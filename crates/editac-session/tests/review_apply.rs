use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    projection::Snapshot,
};
use editac_diff::{representation::*, text::*};
use editac_markdown::{import::import, optional::Codecs, reconcile::SourceMode};
use editac_session::{
    edit_service::*,
    operations::*,
    ports::{memory::*, *},
    review_apply::*,
    revision::RevisionError,
    session::*,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
fn origin() -> TextOrigin {
    TextOrigin::new("review:untrusted-agent-name").unwrap()
}
fn host() -> HostOperation {
    HostOperation {
        actor: None,
        origin: OperationOrigin::Agent,
        request_id: "review-fixture".into(),
    }
}
fn ids(snapshot: &Snapshot) -> Vec<String> {
    snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.id.clone())
        .collect()
}
fn texts(snapshot: &Snapshot) -> Vec<String> {
    snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}
fn fixture<S: SessionStore>(
    store: S,
    id: DocumentIdentity,
    source: &str,
    mode: SourceMode,
) -> EditService<S> {
    let initial = if matches!(mode, SourceMode::Literal) {
        source
    } else {
        ""
    };
    let mut doc = Document::create(
        CreationPermit::authorize_new(id.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: initial.into(),
        }],
    )
    .unwrap();
    if matches!(mode, SourceMode::Markdown(_)) {
        let owner = ids(&doc.snapshot().unwrap())[0].clone();
        let selection = Selection {
            anchor: doc.anchor(&owner, U(0), Bias::Right).unwrap(),
            focus: doc.anchor(&owner, U(0), Bias::Left).unwrap(),
        };
        let p = doc
            .prepare_fragment(&selection, &import(source).unwrap().blocks, &origin())
            .unwrap();
        doc.commit_editor(p).unwrap();
    }
    store
        .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
        .unwrap();
    EditService::new(
        Session::open(store, &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    )
}
fn identity() -> DocumentIdentity {
    static NEXT: AtomicU64 = AtomicU64::new(1200);
    DocumentIdentity::v5(
        format!(
            "12345678-1234-4234-8234-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
fn memory(source: &str, mode: SourceMode) -> (EditService<Arc<MemoryStore>>, Arc<MemoryStore>) {
    let id = identity();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    (fixture(store.clone(), id, source, mode), store)
}
fn md() -> SourceMode {
    SourceMode::Markdown(Codecs::default())
}
fn revision(bytes: &[u8]) -> ImmutableRevision {
    let mut token = [0; 65];
    token[0] = 1;
    ImmutableRevision::capture(
        RevisionScope {
            document: "review-fixtures".into(),
            epoch: "1".into(),
            schema: "v5".into(),
            module_profile: "markdown".into(),
            observed_token: token,
        },
        RevisionInput::ExactSource(bytes),
        RepresentationLimits::default(),
    )
    .unwrap()
}
fn patch(base: &str, proposed: &str) -> TextPatch {
    TextPatch::between(
        &revision(base.as_bytes()),
        &revision(proposed.as_bytes()),
        PatchLimits::default(),
    )
    .unwrap()
}
fn target<S: SessionStore>(s: &EditService<S>, source: &str, mode: SourceMode) -> ReviewTarget {
    s.capture_review(source, mode, &ids(&s.read(0).unwrap().snapshot), 0)
        .unwrap()
}
fn prepare<S: SessionStore>(
    s: &EditService<S>,
    t: &ReviewTarget,
    p: &TextPatch,
    a: Acceptance<'_>,
) -> Result<PreparedReview, ReviewError> {
    s.prepare_review(t, p, a, PatchLimits::default(), &origin(), 0)
}
fn rejected(result: Result<PreparedReview, ReviewError>) -> ReviewError {
    match result {
        Ok(_) => panic!("expected rejected review"),
        Err(e) => e,
    }
}
fn insert<S: SessionStore>(s: &mut EditService<S>, text: &str) {
    let owner = ids(&s.read(0).unwrap().snapshot)[0].clone();
    let at = s
        .session()
        .document()
        .anchor(&owner, U(0), Bias::Right)
        .unwrap();
    let p = s
        .prepare_commands(
            &s.read(0).unwrap().revision,
            &[EditorCommand::Text(TextCommand::Insert {
                at,
                text: text.into(),
            })],
            &origin(),
            0,
        )
        .unwrap();
    s.apply(p, 0).unwrap();
}
fn atomic<S: SessionStore>(
    s: &EditService<S>,
) -> (
    Vec<u8>,
    usize,
    usize,
    editac_session::revision::ObservedRevision,
) {
    (
        s.session().document().checkpoint().bytes,
        s.operations().len(),
        s.session().document().history_state().undo_groups,
        s.read(0).unwrap().revision,
    )
}
#[test]
fn full_markdown_text_marks_links_and_heading_preserve_ids_preview_and_durable_reopen() {
    let base = "# heading\n\n**bold** [link](https://example.com/a)\n";
    let proposed = "## heading\n\n*BOLD* [link](https://example.com/b)\n";
    let (mut s, store) = memory(base, md());
    let before = s.read(0).unwrap().snapshot;
    let owners = ids(&before);
    let t = target(&s, base, md());
    let state = atomic(&s);
    let p = prepare(&s, &t, &patch(base, proposed), Acceptance::All).unwrap();
    assert_eq!(atomic(&s), state);
    assert_eq!(p.expected_revision(), t.revision());
    assert_eq!(p.proposed_source(), proposed);
    assert_eq!(ids(p.preview()), owners);
    assert_eq!(
        p.preview()
            .visible
            .iter()
            .find(|n| n.id == owners[0])
            .unwrap()
            .block_attributes,
        Some(BlockAttributes::Heading(2))
    );
    assert_ne!(
        p.preview()
            .visible
            .iter()
            .find(|n| n.id == owners[1])
            .unwrap()
            .runs,
        before
            .visible
            .iter()
            .find(|n| n.id == owners[1])
            .unwrap()
            .runs
    );
    let bold_run = p
        .preview()
        .visible
        .iter()
        .find(|n| n.id == owners[1])
        .unwrap()
        .runs
        .iter()
        .find(|r| r.text == "BOLD")
        .unwrap();
    assert!(bold_run.attributes.contains_key("italic"));
    assert!(!bold_run.attributes.contains_key("bold"));
    let preview = texts(p.preview());
    s.apply_review_as(p, host(), 0).unwrap().unwrap();
    assert_eq!(ids(&s.read(0).unwrap().snapshot), owners);
    assert_eq!(texts(&s.read(0).unwrap().snapshot), preview);
    let link = s
        .read(0)
        .unwrap()
        .snapshot
        .visible
        .into_iter()
        .flat_map(|n| n.runs.clone())
        .find_map(|r| r.attributes.get("link").cloned())
        .unwrap();
    assert!(format!("{link:?}").contains("https://example.com/b"));
    assert_eq!(s.session().document().history_state().undo_groups, 1);
    assert_eq!(
        store
            .pending(s.session().document().identity())
            .unwrap()
            .len(),
        1
    );
    let reopened = Session::open(
        store,
        s.session().document().identity(),
        CachedPermission::LOCAL,
    )
    .unwrap();
    assert_eq!(ids(&reopened.document().snapshot().unwrap()), owners);
    assert_eq!(texts(&reopened.document().snapshot().unwrap()), preview);
}
fn literal_case(base: &str, proposed: &str) {
    let (mut s, _) = memory(base, SourceMode::Literal);
    let t = target(&s, base, SourceMode::Literal);
    let p = prepare(&s, &t, &patch(base, proposed), Acceptance::All).unwrap();
    let owners = ids(p.preview());
    s.apply_review_as(p, host(), 0).unwrap();
    assert_eq!(texts(&s.read(0).unwrap().snapshot), [proposed]);
    assert_eq!(ids(&s.read(0).unwrap().snapshot), owners);
}
#[test]
fn literal_unicode_utf16_emoji_combining() {
    literal_case("é 👩‍💻\n", "e\u{301} 👨‍👩‍👧‍👦\n");
}
#[test]
fn literal_crlf_mixed_endings() {
    literal_case("a\r\nb\nc\r\n", "A\r\nb\nC\r\n");
}
#[test]
fn literal_missing_final_newline() {
    literal_case("a\nb", "a\nB");
}
#[test]
fn literal_final_newline_removed() {
    literal_case("a\nb\n", "a\nb");
}
#[test]
fn literal_deletion_only() {
    literal_case("abcdef", "adef");
}
fn multiple() -> (String, String) {
    let base = (0..15)
        .map(|i| format!("paragraph {i}\n\n"))
        .collect::<String>();
    let proposed = base
        .replace("paragraph 0\n", "FIRST\n")
        .replace("paragraph 14\n", "LAST\n");
    (base, proposed)
}
fn partial(index: usize) {
    let (base, proposed) = multiple();
    let (mut s, _) = memory(&base, md());
    let t = target(&s, &base, md());
    let patch = patch(&base, &proposed);
    assert_eq!(patch.hunks.len(), 2);
    let owners = ids(&s.read(0).unwrap().snapshot);
    let p = prepare(&s, &t, &patch, Acceptance::Hunks(&[index])).unwrap();
    let expected = if index == 0 {
        base.replace("paragraph 0\n", "FIRST\n")
    } else {
        base.replace("paragraph 14\n", "LAST\n")
    };
    assert_eq!(p.proposed_source(), expected);
    s.apply_review_as(p, host(), 0).unwrap();
    assert_eq!(ids(&s.read(0).unwrap().snapshot), owners);
    let values = texts(&s.read(0).unwrap().snapshot);
    assert_eq!(&values[0], if index == 0 { "FIRST" } else { "paragraph 0" });
    assert_eq!(
        &values[14],
        if index == 1 { "LAST" } else { "paragraph 14" }
    );
    assert_eq!(s.session().document().history_state().undo_groups, 1);
}
#[test]
fn partial_first_hunk_recomputes_semantics() {
    partial(0);
}
#[test]
fn partial_last_hunk_uses_original_ranges() {
    partial(1);
}
#[test]
fn all_selected_hunks_match_accept_all() {
    let (base, proposed) = multiple();
    let (s, _) = memory(&base, md());
    let t = target(&s, &base, md());
    let p = patch(&base, &proposed);
    let selected = prepare(&s, &t, &p, Acceptance::Hunks(&[0, 1])).unwrap();
    let full = prepare(&s, &t, &p, Acceptance::All).unwrap();
    assert_eq!(selected.proposed_source(), full.proposed_source());
    assert_eq!(texts(selected.preview()), texts(full.preview()));
}
#[test]
fn empty_selection_is_noop_without_journal_history_or_origin_record() {
    let (mut s, store) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let state = atomic(&s);
    let p = prepare(&s, &t, &patch("base", "changed"), Acceptance::Hunks(&[])).unwrap();
    assert_eq!(p.proposed_source(), "base");
    assert!(s.apply_review_as(p, host(), 0).unwrap().is_none());
    assert_eq!(atomic(&s), state);
    assert!(
        store
            .pending(s.session().document().identity())
            .unwrap()
            .is_empty()
    );
}
#[test]
fn invalid_partial_fence_rejects_with_three_way_recovery_and_no_mutation() {
    let inside = (0..20).map(|i| format!("code {i}\n")).collect::<String>();
    let base = format!("```rs\n{inside}```\n");
    let proposed = inside;
    let (s, _) = memory(&base, md());
    let t = target(&s, &base, md());
    let p = patch(&base, &proposed);
    assert_eq!(p.hunks.len(), 2);
    let before = atomic(&s);
    let e = rejected(prepare(&s, &t, &p, Acceptance::Hunks(&[0])));
    assert!(matches!(e.failure, ReviewFailure::UnsafeSyntax));
    assert_eq!(e.recovery.base, base);
    assert_eq!(e.recovery.full_proposal.as_deref(), Some(proposed.as_str()));
    assert!(e.recovery.proposed.unwrap().ends_with("```\n"));
    assert_eq!(
        ids(e.recovery.current.as_ref().unwrap()),
        ids(&s.read(0).unwrap().snapshot)
    );
    assert_eq!(atomic(&s), before);
}
#[test]
fn full_unclosed_fence_is_rejected_even_when_markdown_parser_accepts_eof() {
    let (s, _) = memory("```\ncode\n```\n", md());
    let t = target(&s, "```\ncode\n```\n", md());
    let e = rejected(prepare(
        &s,
        &t,
        &patch(t.source(), "```\ncode\n"),
        Acceptance::All,
    ));
    assert!(matches!(e.failure, ReviewFailure::UnsafeSyntax));
    assert_eq!(e.recovery.proposed.as_deref(), Some("```\ncode\n"));
}
#[test]
fn literal_fence_text_is_not_markdown_syntax() {
    literal_case("base", "```\nliteral");
}
#[test]
fn stale_before_prepare_recovers_current_and_proposed_atomically() {
    let (mut s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    insert(&mut s, "peer-");
    let before = atomic(&s);
    let e = rejected(prepare(&s, &t, &patch("base", "review"), Acceptance::All));
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::Session(SessionError::Revision(
            RevisionError::Stale
        )))
    ));
    assert_eq!(e.recovery.base, "base");
    assert_eq!(e.recovery.proposed.as_deref(), Some("review"));
    assert_eq!(texts(e.recovery.current.as_ref().unwrap()), ["peer-base"]);
    assert_eq!(atomic(&s), before);
}
#[test]
fn stale_after_prepare_rechecks_before_commit() {
    let (mut s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("base", "review"), Acceptance::All).unwrap();
    insert(&mut s, "later-");
    let before = atomic(&s);
    let e = s.apply_review_as(p, host(), 0).unwrap_err();
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::Session(SessionError::Revision(
            RevisionError::Stale
        )))
    ));
    assert_eq!(e.recovery.base, "base");
    assert_eq!(e.recovery.proposed.as_deref(), Some("review"));
    assert_eq!(texts(e.recovery.current.as_ref().unwrap()), ["later-base"]);
    assert_eq!(atomic(&s), before);
}
#[test]
fn deletion_only_peer_revision_invalidates_prepared_review_without_state_vector_change() {
    let (mut s, store) = memory("abcdef", SourceMode::Literal);
    let t = target(&s, "abcdef", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("abcdef", "ABCDEF"), Acceptance::All).unwrap();
    let id = s.session().document().identity().clone();
    let mut peer = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    let owner = ids(&peer.document().snapshot().unwrap())[0].clone();
    let deletion = TextCommand::Delete {
        selection: Selection {
            anchor: peer.document().anchor(&owner, U(1), Bias::Right).unwrap(),
            focus: peer.document().anchor(&owner, U(3), Bias::Left).unwrap(),
        },
    };
    let vector = s.session().document().state_vector_v1();
    peer.edit_text(&deletion, &origin(), 0).unwrap();
    s.receive_peer(store.recover(&id).unwrap().journal[0].clone())
        .unwrap();
    assert_eq!(s.session().document().state_vector_v1(), vector);
    let before = atomic(&s);
    let e = s.apply_review_as(p, host(), 0).unwrap_err();
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::Session(SessionError::Revision(
            RevisionError::Stale
        )))
    ));
    assert_eq!(texts(e.recovery.current.as_ref().unwrap()), ["adef"]);
    assert_eq!(e.recovery.proposed.as_deref(), Some("ABCDEF"));
    assert_eq!(atomic(&s), before);
}
#[test]
fn wrong_baseline_patch_rejects_without_mutation() {
    let (s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let before = atomic(&s);
    let e = rejected(prepare(
        &s,
        &t,
        &patch("other", "proposal"),
        Acceptance::All,
    ));
    assert!(matches!(
        e.failure,
        ReviewFailure::Patch(PatchError::WrongBaseline)
    ));
    assert_eq!(e.recovery.base, "base");
    assert!(e.recovery.proposed.is_none());
    assert_eq!(atomic(&s), before);
}
#[test]
fn malformed_hunk_rejects_before_semantic_mutation() {
    let (s, _) = memory("base\n", SourceMode::Literal);
    let t = target(&s, "base\n", SourceMode::Literal);
    let mut p = patch(t.source(), "changed\n");
    p.hunks[0].old_count += 1;
    let before = atomic(&s);
    assert!(matches!(
        rejected(prepare(&s, &t, &p, Acceptance::All)).failure,
        ReviewFailure::Patch(_)
    ));
    assert_eq!(atomic(&s), before);
}
fn bad_selection(indexes: &[usize]) {
    let (base, proposed) = multiple();
    let (s, _) = memory(&base, md());
    let t = target(&s, &base, md());
    let before = atomic(&s);
    assert!(matches!(
        rejected(prepare(
            &s,
            &t,
            &patch(&base, &proposed),
            Acceptance::Hunks(indexes)
        ))
        .failure,
        ReviewFailure::InvalidSelection
    ));
    assert_eq!(atomic(&s), before);
}
#[test]
fn duplicate_hunk_selection_rejects() {
    bad_selection(&[0, 0]);
}
#[test]
fn unordered_hunk_selection_rejects() {
    bad_selection(&[1, 0]);
}
#[test]
fn nonexistent_hunk_selection_rejects() {
    bad_selection(&[2]);
}
fn policy_case(policy: HostPolicy) {
    let (mut s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("base", "review"), Acceptance::All).unwrap();
    s.set_policy(policy);
    let before = atomic(&s);
    let e = s.apply_review_as(p, host(), 0).unwrap_err();
    assert!(matches!(e.failure, ReviewFailure::Service(_)));
    assert_eq!(e.recovery.base, "base");
    assert_eq!(e.recovery.proposed.as_deref(), Some("review"));
    assert_eq!(atomic(&s), before);
}
#[test]
fn readonly_policy_rechecked_at_apply() {
    policy_case(HostPolicy {
        writable: false,
        ..HostPolicy::default()
    });
}
#[test]
fn history_view_rechecked_at_apply() {
    policy_case(HostPolicy {
        history_view: true,
        ..HostPolicy::default()
    });
}
#[test]
fn reduced_input_limit_rechecked_at_apply() {
    policy_case(HostPolicy {
        max_input_bytes: 1,
        ..HostPolicy::default()
    });
}
#[test]
fn expired_permission_rechecked_at_apply() {
    let (mut s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("base", "review"), Acceptance::All).unwrap();
    s.set_permission(CachedPermission {
        writable: true,
        expires_at: Some(1),
    });
    let before = atomic(&s);
    assert!(matches!(
        s.apply_review_as(p, host(), 2).unwrap_err().failure,
        ReviewFailure::Service(_)
    ));
    assert_eq!(atomic(&s), before);
}
#[test]
fn history_and_host_origin_policy_are_preserved_through_undo_redo() {
    let (mut s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("base", "review"), Acceptance::All).unwrap();
    s.apply_review_as(p, host(), 0).unwrap();
    let record = s.operations().back().unwrap();
    assert_eq!(record.origin, OperationOrigin::Agent);
    assert!(record.actor.is_none());
    assert_eq!(record.engine_origin, origin().as_str());
    assert_eq!(s.session().document().history_state().undo_groups, 1);
    s.undo(&s.read(0).unwrap().revision, 0).unwrap();
    assert_eq!(texts(&s.read(0).unwrap().snapshot), ["base"]);
    assert_eq!(s.operations().back().unwrap().origin, OperationOrigin::Undo);
    s.redo(&s.read(0).unwrap().revision, 0).unwrap();
    assert_eq!(texts(&s.read(0).unwrap().snapshot), ["review"]);
    assert_eq!(s.operations().back().unwrap().origin, OperationOrigin::Redo);
}
#[test]
fn failed_store_ack_preserves_existing_unsaved_recovery_policy() {
    let id = identity();
    let store = Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap());
    let mut s = fixture(store.clone(), id, "base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("base", "review"), Acceptance::All).unwrap();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeWrite,
            error: PortError::Unavailable,
        })
        .unwrap();
    let e = s.apply_review_as(p, host(), 0).unwrap_err();
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::Session(SessionError::Store(_)))
    ));
    assert_eq!(e.recovery.base, "base");
    assert_eq!(e.recovery.proposed.as_deref(), Some("review"));
    assert_eq!(texts(e.recovery.current.as_ref().unwrap()), ["review"]);
    assert_eq!(s.session().state(0).readiness, Readiness::RecoveryRequired);
    assert!(matches!(
        s.operations().back().unwrap().outcome,
        OperationOutcome::RecoveryRequired
    ));
    s.recover().unwrap();
    assert_eq!(s.session().state(0).readiness, Readiness::Ready);
    let reopened = Session::open(
        store,
        s.session().document().identity(),
        CachedPermission::LOCAL,
    )
    .unwrap();
    assert_eq!(texts(&reopened.document().snapshot().unwrap()), ["review"]);
}
#[test]
fn semantic_mapping_failure_is_atomic_and_recoverable() {
    let (s, _) = memory("one\n", md());
    let t = target(&s, "one\n", md());
    let before = atomic(&s);
    let e = rejected(prepare(
        &s,
        &t,
        &patch("one\n", "one\n\ntwo\n"),
        Acceptance::All,
    ));
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::SourceConflict { .. })
    ));
    assert_eq!(e.recovery.proposed.as_deref(), Some("one\n\ntwo\n"));
    assert_eq!(texts(e.recovery.current.as_ref().unwrap()), ["one"]);
    assert_eq!(atomic(&s), before);
}
#[test]
fn patch_limits_fail_atomically_and_diagnostics_redact_content() {
    let (s, _) = memory("confidential base", SourceMode::Literal);
    let t = target(&s, "confidential base", SourceMode::Literal);
    let before = atomic(&s);
    let e = rejected(s.prepare_review(
        &t,
        &patch(t.source(), "confidential proposed"),
        Acceptance::All,
        PatchLimits {
            max_output_bytes: 1,
            ..PatchLimits::default()
        },
        &origin(),
        0,
    ));
    assert!(matches!(
        e.failure,
        ReviewFailure::Patch(PatchError::ResourceLimit)
    ));
    assert!(!format!("{e:?}").contains("confidential"));
    assert_eq!(atomic(&s), before);
}

#[test]
fn quoted_unclosed_fence_is_unsafe_and_recovers_candidate() {
    let base = "> ```rs\n> code\n> ```\n";
    let proposed = "> ```rs\n> code\n";
    let (s, _) = memory(base, md());
    let t = target(&s, base, md());
    let e = rejected(prepare(&s, &t, &patch(base, proposed), Acceptance::All));
    assert!(matches!(e.failure, ReviewFailure::UnsafeSyntax));
    assert_eq!(e.recovery.proposed.as_deref(), Some(proposed));
}
#[test]
fn list_unclosed_fence_is_unsafe() {
    let base = "- ```rs\n  code\n  ```\n";
    let proposed = "- ```rs\n  code\n";
    let (s, _) = memory(base, md());
    let t = target(&s, base, md());
    assert!(matches!(
        rejected(prepare(&s, &t, &patch(base, proposed), Acceptance::All)).failure,
        ReviewFailure::UnsafeSyntax
    ));
}
#[test]
fn quoted_closed_fence_edit_preserves_container_and_owner_ids() {
    let base = "> ```rs\n> code\n> ```\n";
    let proposed = "> ```rs\n> CODE\n> ```\n";
    let (mut s, _) = memory(base, md());
    let t = target(&s, base, md());
    let before = s.read(0).unwrap().snapshot;
    let p = prepare(&s, &t, &patch(base, proposed), Acceptance::All).unwrap();
    s.apply_review_as(p, host(), 0).unwrap();
    let after = s.read(0).unwrap().snapshot;
    assert_eq!(ids(&after), ids(&before));
    assert_eq!(
        after
            .visible
            .iter()
            .map(|n| (&n.id, &n.parent))
            .collect::<Vec<_>>(),
        before
            .visible
            .iter()
            .map(|n| (&n.id, &n.parent))
            .collect::<Vec<_>>()
    );
    assert_eq!(texts(&after), ["CODE\n"]);
}
#[test]
fn indented_code_fence_like_text_is_literal() {
    let base = "    ```\n    literal\n";
    let proposed = "    ```\n    LITERAL\n";
    let (mut s, _) = memory(base, md());
    let t = target(&s, base, md());
    let p = prepare(&s, &t, &patch(base, proposed), Acceptance::All).unwrap();
    s.apply_review_as(p, host(), 0).unwrap();
    assert_eq!(texts(&s.read(0).unwrap().snapshot), ["```\nLITERAL\n"]);
}
#[test]
fn tilde_fence_short_closer_rejects_and_long_closer_accepts() {
    let base = "~~~~rs\ncode\n~~~~\n";
    let (s, _) = memory(base, md());
    let t = target(&s, base, md());
    assert!(matches!(
        rejected(prepare(
            &s,
            &t,
            &patch(base, "~~~~rs\ncode\n~~~\n"),
            Acceptance::All
        ))
        .failure,
        ReviewFailure::UnsafeSyntax
    ));
    assert!(
        prepare(
            &s,
            &t,
            &patch(base, "~~~~rs\nCODE\n~~~~~\n"),
            Acceptance::All
        )
        .is_ok()
    );
}

#[test]
fn full_removal_of_both_fence_delimiters_reconciles_existing_identity() {
    let inside = (0..20).map(|i| format!("code {i}\n")).collect::<String>();
    let base = format!("```rs\n{inside}```\n");
    let (mut s, _) = memory(&base, md());
    let t = target(&s, &base, md());
    let before = ids(&s.read(0).unwrap().snapshot);
    let p = prepare(&s, &t, &patch(&base, &inside), Acceptance::All).unwrap();
    s.apply_review_as(p, host(), 0).unwrap();
    let after = s.read(0).unwrap().snapshot;
    assert_eq!(ids(&after), before);
    assert_eq!(
        after
            .visible
            .iter()
            .find(|n| n.id == before[0])
            .unwrap()
            .block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    assert_eq!(s.session().document().history_state().undo_groups, 1);
}
#[test]
fn empty_closed_fence_without_final_newline_is_valid() {
    let base = "```rs\n```";
    let (s, _) = memory(base, md());
    let t = target(&s, base, md());
    assert!(prepare(&s, &t, &patch(base, "```rs\ntext\n```"), Acceptance::All).is_ok());
}
#[test]
fn unclosed_fence_with_trailing_blank_lines_is_unsafe() {
    let base = "```rs\ncode\n```\n";
    let (s, _) = memory(base, md());
    let t = target(&s, base, md());
    assert!(matches!(
        rejected(prepare(
            &s,
            &t,
            &patch(base, "```rs\ncode\n\n\n"),
            Acceptance::All
        ))
        .failure,
        ReviewFailure::UnsafeSyntax
    ));
}
#[test]
fn indented_fence_like_last_line_cannot_act_as_a_closing_delimiter() {
    let base = "```rs\ncode\n```\n";
    let (s, _) = memory(base, md());
    let t = target(&s, base, md());
    assert!(matches!(
        rejected(prepare(
            &s,
            &t,
            &patch(base, "```rs\ncode\n    ```\n"),
            Acceptance::All
        ))
        .failure,
        ReviewFailure::UnsafeSyntax
    ));
}
#[test]
fn partial_output_enforces_recorded_patch_limit_even_when_full_deletion_fits() {
    let (s, _) = memory("long baseline", SourceMode::Literal);
    let t = target(&s, "long baseline", SourceMode::Literal);
    let mut p = patch(t.source(), "x");
    p.metadata.limits.max_output_bytes = 1;
    assert!(matches!(
        rejected(prepare(&s, &t, &p, Acceptance::Hunks(&[]))).failure,
        ReviewFailure::Patch(PatchError::ResourceLimit)
    ));
}
#[test]
fn invalid_host_metadata_at_apply_is_atomic_with_recovery() {
    let (mut s, _) = memory("base", SourceMode::Literal);
    let t = target(&s, "base", SourceMode::Literal);
    let p = prepare(&s, &t, &patch("base", "review"), Acceptance::All).unwrap();
    let before = atomic(&s);
    let mut context = host();
    context.request_id.clear();
    let e = s.apply_review_as(p, context, 0).unwrap_err();
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::Operation(_))
    ));
    assert_eq!(e.recovery.proposed.as_deref(), Some("review"));
    assert_eq!(atomic(&s), before);
}

#[test]
fn another_document_cannot_apply_a_target_with_matching_source_bytes() {
    let (a, _) = memory("base", SourceMode::Literal);
    let (b, _) = memory("base", SourceMode::Literal);
    let t = target(&a, "base", SourceMode::Literal);
    let before = atomic(&b);
    let e = rejected(prepare(&b, &t, &patch("base", "review"), Acceptance::All));
    assert!(matches!(
        e.failure,
        ReviewFailure::Service(ServiceError::Session(SessionError::Revision(
            RevisionError::ScopeMismatch
        )))
    ));
    assert_eq!(texts(e.recovery.current.as_ref().unwrap()), ["base"]);
    assert_eq!(atomic(&b), before);
}
