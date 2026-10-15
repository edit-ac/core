//! Canonical integration: ServiceLifecycle + URL admission + threaded resolver +
//! actual pinned PublicEgress + inert MetadataParser, with prepared DNS/stream.
//! No sockets or providers. Gate-controlled IO proves nonblocking burst/cancel.
mod support;
use editac_session::{
    links::{egress::*, public_resolver::*, public_url::*, *},
    locator::Authority,
    service_lifecycle::ServiceScope,
};
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Clock(AtomicU64);
impl EgressClock for Clock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
impl Clock {
    fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct Trace {
    dns: usize,
    gets: usize,
    active: usize,
    peak: usize,
    closed: usize,
    reads: usize,
    gate: bool,
    entered: usize,
    caps: Vec<usize>,
}
#[derive(Clone, Copy)]
enum Mode {
    Good,
    Offline,
    Timeout,
    Oversize,
    Denied,
    Panic,
}
struct Fixture {
    clock: Arc<Clock>,
    trace: Arc<(Mutex<Trace>, Condvar)>,
    mode: Mode,
    body: Vec<u8>,
}
struct Connection {
    clock: Arc<Clock>,
    trace: Arc<(Mutex<Trace>, Condvar)>,
    peer: SocketAddr,
    chunks: VecDeque<Vec<u8>>,
    mode: Mode,
}
impl PublicTransport for Fixture {
    type Connection = Connection;
    fn resolve(&mut self, _: &str, _: u64, _: usize) -> Result<Vec<IpAddr>, EgressError> {
        self.trace.0.lock().unwrap().dns += 1;
        match self.mode {
            Mode::Offline => Err(EgressError::Dns),
            Mode::Panic => panic!("prepared adapter panic"),
            Mode::Denied => Ok(vec!["127.0.0.1".parse().unwrap()]),
            _ => Ok(vec!["93.184.215.14".parse().unwrap()]),
        }
    }
    fn connect(&mut self, target: PinnedTarget<'_>, _: u64) -> Result<Connection, EgressError> {
        let mut t = self.trace.0.lock().unwrap();
        t.active += 1;
        t.peak = t.peak.max(t.active);
        Ok(Connection {
            clock: self.clock.clone(),
            trace: self.trace.clone(),
            peer: target.address(),
            chunks: [self.body.clone()].into(),
            mode: self.mode,
        })
    }
}
impl PublicConnection for Connection {
    fn peer_addr(&self) -> Result<SocketAddr, EgressError> {
        Ok(self.peer)
    }
    fn get(
        &mut self,
        request: PublicGet<'_>,
        _: u64,
        _: usize,
    ) -> Result<ResponseHead, EgressError> {
        assert_eq!(request.method(), "GET");
        assert_eq!(request.headers().len(), 2);
        self.trace.0.lock().unwrap().gets += 1;
        Ok(ResponseHead {
            status: 200,
            headers: vec![("Content-Type".into(), "text/html".into())],
        })
    }
    fn read(&mut self, deadline: u64, cap: usize) -> Result<Option<Vec<u8>>, EgressError> {
        let (lock, signal) = &*self.trace;
        let mut t = lock.lock().unwrap();
        t.reads += 1;
        t.caps.push(cap);
        t.entered += 1;
        signal.notify_all();
        // Bounded gate: a failing test cannot leave a hung worker or detached IO.
        let (mut t, timeout) = signal
            .wait_timeout_while(t, Duration::from_secs(1), |t| t.gate)
            .unwrap();
        if timeout.timed_out() {
            self.clock.0.store(deadline, Ordering::SeqCst);
            return Err(EgressError::Timeout);
        }
        t.entered -= 1;
        drop(t);
        if matches!(self.mode, Mode::Timeout) {
            self.clock.0.store(deadline, Ordering::SeqCst);
            return Err(EgressError::Timeout);
        }
        self.clock.advance(7);
        if matches!(self.mode, Mode::Oversize) {
            return Ok(Some(vec![b'x'; cap + 1]));
        }
        Ok(self.chunks.pop_front())
    }
    fn close(&mut self) {
        let mut t = self.trace.0.lock().unwrap();
        t.active -= 1;
        t.closed += 1;
        self.trace.1.notify_all();
    }
}
fn request(id: usize) -> LinkRequest {
    LinkRequest {
        request_id: format!("request:{id}"),
        cancellation_token: format!("cancel:{id}"),
        node: format!("node:{id}"),
        epoch: "epoch:1".into(),
        label_revision: "label:1".into(),
        host: LinkHostContext {
            principal: "principal:1".into(),
            tenant: "tenant:1".into(),
            authority: Some(Authority::parse("team").unwrap()),
            scope: ServiceScope {
                document: "doc:1".into(),
                session: "session:1".into(),
                revision: "revision:1".into(),
                permission: "permission:1".into(),
                authorized: true,
            },
            policy_revision: "policy:1".into(),
            readonly: false,
            capabilities: LinkCapabilities {
                public_metadata: true,
                private_lookup: false,
                title: true,
                icon: true,
                preview: true,
                activate: true,
                publish_metadata: false,
            },
        },
        target: LinkTarget::PublicUrl(format!(
            "https://example.test/secret/{id}?token=fixture-secret#fragment"
        )),
        policy: EnrichmentPolicy::LocalPaste,
        origin: LinkOrigin::LocalPaste,
    }
}
struct Harness {
    clock: Arc<Clock>,
    trace: Arc<(Mutex<Trace>, Condvar)>,
}
impl Harness {
    fn new(gate: bool) -> Self {
        Self {
            clock: Arc::new(Clock(AtomicU64::new(100))),
            trace: Arc::new((
                Mutex::new(Trace {
                    gate,
                    ..Trace::default()
                }),
                Condvar::new(),
            )),
        }
    }
    fn resolver(
        &self,
        mode: Mode,
        limits: ResolverLimits,
    ) -> PublicResolver<Fixture, impl Fn() -> Fixture + Send + Sync + 'static, Clock> {
        let clock = self.clock.clone();
        let trace = self.trace.clone();
        PublicResolver::new(move || Fixture { clock: clock.clone(), trace: trace.clone(), mode, body: b"<title>safe &amp; bounded</title><link rel='icon' href='http://127.0.0.1/private'><script>secret</script>".to_vec() }, self.clock.clone(), PublicUrlPolicy::default(), EgressLimits::default(), limits).unwrap()
    }
    fn entered(&self, count: usize) {
        let t = self.trace.0.lock().unwrap();
        let (t, timeout) = self
            .trace
            .1
            .wait_timeout_while(t, Duration::from_secs(2), |t| t.entered < count)
            .unwrap();
        assert!(
            !timeout.timed_out(),
            "expected {count} blocked reads, saw {}",
            t.entered
        );
    }
    fn release(&self) {
        self.trace.0.lock().unwrap().gate = false;
        self.trace.1.notify_all();
    }
}
fn collect<T, F, C>(r: &mut PublicResolver<T, F, C>, count: usize) -> Vec<PublicDelivery>
where
    T: PublicTransport + Send + 'static,
    F: Fn() -> T + Send + Sync + 'static,
    C: EgressClock + Send + Sync + 'static,
{
    let end = Instant::now() + Duration::from_secs(3);
    let mut results = Vec::new();
    while results.len() < count || r.stats().active > 0 || r.stats().queued > 0 {
        results.extend(r.poll());
        assert!(
            Instant::now() < end,
            "resolver did not terminate: {:?}",
            r.stats()
        );
        thread::park_timeout(Duration::from_millis(10));
    }
    assert_eq!(results.len(), count);
    results
}
fn submit<T, F, C>(r: &mut PublicResolver<T, F, C>, q: LinkRequest) -> Submission
where
    T: PublicTransport + Send + 'static,
    F: Fn() -> T + Send + Sync + 'static,
    C: EgressClock + Send + Sync + 'static,
{
    let host = q.host.clone();
    r.submit(q, &host)
}
fn ready(s: Submission) -> PublicDelivery {
    if let Submission::Ready(d) = s {
        d
    } else {
        panic!("expected immediate delivery: {s:?}")
    }
}
fn title(d: &PublicDelivery) -> &str {
    match &d.result.outcome {
        LinkOutcome::Available {
            metadata: LinkMetadata::Public { display, .. },
            ..
        } => &display.title,
        _ => panic!("expected metadata"),
    }
}

#[test]
fn burst_is_nonblocking_and_bounds_concurrency_queue_pending_and_responses() {
    let h = Harness::new(true);
    let limits = ResolverLimits {
        concurrency: 2,
        queue: 3,
        pending: 5,
        ..ResolverLimits::default()
    };
    let mut r = h.resolver(Mode::Good, limits);
    for id in 0..5 {
        assert!(matches!(submit(&mut r, request(id)), Submission::Scheduled));
    }
    h.entered(2);
    assert!(matches!(submit(&mut r, request(5)), Submission::Full));
    assert_eq!(r.stats().active, 2);
    assert_eq!(r.stats().queued, 3);
    assert_eq!(r.stats().pending, 5);
    // Real semantic editing remains independent while both transport reads wait.
    let mut doc = support::document();
    support::insert(&mut doc, 0, "typing during blocked metadata");
    assert_eq!(support::text(&doc), "typing during blocked metadata");
    h.release();
    let results = collect(&mut r, 5);
    for d in results {
        assert_eq!(title(&d), "safe & bounded");
        assert_eq!(
            d.result
                .validate(&d.result.request, h.clock.now_ms(), false),
            Ok(LinkState::Available)
        );
    }
    let t = h.trace.0.lock().unwrap();
    assert!(t.peak <= 2);
    assert_eq!(t.gets, 5);
    assert_eq!(t.closed, 5);
    assert_eq!(t.active, 0);
    assert!(t.caps.iter().all(|n| *n <= 16_384));
}
#[test]
fn duplicate_subscribers_share_io_but_keep_exact_identity_and_cancellation() {
    let h = Harness::new(true);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let a = request(0);
    let mut b = request(1);
    b.target = a.target.clone();
    assert!(matches!(submit(&mut r, a.clone()), Submission::Scheduled));
    h.entered(1);
    assert!(matches!(
        submit(&mut r, b.clone()),
        Submission::Deduplicated
    ));
    r.cancel(&a.cancellation_token);
    h.release();
    let d = collect(&mut r, 1).pop().unwrap();
    assert_eq!(d.result.request, b);
    assert_eq!(h.trace.0.lock().unwrap().gets, 1);
    assert_eq!(
        d.result
            .validate(&d.result.request, h.clock.now_ms(), false),
        Ok(LinkState::Available)
    );
}
#[test]
fn canceled_running_and_queued_work_produces_no_delivery_cache_or_document_mutation() {
    let h = Harness::new(true);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            concurrency: 1,
            ..ResolverLimits::default()
        },
    );
    let doc = support::document();
    let before = support::text(&doc);
    for id in 0..2 {
        submit(&mut r, request(id));
    }
    h.entered(1);
    r.cancel("cancel:0");
    r.cancel("cancel:1");
    assert_eq!(r.stats().active, 1);
    assert_eq!(r.stats().queued, 0);
    h.release();
    collect(&mut r, 0);
    assert_eq!(r.stats().cached, 0);
    assert_eq!(support::text(&doc), before);
    assert_eq!(h.trace.0.lock().unwrap().closed, 1);
}
#[test]
fn dispose_joins_and_clears_every_worker_queue_result_cache_and_is_idempotent() {
    let h = Harness::new(true);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            concurrency: 1,
            ..ResolverLimits::default()
        },
    );
    for id in 0..3 {
        submit(&mut r, request(id));
    }
    h.entered(1);
    h.release();
    r.dispose();
    r.dispose();
    assert_eq!(
        r.stats(),
        ResolverStats {
            disposed: true,
            ..ResolverStats::default()
        }
    );
    assert!(r.poll().is_empty());
    assert!(matches!(
        submit(&mut r, request(9)),
        Submission::Rejected(LinkState::Canceled)
    ));
    assert_eq!(h.trace.0.lock().unwrap().active, 0);
    assert_eq!(h.trace.0.lock().unwrap().closed, 1);
}
#[test]
fn drop_joins_workers_without_detaching() {
    let h = Harness::new(true);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    submit(&mut r, request(0));
    h.entered(1);
    h.release();
    drop(r);
    assert_eq!(h.trace.0.lock().unwrap().active, 0);
    assert_eq!(h.trace.0.lock().unwrap().closed, 1);
}
#[test]
fn cache_hit_offline_and_network_wait_are_separate_with_explicit_freshness() {
    let h = Harness::new(false);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            positive_ms: 50,
            ..ResolverLimits::default()
        },
    );
    let q = request(0);
    submit(&mut r, q.clone());
    let d = collect(&mut r, 1).pop().unwrap();
    assert_eq!(d.timing.network_ms, 14);
    assert!(!d.timing.cache_hit);
    r.set_online(false);
    let hit = ready(submit(&mut r, q.clone()));
    assert!(hit.timing.cache_hit);
    assert_eq!(hit.timing.network_ms, 0);
    assert_eq!(title(&hit), "safe & bounded");
    h.clock.advance(50);
    let miss = ready(submit(&mut r, q));
    assert_eq!(miss.result.outcome.state(), LinkState::Unavailable);
    assert!(!miss.timing.cache_hit);
    assert_eq!(h.trace.0.lock().unwrap().dns, 1);
    println!("timing fixture: network14ms; warm/offline cache0ms; zero additional requests");
}
#[test]
fn negative_cache_expires_without_automatic_retries() {
    let h = Harness::new(false);
    let mut r = h.resolver(
        Mode::Offline,
        ResolverLimits {
            negative_ms: 20,
            ..ResolverLimits::default()
        },
    );
    let q = request(0);
    submit(&mut r, q.clone());
    let d = collect(&mut r, 1).pop().unwrap();
    assert_eq!(d.result.outcome.state(), LinkState::Unavailable);
    assert!(ready(submit(&mut r, q.clone())).timing.cache_hit);
    assert_eq!(h.trace.0.lock().unwrap().dns, 1);
    h.clock.advance(20);
    assert!(r.poll().is_empty());
    assert_eq!(h.trace.0.lock().unwrap().dns, 1);
    assert!(matches!(submit(&mut r, q), Submission::Scheduled));
    collect(&mut r, 1);
    assert_eq!(h.trace.0.lock().unwrap().dns, 2);
}
macro_rules! failure_case {
    ($name:ident,$mode:ident,$gets:expr) => {
        #[test]
        fn $name() {
            let h = Harness::new(false);
            let mut r = h.resolver(Mode::$mode, ResolverLimits::default());
            let q = request(0);
            submit(&mut r, q.clone());
            let d = collect(&mut r, 1).pop().unwrap();
            assert_eq!(d.result.outcome.state(), LinkState::Unavailable);
            assert_eq!(h.trace.0.lock().unwrap().gets, $gets);
            assert_eq!(h.trace.0.lock().unwrap().active, 0);
            assert!(ready(submit(&mut r, q)).timing.cache_hit);
        }
    };
}
failure_case!(timeout_aborts_and_negative_caches, Timeout, 1);
failure_case!(oversized_stream_aborts_and_negative_caches, Oversize, 1);
failure_case!(denied_address_makes_zero_gets, Denied, 0);
failure_case!(panicking_adapter_releases_scheduler_capacity, Panic, 0);
macro_rules! isolation {
    ($name:ident,$change:expr) => {
        #[test]
        fn $name() {
            let h = Harness::new(false);
            let mut r = h.resolver(Mode::Good, ResolverLimits::default());
            let q = request(0);
            submit(&mut r, q.clone());
            collect(&mut r, 1);
            r.set_online(false);
            let mut other = q.clone();
            ($change)(&mut other);
            let d = ready(submit(&mut r, other));
            assert_eq!(d.result.outcome.state(), LinkState::Unavailable);
            assert!(!d.timing.cache_hit);
            assert_eq!(h.trace.0.lock().unwrap().gets, 1);
        }
    };
}
isolation!(principal_isolation, |q: &mut LinkRequest| q
    .host
    .principal =
    "principal:2".into());
isolation!(tenant_isolation, |q: &mut LinkRequest| q.host.tenant =
    "tenant:2".into());
isolation!(authority_isolation, |q: &mut LinkRequest| q
    .host
    .authority =
    Some(Authority::parse("other").unwrap()));
isolation!(policy_revision_isolation, |q: &mut LinkRequest| q
    .host
    .policy_revision =
    "policy:2".into());
isolation!(policy_mode_isolation, |q: &mut LinkRequest| {
    q.policy = EnrichmentPolicy::ExplicitRefresh;
    q.origin = LinkOrigin::ExplicitRefresh;
});
isolation!(permission_revision_isolation, |q: &mut LinkRequest| q
    .host
    .scope
    .permission =
    "permission:2".into());
isolation!(document_isolation, |q: &mut LinkRequest| q
    .host
    .scope
    .document =
    "doc:2".into());
isolation!(session_isolation, |q: &mut LinkRequest| q
    .host
    .scope
    .session =
    "session:2".into());
isolation!(revision_isolation, |q: &mut LinkRequest| q
    .host
    .scope
    .revision =
    "revision:2".into());
macro_rules! no_call {
    ($name:ident,$change:expr) => {
        #[test]
        fn $name() {
            let h = Harness::new(false);
            let mut r = h.resolver(Mode::Good, ResolverLimits::default());
            let mut q = request(0);
            ($change)(&mut q);
            assert!(matches!(submit(&mut r, q), Submission::Rejected(_)));
            assert_eq!(h.trace.0.lock().unwrap().dns, 0);
            assert_eq!(r.stats().pending, 0);
        }
    };
}
no_call!(disabled_never_calls, |q: &mut LinkRequest| q.policy =
    EnrichmentPolicy::Disabled);
no_call!(open_never_calls, |q: &mut LinkRequest| q.origin =
    LinkOrigin::Open);
no_call!(render_never_calls, |q: &mut LinkRequest| q.origin =
    LinkOrigin::Render);
no_call!(remote_never_calls, |q: &mut LinkRequest| q.origin =
    LinkOrigin::Remote);
no_call!(replay_never_calls, |q: &mut LinkRequest| q.origin =
    LinkOrigin::Replay);
no_call!(history_never_calls, |q: &mut LinkRequest| q.origin =
    LinkOrigin::History);
no_call!(unauthorized_never_calls, |q: &mut LinkRequest| q
    .host
    .scope
    .authorized =
    false);
no_call!(capability_denial_never_calls, |q: &mut LinkRequest| q
    .host
    .capabilities
    .public_metadata =
    false);
no_call!(url_credentials_never_call, |q: &mut LinkRequest| q.target =
    LinkTarget::PublicUrl("https://name:secret@example.test/".into()));
#[test]
fn current_authority_denial_precedes_cached_results() {
    let h = Harness::new(false);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let q = request(0);
    submit(&mut r, q.clone());
    collect(&mut r, 1);
    let mut current = q.host.clone();
    current.principal = "other".into();
    assert!(matches!(
        r.submit(q, &current),
        Submission::Rejected(LinkState::Forbidden)
    ));
}
#[test]
fn queued_timeout_expires_without_new_transport() {
    let h = Harness::new(true);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            concurrency: 1,
            queue_ms: 20,
            ..ResolverLimits::default()
        },
    );
    submit(&mut r, request(0));
    submit(&mut r, request(1));
    h.entered(1);
    h.clock.advance(20);
    h.release();
    let ds = collect(&mut r, 2);
    assert!(
        ds.iter()
            .any(|d| d.result.outcome.state() == LinkState::Unavailable)
    );
    assert_eq!(h.trace.0.lock().unwrap().gets, 1);
}
#[test]
fn offline_transition_suppresses_late_success_and_does_not_cache_it() {
    let h = Harness::new(true);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            concurrency: 1,
            ..ResolverLimits::default()
        },
    );
    submit(&mut r, request(0));
    submit(&mut r, request(1));
    h.entered(1);
    r.set_online(false);
    h.release();
    let ds = collect(&mut r, 2);
    assert!(
        ds.iter()
            .all(|d| d.result.outcome.state() == LinkState::Unavailable)
    );
    assert_eq!(r.stats().cached, 0);
    assert_eq!(h.trace.0.lock().unwrap().gets, 1);
}
#[test]
fn bounded_cache_evicts_and_normalized_urls_retain_per_subscriber_identity() {
    let h = Harness::new(false);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            cache_entries: 1,
            ..ResolverLimits::default()
        },
    );
    let q = request(0);
    submit(&mut r, q.clone());
    collect(&mut r, 1);
    let mut normalized = request(2);
    normalized.target = LinkTarget::PublicUrl(
        "https://EXAMPLE.test:443/secret/0?token=fixture-secret#other".into(),
    );
    let d = ready(submit(&mut r, normalized.clone()));
    assert!(d.timing.cache_hit);
    assert_eq!(
        d.result.validate(&normalized, h.clock.now_ms(), false),
        Ok(LinkState::Available)
    );
    submit(&mut r, request(1));
    collect(&mut r, 1);
    assert_eq!(r.stats().cached, 1);
    r.set_online(false);
    assert!(!ready(submit(&mut r, q)).timing.cache_hit);
}
#[test]
fn diagnostics_and_stale_results_do_not_leak_or_overwrite_changed_labels() {
    let h = Harness::new(false);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let q = request(0);
    submit(&mut r, q.clone());
    let d = collect(&mut r, 1).pop().unwrap();
    let debug = format!("{d:?} {:?}", r.stats());
    for secret in [
        "secret",
        "example.test",
        "token",
        "principal:1",
        "safe & bounded",
    ] {
        assert!(!debug.contains(secret));
    }
    let mut changed = q.clone();
    changed.label_revision = "new-label".into();
    assert_eq!(
        d.result.validate(&changed, h.clock.now_ms(), false),
        Err(LinkState::Stale)
    );
    changed = q.clone();
    changed.node = "deleted/replaced".into();
    assert_eq!(
        d.result.validate(&changed, h.clock.now_ms(), false),
        Err(LinkState::Stale)
    );
    assert_eq!(
        d.result.validate(&q, h.clock.now_ms(), true),
        Err(LinkState::Canceled)
    );
}
#[test]
fn deduplicated_subscribers_and_request_id_collisions_remain_bounded() {
    let h = Harness::new(true);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            pending: 2,
            ..ResolverLimits::default()
        },
    );
    let q = request(0);
    submit(&mut r, q.clone());
    h.entered(1);
    assert!(matches!(
        submit(&mut r, q.clone()),
        Submission::Rejected(LinkState::Stale)
    ));
    let mut b = request(1);
    b.target = q.target.clone();
    assert!(matches!(submit(&mut r, b), Submission::Deduplicated));
    let mut c = request(2);
    c.target = q.target;
    assert!(matches!(submit(&mut r, c), Submission::Full));
    h.release();
    collect(&mut r, 2);
    assert_eq!(h.trace.0.lock().unwrap().gets, 1);
}
#[test]
fn resolver_limits_reject_unbounded_configurations() {
    let h = Harness::new(false);
    for limits in [
        ResolverLimits {
            concurrency: 0,
            ..ResolverLimits::default()
        },
        ResolverLimits {
            queue: 257,
            ..ResolverLimits::default()
        },
        ResolverLimits {
            pending: 1025,
            ..ResolverLimits::default()
        },
        ResolverLimits {
            cache_entries: 0,
            ..ResolverLimits::default()
        },
        ResolverLimits {
            positive_ms: 3_600_001,
            ..ResolverLimits::default()
        },
        ResolverLimits {
            negative_ms: 60_001,
            ..ResolverLimits::default()
        },
        ResolverLimits {
            queue_ms: 30_001,
            ..ResolverLimits::default()
        },
    ] {
        let result = PublicResolver::new(
            || Fixture {
                clock: Arc::new(Clock::default()),
                trace: Arc::default(),
                mode: Mode::Good,
                body: vec![],
            },
            h.clock.clone(),
            PublicUrlPolicy::default(),
            EgressLimits::default(),
            limits,
        );
        assert!(matches!(result, Err(EgressError::InvalidLimits)));
    }
}
#[test]
fn completion_notifies_host_event_loop_and_requires_no_idle_polling() {
    let h = Harness::new(false);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    r.set_completion_waker(move || {
        send.try_send(()).unwrap();
    })
    .unwrap();
    submit(&mut r, request(0));
    receive.recv_timeout(Duration::from_secs(2)).unwrap();
    // Notification precedes the thread's final exit by a few instructions;
    // collection is nonblocking, and the bounded helper parks between attempts.
    let d = collect(&mut r, 1);
    assert_eq!(title(&d[0]), "safe & bounded");
}
#[test]
fn completion_after_permission_revocation_is_rejected_by_shared_delivery_contract() {
    let h = Harness::new(true);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let q = request(0);
    submit(&mut r, q.clone());
    h.entered(1);
    let mut revoked = q.clone();
    revoked.host.scope.authorized = false;
    h.release();
    let d = collect(&mut r, 1).pop().unwrap();
    assert_eq!(
        d.result.validate(&revoked, h.clock.now_ms(), false),
        Err(LinkState::Forbidden)
    );
    assert!(matches!(
        r.submit(q, &revoked.host),
        Submission::Rejected(LinkState::Forbidden)
    ));
}
#[test]
fn cancel_after_completion_before_delivery_removes_late_result() {
    let h = Harness::new(false);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let q = request(0);
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    r.set_completion_waker(move || {
        let _ = send.try_send(());
    })
    .unwrap();
    submit(&mut r, q.clone());
    receive.recv_timeout(Duration::from_secs(2)).unwrap();
    r.cancel(&q.cancellation_token);
    collect(&mut r, 0);
    assert_eq!(r.stats().cached, 0);
    assert!(r.poll().is_empty());
}
#[test]
fn queued_duplicate_is_one_job_and_canceling_one_waiter_preserves_other() {
    let h = Harness::new(true);
    let mut r = h.resolver(
        Mode::Good,
        ResolverLimits {
            concurrency: 1,
            ..ResolverLimits::default()
        },
    );
    submit(&mut r, request(0));
    h.entered(1);
    let q = request(1);
    let mut duplicate = request(2);
    duplicate.target = q.target.clone();
    submit(&mut r, q.clone());
    assert!(matches!(
        submit(&mut r, duplicate.clone()),
        Submission::Deduplicated
    ));
    r.cancel(&q.cancellation_token);
    h.release();
    let ds = collect(&mut r, 2);
    assert!(ds.iter().any(|d| d.result.request == duplicate));
    assert_eq!(h.trace.0.lock().unwrap().gets, 2);
}

#[test]
fn qualification_timing_and_retained_cache_memory() {
    fn wait<T, F, C>(r: &mut PublicResolver<T, F, C>) -> PublicDelivery
    where
        T: PublicTransport + Send + 'static,
        F: Fn() -> T + Send + Sync + 'static,
        C: EgressClock + Send + Sync + 'static,
    {
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            let mut deliveries = r.poll();
            if let Some(d) = deliveries.pop() {
                return d;
            }
            assert!(Instant::now() < end, "timing fixture failed to settle");
            thread::park_timeout(Duration::from_millis(1));
        }
    }
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    let mut policy = Vec::new();
    let mut construction = Vec::new();
    let mut cold_gets = 0;
    for sample in 0..130 {
        let h = Harness::new(false);
        let start = Instant::now();
        let mut r = h.resolver(Mode::Good, ResolverLimits::default());
        let setup = start.elapsed().as_nanos();
        let owner = thread::current();
        r.set_completion_waker(move || owner.unpark()).unwrap();
        let start = Instant::now();
        let mut denied = request(0);
        denied.policy = EnrichmentPolicy::Disabled;
        assert!(matches!(submit(&mut r, denied), Submission::Rejected(_)));
        let local = start.elapsed().as_nanos();
        assert_eq!(h.trace.0.lock().unwrap().gets, 0);
        let start = Instant::now();
        assert!(matches!(submit(&mut r, request(0)), Submission::Scheduled));
        let d = wait(&mut r);
        let network = start.elapsed().as_nanos();
        assert_eq!(title(&d), "safe & bounded");
        assert!(!d.timing.cache_hit);
        let start = Instant::now();
        let mut q = request(1);
        q.target = request(0).target;
        let d = ready(submit(&mut r, q));
        let cached = start.elapsed().as_nanos();
        assert!(d.timing.cache_hit);
        assert_eq!(r.stats().cached, 1);
        assert_eq!(h.trace.0.lock().unwrap().gets, 1);
        cold_gets += 1;
        if sample >= 10 {
            construction.push(setup);
            policy.push(local);
            cold.push(network);
            warm.push(cached);
        }
        r.dispose();
        assert_eq!(r.stats().cached, 0);
        assert_eq!(r.stats().pending, 0);
    }
    // OS resident bytes for the WHOLE serial test process, not cache object
    // allocation size. Allocator retention/page granularity may hide release.
    fn resident_bytes() -> u64 {
        if std::env::var_os("EDITAC_LINK_TIMING_OUTPUT").is_none() {
            return 0;
        }
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .expect("RSS measurement tool");
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap()
            * 1024
    }
    let h = Harness::new(false);
    let mut r = h.resolver(Mode::Good, ResolverLimits::default());
    let owner = thread::current();
    r.set_completion_waker(move || owner.unpark()).unwrap();
    let before = resident_bytes();
    for id in 0..96 {
        assert!(matches!(submit(&mut r, request(id)), Submission::Scheduled));
        assert_eq!(title(&wait(&mut r)), "safe & bounded");
        assert!(r.stats().cached <= 64);
    }
    let retained = resident_bytes();
    assert_eq!(r.stats().cached, 64);
    r.dispose();
    let disposed = resident_bytes();
    assert_eq!(r.stats().cached, 0);
    assert_eq!(r.stats().pending, 0);
    assert_eq!(h.trace.0.lock().unwrap().gets, 96);
    assert_eq!(h.trace.0.lock().unwrap().active, 0);
    if let Ok(path) = std::env::var("EDITAC_LINK_TIMING_OUTPUT") {
        std::fs::write(path, format!("{{\"provenance\":\"serial Rust prepared DNS/transport, real parser and resolver; wall nanoseconds; 10 warmups excluded\",\"samples\":120,\"construction_ns\":{construction:?},\"policy_denial_ns\":{policy:?},\"cold_prepared_network_ns\":{cold:?},\"warm_cache_ns\":{warm:?},\"cold_gets_including_warmup\":{cold_gets},\"warm_gets\":0,\"denied_gets\":0,\"cache_probe_gets\":96,\"cache_entries_peak\":64,\"cache_entries_after_dispose\":0,\"whole_process_rss_before_bytes\":{before},\"whole_process_rss_cache64_bytes\":{retained},\"whole_process_rss_disposed_bytes\":{disposed}}}\n")).unwrap();
    }
}
