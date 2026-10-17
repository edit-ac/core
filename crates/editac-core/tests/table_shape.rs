//! RCH-1.6: real portable table shape, rectangle, replay and WCF-08 boundaries.
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

use editac_core::{
    commands::table::{CellRectangle, RectangleEdit, rectangle_commands},
    document::ReplayUpdate,
};
fn rectangle() -> CellRectangle {
    CellRectangle {
        row: 0,
        column: 0,
        rows: 2,
        columns: 2,
    }
}
fn apply(d: &mut Document, commands: &[EditorCommand]) -> ReplayUpdate {
    let checkpoint = d.checkpoint().bytes;
    let plan = d.prepare_editor(commands, &origin()).unwrap();
    assert_eq!(checkpoint, d.checkpoint().bytes);
    d.commit_editor(plan).unwrap().update
}
fn fork(d: &Document) -> Document {
    Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap()
}

#[test]
fn rectangular_clear_and_paste_are_single_groups_and_preserve_geometry_identity_and_marks() {
    for v2 in [false, true] {
        let original = tuple(v2);
        let mut d = engine(&original);
        let initial = d.snapshot().unwrap();
        let cells = vec![
            vec!["ab😀XY".into(), "literal\ttab".into()],
            vec!["אב".into(), "".into()],
        ];
        let commands = rectangle_commands(
            OWNER,
            &any(&original),
            rectangle(),
            RectangleEdit::Paste(&cells),
            &[],
        )
        .unwrap();
        assert_eq!(commands.len(), 4);
        apply(&mut d, &commands);
        let pasted = attrs(&d);
        assert_eq!(d.history_state().undo_groups, 1);
        assert_eq!(pasted[2]["alignments"], original[2]["alignments"]);
        assert_eq!(pasted[2]["source"], original[2]["source"]);
        for r in 0..2 {
            for c in 0..2 {
                let runs = if v2 {
                    &pasted[2]["rows"][r][c]["paragraphs"][0]["runs"]
                } else {
                    &pasted[2]["rows"][r][c]
                };
                let text: String = runs
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|run| run[0].as_str().unwrap())
                    .collect();
                assert_eq!(text, cells[r][c]);
                if !text.is_empty() {
                    assert_eq!(
                        runs[0][1],
                        original[2]["rows"][r][c]
                            .get("paragraphs")
                            .map_or(&original[2]["rows"][r][c][0][1], |p| &p[0]["runs"][0][1])
                            .clone()
                    );
                }
                if v2 {
                    for key in ["rowSpan", "columnSpan", "header"] {
                        assert_eq!(pasted[2]["rows"][r][c][key], original[2]["rows"][r][c][key]);
                    }
                }
            }
        }
        d.undo().unwrap().unwrap();
        assert_eq!(attrs(&d), original);
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), pasted);
        let clear =
            rectangle_commands(OWNER, &any(&pasted), rectangle(), RectangleEdit::Clear, &[])
                .unwrap();
        apply(&mut d, &clear);
        let cleared = attrs(&d);
        assert_eq!(cleared[2]["rows"].as_array().unwrap().len(), 2);
        assert!(
            cleared[2]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r.as_array().unwrap().len() == 2)
        );
        for r in 0..2 {
            for c in 0..2 {
                let runs = if v2 {
                    &cleared[2]["rows"][r][c]["paragraphs"][0]["runs"]
                } else {
                    &cleared[2]["rows"][r][c]
                };
                assert!(runs.as_array().unwrap().iter().all(|r| r[0] == ""));
            }
        }
        assert_eq!(d.history_state().undo_groups, 2);
        d.undo().unwrap().unwrap();
        assert_eq!(attrs(&d), pasted);
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), cleared);
        assert_eq!(attrs(&fork(&d)), cleared);
        for node in initial.visible.iter().filter(|n| n.id != OWNER) {
            assert_eq!(
                d.snapshot()
                    .unwrap()
                    .visible
                    .iter()
                    .find(|n| n.id == node.id),
                Some(node)
            );
        }
        assert_eq!(
            d.fragment_for_node(OWNER)
                .unwrap()
                .attributes
                .unwrap()
                .tuple(),
            any(&cleared)
        );
    }
}

#[test]
fn invalid_rectangles_protected_cells_dimensions_and_resource_limits_fail_before_mutation() {
    let original = tuple(false);
    let d = engine(&original);
    let before = d.checkpoint().bytes;
    let history = d.history_state();
    let expected = any(&original);
    let cases = [
        (
            CellRectangle {
                rows: 0,
                ..rectangle()
            },
            EditorError::InvalidCommand,
        ),
        (
            CellRectangle {
                row: 2,
                ..rectangle()
            },
            EditorError::InvalidCommand,
        ),
        (
            CellRectangle {
                row: usize::MAX,
                ..rectangle()
            },
            EditorError::ResourceLimit,
        ),
        (
            CellRectangle {
                rows: 129,
                columns: 1,
                ..rectangle()
            },
            EditorError::ResourceLimit,
        ),
        (
            CellRectangle {
                rows: usize::MAX,
                columns: 2,
                ..rectangle()
            },
            EditorError::ResourceLimit,
        ),
    ];
    for (range, error) in cases {
        assert_eq!(
            rectangle_commands(OWNER, &expected, range, RectangleEdit::Clear, &[]).err(),
            Some(error)
        );
    }
    assert_eq!(
        rectangle_commands(
            OWNER,
            &expected,
            rectangle(),
            RectangleEdit::Clear,
            &[(1, 1)]
        )
        .err(),
        Some(EditorError::UnsupportedTarget)
    );
    assert!(
        rectangle_commands(
            OWNER,
            &expected,
            rectangle(),
            RectangleEdit::Clear,
            &[(3, 3)]
        )
        .is_ok()
    );
    for cells in [
        vec![vec!["x".into()]],
        vec![vec!["x".into(), "y".into()], vec!["z".into()]],
        vec![vec!["x\ry".into(), "".into()], vec!["".into(), "".into()]],
    ] {
        assert_eq!(
            rectangle_commands(
                OWNER,
                &expected,
                rectangle(),
                RectangleEdit::Paste(&cells),
                &[]
            )
            .err(),
            Some(EditorError::InvalidCommand)
        );
    }
    let oversized = vec![
        vec!["x".repeat(524289), "x".repeat(524289)],
        vec!["".into(), "".into()],
    ];
    assert_eq!(
        rectangle_commands(
            OWNER,
            &expected,
            rectangle(),
            RectangleEdit::Paste(&oversized),
            &[]
        )
        .err(),
        Some(EditorError::ResourceLimit)
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state(), history);
}

#[test]
fn stale_rectangle_and_invalid_late_cell_reject_the_entire_engine_batch() {
    let original = tuple(false);
    let mut d = engine(&original);
    let commands = rectangle_commands(
        OWNER,
        &any(&original),
        rectangle(),
        RectangleEdit::Clear,
        &[],
    )
    .unwrap();
    // A host must send the complete sequence to one preparation. Corrupting the
    // last target proves preceding staged cells never reach the live replica.
    let mut invalid = commands.clone();
    if let EditorCommand::TableCell { column, .. } = invalid.last_mut().unwrap() {
        *column = 99;
    }
    let before = d.checkpoint().bytes;
    assert!(d.prepare_editor(&invalid, &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 0);
    apply(&mut d, &[command(&original, TableAction::InsertColumn, 0)]);
    let before = d.checkpoint().bytes;
    assert_eq!(
        d.prepare_editor(&commands, &origin()).err(),
        Some(EditorError::PresentationConflict)
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 1);
}

#[test]
fn merged_cells_reject_rectangle_and_shape_actions_without_flattening() {
    let mut original = tuple(true);
    original[2]["rows"][0][0]["columnSpan"] = json!(2);
    original[2]["rows"][0][1] = Value::Null;
    let mut d = engine(&original);
    let before = d.checkpoint().bytes;
    assert_eq!(
        rectangle_commands(
            OWNER,
            &any(&original),
            rectangle(),
            RectangleEdit::Clear,
            &[]
        )
        .err(),
        Some(EditorError::UnsupportedTarget)
    );
    reject(
        &mut d,
        command(&original, TableAction::InsertRow, 0),
        EditorError::UnsupportedTarget,
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(attrs(&d), original);
}

#[test]
fn concurrent_shape_and_cell_writes_converge_without_projection_repairs() {
    for v2 in [false, true] {
        let original = tuple(v2);
        let seed = engine(&original);
        let mut row = fork(&seed);
        let mut column = fork(&seed);
        let mut cell = fork(&seed);
        let updates = [
            apply(&mut row, &[command(&original, TableAction::InsertRow, 1)]),
            apply(
                &mut column,
                &[command(&original, TableAction::DeleteColumn, 1)],
            ),
            apply(
                &mut cell,
                &[EditorCommand::TableCell {
                    target: OWNER.into(),
                    expected: any(&original),
                    row: 1,
                    column: 1,
                    text: "peer😀".into(),
                }],
            ),
        ];
        let authored = [attrs(&row), attrs(&column), attrs(&cell)];
        let mut canonical = None;
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let mut receiver = fork(&seed);
            for i in order {
                receiver.apply_replay(&updates[i]).unwrap();
            }
            let checkpoint = receiver.checkpoint().bytes;
            let result = attrs(&receiver);
            assert!(
                authored.contains(&result),
                "atomic tuple must be an authored value"
            );
            if let Some(expected) = &canonical {
                assert_eq!(&result, expected);
            } else {
                canonical = Some(result);
            }
            for _ in 0..3 {
                receiver.snapshot().unwrap();
                receiver.fragment_for_node(OWNER).unwrap();
            }
            assert_eq!(
                receiver.checkpoint().bytes,
                checkpoint,
                "presenter reads must never repair"
            );
            for i in order {
                receiver.apply_replay(&updates[i]).unwrap();
            }
            assert_eq!(
                receiver.checkpoint().bytes,
                checkpoint,
                "duplicate delivery must be inert"
            );
            assert_eq!(attrs(&fork(&receiver)), canonical.clone().unwrap());
        }
    }
}

#[test]
fn removed_destination_rejects_stale_plans_and_remote_edit_stays_retained() {
    let original = tuple(false);
    let seed = engine(&original);
    let mut remover = fork(&seed);
    let mut writer = fork(&seed);
    let stale = writer
        .prepare_editor(&[command(&original, TableAction::InsertRow, 0)], &origin())
        .unwrap();
    let removed = apply(
        &mut remover,
        &[EditorCommand::Enable {
            target: OWNER.into(),
            enabled: false,
        }],
    );
    let edited = apply(
        &mut writer,
        &[command(&original, TableAction::InsertColumn, 0)],
    );
    writer.apply_replay(&removed).unwrap();
    let before = writer.checkpoint().bytes;
    assert!(writer.commit_editor(stale).is_err());
    assert!(
        writer
            .prepare_editor(&[command(&original, TableAction::InsertRow, 0)], &origin())
            .is_err()
    );
    assert_eq!(writer.checkpoint().bytes, before);
    remover.apply_replay(&edited).unwrap();
    assert_eq!(
        writer.snapshot().unwrap().visible,
        remover.snapshot().unwrap().visible
    );
    assert!(
        writer
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .all(|n| n.id != OWNER)
    );
    apply(
        &mut remover,
        &[EditorCommand::Enable {
            target: OWNER.into(),
            enabled: true,
        }],
    );
    assert_eq!(
        attrs(&remover)[2]["alignments"].as_array().unwrap().len(),
        3
    );
}

#[test]
fn wcf08_self_paste_and_overdepth_reject_then_copy_history_serialization_and_drop_remain_bounded() {
    use editac_core::commands::{editor::FragmentBlock, lists::ContainerStyle};
    let original = tuple(false);
    let mut d = engine(&original);
    // The common schema seed deliberately contains an unknown dormant mark.
    // Establish the real table command's generated fallback before copying;
    // copying the raw seed must conservatively reject that unknown mark.
    assert_eq!(
        d.fragment_for_node(OWNER).err(),
        Some(EditorError::UnsupportedTarget)
    );
    apply(
        &mut d,
        &[EditorCommand::TableCell {
            target: OWNER.into(),
            expected: any(&original),
            row: 0,
            column: 0,
            text: "ab😀cd".into(),
        }],
    );
    d = fork(&d);
    d.enable_history(editac_core::history::HistoryConfig::default())
        .unwrap();
    let fragment = d.fragment_for_node(OWNER).unwrap();
    let destination = CellRectangle {
        row: 0,
        column: 0,
        rows: 1,
        columns: 1,
    };
    let copied = vec![vec![fragment.clone()]];
    let before = d.checkpoint().bytes;
    let history = d.history_state();
    for _ in 0..4 {
        assert_eq!(
            rectangle_commands(
                OWNER,
                &any(&original),
                destination,
                RectangleEdit::PasteFragment(&copied),
                &[]
            )
            .err(),
            Some(EditorError::UnsupportedTarget)
        );
    }
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state(), history);
    // Foreign nested table content cannot enter a simple cell's runs.
    let mut nested = original.clone();
    nested[2]["rows"][0][0] = json!([[original.clone(), []]]);
    assert!(Content::from_tuple(&any(&nested)).is_err());
    let mut overdepth: FragmentBlock = fragment.clone();
    overdepth.containers = (0..17)
        .map(|i| (format!("depth-{i}"), ContainerStyle::Quote))
        .collect();
    assert_eq!(
        rectangle_commands(
            OWNER,
            &any(&original),
            destination,
            RectangleEdit::PasteFragment(&[vec![overdepth]]),
            &[]
        )
        .err(),
        Some(EditorError::ResourceLimit)
    );
    assert_eq!(d.checkpoint().bytes, before);
    let serialized = editac_core::interchange::transfer_value(&fragment);
    let bytes = serde_json::to_vec(&serialized).unwrap();
    assert!(bytes.len() < 4096);
    let dto = serde_json::from_value(serialized).unwrap();
    assert_eq!(
        editac_core::interchange::transfer_blocks(vec![dto]).unwrap()[0]
            .attributes
            .as_ref()
            .unwrap()
            .tuple(),
        any(&original)
    );
    apply(&mut d, &[command(&original, TableAction::InsertRow, 1)]);
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), original);
    d.redo().unwrap().unwrap();
    assert_eq!(attrs(&d)[2]["rows"].as_array().unwrap().len(), 3);
    drop(fork(&d));
    drop(d);
    println!(
        "WCF-08 attempts=6 accepted=0 live_updates=0 history_groups=0 serialized_bytes={} followup_shape_groups=1 undo=1 redo=1 disposed_documents=2",
        bytes.len()
    );
}

#[path = "table_structure.rs"]
mod existing_shape_contract;

#[test]
fn decoded_fragment_cells_admit_plain_text_and_reject_lossy_marks_or_line_boundaries() {
    use editac_core::commands::editor::{FragmentBlock, FragmentRun};
    use editac_core::commands::format::Mark;
    let original = tuple(false);
    let mut d = engine(&original);
    let cell = FragmentBlock {
        runs: vec![
            FragmentRun {
                text: "A😀".into(),
                marks: vec![],
            },
            FragmentRun {
                text: "B".into(),
                marks: vec![],
            },
        ],
        attributes: Some(editac_core::document::BlockAttributes::Paragraph),
        containers: vec![],
        checked: None,
    };
    let range = CellRectangle {
        row: 0,
        column: 0,
        rows: 1,
        columns: 1,
    };
    let mut cells = vec![vec![cell.clone()]];
    cells[0][0].runs[0].marks.push((Mark::Bold, None));
    assert_eq!(
        rectangle_commands(
            OWNER,
            &any(&original),
            range,
            RectangleEdit::PasteFragment(&cells),
            &[]
        )
        .err(),
        Some(EditorError::UnsupportedTarget)
    );
    cells[0][0] = cell.clone();
    cells[0][0].runs[1].text = "\rB".into();
    assert_eq!(
        rectangle_commands(
            OWNER,
            &any(&original),
            range,
            RectangleEdit::PasteFragment(&cells),
            &[]
        )
        .err(),
        Some(EditorError::InvalidCommand)
    );
    cells[0][0] = cell;
    let commands = rectangle_commands(
        OWNER,
        &any(&original),
        range,
        RectangleEdit::PasteFragment(&cells),
        &[],
    )
    .unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(d.history_state().undo_groups, 0);
    apply(&mut d, &commands);
    assert_eq!(d.history_state().undo_groups, 1);
    let result = attrs(&d);
    let text: String = result[2]["rows"][0][0]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run[0].as_str().unwrap())
        .collect();
    assert_eq!(text, "A😀B");
    assert_eq!(result[2]["rows"][1], original[2]["rows"][1]);
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), original);
}

#[test]
fn public_rectangle_command_uses_existing_preparation_atomically() {
    use editac_core::interchange::Command;
    for v2 in [false, true] {
        let t = tuple(v2);
        let mut d = engine(&t);
        let translate = |cells: Value, protected: Value, rows: usize| {
            serde_json::from_value::<Command>(
                json!({"type":"tableRectangle","owner":OWNER,"expected":t,
                "row":0,"column":0,"rows":rows,"columns":2,"cells":cells,"protected":protected}),
            )
            .unwrap()
            .translate(|_| panic!("no table anchors"))
            .unwrap()
        };
        let before = d.checkpoint().bytes;
        for command in [
            translate(json!([["a"]]), json!([]), 1),
            translate(Value::Null, json!([[0, 1]]), 1),
            translate(Value::Null, json!([]), 0),
        ] {
            assert!(d.prepare_editor(&[command], &origin()).is_err());
            assert_eq!(d.checkpoint().bytes, before);
            assert_eq!(d.history_state().undo_groups, 0);
        }
        let command = translate(json!([["x😀", "אב"]]), json!([]), 1);
        let plan = d.prepare_editor(&[command], &origin()).unwrap();
        assert_eq!(d.checkpoint().bytes, before);
        d.commit_editor(plan).unwrap();
        assert_eq!(d.history_state().undo_groups, 1);
        assert_ne!(attrs(&d), t);
        d.undo().unwrap();
        assert_eq!(attrs(&d), t);
    }
    assert!(Command::TYPES.contains(&"tableRectangle"));
}
