//! Host-driven, ephemeral adapter over Yrs awareness on this document's replica.
//! No timers, persistence, semantic mutations, or transport ownership.
use crate::{
    anchors::{Anchor, Position, Resolution},
    document::Document,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use yrs::{
    StickyIndex,
    sync::awareness::{Awareness, AwarenessUpdate, AwarenessUpdateEntry},
    updates::{decoder::Decode, encoder::Encode},
};

const MAX_FRAME: usize = 65536;
const MAX_PEERS: usize = 64;
const EXPIRY: u64 = 30000;
const THROTTLE: u64 = 50;
#[derive(Debug)]
pub enum PresenceError {
    Limit,
    Invalid,
}
type Result<T> = std::result::Result<T, PresenceError>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Portable {
    version: u32,
    identity: Value,
    source: String,
    source_identity: String,
    position: StickyIndex,
}

pub fn export_anchor(doc: &Document, anchor: &Anchor) -> Result<Value> {
    if !matches!(doc.resolve_anchor(anchor), Ok(Resolution::Position(_))) {
        return Err(PresenceError::Invalid);
    }
    let (source, source_identity, position) = anchor.portable_parts();
    Ok(
        json!({"version":1,"identity":crate::interchange::identity(doc.identity()),"source":source,"sourceIdentity":source_identity,"position":position}),
    )
}
pub fn import_anchor(doc: &Document, value: &Value) -> Result<Anchor> {
    if value.to_string().len() > 4096 {
        return Err(PresenceError::Limit);
    }
    let p: Portable = serde_json::from_value(value.clone()).map_err(|_| PresenceError::Invalid)?;
    if p.version != 1
        || p.identity != crate::interchange::identity(doc.identity())
        || p.source.len() > 128
        || p.source_identity.len() > 128
    {
        return Err(PresenceError::Invalid);
    }
    // Admit the browser's optional owning type, then normalize to the item. Never
    // let StickyIndex's permissive deserializer ignore contradictory fields.
    let pos = value["position"]
        .as_object()
        .ok_or(PresenceError::Invalid)?;
    let scopes: Vec<_> = ["item", "type", "tname"]
        .into_iter()
        .filter(|k| pos.contains_key(*k))
        .collect();
    if scopes.is_empty()
        || (scopes.contains(&"type") && scopes.contains(&"tname"))
        || pos.len() != scopes.len() + 1
        || !matches!(pos.get("assoc").and_then(Value::as_i64), Some(-1 | 0))
    {
        return Err(PresenceError::Invalid);
    }
    for scope in &scopes {
        let v = &pos[*scope];
        if *scope == "tname" {
            if !v.as_str().is_some_and(|s| s.len() <= 128) {
                return Err(PresenceError::Invalid);
            }
        } else if !v.as_object().is_some_and(|o| {
            o.len() == 2
                && ["client", "clock"].iter().all(|k| {
                    o.get(*k)
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n <= u32::MAX as u64)
                })
        }) {
            return Err(PresenceError::Invalid);
        }
    }
    let canonical = serde_json::to_value(&p.position).map_err(|_| PresenceError::Invalid)?;
    let scope = if pos.contains_key("item") {
        "item"
    } else {
        scopes[0]
    };
    if canonical != json!({scope:pos[scope],"assoc":pos["assoc"]}) {
        return Err(PresenceError::Invalid);
    }
    doc.import_presence_anchor(
        doc.identity().clone(),
        p.source,
        p.source_identity,
        p.position,
    )
    .map_err(|_| PresenceError::Invalid)
}
fn selection(doc: &Document, value: &Value) -> Result<Option<(Anchor, Anchor)>> {
    if value.is_null() {
        return Ok(None);
    }
    let object = value.as_object().ok_or(PresenceError::Invalid)?;
    if object.len() != 1 || !object.contains_key("selection") {
        return Err(PresenceError::Invalid);
    }
    let s = &value["selection"];
    if s.is_null() {
        return Ok(None);
    }
    if !s
        .as_object()
        .is_some_and(|o| o.len() == 2 && o.contains_key("anchor") && o.contains_key("focus"))
    {
        return Err(PresenceError::Invalid);
    }
    Ok(Some((
        import_anchor(doc, &s["anchor"])?,
        import_anchor(doc, &s["focus"])?,
    )))
}

pub struct Presence {
    awareness: Awareness,
    time: Arc<AtomicU64>,
    dirty: bool,
    last_attempt: Option<u64>,
    last_sent: u64,
}
pub type PeerSelection = (u32, Option<(Position, Position)>);
impl Document {
    /// Shares the existing Yrs store; cloning this handle creates no replica.
    pub fn presence(&self) -> Presence {
        let time = Arc::new(AtomicU64::new(0));
        let clock = time.clone();
        Presence {
            awareness: Awareness::with_clock(self.doc.clone(), move || {
                clock.load(Ordering::Relaxed)
            }),
            time,
            dirty: false,
            last_attempt: None,
            last_sent: 0,
        }
    }
}
impl Presence {
    fn now(&self, now: u64) -> Result<()> {
        if now < self.time.load(Ordering::Relaxed) {
            return Err(PresenceError::Invalid);
        }
        self.time.store(now, Ordering::Relaxed);
        Ok(())
    }
    pub fn set_local(
        &mut self,
        doc: &Document,
        range: Option<(&Anchor, &Anchor)>,
        present: bool,
        now: u64,
    ) -> Result<()> {
        self.now(now)?;
        let value = if !present {
            Value::Null
        } else {
            json!({"selection":range.map(|(a,f)| -> Result<Value> {Ok(json!({"anchor":export_anchor(doc,a)?,"focus":export_anchor(doc,f)?}))}).transpose()?})
        };
        let clock = self
            .awareness
            .meta(self.awareness.client_id())
            .map_or(0, |m| m.0);
        if clock == u32::MAX {
            return Err(PresenceError::Limit);
        }
        if present {
            self.awareness
                .set_local_state(value)
                .map_err(|_| PresenceError::Invalid)?;
        } else {
            self.awareness.clean_local_state();
        }
        self.dirty = true;
        Ok(())
    }
    /// Caller returns false on backpressure; the coalesced state remains dirty.
    pub fn flush(&mut self, now: u64, mut send: impl FnMut(Vec<u8>) -> bool) -> Result<bool> {
        self.now(now)?;
        if !self.dirty
            && self.awareness.local_state_raw().is_some()
            && now.saturating_sub(self.last_sent) >= EXPIRY / 2
        {
            let value: Value = self.awareness.local_state().ok_or(PresenceError::Invalid)?;
            let clock = self
                .awareness
                .meta(self.awareness.client_id())
                .map_or(0, |m| m.0);
            if clock == u32::MAX {
                return Err(PresenceError::Limit);
            }
            self.awareness
                .set_local_state(value)
                .map_err(|_| PresenceError::Invalid)?;
            self.dirty = true;
        }
        if !self.dirty
            || self
                .last_attempt
                .is_some_and(|n| now.saturating_sub(n) < THROTTLE)
        {
            return Ok(false);
        }
        let frame = self
            .awareness
            .update_with_clients([self.awareness.client_id()])
            .map_err(|_| PresenceError::Invalid)?
            .encode_v1();
        if frame.len() > MAX_FRAME {
            return Err(PresenceError::Limit);
        }
        self.last_attempt = Some(now);
        if !send(frame) {
            return Ok(false);
        }
        self.dirty = false;
        self.last_sent = now;
        Ok(true)
    }
    pub fn receive(&mut self, doc: &Document, bytes: &[u8], now: u64) -> Result<()> {
        self.now(now)?;
        if bytes.len() > MAX_FRAME {
            return Err(PresenceError::Limit);
        }
        // Canonical encoding check also rejects duplicates, trailing bytes and
        // noncanonical varints before changing Yrs awareness state.
        validate_wire(bytes)?;
        let update = AwarenessUpdate::decode_v1(bytes).map_err(|_| PresenceError::Invalid)?;
        if update.clients.len() > MAX_PEERS {
            return Err(PresenceError::Limit);
        }
        // HashMap iteration is unordered, so compare individual canonical entries
        // through a bounded wire scanner rather than re-encoding the whole map.
        let count = self
            .awareness
            .iter()
            .filter(|(id, _)| *id != self.awareness.client_id())
            .count();
        let added = update
            .clients
            .iter()
            .filter(|(id, e)| {
                **id != self.awareness.client_id()
                    && e.clock > 0
                    && self.awareness.meta(**id).is_none()
            })
            .count();
        if count + added > MAX_PEERS {
            return Err(PresenceError::Limit);
        }
        for e in update.clients.values() {
            let v: Value = serde_json::from_str(&e.json).map_err(|_| PresenceError::Invalid)?;
            selection(doc, &v)?;
        }
        let clients = update
            .clients
            .into_iter()
            .filter(|(id, e)| {
                *id != self.awareness.client_id()
                    && (e.clock > 0 || self.awareness.meta(*id).is_some())
            })
            .collect();
        self.awareness
            .apply_update(AwarenessUpdate { clients })
            .map_err(|_| PresenceError::Invalid)
    }
    pub fn peers(&mut self, doc: &Document, now: u64) -> Result<Vec<PeerSelection>> {
        self.now(now)?;
        let expired: Vec<_> = self
            .awareness
            .iter()
            .filter(|(id, s)| {
                *id != self.awareness.client_id()
                    && s.data.is_some()
                    && now.saturating_sub(s.last_updated) >= EXPIRY
            })
            .map(|(id, s)| (id, s.clock))
            .collect();
        // Equal-clock null tombstones follow the pinned awareness leave semantics.
        let clients = expired
            .into_iter()
            .map(|(id, clock)| {
                (
                    id,
                    AwarenessUpdateEntry {
                        clock,
                        json: Arc::from("null"),
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        self.awareness
            .apply_update(AwarenessUpdate { clients })
            .map_err(|_| PresenceError::Invalid)?;
        let mut result = Vec::new();
        for (id, s) in self.awareness.iter() {
            if id == self.awareness.client_id() {
                continue;
            }
            if let Some(raw) = s.data {
                let resolved = serde_json::from_str(&raw)
                    .ok()
                    .and_then(|v| selection(doc, &v).ok())
                    .flatten()
                    .and_then(
                        |(a, f)| match (doc.resolve_anchor(&a), doc.resolve_anchor(&f)) {
                            (Ok(Resolution::Position(a)), Ok(Resolution::Position(f))) => {
                                Some((a, f))
                            }
                            _ => None,
                        },
                    );
                result.push((id.get() as u32, resolved));
            }
        }
        result.sort_by_key(|x| x.0);
        Ok(result)
    }
}
fn validate_wire(bytes: &[u8]) -> Result<()> {
    fn read(bytes: &[u8], at: &mut usize) -> Result<u32> {
        let mut n = 0u64;
        for i in 0..5 {
            let b = *bytes.get(*at).ok_or(PresenceError::Invalid)?;
            *at += 1;
            n |= ((b & 127) as u64) << (7 * i);
            if b < 128 {
                if n > u32::MAX as u64 || (i > 0 && b == 0) {
                    return Err(PresenceError::Invalid);
                }
                return Ok(n as u32);
            }
        }
        Err(PresenceError::Invalid)
    }
    let mut at = 0;
    let count = read(bytes, &mut at)? as usize;
    if count > MAX_PEERS {
        return Err(PresenceError::Invalid);
    }
    let mut ids = std::collections::HashSet::new();
    for _ in 0..count {
        if !ids.insert(read(bytes, &mut at)?) {
            return Err(PresenceError::Invalid);
        }
        read(bytes, &mut at)?;
        let len = read(bytes, &mut at)? as usize;
        at = at
            .checked_add(len)
            .filter(|n| *n <= bytes.len())
            .ok_or(PresenceError::Invalid)?;
    }
    if at != bytes.len() {
        return Err(PresenceError::Invalid);
    }
    Ok(())
}
