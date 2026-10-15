//! Host/backend lifecycle, outside semantic transactions. submit/poll never wait
//! for IO. A bounded worker composes the owning URL, egress and parser ports.
//! Completion wakes the constructing host thread by default; event-loop hosts
//! install a notification callback before submission. Never poll on keystrokes.
//! dispose/Drop cancel and join workers on the host teardown path (not input).
//! Transports MUST honor egress deadlines; cancellation is checked at each port
//! boundary. A broken blocking adapter cannot be preempted by this controller.
//! Browser hosts implement the same records with their own async host transport;
//! this threaded backend does not promise browser/native UI wiring.
use super::{
    egress::{EgressClock, EgressError, EgressLimits, PublicEgress, PublicTransport},
    metadata::{MAX_HTML_BYTES, MetadataParser},
    public_url::{PublicUrlCacheKey, PublicUrlPolicy},
    *,
};
use crate::service_lifecycle::{
    ServiceLifecycle, ServiceLimits, ServiceOutcome, ServiceRequest, ServiceTicket,
};
use std::{
    collections::VecDeque,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};

#[derive(Clone, Copy, Debug)]
pub struct ResolverLimits {
    pub concurrency: usize,
    pub queue: usize,
    /// Includes deduplicated subscribers and completed, undelivered results.
    pub pending: usize,
    pub cache_entries: usize,
    pub positive_ms: u64,
    pub negative_ms: u64,
    pub queue_ms: u64,
}
impl Default for ResolverLimits {
    fn default() -> Self {
        Self {
            concurrency: 4,
            queue: 32,
            pending: 128,
            cache_entries: 64,
            positive_ms: 300_000,
            negative_ms: 5_000,
            queue_ms: 5_000,
        }
    }
}
impl ResolverLimits {
    fn valid(self) -> bool {
        (1..=8).contains(&self.concurrency)
            && (1..=256).contains(&self.queue)
            && (1..=1024).contains(&self.pending)
            && (1..=256).contains(&self.cache_entries)
            && (1..=3_600_000).contains(&self.positive_ms)
            && (1..=60_000).contains(&self.negative_ms)
            && (1..=30_000).contains(&self.queue_ms)
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResolverTiming {
    pub policy_ms: u64,
    pub cache_ms: u64,
    pub queue_ms: u64,
    pub network_ms: u64,
    pub cache_hit: bool,
}
/// Sensitive result payload intentionally omitted from ordinary diagnostics.
pub struct PublicDelivery {
    pub result: LinkResult,
    pub timing: ResolverTiming,
}
impl fmt::Debug for PublicDelivery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PublicDelivery")
            .field("state", &self.result.outcome.state())
            .field("timing", &self.timing)
            .finish()
    }
}
#[derive(Debug)]
pub enum Submission {
    Scheduled,
    Deduplicated,
    Ready(PublicDelivery),
    Rejected(LinkState),
    Full,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResolverStats {
    pub active: usize,
    pub queued: usize,
    pub pending: usize,
    pub cached: usize,
    pub disposed: bool,
}
#[derive(Clone, PartialEq, Eq)]
struct Key {
    url: PublicUrlCacheKey,
    host: LinkHostContext,
    policy: EnrichmentPolicy,
}
struct Waiter {
    request: LinkRequest,
    submitted: u64,
    policy_ms: u64,
}
struct Work {
    ticket: ServiceTicket,
    key: Key,
    waiters: Vec<Waiter>,
    queued: u64,
}
struct Active {
    work: Work,
    canceled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    thread: JoinHandle<(LinkOutcome, u64)>,
}
struct Cached {
    key: Key,
    outcome: LinkOutcome,
    expires: u64,
}
struct WakeOnDrop {
    wake: Arc<dyn Fn() + Send + Sync>,
    finished: Arc<AtomicBool>,
}
impl Drop for WakeOnDrop {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.wake)()));
    }
}
struct CancelClock<C> {
    clock: Arc<C>,
    canceled: Arc<AtomicBool>,
}
impl<C: EgressClock> EgressClock for CancelClock<C> {
    fn now_ms(&self) -> u64 {
        if self.canceled.load(Ordering::Acquire) {
            u64::MAX
        } else {
            self.clock.now_ms()
        }
    }
}

pub struct PublicResolver<T, F, C>
where
    T: PublicTransport + Send + 'static,
    F: Fn() -> T + Send + Sync + 'static,
    C: EgressClock + Send + Sync + 'static,
{
    factory: Arc<F>,
    clock: Arc<C>,
    urls: PublicUrlPolicy,
    egress: EgressLimits,
    limits: ResolverLimits,
    queue: VecDeque<Work>,
    active: Vec<Active>,
    cache: VecDeque<Cached>,
    ready: VecDeque<PublicDelivery>,
    wake: Arc<dyn Fn() + Send + Sync>,
    online: bool,
    disposed: bool,
    lifecycle: ServiceLifecycle,
}
impl<T, F, C> PublicResolver<T, F, C>
where
    T: PublicTransport + Send + 'static,
    F: Fn() -> T + Send + Sync + 'static,
    C: EgressClock + Send + Sync + 'static,
{
    /// Factory must return a dedicated credentials-free adapter without blocking.
    /// Configuration is immutable for this lifecycle: replace/dispose on change.
    pub fn new(
        factory: F,
        clock: Arc<C>,
        urls: PublicUrlPolicy,
        mut egress: EgressLimits,
        limits: ResolverLimits,
    ) -> Result<Self, EgressError> {
        if !limits.valid() {
            return Err(EgressError::InvalidLimits);
        }
        egress.max_bytes = egress.max_bytes.min(MAX_HTML_BYTES);
        PublicEgress::new(urls.clone(), egress)?;
        let lifecycle = ServiceLifecycle::new(ServiceLimits {
            concurrency: limits.concurrency,
            queue: limits.queue,
            bytes: MAX_LOCATOR * 4,
            items: 1,
            deadline_ms: limits.queue_ms + egress.total_ms,
        })
        .map_err(|_| EgressError::InvalidLimits)?;
        Ok(Self {
            factory: Arc::new(factory),
            clock,
            urls,
            egress,
            limits,
            queue: VecDeque::new(),
            active: Vec::new(),
            cache: VecDeque::new(),
            ready: VecDeque::new(),
            wake: {
                let host = thread::current();
                Arc::new(move || host.unpark())
            },
            online: true,
            disposed: false,
            lifecycle,
        })
    }
    /// Notify the host event loop on completion, including worker failure.
    /// Callback only schedules collection; it must be nonblocking, credential-free
    /// and must not reenter this resolver or panic.
    pub fn set_completion_waker(
        &mut self,
        wake: impl Fn() + Send + Sync + 'static,
    ) -> Result<(), EgressError> {
        if self.disposed || self.stats().pending != 0 || !self.active.is_empty() {
            return Err(EgressError::InvalidLimits);
        }
        self.wake = Arc::new(wake);
        Ok(())
    }
    pub fn stats(&self) -> ResolverStats {
        ResolverStats {
            active: self.active.len(),
            queued: self.queue.len(),
            pending: self.ready.len()
                + self.queue.iter().map(|w| w.waiters.len()).sum::<usize>()
                + self
                    .active
                    .iter()
                    .map(|a| a.work.waiters.len())
                    .sum::<usize>(),
            cached: self.cache.len(),
            disposed: self.disposed,
        }
    }
    pub fn submit(&mut self, request: LinkRequest, current: &LinkHostContext) -> Submission {
        let start = self.clock.now_ms();
        if self.disposed {
            return Submission::Rejected(LinkState::Canceled);
        }
        if start > MAX_SAFE_INTEGER {
            return Submission::Rejected(LinkState::Stale);
        }
        let url = match request.admit_public_url(current, false, &self.urls) {
            Ok(url) => url,
            Err(reason) => return Submission::Rejected(reason.state()),
        };
        let key = Key {
            url: url.cache_key().clone(),
            host: request.host.clone(),
            policy: request.policy,
        };
        let policy_ms = self.clock.now_ms().saturating_sub(start);
        let cache_start = self.clock.now_ms();
        self.cache.retain(|c| c.expires > cache_start);
        if let Some(c) = self.cache.iter().find(|c| c.key == key) {
            let outcome = for_request(c.outcome.clone(), &request);
            return Submission::Ready(PublicDelivery {
                result: LinkResult { request, outcome },
                timing: ResolverTiming {
                    policy_ms,
                    cache_ms: self.clock.now_ms().saturating_sub(cache_start),
                    cache_hit: true,
                    ..ResolverTiming::default()
                },
            });
        }
        if !self.online {
            return Submission::Ready(delivery(
                request,
                LinkOutcome::Unavailable,
                ResolverTiming {
                    policy_ms,
                    ..ResolverTiming::default()
                },
            ));
        }
        if self.stats().pending >= self.limits.pending {
            return Submission::Full;
        }
        // IDs/tokens are host-generated identities; reject collisions even across
        // different keys rather than allowing cancellation to affect strangers.
        if self.requests().any(|r| {
            r.request_id == request.request_id || r.cancellation_token == request.cancellation_token
        }) {
            return Submission::Rejected(LinkState::Stale);
        }
        let waiter = Waiter {
            request,
            submitted: start,
            policy_ms,
        };
        if let Some(w) = self.queue.iter_mut().find(|w| w.key == key) {
            w.waiters.push(waiter);
            return Submission::Deduplicated;
        }
        if let Some(a) = self
            .active
            .iter_mut()
            .find(|a| a.work.key == key && !a.canceled.load(Ordering::Acquire))
        {
            a.work.waiters.push(waiter);
            return Submission::Deduplicated;
        }
        if self.active.len() >= self.limits.concurrency && self.queue.len() >= self.limits.queue {
            return Submission::Full;
        }
        let now = self.clock.now_ms();
        let scope = key.host.scope.clone();
        let ticket = match self.lifecycle.admit(
            ServiceRequest {
                scope: scope.clone(),
                bytes: raw_len(&waiter.request),
                items: 1,
                deadline: now.saturating_add(self.limits.queue_ms + self.egress.total_ms),
            },
            &scope,
            now,
        ) {
            Ok(ticket) => ticket,
            Err(_) => return Submission::Full,
        };
        self.queue.push_back(Work {
            ticket,
            key,
            waiters: vec![waiter],
            queued: start,
        });
        self.start();
        Submission::Scheduled
    }
    fn requests(&self) -> impl Iterator<Item = &LinkRequest> {
        self.queue
            .iter()
            .flat_map(|w| &w.waiters)
            .chain(self.active.iter().flat_map(|a| &a.work.waiters))
            .map(|w| &w.request)
            .chain(self.ready.iter().map(|d| &d.result.request))
    }
    /// Remove subscriber state and any undelivered result. Last subscriber aborts
    /// network work at the next boundary; its slot stays occupied until exit.
    pub fn cancel(&mut self, token: &str) {
        for w in &mut self.queue {
            w.waiters.retain(|w| w.request.cancellation_token != token);
        }
        for w in &self.queue {
            if w.waiters.is_empty() {
                self.lifecycle.cancel(w.ticket);
            }
        }
        self.queue.retain(|w| !w.waiters.is_empty());
        for a in &mut self.active {
            a.work
                .waiters
                .retain(|w| w.request.cancellation_token != token);
            if a.work.waiters.is_empty() {
                a.canceled.store(true, Ordering::Release);
                self.lifecycle.cancel(a.work.ticket);
            }
        }
        self.ready
            .retain(|d| d.result.request.cancellation_token != token);
    }
    /// Offline transitions invalidate in-flight work; explicit later submissions
    /// may reuse only unexpired scoped cache entries. No automatic retry loop.
    pub fn set_online(&mut self, online: bool) {
        self.online = online;
        if !online {
            for a in &self.active {
                a.canceled.store(true, Ordering::Release);
            }
            while let Some(w) = self.queue.pop_front() {
                self.lifecycle.cancel(w.ticket);
                self.finish(w, LinkOutcome::Unavailable, 0, false);
            }
        }
    }
    /// IO-free collection after the worker completion marker. The final join
    /// only settles the nonblocking wake callback/thread exit. Host MUST validate each result against its current
    /// LinkRequest immediately before presentation (LinkResult::validate).
    /// This controller never receives a document or mutation callback.
    pub fn poll(&mut self) -> Vec<PublicDelivery> {
        let mut i = 0;
        while i < self.active.len() {
            if !self.active[i].finished.load(Ordering::Acquire) {
                i += 1;
                continue;
            }
            let a = self.active.remove(i);
            let (mut outcome, duration) = a.thread.join().unwrap_or((LinkOutcome::Unavailable, 0));
            let terminal = self.lifecycle.complete(
                a.work.ticket,
                &a.work.key.host.scope,
                self.clock.now_ms(),
                outcome.state() == LinkState::Available,
            );
            if terminal != Some(ServiceOutcome::Ready) {
                outcome = LinkOutcome::Unavailable;
            }
            if !a.canceled.load(Ordering::Acquire) {
                self.finish(a.work, outcome, duration, true);
            } else if !a.work.waiters.is_empty() {
                self.finish(a.work, LinkOutcome::Unavailable, duration, false);
            }
        }
        self.start();
        self.ready.drain(..).collect()
    }
    fn start(&mut self) {
        while self.online && !self.disposed && self.active.len() < self.limits.concurrency {
            let Some(work) = self.queue.pop_front() else {
                break;
            };
            let now = self.clock.now_ms();
            if now.saturating_sub(work.queued) >= self.limits.queue_ms {
                self.lifecycle.cancel(work.ticket);
                self.finish(work, LinkOutcome::Unavailable, 0, false);
                continue;
            }
            match self.lifecycle.start_next(&work.key.host.scope, now) {
                Some(Ok((ticket, _))) if ticket == work.ticket => {}
                _ => {
                    self.finish(work, LinkOutcome::Unavailable, 0, false);
                    continue;
                }
            }
            let raw = match &work.waiters[0].request.target {
                LinkTarget::PublicUrl(raw) => raw.clone(),
                _ => unreachable!(),
            };
            let clock = self.clock.clone();
            let urls = self.urls.clone();
            let factory = self.factory.clone();
            let canceled = Arc::new(AtomicBool::new(false));
            let flag = canceled.clone();
            let limits = self.egress;
            let ttl = self.limits.positive_ms;
            let policy_revision = work.key.host.policy_revision.clone();
            let wake = self.wake.clone();
            let finished = Arc::new(AtomicBool::new(false));
            let done = finished.clone();
            let thread = thread::Builder::new()
                .name("public-metadata".into())
                .spawn(move || {
                    let _wake = WakeOnDrop {
                        wake,
                        finished: done,
                    };
                    let start = clock.now_ms();
                    let guarded = CancelClock {
                        clock: clock.clone(),
                        canceled: flag,
                    };
                    let egress = PublicEgress::new(urls.clone(), limits)
                        .expect("validated immutable limits");
                    let mut transport = factory();
                    let outcome = match egress.fetch(&mut transport, &guarded, &raw) {
                        Ok(response) => {
                            let requested = urls.admit(&raw).expect("admitted immutable locator");
                            let metadata = MetadataParser::new(urls)
                                .parse(requested, &response)
                                .into_metadata();
                            let now = clock.now_ms();
                            LinkOutcome::Available {
                                metadata,
                                freshness: LinkFreshness {
                                    fetched_at: now,
                                    expires_at: now.saturating_add(ttl).min(MAX_SAFE_INTEGER),
                                    policy_revision,
                                },
                            }
                        }
                        Err(_) => LinkOutcome::Unavailable,
                    };
                    (outcome, clock.now_ms().saturating_sub(start))
                });
            match thread {
                Ok(thread) => self.active.push(Active {
                    work,
                    canceled,
                    finished,
                    thread,
                }),
                Err(_) => {
                    self.lifecycle
                        .complete(work.ticket, &work.key.host.scope, now, false);
                    self.finish(work, LinkOutcome::Unavailable, 0, false);
                }
            }
        }
    }
    fn finish(&mut self, work: Work, outcome: LinkOutcome, network_ms: u64, cache: bool) {
        let now = self.clock.now_ms();
        if cache && !work.waiters.is_empty() && now <= MAX_SAFE_INTEGER {
            let expires = match &outcome {
                LinkOutcome::Available { freshness, .. } => freshness.expires_at,
                _ => now
                    .saturating_add(self.limits.negative_ms)
                    .min(MAX_SAFE_INTEGER),
            };
            self.cache.retain(|c| c.expires > now && c.key != work.key);
            if self.cache.len() >= self.limits.cache_entries {
                self.cache.pop_front();
            }
            self.cache.push_back(Cached {
                key: work.key,
                outcome: outcome.clone(),
                expires,
            });
        }
        for w in work.waiters {
            let elapsed = now.saturating_sub(w.submitted);
            let timing = ResolverTiming {
                policy_ms: w.policy_ms,
                queue_ms: elapsed
                    .saturating_sub(network_ms)
                    .saturating_sub(w.policy_ms),
                network_ms: network_ms.min(elapsed),
                ..ResolverTiming::default()
            };
            self.ready.push_back(delivery(
                w.request.clone(),
                for_request(outcome.clone(), &w.request),
                timing,
            ));
        }
    }
    /// Finite host teardown: cancel, join (adapter total deadlines apply), clear
    /// all queued/completed/cache records. Idempotent; no detached worker remains.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.lifecycle.dispose();
        self.queue.clear();
        self.ready.clear();
        self.cache.clear();
        for a in &self.active {
            a.canceled.store(true, Ordering::Release);
        }
        for a in self.active.drain(..) {
            let _ = a.thread.join();
            self.lifecycle.complete(
                a.work.ticket,
                &a.work.key.host.scope,
                self.clock.now_ms(),
                false,
            );
        }
    }
}
impl<T, F, C> Drop for PublicResolver<T, F, C>
where
    T: PublicTransport + Send + 'static,
    F: Fn() -> T + Send + Sync + 'static,
    C: EgressClock + Send + Sync + 'static,
{
    fn drop(&mut self) {
        self.dispose();
    }
}
fn delivery(request: LinkRequest, outcome: LinkOutcome, timing: ResolverTiming) -> PublicDelivery {
    PublicDelivery {
        result: LinkResult { request, outcome },
        timing,
    }
}
fn for_request(mut outcome: LinkOutcome, request: &LinkRequest) -> LinkOutcome {
    if let (
        LinkOutcome::Available {
            metadata: LinkMetadata::Public { requested_url, .. },
            ..
        },
        LinkTarget::PublicUrl(raw),
    ) = (&mut outcome, &request.target)
    {
        *requested_url = raw.clone();
    }
    outcome
}

fn raw_len(request: &LinkRequest) -> usize {
    match &request.target {
        LinkTarget::PublicUrl(raw) => raw.len(),
        _ => 0,
    }
}
