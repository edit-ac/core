mod support;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::TextCommand,
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    local_channel::MemoryChannel,
    ports::{memory::*, *},
    revision::{ObservedRevision, RevisionError},
    session::*,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use support::{origin, owner, text};

fn identity() -> DocumentIdentity {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    DocumentIdentity::v5(
        &format!(
            "34567890-3456-4456-8456-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "45678901-4567-4567-8567-456789012345",
    )
    .unwrap()
}
fn initial() -> Vec<InitialNode> {
    vec![InitialNode {
        kind: "block".into(),
        text: "abcdef".into(),
    }]
}
fn memory(id: &DocumentIdentity) -> Arc<MemoryStore> {
    Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap())
}
fn fault(id: &DocumentIdentity) -> Arc<FaultInjectedStore> {
    Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap())
}
fn insertion<S: SessionStore>(session: &Session<S>, value: &str) -> TextCommand {
    TextCommand::Insert {
        at: session
            .document()
            .anchor(&owner(session.document()), Utf16Offset(0), Bias::Right)
            .unwrap(),
        text: value.into(),
    }
}
fn deletion<S: SessionStore>(session: &Session<S>) -> TextCommand {
    let owner = owner(session.document());
    TextCommand::Delete {
        selection: session
            .document()
            .selection(
                (&owner, Utf16Offset(1), Bias::Left),
                (&owner, Utf16Offset(3), Bias::Right),
            )
            .unwrap(),
    }
}
fn apply<S: SessionStore>(session: &mut Session<S>, value: &str) {
    let revision = session.observed_revision().unwrap();
    let command = insertion(session, value);
    session
        .edit_text_if_revision(&revision, &command, &origin(), 0)
        .unwrap();
}
fn stale(error: SessionError) {
    assert_eq!(error, SessionError::Revision(RevisionError::Stale));
}

fn deletion_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let before = session.observed_revision().unwrap();
    let vector = session.document().state_vector_v1();
    session
        .edit_text_if_revision(&before, &deletion(&session), &origin(), 0)
        .unwrap()
        .unwrap();
    assert_eq!(text(session.document()), "adef");
    assert_eq!(
        vector,
        session.document().state_vector_v1(),
        "delete-only clocks must be identical"
    );
    let after = session.observed_revision().unwrap();
    assert_ne!(before, after);
    let checkpoint = session.document().checkpoint().bytes;
    let pending = store.pending(&id).unwrap();
    stale(
        session
            .edit_text_if_revision(&before, &insertion(&session, "stale"), &origin(), 0)
            .unwrap_err(),
    );
    assert_eq!(checkpoint, session.document().checkpoint().bytes);
    assert_eq!(pending, store.pending(&id).unwrap());
    assert_eq!(session.observed_revision().unwrap(), after);
    apply(&mut session, "fresh-");
    assert_eq!(text(session.document()), "fresh-adef");
}

fn restart_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let initial_token = session.observed_revision().unwrap();
    apply(&mut session, "first-");
    session
        .edit_text(&deletion(&session), &origin(), 0)
        .unwrap();
    let persisted = session.observed_revision().unwrap().to_bytes();
    let writer = session.document().writer_id();
    let expected_text = text(session.document());
    // Checkpoint publication and coverage do not define a revision or invalidate a proposal.
    let recovery = store.recover(&id).unwrap();
    let checkpoint = CheckpointRecord::new(
        session.document().checkpoint(),
        recovery.journal.iter().map(|e| e.id().clone()).collect(),
    )
    .unwrap();
    store.publish(recovery.generation, checkpoint).unwrap();
    assert_eq!(session.observed_revision().unwrap().to_bytes(), persisted);
    drop(session);
    let mut reopened = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    assert_ne!(reopened.document().writer_id(), writer);
    assert_eq!(reopened.observed_revision().unwrap().to_bytes(), persisted);
    assert_eq!(text(reopened.document()), expected_text);
    stale(
        reopened
            .edit_text_if_revision(&initial_token, &insertion(&reopened, "old"), &origin(), 0)
            .unwrap_err(),
    );
    let token = ObservedRevision::from_bytes(&persisted).unwrap();
    reopened
        .edit_text_if_revision(&token, &insertion(&reopened, "restart-"), &origin(), 0)
        .unwrap();
    assert_ne!(reopened.observed_revision().unwrap(), token);
}

fn later_events_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut a = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let mut b = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    let (mut ca, mut cb) = MemoryChannel::pair(8).unwrap();
    let observed = a.observed_revision().unwrap();
    assert_eq!(b.observed_revision().unwrap(), observed);
    let proposal = insertion(&a, "A-");
    apply(&mut b, "B-");
    b.notify_local(&mut cb).unwrap();
    // B has durably committed into the shared store, but A has not observed the event.
    // The endpoint-local token cannot pretend to be a global database/peer lock.
    assert_eq!(a.observed_revision().unwrap(), observed);
    a.edit_text_if_revision(&observed, &proposal, &origin(), 0)
        .unwrap()
        .unwrap();
    a.notify_local(&mut ca).unwrap();
    let local_revision = a.observed_revision().unwrap();
    a.receive_local(&mut ca).unwrap();
    b.receive_local(&mut cb).unwrap();
    assert_ne!(a.observed_revision().unwrap(), local_revision);
    assert_eq!(
        a.observed_revision().unwrap(),
        b.observed_revision().unwrap()
    );
    assert_eq!(text(a.document()), text(b.document()));
    assert!(text(a.document()).contains("A-"));
    assert!(text(a.document()).contains("B-"));
    assert_eq!(store.recover(&id).unwrap().journal.len(), 2);
    stale(
        a.edit_text_if_revision(&local_revision, &insertion(&a, "stale"), &origin(), 0)
            .unwrap_err(),
    );
}

fn peer_deletion_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut local = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let mut peer = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    let before = local.observed_revision().unwrap();
    let vector = local.document().state_vector_v1();
    peer.edit_text(&deletion(&peer), &origin(), 0).unwrap();
    let entry = store.recover(&id).unwrap().journal[0].clone();
    local.receive_peer(entry.clone()).unwrap();
    assert_eq!(local.document().state_vector_v1(), vector);
    assert_eq!(text(local.document()), "adef");
    assert_ne!(local.observed_revision().unwrap(), before);
    assert_eq!(
        local.observed_revision().unwrap(),
        peer.observed_revision().unwrap()
    );
    let once = local.observed_revision().unwrap();
    local.receive_peer(entry).unwrap();
    local.catch_up_local().unwrap();
    assert_eq!(
        local.observed_revision().unwrap(),
        once,
        "duplicate replay is not a new state"
    );
    stale(
        local
            .edit_text_if_revision(&before, &insertion(&local, "stale"), &origin(), 0)
            .unwrap_err(),
    );
    assert!(
        local.undo_if_revision(&once, 0).unwrap().is_none(),
        "peer deletion is not local undo"
    );
}

macro_rules! shared_cases {
    ($module:ident, $factory:ident) => {
        mod $module {
            use super::*;
            #[test]
            fn deletion_only_invalidates_with_unchanged_clocks() {
                let id = identity();
                deletion_case($factory(&id), id);
            }
            #[test]
            fn revision_survives_checkpoint_and_fresh_writer_restart() {
                let id = identity();
                restart_case($factory(&id), id);
            }
            #[test]
            fn unseen_committed_peer_is_a_later_event_not_a_global_lock() {
                let id = identity();
                later_events_case($factory(&id), id);
            }
            #[test]
            fn peer_deletion_invalidates_and_duplicate_delivery_is_idempotent() {
                let id = identity();
                peer_deletion_case($factory(&id), id);
            }
        }
    };
}
shared_cases!(memory_revisions, memory);
shared_cases!(fault_revisions, fault);

#[test]
fn wrong_document_epoch_and_profile_reject_even_with_identical_observed_structs() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let current = session.observed_revision().unwrap();
    let base = session.document().checkpoint();
    let mut document = id.clone();
    document.document_id = identity().document_id;
    let mut epoch = id.clone();
    epoch.epoch = "56789012-5678-4678-8678-567890123456".into();
    let profile = DocumentIdentity::v4(&id.document_id, &id.epoch).unwrap();
    for other in [document, epoch, profile] {
        // Test-only re-enveloped corpus isolates scope hashing from actual struct state.
        // This is not a migration API: production stores/engine envelopes reject mismatches.
        let mut checkpoint = base.clone();
        checkpoint.identity = other.clone();
        let foreign_store = memory(&other);
        foreign_store
            .publish(0, CheckpointRecord::new(checkpoint, vec![]).unwrap())
            .unwrap();
        let foreign = Session::open(foreign_store, &other, CachedPermission::LOCAL).unwrap();
        let token = foreign.observed_revision().unwrap();
        assert_eq!(
            &token.to_bytes()[33..],
            &current.to_bytes()[33..],
            "same clocks/deletions"
        );
        let before = session.document().checkpoint().bytes;
        assert_eq!(
            session
                .edit_text_if_revision(&token, &insertion(&session, "wrong"), &origin(), 0)
                .unwrap_err(),
            SessionError::Revision(RevisionError::ScopeMismatch)
        );
        assert_eq!(before, session.document().checkpoint().bytes);
        assert!(store.pending(&id).unwrap().is_empty());
    }
}

#[test]
fn two_prepared_proposals_serialize_comparison_before_mutation() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let expected = session.observed_revision().unwrap();
    let first = insertion(&session, "first-");
    let second = deletion(&session);
    session
        .edit_text_if_revision(&expected, &first, &origin(), 0)
        .unwrap();
    let before = session.document().checkpoint().bytes;
    stale(
        session
            .edit_text_if_revision(&expected, &second, &origin(), 0)
            .unwrap_err(),
    );
    assert_eq!(session.document().checkpoint().bytes, before);
    assert_eq!(store.recover(&id).unwrap().journal.len(), 1);
}

#[test]
fn noop_receipts_and_policy_do_not_change_revision_or_bypass_preconditions() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let expected = session.observed_revision().unwrap();
    assert!(
        session
            .edit_text_if_revision(&expected, &insertion(&session, ""), &origin(), 0)
            .unwrap()
            .is_none()
    );
    assert_eq!(session.observed_revision().unwrap(), expected);
    // A current revision does not override host permission or semantic anchor preconditions.
    session.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    assert_eq!(
        session
            .edit_text_if_revision(&expected, &insertion(&session, "denied"), &origin(), 0)
            .unwrap_err(),
        SessionError::ReadOnly
    );
    assert_eq!(
        session.undo_if_revision(&expected, 0).unwrap_err(),
        SessionError::ReadOnly
    );
    assert_eq!(
        session.redo_if_revision(&expected, 0).unwrap_err(),
        SessionError::ReadOnly
    );
    session.set_permission(CachedPermission {
        writable: true,
        expires_at: Some(5),
    });
    assert_eq!(
        session
            .edit_text_if_revision(&expected, &insertion(&session, "expired"), &origin(), 5)
            .unwrap_err(),
        SessionError::PermissionExpired
    );
    session.set_permission(CachedPermission::LOCAL);
    let other = support::document();
    let wrong_anchor = TextCommand::Insert {
        at: other
            .anchor(&owner(&other), Utf16Offset(0), Bias::Right)
            .unwrap(),
        text: "wrong".into(),
    };
    assert!(matches!(
        session.edit_text_if_revision(&expected, &wrong_anchor, &origin(), 0),
        Err(SessionError::Text(_))
    ));
    assert_eq!(session.observed_revision().unwrap(), expected);
    assert!(store.pending(&id).unwrap().is_empty());
    apply(&mut session, "saved-");
    let committed = session.observed_revision().unwrap();
    // A negotiated receipt changes durable outbox membership, not immutable observed state.
    let entry = store.pending(&id).unwrap().remove(0);
    store
        .accept_receipt(
            ReceiptCapability::DurableV1,
            DurableReceipt {
                protocol: ReceiptCapability::DurableV1,
                update: entry.id().clone(),
            },
        )
        .unwrap();
    session.recover().unwrap();
    assert_eq!(session.observed_revision().unwrap(), committed);
}

#[test]
fn guarded_history_invalidates_without_reviving_an_old_token() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store, id, &initial()).unwrap();
    let initial_token = session.observed_revision().unwrap();
    apply(&mut session, "history-");
    let edited = session.observed_revision().unwrap();
    stale(session.undo_if_revision(&initial_token, 0).unwrap_err());
    assert_eq!(text(session.document()), "history-abcdef");
    session.undo_if_revision(&edited, 0).unwrap().unwrap();
    let undone = session.observed_revision().unwrap();
    assert_eq!(text(session.document()), "abcdef");
    assert_ne!(
        undone, initial_token,
        "equal visible text is not equal CRDT state"
    );
    stale(session.redo_if_revision(&edited, 0).unwrap_err());
    session.redo_if_revision(&undone, 0).unwrap().unwrap();
    assert_eq!(text(session.document()), "history-abcdef");
    assert_ne!(session.observed_revision().unwrap(), edited);
}

#[test]
fn failed_commit_cannot_mint_or_use_a_revision_until_ordered_recovery() {
    for boundary in [FaultBoundary::BeforeWrite, FaultBoundary::AfterCommit] {
        let id = identity();
        let store = fault(&id);
        let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
        let token = session.observed_revision().unwrap();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(
            session
                .edit_text_if_revision(&token, &deletion(&session), &origin(), 0)
                .is_err()
        );
        assert_eq!(
            session.observed_revision().unwrap_err(),
            SessionError::RecoveryRequired
        );
        assert_eq!(
            session
                .edit_text_if_revision(&token, &insertion(&session, "blocked"), &origin(), 0)
                .unwrap_err(),
            SessionError::RecoveryRequired
        );
        assert!(!session.recovery_export().locally_committed);
        session.recover().unwrap();
        assert_eq!(store.recover(&id).unwrap().journal.len(), 1);
        let recovered = session.observed_revision().unwrap();
        assert_ne!(recovered, token);
        drop(session);
        let mut reopened = Session::open(store, &id, CachedPermission::LOCAL).unwrap();
        assert_eq!(reopened.observed_revision().unwrap(), recovered);
        stale(
            reopened
                .edit_text_if_revision(&token, &insertion(&reopened, "old"), &origin(), 0)
                .unwrap_err(),
        );
    }
}

#[test]
fn opaque_token_framing_and_altered_tokens_fail_before_mutation() {
    for bytes in [vec![], vec![1; 64], vec![1; 66], vec![2; 65]] {
        assert_eq!(
            ObservedRevision::from_bytes(&bytes),
            Err(RevisionError::InvalidToken)
        );
    }
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let expected = session.observed_revision().unwrap();
    assert_eq!(
        ObservedRevision::from_bytes(&expected.to_bytes()).unwrap(),
        expected
    );
    let mut bytes = expected.to_bytes();
    bytes[40] ^= 1;
    let changed = ObservedRevision::from_bytes(&bytes).unwrap();
    stale(
        session
            .edit_text_if_revision(&changed, &insertion(&session, "bad"), &origin(), 0)
            .unwrap_err(),
    );
    assert!(store.pending(&id).unwrap().is_empty());
    assert_eq!(session.observed_revision().unwrap(), expected);
}

#[cfg(feature = "native-store")]
fn native(id: &DocumentIdentity) -> Arc<editac_session::store::NativeStore> {
    let directory = std::path::PathBuf::from(
        std::env::var_os("EDITAC_REVISION_EVIDENCE")
            .expect("native revisions require a task-owned evidence directory"),
    );
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{}-{}.sqlite", std::process::id(), id.document_id));
    Arc::new(
        editac_session::store::NativeStore::create_new(path, id.clone(), StoreLimits::default())
            .unwrap(),
    )
}
#[cfg(feature = "native-store")]
shared_cases!(native_revisions, native);

#[cfg(feature = "native-store")]
mod native {
    use super::*;
    use editac_session::store::NativeStore;
    use std::{fs, path::PathBuf, process::Command};
    fn process_identity() -> DocumentIdentity {
        DocumentIdentity::v5(
            "67890123-6789-4789-8789-678901234567",
            "78901234-7890-4890-8890-789012345678",
        )
        .unwrap()
    }
    #[test]
    fn revision_process_child() {
        let Some(directory) = std::env::var_os("EDITAC_REVISION_CHILD") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let path = directory.join("restart.sqlite");
        let id = process_identity();
        if std::env::var("EDITAC_REVISION_PHASE").unwrap() == "create" {
            let store = Arc::new(
                NativeStore::create_new(&path, id.clone(), StoreLimits::default()).unwrap(),
            );
            let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
            fs::write(
                directory.join("initial.token"),
                session.observed_revision().unwrap().to_bytes(),
            )
            .unwrap();
            let vector = session.document().state_vector_v1();
            session
                .edit_text(&deletion(&session), &origin(), 0)
                .unwrap();
            assert_eq!(session.document().state_vector_v1(), vector);
            fs::write(
                directory.join("deleted.token"),
                session.observed_revision().unwrap().to_bytes(),
            )
            .unwrap();
            fs::write(
                directory.join("writer.txt"),
                session.document().writer_id().to_string(),
            )
            .unwrap();
            let recovery = store.recover(&id).unwrap();
            store
                .publish(
                    recovery.generation,
                    CheckpointRecord::new(
                        session.document().checkpoint(),
                        recovery.journal.iter().map(|e| e.id().clone()).collect(),
                    )
                    .unwrap(),
                )
                .unwrap();
            assert_eq!(
                session.state(0).local,
                LocalState::Committed(Durability::ProcessCrash)
            );
        } else {
            let store = Arc::new(
                NativeStore::open_existing(&path, id.clone(), StoreLimits::default()).unwrap(),
            );
            let mut session = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
            let persisted =
                ObservedRevision::from_bytes(&fs::read(directory.join("deleted.token")).unwrap())
                    .unwrap();
            let initial =
                ObservedRevision::from_bytes(&fs::read(directory.join("initial.token")).unwrap())
                    .unwrap();
            assert_eq!(session.observed_revision().unwrap(), persisted);
            assert_ne!(
                session.document().writer_id().to_string(),
                fs::read_to_string(directory.join("writer.txt")).unwrap()
            );
            assert_eq!(text(session.document()), "adef");
            stale(
                session
                    .edit_text_if_revision(&initial, &insertion(&session, "stale"), &origin(), 0)
                    .unwrap_err(),
            );
            session
                .edit_text_if_revision(&persisted, &insertion(&session, "new-"), &origin(), 0)
                .unwrap();
            assert_ne!(session.observed_revision().unwrap(), persisted);
            assert_eq!(store.recover(&id).unwrap().journal.len(), 2);
            fs::write(
                directory.join("reopened.token"),
                session.observed_revision().unwrap().to_bytes(),
            )
            .unwrap();
        }
    }
    #[test]
    fn actual_sqlite_process_restart_preserves_deleted_token_and_rejects_stale_proposal() {
        let directory = PathBuf::from(std::env::var_os("EDITAC_REVISION_EVIDENCE").unwrap())
            .join(format!("process-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        for phase in ["create", "reopen"] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "native::revision_process_child", "--nocapture"])
                .env("EDITAC_REVISION_CHILD", &directory)
                .env("EDITAC_REVISION_PHASE", phase)
                .output()
                .unwrap();
            fs::write(
                directory.join(format!("{phase}.stdout.log")),
                &output.stdout,
            )
            .unwrap();
            fs::write(
                directory.join(format!("{phase}.stderr.log")),
                &output.stderr,
            )
            .unwrap();
            assert!(
                output.status.success(),
                "{phase}: {}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
        assert_ne!(
            fs::read(directory.join("initial.token")).unwrap(),
            fs::read(directory.join("deleted.token")).unwrap()
        );
        assert_ne!(
            fs::read(directory.join("deleted.token")).unwrap(),
            fs::read(directory.join("reopened.token")).unwrap()
        );
    }
}
