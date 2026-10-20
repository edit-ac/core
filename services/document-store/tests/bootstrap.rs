use editac_core::modules::assets::AssetAction;
use editac_document_store::{
    BackendError, CommitState, Retryability, SqliteBackend,
    contracts::{
        self, AssetCommitReceipt, AssetGrant, AssetIdentity, AssetRequest, DocumentIdentity,
        JournalEntry, PortError,
    },
};
use rusqlite::{Connection, params};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new(name: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.artifacts/cloud-host-bootstrap-20261018/stores");
        fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!(
            "{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        Self { directory }
    }
    fn path(&self) -> PathBuf {
        self.directory.join("host.sqlite")
    }
    fn open(&self) -> SqliteBackend {
        SqliteBackend::open(&self.path()).unwrap()
    }
}

fn setup(backend: &mut SqliteBackend) {
    backend
        .transaction(|tx| {
            // Harness tables exercise the backend, not a second catalog/update owner.
            tx.execute_batch(
                "CREATE TABLE fixture (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL) STRICT",
            )?;
            Ok(())
        })
        .unwrap();
}
fn rows(backend: &mut SqliteBackend) -> i64 {
    backend
        .transaction(|tx| Ok(tx.query_row("SELECT count(*) FROM fixture", [], |r| r.get(0))?))
        .unwrap()
}

#[test]
fn real_file_bootstrap_migrates_once_and_reports_actual_limits() {
    let fixture = Fixture::new("migration");
    let mut db = fixture.open();
    let caps = db.capabilities();
    assert_eq!(caps.sqlite_version, rusqlite::version());
    assert_eq!(caps.schema_version, 1);
    assert_eq!(caps.journal_mode, "delete");
    assert_eq!(caps.synchronous, "full");
    assert!(caps.atomic_transactions && caps.serialized_writers && caps.process_crash);
    assert!(
        !caps.host_loss
            && !caps.replica_loss
            && !caps.remote_receipts
            && !caps.deployment_qualified
    );
    setup(&mut db);
    drop(db);
    let mut reopened = fixture.open();
    assert_eq!(rows(&mut reopened), 0);
    assert_eq!(
        fs::read(fixture.path()).unwrap().get(..16),
        Some(b"SQLite format 3\0".as_slice())
    );
}

#[test]
fn actual_shared_update_identity_and_owned_bytes_survive_reopen() {
    let fixture = Fixture::new("owned-update");
    let identity = DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap();
    // Deliberately opaque fixture bytes: backend cannot claim CRDT validation.
    let entry = JournalEntry::new(identity, 7, 1, "fixture".into(), vec![0, 255, 8, 0]).unwrap();
    let mut db = fixture.open();
    setup(&mut db);
    db.transaction(|tx| {
        tx.execute("INSERT INTO fixture VALUES (1, ?1)", [entry.bytes()])?;
        Ok(())
    })
    .unwrap();
    drop(db);
    let mut db = fixture.open();
    let bytes: Vec<u8> = db
        .transaction(|tx| {
            Ok(tx.query_row("SELECT bytes FROM fixture WHERE id=1", [], |r| r.get(0))?)
        })
        .unwrap();
    let restored =
        JournalEntry::from_stored(entry.id().clone(), entry.origin().into(), bytes).unwrap();
    assert_eq!(restored, entry);
    assert_eq!(
        JournalEntry::from_stored(entry.id().clone(), "fixture".into(), vec![1]),
        Err(PortError::Integrity)
    );
}

#[test]
fn shared_document_profiles_reject_without_silent_fallback() {
    let mut identity = DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap();
    identity.profile = "unknown-opaque-profile".into();
    assert_eq!(
        JournalEntry::new(identity, 7, 1, "fixture".into(), vec![1]),
        Err(PortError::Incompatible)
    );
    assert_eq!(
        contracts::PORT_NAMES,
        [
            "IdentityVerifier",
            "AuthorizationPolicy",
            "CatalogStore",
            "UpdateStore",
            "BlobStore",
            "CommitCoordinator",
            "Relay"
        ]
    );
}

#[test]
fn actual_rch_asset_grants_and_receipts_remain_separate() {
    let identity = AssetIdentity {
        host: "reference".into(),
        key: "asset_1".into(),
    };
    let grant = AssetGrant {
        identity: identity.clone(),
        actions: vec![AssetAction::Publish],
    };
    let request = AssetRequest {
        version: 1,
        operation_id: "operation_1".into(),
        identity: identity.clone(),
        action: AssetAction::Publish,
        byte_limit: 4096,
    };
    request.validate(&grant).unwrap();
    let receipt = AssetCommitReceipt {
        operation_id: request.operation_id.clone(),
        identity,
    };
    assert_eq!(receipt.identity, request.identity);
    let mut wrong = grant.clone();
    wrong.identity.key = "other".into();
    assert!(request.validate(&wrong).is_err());
    let mut wrong = request.clone();
    wrong.version = 2;
    assert!(wrong.validate(&grant).is_err());
    let mut wrong = request;
    wrong.byte_limit = 0;
    assert!(wrong.validate(&grant).is_err());
    // The shared API has no conversion from this asset receipt to DurableReceipt.
}

#[test]
fn failed_multi_write_transaction_rolls_back_before_result() {
    let fixture = Fixture::new("rollback");
    let mut db = fixture.open();
    setup(&mut db);
    let result = db.transaction(|tx| {
        tx.execute("INSERT INTO fixture VALUES (1, x'01')", [])?;
        tx.execute("INSERT INTO fixture VALUES (1, x'02')", [])?;
        Ok("must not escape")
    });
    assert_eq!(result, Err(BackendError::Rejected));
    assert_eq!(rows(&mut db), 0);
    drop(db);
    assert_eq!(rows(&mut fixture.open()), 0);
}

#[test]
fn application_rejection_rolls_back_and_later_transaction_recovers() {
    let fixture = Fixture::new("application-reject");
    let mut db = fixture.open();
    setup(&mut db);
    assert_eq!(
        db.transaction(|tx| {
            tx.execute("INSERT INTO fixture VALUES (1, x'01')", [])?;
            Err::<(), _>(BackendError::Quota)
        }),
        Err(BackendError::Quota)
    );
    assert_eq!(rows(&mut db), 0);
    db.transaction(|tx| {
        tx.execute("INSERT INTO fixture VALUES (2, x'02')", [])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(rows(&mut db), 1);
}

#[test]
fn sqlite_serializes_distinct_connections_with_bounded_busy_result() {
    let fixture = Fixture::new("busy");
    let mut a = fixture.open();
    let mut b = fixture.open();
    setup(&mut a);
    a.transaction(|tx| {
        tx.execute("INSERT INTO fixture VALUES (1, x'01')", [])?;
        let started = Instant::now();
        assert_eq!(b.transaction(|_| Ok(())), Err(BackendError::Busy));
        assert!(started.elapsed() < Duration::from_secs(5));
        Ok(())
    })
    .unwrap();
    assert_eq!(rows(&mut b), 1);
}

#[test]
fn future_schema_rejection_preserves_existing_bytes() {
    let fixture = Fixture::new("future");
    drop(fixture.open());
    let db = Connection::open(fixture.path()).unwrap();
    db.pragma_update(None, "user_version", 99).unwrap();
    drop(db);
    let before = fs::read(fixture.path()).unwrap();
    assert!(matches!(
        SqliteBackend::open(&fixture.path()),
        Err(BackendError::Incompatible)
    ));
    assert_eq!(fs::read(fixture.path()).unwrap(), before);
}

#[test]
fn foreign_database_is_never_adopted_or_reformatted() {
    let fixture = Fixture::new("foreign");
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch(
        "CREATE TABLE personal (value TEXT); INSERT INTO personal VALUES ('preserve')",
    )
    .unwrap();
    drop(db);
    let before = fs::read(fixture.path()).unwrap();
    assert!(matches!(
        SqliteBackend::open(&fixture.path()),
        Err(BackendError::Incompatible)
    ));
    assert_eq!(fs::read(fixture.path()).unwrap(), before);
}

#[test]
fn corrupt_database_and_metadata_fail_closed() {
    let fixture = Fixture::new("corrupt");
    fs::write(fixture.path(), b"not a database").unwrap();
    assert!(matches!(
        SqliteBackend::open(&fixture.path()),
        Err(BackendError::Integrity)
    ));
    assert_eq!(fs::read(fixture.path()).unwrap(), b"not a database");
    let fixture = Fixture::new("metadata");
    drop(fixture.open());
    let db = Connection::open(fixture.path()).unwrap();
    db.execute("DELETE FROM host_metadata", []).unwrap();
    drop(db);
    assert!(matches!(
        SqliteBackend::open(&fixture.path()),
        Err(BackendError::Integrity)
    ));
}

#[test]
fn invalid_paths_do_not_create_memory_or_relative_stores() {
    for path in [
        ":memory:",
        "relative.sqlite",
        "file:memory?mode=memory",
        "/",
    ] {
        assert!(matches!(
            SqliteBackend::open(Path::new(path)),
            Err(BackendError::InvalidPath)
        ));
    }
    let fixture = Fixture::new("missing-parent");
    assert!(matches!(
        SqliteBackend::open(&fixture.directory.join("missing/host.sqlite")),
        Err(BackendError::Unavailable)
    ));
}

#[test]
fn error_vocabulary_preserves_unknown_commit_and_sanitizes_details() {
    assert_eq!(
        BackendError::CommitUnknown.commit_state(),
        CommitState::Unknown
    );
    assert_eq!(
        BackendError::CommitUnknown.retryability(),
        Retryability::Reconcile
    );
    assert_eq!(BackendError::Busy.retryability(), Retryability::Backoff);
    assert_eq!(BackendError::Integrity.retryability(), Retryability::Never);
    let error = BackendError::from(rusqlite::Error::InvalidParameterName("secret-token".into()));
    assert_eq!(error.to_string(), "Unavailable");
}

#[test]
fn process_crash_before_and_after_commit_preserves_atomic_boundary() {
    const CHILD: &str = "EDITAC_CLD_BOOTSTRAP_CHILD";
    if let Ok(mode) = std::env::var(CHILD) {
        let directory = PathBuf::from(std::env::var_os("EDITAC_CLD_BOOTSTRAP_DIRECTORY").unwrap());
        let mut db = SqliteBackend::open(&directory.join("host.sqlite")).unwrap();
        let write = |tx: &rusqlite::Transaction<'_>| {
            tx.execute(
                "INSERT INTO fixture VALUES (1, ?1)",
                params![vec![42u8; 8192]],
            )?;
            if mode == "before" {
                fs::write(directory.join("ready"), b"ready").unwrap();
                loop {
                    std::thread::park();
                }
            }
            Ok(())
        };
        db.transaction(write).unwrap();
        fs::write(directory.join("ready"), b"committed").unwrap();
        loop {
            std::thread::park();
        }
    }
    for mode in ["before", "after"] {
        let fixture = Fixture::new(mode);
        let mut db = fixture.open();
        setup(&mut db);
        drop(db);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_crash_before_and_after_commit_preserves_atomic_boundary",
                "--nocapture",
            ])
            .env(CHILD, mode)
            .env("EDITAC_CLD_BOOTSTRAP_DIRECTORY", &fixture.directory)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !fixture.directory.join("ready").exists() && Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("child exited before boundary: {status}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = fixture.directory.join("ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "child never reached {mode} boundary");
        let mut reopened = fixture.open();
        assert_eq!(rows(&mut reopened), i64::from(mode == "after"));
        if mode == "after" {
            let bytes: Vec<u8> = reopened
                .transaction(|tx| Ok(tx.query_row("SELECT bytes FROM fixture", [], |r| r.get(0))?))
                .unwrap();
            assert_eq!(bytes, vec![42u8; 8192]);
        }
    }
}

#[test]
fn runnable_host_reports_local_only_and_sanitizes_startup_errors() {
    let fixture = Fixture::new("cli");
    let binary = env!("CARGO_BIN_EXE_editac-document-store");
    let result = Command::new(binary)
        .arg("--store")
        .arg(fixture.path())
        .output()
        .unwrap();
    assert!(result.status.success());
    let stdout = String::from_utf8(result.stdout).unwrap();
    assert!(
        stdout.contains("sqlite-bundled")
            && stdout.contains("remote_receipts: false")
            && stdout.contains("deployment_qualified: false")
    );
    let result = Command::new(binary)
        .args(["--store", "secret-relative-path"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(
        String::from_utf8(result.stderr).unwrap(),
        "host bootstrap: InvalidPath\n"
    );
}
