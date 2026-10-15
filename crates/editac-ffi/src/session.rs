//! Durable shared Session on the existing UniFFI boundary. No foreign callbacks or
//! mutable engine escape. This is an ownership/translation adapter, not a replica.
use editac_core::{
    Utf16Offset,
    commands::{editor::EditorCommand, text::TextOrigin},
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    edit_service::{EditService, HostPolicy, PreparedEdit, ServiceError},
    ports::{Durability, LocalCommit, PortError, StoreLimits},
    revision::{ObservedRevision, RevisionError},
    session::{CachedPermission, Session, SessionError},
    store::NativeStore,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeStoreFailure {
    InvalidRecord,
    Incompatible,
    Integrity,
    Conflict,
    Sequence,
    Quota,
    Permission,
    Unavailable,
    ResourceLimit,
    Backpressure,
    CommitUnknown,
}
impl From<PortError> for NativeStoreFailure {
    fn from(error: PortError) -> Self {
        match error {
            PortError::InvalidRecord => Self::InvalidRecord,
            PortError::Incompatible => Self::Incompatible,
            PortError::Integrity => Self::Integrity,
            PortError::Conflict => Self::Conflict,
            PortError::Sequence => Self::Sequence,
            PortError::Quota => Self::Quota,
            PortError::Permission => Self::Permission,
            PortError::Unavailable => Self::Unavailable,
            PortError::ResourceLimit => Self::ResourceLimit,
            PortError::Backpressure => Self::Backpressure,
            PortError::CommitUnknown => Self::CommitUnknown,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeRevisionFailure {
    InvalidToken,
    InvalidObservedState,
    ResourceLimit,
    Document,
    ScopeMismatch,
    Stale,
}
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeSessionError {
    #[error("store: {reason:?}")]
    Store { reason: NativeStoreFailure },
    #[error("document: {message}")]
    Document { message: String },
    #[error("text: {message}")]
    Text { message: String },
    #[error("history: {message}")]
    History { message: String },
    #[error("revision: {reason:?}: {message}")]
    Revision {
        reason: NativeRevisionFailure,
        message: String,
    },
    #[error("locator: {message}")]
    Locator { message: String },
    #[error("unavailable")]
    Unavailable,
    #[error("locked")]
    Locked,
    #[error("unauthorized")]
    Unauthorized,
    #[error("incompatible")]
    Incompatible,
    #[error("read only")]
    ReadOnly,
    #[error("permission expired")]
    PermissionExpired,
    #[error("recovery required")]
    RecoveryRequired,
    #[error("history view")]
    HistoryView,
    #[error("unqualified history")]
    UnqualifiedHistory,
    #[error("unsupported module")]
    UnsupportedModule,
    #[error("resource limit")]
    ResourceLimit,
    #[error("engine: {message}")]
    Engine { message: String },
    #[error("source: {message}")]
    Source { message: String },
    #[error("operation: {message}")]
    Operation { message: String },
    #[error("invalid or consumed plan")]
    InvalidPlan,
    #[error("session disposed")]
    Disposed,
    #[error("executor unavailable")]
    ExecutorUnavailable,
}
type Result<T> = std::result::Result<T, NativeSessionError>;
impl From<PortError> for NativeSessionError {
    fn from(error: PortError) -> Self {
        Self::Store {
            reason: error.into(),
        }
    }
}
impl From<RevisionError> for NativeSessionError {
    fn from(error: RevisionError) -> Self {
        let reason = match &error {
            RevisionError::InvalidToken => NativeRevisionFailure::InvalidToken,
            RevisionError::InvalidObservedState => NativeRevisionFailure::InvalidObservedState,
            RevisionError::ResourceLimit => NativeRevisionFailure::ResourceLimit,
            RevisionError::Document(_) => NativeRevisionFailure::Document,
            RevisionError::ScopeMismatch => NativeRevisionFailure::ScopeMismatch,
            RevisionError::Stale => NativeRevisionFailure::Stale,
        };
        Self::Revision {
            reason,
            message: error.to_string(),
        }
    }
}
impl From<SessionError> for NativeSessionError {
    fn from(error: SessionError) -> Self {
        match error {
            SessionError::Store(e) => e.into(),
            SessionError::Document(e) => Self::Document {
                message: format!("{e:?}"),
            },
            SessionError::Text(e) => Self::Text {
                message: format!("{e:?}"),
            },
            SessionError::History(e) => Self::History {
                message: format!("{e:?}"),
            },
            SessionError::Revision(e) => e.into(),
            SessionError::Locator(e) => Self::Locator {
                message: format!("{e:?}"),
            },
            SessionError::Unavailable => Self::Unavailable,
            SessionError::Locked => Self::Locked,
            SessionError::Unauthorized => Self::Unauthorized,
            SessionError::Incompatible => Self::Incompatible,
            SessionError::ReadOnly => Self::ReadOnly,
            SessionError::PermissionExpired => Self::PermissionExpired,
            SessionError::RecoveryRequired => Self::RecoveryRequired,
        }
    }
}
impl From<ServiceError> for NativeSessionError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::Session(e) => e.into(),
            ServiceError::Engine(e) => Self::Engine {
                message: format!("{e:?}"),
            },
            ServiceError::Source(e) => Self::Source {
                message: format!("{e:?}"),
            },
            ServiceError::Operation(e) => Self::Operation {
                message: format!("{e:?}"),
            },
            ServiceError::ReadOnly => Self::ReadOnly,
            ServiceError::HistoryView => Self::HistoryView,
            ServiceError::UnqualifiedHistory => Self::UnqualifiedHistory,
            ServiceError::UnsupportedModule => Self::UnsupportedModule,
            ServiceError::ResourceLimit => Self::ResourceLimit,
            ServiceError::SourceConflict { conflict, .. } => Self::Source {
                message: format!("{conflict:?}"),
            },
        }
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionOptions {
    /// Absolute, explicitly host-granted local path; no URI/network resolution.
    pub path: String,
    pub document_id: String,
    pub epoch: String,
    pub writable: bool,
    pub permission_expires_at: Option<u64>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionSeed {
    pub kind: String,
    pub text: String,
}
/// Minimal text presentation DTO, not a writable projection or full rich SDK view.
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionNode {
    pub id: String,
    pub kind: String,
    pub text: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeSessionDurability {
    Volatile,
    ProcessCrash,
    Unknown,
}
impl From<Durability> for NativeSessionDurability {
    fn from(value: Durability) -> Self {
        match value {
            Durability::Volatile => Self::Volatile,
            Durability::ProcessCrash => Self::ProcessCrash,
            Durability::Unknown => Self::Unknown,
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionCommit {
    pub writer: u32,
    pub sequence: u64,
    pub checksum: Vec<u8>,
    pub durability: NativeSessionDurability,
}
impl From<LocalCommit> for NativeSessionCommit {
    fn from(value: LocalCommit) -> Self {
        Self {
            writer: value.update.writer,
            sequence: value.update.sequence,
            checksum: value.update.checksum.to_vec(),
            durability: value.durability.into(),
        }
    }
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionRead {
    /// None while recovery-required: unsaved state cannot mint an acknowledged revision.
    pub revision: Option<Vec<u8>>,
    pub nodes: Vec<NativeSessionNode>,
    pub recovery_required: bool,
    pub pending_upload: u64,
    pub locally_committed: bool,
    pub local_durability: NativeSessionDurability,
    pub can_apply: bool,
    pub can_history: bool,
    pub recovery_error: Option<NativeStoreFailure>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionEdit {
    pub node: String,
    pub from_utf16: u32,
    pub to_utf16: u32,
    pub text: String,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeSessionRecovery {
    /// Owned engine checkpoint; salvage is never a durable receipt.
    pub checkpoint: crate::OwnedCheckpoint,
    pub locally_committed: bool,
    pub unjournaled_update: Option<Vec<u8>>,
}

struct State {
    service: EditService<Arc<NativeStore>>,
    plans: BTreeMap<String, PreparedEdit>,
    next_plan: u64,
}
impl State {
    fn new(session: Session<Arc<NativeStore>>) -> Self {
        Self {
            service: EditService::new(session, HostPolicy::default()),
            plans: BTreeMap::new(),
            next_plan: 0,
        }
    }
}
type Task = Box<dyn FnOnce(&mut State) + Send>;
struct SessionWorker {
    sender: Option<mpsc::SyncSender<Task>>,
    join: Option<JoinHandle<()>>,
}
impl SessionWorker {
    fn start(make: impl FnOnce() -> Result<State> + Send + 'static) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Task>(1);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("editac-session".into())
            .spawn(move || {
                match make() {
                    Ok(mut state) => {
                        if ready_tx.send(Ok(())).is_ok() {
                            while let Ok(task) = receiver.recv() {
                                task(&mut state);
                            }
                        }
                        // All plans, document/history and SQLite owner drop here, before join.
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                }
            })
            .map_err(|_| NativeSessionError::ExecutorUnavailable)?;
        let mut worker = Self {
            sender: Some(sender),
            join: Some(join),
        };
        match ready_rx
            .recv()
            .map_err(|_| NativeSessionError::ExecutorUnavailable)?
        {
            Ok(()) => Ok(worker),
            Err(error) => {
                worker.stop();
                Err(error)
            }
        }
    }
    fn call<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut State) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .as_ref()
            .ok_or(NativeSessionError::Disposed)?
            .send(Box::new(move |state| {
                let _ = tx.send(f(state));
            }))
            .map_err(|_| NativeSessionError::ExecutorUnavailable)?;
        rx.recv()
            .map_err(|_| NativeSessionError::ExecutorUnavailable)?
    }
    fn stop(&mut self) {
        self.sender.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
impl Drop for SessionWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Foreign aliases share this single serialized owner. No callback API is exported;
/// owned synchronous results precede the next submission and survive disposal.
#[derive(uniffi::Object)]
pub struct NativeSession {
    worker: Mutex<Option<SessionWorker>>,
}
impl NativeSession {
    fn start(make: impl FnOnce() -> Result<State> + Send + 'static) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            worker: Mutex::new(Some(SessionWorker::start(make)?)),
        }))
    }
    fn call<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut State) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        let worker = self
            .worker
            .lock()
            .map_err(|_| NativeSessionError::ExecutorUnavailable)?;
        worker.as_ref().ok_or(NativeSessionError::Disposed)?.call(f)
    }
}
fn identity(options: &NativeSessionOptions) -> Result<DocumentIdentity> {
    DocumentIdentity::v5(&options.document_id, &options.epoch).map_err(|e| {
        NativeSessionError::Document {
            message: format!("{e:?}"),
        }
    })
}
fn permission(options: &NativeSessionOptions) -> CachedPermission {
    CachedPermission {
        writable: options.writable,
        expires_at: options.permission_expires_at,
    }
}
#[uniffi::export]
impl NativeSession {
    /// Explicit exclusive file creation, never replacement or a failed-open fallback.
    #[uniffi::constructor]
    pub fn create_local(
        options: NativeSessionOptions,
        initial: Vec<NativeSessionSeed>,
    ) -> Result<Arc<Self>> {
        Self::start(move || {
            let id = identity(&options)?;
            let store = Arc::new(NativeStore::create_new(
                &options.path,
                id.clone(),
                StoreLimits::default(),
            )?);
            let initial = initial
                .into_iter()
                .map(|n| InitialNode {
                    kind: n.kind,
                    text: n.text,
                })
                .collect::<Vec<_>>();
            let mut session = Session::create_local(store, id, &initial)?;
            session.set_permission(permission(&options));
            Ok(State::new(session))
        })
    }
    #[uniffi::constructor]
    pub fn open(options: NativeSessionOptions) -> Result<Arc<Self>> {
        Self::start(move || {
            let id = identity(&options)?;
            let store = Arc::new(NativeStore::open_existing(
                &options.path,
                id.clone(),
                StoreLimits::default(),
            )?);
            Ok(State::new(Session::open(store, &id, permission(&options))?))
        })
    }
    pub fn read(&self, now: u64) -> Result<NativeSessionRead> {
        self.call(move |state| {
            let session = state.service.session();
            let status = session.state(now);
            let revision = match session.observed_revision() {
                Ok(revision) => Some(revision.to_bytes().to_vec()),
                Err(SessionError::RecoveryRequired) => None,
                Err(error) => return Err(error.into()),
            };
            let snapshot =
                session
                    .document()
                    .snapshot()
                    .map_err(|error| NativeSessionError::Engine {
                        message: format!("{error:?}"),
                    })?;
            let capabilities = state.service.capabilities(now);
            use editac_session::session::{LocalState, Readiness};
            let (locally_committed, local_durability) = match status.local {
                LocalState::Initialized(d) | LocalState::Committed(d) => (true, d.into()),
                LocalState::Unsaved => (false, NativeSessionDurability::Unknown),
            };
            Ok(NativeSessionRead {
                revision,
                nodes: snapshot
                    .visible
                    .iter()
                    .map(|n| NativeSessionNode {
                        id: n.id.clone(),
                        kind: n.kind.clone(),
                        text: n.runs.iter().map(|r| r.text.as_str()).collect(),
                    })
                    .collect(),
                recovery_required: status.readiness == Readiness::RecoveryRequired,
                pending_upload: status.pending_upload as u64,
                locally_committed,
                local_durability,
                can_apply: capabilities.can_apply,
                can_history: capabilities.can_history,
                recovery_error: status.recovery_error.map(Into::into),
            })
        })
    }
    /// Whole-edit batches use the existing atomic EditService planner. Revision bytes
    /// are equality validators supplied by read(), never authorization credentials.
    pub fn prepare_edits(
        &self,
        revision: Vec<u8>,
        edits: Vec<NativeSessionEdit>,
        origin: String,
        now: u64,
    ) -> Result<String> {
        self.call(move |state| {
            if state.plans.len() >= 128 || edits.len() > 128 {
                return Err(NativeSessionError::ResourceLimit);
            }
            let revision = ObservedRevision::from_bytes(&revision)?;
            let origin = TextOrigin::new(&origin).map_err(|e| NativeSessionError::Text {
                message: format!("{e:?}"),
            })?;
            let commands = edits
                .into_iter()
                .map(|e| EditorCommand::ReplaceAt {
                    owner: e.node,
                    from: Utf16Offset(e.from_utf16),
                    to: Utf16Offset(e.to_utf16),
                    text: e.text,
                })
                .collect::<Vec<_>>();
            let plan = state
                .service
                .prepare_commands(&revision, &commands, &origin, now)?;
            let next = state
                .next_plan
                .checked_add(1)
                .ok_or(NativeSessionError::ResourceLimit)?;
            let token = format!(
                "session:{}:{next}",
                state.service.session().document().writer_id()
            );
            state.next_plan = next;
            state.plans.insert(token.clone(), plan);
            Ok(token)
        })
    }
    /// Single use, including failed admission. Current permission/revision is checked
    /// again by EditService. Cancellation cannot interrupt an accepted commit.
    pub fn commit_edits(&self, token: String, now: u64) -> Result<Option<NativeSessionCommit>> {
        self.call(move |state| {
            let plan = state
                .plans
                .remove(&token)
                .ok_or(NativeSessionError::InvalidPlan)?;
            Ok(state.service.apply(plan, now)?.map(Into::into))
        })
    }
    /// Ordered idempotent release of an uncommitted plan. After disposal: Disposed.
    pub fn cancel_edits(&self, token: String) -> Result<()> {
        self.call(move |state| {
            state.plans.remove(&token);
            Ok(())
        })
    }
    pub fn undo(&self, revision: Vec<u8>, now: u64) -> Result<Option<NativeSessionCommit>> {
        self.call(move |state| {
            Ok(state
                .service
                .undo(&ObservedRevision::from_bytes(&revision)?, now)?
                .map(Into::into))
        })
    }
    pub fn redo(&self, revision: Vec<u8>, now: u64) -> Result<Option<NativeSessionCommit>> {
        self.call(move |state| {
            Ok(state
                .service
                .redo(&ObservedRevision::from_bytes(&revision)?, now)?
                .map(Into::into))
        })
    }
    /// Trusted host permission replacement, serialized with every prepared admission.
    pub fn set_permission(&self, writable: bool, expires_at: Option<u64>) -> Result<()> {
        self.call(move |state| {
            state.service.set_permission(CachedPermission {
                writable,
                expires_at,
            });
            Ok(())
        })
    }
    pub fn recover(&self) -> Result<()> {
        self.call(|state| {
            state.service.recover()?;
            Ok(())
        })
    }
    pub fn recovery_export(&self) -> Result<NativeSessionRecovery> {
        self.call(|state| {
            let export = state.service.session().recovery_export();
            let c = export.checkpoint;
            let i = c.identity;
            let metadata = serde_json::json!({"identity":{"documentId":i.document_id,"epoch":i.epoch,"schema":i.schema,"profile":i.profile,"offsets":i.offsets,"protocolVersion":i.protocol_version,"updateEncoding":i.update_encoding},"initialized":c.initialized,"writerId":c.writer_id});
            Ok(NativeSessionRecovery { checkpoint: crate::OwnedCheckpoint { metadata_json: metadata.to_string(), bytes: c.bytes }, locally_committed: export.locally_committed, unjournaled_update: export.unjournaled.map(|entry| entry.bytes().to_vec()) })
        })
    }
    /// Idempotent across aliases. Waits for accepted work and drops the real Session,
    /// all plans and native store on the owning executor before returning.
    pub fn dispose(&self) -> Result<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| NativeSessionError::ExecutorUnavailable)?;
        if let Some(mut worker) = worker.take() {
            worker.stop();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use editac_session::ports::{
        LocalStore,
        memory::{FaultBoundary, InjectedFault},
    };
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct Fixture {
        directory: PathBuf,
        id: DocumentIdentity,
        store: Arc<NativeStore>,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let directory = root.join(format!("native-session-unit-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&directory).unwrap();
            let id = DocumentIdentity::v5(
                &format!("a9300000-0000-4000-8000-{n:012x}"),
                "a9400000-0000-4000-8000-000000000001",
            )
            .unwrap();
            let store = Arc::new(
                NativeStore::create_new(
                    directory.join("store.sqlite"),
                    id.clone(),
                    StoreLimits::default(),
                )
                .unwrap(),
            );
            Self {
                directory,
                id,
                store,
            }
        }
        fn session(&self) -> Arc<NativeSession> {
            let store = self.store.clone();
            let id = self.id.clone();
            NativeSession::start(move || {
                Ok(State::new(Session::create_local(
                    store,
                    id,
                    &[InitialNode {
                        kind: "block".into(),
                        text: "seed".into(),
                    }],
                )?))
            })
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
    }
    fn plan(s: &NativeSession, text: &str) -> String {
        let r = s.read(0).unwrap();
        s.prepare_edits(
            r.revision.unwrap(),
            vec![NativeSessionEdit {
                node: r.nodes[0].id.clone(),
                from_utf16: 0,
                to_utf16: 4,
                text: text.into(),
            }],
            "fault-test".into(),
            0,
        )
        .unwrap()
    }
    fn reopen(f: &Fixture) -> Arc<NativeSession> {
        NativeSession::open(NativeSessionOptions {
            path: f.store.path().to_str().unwrap().into(),
            document_id: f.id.document_id.clone(),
            epoch: f.id.epoch.clone(),
            writable: true,
            permission_expires_at: None,
        })
        .unwrap()
    }
    fn fault_case(
        boundary: FaultBoundary,
        expected: NativeStoreFailure,
        persisted_before_recovery: &str,
    ) {
        let f = Fixture::new();
        let s = f.session();
        let token = plan(&s, "recovered");
        let revision = s.read(0).unwrap().revision.unwrap();
        f.store
            .inject_once(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(
            matches!(s.commit_edits(token, 0), Err(NativeSessionError::Store { reason }) if reason == expected)
        );
        let r = s.read(0).unwrap();
        assert!(r.recovery_required && !r.can_apply && !r.locally_committed);
        assert_eq!(r.recovery_error, Some(expected));
        let salvage = s.recovery_export().unwrap();
        assert!(!salvage.locally_committed && salvage.unjournaled_update.is_some());
        assert!(matches!(
            s.undo(revision, 0),
            Err(NativeSessionError::RecoveryRequired)
        ));
        let durable = reopen(&f);
        assert_eq!(
            durable.read(0).unwrap().nodes[0].text,
            persisted_before_recovery
        );
        durable.dispose().unwrap();
        s.recover().unwrap();
        assert!(!s.read(0).unwrap().recovery_required);
        assert_eq!(s.read(0).unwrap().nodes[0].text, "recovered");
        assert_eq!(
            f.store.pending(&f.id).unwrap().len(),
            1,
            "exact retained update, no duplicate on retry"
        );
        s.recover().unwrap();
        assert_eq!(f.store.pending(&f.id).unwrap().len(), 1);
        s.dispose().unwrap();
        let reopened = reopen(&f);
        assert_eq!(reopened.read(0).unwrap().nodes[0].text, "recovered");
        reopened.dispose().unwrap();
    }
    #[test]
    fn before_commit_failure_freezes_and_recovers_exact_shared_session_update() {
        fault_case(
            FaultBoundary::BeforeCommit,
            NativeStoreFailure::Quota,
            "seed",
        );
    }
    #[test]
    fn lost_commit_ack_is_typed_and_recovery_does_not_duplicate_journal() {
        fault_case(
            FaultBoundary::AfterCommit,
            NativeStoreFailure::CommitUnknown,
            "recovered",
        );
    }
    #[test]
    fn failed_initial_publish_returns_recoverable_handle_without_false_durability() {
        let f = Fixture::new();
        f.store
            .set_max_pages(f.store.page_count().unwrap())
            .unwrap();
        let store = f.store.clone();
        let id = f.id.clone();
        let seed = "seed".repeat(16_384);
        let expected = seed.clone();
        let s = NativeSession::start(move || {
            Ok(State::new(Session::create_local(
                store,
                id,
                &[InitialNode {
                    kind: "block".into(),
                    text: seed,
                }],
            )?))
        })
        .unwrap();
        let r = s.read(0).unwrap();
        assert!(r.recovery_required && !r.locally_committed && r.revision.is_none());
        assert_eq!(r.recovery_error, Some(NativeStoreFailure::Quota));
        assert!(!s.recovery_export().unwrap().locally_committed);
        f.store.set_max_pages(1_000_000).unwrap();
        s.recover().unwrap();
        assert!(s.read(0).unwrap().locally_committed);
        s.dispose().unwrap();
        let reopened = reopen(&f);
        assert_eq!(reopened.read(0).unwrap().nodes[0].text, expected);
        reopened.dispose().unwrap();
    }
    #[test]
    fn accepted_commit_completes_before_disposal_and_ordered_cancellation_cannot_rollback() {
        let f = Fixture::new();
        let s = f.session();
        let token = plan(&s, "committed");
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let commit_owner = s.clone();
        let commit_token = token.clone();
        let commit = thread::spawn(move || {
            commit_owner.call(move |state| {
                // This accepted task owns the submission lock and the actual Session.
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                let plan = state.plans.remove(&commit_token).unwrap();
                Ok(state.service.apply(plan, 0)?.map(NativeSessionCommit::from))
            })
        });
        entered_rx.recv().unwrap();
        assert!(s.worker.try_lock().is_err());
        let (dispose_started_tx, dispose_started_rx) = mpsc::sync_channel(1);
        let (disposed_tx, disposed_rx) = mpsc::sync_channel(1);
        let disposal_owner = s.clone();
        let dispose = thread::spawn(move || {
            dispose_started_tx.send(()).unwrap();
            disposal_owner.dispose().unwrap();
            disposed_tx.send(()).unwrap();
        });
        dispose_started_rx.recv().unwrap();
        assert!(matches!(
            disposed_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release_tx.send(()).unwrap();
        assert!(commit.join().unwrap().unwrap().is_some());
        disposed_rx.recv().unwrap();
        dispose.join().unwrap();
        assert!(matches!(
            s.cancel_edits(token),
            Err(NativeSessionError::Disposed)
        ));
        let reopened = reopen(&f);
        assert_eq!(reopened.read(0).unwrap().nodes[0].text, "committed");
        reopened.dispose().unwrap();
    }
    #[test]
    fn final_alias_drop_joins_worker_and_releases_native_store() {
        let f = Fixture::new();
        let weak = Arc::downgrade(&f.store);
        let s = f.session();
        let alias = s.clone();
        let Fixture {
            directory,
            id,
            store,
        } = &f;
        let _ = (directory, id); // Keep fixture cleanup separate from ownership assertion.
        assert_eq!(Arc::strong_count(store), 2);
        drop(s);
        assert_eq!(Arc::strong_count(store), 2);
        drop(alias);
        assert_eq!(Arc::strong_count(store), 1);
        assert!(weak.upgrade().is_some());
        // Disposal/drop has joined, not merely queued cleanup; a fresh writer can open.
        let reopened = reopen(&f);
        reopened.dispose().unwrap();
    }
    #[test]
    fn worker_panic_reports_executor_failure_and_disposal_still_joins() {
        let f = Fixture::new();
        let s = f.session();
        assert!(matches!(
            s.call::<()>(|_| panic!("deterministic worker failure")),
            Err(NativeSessionError::ExecutorUnavailable)
        ));
        assert!(matches!(
            s.read(0),
            Err(NativeSessionError::ExecutorUnavailable)
        ));
        s.dispose().unwrap();
        assert!(matches!(s.read(0), Err(NativeSessionError::Disposed)));
    }
}
