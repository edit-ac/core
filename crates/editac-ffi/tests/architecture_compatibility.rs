//! FIT-1.5: immutable persisted bytes through public Rust and native boundaries.
use editac_core::{
    document::{Document, DocumentError, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
    modules::v1::{Registry, RegistryError},
};
use editac_ffi::{NativeEngine, abi_version};
use serde_json::{Value, json};
use std::path::PathBuf;
use yrs::Any;

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/compatibility")
}
fn metadata(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(directory().join(format!("{name}.json"))).unwrap())
        .unwrap()
}
fn identity(v: &Value) -> DocumentIdentity {
    DocumentIdentity {
        profile: v["profile"].as_str().unwrap().into(),
        schema: v["schema"].as_str().unwrap().into(),
        protocol_version: v["protocolVersion"].as_u64().unwrap() as u32,
        update_encoding: v["updateEncoding"].as_u64().unwrap() as u32,
        offsets: v["offsets"].as_str().unwrap().into(),
        document_id: v["documentId"].as_str().unwrap().into(),
        epoch: v["epoch"].as_str().unwrap().into(),
    }
}
fn checkpoint(name: &str) -> InitializedCheckpoint {
    let m = metadata(name);
    InitializedCheckpoint {
        identity: identity(&m["identity"]),
        initialized: true,
        writer_id: m["writerId"].as_u64().unwrap() as u32,
        bytes: std::fs::read(directory().join(format!("{name}.bin"))).unwrap(),
    }
}
fn journal(name: &str) -> ReplayUpdate {
    ReplayUpdate {
        identity: checkpoint(name).identity,
        bytes: std::fs::read(directory().join(format!("{name}-journal.bin"))).unwrap(),
    }
}
fn recover(name: &str) {
    let c = checkpoint(name);
    let d = Document::restore(&c.identity, &c, &[journal(name)]).unwrap();
    let s = d.snapshot().unwrap();
    let texts: Vec<String> = s
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.runs.iter().map(|r| r.text.as_str()).collect())
        .collect();
    assert_eq!(json!(texts), metadata(name)["expectedTexts"]);
    assert!(s.visible.iter().flat_map(|n| &n.runs).any(|r| {
        r.attributes
            .get("ext:future")
            .map(editac_core::interchange::value)
            == Some(json!({"retained":true}))
    }));
    assert!(s.visible.iter().flat_map(|n| &n.runs).any(|r| {
        r.attributes
            .get("module:future.unknown")
            .map(editac_core::interchange::value)
            == Some(json!([37,{"nested":["keep",{"value":9}]}]))
    }));
    let saved = d.checkpoint();
    let reopened = Document::restore(&saved.identity, &saved, &[]).unwrap();
    assert_eq!(reopened.snapshot().unwrap().visible, s.visible);
    assert_eq!(c.bytes, checkpoint(name).bytes);
}
#[test]
fn legacy_v4_public_rust_reader_recovers_owned_unknown_data_and_journal() {
    recover("v4");
}
#[test]
fn current_v5_public_rust_reader_recovers_owned_unknown_data_and_journal() {
    recover("v5");
}
#[test]
fn persisted_newer_schema_rollback_rejects_without_touching_original() {
    let c = checkpoint("v5");
    assert!(matches!(
        Document::restore(&checkpoint("v4").identity, &c, &[]),
        Err(DocumentError::UnsupportedProfile)
    ));
    assert_eq!(c.bytes, checkpoint("v5").bytes);
    recover("v5"); // Original remains usable with matching reader.
}
#[test]
fn older_schema_upgrade_rejects_without_implicit_migration() {
    let c = checkpoint("v4");
    assert!(matches!(
        Document::restore(&checkpoint("v5").identity, &c, &[]),
        Err(DocumentError::UnsupportedProfile)
    ));
    recover("v4");
}
#[test]
fn relabeling_newer_persisted_schema_is_not_rollback() {
    let mut c = checkpoint("v5");
    c.identity = checkpoint("v4").identity;
    assert!(Document::restore(&c.identity, &c, &[]).is_err());
    assert_eq!(c.bytes, checkpoint("v5").bytes);
}
#[test]
fn unsupported_wire_tuples_reject_before_applying_acknowledged_bytes() {
    let c = checkpoint("v5");
    let mut d = Document::restore(&c.identity, &c, &[]).unwrap();
    for field in ["protocol", "encoding", "offsets", "schema", "profile"] {
        let mut update = journal("v5");
        match field {
            "protocol" => update.identity.protocol_version = 2,
            "encoding" => update.identity.update_encoding = 2,
            "offsets" => update.identity.offsets = "utf8".into(),
            "profile" => update.identity.profile = "editac.yrs-yjs.editor.v6".into(),
            _ => update.identity.schema = "editac.registry.editor.v6".into(),
        }
        let before = d.checkpoint().bytes;
        let vector = d.state_vector_v1();
        assert!(matches!(
            d.apply_replay(&update),
            Err(DocumentError::UnsupportedProfile)
        ));
        assert_eq!(d.checkpoint().bytes, before);
        assert_eq!(d.state_vector_v1(), vector);
    }
    d.apply_replay(&journal("v5")).unwrap();
}
fn native_input(name: &str) -> Value {
    let m = metadata(name);
    json!({"identity":m["identity"],"expected":m["identity"],"initialized":true,"writerId":m["writerId"],
        "journal":[{"identity":m["identity"],"bytes":journal(name).bytes}]})
}
#[test]
fn real_native_abi_recovers_and_exports_checkpoint_for_public_js() {
    let m = metadata("v5");
    let e = NativeEngine::restore(native_input("v5").to_string(), checkpoint("v5").bytes).unwrap();
    let view: Value = serde_json::from_str(&e.read().unwrap()).unwrap();
    assert_eq!(view["identity"], m["identity"]);
    let c = e.checkpoint().unwrap();
    let mut input: Value = serde_json::from_str(&c.metadata_json).unwrap();
    input["expected"] = input["identity"].clone();
    input["journal"] = json!([]);
    let restored = NativeEngine::restore(input.to_string(), c.bytes.clone()).unwrap();
    let reopened: Value = serde_json::from_str(&restored.read().unwrap()).unwrap();
    assert_eq!(reopened["visible"], view["visible"]);
    let abi = abi_version();
    assert_eq!(abi.abi_version, 1);
    assert_eq!(abi.update_encoding, 1);
    assert_eq!(abi.schema, m["identity"]["schema"]);
    assert_eq!(abi.profile, m["identity"]["profile"]);
    assert_eq!(abi.offset_units, "utf16");
    assert_eq!(abi.uniffi_version, "0.32.2");
    let output = PathBuf::from(
        std::env::var("EDITAC_COMPATIBILITY_OUTPUT").expect("isolated proof directory required"),
    );
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(output.join("native.bin"), c.bytes).unwrap();
    std::fs::write(output.join("native.json"), c.metadata_json).unwrap();
    std::fs::write(
        output.join("native-visible.json"),
        view["visible"].to_string(),
    )
    .unwrap();
    e.dispose().unwrap();
    restored.dispose().unwrap();
}
#[test]
fn native_sdk_rejects_legacy_and_future_identity_without_relabeling() {
    for name in ["v4", "v5"] {
        let mut input = native_input(name);
        if name == "v5" {
            input["expected"]["schema"] = json!("editac.registry.editor.v6");
        }
        assert!(NativeEngine::restore(input.to_string(), checkpoint(name).bytes).is_err());
    }
}
#[test]
fn native_wire_rejection_preserves_checkpoint_and_reopens_original() {
    let m = metadata("v5");
    let e = NativeEngine::restore(native_input("v5").to_string(), checkpoint("v5").bytes).unwrap();
    let before = e.checkpoint().unwrap();
    let vector = e.state_vector().unwrap();
    for field in [
        "protocolVersion",
        "updateEncoding",
        "offsets",
        "schema",
        "profile",
    ] {
        let mut wrong = m["identity"].clone();
        wrong[field] = if matches!(field, "protocolVersion" | "updateEncoding") {
            json!(2)
        } else {
            json!("future")
        };
        assert!(
            e.apply_update(wrong.to_string(), journal("v5").bytes)
                .is_err()
        );
        assert_eq!(e.checkpoint().unwrap().bytes, before.bytes);
        assert_eq!(e.state_vector().unwrap(), vector);
    }
    let mut input: Value = serde_json::from_str(&before.metadata_json).unwrap();
    input["expected"] = input["identity"].clone();
    input["journal"] = json!([]);
    let reopened = NativeEngine::restore(input.to_string(), before.bytes).unwrap();
    assert_eq!(reopened.read().unwrap(), e.read().unwrap());
    e.dispose().unwrap();
    reopened.dispose().unwrap();
}
#[test]
fn descriptor_versions_are_opaque_or_reject_registration_without_mutation() {
    let f: Value =
        serde_json::from_slice(&std::fs::read(directory().join("descriptor.json")).unwrap())
            .unwrap();
    let definition = Any::from_json(&f["definition"].to_string()).unwrap();
    let mut registry = Registry::default();
    registry.register(&definition).unwrap();
    let mut future = f["definition"].clone();
    future["version"] = json!(2);
    assert_eq!(
        registry.register(&Any::from_json(&future.to_string()).unwrap()),
        Err(RegistryError::Incompatible)
    );
    let frozen = registry.freeze();
    assert_eq!(frozen.len(), 1);
    let key = format!("module:{}", f["definition"]["type"].as_str().unwrap());
    let future = Any::from_json(&f["future"].to_string()).unwrap();
    assert!(frozen.resolve(&key, &future, "label").unwrap().is_none());
    let unknown = Any::from_json(&f["unknown"].to_string()).unwrap();
    assert!(
        frozen
            .resolve("module:future.unknown", &unknown, "label")
            .unwrap()
            .is_none()
    );
    assert_eq!(editac_core::interchange::value(&unknown), f["unknown"]);
}
#[test]
fn public_js_checkpoint_returns_to_native_and_public_rust_with_unknown_data() {
    let output = PathBuf::from(std::env::var("EDITAC_COMPATIBILITY_OUTPUT").unwrap());
    let mut m: Value =
        serde_json::from_slice(&std::fs::read(output.join("public-js.json")).unwrap()).unwrap();
    let bytes = std::fs::read(output.join("public-js.bin")).unwrap();
    let c = InitializedCheckpoint {
        identity: identity(&m["identity"]),
        initialized: true,
        writer_id: m["writerId"].as_u64().unwrap() as u32,
        bytes: bytes.clone(),
    };
    let d = Document::restore(&c.identity, &c, &[]).unwrap();
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .flat_map(|n| &n.runs)
            .any(|r| r
                .attributes
                .get("module:future.unknown")
                .map(editac_core::interchange::value)
                == Some(json!([37,{"nested":["keep",{"value":9}]}])))
    );
    m["expected"] = m["identity"].clone();
    m["journal"] = json!([]);
    let e = NativeEngine::restore(m.to_string(), bytes).unwrap();
    let s: Value = serde_json::from_str(&e.read().unwrap()).unwrap();
    let expected: Value =
        serde_json::from_slice(&std::fs::read(output.join("public-js-visible.json")).unwrap())
            .unwrap();
    assert_eq!(s["visible"], expected);
    e.dispose().unwrap();
}
