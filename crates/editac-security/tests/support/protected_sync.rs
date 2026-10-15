//! Shared real MLS/Session/protected SQLite/opaque-relay fixture.
use crate::envelope::*;
use crate::keys::*;
use crate::store::*;
use crate::store_native::*;
use crate::support::*;
use crate::sync::*;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    ports::*,
    session::{CachedPermission, Session},
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use zeroize::Zeroizing;

pub(crate) const SEED: &str = "SEC16_CONFIDENTIAL_INITIAL_20261015";
pub(crate) const A: &str = "SEC16_OFFLINE_ALPHA";
pub(crate) const B: &str = "SEC16_OFFLINE_BRAVO";
pub(crate) fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
pub(crate) fn context() -> Context {
    Context {
        document: DOCUMENT,
        document_epoch: 11,
        schema: 3,
        key_epoch: 1,
    }
}
pub(crate) fn key_context() -> KeyContext {
    KeyContext {
        document: DOCUMENT,
        document_epoch: 11,
        key_epoch: 1,
        purpose: KeyPurpose::LocalStore,
    }
}
pub(crate) struct Keys;
impl HostKeyProvider for Keys {
    fn acquire(&mut self, c: KeyContext) -> Result<DecodedKey, KeyFailure> {
        if c != key_context() {
            return Err(KeyFailure::Context);
        }
        Ok(DecodedKey::from_host(c, Zeroizing::new([0x61; 32])))
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn wrap(&mut self, _: KeyContext, _: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn unwrap(&mut self, _: KeyContext, _: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
}
pub(crate) type Protected = ProtectedStore<SqliteHost, Keys>;
pub(crate) type Client = EncryptedClient<FixtureProvider>;
pub(crate) fn client(seed: u8) -> Client {
    let (p, g) = prepared(seed);
    let writers = [signer(1).to_public_vec(), signer(2).to_public_vec()].into();
    let admission =
        Admission::fresh_prepared_membership(p, g, context(), writers, signer(1).to_public_vec())
            .ok()
            .unwrap();
    Client::fresh_prepared(admission, signer(seed), identity(), context())
        .ok()
        .unwrap()
}
pub(crate) fn dir(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = PathBuf::from(
        std::env::var_os("SEC16_ARTIFACT_DIR")
            .unwrap_or_else(|| std::env::temp_dir().join("editac-sec16").into_os_string()),
    );
    let path = root.join(format!(
        "{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}
pub(crate) fn protected(path: &Path, observer: Option<Observer>) -> Arc<Protected> {
    Arc::new(
        ProtectedStore::new(
            identity(),
            key_context(),
            StoreLimits::default(),
            SqliteHost::open(path, observer).unwrap(),
            Keys,
        )
        .ok()
        .unwrap(),
    )
}
pub(crate) fn relay(path: &Path, observer: Option<Observer>) -> OpaqueRelay<SqliteHost> {
    relay_for_scope(path, observer, Scope::prepared(&identity(), &context()))
}
/// Host opens an explicit ciphertext partition for the authenticated new epoch;
/// old partitions are preserved. No partition creation grants decryption keys.
pub(crate) fn relay_for_scope(
    path: &Path,
    observer: Option<Observer>,
    scope: Scope,
) -> OpaqueRelay<SqliteHost> {
    OpaqueRelay::new(SqliteHost::open(path, observer).unwrap(), scope)
        .ok()
        .unwrap()
}
pub(crate) fn edit(s: &mut Session<Arc<Protected>>, text: &str) {
    let block = s
        .document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let at = s
        .document()
        .anchor(&block, Utf16Offset(0), Bias::Right)
        .unwrap();
    s.edit_text(
        &TextCommand::Insert {
            at,
            text: text.into(),
        },
        &TextOrigin::new("security:sync").unwrap(),
        0,
    )
    .unwrap()
    .unwrap();
}
pub(crate) fn text(s: &Session<Arc<Protected>>) -> String {
    s.document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .flat_map(|n| n.runs.iter().map(|r| r.text.as_str()))
        .collect()
}
pub(crate) fn no_plaintext(dir: &Path) {
    for file in fs::read_dir(dir).unwrap() {
        let path = file.unwrap().path();
        let bytes = fs::read(&path).unwrap();
        for seed in [SEED.as_bytes(), A.as_bytes(), B.as_bytes(), &[0x61; 32]] {
            assert!(
                !bytes.windows(seed.len()).any(|w| w == seed),
                "seed leaked to {}",
                path.display()
            );
        }
    }
}
pub(crate) struct Harness {
    pub(crate) dir: PathBuf,
    pub(crate) relay: OpaqueRelay<SqliteHost>,
    pub(crate) ca: Client,
    pub(crate) cb: Client,
    pub(crate) sa: Arc<Protected>,
    pub(crate) sb: Arc<Protected>,
    pub(crate) a: Session<Arc<Protected>>,
    pub(crate) b: Session<Arc<Protected>>,
}
impl Harness {
    pub(crate) fn new(name: &str) -> Self {
        let dir = dir(name);
        let sa = protected(&dir.join("a.sqlite"), None);
        let sb = protected(&dir.join("b.sqlite"), None);
        static INITIAL: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
            std::sync::OnceLock::new();
        let point = INITIAL.get_or_init(|| {
            let document = editac_core::document::Document::create(
                editac_core::document::CreationPermit::authorize_new(identity()).unwrap(),
                &[InitialNode {
                    kind: "block".into(),
                    text: SEED.into(),
                }],
            )
            .unwrap();
            document.checkpoint()
        });
        sa.publish(0, CheckpointRecord::new(point.clone(), vec![]).unwrap())
            .unwrap();
        let a = Session::open(sa.clone(), &identity(), CachedPermission::LOCAL).unwrap();
        let mut ca = client(1);
        let mut cb = client(2);
        let relay = relay(&dir.join("relay.sqlite"), None);
        ca.prepare_checkpoint([1; 16], &a.document().checkpoint())
            .unwrap();
        ca.send(&relay, [1; 16]).unwrap();
        let packets = relay.fetch(cb.scope()).unwrap();
        cb.bootstrap(&packets[0], &*sb).unwrap();
        let b = Session::open(sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
        assert_eq!(text(&a), text(&b));
        no_plaintext(&dir);
        Self {
            dir,
            relay,
            ca,
            cb,
            sa,
            sb,
            a,
            b,
        }
    }
    pub(crate) fn upload_a(&mut self) -> Packet {
        let entries = self.sa.pending(&identity()).unwrap();
        self.ca.prepare_update([2; 16], &entries[0]).unwrap();
        self.ca.send(&self.relay, [2; 16]).unwrap();
        self.relay
            .fetch(self.cb.scope())
            .unwrap()
            .last()
            .unwrap()
            .clone()
    }
}
