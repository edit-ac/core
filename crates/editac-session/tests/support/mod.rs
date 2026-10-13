use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{CreationPermit, Document, DocumentIdentity, InitialNode, InitializedCheckpoint},
};
use std::sync::OnceLock;

pub fn checkpoint() -> &'static InitializedCheckpoint {
    static CHECKPOINT: OnceLock<InitializedCheckpoint> = OnceLock::new();
    CHECKPOINT.get_or_init(|| {
        let identity = DocumentIdentity::v5(
            "12345678-1234-4234-8234-123456789abc",
            "23456789-2345-4345-8345-23456789abcd",
        )
        .unwrap();
        Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap()
        .checkpoint()
    })
}

pub fn document() -> Document {
    let checkpoint = checkpoint();
    Document::restore(&checkpoint.identity, checkpoint, &[]).unwrap()
}

pub fn owner(document: &Document) -> String {
    document
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone()
}

pub fn text(document: &Document) -> String {
    document
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .flat_map(|n| n.runs.iter().map(|r| r.text.clone()).collect::<Vec<_>>())
        .collect()
}

pub fn origin() -> TextOrigin {
    TextOrigin::new("session:compatibility").unwrap()
}

pub fn insert(document: &mut Document, offset: u32, value: &str) {
    let at = document
        .anchor(&owner(document), Utf16Offset(offset), Bias::Right)
        .unwrap();
    let plan = document
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: value.into(),
            },
            &origin(),
        )
        .unwrap();
    document.commit_text(plan).unwrap();
}
