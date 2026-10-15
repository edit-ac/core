//! Scoped, host-driven ephemeral awareness; semantic state remains in Session.
use super::*;
use editac_core::{anchors::Position, presence::PresenceError};

#[derive(Clone, Debug, uniffi::Record)]
pub struct NativePresenceSelection {
    pub anchor: NativeAnchorResolution,
    pub focus: NativeAnchorResolution,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativePeerPresence {
    pub client_id: u32,
    pub selection: Option<NativePresenceSelection>,
}
impl From<PresenceError> for NativeSessionError {
    fn from(error: PresenceError) -> Self {
        match error {
            PresenceError::Limit => Self::ResourceLimit,
            PresenceError::Invalid => Self::AnchorTarget {
                message: "invalid presence frame, cursor, or monotonic time".into(),
            },
        }
    }
}
fn position(p: Position) -> NativeAnchorResolution {
    NativeAnchorResolution::Position {
        node: p.node,
        offset_utf16: p.offset.0,
        source: p.source,
        source_offset_utf16: p.source_offset.0,
        bias: if p.bias == Bias::Left {
            crate::AnchorBias::Left
        } else {
            crate::AnchorBias::Right
        },
    }
}
#[uniffi::export]
impl NativeSession {
    /// None means online without selection; present=false emits an explicit leave.
    /// Both tokens must belong to this worker. No local permission is granted.
    pub fn set_host_presence(
        &self,
        token: String,
        anchor: Option<String>,
        focus: Option<String>,
        present: bool,
        now: u64,
    ) -> Result<()> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            if anchor.is_some() != focus.is_some() || (!present && anchor.is_some()) {
                return Err(NativeSessionError::InvalidAnchor);
            }
            let range = anchor
                .as_ref()
                .zip(focus.as_ref())
                .map(|(a, f)| -> Result<_> {
                    Ok((
                        state
                            .anchors
                            .get(a)
                            .ok_or(NativeSessionError::InvalidAnchor)?,
                        state
                            .anchors
                            .get(f)
                            .ok_or(NativeSessionError::InvalidAnchor)?,
                    ))
                })
                .transpose()?;
            state.host_transport.as_mut().unwrap().presence.set_local(
                state.service.session().document(),
                range,
                present,
                now,
            )?;
            Ok(())
        })
    }
    /// Queue a coalesced pinned awareness frame; queue backpressure retains state.
    pub fn flush_host_presence(&self, token: String, now: u64) -> Result<bool> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            let identity = state.service.session().document().identity().clone();
            let connection = state.host_transport.as_mut().unwrap();
            let queue = &mut connection.presence_queue;
            let mut rejected = None;
            let sent = connection.presence.flush(now, |bytes| {
                match queue.send(TransportFrame {
                    identity: identity.clone(),
                    kind: FrameKind::Awareness,
                    bytes,
                }) {
                    Ok(()) => true,
                    Err(PortError::Backpressure) => false,
                    Err(error) => {
                        rejected = Some(error);
                        false
                    }
                }
            })?;
            if let Some(error) = rejected {
                return Err(error.into());
            }
            Ok(sent)
        })
    }
    /// Awareness uses a separate bounded owning transport queue from durable sync.
    pub fn take_host_presence_frames(
        &self,
        token: String,
        max_frames: u32,
        now: u64,
    ) -> Result<Vec<NativeHostFrame>> {
        self.call(move |state| {
            let connection = state.host_connection(&token, now)?;
            if max_frames == 0 || max_frames > 32 {
                return Err(NativeSessionError::ResourceLimit);
            }
            let mut queue = connection.presence_queue.clone();
            let mut frames = Vec::new();
            for _ in 0..max_frames {
                let Some(frame) = queue.receive()? else { break };
                frames.push(NativeHostFrame {
                    identity_json: editac_core::interchange::identity(&frame.identity).to_string(),
                    bytes: frame.bytes,
                });
            }
            Ok(frames)
        })
    }
    /// Host authenticates participant routing before supplying the existing wire.
    pub fn receive_host_presence(
        &self,
        token: String,
        frame: NativeHostFrame,
        now: u64,
    ) -> Result<()> {
        self.call(move |state| {
            let connection = state.host_connection(&token, now)?;
            if frame.bytes.len() > connection.presence_queue.capabilities().max_frame_bytes {
                return Err(NativeSessionError::ResourceLimit);
            }
            state.host_identity(&frame.identity_json)?;
            state.host_transport.as_mut().unwrap().presence.receive(
                state.service.session().document(),
                &frame.bytes,
                now,
            )?;
            Ok(())
        })
    }
    /// Resolve relative cursors against current committed content, expiring peers.
    pub fn host_presence(&self, token: String, now: u64) -> Result<Vec<NativePeerPresence>> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            Ok(state
                .host_transport
                .as_mut()
                .unwrap()
                .presence
                .peers(state.service.session().document(), now)?
                .into_iter()
                .map(|(client_id, range)| NativePeerPresence {
                    client_id,
                    selection: range.map(|(a, f)| NativePresenceSelection {
                        anchor: position(a),
                        focus: position(f),
                    }),
                })
                .collect())
        })
    }
}
