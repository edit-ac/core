//! EXT-1.3: shared fixture admission and actual Document/checkpoint preservation.
use editac_core::{
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::{content::Content, v1::Registry},
};
use serde_json::{Value, json};
use yrs::{Any, Text, Transact};
#[path = "support/extension_conformance.rs"]
mod conformance;
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/extensions/conformance.json"
    ))
    .unwrap()
}
fn results(category: &str) {
    let c = corpus();
    let mut count = 0;
    for case in c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["category"] == category)
    {
        let before = case.clone();
        let result = conformance::fixture_result(c["definitions"].as_array().unwrap(), case);
        assert_eq!(result["outcome"], case["expected"], "{}", case["id"]);
        assert_eq!(case, &before, "fixture must stay recoverable");
        count += 1;
    }
    assert!(count > 0);
}
#[test]
fn fixed_descriptor_validation_and_resource_bounds() {
    results("descriptor");
}
#[test]
fn fixed_content_unknown_versions_disabled_registration_and_utf16_bounds() {
    results("run");
}
#[test]
fn built_in_blocks_reuse_owning_content_contract() {
    let c = corpus();
    let mut count = 0;
    for case in c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["category"] == "block")
    {
        let tuple = conformance::any(&case["blockAttributes"]);
        if case["id"] != "builtin-future-block" {
            assert_eq!(
                Content::from_tuple(&tuple)
                    .unwrap()
                    .unwrap()
                    .tuple()
                    .unwrap(),
                tuple
            );
        } else {
            assert!(Content::from_tuple(&tuple).unwrap().is_none());
        }
        count += 1;
    }
    assert_eq!(count, 4);
}
fn semantic(node: &editac_core::projection::ProjectedNode) -> Value {
    json!({"id":node.id,"blockAttributes":serde_json::from_str::<Value>(&m::json(&node.block_attributes.as_ref().unwrap().tuple())).unwrap(),
       "runs":node.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),serde_json::from_str::<Value>(&m::json(v)).unwrap())).collect::<serde_json::Map<_,_>>()})).collect::<Vec<_>>()})
}
#[test]
fn real_checkpoints_preserve_all_admitted_payloads_and_semantics() {
    let c = corpus();
    let output = std::env::var("EDITAC_EXTENSION_CONTRACT_OUTPUT")
        .expect("set unique worktree-owned EDITAC_EXTENSION_CONTRACT_OUTPUT");
    std::fs::create_dir_all(&output).unwrap();
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let mut projections = serde_json::Map::new();
    let mut count = 0;
    for case in c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| ["known", "opaque", "preserved"].contains(&x["expected"].as_str().unwrap()))
    {
        let x = m::seed();
        let text = m::text(&x, "n:11:1");
        let (s, attrs) = if case["category"] == "run" {
            (
                case["run"]["text"].as_str().unwrap(),
                case["run"]["attributes"].clone(),
            )
        } else {
            (case["text"].as_str().unwrap(), json!({}))
        };
        {
            let mut tx = x.transact_mut();
            let len = text.len(&tx);
            text.remove_range(&mut tx, 0, len);
            let Any::Map(attrs) = conformance::any(&attrs) else {
                panic!()
            };
            text.insert_with_attributes(
                &mut tx,
                0,
                s,
                attrs
                    .iter()
                    .map(|(k, v)| (k.clone().into(), v.clone()))
                    .collect(),
            );
        }
        if case["category"] == "block" {
            m::set(&x, 4, "n:11:1", conformance::any(&case["blockAttributes"]));
        }
        let checkpoint = InitializedCheckpoint {
            identity: identity.clone(),
            initialized: true,
            writer_id: 11,
            bytes: m::bytes(&x),
        };
        let doc = Document::restore(&identity, &checkpoint, &[]).unwrap();
        let snapshot = doc.snapshot().unwrap();
        let node = snapshot.visible.iter().find(|n| n.id == "n:11:1").unwrap();
        let projection = semantic(node);
        assert_eq!(projection["runs"], json!([{"text":s,"attributes":attrs}]));
        if case["category"] == "block" {
            assert_eq!(projection["blockAttributes"], case["blockAttributes"]);
        }
        let mut registry = Registry::default();
        if case["disabled"] != true {
            for d in c["definitions"].as_array().unwrap() {
                registry.register(&conformance::any(d)).unwrap();
            }
        }
        let registry = registry.freeze();
        for run in &node.runs {
            registry.validate_run(&run.text, &run.attributes).unwrap();
        }
        let restored = Document::restore(&identity, &doc.checkpoint(), &[]).unwrap();
        assert_eq!(restored.snapshot().unwrap().visible, snapshot.visible);
        let id = case["id"].as_str().unwrap();
        std::fs::write(format!("{output}/{id}.bin"), doc.checkpoint().bytes).unwrap();
        projections.insert(id.into(), projection);
        count += 1;
    }
    assert_eq!(count, 13);
    let all = c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| conformance::fixture_result(c["definitions"].as_array().unwrap(), case))
        .collect::<Vec<_>>();
    std::fs::write(
        format!("{output}/rust-results.json"),
        serde_json::to_vec_pretty(&all).unwrap(),
    )
    .unwrap();
    std::fs::write(
        format!("{output}/rust-projections.json"),
        serde_json::to_vec_pretty(&projections).unwrap(),
    )
    .unwrap();
    std::fs::write(format!("{output}/identity.json"),r#"{"offsets":"utf16","protocolVersion":1,"documentId":"77777777-7777-4777-8777-777777777777","epoch":"88888888-8888-4888-8888-888888888888","profile":"editac.yrs-yjs.editor.v5","updateEncoding":1,"schema":"editac.registry.editor.v5"}"#).unwrap();
}
