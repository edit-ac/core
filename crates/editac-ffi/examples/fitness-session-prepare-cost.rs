//! Prepared host attribution through the actual public NativeSession + SQLite.
//! Full frozen Task/Long corpora; no platform-input or tail qualification.
use editac_core::document::{DocumentIdentity, InitializedCheckpoint};
use editac_ffi::{NativeSession, NativeSessionEdit, NativeSessionOptions, NativeSessionRead};
use editac_session::{
    ports::{CheckpointRecord, LocalStore, StoreLimits},
    store::NativeStore,
};
use serde_json::{Value, json};
use std::{env, fs, path::PathBuf, time::Instant};

fn projection(read: &NativeSessionRead) -> Value {
    json!(
        read.nodes
            .iter()
            .map(|n| json!([n.id, n.kind, n.text]))
            .collect::<Vec<_>>()
    )
}
fn main() {
    let args: Vec<_> = env::args().collect();
    assert_eq!(
        args.len(),
        3,
        "checkpoint JSON and unique evidence directory"
    );
    let frozen: Value = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let id = &frozen["identity"];
    let identity = DocumentIdentity::v5(
        id["documentId"].as_str().unwrap(),
        id["epoch"].as_str().unwrap(),
    )
    .unwrap();
    let directory = PathBuf::from(&args[2]);
    fs::create_dir_all(&directory).unwrap();
    let options = NativeSessionOptions {
        path: directory.join("session.sqlite").to_str().unwrap().into(),
        document_id: identity.document_id.clone(),
        epoch: identity.epoch.clone(),
        writable: true,
        permission_expires_at: None,
    };
    let store =
        NativeStore::create_new(&options.path, identity.clone(), StoreLimits::default()).unwrap();
    let checkpoint = InitializedCheckpoint {
        identity,
        initialized: true,
        writer_id: frozen["checkpoint"]["writerId"].as_u64().unwrap() as u32,
        bytes: frozen["checkpoint"]["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| u8::try_from(v.as_u64().unwrap()).unwrap())
            .collect(),
    };
    store
        .publish(0, CheckpointRecord::new(checkpoint, vec![]).unwrap())
        .unwrap();
    drop(store);
    let session = NativeSession::open(options.clone()).unwrap();
    let initial = session.read(0).unwrap();
    let expected_initial = projection(&initial);
    let node = initial
        .nodes
        .iter()
        .rev()
        .find(|n| n.kind == "block")
        .unwrap();
    let offset = node
        .text
        .chars()
        .scan(0u32, |at, c| {
            let start = *at;
            *at += c.len_utf16() as u32;
            Some((start, c))
        })
        .filter(|(_, c)| c.is_ascii_alphabetic())
        .last()
        .unwrap()
        .0;
    let mut expected = initial
        .nodes
        .iter()
        .map(|n| n.text.clone())
        .collect::<Vec<_>>();
    let target = initial.nodes.iter().position(|n| n.id == node.id).unwrap();
    let mut samples = vec![];
    for replacement in "abcdefghijkl".chars() {
        let before = session.read(0).unwrap();
        let started = Instant::now();
        let token = session
            .prepare_edits(
                before.revision.clone().unwrap(),
                vec![NativeSessionEdit {
                    node: node.id.clone(),
                    from_utf16: offset,
                    to_utf16: offset + 1,
                    text: replacement.to_string(),
                }],
                "fitness-session-prepare-cost".into(),
                0,
            )
            .unwrap();
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        let prepared = session.read(0).unwrap();
        assert_eq!(
            projection(&prepared),
            projection(&before),
            "prepare is silent"
        );
        assert_eq!(prepared.revision, before.revision);
        let receipt = session.commit_edits(token, 0).unwrap().unwrap();
        assert!(receipt.sequence > 0);
        let mut text: Vec<_> = expected[target].encode_utf16().collect();
        text[offset as usize] = replacement as u16;
        expected[target] = String::from_utf16(&text).unwrap();
        let actual = session.read(0).unwrap();
        assert_eq!(
            actual
                .nodes
                .iter()
                .map(|n| n.text.clone())
                .collect::<Vec<_>>(),
            expected
        );
        samples.push(json!({"prepareMs":prepare_ms,"sequence":receipt.sequence}));
    }
    // Keep the raw attribution even if a later semantic/history oracle fails.
    // This file alone never qualifies the complete scenario.
    fs::write(
        directory.join("prepare-samples.json"),
        serde_json::to_vec(&samples).unwrap(),
    )
    .unwrap();
    let final_read = session.read(0).unwrap();
    let expected_final = projection(&final_read);
    let history = session.history_state(0).unwrap();
    assert_eq!(
        history.undo_groups, 12,
        "each explicit edit keeps its history boundary"
    );
    for _ in 0..history.undo_groups {
        session
            .undo(session.read(0).unwrap().revision.unwrap(), 0)
            .unwrap()
            .unwrap();
    }
    let undone = session.read(0).unwrap();
    assert_eq!(
        projection(&undone),
        expected_initial,
        "undo restores whole corpus"
    );
    for _ in 0..history.undo_groups {
        session
            .redo(session.read(0).unwrap().revision.unwrap(), 0)
            .unwrap()
            .unwrap();
    }
    assert_eq!(projection(&session.read(0).unwrap()), expected_final);
    session.dispose().unwrap();
    let reopened = NativeSession::open(options).unwrap();
    assert_eq!(
        projection(&reopened.read(0).unwrap()),
        expected_final,
        "actual SQLite reopen preserves whole corpus"
    );
    reopened.dispose().unwrap();
    println!(
        "{}",
        json!({"scope":"public NativeSession prepare + actual SQLite; prepared host causal attribution, not platform input/tail qualification","checkpoint":args[1],"nodes":initial.nodes.len(),"samples":samples,"counts":{"executed":12,"passed":12,"failed":0,"skipped":0},"oracles":["full-corpus content each commit","silent preparation and exact revision","durable receipt each commit","12 explicit undo/redo groups","SQLite reopen"],"disposed":true})
    );
}
