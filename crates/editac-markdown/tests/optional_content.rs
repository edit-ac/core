#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::{editor::FragmentBlock, text::TextOrigin},
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    modules::content::{Alignment, Content, ContentError},
};
use editac_markdown::{
    export::export,
    import::{ImportError, import},
    optional::{Codecs, import_with_codecs},
};
fn enabled() -> Codecs {
    Codecs {
        callouts: false,
        images: true,
        tables: true,
    }
}
fn content(block: &FragmentBlock) -> Content {
    let Some(BlockAttributes::Unknown(tuple)) = &block.attributes else {
        panic!("missing descriptor")
    };
    Content::from_tuple(tuple).unwrap().unwrap()
}
fn visible(
    snapshot: &editac_core::projection::Snapshot,
) -> Vec<editac_core::projection::ProjectedNode> {
    snapshot
        .visible
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let mut node = n.as_ref().clone();
            node.order = i as u32;
            node
        })
        .collect()
}
fn doc() -> Document {
    static BASE: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
        std::sync::OnceLock::new();
    let base = BASE.get_or_init(|| {
        let identity = DocumentIdentity::v5(
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888888",
        )
        .unwrap();
        Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "original".into(),
            }],
        )
        .unwrap()
        .checkpoint()
    });
    let mut d = Document::restore(&base.identity, base, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}

#[test]
fn registered_images_retain_alt_title_url_and_source() {
    let source = "![a &amp; 😀](https://example.com/a.png \"caption\")\n";
    let p = import_with_codecs(source, enabled()).unwrap();
    assert!(p.diagnostics.is_empty());
    let Content::Image {
        alt,
        title,
        url,
        source: raw,
    } = content(&p.blocks[0])
    else {
        panic!()
    };
    assert_eq!(alt, "a & 😀");
    assert_eq!(title, "caption");
    assert_eq!(url, "https://example.com/a.png");
    assert_eq!(raw, source.trim_end());
    let out = export(&p.blocks);
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    let q = import_with_codecs(&out.markdown, enabled()).unwrap();
    let Content::Image { alt, .. } = content(&q.blocks[0]) else {
        panic!()
    };
    assert_eq!(alt, "a & 😀");
}

#[test]
fn rectangular_tables_retain_alignment_rich_cells_and_code_pipes() {
    let source = "| **A** | B |\n| :--- | ---: |\n| `x\\|y` | [link](https://example.com/) |\n";
    let p = import_with_codecs(source, enabled()).unwrap();
    assert!(p.diagnostics.is_empty(), "{:?}", p.diagnostics);
    let Content::Table {
        alignments, rows, ..
    } = content(&p.blocks[0])
    else {
        panic!()
    };
    assert_eq!(alignments, [Alignment::Left, Alignment::Right]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1][0][0].text, "x|y");
    let out = export(&p.blocks);
    assert!(
        out.diagnostics.is_empty(),
        "{:?}: {}",
        out.diagnostics,
        out.markdown
    );
    let q = import_with_codecs(&out.markdown, enabled()).unwrap();
    let Content::Table { rows: again, .. } = content(&q.blocks[0]) else {
        panic!()
    };
    assert_eq!(again[1][0][0].text, "x|y");
    assert_eq!(again[0][0][0].marks, rows[0][0][0].marks);
}

#[test]
fn disabled_inline_and_hostile_images_keep_inert_source_and_diagnostics() {
    for source in ["![alt](https://example.com/a.png)", "| a |\n| - |\n| b |\n"] {
        let p = import(source).unwrap();
        assert!(!p.diagnostics.is_empty());
        assert_eq!(p.source, source);
        assert!(!matches!(
            p.blocks[0].attributes,
            Some(BlockAttributes::Unknown(_))
        ));
    }
    for source in [
        "before ![alt](https://example.com/a.png) after",
        "![alt](data:image/svg+xml,boom)",
    ] {
        let p = import_with_codecs(source, enabled()).unwrap();
        assert!(!p.diagnostics.is_empty());
        assert_eq!(p.source, source);
    }
}

#[test]
fn oversize_shapes_and_bad_versions_reject_before_mutation() {
    let bad = Content::Table {
        alignments: vec![Alignment::None; 33],
        rows: vec![vec![vec![]; 33]],
        source: String::new(),
    };
    assert_eq!(bad.validate(), Err(ContentError::ResourceLimit));
    let source = format!("![{}](https://example.com/a.png)", "a".repeat(8193));
    assert_eq!(
        import_with_codecs(&source, enabled()).unwrap_err(),
        ImportError::ResourceLimit
    );
    let mut tuple = Content::Image {
        url: "https://example.com/a".into(),
        alt: "a".into(),
        title: String::new(),
        source: String::new(),
    }
    .tuple()
    .unwrap();
    let yrs::Any::Array(v) = &mut tuple else {
        panic!()
    };
    let mut data = v.to_vec();
    data[1] = yrs::Any::from(2u32);
    *v = data.into();
    assert_eq!(
        Content::from_tuple(&tuple).unwrap_err(),
        ContentError::UnsupportedVersion
    );
}

#[test]
fn mixed_opaque_fragment_is_one_engine_update_with_selective_history() {
    let mut d = doc();
    let before = d.checkpoint();
    let snapshot = d.snapshot().unwrap();
    let nodes: Vec<_> = snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .collect();
    let first = nodes[0];
    let last = nodes.last().unwrap();
    let len = last
        .runs
        .iter()
        .map(|r| r.text.encode_utf16().count() as u32)
        .sum();
    let range = Selection {
        anchor: d.anchor(&first.id, Utf16Offset(0), Bias::Right).unwrap(),
        focus: d.anchor(&last.id, Utf16Offset(len), Bias::Left).unwrap(),
    };
    let p = import_with_codecs(
        "![alt](https://example.com/a.png)\n\n| a |\n| - |\n| b |\n\nend\n",
        enabled(),
    )
    .unwrap();
    let plan = d
        .prepare_fragment(
            &range,
            &p.blocks,
            &TextOrigin::new("paste:optional").unwrap(),
        )
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before.bytes);
    let commit = d.commit_editor(plan).unwrap();
    assert!(!commit.update.bytes.is_empty());
    let view = d.snapshot().unwrap();
    assert_eq!(view.visible.iter().filter(|n| n.kind == "block").count(), 4);
    assert_eq!(
        view.visible
            .iter()
            .filter(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
            .count(),
        2
    );
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap();
    assert_eq!(visible(&d.snapshot().unwrap()), visible(&snapshot));
    d.redo().unwrap();
    assert_eq!(visible(&d.snapshot().unwrap()), visible(&view));
}

#[test]
fn edge_atom_paste_preserves_unrelated_prefix_suffix_and_result_caret() {
    let mut d = doc();
    let node = d.snapshot().unwrap().visible[0].id.clone();
    let at = d.anchor(&node, Utf16Offset(3), Bias::Right).unwrap();
    let range = Selection {
        anchor: at.clone(),
        focus: at,
    };
    let p = import_with_codecs("![alt](https://example.com/a.png)", enabled()).unwrap();
    let plan = d
        .prepare_fragment(&range, &p.blocks, &TextOrigin::new("paste:edge").unwrap())
        .unwrap();
    let commit = d.commit_editor(plan).unwrap();
    let view = d.snapshot().unwrap();
    let text: Vec<_> = view
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect();
    assert_eq!(text, ["ori", "alt", "ginal"]);
    assert_eq!(
        view.visible[0].block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    assert_eq!(
        view.visible[2].block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    let editac_core::anchors::Resolution::Position(caret) =
        d.resolve_anchor(&commit.result_caret.unwrap()).unwrap()
    else {
        panic!()
    };
    assert_eq!(caret.node, view.visible[2].id);
    assert_eq!(caret.offset, Utf16Offset(0));
    assert_eq!(d.history_state().undo_groups, 1);
}

#[test]
fn cross_block_rich_replacement_keeps_one_update_and_history() {
    let identity = DocumentIdentity::v5(
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[
            InitialNode {
                kind: "block".into(),
                text: "alpha".into(),
            },
            InitialNode {
                kind: "block".into(),
                text: "independent".into(),
            },
        ],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    let before = d.snapshot().unwrap();
    let range = Selection {
        anchor: d
            .anchor(&before.visible[0].id, Utf16Offset(0), Bias::Right)
            .unwrap(),
        focus: d
            .anchor(&before.visible[1].id, Utf16Offset(11), Bias::Left)
            .unwrap(),
    };
    let p = import("## **Bold**\n\n[Link](https://example.com/)\n").unwrap();
    let plan = d
        .prepare_fragment(&range, &p.blocks, &TextOrigin::new("paste:cross").unwrap())
        .unwrap();
    d.commit_editor(plan).unwrap();
    let after = d.snapshot().unwrap();
    assert_eq!(
        after
            .visible
            .iter()
            .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect::<String>())
            .collect::<Vec<_>>(),
        ["Bold", "Link"]
    );
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap();
    assert_eq!(visible(&d.snapshot().unwrap()), visible(&before));
    d.redo().unwrap();
    assert_eq!(visible(&d.snapshot().unwrap()), visible(&after));
}

#[test]
fn reference_export_keeps_literal_label_and_reports_identity_loss() {
    let tuple = Content::Reference {
        target_id: "unknown:host/id".into(),
        label: "Unknown [label]".into(),
    }
    .tuple()
    .unwrap();
    let result = export(&[FragmentBlock {
        attributes: Some(BlockAttributes::Unknown(tuple)),
        runs: vec![editac_core::commands::editor::FragmentRun {
            opaque_marks: vec![],
            text: "Unknown [label]".into(),
            marks: vec![],
        }],
        containers: vec![],
        checked: None,
    }]);
    assert_eq!(result.markdown.trim(), r"Unknown \[label\]");
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "reference-identity-not-exported")
    );
}

#[test]
fn table_cell_breaks_roundtrip_marks_empty_repeated_trailing_and_literal_html() {
    for cell in [
        "<br />",
        "<br><br/>tail<br />",
        "**a<br />😀<br /><br />**",
        "[a<br />b](https://example.com/)",
        "a\\|b<br />c",
        "&lt;br /&gt;<br />tail",
    ] {
        let source = format!("| {cell} | other |\r\n| --- | --- |\r\n| x | y |\r\n");
        let p = import_with_codecs(&source, enabled()).unwrap();
        assert!(p.diagnostics.is_empty(), "{cell}: {:?}", p.diagnostics);
        let Content::Table {
            rows,
            source: retained,
            ..
        } = content(&p.blocks[0])
        else {
            panic!()
        };
        assert!(rows[0][0].iter().any(|r| r.text.contains('\n')));
        assert_eq!(retained, source);
        let out = export(&p.blocks);
        assert!(
            out.diagnostics.is_empty(),
            "{cell}: {:?}: {}",
            out.diagnostics,
            out.markdown
        );
        assert_eq!(out.markdown.lines().count(), 3);
        let q = import_with_codecs(&out.markdown, enabled()).unwrap();
        let Content::Table { rows: again, .. } = content(&q.blocks[0]) else {
            panic!()
        };
        let scalars = |rows: &[Vec<Vec<editac_core::commands::editor::FragmentRun>>]| {
            rows.iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| {
                            cell.iter()
                                .map(|r| (r.text.clone(), r.marks.clone()))
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(scalars(&rows), scalars(&again));
    }
    for cell in [
        "a<br onclick='x'>b",
        "a<br data-x='1' />b",
        "<script>x</script>",
    ] {
        let source = format!("| {cell} |\n| --- |\n| x |\n");
        let p = import_with_codecs(&source, enabled()).unwrap();
        assert!(!p.diagnostics.is_empty(), "{cell}");
        assert_eq!(p.source, source);
    }
}

#[test]
fn multiline_table_code_and_unrepresentable_marks_keep_exact_typed_recovery() {
    use editac_core::commands::{editor::FragmentRun, format::Mark};
    for mark in [Mark::Code, Mark::Underline] {
        let descriptor = Content::Table {
            alignments: vec![Alignment::None],
            rows: vec![vec![vec![FragmentRun {
                opaque_marks: vec![],
                text: "a\n😀\n".into(),
                marks: vec![(mark, None)],
            }]]],
            source: "original\r\nsource".into(),
        };
        let block = FragmentBlock {
            attributes: Some(BlockAttributes::Unknown(descriptor.tuple().unwrap())),
            runs: vec![FragmentRun {
                opaque_marks: vec![],
                text: "a\n😀\n".into(),
                marks: vec![],
            }],
            containers: vec![],
            checked: None,
        };
        let out = export(&[block.clone()]);
        assert!(!out.diagnostics.is_empty());
        assert_eq!(out.recovery.len(), 1);
        assert_eq!(
            out.recovery[0].attributes.as_ref().unwrap().tuple(),
            block.attributes.as_ref().unwrap().tuple()
        );
        assert_eq!(out.recovery[0].runs[0].text, block.runs[0].text);
        assert_eq!(out.recovery[0].runs[0].marks, block.runs[0].marks);
        assert_eq!(out.markdown.lines().count(), 2);
    }
}
