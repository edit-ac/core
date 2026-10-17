//! AGT-1.4 / WCF-02: prepared commands through the real serialized Session owner.
//! All transports, clocks and failures are deterministic; no network or providers.
mod support;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{editor::EditorCommand, text::TextCommand},
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    edit_service::*,
    operations::HostActor,
    ports::{memory::*, *},
    receipts::*,
    session::*,
};
use std::sync::Arc;
use support::{origin, owner, text};
fn identity() -> DocumentIdentity {
    thread_local! { static ID: DocumentIdentity = {
        static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1000);
        let id=std::env::var("EDITAC_REQUEST_SCOPE").unwrap_or_else(|_| format!("12345678-1234-4234-8234-{:012x}",NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)));
        DocumentIdentity::v5(&id,"23456789-2345-4345-8345-23456789abcd").unwrap()
    }; }
    ID.with(Clone::clone)
}
fn actor() -> HostActor {
    HostActor::authenticated_by_host("agent-a").unwrap()
}
fn initial() -> Vec<InitialNode> {
    vec![InitialNode {
        kind: "block".into(),
        text: "base".into(),
    }]
}
fn service<S: SessionStore>(store: Arc<S>) -> EditService<Arc<S>> {
    EditService::new(
        Session::create_local(store, identity(), &initial()).unwrap(),
        HostPolicy::default(),
    )
}
fn memory() -> (
    Arc<FaultInjectedStore>,
    EditService<Arc<FaultInjectedStore>>,
) {
    let store = Arc::new(FaultInjectedStore::new(identity(), StoreLimits::default()).unwrap());
    let service = service(store.clone());
    (store, service)
}
fn proposal<S: SessionStore>(
    s: &EditService<S>,
    id: &str,
    value: &str,
    expires: u64,
) -> RequestProposal {
    let command = EditorCommand::Text(TextCommand::Insert {
        at: s
            .session()
            .document()
            .anchor(&owner(s.session().document()), Utf16Offset(0), Bias::Right)
            .unwrap(),
        text: value.into(),
    });
    let prepared = s
        .prepare_commands(
            &s.session().observed_revision().unwrap(),
            &[command],
            &origin(),
            0,
        )
        .unwrap();
    s.bind_request(prepared, &actor(), id, expires).unwrap()
}
fn apply<S: SessionStore>(s: &mut EditService<S>, p: RequestProposal) -> RequestReceipt {
    let token = p.token().clone();
    s.apply_request(&actor(), &token, Some(p), true, 1, false)
        .unwrap()
}
fn repeat<S: SessionStore>(s: &mut EditService<S>, token: &RequestToken) -> RequestReceipt {
    s.apply_request(&actor(), token, None, true, 1000, true)
        .unwrap()
}
#[test]
fn original_receipt_survives_expiry_revision_advance_and_readonly() {
    let (store, mut s) = memory();
    let p = proposal(&s, "one", "A", 10);
    let token = p.token().clone();
    let original = apply(&mut s, p);
    let p = proposal(&s, "human", "H", 10);
    apply(&mut s, p);
    s.set_policy(HostPolicy {
        writable: false,
        ..HostPolicy::default()
    });
    s.set_permission(CachedPermission {
        writable: false,
        expires_at: Some(2),
    });
    assert_eq!(repeat(&mut s, &token), original);
    assert_eq!(text(s.session().document()), "HAbase");
    assert_eq!(store.pending(&identity()).unwrap().len(), 2);
}
#[test]
fn same_id_changed_actual_payload_rejects_before_revision_check() {
    let (_, mut s) = memory();
    let original = proposal(&s, "one", "A", 10);
    let changed = proposal(&s, "one", "B", 10);
    let other = changed.token().clone();
    apply(&mut s, original);
    assert!(matches!(
        s.apply_request(&actor(), &other, Some(changed), true, 1, false),
        Err(RequestError::ChangedPayload)
    ));
    assert_eq!(text(s.session().document()), "Abase");
}
#[test]
fn existing_token_with_a_different_supplied_proposal_rejects() {
    let (_, mut s) = memory();
    let p = proposal(&s, "one", "A", 10);
    let token = p.token().clone();
    let changed = proposal(&s, "one", "B", 10);
    apply(&mut s, p);
    assert!(matches!(
        s.apply_request(&actor(), &token, Some(changed), true, 1000, false),
        Err(RequestError::ChangedPayload)
    ));
    assert_eq!(text(s.session().document()), "Abase");
}
#[test]
fn unauthorized_and_cross_actor_receipt_lookup_reject() {
    let (_, mut s) = memory();
    let p = proposal(&s, "one", "A", 10);
    let token = p.token().clone();
    apply(&mut s, p);
    let other = HostActor::authenticated_by_host("agent-b").unwrap();
    assert!(matches!(
        s.request_receipt(&actor(), &token, false),
        Err(RequestError::Unauthorized)
    ));
    assert!(matches!(
        s.request_receipt(&other, &token, true),
        Err(RequestError::Unauthorized)
    ));
    assert!(matches!(
        s.apply_request(&other, &token, None, true, 1, false),
        Err(RequestError::Unauthorized)
    ));
}
#[test]
fn same_id_is_actor_scoped() {
    let (store, mut s) = memory();
    let p = proposal(&s, "one", "A", 10);
    apply(&mut s, p);
    let other = HostActor::authenticated_by_host("agent-b").unwrap();
    assert!(
        store
            .request_record(&identity(), other.subject(), "one")
            .unwrap()
            .is_none()
    );
    let prepared = s
        .prepare_commands(
            &s.session().observed_revision().unwrap(),
            &[EditorCommand::Text(TextCommand::Insert {
                at: s
                    .session()
                    .document()
                    .anchor(&owner(s.session().document()), Utf16Offset(0), Bias::Right)
                    .unwrap(),
                text: "B".into(),
            })],
            &origin(),
            1,
        )
        .unwrap();
    let p = s.bind_request(prepared, &other, "one", 10).unwrap();
    let token = p.token().clone();
    s.apply_request(&other, &token, Some(p), true, 1, false)
        .unwrap();
    assert_eq!(text(s.session().document()), "BAbase");
    assert_eq!(store.pending(&identity()).unwrap().len(), 2);
}
#[test]
fn cross_document_and_epoch_tokens_are_not_authority() {
    let (_, s) = memory();
    let p = proposal(&s, "one", "A", 10);
    let token = p.token().clone();
    let mut id = identity();
    id.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let other = EditService::new(
        Session::create_local(store, id, &initial()).unwrap(),
        HostPolicy::default(),
    );
    assert!(matches!(
        other.request_receipt(&actor(), &token, true),
        Err(RequestError::Unauthorized)
    ));
}
#[test]
fn fresh_request_still_rechecks_readonly_stale_and_ownership() {
    let (_, mut s) = memory();
    let p = proposal(&s, "stale", "A", 10);
    let token = p.token().clone();
    let other = proposal(&s, "human", "H", 10);
    apply(&mut s, other);
    assert!(matches!(
        s.apply_request(&actor(), &token, Some(p), true, 1, false),
        Err(RequestError::Service(_))
    ));
    let p = proposal(&s, "readonly", "A", 10);
    let token = p.token().clone();
    s.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    assert!(matches!(
        s.apply_request(&actor(), &token, Some(p), true, 1, false),
        Err(RequestError::Service(_))
    ));
    assert_eq!(text(s.session().document()), "Hbase");
}
fn wcf_queue(expired: bool, cancelled: bool) {
    let (store, s) = memory();
    let p = proposal(&s, "queued", "A", 10);
    let token = p.token().clone();
    let queue = SerializedAdmission::new(s);
    let mut held = std::collections::VecDeque::from([p]);
    assert_eq!(held.len(), 1);
    assert!(store.pending(&identity()).unwrap().is_empty());
    // The host queue releases after the fixed clock/cancellation observation changes.
    let p = held.pop_front().unwrap();
    let result = queue.with(|s| {
        let result = s.apply_request(
            &actor(),
            &token,
            Some(p),
            true,
            if expired { 10 } else { 1 },
            cancelled,
        );
        assert!(if expired {
            matches!(result, Err(RequestError::Expired))
        } else {
            matches!(result, Err(RequestError::Cancelled))
        });
        assert_eq!(text(s.session().document()), "base");
        Ok(())
    });
    result.unwrap();
    assert!(store.pending(&identity()).unwrap().is_empty());
    assert!(
        store
            .request_record(&identity(), actor().subject(), "queued")
            .unwrap()
            .is_none()
    );
    eprintln!(
        "WCF-02 queued expired={expired} cancelled={cancelled} requests=1 effects=0 journal=0"
    );
}
#[test]
fn wcf02_expired_while_queued_has_zero_effects() {
    wcf_queue(true, false);
}
#[test]
fn wcf02_cancelled_while_queued_has_zero_effects() {
    wcf_queue(false, true);
}
#[test]
fn wcf02_response_lost_after_commit_resolves_original_identity() {
    let (store, mut s) = memory();
    let p = proposal(&s, "lost-response", "A", 10);
    let token = p.token().clone();
    let original = apply(&mut s, p);
    assert_eq!(repeat(&mut s, &token), original);
    assert_eq!(text(s.session().document()), "Abase");
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
    eprintln!("WCF-02 post-commit-timeout requests=2 effects=1 journal=1");
}
fn fault_case(boundary: FaultBoundary) {
    let (store, s) = memory();
    assert_fault_case(store, s, boundary, |store, fault| store.inject(fault));
}
fn assert_fault_case<S: SessionStore>(
    store: Arc<S>,
    mut s: EditService<Arc<S>>,
    boundary: FaultBoundary,
    inject: impl Fn(&S, InjectedFault) -> Result<(), PortError>,
) {
    let expected = s.session().observed_revision().unwrap();
    let human = proposal(&s, "human-blocked", "H", 10);
    let human_token = human.token().clone();
    let p = proposal(&s, "failure", "A", 10);
    let token = p.token().clone();
    inject(
        &store,
        InjectedFault {
            boundary,
            error: PortError::Unavailable,
        },
    )
    .unwrap();
    assert!(matches!(
        s.apply_request(&actor(), &token, Some(p), true, 1, false),
        Err(RequestError::Pending { .. })
    ));
    assert_eq!(s.session().state(1).readiness, Readiness::RecoveryRequired);
    assert_eq!(text(s.session().document()), "Abase");
    assert!(s.session().pending_updates().is_err());
    assert!(s.session().observed_revision().is_err());
    assert!(!s.session().recovery_export().locally_committed);
    // Every human/mutation and publication path is blocked on the same owner.
    assert!(s.undo(&expected, 1).is_err());
    assert!(
        s.apply_request(&actor(), &human_token, Some(human), true, 1, false)
            .is_err()
    );
    assert_eq!(text(s.session().document()), "Abase");
    assert!(s.flush_pending(1).is_err());
    assert!(s.session().sync_update(&[]).is_err());
    assert!(s.publish_checkpoint().is_err());
    let unjournaled = s.session().recovery_export().unjournaled.unwrap();
    assert!(s.receive_peer(unjournaled).is_err());
    let before = store.recover(&identity()).unwrap();
    let generation = before.generation;
    let checkpoint = before.checkpoint.clone(); // trusted durable snapshot contains no unjournaled bytes
    store.publish(generation, checkpoint).unwrap();
    let isolated = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(
        text(isolated.document()),
        if boundary == FaultBoundary::AfterCommit {
            "Abase"
        } else {
            "base"
        }
    );
    // State-vector resync cannot escape: the outbox gate denies it; recovery export is labeled.
    s.recover().unwrap();
    let receipt = repeat(&mut s, &token);
    assert_eq!(
        receipt.result.revision(),
        s.session().observed_revision().unwrap()
    );
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
    assert_eq!(text(s.session().document()), "Abase");
    eprintln!("AGT-1.4 fault={boundary:?} requests=2 effects=1 journal=1");
}
#[test]
fn before_write_failure_freezes_and_recovers_atomically() {
    fault_case(FaultBoundary::BeforeWrite);
}
#[test]
fn before_commit_failure_freezes_and_recovers_atomically() {
    fault_case(FaultBoundary::BeforeCommit);
}
#[test]
fn after_commit_unknown_freezes_and_recovers_original_receipt() {
    fault_case(FaultBoundary::AfterCommit);
}
#[test]
fn reopen_after_lost_ack_returns_original_result_without_a_proposal() {
    let (store, mut s) = memory();
    let p = proposal(&s, "restart", "A", 10);
    let token = p.token().clone();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::AfterCommit,
            error: PortError::Unavailable,
        })
        .unwrap();
    assert!(matches!(
        s.apply_request(&actor(), &token, Some(p), true, 1, false),
        Err(RequestError::Pending { .. })
    ));
    drop(s);
    let mut reopened = EditService::new(
        Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    let original = repeat(&mut reopened, &token);
    assert_eq!(repeat(&mut reopened, &token), original);
    assert_eq!(text(reopened.session().document()), "Abase");
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
}
#[test]
fn receipt_survives_checkpoint_and_state_vector_replay() {
    let (store, mut s) = memory();
    let p = proposal(&s, "checkpoint", "A", 10);
    let token = p.token().clone();
    let receipt = apply(&mut s, p);
    let recovery = store.recover(&identity()).unwrap();
    let checkpoint = CheckpointRecord::new(
        s.session().document().checkpoint(),
        recovery.journal.iter().map(|e| e.id().clone()).collect(),
    )
    .unwrap();
    store.publish(recovery.generation, checkpoint).unwrap();
    drop(s);
    let mut s = EditService::new(
        Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    assert_eq!(repeat(&mut s, &token), receipt);
    assert_eq!(text(s.session().document()), "Abase");
    let vector = s.session().document().state_vector_v1();
    let update = s.session().document().update_v1(&vector).unwrap();
    assert!(!update.is_empty());
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
}
#[test]
fn portable_retry_envelope_roundtrips_and_rejects_malformed_tokens() {
    let (_, s) = memory();
    let p = proposal(&s, "one", "A", 10);
    let bytes = p.token().to_bytes();
    assert_eq!(RequestToken::from_bytes(&bytes).unwrap(), *p.token());
    for cut in 0..bytes.len() {
        assert!(RequestToken::from_bytes(&bytes[..cut]).is_err());
    }
    let mut corrupt = bytes;
    corrupt[0] = 2;
    assert!(RequestToken::from_bytes(&corrupt).is_err());
}
#[test]
fn no_op_source_request_is_durably_receipted_without_a_journal_effect() {
    use editac_markdown::reconcile::SourceMode;
    let (store, mut s) = memory();
    let target = s
        .capture_source(
            "base",
            SourceMode::Literal,
            &[owner(s.session().document())],
            0,
        )
        .unwrap();
    let expected = s.session().observed_revision().unwrap();
    let prepared = s
        .prepare_source(&target, &expected, "base", &origin(), 0)
        .unwrap();
    let p = s.bind_request(prepared, &actor(), "noop", 10).unwrap();
    let token = p.token().clone();
    let result = apply(&mut s, p);
    assert!(result.result.update(&identity()).is_none());
    assert_eq!(result.result.revision(), expected);
    assert!(store.pending(&identity()).unwrap().is_empty());
    drop(s);
    let mut s = EditService::new(
        Session::open(store, &identity(), CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    assert_eq!(repeat(&mut s, &token), result);
}
#[test]
fn failed_ordered_recovery_keeps_pending_identity_and_barrier() {
    let (store, mut s) = memory();
    let p = proposal(&s, "pending", "A", 10);
    let token = p.token().clone();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    assert!(matches!(
        s.apply_request(&actor(), &token, Some(p), true, 1, false),
        Err(RequestError::Pending { .. })
    ));
    assert!(matches!(
        s.request_receipt(&actor(), &token, true),
        Err(RequestError::Pending { .. })
    ));
    assert!(s.session().recovery_export().request.is_some());
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeWrite,
            error: PortError::Unavailable,
        })
        .unwrap();
    assert!(s.recover().is_err());
    assert!(s.session().sync_update(&[]).is_err());
    assert!(s.publish_checkpoint().is_err());
    s.recover().unwrap();
    repeat(&mut s, &token);
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
    assert_eq!(text(s.session().document()), "Abase");
}
#[test]
fn request_capacity_never_evicts_a_retryable_receipt() {
    let store = Arc::new(
        MemoryStore::new(
            identity(),
            StoreLimits {
                max_records: 2,
                ..StoreLimits::default()
            },
        )
        .unwrap(),
    );
    let mut s = service(store.clone());
    let p = proposal(&s, "one", "A", 10);
    let token = p.token().clone();
    let result = apply(&mut s, p);
    let p = proposal(&s, "two", "B", 10);
    apply(&mut s, p);
    let p = proposal(&s, "three", "C", 10);
    let t = p.token().clone();
    assert!(matches!(
        s.apply_request(&actor(), &t, Some(p), true, 1, false),
        Err(RequestError::Pending { .. })
    ));
    assert_eq!(
        s.request_receipt(&actor(), &token, true).unwrap().unwrap(),
        result
    );
    assert_eq!(store.pending(&identity()).unwrap().len(), 2);
    assert!(s.session().pending_updates().is_err());
}
#[cfg(feature = "native-store")]
mod native {
    use super::*;
    use editac_session::store::{NativeStore, TransactionBoundary};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    fn directory(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::var_os("EDITAC_REQUEST_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("editac-request-replay"))
            .join(format!(
                "{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn sqlite_reopen_retains_exact_receipt_after_revision_advance() {
        let dir = directory("reopen");
        let path = dir.join("document.sqlite3");
        let store =
            Arc::new(NativeStore::create_new(&path, identity(), StoreLimits::default()).unwrap());
        let mut s = service(store.clone());
        let baseline = s.session().document().checkpoint();
        let vector = s.session().document().state_vector_v1();
        let p = proposal(&s, "durable", "A", 10);
        let token = p.token().clone();
        let original = apply(&mut s, p);
        assert_eq!(original.local, Durability::ProcessCrash);
        let p = proposal(&s, "later", "H", 10);
        apply(&mut s, p);
        s.publish_checkpoint().unwrap();
        let resync = s.session().sync_update(&vector).unwrap();
        let peer = editac_core::document::Document::restore(
            &identity(),
            &baseline,
            &[editac_core::document::ReplayUpdate {
                identity: identity(),
                bytes: resync,
            }],
        )
        .unwrap();
        assert_eq!(text(&peer), "HAbase");
        std::fs::write(dir.join("request-token.bin"), token.to_bytes()).unwrap();
        drop(s);
        drop(store);
        let store = Arc::new(
            NativeStore::open_existing(&path, identity(), StoreLimits::default()).unwrap(),
        );
        let mut s = EditService::new(
            Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap(),
            HostPolicy::default(),
        );
        let token =
            RequestToken::from_bytes(&std::fs::read(dir.join("request-token.bin")).unwrap())
                .unwrap();
        assert_eq!(repeat(&mut s, &token), original);
        assert_eq!(text(s.session().document()), "HAbase");
        assert_eq!(store.pending(&identity()).unwrap().len(), 2);
    }
    #[test]
    fn sqlite_failures_freeze_every_boundary_until_ordered_recovery() {
        let (_, seed) = memory();
        let seed_checkpoint = seed.session().document().checkpoint();
        drop(seed);
        for boundary in [
            FaultBoundary::BeforeWrite,
            FaultBoundary::BeforeCommit,
            FaultBoundary::AfterCommit,
        ] {
            let dir = directory("failure");
            let store = Arc::new(
                NativeStore::create_new(
                    dir.join("document.sqlite3"),
                    identity(),
                    StoreLimits::default(),
                )
                .unwrap(),
            );
            store
                .publish(
                    0,
                    CheckpointRecord::new(seed_checkpoint.clone(), vec![]).unwrap(),
                )
                .unwrap();
            let s = service(store.clone());
            assert_fault_case(store, s, boundary, |store, fault| store.inject_once(fault));
        }
    }
    #[test]
    fn process_crash_at_each_sqlite_boundary_never_duplicates_acknowledged_insert() {
        if let Some(path) = std::env::var_os("EDITAC_REQUEST_CRASH_DB") {
            let boundary = std::env::var("EDITAC_REQUEST_CRASH_BOUNDARY").unwrap();
            let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let enabled = armed.clone();
            let observed: editac_session::store::TransactionObserver = Arc::new(move |b| {
                if enabled.load(Ordering::SeqCst) && format!("{b:?}") == boundary {
                    std::process::exit(73)
                }
            });
            let store = Arc::new(
                NativeStore::open_existing_observed(
                    path,
                    identity(),
                    StoreLimits::default(),
                    Some(observed),
                )
                .unwrap(),
            );
            let mut s = EditService::new(
                Session::open(store, &identity(), CachedPermission::LOCAL).unwrap(),
                HostPolicy::default(),
            );
            let p = proposal(&s, "crash", "A", 10);
            armed.store(true, Ordering::SeqCst);
            apply(&mut s, p);
            panic!("crash boundary not reached");
        }
        let (_, seed) = memory();
        let seed_checkpoint = seed.session().document().checkpoint();
        drop(seed);
        for boundary in [
            TransactionBoundary::BeforeWrite,
            TransactionBoundary::BeforeCommit,
            TransactionBoundary::AfterCommit,
        ] {
            let dir = directory("crash");
            let path = dir.join("document.sqlite3");
            let store = Arc::new(
                NativeStore::create_new(&path, identity(), StoreLimits::default()).unwrap(),
            );
            store
                .publish(
                    0,
                    CheckpointRecord::new(seed_checkpoint.clone(), vec![]).unwrap(),
                )
                .unwrap();
            let s = service(store.clone());
            let p = proposal(&s, "crash", "A", 10);
            let token = p.token().clone();
            drop(p);
            drop(s);
            drop(store);
            let output=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","native::process_crash_at_each_sqlite_boundary_never_duplicates_acknowledged_insert","--nocapture"]).env("EDITAC_REQUEST_CRASH_DB",&path).env("EDITAC_REQUEST_SCOPE", &identity().document_id).env("EDITAC_REQUEST_CRASH_BOUNDARY",format!("{boundary:?}")).output().unwrap();
            std::fs::write(dir.join("child.stdout"), &output.stdout).unwrap();
            std::fs::write(dir.join("child.stderr"), &output.stderr).unwrap();
            assert_eq!(output.status.code(), Some(73));
            let store = Arc::new(
                NativeStore::open_existing(&path, identity(), StoreLimits::default()).unwrap(),
            );
            let mut s = EditService::new(
                Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap(),
                HostPolicy::default(),
            );
            if boundary == TransactionBoundary::AfterCommit {
                repeat(&mut s, &token);
            } else {
                assert!(s.request_receipt(&actor(), &token, true).unwrap().is_none());
                let p = proposal(&s, "crash", "A", 10);
                assert_eq!(p.token(), &token);
                apply(&mut s, p);
            }
            let result = repeat(&mut s, &token);
            assert_eq!(result.local, Durability::ProcessCrash);
            assert_eq!(text(s.session().document()), "Abase");
            assert_eq!(store.pending(&identity()).unwrap().len(), 1);
            let engine_commits = if boundary == TransactionBoundary::AfterCommit {
                1
            } else {
                2
            };
            eprintln!(
                "AGT-1.4 process-crash={boundary:?} apply-requests=3 engine-commits={engine_commits} retained-effects=1 journal=1 child-exit=73"
            );
        }
    }
}
