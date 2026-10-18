//! Optional host-service contract, not document schema or an input dispatcher.
//! Registration/status never receive a Document. Hosts retain anchors, permissions,
//! transport handles and timers; AIN session consumers resolve through the engine.
use crate::{anchors::Anchor, document::DocumentIdentity};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub const ASSISTIVE_VERSION: u32 = 1;
pub const ASSISTIVE_PROFILE: &str = "editac-assistive-input-v1";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    Commands,
    Status,
    HostTransport,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Limits {
    pub text_bytes: u32,
    pub status_bytes: u32,
    pub commands: u32,
    pub results: u32,
    pub sessions: u32,
    pub timeout_ms: u32,
}
impl Limits {
    pub fn validate(&self) -> Result<(), Error> {
        for (value, max) in [
            (self.text_bytes, 16_384),
            (self.status_bytes, 512),
            (self.commands, 64),
            (self.results, 1024),
            (self.sessions, 8),
            (self.timeout_ms, 120_000),
        ] {
            if value == 0 || value > max {
                return Err(Error::Limits);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InputKind {
    Audio,
    Transcript,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Locality {
    OnDevice,
    Remote,
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionOwner {
    Host,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Retention {
    None,
    Session,
    HostPolicy,
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CancelBehavior {
    Abort,
    BestEffort,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TransportCapabilities {
    pub input: InputKind,
    pub locality: Locality,
    pub permission_owner: PermissionOwner,
    pub retention: Retention,
    pub cancellation: CancelBehavior,
    pub can_stop: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Descriptor {
    pub version: u32,
    pub enabled: bool,
    pub capabilities: Vec<Capability>,
    pub limits: Limits,
    #[serde(deserialize_with = "required_nullable")]
    pub transport: Option<TransportCapabilities>,
}
impl Descriptor {
    pub fn validate(&self) -> Result<(), Error> {
        version(self.version)?;
        self.limits.validate()?;
        if self.capabilities.is_empty()
            || self.capabilities.len() > 3
            || self
                .capabilities
                .iter()
                .enumerate()
                .any(|(i, c)| self.capabilities[..i].contains(c))
            || self.capabilities.contains(&Capability::HostTransport) != self.transport.is_some()
        {
            return Err(Error::Capability);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Error {
    Version,
    Limits,
    Capability,
    Duplicate,
    Unavailable,
    Disposed,
    InvalidEnvelope,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Unsupported,
    PermissionDenied,
    Unavailable,
    ReadOnly,
    Composing,
    Canceled,
    Stale,
    Malformed,
    Oversized,
    Timeout,
    Disconnected,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Idle,
    Starting,
    Active,
    Preparing,
    Completed,
    Cancelled,
    Stale,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionIdentity {
    pub session_id: String,
    pub generation: u32,
}
impl SessionIdentity {
    pub fn validate(&self) -> Result<(), Error> {
        if !identifier(&self.session_id) || self.generation == 0 {
            return Err(Error::InvalidEnvelope);
        }
        Ok(())
    }
}
/// Local only. Never serialize anchors/document context into a transport request.
/// The capturing host releases its anchors; registry disposal does not own them.
#[derive(Clone, Debug)]
pub struct Target {
    pub identity: DocumentIdentity,
    pub anchor: Anchor,
    pub focus: Anchor,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommandApplicability {
    /// Existing semantic command identity; this contract does not dispatch it.
    pub command_id: String,
    pub label: String,
    pub enabled: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<Outcome>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresenterStatus {
    pub version: u32,
    pub state: State,
    #[serde(deserialize_with = "required_nullable")]
    pub session: Option<SessionIdentity>,
    #[serde(deserialize_with = "required_nullable")]
    pub reason: Option<Outcome>,
    /// Perceivable status only; never put transcript text in announcements by default.
    pub message: String,
    /// Disposable bounded presenter state, never a document update or telemetry.
    pub provisional: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ResultKind {
    Provisional,
    Final,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultEnvelope {
    pub version: u32,
    pub session: SessionIdentity,
    pub sequence: u32,
    pub kind: ResultKind,
    pub text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StartRequest {
    pub version: u32,
    pub session: SessionIdentity,
}
#[derive(Clone, Debug)]
pub enum TransportEvent {
    Result(ResultEnvelope),
    Error {
        session: SessionIdentity,
        reason: Outcome,
    },
}
/// Host owns permission, processing, retention, callbacks and resource release.
/// Stop requests a final result; cancel rejects late results before cleanup.
pub trait TransportSession {
    fn stop(&mut self);
    fn cancel(&mut self);
    fn dispose(&mut self);
}
pub trait Transport {
    fn start(
        &mut self,
        request: &StartRequest,
        cancellation: Cancellation,
        emit: Box<dyn FnMut(TransportEvent) + Send>,
    ) -> Result<Box<dyn TransportSession>, Outcome>;
}
#[derive(Clone, Debug, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_canceled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Mirrors the existing optional host-extension boundary, not the data registry.
/// Validation is atomic; failed registration cannot replace an accepted descriptor.
#[derive(Default)]
pub struct Registration {
    descriptor: Option<Descriptor>,
    disposed: bool,
    cancellation: Cancellation,
}
impl Registration {
    pub fn register(&mut self, descriptor: Descriptor) -> Result<(), Error> {
        if self.disposed {
            return Err(Error::Disposed);
        }
        descriptor.validate()?;
        if self.descriptor.is_some() {
            return Err(Error::Duplicate);
        }
        self.descriptor = Some(descriptor);
        Ok(())
    }
    pub fn descriptor(&self) -> Option<&Descriptor> {
        self.descriptor.as_ref()
    }
    pub fn supports(&self, capability: Capability) -> bool {
        !self.disposed
            && self
                .descriptor
                .as_ref()
                .is_some_and(|d| d.enabled && d.capabilities.contains(&capability))
    }
    pub fn cancellation(&self) -> Cancellation {
        self.cancellation.clone()
    }
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.cancellation.cancel();
        self.descriptor = None;
    }
    fn require(&self, capability: Capability) -> Result<&Limits, Error> {
        if self.disposed {
            return Err(Error::Disposed);
        }
        if !self.supports(capability) {
            return Err(Error::Unavailable);
        }
        Ok(&self.descriptor.as_ref().unwrap().limits)
    }
    pub fn validate_commands(&self, commands: &[CommandApplicability]) -> Result<(), Error> {
        let limits = self.require(Capability::Commands)?;
        if commands.len() > limits.commands as usize {
            return Err(Error::Limits);
        }
        for (i, c) in commands.iter().enumerate() {
            if !identifier(&c.command_id)
                || c.label.trim().is_empty()
                || c.label.len() > limits.status_bytes as usize
                || c.enabled == c.reason.is_some()
                || commands[..i].iter().any(|p| p.command_id == c.command_id)
            {
                return Err(Error::InvalidEnvelope);
            }
        }
        Ok(())
    }
    pub fn validate_status(&self, status: &PresenterStatus) -> Result<(), Error> {
        let limits = self.require(Capability::Status)?;
        version(status.version)?;
        if let Some(session) = &status.session {
            session.validate()?;
        }
        if status.message.len() > limits.status_bytes as usize
            || status.provisional.len() > limits.text_bytes as usize
        {
            return Err(Error::Limits);
        }
        Ok(())
    }
    pub fn validate_result(&self, result: &ResultEnvelope) -> Result<(), Error> {
        let limits = self.require(Capability::HostTransport)?;
        version(result.version)?;
        result.session.validate()?;
        if result.sequence >= limits.results || result.text.len() > limits.text_bytes as usize {
            return Err(Error::Limits);
        }
        Ok(())
    }
    pub fn validate_start(&self, request: &StartRequest) -> Result<(), Error> {
        self.require(Capability::HostTransport)?;
        version(request.version)?;
        request.session.validate()
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.dispose();
    }
}
fn version(v: u32) -> Result<(), Error> {
    if v == ASSISTIVE_VERSION {
        Ok(())
    } else {
        Err(Error::Version)
    }
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
}
fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
