use editac_ffi::{AnchorBias, AnchorInput, NativeEngine, NativeError, abi_version};
use serde_json::{Value, json};
use std::sync::Arc;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/native/fixtures/bounded-abi.json"
    ))
    .unwrap()
}
fn engine(case: &str) -> Arc<NativeEngine> {
    let f = fixture();
    let serial = [
        "unicode",
        "atomic-reject",
        "errors",
        "cancel",
        "replica",
        "threads",
        "version",
    ]
    .iter()
    .position(|name| *name == case)
    .unwrap()
        + 1;
    NativeEngine::create(json!({"profile":f["profile"],"documentId":format!("a8000000-0000-4000-8000-{serial:012}"),"epoch":f["epoch"],"nodes":[{"text":f["initialText"]}]}).to_string()).unwrap()
}
fn snapshot(e: &NativeEngine) -> Value {
    {
        let mut output: Value = serde_json::from_str(&e.read().unwrap()).unwrap();
        // Projection read deltas are observational, not committed document state.
        output.as_object_mut().unwrap().remove("changedNodes");
        output.as_object_mut().unwrap().remove("touchedRanges");
        output
    }
}
fn text(s: &Value) -> String {
    s["visible"][0]["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect()
}
fn anchor(e: &NativeEngine, offset: u32) -> String {
    e.capture_anchor(AnchorInput {
        node: snapshot(e)["visible"][0]["id"].as_str().unwrap().into(),
        offset_utf16: offset,
        bias: AnchorBias::Right,
    })
    .unwrap()
}
fn commands(e: &NativeEngine) -> String {
    let f = fixture();
    let at = anchor(e, 3);
    let end = anchor(e, 6);
    json!({"kind":"editor","origin":"native-fixture","commands":[{"type":"insert","at":at,"text":f["insertText"]},{"type":"insert","at":end,"text":f["suffixText"]}]}).to_string()
}
fn restore(e: &NativeEngine) -> Arc<NativeEngine> {
    let c = e.checkpoint().unwrap();
    let mut input: Value = serde_json::from_str(&c.metadata_json).unwrap();
    input["expected"] = input["identity"].clone();
    input["journal"] = json!([]);
    NativeEngine::restore(input.to_string(), c.bytes).unwrap()
}
#[test]
fn utf16_atomic_batch_detached_patch_and_owned_checkpoint() {
    let f = fixture();
    let e = engine("unicode");
    let initial = snapshot(&e);
    assert!(initial.get("retainedStructure").is_none());
    let end = anchor(&e, 6);
    assert_eq!(
        text(&initial).encode_utf16().count(),
        f["initialUtf16Units"].as_u64().unwrap() as usize
    );
    let c = e.checkpoint().unwrap();
    let old_bytes = c.bytes.clone();
    let result = e.execute_batch(commands(&e)).unwrap();
    let patch: Value = serde_json::from_str(&result.patch_json).unwrap();
    assert_eq!(text(&snapshot(&e)), f["expectedText"]);
    assert_eq!(text(&snapshot(&e)).encode_utf16().count(), 8);
    assert_eq!(patch["version"], 1);
    assert_eq!(patch["sequence"], 1);
    assert_eq!(patch["changedNodes"].as_array().unwrap().len(), 1);
    assert_eq!(patch["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(patch["identity"]["offsets"], "utf16");
    assert_eq!(
        serde_json::from_str::<Value>(&e.resolve_anchor(end).unwrap()).unwrap()["offset"],
        8
    );
    assert_eq!(e.take_patch().unwrap(), "null");
    assert_eq!(c.bytes, old_bytes);
    assert_eq!(text(&initial), f["initialText"]);
    let replica = restore(&e);
    assert_eq!(text(&snapshot(&replica)), f["expectedText"]);
    assert_eq!(snapshot(&replica)["identity"], snapshot(&e)["identity"]);
    assert_ne!(
        serde_json::from_str::<Value>(&replica.checkpoint().unwrap().metadata_json).unwrap()["writerId"],
        serde_json::from_str::<Value>(&e.checkpoint().unwrap().metadata_json).unwrap()["writerId"]
    );
    e.dispose().unwrap();
    assert_eq!(patch["sequence"], 1);
    assert!(!c.bytes.is_empty());
}
#[test]
fn invalid_second_command_rejects_whole_batch_without_patch_or_mutation() {
    let e = engine("atomic-reject");
    let before = snapshot(&e);
    let at = anchor(&e, 3);
    let input = json!({"kind":"editor","origin":"native-fixture","commands":[{"type":"insert","at":at,"text":"X"},{"type":"insert","at":"missing","text":"Y"}]}).to_string();
    assert!(matches!(
        e.execute_batch(input),
        Err(NativeError::InvalidHandle { .. })
    ));
    assert_eq!(snapshot(&e), before);
    assert_eq!(e.take_patch().unwrap(), "null");
}
#[test]
fn surrogate_and_malformed_input_are_typed_pre_mutation_errors() {
    let e = engine("errors");
    let before = snapshot(&e);
    let input = AnchorInput {
        node: before["visible"][0]["id"].as_str().unwrap().into(),
        offset_utf16: 2,
        bias: AnchorBias::Right,
    };
    assert!(matches!(
        e.capture_anchor(input),
        Err(NativeError::EngineRejected { .. })
    ));
    assert!(matches!(
        e.execute_batch("{".into()),
        Err(NativeError::InvalidInput { .. })
    ));
    assert!(matches!(
        e.execute_batch(" ".repeat(2 * 1024 * 1024 + 1)),
        Err(NativeError::ResourceLimit { .. })
    ));
    assert_eq!(snapshot(&e), before);
    assert!(matches!(
        NativeEngine::create("{}".into()),
        Err(NativeError::InvalidInput { .. })
    ));
}
#[test]
fn cancellation_release_and_disposal_are_explicit_and_idempotent() {
    let e = engine("cancel");
    let input = commands(&e);
    let before = snapshot(&e);
    let token = e.prepare_batch(input.clone()).unwrap();
    e.cancel_batch(token.clone()).unwrap();
    e.cancel_batch(token.clone()).unwrap();
    assert!(matches!(
        e.commit_batch(token),
        Err(NativeError::InvalidHandle { .. })
    ));
    assert_eq!(snapshot(&e), before);
    let token = e.prepare_batch(input).unwrap();
    let retained = e.checkpoint().unwrap();
    e.dispose().unwrap();
    e.dispose().unwrap();
    assert!(matches!(e.read(), Err(NativeError::Disposed)));
    assert!(matches!(e.commit_batch(token), Err(NativeError::Disposed)));
    assert!(matches!(
        e.cancel_batch("missing".into()),
        Err(NativeError::Disposed)
    ));
    assert!(!retained.bytes.is_empty());
}
#[test]
fn portable_anchor_update_bytes_and_history_use_real_replica() {
    let e = engine("replica");
    let replica = restore(&e);
    let at = anchor(&e, 3);
    let exported = e.export_anchor(at.clone()).unwrap();
    let imported = replica.import_anchor(exported).unwrap();
    let vector = replica.state_vector().unwrap();
    e.execute_batch(commands(&e)).unwrap();
    let update = e.encode_update(vector).unwrap();
    assert!(!update.is_empty());
    let identity = snapshot(&e)["identity"].to_string();
    let result = replica.apply_update(identity, update).unwrap();
    let patch: Value = serde_json::from_str(&result.patch_json).unwrap();
    assert_eq!(patch["operation"], "Remote");
    assert_eq!(text(&snapshot(&replica)), text(&snapshot(&e)));
    assert_eq!(
        serde_json::from_str::<Value>(&replica.resolve_anchor(imported.clone()).unwrap()).unwrap()
            ["offset"],
        4
    );
    replica.release_anchor(imported.clone()).unwrap();
    assert!(matches!(
        replica.resolve_anchor(imported),
        Err(NativeError::InvalidHandle { .. })
    ));
    let undo = e.history(json!({"type":"undo"}).to_string()).unwrap();
    assert_ne!(undo.patch_json, "null");
    assert_eq!(text(&snapshot(&e)), fixture()["initialText"]);
}
#[test]
fn cross_thread_aliases_serialize_and_final_drop_joins_executor() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<NativeEngine>();
    let e = engine("threads");
    let readers = (0..8)
        .map(|_| {
            let e = Arc::clone(&e);
            std::thread::spawn(move || {
                for _ in 0..8 {
                    assert_eq!(text(&snapshot(&e)), fixture()["initialText"]);
                }
            })
        })
        .collect::<Vec<_>>();
    for reader in readers {
        reader.join().unwrap();
    }
    let at = anchor(&e, 3);
    let writers = (0..8).map(|_| {
        let e = Arc::clone(&e); let at = at.clone();
        std::thread::spawn(move || e.execute_batch(json!({"kind":"editor","origin":"threads","commands":[{"type":"insert","at":at,"text":"X"}]}).to_string()).unwrap())
    }).collect::<Vec<_>>();
    for writer in writers {
        writer.join().unwrap();
    }
    assert_eq!(text(&snapshot(&e)), "A😀XXXXXXXXéZ");
    let alias = Arc::clone(&e);
    e.dispose().unwrap();
    assert!(matches!(alias.checkpoint(), Err(NativeError::Disposed)));
    drop(e);
    drop(alias);
}
#[test]
fn schema_and_generator_versions_are_frozen_and_restore_checks_identity() {
    let v = abi_version();
    assert_eq!(v.abi_version, 1);
    assert_eq!(v.offset_units, "utf16");
    assert_eq!(v.schema, "editac.registry.editor.v5");
    assert_eq!(v.profile, "editac.yrs-yjs.editor.v5");
    assert_eq!(v.update_encoding, 1);
    assert_eq!(v.uniffi_version, "0.32.2");
    let e = engine("version");
    let c = e.checkpoint().unwrap();
    let mut input: Value = serde_json::from_str(&c.metadata_json).unwrap();
    input["expected"] = input["identity"].clone();
    input["expected"]["offsets"] = json!("utf8");
    input["journal"] = json!([]);
    assert!(matches!(
        NativeEngine::restore(input.to_string(), c.bytes),
        Err(NativeError::EngineRejected { .. })
    ));
}
