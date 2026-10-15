//! Host causal attribution, not platform qualification. Uses the same native ABI
//! and frozen Task/Long checkpoints as the OS-keyboard harness.
use editac_ffi::{AnchorBias, AnchorInput, NativeEngine};
use serde_json::{Value, json};
use std::{env, fs, time::Instant};

fn main() {
    assert!(
        cfg!(feature = "fitness-trace"),
        "requires diagnostic feature"
    );
    let path = env::args().nth(1).expect("frozen native checkpoint JSON");
    let frozen: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut input = frozen["checkpoint"].clone();
    let bytes = input.as_object_mut().unwrap().remove("bytes").unwrap();
    input["expected"] = frozen["identity"].clone();
    input["journal"] = json!([]);
    let engine = NativeEngine::restore(
        input.to_string(),
        bytes
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect(),
    )
    .unwrap();
    let initial: Value = serde_json::from_str(&engine.read().unwrap()).unwrap();
    let node = initial["visible"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|n| n["kind"] == "block")
        .unwrap();
    let text: String = node["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect();
    let offset = text
        .chars()
        .scan(0u32, |offset, c| {
            let at = *offset;
            *offset += c.len_utf16() as u32;
            Some((at, c))
        })
        .filter(|(_, c)| c.is_ascii_alphabetic())
        .last()
        .unwrap()
        .0;
    let mut samples = vec![];
    for replacement in "abcdefghijkl".chars() {
        let started = Instant::now();
        let anchor = engine
            .capture_anchor(AnchorInput {
                node: node["id"].as_str().unwrap().into(),
                offset_utf16: offset,
                bias: AnchorBias::Right,
            })
            .unwrap();
        let first = started.elapsed().as_secs_f64() * 1000.0;
        let focus = engine
            .capture_anchor(AnchorInput {
                node: node["id"].as_str().unwrap().into(),
                offset_utf16: offset + 1,
                bias: AnchorBias::Left,
            })
            .unwrap();
        let second = started.elapsed().as_secs_f64() * 1000.0;
        let result = engine.execute_batch(json!({"kind":"editor","origin":"fitness-batch-cost", "commands":[{"type":"replace", "range":{"anchor":anchor,"focus":focus},"text":replacement.to_string()}]}).to_string()).unwrap();
        let returned = started.elapsed().as_secs_f64() * 1000.0;
        let result: Value = serde_json::from_str(&result.result_json).unwrap();
        samples.push(json!({"anchorMs":first,"focusMs":second-first,"batchAndTransferMs":returned-second,"trace":result["fitnessTrace"]}));
        engine.release_anchor(anchor).unwrap();
        engine.release_anchor(focus).unwrap();
    }
    let checkpoint = engine.checkpoint().unwrap();
    let mut input: Value = serde_json::from_str(&checkpoint.metadata_json).unwrap();
    input["expected"] = frozen["identity"].clone();
    input["journal"] = json!([]);
    let reopened = NativeEngine::restore(input.to_string(), checkpoint.bytes).unwrap();
    let mut final_snapshot: Value = serde_json::from_str(&engine.read().unwrap()).unwrap();
    let mut restored: Value = serde_json::from_str(&reopened.read().unwrap()).unwrap();
    for value in [&mut final_snapshot, &mut restored] {
        for key in ["revision", "changedNodes", "touchedRanges"] {
            value.as_object_mut().unwrap().remove(key);
        }
    }
    assert_eq!(final_snapshot, restored);
    engine.dispose().unwrap();
    reopened.dispose().unwrap();
    println!(
        "{}",
        json!({"scope":"instrumented host ABI causal diagnosis; not platform or tail qualification", "checkpoint":path,"samples":samples,"counts":{"executed":12,"passed":12,"failed":0,"skipped":0}})
    );
}
