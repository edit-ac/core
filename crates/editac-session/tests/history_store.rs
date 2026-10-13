#[allow(dead_code)]
mod support;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::TextCommand,
    document::{DocumentIdentity, InitialNode},
};
use editac_diff::representation::*;
use editac_session::{
    history_store::*,
    ports::{StoreLimits, memory::MemoryStore},
    revision::RevisionError,
    session::{Session, SessionError},
};
use std::{
    cell::Cell,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use support::{origin, owner, text};

fn policy(count: usize, bytes: usize) -> RetentionPolicy {
    RetentionPolicy {
        max_revisions: count,
        max_total_bytes: bytes,
    }
}
fn store() -> HistoryStore {
    HistoryStore::new("fixture-history-1", policy(4, 4096)).unwrap()
}
fn scope() -> RevisionScope {
    RevisionScope {
        document: "document".into(),
        epoch: "epoch".into(),
        schema: "schema".into(),
        module_profile: "profile".into(),
        observed_token: [1; 65],
    }
}
fn source(bytes: &[u8]) -> ImmutableRevision {
    ImmutableRevision::capture(
        scope(),
        RevisionInput::ExactSource(bytes),
        RepresentationLimits::default(),
    )
    .unwrap()
}
fn unavailable(
    store: &HistoryStore,
    request: &HistoryRequest,
    key: Option<&str>,
    reason: UnavailableReason,
) {
    assert!(
        matches!(store.read(request, key).unwrap(), HistoryAvailability::Unavailable(actual) if actual == reason)
    );
}
fn read<'a>(store: &'a HistoryStore, request: &HistoryRequest) -> &'a HistoricalRevision {
    match store.read(request, None).unwrap() {
        HistoryAvailability::Available(revision) => revision,
        other => panic!("{other:?}"),
    }
}
fn session() -> Session<Arc<MemoryStore>> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = DocumentIdentity::v5(
        &format!(
            "34567890-3456-4456-8456-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "45678901-4567-4567-8567-456789012345",
    )
    .unwrap();
    let memory = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    Session::create_local(
        memory,
        id,
        &[InitialNode {
            kind: "block".into(),
            text: "abcdef".into(),
        }],
    )
    .unwrap()
}
fn capture(
    store: &mut HistoryStore,
    session: &Session<Arc<MemoryStore>>,
    name: &str,
    calls: &Cell<usize>,
) -> HistoryRequest {
    store
        .capture_session(
            session,
            &session.observed_revision().unwrap(),
            name,
            None,
            |doc, scope| {
                calls.set(calls.get() + 1);
                ImmutableRevision::capture(
                    scope,
                    RevisionInput::ProjectedMarkdown {
                        bytes: text(doc).as_bytes(),
                        serializer: "fixture-plain-v1",
                        dialect: "plain-block",
                    },
                    RepresentationLimits::default(),
                )
            },
        )
        .unwrap()
}
fn insert(session: &mut Session<Arc<MemoryStore>>) {
    let at = session
        .document()
        .anchor(&owner(session.document()), Utf16Offset(0), Bias::Right)
        .unwrap();
    session
        .edit_text(
            &TextCommand::Insert {
                at,
                text: "x".into(),
            },
            &origin(),
            1,
        )
        .unwrap();
}

#[test]
fn exact_source_bytes_hash_and_name_are_immutable() {
    let mut store = store();
    let input = b"one\r\ntwo";
    let request = store.capture("before edit", source(input), None).unwrap();
    let before = read(&store, &request);
    assert_eq!(before.name(), "before edit");
    assert_eq!(before.revision().bytes(), input);
    assert_eq!(before.revision().hash(), ContentHash::of(input));
    assert_eq!(before.request(), &request);
    assert_eq!(
        before.revision().representation(),
        &Representation::ExactSourceUtf8
    );
}

#[test]
fn fifo_count_pruning_does_not_touch_remaining_snapshots() {
    let mut store = HistoryStore::new("fixture-history-1", policy(2, 4096)).unwrap();
    let old = store.capture("old", source(b"old"), None).unwrap();
    let middle = store.capture("middle", source(b"middle"), None).unwrap();
    let new = store.capture("new", source(b"new"), None).unwrap();
    unavailable(&store, &old, None, UnavailableReason::Pruned);
    assert_eq!(store.len(), 2);
    assert_eq!(read(&store, &middle).revision().bytes(), b"middle");
    assert_eq!(read(&store, &new).revision().bytes(), b"new");
}

#[test]
fn total_byte_retention_includes_metadata_and_prunes_fifo() {
    let mut store = store();
    let old = store.capture("first", source(b"same"), None).unwrap();
    let one_size = store.total_bytes();
    assert!(one_size > 4 + 5);
    store.set_retention(policy(100, one_size));
    let new = store.capture("other", source(b"same"), None).unwrap();
    assert_eq!(store.total_bytes(), one_size);
    assert_eq!(store.len(), 1);
    unavailable(&store, &old, None, UnavailableReason::Pruned);
    assert_eq!(read(&store, &new).revision().bytes(), b"same");
}

#[test]
fn rejected_oversize_capture_is_atomic_and_does_not_consume_handle() {
    let mut store = store();
    let old = store.capture("old", source(b"old"), None).unwrap();
    let bound = store.total_bytes();
    store.set_retention(policy(2, bound));
    assert_eq!(
        store.capture("large", source(&[b'x'; 4096]), None),
        Err(HistoryError::ResourceLimit)
    );
    assert_eq!(store.total_bytes(), bound);
    assert_eq!(read(&store, &old).revision().bytes(), b"old");
    let next = store.capture("new", source(b"new"), None).unwrap();
    unavailable(&store, &old, None, UnavailableReason::Pruned);
    assert_eq!(read(&store, &next).name(), "new");
}

#[test]
fn zero_retention_and_tightening_are_explicit() {
    let mut store = store();
    let old = store.capture("old", source(b"old"), None).unwrap();
    store.set_retention(policy(0, 0));
    assert!(store.is_empty());
    assert_eq!(store.total_bytes(), 0);
    unavailable(&store, &old, None, UnavailableReason::Pruned);
    assert_eq!(
        store.capture("new", source(b"new"), None),
        Err(HistoryError::ResourceLimit)
    );
    store.set_retention(policy(1, 0));
    assert_eq!(
        store.capture("empty", source(b""), None),
        Err(HistoryError::ResourceLimit)
    );
}

#[test]
fn missing_and_pruned_handles_never_fall_back_to_current_content() {
    let mut store = store();
    let request = store.capture("old", source(b"old"), None).unwrap();
    unavailable(
        &HistoryStore::new("foreign", policy(4, 4096)).unwrap(),
        &request,
        None,
        UnavailableReason::Missing,
    );
    unavailable(
        &HistoryStore::new("fixture-history-1", policy(4, 4096)).unwrap(),
        &request,
        None,
        UnavailableReason::Missing,
    );
    store.set_retention(policy(0, 0));
    unavailable(&store, &request, None, UnavailableReason::Pruned);
}

#[test]
fn missing_or_rotated_host_key_profile_is_locked() {
    let mut store = store();
    let request = store
        .capture(
            "protected",
            source(b"confidential"),
            Some("key-generation-1"),
        )
        .unwrap();
    for key in [None, Some("key-generation-2")] {
        unavailable(&store, &request, key, UnavailableReason::KeyUnavailable);
    }
    match store.read(&request, Some("key-generation-1")).unwrap() {
        HistoryAvailability::Available(entry) => {
            assert_eq!(entry.required_key_profile(), Some("key-generation-1"));
            assert_eq!(entry.revision().bytes(), b"confidential");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn wrong_schema_or_module_profile_is_incompatible() {
    let mut store = store();
    let original = store.capture("old", source(b"old"), None).unwrap();
    let mut request = original.clone();
    request.scope.schema = "migrated".into();
    unavailable(
        &store,
        &request,
        None,
        UnavailableReason::IncompatibleSchema,
    );
    request = original.clone();
    request.scope.module_profile = "migrated".into();
    unavailable(
        &store,
        &request,
        None,
        UnavailableReason::IncompatibleSchema,
    );
    assert_eq!(read(&store, &original).revision().bytes(), b"old");
}

#[test]
fn every_other_request_binding_is_validated() {
    let mut store = store();
    let original = store.capture("old", source(b"old"), None).unwrap();
    for field in 0..3 {
        let mut request = original.clone();
        match field {
            0 => request.scope.document = "other".into(),
            1 => request.scope.epoch = "other".into(),
            _ => request.scope.observed_token[1] ^= 1,
        }
        assert_eq!(
            store.read(&request, None).unwrap_err(),
            HistoryError::ScopeMismatch
        );
    }
    let mut request = original.clone();
    request.hash = ContentHash::of(b"different");
    assert_eq!(
        store.read(&request, None).unwrap_err(),
        HistoryError::HashMismatch
    );
    request = original.clone();
    request.representation = Representation::SemanticV1;
    assert_eq!(
        store.read(&request, None).unwrap_err(),
        HistoryError::RepresentationMismatch
    );
}

#[test]
fn real_session_deletion_and_history_reads_never_rewind_live_replica() {
    let mut session = session();
    let mut store = store();
    let calls = Cell::new(0);
    let old = capture(&mut store, &session, "before", &calls);
    let vector = session.document().state_vector_v1();
    let owner = owner(session.document());
    let selection = session
        .document()
        .selection(
            (&owner, Utf16Offset(1), Bias::Left),
            (&owner, Utf16Offset(3), Bias::Right),
        )
        .unwrap();
    session
        .edit_text(&TextCommand::Delete { selection }, &origin(), 1)
        .unwrap();
    assert_eq!(vector, session.document().state_vector_v1());
    let current = session.observed_revision().unwrap();
    let live_checkpoint = session.document().checkpoint();
    for _ in 0..20 {
        assert_eq!(read(&store, &old).revision().bytes(), b"abcdef");
    }
    assert_eq!(text(session.document()), "adef");
    assert_eq!(session.observed_revision().unwrap(), current);
    let after_read = session.document().checkpoint();
    assert_eq!(after_read.bytes, live_checkpoint.bytes);
    assert_eq!(after_read.identity, live_checkpoint.identity);
    assert_eq!(after_read.writer_id, live_checkpoint.writer_id);
    assert_eq!(after_read.initialized, live_checkpoint.initialized);
    let after = capture(&mut store, &session, "after", &calls);
    assert_ne!(old.scope.observed_token, after.scope.observed_token);
    assert_ne!(old.hash, after.hash);
    assert_eq!(read(&store, &after).revision().bytes(), b"adef");
    assert_eq!(calls.get(), 2);
}

#[test]
fn ordinary_typing_does_not_capture_or_serialize_review_history() {
    let mut session = session();
    let mut store = store();
    let calls = Cell::new(0);
    let old = capture(&mut store, &session, "before", &calls);
    let size = store.total_bytes();
    for _ in 0..50 {
        insert(&mut session);
    }
    assert_eq!(calls.get(), 1);
    assert_eq!(store.len(), 1);
    assert_eq!(store.total_bytes(), size);
    assert_eq!(read(&store, &old).revision().bytes(), b"abcdef");
    let after = capture(&mut store, &session, "after", &calls);
    assert_eq!(calls.get(), 2);
    assert_eq!(read(&store, &after).revision().bytes().len(), 56);
}

#[test]
fn stale_capture_rejects_before_materialization_and_storage() {
    let mut session = session();
    let mut store = store();
    let before = session.observed_revision().unwrap();
    insert(&mut session);
    let result = store.capture_session(&session, &before, "stale", None, |_, _| {
        panic!("stale callback ran")
    });
    assert_eq!(
        result,
        Err(HistoryError::Session(SessionError::Revision(
            RevisionError::Stale
        )))
    );
    assert!(store.is_empty());
}

#[test]
fn materialization_failure_or_wrong_scope_does_not_mutate_store_or_session() {
    let session = session();
    let mut store = store();
    let current = session.observed_revision().unwrap();
    assert_eq!(
        store.capture_session(&session, &current, "failed", None, |_, _| Err(
            RepresentationError::ResourceLimit
        )),
        Err(HistoryError::Representation(
            RepresentationError::ResourceLimit
        ))
    );
    assert_eq!(
        store.capture_session(&session, &current, "foreign", None, |_, _| Ok(source(
            b"foreign"
        ))),
        Err(HistoryError::ScopeMismatch)
    );
    assert!(store.is_empty());
    assert_eq!(session.observed_revision().unwrap(), current);
}

#[test]
fn metadata_limits_and_debug_do_not_leak_content() {
    assert!(matches!(
        HistoryStore::new("", policy(1, 100)),
        Err(HistoryError::InvalidLabel)
    ));
    let mut store = store();
    for label in ["".to_owned(), "x".repeat(257)] {
        assert_eq!(
            store.capture(&label, source(b"SECRET"), None),
            Err(HistoryError::InvalidLabel)
        );
        assert_eq!(
            store.capture("valid", source(b"SECRET"), Some(&label)),
            Err(HistoryError::InvalidLabel)
        );
    }
    let request = store
        .capture("SECRET name", source(b"SECRET source"), None)
        .unwrap();
    assert!(!format!("{:?}", read(&store, &request)).contains("SECRET"));
}

#[test]
fn semantic_and_projected_capabilities_remain_distinct_from_exact_source() {
    let mut store = store();
    let semantic = SemanticSnapshot {
        visible: vec![],
        recovery: vec![],
        retained_structure: Default::default(),
    };
    let revision = ImmutableRevision::capture(
        scope(),
        RevisionInput::Semantic(&semantic),
        RepresentationLimits::default(),
    )
    .unwrap();
    let expected = revision.bytes().to_vec();
    let request = store.capture("semantic", revision, None).unwrap();
    assert_eq!(
        read(&store, &request).revision().representation(),
        &Representation::SemanticV1
    );
    assert_eq!(read(&store, &request).revision().bytes(), expected);
    let projected = ImmutableRevision::capture(
        scope(),
        RevisionInput::ProjectedMarkdown {
            bytes: b"normalized",
            serializer: "serializer-v2",
            dialect: "dialect-v3",
        },
        RepresentationLimits::default(),
    )
    .unwrap();
    let request = store.capture("projected", projected, None).unwrap();
    assert_eq!(
        read(&store, &request).revision().representation(),
        &Representation::ProjectedMarkdown {
            serializer: "serializer-v2".into(),
            dialect: "dialect-v3".into()
        }
    );
}

#[test]
fn handles_cannot_alias_a_recreated_store_even_with_identical_scope_and_content() {
    let mut old_store = store();
    let old = old_store
        .capture("original name", source(b"same"), None)
        .unwrap();
    let mut recreated = store();
    let new = recreated
        .capture("replacement name", source(b"same"), None)
        .unwrap();
    unavailable(&recreated, &old, None, UnavailableReason::Missing);
    unavailable(&old_store, &new, None, UnavailableReason::Missing);
    assert_eq!(read(&old_store, &old).name(), "original name");
    assert_eq!(read(&recreated, &new).name(), "replacement name");
}
