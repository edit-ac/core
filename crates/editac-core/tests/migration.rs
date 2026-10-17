//! Canonical SDK-1.5 proof through production conversion, staged editing,
//! checkpoint restore and epoch/profile replay admission. No model/provider calls.
use editac_core::{
    document::{
        BlockAttributes, CreationPermit, Document, DocumentError, DocumentIdentity, InitialNode,
        ReplayUpdate,
    },
    import::tiptap::*,
};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use yrs::Any;

const SUPPORTED: &str = include_str!("fixtures/migration/supported.json");
fn source() -> SourceSession {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    SourceSession {
        document_id: format!("a5000000-0000-4000-8000-{id:012}"),
        epoch: "a6000000-0000-4000-8000-000000000001".into(),
    }
}
const NEW_EPOCH: &str = "a6000000-0000-4000-8000-000000000002";
fn prepare(input: &str) -> PreparedMigration {
    prepare_json(input, 1, source()).unwrap()
}
fn paragraphs(d: &Document) -> Vec<String> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}
fn snapshot_json(text: &str) -> String {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
        .to_string()
}

#[test]
fn supported_fixture_survives_semantic_migration_and_checkpoint_restore() {
    let prepared = prepare(SUPPORTED);
    assert_eq!(prepared.converter_version(), 1);
    assert!(prepared.diagnostics().is_empty());
    assert_eq!(prepared.original_json(), SUPPORTED);
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    let expected = vec![
        "A😀é שלום\ncode",
        "Heading",
        "fn main() {\n  println!(\"hi\");\n}\n",
        "",
        "Quote",
        "Bullet",
        "Nested",
        "Done",
        "Todo",
        "",
    ];
    assert_eq!(paragraphs(&d), expected);
    assert_eq!(d.identity().epoch, NEW_EPOCH);
    assert_eq!(
        d.identity().document_id,
        prepared.source_session().document_id
    );
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    assert_ne!(d.writer_id(), restored.writer_id());
    assert_eq!(paragraphs(&restored), expected);
}
#[test]
fn supported_marks_and_presentations_survive_in_production_projection() {
    let d = prepare(SUPPORTED).start_session(NEW_EPOCH).unwrap();
    let snapshot = d.snapshot().unwrap();
    let blocks: Vec<_> = snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .collect();
    let first = &blocks[0].runs[0];
    for key in ["bold", "italic", "strike", "underline"] {
        assert_eq!(first.attributes.get(key), Some(&Any::Bool(true)));
    }
    assert_eq!(
        first.attributes.get("link"),
        Some(&Any::from("https://example.com/path"))
    );
    assert!(
        blocks[0]
            .runs
            .iter()
            .any(|r| r.text == "code" && r.attributes.get("code") == Some(&Any::Bool(true)))
    );
    assert_eq!(
        blocks[1].block_attributes,
        Some(BlockAttributes::Heading(3))
    );
    assert_eq!(
        blocks[2].block_attributes,
        Some(BlockAttributes::Code("rust".into()))
    );
    assert_eq!(blocks[3].block_attributes, Some(BlockAttributes::Separator));
    assert_eq!(blocks[7].editor.as_ref().unwrap().checked, Some(true));
    assert_eq!(blocks[8].editor.as_ref().unwrap().checked, Some(false));
    assert_eq!(blocks[6].editor.as_ref().unwrap().number, Some(4));
    let quote = snapshot.visible.iter().find(|n| n.kind == "quote").unwrap();
    assert_eq!(blocks[4].parent, quote.id);
    let bullet = snapshot
        .visible
        .iter()
        .find(|n| n.kind == "list" && n.parent == "@root")
        .unwrap();
    assert_eq!(blocks[5].parent, bullet.id);
    let nested = snapshot
        .visible
        .iter()
        .find(|n| n.kind == "list" && n.parent == bullet.id)
        .unwrap();
    assert_eq!(blocks[6].parent, nested.id);
}
#[test]
fn unknown_block_keeps_inert_bounded_source_and_exact_recovery_input() {
    let input = json!({"type":"doc","content":[{"type":"secretWidget","attrs":{"payload":"😀".repeat(3000)}}]}).to_string();
    let prepared = prepare(&input);
    assert_eq!(prepared.original_json(), input);
    assert_eq!(prepared.diagnostics().len(), 1);
    let diagnostic = &prepared.diagnostics()[0];
    assert!(diagnostic.truncated);
    assert!(diagnostic.source.len() <= MAX_SOURCE_BYTES);
    assert_eq!(diagnostic.path, "$.content[0]");
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let snapshot = restored.snapshot().unwrap();
    let atom = snapshot
        .visible
        .iter()
        .find(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
        .unwrap();
    let Some(BlockAttributes::Unknown(Any::Array(tuple))) = &atom.block_attributes else {
        panic!("opaque atom")
    };
    assert_eq!(tuple[0], Any::from("tiptap.v1"));
    assert_eq!(tuple[1], Any::from(diagnostic.source.clone()));
    assert_eq!(tuple[2], Any::Bool(true));
    assert_eq!(
        atom.runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        diagnostic.source
    );
}
#[test]
fn unknown_inline_mark_attributes_and_fields_all_emit_diagnostics() {
    let input = json!({"type":"doc","extra":"root", "content":[{"type":"paragraph","attrs":{"align":"center"},"content":[
        {"type":"text","text":"keep", "marks":[{"type":"rainbow","attrs":{"x":1}}, {"type":"bold","attrs":{"extra":2}}]},
        {"type":"image","attrs":{"src":"javascript:alert(1)"}}
    ]}]}).to_string();
    let prepared = prepare(&input);
    assert_eq!(prepared.original_json(), input);
    assert_eq!(prepared.diagnostics().len(), 5);
    assert!(
        prepared
            .diagnostics()
            .iter()
            .any(|d| d.reason == "unsupported inline node")
    );
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    let texts = paragraphs(&d);
    assert!(texts[0].starts_with("keep"));
    assert!(texts[0].contains("javascript:alert(1)")); // inert text, not an executable URL
}
#[test]
fn unsafe_links_preserve_text_and_source_without_active_link() {
    let input = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"safe", "marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}).to_string();
    let prepared = prepare(&input);
    assert_eq!(prepared.diagnostics()[0].reason, "unsafe link omitted");
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    assert_eq!(paragraphs(&d), ["safe"]);
    assert!(
        d.snapshot().unwrap().visible[0].runs[0]
            .attributes
            .get("link")
            .is_none()
    );
}
#[test]
fn literal_code_whitespace_and_unsupported_marks_are_reported() {
    let input = json!({"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"\n\t x\n\n", "marks":[{"type":"bold"}]}]}]}).to_string();
    let prepared = prepare(&input);
    assert_eq!(prepared.diagnostics()[0].reason, "code block mark omitted");
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    assert_eq!(paragraphs(&d), ["\n\t x\n\n"]);
}
#[test]
fn empty_document_starts_once_and_restores_without_reimport() {
    let prepared = prepare("{\"type\":\"doc\"}");
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    assert_eq!(paragraphs(&d), [""]);
    assert!(matches!(
        prepared.start_session(NEW_EPOCH),
        Err(MigrationError::Admission(DocumentError::AlreadyInitialized))
    ));
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    assert_eq!(paragraphs(&restored), [""]);
}
#[test]
fn same_epoch_and_invalid_epoch_are_rejected_before_creation() {
    let prepared = prepare(&snapshot_json("new"));
    assert!(matches!(
        prepared.start_session(&prepared.source_session().epoch),
        Err(MigrationError::SameEpoch)
    ));
    assert!(matches!(
        prepared.start_session("not-an-epoch"),
        Err(MigrationError::Admission(DocumentError::InvalidMetadata))
    ));
    assert_eq!(
        paragraphs(&prepared.start_session(NEW_EPOCH).unwrap()),
        ["new"]
    );
}
#[test]
fn actual_old_yjs_update_is_rejected_before_live_mutation() {
    let prepared = prepare(&snapshot_json("new content"));
    let mut d = prepared.start_session(NEW_EPOCH).unwrap();
    let bytes = include_bytes!("fixtures/migration/legacy-yjs.bin").to_vec();
    let old_identity = DocumentIdentity::v5(
        &prepared.source_session().document_id,
        &prepared.source_session().epoch,
    )
    .unwrap();
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    assert_eq!(
        d.apply_replay(&ReplayUpdate {
            identity: old_identity,
            bytes
        }),
        Err(DocumentError::WrongEpoch)
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), revision);
    assert_eq!(paragraphs(&d), ["new content"]);
    let legacy = DocumentIdentity::v4(&prepared.source_session().document_id, NEW_EPOCH).unwrap();
    assert_eq!(
        d.apply_replay(&ReplayUpdate {
            identity: legacy,
            bytes: vec![255]
        }),
        Err(DocumentError::UnsupportedProfile)
    );
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn old_live_replica_is_unchanged_and_its_offline_tail_is_rejected() {
    let session = source();
    let identity = DocumentIdentity::v5(&session.document_id, &session.epoch).unwrap();
    let old = Document::create(
        CreationPermit::authorize_new(identity.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "old offline content".into(),
        }],
    )
    .unwrap();
    let old_checkpoint = old.checkpoint();
    let prepared = prepare_json(&snapshot_json("imported"), 1, session).unwrap();
    let mut fresh = prepared.start_session(NEW_EPOCH).unwrap();
    assert_ne!(old.writer_id(), fresh.writer_id());
    assert_eq!(old.checkpoint().bytes, old_checkpoint.bytes);
    assert_eq!(paragraphs(&old), ["old offline content"]);
    assert_eq!(
        fresh.apply_replay(&ReplayUpdate {
            identity,
            bytes: old_checkpoint.bytes
        }),
        Err(DocumentError::WrongEpoch)
    );
    assert_eq!(paragraphs(&fresh), ["imported"]);
}
#[test]
fn malformed_json_version_and_session_fail_without_conversion() {
    assert!(matches!(
        prepare_json("{", 1, source()),
        Err(MigrationError::InvalidJson)
    ));
    assert!(matches!(
        prepare_json(SUPPORTED, 2, source()),
        Err(MigrationError::UnsupportedConverter(2))
    ));
    let mut session = source();
    session.epoch = "bad".into();
    assert!(matches!(
        prepare_json(SUPPORTED, 1, session),
        Err(MigrationError::Admission(DocumentError::InvalidMetadata))
    ));
}
#[test]
fn malformed_supported_content_is_not_silently_downgraded() {
    for node in [
        json!({"type":"heading","attrs":{"level":7}}),
        json!({"type":"codeBlock","attrs":{"language":"a b"}}),
        json!({"type":"orderedList","attrs":{"start":-1}}),
        json!({"type":"paragraph","content":"bad"}),
        json!({"type":"paragraph","content":[{"type":"text"}]}),
        json!({"type":"horizontalRule","content":[{"type":"text","text":"bad"}]}),
        json!({"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":"bad"},"content":[{"type":"paragraph"}]}]}),
    ] {
        let input = json!({"type":"doc","content":[node]}).to_string();
        assert!(
            matches!(
                prepare_json(&input, 1, source()),
                Err(MigrationError::InvalidContent(_))
            ),
            "{input}"
        );
    }
}
#[test]
fn conflicting_and_duplicate_marks_fail_before_session_initialization() {
    for marks in [
        json!([{"type":"code"},{"type":"bold"}]),
        json!([{"type":"bold"},{"type":"bold"}]),
    ] {
        let input = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":marks}]}]}).to_string();
        assert!(matches!(
            prepare_json(&input, 1, source()),
            Err(MigrationError::InvalidContent(_))
        ));
    }
}
#[test]
fn bounded_input_block_run_and_diagnostic_limits_fail_explicitly() {
    let large = snapshot_json(&"x".repeat(MAX_INPUT_BYTES));
    assert!(matches!(
        prepare_json(&large, 1, source()),
        Err(MigrationError::ResourceLimit)
    ));
    let blocks = json!({"type":"doc","content":vec![json!({"type":"paragraph"});127]}).to_string();
    assert!(matches!(
        prepare_json(&blocks, 1, source()),
        Err(MigrationError::ResourceLimit)
    ));
    let runs = json!({"type":"doc","content":[{"type":"paragraph","content":vec![json!({"type":"text","text":"x"});1025]}]}).to_string();
    assert!(matches!(
        prepare_json(&runs, 1, source()),
        Err(MigrationError::ResourceLimit)
    ));
    let unknown =
        json!({"type":"doc","content":vec![json!({"type":"widget","data":"x".repeat(4096)});17]})
            .to_string();
    assert!(matches!(
        prepare_json(&unknown, 1, source()),
        Err(MigrationError::ResourceLimit)
    ));
}
#[test]
fn nested_container_depth_is_bounded() {
    let mut node = json!({"type":"paragraph"});
    for _ in 0..17 {
        node = json!({"type":"blockquote","content":[node]});
    }
    assert!(matches!(
        prepare_json(
            &json!({"type":"doc","content":[node]}).to_string(),
            1,
            source()
        ),
        Err(MigrationError::ResourceLimit)
    ));
}
#[test]
fn new_epoch_replicas_exchange_only_new_profile_updates() {
    let prepared = prepare(&snapshot_json("new"));
    let mut d = prepared.start_session(NEW_EPOCH).unwrap();
    let mut peer = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let at = d
        .anchor(
            &owner,
            editac_core::Utf16Offset(3),
            editac_core::anchors::Bias::Right,
        )
        .unwrap();
    let origin = editac_core::commands::text::TextOrigin::new("migration:peer-proof").unwrap();
    let plan = d
        .prepare_editor(
            &[editac_core::commands::editor::EditorCommand::Text(
                editac_core::commands::text::TextCommand::Insert {
                    at,
                    text: " epoch edit".into(),
                },
            )],
            &origin,
        )
        .unwrap();
    d.commit_editor(plan).unwrap();
    let update = ReplayUpdate {
        identity: d.identity().clone(),
        bytes: d.update_v1(&peer.state_vector_v1()).unwrap(),
    };
    peer.apply_replay(&update).unwrap();
    assert_eq!(paragraphs(&peer), ["new epoch edit"]);
    peer.apply_replay(&update).unwrap();
    assert_eq!(paragraphs(&peer), ["new epoch edit"]);
}

#[test]
fn unknown_atoms_between_supported_blocks_remain_read_only_without_losing_neighbors() {
    let input = json!({"type":"doc","content":[
        {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"before"}]},
        {"type":"widget","attrs":{"data":"retained"}},
        {"type":"paragraph","content":[{"type":"text","text":"after"}]}
    ]})
    .to_string();
    let prepared = prepare(&input);
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    let snapshot = d.snapshot().unwrap();
    let blocks: Vec<_> = snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .collect();
    assert_eq!(blocks.len(), 3);
    assert_eq!(paragraphs(&d)[0], "before");
    assert_eq!(paragraphs(&d)[2], "after");
    assert_eq!(
        blocks[0].block_attributes,
        Some(BlockAttributes::Heading(2))
    );
    assert!(matches!(
        blocks[1].block_attributes,
        Some(BlockAttributes::Unknown(_))
    ));
    let at = d.anchor(
        &blocks[1].id,
        editac_core::Utf16Offset(0),
        editac_core::anchors::Bias::Left,
    );
    let origin = editac_core::commands::text::TextOrigin::new("migration:opaque-proof").unwrap();
    let result = d.prepare_editor(
        &[editac_core::commands::editor::EditorCommand::Text(
            editac_core::commands::text::TextCommand::Insert {
                at: at.unwrap(),
                text: "forbidden".into(),
            },
        )],
        &origin,
    );
    assert!(result.is_err());
}
#[test]
fn complex_list_items_preserve_source_instead_of_changing_list_numbering() {
    let input = json!({"type":"doc","content":[{"type":"orderedList","attrs":{"start":7},"content":[
        {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"first"}]},{"type":"paragraph","content":[{"type":"text","text":"second"}]}]},
        {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"next"}]}]}
    ]}]}).to_string();
    let prepared = prepare(&input);
    assert_eq!(
        prepared.diagnostics()[0].reason,
        "unsupported multi-block list item"
    );
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    let snapshot = d.snapshot().unwrap();
    let blocks: Vec<_> = snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .collect();
    let atom = blocks
        .iter()
        .find(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
        .unwrap();
    let retained = atom
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect::<String>();
    assert!(retained.contains("first") && retained.contains("second") && retained.contains("next"));
    // The entire unsupported list stays inert; no altered numbering is advertised.
    assert!(!snapshot.visible.iter().any(|n| n.kind == "list"));
    assert_eq!(prepared.original_json(), input);
}
#[test]
fn deepest_supported_container_uses_bounded_keys_and_survives_restore() {
    let mut node = json!({"type":"paragraph","content":[{"type":"text","text":"deep"}]});
    for _ in 0..16 {
        node = json!({"type":"blockquote","content":[node]});
    }
    let prepared = prepare(&json!({"type":"doc","content":[node]}).to_string());
    assert!(prepared.diagnostics().is_empty());
    let d = prepared.start_session(NEW_EPOCH).unwrap();
    assert_eq!(paragraphs(&d), ["deep"]);
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .filter(|n| n.kind == "quote")
            .count(),
        16
    );
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    assert_eq!(paragraphs(&restored), ["deep"]);
}
#[test]
fn invalid_later_node_does_not_initialize_or_mutate_the_old_replica() {
    let session = source();
    let identity = DocumentIdentity::v5(&session.document_id, &session.epoch).unwrap();
    let old = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "preserve".into(),
        }],
    )
    .unwrap();
    let checkpoint = old.checkpoint();
    let input = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"valid"}]},{"type":"heading","attrs":{"level":99}}]}).to_string();
    assert!(matches!(
        prepare_json(&input, 1, session.clone()),
        Err(MigrationError::InvalidContent(_))
    ));
    assert_eq!(old.checkpoint().bytes, checkpoint.bytes);
    let prepared = prepare_json(&snapshot_json("fixed"), 1, session).unwrap();
    assert_eq!(
        paragraphs(&prepared.start_session(NEW_EPOCH).unwrap()),
        ["fixed"]
    );
}
