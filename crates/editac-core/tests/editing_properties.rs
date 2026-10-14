//! RGS-1.5: bounded production conversion properties, not a synthetic normalizer.
use editac_core::{
    document::{BlockAttributes, Document},
    import::tiptap::{
        MAX_INPUT_BYTES, MigrationError, PreparedMigration, SourceSession, prepare_json,
    },
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
const NEW_EPOCH: &str = "a6100000-0000-4000-8000-000000000002";
fn profile() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/property-profile.json"
    ))
    .unwrap()
}
fn source() -> SourceSession {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    SourceSession {
        document_id: format!(
            "a5100000-0000-4000-8000-{:012}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        epoch: "a6100000-0000-4000-8000-000000000001".into(),
    }
}
fn prepare(v: &Value) -> PreparedMigration {
    prepare_json(&v.to_string(), 1, source()).unwrap()
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
// Fixture adapter for the declared canonical paragraph/code profile. It rejects
// unrepresented tuples/marks instead of silently flattening them.
fn canonical_input(p: &PreparedMigration) -> Value {
    json!({"type":"doc","content":p.semantic_blocks().iter().map(|b| {
        assert!(b.containers.is_empty()); assert!(b.checked.is_none());
        let (kind,attrs)=match &b.attributes {
            Some(BlockAttributes::Code(language)) => ("codeBlock",json!({"language":language})),
            Some(BlockAttributes::Paragraph) => ("paragraph",json!({})),
            _ => panic!("unsupported canonical fixture projection"),
        };
        json!({"type":kind,"attrs":attrs,"content":b.runs.iter().map(|r| {
            assert!(r.marks.is_empty(),"canonical code profile omits marks");
            json!({"type":"text","text":r.text})
        }).collect::<Vec<_>>()})
    }).collect::<Vec<_>>()})
}
fn guard(p: &PreparedMigration, text: &str, diagnostic_count: usize) -> Result<(), &'static str> {
    if p.semantic_blocks()
        .iter()
        .flat_map(|b| &b.runs)
        .map(|r| r.text.as_str())
        .collect::<String>()
        != text
    {
        return Err("content");
    }
    if p.diagnostics().len() != diagnostic_count {
        return Err("diagnostics");
    }
    if p.semantic_blocks()
        .iter()
        .flat_map(|b| &b.runs)
        .any(|r| !r.marks.is_empty())
    {
        return Err("marks");
    }
    Ok(())
}
fn report(case: &str, samples: usize, max: usize) {
    println!(
        "RGS_PROPERTY {}",
        json!({"case":case,"samples":samples,"maxInputBytes":max,"converter":1,"profile":"rgs-properties-v1","passed":true})
    );
}

#[test]
fn reg08_g10_interacting_repairs_reach_independent_canonical_fixed_point() {
    let p = profile();
    let mut max = 0;
    for seed in p["seeds"].as_array().unwrap() {
        let vector = p["vectors"][(seed.as_u64().unwrap() as usize) % 9]
            .as_str()
            .unwrap();
        let text = format!("prefix {vector} suffix  ");
        // Unsafe link omission interacts with code-block mark omission. Unknown
        // attributes are diagnosed separately, with exact original recovery input.
        let malformed = json!({"type":"doc","content":[{"type":"codeBlock","attrs":{"language":"rust","future":{"seed":seed}},"content":[{"type":"text","text":text,"marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}},{"type":"bold"}]}]}]});
        let input = malformed.to_string();
        max = max.max(input.len());
        let first = prepare(&malformed);
        assert_eq!(first.original_json(), input);
        assert_eq!(first.diagnostics().len(), 3);
        for reason in [
            "unsupported attribute",
            "unsafe link omitted",
            "code block mark omitted",
        ] {
            assert!(first.diagnostics().iter().any(|d| d.reason == reason));
        }
        let block = &first.semantic_blocks()[0];
        assert_eq!(block.attributes, Some(BlockAttributes::Code("rust".into())));
        assert_eq!(block.runs.len(), 1);
        assert_eq!(block.runs[0].text, text);
        assert!(block.runs[0].marks.is_empty());
        // Independently authored canonical input, never generated from engine output.
        let canonical = json!({"type":"doc","content":[{"type":"codeBlock","attrs":{"language":"rust"},"content":[{"type":"text","text":text}]}]});
        assert_eq!(canonical_input(&first), canonical);
        let second = prepare(&canonical_input(&first));
        let third = prepare(&canonical_input(&second));
        assert_eq!(guard(&first, &text, 3), Ok(()));
        assert_eq!(guard(&second, &text, 0), Ok(()));
        assert!(second.diagnostics().is_empty());
        assert!(third.diagnostics().is_empty());
        assert_eq!(
            format!("{:?}", first.semantic_blocks()),
            format!("{:?}", second.semantic_blocks())
        );
        assert_eq!(
            format!("{:?}", second.semantic_blocks()),
            format!("{:?}", third.semantic_blocks())
        );
        let d = first.start_session(NEW_EPOCH).unwrap();
        let before = d.snapshot().unwrap();
        let checkpoint = d.checkpoint();
        let revision = d.revision();
        assert_eq!(texts(&d), [text]);
        // Pure normalization has no receiver/transaction; an admitted document
        // remains byte-for-byte stable while its canonical input is normalized.
        for _ in 0..3 {
            let again = prepare(&canonical);
            assert!(again.diagnostics().is_empty());
        }
        assert_eq!(d.snapshot().unwrap().visible, before.visible);
        assert_eq!(d.revision(), revision);
        assert_eq!(d.checkpoint().bytes, checkpoint.bytes);
        let restored = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
        assert_eq!(restored.snapshot().unwrap().visible, before.visible);
        // Corrupting the expected retained content/marks must fail this oracle.
        assert_ne!(block.runs[0].text, format!("{vector} suffix"));
        assert_ne!(first.diagnostics().len(), 0);
    }
    report("REG-08/G10/interacting-code-link-repairs", 8, max);
}

#[test]
fn g10_unknown_tuple_and_recovery_source_survive_admission_and_restore() {
    let p = profile();
    let mut max = 0;
    for seed in p["seeds"].as_array().unwrap() {
        let input = json!({"type":"doc","content":[{"type":"futureWidget","attrs":{"seed":seed,"payload":"😀".repeat(1100)}}]});
        let raw = input.to_string();
        max = max.max(raw.len());
        let prepared = prepare(&input);
        assert_eq!(prepared.original_json(), raw);
        assert_eq!(prepared.diagnostics().len(), 1);
        let diagnostic = &prepared.diagnostics()[0];
        assert!(diagnostic.truncated);
        assert!(diagnostic.source.len() <= 4096);
        assert!(diagnostic.source.is_char_boundary(diagnostic.source.len()));
        let d = prepared.start_session(NEW_EPOCH).unwrap();
        let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
        let snapshot = restored.snapshot().unwrap();
        let unknown = snapshot
            .visible
            .iter()
            .find(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
            .unwrap();
        assert_eq!(
            unknown
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>(),
            diagnostic.source
        );
        assert_eq!(snapshot.visible, d.snapshot().unwrap().visible);
        let Some(BlockAttributes::Unknown(yrs::Any::Array(tuple))) = &unknown.block_attributes
        else {
            panic!("retained unknown tuple")
        };
        assert_eq!(tuple[0], yrs::Any::from("tiptap.v1"));
        assert_eq!(tuple[1], yrs::Any::from(diagnostic.source.clone()));
        assert_eq!(tuple[2], yrs::Any::Bool(true));
    }
    report("G10/unknown-recovery", 8, max);
}

#[test]
fn g10_resource_limits_are_explicit_and_bounded() {
    let block = json!({"type":"paragraph","content":[]});
    let bytes = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a".repeat(MAX_INPUT_BYTES)}]}]});
    let blocks = json!({"type":"doc","content":vec![block.clone();127]});
    let runs = json!({"type":"doc","content":[{"type":"paragraph","content":vec![json!({"type":"text","text":"x"});1025]}]});
    let mut deep = block.clone();
    for _ in 0..18 {
        deep = json!({"type":"blockquote","content":[deep]});
    }
    let depth = json!({"type":"doc","content":[deep]});
    let mut attrs = serde_json::Map::new();
    for n in 0..257 {
        attrs.insert(format!("future{n}"), json!(n));
    }
    let diagnostics =
        json!({"type":"doc","content":[{"type":"paragraph","attrs":attrs,"content":[]}]});
    let nodes = json!({"type":"doc","content":vec![block;2049]});
    let mut max = 0;
    for (id, v) in [
        ("bytes", bytes),
        ("blocks", blocks),
        ("runs", runs),
        ("depth", depth),
        ("diagnostics", diagnostics),
        ("nodes", nodes),
    ] {
        let raw = v.to_string();
        max = max.max(raw.len());
        assert!(
            matches!(
                prepare_json(&raw, 1, source()),
                Err(MigrationError::ResourceLimit)
            ),
            "{id}"
        );
    }
    report("G10/resource-rejection", 6, max);
}

#[test]
fn admitted_profile_roundtrip_preserves_whitespace_unicode_and_schema() {
    let p = profile();
    for vector in p["vectors"].as_array().unwrap() {
        let text = format!("  {}\t ", vector.as_str().unwrap());
        for kind in ["paragraph", "codeBlock"] {
            let input = json!({"type":"doc","content":[{"type":kind,"content":[{"type":"text","text":text}]}]});
            let prepared = prepare(&input);
            assert!(prepared.diagnostics().is_empty());
            let d = prepared.start_session(NEW_EPOCH).unwrap();
            assert_eq!(texts(&d), [text.clone()]);
            let snapshot = d.snapshot().unwrap();
            let node = snapshot.visible.iter().find(|n| n.kind == "block").unwrap();
            assert_eq!(
                node.block_attributes,
                Some(if kind == "paragraph" {
                    BlockAttributes::Paragraph
                } else {
                    BlockAttributes::Code("".into())
                })
            );
            let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
            assert_eq!(restored.snapshot().unwrap().visible, snapshot.visible);
        }
    }
    report("supported-import-checkpoint-roundtrip", 18, 0);
}

#[test]
fn g10_negative_controls_reject_dropped_content_reintroduced_marks_and_diagnostics() {
    let input = json!({"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"kept suffix","marks":[{"type":"bold"}]}]}]});
    let first = prepare(&input);
    assert_eq!(guard(&first, "kept suffix", 1), Ok(()));
    assert_eq!(guard(&first, "kept", 1), Err("content"));
    assert_eq!(guard(&first, "kept suffix", 0), Err("diagnostics"));
    let mut next = canonical_input(&first);
    next["content"][0]["content"][0]["text"] = json!("oscillated");
    let corrupted = prepare(&next);
    assert_eq!(guard(&corrupted, "kept suffix", 0), Err("content"));
    let marked = prepare(
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"kept suffix","marks":[{"type":"bold"}]}]}]}),
    );
    assert_eq!(guard(&marked, "kept suffix", 0), Err("marks"));
    report(
        "G10/negative-controls-content-diagnostics-fixed-point-marks",
        4,
        0,
    );
}

#[test]
fn scalar_boundary_edits_keep_anchor_source_offsets_valid() {
    use editac_core::{
        Utf16Offset as U,
        anchors::Bias,
        commands::{
            editor::{EditorCommand, EditorPosition},
            format::{FormatAction, Mark},
            text::TextOrigin,
        },
        document::{CreationPermit, DocumentIdentity, InitialNode},
    };
    let src = source();
    let id = DocumentIdentity::v5(src.document_id, src.epoch).unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "".into(),
        }],
    )
    .unwrap();
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let origin = TextOrigin::new("rgs:property").unwrap();
    for (from, to, text, expected) in [(0, 0, "é", "é"), (0, 0, "🇭🇺", "🇭🇺é"), (0, 2, "🇭🇺", "🇭🇺🇺é")]
    {
        let end = expected.encode_utf16().count() as u32;
        let commands = [
            EditorCommand::ReplaceAt {
                owner: owner.clone(),
                from: U(from),
                to: U(to),
                text: text.into(),
            },
            EditorCommand::MarkAt {
                owner: owner.clone(),
                from: U(0),
                to: U(end),
                mark: Mark::Bold,
                action: FormatAction::Apply,
                href: None,
            },
            EditorCommand::SelectionAt {
                anchor: EditorPosition {
                    owner: owner.clone(),
                    offset: U(0),
                    bias: Bias::Right,
                },
                focus: EditorPosition {
                    owner: owner.clone(),
                    offset: U(end),
                    bias: Bias::Right,
                },
            },
        ];
        let plan = d.prepare_editor(&commands, &origin).unwrap_or_else(|e| {
            panic!("from={from} to={to} insert={text:?} expected={expected:?}: {e:?}")
        });
        d.commit_editor(plan).unwrap();
        assert_eq!(texts(&d), [expected]);
        let mut offset = 0;
        for ch in expected.chars().chain(std::iter::once('\0')) {
            for bias in [Bias::Left, Bias::Right] {
                let anchor = d.anchor(&owner, U(offset), bias).unwrap();
                let editac_core::anchors::Resolution::Position(position) =
                    d.resolve_anchor(&anchor).unwrap()
                else {
                    panic!("valid scalar anchor")
                };
                assert_eq!(position.offset, U(offset));
                assert_eq!(position.bias, bias);
            }
            if ch != '\0' && ch.len_utf16() == 2 {
                // Markup never turns a surrogate interior into a valid cut.
                let before = d.checkpoint();
                let revision = d.revision();
                assert!(d.anchor(&owner, U(offset + 1), Bias::Right).is_err());
                assert!(
                    d.prepare_editor(
                        &[EditorCommand::ReplaceAt {
                            owner: owner.clone(),
                            from: U(offset + 1),
                            to: U(offset + 1),
                            text: "lost".into(),
                        }],
                        &origin
                    )
                    .is_err()
                );
                assert_eq!(d.checkpoint().bytes, before.bytes);
                assert_eq!(d.revision(), revision);
            }
            offset += ch.len_utf16() as u32;
        }
    }
    report("UTF16/split-regional-indicator", 3, 0);
}

#[test]
fn g10_bounded_guard_retains_minimal_oscillation_witness() {
    // Every observation uses production import; only the next request is
    // corrupted. Four passes bound both real normalization and this fault.
    fn run(inject: bool) -> Result<(Value, usize), Vec<Value>> {
        let mut input = json!({"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"left","marks":[{"type":"bold"}]}]}]});
        let mut seen = Vec::<Value>::new();
        for pass in 0..4 {
            let canonical = canonical_input(&prepare(&input));
            if !inject && canonical == input {
                return Ok((canonical, pass + 1));
            }
            if let Some(start) = seen.iter().position(|state| state == &canonical) {
                let mut witness = seen[start..].to_vec();
                witness.push(canonical);
                return Err(witness);
            }
            seen.push(canonical.clone());
            input = canonical;
            if inject {
                let text = input["content"][0]["content"][0]["text"].as_str().unwrap();
                input["content"][0]["content"][0]["text"] =
                    json!(if text == "left" { "right" } else { "left" });
            }
        }
        Err(seen)
    }
    let expected = json!({"type":"doc","content":[{"type":"codeBlock","attrs":{"language":""},"content":[{"type":"text","text":"left"}]}]});
    assert_eq!(run(false).unwrap(), (expected, 2));
    let witness = run(true).unwrap_err();
    assert_eq!(witness, run(true).unwrap_err(), "reproducible shrinking");
    let words: Vec<_> = witness
        .iter()
        .map(|v| v["content"][0]["content"][0]["text"].as_str().unwrap())
        .collect();
    assert_eq!(words, ["left", "right", "left"]);
    // Removing any observation loses the closed cycle or its distinct state.
    for removed in 0..words.len() {
        let reduced: Vec<_> = words
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != removed)
            .map(|(_, x)| *x)
            .collect();
        assert!(
            !(reduced.len() >= 3
                && reduced[0] == reduced[reduced.len() - 1]
                && reduced[0] != reduced[1])
        );
    }
    println!(
        "RGS_PROPERTY {}",
        json!({"case":"G10/bounded-oscillation-control", "samples":2,"maxPasses":4,"observedPasses":3,"minimizedTrace":witness,"passed":true})
    );
}
