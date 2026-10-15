//! Direct replay/serialization attribution on retained checkpoints, no bridge clock.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use serde_json::{Value, json};
use std::{env, fs, time::Instant};
fn timed<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let start = Instant::now();
    let value = f();
    (value, start.elapsed().as_secs_f64() * 1000.0)
}
fn main() {
    let args: Vec<_> = env::args().collect();
    assert_eq!(args.len(), 2, "Expected retained native checkpoint JSON");
    let frozen: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let bytes: Vec<u8> = frozen["checkpoint"]["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap().try_into().unwrap())
        .collect();
    let doc = m::replica(123456);
    let (_, apply_ms) = timed(|| m::apply(&doc, &bytes).unwrap());
    let mut samples = vec![];
    let mut snapshot = None;
    for sample in 0..6 {
        let (view, replay_ms) = timed(|| m::project(&doc).unwrap());
        let owners = view.owners.len();
        let (value, serialization_ms) = timed(|| m::snapshot_from_view(&doc, view).unwrap());
        if let Some(previous) = &snapshot {
            assert_eq!(previous, &value);
        }
        snapshot = Some(value);
        samples.push(json!({"sample":sample,"owners":owners,"replayMs":replay_ms,"serializationMs":serialization_ms}));
    }
    println!(
        "{}",
        json!({"version":1,"scope":"portable-v5-replay-serialization; no bridge/platform/tail qualification",
        "applyMs":apply_ms,"checkpoint":args[1],"checkpointBytes":bytes.len(),"samples":samples,
        "snapshot":serde_json::from_str::<Value>(&m::json(&snapshot.unwrap())).unwrap(),
        "counts":{"executed":samples.len(),"passed":samples.len(),"failed":0,"skipped":0}})
    );
}
