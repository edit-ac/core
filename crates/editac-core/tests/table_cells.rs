#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::commands::editor::FragmentRun;
use editac_core::{
    commands::{editor::EditorCommand, format::Mark, text::TextOrigin},
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::content::{Alignment, Content},
};
use yrs::Any;
fn engine() -> Document {
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let mut d = Document::restore(
        &identity,
        &InitializedCheckpoint {
            identity: identity.clone(),
            initialized: true,
            writer_id: 11,
            bytes: m::bytes(&m::seed()),
        },
        &[],
    )
    .unwrap();
    let content = Content::Table {
        alignments: vec![Alignment::Left, Alignment::None],
        rows: vec![vec![
            vec![
                FragmentRun {
                    opaque_marks: vec![],
                    text: "ab😀".into(),
                    marks: vec![(Mark::Bold, None)],
                },
                FragmentRun {
                    opaque_marks: vec![],
                    text: "cd".into(),
                    marks: vec![],
                },
            ],
            vec![FragmentRun {
                opaque_marks: vec![],
                text: "other".into(),
                marks: vec![],
            }],
        ]],
        source: "original source".into(),
    };
    let p = d
        .prepare_editor(
            &[EditorCommand::Content {
                target: "n:11:1".into(),
                content,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    d
}
fn origin() -> TextOrigin {
    TextOrigin::new("table-cell-test").unwrap()
}
fn attrs(d: &mut Document) -> Any {
    d.snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == "n:11:1")
        .unwrap()
        .block_attributes
        .as_ref()
        .unwrap()
        .tuple()
}
fn edit(expected: Any, row: usize, column: usize, text: &str) -> EditorCommand {
    EditorCommand::TableCell {
        target: "n:11:1".into(),
        expected,
        row,
        column,
        text: text.into(),
    }
}
#[test]
fn cell_edit_is_prepared_atomic_and_preserves_owner_and_marks() {
    let mut d = engine();
    let before = d.checkpoint().bytes;
    let expected = attrs(&mut d);
    let p = d
        .prepare_editor(&[edit(expected.clone(), 0, 0, "abX😀cd")], &origin())
        .unwrap();
    assert_eq!(before, d.checkpoint().bytes);
    d.commit_editor(p).unwrap();
    let Some(Content::Table { rows, source, .. }) = Content::from_tuple(&attrs(&mut d)).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        rows[0][0]
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "abX😀cd"
    );
    assert_eq!(rows[0][0][0].marks, vec![(Mark::Bold, None)]);
    assert_eq!(rows[0][0].last().unwrap().text, "cd");
    assert_eq!(rows[0][1][0].text, "other");
    assert_eq!(source, "original source");
    let node = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == "n:11:1")
        .unwrap();
    assert_eq!(
        node.runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "abX😀cd\tother"
    );
    let bytes = d.checkpoint().bytes;
    assert!(
        d.prepare_editor(&[edit(expected, 0, 0, "stale")], &origin())
            .is_err()
    );
    assert_eq!(bytes, d.checkpoint().bytes);
}
#[test]
fn malformed_out_of_range_cr_and_oversized_cells_do_not_mutate() {
    let mut d = engine();
    let expected = attrs(&mut d);
    let bytes = d.checkpoint().bytes;
    for c in [
        edit(expected.clone(), 1, 0, "x"),
        edit(expected.clone(), 0, 2, "x"),
        edit(expected.clone(), 0, 0, "new\rrow"),
        edit(expected.clone(), 0, 0, &"x".repeat(1048577)),
        edit(Any::Null, 0, 0, "x"),
    ] {
        assert!(d.prepare_editor(&[c], &origin()).is_err());
        assert_eq!(bytes, d.checkpoint().bytes);
    }
}

#[test]
fn multiline_cell_preserves_marks_scalars_and_source_through_prepared_reopen() {
    let mut d = engine();
    let expected = attrs(&mut d);
    let before = d.checkpoint().bytes;
    let p = d
        .prepare_editor(&[edit(expected, 0, 0, "ab\n😀cd\n\n")], &origin())
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before);
    d.commit_editor(p).unwrap();
    let Content::Table { rows, source, .. } = Content::from_tuple(&attrs(&mut d)).unwrap().unwrap()
    else {
        panic!()
    };
    assert_eq!(
        rows[0][0]
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "ab\n😀cd\n\n"
    );
    assert_eq!(rows[0][0][0].marks, vec![(Mark::Bold, None)]);
    assert_eq!(rows[0][1][0].text, "other");
    assert_eq!(source, "original source");
    let checkpoint = d.checkpoint();
    let mut reopened = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    assert_eq!(attrs(&mut reopened), attrs(&mut d));
}
