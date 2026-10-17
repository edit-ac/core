use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::{
        editor::{EditorCommand, FragmentBlock, FragmentRun},
        text::{TextCommand, TextOrigin},
    },
    document::{DocumentIdentity, InitialNode},
    modules::assets::*,
    projection::Snapshot,
};
use editac_formats::{job::*, *};
use editac_session::{
    assets::*,
    edit_service::HostPolicy,
    ports::{memory::*, *},
    session::CachedPermission,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

type Owner = ConversionOwner<MemoryStore>;
fn identity() -> DocumentIdentity {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    DocumentIdentity::v5(
        &format!(
            "27000000-0000-4000-8000-{:012x}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ),
        "27000000-0000-4000-8000-000000000000",
    )
    .unwrap()
}
fn owner() -> (Owner, Arc<MemoryStore>) {
    let id = identity();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    (
        ConversionOwner::create(
            store.clone(),
            id,
            &[InitialNode {
                kind: "block".into(),
                text: "base".into(),
            }],
            HostPolicy::default(),
        )
        .unwrap(),
        store,
    )
}
fn text(s: &Snapshot) -> String {
    s.visible
        .iter()
        .flat_map(|n| n.runs.iter().map(|r| r.text.as_str()))
        .collect()
}
fn current(owner: &Owner) -> String {
    text(&owner.service().read(0).unwrap().snapshot)
}
fn target(owner: &Owner) -> Selection {
    let d = owner.service().session().document();
    let node = &d.snapshot().unwrap().visible[0].id;
    let a = d.anchor(node, Utf16Offset(0), Bias::Right).unwrap();
    Selection {
        anchor: a.clone(),
        focus: a,
    }
}
fn edit(owner: &mut Owner, value: &str) {
    let t = target(owner);
    let r = owner.service().read(0).unwrap().revision;
    let p = owner
        .service()
        .prepare_commands(
            &r,
            &[EditorCommand::Text(TextCommand::Insert {
                at: t.anchor,
                text: value.into(),
            })],
            &TextOrigin::new("human").unwrap(),
            0,
        )
        .unwrap();
    owner.service_mut().apply(p, 0).unwrap();
}
fn blocks(value: &str) -> Vec<FragmentBlock> {
    vec![FragmentBlock {
        runs: vec![FragmentRun {
            text: value.into(),
            marks: vec![],
        }],
        attributes: None,
        containers: vec![],
        checked: None,
    }]
}
fn profile_fixture() -> Profile {
    Profile {
        available: true,
        ..PROFILES[0]
    }
}
fn spec<'a>(o: &Owner, id: &'a str, direction: Direction) -> JobSpec<'a> {
    JobSpec {
        id,
        profile: profile_fixture(),
        direction,
        original: b"hand-authored local source",
        filename: "fixture.docx",
        media_type: "application/octet-stream",
        target: (direction == Direction::Import).then(|| target(o)),
        limits: LIMITS,
        timeout: 100,
        memory_bytes: 8 * 1024 * 1024,
    }
}
struct Port {
    enforcement: Enforcement,
    starts: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    fail: bool,
}
impl ExecutionPort for Port {
    fn enforcement(&self) -> Enforcement {
        self.enforcement
    }
    fn start(
        &mut self,
        c: &JobContract,
        s: &JobSource,
        cancellation: &Cancellation,
    ) -> Result<(), JobError> {
        assert!(!cancellation.is_cancelled());
        self.starts.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            c.input_sha256,
            <[u8; 32]>::from(Sha256::digest(s.original()))
        );
        if self.fail {
            Err(JobError::IsolationUnavailable)
        } else {
            Ok(())
        }
    }
    fn stop(&mut self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
}
fn port() -> (Box<Port>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let starts = Arc::new(AtomicUsize::new(0));
    let stops = Arc::new(AtomicUsize::new(0));
    (
        Box::new(Port {
            enforcement: Enforcement {
                isolation: Isolation::NativeProcess,
                hard_memory_bytes: 8 * 1024 * 1024,
                watchdog: true,
                restricted_assets: true,
                no_network: true,
            },
            starts: starts.clone(),
            stops: stops.clone(),
            fail: false,
        }),
        starts,
        stops,
    )
}
fn job(o: &Owner, id: &str, direction: Direction) -> PreparedJob<MemoryStore> {
    PreparedJob::begin(
        o,
        spec(o, id, direction),
        &JobPool::new(2).unwrap(),
        port().0,
        0,
    )
    .unwrap()
}
fn asset() -> AssetIdentity {
    AssetIdentity {
        host: "prepared".into(),
        key: "shared_binary".into(),
    }
}
#[derive(Default)]
struct Host {
    fail: bool,
    denied: bool,
    effects: Vec<(String, AssetAction)>,
}
impl AssetHost for Host {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        if self.denied {
            return Err(PortError::Permission);
        }
        Ok(AssetGrant {
            identity: r.identity.clone(),
            actions: vec![r.action],
        })
    }
    fn execute(&mut self, reference: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        if self.fail {
            return Err(PortError::Unavailable);
        }
        self.effects.push((reference.into(), r.action));
        Ok(HostOutcome::Complete)
    }
}
fn clean(store: &MemoryStore, host: &mut Host) {
    let pending: Vec<_> = store
        .asset_journal()
        .unwrap()
        .intents()
        .iter()
        .filter(|i| i.status == WorkStatus::Pending)
        .map(|i| i.request.operation_id.clone())
        .collect();
    for id in pending {
        AssetWork::new(store).run_one(&id, true, host).unwrap();
    }
}
