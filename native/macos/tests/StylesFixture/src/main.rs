//! Native-owned corpus using the existing portable transfer parser and engine.
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::text::TextOrigin,
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    interchange::{TransferBlock, projection_snapshot, transfer_blocks, transfer_value},
};
use editac_session::{
    ports::{CheckpointRecord, LocalStore, StoreLimits},
    store::NativeStore,
};

fn main() {
    let root =
        std::path::PathBuf::from(std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").unwrap());
    std::fs::create_dir_all(&root).unwrap();
    let document_id = "ac180000-0000-4000-8000-000000000008";
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
            &TextOrigin::new("macos-style-corpus").unwrap(),
        )
        .unwrap();
    doc.commit_editor(prepared).unwrap();
    // Compare the engine's exported semantic corpus, not checkpoint/CRDT bytes.
    // Fragment container keys are transfer-local; engine owner IDs are fresh.
    // An absent run and an unmarked zero-length run represent the same empty text.
    let normalize = |mut value: serde_json::Value| {
        value["runs"]
            .as_array_mut()
            .unwrap()
            .retain(|r| r["text"].as_str() != Some(""));
        for container in value["containers"].as_array_mut().unwrap() {
            container.as_object_mut().unwrap().remove("key");
        }
        value
    };
    let expected_semantics: Vec<_> = blocks
        .iter()
        .map(|b| normalize(transfer_value(b)))
        .collect();
    let actual_semantics: Vec<_> = doc
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| normalize(transfer_value(&doc.fragment_for_node(&n.id).unwrap())))
        .collect();
    assert_eq!(
        actual_semantics, expected_semantics,
        "shared style corpus semantic equality"
    );
    let expected = projection_snapshot(&doc).unwrap();
    let path = root.join("store.sqlite");
    let store =
        NativeStore::create_new(path.to_str().unwrap(), identity, StoreLimits::default()).unwrap();
    store
        .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
        .unwrap();
    drop(store);
    let manifest = serde_json::json!({"path":path,"documentId":document_id,"epoch":epoch,
        "expected":expected,"factory":"native/macos/tests/StylesFixture/src/main.rs",
        "providerCalls":0,"semanticEquality":true,"semanticBlocks":actual_semantics.len(),
        "corpus":serde_json::from_str::<serde_json::Value>(include_str!("../corpus.json")).unwrap()});
    let manifest_path = root.join("manifest.json");
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    println!("{}", manifest_path.display());
}
