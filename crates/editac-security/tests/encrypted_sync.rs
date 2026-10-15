//! Canonical SEC-1.6: real MLS, Yrs sessions, protected SQLite stores and an
//! opaque durable SQLite relay; only local disposable fixtures, no sockets/API.
#[allow(dead_code)]
#[path = "../src/envelope.rs"]
mod envelope;
#[allow(dead_code)]
#[path = "../src/keys.rs"]
mod keys;
#[allow(dead_code)]
#[path = "../src/store.rs"]
mod store;
#[path = "../src/store_native.rs"]
mod store_native;
mod support;
#[path = "../src/sync.rs"]
mod sync;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    ports::*,
    session::{CachedPermission, RemoteState, Session},
};
use envelope::*;
use keys::*;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use store::*;
use store_native::*;
use support::*;
use sync::*;
use zeroize::Zeroizing;

const SEED: &str = "SEC16_CONFIDENTIAL_INITIAL_20261015";
const A: &str = "SEC16_OFFLINE_ALPHA";
const B: &str = "SEC16_OFFLINE_BRAVO";
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
fn context() -> Context {
    Context {
        document: DOCUMENT,
        document_epoch: 11,
        schema: 3,
        key_epoch: 1,
    }
}
fn key_context() -> KeyContext {
    KeyContext {
        document: DOCUMENT,
        document_epoch: 11,
        key_epoch: 1,
        purpose: KeyPurpose::LocalStore,
    }
}
struct Keys;
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
type Protected = ProtectedStore<SqliteHost, Keys>;
type Client = EncryptedClient<FixtureProvider>;
fn client(seed: u8) -> Client {
    let (p, g) = prepared(seed);
    let writers = [signer(1).to_public_vec(), signer(2).to_public_vec()].into();
    let admission = Admission::fresh_prepared(p, g, context(), writers)
        .ok()
        .unwrap();
    Client::fresh_prepared(admission, signer(seed), identity(), context())
        .ok()
        .unwrap()
}
fn dir(name: &str) -> PathBuf {
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
fn protected(path: &Path, observer: Option<Observer>) -> Arc<Protected> {
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
fn relay(path: &Path, observer: Option<Observer>) -> OpaqueRelay<SqliteHost> {
    OpaqueRelay::new(
        SqliteHost::open(path, observer).unwrap(),
        Scope::prepared(&identity(), &context()),
    )
    .ok()
    .unwrap()
}
fn edit(s: &mut Session<Arc<Protected>>, text: &str) {
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
fn text(s: &Session<Arc<Protected>>) -> String {
    s.document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .flat_map(|n| n.runs.iter().map(|r| r.text.as_str()))
        .collect()
}
fn no_plaintext(dir: &Path) {
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
struct Harness {
    dir: PathBuf,
    relay: OpaqueRelay<SqliteHost>,
    ca: Client,
    cb: Client,
    sa: Arc<Protected>,
    sb: Arc<Protected>,
    a: Session<Arc<Protected>>,
    b: Session<Arc<Protected>>,
}
impl Harness {
    fn new(name: &str) -> Self {
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
    fn upload_a(&mut self) -> Packet {
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
#[test]
fn offline_authorized_sessions_converge_through_ciphertext_only_persistent_relay() {
    let mut h = Harness::new("offline");
    edit(&mut h.a, A);
    edit(&mut h.b, B);
    let pa = h.upload_a();
    h.cb.prepare_update([3; 16], &h.sb.pending(&identity()).unwrap()[0])
        .unwrap();
    h.cb.send(&h.relay, [3; 16]).unwrap();
    let pb = h.relay.fetch(h.ca.scope()).unwrap().last().unwrap().clone();
    h.cb.receive_update(&pa, &mut h.b).unwrap();
    h.ca.receive_update(&pb, &mut h.a).unwrap();
    assert_eq!(text(&h.a), text(&h.b));
    assert!(text(&h.a).contains(SEED));
    assert!(text(&h.a).contains(A));
    assert!(text(&h.a).contains(B));
    assert_eq!(h.a.state(0).remote, RemoteState::Unknown); // ciphertext receipt is not a semantic receipt
    assert!(h.ca.stored([2; 16]));
    assert!(h.cb.stored([3; 16]));
    assert_eq!(h.sa.pending(&identity()).unwrap().len(), 2); // no false DurableV1 pruning
    assert_eq!(h.sb.pending(&identity()).unwrap().len(), 2);
    let a = Session::open(h.sa.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    let b = Session::open(h.sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(text(&a), text(&b));
    let reopened = relay(&h.dir.join("relay.sqlite"), None);
    assert_eq!(reopened.fetch(h.ca.scope()).unwrap().len(), 3);
    no_plaintext(&h.dir);
}
fn changed_scope(scope: &Scope, field: &str, value: serde_json::Value) -> Scope {
    let mut v = serde_json::to_value(scope).unwrap();
    v[field] = value;
    serde_json::from_value(v).unwrap()
}
#[test]
fn profile_version_document_schema_and_epochs_never_downgrade() {
    let h = Harness::new("negotiation");
    for (field, value) in [
        ("profile", serde_json::json!("baseline")),
        ("version", serde_json::json!(0)),
        ("schema", serde_json::json!(4)),
        ("document_epoch", serde_json::json!(12)),
        ("key_epoch", serde_json::json!(2)),
        ("document", serde_json::json!(vec![8; 16])),
    ] {
        let scope = changed_scope(h.ca.scope(), field, value);
        assert_eq!(h.relay.negotiate(&scope), Err(PortError::Incompatible));
        assert!(h.relay.fetch(&scope).is_err());
    }
}
#[test]
fn scope_mismatch_cannot_attach_to_an_authenticated_mls_context() {
    let (p, g) = prepared(1);
    let admission = Admission::fresh_prepared(p, g, context(), writers())
        .ok()
        .unwrap();
    let mut c = context();
    c.schema += 1;
    assert!(matches!(
        Client::fresh_prepared(admission, signer(1), identity(), c),
        Err(Rejection::Context)
    ));
}
#[test]
fn ciphertext_receipt_binds_exact_bytes_and_all_public_scope_fields() {
    let mut h = Harness::new("receipts");
    edit(&mut h.a, A);
    let packet = h.upload_a();
    let receipt = h.ca.send(&h.relay, [2; 16]).unwrap();
    assert_eq!(
        h.ca.accept(&receipt).unwrap(),
        Some(h.sa.pending(&identity()).unwrap()[0].id().clone())
    );
    let mut forged = receipt.clone();
    forged.digest[0] ^= 1;
    assert_eq!(h.ca.accept(&forged), Err(PortError::Integrity));
    let mut forged = receipt;
    forged.scope = changed_scope(&forged.scope, "key_epoch", serde_json::json!(2));
    assert_eq!(h.ca.accept(&forged), Err(PortError::Incompatible));
    let mut changed = packet;
    *changed.ciphertext.last_mut().unwrap() ^= 1;
    let tamper_receipt = h.relay.put(changed).unwrap(); // relay stores opaque bytes, never validates plaintext
    assert_eq!(h.ca.accept(&tamper_receipt), Err(PortError::Integrity));
    assert_eq!(h.sa.pending(&identity()).unwrap().len(), 1);
}
#[test]
fn tamper_and_plaintext_never_apply_and_failed_crypto_retires_endpoint() {
    let mut h = Harness::new("admission");
    edit(&mut h.a, A);
    let p = h.upload_a();
    let before = text(&h.b);
    let mut bad = p.clone();
    *bad.ciphertext.last_mut().unwrap() ^= 1;
    assert!(h.cb.receive_update(&bad, &mut h.b).is_err());
    assert_eq!(text(&h.b), before);
    let mut bad = p.clone();
    bad.ciphertext = SEED.as_bytes().to_vec();
    assert!(h.cb.receive_update(&bad, &mut h.b).is_err());
    assert_eq!(text(&h.b), before);
    assert_eq!(
        h.cb.receive_update(&p, &mut h.b),
        Err(PortError::Permission)
    );
    assert_eq!(text(&h.b), before);
    assert!(h.sb.pending(&identity()).unwrap().is_empty());
    no_plaintext(&h.dir);
}
#[test]
fn authenticated_replay_never_applies_twice() {
    let mut h = Harness::new("replay");
    edit(&mut h.a, A);
    let p = h.upload_a();
    h.cb.receive_update(&p, &mut h.b).unwrap();
    let after = text(&h.b);
    assert!(h.cb.receive_update(&p, &mut h.b).is_err());
    assert_eq!(text(&h.b), after);
    assert_eq!(h.sb.pending(&identity()).unwrap().len(), 1);
    no_plaintext(&h.dir);
}
#[test]
fn wrong_keys_and_cross_document_routing_reject_without_mutation() {
    let mut h = Harness::new("wrong-key");
    edit(&mut h.a, A);
    let p = h.upload_a();
    let mut wrong = client(4);
    assert!(wrong.receive_update(&p, &mut h.b).is_err());
    assert!(!text(&h.b).contains(A));
    let mut cross = p;
    cross.scope = changed_scope(&cross.scope, "document_epoch", serde_json::json!(12));
    assert!(h.cb.receive_update(&cross, &mut h.b).is_err());
    assert!(!text(&h.b).contains(A));
}
#[test]
fn relay_bounds_and_queue_pressure_fail_closed() {
    let h = Harness::new("bounds");
    let mut p = h.relay.fetch(h.ca.scope()).unwrap().remove(0);
    p.ciphertext = vec![0; MAX_ENVELOPE + 1];
    assert!(matches!(
        h.relay.put(p.clone()),
        Err(PortError::ResourceLimit)
    ));
    p.ciphertext.clear();
    assert!(matches!(
        h.relay.put(p.clone()),
        Err(PortError::ResourceLimit)
    ));
    for n in 0..23u8 {
        p.ciphertext = vec![n; 32];
        p.ciphertext[..4].copy_from_slice(&[0, 1, 0, 2]);
        h.relay.put(p.clone()).unwrap();
    }
    p.ciphertext = vec![99; 32];
    p.ciphertext[..4].copy_from_slice(&[0, 1, 0, 2]);
    assert!(matches!(h.relay.put(p), Err(PortError::Backpressure)));
    assert_eq!(h.relay.fetch(h.ca.scope()).unwrap().len(), 24);
    no_plaintext(&h.dir);
}
#[test]
fn durable_relay_failures_never_acknowledge_and_retry_reuses_exact_ciphertext() {
    for boundary in [
        Boundary::BeforeWrite,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let mut h = Harness::new("relay-failure");
        edit(&mut h.a, A);
        h.ca.prepare_update([2; 16], &h.sa.pending(&identity()).unwrap()[0])
            .unwrap();
        let broken = relay(
            &h.dir.join("relay.sqlite"),
            Some(Arc::new(move |at| {
                if at == boundary {
                    Err(PortError::CommitUnknown)
                } else {
                    Ok(())
                }
            })),
        );
        assert!(h.ca.send(&broken, [2; 16]).is_err());
        assert!(!h.ca.stored([2; 16]));
        drop(broken);
        let restored = relay(&h.dir.join("relay.sqlite"), None);
        let count = restored.fetch(h.ca.scope()).unwrap().len();
        assert_eq!(
            count,
            if boundary == Boundary::AfterCommit {
                2
            } else {
                1
            }
        );
        h.ca.send(&restored, [2; 16]).unwrap();
        h.ca.send(&restored, [2; 16]).unwrap();
        assert!(h.ca.stored([2; 16]));
        assert_eq!(restored.fetch(h.ca.scope()).unwrap().len(), 2);
        no_plaintext(&h.dir);
    }
}
#[test]
fn restored_sender_cannot_send_or_reencrypt_pending_work() {
    let mut h = Harness::new("restore-lock");
    edit(&mut h.a, A);
    let entry = h.sa.pending(&identity()).unwrap().remove(0);
    h.ca.prepare_update([2; 16], &entry).unwrap();
    h.ca.retire_after_restore();
    assert_eq!(h.ca.prepare_update([3; 16], &entry), Err(Rejection::Locked));
    assert!(matches!(
        h.ca.send(&h.relay, [2; 16]),
        Err(PortError::Permission)
    ));
    assert_eq!(h.sa.pending(&identity()).unwrap(), [entry]);
    assert_eq!(h.relay.fetch(h.cb.scope()).unwrap().len(), 1);
    no_plaintext(&h.dir);
}
#[test]
fn read_only_mls_member_cannot_seal_an_update_even_with_local_plaintext() {
    let mut h = Harness::new("reader");
    edit(&mut h.a, A);
    let entry = h.sa.pending(&identity()).unwrap().remove(0);
    let mut reader = client(3);
    assert_eq!(
        reader.prepare_update([9; 16], &entry),
        Err(Rejection::Unauthorized)
    );
    assert_eq!(h.relay.fetch(h.cb.scope()).unwrap().len(), 1);
}
#[test]
fn authenticated_invalid_engine_updates_never_mutate_or_persist_plaintext() {
    let mut h = Harness::new("invalid-yjs");
    let entry = JournalEntry::new(
        identity(),
        14,
        1,
        "security:invalid".into(),
        b"not a Yjs update".to_vec(),
    )
    .unwrap();
    h.ca.prepare_update([2; 16], &entry).unwrap();
    h.ca.send(&h.relay, [2; 16]).unwrap();
    let p = h.relay.fetch(h.cb.scope()).unwrap().pop().unwrap();
    let before = text(&h.b);
    assert!(h.cb.receive_update(&p, &mut h.b).is_err());
    assert_eq!(text(&h.b), before);
    assert!(h.sb.pending(&identity()).unwrap().is_empty());
    no_plaintext(&h.dir);
}
#[test]
fn protected_receiver_append_failure_retains_authenticated_work_for_retry() {
    let mut h = Harness::new("receiver-failure");
    edit(&mut h.a, A);
    let p = h.upload_a();
    let fail = Arc::new(AtomicBool::new(false));
    let flag = fail.clone();
    let sb = protected(
        &h.dir.join("b.sqlite"),
        Some(Arc::new(move |at| {
            if at == Boundary::BeforeCommit && flag.load(Ordering::SeqCst) {
                Err(PortError::Quota)
            } else {
                Ok(())
            }
        })),
    );
    let mut b = Session::open(sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    let before = text(&b);
    fail.store(true, Ordering::SeqCst);
    assert!(h.cb.receive_update(&p, &mut b).is_err());
    assert_eq!(text(&b), before);
    assert!(sb.pending(&identity()).unwrap().is_empty());
    fail.store(false, Ordering::SeqCst);
    b.recover().unwrap();
    h.cb.receive_update(&p, &mut b).unwrap();
    assert!(text(&b).contains(A));
    assert_eq!(sb.pending(&identity()).unwrap().len(), 1);
    no_plaintext(&h.dir);
}
#[test]
fn remote_checkpoint_cannot_replace_existing_session() {
    let mut h = Harness::new("checkpoint-conflict");
    let p = h.relay.fetch(h.cb.scope()).unwrap().remove(0);
    assert_eq!(h.cb.bootstrap(&p, &*h.sb), Err(PortError::Conflict));
    assert_eq!(text(&h.a), text(&h.b));
}

#[test]
fn aggregate_ciphertext_budget_rejects_before_publication() {
    let h = Harness::new("byte-budget");
    let mut p = h.relay.fetch(h.ca.scope()).unwrap().remove(0);
    let mut accepted = 0;
    for n in 1..24u8 {
        p.ciphertext = vec![255; MAX_ENVELOPE];
        p.ciphertext[..4].copy_from_slice(&[0, 1, 0, 2]);
        p.ciphertext[4] = n;
        match h.relay.put(p.clone()) {
            Ok(_) => accepted += 1,
            Err(PortError::Backpressure) => break,
            _ => panic!("unexpected bounded relay result"),
        }
    }
    assert!(accepted > 0 && accepted < 23);
    assert_eq!(h.relay.fetch(h.ca.scope()).unwrap().len(), accepted + 1);
    no_plaintext(&h.dir);
}

#[test]
fn authenticated_corrupt_checkpoint_cannot_publish_initial_state() {
    let path = dir("invalid-checkpoint");
    let sa = protected(&path.join("a.sqlite"), None);
    let mut ca = client(1);
    let mut cb = client(2);
    let r = relay(&path.join("relay.sqlite"), None);
    let point = editac_core::document::InitializedCheckpoint {
        identity: identity(),
        initialized: true,
        writer_id: 11,
        bytes: b"not a Yjs checkpoint".to_vec(),
    };
    ca.prepare_checkpoint([1; 16], &point).unwrap();
    ca.send(&r, [1; 16]).unwrap();
    let p = r.fetch(cb.scope()).unwrap().remove(0);
    assert_eq!(cb.bootstrap(&p, &*sa), Err(PortError::Integrity));
    assert_eq!(sa.generation(&identity()).unwrap(), 0);
    assert!(sa.pending(&identity()).unwrap().is_empty());
    no_plaintext(&path);
}

#[test]
fn failed_profile_negotiation_never_invokes_ciphertext_send() {
    struct Incompatible;
    impl CiphertextTransport for Incompatible {
        fn negotiate(&self, _: &Scope) -> Result<(), PortError> {
            Err(PortError::Incompatible)
        }
        fn put(&self, _: Packet) -> Result<CiphertextReceipt, PortError> {
            panic!("sent after incompatible negotiation")
        }
        fn fetch(&self, _: &Scope) -> Result<Vec<Packet>, PortError> {
            panic!("fetched incompatible peer")
        }
    }
    let mut h = Harness::new("no-downgrade");
    edit(&mut h.a, A);
    let entry = h.sa.pending(&identity()).unwrap().remove(0);
    h.ca.prepare_update([2; 16], &entry).unwrap();
    assert!(matches!(
        h.ca.send(&Incompatible, [2; 16]),
        Err(PortError::Incompatible)
    ));
    assert!(!h.ca.stored([2; 16]));
    assert_eq!(h.sa.pending(&identity()).unwrap(), [entry]);
    no_plaintext(&h.dir);
}
