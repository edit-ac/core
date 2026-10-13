//! CAP-1.10: one operation corpus/oracle shared with an actual browser host.
mod support;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::TextCommand,
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    ports::{memory::*, *},
    session::*,
};
use std::{path::PathBuf, sync::Arc};
use support::{origin, owner, text};
const FIXTURES: &str = include_str!("../../../fixtures/client-contracts/conformance.tsv");
fn identity(case: &str) -> DocumentIdentity {
    let index = ["Offline", "Recovery", "Readonly", "Reconnect"]
        .iter()
        .position(|s| *s == case)
        .unwrap()
        + 1;
    DocumentIdentity::v5(
        &format!("12345678-1234-4234-8234-{index:012x}"),
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
fn output() -> PathBuf {
    let path = std::env::var_os("EDITAC_CONFORMANCE_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("editac-conformance-{}", std::process::id()))
        });
    std::fs::create_dir_all(&path).unwrap();
    path
}
trait HarnessStore: SessionStore + Sized {
    fn fail(&self);
    fn reopen(self: &Arc<Self>, _: &DocumentIdentity) -> Arc<Self> {
        self.clone()
    }
}
impl HarnessStore for FaultInjectedStore {
    fn fail(&self) {
        self.inject(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    }
}
#[cfg(feature = "native-store")]
impl HarnessStore for editac_session::store::NativeStore {
    fn fail(&self) {
        self.inject_once(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    }
    fn reopen(self: &Arc<Self>, id: &DocumentIdentity) -> Arc<Self> {
        Arc::new(Self::open_existing(self.path(), id.clone(), StoreLimits::default()).unwrap())
    }
}
fn insert<S: SessionStore>(
    s: &mut Session<S>,
    value: &str,
) -> Result<Option<LocalCommit>, SessionError> {
    let at = s
        .document()
        .anchor(&owner(s.document()), Utf16Offset(0), Bias::Right)
        .unwrap();
    s.edit_text(
        &TextCommand::Insert {
            at,
            text: value.into(),
        },
        &origin(),
        0,
    )
}
fn run<S: HarnessStore>(case: &str, mut store: Arc<S>, adapter: &str) {
    let id = identity(case);
    // Creation permits are process-unique. All adapters restore the same initialized seed.
    static SEEDS: std::sync::OnceLock<Vec<editac_core::document::InitializedCheckpoint>> =
        std::sync::OnceLock::new();
    let seeds = SEEDS.get_or_init(|| {
        ["Offline", "Recovery", "Readonly", "Reconnect"]
            .iter()
            .map(|case| {
                editac_core::document::Document::create(
                    editac_core::document::CreationPermit::authorize_new(identity(case)).unwrap(),
                    &[InitialNode {
                        kind: "block".into(),
                        text: String::new(),
                    }],
                )
                .unwrap()
                .checkpoint()
            })
            .collect()
    });
    let seed = seeds
        .iter()
        .find(|point| point.identity == id)
        .unwrap()
        .clone();
    store
        .publish(0, CheckpointRecord::new(seed, vec![]).unwrap())
        .unwrap();
    let mut s = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    let mut readonly = false;
    let mut trace = String::new();
    let mut rows = 0;
    for row in FIXTURES
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter(|l| l.split('\t').next() == Some(case))
    {
        let fields: Vec<_> = row.split('\t').collect();
        assert_eq!(fields.len(), 6);
        let result = match fields[1] {
            "insert" => match insert(&mut s, fields[2]) {
                Ok(Some(_)) => "committed",
                Err(SessionError::ReadOnly) => "rejected",
                other => panic!("unexpected insert {other:?}"),
            },
            "undo" | "redo" => {
                let r = if fields[1] == "undo" {
                    s.undo(0)
                } else {
                    s.redo(0)
                };
                match r {
                    Ok(Some(_)) => "committed",
                    Err(SessionError::ReadOnly) => "rejected",
                    other => panic!("unexpected history {other:?}"),
                }
            }
            "readonly" | "writable" => {
                readonly = fields[1] == "readonly";
                s.set_permission(CachedPermission {
                    writable: !readonly,
                    expires_at: None,
                });
                "ready"
            }
            "fail-insert" => {
                store.fail();
                assert!(insert(&mut s, fields[2]).is_err());
                assert_eq!(s.state(0).readiness, Readiness::RecoveryRequired);
                assert_eq!(usize::from(s.recovery_export().unjournaled.is_some()), 1);
                "recovery-required"
            }
            "recover" => {
                s.recover().unwrap();
                assert_eq!(s.state(0).readiness, Readiness::Ready);
                "ready"
            }
            "reopen" => {
                let old = s.document().writer_id();
                drop(s);
                store = store.reopen(&id);
                s = Session::open(
                    store.clone(),
                    &id,
                    CachedPermission {
                        writable: !readonly,
                        expires_at: None,
                    },
                )
                .unwrap();
                assert_ne!(old, s.document().writer_id());
                "ready"
            }
            "peer-insert" => {
                let mut peer = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
                insert(&mut peer, fields[2]).unwrap();
                "detached"
            }
            "upload" => {
                let transport = PreparedTransport::new(
                    id.clone(),
                    ConnectionState::Authorized,
                    TransportCapabilities {
                        receipts: ReceiptCapability::Unknown,
                        max_frame_bytes: 1_000_000,
                        max_queue_bytes: 2_000_000,
                        max_queue_frames: 32,
                    },
                )
                .unwrap();
                s.attach_transport(Box::new(transport), 100, 0).unwrap();
                assert_eq!(s.flush_pending(0).unwrap(), 2);
                assert_eq!(s.state(0).remote, RemoteState::SentDurabilityUnknown);
                s.detach_transport();
                "sent-unknown"
            }
            "catch-up" => {
                s.catch_up_local().unwrap();
                "ready"
            }
            action => panic!("unknown action {action}"),
        };
        let current = text(s.document());
        let pending = store.pending(&id).unwrap().len();
        assert_eq!(
            current,
            if fields[3] == "~" { "" } else { fields[3] },
            "{case}/{}",
            fields[1]
        );
        assert_eq!(pending.to_string(), fields[4], "{case}/{}", fields[1]);
        assert_eq!(result, fields[5]);
        trace.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\n",
            case,
            fields[1],
            fields[2],
            if current.is_empty() { "~" } else { &current },
            pending,
            result
        ));
        rows += 1;
    }
    assert!(rows >= 4);
    assert_eq!(s.state(0).remote, RemoteState::Unknown);
    std::fs::write(output().join(format!("{adapter}-{case}.tsv")), trace).unwrap();
}
macro_rules! cases {($($name:ident => $case:literal),*) => {$ (
    #[test] fn $name() {let id=identity($case);run($case,Arc::new(FaultInjectedStore::new(id,StoreLimits::default()).unwrap()),"headless");}
)*};}
cases!(offline => "Offline", recovery => "Recovery", readonly => "Readonly", reconnect => "Reconnect");
#[cfg(feature = "native-store")]
macro_rules! native_cases {($($name:ident => $case:literal),*) => {$ (
    #[test] fn $name() {let id=identity($case);let path=output().join(format!("{}-{}-document.sqlite3",std::process::id(),$case));
        run($case,Arc::new(editac_session::store::NativeStore::create_new(path,id,StoreLimits::default()).unwrap()),"native");}
)*};}
#[cfg(feature = "native-store")]
native_cases!(native_offline => "Offline", native_recovery => "Recovery", native_readonly => "Readonly", native_reconnect => "Reconnect");
