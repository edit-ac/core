//! Actual shared Session + SQLite via the public native ABI. No provider/network IO.
use editac_ffi::*;
use std::{
    path::PathBuf,
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
};
struct Fixture {
    directory: PathBuf,
    options: NativeSessionOptions,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!("native-session-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let options = NativeSessionOptions {
            path: directory.join("session.sqlite").to_str().unwrap().into(),
            document_id: format!("a9100000-0000-4000-8000-{n:012x}"),
            epoch: "a9200000-0000-4000-8000-000000000001".into(),
            writable: true,
            permission_expires_at: None,
        };
        Self { directory, options }
    }
    fn create(&self) -> Arc<NativeSession> {
        NativeSession::create_local(
            self.options.clone(),
            vec![NativeSessionSeed {
                kind: "block".into(),
                text: "A🦀B".into(),
            }],
        )
        .unwrap()
    }
    fn open(&self) -> Arc<NativeSession> {
        NativeSession::open(self.options.clone()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
fn prepare(s: &NativeSession, text: &str) -> String {
    let read = s.read(0).unwrap();
    s.prepare_edits(
        read.revision.unwrap(),
        vec![NativeSessionEdit {
            node: read.nodes[0].id.clone(),
            from_utf16: 1,
            to_utf16: 3,
            text: text.into(),
        }],
        "native-test".into(),
        0,
    )
    .unwrap()
}
fn text(s: &NativeSession) -> String {
    s.read(0).unwrap().nodes[0].text.clone()
}

#[test]
fn durable_create_edit_reopen_owned_checkpoint_and_history() {
    let f = Fixture::new();
    let s = f.create();
    let before = s.read(0).unwrap();
    assert_eq!(before.nodes[0].text, "A🦀B");
    assert!(before.locally_committed && before.can_apply && before.can_history);
    assert_eq!(
        before.local_durability,
        NativeSessionDurability::ProcessCrash
    );
    let owned = s.recovery_export().unwrap();
    let bytes = owned.checkpoint.bytes.clone();
    assert!(owned.locally_committed && owned.unjournaled_update.is_none());
    let token = prepare(&s, "xy");
    assert_eq!(text(&s), "A🦀B", "preparation must not mutate");
    let receipt = s.commit_edits(token, 0).unwrap().unwrap();
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.checksum.len(), 32);
    assert_eq!(receipt.durability, NativeSessionDurability::ProcessCrash);
    assert_eq!(text(&s), "AxyB");
    assert!(s.read(0).unwrap().pending_upload > 0);
    let r = s.read(0).unwrap().revision.unwrap();
    assert!(s.undo(r, 0).unwrap().is_some());
    assert_eq!(text(&s), "A🦀B");
    let r = s.read(0).unwrap().revision.unwrap();
    assert!(s.redo(r, 0).unwrap().is_some());
    assert_eq!(text(&s), "AxyB");
    s.dispose().unwrap();
    assert_eq!(owned.checkpoint.bytes, bytes);
    assert_eq!(before.nodes[0].text, "A🦀B");
    let restored = f.open();
    assert_eq!(text(&restored), "AxyB");
    assert_eq!(restored.read(0).unwrap().revision.unwrap().len(), 65);
    restored.dispose().unwrap();
}
#[test]
fn canceled_single_use_and_replica_scoped_plans() {
    let f = Fixture::new();
    let s = f.create();
    let other = f.open();
    let token = prepare(&s, "x");
    let other_token = prepare(&other, "y");
    assert_ne!(token, other_token);
    assert!(matches!(
        other.commit_edits(token.clone(), 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    s.cancel_edits(token.clone()).unwrap();
    s.cancel_edits(token.clone()).unwrap();
    assert!(matches!(
        s.commit_edits(token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert_eq!(text(&s), "A🦀B");
    let token = prepare(&s, "z");
    s.commit_edits(token.clone(), 0).unwrap();
    s.cancel_edits(token.clone()).unwrap();
    assert!(matches!(
        s.commit_edits(token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert_eq!(text(&s), "AzB");
    s.dispose().unwrap();
    other.dispose().unwrap();
}
#[test]
fn stale_admission_and_invalid_utf16_batch_are_atomic() {
    let f = Fixture::new();
    let s = f.create();
    let before = s.read(0).unwrap();
    let node = before.nodes[0].id.clone();
    let result = s.prepare_edits(
        before.revision.clone().unwrap(),
        vec![
            NativeSessionEdit {
                node: node.clone(),
                from_utf16: 0,
                to_utf16: 0,
                text: "valid".into(),
            },
            NativeSessionEdit {
                node,
                from_utf16: 7,
                to_utf16: 7,
                text: "split".into(),
            },
        ],
        "atomic".into(),
        0,
    );
    // After staging "valid", UTF-16 7 is inside the crab surrogate pair.
    assert!(matches!(result, Err(NativeSessionError::Engine { .. })));
    assert_eq!(s.read(0).unwrap().revision, before.revision);
    assert_eq!(text(&s), "A🦀B");
    let first = prepare(&s, "x");
    let stale = prepare(&s, "y");
    s.commit_edits(first, 0).unwrap();
    assert!(matches!(
        s.commit_edits(stale, 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    assert_eq!(text(&s), "AxB");
    s.dispose().unwrap();
}
#[test]
fn permission_rechecked_for_commit_undo_redo_and_reopen() {
    let f = Fixture::new();
    let s = f.create();
    let token = prepare(&s, "x");
    s.set_permission(false, None).unwrap();
    assert!(matches!(
        s.commit_edits(token, 0),
        Err(NativeSessionError::ReadOnly)
    ));
    assert!(matches!(
        s.undo(s.read(0).unwrap().revision.unwrap(), 0),
        Err(NativeSessionError::ReadOnly)
    ));
    assert!(matches!(
        s.redo(s.read(0).unwrap().revision.unwrap(), 0),
        Err(NativeSessionError::ReadOnly)
    ));
    s.set_permission(true, Some(5)).unwrap();
    let token = prepare(&s, "x");
    assert!(matches!(
        s.commit_edits(token, 5),
        Err(NativeSessionError::PermissionExpired)
    ));
    assert!(!s.read(5).unwrap().can_apply);
    assert_eq!(text(&s), "A🦀B");
    s.dispose().unwrap();
    let mut options = f.options.clone();
    options.writable = false;
    let reopened = NativeSession::open(options).unwrap();
    assert!(!reopened.read(0).unwrap().can_apply);
    assert!(matches!(
        reopened.prepare_edits(
            reopened.read(0).unwrap().revision.unwrap(),
            vec![],
            "no".into(),
            0
        ),
        Err(NativeSessionError::ReadOnly)
    ));
    reopened.dispose().unwrap();
}
#[test]
fn failed_open_never_creates_or_replaces_store_and_scope_is_typed() {
    let f = Fixture::new();
    assert!(NativeSession::open(f.options.clone()).is_err());
    assert!(!std::path::Path::new(&f.options.path).exists());
    let s = f.create();
    assert!(matches!(
        NativeSession::create_local(f.options.clone(), vec![]),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Conflict
        })
    ));
    let mut wrong = f.options.clone();
    wrong.epoch = "a9200000-0000-4000-8000-000000000002".into();
    assert!(matches!(
        NativeSession::open(wrong),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Incompatible
        })
    ));
    s.dispose().unwrap();
    assert_eq!(text(&f.open()), "A🦀B");
    let corrupt = f.directory.join("corrupt.sqlite");
    std::fs::write(&corrupt, b"not sqlite").unwrap();
    let mut options = f.options.clone();
    options.path = corrupt.to_str().unwrap().into();
    assert!(matches!(
        NativeSession::open(options),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Integrity
        })
    ));
    assert_eq!(std::fs::read(corrupt).unwrap(), b"not sqlite");
}
#[test]
fn aliases_serialize_concurrent_commits_without_lost_acknowledged_edits() {
    let f = Fixture::new();
    let s = f.create();
    let barrier = Arc::new(Barrier::new(9));
    let mut joins = vec![];
    for _ in 0..8 {
        let s = Arc::clone(&s);
        let b = barrier.clone();
        joins.push(std::thread::spawn(move || {
            let token = prepare(&s, "x");
            b.wait();
            match s.commit_edits(token, 0) {
                Ok(Some(receipt)) => Some(receipt),
                Err(NativeSessionError::Revision {
                    reason: NativeRevisionFailure::Stale,
                    ..
                }) => None,
                other => panic!("unexpected admission: {other:?}"),
            }
        }));
    }
    barrier.wait();
    let receipts = joins
        .into_iter()
        .filter_map(|j| j.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].sequence, 1);
    assert_eq!(text(&s), "AxB");
    s.dispose().unwrap();
    assert_eq!(text(&f.open()), "AxB");
}
#[test]
fn alias_disposal_is_idempotent_and_every_operation_rejects_afterward() {
    let f = Fixture::new();
    let s = f.create();
    let alias = Arc::clone(&s);
    let read = s.read(0).unwrap();
    let token = prepare(&s, "x");
    let export = s.recovery_export().unwrap();
    s.dispose().unwrap();
    alias.dispose().unwrap();
    assert!(matches!(alias.read(0), Err(NativeSessionError::Disposed)));
    assert!(matches!(
        alias.prepare_edits(read.revision.clone().unwrap(), vec![], "x".into(), 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.commit_edits(token.clone(), 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.cancel_edits(token),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.undo(read.revision.clone().unwrap(), 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.redo(read.revision.unwrap(), 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.set_permission(true, None),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(alias.recover(), Err(NativeSessionError::Disposed)));
    assert!(matches!(
        alias.recovery_export(),
        Err(NativeSessionError::Disposed)
    ));
    assert!(!export.checkpoint.bytes.is_empty());
    assert_eq!(text(&f.open()), "A🦀B");
}
#[test]
fn plan_limit_is_bounded_and_cancellation_releases_capacity() {
    let f = Fixture::new();
    let s = f.create();
    let mut tokens = vec![];
    for _ in 0..128 {
        tokens.push(prepare(&s, "x"));
    }
    let r = s.read(0).unwrap().revision.unwrap();
    assert!(matches!(
        s.prepare_edits(r, vec![], "limit".into(), 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    s.cancel_edits(tokens.pop().unwrap()).unwrap();
    let _ = prepare(&s, "y");
    assert_eq!(text(&s), "A🦀B");
    s.dispose().unwrap();
}
#[test]
fn malformed_revision_and_origin_fail_before_mutation() {
    let f = Fixture::new();
    let s = f.create();
    assert!(matches!(
        s.prepare_edits(vec![0], vec![], "x".into(), 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::InvalidToken,
            ..
        })
    ));
    assert!(matches!(
        s.prepare_edits(
            s.read(0).unwrap().revision.unwrap(),
            vec![],
            String::new(),
            0
        ),
        Err(NativeSessionError::Text { .. })
    ));
    assert_eq!(text(&s), "A🦀B");
    s.dispose().unwrap();
}
