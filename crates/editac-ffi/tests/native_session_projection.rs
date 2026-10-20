//! Actual SQLite-backed NativeSession rich projection, never a NativeEngine DTO.
use editac_ffi::*;
use serde_json::Value;
#[path = "support/rich_fixture.rs"]
mod rich_fixture;
use rich_fixture::Fixture;
fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}
fn edit(s: &NativeSession, node: &str, from: u32, to: u32, text: &str) -> String {
    s.prepare_edits(
        s.read(0).unwrap().revision.unwrap(),
        vec![NativeSessionEdit {
            node: node.into(),
            from_utf16: from,
            to_utf16: to,
            text: text.into(),
        }],
        "rich-native-test".into(),
        0,
    )
    .unwrap()
}
fn commit(s: &NativeSession, node: &str, from: u32, to: u32, text: &str) {
    s.commit_edits(edit(s, node, from, to, text), 0)
        .unwrap()
        .unwrap();
}
#[test]
fn actual_rich_snapshot_preserves_shared_runs_spans_bidi_and_attachment_tuple() {
    let f = Fixture::new();
    let s = f.open();
    let rich = s.rich_snapshot().unwrap();
    let wire = json(&rich.snapshot_json);
    assert_eq!(wire["visible"], f.expected["visible"]);
    assert_eq!(wire["identity"], f.expected["identity"]);
    assert_eq!(wire["retainedStructure"], f.expected["retainedStructure"]);
    assert_eq!(wire["visible"].as_array().unwrap().len(), 3);
    assert_eq!(wire["visible"][0]["runs"][0]["text"], "A🦀אב");
    assert!(
        !wire["visible"][0]["runs"][0]["attributes"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    assert!(!wire["visible"][1]["blockAttributes"].is_null());
    assert_eq!(wire["visible"][1]["order"], 1);
    assert!(
        wire["visible"][1]["spans"][0]["identity"]
            .as_str()
            .is_some()
    );
    assert_eq!(Some(rich.revision), s.read(0).unwrap().revision);
}

fn assert_wire_eq(actual: &Value, expected: &Value) {
    if actual != expected {
        let directory = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::write(directory.join("chunk-actual.json"), actual.to_string()).unwrap();
        std::fs::write(directory.join("chunk-expected.json"), expected.to_string()).unwrap();
        let changed: Vec<_> = expected
            .as_object()
            .unwrap()
            .keys()
            .filter(|key| actual[*key] != expected[*key])
            .collect();
        panic!("complete wire differs at {changed:?}; retained chunk-actual/expected.json");
    }
}

fn chunked(s: &NativeSession) -> (Vec<u8>, u64, usize) {
    let revision = s.read(0).unwrap().revision.unwrap();
    let mut bytes = vec![];
    let mut count = 0;
    loop {
        let chunk = s
            .rich_snapshot_chunk(revision.clone(), bytes.len() as u64)
            .unwrap();
        assert_eq!(chunk.revision, revision);
        assert_eq!(chunk.offset_bytes, bytes.len() as u64);
        assert!(!chunk.bytes.is_empty() && chunk.bytes.len() <= 2 * 1024 * 1024);
        bytes.extend_from_slice(&chunk.bytes);
        count += 1;
        if chunk.complete {
            assert_eq!(chunk.total_bytes, bytes.len() as u64);
            return (bytes, chunk.sequence, count);
        }
        assert!(bytes.len() < chunk.total_bytes as usize);
    }
}

#[test]
fn single_chunk_is_exact_legacy_wire_and_invalid_reads_preserve_pending_patch() {
    let f = Fixture::new();
    let s = f.open();
    let before = s.rich_snapshot().unwrap();
    assert!(matches!(
        s.rich_snapshot_chunk(vec![], 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::InvalidToken,
            ..
        })
    ));
    let node = s.read(0).unwrap().nodes[0].id.clone();
    commit(&s, &node, 0, 0, "x");
    let revision = s.read(0).unwrap().revision.unwrap();
    assert!(matches!(
        s.rich_snapshot_chunk(revision, 1),
        Err(NativeSessionError::InvalidProjectionCursor)
    ));
    assert_eq!(
        s.take_rich_patches(before.sequence)
            .unwrap()
            .patches_json
            .len(),
        1
    );
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    let legacy = s.rich_snapshot().unwrap();
    let (bytes, sequence, chunks) = chunked(&s);
    assert_eq!(bytes, legacy.snapshot_json.as_bytes());
    assert_eq!(sequence, legacy.sequence);
    assert_eq!(chunks, 1);
    assert_eq!(s.recovery_export().unwrap().checkpoint.bytes, checkpoint);
}

#[test]
fn full_large_rich_wire_chunks_preserve_every_field_and_acknowledge_only_at_end() {
    let f = Fixture::large();
    let s = f.open();
    let revision = s.history_state(0).unwrap().revision.unwrap();
    let first = s.rich_snapshot_chunk(revision.clone(), 0).unwrap();
    assert!(!first.complete);
    assert_eq!(first.bytes.len(), 2 * 1024 * 1024);
    assert!(matches!(
        s.take_rich_patches(first.sequence),
        Err(NativeSessionError::ProjectionResyncRequired)
    ));
    for offset in [1, u64::MAX, first.bytes.len() as u64 - 1] {
        assert!(matches!(
            s.rich_snapshot_chunk(revision.clone(), offset),
            Err(NativeSessionError::InvalidProjectionCursor)
        ));
    }
    let alias = s.clone();
    let _ = alias.read(0).unwrap();
    assert!(matches!(
        alias.rich_snapshot(),
        Err(NativeSessionError::ResourceLimit)
    ));
    let mut bytes = first.bytes;
    loop {
        let chunk = alias
            .rich_snapshot_chunk(revision.clone(), bytes.len() as u64)
            .unwrap();
        assert_eq!(chunk.sequence, first.sequence);
        assert_eq!(chunk.revision, revision);
        assert!(chunk.bytes.len() <= 2 * 1024 * 1024);
        bytes.extend_from_slice(&chunk.bytes);
        if chunk.complete {
            assert_eq!(bytes.len() as u64, chunk.total_bytes);
            break;
        }
        assert!(matches!(
            s.take_rich_patches(chunk.sequence),
            Err(NativeSessionError::ProjectionResyncRequired)
        ));
    }
    assert_wire_eq(
        &serde_json::from_slice::<Value>(&bytes).unwrap(),
        &f.initial_expected,
    );
    assert!(
        s.take_rich_patches(first.sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
    let node = s.read(0).unwrap().nodes[0].id.clone();
    commit(&s, &node, 0, 0, "persisted");
    let patch = s.take_rich_patches(first.sequence).unwrap();
    assert_eq!(patch.patches_json.len(), 1);
    let (latest, _, _) = chunked(&s);
    s.dispose().unwrap();
    assert!(matches!(
        alias.rich_snapshot_chunk(revision, 0),
        Err(NativeSessionError::Disposed)
    ));
    assert_wire_eq(
        &serde_json::from_slice::<Value>(&bytes).unwrap(),
        &f.initial_expected,
    );
    let reopened = f.open();
    assert_eq!(
        serde_json::from_slice::<Value>(&chunked(&reopened).0).unwrap()["visible"],
        serde_json::from_slice::<Value>(&latest).unwrap()["visible"]
    );
}

#[test]
fn partial_chunk_revision_fences_commit_history_restart_and_failed_legacy_read() {
    let f = Fixture::large();
    let s = f.open();
    let revision = s.read(0).unwrap().revision.unwrap();
    let first = s.rich_snapshot_chunk(revision.clone(), 0).unwrap();
    let node = s.read(0).unwrap().nodes[0].id.clone();
    commit(&s, &node, 0, 0, "x");
    assert!(matches!(
        s.rich_snapshot_chunk(revision, first.bytes.len() as u64),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    let current = s.read(0).unwrap().revision.unwrap();
    assert!(matches!(
        s.rich_snapshot_chunk(current.clone(), first.bytes.len() as u64),
        Err(NativeSessionError::InvalidProjectionCursor)
    ));
    let restarted = s.rich_snapshot_chunk(current.clone(), 0).unwrap();
    assert!(matches!(
        s.rich_snapshot(),
        Err(NativeSessionError::ResourceLimit)
    ));
    let mut offset = restarted.bytes.len() as u64;
    loop {
        let next = s.rich_snapshot_chunk(current.clone(), offset).unwrap();
        offset += next.bytes.len() as u64;
        if next.complete {
            break;
        }
    }
    assert!(
        s.take_rich_patches(restarted.sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
    let partial = s.rich_snapshot_chunk(current.clone(), 0).unwrap();
    s.undo(current.clone(), 0).unwrap().unwrap();
    assert!(matches!(
        s.rich_snapshot_chunk(current, partial.bytes.len() as u64),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    assert_eq!(
        s.take_rich_patches(restarted.sequence)
            .unwrap()
            .patches_json
            .len(),
        1
    );
    chunked(&s);
}
#[test]
fn ordered_incremental_ranges_keep_other_rich_nodes_and_identity() {
    let f = Fixture::new();
    let s = f.open();
    let before = s.rich_snapshot().unwrap();
    let original = json(&before.snapshot_json);
    let node = original["visible"][0]["id"].as_str().unwrap();
    commit(&s, node, 1, 3, "😀");
    commit(&s, node, 0, 0, "X");
    // P1 reads do not steal rich patch delivery.
    let read = s.read(0).unwrap();
    let delta = s.take_rich_patches(before.sequence).unwrap();
    assert_eq!(delta.patches_json.len(), 2);
    assert_ne!(delta.revision, before.revision);
    assert_eq!(Some(delta.revision.clone()), read.revision);
    let patches: Vec<Value> = delta.patches_json.iter().map(|p| json(p)).collect();
    for (i, p) in patches.iter().enumerate() {
        assert_eq!(p["sequence"], before.sequence + i as u64 + 1);
        assert_eq!(p["identity"], original["identity"]);
        assert_eq!(p["changedNodes"], serde_json::json!([node]));
        assert_eq!(p["nodes"].as_array().unwrap().len(), 1);
        assert!(!p["touchedRanges"].as_array().unwrap().is_empty());
    }
    let range = &patches[0]["touchedRanges"][0];
    assert_eq!(range["start"], 1);
    assert_eq!(range["oldEnd"], 3);
    assert_eq!(range["newEnd"], 3);
    let after = json(&s.rich_snapshot().unwrap().snapshot_json);
    assert_eq!(after["visible"][1], original["visible"][1]);
    assert_eq!(after["visible"][2], original["visible"][2]);
    assert_eq!(
        after["visible"][0]["spans"][0]["identity"],
        original["visible"][0]["spans"][0]["identity"]
    );
    assert_eq!(
        after["visible"][0]["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["text"].as_str().unwrap().contains('A'))
            .unwrap()["attributes"],
        original["visible"][0]["runs"][0]["attributes"]
    );
    assert!(
        s.take_rich_patches(delta.sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
}
#[test]
fn invalid_cursor_invalid_unicode_batch_and_cancellation_are_atomic() {
    let f = Fixture::new();
    let s = f.open();
    assert!(matches!(
        s.take_rich_patches(0),
        Err(NativeSessionError::ProjectionResyncRequired)
    ));
    let before = s.rich_snapshot().unwrap();
    let wire = json(&before.snapshot_json);
    let node = wire["visible"][0]["id"].as_str().unwrap();
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    assert!(
        s.prepare_edits(
            before.revision.clone(),
            vec![NativeSessionEdit {
                node: node.into(),
                from_utf16: 2,
                to_utf16: 3,
                text: "invalid surrogate".into()
            }],
            "invalid".into(),
            0
        )
        .is_err()
    );
    s.cancel_edits(edit(&s, node, 0, 0, "cancelled")).unwrap();
    assert_eq!(s.recovery_export().unwrap().checkpoint.bytes, checkpoint);
    commit(&s, node, 0, 0, "valid");
    assert!(matches!(
        s.take_rich_patches(before.sequence + 100),
        Err(NativeSessionError::InvalidProjectionCursor)
    ));
    assert_eq!(
        s.take_rich_patches(before.sequence)
            .unwrap()
            .patches_json
            .len(),
        1
    );
}
#[test]
fn bounded_queue_requires_snapshot_resync_without_losing_committed_state() {
    let f = Fixture::new();
    let s = f.open();
    let before = s.rich_snapshot().unwrap();
    let wire = json(&before.snapshot_json);
    let node = wire["visible"][0]["id"].as_str().unwrap();
    for _ in 0..129 {
        commit(&s, node, 0, 0, "x");
    }
    assert!(matches!(
        s.take_rich_patches(before.sequence),
        Err(NativeSessionError::ProjectionResyncRequired)
    ));
    let (bytes, sequence, _) = chunked(&s);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["visible"][0]["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["text"].as_str().unwrap())
            .collect::<String>(),
        s.read(0).unwrap().nodes[0].text
    );
    assert!(
        s.take_rich_patches(sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
    let resync = s.rich_snapshot().unwrap();
    assert!(resync.sequence > before.sequence);
    assert!(
        json(&resync.snapshot_json)["visible"][0]["runs"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with(&"x".repeat(129))
    );
    assert!(
        s.take_rich_patches(resync.sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
}
#[test]
fn owned_outputs_survive_disposal_and_reopen_restores_same_rich_state() {
    let f = Fixture::new();
    let s = f.open();
    let before = s.rich_snapshot().unwrap();
    let wire = json(&before.snapshot_json);
    let node = wire["visible"][0]["id"].as_str().unwrap();
    commit(&s, node, 0, 0, "persisted");
    let delta = s.take_rich_patches(before.sequence).unwrap();
    let latest = s.rich_snapshot().unwrap();
    let alias = s.clone();
    s.dispose().unwrap();
    assert!(matches!(
        alias.rich_snapshot(),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.take_rich_patches(delta.sequence),
        Err(NativeSessionError::Disposed)
    ));
    assert_eq!(delta.patches_json.len(), 1);
    assert_eq!(json(&before.snapshot_json), wire);
    let reopened = f.open();
    assert_eq!(
        json(&reopened.rich_snapshot().unwrap().snapshot_json)["visible"],
        json(&latest.snapshot_json)["visible"]
    );
    assert_eq!(reopened.rich_snapshot().unwrap().revision, latest.revision);
}
#[test]
fn byte_bounded_queue_requires_resync_before_patch_count_limit() {
    let f = Fixture::new();
    let s = f.open();
    let before = s.rich_snapshot().unwrap();
    let wire = json(&before.snapshot_json);
    let node = wire["visible"][0]["id"].as_str().unwrap();
    // Stay below the existing 262144 UTF-16 per-source admission cap.
    for _ in 0..16 {
        commit(&s, node, 0, 0, &"z".repeat(16_000));
    }
    assert!(matches!(
        s.take_rich_patches(before.sequence),
        Err(NativeSessionError::ProjectionResyncRequired)
    ));
    let current = s.rich_snapshot().unwrap();
    assert_eq!(current.sequence, before.sequence + 16);
    assert!(
        s.take_rich_patches(current.sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
}
#[test]
fn alias_cursor_and_undo_redo_share_ordered_authoritative_patches() {
    let f = Fixture::new();
    let s = f.open();
    let before = s.rich_snapshot().unwrap();
    let wire = json(&before.snapshot_json);
    let node = wire["visible"][0]["id"].as_str().unwrap();
    let alias = s.clone();
    commit(&s, node, 0, 0, "history");
    let first = alias.take_rich_patches(before.sequence).unwrap();
    assert!(matches!(
        s.take_rich_patches(before.sequence),
        Err(NativeSessionError::InvalidProjectionCursor)
    ));
    s.undo(first.revision, 0).unwrap().unwrap();
    s.redo(s.read(0).unwrap().revision.unwrap(), 0)
        .unwrap()
        .unwrap();
    let patches = s.take_rich_patches(first.sequence).unwrap();
    assert_eq!(patches.patches_json.len(), 2);
    assert_eq!(json(&patches.patches_json[0])["operation"], "Undo");
    assert_eq!(json(&patches.patches_json[1])["operation"], "Redo");
}

fn anchor_input(node: &str, offset: u32, bias: AnchorBias) -> AnchorInput {
    AnchorInput {
        node: node.into(),
        offset_utf16: offset,
        bias,
    }
}
fn capture(s: &NativeSession, inputs: Vec<AnchorInput>) -> Vec<NativeSessionAnchor> {
    s.capture_anchors(s.read(0).unwrap().revision.unwrap(), inputs)
        .unwrap()
}
fn anchor_position(
    s: &NativeSession,
    token: &str,
    node: &str,
    offset: u32,
    right: bool,
) -> NativeSessionAnchorRead {
    let read = s.resolve_anchor(token.into()).unwrap();
    assert_eq!(Some(read.revision.clone()), s.read(0).unwrap().revision);
    match &read.resolution {
        NativeAnchorResolution::Position {
            node: actual,
            offset_utf16,
            bias,
            source,
            ..
        } => {
            assert_eq!(actual, node);
            assert_eq!(*offset_utf16, offset);
            assert_eq!(matches!(bias, AnchorBias::Right), right);
            assert!(!source.is_empty());
        }
        other => panic!("expected position, got {other:?}"),
    }
    read
}
#[test]
fn anchors_move_selected_unicode_bidi_nodes_with_both_biases_and_owned_lineage() {
    let f = Fixture::new();
    let s = f.open();
    let nodes = s.read(0).unwrap().nodes;
    let a = capture(
        &s,
        vec![
            anchor_input(&nodes[0].id, 3, AnchorBias::Left),
            anchor_input(&nodes[0].id, 3, AnchorBias::Right),
            anchor_input(&nodes[2].id, 8, AnchorBias::Right),
        ],
    );
    for anchor in &a {
        assert_eq!(anchor.document_id, f.options.document_id);
        assert_eq!(anchor.epoch, f.options.epoch);
        assert!(anchor.token.contains(&f.options.document_id));
        assert!(anchor.token.contains(&f.options.epoch));
        assert_eq!(Some(anchor.revision.clone()), s.read(0).unwrap().revision);
    }
    commit(&s, &nodes[0].id, 3, 3, "😀");
    commit(&s, &nodes[2].id, 0, 0, "אב");
    anchor_position(&s, &a[0].token, &nodes[0].id, 3, false);
    anchor_position(&s, &a[1].token, &nodes[0].id, 5, true);
    let detached = anchor_position(&s, &a[2].token, &nodes[2].id, 10, true);
    assert_ne!(a[0].revision, detached.revision);
    s.dispose().unwrap();
    assert_eq!(detached.document_id, f.options.document_id);
    assert!(matches!(
        detached.resolution,
        NativeAnchorResolution::Position {
            offset_utf16: 10,
            ..
        }
    ));
}
#[test]
fn anchors_unicode_combining_bidi_and_attachment_boundaries_use_shared_rules() {
    let f = Fixture::new();
    let s = f.open();
    let nodes = s.read(0).unwrap().nodes;
    for (index, boundaries) in [
        (0, vec![0, 1, 3, 4, 5]),
        (1, vec![0]),
        (2, vec![0, 5, 6, 7, 8, 9, 10, 11, 12]),
    ] {
        for offset in boundaries {
            for bias in [AnchorBias::Left, AnchorBias::Right] {
                let right = matches!(bias, AnchorBias::Right);
                let a = capture(&s, vec![anchor_input(&nodes[index].id, offset, bias)]);
                anchor_position(&s, &a[0].token, &nodes[index].id, offset, right);
                s.release_anchor(a[0].token.clone()).unwrap();
            }
        }
    }
    let rev = s.read(0).unwrap().revision.unwrap();
    for (node, offset) in [(&nodes[0].id, 2), (&nodes[0].id, 6), (&nodes[1].id, 1)] {
        assert!(matches!(
            s.capture_anchors(
                rev.clone(),
                vec![anchor_input(node, offset, AnchorBias::Right)]
            ),
            Err(NativeSessionError::AnchorTarget { .. })
        ));
    }
}
#[test]
fn anchors_deleted_text_collapses_without_caret_diff_and_undo_redo_follow_shared_history() {
    let f = Fixture::new();
    let s = f.open();
    let node = s.read(0).unwrap().nodes[0].id.clone();
    let a = capture(&s, vec![anchor_input(&node, 3, AnchorBias::Right)]);
    commit(&s, &node, 1, 5, "");
    anchor_position(&s, &a[0].token, &node, 1, true);
    s.undo(s.read(0).unwrap().revision.unwrap(), 0)
        .unwrap()
        .unwrap();
    // Shared sticky positions whose characters were deleted stay collapsed at
    // the surviving boundary; history does not retarget this retained anchor.
    anchor_position(&s, &a[0].token, &node, 1, true);
    s.redo(s.read(0).unwrap().revision.unwrap(), 0)
        .unwrap()
        .unwrap();
    anchor_position(&s, &a[0].token, &node, 1, true);
}
#[test]
fn anchors_stale_cross_document_and_malformed_capture_are_atomic() {
    let f = Fixture::new();
    let s = f.open();
    let other = Fixture::new();
    let foreign = other.open();
    let before = s.rich_snapshot().unwrap();
    let node = s.read(0).unwrap().nodes[0].id.clone();
    let input = || vec![anchor_input(&node, 1, AnchorBias::Left)];
    assert!(matches!(
        s.capture_anchors(foreign.read(0).unwrap().revision.unwrap(), input()),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::ScopeMismatch,
            ..
        })
    ));
    assert!(matches!(
        s.capture_anchors(vec![0; 65], input()),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::InvalidToken,
            ..
        })
    ));
    commit(&s, &node, 1, 3, ""); // deletion-only changes must stale the capture revision
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    assert!(matches!(
        s.capture_anchors(before.revision, input()),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    assert_eq!(checkpoint, s.recovery_export().unwrap().checkpoint.bytes);
    s.dispose().unwrap();
    foreign.dispose().unwrap();
}
#[test]
fn anchors_atomic_capture_bounded_slots_release_and_never_reuse_tokens() {
    let f = Fixture::new();
    let s = f.open();
    let node = s.read(0).unwrap().nodes[0].id.clone();
    let projection = s.rich_snapshot().unwrap();
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    let input = || anchor_input(&node, 1, AnchorBias::Right);
    let revision = projection.revision.clone();
    assert!(matches!(
        s.capture_anchors(
            revision.clone(),
            vec![input(), anchor_input("absent", 0, AnchorBias::Left)]
        ),
        Err(NativeSessionError::AnchorTarget { .. })
    ));
    assert!(matches!(
        s.capture_anchors(revision.clone(), vec![input(); 129]),
        Err(NativeSessionError::ResourceLimit)
    ));
    let mut anchors = vec![];
    for _ in 0..8 {
        anchors.extend(capture(&s, vec![input(); 128]));
    }
    assert_eq!(anchors.len(), 1024);
    assert!(matches!(
        s.capture_anchors(revision.clone(), vec![input()]),
        Err(NativeSessionError::ResourceLimit)
    ));
    let old = anchors.remove(0);
    s.release_anchor(old.token.clone()).unwrap();
    s.release_anchor(old.token.clone()).unwrap();
    assert!(matches!(
        s.resolve_anchor(old.token.clone()),
        Err(NativeSessionError::InvalidAnchor)
    ));
    let replacement = capture(&s, vec![input()]).remove(0);
    assert_ne!(replacement.token, old.token);
    for a in anchors {
        s.release_anchor(a.token).unwrap();
    }
    s.release_anchor(replacement.token).unwrap();
    assert_eq!(checkpoint, s.recovery_export().unwrap().checkpoint.bytes);
    assert!(
        s.take_rich_patches(projection.sequence)
            .unwrap()
            .patches_json
            .is_empty()
    );
}
#[test]
fn anchors_cross_worker_same_store_alias_cancellation_and_disposal_ownership() {
    let f = Fixture::new();
    let s = f.open();
    let other = f.open();
    let alias = s.clone();
    let node = s.read(0).unwrap().nodes[0].id.clone();
    let a = capture(&s, vec![anchor_input(&node, 3, AnchorBias::Right)]).remove(0);
    let b = capture(&other, vec![anchor_input(&node, 3, AnchorBias::Right)]).remove(0);
    assert_ne!(a.token, b.token);
    assert!(matches!(
        other.resolve_anchor(a.token.clone()),
        Err(NativeSessionError::InvalidAnchor)
    ));
    other.release_anchor(a.token.clone()).unwrap();
    s.cancel_edits(edit(&s, &node, 0, 0, "cancelled")).unwrap();
    let detached = anchor_position(&alias, &a.token, &node, 3, true);
    assert_eq!(detached.revision, a.revision);
    alias.release_anchor(a.token.clone()).unwrap();
    assert!(matches!(
        s.resolve_anchor(a.token.clone()),
        Err(NativeSessionError::InvalidAnchor)
    ));
    s.dispose().unwrap();
    alias.dispose().unwrap();
    assert!(matches!(
        alias.capture_anchors(a.revision.clone(), vec![]),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.resolve_anchor(a.token.clone()),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        alias.release_anchor(a.token),
        Err(NativeSessionError::Disposed)
    ));
    anchor_position(&other, &b.token, &node, 3, true);
    other.dispose().unwrap();
    let reopened = f.open();
    let a_token_for_reopen = b.token.clone();
    assert!(matches!(
        reopened.resolve_anchor(b.token),
        Err(NativeSessionError::InvalidAnchor)
    ));
    let fresh = capture(&reopened, vec![anchor_input(&node, 3, AnchorBias::Right)]).remove(0);
    assert_ne!(fresh.token, a_token_for_reopen);
    reopened.dispose().unwrap();
    assert_eq!(detached.document_id, f.options.document_id);
}
