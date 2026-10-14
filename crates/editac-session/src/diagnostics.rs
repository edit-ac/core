//! Opt-in support diagnostics. This export is distinct from content-bearing recovery export.
//! No caller-provided string, document identity, URL, payload or error message is accepted.
use crate::{
    locator::LocatorError,
    ports::{ConnectionState, Durability, MAX_SEQUENCE, PortError},
    service_lifecycle::ServiceOutcome,
    session::{
        AuthState, LocalState, PermissionState, Readiness, RemoteState, SessionError, SessionState,
    },
};
use std::collections::VecDeque;
use std::fmt::Write;

pub const MAX_EVENTS: usize = 64;
pub const MAX_ELAPSED_MS: u64 = 86_400_000;
pub const MAX_COUNT: usize = 4096;

macro_rules! vocabulary {
    ($name:ident { $($variant:ident => $code:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name { $($variant),+ }
        impl $name { pub const fn code(self) -> &'static str { match self { $(Self::$variant => $code),+ } } }
    };
}
vocabulary!(Source { Session => "session", Store => "store", Resolver => "resolver", Converter => "converter", Host => "host" });
vocabulary!(ErrorCode {
    None => "none", Invalid => "invalid", Incompatible => "incompatible", Integrity => "integrity",
    Conflict => "conflict", Sequence => "sequence", Quota => "quota", PermissionLoss => "permission-loss",
    Unavailable => "unavailable", ResourceLimit => "resource-limit", Saturated => "saturated",
    CommitUnknown => "commit-unknown", RecoveryRequired => "recovery-required", Cancelled => "cancelled",
    Disposed => "disposed", Deadline => "deadline", StaleRevision => "stale-revision",
    ReplacedSession => "replaced-session", ProviderFailed => "provider-failed"
});
vocabulary!(RecoveryAction {
    None => "none", RecoverStore => "recover-store", PreserveExport => "preserve-export",
    MigrationExport => "migration-export", Reauthorize => "reauthorize", RetryBounded => "retry-bounded",
    ReduceInput => "reduce-input", WaitCapacity => "wait-capacity", Stop => "stop",
    RefreshDerived => "refresh-derived", ReopenSession => "reopen-session"
});
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: ErrorCode,
    pub recovery: RecoveryAction,
}
impl Failure {
    const fn new(code: ErrorCode, recovery: RecoveryAction) -> Self {
        Self { code, recovery }
    }
    pub const READY: Self = Self::new(ErrorCode::None, RecoveryAction::None);
}
pub fn store_failure(error: PortError) -> Failure {
    use ErrorCode as C;
    use RecoveryAction as R;
    match error {
        PortError::InvalidRecord => Failure::new(C::Invalid, R::PreserveExport),
        PortError::Incompatible => Failure::new(C::Incompatible, R::MigrationExport),
        PortError::Integrity => Failure::new(C::Integrity, R::PreserveExport),
        PortError::Conflict => Failure::new(C::Conflict, R::RecoverStore),
        PortError::Sequence => Failure::new(C::Sequence, R::PreserveExport),
        PortError::Quota => Failure::new(C::Quota, R::RecoverStore),
        PortError::Permission => Failure::new(C::PermissionLoss, R::Reauthorize),
        PortError::Unavailable => Failure::new(C::Unavailable, R::RetryBounded),
        PortError::ResourceLimit => Failure::new(C::ResourceLimit, R::ReduceInput),
        PortError::Backpressure => Failure::new(C::Saturated, R::WaitCapacity),
        PortError::CommitUnknown => Failure::new(C::CommitUnknown, R::RecoverStore),
    }
}
pub fn locator_failure(error: &LocatorError) -> Failure {
    use LocatorError::*;
    match error {
        UnknownAuthority | UnknownAppHost => {
            Failure::new(ErrorCode::Unavailable, RecoveryAction::Reauthorize)
        }
        ConflictingIdentity | InvalidIdentity => {
            Failure::new(ErrorCode::Incompatible, RecoveryAction::MigrationExport)
        }
        InvalidLocator | InvalidDocumentId | InvalidAuthority | InvalidAppHost
        | DuplicateMapping | InvalidLocalPath => {
            Failure::new(ErrorCode::Invalid, RecoveryAction::ReduceInput)
        }
    }
}
pub fn service_failure(outcome: ServiceOutcome) -> Failure {
    use ErrorCode as C;
    use RecoveryAction as R;
    match outcome {
        ServiceOutcome::Ready => Failure::READY,
        ServiceOutcome::Invalid => Failure::new(C::Invalid, R::ReduceInput),
        ServiceOutcome::ResourceLimit => Failure::new(C::ResourceLimit, R::ReduceInput),
        ServiceOutcome::Saturated => Failure::new(C::Saturated, R::WaitCapacity),
        ServiceOutcome::Cancelled => Failure::new(C::Cancelled, R::Stop),
        ServiceOutcome::Disposed => Failure::new(C::Disposed, R::Stop),
        ServiceOutcome::Deadline => Failure::new(C::Deadline, R::RetryBounded),
        ServiceOutcome::StaleRevision => Failure::new(C::StaleRevision, R::RefreshDerived),
        ServiceOutcome::ReplacedSession => Failure::new(C::ReplacedSession, R::ReopenSession),
        ServiceOutcome::PermissionLoss => Failure::new(C::PermissionLoss, R::Reauthorize),
        ServiceOutcome::ProviderFailed => Failure::new(C::ProviderFailed, R::RetryBounded),
    }
}
pub fn session_failure(error: &SessionError) -> Failure {
    use ErrorCode as C;
    use RecoveryAction as R;
    match error {
        SessionError::Store(error) => store_failure(*error),
        SessionError::Locator(error) => locator_failure(error),
        SessionError::Unauthorized | SessionError::ReadOnly | SessionError::PermissionExpired => {
            Failure::new(C::PermissionLoss, R::Reauthorize)
        }
        SessionError::Unavailable => Failure::new(C::Unavailable, R::RetryBounded),
        SessionError::Locked => Failure::new(C::Conflict, R::ReopenSession),
        SessionError::Incompatible => Failure::new(C::Incompatible, R::MigrationExport),
        SessionError::RecoveryRequired => Failure::new(C::RecoveryRequired, R::RecoverStore),
        SessionError::Document(_)
        | SessionError::Text(_)
        | SessionError::History(_)
        | SessionError::Revision(_) => Failure::new(C::Invalid, R::PreserveExport),
    }
}

/// All fields are closed vocabularies or bounded numbers. Never store the full session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SupportState {
    pub readiness: Readiness,
    pub local: LocalState,
    pub remote: RemoteState,
    pub connection: ConnectionState,
    pub auth: AuthState,
    pub permission: PermissionState,
    pending: usize,
    pub conflict: bool,
}
impl From<&SessionState> for SupportState {
    fn from(s: &SessionState) -> Self {
        Self {
            readiness: s.readiness,
            local: s.local,
            remote: s.remote,
            connection: s.connection,
            auth: s.auth,
            permission: s.permission,
            pending: s.pending_upload.min(MAX_COUNT),
            conflict: s.conflict,
        }
    }
}
#[derive(Clone, Copy, Debug)]
struct Event {
    operation: u64,
    source: Source,
    failure: Failure,
    elapsed_ms: u64,
    active: usize,
    queued: usize,
    state: Option<SupportState>,
}
#[derive(Default, Debug)]
pub struct SupportDiagnostics {
    events: VecDeque<Event>,
    next: u64,
    dropped: u64,
}
impl SupportDiagnostics {
    /// IDs are local monotonic correlation numbers, never caller-supplied document/session IDs.
    pub fn record(
        &mut self,
        source: Source,
        failure: Failure,
        elapsed_ms: u64,
        active: usize,
        queued: usize,
    ) -> u64 {
        self.next = self.next.saturating_add(1).min(MAX_SEQUENCE);
        if self.events.len() == MAX_EVENTS {
            self.events.pop_front();
            self.dropped = self.dropped.saturating_add(1).min(MAX_SEQUENCE);
        }
        self.events.push_back(Event {
            operation: self.next,
            source,
            failure,
            elapsed_ms: elapsed_ms.min(MAX_ELAPSED_MS),
            active: active.min(MAX_COUNT),
            queued: queued.min(MAX_COUNT),
            state: None,
        });
        self.next
    }
    /// Capture actual durability/readiness without exporting journal, checkpoint or origins.
    pub fn record_session(
        &mut self,
        state: &SessionState,
        error: Option<&SessionError>,
        elapsed_ms: u64,
    ) -> u64 {
        let mut failure = error
            .map(session_failure)
            .or_else(|| state.recovery_error.map(store_failure))
            .unwrap_or(Failure::READY);
        // Frozen session writes must reconcile persisted bytes before retrying.
        if state.readiness == Readiness::RecoveryRequired
            && matches!(
                failure.recovery,
                RecoveryAction::RetryBounded
                    | RecoveryAction::ReduceInput
                    | RecoveryAction::WaitCapacity
            )
        {
            failure.recovery = RecoveryAction::RecoverStore;
        }
        let source =
            if state.recovery_error.is_some() || matches!(error, Some(SessionError::Store(_))) {
                Source::Store
            } else {
                Source::Session
            };
        let id = self.record(source, failure, elapsed_ms, 0, 0);
        self.events.back_mut().expect("record inserted event").state = Some(state.into());
        id
    }
    /// Fixed schema/version and literal enum spellings; bounded even under repeated failures.
    pub fn export(&self) -> String {
        let mut out = format!("{{\"version\":1,\"dropped\":{},\"events\":[", self.dropped);
        for (i, e) in self.events.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            write!(out, "{{\"operation\":{},\"source\":\"{}\",\"error\":\"{}\",\"recovery\":\"{}\",\"elapsedMs\":{},\"active\":{},\"queued\":{}", e.operation, e.source.code(), e.failure.code.code(), e.failure.recovery.code(), e.elapsed_ms, e.active, e.queued).expect("String write");
            if let Some(s) = e.state {
                let local = match s.local {
                    LocalState::Initialized(_) => "initialized",
                    LocalState::Committed(_) => "committed",
                    LocalState::Unsaved => "unsaved",
                };
                let durability = match s.local {
                    LocalState::Initialized(d) | LocalState::Committed(d) => match d {
                        Durability::Volatile => "volatile",
                        Durability::ProcessCrash => "process-crash",
                        Durability::Unknown => "unknown",
                    },
                    LocalState::Unsaved => "unknown",
                };
                let readiness = match s.readiness {
                    Readiness::Ready => "ready",
                    Readiness::RecoveryRequired => "recovery-required",
                };
                let remote = match s.remote {
                    RemoteState::Unknown => "unknown",
                    RemoteState::SentDurabilityUnknown => "sent-durability-unknown",
                    RemoteState::RemotelyCommitted => "remotely-committed",
                };
                let connection = match s.connection {
                    ConnectionState::Disconnected => "disconnected",
                    ConnectionState::Authorized => "authorized",
                    ConnectionState::Unauthorized => "unauthorized",
                    ConnectionState::Incompatible => "incompatible",
                };
                let auth = match s.auth {
                    AuthState::Detached => "detached",
                    AuthState::Authorized => "authorized",
                    AuthState::Expired => "expired",
                    AuthState::Unauthorized => "unauthorized",
                };
                let permission = match s.permission {
                    PermissionState::Writable => "writable",
                    PermissionState::ReadOnly => "read-only",
                    PermissionState::Expired => "expired",
                };
                write!(out, ",\"state\":{{\"readiness\":\"{readiness}\",\"local\":\"{local}\",\"durability\":\"{durability}\",\"remote\":\"{remote}\",\"connection\":\"{connection}\",\"auth\":\"{auth}\",\"permission\":\"{permission}\",\"pending\":{},\"conflict\":{}}}", s.pending, s.conflict).expect("String write");
            }
            out.push('}');
        }
        out.push_str("]}");
        out
    }
}
