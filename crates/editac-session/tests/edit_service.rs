mod support;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{DocumentIdentity, InitialNode},
};
use editac_markdown::{
    optional::Codecs,
    reconcile::{Conflict, ConflictKind, SourceMode},
};
use editac_session::{
    edit_service::*,
    ports::{memory::*, *},
    revision::RevisionError,
    session::*,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use support::{origin, owner, text};
fn identity() -> DocumentIdentity {
    static NEXT: AtomicU64 = AtomicU64::new(100);
    DocumentIdentity::v5(
        &format!(
            "12345678-1234-4234-8234-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "23456789-2345-4345-8345-23456789abcd",
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
fn service<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) -> EditService<Arc<S>> {
    EditService::new(
        Session::create_local(store, id, &initial()).unwrap(),
        HostPolicy::default(),
    )
}
fn insert<S: SessionStore>(service: &EditService<S>, value: &str) -> EditorCommand {
    EditorCommand::Text(TextCommand::Insert {
        at: service
            .session()
            .document()
            .anchor(
                &owner(service.session().document()),
                Utf16Offset(0),
                Bias::Right,
            )
            .unwrap(),
        text: value.into(),
    })
}
fn prepare<S: SessionStore>(service: &EditService<S>, value: &str) -> PreparedEdit {
    service
        .prepare_commands(
            &service.session().observed_revision().unwrap(),
            &[insert(service, value)],
            &origin(),
            0,
        )
        .unwrap()
}
fn snapshot_text(snapshot: &editac_core::projection::Snapshot) -> String {
    snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .flat_map(|n| n.runs.iter().map(|r| r.text.clone()))
        .collect()
}
fn role_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut service = service(store.clone(), id.clone());
    // Exact same operation path; caller names carry no authenticated-actor promise.
    for role in ["human", "script", "adapter"] {
        let revision = service.read(0).unwrap().revision;
        let before = service.session().document().checkpoint().bytes;
        let pending = store.pending(&id).unwrap().len();
        let expected = format!("{role}-{}", text(service.session().document()));
        let plan = service
            .prepare_commands(
                &revision,
                &[insert(&service, &format!("{role}-"))],
                &TextOrigin::new(&format!("fixture:{role}")).unwrap(),
                0,
            )
            .unwrap();
        assert_eq!(snapshot_text(plan.preview()), expected);
        assert_eq!(service.session().document().checkpoint().bytes, before);
        assert_eq!(store.pending(&id).unwrap().len(), pending);
        let committed = service.apply(plan, 0).unwrap().unwrap();
        assert_eq!(
            service.local_receipt(&committed.update).unwrap(),
            Some(committed)
        );
        assert_eq!(text(service.session().document()), expected);
        assert_eq!(store.pending(&id).unwrap().len(), pending + 1);
    }
    let restored = Session::open(store, &id, CachedPermission::LOCAL).unwrap();
    assert_eq!(text(restored.document()), "adapter-script-human-abcdef");
}
fn source_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut service = service(store.clone(), id.clone());
    for mode in [SourceMode::Literal, SourceMode::Markdown(Codecs::default())] {
        let value = text(service.session().document());
        let base = if matches!(mode, SourceMode::Literal) {
            value.clone()
        } else {
            format!("{value}\n")
        };
        let proposed = format!("new-{base}");
        let target = service
            .capture_source(&base, mode, &[owner(service.session().document())], 0)
            .unwrap();
        let token = service.read(0).unwrap().revision;
        let plan = service
            .prepare_source(&target, &token, &proposed, &origin(), 0)
            .unwrap();
        assert_eq!(snapshot_text(plan.preview()), format!("new-{value}"));
        assert_eq!(text(service.session().document()), value);
        service.apply(plan, 0).unwrap().unwrap();
    }
    let restored = Session::open(store, &id, CachedPermission::LOCAL).unwrap();
    assert_eq!(text(restored.document()), "new-new-abcdef");
}
#[test]
fn memory_human_script_adapter_share_real_semantics_and_durability() {
    let id = identity();
    role_case(memory(&id), id);
}
#[test]
fn fault_adapter_human_script_adapter_share_same_cases() {
    let id = identity();
    role_case(
        Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap()),
        id,
    );
}
#[test]
fn memory_exact_markdown_and_literal_source_preview_apply_reopen() {
    let id = identity();
    source_case(memory(&id), id);
}
#[test]
fn fault_adapter_exact_source_cases() {
    let id = identity();
    source_case(
        Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap()),
        id,
    );
}
#[test]
fn current_readonly_host_policy_revokes_prepared_apply_and_history() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let plan = prepare(&service, "denied");
    let before = service.session().document().checkpoint().bytes;
    service.set_policy(HostPolicy {
        writable: false,
        ..HostPolicy::default()
    });
    assert!(matches!(
        service.apply(plan, 0),
        Err(ServiceError::ReadOnly)
    ));
    let token = service.read(0).unwrap().revision;
    assert!(!service.capabilities(0).can_apply);
    assert!(matches!(
        service.undo(&token, 0),
        Err(ServiceError::ReadOnly)
    ));
    assert!(matches!(
        service.redo(&token, 0),
        Err(ServiceError::ReadOnly)
    ));
    assert!(matches!(
        service.prepare_commands(&token, &[insert(&service, "x")], &origin(), 0),
        Err(ServiceError::ReadOnly)
    ));
    assert_eq!(service.session().document().checkpoint().bytes, before);
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn cached_readonly_and_expiry_rechecked_at_source_and_command_apply() {
    for source in [false, true] {
        for expired in [false, true] {
            let id = identity();
            let store = memory(&id);
            let mut service = service(store.clone(), id.clone());
            let token = service.read(0).unwrap().revision;
            let plan = if source {
                let target = service
                    .capture_source(
                        "abcdef\n",
                        SourceMode::Markdown(Codecs::default()),
                        &[owner(service.session().document())],
                        0,
                    )
                    .unwrap();
                service
                    .prepare_source(&target, &token, "changed\n", &origin(), 0)
                    .unwrap()
            } else {
                prepare(&service, "changed")
            };
            service.set_permission(CachedPermission {
                writable: expired,
                expires_at: Some(1),
            });
            assert!(matches!(
                service.apply(plan, 1),
                Err(ServiceError::Session(
                    SessionError::ReadOnly | SessionError::PermissionExpired
                ))
            ));
            assert_eq!(service.session().observed_revision().unwrap(), token);
            assert!(store.pending(&id).unwrap().is_empty());
        }
    }
}
#[test]
fn historical_view_and_reduced_limits_revoke_existing_plans() {
    for history in [false, true] {
        let id = identity();
        let store = memory(&id);
        let mut service = service(store.clone(), id.clone());
        let plan = prepare(&service, "x");
        service.set_policy(HostPolicy {
            history_view: history,
            max_input_bytes: 0,
            ..HostPolicy::default()
        });
        assert!(matches!(
            service.apply(plan, 0),
            Err(ServiceError::HistoryView | ServiceError::ResourceLimit)
        ));
        assert!(store.pending(&id).unwrap().is_empty());
        assert_eq!(text(service.session().document()), "abcdef");
    }
}
#[test]
fn deletion_only_change_invalidates_prepared_plan_without_clock_advance() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let plan = prepare(&service, "stale");
    let clocks = service.session().document().state_vector_v1();
    let token = service.read(0).unwrap().revision;
    let own = owner(service.session().document());
    let selection = service
        .session()
        .document()
        .selection(
            (&own, Utf16Offset(1), Bias::Left),
            (&own, Utf16Offset(3), Bias::Right),
        )
        .unwrap();
    let delete = service
        .prepare_commands(
            &token,
            &[EditorCommand::Text(TextCommand::Delete { selection })],
            &origin(),
            0,
        )
        .unwrap();
    service.apply(delete, 0).unwrap();
    assert_eq!(service.session().document().state_vector_v1(), clocks);
    assert!(matches!(
        service.apply(plan, 0),
        Err(ServiceError::Session(SessionError::Revision(
            RevisionError::Stale
        )))
    ));
    assert_eq!(text(service.session().document()), "adef");
    assert_eq!(store.pending(&id).unwrap().len(), 1);
}
#[test]
fn stale_source_is_recoverable_without_replacing_current_document() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let target = service
        .capture_source(
            "abcdef\n",
            SourceMode::Markdown(Codecs::default()),
            &[owner(service.session().document())],
            0,
        )
        .unwrap();
    let token = service.read(0).unwrap().revision;
    let at = service
        .session()
        .document()
        .anchor(
            &owner(service.session().document()),
            Utf16Offset(3),
            Bias::Right,
        )
        .unwrap();
    let plan = service
        .prepare_commands(
            &token,
            &[EditorCommand::Text(TextCommand::Insert {
                at,
                text: "overlap-".into(),
            })],
            &origin(),
            0,
        )
        .unwrap();
    service.apply(plan, 0).unwrap();
    let token = service.read(0).unwrap().revision;
    let before = service.session().document().checkpoint().bytes;
    match service.prepare_source(&target, &token, "replaced\n", &origin(), 0) {
        Err(ServiceError::SourceConflict {
            conflict,
            base,
            proposed,
            current,
        }) => {
            assert_eq!(conflict.kind, ConflictKind::Overlap);
            assert_eq!(base, "abcdef\n");
            assert_eq!(proposed, "replaced\n");
            assert_eq!(snapshot_text(&current), "abcoverlap-def");
        }
        _ => panic!("expected recoverable overlap"),
    }
    assert_eq!(service.session().document().checkpoint().bytes, before);
    assert_eq!(store.pending(&id).unwrap().len(), 1);
}
#[test]
fn ambiguous_source_mapping_and_wrong_document_anchor_fail_atomically() {
    let id = identity();
    let store = memory(&id);
    let service = service(store.clone(), id.clone());
    let token = service.read(0).unwrap().revision;
    assert!(matches!(
        service.capture_source("abcdef\n", SourceMode::Markdown(Codecs::default()), &[], 0),
        Err(ServiceError::SourceConflict {
            conflict: Conflict {
                kind: ConflictKind::AmbiguousMapping,
                ..
            },
            ..
        })
    ));
    let other_id = identity();
    let other = crate::service(memory(&other_id), other_id);
    assert!(matches!(
        service.prepare_commands(
            &token,
            &[insert(&service, "first"), insert(&other, "wrong")],
            &origin(),
            0
        ),
        Err(ServiceError::Engine(_))
    ));
    assert_eq!(text(service.session().document()), "abcdef");
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn wrong_revision_identity_and_wrong_replica_plan_fail_before_mutation() {
    let id = identity();
    let store = memory(&id);
    let service = service(store.clone(), id.clone());
    let plan = prepare(&service, "x");
    let other_id = identity();
    let other = crate::service(memory(&other_id), other_id);
    let wrong = other.read(0).unwrap().revision;
    assert!(matches!(
        service.prepare_commands(&wrong, &[insert(&service, "x")], &origin(), 0),
        Err(ServiceError::Session(SessionError::Revision(_)))
    ));
    let mut other = EditService::new(
        Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    assert!(matches!(other.apply(plan, 0), Err(ServiceError::Engine(_))));
    assert_eq!(text(other.session().document()), "abcdef");
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn unsupported_content_modules_and_source_codecs_reject_then_recheck_apply() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let token = service.read(0).unwrap().revision;
    let command = EditorCommand::Content {
        target: owner(service.session().document()),
        content: editac_core::modules::content::Content::Image {
            url: "https://example.test/a.png".into(),
            alt: "a".into(),
            title: String::new(),
            source: "![a](https://example.test/a.png)".into(),
        },
    };
    assert!(matches!(
        service.prepare_commands(&token, &[command], &origin(), 0),
        Err(ServiceError::UnsupportedModule)
    ));
    let mode = SourceMode::Markdown(Codecs {
        images: true,
        ..Codecs::default()
    });
    assert!(matches!(
        service.capture_source("abcdef\n", mode, &[owner(service.session().document())], 0),
        Err(ServiceError::UnsupportedModule)
    ));
    service.set_policy(HostPolicy {
        codecs: Codecs {
            images: true,
            ..Codecs::default()
        },
        ..HostPolicy::default()
    });
    let target = service
        .capture_source("abcdef\n", mode, &[owner(service.session().document())], 0)
        .unwrap();
    let plan = service
        .prepare_source(&target, &token, "new\n", &origin(), 0)
        .unwrap();
    service.set_policy(HostPolicy::default());
    assert!(matches!(
        service.apply(plan, 0),
        Err(ServiceError::UnsupportedModule)
    ));
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn command_count_and_source_size_limits_precede_mutation() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    service.set_policy(HostPolicy {
        max_commands: 0,
        max_input_bytes: 3,
        ..HostPolicy::default()
    });
    let token = service.read(0).unwrap().revision;
    assert!(matches!(
        service.prepare_commands(&token, &[insert(&service, "x")], &origin(), 0),
        Err(ServiceError::ResourceLimit)
    ));
    assert!(matches!(
        service.capture_source(
            "abcdef",
            SourceMode::Literal,
            &[owner(service.session().document())],
            0
        ),
        Err(ServiceError::ResourceLimit)
    ));
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn source_noop_leaves_revision_history_and_store_unchanged() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let token = service.read(0).unwrap().revision;
    let target = service
        .capture_source(
            "abcdef\n",
            SourceMode::Markdown(Codecs::default()),
            &[owner(service.session().document())],
            0,
        )
        .unwrap();
    let plan = service
        .prepare_source(&target, &token, "abcdef\n", &origin(), 0)
        .unwrap();
    assert!(service.apply(plan, 0).unwrap().is_none());
    assert_eq!(service.read(0).unwrap().revision, token);
    assert_eq!(service.session().document().history_state().undo_groups, 0);
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn service_undo_redo_use_expected_revision_and_durable_session_history() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let old = service.read(0).unwrap().revision;
    let plan = prepare(&service, "history-");
    service.apply(plan, 0).unwrap();
    assert!(matches!(
        service.undo(&old, 0),
        Err(ServiceError::Session(SessionError::Revision(
            RevisionError::Stale
        )))
    ));
    let token = service.read(0).unwrap().revision;
    service.undo(&token, 0).unwrap().unwrap();
    assert_eq!(text(service.session().document()), "abcdef");
    let token = service.read(0).unwrap().revision;
    service.redo(&token, 0).unwrap().unwrap();
    assert_eq!(
        text(
            Session::open(store, &id, CachedPermission::LOCAL)
                .unwrap()
                .document()
        ),
        "history-abcdef"
    );
}
#[test]
fn failed_prepared_commit_freezes_admission_until_ordered_recovery() {
    for boundary in [FaultBoundary::BeforeWrite, FaultBoundary::AfterCommit] {
        let id = identity();
        let store = Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap());
        let mut service = service(store.clone(), id.clone());
        let first = prepare(&service, "retained-");
        let second = prepare(&service, "blocked-");
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(service.apply(first, 0).is_err());
        assert!(matches!(
            service.apply(second, 0),
            Err(ServiceError::Session(SessionError::RecoveryRequired))
        ));
        assert!(!service.capabilities(0).can_apply);
        assert!(!service.session().recovery_export().locally_committed);
        service.recover().unwrap();
        assert!(service.capabilities(0).can_apply);
        assert_eq!(store.pending(&id).unwrap().len(), 1);
        assert_eq!(
            text(
                Session::open(store, &id, CachedPermission::LOCAL)
                    .unwrap()
                    .document()
            ),
            "retained-abcdef"
        );
    }
}
#[cfg(feature = "native-store")]
fn native(id: &DocumentIdentity) -> Arc<editac_session::store::NativeStore> {
    let dir = std::path::PathBuf::from(
        std::env::var_os("EDITAC_SERVICE_EVIDENCE").expect("task-owned directory required"),
    );
    std::fs::create_dir_all(&dir).unwrap();
    Arc::new(
        editac_session::store::NativeStore::create_new(
            dir.join(format!("{}-{}.sqlite", std::process::id(), id.document_id)),
            id.clone(),
            StoreLimits::default(),
        )
        .unwrap(),
    )
}
#[cfg(feature = "native-store")]
#[test]
fn native_human_script_adapter_share_identical_durable_cases() {
    let id = identity();
    role_case(native(&id), id);
}
#[cfg(feature = "native-store")]
#[test]
fn native_markdown_literal_reopen_share_identical_source_cases() {
    let id = identity();
    source_case(native(&id), id);
}
#[test]
fn unresolved_cross_owner_range_cannot_partially_apply_earlier_command() {
    let id = identity();
    let store = memory(&id);
    let session = Session::create_local(
        store.clone(),
        id.clone(),
        &[
            InitialNode {
                kind: "block".into(),
                text: "one".into(),
            },
            InitialNode {
                kind: "block".into(),
                text: "two".into(),
            },
        ],
    )
    .unwrap();
    let service = EditService::new(session, HostPolicy::default());
    let snapshot = service.read(0).unwrap();
    let owners: Vec<_> = snapshot
        .snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.id.clone())
        .collect();
    let selection = service
        .session()
        .document()
        .selection(
            (&owners[0], Utf16Offset(1), Bias::Left),
            (&owners[1], Utf16Offset(1), Bias::Right),
        )
        .unwrap();
    let commands = [
        insert(&service, "partial"),
        EditorCommand::Text(TextCommand::Replace {
            selection,
            text: "ambiguous".into(),
        }),
    ];
    assert!(matches!(
        service.prepare_commands(&snapshot.revision, &commands, &origin(), 0),
        Err(ServiceError::Engine(_))
    ));
    assert_eq!(text(service.session().document()), "onetwo");
    assert!(store.pending(&id).unwrap().is_empty());
}
#[cfg(feature = "native-store")]
#[test]
fn native_failed_source_commit_freezes_and_recovers_before_real_connection_reopen() {
    for boundary in [FaultBoundary::BeforeCommit, FaultBoundary::AfterCommit] {
        let id = identity();
        let store = native(&id);
        let mut service = service(store.clone(), id.clone());
        let token = service.read(0).unwrap().revision;
        let target = service
            .capture_source(
                "abcdef\n",
                SourceMode::Markdown(Codecs::default()),
                &[owner(service.session().document())],
                0,
            )
            .unwrap();
        let first = service
            .prepare_source(&target, &token, "native-retained\n", &origin(), 0)
            .unwrap();
        let second = prepare(&service, "blocked");
        store
            .inject_once(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(service.apply(first, 0).is_err());
        assert!(matches!(
            service.apply(second, 0),
            Err(ServiceError::Session(SessionError::RecoveryRequired))
        ));
        service.recover().unwrap();
        let path = store.path().to_owned();
        drop(service);
        drop(store);
        let reopened = Arc::new(
            editac_session::store::NativeStore::open_existing(
                path,
                id.clone(),
                StoreLimits::default(),
            )
            .unwrap(),
        );
        assert_eq!(
            text(
                Session::open(reopened.clone(), &id, CachedPermission::LOCAL)
                    .unwrap()
                    .document()
            ),
            "native-retained"
        );
        assert_eq!(reopened.pending(&id).unwrap().len(), 1);
    }
}
#[test]
fn coalesced_observation_and_exact_local_receipt_do_not_claim_remote_commit() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store, id.clone());
    let before = service.read(0).unwrap().revision;
    assert!(service.observe(&before, 0).unwrap().is_none());
    let plan = prepare(&service, "observed-");
    let committed = service.apply(plan, 0).unwrap().unwrap();
    let observed = service.observe(&before, 0).unwrap().unwrap();
    assert_eq!(snapshot_text(&observed.snapshot), "observed-abcdef");
    assert_eq!(observed.state.remote, RemoteState::Unknown);
    assert_eq!(
        service.local_receipt(&committed.update).unwrap(),
        Some(committed.clone())
    );
    let mut unknown = committed.update.clone();
    unknown.checksum[0] ^= 1;
    assert!(service.local_receipt(&unknown).unwrap().is_none());
    unknown.identity = identity();
    assert!(matches!(
        service.local_receipt(&unknown),
        Err(ServiceError::Session(SessionError::Incompatible))
    ));
}
#[test]
fn unsupported_profile_rejects_session_before_service_can_claim_capabilities() {
    let id = DocumentIdentity::v1(
        "34567890-3456-4456-8456-345678901234",
        "45678901-4567-4567-8567-456789012345",
    )
    .unwrap();
    let store = memory(&id);
    assert!(matches!(
        Session::create_local(store.clone(), id.clone(), &initial()),
        Err(SessionError::History(
            editac_core::history::HistoryError::UnsupportedProfile
        ))
    ));
    assert!(store.pending(&id).unwrap().is_empty());
}
#[test]
fn history_cannot_bypass_revoked_modules_or_reduced_limits() {
    for module in [false, true] {
        let id = identity();
        let store = memory(&id);
        let mut service = service(store.clone(), id.clone());
        let policy = HostPolicy {
            codecs: Codecs {
                images: true,
                ..Codecs::default()
            },
            ..HostPolicy::default()
        };
        service.set_policy(policy);
        let token = service.read(0).unwrap().revision;
        let target = service
            .capture_source(
                "abcdef\n",
                SourceMode::Markdown(policy.codecs),
                &[owner(service.session().document())],
                0,
            )
            .unwrap();
        let plan = service
            .prepare_source(&target, &token, "new\n", &origin(), 0)
            .unwrap();
        service.apply(plan, 0).unwrap();
        service.set_policy(if module {
            HostPolicy::default()
        } else {
            HostPolicy {
                max_input_bytes: 0,
                ..policy
            }
        });
        let token = service.read(0).unwrap().revision;
        assert!(!service.capabilities(0).can_history);
        assert!(matches!(
            service.undo(&token, 0),
            Err(ServiceError::ResourceLimit | ServiceError::UnsupportedModule)
        ));
        assert!(matches!(
            service.redo(&token, 0),
            Err(ServiceError::ResourceLimit | ServiceError::UnsupportedModule)
        ));
        assert_eq!(text(service.session().document()), "new");
        assert_eq!(store.pending(&id).unwrap().len(), 1);
        service.set_policy(policy);
        assert!(service.capabilities(0).can_history);
        service.undo(&token, 0).unwrap().unwrap();
        assert_eq!(text(service.session().document()), "abcdef");
    }
}
#[test]
fn preexisting_unqualified_history_never_silently_bypasses_host_caps() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store, id, &initial()).unwrap();
    let at = session
        .document()
        .anchor(&owner(session.document()), Utf16Offset(0), Bias::Right)
        .unwrap();
    session
        .edit_text(
            &TextCommand::Insert {
                at,
                text: "old-".into(),
            },
            &origin(),
            0,
        )
        .unwrap();
    let mut service = EditService::new(session, HostPolicy::default());
    let token = service.read(0).unwrap().revision;
    assert!(!service.capabilities(0).can_history);
    assert!(matches!(
        service.undo(&token, 0),
        Err(ServiceError::UnqualifiedHistory)
    ));
    assert_eq!(text(service.session().document()), "old-abcdef");
}

// Host lifecycle forwarding must preserve the live replica and origin-aware history.
fn lifecycle_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut service = service(store.clone(), id.clone());
    let replica = service.session().document() as *const _;
    let plan = prepare(&service, "local-");
    let commit = service.apply(plan, 0).unwrap().unwrap();
    let pending = store.pending(&id).unwrap();
    let history = service.session().document().history_state();
    let attach = |service: &mut EditService<Arc<S>>| {
        service
            .attach_transport(
                Box::new(
                    PreparedTransport::new(
                        id.clone(),
                        ConnectionState::Authorized,
                        TransportCapabilities {
                            receipts: ReceiptCapability::DurableV1,
                            max_frame_bytes: 1_048_576,
                            max_queue_bytes: 1_048_576,
                            max_queue_frames: 100,
                        },
                    )
                    .unwrap(),
                ),
                100,
                0,
            )
            .unwrap();
    };
    attach(&mut service);
    assert_eq!(service.flush_pending(0).unwrap(), pending.len());
    assert_eq!(
        service.read(0).unwrap().state.remote,
        RemoteState::SentDurabilityUnknown
    );
    service.detach_transport();
    let receipt = DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: commit.update,
    };
    assert!(service.accept_receipt(receipt.clone(), 0).is_err());
    assert_eq!(
        store
            .pending(&id)
            .unwrap()
            .iter()
            .map(|e| e.id())
            .collect::<Vec<_>>(),
        pending.iter().map(|e| e.id()).collect::<Vec<_>>()
    );
    attach(&mut service);
    for entry in &pending {
        let receipt = DurableReceipt {
            protocol: ReceiptCapability::DurableV1,
            update: entry.id().clone(),
        };
        assert_eq!(
            service.accept_receipt(receipt.clone(), 0).unwrap(),
            ReceiptResult::RemoteCommitted
        );
        assert_eq!(
            service.accept_receipt(receipt, 0).unwrap(),
            ReceiptResult::RemoteCommitted
        );
    }
    assert!(store.pending(&id).unwrap().is_empty());
    assert_eq!(
        service.read(0).unwrap().state.remote,
        RemoteState::RemotelyCommitted
    );
    assert_eq!(service.session().document().history_state(), history);
    assert_eq!(service.session().document() as *const _, replica);
    assert_eq!(text(service.session().document()), "local-abcdef");
}
#[test]
fn memory_service_lifecycle_preserves_replica_history_and_receipt_barrier() {
    let id = identity();
    lifecycle_case(memory(&id), id);
}
#[cfg(feature = "native-store")]
#[test]
fn native_service_lifecycle_preserves_replica_history_and_receipt_barrier() {
    let id = identity();
    lifecycle_case(native(&id), id);
}

// SFR-1.3: both original RCH-1.23 fingerprints through real SQLite Session admission.
#[cfg(feature = "native-store")]
fn registered_fragment_case(kind: u8) {
    let atomic = kind != 0;
    use editac_core::{interchange, modules::registry::Registry};
    use serde_json::json;
    let id = identity();
    let store = native(&id);
    let session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let mut registry = Registry::default();
    registry.register(&serde_json::from_value(json!({"type":"editac.math","version":1,"kind":"inline-atom","attributes":{"latex":{"type":"string","required":true,"maxUtf16":64},"display":{"type":"boolean","required":true}},"content":{"type":"text","maxUtf16":128},"fallback":{"type":"text","source":"content"}})).unwrap()).unwrap();
    let policy = HostPolicy {
        references: true,
        extensions: true,
        ..HostPolicy::default()
    };
    let mut service = EditService::with_registry(session, policy.clone(), registry.freeze());
    let input = match kind {
        1 => {
            json!([{"attributes":{"type":"content","tuple":["module:editac.reference",1,{"targetId":"host:opaque","label":"label"}]},"runs":[{"text":"label","marks":[{"mark":"bold"}]}]}])
        }
        2 => {
            let corpus: serde_json::Value = serde_json::from_str(include_str!(
                "../../../fixtures/rich-presenters/formatting/mixed-extensions.json"
            ))
            .unwrap();
            let mut block = corpus["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == "file-caption-bold")
                .unwrap()["envelope"]["payload"][0]
                .clone();
            block["runs"][0]["marks"] = json!([{"mark":"bold"}]);
            json!([block])
        }
        3 => {
            json!([{"attributes":{"type":"content","tuple":["module:editac.inert-extension",1,{"version":1,"type":"vendor.atom","dataVersion":7,"source":"opaque 😀 source","payload":{"identity":"stable:atom","data":[true,42]}}]},"runs":[{"text":"opaque 😀 source","marks":[{"mark":"bold"}],"opaqueMarks":[{"key":"vendor-note","value":{"exact":true}}]}]}])
        }
        _ => {
            json!([{"attributes":{"type":"paragraph"},"runs":[{"text":"LaTeX source: x^2","marks":[{"mark":"bold"}],"attributes":{"module:editac.math":[1,{"latex":"x^2","display":false}]}}]}])
        }
    };
    let blocks = interchange::transfer_blocks(serde_json::from_value(input).unwrap()).unwrap();
    let doc = service.session().document();
    let selection = doc
        .selection(
            (&owner(doc), Utf16Offset(0), Bias::Right),
            (&owner(doc), Utf16Offset(6), Bias::Left),
        )
        .unwrap();
    let revision = service.read(0).unwrap().revision;
    let baseline = doc.checkpoint().bytes;
    let plan = service
        .prepare_fragment(&revision, &selection, &blocks, &origin(), 0)
        .unwrap();
    assert_eq!(service.session().document().checkpoint().bytes, baseline);
    // Dropping a prepared edit is cancellation; no journal, history or checkpoint drift.
    drop(plan);
    assert!(store.pending(&id).unwrap().is_empty());
    assert_eq!(service.session().document().history_state().undo_groups, 0);
    let plan = service
        .prepare_fragment(&revision, &selection, &blocks, &origin(), 0)
        .unwrap();
    // Permission revocation is rechecked at application, including registered tuples.
    let mut denied = policy.clone();
    match kind {
        1 => denied.references = false,
        3 => denied.writable = false,
        _ => denied.extensions = false,
    };
    service.set_policy(denied);
    assert!(service.apply(plan, 0).is_err());
    assert_eq!(service.session().document().checkpoint().bytes, baseline);
    assert!(store.pending(&id).unwrap().is_empty());
    service.set_policy(policy);
    if !atomic {
        let mut bad = blocks.clone();
        bad[0].runs[0].opaque_marks[0].1 =
            serde_json::from_value(json!([1,{"latex":42,"display":false}])).unwrap();
        assert!(
            service
                .prepare_fragment(&revision, &selection, &bad, &origin(), 0)
                .is_err()
        );
        assert_eq!(service.session().document().checkpoint().bytes, baseline);
    }
    let stale = service
        .prepare_fragment(&revision, &selection, &blocks, &origin(), 0)
        .unwrap();
    let plan = service
        .prepare_fragment(&revision, &selection, &blocks, &origin(), 0)
        .unwrap();
    service.apply(plan, 0).unwrap().unwrap();
    let committed = service.session().document().checkpoint().bytes;
    assert!(service.apply(stale, 0).is_err());
    assert_eq!(service.session().document().checkpoint().bytes, committed);
    assert_eq!(service.session().document().history_state().undo_groups, 1);
    assert_eq!(store.pending(&id).unwrap().len(), 1);
    let projection = |d: &editac_core::document::Document| {
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .filter(|n| n.kind == "block")
            .map(|n| interchange::transfer_value(&d.fragment_for_node(&n.id).unwrap()))
            .collect::<Vec<_>>()
    };
    let expected = projection(service.session().document());
    let imported = service
        .session()
        .document()
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.runs.iter().any(|r| r.text == blocks[0].runs[0].text))
        .unwrap();
    let fragment = service
        .session()
        .document()
        .fragment_for_node(&imported.id)
        .unwrap();
    assert_eq!(
        interchange::transfer_value(&fragment),
        interchange::transfer_value(&blocks[0])
    );
    let recovered = editac_markdown::export::export(&[fragment]);
    assert!(!recovered.diagnostics.is_empty());
    assert!(!recovered.recovery.is_empty());
    let rev = service.read(0).unwrap().revision;
    service.undo(&rev, 0).unwrap();
    assert_eq!(text(service.session().document()), "abcdef");
    let rev = service.read(0).unwrap().revision;
    service.redo(&rev, 0).unwrap();
    assert_eq!(projection(service.session().document()), expected);
    let doc = service.session().document();
    let partial = doc
        .selection(
            (&imported.id, Utf16Offset(1), Bias::Right),
            (&imported.id, Utf16Offset(2), Bias::Left),
        )
        .unwrap();
    if atomic {
        assert!(editac_core::transfer::range_blocks(doc, &partial).is_err());
    }
    let path = store.path().to_owned();
    drop(service);
    drop(store);
    let reopened_store = Arc::new(
        editac_session::store::NativeStore::open_existing(path, id.clone(), StoreLimits::default())
            .unwrap(),
    );
    let reopened = Session::open(reopened_store, &id, CachedPermission::LOCAL).unwrap();
    assert_eq!(reopened.document().identity(), &id);
    assert_eq!(projection(reopened.document()), expected);
}
#[cfg(feature = "native-store")]
#[test]
fn registered_inline_math_tuple_sqlite_transfer() {
    registered_fragment_case(0);
}
#[cfg(feature = "native-store")]
#[test]
fn marked_atomic_reference_label_sqlite_transfer() {
    registered_fragment_case(1);
}

#[cfg(feature = "native-store")]
#[test]
fn marked_atomic_asset_fallback_sqlite_transfer() {
    registered_fragment_case(2);
}
#[cfg(feature = "native-store")]
#[test]
fn marked_atomic_inert_source_sqlite_transfer() {
    registered_fragment_case(3);
}

#[test]
fn command_preview_reuses_exact_new_source_identity_and_one_durable_history_group() {
    let id = identity();
    let store = memory(&id);
    let mut service = service(store.clone(), id.clone());
    let before = service.read(0).unwrap();
    let node = owner(service.session().document());
    let at = service
        .session()
        .document()
        .anchor(&node, Utf16Offset(3), Bias::Right)
        .unwrap();
    let bytes = service.session().document().checkpoint().bytes;
    let plan = service
        .prepare_commands(
            &before.revision,
            &[EditorCommand::Split { owner: node, at }],
            &origin(),
            0,
        )
        .unwrap();
    let preview = plan.preview().clone();
    assert_eq!(
        preview
            .visible
            .iter()
            .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect::<String>())
            .collect::<Vec<_>>(),
        ["abc", "def"]
    );
    assert_eq!(bytes, service.session().document().checkpoint().bytes);
    assert!(store.pending(&id).unwrap().is_empty());
    let receipt = service.apply(plan, 0).unwrap().unwrap();
    let after = service.read(0).unwrap();
    assert_eq!(preview.visible, after.snapshot.visible);
    assert_eq!(preview.recovery, after.snapshot.recovery);
    assert_eq!(
        preview.retained_structure,
        after.snapshot.retained_structure
    );
    assert_eq!(store.pending(&id).unwrap().len(), 1);
    assert_eq!(
        service.local_receipt(&receipt.update).unwrap(),
        Some(receipt)
    );
    assert_eq!(service.session().document().history_state().undo_groups, 1);
}
