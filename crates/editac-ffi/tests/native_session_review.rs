//! Canonical review over actual NativeSession/SQLite; no prepared engine/provider.
use editac_diff::{
    portable::{ChangeInput, ChangeModel, MAX_BYTES},
    representation::{ImmutableRevision, RepresentationLimits, RevisionInput, RevisionScope},
    text::{PatchLimits, TextPatch},
};
use editac_ffi::*;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
#[path = "support/rich_fixture.rs"]
mod rich_fixture;
const LIMIT: u64 = MAX_BYTES as u64;
struct Fixture {
    dir: PathBuf,
    options: NativeSessionOptions,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = root.join(format!("native-review-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let options = NativeSessionOptions {
            path: dir.join("session.sqlite").to_str().unwrap().into(),
            document_id: format!("c9100000-0000-4000-8000-{n:012x}"),
            epoch: "c9200000-0000-4000-8000-000000000001".into(),
            writable: true,
            permission_expires_at: None,
        };
        Self { dir, options }
    }
    fn create(&self) -> Arc<NativeSession> {
        NativeSession::create_local(
            self.options.clone(),
            vec![NativeSessionSeed {
                kind: "block".into(),
                text: "A🦀B".into(),
            }],
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}
fn capture(s: &NativeSession, name: &str, key: Option<&str>) -> NativeReviewRevision {
    s.capture_review_revision(
        s.read(0).unwrap().revision.unwrap(),
        name.into(),
        key.map(str::to_owned),
    )
    .unwrap()
}
fn read(s: &NativeSession, r: NativeReviewRevision) -> Vec<u8> {
    match s.read_review_revision(r, None).unwrap() {
        NativeReviewRead::Available { bytes, .. } => bytes,
        other => panic!("unexpected {other:?}"),
    }
}
fn edit(s: &NativeSession, value: &str) -> NativeSessionCommit {
    let r = s.read(0).unwrap();
    let plan = s
        .prepare_edits(
            r.revision.unwrap(),
            vec![NativeSessionEdit {
                node: r.nodes[0].id.clone(),
                from_utf16: 1,
                to_utf16: 3,
                text: value.into(),
            }],
            "review-test-untrusted-label".into(),
            0,
        )
        .unwrap();
    s.commit_edits(plan, 0).unwrap().unwrap()
}
fn unavailable(s: &NativeSession, r: NativeReviewRevision, reason: NativeReviewUnavailable) {
    assert!(
        matches!(s.read_review_revision(r, None).unwrap(), NativeReviewRead::Unavailable { reason: got } if got == reason)
    );
}
fn model(s: &NativeSession, a: NativeReviewRevision, b: NativeReviewRevision) -> NativeChangeModel {
    match s.compare_review_revisions(a, b, None, None, LIMIT).unwrap() {
        NativeReviewComparison::Available { model } => model,
        other => panic!("unexpected {other:?}"),
    }
}
#[test]
fn sqlite_capture_compare_is_immutable_and_preserves_live_history_journal_and_projection_queue() {
    let f = Fixture::new();
    let s = f.create();
    let projection = s.rich_snapshot().unwrap();
    let before = capture(&s, "label-is-not-an-author", None);
    assert_eq!(before.document_id, f.options.document_id);
    assert_eq!(before.epoch, f.options.epoch);
    assert!(!before.schema.is_empty() && !before.module_profile.is_empty());
    assert_eq!(before.hash.len(), 32);
    assert_eq!(before.observed_revision.len(), 65);
    assert_eq!(before.representation, NativeReviewRepresentation::Semantic);
    let owned_before = read(&s, before.clone());
    let receipt = edit(&s, "xy");
    assert_eq!(receipt.sequence, 1);
    let after = capture(&s, "after", None);
    assert_ne!(before.hash, after.hash);
    let live = s.read(0).unwrap();
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    let history = s.history_state(0).unwrap();
    let pending: Vec<_> = s
        .pending_updates()
        .unwrap()
        .into_iter()
        .map(|p| (p.writer, p.sequence, p.checksum, p.bytes))
        .collect();
    let disk = std::fs::read(&f.options.path).unwrap();
    let wire = model(&s, before.clone(), after.clone());
    assert_eq!(wire.attribution, "unknown");
    let value: Value = serde_json::from_slice(&wire.json).unwrap();
    assert_eq!(value["input"]["model"]["attribution"], "unknown");
    let changes = value["input"]["model"]["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1);
    assert!(
        changes[0]["facets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "Text")
    );
    assert_eq!(read(&s, before.clone()), owned_before);
    assert_eq!(
        s.validate_change_model(wire.json.clone(), LIMIT)
            .unwrap()
            .json,
        wire.json
    );
    assert_eq!(s.read(0).unwrap().revision, live.revision);
    assert_eq!(s.read(0).unwrap().nodes[0].text, "AxyB");
    assert_eq!(s.recovery_export().unwrap().checkpoint.bytes, checkpoint);
    assert_eq!(s.history_state(0).unwrap(), history);
    assert_eq!(
        s.pending_updates()
            .unwrap()
            .into_iter()
            .map(|p| (p.writer, p.sequence, p.checksum, p.bytes))
            .collect::<Vec<_>>(),
        pending
    );
    assert_eq!(std::fs::read(&f.options.path).unwrap(), disk);
    assert!(
        !s.take_rich_patches(projection.sequence)
            .unwrap()
            .patches_json
            .is_empty(),
        "review must not consume live deltas"
    );
    s.undo(live.revision.unwrap(), 0).unwrap().unwrap();
    assert_eq!(s.read(0).unwrap().nodes[0].text, "A🦀B");
    s.dispose().unwrap();
    assert!(!owned_before.is_empty());
    let reopened = NativeSession::open(f.options.clone()).unwrap();
    unavailable(&reopened, before, NativeReviewUnavailable::Missing);
    assert_eq!(reopened.read(0).unwrap().nodes[0].text, "A🦀B");
    reopened.dispose().unwrap();
}
#[test]
fn capture_and_unavailable_comparisons_preserve_readonly_sqlite_and_pending_receipts() {
    let f = Fixture::new();
    let s = f.create();
    let old = capture(&s, "before edit", None);
    edit(&s, "xy");
    s.set_permission(false, Some(0)).unwrap();
    let snapshot = || {
        let mut files: Vec<_> = std::fs::read_dir(&f.dir)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (entry.file_name(), std::fs::read(entry.path()).unwrap())
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        (
            s.read(0).unwrap().revision,
            s.history_state(0).unwrap(),
            s.recovery_export().unwrap().checkpoint.bytes,
            s.pending_updates()
                .unwrap()
                .into_iter()
                .map(|p| (p.writer, p.sequence, p.checksum, p.bytes))
                .collect::<Vec<_>>(),
            files,
        )
    };
    let baseline = snapshot();
    assert_eq!(baseline.3.len(), 1, "exercise an actual pending receipt");
    let current = capture(&s, "readonly capture", None);
    assert_eq!(snapshot(), baseline, "capture itself must be read-only");
    let owned = read(&s, current.clone());
    assert_eq!(model(&s, old, current.clone()).attribution, "unknown");

    let foreign = Fixture::new();
    let other = foreign.create();
    let missing = capture(&other, "foreign session", None);
    other.dispose().unwrap();
    let mut schema = current.clone();
    schema.schema.push_str("-future");
    let mut profile = current.clone();
    profile.module_profile.push_str("-future");
    let locked = capture(&s, "locked", Some("host-key-generation"));
    for (unavailable, reason) in [
        (missing, NativeReviewUnavailable::Missing),
        (schema, NativeReviewUnavailable::IncompatibleSchema),
        (profile, NativeReviewUnavailable::IncompatibleSchema),
        (locked, NativeReviewUnavailable::KeyUnavailable),
    ] {
        for side in [NativeReviewSide::Before, NativeReviewSide::After] {
            let (before, after) = match side {
                NativeReviewSide::Before => (unavailable.clone(), current.clone()),
                NativeReviewSide::After => (current.clone(), unavailable.clone()),
            };
            assert!(matches!(
                s.compare_review_revisions(before, after, None, None, LIMIT).unwrap(),
                NativeReviewComparison::Unavailable { side: got_side, reason: got_reason }
                    if got_side == side && got_reason == reason
            ));
        }
    }
    s.set_review_retention(0, 0).unwrap();
    assert!(matches!(
        s.compare_review_revisions(current.clone(), current.clone(), None, None, LIMIT)
            .unwrap(),
        NativeReviewComparison::Unavailable {
            side: NativeReviewSide::Before,
            reason: NativeReviewUnavailable::Pruned
        }
    ));
    // Widening does not resurrect the old handle; the new capture is retained.
    s.set_review_retention(1, 32 * 1024 * 1024).unwrap();
    let retained = capture(&s, "retained", None);
    assert!(matches!(
        s.compare_review_revisions(retained, current.clone(), None, None, LIMIT)
            .unwrap(),
        NativeReviewComparison::Unavailable {
            side: NativeReviewSide::After,
            reason: NativeReviewUnavailable::Pruned
        }
    ));
    assert_eq!(snapshot(), baseline);
    s.dispose().unwrap();
    assert!(!owned.is_empty());
    let reopened = NativeSession::open(f.options.clone()).unwrap();
    unavailable(&reopened, current, NativeReviewUnavailable::Missing);
    assert_eq!(reopened.read(0).unwrap().nodes[0].text, "AxyB");
    assert_eq!(reopened.pending_updates().unwrap().len(), 1);
    reopened.dispose().unwrap();
}
#[test]
fn actual_rich_projection_preserves_marks_atoms_sources_and_complete_semantic_payloads() {
    let f = rich_fixture::Fixture::new();
    let s = f.open();
    assert!(!f.expected["visible"].as_array().unwrap().is_empty());
    let before = capture(&s, "rich", None);
    let bytes = read(&s, before.clone());
    let snapshot: Value =
        serde_json::from_slice(&bytes[editac_diff::representation::SEMANTIC_ENCODING.len() + 1..])
            .unwrap();
    assert_eq!(snapshot["visible"].as_array().unwrap().len(), 3);
    assert!(String::from_utf8(bytes).unwrap().contains("fixture.png"));
    edit(&s, "changed");
    let after = capture(&s, "rich-after", None);
    let wire = model(&s, before, after);
    let decoded = ChangeModel::decode(&wire.json, MAX_BYTES).unwrap();
    let ChangeInput::Semantic { model } = decoded.input else {
        panic!("semantic required")
    };
    assert_eq!(model.changes.len(), 1);
    let node = model.changes[0].before.as_ref().unwrap();
    assert!(
        node.runs
            .iter()
            .any(|run| !run.marks.as_object().unwrap().is_empty())
    );
    assert!(!node.spans.is_empty());
    s.dispose().unwrap();
}
#[test]
fn missing_pruned_incompatible_and_rotated_key_are_explicit_with_comparison_side() {
    let f = Fixture::new();
    let s = f.create();
    let locked = capture(&s, "locked", Some("key-v1"));
    unavailable(&s, locked.clone(), NativeReviewUnavailable::KeyUnavailable);
    assert!(matches!(
        s.read_review_revision(locked.clone(), Some("key-v2".into()))
            .unwrap(),
        NativeReviewRead::Unavailable {
            reason: NativeReviewUnavailable::KeyUnavailable
        }
    ));
    assert!(matches!(
        s.read_review_revision(locked.clone(), Some("key-v1".into()))
            .unwrap(),
        NativeReviewRead::Available { .. }
    ));
    let open = capture(&s, "open", None);
    assert!(matches!(
        s.compare_review_revisions(open.clone(), locked.clone(), None, None, LIMIT)
            .unwrap(),
        NativeReviewComparison::Unavailable {
            side: NativeReviewSide::After,
            reason: NativeReviewUnavailable::KeyUnavailable
        }
    ));
    assert!(matches!(
        s.compare_review_revisions(locked.clone(), open.clone(), None, None, LIMIT)
            .unwrap(),
        NativeReviewComparison::Unavailable {
            side: NativeReviewSide::Before,
            reason: NativeReviewUnavailable::KeyUnavailable
        }
    ));
    let mut incompatible = open.clone();
    incompatible.schema.push_str("-future");
    unavailable(
        &s,
        incompatible,
        NativeReviewUnavailable::IncompatibleSchema,
    );
    let mut incompatible = open.clone();
    incompatible.module_profile.push_str("-future");
    unavailable(
        &s,
        incompatible,
        NativeReviewUnavailable::IncompatibleSchema,
    );
    s.set_review_retention(1, 32 * 1024 * 1024).unwrap();
    unavailable(&s, locked, NativeReviewUnavailable::Pruned);
    let other = Fixture::new();
    let other_s = other.create();
    unavailable(&other_s, open.clone(), NativeReviewUnavailable::Missing);
    s.set_review_retention(0, 0).unwrap();
    unavailable(&s, open, NativeReviewUnavailable::Pruned);
    s.dispose().unwrap();
    other_s.dispose().unwrap();
}
#[test]
fn all_revision_bindings_and_bounded_input_reject_without_mutation_or_eviction() {
    let f = Fixture::new();
    let s = f.create();
    let r = capture(&s, "valid", None);
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    let mut bad = r.clone();
    bad.document_id.push('x');
    assert!(matches!(
        s.read_review_revision(bad, None),
        Err(NativeSessionError::ReviewInput {
            reason: NativeReviewFailure::ScopeMismatch
        })
    ));
    let mut bad = r.clone();
    bad.epoch.push('x');
    assert!(matches!(
        s.read_review_revision(bad, None),
        Err(NativeSessionError::ReviewInput {
            reason: NativeReviewFailure::ScopeMismatch
        })
    ));
    let mut bad = r.clone();
    bad.observed_revision[64] ^= 1;
    assert!(matches!(
        s.read_review_revision(bad, None),
        Err(NativeSessionError::ReviewInput {
            reason: NativeReviewFailure::ScopeMismatch
        })
    ));
    let mut bad = r.clone();
    bad.hash[0] ^= 1;
    assert!(matches!(
        s.read_review_revision(bad, None),
        Err(NativeSessionError::ReviewInput {
            reason: NativeReviewFailure::HashMismatch
        })
    ));
    let mut bad = r.clone();
    bad.representation = NativeReviewRepresentation::ExactSource;
    assert!(matches!(
        s.read_review_revision(bad, None),
        Err(NativeSessionError::ReviewInput {
            reason: NativeReviewFailure::RepresentationMismatch
        })
    ));
    for len in [0, 64, 66] {
        let mut bad = r.clone();
        bad.observed_revision = vec![1; len];
        assert!(s.read_review_revision(bad, None).is_err());
    }
    let mut bad = r.clone();
    bad.key = "x".repeat(1025);
    assert!(matches!(
        s.read_review_revision(bad, None),
        Err(NativeSessionError::ResourceLimit)
    ));
    let mut bad = r.clone();
    bad.key = "{}".into();
    assert!(s.read_review_revision(bad, None).is_err());
    let mut bad = r.clone();
    bad.hash.pop();
    assert!(s.read_review_revision(bad, None).is_err());
    assert!(s.set_review_retention(129, 0).is_err());
    assert!(s.set_review_retention(1, 32 * 1024 * 1024 + 1).is_err());
    assert!(
        s.capture_review_revision(r.observed_revision.clone(), "x".repeat(257), None)
            .is_err()
    );
    assert!(
        s.capture_review_revision(r.observed_revision.clone(), "valid".into(), Some("".into()))
            .is_err()
    );
    assert!(matches!(
        s.compare_review_revisions(r.clone(), r.clone(), None, None, 1),
        Err(NativeSessionError::ResourceLimit)
    ));
    assert!(
        s.compare_review_revisions(r.clone(), r.clone(), None, None, 0)
            .is_err()
    );
    assert!(
        s.compare_review_revisions(r.clone(), r.clone(), None, None, LIMIT + 1)
            .is_err()
    );
    assert!(!read(&s, r).is_empty());
    assert_eq!(s.recovery_export().unwrap().checkpoint.bytes, checkpoint);
    s.dispose().unwrap();
}
#[test]
fn stale_capture_rejects_deletion_only_revision_and_read_only_capture_does_not_require_edit_permission()
 {
    let f = Fixture::new();
    let s = f.create();
    let old = capture(&s, "old", None);
    edit(&s, "");
    assert!(matches!(
        s.capture_review_revision(old.observed_revision, "stale".into(), None),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    s.set_permission(false, Some(0)).unwrap();
    let r = capture(&s, "readonly", None);
    assert!(!read(&s, r.clone()).is_empty());
    assert!(matches!(
        s.compare_review_revisions(r.clone(), r, None, None, LIMIT)
            .unwrap(),
        NativeReviewComparison::Available { .. }
    ));
    s.dispose().unwrap();
}
#[test]
fn fifo_byte_limits_and_failed_capture_preserve_existing_revision() {
    let f = Fixture::new();
    let s = f.create();
    let r = capture(&s, "retained", None);
    let n = read(&s, r.clone()).len();
    // Retained metadata counts too, so a byte cap at exactly payload size evicts.
    s.set_review_retention(1, n as u64).unwrap();
    unavailable(&s, r, NativeReviewUnavailable::Pruned);
    assert!(matches!(
        s.capture_review_revision(
            s.read(0).unwrap().revision.unwrap(),
            "too-large".into(),
            None
        ),
        Err(NativeSessionError::ResourceLimit)
    ));
    s.set_review_retention(1, 32 * 1024 * 1024).unwrap();
    let r = capture(&s, "retained", None);
    assert!(
        s.capture_review_revision(vec![0; 65], "bad".into(), None)
            .is_err()
    );
    assert!(!read(&s, r.clone()).is_empty());
    let next = capture(&s, "next", None);
    unavailable(&s, r, NativeReviewUnavailable::Pruned);
    assert!(!read(&s, next).is_empty());
    s.dispose().unwrap();
}
fn text_model(input: bool) -> Vec<u8> {
    text_model_from_sources(input, b"old\n", "new 🦀\n".as_bytes())
}
fn text_model_from_sources(input: bool, before: &[u8], after: &[u8]) -> Vec<u8> {
    let mut token = [0; 65];
    token[0] = 1;
    let scope = RevisionScope {
        document: "doc".into(),
        epoch: "epoch".into(),
        schema: "schema".into(),
        module_profile: "profile".into(),
        observed_token: token,
    };
    let make = |bytes| {
        ImmutableRevision::capture(
            scope.clone(),
            RevisionInput::ExactSource(bytes),
            RepresentationLimits::default(),
        )
        .unwrap()
    };
    let wire = TextPatch::between(&make(before), &make(after), PatchLimits::default())
        .unwrap()
        .encode(PatchLimits::default())
        .unwrap();
    ChangeModel::new(if input {
        ChangeInput::ProjectedMarkdown {
            wire,
            serializer: "serializer-v1".into(),
            dialect: "commonmark".into(),
        }
    } else {
        ChangeInput::ExactSource { wire }
    })
    .unwrap()
    .encode(MAX_BYTES)
    .unwrap()
}
#[test]
fn native_value_oracle_preserves_crlf_hashes_profiles_and_missing_final_newline() {
    let f = Fixture::new();
    let s = f.create();
    let live = s.read(0).unwrap();
    let checkpoint = s.recovery_export().unwrap().checkpoint.bytes;
    let history = s.history_state(0).unwrap();
    let disk = std::fs::read(&f.options.path).unwrap();
    for projected in [false, true] {
        let bytes = text_model_from_sources(projected, "A🦀B\r\n".as_bytes(), b"AxyB");
        let owned = s.validate_change_model(bytes.clone(), LIMIT).unwrap();
        assert_eq!(owned.json, bytes);
        assert_eq!(owned.attribution, "unknown");
        let value: Value = serde_json::from_slice(&owned.json).unwrap();
        assert_eq!(value["version"], "editac-change-model-v1");
        assert_eq!(
            value["input"]["representation"],
            if projected {
                "projected-markdown"
            } else {
                "exact-source"
            }
        );
        if projected {
            assert_eq!(value["input"]["serializer"], "serializer-v1");
            assert_eq!(value["input"]["dialect"], "commonmark");
        }
        // Read the public wire directly, without a shared decoder as the oracle.
        let wire = value["input"]["wire"].as_str().unwrap();
        let metadata: Value = serde_json::from_str(
            wire.lines()
                .next()
                .unwrap()
                .strip_prefix("# editac-exact-patch-v1 ")
                .unwrap(),
        )
        .unwrap();
        // Independent SHA-256 constants for the literal UTF-8 inputs above.
        assert_eq!(
            metadata["before_hash"],
            "e37245452c37c83c4656f948cb31f2c44fc98eea9659241d62ecd879fc8c02bd"
        );
        assert_eq!(
            metadata["after_hash"],
            "5083d1c94af28f35e4c65e63923af955467eb3b54d715c6b35e6210318f01231"
        );
        assert_eq!(metadata["before_bytes"], 8);
        assert_eq!(metadata["after_bytes"], 4);
        assert_eq!(metadata["before_final_newline"], true);
        assert_eq!(metadata["after_final_newline"], false);
        assert!(wire.ends_with("@@ -1,1 +1,1 @@\n-A🦀B\r\n+AxyB\n\\ No newline at end of file\n"));
        for (field, replacement) in [
            ("representation", Value::from("future")),
            (
                "unexpected",
                Value::from("private source must not enter diagnostics"),
            ),
        ] {
            let mut bad = value.clone();
            bad["input"][field] = replacement;
            let error = s
                .validate_change_model(serde_json::to_vec(&bad).unwrap(), LIMIT)
                .unwrap_err();
            assert!(matches!(
                error,
                NativeSessionError::ReviewInput {
                    reason: NativeReviewFailure::Invalid
                }
            ));
            assert_eq!(error.to_string(), "review input: Invalid");
        }
    }
    assert_eq!(s.read(0).unwrap().revision, live.revision);
    assert_eq!(s.read(0).unwrap().nodes[0].text, "A🦀B");
    assert_eq!(s.recovery_export().unwrap().checkpoint.bytes, checkpoint);
    assert_eq!(s.history_state(0).unwrap(), history);
    assert!(s.pending_updates().unwrap().is_empty());
    assert_eq!(std::fs::read(&f.options.path).unwrap(), disk);
    s.dispose().unwrap();
}
#[test]
fn native_semantic_value_oracle_keeps_utf16_source_spans_and_owned_payloads() {
    let f = Fixture::new();
    let s = f.create();
    let node_id = s.read(0).unwrap().nodes[0].id.clone();
    let before = capture(&s, "before", None);
    edit(&s, "xy");
    let after = capture(&s, "after", None);
    let owned = model(&s, before, after);
    let validated = s.validate_change_model(owned.json.clone(), LIMIT).unwrap();
    assert_eq!(validated.json, owned.json);
    assert_eq!(
        validated.representation,
        NativeReviewRepresentation::Semantic
    );
    s.dispose().unwrap();
    let value: Value = serde_json::from_slice(&validated.json).unwrap();
    let changes = value["input"]["model"]["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1);
    for (side, text) in [("before", "A🦀B"), ("after", "AxyB")] {
        let node = &changes[0][side];
        assert_eq!(node["id"], node_id);
        assert_eq!(node["runs"][0]["text"], text);
        let spans = node["spans"].as_array().unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0]["start"], 0);
        assert_eq!(spans[0]["end"], 4); // Emoji occupies two UTF-16 units, four UTF-8 bytes.
        assert!(!spans[0]["source"].as_str().unwrap().is_empty());
        assert!(!spans[0]["identity"].as_str().unwrap().is_empty());
    }
    assert_eq!(value["input"]["model"]["attribution"], "unknown");
}
#[test]
fn portable_exact_and_projected_validation_preserves_wire_profiles_and_rejects_limits_and_corruption()
 {
    let f = Fixture::new();
    let s = f.create();
    for projected in [false, true] {
        let bytes = text_model(projected);
        let out = s
            .validate_change_model(bytes.clone(), bytes.len() as u64)
            .unwrap();
        assert_eq!(out.json, bytes);
        assert_eq!(out.attribution, "unknown");
        assert_eq!(
            out.representation,
            if projected {
                NativeReviewRepresentation::ProjectedMarkdown {
                    serializer: "serializer-v1".into(),
                    dialect: "commonmark".into(),
                }
            } else {
                NativeReviewRepresentation::ExactSource
            }
        );
        assert!(matches!(
            s.validate_change_model(bytes.clone(), bytes.len() as u64 - 1),
            Err(NativeSessionError::ResourceLimit)
        ));
        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["version"] = "future".into();
        assert!(matches!(
            s.validate_change_model(serde_json::to_vec(&bad).unwrap(), LIMIT),
            Err(NativeSessionError::ReviewInput {
                reason: NativeReviewFailure::Invalid
            })
        ));
        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["input"]["wire"] = "not-a-patch".into();
        assert!(
            s.validate_change_model(serde_json::to_vec(&bad).unwrap(), LIMIT)
                .is_err()
        );
    }
    assert!(s.validate_change_model(b"{}".to_vec(), LIMIT).is_err());
    assert!(s.validate_change_model(b"{}".to_vec(), 0).is_err());
    assert!(s.validate_change_model(b"{}".to_vec(), LIMIT + 1).is_err());
    s.dispose().unwrap();
}
#[test]
fn semantic_portable_rejects_forged_authorship_unknown_fields_and_invalid_nested_payload() {
    let f = Fixture::new();
    let s = f.create();
    let a = capture(&s, "a", None);
    edit(&s, "new");
    let b = capture(&s, "b", None);
    let wire = model(&s, a, b).json;
    let value: Value = serde_json::from_slice(&wire).unwrap();
    for (field, replacement) in [
        ("attribution", Value::String("trusted-author".into())),
        ("before_hash", Value::String("bad".into())),
        ("version", Value::String("future".into())),
    ] {
        let mut bad = value.clone();
        bad["input"]["model"][field] = replacement;
        assert!(
            s.validate_change_model(serde_json::to_vec(&bad).unwrap(), LIMIT)
                .is_err()
        );
    }
    let mut bad = value.clone();
    bad["input"]["model"]["author"] = "forged".into();
    assert!(
        s.validate_change_model(serde_json::to_vec(&bad).unwrap(), LIMIT)
            .is_err()
    );
    let mut bad = value;
    bad["input"]["model"]["changes"][0]["before"]["id"] = "foreign".into();
    assert!(
        s.validate_change_model(serde_json::to_vec(&bad).unwrap(), LIMIT)
            .is_err()
    );
    s.dispose().unwrap();
}
#[test]
fn all_review_operations_obey_disposal_and_owned_results_survive() {
    let f = Fixture::new();
    let s = f.create();
    let r = capture(&s, "owned", None);
    let bytes = read(&s, r.clone());
    let wire = text_model(false);
    let out = s.validate_change_model(wire.clone(), LIMIT).unwrap();
    s.dispose().unwrap();
    assert!(matches!(
        s.read_review_revision(r.clone(), None),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        s.capture_review_revision(r.observed_revision.clone(), "x".into(), None),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        s.compare_review_revisions(r.clone(), r, None, None, LIMIT),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        s.validate_change_model(wire, LIMIT),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        s.set_review_retention(0, 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(!bytes.is_empty());
    assert!(!out.json.is_empty());
}
