//! RGS-1.2: shared independently authored native/WASM atomic and Unicode vectors.
//! These vectors do not qualify an absent history selection port or native gestures.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Direction, Resolution, deletion_range},
    commands::{
        blocks::{BlockCommand, Side},
        editor::{EditorCommand, EditorPosition},
        format::{FormatAction, Mark},
        text::TextOrigin,
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    patches::PatchScope,
};
use serde_json::Value;
use std::{
    cell::Cell,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
use yrs::Any;
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/semantic-vectors.json"
    ))
    .unwrap()
}
fn number(v: &Value) -> u32 {
    v.as_u64().unwrap().try_into().unwrap()
}
fn document(text: &str) -> Document {
    documents(&[text])
}
fn documents(texts: &[&str]) -> Document {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let identity = DocumentIdentity::v5(
        format!("42400000-0000-4000-8000-{n:012}"),
        format!("42400000-0000-4000-9000-{n:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &texts
            .iter()
            .map(|text| InitialNode {
                kind: "block".into(),
                text: (*text).into(),
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn frozen(d: &Document) -> (Vec<u8>, Vec<u8>, u64, editac_core::history::HistoryState) {
    (
        d.checkpoint().bytes,
        d.state_vector_v1(),
        d.revision(),
        d.history_state(),
    )
}
fn mark(value: &str) -> Mark {
    match value {
        "bold" => Mark::Bold,
        "italic" => Mark::Italic,
        "code" => Mark::Code,
        _ => panic!("unbound vector mark"),
    }
}
fn atomic(id: &str) {
    let all = vectors();
    let v = all["atomic"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let mut d = document(v["text"].as_str().unwrap());
    let original = d.snapshot().unwrap().visible[0].clone();
    let owner = original.id.clone();
    let commands: Vec<_> = v["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let target = c["owner"].as_str().unwrap_or(&owner).to_string();
            match c["type"].as_str().unwrap() {
                "replaceAt" => EditorCommand::ReplaceAt {
                    owner: target,
                    from: U(number(&c["from"])),
                    to: U(number(&c["to"])),
                    text: c["text"].as_str().unwrap().into(),
                },
                "markAt" => EditorCommand::MarkAt {
                    owner: target,
                    from: U(number(&c["from"])),
                    to: U(number(&c["to"])),
                    mark: mark(c["mark"].as_str().unwrap()),
                    action: FormatAction::Apply,
                    href: None,
                },
                "insertSeparator" => EditorCommand::BlockCommand(BlockCommand::InsertSeparator {
                    beside: target,
                    side: Side::After,
                }),
                "selectionAt" => EditorCommand::SelectionAt {
                    anchor: EditorPosition {
                        owner: target.clone(),
                        offset: U(number(&c["anchor"])),
                        bias: Bias::Left,
                    },
                    focus: EditorPosition {
                        owner: target,
                        offset: U(number(&c["focus"])),
                        bias: Bias::Right,
                    },
                },
                _ => panic!("unbound vector command"),
            }
        })
        .collect();
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _subscription = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let before = frozen(&d);
    let origin = TextOrigin::new("local:rgs:native").unwrap();
    let plan = d.prepare_editor(&commands, &origin);
    assert_eq!(frozen(&d), before, "isolated preparation {id}");
    assert_eq!(count.get(), 0);
    if v["rejected"] == true {
        assert!(plan.is_err(), "{id}");
        return;
    }
    let result = d.commit_editor(plan.unwrap()).unwrap();
    assert_eq!(result.revision, before.2 + 1);
    assert_eq!(count.get(), 1);
    assert_eq!(d.history_state().undo_groups, 1);
    let nodes = d.snapshot().unwrap().visible;
    if !v["visibleKinds"].is_null() {
        assert_eq!(nodes.len(), 2);
        assert!(matches!(
            nodes[1].block_attributes,
            Some(editac_core::document::BlockAttributes::Separator)
        ));
    }
    let node = nodes[0].clone();
    assert_eq!(node.id, original.id);
    assert_eq!(node.spans[0].source, original.spans[0].source);
    assert_eq!(node.spans[0].identity, original.spans[0].identity);
    let text: String = node.runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(text, v["expectedText"].as_str().unwrap());
    // Compare each UTF-16 unit's attributes against independent expected intervals.
    let mut offset = 0;
    for run in &node.runs {
        for _ in run.text.encode_utf16() {
            let expected: Vec<_> = v["expectedMarks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| number(&m[0]) <= offset && offset < number(&m[1]))
                .map(|m| m[2].as_str().unwrap())
                .collect();
            assert_eq!(
                run.attributes.len(),
                expected.len(),
                "attributes at {offset}"
            );
            for key in expected {
                assert_eq!(run.attributes.get(key), Some(&Any::Bool(true)));
            }
            offset += 1;
        }
    }
    let selection = result.result_selection.unwrap();
    for (anchor, expected, bias) in [
        (&selection.anchor, &v["selection"][0], Bias::Left),
        (&selection.focus, &v["selection"][1], Bias::Right),
    ] {
        match d.resolve_anchor(anchor).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(p.node, owner);
                assert_eq!(p.offset, U(number(expected)));
                assert_eq!(p.bias, bias);
            }
            _ => panic!("unresolved selection"),
        }
    }
    d.undo().unwrap().unwrap();
    assert_eq!(
        d.snapshot().unwrap().visible[0]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        v["text"].as_str().unwrap()
    );
}
macro_rules! atomic_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            atomic($id);
        }
    };
}
atomic_case!(reg13_valid, "REG-13-valid");
atomic_case!(reg13_invalid_final_owner, "REG-13-invalid-final-owner");
atomic_case!(
    reg13_invalid_final_surrogate,
    "REG-13-invalid-final-surrogate"
);
atomic_case!(
    reg13_invalid_final_selection,
    "REG-13-invalid-final-selection"
);
atomic_case!(reg13_invalid_mark_policy, "REG-13-invalid-mark-policy");
atomic_case!(reg13_staged_offsets, "REG-13-staged-offsets");
atomic_case!(
    reg13_text_mark_structure_invalid_final,
    "REG-13-text-mark-structure-invalid-final"
);
atomic_case!(
    reg13_text_mark_structure_valid_retry,
    "REG-13-text-mark-structure-valid-retry"
);
atomic_case!(g03_backward_selection, "G03-backward-selection");
atomic_case!(g06_astral_staged_utf16, "G06-astral-staged-utf16");
atomic_case!(g06_invalid_first_surrogate, "G06-invalid-first-surrogate");
fn grapheme(id: &str) {
    let all = vectors();
    let v = all["graphemes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let text = v["text"].as_str().unwrap();
    let actual = deletion_range(text, U(number(&v["offset"])), Direction::Backward);
    if v["rejected"] == true {
        assert!(actual.is_err());
        return;
    }
    let range = actual.unwrap();
    if v["range"].is_null() {
        assert!(range.is_none());
        assert_eq!(text, v["expectedText"].as_str().unwrap());
        return;
    }
    let range = range.unwrap();
    assert_eq!(range, U(number(&v["range"][0]))..U(number(&v["range"][1])));
    let mut d = document(text);
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let plan = d
        .prepare_editor(
            &[EditorCommand::ReplaceAt {
                owner,
                from: range.start,
                to: range.end,
                text: String::new(),
            }],
            &TextOrigin::new("local:rgs:unicode").unwrap(),
        )
        .unwrap();
    d.commit_editor(plan).unwrap();
    assert_eq!(
        d.snapshot().unwrap().visible[0]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        v["expectedText"].as_str().unwrap()
    );
}
macro_rules! grapheme_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            grapheme($id);
        }
    };
}
grapheme_case!(g06_nfc, "nfc");
grapheme_case!(g06_nfd, "nfd");
grapheme_case!(g06_zwj, "family-zwj");
grapheme_case!(g06_flag, "flag");
grapheme_case!(g06_indic, "indic");
grapheme_case!(g06_bidi, "bidi");
grapheme_case!(g06_authored_space, "authored-space");
grapheme_case!(g06_surrogate_interior, "surrogate-interior");
grapheme_case!(g06_combining_interior, "combining-interior");
grapheme_case!(g06_boundary, "boundary");

#[test]
fn reg06_schema_crossing_delete_replace_and_format_preserve_bold_suffix_on_rejection() {
    use editac_core::anchors::Selection;
    use editac_core::commands::{
        editor::{FragmentBlock, FragmentRun},
        format::FormatCommand,
    };
    let mut d = documents(&["ab", "cd"]);
    let nodes = d.snapshot().unwrap().visible;
    let (first, second) = (nodes[0].id.clone(), nodes[1].id.clone());
    let origin = TextOrigin::new("local:rgs:mixed").unwrap();
    let setup = d
        .prepare_editor(
            &[
                EditorCommand::BlockCommand(BlockCommand::SetCode {
                    owner: first.clone(),
                    language: String::new(),
                }),
                EditorCommand::MarkAt {
                    owner: second.clone(),
                    from: U(0),
                    to: U(2),
                    mark: Mark::Bold,
                    action: FormatAction::Apply,
                    href: None,
                },
            ],
            &origin,
        )
        .unwrap();
    d.commit_editor(setup).unwrap();
    d.clear_history();
    let selection = Selection {
        anchor: d.anchor(&second, U(1), Bias::Right).unwrap(),
        focus: d.anchor(&first, U(1), Bias::Right).unwrap(),
    };
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let before = frozen(&d);
    let snapshot = d.snapshot().unwrap().visible;
    for text in ["", "X"] {
        let fragment = FragmentBlock {
            runs: vec![FragmentRun {
                text: text.into(),
                marks: vec![],
            }],
            attributes: None,
            containers: vec![],
            checked: None,
        };
        assert!(
            d.prepare_fragment(&selection, &[fragment], &origin)
                .is_err()
        );
        assert_eq!(frozen(&d), before);
        assert_eq!(d.snapshot().unwrap().visible, snapshot);
        assert_eq!(count.get(), 0);
    }
    let format = FormatCommand {
        selection,
        mark: Mark::Bold,
        action: FormatAction::Apply,
        href: None,
    };
    assert!(d.prepare_format(&[format], &origin).is_err());
    assert_eq!(frozen(&d), before);
    assert_eq!(d.snapshot().unwrap().visible, snapshot);
    assert_eq!(count.get(), 0);
}
fn separated_pre(in_code: bool) {
    use editac_core::{
        anchors::Selection,
        commands::editor::{FragmentBlock, FragmentRun},
        document::BlockAttributes,
    };
    let text = if in_code { "xy" } else { "" };
    let offset = if in_code { 1 } else { 0 };
    let mut d = document(text);
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let origin = TextOrigin::new("local:rgs:pre").unwrap();
    if in_code {
        let setup = d
            .prepare_editor(
                &[EditorCommand::BlockCommand(BlockCommand::SetCode {
                    owner: owner.clone(),
                    language: String::new(),
                })],
                &origin,
            )
            .unwrap();
        d.commit_editor(setup).unwrap();
        d.clear_history();
    }
    let original = d.snapshot().unwrap().visible[0].clone();
    let range = Selection {
        anchor: d.anchor(&owner, U(offset), Bias::Right).unwrap(),
        focus: d.anchor(&owner, U(offset), Bias::Right).unwrap(),
    };
    let make = |text: &str, attributes| FragmentBlock {
        runs: vec![FragmentRun {
            text: text.into(),
            marks: vec![],
        }],
        attributes: Some(attributes),
        containers: vec![],
        checked: None,
    };
    let fragments = [
        make("A", BlockAttributes::Code(String::new())),
        make("\n", BlockAttributes::Paragraph),
        make("B", BlockAttributes::Code(String::new())),
    ];
    let before = frozen(&d);
    let plan = d.prepare_fragment(&range, &fragments, &origin).unwrap();
    assert_eq!(frozen(&d), before);
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let result = d.commit_editor(plan).unwrap();
    assert_eq!(count.get(), 1);
    assert_eq!(d.history_state().undo_groups, 1);
    let nodes = d.snapshot().unwrap().visible;
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0].id, original.id);
    assert_eq!(nodes[0].spans[0].source, original.spans[0].source);
    let expected = if in_code {
        ["xA", "\n", "By"]
    } else {
        ["A", "\n", "B"]
    };
    for (node, text) in nodes.iter().zip(expected) {
        assert_eq!(
            node.runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>(),
            text
        );
        assert!(node.runs.iter().all(|r| r.attributes.is_empty()));
    }
    assert_eq!(
        nodes[0].block_attributes,
        Some(BlockAttributes::Code(String::new()))
    );
    assert_eq!(nodes[1].block_attributes, Some(BlockAttributes::Paragraph));
    assert_eq!(
        nodes[2].block_attributes,
        Some(BlockAttributes::Code(String::new()))
    );
    match d.resolve_anchor(&result.result_caret.unwrap()).unwrap() {
        Resolution::Position(p) => {
            assert_eq!(p.node, nodes[2].id);
            assert_eq!(p.offset, U(1));
        }
        _ => panic!("missing fragment caret"),
    }
    d.undo().unwrap().unwrap();
    let restored = d.snapshot().unwrap().visible;
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, original.id);
    assert_eq!(restored[0].block_attributes, original.block_attributes);
    assert_eq!(restored[0].runs, original.runs);
    assert_eq!(count.get(), 2);
}
#[test]
fn reg07_separated_pre_in_code_content_undo() {
    separated_pre(true);
}
#[test]
fn reg07_separated_pre_empty_control_content_undo() {
    separated_pre(false);
}

// Matching packed-WASM selected-fragment vectors. Editor-local pending marks and
// history selection are deliberately outside this document boundary.
fn selected_pre(in_code: bool, cross_owner: bool, backward: bool) {
    use editac_core::{
        anchors::Selection,
        commands::editor::{FragmentBlock, FragmentRun},
        document::BlockAttributes,
    };
    let mut d = if cross_owner {
        documents(&["xy", "wz"])
    } else {
        document("xyz")
    };
    let nodes = d.snapshot().unwrap().visible;
    let first = nodes[0].id.clone();
    let origin = TextOrigin::new("local:rgs:selected-pre").unwrap();
    if in_code {
        let setup = d
            .prepare_editor(
                &[EditorCommand::BlockCommand(BlockCommand::SetCode {
                    owner: first.clone(),
                    language: String::new(),
                })],
                &origin,
            )
            .unwrap();
        d.commit_editor(setup).unwrap();
        d.clear_history();
    }
    let originals = d.snapshot().unwrap().visible;
    let lower = d.anchor(&first, U(1), Bias::Right).unwrap();
    let upper = if cross_owner {
        d.anchor(&originals[1].id, U(1), Bias::Right).unwrap()
    } else {
        d.anchor(&first, U(2), Bias::Right).unwrap()
    };
    let selection = if backward {
        Selection {
            anchor: upper,
            focus: lower,
        }
    } else {
        Selection {
            anchor: lower,
            focus: upper,
        }
    };
    let make = |text: &str, attributes| FragmentBlock {
        runs: vec![FragmentRun {
            text: text.into(),
            marks: vec![],
        }],
        attributes: Some(attributes),
        containers: vec![],
        checked: None,
    };
    let fragments = [
        make("A", BlockAttributes::Code(String::new())),
        make("\n", BlockAttributes::Paragraph),
        make("B", BlockAttributes::Code(String::new())),
    ];
    let before = frozen(&d);
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let plan = d.prepare_fragment(&selection, &fragments, &origin).unwrap();
    assert_eq!(
        frozen(&d),
        before,
        "prepare must publish no intermediate mutation"
    );
    assert_eq!(count.get(), 0);
    let result = d.commit_editor(plan).unwrap();
    assert_eq!(count.get(), 1);
    assert_eq!(d.revision(), before.2 + 1);
    assert_eq!(d.history_state().undo_groups, 1);
    let pasted = d.snapshot().unwrap().visible;
    assert_eq!(pasted.len(), 3);
    assert_eq!(pasted[0].id, originals[0].id);
    assert_eq!(pasted[0].spans[0].source, originals[0].spans[0].source);
    for (node, text) in pasted.iter().zip(["xA", "\n", "Bz"]) {
        assert_eq!(
            node.runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>(),
            text
        );
        assert!(node.runs.iter().all(|r| r.attributes.is_empty()));
    }
    assert_eq!(
        pasted[0].block_attributes,
        Some(BlockAttributes::Code(String::new()))
    );
    assert_eq!(pasted[1].block_attributes, Some(BlockAttributes::Paragraph));
    assert_eq!(
        pasted[2].block_attributes,
        Some(BlockAttributes::Code(String::new()))
    );
    match d.resolve_anchor(&result.result_caret.unwrap()).unwrap() {
        Resolution::Position(p) => {
            assert_eq!(p.node, pasted[2].id);
            assert_eq!(p.offset, U(1));
        }
        _ => panic!("missing fragment result caret"),
    }
    d.undo().unwrap().unwrap();
    assert_eq!(count.get(), 2);
    let restored = d.snapshot().unwrap().visible;
    assert_eq!(restored.len(), originals.len());
    for (node, old) in restored.iter().zip(&originals) {
        assert_eq!(node.id, old.id);
        assert_eq!(node.block_attributes, old.block_attributes);
        assert_eq!(node.runs, old.runs);
    }
    d.redo().unwrap().unwrap();
    assert_eq!(count.get(), 3);
    let redone = d.snapshot().unwrap().visible;
    assert_eq!(redone.len(), 3);
    for (node, old) in redone.iter().zip(&pasted) {
        assert_eq!(node.id, old.id);
        assert_eq!(node.block_attributes, old.block_attributes);
        assert_eq!(node.runs, old.runs);
    }
}
#[test]
fn reg07_selected_code_forward() {
    selected_pre(true, false, false);
}
#[test]
fn reg07_selected_code_backward() {
    selected_pre(true, false, true);
}
#[test]
fn reg07_selected_text_forward() {
    selected_pre(false, false, false);
}
#[test]
fn reg07_selected_text_backward() {
    selected_pre(false, false, true);
}
#[test]
fn reg07_selected_text_code_boundary_forward() {
    selected_pre(true, true, false);
}
#[test]
fn reg07_selected_text_code_boundary_backward() {
    selected_pre(true, true, true);
}

fn delete_trigger_and_type(explicit_bold: bool) {
    let mut d = document("#a");
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let origin = TextOrigin::new("local:rgs:trigger").unwrap();
    let mark = |from, to, action| EditorCommand::MarkAt {
        owner: owner.clone(),
        from: U(from),
        to: U(to),
        mark: Mark::Bold,
        action,
        href: None,
    };
    let selection = |offset| EditorCommand::SelectionAt {
        anchor: EditorPosition {
            owner: owner.clone(),
            offset: U(offset),
            bias: Bias::Right,
        },
        focus: EditorPosition {
            owner: owner.clone(),
            offset: U(offset),
            bias: Bias::Right,
        },
    };
    let plan = d
        .prepare_editor(&[mark(1, 2, FormatAction::Apply)], &origin)
        .unwrap();
    d.commit_editor(plan).unwrap();
    d.clear_history();
    let original = d.snapshot().unwrap().visible[0].clone();
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let before = frozen(&d);
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::ReplaceAt {
                    owner: owner.clone(),
                    from: U(0),
                    to: U(1),
                    text: String::new(),
                },
                selection(0),
            ],
            &origin,
        )
        .unwrap();
    assert_eq!(frozen(&d), before);
    d.commit_editor(plan).unwrap();
    assert_eq!(count.get(), 1);
    let before = frozen(&d);
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::ReplaceAt {
                    owner: owner.clone(),
                    from: U(0),
                    to: U(0),
                    text: "X".into(),
                },
                mark(
                    0,
                    1,
                    if explicit_bold {
                        FormatAction::Apply
                    } else {
                        FormatAction::Remove
                    },
                ),
                selection(1),
            ],
            &origin,
        )
        .unwrap();
    assert_eq!(frozen(&d), before);
    let result = d.commit_editor(plan).unwrap();
    assert_eq!(count.get(), 2);
    let node = d.snapshot().unwrap().visible[0].clone();
    assert_eq!(node.id, original.id);
    assert_eq!(node.spans[0].source, original.spans[0].source);
    assert_eq!(
        node.runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "Xa"
    );
    let mut offset = 0;
    for run in &node.runs {
        for _ in run.text.encode_utf16() {
            assert_eq!(
                run.attributes.contains_key("bold"),
                explicit_bold || offset == 1
            );
            offset += 1;
        }
    }
    let selection = result.result_selection.unwrap();
    for token in [&selection.anchor, &selection.focus] {
        match d.resolve_anchor(token).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(p.node, owner);
                assert_eq!(p.offset, U(1));
                assert_eq!(p.bias, Bias::Right);
            }
            _ => panic!("missing result endpoint"),
        }
    }
}
#[test]
fn reg05_trigger_delete_explicit_empty_marks() {
    delete_trigger_and_type(false);
}
#[test]
fn reg05_trigger_delete_explicit_bold_marks() {
    delete_trigger_and_type(true);
}

// G03: retain the actual result tokens through a real unrelated replica delta.
// Authored oracles are shared with packed WASM, never recorded from execution.
fn g03_remote_result(id: &str) {
    let all: Value = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/selection-vectors.json"
    ))
    .unwrap();
    let v = all["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let mut d = documents(&[
        v["text"].as_str().unwrap(),
        v["remoteText"].as_str().unwrap(),
    ]);
    let originals = d.snapshot().unwrap().visible;
    let owner = originals[0].id.clone();
    let neighbor = originals[1].id.clone();
    let bias = if v["bias"] == "left" {
        Bias::Left
    } else {
        Bias::Right
    };
    let origin = TextOrigin::new("local:rgs:selection").unwrap();
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _subscription = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let pos = |offset| EditorPosition {
        owner: owner.clone(),
        offset: U(offset),
        bias,
    };
    let action = if v["kind"] == "replace" {
        EditorCommand::ReplaceAt {
            owner: owner.clone(),
            from: U(1),
            to: U(4),
            text: "XY".into(),
        }
    } else {
        EditorCommand::MarkAt {
            owner: owner.clone(),
            from: U(1),
            to: U(4),
            mark: Mark::Bold,
            action: FormatAction::Apply,
            href: None,
        }
    };
    let before = frozen(&d);
    let plan = d
        .prepare_editor(
            &[
                action,
                EditorCommand::SelectionAt {
                    anchor: pos(number(&v["selection"][0])),
                    focus: pos(number(&v["selection"][1])),
                },
            ],
            &origin,
        )
        .unwrap();
    assert_eq!(frozen(&d), before);
    assert_eq!(count.get(), 0);
    let result = d.commit_editor(plan).unwrap();
    assert_eq!(result.revision, before.2 + 1);
    assert_eq!(count.get(), 1);
    let selection = result.result_selection.unwrap();
    let endpoints = |doc: &Document| {
        [&selection.anchor, &selection.focus].map(|a| match doc.resolve_anchor(a).unwrap() {
            Resolution::Position(p) => (p.node, p.offset.0, p.bias),
            _ => panic!("unresolved returned selection"),
        })
    };
    let expected = [
        (owner.clone(), number(&v["selection"][0]), bias),
        (owner.clone(), number(&v["selection"][1]), bias),
    ];
    assert_eq!(endpoints(&d), expected);
    let node = d.snapshot().unwrap().visible[0].clone();
    let content = |n: &editac_core::projection::ProjectedNode| {
        n.runs.iter().map(|r| r.text.as_str()).collect::<String>()
    };
    assert_eq!(content(&node), v["expectedText"].as_str().unwrap());
    let mut offset = 0;
    for run in &node.runs {
        for _ in run.text.encode_utf16() {
            let bold = v["expectedMarks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| number(&m[0]) <= offset && offset < number(&m[1]));
            assert_eq!(run.attributes.len(), usize::from(bold));
            if bold {
                assert_eq!(run.attributes.get("bold"), Some(&Any::Bool(true)));
            }
            offset += 1;
        }
    }
    let checkpoint = d.checkpoint();
    let mut remote = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    let vector = d.state_vector_v1();
    let plan = remote
        .prepare_editor(
            &[EditorCommand::ReplaceAt {
                owner: neighbor.clone(),
                from: U(6),
                to: U(6),
                text: "R".into(),
            }],
            &origin,
        )
        .unwrap();
    remote.commit_editor(plan).unwrap();
    let delta = editac_core::document::ReplayUpdate {
        identity: d.identity().clone(),
        bytes: remote.update_v1(&vector).unwrap(),
    };
    d.apply_replay(&delta).unwrap();
    assert_eq!(count.get(), 2);
    assert_eq!(endpoints(&d), expected);
    assert_eq!(
        content(&d.snapshot().unwrap().visible[1]),
        v["expectedRemote"].as_str().unwrap()
    );
    let actual = endpoints(&d);
    // Negative controls use the same owning assertion and must panic.
    for mutation in 0..5 {
        let mut wrong = expected.clone();
        match mutation {
            0 => wrong[0].1 += 1,
            1 => wrong[1].1 += 1,
            2 => wrong.reverse(),
            3 => {
                wrong[0].2 = if bias == Bias::Left {
                    Bias::Right
                } else {
                    Bias::Left
                }
            }
            _ => wrong[1].0 = neighbor.clone(),
        }
        assert!(std::panic::catch_unwind(|| assert_eq!(actual, wrong)).is_err());
    }
    let from = actual[0].1.min(actual[1].1);
    let to = actual[0].1.max(actual[1].1);
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::ReplaceAt {
                    owner: actual[0].0.clone(),
                    from: U(from),
                    to: U(to),
                    text: "!".into(),
                },
                EditorCommand::MarkAt {
                    owner: owner.clone(),
                    from: U(from),
                    to: U(from + 1),
                    mark: Mark::Bold,
                    action: FormatAction::Remove,
                    href: None,
                },
                EditorCommand::SelectionAt {
                    anchor: pos(2),
                    focus: pos(2),
                },
            ],
            &origin,
        )
        .unwrap();
    let result = d.commit_editor(plan).unwrap();
    let caret = result.result_selection.unwrap();
    for token in [&caret.anchor, &caret.focus] {
        match d.resolve_anchor(token).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(p.node, owner);
                assert_eq!(p.offset, U(2));
                assert_eq!(p.bias, bias);
            }
            _ => panic!("unresolved sentinel selection"),
        }
    }
    let nodes = d.snapshot().unwrap().visible;
    assert_eq!(content(&nodes[0]), v["expectedSentinel"].as_str().unwrap());
    assert!(nodes[0].runs.iter().all(|r| r.attributes.is_empty()));
    assert_eq!(content(&nodes[1]), v["expectedRemote"].as_str().unwrap());
    assert_eq!(count.get(), 3);
    for (node, old) in nodes.iter().zip(&originals) {
        assert_eq!(node.id, old.id);
        assert_eq!(node.spans[0].source, old.spans[0].source);
        assert_eq!(node.spans[0].identity, old.spans[0].identity);
    }
}
macro_rules! remote_selection_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            g03_remote_result($id);
        }
    };
}
remote_selection_case!(g03_remote_replace_forward_left, "G03-replace-forward-left");
remote_selection_case!(
    g03_remote_replace_forward_right,
    "G03-replace-forward-right"
);
remote_selection_case!(
    g03_remote_replace_backward_left,
    "G03-replace-backward-left"
);
remote_selection_case!(
    g03_remote_replace_backward_right,
    "G03-replace-backward-right"
);
remote_selection_case!(g03_remote_format_forward_left, "G03-format-forward-left");
remote_selection_case!(g03_remote_format_forward_right, "G03-format-forward-right");
remote_selection_case!(g03_remote_format_backward_left, "G03-format-backward-left");
remote_selection_case!(
    g03_remote_format_backward_right,
    "G03-format-backward-right"
);

// G03 fragment actions: directional/affinity input, one actual collapsed result
// caret (right-biased by the engine policy), retained across a real replica delta.
fn g03_action_result(id: &str) {
    use editac_core::{
        anchors::Selection,
        commands::editor::{FragmentBlock, FragmentRun},
        document::BlockAttributes,
    };
    use serde_json::json;
    let all: Value = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/selection-vectors.json"
    ))
    .unwrap();
    let v = all["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let mut d = documents(&[
        v["text"].as_str().unwrap(),
        v["remoteText"].as_str().unwrap(),
    ]);
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let origin = TextOrigin::new("local:rgs:selection-actions").unwrap();
    if v["initialKind"] == "code" {
        let p = d
            .prepare_editor(
                &[EditorCommand::BlockCommand(BlockCommand::SetCode {
                    owner: owner.clone(),
                    language: String::new(),
                })],
                &origin,
            )
            .unwrap();
        d.commit_editor(p).unwrap();
    }
    let originals = d.snapshot().unwrap().visible;
    let neighbor = originals[1].id.clone();
    d.clear_history();
    let bias = if v["bias"] == "left" {
        Bias::Left
    } else {
        Bias::Right
    };
    let input = Selection {
        anchor: d
            .anchor(&owner, U(number(&v["inputSelection"][0])), bias)
            .unwrap(),
        focus: d
            .anchor(&owner, U(number(&v["inputSelection"][1])), bias)
            .unwrap(),
    };
    let resolve =
        |doc: &Document, a: &editac_core::anchors::Anchor| match doc.resolve_anchor(a).unwrap() {
            Resolution::Position(p) => p,
            _ => panic!("unresolved selection"),
        };
    let input_actual = [&input.anchor, &input.focus].map(|a| resolve(&d, a));
    for (i, p) in input_actual.iter().enumerate() {
        assert_eq!(p.node, owner);
        assert_eq!(p.offset, U(number(&v["inputSelection"][i])));
        assert_eq!(p.bias, bias);
        assert_eq!(p.source, originals[0].spans[0].source);
        assert_eq!(p.source_offset, p.offset);
    }
    let mut wrong_direction = input_actual.clone();
    wrong_direction.reverse();
    assert!(std::panic::catch_unwind(|| assert_eq!(input_actual, wrong_direction)).is_err());
    let fragment = |text: &str, attributes| FragmentBlock {
        runs: if text.is_empty() {
            vec![]
        } else {
            vec![FragmentRun {
                text: text.into(),
                marks: vec![],
            }]
        },
        attributes: Some(attributes),
        containers: vec![],
        checked: None,
    };
    let blocks = match v["kind"].as_str().unwrap() {
        "enter" => vec![
            fragment("", BlockAttributes::Paragraph),
            fragment("", BlockAttributes::Paragraph),
        ],
        "hard-break" => vec![fragment("\n", BlockAttributes::Paragraph)],
        "pre-paste" => vec![
            fragment("A", BlockAttributes::Code(String::new())),
            fragment("\n", BlockAttributes::Paragraph),
            fragment("B", BlockAttributes::Code(String::new())),
        ],
        _ => panic!("unknown action family"),
    };
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _subscription = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let before = frozen(&d);
    let plan = d.prepare_fragment(&input, &blocks, &origin).unwrap();
    assert_eq!(frozen(&d), before);
    assert_eq!(count.get(), 0);
    let result = d.commit_editor(plan).unwrap();
    assert_eq!(result.revision, before.2 + 1);
    assert_ne!(d.state_vector_v1(), before.1);
    assert_eq!(count.get(), 1);
    assert_eq!(d.history_state().undo_groups, 1);
    assert!(
        result.result_selection.is_none(),
        "fragment returns one collapsed caret"
    );
    let caret = result.result_caret.expect("action must return a caret");
    let committed = d.snapshot().unwrap().visible;
    let destination = &committed[number(&v["resultBlock"]) as usize];
    assert_eq!(
        committed.len(),
        v["expectedBlocks"].as_array().unwrap().len() + 1
    );
    assert_eq!(committed[0].id, owner);
    assert_eq!(committed.last().unwrap().id, neighbor);
    if v["kind"] != "hard-break" {
        assert!(!originals.iter().any(|n| n.id == destination.id));
    }
    let p = resolve(&d, &caret);
    assert_eq!(p.node, destination.id);
    assert_eq!(p.offset, U(number(&v["resultOffset"])));
    assert_eq!(p.bias, Bias::Right);
    let payload_source = destination
        .spans
        .iter()
        .find(|s| s.source != originals[0].spans[0].source)
        .expect("created payload source");
    assert_eq!(p.source, payload_source.source);
    assert_eq!(p.source_offset, U(number(&v["resultSourceOffset"])));
    assert!(
        destination
            .spans
            .iter()
            .any(|s| s.source == originals[0].spans[0].source
                && s.identity == originals[0].spans[0].identity)
    );
    let content = |n: &editac_core::projection::ProjectedNode| {
        n.runs.iter().map(|r| r.text.as_str()).collect::<String>()
    };
    let kind = |n: &editac_core::projection::ProjectedNode| match &n.block_attributes {
        Some(BlockAttributes::Paragraph) => "paragraph",
        Some(BlockAttributes::Code(_)) => "code",
        _ => panic!("unsupported block"),
    };
    let observed = |doc: &Document| {
        let nodes = doc.snapshot().unwrap().visible;
        let p = resolve(doc, &caret);
        json!({"blocks": nodes[..nodes.len()-1].iter().map(|n| json!({"text": content(n), "kind": kind(n), "marks": n.runs.iter().filter(|r| !r.attributes.is_empty()).count()})).collect::<Vec<_>>(),
            "remote": content(nodes.last().unwrap()), "caret": {"node": p.node, "offset": p.offset.0, "source": p.source, "sourceOffset": p.source_offset.0, "bias": if p.bias == Bias::Right {"right"} else {"left"}}, "publications": count.get()})
    };
    let mut expected = json!({"blocks": v["expectedBlocks"].as_array().unwrap().iter().map(|b| json!({"text": b["text"], "kind": b["kind"], "marks": 0})).collect::<Vec<_>>(),
        "remote": v["remoteText"], "caret": {"node": destination.id, "offset": v["resultOffset"], "source": payload_source.source, "sourceOffset": v["resultSourceOffset"], "bias": v["resultBias"]}, "publications": 1});
    assert_eq!(observed(&d), expected);
    let checkpoint = d.checkpoint();
    let mut remote = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    let vector = d.state_vector_v1();
    let plan = remote
        .prepare_editor(
            &[EditorCommand::ReplaceAt {
                owner: neighbor.clone(),
                from: U(6),
                to: U(6),
                text: "R".into(),
            }],
            &origin,
        )
        .unwrap();
    remote.commit_editor(plan).unwrap();
    d.apply_replay(&editac_core::document::ReplayUpdate {
        identity: d.identity().clone(),
        bytes: remote.update_v1(&vector).unwrap(),
    })
    .unwrap();
    expected["remote"] = v["expectedRemote"].clone();
    expected["publications"] = json!(2);
    assert_eq!(observed(&d), expected);
    assert_ne!(d.state_vector_v1(), vector);
    for (pointer, replacement) in [
        ("/blocks/0/text", json!("corrupted")),
        (
            "/blocks/0/kind",
            json!(if v["initialKind"] == "code" {
                "paragraph"
            } else {
                "code"
            }),
        ),
        ("/blocks/0/marks", json!(1)),
        ("/caret/offset", json!(number(&v["resultOffset"]) + 1)),
        ("/caret/bias", json!("left")),
        ("/caret/node", json!(neighbor)),
        ("/caret/source", json!(originals[1].spans[0].source)),
        (
            "/caret/sourceOffset",
            json!(number(&v["resultSourceOffset"]) + 1),
        ),
        ("/remote", json!("remote")),
        ("/publications", json!(3)),
    ] {
        let mut wrong = expected.clone();
        *wrong.pointer_mut(pointer).unwrap() = replacement;
        let actual = observed(&d);
        assert!(std::panic::catch_unwind(|| assert_eq!(actual, wrong)).is_err());
    }
    let position = resolve(&d, &caret);
    let pos = || EditorPosition {
        owner: position.node.clone(),
        offset: U(number(&v["resultOffset"]) + 1),
        bias: Bias::Right,
    };
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::ReplaceAt {
                    owner: position.node.clone(),
                    from: position.offset,
                    to: position.offset,
                    text: "!".into(),
                },
                EditorCommand::SelectionAt {
                    anchor: pos(),
                    focus: pos(),
                },
            ],
            &origin,
        )
        .unwrap();
    let result = d.commit_editor(plan).unwrap();
    let selection = result.result_selection.unwrap();
    for a in [&selection.anchor, &selection.focus] {
        let p = resolve(&d, a);
        assert_eq!(p.node, destination.id);
        assert_eq!(p.offset, U(number(&v["resultOffset"]) + 1));
        assert_eq!(p.bias, Bias::Right);
    }
    let nodes = d.snapshot().unwrap().visible;
    for (i, node) in nodes[..nodes.len() - 1].iter().enumerate() {
        assert_eq!(content(node), v["expectedSentinel"][i].as_str().unwrap());
        assert_eq!(kind(node), v["expectedBlocks"][i]["kind"].as_str().unwrap());
        assert!(node.runs.iter().all(|r| r.attributes.is_empty()));
    }
    assert_eq!(
        content(nodes.last().unwrap()),
        v["expectedRemote"].as_str().unwrap()
    );
    assert_eq!(count.get(), 3);
    for (node, old) in [
        (&nodes[0], &originals[0]),
        (nodes.last().unwrap(), &originals[1]),
    ] {
        assert_eq!(node.id, old.id);
        assert_eq!(node.spans[0].source, old.spans[0].source);
        assert_eq!(node.spans[0].identity, old.spans[0].identity);
    }
    for (node, prior) in nodes.iter().zip(&committed) {
        assert_eq!(node.id, prior.id);
    }
}
macro_rules! action_selection_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            g03_action_result($id);
        }
    };
}
action_selection_case!(g03_action_enter_forward_left, "G03-enter-forward-left");
action_selection_case!(g03_action_enter_forward_right, "G03-enter-forward-right");
action_selection_case!(g03_action_enter_backward_left, "G03-enter-backward-left");
action_selection_case!(g03_action_enter_backward_right, "G03-enter-backward-right");
action_selection_case!(
    g03_action_hard_break_forward_left,
    "G03-hard-break-forward-left"
);
action_selection_case!(
    g03_action_hard_break_forward_right,
    "G03-hard-break-forward-right"
);
action_selection_case!(
    g03_action_hard_break_backward_left,
    "G03-hard-break-backward-left"
);
action_selection_case!(
    g03_action_hard_break_backward_right,
    "G03-hard-break-backward-right"
);
action_selection_case!(
    g03_action_pre_paste_forward_left,
    "G03-pre-paste-forward-left"
);
action_selection_case!(
    g03_action_pre_paste_forward_right,
    "G03-pre-paste-forward-right"
);
action_selection_case!(
    g03_action_pre_paste_backward_left,
    "G03-pre-paste-backward-left"
);
action_selection_case!(
    g03_action_pre_paste_backward_right,
    "G03-pre-paste-backward-right"
);

// REG-06: independently authored rejection matrix at the owning prepare ports.
fn reg06_rejection_matrix(id: &str) {
    use editac_core::{
        anchors::Selection,
        commands::{
            editor::{FragmentBlock, FragmentRun},
            format::FormatCommand,
        },
    };
    use serde_json::json;
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/schema-rejection-vectors.json"
    ))
    .unwrap();
    let v = vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let mut d = documents(&["ab", "cd"]);
    let originals = d.snapshot().unwrap().visible;
    let owners = [originals[0].id.clone(), originals[1].id.clone()];
    let origin = TextOrigin::new("local:rgs:schema").unwrap();
    let setup = d
        .prepare_editor(
            &[
                EditorCommand::BlockCommand(BlockCommand::SetCode {
                    owner: owners[0].clone(),
                    language: String::new(),
                }),
                EditorCommand::MarkAt {
                    owner: owners[1].clone(),
                    from: U(0),
                    to: U(2),
                    mark: Mark::Bold,
                    action: FormatAction::Apply,
                    href: None,
                },
            ],
            &origin,
        )
        .unwrap();
    d.commit_editor(setup).unwrap();
    d.clear_history();
    let bias = if v["bias"] == "left" {
        Bias::Left
    } else {
        Bias::Right
    };
    let indices = [
        number(&v["endpoints"][0]) as usize,
        number(&v["endpoints"][1]) as usize,
    ];
    let selection = Selection {
        anchor: d.anchor(&owners[indices[0]], U(1), bias).unwrap(),
        focus: d.anchor(&owners[indices[1]], U(1), bias).unwrap(),
    };
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _subscription = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let before = frozen(&d);
    let snapshot = d.snapshot().unwrap().visible;
    let observe = |d: &Document| {
        let nodes = d.snapshot().unwrap().visible;
        let endpoints = [&selection.anchor, &selection.focus].map(|a| match d.resolve_anchor(a).unwrap() {
            Resolution::Position(p) => json!({"node":p.node,"offset":p.offset.0,"source":p.source,"sourceOffset":p.source_offset.0,"bias":if p.bias == Bias::Left {"left"} else {"right"}}),
            _ => panic!("input anchor unresolved"),
        });
        json!({"semantic":nodes.iter().map(|n| json!({"owner":n.id,"kind":if matches!(n.block_attributes, Some(editac_core::document::BlockAttributes::Code { .. })) {"code"} else {"paragraph"},"text":n.runs.iter().map(|r| r.text.as_str()).collect::<String>(),"marks":n.runs.iter().map(|r| &r.attributes).collect::<Vec<_>>(),"spans":n.spans.iter().map(|s| json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>()})).collect::<Vec<_>>(),
            "endpoints":endpoints,"revision":d.revision(),"vector":d.state_vector_v1(),"checkpoint":d.checkpoint().bytes,"history":format!("{:?}",d.history_state()),"publications":count.get()})
    };
    let expected = json!({"semantic":(0..2).map(|i| json!({"owner":owners[i],"kind":if i==0 {"code"} else {"paragraph"},"text":if i==0 {"ab"} else {"cd"},"marks":[if i==0 {json!({})} else {json!({"bold":true})}],"spans":originals[i].spans.iter().map(|s| json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "endpoints":indices.map(|i| json!({"node":owners[i],"offset":1,"source":originals[i].spans[0].source,"sourceOffset":1,"bias":v["bias"]})),"revision":before.2,"vector":before.1,"checkpoint":before.0,"history":format!("{:?}",before.3),"publications":0});
    assert_eq!(observe(&d), expected);
    if v["kind"] == "format" {
        assert!(
            d.prepare_format(
                &[FormatCommand {
                    selection: selection.clone(),
                    mark: Mark::Bold,
                    action: FormatAction::Apply,
                    href: None
                }],
                &origin
            )
            .is_err()
        );
    } else {
        let fragment = FragmentBlock {
            runs: vec![FragmentRun {
                text: if v["kind"] == "delete" { "" } else { "X" }.into(),
                marks: vec![],
            }],
            attributes: None,
            containers: vec![],
            checked: None,
        };
        assert!(
            d.prepare_fragment(&selection, &[fragment], &origin)
                .is_err()
        );
    }
    assert_eq!(frozen(&d), before);
    assert_eq!(d.snapshot().unwrap().visible, snapshot);
    assert_eq!(observe(&d), expected);
    let mutations = [
        ("/semantic/0/kind", json!("paragraph")),
        ("/semantic/1/text", json!("c")),
        ("/semantic/1/marks", json!([{}])),
        ("/semantic/1/owner", json!(owners[0])),
        (
            "/semantic/1/spans/0/source",
            json!(originals[0].spans[0].source),
        ),
        (
            "/semantic/1/spans/0/identity",
            json!(originals[0].spans[0].identity),
        ),
        ("/endpoints/0/offset", json!(2)),
        ("/endpoints/1/offset", json!(2)),
        (
            "/endpoints",
            json!([expected["endpoints"][1], expected["endpoints"][0]]),
        ),
        (
            "/endpoints/0/bias",
            json!(if bias == Bias::Left { "right" } else { "left" }),
        ),
        ("/endpoints/1/sourceOffset", json!(2)),
        ("/revision", json!(before.2 + 1)),
        ("/vector", json!([])),
        ("/checkpoint", json!([])),
        ("/history", json!("corrupt history")),
        ("/publications", json!(1)),
    ];
    for (path, value) in mutations {
        let mut wrong = expected.clone();
        *wrong.pointer_mut(path).unwrap() = value;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                observe(&d),
                wrong
            )))
            .is_err(),
            "undetected {path}"
        );
    }
}
macro_rules! schema_rejection_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            reg06_rejection_matrix($id);
        }
    };
}
schema_rejection_case!(
    reg06_matrix_delete_forward_left,
    "REG06-delete-forward-left"
);
schema_rejection_case!(
    reg06_matrix_delete_forward_right,
    "REG06-delete-forward-right"
);
schema_rejection_case!(
    reg06_matrix_delete_backward_left,
    "REG06-delete-backward-left"
);
schema_rejection_case!(
    reg06_matrix_delete_backward_right,
    "REG06-delete-backward-right"
);
schema_rejection_case!(
    reg06_matrix_replace_forward_left,
    "REG06-replace-forward-left"
);
schema_rejection_case!(
    reg06_matrix_replace_forward_right,
    "REG06-replace-forward-right"
);
schema_rejection_case!(
    reg06_matrix_replace_backward_left,
    "REG06-replace-backward-left"
);
schema_rejection_case!(
    reg06_matrix_replace_backward_right,
    "REG06-replace-backward-right"
);
schema_rejection_case!(
    reg06_matrix_format_forward_left,
    "REG06-format-forward-left"
);
schema_rejection_case!(
    reg06_matrix_format_forward_right,
    "REG06-format-forward-right"
);
schema_rejection_case!(
    reg06_matrix_format_backward_left,
    "REG06-format-backward-left"
);
schema_rejection_case!(
    reg06_matrix_format_backward_right,
    "REG06-format-backward-right"
);
