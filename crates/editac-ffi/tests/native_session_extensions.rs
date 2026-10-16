//! Real shared planner, one SQLite-backed Session, exact revisions and history.
use editac_core::{
    commands::{editor::EditorCommand, text::TextOrigin},
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    modules::content::Content,
};
use editac_ffi::*;
use editac_session::{
    ports::{CheckpointRecord, LocalStore, StoreLimits},
    store::NativeStore,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

fn registry(version: u32) -> String {
    json!([{"type":"fixture.note","version":version,"kind":"mark",
        "attributes":{"label":{"type":"string","required":true,"maxUtf16":32}},
        "content":{"type":"text","maxUtf16":32},"fallback":{"type":"text","source":"content"}},
        {"type":"fixture.atom","version":1,"kind":"inline-atom","attributes":{},
        "content":{"type":"text","maxUtf16":32},"fallback":{"type":"text","source":"content"}}])
    .to_string()
}
struct Fixture {
    options: NativeSessionOptions,
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!("extension-api-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        Self {
            options: NativeSessionOptions {
                path: directory.join("session.sqlite").to_string_lossy().into(),
                document_id: format!("ac120000-0000-4000-8000-{n:012x}"),
                epoch: "ac130000-0000-4000-8000-000000000001".into(),
                writable: true,
                permission_expires_at: None,
            },
            directory,
        }
    }
    fn create(&self, version: u32) -> std::sync::Arc<NativeSession> {
        NativeSession::create_local_with_registry(
            self.options.clone(),
            vec![NativeSessionSeed {
                kind: "block".into(),
                text: "A🦀B".into(),
            }],
            registry(version),
        )
        .unwrap()
    }
    fn atom(&self, type_name: &str, version: u32) -> std::sync::Arc<NativeSession> {
        let id = DocumentIdentity::v5(&self.options.document_id, &self.options.epoch).unwrap();
        let mut d = Document::create(
            CreationPermit::authorize_new(id.clone()).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "original".into(),
            }],
        )
        .unwrap();
        let target = d.snapshot().unwrap().visible[0].id.clone();
        let data = yrs::Any::from_json(&json!({"version":1,"type":type_name,"dataVersion":version,"payload":{"unknown":[1,"retain"]},"source":"\\bad{"}).to_string()).unwrap();
        let p = d
            .prepare_editor(
                &[EditorCommand::Content {
                    target,
                    content: Content::InertExtension { data },
                }],
                &TextOrigin::new("seed").unwrap(),
            )
            .unwrap();
        d.commit_editor(p).unwrap();
        let store =
            NativeStore::create_new(&self.options.path, id, StoreLimits::default()).unwrap();
        store
            .publish(0, CheckpointRecord::new(d.checkpoint(), vec![]).unwrap())
            .unwrap();
        drop(d);
        drop(store);
        NativeSession::open_with_registry(self.options.clone(), registry(1)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
fn snapshot(s: &NativeSession) -> Value {
    let mut value: Value = serde_json::from_str(&s.rich_snapshot().unwrap().snapshot_json).unwrap();
    // Read-drained notification metadata is not document state. Assert the full
    // retained document, visible sources, identity and revision below.
    value.as_object_mut().unwrap().remove("changedNodes");
    value.as_object_mut().unwrap().remove("touchedRanges");
    value
}
fn plan(s: &NativeSession, commands: Value) -> Result<NativePreparedCommands, NativeSessionError> {
    s.prepare_commands(
        s.read(0).unwrap().revision.unwrap(),
        commands.to_string(),
        "extension-test".into(),
        0,
    )
}
fn mark(s: &NativeSession, version: u32) -> Value {
    json!({"type":"customMarkAt","owner":s.read(0).unwrap().nodes[0].id,"from":1,"to":3,"key":"module:fixture.note","value":[version,{"label":"highlight"}]})
}
fn apply(s: &NativeSession, commands: Value) -> NativeSessionCommit {
    s.commit_commands(plan(s, commands).unwrap().token, 0)
        .unwrap()
        .unwrap()
}
fn at(s: &NativeSession, offset: u32) -> String {
    s.capture_anchors(
        s.read(0).unwrap().revision.unwrap(),
        vec![AnchorInput {
            node: s.read(0).unwrap().nodes[0].id.clone(),
            offset_utf16: offset,
            bias: AnchorBias::Right,
        }],
    )
    .unwrap()[0]
        .token
        .clone()
}
fn source(s: &NativeSession, text: &str) -> Value {
    let tuple = snapshot(s)["visible"][0]["blockAttributes"].clone();
    json!({"type":"extensionSource","owner":s.read(0).unwrap().nodes[0].id,"at":at(s,0),"expected":tuple,"source":text})
}
fn unchanged(s: &NativeSession, before: &Value, revision: &[u8]) {
    assert_eq!(&snapshot(s), before);
    assert_eq!(s.read(0).unwrap().revision.as_deref(), Some(revision));
}

#[test]
fn registry_is_validated_atomically_before_store_creation() {
    let f = Fixture::new();
    let definitions: Value = serde_json::from_str(&registry(1)).unwrap();
    let duplicated = json!([definitions[0], definitions[0]]).to_string();
    assert!(
        NativeSession::create_local_with_registry(f.options.clone(), vec![], duplicated).is_err()
    );
    assert!(!PathBuf::from(&f.options.path).exists());
    let s = f.create(1);
    s.dispose().unwrap();
}
#[test]
fn registered_mark_is_one_durable_history_group_and_survives_reopen() {
    let f = Fixture::new();
    let s = f.create(1);
    s.set_extension_policy(true).unwrap();
    let before = snapshot(&s);
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    assert_eq!(snapshot(&s), before);
    let c = s.commit_commands(p.token.clone(), 0).unwrap().unwrap();
    assert_eq!(c.sequence, 1);
    assert!(s.commit_commands(p.token, 0).is_err());
    let after = snapshot(&s);
    assert_eq!(
        after["visible"][0]["runs"][1]["attributes"]["module:fixture.note"],
        json!([1,{"label":"highlight"}])
    );
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    s.undo(s.read(0).unwrap().revision.unwrap(), 0).unwrap();
    assert_eq!(snapshot(&s)["visible"], before["visible"]);
    s.redo(s.read(0).unwrap().revision.unwrap(), 0).unwrap();
    s.dispose().unwrap();
    let reopened = NativeSession::open_with_registry(f.options.clone(), registry(1)).unwrap();
    assert_eq!(snapshot(&reopened)["visible"], after["visible"]);
    reopened.dispose().unwrap();
}
#[test]
fn custom_mark_batches_reject_invalid_ranges_envelopes_and_later_commands_atomically() {
    let f = Fixture::new();
    let s = f.create(1);
    s.set_extension_policy(true).unwrap();
    let before = snapshot(&s);
    let r = s.read(0).unwrap().revision.unwrap();
    for field in ["surrogate", "owner", "key", "version", "payload"] {
        let mut cmd = mark(&s, 1);
        match field {
            "surrogate" => cmd["from"] = json!(2),
            "owner" => cmd["owner"] = json!("foreign"),
            "key" => cmd["key"] = json!("bold"),
            "version" => cmd["value"][0] = json!(2),
            _ => cmd["value"][1]["label"] = json!("x".repeat(33)),
        }
        assert!(plan(&s, json!([mark(&s, 1), cmd])).is_err(), "{field}");
        unchanged(&s, &before, &r);
    }
    assert_eq!(s.history_state(0).unwrap().undo_groups, 0);
    s.dispose().unwrap();
}
#[test]
fn unknown_future_mark_envelopes_cannot_be_overwritten_or_removed() {
    let f = Fixture::new();
    let s = f.create(2);
    s.set_extension_policy(true).unwrap();
    apply(&s, json!([mark(&s, 2)]));
    s.dispose().unwrap();
    let s = NativeSession::open_with_registry(f.options.clone(), registry(1)).unwrap();
    s.set_extension_policy(true).unwrap();
    let before = snapshot(&s);
    let r = s.read(0).unwrap().revision.unwrap();
    assert!(plan(&s, json!([mark(&s, 1)])).is_err());
    let mut remove = mark(&s, 1);
    remove["value"] = Value::Null;
    assert!(plan(&s, json!([remove])).is_err());
    unchanged(&s, &before, &r);
    s.dispose().unwrap();
}
#[test]
fn plans_recheck_policy_permission_revision_cancellation_and_disposal() {
    let f = Fixture::new();
    let s = f.create(1);
    assert!(plan(&s, json!([mark(&s, 1)])).is_err());
    s.set_extension_policy(true).unwrap();
    let before = snapshot(&s);
    let r = s.read(0).unwrap().revision.unwrap();
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    s.set_extension_policy(false).unwrap();
    assert!(s.commit_commands(p.token, 0).is_err());
    unchanged(&s, &before, &r);
    s.set_extension_policy(true).unwrap();
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    s.set_permission(false, None).unwrap();
    assert!(s.commit_commands(p.token, 0).is_err());
    unchanged(&s, &before, &r);
    s.set_permission(true, None).unwrap();
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    s.cancel_commands(p.token.clone()).unwrap();
    assert!(s.commit_commands(p.token, 0).is_err());
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    apply(
        &s,
        json!([{"type":"replaceAt","owner":s.read(0).unwrap().nodes[0].id,"from":0,"to":0,"text":"prefix"}]),
    );
    assert!(s.commit_commands(p.token, 0).is_err());
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    s.set_permission(true, Some(1)).unwrap();
    assert!(s.commit_commands(p.token, 1).is_err());
    s.set_permission(true, None).unwrap();
    let p = plan(&s, json!([mark(&s, 1)])).unwrap();
    s.dispose().unwrap();
    assert!(s.commit_commands(p.token, 0).is_err());
}
#[test]
fn math_and_unknown_atom_source_edit_preserves_payload_and_invalid_source_with_history() {
    for (name, version) in [("editac.math", 1), ("future.atom", 7)] {
        let f = Fixture::new();
        let s = f.atom(name, version);
        s.set_extension_policy(true).unwrap();
        let before = snapshot(&s);
        let cmd = source(&s, "\\still-invalid{");
        apply(&s, json!([cmd]));
        let after = snapshot(&s);
        assert_eq!(s.read(0).unwrap().nodes[0].text, "\\still-invalid{");
        let old = &before["visible"][0]["blockAttributes"];
        let new = &after["visible"][0]["blockAttributes"];
        assert_eq!(old[2]["payload"], new[2]["payload"]);
        assert_eq!(old[2]["dataVersion"], new[2]["dataVersion"]);
        s.undo(s.read(0).unwrap().revision.unwrap(), 0).unwrap();
        assert_eq!(snapshot(&s)["visible"], before["visible"]);
        s.redo(s.read(0).unwrap().revision.unwrap(), 0).unwrap();
        s.dispose().unwrap();
        let reopened = NativeSession::open(f.options.clone()).unwrap();
        assert_eq!(snapshot(&reopened)["visible"], after["visible"]);
        reopened.dispose().unwrap();
    }
}
#[test]
fn source_edit_requires_exact_tuple_source_owned_anchor_and_bounded_source() {
    let f = Fixture::new();
    let s = f.atom("editac.math", 1);
    s.set_extension_policy(true).unwrap();
    let f2 = Fixture::new();
    let other = f2.atom("editac.math", 1);
    let before = snapshot(&s);
    let r = s.read(0).unwrap().revision.unwrap();
    for field in ["tuple", "offset", "foreign", "limit"] {
        let mut cmd = source(&s, "new");
        match field {
            "tuple" => cmd["expected"][2]["source"] = json!("stale"),
            "offset" => cmd["at"] = json!(at(&s, 1)),
            "foreign" => cmd["at"] = json!(at(&other, 0)),
            _ => cmd["source"] = json!("x".repeat(8193)),
        }
        assert!(plan(&s, json!([cmd])).is_err(), "{field}");
        unchanged(&s, &before, &r);
    }
    let cmd = source(&s, "pending");
    let p = plan(&s, json!([cmd])).unwrap();
    s.set_extension_policy(false).unwrap();
    assert!(s.commit_commands(p.token, 0).is_err());
    unchanged(&s, &before, &r);
    s.dispose().unwrap();
    other.dispose().unwrap();
}
#[test]
fn registered_inline_atom_and_mark_removal_use_existing_history_and_policy() {
    let f = Fixture::new();
    let s = f.create(1);
    s.set_extension_policy(true).unwrap();
    let mut cmd = mark(&s, 1);
    cmd["key"] = json!("module:fixture.atom");
    cmd["value"] = json!([1, {}]);
    apply(&s, json!([cmd.clone()]));
    cmd["value"] = Value::Null;
    apply(&s, json!([cmd]));
    let clean = snapshot(&s);
    assert!(
        clean["visible"][0]["runs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["attributes"].get("module:fixture.atom").is_none())
    );
    s.set_extension_policy(false).unwrap();
    assert!(s.undo(s.read(0).unwrap().revision.unwrap(), 0).is_err());
    assert_eq!(snapshot(&s), clean);
    s.set_extension_policy(true).unwrap();
    assert!(
        s.undo(s.read(0).unwrap().revision.unwrap(), 0)
            .unwrap()
            .is_some()
    );
    s.dispose().unwrap();
}

#[test]
fn generated_swift_fixture_preserves_actual_math_store() {
    let f = Fixture::new();
    let s = f.atom("editac.math", 1);
    assert_eq!(
        snapshot(&s)["visible"][0]["blockAttributes"][2]["source"],
        json!("\\bad{")
    );
    s.dispose().unwrap();
    if let Some(root) = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE") {
        std::fs::write(
            PathBuf::from(root).join("swift-fixture.json"),
            json!({
                "path":f.options.path,"documentId":f.options.document_id,"epoch":f.options.epoch,
                "registry":registry(1),"directory":f.directory,
            })
            .to_string(),
        )
        .unwrap();
    }
}

#[test]
fn atomic_inert_edit_cannot_change_payload_and_removal_is_undoable() {
    let f = Fixture::new();
    let s = f.atom("future.atom", 9);
    s.set_extension_policy(true).unwrap();
    let before = snapshot(&s);
    let expected = before["visible"][0]["blockAttributes"].clone();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let anchor = at(&s, 0);
    let mut replacement = expected.clone();
    replacement[2]["payload"] = json!({"rewritten":true});
    let mut command = json!({"type":"atomicContent","owner":owner,"at":anchor,"expected":expected,"replacement":replacement});
    assert!(plan(&s, json!([command.clone()])).is_err());
    assert_eq!(snapshot(&s), before);
    command["replacement"] = Value::Null;
    apply(&s, json!([command]));
    assert_eq!(s.read(0).unwrap().nodes[0].text, "");
    assert_eq!(
        snapshot(&s)["visible"][0]["blockAttributes"],
        json!(["paragraph"])
    );
    s.undo(s.read(0).unwrap().revision.unwrap(), 0).unwrap();
    assert_eq!(snapshot(&s)["visible"], before["visible"]);
    s.dispose().unwrap();
}
