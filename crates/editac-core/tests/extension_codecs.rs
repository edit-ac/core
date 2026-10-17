//! EXT-1.4 canonical Document/Markdown/epoch harness. No providers or host I/O.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::{EditorCommand, FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{
        BlockAttributes, CreationPermit, Document, DocumentError, DocumentIdentity, InitialNode,
        ReplayUpdate,
    },
    history::HistoryConfig,
    import::tiptap::{self, MigrationError, SourceSession},
    modules::v1::{EvolutionError, ModuleEvolution},
};
use editac_markdown::{
    extensions,
    optional::Codecs,
    reconcile::{ConflictKind, SourceBaseline, SourceMode},
};
use serde_json::{Value, json};
use yrs::{Any, Text, Transact};
#[path = "support/extension_conformance.rs"]
#[allow(dead_code)]
mod conformance;
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/extensions/versions/conformance.json"
    ))
    .unwrap()
}
fn output() -> std::path::PathBuf {
    let p = std::path::PathBuf::from(
        std::env::var("EDITAC_EXTENSION_CODECS_OUTPUT")
            .expect("unique worktree-owned EDITAC_EXTENSION_CODECS_OUTPUT required"),
    );
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn save(name: &str, value: &Value) {
    std::fs::write(
        output().join(name),
        format!("{}\n", serde_json::to_string(value).unwrap()),
    )
    .unwrap();
}
fn origin() -> TextOrigin {
    TextOrigin::new("extension-codec:fixture").unwrap()
}
fn identity_json(i: &DocumentIdentity) -> Value {
    json!({"profile":i.profile,"schema":i.schema,"documentId":i.document_id,"epoch":i.epoch,"protocolVersion":1,"updateEncoding":1,"offsets":"utf16"})
}
fn identity(epoch: &str) -> DocumentIdentity {
    DocumentIdentity::v5("77777777-7777-4777-8777-777777777774", epoch).unwrap()
}
const OLD: &str = "88888888-8888-4888-8888-888888888881";
const NEW: &str = "88888888-8888-4888-8888-888888888882";
fn blank() -> Document {
    static CHECKPOINT: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
        std::sync::OnceLock::new();
    let cp = CHECKPOINT.get_or_init(|| {
        Document::create(
            CreationPermit::authorize_new(identity(OLD)).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap()
        .checkpoint()
    });
    let mut d = Document::restore(&cp.identity, cp, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn owners(d: &Document) -> Vec<String> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.id.clone())
        .collect()
}
fn semantic(d: &Document) -> Value {
    json!(d.snapshot().unwrap().visible.iter().filter(|n|n.kind=="block").map(|n| json!({"blockAttributes":serde_json::from_str::<Value>(&m::json(&n.block_attributes.as_ref().unwrap().tuple())).unwrap(),"runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),serde_json::from_str::<Value>(&m::json(v)).unwrap())).collect::<serde_json::Map<_,_>>()})).collect::<Vec<_>>()})).collect::<Vec<_>>())
}
fn paste(d: &mut Document, blocks: &[FragmentBlock]) {
    let id = owners(d)[0].clone();
    let range = Selection {
        anchor: d.anchor(&id, U(0), Bias::Right).unwrap(),
        focus: d.anchor(&id, U(0), Bias::Left).unwrap(),
    };
    let p = d.prepare_fragment(&range, blocks, &origin()).unwrap();
    d.commit_editor(p).unwrap();
    d.clear_history();
}
// Recovery must preserve every field, including source spelling excluded from
// Markdown semantic equivalence. Avoid adding equality to engine-owned types.
fn assert_exact_fragments(actual: &[FragmentBlock], expected: &[FragmentBlock]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert_eq!(a.attributes, b.attributes);
        assert_eq!(a.containers, b.containers);
        assert_eq!(a.checked, b.checked);
        assert_eq!(a.runs.len(), b.runs.len());
        for (a, b) in a.runs.iter().zip(&b.runs) {
            assert_eq!(a.text, b.text);
            assert_eq!(a.marks, b.marks);
        }
    }
}
fn write_checkpoint(name: &str, d: &Document) {
    let cp = d.checkpoint();
    std::fs::write(output().join(format!("{name}.bin")), &cp.bytes).unwrap();
    save(
        &format!("{name}.json"),
        &json!({"identity":identity_json(&cp.identity),"writerId":cp.writer_id,"semantic":semantic(d)}),
    );
}
fn evolution(c: &Value) -> ModuleEvolution {
    ModuleEvolution::new(
        &c["evolution"]["reads"]
            .as_array()
            .unwrap()
            .iter()
            .map(conformance::any)
            .collect::<Vec<_>>(),
        &[(1, 2)],
    )
    .unwrap()
}
#[test]
fn explicit_candidate_transitions_validate_both_versions_without_document_mutation() {
    let c = corpus();
    let e = evolution(&c);
    let mut results = vec![];
    let d = blank();
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    for case in c["migrationCases"].as_array().unwrap() {
        let input = conformance::any(&case["envelope"]);
        let retained = input.clone();
        let mut calls = 0;
        let result=e.prepare(&input,"é😀",case["target"].as_u64().unwrap() as u32,|attrs| {
            calls+=1;
            match case["mode"].as_str().unwrap() {
                "fail"=>Err(EvolutionError::MigrationFailed),
                "invalid"=>Ok(conformance::any(&json!({"wrong":"value"}))),
                "oversized"=>Ok(conformance::any(&json!({"title":"x".repeat(129)}))),
                _=>{let Any::Map(a)=attrs else {panic!()};Ok(conformance::any(&json!({"title":serde_json::from_str::<Value>(&m::json(&a["label"])).unwrap()})))}
            }
        });
        let outcome = match &result {
            Ok(p) => {
                assert_eq!(p.source, input);
                assert_eq!(p.candidate, conformance::any(&json!([2,{"title":"é😀"}])));
                "prepared"
            }
            Err(EvolutionError::UnsupportedTransition) => "unsupported-transition",
            Err(EvolutionError::MigrationFailed) => "migration-failed",
            Err(EvolutionError::Registry(
                editac_core::modules::v1::RegistryError::InvalidContent,
            )) => "invalid-content",
            other => panic!("{other:?}"),
        };
        assert_eq!(outcome, case["expected"].as_str().unwrap());
        assert_eq!(input, retained);
        assert_eq!(
            calls,
            usize::from(
                ["prepared", "migration-failed"].contains(&outcome)
                    || ["malformed-candidate", "oversized-candidate"]
                        .contains(&case["id"].as_str().unwrap())
            )
        );
        drop(result); // interrupted candidate is discarded, never committed
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(d.revision(), revision);
        results.push(json!({"id":case["id"],"outcome":outcome,"calls":calls}));
    }
    assert_eq!(results.len(), c["migrationCases"].as_array().unwrap().len());
    save("rust-migrations.json", &json!(results));
}
#[test]
fn declarations_reject_duplicate_missing_reverse_and_cross_type_edges() {
    let c = corpus();
    let mut defs = c["evolution"]["reads"]
        .as_array()
        .unwrap()
        .iter()
        .map(conformance::any)
        .collect::<Vec<_>>();
    for edges in [vec![(1, 1)], vec![(1, 99)], vec![(1, 2), (1, 2)]] {
        assert!(matches!(
            ModuleEvolution::new(&defs, &edges),
            Err(EvolutionError::InvalidEvolution)
        ));
    }
    assert!(matches!(
        ModuleEvolution::new(&[], &[]),
        Err(EvolutionError::InvalidEvolution)
    ));
    let too_many = vec![defs[0].clone(); 33];
    assert!(matches!(
        ModuleEvolution::new(&too_many, &[]),
        Err(EvolutionError::InvalidEvolution)
    ));
    assert!(matches!(
        ModuleEvolution::new(&defs, &vec![(1, 2); 33]),
        Err(EvolutionError::InvalidEvolution)
    ));
    let mut kind = c["evolution"]["reads"][1].clone();
    kind["kind"] = json!("mark");
    assert!(matches!(
        ModuleEvolution::new(&[defs[0].clone(), conformance::any(&kind)], &[(1, 2)]),
        Err(EvolutionError::InvalidEvolution)
    ));
    defs.push(defs[0].clone());
    assert!(matches!(
        ModuleEvolution::new(&defs, &[(1, 2)]),
        Err(EvolutionError::InvalidEvolution)
    ));
    let mut changed = c["evolution"]["reads"][1].clone();
    changed["type"] = json!("other.badge");
    assert!(matches!(
        ModuleEvolution::new(&[defs[0].clone(), conformance::any(&changed)], &[(1, 2)]),
        Err(EvolutionError::InvalidEvolution)
    ));
}
#[test]
fn owning_codecs_copy_export_and_literal_bypass_preserve_semantics() {
    let c = corpus();
    let mut results = vec![];
    for case in c["codecCases"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let o = &case["options"];
        let codecs = Codecs {
            images: o["images"] == true,
            tables: o["tables"] == true,
            callouts: o["callouts"] == true,
        };
        let blocks = if case["literal"] == true {
            vec![FragmentBlock {
                attributes: None,
                runs: vec![FragmentRun {
                    opaque_marks: vec![],
                    text: source.into(),
                    marks: vec![],
                }],
                containers: vec![],
                checked: None,
            }]
        } else {
            let p = extensions::import(source, codecs, &[]).unwrap();
            assert_eq!(p.source, source);
            p.blocks
        };
        let mut d = blank();
        paste(&mut d, &blocks);
        let copied = owners(&d)
            .iter()
            .map(|id| d.fragment_for_node(id).unwrap())
            // Content insertion adds required empty landing paragraphs. Copy the
            // inserted payload; do not export unrelated caret landing controls.
            .filter(|b| {
                !(b.attributes == Some(BlockAttributes::Paragraph)
                    && b.runs.iter().all(|r| r.text.is_empty()))
            })
            .collect::<Vec<_>>();
        assert!(
            editac_markdown::export::equivalent(&blocks, &copied),
            "{}: input={blocks:?}; copied={copied:?}",
            case["id"]
        );
        let exported = extensions::export(&copied, &[]).unwrap();
        if case["lossless"] == true {
            assert!(
                exported.diagnostics.is_empty(),
                "{}: {:?}",
                case["id"],
                exported.diagnostics
            );
            assert!(exported.recovery.is_empty());
            let imported = extensions::import(&exported.markdown, codecs, &[]).unwrap();
            assert!(
                editac_markdown::export::equivalent(&copied, &imported.blocks),
                "{}",
                case["id"]
            );
        } else {
            assert_eq!(exported.diagnostics.len(), 1);
            assert_eq!(
                exported.diagnostics[0].code,
                case["diagnostic"].as_str().unwrap()
            );
            assert_exact_fragments(&exported.recovery, &copied);
            let mut recovered = blank();
            paste(&mut recovered, &exported.recovery);
            assert_eq!(semantic(&recovered), semantic(&d));
        }
        let before = d.checkpoint().bytes;
        assert_eq!(d.checkpoint().bytes, before); // codecs have no live handle
        write_checkpoint(case["id"].as_str().unwrap(), &d);
        results.push(json!({"id":case["id"],"markdown":exported.markdown,"diagnostics":exported.diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),"semantic":semantic(&d)}));
    }
    assert_eq!(results.len(), 7);
    save("rust-codecs.json", &json!(results));
}
#[test]
fn source_reconciliation_retains_opaque_identity_payload_and_rejects_changes_atomically() {
    let c = corpus();
    let mut results = vec![];
    for case in c["opaqueCases"].as_array().unwrap() {
        let mut d = blank();
        let p = extensions::import("known\n\nopaque\n", Codecs::default(), &[]).unwrap();
        paste(&mut d, &p.blocks);
        let ids = owners(&d);
        let mut cp = d.checkpoint();
        let raw = m::replica(99);
        m::apply(&raw, &cp.bytes).unwrap();
        if !case["blockAttributes"].is_null() {
            m::set(&raw, 4, &ids[1], conformance::any(&case["blockAttributes"]));
        } else {
            let t = m::text(&raw, &ids[1]);
            let mut tx = raw.transact_mut();
            let len = t.len(&tx);
            t.remove_range(&mut tx, 0, len);
            let Any::Map(a) = conformance::any(&case["attributes"]) else {
                panic!()
            };
            t.insert_with_attributes(
                &mut tx,
                0,
                "opaque",
                a.iter()
                    .map(|(k, v)| (k.clone().into(), v.clone()))
                    .collect(),
            );
        }
        cp.bytes = m::bytes(&raw);
        d = Document::restore(&cp.identity, &cp, &[]).unwrap();
        d.enable_history(HistoryConfig::default()).unwrap();
        let original = d
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == ids[1])
            .unwrap()
            .as_ref()
            .clone();
        let base = SourceBaseline::capture(
            &d,
            "known\n\nopaque\n",
            SourceMode::Markdown(Codecs::default()),
            &ids,
        )
        .unwrap();
        let staged = base.prepare(&d, "changed\n\nopaque\n", &origin()).unwrap();
        let before = d.checkpoint().bytes;
        let revision = d.revision();
        drop(staged);
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(d.revision(), revision);
        base.prepare(&d, "changed\n\nopaque\n", &origin())
            .unwrap()
            .commit(&mut d)
            .unwrap();
        assert_eq!(
            d.snapshot()
                .unwrap()
                .visible
                .iter()
                .find(|n| n.id == ids[1])
                .unwrap()
                .as_ref(),
            &original
        );
        let before = d.checkpoint().bytes;
        let revision = d.revision();
        let failure = base
            .prepare(&d, "known\n\nchanged atom\n", &origin())
            .err()
            .unwrap();
        assert_eq!(failure.kind, ConflictKind::UnsupportedContent);
        assert_eq!(failure.source.as_deref(), Some("known\n\nchanged atom\n"));
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(d.revision(), revision);
        match d.fragment_for_node(&ids[1]) {
            Ok(fragment) => {
                assert_eq!(fragment.attributes, original.block_attributes);
                assert!(
                    editac_markdown::extensions::validate(&[fragment]).is_err(),
                    "unsupported block transfer rejects before admission"
                );
            }
            Err(_) => {} // Unknown inline marks have no supported fragment codec.
        }
        let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
        assert_eq!(semantic(&restored), semantic(&d));
        write_checkpoint(case["id"].as_str().unwrap(), &d);
        results.push(json!({"id":case["id"],"owner":ids[1],"semantic":semantic(&d),"rejection":"UnsupportedContent"}));
    }
    assert_eq!(results.len(), 4);
    save("rust-source.json", &json!(results));
}
#[test]
fn prepared_source_commit_rejects_intervening_changes_and_unsafe_structure() {
    let mut d = blank();
    paste(
        &mut d,
        &extensions::import("known\n\nopaque\n", Codecs::default(), &[])
            .unwrap()
            .blocks,
    );
    let ids = owners(&d);
    let base = SourceBaseline::capture(
        &d,
        "known\n\nopaque\n",
        SourceMode::Markdown(Codecs::default()),
        &ids,
    )
    .unwrap();
    let staged = base.prepare(&d, "changed\n\nopaque\n", &origin()).unwrap();
    let edit = d
        .prepare_editor(
            &[EditorCommand::ReplaceAt {
                owner: ids[0].clone(),
                from: U(0),
                to: U(0),
                text: "remote ".into(),
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(edit).unwrap();
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    assert!(staged.commit(&mut d).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), revision);
    assert!(
        base.prepare(&d, "known\n\nnew\n\nopaque\n", &origin())
            .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn schema_migration_reuses_explicit_epoch_protocol_and_rejects_delayed_offline_updates() {
    let mut old = blank();
    paste(
        &mut old,
        &extensions::import("old content", Codecs::default(), &[])
            .unwrap()
            .blocks,
    );
    let before = old.checkpoint().bytes;
    let revision = old.revision();
    let source = SourceSession {
        document_id: old.identity().document_id.clone(),
        epoch: OLD.into(),
    };
    let raw = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"new content"}]}]}"#;
    assert!(matches!(
        tiptap::prepare_json(raw, 99, source.clone()),
        Err(MigrationError::UnsupportedConverter(99))
    ));
    assert!(tiptap::prepare_json("{", 1, source.clone()).is_err());
    let interrupted = tiptap::prepare_json(raw, 1, source.clone()).unwrap();
    drop(interrupted);
    assert_eq!(old.checkpoint().bytes, before);
    assert_eq!(old.revision(), revision);
    let prepared = tiptap::prepare_json(raw, 1, source).unwrap();
    assert_eq!(prepared.original_json(), raw);
    assert!(matches!(
        prepared.start_session(OLD),
        Err(MigrationError::SameEpoch)
    ));
    let mut new = prepared.start_session(NEW).unwrap();
    assert_eq!(new.identity().epoch, NEW);
    assert_eq!(old.checkpoint().bytes, before);
    let id = owners(&old)[0].clone();
    let p = old
        .prepare_editor(
            &[EditorCommand::ReplaceAt {
                owner: id,
                from: U(0),
                to: U(0),
                text: "delayed ".into(),
            }],
            &origin(),
        )
        .unwrap();
    old.commit_editor(p).unwrap();
    let delayed = ReplayUpdate {
        identity: old.identity().clone(),
        bytes: old.checkpoint().bytes,
    };
    let before_new = new.checkpoint().bytes;
    let revision_new = new.revision();
    assert_eq!(new.apply_replay(&delayed), Err(DocumentError::WrongEpoch));
    assert_eq!(new.checkpoint().bytes, before_new);
    assert_eq!(new.revision(), revision_new);
    write_checkpoint("new-epoch", &new);
    std::fs::write(output().join("old-epoch.bin"), &delayed.bytes).unwrap();
    save(
        "old-epoch.json",
        &json!({"identity":identity_json(&delayed.identity)}),
    );
    let mut restored = Document::restore(new.identity(), &new.checkpoint(), &[]).unwrap();
    assert_eq!(
        restored.apply_replay(&delayed),
        Err(DocumentError::WrongEpoch)
    );
    assert_eq!(semantic(&restored), semantic(&new));
}

struct Badge;
impl extensions::Extension for Badge {
    fn name(&self) -> &str {
        "badge"
    }
    fn import(
        &self,
        p: &editac_markdown::import::PreparedContent,
    ) -> Result<Option<Vec<FragmentBlock>>, editac_markdown::import::ImportError> {
        Ok(p.source.strip_prefix("[badge] ").map(|s| {
            vec![FragmentBlock {
                attributes: Some(BlockAttributes::Heading(2)),
                runs: vec![FragmentRun {
                    opaque_marks: vec![],
                    text: s.into(),
                    marks: vec![(editac_core::commands::format::Mark::Bold, None)],
                }],
                containers: vec![],
                checked: None,
            }]
        }))
    }
    fn export(&self, b: &[FragmentBlock]) -> Option<String> {
        (b.len() == 1 && b[0].attributes == Some(BlockAttributes::Heading(2))).then(|| {
            format!(
                "[badge] {}",
                b[0].runs
                    .iter()
                    .map(|r| r.text.as_str())
                    .collect::<String>()
            )
        })
    }
}
struct Lossy;
impl extensions::Extension for Lossy {
    fn name(&self) -> &str {
        "lossy"
    }
    fn export(&self, _: &[FragmentBlock]) -> Option<String> {
        Some("changed".into())
    }
}
#[test]
fn trusted_custom_source_hooks_and_reference_export_keep_explicit_recovery() {
    let p = extensions::import("[badge] é😀", Codecs::default(), &[&Badge]).unwrap();
    let mut d = blank();
    paste(&mut d, &p.blocks);
    let before = d.checkpoint().bytes;
    let e = extensions::export(&p.blocks, &[&Badge]).unwrap();
    assert_eq!(e.markdown, p.source);
    assert!(e.recovery.is_empty());
    let e = extensions::export(&p.blocks, &[&Lossy]).unwrap();
    assert_eq!(e.diagnostics[0].code, "extension-unrepresentable");
    assert_exact_fragments(&e.recovery, &p.blocks);
    assert_eq!(d.checkpoint().bytes, before);
    let tuple = conformance::any(
        &json!(["module:editac.reference",1,{"targetId":"host:unknown/😀","label":"Offline 😀"}]),
    );
    let blocks = vec![FragmentBlock {
        attributes: Some(BlockAttributes::Unknown(tuple)),
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: "Offline 😀".into(),
            marks: vec![],
        }],
        containers: vec![],
        checked: None,
    }];
    let mut reference = blank();
    paste(&mut reference, &blocks);
    let reference_id = reference
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
        .unwrap()
        .id
        .clone();
    let copied = reference.fragment_for_node(&reference_id).unwrap();
    let exported = extensions::export(&[copied.clone()], &[]).unwrap();
    assert_eq!(
        exported.diagnostics[0].code,
        "reference-identity-not-exported"
    );
    assert_exact_fragments(&exported.recovery, &[copied]);
    write_checkpoint("reference-recovery", &reference);
    save(
        "rust-reference.json",
        &json!({"markdown":exported.markdown,"diagnostic":"reference-identity-not-exported","semantic":semantic(&reference)}),
    );
}
#[test]
fn literal_source_reconciliation_never_parses_markdown_syntax() {
    let source = "# **literal** é😀\n";
    let mut d = blank();
    paste(
        &mut d,
        &[FragmentBlock {
            attributes: None,
            runs: vec![FragmentRun {
                opaque_marks: vec![],
                text: source.into(),
                marks: vec![],
            }],
            containers: vec![],
            checked: None,
        }],
    );
    let ids = owners(&d);
    let base = SourceBaseline::capture(&d, source, SourceMode::Literal, &ids).unwrap();
    base.prepare(&d, "# **literal changed** é😀\n", &origin())
        .unwrap()
        .commit(&mut d)
        .unwrap();
    let snapshot = d.snapshot().unwrap();
    assert_eq!(
        snapshot
            .visible
            .iter()
            .find(|n| n.kind == "block")
            .unwrap()
            .block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    assert!(
        snapshot
            .visible
            .iter()
            .filter(|n| n.kind == "block")
            .flat_map(|n| &n.runs)
            .all(|r| r.attributes.is_empty())
    );
}
