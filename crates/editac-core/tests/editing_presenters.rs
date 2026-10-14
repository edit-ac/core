//! REG-17: native result policy for the real browser presenter insertion path.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{
        blocks::{BlockCommand, Side},
        editor::{EditorCommand, EditorPosition},
        text::TextOrigin,
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
};
fn with_nodes(texts: &[&str]) -> Document {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let identity = DocumentIdentity::v5(
        format!("42700000-0000-4000-8000-{n:012}"),
        format!("42700000-0000-4000-9000-{n:012}"),
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
fn document() -> Document {
    with_nodes(&["alpha", "independent"])
}
fn origin() -> TextOrigin {
    TextOrigin::new("rgs:presenter").unwrap()
}
fn setup() -> (Document, String, String) {
    let mut d = document();
    let first = d.snapshot().unwrap().visible[0].id.clone();
    let plan = d
        .prepare_blocks(
            &[BlockCommand::InsertSeparator {
                beside: first.clone(),
                side: Side::After,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_blocks(plan).unwrap();
    let separator = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.block_attributes == Some(editac_core::document::BlockAttributes::Separator))
        .unwrap()
        .id
        .clone();
    (d, first, separator)
}
fn check(side: Side) {
    let (mut d, first, separator) = setup();
    let before = d.snapshot().unwrap();
    let frozen = (d.checkpoint().bytes, d.state_vector_v1(), d.revision());
    let plan = d
        .prepare_blocks(
            &[BlockCommand::InsertParagraph {
                separator: separator.clone(),
                side,
                text: "X😀".into(),
            }],
            &origin(),
        )
        .unwrap();
    let staged = plan.result_caret().unwrap().clone();
    assert_eq!(
        (d.checkpoint().bytes, d.state_vector_v1(), d.revision()),
        frozen,
        "preparation never publishes"
    );
    let result = d.commit_blocks(plan).unwrap();
    let Resolution::Position(committed) = d.resolve_anchor(&result.result_caret.unwrap()).unwrap()
    else {
        panic!("unmapped committed caret")
    };
    let Resolution::Position(caret) = d.resolve_anchor(&staged).unwrap() else {
        panic!("unmapped insertion")
    };
    assert_eq!(
        (&committed.node, committed.offset, committed.bias),
        (&caret.node, U(3), Bias::Right)
    );
    assert_eq!(caret.offset, U(3));
    assert_eq!(caret.bias, Bias::Right);
    let nodes = d.snapshot().unwrap().visible;
    let index = nodes.iter().position(|n| n.id == caret.node).unwrap();
    let atom = nodes.iter().position(|n| n.id == separator).unwrap();
    assert_eq!(
        index as isize - atom as isize,
        if side == Side::Before { -1 } else { 1 }
    );
    assert_eq!(
        nodes[index]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "X😀"
    );
    assert_eq!(
        nodes.iter().find(|n| n.id == first).unwrap().runs,
        before.visible[0].runs
    );
    assert_ne!(
        caret.offset,
        U(2),
        "surrogate-interior expectation is falsified"
    );
}
#[test]
fn before_atom_result_is_new_owner_utf16_end() {
    check(Side::Before)
}
#[test]
fn after_atom_result_is_new_owner_utf16_end() {
    check(Side::After)
}
#[test]
fn invalid_final_selection_rejects_inserted_owner_and_result_without_effects() {
    let (d, first, separator) = setup();
    let frozen = (
        d.checkpoint().bytes,
        d.state_vector_v1(),
        d.revision(),
        d.history_state(),
    );
    let point = EditorPosition {
        owner: first,
        offset: U(999),
        bias: Bias::Right,
    };
    assert!(
        d.prepare_editor(
            &[
                EditorCommand::BlockCommand(BlockCommand::InsertParagraph {
                    separator,
                    side: Side::After,
                    text: "X😀".into()
                }),
                EditorCommand::SelectionAt {
                    anchor: point.clone(),
                    focus: point
                }
            ],
            &origin()
        )
        .is_err()
    );
    assert_eq!(
        (
            d.checkpoint().bytes,
            d.state_vector_v1(),
            d.revision(),
            d.history_state()
        ),
        frozen
    );
}
#[test]
fn explicit_final_selection_keeps_precedence_over_default_inserted_caret() {
    let (mut d, first, separator) = setup();
    let point = EditorPosition {
        owner: first.clone(),
        offset: U(1),
        bias: Bias::Left,
    };
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::BlockCommand(BlockCommand::InsertParagraph {
                    separator,
                    side: Side::After,
                    text: "X😀".into(),
                }),
                EditorCommand::SelectionAt {
                    anchor: point.clone(),
                    focus: point,
                },
            ],
            &origin(),
        )
        .unwrap();
    let result = d.commit_editor(plan).unwrap();
    let selection = result.result_selection.unwrap();
    for anchor in [&selection.anchor, &selection.focus] {
        let Resolution::Position(at) = d.resolve_anchor(anchor).unwrap() else {
            panic!()
        };
        assert_eq!(at.node, first);
        assert_eq!(at.offset, U(1));
        assert_eq!(at.bias, Bias::Left);
    }
}

#[test]
fn after_atom_adjacency_is_independent_of_recovered_writer_order() {
    for writer in [1, 4_000_000_000] {
        let (d, _, separator) = setup();
        let checkpoint = editac_core::document::InitializedCheckpoint {
            identity: d.identity().clone(),
            initialized: true,
            writer_id: writer,
            bytes: d.checkpoint().bytes,
        };
        let mut peer = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
        let atom = peer
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|n| n.id == separator)
            .unwrap();
        let plan = peer
            .prepare_blocks(
                &[BlockCommand::InsertParagraph {
                    separator: separator.clone(),
                    side: Side::After,
                    text: "X😀".into(),
                }],
                &origin(),
            )
            .unwrap();
        let result = peer.commit_blocks(plan).unwrap();
        let Resolution::Position(caret) =
            peer.resolve_anchor(&result.result_caret.unwrap()).unwrap()
        else {
            panic!()
        };
        let nodes = peer.snapshot().unwrap().visible;
        let at = nodes.iter().position(|n| n.id == separator).unwrap();
        assert_eq!(nodes[at + 1].id, caret.node);
        assert_eq!(caret.offset, U(3));
        assert_eq!(nodes[at].spans, atom.spans);
        assert_eq!(nodes[at].block_attributes, atom.block_attributes);
    }
}

#[test]
fn separator_deletion_returns_native_adjacent_or_created_caret() {
    for (texts, index, expected_text, offset) in [
        (vec![""], 0, "", 0),
        (vec!["", "tail"], 0, "tail", 0),
        (vec!["head😀", ""], 1, "head😀", 6),
    ] {
        let mut d = with_nodes(&texts);
        let separator = d.snapshot().unwrap().visible[index].id.clone();
        let plan = d
            .prepare_blocks(
                &[BlockCommand::ConvertSeparator {
                    owner: separator.clone(),
                }],
                &origin(),
            )
            .unwrap();
        d.commit_blocks(plan).unwrap();
        if texts.len() == 1 {
            // Conversion supplies a typing fallback. Disable that prepared
            // owner to exercise deletion with genuinely no editable neighbor.
            let fallback = d
                .snapshot()
                .unwrap()
                .visible
                .into_iter()
                .find(|node| node.id != separator)
                .unwrap();
            let plan = d
                .prepare_editor(
                    &[EditorCommand::Enable {
                        target: fallback.id.clone(),
                        enabled: false,
                    }],
                    &origin(),
                )
                .unwrap();
            d.commit_editor(plan).unwrap();
            let nodes = d.snapshot().unwrap().visible;
            assert_eq!(nodes.len(), 1);
            assert_eq!(nodes[0].id, separator);
            if let Ok(directory) = std::env::var("EDITAC_PRESENTER_ATOM_EXCHANGE") {
                // This is prepared input, never an expected-state golden.
                let directory = std::path::Path::new(&directory);
                std::fs::create_dir_all(directory).unwrap();
                let checkpoint = d.checkpoint();
                std::fs::write(
                    directory.join("identity.json"),
                    serde_json::to_vec_pretty(&serde_json::json!({
                        "profile": d.identity().profile,
                        "schema": d.identity().schema,
                        "protocolVersion": d.identity().protocol_version,
                        "updateEncoding": d.identity().update_encoding,
                        "offsets": d.identity().offsets,
                        "documentId": d.identity().document_id,
                        "epoch": d.identity().epoch,
                    }))
                    .unwrap(),
                )
                .unwrap();
                std::fs::write(directory.join("checkpoint.bin"), checkpoint.bytes).unwrap();
            }
        }
        let before = (d.checkpoint().bytes, d.state_vector_v1(), d.revision());
        let plan = d
            .prepare_blocks(
                &[BlockCommand::DeleteSeparator {
                    owner: separator.clone(),
                }],
                &origin(),
            )
            .unwrap();
        assert_eq!(
            (d.checkpoint().bytes, d.state_vector_v1(), d.revision()),
            before
        );
        let result = d.commit_blocks(plan).unwrap();
        assert!(!result.update.bytes.is_empty());
        assert_eq!(d.revision(), before.2 + 1);
        let caret = result.result_caret.unwrap();
        let Resolution::Position(point) = d.resolve_anchor(&caret).unwrap() else {
            panic!("unmapped deletion caret")
        };
        assert_eq!((point.offset, point.bias), (U(offset), Bias::Right));
        let nodes = d.snapshot().unwrap().visible;
        assert_eq!(nodes.len(), 1);
        assert_ne!(nodes[0].id, separator);
        assert_eq!(point.node, nodes[0].id);
        assert_eq!(
            nodes[0]
                .runs
                .iter()
                .map(|run| run.text.as_str())
                .collect::<String>(),
            expected_text
        );
        let insert = d
            .prepare_text(
                &editac_core::commands::text::TextCommand::Insert {
                    at: caret,
                    text: "Z".into(),
                },
                &origin(),
            )
            .unwrap();
        d.commit_text(insert).unwrap();
        let expected = if offset == 0 {
            format!("Z{expected_text}")
        } else {
            format!("{expected_text}Z")
        };
        assert_eq!(
            d.snapshot().unwrap().visible[0]
                .runs
                .iter()
                .map(|run| run.text.as_str())
                .collect::<String>(),
            expected
        );
    }
}
