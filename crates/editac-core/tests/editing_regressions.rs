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
