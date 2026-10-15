//! Native-owned corpus using the existing portable transfer parser and engine.
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::text::TextOrigin,
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    interchange::{TransferBlock, projection_snapshot, transfer_blocks},
};
use editac_session::{
    ports::{CheckpointRecord, LocalStore, StoreLimits},
    store::NativeStore,
};

fn main() {
    let root =
        std::path::PathBuf::from(std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").unwrap());
    std::fs::create_dir_all(&root).unwrap();
    let document_id = "ac180000-0000-4000-8000-000000000011";
    let epoch = "ac180000-0000-4000-8000-000000000001";
    let identity = DocumentIdentity::v5(document_id, epoch).unwrap();
    let mut doc = Document::create(
        CreationPermit::authorize_new(identity.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: String::new(),
        }],
    )
    .unwrap();
    let node = doc.snapshot().unwrap().visible[0].id.clone();
    let anchor = doc.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    let corpus: Vec<TransferBlock> = serde_json::from_str(include_str!("../corpus.json")).unwrap();
    let blocks = transfer_blocks(corpus).unwrap();
    let prepared = doc
        .prepare_fragment(
            &Selection {
                anchor: anchor.clone(),
                focus: anchor,
            },
            &blocks,
            &TextOrigin::new("macos-attachments-corpus").unwrap(),
        )
        .unwrap();
    doc.commit_editor(prepared).unwrap();
    let expected = projection_snapshot(&doc).unwrap();
    let path = root.join("store.sqlite");
    let store = NativeStore::create_new(
        path.to_str().unwrap(),
        identity.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    store
        .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
        .unwrap();
    drop(store);
    let visible = doc.snapshot().unwrap().visible;
    let manifest = serde_json::json!({"path":path,"documentId":document_id,"epoch":epoch,
        "expected":expected,"factory":"native/macos/tests/AttachmentsFixture/src/main.rs",
        "providerCalls":0,"image":visible[1].id,"reference":visible[2].id});
    let manifest_path = root.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    println!("{}", manifest_path.display());
}
