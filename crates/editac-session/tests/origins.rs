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
use editac_session::{
    edit_service::*,
    operations::*,
    ports::{memory::*, *},
    session::*,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use support::{owner, text};
fn identity() -> DocumentIdentity {
    static NEXT: AtomicU64 = AtomicU64::new(900);
    DocumentIdentity::v5(
        &format!(
            "12345678-1234-4234-8234-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
fn service<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) -> EditService<Arc<S>> {
    EditService::new(
        Session::create_local(
            store,
            id,
            &[InitialNode {
                kind: "block".into(),
                text: "base".into(),
            }],
        )
        .unwrap(),
        HostPolicy::default(),
    )
}
fn memory() -> EditService<Arc<MemoryStore>> {
    let id = identity();
    service(
        Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap()),
        id,
    )
}
fn prepare<S: SessionStore>(s: &EditService<S>, value: &str) -> PreparedEdit {
    s.prepare_commands(
        &s.read(0).unwrap().revision,
        &[EditorCommand::Text(TextCommand::Insert {
            at: s
                .session()
                .document()
                .anchor(&owner(s.session().document()), Utf16Offset(0), Bias::Right)
                .unwrap(),
            text: value.into(),
        })],
        &TextOrigin::new("human:administrator:replica-123").unwrap(),
        0,
    )
    .unwrap()
}
fn host(origin: OperationOrigin) -> HostOperation {
    HostOperation {
        actor: Some(HostActor::authenticated_by_host("host:verified-subject").unwrap()),
        origin,
        request_id: "untrusted-correlation-name".into(),
    }
}
fn apply<S: SessionStore>(s: &mut EditService<S>, value: &str, origin: OperationOrigin) {
    let before = s.read(0).unwrap().revision;
    let plan = prepare(s, value);
    let commit = s.apply_as(plan, host(origin), 0).unwrap().unwrap();
    let record = s.operations().back().unwrap();
    assert_eq!(record.before, before);
    assert_eq!(record.after, s.read(0).unwrap().revision);
    assert_ne!(record.before, record.after);
    assert!(
        matches!(&record.outcome, OperationOutcome::LocalCommit(c) if c.update == commit.update)
    );
    assert_eq!(record.origin, origin);
    assert_eq!(
        record.actor.as_ref().unwrap().subject(),
        "host:verified-subject"
    );
}
fn groups<S: SessionStore>(s: &mut EditService<S>) {
    let origins = [
        OperationOrigin::Human,
        OperationOrigin::Agent,
        OperationOrigin::OtherHuman,
        OperationOrigin::Import,
        OperationOrigin::Replay,
        OperationOrigin::Human,
    ];
    for (i, origin) in origins.into_iter().enumerate() {
        apply(s, &i.to_string(), origin);
        assert_eq!(s.session().document().history_state().undo_groups, i + 1);
    }
    assert_eq!(text(s.session().document()), "543210base");
    for expected in [
        "43210base",
        "3210base",
        "210base",
        "10base",
        "0base",
        "base",
    ] {
        let token = s.read(0).unwrap().revision;
        s.undo(&token, 0).unwrap().unwrap();
        assert_eq!(text(s.session().document()), expected);
        assert_eq!(s.operations().back().unwrap().origin, OperationOrigin::Undo);
    }
    let token = s.read(0).unwrap().revision;
    s.redo(&token, 0).unwrap().unwrap();
    assert_eq!(text(s.session().document()), "0base");
    assert_eq!(s.operations().back().unwrap().origin, OperationOrigin::Redo);
}
#[test]
fn memory_actual_history_separates_all_host_origins() {
    groups(&mut memory());
}
#[test]
fn fault_adapter_actual_history_separates_all_host_origins() {
    let id = identity();
    let mut s = service(
        Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap()),
        id,
    );
    groups(&mut s);
}
#[test]
fn legacy_names_and_client_ids_never_become_authenticated_actors() {
    let mut s = memory();
    for value in ["a", "b"] {
        let p = prepare(&s, value);
        s.apply(p, 0).unwrap();
    }
    assert_eq!(s.session().document().history_state().undo_groups, 2);
    for r in s.operations() {
        assert!(r.actor.is_none());
        assert_eq!(r.origin, OperationOrigin::Unattributed);
        assert!(r.engine_origin.contains("administrator:replica-123"));
    }
    let before = s.read(0).unwrap().revision;
    let p = prepare(&s, "c");
    let mut context = host(OperationOrigin::Agent);
    context.actor = None;
    s.apply_as(p, context, 0).unwrap();
    assert!(s.operations().back().unwrap().actor.is_none());
    assert_eq!(s.operations().back().unwrap().before, before);
}
#[test]
fn invalid_host_labels_reject_before_mutation_and_history() {
    let mut s = memory();
    let before = s.read(0).unwrap().revision;
    for label in [
        "".to_string(),
        "x".repeat(MAX_LABEL_BYTES + 1),
        "bad\nsubject".into(),
    ] {
        assert!(HostActor::authenticated_by_host(&label).is_err());
        let p = prepare(&s, "bad");
        let mut h = host(OperationOrigin::Agent);
        h.request_id = label;
        assert!(matches!(
            s.apply_as(p, h, 0),
            Err(ServiceError::Operation(OperationError::InvalidLabel))
        ));
    }
    assert_eq!(s.read(0).unwrap().revision, before);
    assert!(s.operations().is_empty());
    assert_eq!(s.session().document().history_state().undo_groups, 0);
}
#[test]
fn stale_readonly_and_noop_do_not_manufacture_records() {
    let mut s = memory();
    let stale = prepare(&s, "old");
    apply(&mut s, "new", OperationOrigin::Human);
    assert!(s.apply_as(stale, host(OperationOrigin::Agent), 0).is_err());
    let p = prepare(&s, "blocked");
    s.set_policy(HostPolicy {
        writable: false,
        ..HostPolicy::default()
    });
    assert!(s.apply_as(p, host(OperationOrigin::Agent), 0).is_err());
    s.set_policy(HostPolicy::default());
    let source = format!("{}\n", text(s.session().document()));
    let target = s
        .capture_source(
            &source,
            editac_markdown::reconcile::SourceMode::Markdown(
                editac_markdown::optional::Codecs::default(),
            ),
            &[owner(s.session().document())],
            0,
        )
        .unwrap();
    let p = s
        .prepare_source(
            &target,
            &s.read(0).unwrap().revision,
            &source,
            &TextOrigin::new("same-source").unwrap(),
            0,
        )
        .unwrap();
    assert!(
        s.apply_as(p, host(OperationOrigin::Replay), 0)
            .unwrap()
            .is_none()
    );
    assert_eq!(s.operations().len(), 1);
}
#[test]
fn bounded_retention_evicts_oldest_without_losing_semantics() {
    let mut s = memory();
    for _ in 0..MAX_OPERATION_RECORDS + 3 {
        apply(&mut s, "x", OperationOrigin::Agent);
    }
    assert_eq!(s.operations().len(), MAX_OPERATION_RECORDS);
    assert_eq!(s.operations().front().unwrap().operation_id, 4);
    assert_eq!(
        s.operations().back().unwrap().operation_id,
        (MAX_OPERATION_RECORDS + 3) as u64
    );
    assert!(s.operation_bytes() <= MAX_OPERATION_BYTES);
    assert_eq!(
        text(s.session().document()),
        format!("{}base", "x".repeat(MAX_OPERATION_RECORDS + 3))
    );
}
#[test]
fn semantic_commit_storage_failure_has_exact_unacknowledged_provenance() {
    for boundary in [FaultBoundary::BeforeWrite, FaultBoundary::AfterCommit] {
        let id = identity();
        let store = Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap());
        let mut s = service(store.clone(), id);
        let before = s.read(0).unwrap().revision;
        let p = prepare(&s, "retained");
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(s.apply_as(p, host(OperationOrigin::Agent), 0).is_err());
        let record = s.operations().back().unwrap().clone();
        assert_eq!(record.before, before);
        assert!(matches!(record.outcome, OperationOutcome::RecoveryRequired));
        assert_eq!(text(s.session().document()), "retainedbase");
        s.recover().unwrap();
        assert_eq!(s.read(0).unwrap().revision, record.after);
        assert_eq!(s.operations().len(), 1); // recovery creates no new authenticated event
    }
}
#[test]
fn real_remote_replay_preserves_human_undo_and_never_authenticates_replica() {
    let id = identity();
    let local_store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let mut local = service(local_store.clone(), id.clone());
    let peer_store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    peer_store
        .publish(0, local_store.recover(&id).unwrap().checkpoint.clone())
        .unwrap();
    let mut peer = EditService::new(
        Session::open(peer_store.clone(), &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    apply(&mut local, "human-", OperationOrigin::Human);
    apply(&mut peer, "remote-", OperationOrigin::Agent);
    let entry = peer_store
        .pending(&id)
        .unwrap()
        .into_iter()
        .find(|e| e.id().writer == peer.session().document().writer_id())
        .unwrap();
    local.receive_peer(entry.clone()).unwrap();
    assert_eq!(local.session().document().history_state().undo_groups, 1);
    assert_eq!(
        local.operations().back().unwrap().origin,
        OperationOrigin::Replay
    );
    assert!(local.operations().back().unwrap().actor.is_none());
    let records = local.operations().len();
    local.receive_peer(entry).unwrap();
    assert_eq!(local.operations().len(), records);
    let token = local.read(0).unwrap().revision;
    local.undo(&token, 0).unwrap();
    assert_eq!(text(local.session().document()), "remote-base");
}
#[cfg(feature = "native-store")]
#[test]
fn native_reopen_recovers_edits_without_inventing_persisted_author_records() {
    use editac_session::store::NativeStore;
    let id = identity();
    let dir = std::path::PathBuf::from(
        std::env::var_os("EDITAC_ORIGINS_EVIDENCE").expect("task-owned evidence directory"),
    );
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}-{}.sqlite", std::process::id(), id.document_id));
    let store =
        Arc::new(NativeStore::create_new(&path, id.clone(), StoreLimits::default()).unwrap());
    let mut s = service(store, id.clone());
    groups(&mut s);
    let expected = s.read(0).unwrap().revision;
    assert!(!s.operations().is_empty());
    drop(s);
    let store =
        Arc::new(NativeStore::open_existing(path, id.clone(), StoreLimits::default()).unwrap());
    let mut reopened = EditService::new(
        Session::open(store, &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    assert_eq!(reopened.read(0).unwrap().revision, expected);
    assert_eq!(text(reopened.session().document()), "0base");
    assert!(reopened.operations().is_empty());
    assert_eq!(reopened.operation_bytes(), 0);
    apply(&mut reopened, "new", OperationOrigin::Agent);
    assert_eq!(reopened.operations().len(), 1);
    assert_eq!(reopened.operations().back().unwrap().operation_id, 1);
}
