//! Deterministic real-byte fixture and compiled-WASM replay driver.
use crate::bridge::Bridge;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
fn create(key: u64) -> Bridge {
    Bridge::create(&json!({"profile":"v5","documentId":format!("12345678-1234-4234-8234-{key:012x}"),"epoch":"23456789-2345-4345-8345-23456789abcd","nodes":[{"text":"a😀b"},{"text":"é👩‍💻אב"}]}).to_string()).unwrap()
}
fn restored(c: &Value, journal: &[Value]) -> Bridge {
    Bridge::restore(&json!({"expected":c["identity"],"identity":c["identity"],"initialized":c["initialized"],"writerId":c["writerId"],"journal":journal}).to_string(), &data(&c["bytes"])).unwrap()
}
fn data(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|v| u8::try_from(v.as_u64().unwrap()).unwrap())
        .collect()
}
fn checkpoint(b: &Bridge) -> Value {
    let mut c = b.checkpoint_metadata();
    c["bytes"] = json!(b.checkpoint_bytes());
    c
}
fn semantic(mut s: Value) -> Value {
    for k in ["revision", "changedNodes", "touchedRanges"] {
        s.as_object_mut().unwrap().remove(k);
    }
    s
}
fn insert(b: &mut Bridge, at: u32, text: &str) -> Value {
    let id = b.read().unwrap()["visible"][0]["id"].clone();
    let a = b
        .capture(&json!({"node":id,"offset":at,"bias":"right"}).to_string())
        .unwrap();
    let p=b.prepare(&json!({"kind":"text","origin":"updates:explicit","command":{"type":"insert","at":a["token"],"text":text}}).to_string()).unwrap();
    b.commit(p["token"].as_str().unwrap()).unwrap();
    b.take_patch()["update"].clone()
}
#[test]
fn native_updates_checkpoint_and_replay() {
    let mut b = create(1);
    let c = checkpoint(&b);
    let initial = b.read().unwrap();
    let mut replica = restored(&c, &[]);
    assert_ne!(
        b.checkpoint_metadata()["writerId"],
        replica.checkpoint_metadata()["writerId"]
    );
    let first = insert(&mut b, 3, "X");
    let second = insert(&mut b, 4, "Y");
    // Full bounded restore merges out-of-order dependent journal structs.
    let replay = restored(&c, &[second.clone(), first.clone(), first.clone()]);
    assert_eq!(
        semantic(replay.read().unwrap()),
        semantic(b.read().unwrap())
    );
    replica
        .apply(&first["identity"].to_string(), &data(&first["bytes"]))
        .unwrap();
    replica
        .apply(&second["identity"].to_string(), &data(&second["bytes"]))
        .unwrap();
    let revision = replica.read().unwrap()["revision"].clone();
    replica
        .apply(&first["identity"].to_string(), &data(&first["bytes"]))
        .unwrap();
    assert_eq!(replica.read().unwrap()["revision"], revision);
    assert_eq!(
        semantic(replica.read().unwrap()),
        semantic(b.read().unwrap())
    );
    assert_eq!(b.read().unwrap()["visible"][0]["runs"][0]["text"], "a😀XYb");
    if let Some(dir) = std::env::var_os("EDITAC_WASM_UPDATE_OUTPUT") {
        let p = PathBuf::from(dir);
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("native-fixture.json"),serde_json::to_vec_pretty(&json!({"checkpoint":c,"initial":initial,"journal":[first,second],"snapshot":b.read().unwrap()})).unwrap()).unwrap();
    }
}
#[test]
fn native_updates_vectors_diffs_and_delete_sets() {
    let mut a = create(2);
    let mut b = restored(&checkpoint(&a), &[]);
    let vector = b.state_vector();
    insert(&mut a, 1, "Z");
    let diff = a.update(&vector).unwrap();
    b.apply(&a.checkpoint_metadata()["identity"].to_string(), &diff)
        .unwrap();
    assert_eq!(semantic(a.read().unwrap()), semantic(b.read().unwrap()));
    for bad in [vec![], vec![0, 0], vec![255, 255, 255, 255, 15], vec![1, 0]] {
        assert!(a.update(&bad).is_err());
    }
    let bytes = a.checkpoint_bytes();
    assert_eq!(a.update(&[0]).unwrap(), bytes);
}
#[test]
fn native_updates_rejections_are_atomic() {
    let mut b = create(3);
    let c = checkpoint(&b);
    let before = b.doc_state();
    let mut wrong = c["identity"].clone();
    wrong["epoch"] = json!("34567890-3456-4456-8456-34567890abcd");
    assert!(b.apply(&wrong.to_string(), &b.checkpoint_bytes()).is_err());
    for bad in [vec![], vec![255], vec![0, 0, 0]] {
        assert!(b.apply(&c["identity"].to_string(), &bad).is_err());
        assert_eq!(b.doc_state().0, before.0);
        assert_eq!(b.doc_state().1, before.1);
        assert_eq!(b.doc_state().2, before.2);
        assert!(b.take_patch().is_null());
    }
    let mut invalid = c.clone();
    invalid["initialized"] = json!(false);
    assert!(Bridge::restore(&json!({"expected":invalid["identity"],"identity":invalid["identity"],"initialized":false,"writerId":invalid["writerId"],"journal":[]}).to_string(),&data(&c["bytes"])).is_err());
}
#[test]
fn native_updates_patch_drain_is_once_per_commit() {
    let mut b = create(4);
    assert!(b.take_patch().is_null());
    insert(&mut b, 1, "Z");
    assert!(b.take_patch().is_null());
    b.history(r#"{"type":"undo"}"#).unwrap();
    let p = b.take_patch();
    assert_eq!(p["operation"], "Undo");
    assert_eq!(p["sequence"], 2);
    assert!(!p["update"].is_null());
    assert!(b.take_patch().is_null());
    b.history(r#"{"type":"state"}"#).unwrap();
    assert!(b.take_patch().is_null());
}
#[test]
fn native_updates_reverse_replay() {
    // The standalone native check proves its own loop. The canonical JS suite
    // supplies actual compiled-WASM bytes and snapshots through this same driver.
    let (fixture, transport) = if let Some(file) = std::env::var_os("EDITAC_WASM_REPLAY_INPUT") {
        (
            serde_json::from_slice::<Value>(&fs::read(file).unwrap()).unwrap(),
            "built-wasm",
        )
    } else {
        let mut b = create(5);
        let c = checkpoint(&b);
        insert(&mut b, 1, "W");
        (
            json!({"checkpoint":c,"update":{"identity":b.checkpoint_metadata()["identity"],"bytes":b.update(&[0]).unwrap()},"snapshot":b.read().unwrap()}),
            "native-loop",
        )
    };
    let mut b = restored(&fixture["checkpoint"], &[]);
    b.apply(
        &fixture["update"]["identity"].to_string(),
        &data(&fixture["update"]["bytes"]),
    )
    .unwrap();
    assert_eq!(
        semantic(b.read().unwrap()),
        semantic(fixture["snapshot"].clone())
    );
    let from_journal = restored(
        &fixture["checkpoint"],
        std::slice::from_ref(&fixture["update"]),
    );
    assert_eq!(
        semantic(from_journal.read().unwrap()),
        semantic(fixture["snapshot"].clone())
    );
    if let Some(dir) = std::env::var_os("EDITAC_WASM_UPDATE_OUTPUT") {
        fs::write(
            PathBuf::from(dir).join(format!("{transport}-replay.json")),
            serde_json::to_vec_pretty(&b.read().unwrap()).unwrap(),
        )
        .unwrap();
    }
}
