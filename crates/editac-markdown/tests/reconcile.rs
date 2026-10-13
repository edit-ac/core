#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
};
use editac_markdown::{
    import::import,
    optional::Codecs,
    reconcile::{ConflictKind, SourceBaseline, SourceMode},
};
use yrs::Any;
fn origin() -> TextOrigin {
    TextOrigin::new("source-reconcile:fixture").unwrap()
}
fn blank() -> Document {
    static BASE: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
        std::sync::OnceLock::new();
    let checkpoint = BASE.get_or_init(|| {
        let identity = DocumentIdentity::v5(
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888888",
        )
        .unwrap();
        Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap()
        .checkpoint()
    });
    let mut d = Document::restore(&checkpoint.identity, checkpoint, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn owners(d: &Document) -> Vec<String> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.id.clone())
        .collect()
}
fn prepared(source: &str) -> (Document, Vec<String>, SourceBaseline) {
    let mut d = blank();
    let owner = owners(&d)[0].clone();
    let selection = Selection {
        anchor: d.anchor(&owner, U(0), Bias::Right).unwrap(),
        focus: d.anchor(&owner, U(0), Bias::Left).unwrap(),
    };
    let p = d
        .prepare_fragment(&selection, &import(source).unwrap().blocks, &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    d.clear_history();
    let ids = owners(&d);
    let base =
        SourceBaseline::capture(&d, source, SourceMode::Markdown(Codecs::default()), &ids).unwrap();
    (d, ids, base)
}
fn texts(d: &Document) -> Vec<String> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}
fn remote(d: &mut Document, id: &str, offset: u32, text: &str) {
    let vector = d.state_vector_v1();
    let mut peer = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let at = peer.anchor(id, U(offset), Bias::Right).unwrap();
    let p = peer
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: text.into(),
            },
            &origin(),
        )
        .unwrap();
    peer.commit_text(p).unwrap();
    let update = editac_core::document::ReplayUpdate {
        identity: d.identity().clone(),
        bytes: peer.update_v1(&vector).unwrap(),
    };
    d.apply_replay(&update).unwrap();
}
fn unchanged(d: &Document, before: &[u8], vector: &[u8], history: usize) {
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.state_vector_v1(), vector);
    assert_eq!(d.history_state().undo_groups, history);
}
#[test]
fn exact_noop_and_spelling_only_keep_source_ids_and_state() {
    let (mut d, ids, base) = prepared("*é😀*\n\nsecond\n");
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    for edited in ["*é😀*\n\nsecond\n", "_é😀_\n\nsecond\n"] {
        let edit = base.prepare(&d, edited, &origin()).unwrap();
        assert_eq!(edit.changed, 0);
        let result = edit.commit(&mut d).unwrap();
        assert_eq!(result.source, edited);
        assert!(result.commit.is_none());
        unchanged(&d, &before, &vector, 0);
        assert_eq!(owners(&d), ids);
    }
    assert_eq!(base.source(), "*é😀*\n\nsecond\n");
}
#[test]
fn disjoint_unicode_and_mark_changes_are_one_update_and_keep_untouched_identity() {
    let (mut d, ids, base) = prepared("before **bold** after\n\nunchanged 😀\n\nend\n");
    let before = d.snapshot().unwrap();
    let before_bytes = d.checkpoint().bytes;
    let edited = "before **brave** after\n\nunchanged 😀\n\nlast é😀\n";
    let edit = base.prepare(&d, edited, &origin()).unwrap();
    assert_eq!(edit.changed, 2);
    assert_eq!(d.checkpoint().bytes, before_bytes);
    let result = edit.commit(&mut d).unwrap();
    assert!(result.commit.unwrap().update.bytes.len() > 0);
    assert_eq!(result.source, edited);
    assert_eq!(owners(&d), ids);
    assert_eq!(d.history_state().undo_groups, 1);
    let after = d.snapshot().unwrap();
    assert_eq!(
        before.visible.iter().find(|n| n.id == ids[1]),
        after.visible.iter().find(|n| n.id == ids[1])
    );
    assert!(
        after
            .visible
            .iter()
            .find(|n| n.id == ids[0])
            .unwrap()
            .runs
            .iter()
            .any(|r| r.text == "brave" && r.attributes.get("bold") == Some(&Any::Bool(true)))
    );
    let original_source = &before
        .visible
        .iter()
        .find(|n| n.id == ids[0])
        .unwrap()
        .spans[0]
        .source;
    assert!(
        after
            .visible
            .iter()
            .find(|n| n.id == ids[0])
            .unwrap()
            .spans
            .iter()
            .any(|s| &s.source == original_source)
    );
    d.undo().unwrap();
    assert_eq!(texts(&d), vec!["before bold after", "unchanged 😀", "end"]);
    d.redo().unwrap();
    assert_eq!(
        texts(&d),
        vec!["before brave after", "unchanged 😀", "last é😀"]
    );
}
#[test]
fn lists_fences_and_reference_definitions_use_one_whole_document_parse() {
    let source =
        "- **one**\n- two\n\n```rs\n  code 😀\n```\n\n[ref][id]\n\n[id]: https://example.com/a\n";
    let (mut d, ids, base) = prepared(source);
    let edited =
        "- **ONE**\n- two\n\n```rs\n  code é😀\n```\n\n[ref][id]\n\n[id]: https://example.com/b\n";
    let edit = base.prepare(&d, edited, &origin()).unwrap();
    assert_eq!(edit.changed, 3);
    edit.commit(&mut d).unwrap();
    assert_eq!(owners(&d), ids);
    let s = d.snapshot().unwrap();
    assert!(s.visible.iter().any(|n| n.block_attributes
        == Some(BlockAttributes::Code("rs".into()))
        && n.runs.iter().any(|r| r.text == "  code é😀\n")));
    assert!(s.visible.iter().any(|n| {
        n.runs
            .iter()
            .any(|r| r.attributes.get("link") == Some(&Any::from("https://example.com/b")))
    }));
    assert_eq!(d.history_state().undo_groups, 1);
}
#[test]
fn checked_state_and_heading_presentation_are_portable_edits() {
    let (mut d, ids, base) = prepared("# heading\n\n- [ ] task\n");
    base.prepare(&d, "## heading\n\n- [x] task\n", &origin())
        .unwrap()
        .commit(&mut d)
        .unwrap();
    let s = d.snapshot().unwrap();
    assert_eq!(owners(&d), ids);
    assert_eq!(
        s.visible
            .iter()
            .find(|n| n.id == ids[0])
            .unwrap()
            .block_attributes,
        Some(BlockAttributes::Heading(2))
    );
    assert_eq!(
        s.visible
            .iter()
            .find(|n| n.id == ids[1])
            .unwrap()
            .editor
            .as_ref()
            .unwrap()
            .checked,
        Some(true)
    );
}
#[test]
fn second_replica_disjoint_text_survives_original_anchors_and_undo() {
    let (mut d, ids, base) = prepared("prefix old suffix\n\nindependent\n");
    remote(&mut d, &ids[0], 0, "remote ");
    remote(&mut d, &ids[1], 0, "other ");
    let before = d.checkpoint().bytes;
    let edit = base
        .prepare(&d, "prefix new suffix\n\nindependent\n", &origin())
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before);
    edit.commit(&mut d).unwrap();
    assert_eq!(
        texts(&d),
        vec!["remote prefix new suffix", "other independent"]
    );
    assert_eq!(owners(&d), ids);
    d.undo().unwrap();
    assert_eq!(
        texts(&d),
        vec!["remote prefix old suffix", "other independent"]
    );
    d.redo().unwrap();
    assert_eq!(
        texts(&d),
        vec!["remote prefix new suffix", "other independent"]
    );
}
#[test]
fn overlapping_remote_text_rejects_with_base_draft_and_current_recoverable() {
    let (mut d, ids, base) = prepared("prefix old suffix\n");
    remote(&mut d, &ids[0], 8, "REMOTE");
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    let draft = "prefix new suffix\n";
    let error = base.prepare(&d, draft, &origin()).err().unwrap();
    assert_eq!(error.kind, ConflictKind::Overlap);
    assert_eq!(error.source.as_deref(), Some(draft));
    assert_eq!(base.source(), "prefix old suffix\n");
    assert_eq!(draft, "prefix new suffix\n");
    assert!(texts(&d)[0].contains("REMOTE"));
    unchanged(&d, &before, &vector, 0);
}
#[test]
fn late_second_target_failure_cannot_apply_a_first_delta() {
    let (mut d, ids, base) = prepared("old one\n\nold two\n");
    remote(&mut d, &ids[1], 1, "overlap");
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    assert_eq!(
        base.prepare(&d, "new one\n\nnew two\n", &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::Overlap
    );
    unchanged(&d, &before, &vector, 0);
}
#[test]
fn deleted_and_moved_targets_conflict_without_redirect_or_partial_mutation() {
    for moved in [false, true] {
        let (mut d, ids, base) = prepared("one\n\ntwo\n");
        let command = if moved {
            EditorCommand::List(editac_core::commands::lists::ListCommand::Wrap {
                targets: vec![ids[1].clone()],
                style: editac_core::commands::lists::ContainerStyle::Quote,
            })
        } else {
            EditorCommand::Join {
                first: ids[0].clone(),
                second: ids[1].clone(),
            }
        };
        let p = d.prepare_editor(&[command], &origin()).unwrap();
        d.commit_editor(p).unwrap();
        let before = d.checkpoint().bytes;
        let vector = d.state_vector_v1();
        let count = d.history_state().undo_groups;
        let error = base
            .prepare(&d, "one\n\nchanged\n", &origin())
            .err()
            .unwrap();
        assert_eq!(
            error.kind,
            if moved {
                ConflictKind::MovedTarget
            } else {
                ConflictKind::DeletedTarget
            }
        );
        unchanged(&d, &before, &vector, count);
    }
}
#[test]
fn unsupported_atom_is_preserved_by_unrelated_edit_and_changed_atom_rejects() {
    let (mut d, ids, _) = prepared("known\n\nopaque\n");
    let opaque_id = ids[1].clone();
    let mut checkpoint = d.checkpoint();
    let raw = m::replica(99);
    m::apply(&raw, &checkpoint.bytes).unwrap();
    m::set(
        &raw,
        4,
        &opaque_id,
        Any::Array(
            vec![
                Any::from("vendor:unknown"),
                Any::from(1u32),
                Any::from("exact data"),
            ]
            .into(),
        ),
    );
    checkpoint.bytes = m::bytes(&raw);
    d = Document::restore(&checkpoint.identity, &checkpoint, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    let bound = vec![ids[0].clone(), opaque_id.clone()];
    let base = SourceBaseline::capture(
        &d,
        "known\n\nopaque\n",
        SourceMode::Markdown(Codecs::default()),
        &bound,
    )
    .unwrap();
    let old = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == opaque_id)
        .unwrap()
        .as_ref()
        .clone();
    base.prepare(&d, "changed\n\nopaque\n", &origin())
        .unwrap()
        .commit(&mut d)
        .unwrap();
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == opaque_id)
            .unwrap()
            .as_ref(),
        &old
    );
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    assert_eq!(
        base.prepare(&d, "known\n\nchanged atom\n", &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::UnsupportedContent
    );
    unchanged(&d, &before, &vector, 1);
}
#[test]
fn literal_mode_never_interprets_markdown_and_preserves_unicode_boundaries() {
    let mut d = blank();
    let id = owners(&d)[0].clone();
    let source = "# **literal** 😀\r\n";
    let at = d.anchor(&id, U(0), Bias::Right).unwrap();
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: source.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap();
    d.clear_history();
    let base = SourceBaseline::capture(&d, source, SourceMode::Literal, &[id.clone()]).unwrap();
    let edited = "# **literal** é😀\r\n";
    base.prepare(&d, edited, &origin())
        .unwrap()
        .commit(&mut d)
        .unwrap();
    assert_eq!(texts(&d), vec![edited]);
    assert_eq!(
        d.snapshot().unwrap().visible[0].block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    assert!(
        d.snapshot().unwrap().visible[0]
            .runs
            .iter()
            .all(|r| r.attributes.is_empty())
    );
}
#[test]
fn ambiguity_structural_change_limits_and_stale_commit_keep_current_state() {
    let (mut d, ids, base) = prepared("one\n\ntwo\n");
    assert_eq!(
        SourceBaseline::capture(
            &d,
            base.source(),
            SourceMode::Markdown(Codecs::default()),
            &[ids[0].clone(), ids[0].clone()]
        )
        .err()
        .unwrap()
        .kind,
        ConflictKind::AmbiguousMapping
    );
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    assert_eq!(
        base.prepare(&d, "one\n\ntwo\n\nthree\n", &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::AmbiguousMapping
    );
    assert_eq!(
        base.prepare(&d, &"x".repeat(1048577), &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::ResourceLimit
    );
    unchanged(&d, &before, &vector, 0);
    let edit = base.prepare(&d, "ONE\n\ntwo\n", &origin()).unwrap();
    remote(&mut d, &ids[1], 0, "remote ");
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    let failure = edit.commit(&mut d).err().unwrap();
    assert_eq!(failure.kind, ConflictKind::StalePlan);
    assert_eq!(failure.source.as_deref(), Some("ONE\n\ntwo\n"));
    unchanged(&d, &before, &vector, 0);
}
#[test]
fn core_atomic_batch_rejects_invalid_later_fragment_before_live_effects() {
    let (d, ids, _) = prepared("one\n\ntwo\n");
    let selection = |id: &str| Selection {
        anchor: d.anchor(id, U(0), Bias::Right).unwrap(),
        focus: d.anchor(id, U(3), Bias::Left).unwrap(),
    };
    let before = d.checkpoint().bytes;
    let vector = d.state_vector_v1();
    let good = import("valid").unwrap().blocks;
    let mut bad = good.clone();
    bad[0].attributes = Some(BlockAttributes::Heading(9));
    assert!(
        d.prepare_source_edits(
            &[(selection(&ids[0]), good), (selection(&ids[1]), bad)],
            &origin()
        )
        .is_err()
    );
    unchanged(&d, &before, &vector, 0);
}

#[test]
fn a_source_baseline_and_noop_plan_cannot_cross_document_identity() {
    let (d, _, base) = prepared("one\n\ntwo\n");
    let identity = DocumentIdentity::v5(
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )
    .unwrap();
    let mut other = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "other".into(),
        }],
    )
    .unwrap();
    let before = other.checkpoint().bytes;
    let vector = other.state_vector_v1();
    let conflict = base
        .prepare(&other, base.source(), &origin())
        .err()
        .unwrap();
    assert_eq!(conflict.kind, ConflictKind::IdentityMismatch);
    assert_eq!(conflict.source.as_deref(), Some(base.source()));
    let noop = base.prepare(&d, base.source(), &origin()).unwrap();
    let conflict = noop.commit(&mut other).err().unwrap();
    assert_eq!(conflict.kind, ConflictKind::IdentityMismatch);
    assert_eq!(conflict.source.as_deref(), Some(base.source()));
    assert_eq!(other.checkpoint().bytes, before);
    assert_eq!(other.state_vector_v1(), vector);
}
