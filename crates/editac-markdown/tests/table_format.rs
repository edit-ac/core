#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod mapping;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    modules::content::Content,
};
use editac_markdown::{
    export::equivalent,
    optional::{Codecs, import_with_codecs},
    reconcile::{ConflictKind, SourceBaseline, SourceMode},
};

fn origin() -> TextOrigin {
    TextOrigin::new("table-format:fixture").unwrap()
}
fn codecs() -> Codecs {
    Codecs {
        tables: true,
        ..Codecs::default()
    }
}
fn imported(source: &str) -> (Document, Vec<String>, SourceBaseline) {
    static BASE: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
        std::sync::OnceLock::new();
    let base = BASE.get_or_init(|| {
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
    let mut d = Document::restore(&base.identity, base, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    let first = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let selection = Selection {
        anchor: d.anchor(&first, U(0), Bias::Right).unwrap(),
        focus: d.anchor(&first, U(0), Bias::Left).unwrap(),
    };
    let parsed = import_with_codecs(source, codecs()).unwrap();
    let plan = d
        .prepare_fragment(&selection, &parsed.blocks, &origin())
        .unwrap();
    d.commit_editor(plan).unwrap();
    d.clear_history();
    let snapshot = d.snapshot().unwrap();
    let mut nodes = snapshot.visible.iter().filter(|n| n.kind == "block");
    let mut ids = Vec::new();
    for block in &parsed.blocks {
        let node = nodes
            .find(|n| {
                d.fragment_for_node(&n.id).is_ok_and(|current| {
                    current.attributes == block.attributes
                        && equivalent(&[current], &[block.clone()])
                })
            })
            .expect("imported block retains semantic identity");
        ids.push(node.id.clone());
    }
    let base = SourceBaseline::capture(&d, source, SourceMode::Markdown(codecs()), &ids).unwrap();
    (d, ids, base)
}
fn tables(d: &Document, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| matches!(table(d, id), Some(Content::Table { .. })))
        .cloned()
        .collect()
}
fn table(d: &Document, id: &str) -> Option<Content> {
    let block = d.fragment_for_node(id).ok()?;
    let Some(BlockAttributes::Unknown(tuple)) = block.attributes else {
        return None;
    };
    Content::from_tuple(&tuple).ok().flatten()
}
fn retained(d: &Document, id: &str) -> String {
    let Some(Content::Table { source, .. }) = table(d, id) else {
        panic!("table missing");
    };
    source
}
fn insert(d: &mut Document, id: &str) {
    let at = d.anchor(id, U(0), Bias::Right).unwrap();
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: "changed ".into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap();
}
fn unchanged(d: &Document, checkpoint: &[u8], history: usize) {
    assert_eq!(d.checkpoint().bytes, checkpoint);
    assert_eq!(d.history_state().undo_groups, history);
}
fn exercise(source: &str, selected: usize) -> String {
    let (mut d, ids, base) = imported(source);
    let owner = &tables(&d, &ids)[selected];
    let old_table = retained(&d, owner);
    let before = d.snapshot().unwrap();
    let bytes = d.checkpoint().bytes;
    let plan = base.prepare_table_format(&d, owner, &origin()).unwrap();
    assert!(plan.changed(), "fixture must exercise a real format");
    let expected = plan.source().to_owned();
    unchanged(&d, &bytes, 0);
    let result = plan.commit(&mut d).unwrap();
    let commit = result.commit.unwrap();
    assert!(!commit.update.bytes.is_empty());
    assert_eq!(result.source, expected);
    assert_eq!(d.history_state().undo_groups, 1);
    assert_eq!(base.source_with_current_table(&d, owner).unwrap(), expected);
    let after = d.snapshot().unwrap();
    assert_eq!(before.visible.len(), after.visible.len());
    for (old, new) in before.visible.iter().zip(&after.visible) {
        if old.id == *owner {
            assert_eq!(old.id, new.id);
            assert_eq!(old.spans, new.spans, "source ownership unchanged");
            assert_eq!(old.runs, new.runs, "backing text unchanged");
            assert_eq!(old.parent, new.parent);
            assert_eq!(old.editor, new.editor);
        } else {
            assert_eq!(old, new, "unselected nodes unchanged");
        }
    }
    let range = import_with_codecs(source, codecs()).unwrap().ranges
        [ids.iter().position(|id| id == owner).unwrap()]
    .clone();
    let formatted = retained(&d, owner);
    assert_eq!(&expected[..range.start], &source[..range.start]);
    assert_eq!(
        &expected[range.start + formatted.len()..],
        &source[range.end..]
    );
    let fresh =
        SourceBaseline::capture(&d, &expected, SourceMode::Markdown(codecs()), &ids).unwrap();
    let noop_bytes = d.checkpoint().bytes;
    let noop = fresh.prepare_table_format(&d, owner, &origin()).unwrap();
    assert!(!noop.changed());
    assert!(noop.commit(&mut d).unwrap().commit.is_none());
    unchanged(&d, &noop_bytes, 1);
    assert!(d.undo().unwrap().is_some());
    assert_eq!(retained(&d, owner), old_table);
    assert_eq!(
        base.source_with_current_table(&d, owner).unwrap(),
        source,
        "normal engine undo restores exact original bytes"
    );
    assert!(d.redo().unwrap().is_some());
    assert_eq!(base.source_with_current_table(&d, owner).unwrap(), expected);
    let checkpoint = d.checkpoint();
    let restored = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    assert_eq!(
        base.source_with_current_table(&restored, owner).unwrap(),
        expected
    );
    expected
}
#[test]
fn selected_first_table_keeps_surrounding_bytes_and_second_table_exact() {
    let source = include_str!("../../../fixtures/tables/source/multiple.md");
    let result = exercise(source, 0);
    assert!(result.contains("| a    | longer |\n| :--- | -----: |\n| one  | two    |"));
    assert!(result.contains("x|y\n---|---\n3|4"));
}
#[test]
fn selected_second_table_keeps_first_table_exact() {
    exercise(
        include_str!("../../../fixtures/tables/source/multiple.md"),
        1,
    );
}
#[test]
fn escaped_pipes_backslashes_code_delimiters_and_inline_marks_survive() {
    let result = exercise(
        include_str!("../../../fixtures/tables/source/lexemes.md"),
        0,
    );
    for lexeme in [
        r"a\|b",
        "``a ` b``",
        r"`x\| y`",
        "**bold** &amp;",
        r"a\\",
        "~~end~~",
        "[ok](https://example.com)",
    ] {
        assert!(result.contains(lexeme), "missing {lexeme:?}");
    }
}
#[test]
fn unicode_scalar_padding_is_declared_and_does_not_normalize_text() {
    let result = exercise(
        include_str!("../../../fixtures/tables/source/unicode.md"),
        0,
    );
    assert!(result.contains("| 😀   | é  | אב  |\n"));
    assert!(result.contains("| 👩‍💻 | 中\t文 |     |\n"));
}
#[test]
fn crlf_and_explicit_empty_trailing_cell_survive() {
    let result = exercise(include_str!("../../../fixtures/tables/source/crlf.md"), 0);
    assert!(!result.replace("\r\n", "").contains('\n'));
    assert!(result.ends_with("After\r\n"));
}
#[test]
fn eof_without_newline_stays_without_newline() {
    let result = exercise(include_str!("../../../fixtures/tables/source/eof.md"), 0);
    assert!(!result.ends_with('\n'));
}
#[test]
fn mixed_line_endings_are_retained_per_line() {
    let result = exercise(
        include_str!("../../../fixtures/tables/source/mixed-newlines.md"),
        0,
    );
    assert_eq!(result.lines().count(), 3);
    assert_eq!(result.matches("\r\n").count(), 2);
    assert_eq!(result.matches('\n').count(), 3);
}
#[test]
fn implicit_empty_cells_are_made_explicit_without_content_loss() {
    let result = exercise(
        include_str!("../../../fixtures/tables/source/implicit-empty.md"),
        0,
    );
    assert!(result.ends_with("| x   |     |     |\n"));
}
#[test]
fn stale_baseline_and_delayed_commit_reject_with_zero_effects() {
    let (mut d, ids, base) = imported("Before\n\na|b\n---|---\nc|d\n\nAfter\n");
    let owner = &tables(&d, &ids)[0];
    let pending = base.prepare_table_format(&d, owner, &origin()).unwrap();
    insert(&mut d, &ids[0]);
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&d, owner, &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::StalePlan
    );
    assert_eq!(
        pending.commit(&mut d).err().unwrap().kind,
        ConflictKind::StalePlan
    );
    unchanged(&d, &bytes, 1);
    assert_eq!(
        base.source_with_current_table(&d, owner).unwrap_err().kind,
        ConflictKind::Overlap
    );
}
#[test]
fn stale_noop_commit_also_rejects() {
    let (mut d, ids, base) = imported("Before\n\n| a   | b   |\n| --- | --- |\n| c   | d   |\n");
    let owner = &tables(&d, &ids)[0];
    let pending = base.prepare_table_format(&d, owner, &origin()).unwrap();
    assert!(!pending.changed());
    insert(&mut d, &ids[0]);
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        pending.commit(&mut d).err().unwrap().kind,
        ConflictKind::StalePlan
    );
    unchanged(&d, &bytes, 1);
}
#[test]
fn changed_table_descriptor_and_deleted_target_invalidate_baseline() {
    let (mut d, ids, base) = imported("a|b\n---|---\nc|d\n");
    let owner = &tables(&d, &ids)[0];
    let Some(BlockAttributes::Unknown(expected)) = d.fragment_for_node(owner).unwrap().attributes
    else {
        panic!();
    };
    let p = d
        .prepare_editor(
            &[EditorCommand::TableCell {
                target: owner.clone(),
                expected,
                row: 1,
                column: 0,
                text: "remote".into(),
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&d, owner, &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::StalePlan
    );
    unchanged(&d, &bytes, 1);
    let fresh =
        SourceBaseline::capture(&d, base.source(), SourceMode::Markdown(codecs()), &ids).unwrap();
    assert_eq!(
        fresh
            .prepare_table_format(&d, owner, &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::Overlap
    );
    let p = d
        .prepare_editor(
            &[EditorCommand::Enable {
                target: owner.clone(),
                enabled: false,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    assert_eq!(
        fresh
            .prepare_table_format(&d, owner, &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::StalePlan
    );
}
#[test]
fn non_table_unknown_owner_and_disabled_codec_reject_without_writes() {
    let (d, ids, base) = imported("Before\n\na|b\n---|---\nc|d\n");
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&d, &ids[0], &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::UnsupportedContent
    );
    assert_eq!(
        base.prepare_table_format(&d, "missing", &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::DeletedTarget
    );
    let disabled = SourceBaseline::capture(
        &d,
        base.source(),
        SourceMode::Markdown(Codecs::default()),
        &ids,
    )
    .unwrap();
    assert_eq!(
        disabled
            .prepare_table_format(&d, &tables(&d, &ids)[0], &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::UnsupportedContent
    );
    unchanged(&d, &bytes, 0);
}
#[test]
fn excess_ignored_source_cells_reject_instead_of_disappearing() {
    let (d, ids, base) = imported("a|b\n---|---\nc|d|must retain\n");
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&d, &tables(&d, &ids)[0], &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::UnsupportedContent
    );
    unchanged(&d, &bytes, 0);
}
#[test]
fn nested_container_source_is_explicitly_unsupported() {
    let (d, ids, base) = imported("> a|b\n> ---|---\n> c|d\n");
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&d, &tables(&d, &ids)[0], &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::UnsupportedContent
    );
    unchanged(&d, &bytes, 0);
}
#[test]
fn source_metadata_command_compares_exact_descriptor_and_enforces_limits() {
    let (d, ids, _) = imported("a|b\n---|---\nc|d\n");
    let owner = &tables(&d, &ids)[0];
    let Some(BlockAttributes::Unknown(expected)) = d.fragment_for_node(owner).unwrap().attributes
    else {
        panic!();
    };
    let bytes = d.checkpoint().bytes;
    for command in [
        EditorCommand::TableSource {
            target: owner.clone(),
            expected: yrs::Any::Null,
            source: "x".into(),
        },
        EditorCommand::TableSource {
            target: owner.clone(),
            expected,
            source: "x".repeat(1_048_577),
        },
    ] {
        assert!(d.prepare_editor(&[command], &origin()).is_err());
    }
    unchanged(&d, &bytes, 0);
}

#[test]
fn foreign_replica_identity_rejects_prepare_and_commit() {
    let (d, ids, base) = imported("a|b\n---|---\nc|d\n");
    let owner = &tables(&d, &ids)[0];
    let pending = base.prepare_table_format(&d, owner, &origin()).unwrap();
    let identity = DocumentIdentity::v5(
        "99777777-7777-4777-8777-777777777777",
        "99888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let mut foreign = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "foreign".into(),
        }],
    )
    .unwrap();
    let bytes = foreign.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&foreign, owner, &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::IdentityMismatch
    );
    assert_eq!(
        pending.commit(&mut foreign).err().unwrap().kind,
        ConflictKind::IdentityMismatch
    );
    assert_eq!(
        base.source_with_current_table(&foreign, owner)
            .unwrap_err()
            .kind,
        ConflictKind::IdentityMismatch
    );
    assert_eq!(foreign.checkpoint().bytes, bytes);
}

#[test]
fn remote_replay_invalidates_captured_format_without_a_local_history_effect() {
    let (mut d, ids, base) = imported("Before\n\na|b\n---|---\nc|d\n");
    let owner = &tables(&d, &ids)[0];
    let pending = base.prepare_table_format(&d, owner, &origin()).unwrap();
    let vector = d.state_vector_v1();
    let checkpoint = d.checkpoint();
    let mut remote = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    insert(&mut remote, &ids[0]);
    let update = editac_core::document::ReplayUpdate {
        identity: d.identity().clone(),
        bytes: remote.update_v1(&vector).unwrap(),
    };
    d.apply_replay(&update).unwrap();
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        base.prepare_table_format(&d, owner, &origin())
            .err()
            .unwrap()
            .kind,
        ConflictKind::StalePlan
    );
    assert_eq!(
        pending.commit(&mut d).err().unwrap().kind,
        ConflictKind::StalePlan
    );
    unchanged(&d, &bytes, 0);
}
