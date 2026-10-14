//! EXT-1.13-C2-B: whole admitted atoms share one prepared transfer/history update.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::{FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    modules::content::{Alignment, Content},
};
fn blank() -> Document {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = DocumentIdentity::v5(
        format!("93000000-0000-4000-8000-{next:012}"),
        format!("94000000-0000-4000-8000-{next:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: String::new(),
        }],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn run(text: &str) -> FragmentRun {
    FragmentRun {
        text: text.into(),
        marks: vec![],
    }
}
fn block(text: &str) -> FragmentBlock {
    FragmentBlock {
        runs: vec![run(text)],
        attributes: None,
        containers: vec![],
        checked: None,
    }
}
fn text(d: &Document) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .flat_map(|n| &n.runs)
        .map(|r| r.text.as_str())
        .collect()
}
fn contents() -> Vec<Content> {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/extensions/clipboard/conformance.json"
    ))
    .unwrap();
    let rich = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == "table-v2-mixed-cell")
        .unwrap();
    let tuple =
        yrs::Any::from_json(&rich["envelope"]["payload"][0]["attributes"]["tuple"].to_string())
            .unwrap();
    vec![
        Content::InertExtension { data: yrs::Any::from_json(r#"{"version":1,"type":"vendor.atom","dataVersion":99,"source":"inert 😀","payload":{"formula":"=unsafe()"}}"#).unwrap() },
        Content::from_tuple(&tuple).unwrap().unwrap(),
        Content::Table {
            alignments: vec![Alignment::Left],
            rows: vec![vec![vec![run("cell")]]],
            source: "| cell |".into(),
        },
        Content::Image {
            url: "https://example.invalid/image".into(),
            alt: "alt".into(),
            title: "title".into(),
            source: "![alt](https://example.invalid/image)".into(),
        },
        Content::Reference {
            target_id: "host:opaque".into(),
            label: "label".into(),
        },
    ]
}
#[test]
fn whole_mixed_atom_deletion_preserves_surroundings_history_and_restore() {
    for content in contents() {
        let mut d = blank();
        let origin = TextOrigin::new("extension:transfer").unwrap();
        let id = d.snapshot().unwrap().visible[0].id.clone();
        let at = d.anchor(&id, U(0), Bias::Right).unwrap();
        let label = if let Content::Reference { label, .. } = &content {
            label.as_str()
        } else {
            content.inert_source().unwrap_or("")
        };
        let mut atom = block(label);
        atom.attributes = Some(BlockAttributes::Unknown(content.tuple().unwrap()));
        let p = d
            .prepare_fragment(
                &Selection {
                    anchor: at.clone(),
                    focus: at,
                },
                &[block("prefixDROP"), atom, block("DROPtail😀")],
                &origin,
            )
            .unwrap();
        d.commit_editor(p).unwrap();
        d.reset_history_group();
        let before = d.checkpoint();
        let nodes = d.snapshot().unwrap().visible;
        let selected = Selection {
            anchor: d.anchor(&nodes[0].id, U(6), Bias::Right).unwrap(),
            focus: d
                .anchor(&nodes.last().unwrap().id, U(4), Bias::Left)
                .unwrap(),
        };
        let p = d
            .prepare_fragment(&selected, &[block("")], &origin)
            .unwrap();
        assert_eq!(d.checkpoint().bytes, before.bytes);
        d.commit_editor(p).unwrap();
        assert_eq!(text(&d), "prefixtail😀");
        assert_eq!(d.history_state().undo_groups, 2);
        let after = d.checkpoint();
        let restored = Document::restore(&after.identity, &after, &[]).unwrap();
        assert_eq!(text(&restored), "prefixtail😀");
        d.undo().unwrap();
        assert_eq!(
            text(&d),
            "prefixDROPlabelDROPtail😀".replace("label", label)
        );
        assert!(
            d.snapshot()
                .unwrap()
                .visible
                .iter()
                .any(|n| n.block_attributes.as_ref()
                    == Some(&BlockAttributes::Unknown(content.tuple().unwrap())))
        );
        d.redo().unwrap();
        assert_eq!(text(&d), "prefixtail😀");
    }
}
#[test]
fn partial_reference_deletion_is_nonmutating() {
    let mut d = blank();
    let origin = TextOrigin::new("extension:transfer").unwrap();
    let id = d.snapshot().unwrap().visible[0].id.clone();
    let at = d.anchor(&id, U(0), Bias::Right).unwrap();
    let mut atom = block("label");
    atom.attributes = Some(BlockAttributes::Unknown(
        Content::Reference {
            target_id: "host:opaque".into(),
            label: "label".into(),
        }
        .tuple()
        .unwrap(),
    ));
    let p = d
        .prepare_fragment(
            &Selection {
                anchor: at.clone(),
                focus: at,
            },
            &[atom],
            &origin,
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    let id = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
        .unwrap()
        .id
        .clone();
    let selected = Selection {
        anchor: d.anchor(&id, U(1), Bias::Right).unwrap(),
        focus: d.anchor(&id, U(4), Bias::Left).unwrap(),
    };
    let before = d.checkpoint();
    let history = d.history_state();
    assert!(
        d.prepare_fragment(&selected, &[block("")], &origin)
            .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before.bytes);
    assert_eq!(d.history_state().undo_groups, history.undo_groups);
}
