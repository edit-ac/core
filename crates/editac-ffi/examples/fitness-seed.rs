//! Prepared frozen-schema fixture initialization, outside measurements. Validate
//! through public native restore; browser checks still execute actual WASM.
#[allow(dead_code)]
#[path = "../../../fixtures/schema-v5/mapping.rs"]
mod schema;
use editac_ffi::NativeEngine;
use serde_json::{Value, json};
use std::{collections::BTreeMap, env, fs};
use yrs::{Any, Map, ReadTxn, Transact};

fn main() {
    let args: Vec<_> = env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "Expected fixture, checkpoint and snapshot JSON"
    );
    let fixture: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let blocks = fixture["blocks"].as_array().unwrap();
    let engine = NativeEngine::create(json!({"profile":"v5",
        "documentId":format!("00000000-0000-4000-8000-{:012x}", fixture["seed"].as_u64().unwrap()),
        "epoch":format!("00000000-0000-4000-9000-{:012x}", fixture["seed"].as_u64().unwrap()),
        "nodes":blocks.iter().map(|b|json!({"text":b["runs"].as_array().unwrap().iter().map(|r|r["text"].as_str().unwrap()).collect::<String>()})).collect::<Vec<_>>()
    }).to_string()).unwrap();
    let initial: Value = serde_json::from_str(&engine.read().unwrap()).unwrap();
    let initial = initial["visible"].as_array().unwrap();
    assert_eq!(initial.len(), blocks.len());
    let checkpoint = engine.checkpoint().unwrap();
    let metadata: Value = serde_json::from_str(&checkpoint.metadata_json).unwrap();
    let writer = metadata["writerId"].as_u64().unwrap();
    engine.dispose().unwrap();
    let prepared = schema::replica(writer);
    schema::apply(&prepared, &checkpoint.bytes).unwrap();
    let mut groups: BTreeMap<String, (String, u32)> = BTreeMap::new();
    {
        let mut txn = prepared.transact_mut_with("fitness:prepared-initializer");
        for (index, block) in blocks.iter().enumerate() {
            let id = initial[index]["id"].as_str().unwrap();
            let tuple = match block["attributes"]["type"].as_str().unwrap() {
                "heading" => schema::arr(vec![Any::from("heading"), Any::from(2)]),
                "code" => schema::arr(vec![Any::from("code"), Any::from("text")]),
                "paragraph" => schema::arr(vec![Any::from("paragraph")]),
                _ => panic!("Unknown fixture attributes"),
            };
            txn.get_map(schema::ROOTS[4])
                .unwrap()
                .insert(&mut txn, id, tuple);
            if let Some(key) = block["containers"][0]["key"].as_str() {
                if !groups.contains_key(key) {
                    let container = format!("c:{writer}:{}", groups.len() + 1);
                    txn.get_map(schema::ROOTS[0]).unwrap().insert(
                        &mut txn,
                        container.as_str(),
                        "list",
                    );
                    txn.get_map(schema::ROOTS[2]).unwrap().insert(
                        &mut txn,
                        container.as_str(),
                        schema::arr(vec![Any::from("@root"), Any::from(index as u32)]),
                    );
                    txn.get_map(schema::ROOTS[7]).unwrap().insert(
                        &mut txn,
                        container.as_str(),
                        schema::arr(vec![Any::from("unordered")]),
                    );
                    groups.insert(key.into(), (container, 0));
                }
                let (parent, order) = groups.get_mut(key).unwrap();
                txn.get_map(schema::ROOTS[2]).unwrap().insert(
                    &mut txn,
                    id,
                    schema::arr(vec![Any::from(parent.as_str()), Any::from(*order)]),
                );
                *order += 1;
            }
        }
    }
    eprintln!(
        "seed: prepared {} blocks / {} containers with frozen schema-v5",
        blocks.len(),
        groups.len()
    );
    let mut restore = metadata.clone();
    restore["expected"] = metadata["identity"].clone();
    restore["journal"] = json!([]);
    let engine = NativeEngine::restore(restore.to_string(), schema::bytes(&prepared)).unwrap();
    fs::write(&args[3], engine.read().unwrap()).unwrap();
    let checkpoint = engine.checkpoint().unwrap();
    let mut metadata: Value = serde_json::from_str(&checkpoint.metadata_json).unwrap();
    metadata["bytes"] = json!(checkpoint.bytes);
    fs::write(
        &args[2],
        json!({"identity":metadata["identity"],"checkpoint":metadata}).to_string(),
    )
    .unwrap();
    engine.dispose().unwrap();
    println!("seed: 1/1 fixture prepared; 0 failures/skips");
}
