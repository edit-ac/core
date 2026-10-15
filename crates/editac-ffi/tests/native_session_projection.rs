//! Actual SQLite-backed NativeSession rich projection, never a NativeEngine DTO.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    interchange::projection_snapshot,
    modules::content::Content,
};
use editac_ffi::*;
use editac_session::{
    ports::{CheckpointRecord, LocalStore, StoreLimits},
    store::NativeStore,
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

struct Fixture {
    directory: PathBuf,
    options: NativeSessionOptions,
    expected: Value,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!("rich-session-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let options = NativeSessionOptions {
            path: directory.join("store.sqlite").to_str().unwrap().into(),
            document_id: format!("ab100000-0000-4000-8000-{n:012x}"),
            epoch: "ab200000-0000-4000-8000-000000000001".into(),
            writable: true,
            permission_expires_at: None,
        };
        let identity = DocumentIdentity::v5(&options.document_id, &options.epoch).unwrap();
        let mut doc = Document::create(
            CreationPermit::authorize_new(identity.clone()).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap();
        let id = doc.snapshot().unwrap().visible[0].id.clone();
        let anchor = doc.anchor(&id, U(0), Bias::Right).unwrap();
        let block = |text: &str, marks| FragmentBlock {
            runs: vec![FragmentRun {
                text: text.into(),
                marks,
            }],
            attributes: None,
            containers: vec![],
            checked: None,
        };
        let image = Content::Image {
            url: "https://example.invalid/fixture.png".into(),
            alt: "אב 🦀".into(),
            title: "deterministic attachment".into(),
            source: "![אב 🦀](https://example.invalid/fixture.png)".into(),
        };
        let mut atom = block("", vec![]);
        atom.attributes = Some(BlockAttributes::Unknown(image.tuple().unwrap()));
        let prepared = doc
            .prepare_fragment(
                &Selection {
                    anchor: anchor.clone(),
                    focus: anchor,
                },
                &[
                    block(
                        "A🦀אב",
                        vec![
                            (Mark::Bold, None),
                            (Mark::Link, Some("https://example.invalid/link".into())),
                        ],
                    ),
                    atom,
                    block("tail e\u{301} שלום", vec![(Mark::Italic, None)]),
                ],
                &TextOrigin::new("rich-native-fixture").unwrap(),
            )
            .unwrap();
        doc.commit_editor(prepared).unwrap();
        let expected = projection_snapshot(&doc).unwrap();
        let store =
            NativeStore::create_new(&options.path, identity, StoreLimits::default()).unwrap();
        store
            .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
            .unwrap();
        Self {
            directory,
            options,
            expected,
        }
    }
    fn open(&self) -> Arc<NativeSession> {
        NativeSession::open(self.options.clone()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
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
