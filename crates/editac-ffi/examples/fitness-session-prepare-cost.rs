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
fn changed_regions(
    session: &NativeSession,
    target: &str,
    directory: &std::path::Path,
) -> Result<Vec<Value>, String> {
    let mut cells = vec![];
    for width in [1usize, 4, 16] {
        let before = session.read(0).unwrap();
        let index = before.nodes.iter().position(|n| n.id == target).unwrap();
        let original = &before.nodes[index].text;
        let byte = original
            .as_bytes()
            .windows(width)
            .position(|w| w.iter().all(u8::is_ascii))
            .expect("fixed corpus ASCII region");
        let offset = original[..byte].encode_utf16().count() as u32;
        let mut expected = projection(&before);
        let mut cursor = session
            .rich_snapshot()
            .map_err(|e| format!("{e:?}"))?
            .sequence;
        let entry_groups = session.history_state(0).unwrap().undo_groups;
        let mut samples = vec![];
        let first = if &original[byte..byte + width] == "#".repeat(width) {
            '%'
        } else {
            '#'
        };
        for sample in 0..12 {
            let read = session.read(0).unwrap();
            let replacement = if sample % 2 == 0 { first } else { '^' }
                .to_string()
                .repeat(width);
            let started = Instant::now();
            let plan = session
                .prepare_edits(
                    read.revision.clone().unwrap(),
                    vec![NativeSessionEdit {
                        node: target.into(),
                        from_utf16: offset,
                        to_utf16: offset + width as u32,
                        text: replacement.clone(),
                    }],
                    "fitness-session-region-cost".into(),
                    0,
                )
                .unwrap();
            let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(projection(&session.read(0).unwrap()), projection(&read));
            let receipt = session.commit_edits(plan, 0).unwrap().unwrap();
            let patches = session.take_rich_patches(cursor).unwrap();
            cursor = patches.sequence;
            assert_eq!(
                patches.patches_json.len(),
                1,
                "one bounded actual native patch"
            );
            let patch: Value = serde_json::from_str(&patches.patches_json[0]).unwrap();
            assert_eq!(patch["changedNodes"], json!([target]));
            assert_eq!(patch["changedSources"].as_array().unwrap().len(), 1);
            assert_eq!(patch["nodes"].as_array().unwrap().len(), 1);
            assert!(!patch["touchedRanges"].as_array().unwrap().is_empty());
            let mut expected_text = original.clone();
            expected_text.replace_range(byte..byte + width, &replacement);
            expected[index][2] = json!(expected_text);
            assert_eq!(
                projection(&session.read(0).unwrap()),
                expected,
                "complete corpus retained"
            );
            samples.push(json!({"prepareMs":prepare_ms,"sequence":receipt.sequence,
                "changedNodes":1,"changedSources":1,"patches":1,
                "patchBytes":patches.patches_json[0].len(),"touchedRanges":patch["touchedRanges"]}));
            fs::write(
                directory.join(format!("regions-{width}-samples.json")),
                serde_json::to_vec(&samples).unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            session.history_state(0).unwrap().undo_groups,
            entry_groups + 12
        );
        for _ in 0..12 {
            session
                .undo(session.read(0).unwrap().revision.unwrap(), 0)
                .unwrap()
                .unwrap();
        }
        assert_eq!(projection(&session.read(0).unwrap()), projection(&before));
        for _ in 0..12 {
            session
                .redo(session.read(0).unwrap().revision.unwrap(), 0)
                .unwrap()
                .unwrap();
        }
        assert_eq!(projection(&session.read(0).unwrap()), expected);
        cells.push(json!({"widthUtf16":width,"nodes":before.nodes.len(),
            "documentTextBytes":before.nodes.iter().map(|n| n.text.len()).sum::<usize>(),
            "samples":samples,"counts":{"executed":12,"passed":12,"failed":0,"skipped":0},
            "history":"12 complete undo/redo groups; whole-corpus identity/content exact"}));
    }
    Ok(cells)
}

fn main() {
    let args: Vec<_> = env::args().collect();
    assert!(
        args.len() == 3 || (args.len() == 4 && args[3] == "--regions"),
        "checkpoint JSON and unique evidence directory, optional --regions"
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
    // Preserve the complete owning scenario before optional boundary checks.
    // A later failure must never erase or qualify a different proof scope.
    let mut result = json!({"scope":"public NativeSession prepare + actual SQLite; prepared host causal attribution, not platform input/tail qualification","checkpoint":args[1],"nodes":initial.nodes.len(),"samples":samples,"counts":{"executed":12,"passed":12,"failed":0,"skipped":0},"oracles":["full-corpus content each commit","silent preparation and exact revision","durable receipt each commit","12 explicit undo/redo groups","SQLite reopen"],"regions":[],"disposed":false});
    fs::write(
        directory.join("primary-result.json"),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
    let regions = if args.len() == 4 {
        changed_regions(&reopened, &node.id, &directory)
    } else {
        Ok(vec![])
    };
    reopened.dispose().unwrap();
    result["disposed"] = json!(true);
    match regions {
        Ok(cells) => result["regions"] = json!(cells),
        Err(error) => {
            result["supplementalFailure"] = json!({"boundary":"native rich snapshot before changed-region samples","error":error,"qualified":false});
            fs::write(
                directory.join("result.json"),
                serde_json::to_vec(&result).unwrap(),
            )
            .unwrap();
            println!("{result}");
            std::process::exit(1);
        }
    }
    fs::write(
        directory.join("result.json"),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
    println!("{result}");
}
