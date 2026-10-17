//! RCH-1.23-T2: v2 prepared formatting/rectangle admission and exact effects.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    commands::{
        editor::EditorCommand,
        format::{FormatAction, Mark},
        table::CellRectangle,
        text::TextOrigin,
    },
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::content::Content,
};
use serde_json::{Value, json};
use yrs::Any;
const OWNER: &str = "n:11:1";
fn origin() -> TextOrigin {
    TextOrigin::new("table-attributes").unwrap()
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

fn fixture() -> Value {
    let value: Value = serde_json::from_str(include_str!(
        "../../../fixtures/rich-presenters/formatting/table-blocks.json"
    ))
    .unwrap();
    value["tuple"].clone()
}
fn rectangle() -> CellRectangle {
    CellRectangle {
        row: 1,
        column: 0,
        rows: 1,
        columns: 2,
    }
}
fn format(t: &Value, mark: Mark) -> EditorCommand {
    EditorCommand::TableFormat {
        target: OWNER.into(),
        expected: any(t),
        rectangle: rectangle(),
        mark,
        action: FormatAction::Apply,
        href: (mark == Mark::Link).then(|| "https://example.org/".into()),
        protected: vec![],
    }
}
fn rich(t: &Value, cells: Value) -> EditorCommand {
    EditorCommand::TableRichRectangle {
        target: OWNER.into(),
        expected: any(t),
        rectangle: rectangle(),
        cells: any(&cells),
        protected: vec![],
    }
}
fn apply(d: &mut Document, c: EditorCommand) {
    let bytes = d.checkpoint().bytes;
    let p = d.prepare_editor(&[c], &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    d.commit_editor(p).unwrap();
}
#[test]
fn all_six_marks_preserve_styles_metadata_backing_identity_history_and_reopen() {
    for mark in [
        Mark::Bold,
        Mark::Italic,
        Mark::Underline,
        Mark::Strike,
        Mark::Code,
        Mark::Link,
    ] {
        let t = fixture();
        let mut d = engine(&t);
        let before = d.snapshot().unwrap();
        let anchor = d
            .anchor(
                OWNER,
                editac_core::Utf16Offset(0),
                editac_core::anchors::Bias::Right,
            )
            .unwrap();
        let position = d.resolve_anchor(&anchor).unwrap();
        apply(&mut d, format(&t, mark));
        let edited = attrs(&d);
        assert_eq!(d.history_state().undo_groups, 1);
        assert_eq!(d.resolve_anchor(&anchor).unwrap(), position);
        assert_eq!(
            d.snapshot().unwrap().visible[0].runs,
            before.visible[0].runs
        );
        assert_eq!(edited[2]["rows"][0], t[2]["rows"][0]);
        assert_eq!(edited[2]["alignments"], t[2]["alignments"]);
        assert_eq!(edited[2]["source"], t[2]["source"]);
        for c in 0..2 {
            assert_eq!(
                edited[2]["rows"][1][c]["header"],
                t[2]["rows"][1][c]["header"]
            );
            assert_eq!(
                edited[2]["rows"][1][c]["paragraphs"][0]["style"],
                json!(["paragraph"])
            );
        }
        let recovered = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
        assert_eq!(attrs(&recovered), edited);
        d.undo().unwrap().unwrap();
        assert_eq!(attrs(&d), t);
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), edited);
    }
}
#[test]
fn v2_rectangles_preserve_every_cell_field_and_promote_v1_without_loss() {
    let t = fixture();
    let cells = t[2]["rows"][0].clone();
    for initial in [t.clone(), tuple(false)] {
        let mut d = engine(&initial);
        apply(&mut d, rich(&initial, json!([cells])));
        let edited = attrs(&d);
        assert_eq!(edited[1], 2);
        assert_eq!(edited[2]["rows"][1], cells);
        assert_eq!(edited[2]["alignments"], initial[2]["alignments"]);
        assert_eq!(edited[2]["source"], initial[2]["source"]);
        assert_eq!(d.history_state().undo_groups, 1);
        if initial[1] == 2 {
            assert_eq!(edited[2]["rows"][0], initial[2]["rows"][0]);
        } else {
            assert_eq!(
                edited[2]["rows"][0][0]["paragraphs"][0]["runs"],
                initial[2]["rows"][0][0]
            );
            assert_eq!(edited[2]["rows"][0][0]["header"], true);
        }
        d.undo().unwrap().unwrap();
        assert_eq!(attrs(&d), initial);
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), edited);
    }
}
#[test]
fn malformed_v2_rectangles_styles_duplicates_precedence_and_bounds_reject_purely() {
    let t = fixture();
    let good = t[2]["rows"][1].clone();
    let mut cases = vec![
        json!([[{}, {}]]),
        json!([[null, null]]),
        json!([]),
        json!([[[], []]]),
    ];
    let mutations: Vec<fn(&mut Value)> = vec![
        |c| c[0]["paragraphs"][0]["style"] = json!(["list", "bullet"]),
        |c| c[0]["paragraphs"][0]["style"] = json!(["heading", 7]),
        |c| c[0]["rowSpan"] = json!(2),
        |c| c[0]["header"] = json!("true"),
        |c| c[0]["paragraphs"] = json!([]),
        |c| c[0]["paragraphs"][0]["runs"] = json!([["x", [["bold"], ["bold"]]]]),
        |c| c[0]["paragraphs"][0]["runs"] = json!([["x", [["code"], ["italic"]]]]),
        |c| c[0]["paragraphs"][0]["runs"] = json!([["x", [["link", "javascript:alert(1)"]]]]),
        |c| c[0]["extra"] = json!(true),
        |c| c[0]["paragraphs"][0]["runs"] = json!([["x\ry", []]]),
    ];
    for mutation in mutations {
        let mut cells = good.clone();
        mutation(&mut cells);
        cases.push(json!([cells]));
    }
    let d = engine(&t);
    let bytes = d.checkpoint().bytes;
    for cells in cases {
        assert!(d.prepare_editor(&[rich(&t, cells)], &origin()).is_err());
        assert_eq!(d.checkpoint().bytes, bytes);
        assert_eq!(d.history_state().undo_groups, 0);
    }
}
#[test]
fn protected_stale_and_code_block_formatting_reject_without_effects() {
    let t = fixture();
    let mut d = engine(&t);
    let before = d.checkpoint().bytes;
    let mut c = format(&t, Mark::Bold);
    if let EditorCommand::TableFormat { protected, .. } = &mut c {
        protected.push((1, 0));
    }
    assert!(d.prepare_editor(&[c], &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    let mut c = format(&t, Mark::Bold);
    if let EditorCommand::TableFormat { rectangle, .. } = &mut c {
        rectangle.row = 0;
        rectangle.rows = 1;
    }
    assert!(d.prepare_editor(&[c], &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    let delayed = d
        .prepare_editor(&[format(&t, Mark::Bold)], &origin())
        .unwrap();
    apply(&mut d, format(&t, Mark::Strike));
    let changed = d.checkpoint().bytes;
    assert!(d.commit_editor(delayed).is_err());
    assert!(
        d.prepare_editor(&[format(&t, Mark::Bold)], &origin())
            .is_err()
    );
    assert_eq!(d.checkpoint().bytes, changed);
}
#[test]
fn multiblock_inline_formatting_preserves_order_and_individual_styles() {
    let mut t = fixture();
    t[2]["rows"][1][0]["paragraphs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"style":["heading",3],"runs":[["second",[]]]}));
    let mut d = engine(&t);
    apply(&mut d, format(&t, Mark::Bold));
    let edited = attrs(&d);
    assert_eq!(
        edited[2]["rows"][1][0]["paragraphs"][1],
        json!({"style":["heading",3],"runs":[["second",[["bold"]]]]})
    );
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), t);
}

#[test]
fn rich_rectangle_retains_multiline_marked_runs_and_one_history_unit() {
    let t = fixture();
    let mut cells = t[2]["rows"][1].clone();
    cells[0]["paragraphs"][0]["runs"] = runs("a\n😀\n\n");
    let mut d = engine(&t);
    let bytes = d.checkpoint().bytes;
    let p = d
        .prepare_editor(&[rich(&t, json!([cells]))], &origin())
        .unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    d.commit_editor(p).unwrap();
    let edited = attrs(&d);
    assert_eq!(edited[2]["rows"][1], cells);
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), t);
    d.redo().unwrap().unwrap();
    assert_eq!(attrs(&d), edited);
}
