//! EXT-1.5 owning prepared-command/history boundary; deterministic local/remote edits.
use editac_core::{
    Utf16Offset as U,
    commands::{editor::EditorCommand, text::TextOrigin},
    document::{CreationPermit, Document, DocumentIdentity, InitialNode, ReplayUpdate},
    history::{HistoryConfig, HistoryGroup},
};
use serde_json::{Value, json};
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/extensions/commands/conformance.json"
    ))
    .unwrap()
}
fn blank() -> Document {
    static CHECKPOINT: std::sync::OnceLock<editac_core::document::InitializedCheckpoint> =
        std::sync::OnceLock::new();
    let cp = CHECKPOINT.get_or_init(|| {
        let identity = DocumentIdentity::v5(
            "71000000-0000-4000-8000-000000000005",
            "72000000-0000-4000-8000-000000000005",
        )
        .unwrap();
        Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "a😀b".into(),
            }],
        )
        .unwrap()
        .checkpoint()
    });
    let mut d = Document::restore(&cp.identity, cp, &[]).unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn owner(d: &Document) -> String {
    d.snapshot().unwrap().visible[0].id.clone()
}
fn text(d: &Document) -> String {
    d.snapshot().unwrap().visible[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
fn command(d: &Document, from: u32, to: u32, value: &str) -> EditorCommand {
    EditorCommand::ReplaceAt {
        owner: owner(d),
        from: U(from),
        to: U(to),
        text: value.into(),
    }
}
fn origin() -> TextOrigin {
    TextOrigin::new("extension:fixture").unwrap()
}
fn write(name: &str, d: &Document, observations: Value) {
    assert!(
        corpus()["cases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == name)
    );
    let path = std::path::PathBuf::from(
        std::env::var("EDITAC_EXTENSION_COMMANDS_OUTPUT")
            .expect("unique worktree-owned EDITAC_EXTENSION_COMMANDS_OUTPUT required"),
    );
    std::fs::create_dir_all(&path).unwrap();
    let cp = d.checkpoint();
    let i = &cp.identity;
    std::fs::write(path.join(format!("{name}.bin")), &cp.bytes).unwrap();
    std::fs::write(path.join(format!("{name}.json")),serde_json::to_vec(&json!({"identity":{"profile":i.profile,"schema":i.schema,"documentId":i.document_id,"epoch":i.epoch,"protocolVersion":1,"updateEncoding":1,"offsets":"utf16"},"writerId":cp.writer_id,"text":text(d),"undoGroups":d.history_state().undo_groups,"observations":observations})).unwrap()).unwrap();
}
#[test]
fn preparation_applicability_and_one_intent_history() {
    let mut d = blank();
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    let commands = [command(&d, 1, 3, "table"), command(&d, 6, 6, "!")];
    d.can_editor(&commands, &origin()).unwrap();
    let p = d.prepare_editor(&commands, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), revision);
    assert_eq!(d.history_state().undo_groups, 0);
    d.set_history_group(HistoryGroup::Explicit);
    d.commit_editor(p).unwrap();
    d.reset_history_group();
    assert_eq!(text(&d), "atable!b");
    assert_eq!(d.history_state().undo_groups, 1);
    assert_eq!(d.revision(), revision + 1);
    assert!(d.undo().unwrap().is_some());
    assert_eq!(text(&d), "a😀b");
    assert!(d.redo().unwrap().is_some());
    assert_eq!(text(&d), "atable!b");
    write(
        "CMD-prepare-commit-history",
        &d,
        json!({"commits":1,"undo":1,"redo":1}),
    );
}
#[test]
fn invalid_batch_and_discarded_preparation_are_atomic() {
    let d = blank();
    let before = d.checkpoint().bytes;
    let commands = [
        command(&d, 0, 1, "changed"),
        command(&d, 999, 999, "invalid"),
    ];
    assert!(d.can_editor(&commands, &origin()).is_err());
    assert!(d.prepare_editor(&commands, &origin()).is_err());
    drop(
        d.prepare_editor(&[command(&d, 0, 1, "unused")], &origin())
            .unwrap(),
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 0);
    write("CMD-invalid-atomic", &d, json!({"commits":0}));
}
#[test]
fn local_change_rejects_old_plan_before_mutation() {
    let mut d = blank();
    let stale = d
        .prepare_editor(&[command(&d, 0, 1, "stale")], &origin())
        .unwrap();
    let p = d
        .prepare_editor(&[command(&d, 0, 1, "fresh")], &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    let before = d.checkpoint().bytes;
    assert!(d.commit_editor(stale).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(text(&d), "fresh😀b");
    write(
        "CMD-stale-local",
        &d,
        json!({"commits":1,"staleRejected":true}),
    );
}
#[test]
fn remote_origin_is_not_local_history_and_invalidates_preparation() {
    let mut d = blank();
    let cp = d.checkpoint();
    let mut peer = Document::restore(&cp.identity, &cp, &[]).unwrap();
    let stale = d
        .prepare_editor(&[command(&d, 0, 1, "stale")], &origin())
        .unwrap();
    let p = peer
        .prepare_editor(&[command(&peer, 4, 4, "R")], &origin())
        .unwrap();
    peer.commit_editor(p).unwrap();
    d.apply_replay(&ReplayUpdate {
        identity: cp.identity,
        bytes: peer.checkpoint().bytes,
    })
    .unwrap();
    let before = d.checkpoint().bytes;
    assert!(d.commit_editor(stale).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 0);
    let p = d
        .prepare_editor(&[command(&d, 0, 1, "local")], &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    d.undo().unwrap();
    assert_eq!(text(&d), "a😀bR");
    write(
        "CMD-remote-history",
        &d,
        json!({"remote":1,"undoPreservesRemote":true}),
    );
}
