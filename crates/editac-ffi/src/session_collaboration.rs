//! Thin host-driven ports on the existing serialized Session. No callbacks or IO.
use super::*;
use editac_session::{
    ports::{
        ConnectionState, DurableReceipt, FrameKind, ReceiptCapability, ReceiptResult, Transport,
        TransportCapabilities, TransportFrame, UpdateId, memory::PreparedTransport,
    },
    session::AuthState,
};

#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeHostTransportOptions {
    pub identity_json: String,
    pub expires_at: u64,
    pub durable_receipts: bool,
    pub max_frame_bytes: u32,
    pub max_queue_bytes: u32,
    pub max_queue_frames: u32,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeHostFrame {
    pub identity_json: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeHostReceipt {
    pub identity_json: String,
    pub writer: u32,
    pub sequence: u64,
    pub checksum: Vec<u8>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeHostReceiptResult {
    RemoteCommitted,
    CapabilityUnavailable,
    UnknownUpdate,
}

// Reuse the owning bounded queue, including scope, frame and aggregate bounds.
// The queue is confined to the Session worker. Foreign code receives owned copies.
#[derive(Clone)]
struct HostQueue(Rc<RefCell<PreparedTransport>>);
impl Transport for HostQueue {
    fn state(&self) -> ConnectionState {
        self.0.borrow().state()
    }
    fn capabilities(&self) -> TransportCapabilities {
        self.0.borrow().capabilities()
    }
    fn send(&mut self, frame: TransportFrame) -> std::result::Result<(), PortError> {
        self.0.borrow_mut().send(frame)
    }
    fn receive(&mut self) -> std::result::Result<Option<TransportFrame>, PortError> {
        self.0.borrow_mut().receive()
    }
}
pub(super) struct HostConnection {
    token: String,
    queue: HostQueue,
}
impl State {
    fn host_connection(&self, token: &str, now: u64) -> Result<&HostConnection> {
        // The same Session recovery and authorization state governs every port.
        self.service.session().observed_revision()?;
        let connection = self
            .host_transport
            .as_ref()
            .ok_or(NativeSessionError::Unauthorized)?;
        if connection.token != token
            || self.service.session().state(now).auth != AuthState::Authorized
        {
            return Err(NativeSessionError::Unauthorized);
        }
        Ok(connection)
    }
    fn host_identity(&self, input: &str) -> Result<DocumentIdentity> {
        if input.len() > 4096 {
            return Err(NativeSessionError::ResourceLimit);
        }
        let supplied: serde_json::Value =
            serde_json::from_str(input).map_err(|_| NativeSessionError::Store {
                reason: NativeStoreFailure::InvalidRecord,
            })?;
        let identity = self.service.session().document().identity();
        if supplied != editac_core::interchange::identity(identity) {
            return Err(NativeSessionError::Incompatible);
        }
        Ok(identity.clone())
    }
}

#[uniffi::export]
impl NativeSession {
    /// Trusted host grants an exclusive lease, with no local write permission change.
    pub fn attach_host_transport(
        &self,
        options: NativeHostTransportOptions,
        now: u64,
    ) -> Result<String> {
        self.call(move |state| {
            state.service.session().observed_revision()?;
            let identity = state.host_identity(&options.identity_json)?;
            if options.max_frame_bytes == 0
                || options.max_frame_bytes > 16 * 1024 * 1024
                || options.max_queue_bytes < options.max_frame_bytes
                || options.max_queue_bytes > 32 * 1024 * 1024
                || options.max_queue_frames == 0
                || options.max_queue_frames > 32
            {
                return Err(NativeSessionError::ResourceLimit);
            }
            let next = state
                .next_connection
                .checked_add(1)
                .ok_or(NativeSessionError::ResourceLimit)?;
            let queue = HostQueue(Rc::new(RefCell::new(PreparedTransport::new(
                identity,
                ConnectionState::Authorized,
                TransportCapabilities {
                    receipts: if options.durable_receipts {
                        ReceiptCapability::DurableV1
                    } else {
                        ReceiptCapability::Unknown
                    },
                    max_frame_bytes: options.max_frame_bytes as usize,
                    max_queue_bytes: options.max_queue_bytes as usize,
                    max_queue_frames: options.max_queue_frames as usize,
                },
            )?)));
            state
                .service
                .attach_transport(Box::new(queue.clone()), options.expires_at, now)?;
            let token = format!("host:{}:{next}", state.anchor_owner);
            state.next_connection = next;
            state.host_transport = Some(HostConnection {
                token: token.clone(),
                queue,
            });
            Ok(token)
        })
    }
    /// Detach/revoke only this connection. A stale event cannot revoke a newer lease.
    pub fn detach_host_transport(&self, token: String) -> Result<()> {
        self.call(move |state| {
            if state
                .host_transport
                .as_ref()
                .is_none_or(|c| c.token != token)
            {
                return Err(NativeSessionError::Unauthorized);
            }
            state.service.detach_transport();
            state.host_transport = None;
            Ok(())
        })
    }
    /// Existing Session y-protocols flush. Partial queueing on backpressure is retained.
    pub fn flush_host_transport(&self, token: String, now: u64) -> Result<u64> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            Ok(state.service.flush_pending(now)? as u64)
        })
    }
    /// Page over exact durable pending identities without manufacturing receipts.
    pub fn flush_host_transport_page(
        &self,
        token: String,
        after: Option<NativeHostReceipt>,
        max_frames: u32,
        now: u64,
    ) -> Result<u64> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            if max_frames == 0 || max_frames > 32 {
                return Err(NativeSessionError::ResourceLimit);
            }
            let after = after
                .map(|receipt| -> Result<UpdateId> {
                    Ok(UpdateId {
                        identity: state.host_identity(&receipt.identity_json)?,
                        writer: receipt.writer,
                        sequence: receipt.sequence,
                        checksum: receipt.checksum.try_into().map_err(|_| {
                            NativeSessionError::Store {
                                reason: NativeStoreFailure::InvalidRecord,
                            }
                        })?,
                    })
                })
                .transpose()?;
            Ok(state
                .service
                .flush_pending_page(after.as_ref(), max_frames as usize, now)?
                as u64)
        })
    }
    /// Pull copied outbound frames; delivery is never a remote durable acknowledgment.
    pub fn take_host_frames(
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
            let mut queue = connection.queue.clone();
            let mut frames = Vec::new();
            for _ in 0..max_frames {
                let Some(frame) = queue.receive()? else { break };
                debug_assert_eq!(frame.kind, FrameKind::Sync);
                frames.push(NativeHostFrame {
                    identity_json: editac_core::interchange::identity(&frame.identity).to_string(),
                    bytes: frame.bytes,
                });
            }
            Ok(frames)
        })
    }
    /// Existing trusted-host journal admission, additionally bound to the active lease.
    pub fn receive_host_peer(
        &self,
        token: String,
        update: NativeSessionPeerUpdate,
        now: u64,
    ) -> Result<NativeSessionCommit> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            // Bound admitted update bytes by the connection limit and shared journal guards.
            if update.bytes.len()
                > state
                    .host_connection(&token, now)?
                    .queue
                    .capabilities()
                    .max_frame_bytes
            {
                return Err(NativeSessionError::ResourceLimit);
            }
            state.receive_peer_update(update)
        })
    }
    /// Exact authenticated application receipt; only the existing atomic store path prunes.
    pub fn accept_host_receipt(
        &self,
        token: String,
        receipt: NativeHostReceipt,
        now: u64,
    ) -> Result<NativeHostReceiptResult> {
        self.call(move |state| {
            state.host_connection(&token, now)?;
            let identity = state.host_identity(&receipt.identity_json)?;
            let checksum = receipt
                .checksum
                .try_into()
                .map_err(|_| NativeSessionError::Store {
                    reason: NativeStoreFailure::InvalidRecord,
                })?;
            let result = state.service.accept_receipt(
                DurableReceipt {
                    protocol: ReceiptCapability::DurableV1,
                    update: UpdateId {
                        identity,
                        writer: receipt.writer,
                        sequence: receipt.sequence,
                        checksum,
                    },
                },
                now,
            )?;
            Ok(match result {
                ReceiptResult::RemoteCommitted => NativeHostReceiptResult::RemoteCommitted,
                ReceiptResult::CapabilityUnavailable => {
                    NativeHostReceiptResult::CapabilityUnavailable
                }
                ReceiptResult::UnknownUpdate => NativeHostReceiptResult::UnknownUpdate,
            })
        })
    }
}
