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
    let document_id = "ac180000-0000-4000-8000-000000000009";
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
            &TextOrigin::new("macos-table-corpus").unwrap(),
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
    // Restore the exact persisted baseline, like NativeSession, so the real
    // engine's incremental stream begins at sequence zero.
    let producer_path = root.join("producer.sqlite");
    std::fs::copy(&path, &producer_path).unwrap();
    let store =
        NativeStore::open_existing(&producer_path, identity.clone(), StoreLimits::default())
            .unwrap();
    let session = editac_session::session::Session::open(
        store,
        &identity,
        editac_session::session::CachedPermission {
            writable: true,
            expires_at: None,
        },
    )
    .unwrap();
    let mut policy = editac_session::edit_service::HostPolicy::default();
    policy.codecs.tables = true;
    let mut service = editac_session::edit_service::EditService::new(session, policy);
    let visible = service.session().document().snapshot().unwrap().visible;
    let before = visible[0].id.clone();
    let table = visible[1].id.clone();
    let rich = visible[2].id.clone();
    let baseline: serde_json::Value = serde_json::from_str(include_str!("../corpus.json")).unwrap();
    let original = baseline[1]["attributes"]["tuple"].clone();
    let mut steps = Vec::new();
    let mut apply = |label: &str, command| {
        let revision = service.session().observed_revision().unwrap();
        let plan = service
            .prepare_commands(&revision, &[command], &TextOrigin::new(label).unwrap(), 0)
            .unwrap_or_else(|e| panic!("{label}: {e:?}"));
        let receipt = service.apply(plan, 0).unwrap().unwrap();
        assert!(service.local_receipt(&receipt.update).unwrap().is_some());
        let doc = service.session().document();
        let patch = doc.last_patch().unwrap();
        steps.push(serde_json::json!({"label":label, "sequence":patch.sequence,
            "patch":editac_core::interchange::projection_patch(&patch),
            "expected":projection_snapshot(doc).unwrap(), "localReceipt":true,
            "revision":service.session().observed_revision().unwrap().to_bytes().to_vec()}));
    };
    apply(
        "cell-content",
        editac_core::commands::editor::EditorCommand::TableCell {
            target: table.clone(),
            expected: yrs::Any::from_json(&original.to_string()).unwrap(),
            row: 1,
            column: 0,
            text: "Updated 🦀 אב".into(),
        },
    );
    apply(
        "preceding-text",
        editac_core::commands::editor::EditorCommand::ReplaceAt {
            owner: before,
            from: Utf16Offset(0),
            to: Utf16Offset(6),
            text: "Before\nExtra line 🦀".into(),
        },
    );
    apply(
        "remove-table",
        editac_core::commands::editor::EditorCommand::Enable {
            target: table.clone(),
            enabled: false,
        },
    );
    apply(
        "restore-table",
        editac_core::commands::editor::EditorCommand::Enable {
            target: table.clone(),
            enabled: true,
        },
    );
    // Shared undo/redo are real durable operations over the same Session.
    for (label, undo) in [("undo-restore", true), ("redo-restore", false)] {
        let revision = service.session().observed_revision().unwrap();
        let receipt = if undo {
            service.undo(&revision, 0)
        } else {
            service.redo(&revision, 0)
        }
        .unwrap()
        .unwrap();
        assert!(service.local_receipt(&receipt.update).unwrap().is_some());
        let doc = service.session().document();
        let patch = doc.last_patch().unwrap();
        steps.push(serde_json::json!({"label":label,"sequence":patch.sequence,
            "patch":editac_core::interchange::projection_patch(&patch),
            "expected":projection_snapshot(doc).unwrap(),"localReceipt":true,
            "revision":service.session().observed_revision().unwrap().to_bytes().to_vec()}));
    }
    let manifest = serde_json::json!({"path":path,"documentId":document_id,"epoch":epoch,
        "expected":expected,"factory":"native/macos/tests/TablesFixture/src/main.rs",
        "providerCalls":0,"table":table,"richTable":rich,"steps":steps,
        "corpus":baseline});
    let manifest_path = root.join("manifest.json");
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    println!("{}", manifest_path.display());
}
