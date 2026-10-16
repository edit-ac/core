//! RCH-1.7: attribute commands, codec recovery, identity/history and real replay.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    commands::{
        editor::{EditorCommand, EditorError},
        table::CellRectangle,
        text::TextOrigin,
    },
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::content::{Alignment, Content},
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

fn command(t: &Value, header: Option<bool>, alignment: Option<Alignment>) -> EditorCommand {
    EditorCommand::TableAttributes {
        target: OWNER.into(),
        expected: any(t),
        rectangle: CellRectangle {
            row: 1,
            column: 0,
            rows: 1,
            columns: 2,
        },
        header,
        alignment,
        protected: vec![],
    }
}
fn apply(d: &mut Document, commands: &[EditorCommand]) -> editac_core::document::ReplayUpdate {
    let before = d.checkpoint().bytes;
    let p = d.prepare_editor(commands, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, before, "prepare must remain pure");
    d.commit_editor(p).unwrap().update
}
fn fork(d: &Document) -> Document {
    Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap()
}
fn reject(d: &mut Document, commands: &[EditorCommand], error: EditorError) {
    let before = d.checkpoint().bytes;
    let groups = d.history_state().undo_groups;
    assert_eq!(d.prepare_editor(commands, &origin()).err(), Some(error));
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, groups);
}

#[test]
fn alignment_changes_only_columns_and_preserves_cells_source_owner_and_one_history_group() {
    for v2 in [false, true] {
        for alignment in [
            Alignment::None,
            Alignment::Left,
            Alignment::Center,
            Alignment::Right,
        ] {
            let mut original = tuple(v2);
            if alignment == Alignment::Left {
                original[2]["alignments"][0] = json!("none");
            }
            let mut d = engine(&original);
            let before = d.snapshot().unwrap();
            let anchor = d
                .anchor(
                    OWNER,
                    editac_core::Utf16Offset(0),
                    editac_core::anchors::Bias::Right,
                )
                .unwrap();
            let position = d.resolve_anchor(&anchor).unwrap();
            let mut c = command(&original, None, Some(alignment));
            if let EditorCommand::TableAttributes { rectangle, .. } = &mut c {
                rectangle.columns = 1;
            }
            apply(&mut d, &[c]);
            let edited = attrs(&d);
            let value = match alignment {
                Alignment::None => "none",
                Alignment::Left => "left",
                Alignment::Center => "center",
                Alignment::Right => "right",
            };
            assert_eq!(edited[2]["alignments"], json!([value, "right"]));
            assert_eq!(edited[2]["rows"], original[2]["rows"]);
            assert_eq!(edited[2]["source"], original[2]["source"]);
            assert_eq!(edited[1], original[1]);
            assert_eq!(d.resolve_anchor(&anchor).unwrap(), position);
            assert_eq!(d.history_state().undo_groups, 1);
            let after = d.snapshot().unwrap();
            assert_eq!(
                after.visible.iter().find(|n| n.id == OWNER).unwrap().runs,
                before.visible.iter().find(|n| n.id == OWNER).unwrap().runs,
                "metadata must retain exact backing runs, including unknown marks"
            );
            for node in before.visible.iter().filter(|n| n.id != OWNER) {
                assert_eq!(after.visible.iter().find(|n| n.id == node.id), Some(node));
            }
            assert_eq!(
                after.visible.iter().find(|n| n.id == OWNER).unwrap().id,
                OWNER
            );
            assert_eq!(attrs(&fork(&d)), edited);
            if edited != original {
                d.undo().unwrap().unwrap();
                assert_eq!(attrs(&d), original);
                d.redo().unwrap().unwrap();
                assert_eq!(attrs(&d), edited);
            }
        }
    }
}

#[test]
fn explicit_headers_promote_v1_only_when_needed_and_keep_every_cell_run_and_coordinate() {
    for v2 in [false, true] {
        let original = tuple(v2);
        let mut d = engine(&original);
        apply(
            &mut d,
            &[command(&original, Some(true), Some(Alignment::Center))],
        );
        let edited = attrs(&d);
        assert_eq!(edited[1], 2);
        assert_eq!(edited[2]["source"], original[2]["source"]);
        for r in 0..2 {
            for c in 0..2 {
                let cell = &edited[2]["rows"][r][c];
                assert_eq!(cell["header"], true);
                if v2 {
                    assert_eq!(cell["paragraphs"], original[2]["rows"][r][c]["paragraphs"]);
                } else {
                    assert_eq!(cell["paragraphs"][0]["runs"], original[2]["rows"][r][c]);
                    assert_eq!(cell["paragraphs"][0]["style"], json!(["paragraph"]));
                }
            }
        }
        assert_eq!(d.history_state().undo_groups, 1);
        d.undo().unwrap().unwrap();
        assert_eq!(attrs(&d), original);
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), edited);
        apply(&mut d, &[command(&edited, Some(false), None)]);
        let cleared = attrs(&d);
        assert_eq!(cleared[2]["rows"][1][0]["header"], false);
        assert_eq!(cleared[2]["rows"][0][0]["header"], true);
    }
    let original = tuple(false);
    let mut d = engine(&original);
    apply(
        &mut d,
        &[command(&original, Some(false), Some(Alignment::None))],
    );
    assert_eq!(
        attrs(&d)[1],
        1,
        "unchanged implicit header needs no schema promotion"
    );
}

#[test]
fn mixed_header_rectangle_sets_explicit_value_in_one_undo_group() {
    let mut original = tuple(true);
    original[2]["rows"][1][0]["header"] = json!(false);
    let mut d = engine(&original);
    let mut c = command(&original, Some(false), None);
    if let EditorCommand::TableAttributes { rectangle, .. } = &mut c {
        rectangle.row = 0;
        rectangle.rows = 2;
    }
    apply(&mut d, &[c]);
    for row in attrs(&d)[2]["rows"].as_array().unwrap() {
        for cell in row.as_array().unwrap() {
            assert_eq!(cell["header"], false);
        }
    }
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), original);
}

#[test]
fn invalid_empty_overflow_oversize_protected_and_mixed_targets_reject_before_mutation() {
    for v2 in [false, true] {
        let original = tuple(v2);
        let mut d = engine(&original);
        reject(
            &mut d,
            &[command(&original, None, None)],
            EditorError::InvalidCommand,
        );
        for (r, error) in [
            (
                CellRectangle {
                    row: 2,
                    column: 0,
                    rows: 1,
                    columns: 1,
                },
                EditorError::InvalidCommand,
            ),
            (
                CellRectangle {
                    row: 0,
                    column: 0,
                    rows: 0,
                    columns: 1,
                },
                EditorError::InvalidCommand,
            ),
            (
                CellRectangle {
                    row: usize::MAX,
                    column: 0,
                    rows: 1,
                    columns: 1,
                },
                EditorError::ResourceLimit,
            ),
            (
                CellRectangle {
                    row: 0,
                    column: 0,
                    rows: 129,
                    columns: 1,
                },
                EditorError::ResourceLimit,
            ),
        ] {
            let mut c = command(&original, Some(false), Some(Alignment::Left));
            if let EditorCommand::TableAttributes { rectangle, .. } = &mut c {
                *rectangle = r;
            }
            reject(&mut d, &[c], error);
        }
        // Alignment affects the full column, including protected cells outside the rectangle.
        let mut c = command(&original, None, Some(Alignment::Center));
        if let EditorCommand::TableAttributes { protected, .. } = &mut c {
            *protected = vec![(0, 0)];
        }
        reject(&mut d, &[c], EditorError::UnsupportedTarget);
        let mut c = command(&original, Some(true), None);
        if let EditorCommand::TableAttributes { protected, .. } = &mut c {
            *protected = vec![(1, 1)];
        }
        reject(&mut d, &[c], EditorError::UnsupportedTarget);
        let mut c = command(&original, Some(true), None);
        if let EditorCommand::TableAttributes { protected, .. } = &mut c {
            *protected = vec![(0, 0); 4097];
        }
        reject(&mut d, &[c], EditorError::ResourceLimit);
        let mut c = command(&original, Some(true), None);
        if let EditorCommand::TableAttributes { expected, .. } = &mut c {
            *expected = any(&json!(["paragraph"]));
        }
        reject(
            &mut d,
            &[command(&original, Some(false), Some(Alignment::None)), c],
            EditorError::PresentationConflict,
        );
    }
}

#[test]
fn malformed_unknown_and_merged_descriptors_remain_unchanged() {
    let original = tuple(true);
    let d = engine(&original);
    for bad in [
        {
            let mut t = original.clone();
            t[2]["alignments"][0] = json!("justify");
            t
        },
        {
            let mut t = original.clone();
            t[2]["rows"][0][0]["header"] = json!(1);
            t
        },
        {
            let mut t = original.clone();
            t[2]["future"] = json!({"opaque":"retained"});
            t
        },
        {
            let mut t = original.clone();
            t[1] = json!(99);
            t
        },
    ] {
        let checkpoint = d.checkpoint().bytes;
        assert!(
            d.prepare_editor(&[command(&bad, Some(false), None)], &origin())
                .is_err()
        );
        assert_eq!(d.checkpoint().bytes, checkpoint);
    }
    let mut merged = original;
    merged[2]["rows"][0][0]["columnSpan"] = json!(2);
    merged[2]["rows"][0][1] = Value::Null;
    let mut d = engine(&merged);
    reject(
        &mut d,
        &[command(&merged, Some(false), Some(Alignment::None))],
        EditorError::UnsupportedTarget,
    );
}

#[test]
fn retained_future_table_and_mixed_table_prose_batch_are_never_rewritten() {
    let original = tuple(true);
    let mut d = engine(&original);
    let prose = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id != OWNER && n.kind == "block")
        .unwrap();
    let mut mixed = command(&original, Some(false), None);
    if let EditorCommand::TableAttributes {
        target, expected, ..
    } = &mut mixed
    {
        *target = prose.id.clone();
        *expected = prose.block_attributes.as_ref().unwrap().tuple();
    }
    reject(
        &mut d,
        &[command(&original, Some(false), None), mixed],
        EditorError::UnsupportedTarget,
    );
    let mut future = original;
    future[1] = json!(99);
    future[2]["future"] = json!({"opaque":"retained"});
    let raw = m::seed();
    m::set(&raw, 4, OWNER, any(&future));
    let checkpoint = InitializedCheckpoint {
        identity: d.identity().clone(),
        initialized: true,
        writer_id: 11,
        bytes: m::bytes(&raw),
    };
    let d = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    let before = d.checkpoint().bytes;
    assert_eq!(attrs(&d), future);
    assert!(
        d.prepare_editor(&[command(&future, Some(false), None)], &origin())
            .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(attrs(&fork(&d)), future);
}

#[test]
fn gfm_alignment_roundtrip_and_explicit_header_typed_recovery_are_lossless() {
    use editac_markdown::{
        export::export,
        optional::{Codecs, import_with_codecs},
    };
    let codecs = Codecs {
        tables: true,
        ..Codecs::default()
    };
    // Independent GFM source exercises the declared delimiter codec, not a generated oracle.
    let source = "| name | note |\n| :--- | ---: |\n| Ω | **yes** |\n";
    let imported = import_with_codecs(source, codecs).unwrap();
    let t =
        editac_core::interchange::value(&imported.blocks[0].attributes.as_ref().unwrap().tuple());
    let mut d = engine(&t);
    apply(&mut d, &[command(&t, None, Some(Alignment::Center))]);
    // Codec input is the actual committed descriptor. The schema seed also has
    // an unknown outer text mark; metadata edits must retain it, and whole-node
    // copy correctly rejects it. Do not confuse that with table codec admission.
    let block = editac_core::commands::editor::FragmentBlock {
        attributes: d
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == OWNER)
            .unwrap()
            .block_attributes
            .clone(),
        runs: imported.blocks[0].runs.clone(),
        containers: vec![],
        checked: None,
    };
    let output = export(&[block]);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    assert!(output.markdown.contains("| :---: | :---: |"));
    let back = import_with_codecs(&output.markdown, codecs).unwrap();
    let back =
        editac_core::interchange::value(&back.blocks[0].attributes.as_ref().unwrap().tuple());
    assert_eq!(back[2]["alignments"], attrs(&d)[2]["alignments"]);
    assert_eq!(back[2]["rows"], attrs(&d)[2]["rows"]);
    let t = attrs(&d);
    apply(&mut d, &[command(&t, Some(true), None)]);
    let block = editac_core::commands::editor::FragmentBlock {
        attributes: d
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == OWNER)
            .unwrap()
            .block_attributes
            .clone(),
        runs: imported.blocks[0].runs.clone(),
        containers: vec![],
        checked: None,
    };
    let output = export(&[block]);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|d| d.code == "rich-table-source-fallback")
    );
    assert_eq!(output.recovery.len(), 1);
    assert_eq!(
        output.recovery[0].attributes.as_ref().unwrap().tuple(),
        any(&attrs(&d))
    );
    // The profile promises source + typed recovery, never a false source-only roundtrip.
    assert_eq!(attrs(&fork(&d)), attrs(&d));
}

#[test]
fn concurrent_header_alignment_and_cell_changes_converge_under_atomic_table_policy() {
    for v2 in [false, true] {
        let original = tuple(v2);
        let seed = engine(&original);
        let mut header = fork(&seed);
        let mut align = fork(&seed);
        let mut cell = fork(&seed);
        let updates = [
            apply(&mut header, &[command(&original, Some(false), None)]),
            apply(
                &mut align,
                &[command(&original, None, Some(Alignment::Center))],
            ),
            apply(
                &mut cell,
                &[EditorCommand::TableCell {
                    target: OWNER.into(),
                    expected: any(&original),
                    row: 0,
                    column: 0,
                    text: "peer😀".into(),
                }],
            ),
        ];
        let authored = [attrs(&header), attrs(&align), attrs(&cell)];
        let mut canonical = None;
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let mut d = fork(&seed);
            for i in order {
                d.apply_replay(&updates[i]).unwrap();
            }
            let checkpoint = d.checkpoint().bytes;
            let result = attrs(&d);
            assert!(authored.contains(&result));
            if let Some(expected) = &canonical {
                assert_eq!(&result, expected);
            } else {
                canonical = Some(result);
            }
            for i in order {
                d.apply_replay(&updates[i]).unwrap();
            }
            d.snapshot().unwrap();
            d.fragment_for_node(OWNER).unwrap();
            assert_eq!(
                d.checkpoint().bytes,
                checkpoint,
                "duplicate/reprojection writes"
            );
            assert_eq!(attrs(&fork(&d)), canonical.clone().unwrap());
        }
    }
}

#[test]
fn stale_descriptor_and_prepared_remote_completion_reject_without_mutation() {
    let original = tuple(true);
    let mut d = engine(&original);
    let mut peer = fork(&d);
    let pending = d
        .prepare_editor(&[command(&original, Some(false), None)], &origin())
        .unwrap();
    let update = apply(
        &mut peer,
        &[command(&original, None, Some(Alignment::None))],
    );
    d.apply_replay(&update).unwrap();
    let checkpoint = d.checkpoint().bytes;
    assert!(d.commit_editor(pending).is_err());
    assert_eq!(d.checkpoint().bytes, checkpoint);
    reject(
        &mut d,
        &[command(&original, Some(false), None)],
        EditorError::PresentationConflict,
    );
}

#[test]
fn local_attribute_undo_preserves_unrelated_remote_text_and_deleted_owner_rejects_pending_edit() {
    for v2 in [false, true] {
        let original = tuple(v2);
        let mut d = engine(&original);
        let mut peer = fork(&d);
        apply(
            &mut d,
            &[command(&original, Some(false), Some(Alignment::Center))],
        );
        let edited = attrs(&d);
        let remote = apply(
            &mut peer,
            &[EditorCommand::ReplaceAt {
                owner: "n:11:3".into(),
                from: editac_core::Utf16Offset(0),
                to: editac_core::Utf16Offset(0),
                text: "peer😀".into(),
            }],
        );
        d.apply_replay(&remote).unwrap();
        let remote_node = d
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == "n:11:3")
            .unwrap()
            .clone();
        d.undo().unwrap().unwrap();
        assert_eq!(attrs(&d), original);
        assert_eq!(
            d.snapshot()
                .unwrap()
                .visible
                .iter()
                .find(|n| n.id == "n:11:3"),
            Some(&remote_node)
        );
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), edited);
        let pending = d
            .prepare_editor(&[command(&edited, Some(true), None)], &origin())
            .unwrap();
        let mut remover = fork(&d);
        let removed = apply(
            &mut remover,
            &[EditorCommand::Enable {
                target: OWNER.into(),
                enabled: false,
            }],
        );
        d.apply_replay(&removed).unwrap();
        let before = d.checkpoint().bytes;
        assert!(d.commit_editor(pending).is_err());
        assert!(
            d.prepare_editor(&[command(&edited, Some(true), None)], &origin())
                .is_err()
        );
        assert_eq!(d.checkpoint().bytes, before);
    }
}

#[test]
fn public_attribute_dto_rejects_invalid_values_and_routes_to_the_engine() {
    use editac_core::interchange::Command;
    let original = tuple(false);
    let mut d = engine(&original);
    let raw = json!({"type":"tableAttributes","owner":OWNER,"expected":original,"row":1,"column":0,"rows":1,"columns":1,"alignment":"center","header":true,"protected":[]});
    for bad in [json!("justify"), json!(5), json!("CENTER")] {
        let mut r = raw.clone();
        r["alignment"] = bad;
        assert!(serde_json::from_value::<Command>(r).is_err());
    }
    let mut bad = raw.clone();
    bad["header"] = json!("false");
    assert!(serde_json::from_value::<Command>(bad).is_err());
    let c = serde_json::from_value::<Command>(raw)
        .unwrap()
        .translate(|_| panic!("no anchor needed"))
        .unwrap();
    apply(&mut d, &[c]);
    assert_eq!(attrs(&d)[2]["alignments"], json!(["center", "right"]));
    assert_eq!(attrs(&d)[2]["rows"][1][0]["header"], true);
}
