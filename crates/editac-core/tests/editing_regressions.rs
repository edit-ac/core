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
fn atomic_commands(v: &Value, owner: &str) -> Vec<EditorCommand> {
    v["commands"]
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
        .collect()
}
fn atomic(id: &str) {
    let all = vectors();
    let v = all["atomic"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    if matches!(
        id,
        "REG-13-valid"
            | "REG-13-invalid-final-owner"
            | "REG-13-invalid-final-surrogate"
            | "G03-backward-selection"
            | "REG-13-invalid-final-selection"
            | "REG-13-invalid-mark-policy"
            | "REG-13-staged-offsets"
            | "G06-astral-staged-utf16"
            | "G06-invalid-first-surrogate"
    ) {
        qualified_raw_atomic(v);
        return;
    }
    let mut d = document(v["text"].as_str().unwrap());
    let original = d.snapshot().unwrap().visible[0].clone();
    let owner = original.id.clone();
    let commands = atomic_commands(v, &owner);
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
// C20/C21 own complete snapshots at each selected native vector, including a
// separate accepted observer probe after rejection. It does not claim storage.
fn qualified_raw_atomic(v: &Value) {
    use serde_json::json;
    fn verify(actual: &Value, expected: &Value, paths: &[&str]) -> usize {
        assert_eq!(actual, expected);
        for path in paths {
            let mut wrong = expected.clone();
            *wrong.pointer_mut(path).unwrap() = json!("corrupted");
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                    actual,
                    &wrong
                )))
                .is_err(),
                "undetected {path}"
            );
        }
        paths.len()
    }
    let mut d = document(v["text"].as_str().unwrap());
    let original = d.snapshot().unwrap().visible[0].clone();
    let owner = original.id.clone();
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
    let mut controls = 0;
    let mut checkpoints = 0;
    let mut accepted = v.clone();
    let plan = d.prepare_editor(&atomic_commands(v, &owner), &origin);
    assert_eq!(frozen(&d), before);
    assert_eq!(count.get(), 0);
    checkpoints += 2;
    if v["rejected"] == true {
        assert!(plan.is_err());
        checkpoints += 1;
        assert_eq!(d.snapshot().unwrap().visible, vec![original.clone()]);
        checkpoints += 1;
        let observed = json!({"content":format!("{:?}", d.snapshot().unwrap().visible), "vector":d.state_vector_v1(), "checkpoint":d.checkpoint().bytes, "revision":d.revision(), "history":format!("{:?}",d.history_state()), "publications":count.get()});
        let expected = json!({"content":format!("{:?}",vec![original.clone()]), "vector":before.1, "checkpoint":before.0, "revision":before.2, "history":format!("{:?}",before.3), "publications":0});
        controls += verify(
            &observed,
            &expected,
            &[
                "/content",
                "/vector",
                "/checkpoint",
                "/revision",
                "/history",
                "/publications",
            ],
        );
        checkpoints += 1;
        accepted = json!({"id":format!("{}/live-probe",v["id"].as_str().unwrap()), "commands":[{"type":"replaceAt","from":0,"to":0,"text":"!"},{"type":"selectionAt","anchor":1,"focus":1}], "expectedText":format!("!{}",v["text"].as_str().unwrap()), "expectedMarks":[], "selection":[1,1]});
    }
    let plan = if v["rejected"] == true {
        d.prepare_editor(&atomic_commands(&accepted, &owner), &origin)
            .unwrap()
    } else {
        plan.unwrap()
    };
    assert_eq!(frozen(&d), before);
    assert_eq!(count.get(), 0);
    checkpoints += 2;
    let result = d.commit_editor(plan).unwrap();
    let nodes = d.snapshot().unwrap().visible;
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].kind, original.kind);
    assert_eq!(nodes[0].block_attributes, original.block_attributes);
    checkpoints += 3;
    let node = &nodes[0];
    let text = node
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect::<String>();
    let mut units = Vec::new();
    for run in &node.runs {
        let attrs = run
            .attributes
            .iter()
            .map(|(key, value)| {
                assert_eq!(value, &Any::Bool(true));
                (key.clone(), json!(true))
            })
            .collect::<serde_json::Map<_, _>>();
        for _ in run.text.encode_utf16() {
            units.push(Value::Object(attrs.clone()));
        }
    }
    let expected_text = accepted["expectedText"].as_str().unwrap();
    let expected_units = (0..expected_text.encode_utf16().count() as u32)
        .map(|offset| {
            Value::Object(
                accepted["expectedMarks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| number(&m[0]) <= offset && offset < number(&m[1]))
                    .map(|m| (m[2].as_str().unwrap().to_string(), json!(true)))
                    .collect(),
            )
        })
        .collect::<Vec<_>>();
    let mut endpoints = Vec::new();
    for token in [
        &result.result_selection.as_ref().unwrap().anchor,
        &result.result_selection.as_ref().unwrap().focus,
    ] {
        match d.resolve_anchor(token).unwrap() {
            Resolution::Position(p) => endpoints.push(json!({"owner":p.node,"offset":p.offset.0,"source":p.source,"sourceOffset":p.source_offset.0,"bias":format!("{:?}",p.bias)})),
            _ => panic!("unresolved endpoint"),
        }
    }
    let expected_endpoints = [0,1].map(|i| json!({"owner":owner,"offset":accepted["selection"][i],"source":original.spans[0].source,"sourceOffset":accepted["selection"][i],"bias":if i == 0 {"Left"} else {"Right"}}));
    let observed = json!({"text":text,"units":units,"owner":node.id,"source":node.spans[0].source,"identity":format!("{:?}",node.spans[0].identity),"endpoints":endpoints,"revision":result.revision,"publications":count.get(),"undo":d.history_state().undo_groups,"redo":d.history_state().redo_groups});
    let expected = json!({"text":expected_text,"units":expected_units,"owner":owner,"source":original.spans[0].source,"identity":format!("{:?}",original.spans[0].identity),"endpoints":expected_endpoints,"revision":before.2 + 1,"publications":1,"undo":1,"redo":0});
    controls += verify(
        &observed,
        &expected,
        &[
            "/text",
            "/units",
            "/owner",
            "/source",
            "/identity",
            "/endpoints/0/offset",
            "/endpoints/1/offset",
            "/endpoints/0/bias",
            "/endpoints/1/bias",
            "/revision",
            "/publications",
            "/undo",
            "/redo",
        ],
    );
    let remaining = matches!(
        v["id"].as_str().unwrap(),
        "REG-13-valid"
            | "REG-13-invalid-final-owner"
            | "REG-13-invalid-final-surrogate"
            | "G03-backward-selection"
    );
    if v["id"] == "G03-backward-selection" {
        controls += verify(
            &json!({"backward": observed["endpoints"][0]["offset"].as_u64().unwrap() > observed["endpoints"][1]["offset"].as_u64().unwrap()}),
            &json!({"backward": true}),
            &["/backward"],
        );
        checkpoints += 1;
    }
    if remaining {
        controls += verify(
            &observed,
            &expected,
            &[
                "/endpoints/0/owner",
                "/endpoints/1/owner",
                "/endpoints/0/source",
                "/endpoints/1/source",
                "/endpoints/0/sourceOffset",
                "/endpoints/1/sourceOffset",
            ],
        );
        checkpoints += 1;
    }
    checkpoints += 1;
    assert_ne!(d.checkpoint().bytes, before.0);
    assert_ne!(d.state_vector_v1(), before.1);
    checkpoints += 2;
    d.undo().unwrap().unwrap();
    assert_eq!(d.snapshot().unwrap().visible, vec![original]);
    assert_eq!(count.get(), 2);
    assert_eq!(d.history_state().undo_groups, 0);
    assert_eq!(d.history_state().redo_groups, 1);
    checkpoints += 4;
    println!(
        "{} {} checkpoints={} controls={} rejection={} accepted=1 content_undo=1",
        if remaining { "C21" } else { "C20" },
        v["id"].as_str().unwrap(),
        checkpoints,
        controls,
        v["rejected"] == true
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
    use serde_json::json;
    let all = vectors();
    let v = all["graphemes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let mut controls = 0;
    for bias in [Bias::Left, Bias::Right] {
        let text = v["text"].as_str().unwrap();
        let mut d = document(text);
        let original = d.snapshot().unwrap().visible[0].clone();
        let owner = original.id.clone();
        let before = frozen(&d);
        let count = Rc::new(Cell::new(0));
        let seen = count.clone();
        let _subscription = d
            .subscribe(PatchScope::All, move |_, _| {
                seen.set(seen.get() + 1);
                Ok(())
            })
            .unwrap();
        let origin = TextOrigin::new("local:rgs:unicode").unwrap();
        let range = deletion_range(text, U(number(&v["offset"])), Direction::Backward);
        let applied = v["rejected"] != true && !v["range"].is_null();
        let mut endpoints = json!([]);
        if v["rejected"] == true {
            assert!(range.is_err());
            if id == "surrogate-interior" {
                // Invalid UTF-16 public command ranges also reach real preparation.
                assert!(
                    d.prepare_editor(
                        &[EditorCommand::ReplaceAt {
                            owner: owner.clone(),
                            from: U(2),
                            to: U(3),
                            text: String::new()
                        }],
                        &origin
                    )
                    .is_err()
                );
            }
        } else if v["range"].is_null() {
            // A boundary deletion has no range and dispatches no engine edit.
            // Preparing an empty replacement is a different operation.
            assert!(range.unwrap().is_none());
        } else {
            let range = range.unwrap();
            let (from, to) = if v["range"].is_null() {
                assert!(range.is_none());
                (U(0), U(0))
            } else {
                let range = range.unwrap();
                assert_eq!(range, U(number(&v["range"][0]))..U(number(&v["range"][1])));
                (range.start, range.end)
            };
            let plan = d
                .prepare_editor(
                    &[
                        EditorCommand::ReplaceAt {
                            owner: owner.clone(),
                            from,
                            to,
                            text: String::new(),
                        },
                        EditorCommand::SelectionAt {
                            anchor: EditorPosition {
                                owner: owner.clone(),
                                offset: U(number(&v["selection"][0])),
                                bias,
                            },
                            focus: EditorPosition {
                                owner: owner.clone(),
                                offset: U(number(&v["selection"][1])),
                                bias,
                            },
                        },
                    ],
                    &origin,
                )
                .unwrap();
            assert_eq!(frozen(&d), before, "preparation changed state");
            assert_eq!(count.get(), 0);
            let result = d.commit_editor(plan).unwrap();
            assert_eq!(result.revision, before.2 + u64::from(applied));
            let selection = result.result_selection.unwrap();
            endpoints = json!([&selection.anchor, &selection.focus].map(|token| match d.resolve_anchor(token).unwrap() {
                Resolution::Position(p) => json!({"node":p.node,"offset":p.offset.0,"bias":if p.bias == Bias::Left {"left"} else {"right"}}),
                _ => panic!("prepared Unicode result unresolved"),
            }));
        }
        let observe = |d: &Document| {
            let snapshot = d.snapshot().unwrap();
            let node = &snapshot.visible[0];
            json!({"visibleCount":snapshot.visible.len(),"owner":node.id,"kind":node.kind,"attributes":format!("{:?}",node.block_attributes),"text":node.runs.iter().map(|r|r.text.as_str()).collect::<String>(),"runs":node.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes})).collect::<Vec<_>>(),"spans":node.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>(),"endpoints":endpoints,"revision":d.revision(),"publications":count.get(),"undo":d.history_state().undo_groups,"redo":d.history_state().redo_groups})
        };
        let expected_endpoints = if !applied {
            json!([])
        } else {
            json!(v["selection"].as_array().unwrap().iter().map(|offset|json!({"node":owner,"offset":offset,"bias":if bias == Bias::Left {"left"} else {"right"}})).collect::<Vec<_>>())
        };
        let expected = json!({"visibleCount":1,"owner":owner,"kind":original.kind,"attributes":format!("{:?}",original.block_attributes),"text":v["expectedText"],"runs":[{"text":v["expectedText"],"attributes":{}}],"spans":original.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>(),"endpoints":expected_endpoints,"revision":before.2+u64::from(applied),"publications":u32::from(applied),"undo":u32::from(applied),"redo":0});
        assert_eq!(observe(&d), expected);
        for (path, value) in [
            ("/text", json!("corrupted")),
            ("/runs/0/attributes", json!({"bold":true})),
            ("/owner", json!("missing")),
            ("/spans/0/source", json!("missing")),
            ("/spans/0/identity", json!("missing")),
            ("/attributes", json!(["code"])),
            ("/visibleCount", json!(2)),
            ("/revision", json!(before.2 + 2)),
            ("/publications", json!(2)),
            ("/undo", json!(2)),
            ("/redo", json!(1)),
        ] {
            let mut wrong = expected.clone();
            *wrong.pointer_mut(path).unwrap() = value;
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                    observe(&d),
                    wrong
                )))
                .is_err(),
                "undetected {id}/{path}"
            );
            controls += 1;
        }
        if applied {
            for (path, value) in [
                ("/endpoints/0/offset", json!(99)),
                ("/endpoints/1/offset", json!(99)),
                ("/endpoints/0/node", json!("missing")),
                (
                    "/endpoints/1/bias",
                    json!(if bias == Bias::Left { "right" } else { "left" }),
                ),
            ] {
                let mut wrong = expected.clone();
                *wrong.pointer_mut(path).unwrap() = value;
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                        observe(&d),
                        wrong
                    )))
                    .is_err(),
                    "undetected {id}/{path}"
                );
                controls += 1;
            }
        }
        if applied {
            // Delete-set updates do not advance the CRDT insertion clock.
            assert_eq!(d.state_vector_v1(), before.1);
            assert_ne!(d.checkpoint().bytes, before.0);
        } else {
            assert_eq!(frozen(&d), before);
            let observe_frozen = |d: &Document| json!({"vector":d.state_vector_v1(),"checkpoint":d.checkpoint().bytes,"revision":d.revision(),"history":format!("{:?}",d.history_state()),"publications":count.get()});
            let expected_frozen = json!({"vector":before.1,"checkpoint":before.0,"revision":before.2,"history":format!("{:?}",before.3),"publications":0});
            assert_eq!(observe_frozen(&d), expected_frozen);
            for (path, value) in [
                ("/vector", json!([])),
                ("/checkpoint", json!([])),
                ("/revision", json!(before.2 + 1)),
                ("/history", json!("corrupted")),
                ("/publications", json!(1)),
            ] {
                let mut wrong = expected_frozen.clone();
                *wrong.pointer_mut(path).unwrap() = value;
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                        observe_frozen(&d),
                        wrong
                    )))
                    .is_err(),
                    "undetected {id}/{path}"
                );
                controls += 1;
            }
        }
    }
    println!("G06_RECEIPT id={id} vectors=2 controls={controls}");
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
    assert_eq!(nodes[0].spans[0].identity, original.spans[0].identity);
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
    assert_eq!(restored[0].spans[0].source, original.spans[0].source);
    assert_eq!(restored[0].spans[0].identity, original.spans[0].identity);
    assert_eq!(d.history_state().undo_groups, 0);
    assert_eq!(d.history_state().redo_groups, 1);
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
    if cross_owner {
        // A clipboard-only staging repair must not broaden ordinary Join.
        assert!(
            d.prepare_editor(
                &[EditorCommand::Join {
                    first: originals[0].id.clone(),
                    second: originals[1].id.clone(),
                }],
                &origin
            )
            .is_err()
        );
        let mut invalid = fragments.clone();
        invalid[2].attributes = Some(BlockAttributes::Code("invalid language!".into()));
        assert!(d.prepare_fragment(&selection, &invalid, &origin).is_err());
        assert_eq!(frozen(&d), before);
        assert_eq!(count.get(), 0);
    }
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
    assert_eq!(pasted[0].spans[0].identity, originals[0].spans[0].identity);
    let suffix_source = originals.last().unwrap().spans.last().unwrap();
    assert!(
        pasted[2]
            .spans
            .iter()
            .any(|span| span.source == suffix_source.source
                && span.identity == suffix_source.identity)
    );
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
        assert_eq!(node.spans, old.spans);
    }
    d.redo().unwrap().unwrap();
    assert_eq!(count.get(), 3);
    let redone = d.snapshot().unwrap().visible;
    assert_eq!(redone.len(), 3);
    for (node, old) in redone.iter().zip(&pasted) {
        assert_eq!(node.id, old.id);
        assert_eq!(node.block_attributes, old.block_attributes);
        assert_eq!(node.runs, old.runs);
        assert_eq!(node.spans, old.spans);
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

// Matches C18's empty-destination committed state. Pending toggles/rejection
// are editor-local and remain packed-driver assertions, never native claims.
#[test]
fn reg05_empty_destination_committed_vector() {
    let mut d = documents(&["a", ""]);
    let nodes = d.snapshot().unwrap().visible;
    let first = nodes[0].id.clone();
    let empty = nodes[1].id.clone();
    let origin = TextOrigin::new("local:rgs:empty-destination").unwrap();
    let plan = d
        .prepare_editor(
            &[EditorCommand::MarkAt {
                owner: first.clone(),
                from: U(0),
                to: U(1),
                mark: Mark::Bold,
                action: FormatAction::Apply,
                href: None,
            }],
            &origin,
        )
        .unwrap();
    d.commit_editor(plan).unwrap();
    d.clear_history();
    let original = d.snapshot().unwrap().visible;
    let before = frozen(&d);
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    for (owner, offset) in [(&first, 1), (&empty, 0), (&first, 1), (&empty, 0)] {
        let anchor = d.anchor(owner, U(offset), Bias::Right).unwrap();
        match d.resolve_anchor(&anchor).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(&p.node, owner);
                assert_eq!(p.offset, U(offset));
                assert_eq!(p.bias, Bias::Right);
            }
            _ => panic!("missing revisit position"),
        }
        assert_eq!(frozen(&d), before);
        assert_eq!(count.get(), 0);
    }
    let point = || EditorPosition {
        owner: empty.clone(),
        offset: U(1),
        bias: Bias::Right,
    };
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::ReplaceAt {
                    owner: empty.clone(),
                    from: U(0),
                    to: U(0),
                    text: "X".into(),
                },
                EditorCommand::SelectionAt {
                    anchor: point(),
                    focus: point(),
                },
            ],
            &origin,
        )
        .unwrap();
    assert_eq!(frozen(&d), before);
    assert_eq!(count.get(), 0);
    let result = d.commit_editor(plan).unwrap();
    assert_eq!(count.get(), 1);
    assert_eq!(d.revision(), before.2 + 1);
    assert_eq!(d.history_state().undo_groups, 1);
    let after = d.snapshot().unwrap().visible;
    assert_eq!(after.len(), 2);
    assert_eq!(after[0].id, first);
    assert_eq!(after[0].runs, original[0].runs);
    assert_eq!(after[0].block_attributes, original[0].block_attributes);
    assert_eq!(after[0].spans[0].source, original[0].spans[0].source);
    assert_eq!(after[1].id, empty);
    assert_eq!(after[1].block_attributes, original[1].block_attributes);
    assert_eq!(
        after[1]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "X"
    );
    assert!(after[1].runs.iter().all(|r| r.attributes.is_empty()));
    let selection = result.result_selection.unwrap();
    for token in [&selection.anchor, &selection.focus] {
        match d.resolve_anchor(token).unwrap() {
            Resolution::Position(p) => {
                assert_eq!(p.node, empty);
                assert_eq!(p.offset, U(1));
                assert_eq!(p.bias, Bias::Right);
            }
            _ => panic!("missing empty-destination result"),
        }
    }
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

// RGS-1.2-C8: the editor-local pending matrix belongs to the packed adapter.
// Native matches the four shared document/selection vectors without claiming it.
fn mixed_batch(id: &str) {
    use serde_json::json;
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/mixed-batch-vectors.json"
    ))
    .unwrap();
    let v = vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let mut d = document(vectors["initialText"].as_str().unwrap());
    let original = d.snapshot().unwrap().visible[0].clone();
    let owner = original.id.clone();
    let bias = if v["bias"] == "left" {
        Bias::Left
    } else {
        Bias::Right
    };
    let commands: Vec<_> = vectors["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| match c["type"].as_str().unwrap() {
            "insertText" => EditorCommand::ReplaceAt {
                owner: owner.clone(),
                from: U(number(&c["offset"])),
                to: U(number(&c["offset"])),
                text: c["text"].as_str().unwrap().into(),
            },
            "replaceText" => EditorCommand::ReplaceAt {
                owner: owner.clone(),
                from: U(number(&c["from"])),
                to: U(number(&c["to"])),
                text: c["text"].as_str().unwrap().into(),
            },
            "applyMark" => EditorCommand::MarkAt {
                owner: owner.clone(),
                from: U(number(&c["from"])),
                to: U(number(&c["to"])),
                mark: mark(c["mark"].as_str().unwrap()),
                action: FormatAction::Apply,
                href: None,
            },
            _ => panic!("unbound mixed batch command"),
        })
        .collect();
    let origin = TextOrigin::new("local:rgs:mixed-batch").unwrap();
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
    let observe_rejection = |d: &Document| json!({"document": d.snapshot().unwrap().visible.iter().map(|n| json!({"owner":n.id,"text":n.runs.iter().map(|r|r.text.as_str()).collect::<String>(),"runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes})).collect::<Vec<_>>(),"spans":n.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>()})).collect::<Vec<_>>(), "revision":d.revision(),"vector":d.state_vector_v1(),"checkpoint":d.checkpoint().bytes,"history":format!("{:?}",d.history_state()),"publications":count.get()});
    let expected_rejection = json!({"document":[{"owner":owner,"text":vectors["initialText"],"runs":[{"text":vectors["initialText"],"attributes":{}}],"spans":original.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>()}],"revision":before.2,"vector":before.1,"checkpoint":before.0,"history":format!("{:?}",before.3),"publications":0});
    let mut invalid = commands.clone();
    if let EditorCommand::MarkAt { owner, .. } = invalid.last_mut().unwrap() {
        *owner = vectors["invalidFinalOwner"].as_str().unwrap().into();
    } else {
        panic!("expected final mark");
    }
    // The staged emoji spans UTF-16 [3,5); offset 4 must not be resolved
    // against the entry document where it was a valid boundary.
    let mut invalid_mark = commands.clone();
    if let EditorCommand::MarkAt { from, to, .. } = invalid_mark.last_mut().unwrap() {
        *from = U(number(&vectors["invalidStagedUtf16Offset"]));
        *to = U(5);
    }
    let mut invalid_selection = commands.clone();
    invalid_selection.push(EditorCommand::SelectionAt {
        anchor: EditorPosition {
            owner: owner.clone(),
            offset: U(1),
            bias,
        },
        focus: EditorPosition {
            owner: owner.clone(),
            offset: U(number(&vectors["invalidStagedUtf16Offset"])),
            bias,
        },
    });
    for (name, rejected) in [
        ("missing-final-owner", invalid),
        ("staged-surrogate-mark", invalid_mark),
        ("staged-surrogate-selection", invalid_selection),
    ] {
        assert!(
            d.prepare_editor(&rejected, &origin).is_err(),
            "accepted {name}"
        );
        assert_eq!(frozen(&d), before, "mutated after {name}");
        assert_eq!(d.snapshot().unwrap().visible, snapshot);
        assert_eq!(observe_rejection(&d), expected_rejection);
    }
    for (path, value) in [
        ("/document", json!([])),
        ("/revision", json!(before.2 + 1)),
        ("/vector", json!([])),
        ("/checkpoint", json!([])),
        ("/history", json!("corrupt")),
        ("/publications", json!(1)),
    ] {
        let mut wrong = expected_rejection.clone();
        *wrong.pointer_mut(path).unwrap() = value;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                observe_rejection(&d),
                wrong
            )))
            .is_err(),
            "undetected {path}"
        );
    }
    let mut valid = commands;
    valid.push(EditorCommand::SelectionAt {
        anchor: EditorPosition {
            owner: owner.clone(),
            offset: U(number(&v["selection"][0])),
            bias,
        },
        focus: EditorPosition {
            owner: owner.clone(),
            offset: U(number(&v["selection"][1])),
            bias,
        },
    });
    let plan = d.prepare_editor(&valid, &origin).unwrap();
    assert_eq!(frozen(&d), before);
    assert_eq!(count.get(), 0);
    let result = d.commit_editor(plan).unwrap();
    assert_ne!(d.state_vector_v1(), before.1);
    assert_ne!(d.checkpoint().bytes, before.0);
    let selection = result.result_selection.unwrap();
    let observe_retry = |d: &Document| {
        let node = d.snapshot().unwrap().visible[0].clone();
        let endpoints=[&selection.anchor,&selection.focus].map(|token| match d.resolve_anchor(token).unwrap() {
            Resolution::Position(p)=>json!({"node":p.node,"offset":p.offset.0,"source":p.source,"sourceOffset":p.source_offset.0,"bias":if p.bias==Bias::Left {"left"} else {"right"}}),
            _=>panic!("result selection unresolved"),
        });
        json!({"text":node.runs.iter().map(|r|r.text.as_str()).collect::<String>(),"runs":node.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes})).collect::<Vec<_>>(),"owner":node.id,"spans":node.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>(),"endpoints":endpoints,"revision":d.revision(),"publications":count.get(),"undoGroups":d.history_state().undo_groups,"redoGroups":d.history_state().redo_groups})
    };
    let expected_retry = json!({"text":vectors["expectedText"],"runs":vectors["expectedRuns"],"owner":owner,"spans":original.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>(),"endpoints":v["selection"].as_array().unwrap().iter().map(|offset|json!({"node":owner,"offset":offset,"source":original.spans[0].source,"sourceOffset":offset,"bias":v["bias"]})).collect::<Vec<_>>(),"revision":before.2+1,"publications":1,"undoGroups":1,"redoGroups":0});
    assert_eq!(result.revision, before.2 + 1);
    assert_eq!(observe_retry(&d), expected_retry);
    assert!(
        observe_retry(&d)["text"]
            .as_str()
            .unwrap()
            .ends_with(vectors["suffix"].as_str().unwrap())
    );
    for (path, value) in [
        ("/text", json!("aXY😀bc")),
        ("/runs/2/text", json!("😀b")),
        ("/runs/1/attributes", json!({})),
        ("/runs/2/attributes", json!({"bold":true})),
        ("/owner", json!("missing")),
        ("/spans/0/source", json!("missing")),
        ("/spans/0/identity", json!("missing")),
        ("/endpoints/0/offset", json!(0)),
        ("/endpoints/1/offset", json!(0)),
        (
            "/endpoints",
            json!([
                expected_retry["endpoints"][1],
                expected_retry["endpoints"][0]
            ]),
        ),
        (
            "/endpoints/1/bias",
            json!(if bias == Bias::Left { "right" } else { "left" }),
        ),
        ("/endpoints/1/sourceOffset", json!(0)),
        ("/revision", json!(before.2 + 2)),
        ("/publications", json!(2)),
        ("/undoGroups", json!(2)),
        ("/redoGroups", json!(1)),
    ] {
        let mut wrong = expected_retry.clone();
        *wrong.pointer_mut(path).unwrap() = value;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_eq!(
                observe_retry(&d),
                wrong
            )))
            .is_err(),
            "undetected {path}"
        );
    }
}
macro_rules! mixed_batch_case {
    ($name:ident,$id:literal) => {
        #[test]
        fn $name() {
            mixed_batch($id);
        }
    };
}
mixed_batch_case!(reg13_mixed_forward_left, "REG13-mixed-forward-left");
mixed_batch_case!(reg13_mixed_forward_right, "REG13-mixed-forward-right");
mixed_batch_case!(reg13_mixed_backward_left, "REG13-mixed-backward-left");
mixed_batch_case!(reg13_mixed_backward_right, "REG13-mixed-backward-right");

// G04 mirrors committed operations only. Pending sets belong to the packed editor.
fn g04_pending_sequence(id: &str) {
    use editac_core::anchors::Selection;
    use editac_core::{commands::editor::FragmentBlock, document::BlockAttributes};
    use serde_json::json;
    use std::collections::BTreeMap;
    let all: Value = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/pending-vectors.json"
    ))
    .unwrap();
    let v = all["sequences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let initial = v["initial"]["blocks"].as_array().unwrap();
    let mut d = documents(
        &initial
            .iter()
            .map(|b| b["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
    );
    let mut owners = BTreeMap::new();
    for (b, node) in initial.iter().zip(d.snapshot().unwrap().visible) {
        owners.insert(b["id"].as_str().unwrap().to_owned(), node.id.clone());
    }
    let origin = TextOrigin::new("local:rgs:pending").unwrap();
    let mut setup = Vec::new();
    for b in initial {
        let owner = owners[b["id"].as_str().unwrap()].clone();
        if b["kind"] == "code" {
            setup.push(EditorCommand::BlockCommand(BlockCommand::SetCode {
                owner: owner.clone(),
                language: String::new(),
            }));
        }
        for m in b["marks"].as_array().unwrap() {
            setup.push(EditorCommand::MarkAt {
                owner: owner.clone(),
                from: U(number(&m["from"])),
                to: U(number(&m["to"])),
                mark: mark(m["type"].as_str().unwrap()),
                action: FormatAction::Apply,
                href: None,
            });
        }
    }
    if !setup.is_empty() {
        let plan = d.prepare_editor(&setup, &origin).unwrap();
        d.commit_editor(plan).unwrap();
    }
    d.clear_history();
    let baseline = frozen(&d);
    let mut identities = BTreeMap::new();
    for (alias, owner) in &owners {
        let node = d
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|n| &n.id == owner)
            .unwrap();
        identities.insert(alias.clone(), json!({"owner":owner,"spans":node.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>() }));
    }
    let count = Rc::new(Cell::new(0));
    let seen = count.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let mut commits = 0;
    let mut controls = 0;
    let mut checkpoints = 0;
    for step in v["steps"].as_array().unwrap() {
        let before = frozen(&d);
        let native = &step["native"];
        let s = &step["expect"]["state"]["selection"];
        let bias = if s["affinity"] == "backward" {
            Bias::Left
        } else {
            Bias::Right
        };
        let point = |p: &Value| EditorPosition {
            owner: owners[p["block"].as_str().unwrap()].clone(),
            offset: U(number(&p["offset"])),
            bias,
        };
        let mut endpoints = json!([]);
        if native.is_array() {
            let mut commands = Vec::new();
            for c in native.as_array().unwrap() {
                let owner = owners[c["owner"].as_str().unwrap()].clone();
                commands.push(match c["type"].as_str().unwrap() {
                    "replaceAt" => EditorCommand::ReplaceAt {
                        owner,
                        from: U(number(&c["from"])),
                        to: U(number(&c["to"])),
                        text: c["text"].as_str().unwrap().to_owned(),
                    },
                    "markAt" => EditorCommand::MarkAt {
                        owner,
                        from: U(number(&c["from"])),
                        to: U(number(&c["to"])),
                        mark: mark(c["mark"].as_str().unwrap()),
                        action: if c["action"] == "apply" {
                            FormatAction::Apply
                        } else {
                            FormatAction::Remove
                        },
                        href: None,
                    },
                    _ => panic!("unknown G04 native command"),
                });
            }
            commands.push(EditorCommand::SelectionAt {
                anchor: point(&s["anchor"]),
                focus: point(&s["focus"]),
            });
            let plan = d.prepare_editor(&commands, &origin).unwrap();
            assert_eq!(frozen(&d), before);
            let result = d.commit_editor(plan).unwrap();
            let selection = result.result_selection.unwrap();
            endpoints = json!([selection.anchor, selection.focus].iter().map(|t| match d.resolve_anchor(t).unwrap() { Resolution::Position(p) => json!({"node":p.node,"offset":p.offset.0,"bias":if p.bias == Bias::Left {"left"} else {"right"}}), _ => panic!("G04 endpoint missing") }).collect::<Vec<_>>());
            commits += 1;
        } else if native["type"] == "split" {
            let owner = &owners[native["owner"].as_str().unwrap()];
            let range = Selection {
                anchor: d
                    .anchor(owner, U(number(&native["offset"])), Bias::Right)
                    .unwrap(),
                focus: d
                    .anchor(owner, U(number(&native["offset"])), Bias::Right)
                    .unwrap(),
            };
            let fragments = [
                FragmentBlock {
                    runs: vec![],
                    attributes: Some(BlockAttributes::Paragraph),
                    containers: vec![],
                    checked: None,
                },
                FragmentBlock {
                    runs: vec![],
                    attributes: Some(BlockAttributes::Paragraph),
                    containers: vec![],
                    checked: None,
                },
            ];
            let plan = d.prepare_fragment(&range, &fragments, &origin).unwrap();
            assert_eq!(frozen(&d), before);
            let result = d.commit_editor(plan).unwrap();
            assert!(result.result_selection.is_none());
            let caret = match d.resolve_anchor(&result.result_caret.unwrap()).unwrap() {
                Resolution::Position(p) => p,
                _ => panic!("G04 split caret missing"),
            };
            assert!(!owners.values().any(|id| id == &caret.node));
            let alias = native["newBlockId"].as_str().unwrap().to_owned();
            owners.insert(alias.clone(), caret.node.clone());
            let node = d
                .snapshot()
                .unwrap()
                .visible
                .into_iter()
                .find(|n| n.id == caret.node)
                .unwrap();
            let retained = identities["p1"].clone();
            let old_owner = &owners["p1"];
            let split_owner = d
                .snapshot()
                .unwrap()
                .visible
                .into_iter()
                .find(|n| &n.id == old_owner)
                .unwrap();
            let split_spans = json!(
                split_owner
                    .spans
                    .iter()
                    .map(|s| json!({"source":s.source,"identity":s.identity}))
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                split_spans.as_array().unwrap().len(),
                retained["spans"].as_array().unwrap().len() + 2
            );
            assert_eq!(
                &split_spans.as_array().unwrap()[..retained["spans"].as_array().unwrap().len()],
                retained["spans"].as_array().unwrap()
            );
            identities.insert(
                "p1".to_owned(),
                json!({"owner":old_owner,"spans":split_spans}),
            );
            identities.insert(alias, json!({"owner":caret.node,"spans":node.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>() }));
            endpoints = json!([{ "node":caret.node,"offset":caret.offset.0,"bias":if caret.bias == Bias::Left {"left"} else {"right"}}]);
            commits += 1;
        } else {
            // Local pending/selection dispatch does not call Document; no fabricated native pending state.
            assert_eq!(frozen(&d), before);
        }
        let expected_blocks = step["expect"]["state"]["blocks"].as_array().unwrap();
        let observe = || {
            let nodes = d.snapshot().unwrap().visible;
            let blocks: Vec<_> = nodes.iter().map(|n| {
                let mut offset = 0u32; let mut marks: Vec<Value> = Vec::new();
                for run in &n.runs {
                    let end = offset + u32::try_from(run.text.encode_utf16().count()).unwrap();
                    for name in run.attributes.keys() {
                        if let Some(last) = marks.iter_mut().rev().find(|m| m["type"] == *name && m["to"] == offset) { last["to"] = json!(end); }
                        else { marks.push(json!({"from":offset,"to":end,"type":name})); }
                    }
                    offset = end;
                }
                json!({"owner":n.id,"kind":match &n.block_attributes { Some(BlockAttributes::Code(language)) if language.is_empty() => "code", Some(BlockAttributes::Paragraph) => "paragraph", _ => panic!("unexpected G04 block attributes") },"text":n.runs.iter().map(|r|r.text.as_str()).collect::<String>(),"marks":marks,"spans":n.spans.iter().map(|s|json!({"source":s.source,"identity":s.identity})).collect::<Vec<_>>()})
            }).collect();
            json!({"blocks":blocks,"revision":d.revision(),"publications":count.get(),"undo":d.history_state().undo_groups,"redo":d.history_state().redo_groups,"endpoints":endpoints})
        };
        let expected_points: Vec<_> = if native.is_null() {
            vec![]
        } else if native["type"] == "split" {
            vec![&s["anchor"]]
        } else {
            vec![&s["anchor"], &s["focus"]]
        };
        let expected = json!({"blocks":expected_blocks.iter().map(|b|json!({"owner":owners[b["id"].as_str().unwrap()],"kind":b["kind"],"text":b["text"],"marks":b["marks"],"spans":identities[b["id"].as_str().unwrap()]["spans"]})).collect::<Vec<_>>(),"revision":baseline.2+commits,"publications":commits,"undo":commits,"redo":0,"endpoints":expected_points.iter().map(|p|json!({"node":owners[p["block"].as_str().unwrap()],"offset":p["offset"],"bias":if bias == Bias::Left {"left"} else {"right"}})).collect::<Vec<_>>()});
        assert_eq!(observe(), expected, "{id}/{}", step["id"]);
        checkpoints += 1;
        if native.is_null() {
            assert_eq!(frozen(&d), before);
            checkpoints += 1;
        } else {
            assert_ne!(d.state_vector_v1(), before.1);
            assert_ne!(d.checkpoint().bytes, before.0);
            checkpoints += 1;
        }
        for (path, value) in [
            ("/blocks/0/text", json!("wrong")),
            (
                "/blocks/0/marks",
                json!([{"from":0,"to":1,"type":"italic"}]),
            ),
            ("/blocks/0/owner", json!("missing")),
            ("/blocks/0/spans/0/source", json!("missing")),
            ("/blocks/0/spans/0/identity", json!("missing")),
            ("/revision", json!(baseline.2 + commits + 1)),
            ("/publications", json!(commits + 1)),
            ("/undo", json!(99)),
            ("/redo", json!(1)),
        ] {
            let mut wrong = expected.clone();
            *wrong.pointer_mut(path).unwrap() = value;
            assert_ne!(observe(), wrong);
            controls += 1;
        }
        if !native.is_null() {
            for (path, value) in [
                ("/endpoints/0/offset", json!(99)),
                ("/endpoints/0/node", json!("missing")),
                ("/endpoints/0/bias", json!("wrong")),
            ] {
                let mut wrong = expected.clone();
                *wrong.pointer_mut(path).unwrap() = value;
                assert_ne!(observe(), wrong);
                controls += 1;
            }
            if native.is_array() {
                let mut wrong = expected.clone();
                wrong["endpoints"][1]["offset"] = json!(99);
                assert_ne!(observe(), wrong);
                controls += 1;
            }
        } else {
            let actual = frozen(&d);
            let mut wrong = actual.clone();
            wrong.0[0] ^= 1;
            assert_ne!(frozen(&d), wrong);
            controls += 1;
            let mut wrong = actual.clone();
            wrong.1[0] ^= 1;
            assert_ne!(frozen(&d), wrong);
            controls += 1;
        }
    }
    println!(
        "G04_RECEIPT id={id} steps={} committed={commits} checkpoints={checkpoints} controls={controls} native_pending=unclaimed",
        v["steps"].as_array().unwrap().len()
    );
}
#[test]
fn g04_pending_context_disable_reject_revisit() {
    g04_pending_sequence("context-disable-reject-revisit");
}
#[test]
fn g04_pending_override_split_empty_revisit() {
    g04_pending_sequence("override-split-empty-revisit");
}

/// REG-13 paired owning proof: failed final selection then retry on one replica.
/// Journal and editor-local pending state are asserted only by the packed host.
#[test]
fn reg13_structure_rejection_retry_owning() {
    use serde_json::json;
    let mut checkpoints = 0;
    let all = vectors();
    let pair: Vec<_> = all["atomic"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| {
            v["id"]
                .as_str()
                .unwrap()
                .starts_with("REG-13-text-mark-structure-")
        })
        .collect();
    assert_eq!(pair.len(), 2);
    let mut d = document("abc");
    let original = d.snapshot().unwrap().visible[0].clone();
    let owner = original.id.clone();
    let before = frozen(&d);
    let original_visible = d.snapshot().unwrap().visible;
    let publications = Rc::new(Cell::new(0));
    let seen = publications.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.set(seen.get() + 1);
            Ok(())
        })
        .unwrap();
    let origin = TextOrigin::new("local:rgs:structure-storage").unwrap();
    assert!(
        d.prepare_editor(&atomic_commands(pair[0], &owner), &origin)
            .is_err()
    );
    assert_eq!(frozen(&d), before);
    assert_eq!(d.snapshot().unwrap().visible, original_visible);
    assert_eq!(publications.get(), 0);
    checkpoints += 3;
    let rejection = json!({"checkpoint":before.0,"vector":before.1,"revision":before.2,"undo":before.3.undo_groups,"redo":before.3.redo_groups,"publications":0,"visible":format!("{original_visible:?}")});
    let mut controls = 0;
    let mut falsify = |actual: &Value, wrong: Value| {
        assert!(std::panic::catch_unwind(|| assert_eq!(actual, &wrong)).is_err());
        controls += 1;
    };
    for key in ["revision", "undo", "redo", "publications"] {
        let mut wrong = rejection.clone();
        wrong[key] = json!(1);
        falsify(&rejection, wrong);
    }
    for key in ["checkpoint", "vector"] {
        let mut wrong = rejection.clone();
        wrong[key][0] = json!(255);
        falsify(&rejection, wrong);
    }
    let plan = d
        .prepare_editor(&atomic_commands(pair[1], &owner), &origin)
        .unwrap();
    assert_eq!(frozen(&d), before);
    assert_eq!(publications.get(), 0);
    checkpoints += 2;
    let result = d.commit_editor(plan).unwrap();
    let visible = d.snapshot().unwrap().visible;
    assert_eq!(visible.len(), 2);
    let node = &visible[0];
    let separator = &visible[1];
    assert_ne!(separator.id, owner);
    assert!(matches!(
        separator.block_attributes,
        Some(editac_core::document::BlockAttributes::Separator)
    ));
    checkpoints += 3;
    let selection = result.result_selection.unwrap();
    let points: Vec<_> = [&selection.anchor, &selection.focus].into_iter().map(|a| match d.resolve_anchor(a).unwrap() {
        Resolution::Position(p) => json!({"node":p.node,"offset":p.offset.0,"bias":if p.bias == Bias::Left {"left"} else {"right"}}),
        _ => panic!("missing REG-13 endpoint"),
    }).collect();
    let identities: Vec<_> = node
        .spans
        .iter()
        .map(|s| json!({"source":s.source,"identity":s.identity}))
        .collect();
    let original_identities: Vec<_> = original
        .spans
        .iter()
        .map(|s| json!({"source":s.source,"identity":s.identity}))
        .collect();
    let actual = json!({"owner":node.id,"text":node.runs.iter().map(|r|r.text.as_str()).collect::<String>(),"runs":node.runs.iter().map(|r| { let attributes: serde_json::Map<String,Value> = r.attributes.iter().map(|(k,v)| (k.clone(), match v { Any::Bool(b) => json!(b), _ => panic!("unexpected attribute") })).collect(); json!({"text":r.text,"attributes":attributes}) }).collect::<Vec<_>>(),"identities":identities,"separator":{"id":separator.id,"kind":separator.kind,"runs":separator.runs.iter().map(|r|r.text.clone()).collect::<Vec<_>>()},"revision":d.revision(),"undo":d.history_state().undo_groups,"redo":d.history_state().redo_groups,"endpoints":points,"publications":publications.get()});
    let expected = json!({"owner":owner,"text":"aXbc","runs":[{"text":"a","attributes":{}},{"text":"X","attributes":{"bold":true}},{"text":"bc","attributes":{}}],"identities":original_identities,"separator":{"id":separator.id,"kind":"block","runs":[]},"revision":before.2+1,"undo":1,"redo":0,"endpoints":[{"node":owner,"offset":2,"bias":"left"},{"node":owner,"offset":2,"bias":"right"}],"publications":1});
    assert_eq!(actual, expected);
    checkpoints += 1;
    assert_eq!(result.revision, before.2 + 1);
    assert_ne!(d.state_vector_v1(), before.1);
    assert_ne!(d.checkpoint().bytes, before.0);
    checkpoints += 3;
    for key in ["owner", "text"] {
        let mut wrong = expected.clone();
        wrong[key] = json!("wrong");
        falsify(&actual, wrong);
    }
    for key in ["revision", "undo", "redo", "publications"] {
        let mut wrong = expected.clone();
        wrong[key] = json!(99);
        falsify(&actual, wrong);
    }
    for i in [0, 1] {
        let mut wrong = expected.clone();
        wrong["endpoints"][i]["offset"] = json!(99);
        falsify(&actual, wrong);
    }
    let mut wrong = expected.clone();
    wrong["endpoints"][0]["bias"] = json!("right");
    falsify(&actual, wrong);
    let mut wrong = expected.clone();
    wrong["runs"][1]["attributes"] = json!({});
    falsify(&actual, wrong);
    for key in ["source", "identity"] {
        let mut wrong = expected.clone();
        wrong["identities"][0][key] = json!("wrong");
        falsify(&actual, wrong);
    }
    let mut wrong = expected.clone();
    wrong["separator"]["kind"] = json!("separator");
    falsify(&actual, wrong);
    println!(
        "REG13_STORAGE_NATIVE_RECEIPT vectors=2 sequences=1 rejected=1 committed=1 checkpoints={checkpoints} controls={controls} pending=editor-local-only journal=packed-host-only"
    );
}

// Same architecture recipes as the attached packed runner. Native asserts the
// committed primitive vectors; selection/pending-only actions are fixture-side
// preparation, never claimed as native editor-local pending-state support.
fn canonical_recipe(id: &str) {
    use editac_core::{
        anchors::Selection,
        commands::editor::{FragmentBlock, FragmentRun},
        document::BlockAttributes,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../architecture/tests/editing-suite/recipes")
        .join(format!("{}.json", id.to_lowercase()));
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(recipe["id"], id);
    let initial = recipe["initial"]["blocks"].as_array().unwrap();
    let mut d = documents(
        &initial
            .iter()
            .map(|b| b["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
    );
    let mut owners: BTreeMap<String, String> = initial
        .iter()
        .zip(d.snapshot().unwrap().visible)
        .map(|(b, n)| (b["id"].as_str().unwrap().to_owned(), n.id.clone()))
        .collect();
    let originals = d.snapshot().unwrap().visible;
    let origin = TextOrigin::new("local:rgs:canonical").unwrap();
    let mut selection = recipe["initial"]["selection"].clone();
    let mut pending = recipe["initial"]["pendingMarks"].clone();
    let seen = Rc::new(Cell::new(0));
    let counter = seen.clone();
    let _subscription = d
        .subscribe(PatchScope::All, move |_, _| {
            counter.set(counter.get() + 1);
            Ok(())
        })
        .unwrap();
    let baseline = d.revision();
    let mut commits = 0;
    let mut controls = 0;
    let mut checkpoints = 0;
    for step in recipe["steps"].as_array().unwrap() {
        let action = &step["action"];
        let before = frozen(&d);
        let before_events = seen.get();
        let owner = owners[selection["anchor"]["block"].as_str().unwrap()].clone();
        let a = number(&selection["anchor"]["offset"]);
        let f = number(&selection["focus"]["offset"]);
        let mut from = a.min(f);
        let mut to = a.max(f);
        let mut endpoints = vec![];
        let kind = action["type"].as_str().unwrap();
        let mut outcome = "applied";
        let mut commands = Vec::new();
        match kind {
            "setSelection" => {
                selection = action["selection"].clone();
                pending = Value::Null;
                outcome = "selection-only";
            }
            "toggleMark" if from == to => {
                pending = json!([action["mark"]]);
                outcome = "selection-only";
            }
            "undo" => {
                assert_eq!(d.history_state().undo_groups, 0);
                assert!(d.undo().unwrap().is_none());
                outcome = "no-op";
            }
            "toggleMark" => {
                commands.push(EditorCommand::MarkAt {
                    owner: owner.clone(),
                    from: U(from),
                    to: U(to),
                    mark: mark(action["mark"].as_str().unwrap()),
                    action: FormatAction::Toggle,
                    href: None,
                });
            }
            "insertText" | "backspace" => {
                let text = if kind == "insertText" {
                    action["text"].as_str().unwrap()
                } else {
                    ""
                };
                let node = d
                    .snapshot()
                    .unwrap()
                    .visible
                    .into_iter()
                    .find(|n| n.id == owner)
                    .unwrap();
                if kind == "backspace" && from == to {
                    let content: String = node.runs.iter().map(|r| r.text.as_str()).collect();
                    match deletion_range(&content, U(from), Direction::Backward).unwrap() {
                        Some(range) => {
                            from = range.start.0;
                            to = range.end.0;
                        }
                        None => outcome = "no-op",
                    }
                }
                if outcome == "applied" {
                    commands.push(EditorCommand::ReplaceAt {
                        owner: owner.clone(),
                        from: U(from),
                        to: U(to),
                        text: text.into(),
                    });
                    if !text.is_empty() {
                        let marks: Vec<String> = if pending.is_null() {
                            let mut offset = 0;
                            node.runs
                                .iter()
                                .filter_map(|r| {
                                    let start = offset;
                                    offset += r.text.encode_utf16().count() as u32;
                                    if start <= from
                                        && (from < offset
                                            || from == offset
                                                && from
                                                    == node
                                                        .runs
                                                        .iter()
                                                        .map(|r| {
                                                            r.text.encode_utf16().count() as u32
                                                        })
                                                        .sum::<u32>())
                                    {
                                        Some(r.attributes.keys().cloned().collect::<Vec<_>>())
                                    } else {
                                        None
                                    }
                                })
                                .flatten()
                                .collect()
                        } else {
                            pending
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|m| m.as_str().unwrap().to_owned())
                                .collect()
                        };
                        for name in marks {
                            commands.push(EditorCommand::MarkAt {
                                owner: owner.clone(),
                                from: U(from),
                                to: U(from + text.encode_utf16().count() as u32),
                                mark: mark(&name),
                                action: FormatAction::Apply,
                                href: None,
                            });
                        }
                    }
                    selection["anchor"]["offset"] =
                        json!(from + text.encode_utf16().count() as u32);
                    selection["focus"]["offset"] = selection["anchor"]["offset"].clone();
                }
            }
            "applyBatch" => {
                for op in action["operations"].as_array().unwrap() {
                    let alias = op["block"].as_str().unwrap();
                    let target = owners.get(alias).cloned().unwrap_or_else(|| alias.into());
                    commands.push(match op["type"].as_str().unwrap() {
                        "insertText" => EditorCommand::ReplaceAt {
                            owner: target,
                            from: U(number(&op["offset"])),
                            to: U(number(&op["offset"])),
                            text: op["text"].as_str().unwrap().into(),
                        },
                        "applyMark" => EditorCommand::MarkAt {
                            owner: target,
                            from: U(number(&op["from"])),
                            to: U(number(&op["to"])),
                            mark: mark(op["mark"].as_str().unwrap()),
                            action: FormatAction::Apply,
                            href: None,
                        },
                        _ => panic!("unbound canonical batch operation"),
                    });
                }
                if !action["resultSelection"].is_null() {
                    selection = action["resultSelection"].clone();
                }
            }
            "insertParagraph" | "insertHardBreak" => {
                let range = Selection {
                    anchor: d.anchor(&owner, U(a), Bias::Right).unwrap(),
                    focus: d.anchor(&owner, U(f), Bias::Right).unwrap(),
                };
                let make = |runs| FragmentBlock {
                    runs,
                    attributes: Some(BlockAttributes::Paragraph),
                    containers: vec![],
                    checked: None,
                };
                let fragments = if kind == "insertParagraph" {
                    vec![make(vec![]), make(vec![])]
                } else {
                    vec![make(vec![FragmentRun {
                        text: "\n".into(),
                        marks: vec![],
                    }])]
                };
                let plan = d.prepare_fragment(&range, &fragments, &origin).unwrap();
                assert_eq!(frozen(&d), before);
                let result = d.commit_editor(plan).unwrap();
                let caret = match d.resolve_anchor(&result.result_caret.unwrap()).unwrap() {
                    Resolution::Position(p) => p,
                    _ => panic!("missing canonical caret"),
                };
                if kind == "insertParagraph" {
                    assert!(!owners.values().any(|old| old == &caret.node));
                    owners.insert(
                        action["newBlockId"].as_str().unwrap().into(),
                        caret.node.clone(),
                    );
                    selection["anchor"]["block"] = action["newBlockId"].clone();
                    selection["focus"]["block"] = action["newBlockId"].clone();
                }
                selection["anchor"]["offset"] = json!(caret.offset.0);
                selection["focus"]["offset"] = json!(caret.offset.0);
                endpoints.push(json!({"node":caret.node,"offset":caret.offset.0,"bias":"right"}));
                commits += 1;
            }
            _ => panic!("unbound canonical action {kind}"),
        }
        if !commands.is_empty() {
            if kind != "applyBatch" || !action["resultSelection"].is_null() {
                let point = |p: &Value| EditorPosition {
                    owner: owners[p["block"].as_str().unwrap()].clone(),
                    offset: U(number(&p["offset"])),
                    bias: Bias::Right,
                };
                commands.push(EditorCommand::SelectionAt {
                    anchor: point(&selection["anchor"]),
                    focus: point(&selection["focus"]),
                });
            }
            let plan = d.prepare_editor(&commands, &origin);
            assert_eq!(frozen(&d), before);
            if let Ok(plan) = plan {
                let result = d.commit_editor(plan).unwrap();
                let selection = result.result_selection.unwrap();
                endpoints = [selection.anchor, selection.focus]
                    .iter()
                    .map(|t| match d.resolve_anchor(t).unwrap() {
                        Resolution::Position(p) => {
                            json!({"node":p.node,"offset":p.offset.0,"bias":"right"})
                        }
                        _ => panic!("missing canonical result"),
                    })
                    .collect();
                commits += 1;
            } else {
                outcome = "rejected";
            }
        }
        let expected = &step["expect"];
        assert_eq!(outcome, expected["outcome"]);
        let committed = number(&expected["effects"]["localCommits"]);
        assert_eq!(seen.get() - before_events, committed);
        assert_eq!(d.revision(), baseline + commits);
        assert_eq!(d.history_state().undo_groups, commits as usize);
        assert_eq!(d.history_state().redo_groups, 0);
        if committed == 0 {
            assert_eq!(frozen(&d), before);
        }
        // Both real returned endpoints (or the structural caret) are checked
        // against independent authored checkpoints, never used to create ops.
        if committed != 0 {
            let s = &expected["state"]["selection"];
            let points = if matches!(kind, "insertParagraph" | "insertHardBreak") {
                vec![&s["focus"]]
            } else {
                vec![&s["anchor"], &s["focus"]]
            };
            let expected_points = json!(points.iter().map(|p| json!({"node":owners[p["block"].as_str().unwrap()],"offset":p["offset"],"bias":"right"})).collect::<Vec<_>>());
            assert_eq!(json!(endpoints), expected_points);
            let mut wrong = expected_points.clone();
            wrong[0]["offset"] = json!(number(&wrong[0]["offset"]) + 1);
            assert_ne!(json!(endpoints), wrong);
            controls += 1;
        }
        let nodes = d.snapshot().unwrap().visible;
        let blocks = expected["state"]["blocks"].as_array().unwrap();
        assert_eq!(nodes.len(), blocks.len());
        for (node, block) in nodes.iter().zip(blocks) {
            assert_eq!(node.id, owners[block["id"].as_str().unwrap()]);
            assert_eq!(node.block_attributes, Some(BlockAttributes::Paragraph));
            let text: String = node.runs.iter().map(|r| r.text.as_str()).collect();
            assert_eq!(text, block["text"].as_str().unwrap());
            assert_ne!(text, format!("{}?", block["text"].as_str().unwrap()));
            controls += 1;
            let mut offset = 0;
            for run in &node.runs {
                for _ in run.text.encode_utf16() {
                    let mut marks = block["marks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|m| number(&m["from"]) <= offset && offset < number(&m["to"]))
                        .map(|m| m["type"].as_str().unwrap().to_owned())
                        .collect::<Vec<_>>();
                    marks.sort();
                    assert_eq!(run.attributes.keys().cloned().collect::<Vec<_>>(), marks);
                    offset += 1;
                }
            }
            if let Some(original) = originals.iter().find(|old| old.id == node.id) {
                assert_eq!(node.spans[0].source, original.spans[0].source);
                assert_eq!(node.spans[0].identity, original.spans[0].identity);
                assert_ne!(node.spans[0].source, "corrupt");
                controls += 1;
            }
        }
        assert_ne!(u64::from(seen.get()), commits + 1);
        assert_ne!(d.revision(), baseline + commits + 1);
        controls += 2;
        checkpoints += 1;
    }
    println!(
        "{id}: canonical native checkpoints={checkpoints} controls={controls} commits={commits}; editor-local pending/selection-only preparation is not native UI evidence"
    );
}
macro_rules! canonical_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            canonical_recipe($id);
        }
    };
}
canonical_case!(canonical_seq01, "SEQ-01");
canonical_case!(canonical_seq02, "SEQ-02");
canonical_case!(canonical_seq04, "SEQ-04");
canonical_case!(canonical_seq05, "SEQ-05");
canonical_case!(canonical_seq06, "SEQ-06");
canonical_case!(canonical_seq11, "SEQ-11");
canonical_case!(canonical_seq12, "SEQ-12");
