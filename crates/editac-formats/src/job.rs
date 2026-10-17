//! Optional local orchestration, not a converter or platform sandbox. Hosts must
//! enforce the declared worker/process ceilings and watchdog, terminate on stop,
//! and allocate unique non-secret job IDs. No path, URL, credential or network port
//! is provided. Platform owners 31–36 implement and qualify those enforcement ports.
use crate::{Direction, ImportRequest, Limits, Profile, Work, admit_direction, admit_import};
use editac_core::{
    anchors::Selection,
    commands::{editor::FragmentBlock, text::TextOrigin},
    document::{DocumentIdentity, InitialNode},
    modules::assets::{AssetAction, AssetIdentity, AssetRequest},
    projection::Snapshot,
};
use editac_session::{
    assets::{AssetHost, AssetStore, AssetWork},
    edit_service::{EditService, HostPolicy, ServiceError},
    ports::{LocalCommit, PortError},
    revision::ObservedRevision,
    session::{CachedPermission, Session, SessionError, SessionStore},
};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Debug)]
pub enum JobError {
    Admission(crate::Code),
    InvalidJob,
    IsolationUnavailable,
    Busy,
    ResourceLimit,
    Cancelled,
    Timeout,
    Finished,
    WrongDirection,
    Asset(PortError),
    Service(ServiceError),
}
impl From<PortError> for JobError {
    fn from(e: PortError) -> Self {
        Self::Asset(e)
    }
}
impl From<ServiceError> for JobError {
    fn from(e: ServiceError) -> Self {
        Self::Service(e)
    }
}

/// Owns the Session and its exact asset store. No independent document model.
pub struct ConversionOwner<S: SessionStore + AssetStore> {
    service: EditService<Arc<S>>,
    store: Arc<S>,
}
impl<S: SessionStore + AssetStore> ConversionOwner<S> {
    pub fn create(
        store: Arc<S>,
        identity: DocumentIdentity,
        initial: &[InitialNode],
        policy: HostPolicy,
    ) -> Result<Self, SessionError> {
        let session = Session::create_local(store.clone(), identity, initial)?;
        Ok(Self {
            service: EditService::new(session, policy),
            store,
        })
    }
    pub fn open(
        store: Arc<S>,
        identity: &DocumentIdentity,
        permission: CachedPermission,
        policy: HostPolicy,
    ) -> Result<Self, SessionError> {
        let session = Session::open(store.clone(), identity, permission)?;
        Ok(Self {
            service: EditService::new(session, policy),
            store,
        })
    }
    pub fn service(&self) -> &EditService<Arc<S>> {
        &self.service
    }
    pub fn service_mut(&mut self) -> &mut EditService<Arc<S>> {
        &mut self.service
    }
}

#[derive(Clone)]
pub struct JobPool {
    active: Arc<AtomicUsize>,
    maximum: usize,
}
impl JobPool {
    pub fn new(maximum: usize) -> Result<Self, JobError> {
        if !(1..=16).contains(&maximum) {
            return Err(JobError::InvalidJob);
        }
        Ok(Self {
            active: Arc::new(AtomicUsize::new(0)),
            maximum,
        })
    }
    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
    fn acquire(&self) -> Result<Permit, JobError> {
        self.active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < self.maximum).then_some(n + 1)
            })
            .map_err(|_| JobError::Busy)?;
        Ok(Permit(self.active.clone()))
    }
}
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    BrowserWorker,
    NativeProcess,
    Unavailable,
}
#[derive(Clone, Copy, Debug)]
pub struct Enforcement {
    pub isolation: Isolation,
    pub hard_memory_bytes: usize,
    pub watchdog: bool,
    pub restricted_assets: bool,
    pub no_network: bool,
}
/// Trusted host enforcement port. `start` must install hard ceilings/watchdog
/// before doing work, and watch cancellation; `stop` fences late results and releases execution resources.
pub trait ExecutionPort {
    fn enforcement(&self) -> Enforcement;
    fn start(
        &mut self,
        contract: &JobContract,
        source: &JobSource,
        cancellation: &Cancellation,
    ) -> Result<(), JobError>;
    fn stop(&mut self);
}

#[derive(Clone, Debug)]
pub struct JobContract {
    pub id: String,
    pub profile: Profile,
    pub direction: Direction,
    pub revision: ObservedRevision,
    pub input_sha256: [u8; 32],
    pub limits: Limits,
    pub deadline: u64,
    pub memory_bytes: usize,
}
/// Captured only once. Accessors never reread the mutable Session.
pub struct JobSource {
    original: Vec<u8>,
    snapshot: Snapshot,
    target: Option<Selection>,
}
impl JobSource {
    pub fn original(&self) -> &[u8] {
        &self.original
    }
    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }
    pub fn target(&self) -> Option<&Selection> {
        self.target.as_ref()
    }
}
pub struct JobSpec<'a> {
    pub id: &'a str,
    /// Only an installed/qualified adapter may set available=true. Registry
    /// profiles remain unavailable; prepared fixture profiles do not install one.
    pub profile: Profile,
    pub direction: Direction,
    pub original: &'a [u8],
    pub filename: &'a str,
    pub media_type: &'a str,
    pub target: Option<Selection>,
    pub limits: Limits,
    pub timeout: u64,
    pub memory_bytes: usize,
}
#[derive(Clone)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
#[derive(Clone, Debug)]
pub struct StagedAsset {
    pub reference: String,
    pub identity: AssetIdentity,
}

pub struct PreparedJob<S: SessionStore + AssetStore> {
    contract: JobContract,
    source: JobSource,
    store: Arc<S>,
    port: Box<dyn ExecutionPort>,
    permit: Option<Permit>,
    cancellation: Cancellation,
    terminal: bool,
    poisoned: bool,
    work: Work,
    output: Vec<u8>,
    pub(crate) token: Arc<()>,
    reference_prefix: String,
    asset_bytes: u64,
    staged: Vec<StagedAsset>,
    #[cfg(feature = "docx-codecs")]
    container_prepared: bool,
}
impl<S: SessionStore + AssetStore> PreparedJob<S> {
    pub fn begin(
        owner: &ConversionOwner<S>,
        spec: JobSpec<'_>,
        pool: &JobPool,
        mut port: Box<dyn ExecutionPort>,
        now: u64,
    ) -> Result<Self, JobError> {
        if spec.id.is_empty()
            || spec.id.len() > 64
            || !spec
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || spec.timeout == 0
        {
            return Err(JobError::InvalidJob);
        }
        if spec.direction == Direction::Import {
            let admission = admit_import(&ImportRequest {
                profile_id: spec.profile.id,
                filename: spec.filename,
                media_type: spec.media_type,
                original: spec.original,
            });
            if let Err(e) = admission {
                // Recognition is shared; availability belongs to the installed adapter.
                if e.diagnostic.code != crate::Code::AdapterUnavailable {
                    return Err(JobError::Admission(e.diagnostic.code));
                }
            }
        }
        admit_direction(&spec.profile, spec.direction, spec.original)
            .map_err(|e| JobError::Admission(e.diagnostic.code))?;
        let p = spec.profile.limits;
        let l = spec.limits;
        if l.input_bytes > p.input_bytes
            || l.output_bytes > p.output_bytes
            || l.nodes > p.nodes
            || l.pages > p.pages
            || spec.original.len() > l.input_bytes
            || spec.memory_bytes < l.input_bytes.saturating_add(l.output_bytes)
        {
            return Err(JobError::ResourceLimit);
        }
        if (spec.direction == Direction::Import) != spec.target.is_some() {
            return Err(JobError::InvalidJob);
        }
        let e = port.enforcement();
        if e.isolation == Isolation::Unavailable
            || !e.watchdog
            || !e.restricted_assets
            || !e.no_network
            || e.hard_memory_bytes < spec.memory_bytes
        {
            return Err(JobError::IsolationUnavailable);
        }
        let permit = pool.acquire()?;
        let read = owner.service.read(now)?;
        if spec.direction == Direction::Export {
            use std::fmt::Write;
            let mut count = BoundedCount {
                bytes: 0,
                limit: l.input_bytes,
            };
            write!(&mut count, "{:?}", read.snapshot).map_err(|_| JobError::ResourceLimit)?;
        }
        static NEXT_JOB: AtomicUsize = AtomicUsize::new(0);
        let serial = NEXT_JOB
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map_err(|_| JobError::InvalidJob)?;
        let reference_prefix = format!("{}_j{serial}", spec.id);
        let contract = JobContract {
            id: spec.id.into(),
            profile: spec.profile,
            direction: spec.direction,
            revision: read.revision,
            input_sha256: Sha256::digest(spec.original).into(),
            limits: l,
            deadline: now.checked_add(spec.timeout).ok_or(JobError::InvalidJob)?,
            memory_bytes: spec.memory_bytes,
        };
        let source = JobSource {
            original: spec.original.to_vec(),
            snapshot: read.snapshot,
            target: spec.target,
        };
        let cancellation = Cancellation(Arc::new(AtomicBool::new(false)));
        if let Err(e) = port.start(&contract, &source, &cancellation) {
            port.stop();
            return Err(e);
        }
        Ok(Self {
            contract,
            source,
            store: owner.store.clone(),
            port,
            permit: Some(permit),
            cancellation,
            terminal: false,
            poisoned: false,
            work: Work::default(),
            output: vec![],
            token: Arc::new(()),
            reference_prefix,
            asset_bytes: 0,
            staged: vec![],
            #[cfg(feature = "docx-codecs")]
            container_prepared: false,
        })
    }
    /// Inspect immutable input under this job's deadline/cancellation contract.
    /// Any rejected package retires only this job's staged references.
    #[cfg(feature = "docx-codecs")]
    pub fn prepare_container(
        &mut self,
        budgets: crate::container::Budgets,
        mut now: impl FnMut() -> u64,
    ) -> Result<crate::container::Package, crate::container::Failure> {
        use crate::container::{Code, Failure};
        if self.container_prepared {
            self.poisoned = true;
            self.abort()
                .map_err(|_| Failure::new(Code::Cleanup, "job"))?;
            return Err(Failure::new(Code::Budget, "repeated-container-preparation"));
        }
        self.container_prepared = true;
        // Account held input, all retained inflated parts, metadata/name
        // headroom, the job output ceiling and bounded decoder scratch.
        let required = budgets
            .entries
            .checked_mul(4096)
            .and_then(|n| {
                budgets
                    .inflated
                    .checked_mul(2)
                    .and_then(|v| n.checked_add(v))
            })
            .and_then(|n| {
                budgets
                    .nodes
                    .checked_mul(2048)
                    .and_then(|v| n.checked_add(v))
            })
            .and_then(|n| n.checked_add(self.source.original.len()))
            .and_then(|n| n.checked_add(self.contract.limits.output_bytes))
            .and_then(|n| n.checked_add(8192));
        if required.is_none_or(|n| n > self.contract.memory_bytes) {
            self.poisoned = true;
            self.abort()
                .map_err(|_| Failure::new(Code::Cleanup, "job"))?;
            return Err(Failure::new(Code::Budget, "job-memory"));
        }
        let mut result = crate::container::inspect(&self.source.original, budgets, || {
            self.check(now()).map_err(|error| {
                Failure::new(
                    match error {
                        JobError::Cancelled => Code::Cancelled,
                        JobError::Timeout => Code::Timeout,
                        _ => Code::Budget,
                    },
                    "job",
                )
            })
        });
        if let Ok(package) = &mut result {
            package.job_token = Some(self.token.clone());
        }
        if result.is_err() {
            self.poisoned = true;
            self.abort()
                .map_err(|_| Failure::new(Code::Cleanup, "job"))?;
        }
        result
    }
    /// Charge original-media validation to this exact prepared input/job. A
    /// failed/cancelled decode retires staging before a semantic batch can commit.
    #[cfg(feature = "docx-codecs")]
    pub fn validate_container_media(
        &mut self,
        package: &mut crate::container::Package,
        name: &str,
        mut now: impl FnMut() -> u64,
    ) -> Result<(u32, u32), crate::container::Failure> {
        use crate::container::{Code, Failure};
        let result = if package
            .job_token
            .as_ref()
            .is_none_or(|token| !Arc::ptr_eq(token, &self.token))
        {
            Err(Failure::new(Code::Relationship, "foreign-container-job"))
        } else {
            package.media(name, &mut || {
                self.check(now()).map_err(|error| {
                    Failure::new(
                        match error {
                            JobError::Cancelled => Code::Cancelled,
                            JobError::Timeout => Code::Timeout,
                            _ => Code::Budget,
                        },
                        "job",
                    )
                })
            })
        };
        if result.is_err() {
            self.poisoned = true;
            self.abort()
                .map_err(|_| Failure::new(Code::Cleanup, "job"))?;
        }
        result
    }
    pub fn contract(&self) -> &JobContract {
        &self.contract
    }
    pub fn source(&self) -> &JobSource {
        &self.source
    }
    pub fn cancellation(&self) -> Cancellation {
        self.cancellation.clone()
    }
    pub fn work(&self) -> Work {
        self.work
    }
    pub fn asset_bytes(&self) -> u64 {
        self.asset_bytes
    }
    pub(crate) fn check(&self, now: u64) -> Result<(), JobError> {
        if self.terminal {
            return Err(JobError::Finished);
        }
        if self.cancellation.0.load(Ordering::SeqCst) {
            return Err(JobError::Cancelled);
        }
        if now >= self.contract.deadline {
            return Err(JobError::Timeout);
        }
        if self.poisoned {
            return Err(JobError::ResourceLimit);
        }
        Ok(())
    }
    /// Charges before copying/allocation. A failed charge poisons the whole job.
    pub fn append(
        &mut self,
        bytes: &[u8],
        nodes: usize,
        pages: usize,
        now: u64,
    ) -> Result<(), JobError> {
        if let Err(e) = self.check(now) {
            self.abort()?;
            return Err(e);
        }
        let next = self
            .work
            .bytes
            .checked_add(bytes.len())
            .zip(self.work.nodes.checked_add(nodes))
            .zip(self.work.pages.checked_add(pages));
        let l = self.contract.limits;
        let Some(((b, n), p)) =
            next.filter(|((b, n), p)| *b <= l.output_bytes && *n <= l.nodes && *p <= l.pages)
        else {
            self.poisoned = true;
            self.abort()?;
            return Err(JobError::ResourceLimit);
        };
        self.output.extend_from_slice(bytes);
        self.work = Work {
            bytes: b,
            nodes: n,
            pages: p,
        };
        Ok(())
    }
    /// Only fresh job-owned references are admitted; no arbitrary reference or
    /// publish/delete action can be injected. Host retains recovery bytes itself.
    pub fn stage_asset(
        &mut self,
        identity: AssetIdentity,
        action: AssetAction,
        byte_limit: u64,
        host: &mut impl AssetHost,
        now: u64,
    ) -> Result<(), JobError> {
        let result = self.stage_asset_inner(identity, action, byte_limit, host, now);
        if result.is_err() {
            self.poisoned = true;
            self.abort()?;
        }
        result
    }
    fn stage_asset_inner(
        &mut self,
        identity: AssetIdentity,
        action: AssetAction,
        byte_limit: u64,
        host: &mut impl AssetHost,
        now: u64,
    ) -> Result<(), JobError> {
        self.check(now)?;
        if !matches!(
            action,
            AssetAction::Ingest | AssetAction::Read | AssetAction::Cache
        ) || self.staged.len() >= 64
            || byte_limit > self.contract.limits.input_bytes as u64
        {
            return Err(JobError::ResourceLimit);
        }
        let next = self
            .asset_bytes
            .checked_add(byte_limit)
            .filter(|n| *n <= self.contract.limits.input_bytes as u64)
            .ok_or(JobError::ResourceLimit)?;
        self.asset_bytes = next;
        let reference = format!("{}_asset_{}", self.reference_prefix, self.staged.len());
        let request = AssetRequest {
            version: 1,
            operation_id: reference.clone(),
            identity: identity.clone(),
            action,
            byte_limit,
        };
        let journal = self.store.asset_journal()?;
        if journal
            .intents()
            .iter()
            .any(|i| i.reference == reference || i.request.operation_id == reference)
        {
            return Err(JobError::InvalidJob);
        }
        let grant = host.authorize(&request)?;
        // Record ownership before enqueue: an ambiguous persistence failure must
        // retain a cleanup handle and never be treated as successful staging.
        self.staged.push(StagedAsset {
            reference: reference.clone(),
            identity,
        });
        let work = AssetWork::new(&self.store);
        if let Err(e) = work
            .enqueue(&reference, request, &grant)
            .and_then(|_| work.run_one(&reference, true, host).map(|_| ()))
        {
            self.poisoned = true;
            return Err(e.into());
        }
        Ok(())
    }
    fn discard(&mut self) {
        self.output = Vec::new();
    }
    fn stop(&mut self) {
        if self.permit.take().is_some() {
            self.port.stop();
        }
    }
    /// Persist scoped cancellation/release intents, never global binary deletion.
    /// On store failure the job retains its recovery handles; retry this same abort.
    pub fn cancel(&mut self) -> Result<(), JobError> {
        self.cancellation.cancel();
        self.abort()
    }
    pub fn abort(&mut self) -> Result<(), JobError> {
        self.terminal = true;
        self.discard();
        self.stop();
        let work = AssetWork::new(&self.store);
        for staged in &self.staged {
            work.retire(
                &staged.reference,
                &staged.identity,
                &format!("{}_cleanup", staged.reference),
            )?;
        }
        self.staged.clear();
        Ok(())
    }
    pub fn finish_import(
        &mut self,
        owner: &mut ConversionOwner<S>,
        blocks: &[FragmentBlock],
        now: u64,
    ) -> Result<Option<ImportCompletion>, JobError> {
        let result = (|| {
            self.check(now)?;
            if self.contract.direction != Direction::Import {
                return Err(JobError::WrongDirection);
            }
            // Shared planner checks the complete payload, UTF-16 anchors, codecs,
            // current authority and exact revision before one semantic commit.
            if !Arc::ptr_eq(&self.store, &owner.store) {
                return Err(JobError::InvalidJob);
            }
            let nodes = blocks
                .iter()
                .try_fold(0usize, |n, b| {
                    n.checked_add(1)?
                        .checked_add(b.runs.len())?
                        .checked_add(b.containers.len())
                })
                .ok_or(JobError::ResourceLimit)?;
            if nodes > self.contract.limits.nodes {
                return Err(JobError::ResourceLimit);
            }
            // Count the full representation without allocating a second unbounded
            // serialization (marks, tuples and containers count as well as text).
            use std::fmt::Write;
            let mut count = BoundedCount {
                bytes: 0,
                limit: self.contract.limits.output_bytes,
            };
            write!(&mut count, "{blocks:?}").map_err(|_| JobError::ResourceLimit)?;
            let plan = owner.service.prepare_fragment(
                &self.contract.revision,
                self.source.target.as_ref().ok_or(JobError::InvalidJob)?,
                blocks,
                &TextOrigin::new("format-import").map_err(|_| JobError::InvalidJob)?,
                now,
            )?;
            // Unused preparation remains job-owned and is fenced before commit.
            let mut used = Vec::new();
            for block in blocks {
                if let Some(editac_core::document::BlockAttributes::Unknown(tuple)) =
                    &block.attributes
                {
                    if let Ok(Some(editac_core::modules::content::Content::Asset { descriptor })) =
                        editac_core::modules::content::Content::from_tuple(tuple)
                    {
                        used.push(descriptor.identity);
                    }
                }
            }
            let work = AssetWork::new(&self.store);
            for asset in &self.staged {
                if !used.contains(&asset.identity) {
                    work.retire(
                        &asset.reference,
                        &asset.identity,
                        &format!("{}_cleanup", asset.reference),
                    )?;
                }
            }
            self.staged.retain(|a| used.contains(&a.identity));
            self.check(now)?;
            owner.service.apply(plan, now).map_err(Into::into)
        })();
        match result {
            Ok(None) => {
                self.abort()?;
                Ok(None)
            }
            Ok(Some(commit)) => {
                self.terminal = true;
                let assets = std::mem::take(&mut self.staged);
                self.discard();
                self.stop();
                Ok(Some(ImportCompletion {
                    local_commit: commit,
                    assets,
                }))
            }
            Err(e) => {
                self.abort()?;
                Err(e)
            }
        }
    }
    pub fn finish_export(&mut self, now: u64) -> Result<ExportArtifact, JobError> {
        if let Err(e) = self.check(now) {
            self.abort()?;
            return Err(e);
        }
        if self.contract.direction != Direction::Export {
            self.abort()?;
            return Err(JobError::WrongDirection);
        }
        // Read/cache preparation is temporary even on successful export.
        let bytes = std::mem::take(&mut self.output);
        self.abort()?;
        Ok(ExportArtifact {
            job_id: self.contract.id.clone(),
            token: self.token.clone(),
            revision: self.contract.revision.clone(),
            bytes,
            work: self.work,
        })
    }
}
impl<S: SessionStore + AssetStore> Drop for PreparedJob<S> {
    fn drop(&mut self) {
        if !self.terminal || !self.staged.is_empty() {
            let _ = self.abort();
        }
    }
}

/// Job-owned references transferred only with a real committed insertion. Hosts
/// retain these bindings for their existing deletion/recovery lifecycle hooks.
pub struct ImportCompletion {
    pub local_commit: LocalCommit,
    pub assets: Vec<StagedAsset>,
}

/// Conversion completion carries no journal or file durability assertion.
#[derive(Debug)]
pub struct ExportArtifact {
    job_id: String,
    token: Arc<()>,
    revision: ObservedRevision,
    bytes: Vec<u8>,
    work: Work,
}
impl ExportArtifact {
    pub fn job_id(&self) -> &str {
        &self.job_id
    }
    pub fn revision(&self) -> &ObservedRevision {
        &self.revision
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn work(&self) -> Work {
        self.work
    }
}
/// Host destination port: write stages bytes; close atomically installs them.
/// Failed write/close preserves the prior artifact and recoverable staged data.
pub trait ArtifactSink {
    fn write(&mut self, bytes: &[u8]) -> Result<(), SaveFailure>;
    fn close(&mut self) -> Result<(), SaveFailure>;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveFailure {
    PickerCancelled,
    Write,
    Close,
    Correlation,
    AlreadyFinished,
}
/// Host Save-before-New/Open gate. Keep the live Session and last valid artifact
/// until this returns true. A successful old-revision save cannot close newer work.
pub struct SaveTransition {
    job_id: String,
    token: Arc<()>,
    revision: ObservedRevision,
    finished: bool,
}
impl SaveTransition {
    pub fn begin<S: SessionStore + AssetStore>(job: &PreparedJob<S>) -> Result<Self, JobError> {
        if job.contract.direction != Direction::Export {
            return Err(JobError::WrongDirection);
        }
        job.check(0)?;
        Ok(Self {
            job_id: job.contract.id.clone(),
            token: job.token.clone(),
            revision: job.contract.revision.clone(),
            finished: false,
        })
    }
    pub fn cancel(&mut self) -> Result<(), SaveFailure> {
        self.finished = true;
        Err(SaveFailure::PickerCancelled)
    }
    pub fn write_and_close(
        &mut self,
        artifact: &ExportArtifact,
        current: &ObservedRevision,
        sink: &mut impl ArtifactSink,
    ) -> Result<bool, SaveFailure> {
        if self.finished {
            return Err(SaveFailure::AlreadyFinished);
        }
        if !Arc::ptr_eq(&artifact.token, &self.token)
            || artifact.job_id != self.job_id
            || artifact.revision != self.revision
        {
            return Err(SaveFailure::Correlation);
        }
        sink.write(&artifact.bytes)?;
        sink.close()?;
        self.finished = true;
        Ok(*current == self.revision)
    }
}

struct BoundedCount {
    bytes: usize,
    limit: usize,
}
impl std::fmt::Write for BoundedCount {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        self.bytes = self
            .bytes
            .checked_add(value.len())
            .filter(|n| *n <= self.limit)
            .ok_or(std::fmt::Error)?;
        Ok(())
    }
}
