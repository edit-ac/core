//! STB-1.2: actual shared prepared planner and portable command translation.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    commands::{
        editor::{EditorCommand, EditorError},
        table::TableAction,
        text::TextOrigin,
    },
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    interchange::Command,
    modules::content::Content,
};
use serde_json::{Value, json};
use yrs::Any;
const OWNER: &str = "n:11:1";
fn origin() -> TextOrigin {
    TextOrigin::new("table-structure").unwrap()
}
fn runs(text: &str) -> Value {
    json!([[text, [["bold"], ["link", "https://example.test/"]]]])
}
fn cell(text: &str, style: Value) -> Value {
    json!({"paragraphs":[{"style":style,"runs":runs(text)}], "rowSpan":1,"columnSpan":1,"header":true})
}
fn tuple(v2: bool) -> Value {
    let rows = if v2 {
        json!([
            [
                cell("ab😀cd", json!(["heading", 2])),
                cell("code", json!(["code", "rust"]))
            ],
            [
                cell("אב", json!(["paragraph"])),
                cell("tail", json!(["paragraph"]))
            ]
        ])
    } else {
        json!([[runs("ab😀cd"), runs("code")], [runs("אב"), runs("tail")]])
    };
    json!(["module:editac.table", if v2 {2} else {1}, {"alignments":["left","right"], "rows":rows,"source":"retained original"}])
}
fn any(v: &Value) -> Any {
    Any::from_json(&v.to_string()).unwrap()
}
fn engine(t: &Value) -> Document {
    let id = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let mut d = Document::restore(
        &id,
        &InitializedCheckpoint {
            identity: id.clone(),
            initialized: true,
            writer_id: 11,
            bytes: m::bytes(&m::seed()),
        },
        &[],
    )
    .unwrap();
    let content = Content::from_tuple(&any(t)).unwrap().unwrap();
    let p = d
        .prepare_editor(
            &[EditorCommand::Content {
                target: OWNER.into(),
                content,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    // Reopen the baseline so tests measure only the requested edit's history.
    {
        let mut restored = Document::restore(&id, &d.checkpoint(), &[]).unwrap();
        restored
            .enable_history(editac_core::history::HistoryConfig::default())
            .unwrap();
        restored
    }
}
fn attrs(d: &Document) -> Value {
    let n = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == OWNER)
        .unwrap();
    {
        let mut json = String::new();
        n.block_attributes
            .as_ref()
            .unwrap()
            .tuple()
            .to_json(&mut json);
        serde_json::from_str(&json).unwrap()
    }
}
fn command(t: &Value, action: TableAction, index: usize) -> EditorCommand {
    EditorCommand::TableStructure {
        target: OWNER.into(),
        expected: any(t),
        action,
        index,
    }
}
fn commit(d: &mut Document, c: EditorCommand) {
    let before = d.checkpoint().bytes;
    let p = d.prepare_editor(&[c], &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, before, "prepare mutated live replica");
    assert!(!d.commit_editor(p).unwrap().update.bytes.is_empty());
}
fn reject(d: &mut Document, c: EditorCommand, error: EditorError) {
    let before = d.checkpoint().bytes;
    assert_eq!(d.prepare_editor(&[c], &origin()).err(), Some(error));
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn both_versions_support_all_structural_actions_with_exact_survivors_history_and_reopen() {
    for v2 in [false, true] {
        for (insert, delete, index) in [
            (TableAction::InsertRow, TableAction::DeleteRow, 1),
            (TableAction::InsertColumn, TableAction::DeleteColumn, 1),
        ] {
            let original = tuple(v2);
            let mut d = engine(&original);
            let before = d.snapshot().unwrap();
            commit(&mut d, command(&original, insert, index));
            let after = attrs(&d);
            assert_eq!(after[0], original[0]);
            assert_eq!(after[1], original[1]);
            assert_eq!(after[2]["source"], original[2]["source"]);
            if insert == TableAction::InsertRow {
                assert_eq!(after[2]["rows"][0], original[2]["rows"][0]);
                assert_eq!(after[2]["rows"][2], original[2]["rows"][1]);
                assert_eq!(after[2]["alignments"], original[2]["alignments"]);
            } else {
                for r in 0..2 {
                    assert_eq!(after[2]["rows"][r][0], original[2]["rows"][r][0]);
                    assert_eq!(after[2]["rows"][r][2], original[2]["rows"][r][1]);
                }
                assert_eq!(after[2]["alignments"], json!(["left", "none", "right"]));
            }
            let blank = if insert == TableAction::InsertRow {
                &after[2]["rows"][1][0]
            } else {
                &after[2]["rows"][0][1]
            };
            if v2 {
                assert_eq!(
                    blank,
                    &json!({"paragraphs":[{"style":["paragraph"],"runs":[["",[]]]}],"rowSpan":1,"columnSpan":1,"header":false})
                );
            } else {
                assert_eq!(blank, &json!([["", []]]));
            }
            assert_eq!(d.history_state().undo_groups, 1);
            d.undo().unwrap().unwrap();
            assert_eq!(attrs(&d), original);
            d.redo().unwrap().unwrap();
            assert_eq!(attrs(&d), after);
            let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
            assert_eq!(attrs(&restored), after);
            // Unrelated owners, spans, parent/order and formatting stay intact.
            let now = d.snapshot().unwrap();
            for node in before.visible.iter().filter(|n| n.id != OWNER) {
                assert_eq!(now.visible.iter().find(|n| n.id == node.id), Some(node));
            }
            commit(&mut d, command(&after, delete, index));
            assert_eq!(attrs(&d), original);
        }
    }
}
#[test]
fn v2_single_block_edits_keep_styles_headers_spans_marks_and_untouched_payloads() {
    let original = tuple(true);
    let mut d = engine(&original);
    commit(
        &mut d,
        EditorCommand::TableCell {
            target: OWNER.into(),
            expected: any(&original),
            row: 0,
            column: 0,
            text: "abX😀cd".into(),
        },
    );
    let after = attrs(&d);
    assert_eq!(
        after[2]["rows"][0][0]["paragraphs"][0]["style"],
        json!(["heading", 2])
    );
    assert_eq!(after[2]["rows"][0][0]["header"], true);
    assert_eq!(
        after[2]["rows"][0][0]["paragraphs"][0]["runs"],
        runs("abX😀cd")
    );
    let mut expected = original.clone();
    expected[2]["rows"][0][0]["paragraphs"][0]["runs"] = runs("abX😀cd");
    assert_eq!(after, expected);
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), original);
    d.redo().unwrap().unwrap();
    assert_eq!(attrs(&d), after);
    commit(
        &mut d,
        EditorCommand::TableCell {
            target: OWNER.into(),
            expected: any(&after),
            row: 0,
            column: 1,
            text: "".into(),
        },
    );
    assert_eq!(
        attrs(&d)[2]["rows"][0][1]["paragraphs"][0]["style"],
        json!(["code", "rust"])
    );
}
#[test]
fn rich_span_cell_edits_preserve_geometry_but_covered_multiblock_and_structure_reject() {
    let mut t = tuple(true);
    t[2]["rows"][0][0]["columnSpan"] = json!(2);
    t[2]["rows"][0][1] = Value::Null;
    let mut d = engine(&t);
    for action in [
        TableAction::InsertRow,
        TableAction::DeleteRow,
        TableAction::InsertColumn,
        TableAction::DeleteColumn,
    ] {
        reject(
            &mut d,
            command(&t, action, 0),
            EditorError::UnsupportedTarget,
        );
    }
    reject(
        &mut d,
        EditorCommand::TableCell {
            target: OWNER.into(),
            expected: any(&t),
            row: 0,
            column: 1,
            text: "no".into(),
        },
        EditorError::UnsupportedTarget,
    );
    commit(
        &mut d,
        EditorCommand::TableCell {
            target: OWNER.into(),
            expected: any(&t),
            row: 0,
            column: 0,
            text: "span".into(),
        },
    );
    assert_eq!(attrs(&d)[2]["rows"][0][1], Value::Null);
    assert_eq!(attrs(&d)[2]["rows"][0][0]["columnSpan"], 2);
    let mut t = tuple(true);
    let extra = t[2]["rows"][0][0]["paragraphs"][0].clone();
    t[2]["rows"][0][0]["paragraphs"]
        .as_array_mut()
        .unwrap()
        .push(extra);
    let mut d = engine(&t);
    reject(
        &mut d,
        EditorCommand::TableCell {
            target: OWNER.into(),
            expected: any(&t),
            row: 0,
            column: 0,
            text: "no".into(),
        },
        EditorError::UnsupportedTarget,
    );
    // Structural shifts retain multi-block cells verbatim.
    commit(&mut d, command(&t, TableAction::InsertRow, 0));
    assert_eq!(attrs(&d)[2]["rows"][1], t[2]["rows"][0]);
}
#[test]
fn stale_targets_indices_final_dimension_and_resource_limits_reject_without_mutation() {
    for v2 in [false, true] {
        let t = tuple(v2);
        let mut d = engine(&t);
        for action in [
            TableAction::InsertRow,
            TableAction::DeleteRow,
            TableAction::InsertColumn,
            TableAction::DeleteColumn,
        ] {
            reject(&mut d, command(&t, action, 3), EditorError::InvalidCommand);
        }
        commit(&mut d, command(&t, TableAction::InsertRow, 2));
        reject(
            &mut d,
            command(&t, TableAction::DeleteRow, 0),
            EditorError::PresentationConflict,
        );
        let mut one = tuple(v2);
        one[2]["rows"].as_array_mut().unwrap().truncate(1);
        let mut d = engine(&one);
        reject(
            &mut d,
            command(&one, TableAction::DeleteRow, 0),
            EditorError::InvalidCommand,
        );
        one[2]["alignments"].as_array_mut().unwrap().truncate(1);
        one[2]["rows"][0].as_array_mut().unwrap().truncate(1);
        let mut d = engine(&one);
        reject(
            &mut d,
            command(&one, TableAction::DeleteColumn, 0),
            EditorError::InvalidCommand,
        );
        let mut max = tuple(v2);
        max[2]["rows"] = json!(vec![max[2]["rows"][0].clone(); 128]);
        let mut d = engine(&max);
        reject(
            &mut d,
            command(&max, TableAction::InsertRow, 128),
            EditorError::ResourceLimit,
        );
        let mut max = tuple(v2);
        max[2]["alignments"] = json!(vec!["none"; 32]);
        max[2]["rows"] = json!([vec![max[2]["rows"][0][0].clone(); 32]]);
        let mut d = engine(&max);
        reject(
            &mut d,
            command(&max, TableAction::InsertColumn, 32),
            EditorError::ResourceLimit,
        );
    }
}
#[test]
fn portable_translation_uses_the_shared_planner_and_rejects_unknown_actions() {
    for v2 in [false, true] {
        for action in ["insertRow", "deleteRow", "insertColumn", "deleteColumn"] {
            let t = tuple(v2);
            let mut d = engine(&t);
            let c:Command=serde_json::from_value(json!({"type":"tableStructure","owner":OWNER,"expected":t,"action":action,"index":1})).unwrap();
            commit(
                &mut d,
                c.translate(|_| panic!("table command must not invent anchors"))
                    .unwrap(),
            );
            Content::from_tuple(&any(&attrs(&d))).unwrap().unwrap();
        }
    }
    assert!(Command::TYPES.contains(&"tableStructure"));
    for action in ["merge", "insertrow", ""] {
        assert!(serde_json::from_value::<Command>(json!({"type":"tableStructure","owner":OWNER,"expected":tuple(true),"action":action,"index":0})).is_err());
    }
}
