//! EXT-1.8 inert persistent reference data at the actual Document boundary.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::{EditorCommand, FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    modules::content::Content,
};
use yrs::Any;
const ID: &str = "ac://team-1/12345678-1234-4234-8234-123456789abc";
fn document() -> Document {
    static CP: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
        std::sync::OnceLock::new();
    let cp = CP.get_or_init(|| {
        let identity = DocumentIdentity::v5(
            "71000000-0000-4000-8000-000000000008",
            "72000000-0000-4000-8000-000000000008",
        )
        .unwrap();
        Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "alpha".into(),
            }],
        )
        .unwrap()
        .checkpoint()
    });
    let mut d = Document::restore(&cp.identity, cp, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn block() -> FragmentBlock {
    FragmentBlock {
        attributes: Some(BlockAttributes::Unknown(
            Content::Reference {
                target_id: ID.into(),
                label: "Offline <label> 😀".into(),
            }
            .tuple()
            .unwrap(),
        )),
        containers: vec![],
        checked: None,
        runs: vec![FragmentRun {
            text: "Offline <label> 😀".into(),
            marks: vec![],
        }],
    }
}
#[test]
fn offline_identity_label_checkpoint_copy_and_unrelated_edit_are_exact() {
    let mut d = document();
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let range = Selection {
        anchor: d.anchor(&owner, U(5), Bias::Right).unwrap(),
        focus: d.anchor(&owner, U(5), Bias::Right).unwrap(),
    };
    let before = d.checkpoint().bytes;
    let prepared = d
        .prepare_fragment(
            &range,
            &[block()],
            &TextOrigin::new("reference:insert").unwrap(),
        )
        .unwrap();
    assert_eq!(before, d.checkpoint().bytes);
    d.commit_editor(prepared).unwrap();
    let node = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
        .unwrap();
    assert_exact(d.fragment_for_node(&node.id).unwrap());
    let edit = EditorCommand::ReplaceAt {
        owner,
        from: U(0),
        to: U(1),
        text: "A".into(),
    };
    let p = d
        .prepare_editor(&[edit], &TextOrigin::new("elsewhere").unwrap())
        .unwrap();
    d.commit_editor(p).unwrap();
    let cp = d.checkpoint();
    let restored = Document::restore(&cp.identity, &cp, &[]).unwrap();
    assert_exact(restored.fragment_for_node(&node.id).unwrap());
    let output = std::path::PathBuf::from(
        std::env::var("EDITAC_EXTENSION_REFERENCES_OUTPUT")
            .expect("isolated reference output required"),
    );
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(output.join("rust-reference.bin"), cp.bytes).unwrap();
    std::fs::write(output.join("rust-reference.json"),serde_json::to_vec(&serde_json::json!({"identity":{"profile":cp.identity.profile,"schema":cp.identity.schema,"documentId":cp.identity.document_id,"epoch":cp.identity.epoch,"protocolVersion":1,"updateEncoding":1,"offsets":"utf16"},"writerId":cp.writer_id,"targetId":ID,"label":"Offline <label> 😀"})).unwrap()).unwrap();
}
#[test]
fn malformed_and_credential_fields_fail_before_document_mutation() {
    let d = document();
    let owner = d.snapshot().unwrap().visible[0].id.clone();
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    for tuple in [
        r#"["module:editac.reference",1,{"targetId":"id","label":"x","token":"SECRET"}]"#,
        r#"["module:editac.reference",1,{"targetId":"","label":"x"}]"#,
        r#"["module:editac.reference",1,{"targetId":"id","label":"x"}]"#,
    ] {
        let mut b = block();
        b.attributes = Some(BlockAttributes::Unknown(Any::from_json(tuple).unwrap()));
        let range = Selection {
            anchor: d.anchor(&owner, U(0), Bias::Right).unwrap(),
            focus: d.anchor(&owner, U(1), Bias::Left).unwrap(),
        };
        assert!(
            d.prepare_fragment(&range, &[b], &TextOrigin::new("reference:invalid").unwrap())
                .is_err()
        );
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(d.revision(), revision);
    }
}

fn assert_exact(b: FragmentBlock) {
    let expected = block();
    assert_eq!(b.attributes, expected.attributes);
    assert_eq!(b.runs.len(), 1);
    assert_eq!(b.runs[0].text, expected.runs[0].text);
    assert_eq!(b.runs[0].marks, expected.runs[0].marks);
}
