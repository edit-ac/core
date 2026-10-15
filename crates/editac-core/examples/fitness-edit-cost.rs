//! FIT-1.8 portable command attribution; not native UI/IME qualification.
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{Document, DocumentIdentity, InitializedCheckpoint},
};
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
    let metadata = &frozen["checkpoint"];
    let id = &metadata["identity"];
    let identity = DocumentIdentity::v5(
        id["documentId"].as_str().unwrap(), id["epoch"].as_str().unwrap(),
    ).unwrap();
    let checkpoint = InitializedCheckpoint {
        identity: identity.clone(), initialized: true,
        writer_id: metadata["writerId"].as_u64().unwrap().try_into().unwrap(),
        bytes: metadata["bytes"].as_array().unwrap().iter()
            .map(|b| b.as_u64().unwrap().try_into().unwrap()).collect(),
    };
    let (mut document, restore_ms) = timed(|| Document::restore(&identity, &checkpoint, &[]).unwrap());
    let (initial, snapshot_ms) = timed(|| document.snapshot().unwrap());
    let initial_text: Vec<String> = initial.visible.iter().map(|n| n.runs.iter().map(|r| r.text.as_str()).collect()).collect();
    let nodes: Vec<_> = initial.visible.iter().filter(|n| n.kind == "block").collect();
    let mut samples = vec![];
    for (position, index) in [("start", 0), ("middle", nodes.len()/2), ("end", nodes.len()-1)] {
        let node = nodes[index];
        let text: String = node.runs.iter().map(|r| r.text.as_str()).collect();
        let (offset, original) = text.chars().scan(0u32, |offset, c| {
            let at = *offset; *offset += c.len_utf16() as u32; Some((at, c))
        }).find(|(_, c)| c.is_ascii_alphabetic()).unwrap();
        for sample in 0..3 {
            for (phase, replacement) in [("overwrite", "x".to_owned()), ("restore", original.to_string())] {
                let (selection, anchor_ms) = timed(|| document.selection(
                    (&node.id, Utf16Offset(offset), Bias::Right),
                    (&node.id, Utf16Offset(offset + 1), Bias::Left),
                ).unwrap());
                let (plan, prepare_ms) = timed(|| document.prepare_text(
                    &TextCommand::Replace { selection, text: replacement },
                    &TextOrigin::new("fitness:edit-cost").unwrap(),
                ).unwrap());
                let (_, commit_ms) = timed(|| document.commit_text(plan).unwrap());
                let (snapshot, projection_ms) = timed(|| document.snapshot().unwrap());
                samples.push(json!({"position":position,"sample":sample,"phase":phase,
                    "anchorMs":anchor_ms,"prepareMs":prepare_ms,"commitMs":commit_ms,
                    "projectionMs":projection_ms,"sourceReads":snapshot.source_reads,
                    "changedNodes":snapshot.changed_nodes.len()}));
            }
        }
    }
    let final_snapshot = document.snapshot().unwrap();
    let final_text: Vec<String> = final_snapshot.visible.iter().map(|n| n.runs.iter().map(|r| r.text.as_str()).collect()).collect();
    assert_eq!(initial_text, final_text, "Replay changed seeded corpus");
    assert_eq!(initial.visible.len(), final_snapshot.visible.len());
    println!("{}", json!({"version":1,"scope":"portable-native-command-attribution; no platform qualification",
        "checkpoint":args[1],"checkpointBytes":checkpoint.bytes.len(),"blocks":nodes.len(),
        "textBytes":initial_text.iter().map(String::len).sum::<usize>(),"restoreMs":restore_ms,
        "initialSnapshotMs":snapshot_ms,"samples":samples,
        "counts":{"executed":samples.len(),"passed":samples.len(),"failed":0,"skipped":0}}));
}
