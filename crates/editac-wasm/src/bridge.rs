//! Bounded JSON boundary shared by native fixture proofs and the compiled bridge.
//! Every fallible parse/translation/preparation precedes a live commit.
use editac_core::interchange::{
    Affinity, Command, CommandAction as Action, CommandRange as Range, MarkName, Result,
    TransferBlock, err, identity, kernel, parse, transfer_blocks,
};
use editac_core::{
    Utf16Offset,
    anchors::{Anchor, Bias, Resolution, Selection},
    commands::{
        editor::{EditorCommand, PreparedEditorEdit},
        format::{BlockFormatCommand, FormatCommand, PreparedFormatBatch},
        text::{PreparedTextEdit, TextCommand, TextOrigin},
    },
    document::{
        BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode,
        InitializedCheckpoint, MAX_RESTORE_BYTES, ReplayUpdate,
    },
    history::{HistoryConfig, HistoryGroup},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MAX_PLANS: usize = 128;
const MAX_ANCHORS: usize = 4096;

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Identity {
    profile: String,
    schema: String,
    protocol_version: u32,
    update_encoding: u32,
    offsets: String,
    document_id: String,
    epoch: String,
}
impl Identity {
    fn kernel(&self) -> DocumentIdentity {
        DocumentIdentity {
            profile: self.profile.clone(),
            schema: self.schema.clone(),
            protocol_version: self.protocol_version,
            update_encoding: self.update_encoding,
            offsets: self.offsets.clone(),
            document_id: self.document_id.clone(),
            epoch: self.epoch.clone(),
        }
    }
    fn admitted_v5(&self, op: &'static str) -> Result<DocumentIdentity> {
        let expected =
            DocumentIdentity::v5(&self.document_id, &self.epoch).map_err(|e| kernel(op, e))?;
        if self.kernel() != expected {
            return Err(err("EngineRejected", op, "unsupported identity envelope"));
        }
        Ok(expected)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Restore {
    expected: Identity,
    identity: Identity,
    initialized: bool,
    writer_id: u32,
    journal: Vec<WireUpdate>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireUpdate {
    identity: Identity,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Create {
    profile: Profile,
    document_id: String,
    epoch: String,
    nodes: Vec<Node>,
}
#[derive(Deserialize)]
enum Profile {
    #[serde(rename = "v5")]
    V5,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    node: String,
    offset: u32,
    bias: Affinity,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Prepare {
    Fragment {
        origin: String,
        range: Range,
        blocks: Vec<TransferBlock>,
    },
    Text {
        origin: String,
        command: TextRequest,
    },
    Editor {
        origin: String,
        commands: Vec<Command>,
    },
    Format {
        origin: String,
        marks: Vec<MarkRequest>,
        blocks: Vec<BlockRequest>,
    },
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum TextRequest {
    Insert { at: String, text: String },
    Delete { range: Range },
    Replace { range: Range, text: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkRequest {
    range: Range,
    mark: MarkName,
    action: Action,
    href: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Attributes {
    Paragraph {},
    Heading { level: u8 },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlockRequest {
    targets: Vec<String>,
    attributes: Attributes,
    action: Action,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum HistoryRequest {
    State {},
    Undo {},
    Redo {},
    Clear {},
    Boundary {},
    Explicit {},
    Typing { session: u32, time_ms: u32 },
    Composition { session: u32 },
}
#[derive(Default)]
struct ResultTokens {
    caret: Option<String>,
    selection: Option<(String, String)>,
}
impl ResultTokens {
    fn slots(&self) -> usize {
        usize::from(self.caret.is_some()) + 2 * usize::from(self.selection.is_some())
    }
}
enum Plan {
    Text(PreparedTextEdit),
    Editor(PreparedEditorEdit, ResultTokens),
    Format(PreparedFormatBatch),
}

pub(crate) struct Bridge {
    doc: Document,
    plans: BTreeMap<String, Plan>,
    anchors: BTreeMap<String, Anchor>,
    counter: u32,
    patch_sequence: u64,
}
impl Bridge {
    pub fn create(input: &str) -> Result<Self> {
        let c: Create = parse(input, "create")?;
        let _ = c.profile;
        let identity =
            DocumentIdentity::v5(c.document_id, c.epoch).map_err(|e| kernel("create", e))?;
        // Validate the whole creation request before reserving an identity.
        if c.nodes.len() > 4096
            || c.nodes
                .iter()
                .any(|n| n.text.encode_utf16().count() > 262144)
            || c.nodes.iter().map(|n| n.text.len()).sum::<usize>() > 1048576
        {
            return Err(err(
                "ResourceLimit",
                "create",
                "invalid initial content bounds",
            ));
        }
        let permit = CreationPermit::authorize_new(identity).map_err(|e| kernel("create", e))?;
        let nodes = c
            .nodes
            .into_iter()
            .map(|n| InitialNode {
                kind: "block".into(),
                text: n.text,
            })
            .collect::<Vec<_>>();
        let mut doc = Document::create(permit, &nodes).map_err(|e| kernel("create", e))?;
        doc.enable_history(HistoryConfig::default())
            .map_err(|e| kernel("create", e))?;
        Ok(Self {
            doc,
            plans: BTreeMap::new(),
            anchors: BTreeMap::new(),
            counter: 0,
            patch_sequence: 0,
        })
    }
    pub fn restore(input: &str, bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_RESTORE_BYTES {
            return Err(err(
                "ResourceLimit",
                "restore",
                "checkpoint exceeds byte limit",
            ));
        }
        let r: Restore = parse(input, "restore")?;
        if r.journal.len() > 4096 {
            return Err(err(
                "ResourceLimit",
                "restore",
                "journal exceeds entry limit",
            ));
        }
        let expected = r.expected.admitted_v5("restore")?;
        let checkpoint = InitializedCheckpoint {
            identity: r.identity.kernel(),
            initialized: r.initialized,
            writer_id: r.writer_id,
            bytes: bytes.to_vec(),
        };
        let journal = r
            .journal
            .into_iter()
            .map(|u| ReplayUpdate {
                identity: u.identity.kernel(),
                bytes: u.bytes,
            })
            .collect::<Vec<_>>();
        let mut doc = Document::restore(&expected, &checkpoint, &journal)
            .map_err(|e| kernel("restore", e))?;
        doc.enable_history(HistoryConfig::default())
            .map_err(|e| kernel("restore", e))?;
        Ok(Self {
            doc,
            plans: BTreeMap::new(),
            anchors: BTreeMap::new(),
            counter: 0,
            patch_sequence: 0,
        })
    }
    pub fn checkpoint_metadata(&self) -> Value {
        json!({"identity":identity(self.doc.identity()),"initialized":true,"writerId":self.doc.writer_id()})
    }
    pub fn checkpoint_bytes(&self) -> Vec<u8> {
        self.doc.checkpoint().bytes
    }
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.state_vector_v1()
    }
    pub fn update(&self, vector: &[u8]) -> Result<Vec<u8>> {
        self.doc
            .update_v1(vector)
            .map_err(|e| kernel("encodeUpdate", e))
    }
    pub fn apply(&mut self, input: &str, bytes: &[u8]) -> Result<Value> {
        if bytes.len() > MAX_RESTORE_BYTES {
            return Err(err(
                "ResourceLimit",
                "applyUpdate",
                "update exceeds byte limit",
            ));
        }
        let i: Identity = parse(input, "applyUpdate")?;
        // Kernel stages/admit-validates the complete corpus before any live write.
        self.doc
            .apply_replay(&ReplayUpdate {
                identity: i.kernel(),
                bytes: bytes.to_vec(),
            })
            .map_err(|e| kernel("applyUpdate", e))?;
        Ok(json!({"revision":self.doc.revision()}))
    }
    pub fn take_patch(&mut self) -> Value {
        let Some(p) = self.doc.last_patch() else {
            return Value::Null;
        };
        if p.sequence <= self.patch_sequence {
            return Value::Null;
        }
        self.patch_sequence = p.sequence;
        editac_core::interchange::projection_patch(&p)
    }
    fn token(&mut self, kind: &str) -> Result<String> {
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| err("ResourceLimit", "handle", "token counter exhausted"))?;
        Ok(format!("{}:{kind}:{}", self.doc.writer_id(), self.counter))
    }
    fn anchor_value(&self, id: &str) -> Result<Anchor> {
        self.anchors.get(id).cloned().ok_or_else(|| {
            err(
                "InvalidHandle",
                "anchor",
                "anchor is released or belongs to another engine",
            )
        })
    }
    fn selection(&self, r: Range) -> Result<Selection> {
        Ok(Selection {
            anchor: self.anchor_value(&r.anchor)?,
            focus: self.anchor_value(&r.focus)?,
        })
    }
    fn anchor_slots(&self) -> usize {
        self.anchors.len()
            + self
                .plans
                .values()
                .map(|p| match p {
                    Plan::Editor(_, tokens) => tokens.slots(),
                    _ => 0,
                })
                .sum::<usize>()
    }
    pub fn capture(&mut self, input: &str) -> Result<Value> {
        if self.anchor_slots() >= MAX_ANCHORS {
            return Err(err("ResourceLimit", "anchor", "release unused anchors"));
        }
        let c: Capture = parse(input, "anchor")?;
        let a = self
            .doc
            .anchor(&c.node, Utf16Offset(c.offset), c.bias.bias())
            .map_err(|e| kernel("anchor", e))?;
        let token = self.token("anchor")?;
        self.anchors.insert(token.clone(), a);
        Ok(json!({"token": token}))
    }
    pub fn export_anchor(&self, token: &str) -> Result<Value> {
        let a = self.anchor_value(token)?;
        let (source, source_identity, position) = a.portable_parts();
        Ok(
            json!({"version":1,"identity":identity(self.doc.identity()),"source":source,
            "sourceIdentity":source_identity,"position":position}),
        )
    }
    pub fn import_anchor(&mut self, input: &str) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Portable {
            version: u32,
            identity: Identity,
            source: String,
            source_identity: String,
            position: yrs::StickyIndex,
        }
        if input.len() > 4096 || self.anchor_slots() >= MAX_ANCHORS {
            return Err(err(
                "ResourceLimit",
                "importAnchor",
                "presence anchor limit",
            ));
        }
        let value: Value = parse(input, "importAnchor")?;
        let p: Portable = parse(input, "importAnchor")?;
        if serde_json::to_value(&p.position)
            .map_err(|e| err("InvalidInput", "importAnchor", e.to_string()))?
            != value["position"]
        {
            return Err(err(
                "InvalidInput",
                "importAnchor",
                "noncanonical relative position",
            ));
        }
        if p.version != 1 || p.source.len() > 128 || p.source_identity.len() > 128 {
            return Err(err(
                "InvalidInput",
                "importAnchor",
                "invalid presence anchor",
            ));
        }
        let a = self
            .doc
            .import_presence_anchor(
                p.identity.admitted_v5("importAnchor")?,
                p.source,
                p.source_identity,
                p.position,
            )
            .map_err(|e| kernel("importAnchor", e))?;
        let token = self.token("anchor")?;
        self.anchors.insert(token.clone(), a);
        Ok(json!({"token":token}))
    }
    pub fn resolve(&self, token: &str) -> Result<Value> {
        let a = self.anchor_value(token)?;
        let v = self
            .doc
            .resolve_anchor(&a)
            .map_err(|e| kernel("resolve", e))?;
        Ok(match v {
            Resolution::Position(p) => {
                json!({"type":"position", "node":p.node, "offset":p.offset.0, "source":p.source, "sourceOffset":p.source_offset.0, "bias":if p.bias == Bias::Left {"left"} else {"right"}})
            }
            Resolution::Deleted { source, owner } => {
                json!({"type":"deleted", "source":source, "owner":owner})
            }
            Resolution::Unresolvable(e) => {
                json!({"type":"unresolvable", "reason":format!("{e:?}")})
            }
        })
    }
    pub fn release_anchor(&mut self, token: &str) {
        self.anchors.remove(token);
    }
    fn command(&self, c: Command) -> Result<EditorCommand> {
        c.translate(|id| self.anchor_value(id))
    }
    fn prepared(&self, input: &str) -> Result<Plan> {
        let r: Prepare = parse(input, "prepare")?;
        let plan = match r {
            Prepare::Fragment {
                origin,
                range,
                blocks,
            } => {
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let selection = self.selection(range)?;
                let blocks = transfer_blocks(blocks)?;
                Plan::Editor(
                    self.doc
                        .prepare_fragment(&selection, &blocks, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                    ResultTokens::default(),
                )
            }
            Prepare::Text { origin, command } => {
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let command = match command {
                    TextRequest::Insert { at, text } => TextCommand::Insert {
                        at: self.anchor_value(&at)?,
                        text,
                    },
                    TextRequest::Delete { range } => TextCommand::Delete {
                        selection: self.selection(range)?,
                    },
                    TextRequest::Replace { range, text } => TextCommand::Replace {
                        selection: self.selection(range)?,
                        text,
                    },
                };
                Plan::Text(
                    self.doc
                        .prepare_text(&command, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                )
            }
            Prepare::Editor { origin, commands } => {
                if commands.len() > 128 {
                    return Err(err("ResourceLimit", "prepare", "too many commands"));
                }
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let commands = commands
                    .into_iter()
                    .map(|c| self.command(c))
                    .collect::<Result<Vec<_>>>()?;
                Plan::Editor(
                    self.doc
                        .prepare_editor(&commands, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                    ResultTokens::default(),
                )
            }
            Prepare::Format {
                origin,
                marks,
                blocks,
            } => {
                if marks.len().saturating_add(blocks.len()) > 128 {
                    return Err(err("ResourceLimit", "prepare", "too many format commands"));
                }
                let origin = TextOrigin::new(&origin).map_err(|e| kernel("prepare", e))?;
                let marks = marks
                    .into_iter()
                    .map(|m| {
                        Ok(FormatCommand {
                            selection: self.selection(m.range)?,
                            mark: m.mark.native(),
                            action: m.action.native(),
                            href: m.href,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let blocks = blocks
                    .into_iter()
                    .map(|b| BlockFormatCommand {
                        targets: b.targets,
                        attributes: match b.attributes {
                            Attributes::Paragraph {} => BlockAttributes::Paragraph,
                            Attributes::Heading { level } => BlockAttributes::Heading(level),
                        },
                        action: b.action.native(),
                    })
                    .collect::<Vec<_>>();
                Plan::Format(
                    self.doc
                        .prepare_format_batch(&marks, &blocks, &origin)
                        .map_err(|e| kernel("prepare", e))?,
                )
            }
        };
        Ok(plan)
    }
    fn capacity(&self, plan: &Plan) -> Result<()> {
        if self.plans.len() >= MAX_PLANS {
            return Err(err("ResourceLimit", "prepare", "release unused plans"));
        }
        let needed = match plan {
            Plan::Editor(p, _) => {
                usize::from(p.result_caret().is_some())
                    + 2 * usize::from(p.result_selection().is_some())
            }
            _ => 0,
        };
        if self.anchor_slots().saturating_add(needed) > MAX_ANCHORS {
            return Err(err("ResourceLimit", "prepare", "release unused anchors"));
        }
        self.counter
            .checked_add(1 + needed as u32)
            .ok_or_else(|| err("ResourceLimit", "prepare", "token counter exhausted"))?;
        Ok(())
    }
    pub fn can(&self, input: &str) -> Result<Value> {
        let plan = self.prepared(input)?;
        self.capacity(&plan)?;
        Ok(json!(true))
    }
    pub fn prepare(&mut self, input: &str) -> Result<Value> {
        let mut plan = self.prepared(input)?;
        self.capacity(&plan)?;
        // Reserve both tokens before exposing a plan; capacity() preflights overflow.
        let token = self.token("plan")?;
        if let Plan::Editor(p, reservation) = &mut plan {
            if p.result_caret().is_some() {
                reservation.caret = Some(self.token("anchor")?);
            }
            if p.result_selection().is_some() {
                reservation.selection = Some((self.token("anchor")?, self.token("anchor")?));
            }
        }
        self.plans.insert(token.clone(), plan);
        Ok(json!({"token":token, "revision": self.doc.revision()}))
    }
    pub fn release_plan(&mut self, token: &str) {
        self.plans.remove(token);
    }
    pub fn commit(&mut self, token: &str) -> Result<Value> {
        let plan = self.plans.remove(token).ok_or_else(|| {
            err(
                "InvalidHandle",
                "commit",
                "plan is consumed, released or belongs to another engine",
            )
        })?;
        let mut result = json!({"revision":self.doc.revision()});
        match plan {
            Plan::Text(p) => {
                self.doc.commit_text(p).map_err(|e| kernel("commit", e))?;
            }
            Plan::Editor(p, reservation) => {
                let commit = self.doc.commit_editor(p).map_err(|e| kernel("commit", e))?;
                if let (Some(caret), Some(token)) = (commit.result_caret, reservation.caret) {
                    self.anchors.insert(token.clone(), caret);
                    result["caret"] = json!(token);
                }
                if let (Some(selection), Some((anchor, focus))) =
                    (commit.result_selection, reservation.selection)
                {
                    self.anchors.insert(anchor.clone(), selection.anchor);
                    self.anchors.insert(focus.clone(), selection.focus);
                    result["selection"] = json!({"anchor":anchor, "focus":focus});
                }
            }
            Plan::Format(p) => {
                self.doc.commit_format(p).map_err(|e| kernel("commit", e))?;
            }
        }
        result["revision"] = json!(self.doc.revision());
        Ok(result)
    }
    pub fn history(&mut self, input: &str) -> Result<Value> {
        let request = parse::<HistoryRequest>(input, "history")?;
        let mut selection = None;
        if matches!(request, HistoryRequest::Undo {} | HistoryRequest::Redo {}) {
            if self.anchor_slots().saturating_add(2) > MAX_ANCHORS {
                return Err(err("ResourceLimit", "history", "release unused anchors"));
            }
            self.counter
                .checked_add(2)
                .ok_or_else(|| err("ResourceLimit", "history", "token counter exhausted"))?;
        }
        match request {
            HistoryRequest::State {} => {}
            HistoryRequest::Undo {} => {
                selection = self
                    .doc
                    .undo()
                    .map_err(|e| kernel("history", e))?
                    .and_then(|c| c.selection);
            }
            HistoryRequest::Redo {} => {
                selection = self
                    .doc
                    .redo()
                    .map_err(|e| kernel("history", e))?
                    .and_then(|c| c.selection);
            }
            HistoryRequest::Clear {} => self.doc.clear_history(),
            HistoryRequest::Boundary {} => self.doc.reset_history_group(),
            HistoryRequest::Explicit {} => self.doc.set_history_group(HistoryGroup::Explicit),
            HistoryRequest::Typing { session, time_ms } => {
                self.doc.set_history_group(HistoryGroup::Typing {
                    session: session.into(),
                    time_ms: time_ms.into(),
                })
            }
            HistoryRequest::Composition { session } => {
                self.doc.set_history_group(HistoryGroup::Composition {
                    session: session.into(),
                })
            }
        }
        let h = self.doc.history_state();
        let mut result = json!({"revision":self.doc.revision(), "undoGroups":h.undo_groups, "redoGroups":h.redo_groups, "retainedUpdateBytes":h.retained_update_bytes});
        if let Some(selection) = selection {
            let anchor = self.token("anchor")?;
            let focus = self.token("anchor")?;
            self.anchors.insert(anchor.clone(), selection.anchor);
            self.anchors.insert(focus.clone(), selection.focus);
            result["selection"] = json!({"anchor":anchor, "focus":focus});
        }
        Ok(result)
    }
    #[cfg(test)]
    pub(super) fn doc_state(&self) -> (Vec<u8>, u64, editac_core::history::HistoryState) {
        (
            self.doc.checkpoint().bytes,
            self.doc.revision(),
            self.doc.history_state(),
        )
    }
    pub fn read(&self) -> Result<Value> {
        editac_core::interchange::projection_snapshot(&self.doc)
    }
}
#[cfg(test)]
mod result_caret_tests {
    use super::*;
    fn heading(serial: u32) -> (Bridge, String, String) {
        let mut b = Bridge::create(&json!({"profile":"v5","documentId":format!("95000000-0000-4000-8000-{serial:012}"),"epoch":format!("96000000-0000-4000-8000-{serial:012}"),"nodes":[{"text":"H"}]}).to_string()).unwrap();
        let node = b.doc.snapshot().unwrap().visible[0].id.clone();
        let plan = b.prepare(&json!({"kind":"format","origin":"setup","marks":[],"blocks":[{"targets":[node],"attributes":{"type":"heading","level":2},"action":"apply"}]}).to_string()).unwrap();
        b.commit(plan["token"].as_str().unwrap()).unwrap();
        let at = b
            .capture(&json!({"node":node,"offset":1,"bias":"right"}).to_string())
            .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let request = json!({"kind":"editor","origin":"test","commands":[{"type":"headingEnd","owner":node,"at":at}]}).to_string();
        (b, node, request)
    }
    #[test]
    fn result_capacity_can_and_token_overflow_are_pre_mutation() {
        let (mut b, node, request) = heading(1);
        let counter = b.counter;
        let state = b.doc_state();
        for _ in 0..16 {
            assert_eq!(b.can(&request).unwrap(), json!(true));
        }
        assert_eq!(b.counter, counter);
        assert!(b.plans.is_empty());
        assert_eq!(b.doc_state(), state);
        for _ in 1..MAX_ANCHORS {
            b.capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
                .unwrap();
        }
        assert_eq!(b.can(&request).unwrap_err().code, "ResourceLimit");
        assert_eq!(b.prepare(&request).unwrap_err().code, "ResourceLimit");
        assert_eq!(b.doc_state(), state);
        b.anchors.clear();
        // Restore the retained input token, then isolate counter overflow.
        let at = b
            .capture(&json!({"node":node,"offset":1,"bias":"right"}).to_string())
            .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let input = json!({"kind":"editor","origin":"test","commands":[{"type":"headingEnd","owner":node,"at":at}]}).to_string();
        b.counter = u32::MAX - 1;
        assert_eq!(b.can(&input).unwrap_err().code, "ResourceLimit");
        assert_eq!(b.prepare(&input).unwrap_err().code, "ResourceLimit");
        assert_eq!(b.counter, u32::MAX - 1);
        assert!(b.plans.is_empty());
        assert_eq!(b.doc_state(), state);
    }
    #[test]
    fn result_reservations_release_and_commit_cannot_fail_after_mutation() {
        let (mut b, node, request) = heading(2);
        let plan = b.prepare(&request).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(b.anchor_slots(), 2);
        b.release_plan(&plan);
        assert_eq!(b.anchor_slots(), 1);
        let plan = b.prepare(&request).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        for _ in 2..MAX_ANCHORS {
            b.capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
                .unwrap();
        }
        assert_eq!(
            b.capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
                .unwrap_err()
                .code,
            "ResourceLimit"
        );
        b.counter = u32::MAX;
        let result = b.commit(&plan).unwrap();
        assert_eq!(b.anchor_slots(), MAX_ANCHORS);
        let token = result["caret"].as_str().unwrap();
        let nodes = b.doc.snapshot().unwrap().visible;
        assert_eq!(b.resolve(token).unwrap()["node"], nodes[1].id);
        assert_eq!(b.resolve(token).unwrap()["offset"], 0);
        b.release_anchor(token);
        assert_eq!(b.anchor_slots(), MAX_ANCHORS - 1);
        assert_eq!(b.resolve(token).unwrap_err().code, "InvalidHandle");
    }
    #[test]
    fn stale_result_plan_consumes_reservation_without_exposing_caret() {
        let (mut b, node, request) = heading(3);
        let plan = b.prepare(&request).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let change = b.prepare(&json!({"kind":"format","origin":"change","marks":[],"blocks":[{"targets":[node],"attributes":{"type":"heading","level":3},"action":"apply"}]}).to_string()).unwrap();
        b.commit(change["token"].as_str().unwrap()).unwrap();
        let state = b.doc_state();
        assert!(b.commit(&plan).is_err());
        assert_eq!(b.anchor_slots(), 1);
        assert!(b.plans.is_empty());
        assert_eq!(b.doc_state(), state);
    }
    #[test]
    fn result_removed_by_later_batch_command_is_rejected_during_prepare() {
        let (b, node, request) = heading(4);
        // Inspect the genuine staged result on a disposable replica; no guessed ID.
        let mut staged = Document::restore(b.doc.identity(), &b.doc.checkpoint(), &[]).unwrap();
        let commands: Prepare = parse(&request, "prepare").unwrap();
        let Prepare::Editor { commands, .. } = commands else {
            panic!()
        };
        // Bridge/native plan lifetime is replica-scoped; use a second genuine preparation
        // only to inspect the deterministic destination on the live writer's staged update.
        let native = commands
            .into_iter()
            .map(|c| b.command(c))
            .collect::<Result<Vec<_>>>()
            .unwrap();
        let p = staged
            .prepare_editor(&native, &TextOrigin::new("test").unwrap())
            .unwrap();
        let result = staged.commit_editor(p).unwrap().result_caret.unwrap();
        let Resolution::Position(destination) = staged.resolve_anchor(&result).unwrap() else {
            panic!()
        };
        // Generated operation counters are identical; only the staged writer differs.
        let destination = destination.node.replace(
            &format!("o:{}:", staged.writer_id()),
            &format!("o:{}:", b.doc.writer_id()),
        );
        let mut request: Value = serde_json::from_str(&request).unwrap();
        request["commands"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"join","first":node,"second":destination}));
        let state = b.doc_state();
        let failure = match b.prepared(&request.to_string()) {
            Ok(_) => panic!("invalidated result was admitted"),
            Err(e) => e,
        };
        assert!(
            failure.message.contains("InvalidCommand"),
            "{}",
            failure.message
        );
        assert_eq!(b.doc_state(), state);
    }
}

#[cfg(test)]
mod atomic_selection_tests {
    use super::*;
    fn fixture(serial: u32) -> (Bridge, String, String) {
        let b=Bridge::create(&json!({"profile":"v5","documentId":format!("42200000-0000-4000-8000-{serial:012}"),"epoch":format!("42200000-0000-4000-9000-{serial:012}"),"nodes":[{"text":"abc"}]}).to_string()).unwrap();
        let node = b.doc.snapshot().unwrap().visible[0].id.clone();
        let request=json!({"kind":"editor","origin":"atomic:fixture","commands":[{"type":"replaceAt","owner":node,"from":1,"to":1,"text":"X"},{"type":"markAt","owner":node,"from":1,"to":2,"mark":"bold","action":"apply"},{"type":"selectionAt","anchor":{"owner":node,"offset":2,"bias":"left"},"focus":{"owner":node,"offset":2,"bias":"right"}}]}).to_string();
        (b, node, request)
    }
    #[test]
    fn result_selection_tokens_are_reserved_before_mutation_and_released() {
        let (mut b, node, request) = fixture(1);
        for _ in 0..MAX_ANCHORS - 1 {
            b.capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
                .unwrap();
        }
        let old = b.doc_state();
        let counter = b.counter;
        assert!(b.can(&request).is_err());
        assert!(b.prepare(&request).is_err());
        assert_eq!(b.doc_state(), old);
        assert_eq!(b.counter, counter);
        let token = b.anchors.keys().next().unwrap().clone();
        b.release_anchor(&token);
        let plan = b.prepare(&request).unwrap();
        assert_eq!(b.anchor_slots(), MAX_ANCHORS);
        assert!(
            b.capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
                .is_err()
        );
        b.release_plan(plan["token"].as_str().unwrap());
        assert_eq!(b.anchor_slots(), MAX_ANCHORS - 2);
        assert_eq!(b.doc_state(), old);
    }
    #[test]
    fn selection_token_overflow_and_invalid_final_cut_are_pre_mutation() {
        let (mut b, node, request) = fixture(2);
        b.counter = u32::MAX - 2;
        let old = b.doc_state();
        assert!(b.can(&request).is_err());
        assert!(b.prepare(&request).is_err());
        assert_eq!(b.doc_state(), old);
        assert_eq!(b.counter, u32::MAX - 2);
        let (mut b, _, request) = fixture(3);
        let mut invalid: Value = serde_json::from_str(&request).unwrap();
        invalid["commands"][2]["focus"]["offset"] = json!(99);
        let old = b.doc_state();
        assert!(b.prepare(&invalid.to_string()).is_err());
        assert_eq!(b.doc_state(), old);
        assert!(b.anchors.is_empty());
        assert!(b.plans.is_empty());
        let _ = node;
    }
    #[test]
    fn stale_selection_plan_consumes_reservations_and_never_exposes_results() {
        let (mut b, node, request) = fixture(4);
        let plan = b.prepare(&request).unwrap();
        assert_eq!(b.anchor_slots(), 2);
        let other=b.prepare(&json!({"kind":"editor","origin":"other","commands":[{"type":"replaceAt","owner":node,"from":0,"to":0,"text":"Z"}]}).to_string()).unwrap();
        b.commit(other["token"].as_str().unwrap()).unwrap();
        let old = b.doc_state();
        assert!(b.commit(plan["token"].as_str().unwrap()).is_err());
        assert_eq!(b.doc_state(), old);
        assert_eq!(b.anchor_slots(), 0);
    }
}

#[cfg(test)]
mod history_selection_tests {
    use super::*;
    #[test]
    fn history_tokens_and_capacity_rejection_preserve_native_bookmarks() {
        let mut b = Bridge::create(&json!({"profile":"v5","documentId":"42300000-0000-4000-8000-000000000001","epoch":"42300000-0000-4000-9000-000000000001","nodes":[{"text":"abcdef"}]}).to_string()).unwrap();
        let node = b.doc.snapshot().unwrap().visible[0].id.clone();
        let p = b.prepare(&json!({"kind":"editor","origin":"test:history","commands":[
            {"type":"historySelectionAt","anchor":{"owner":node,"offset":5,"bias":"left"},"focus":{"owner":node,"offset":2,"bias":"right"}},
            {"type":"replaceAt","owner":node,"from":1,"to":5,"text":"X"},
            {"type":"selectionAt","anchor":{"owner":node,"offset":2,"bias":"right"},"focus":{"owner":node,"offset":1,"bias":"left"}}
        ]}).to_string()).unwrap();
        b.commit(p["token"].as_str().unwrap()).unwrap();
        b.anchors.clear();
        for _ in 0..MAX_ANCHORS - 1 {
            b.capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
                .unwrap();
        }
        let before = b.doc_state();
        assert!(b.history("{\"type\":\"undo\"}").is_err());
        assert_eq!(b.doc_state(), before);
        b.anchors.clear();
        b.counter = u32::MAX - 1;
        assert!(b.history("{\"type\":\"undo\"}").is_err());
        assert_eq!(b.doc_state(), before);
        b.counter = 0;
        for (action, cuts) in [
            ("undo", [(5, "left"), (2, "right")]),
            ("redo", [(2, "right"), (1, "left")]),
        ] {
            let result = b.history(&json!({"type":action}).to_string()).unwrap();
            for (key, (offset, bias)) in ["anchor", "focus"].into_iter().zip(cuts) {
                let token = result["selection"][key].as_str().unwrap();
                let position = b.resolve(token).unwrap();
                assert_eq!(position["node"], node);
                assert_eq!(position["offset"], offset);
                assert_eq!(position["bias"], bias);
                b.release_anchor(token);
            }
            assert_eq!(b.anchor_slots(), 0);
        }
    }
}

#[cfg(test)]
mod alignment_profile_tests {
    use super::*;
    #[test]
    fn canonical_left_is_noop_and_undeclared_alignment_is_atomic_rejection() {
        let mut b = Bridge::create(&json!({"profile":"v5","documentId":"42600000-0000-4000-8000-000000000001","epoch":"42600000-0000-4000-9000-000000000001","nodes":[{"text":"a"}]}).to_string()).unwrap();
        let owner = b.doc.snapshot().unwrap().visible[0].id.clone();
        let before = b.doc_state();
        let request = json!({"kind":"editor","origin":"local:rgs:c4","commands":[{"type":"setAlignment","owner":owner,"alignment":"left"}]}).to_string();
        let plan = b.prepare(&request).unwrap();
        b.commit(plan["token"].as_str().unwrap()).unwrap();
        assert_eq!(b.doc_state(), before);
        for value in ["center", "right", "justify", "LEFT"] {
            let request = json!({"kind":"editor","origin":"local:rgs:c4","commands":[{"type":"replaceAt","owner":owner,"from":0,"to":0,"text":"BAD"},{"type":"setAlignment","owner":owner,"alignment":value}]}).to_string();
            assert!(b.can(&request).is_err());
            assert!(b.prepare(&request).is_err());
            assert_eq!(b.doc_state(), before);
        }
    }
}
