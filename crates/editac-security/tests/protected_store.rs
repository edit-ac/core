//! SEC-1.5 canonical integration: actual LocalStore, Yrs engine, age files,
//! scoped host keys, SQLite WAL and abrupt child-process termination.
#[allow(dead_code)]
#[path = "../src/keys.rs"]
mod keys;
#[path = "../src/store.rs"]
mod store;
#[path = "../src/store_native.rs"]
mod store_native;

use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{CreationPermit, Document, DocumentIdentity, InitialNode, ReplayUpdate},
};
use editac_session::ports::*;
use editac_session::session::{CachedPermission, LocalState, Readiness, Session, SessionStore};
use keys::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use store::*;
use store_native::*;
use zeroize::Zeroizing;

const SEED: &str = "SEC15_PRIVATE_SEEDED_CONTENT_983421";
const TAIL: &str = " protected offline tail";
const KEY: [u8; 32] = [0x53; 32];
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
fn context() -> KeyContext {
    KeyContext {
        document: [0x15; 16],
        document_epoch: 1,
        key_epoch: 2,
        purpose: KeyPurpose::LocalStore,
    }
}
struct Access {
    key: [u8; 32],
    access: Result<(), KeyFailure>,
    acquisitions: usize,
    deny_at: Option<usize>,
}
#[derive(Clone)]
struct PreparedKeys(Arc<Mutex<Access>>);
impl PreparedKeys {
    fn ready() -> Self {
        Self(Arc::new(Mutex::new(Access {
            key: KEY,
            access: Ok(()),
            acquisitions: 0,
            deny_at: None,
        })))
    }
}
impl HostKeyProvider for PreparedKeys {
    fn acquire(&mut self, c: KeyContext) -> Result<DecodedKey, KeyFailure> {
        let mut access = self.0.lock().unwrap();
        access.acquisitions += 1;
        access.access?;
        if access.deny_at == Some(access.acquisitions) {
            return Err(KeyFailure::Revoked);
        }
        if c != context() {
            return Err(KeyFailure::Context);
        }
        Ok(DecodedKey::from_host(c, Zeroizing::new(access.key)))
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Unavailable)
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Unavailable)
    }
    fn wrap(&mut self, _: KeyContext, _: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn unwrap(&mut self, _: KeyContext, _: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
}
type Protected = ProtectedStore<SqliteHost, PreparedKeys>;
fn db(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::var_os("SEC15_ARTIFACT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("editac-sec15"));
    let dir = root.join(format!(
        "{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir.join("store.sqlite")
}
fn endpoint(path: &Path, keys: PreparedKeys, observer: Option<Observer>) -> Protected {
    ProtectedStore::new(
        identity(),
        context(),
        StoreLimits::default(),
        SqliteHost::open(path, observer).unwrap(),
        keys,
    )
    .ok()
    .unwrap()
}
fn initial() -> CheckpointRecord {
    static INITIAL: std::sync::OnceLock<CheckpointRecord> = std::sync::OnceLock::new();
    INITIAL
        .get_or_init(|| {
            let document = Document::create(
                CreationPermit::authorize_new(identity()).unwrap(),
                &[InitialNode {
                    kind: "block".into(),
                    text: SEED.into(),
                }],
            )
            .unwrap();
            CheckpointRecord::new(document.checkpoint(), vec![]).unwrap()
        })
        .clone()
}
fn boot(store: &impl LocalStore) {
    let result = store.publish(0, initial()).unwrap();
    assert_eq!(result.generation, 1);
    assert_eq!(result.durability, Durability::ProcessCrash);
}
fn restored(store: &impl LocalStore) -> Document {
    let recovery = store.recover(&identity()).unwrap();
    let tail = recovery
        .journal
        .iter()
        .map(|e| ReplayUpdate {
            identity: e.id().identity.clone(),
            bytes: e.bytes().to_vec(),
        })
        .collect::<Vec<_>>();
    Document::restore(&identity(), recovery.checkpoint.checkpoint(), &tail).unwrap()
}
fn text(document: &Document) -> String {
    document
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .flat_map(|n| n.runs.iter().map(|r| r.text.clone()))
        .collect()
}
fn edit(store: &impl LocalStore) -> (JournalEntry, CheckpointRecord) {
    let mut document = restored(store);
    let block = document
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let at = document
        .anchor(&block, Utf16Offset(0), Bias::Right)
        .unwrap();
    let prepared = document
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: TAIL.into(),
            },
            &TextOrigin::new("security:fixture").unwrap(),
        )
        .unwrap();
    document.commit_text(prepared).unwrap();
    let entry = JournalEntry::new(
        identity(),
        document.writer_id(),
        1,
        "security:fixture".into(),
        document
            .last_patch()
            .unwrap()
            .update
            .as_ref()
            .unwrap()
            .bytes
            .clone(),
    )
    .unwrap();
    let mut coverage = store
        .recover(&identity())
        .unwrap()
        .journal
        .iter()
        .map(|e| e.id().clone())
        .collect::<Vec<_>>();
    coverage.push(entry.id().clone());
    (
        entry,
        CheckpointRecord::new(document.checkpoint(), coverage).unwrap(),
    )
}
fn no_plaintext(path: &Path) {
    for entry in fs::read_dir(path.parent().unwrap()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let bytes = fs::read(path).unwrap();
            assert!(!bytes.windows(SEED.len()).any(|w| w == SEED.as_bytes()));
            assert!(!bytes.windows(TAIL.len()).any(|w| w == TAIL.as_bytes()));
            assert!(!bytes.windows(KEY.len()).any(|w| w == KEY));
        }
    }
}
fn receipt(entry: &JournalEntry) -> DurableReceipt {
    DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: entry.id().clone(),
    }
}

fn session_store(path: &Path, id: &DocumentIdentity, observer: Option<Observer>) -> Arc<Protected> {
    Arc::new(
        ProtectedStore::new(
            id.clone(),
            context(),
            StoreLimits::default(),
            SqliteHost::open(path, observer).unwrap(),
            PreparedKeys::ready(),
        )
        .ok()
        .unwrap(),
    )
}
fn session_identity(n: u8) -> DocumentIdentity {
    DocumentIdentity::v5(
        format!("12345678-1234-4234-8234-{n:012x}"),
        identity().epoch,
    )
    .unwrap()
}
fn session_edit(
    session: &mut Session<Arc<Protected>>,
) -> Result<Option<LocalCommit>, editac_session::session::SessionError> {
    let block = session
        .document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let at = session
        .document()
        .anchor(&block, Utf16Offset(0), Bias::Right)
        .unwrap();
    session.edit_text(
        &TextCommand::Insert {
            at,
            text: TAIL.into(),
        },
        &TextOrigin::new("security:session").unwrap(),
        0,
    )
}

#[test]
fn actual_session_creation_edit_reopen_and_writer_reservations_use_protected_store() {
    let path = db("real-session");
    let id = session_identity(21);
    let store = session_store(&path, &id, None);
    let mut session = Session::create_local(
        store.clone(),
        id.clone(),
        &[InitialNode {
            kind: "block".into(),
            text: SEED.into(),
        }],
    )
    .unwrap();
    assert_eq!(
        session.state(0).local,
        LocalState::Initialized(Durability::ProcessCrash)
    );
    let writer = session.document().writer_id();
    assert_eq!(store.claim_writer(writer).unwrap_err(), PortError::Conflict);
    assert_eq!(
        session_edit(&mut session).unwrap().unwrap().durability,
        Durability::ProcessCrash
    );
    assert_eq!(session.state(0).pending_upload, 1);
    no_plaintext(&path);
    drop(session);
    drop(store);
    let store = session_store(&path, &id, None);
    assert_eq!(store.claim_writer(writer).unwrap_err(), PortError::Conflict);
    let reopened = Session::open(store, &id, CachedPermission::LOCAL).unwrap();
    assert_ne!(reopened.document().writer_id(), writer);
    assert_eq!(reopened.state(0).readiness, Readiness::Ready);
    assert_eq!(reopened.state(0).pending_upload, 1);
    assert!(text(reopened.document()) == format!("{TAIL}{SEED}"));
    no_plaintext(&path);
}

#[test]
fn actual_session_creation_and_edit_failures_stay_unsaved_until_protected_recovery() {
    // Session creation reserves its writer before checkpoint publication. The
    // second transaction is creation; the third is its first edit journal.
    for failing_transaction in [2, 3] {
        let path = db("real-session-failure");
        let id = session_identity(21 + failing_transaction as u8);
        let transactions = Arc::new(AtomicU64::new(0));
        let counter = transactions.clone();
        let observer: Observer = Arc::new(move |at| {
            if at == Boundary::BeforeCommit
                && counter.fetch_add(1, Ordering::Relaxed) + 1 == failing_transaction
            {
                return Err(PortError::Quota);
            }
            Ok(())
        });
        let store = session_store(&path, &id, Some(observer));
        let mut session = Session::create_local(
            store.clone(),
            id.clone(),
            &[InitialNode {
                kind: "block".into(),
                text: SEED.into(),
            }],
        )
        .unwrap();
        if failing_transaction == 2 {
            assert_eq!(store.generation(&id).unwrap(), 0);
            assert!(store.recover(&id).is_err());
        } else {
            assert!(session_edit(&mut session).is_err());
            assert!(store.pending(&id).unwrap().is_empty());
        }
        assert_eq!(session.state(0).readiness, Readiness::RecoveryRequired);
        assert_eq!(session.state(0).local, LocalState::Unsaved);
        no_plaintext(&path);
        session.recover().unwrap();
        assert_eq!(session.state(0).readiness, Readiness::Ready);
        let expected = if failing_transaction == 2 {
            SEED.to_owned()
        } else {
            format!("{TAIL}{SEED}")
        };
        assert!(text(session.document()) == expected);
        drop(session);
        drop(store);
        let reopened = Session::open(
            session_store(&path, &id, None),
            &id,
            CachedPermission::LOCAL,
        )
        .unwrap();
        assert!(text(reopened.document()) == expected);
        no_plaintext(&path);
    }
}

#[test]
fn sec_f_create_first_is_protected_before_any_sink() {
    let path = db("create");
    let store = endpoint(&path, PreparedKeys::ready(), None);
    boot(&store);
    assert!(text(&restored(&store)) == SEED);
    no_plaintext(&path);
}

#[test]
fn journal_checkpoint_outbox_and_receipts_survive_reopen() {
    let path = db("lifecycle");
    let store = endpoint(&path, PreparedKeys::ready(), None);
    boot(&store);
    let (entry, point) = edit(&store);
    assert_eq!(
        store.append(entry.clone()).unwrap().durability,
        Durability::ProcessCrash
    );
    store.publish(1, point).unwrap();
    assert_eq!(store.pending(&identity()).unwrap(), vec![entry.clone()]);
    no_plaintext(&path);
    assert_eq!(
        store
            .accept_receipt(ReceiptCapability::Unknown, receipt(&entry))
            .unwrap(),
        ReceiptResult::CapabilityUnavailable
    );
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
    assert_eq!(
        store
            .accept_receipt(ReceiptCapability::DurableV1, receipt(&entry))
            .unwrap(),
        ReceiptResult::RemoteCommitted
    );
    drop(store);
    let store = endpoint(&path, PreparedKeys::ready(), None);
    let recovery = store.recover(&identity()).unwrap();
    assert_eq!(recovery.generation, 2);
    assert!(recovery.fallback.is_some());
    assert!(recovery.pending.is_empty());
    assert_eq!(recovery.journal.len(), 1);
    assert!(text(&restored(&store)) == format!("{TAIL}{SEED}"));
    no_plaintext(&path);
}

#[test]
fn sec_f_create_failure_never_falls_back_to_plaintext() {
    for boundary in [Boundary::BeforeWrite, Boundary::BeforeCommit] {
        let path = db("creation-failure");
        let observer: Observer = Arc::new(move |at| {
            if at == boundary {
                Err(PortError::Quota)
            } else {
                Ok(())
            }
        });
        let store = endpoint(&path, PreparedKeys::ready(), Some(observer));
        assert_eq!(store.publish(0, initial()).unwrap_err(), PortError::Quota);
        assert_eq!(
            SqliteHost::open(&path, None)
                .unwrap()
                .read(MAX_BLOB)
                .ok()
                .unwrap()
                .map(|b| b.revision),
            None
        );
        assert_eq!(store.generation(&identity()).unwrap(), 0);
        no_plaintext(&path);
    }
}

#[test]
fn unavailable_locked_revoked_or_lost_key_cannot_create_or_read() {
    for failure in [
        KeyFailure::Locked,
        KeyFailure::Unavailable,
        KeyFailure::Revoked,
        KeyFailure::RecoveryRequired,
    ] {
        let path = db("key-absent");
        let keys = PreparedKeys::ready();
        keys.0.lock().unwrap().access = Err(failure);
        let store = endpoint(&path, keys.clone(), None);
        assert_eq!(
            store.publish(0, initial()).unwrap_err(),
            PortError::Permission
        );
        assert_eq!(
            store.generation(&identity()).unwrap_err(),
            PortError::Permission
        );
        keys.0.lock().unwrap().access = Ok(());
        boot(&store);
        keys.0.lock().unwrap().access = Err(failure);
        assert_eq!(
            store.recover(&identity()).unwrap_err(),
            PortError::Permission
        );
        assert_eq!(
            store.pending(&identity()).unwrap_err(),
            PortError::Permission
        );
        no_plaintext(&path);
    }
}

#[test]
fn authorization_is_rechecked_between_prepare_and_seal() {
    let path = db("revoked-during-write");
    let keys = PreparedKeys::ready();
    keys.0.lock().unwrap().deny_at = Some(2);
    let store = endpoint(&path, keys, None);
    assert_eq!(
        store.publish(0, initial()).unwrap_err(),
        PortError::Permission
    );
    assert!(
        SqliteHost::open(&path, None)
            .unwrap()
            .read(MAX_BLOB)
            .ok()
            .unwrap()
            .is_none()
    );
    no_plaintext(&path);
}

#[test]
fn wrong_key_and_tampered_or_truncated_age_files_reject_without_repair() {
    let path = db("tamper");
    let keys = PreparedKeys::ready();
    let store = endpoint(&path, keys.clone(), None);
    boot(&store);
    keys.0.lock().unwrap().key = [9; 32];
    assert_eq!(
        store.recover(&identity()).unwrap_err(),
        PortError::Integrity
    );
    keys.0.lock().unwrap().key = KEY;
    let host = SqliteHost::open(&path, None).unwrap();
    let original = host.read(MAX_BLOB).unwrap().unwrap().ciphertext;
    for mode in 0..3 {
        let mut damaged = original.clone();
        match mode {
            0 => {
                let n = damaged.len();
                damaged[n - 1] ^= 1;
            }
            1 => {
                damaged.truncate(damaged.len() - 1);
            }
            _ => {
                damaged[0] ^= 1;
            }
        }
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute("UPDATE protected_blob SET ciphertext=?1", [damaged.clone()])
            .unwrap();
        assert_eq!(
            store.recover(&identity()).unwrap_err(),
            PortError::Integrity
        );
        assert_eq!(host.read(MAX_BLOB).unwrap().unwrap().ciphertext, damaged);
    }
    no_plaintext(&path);
}

#[test]
fn cross_document_schema_epoch_key_epoch_and_revision_are_bound() {
    let path = db("context");
    let store = endpoint(&path, PreparedKeys::ready(), None);
    boot(&store);
    for field in 0..6 {
        let mut id = identity();
        let mut c = context();
        match field {
            0 => id.document_id = "34567890-3456-4456-8456-34567890abcd".into(),
            1 => id.epoch = "34567890-3456-4456-8456-34567890abcd".into(),
            2 => id.schema.push_str(":other"),
            3 => c.document_epoch += 1,
            4 => c.key_epoch += 1,
            _ => c.document[0] ^= 1,
        }
        // A permissive prepared key provider would still not bypass ciphertext binding.
        let host = SqliteHost::open(&path, None).unwrap();
        let other =
            ProtectedStore::new(id.clone(), c, StoreLimits::default(), host, PermissiveKeys).ok();
        if let Some(other) = other {
            assert!(other.recover(&id).is_err());
        }
    }
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute("UPDATE protected_blob SET revision=revision+1", [])
        .unwrap();
    assert_eq!(
        store.recover(&identity()).unwrap_err(),
        PortError::Integrity
    );
}
struct PermissiveKeys;
impl HostKeyProvider for PermissiveKeys {
    fn acquire(&mut self, c: KeyContext) -> Result<DecodedKey, KeyFailure> {
        Ok(DecodedKey::from_host(c, Zeroizing::new(KEY)))
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Unavailable)
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Unavailable)
    }
    fn wrap(&mut self, _: KeyContext, _: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn unwrap(&mut self, _: KeyContext, _: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
}

#[test]
fn stale_checkpoint_and_competing_ciphertext_cas_cannot_acknowledge() {
    let path = db("cas");
    let store = endpoint(&path, PreparedKeys::ready(), None);
    boot(&store);
    assert_eq!(
        store.publish(0, initial()).unwrap_err(),
        PortError::Conflict
    );
    let a = SqliteHost::open(&path, None).unwrap();
    let b = SqliteHost::open(&path, None).unwrap();
    let old = a.read(MAX_BLOB).unwrap().unwrap();
    let candidate = || Blob {
        revision: old.revision + 1,
        ciphertext: old.ciphertext.clone(),
    };
    a.compare_exchange(Some(old.revision), candidate()).unwrap();
    assert_eq!(
        b.compare_exchange(Some(old.revision), candidate())
            .unwrap_err(),
        PortError::Conflict
    );
    assert_eq!(
        b.compare_exchange(
            None,
            Blob {
                revision: 1,
                ciphertext: vec![1]
            }
        )
        .unwrap_err(),
        PortError::Conflict
    );
}

#[test]
fn bounded_input_and_non_durable_hosts_are_not_qualified() {
    let path = db("limit");
    let host = SqliteHost::open(&path, None).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO protected_blob VALUES(1,1,zeroblob(?1))",
            [(MAX_BLOB + 1) as i64],
        )
        .unwrap();
    assert_eq!(host.read(MAX_BLOB).err(), Some(PortError::ResourceLimit));
    let store = endpoint(&path, PreparedKeys::ready(), None);
    assert_eq!(
        store.recover(&identity()).unwrap_err(),
        PortError::ResourceLimit
    );
    struct Volatile;
    impl BlobHost for Volatile {
        fn capabilities(&self) -> StoreCapabilities {
            StoreCapabilities {
                durability: Durability::Volatile,
                atomic_transactions: true,
                serialized_writers: true,
            }
        }
        fn read(&self, _: usize) -> Result<Option<Blob>, PortError> {
            panic!("must reject before use")
        }
        fn compare_exchange(&self, _: Option<u64>, _: Blob) -> Result<(), PortError> {
            panic!("must reject before use")
        }
    }
    assert!(matches!(
        ProtectedStore::new(
            identity(),
            context(),
            StoreLimits::default(),
            Volatile,
            PreparedKeys::ready()
        ),
        Err(PortError::Incompatible)
    ));
}

#[test]
fn failed_update_preserves_acknowledged_checkpoint_and_pending_work() {
    let path = db("update-failure");
    let store = endpoint(&path, PreparedKeys::ready(), None);
    boot(&store);
    let (entry, point) = edit(&store);
    store.append(entry.clone()).unwrap();
    drop(store);
    let observer: Observer = Arc::new(|at| {
        if at == Boundary::BeforeCommit {
            Err(PortError::Quota)
        } else {
            Ok(())
        }
    });
    let store = endpoint(&path, PreparedKeys::ready(), Some(observer));
    assert_eq!(store.publish(1, point).unwrap_err(), PortError::Quota);
    drop(store);
    let store = endpoint(&path, PreparedKeys::ready(), None);
    assert_eq!(store.generation(&identity()).unwrap(), 1);
    assert_eq!(store.pending(&identity()).unwrap(), vec![entry]);
    assert!(text(&restored(&store)) == format!("{TAIL}{SEED}"));
    no_plaintext(&path);
}

#[test]
fn lost_postcommit_ack_is_explicit_and_recovers_protected_state() {
    let path = db("ack-unknown");
    let observer: Observer = Arc::new(|at| {
        if at == Boundary::AfterCommit {
            Err(PortError::Unavailable)
        } else {
            Ok(())
        }
    });
    let store = endpoint(&path, PreparedKeys::ready(), Some(observer));
    assert_eq!(
        store.publish(0, initial()).unwrap_err(),
        PortError::CommitUnknown
    );
    drop(store);
    let store = endpoint(&path, PreparedKeys::ready(), None);
    assert_eq!(store.generation(&identity()).unwrap(), 1);
    assert!(text(&restored(&store)) == SEED);
    no_plaintext(&path);
}

#[test]
fn sec_f_commit_crash_before_and_after_sqlite_commit_preserves_acknowledged_state() {
    for mode in ["before-write", "before-commit", "after-commit"] {
        let path = db(mode);
        let store = endpoint(&path, PreparedKeys::ready(), None);
        boot(&store);
        let (acknowledged, _) = edit(&store);
        store.append(acknowledged).unwrap();
        drop(store);
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_probe", "--nocapture"])
            .env("SEC15_CRASH_MODE", mode)
            .env("SEC15_CRASH_DB", &path)
            .output()
            .unwrap();
        fs::write(path.parent().unwrap().join("child.stdout"), &output.stdout).unwrap();
        fs::write(path.parent().unwrap().join("child.stderr"), &output.stderr).unwrap();
        assert_eq!(output.status.code(), Some(79));
        let store = endpoint(&path, PreparedKeys::ready(), None);
        let recovery = store.recover(&identity()).unwrap();
        assert_eq!(recovery.generation, 1);
        if mode == "after-commit" {
            assert_eq!(recovery.pending.len(), 2);
            assert!(text(&restored(&store)) == format!("{TAIL}{TAIL}{SEED}"));
        } else {
            assert_eq!(recovery.pending.len(), 1);
            assert!(text(&restored(&store)) == format!("{TAIL}{SEED}"));
        }
        no_plaintext(&path);
    }
}

/// Subprocess entry only; a parent run without the explicit fixture environment
/// performs no scenario. Count separately from the substantive integration cases.
#[test]
fn crash_probe() {
    let Ok(mode) = std::env::var("SEC15_CRASH_MODE") else {
        return;
    };
    let path = PathBuf::from(std::env::var_os("SEC15_CRASH_DB").unwrap());
    let boundary = match mode.as_str() {
        "before-write" => Boundary::BeforeWrite,
        "before-commit" => Boundary::BeforeCommit,
        "after-commit" => Boundary::AfterCommit,
        _ => panic!("unknown fixture"),
    };
    let observer: Observer = Arc::new(move |at| {
        if at == boundary {
            std::process::exit(79);
        }
        Ok(())
    });
    let store = endpoint(&path, PreparedKeys::ready(), Some(observer));
    let (entry, _) = edit(&store);
    store.append(entry).unwrap();
    panic!("crash boundary not executed");
}
