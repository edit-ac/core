#[path = "support/store_conformance.rs"]
mod conformance;
mod support;
use conformance::*;
use editac_core::document::DocumentIdentity;
use editac_session::{
    ports::{memory::*, *},
    store::*,
};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use support::*;

struct Probe(Child);
impl std::ops::Deref for Probe {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for Probe {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

struct Fixture {
    store: NativeStore,
    directory: PathBuf,
}
impl Fixture {
    fn new(limits: StoreLimits) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = std::env::var_os("EDITAC_NATIVE_STORE_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("editac-native-store-tests"));
        let directory = root.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let store = NativeStore::create_new(directory.join("document.sqlite3"), identity(), limits)
            .unwrap();
        Self { store, directory }
    }
    fn reopen(&self) -> NativeStore {
        NativeStore::open_existing(self.store.path(), identity(), StoreLimits::default()).unwrap()
    }
    fn boot(&self) {
        boot(&self.store);
    }
    fn child(&self, mode: &str, signal: &std::path::Path, go: Option<&std::path::Path>) -> Probe {
        let log = std::fs::File::create(self.directory.join(format!(
            "{mode}-{}.log",
            signal.file_name().unwrap().to_string_lossy()
        )))
        .unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_editac-native-store-probe"));
        command.arg(self.store.path()).arg(mode).arg(signal);
        if let Some(go) = go {
            command.arg(go);
        }
        Probe(
            command
                .stdin(Stdio::null())
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_STORE_EVIDENCE").is_none() {
            // Unix can unlink open handles; persisted evidence is retained when explicitly requested.
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
// Shared prepared fixtures use the same policy and real native transactions. Their generated
// replica IDs are reserved once; direct native tests separately enforce collisions/admission.
impl LocalStore for Fixture {
    fn capabilities(&self) -> StoreCapabilities {
        self.store.capabilities()
    }
    fn append(&self, e: JournalEntry) -> Result<LocalCommit, PortError> {
        if e.id().sequence == 1 {
            match self.store.claim_writer(e.id().writer) {
                Ok(()) | Err(PortError::Conflict) => (),
                Err(err) => return Err(err),
            }
        }
        self.store.append(e)
    }
    fn generation(&self, i: &DocumentIdentity) -> Result<u64, PortError> {
        self.store.generation(i)
    }
    fn publish(&self, g: u64, c: CheckpointRecord) -> Result<PublicationCommit, PortError> {
        self.store.publish(g, c)
    }
    fn recover(&self, i: &DocumentIdentity) -> Result<Recovery, PortError> {
        self.store.recover(i)
    }
    fn pending(&self, i: &DocumentIdentity) -> Result<Vec<JournalEntry>, PortError> {
        self.store.pending(i)
    }
    fn accept_receipt(
        &self,
        n: ReceiptCapability,
        r: DurableReceipt,
    ) -> Result<ReceiptResult, PortError> {
        self.store.accept_receipt(n, r)
    }
}
macro_rules! shared {($($name:ident),*)=>{$(#[test] fn $name(){conformance::$name(Fixture::new(StoreLimits::default()));})*}}
shared!(
    initialized_empty,
    owned_updates,
    journal_identity_and_sequence,
    two_writers,
    checkpoint_retains_outbox,
    semantic_fallback_available,
    stale_and_uncommitted_coverage,
    exact_receipts,
    serialized_cas
);
#[test]
fn bounded_records() {
    conformance::bounded_records(Fixture::new(StoreLimits {
        max_records: 1,
        ..StoreLimits::default()
    }));
}
#[test]
fn explicit_path_scope_version_and_wal_configuration() {
    assert!(matches!(
        NativeStore::create_new("relative", identity(), StoreLimits::default()),
        Err(PortError::InvalidRecord)
    ));
    let fixture = Fixture::new(StoreLimits::default());
    assert!(fixture.store.path().is_absolute());
    assert!(matches!(
        NativeStore::create_new(fixture.store.path(), identity(), StoreLimits::default()),
        Err(PortError::Conflict)
    ));
    assert!(matches!(
        NativeStore::open_existing(
            fixture.directory.join("absent.sqlite3"),
            identity(),
            StoreLimits::default()
        ),
        Err(PortError::Unavailable)
    ));
    assert!(!fixture.directory.join("absent.sqlite3").exists());
    let mut wrong = identity();
    wrong.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    assert!(matches!(
        NativeStore::open_existing(fixture.store.path(), wrong, StoreLimits::default()),
        Err(PortError::Incompatible)
    ));
    let sql = rusqlite::Connection::open(fixture.store.path()).unwrap();
    assert_eq!(
        sql.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    sql.pragma_update(None, "user_version", 2).unwrap();
    assert!(matches!(
        NativeStore::open_existing(fixture.store.path(), identity(), StoreLimits::default()),
        Err(PortError::Incompatible)
    ));
    assert_eq!(
        sql.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        2
    );
    println!(
        "SQLite {} native WAL path {:?}",
        rusqlite::version(),
        fixture.store.path()
    );
}
#[test]
fn unreserved_and_reused_writers_reject_across_reopen() {
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let e = update();
    assert_eq!(f.store.claim_writer(0), Err(PortError::InvalidRecord));
    assert_eq!(f.store.append(e.clone()), Err(PortError::Permission));
    f.store.claim_writer(e.id().writer).unwrap();
    f.store.append(e.clone()).unwrap();
    assert_eq!(
        f.reopen().claim_writer(e.id().writer),
        Err(PortError::Conflict)
    );
    assert_eq!(f.reopen().append(e.clone()).unwrap().update, *e.id());
    assert_eq!(f.reopen().pending(&identity()).unwrap(), vec![e]);
}
#[test]
fn journal_native_failure_boundaries_and_unknown_retry() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let f = Fixture::new(StoreLimits::default());
        f.boot();
        let e = update();
        f.store.claim_writer(e.id().writer).unwrap();
        f.store
            .inject_once(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        let expected = if boundary == FaultBoundary::AfterCommit {
            PortError::CommitUnknown
        } else {
            PortError::Quota
        };
        assert_eq!(f.store.append(e.clone()), Err(expected));
        let pending = f.reopen().pending(&identity()).unwrap();
        assert_eq!(
            pending.len(),
            usize::from(boundary == FaultBoundary::AfterCommit)
        );
        f.reopen().append(e.clone()).unwrap();
        assert_eq!(f.reopen().pending(&identity()).unwrap(), vec![e]);
        assert_eq!(text(&restore(&f.store)), "port 😀");
    }
}
#[test]
fn checkpoint_native_failure_boundaries_keep_coverage_and_generation_atomic() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let f = Fixture::new(StoreLimits::default());
        f.boot();
        let e = update();
        f.append(e.clone()).unwrap();
        let point =
            CheckpointRecord::new(restore(&f.store).checkpoint(), vec![e.id().clone()]).unwrap();
        f.store
            .inject_once(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        let expected = if boundary == FaultBoundary::AfterCommit {
            PortError::CommitUnknown
        } else {
            PortError::Quota
        };
        assert_eq!(f.store.publish(1, point), Err(expected));
        let recovered = f.reopen().recover(&identity()).unwrap();
        assert_eq!(
            recovered.generation,
            if boundary == FaultBoundary::AfterCommit {
                2
            } else {
                1
            }
        );
        assert_eq!(
            recovered.checkpoint.coverage().len(),
            usize::from(boundary == FaultBoundary::AfterCommit)
        );
        assert_eq!(recovered.journal, vec![e.clone()]);
        assert_eq!(recovered.pending, vec![e]);
        assert_eq!(text(&restore(&f.reopen())), "port 😀");
    }
}
#[test]
fn receipt_native_failure_boundaries_preserve_journal() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let f = Fixture::new(StoreLimits::default());
        f.boot();
        let e = update();
        f.append(e.clone()).unwrap();
        f.store
            .inject_once(InjectedFault {
                boundary,
                error: PortError::Permission,
            })
            .unwrap();
        let expected = if boundary == FaultBoundary::AfterCommit {
            PortError::CommitUnknown
        } else {
            PortError::Permission
        };
        assert_eq!(
            f.store
                .accept_receipt(ReceiptCapability::DurableV1, receipt(&e)),
            Err(expected)
        );
        let recovered = f.reopen().recover(&identity()).unwrap();
        assert_eq!(recovered.journal, vec![e.clone()]);
        assert_eq!(
            recovered.pending.len(),
            usize::from(boundary != FaultBoundary::AfterCommit)
        );
        f.reopen()
            .accept_receipt(ReceiptCapability::DurableV1, receipt(&e))
            .unwrap();
        assert!(f.reopen().pending(&identity()).unwrap().is_empty());
    }
}
fn wait_signal(child: &mut Child, path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("child exited before signal: {status}");
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("child boundary signal timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn killed_process_at_real_sqlite_commit_boundaries() {
    for (mode, committed) in [
        ("kill-write", false),
        ("kill-commit", false),
        ("kill-after", true),
    ] {
        let f = Fixture::new(StoreLimits::default());
        f.boot();
        let signal = f.directory.join("boundary");
        let mut child = f.child(mode, &signal, None);
        wait_signal(&mut child, &signal);
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        let reopened = f.reopen();
        let recovered = reopened.recover(&identity()).unwrap();
        assert_eq!(recovered.journal.len(), usize::from(committed));
        assert_eq!(recovered.pending.len(), usize::from(committed));
        assert_eq!(
            text(&restore(&reopened)),
            if committed { "native child 😀" } else { "" }
        );
        if committed {
            let e = recovered.journal[0].clone();
            reopened.append(e).unwrap();
            assert_eq!(reopened.pending(&identity()).unwrap().len(), 1);
        }
        println!(
            "terminated {mode}; journal/pending={}; engine replay verified",
            recovered.journal.len()
        );
    }
}
#[test]
fn killed_checkpoint_and_receipt_processes_recover_atomic_membership() {
    for operation in ["publish", "receipt"] {
        for (boundary, committed) in [("write", false), ("commit", false), ("after", true)] {
            let f = Fixture::new(StoreLimits::default());
            f.boot();
            let signal = f.directory.join("boundary");
            let mode = format!("kill-{operation}-{boundary}");
            let mut child = f.child(&mode, &signal, None);
            wait_signal(&mut child, &signal);
            child.kill().unwrap();
            assert!(!child.wait().unwrap().success());
            let recovered = f.reopen().recover(&identity()).unwrap();
            assert_eq!(recovered.journal.len(), 1);
            assert_eq!(text(&restore(&f.reopen())), "native child 😀");
            if operation == "publish" {
                assert_eq!(recovered.generation, if committed { 2 } else { 1 });
                assert_eq!(
                    recovered.checkpoint.coverage().len(),
                    usize::from(committed)
                );
                assert_eq!(recovered.pending.len(), 1);
            } else {
                assert_eq!(recovered.generation, 1);
                assert_eq!(recovered.pending.len(), usize::from(!committed));
                let entry = &recovered.journal[0];
                assert_eq!(
                    f.reopen()
                        .accept_receipt(ReceiptCapability::DurableV1, receipt(entry))
                        .unwrap(),
                    ReceiptResult::RemoteCommitted
                );
                assert!(f.reopen().pending(&identity()).unwrap().is_empty());
            }
            println!(
                "terminated {mode}; generation={}, journal={}, pending={}; engine replay verified",
                recovered.generation,
                recovered.journal.len(),
                recovered.pending.len()
            );
        }
    }
}
#[test]
fn acknowledged_child_edit_recovers_after_exit_without_destructors() {
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let signal = f.directory.join("ack");
    let mut child = f.child("ack-exit", &signal, None);
    wait_signal(&mut child, &signal);
    assert!(child.wait().unwrap().success());
    assert_eq!(std::fs::read_to_string(signal).unwrap(), "acknowledged");
    assert_eq!(f.reopen().pending(&identity()).unwrap().len(), 1);
    assert_eq!(text(&restore(&f.reopen())), "native child 😀");
}
#[test]
fn separate_process_checkpoint_cas_and_writer_reservation() {
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let go = f.directory.join("go");
    let a = f.directory.join("a");
    let b = f.directory.join("b");
    let mut first = f.child("cas", &a, Some(&go));
    let mut second = f.child("cas", &b, Some(&go));
    wait_signal(&mut first, &a);
    wait_signal(&mut second, &b);
    std::fs::write(go, b"go").unwrap();
    let mut codes = vec![
        first.wait().unwrap().code().unwrap(),
        second.wait().unwrap().code().unwrap(),
    ];
    codes.sort();
    assert_eq!(codes, vec![0, 10]);
    assert_eq!(f.reopen().generation(&identity()).unwrap(), 2);
    let mut first = f.child("claim", &a, None);
    let mut second = f.child("claim", &b, None);
    let mut codes = vec![
        first.wait().unwrap().code().unwrap(),
        second.wait().unwrap().code().unwrap(),
    ];
    codes.sort();
    assert_eq!(codes, vec![0, 10]);
}
#[test]
fn real_sqlite_full_never_acknowledges_or_loses_prior_edit() {
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let mut doc = document();
    insert(&mut doc, 0, "saved 😀");
    let entry = JournalEntry::new(
        identity(),
        doc.writer_id(),
        1,
        "human".into(),
        doc.last_patch()
            .unwrap()
            .update
            .as_ref()
            .unwrap()
            .bytes
            .clone(),
    )
    .unwrap();
    f.store.claim_writer(doc.writer_id()).unwrap();
    assert_eq!(
        f.store.append(entry.clone()).unwrap().durability,
        Durability::ProcessCrash
    );
    let pages = f.store.page_count().unwrap();
    assert_eq!(f.store.set_max_pages(pages).unwrap(), pages);
    insert(&mut doc, 8, &"large edit ".repeat(16000));
    let large = JournalEntry::new(
        identity(),
        doc.writer_id(),
        2,
        "human".into(),
        doc.last_patch()
            .unwrap()
            .update
            .as_ref()
            .unwrap()
            .bytes
            .clone(),
    )
    .unwrap();
    assert_eq!(f.store.append(large.clone()), Err(PortError::Quota));
    assert_eq!(f.store.pending(&identity()).unwrap(), vec![entry.clone()]);
    assert_eq!(
        f.reopen().recover(&identity()).unwrap().journal,
        vec![entry]
    );
    assert_eq!(text(&restore(&f.reopen())), "saved 😀");
    f.store.set_max_pages(pages + 1024).unwrap();
    f.store.append(large).unwrap();
    assert_eq!(f.reopen().pending(&identity()).unwrap().len(), 2);
    println!(
        "actual SQLite page quota ({pages} pages) returned SQLITE_FULL/Quota; prior acknowledged edit recovered; changed quota retry succeeded"
    );
}
fn corrupt(f: &Fixture, change: impl FnOnce(&mut serde_json::Value)) {
    let sql = rusqlite::Connection::open(f.store.path()).unwrap();
    let body: Vec<u8> = sql
        .query_row("SELECT body FROM state", [], |r| r.get(0))
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    change(&mut value);
    sql.execute(
        "UPDATE state SET body=?1",
        [serde_json::to_vec(&value).unwrap()],
    )
    .unwrap();
}
#[test]
fn corrupt_latest_fallback_full_tail_and_cas_repair() {
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let e = update();
    f.append(e.clone()).unwrap();
    f.store
        .publish(
            1,
            CheckpointRecord::new(restore(&f.store).checkpoint(), vec![e.id().clone()]).unwrap(),
        )
        .unwrap();
    corrupt(&f, |v| v["latest"]["bytes"][0] = serde_json::json!(255));
    let r = f.reopen().recover(&identity()).unwrap();
    assert_eq!(r.source, RecoverySource::Previous);
    assert_eq!(
        r.rejected,
        vec![(RecoverySource::Latest, PortError::Integrity)]
    );
    assert_eq!(r.generation, 2);
    assert_eq!(r.journal, vec![e.clone()]);
    assert_eq!(r.pending, vec![e.clone()]);
    assert_eq!(text(&restore(&f.reopen())), "port 😀");
    f.store
        .publish(
            2,
            CheckpointRecord::new(restore(&f.store).checkpoint(), vec![e.id().clone()]).unwrap(),
        )
        .unwrap();
    assert_eq!(f.reopen().generation(&identity()).unwrap(), 3);
}
#[test]
fn corrupt_journal_or_receipt_membership_never_silently_omits_bytes() {
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let e = update();
    f.append(e).unwrap();
    corrupt(&f, |v| v["journal"][0]["bytes"][0] = serde_json::json!(255));
    assert_eq!(f.store.pending(&identity()), Err(PortError::Integrity));
    assert!(matches!(
        f.store.recover(&identity()),
        Err(PortError::Integrity)
    ));
    assert!(matches!(
        NativeStore::open_existing(f.store.path(), identity(), StoreLimits::default()),
        Err(PortError::Integrity)
    ));
    assert_eq!(f.store.publish(1, initial()), Err(PortError::Integrity));
    let f = Fixture::new(StoreLimits::default());
    f.boot();
    let e = update();
    f.append(e.clone()).unwrap();
    f.store
        .accept_receipt(ReceiptCapability::DurableV1, receipt(&e))
        .unwrap();
    corrupt(&f, |v| v["receipted"][0]["sequence"] = serde_json::json!(2));
    assert_eq!(f.store.pending(&identity()), Err(PortError::Integrity));
}
