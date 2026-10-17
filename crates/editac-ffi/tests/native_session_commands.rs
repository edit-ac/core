//! Actual native Session + SQLite, portable command transport, no providers.
use editac_ffi::*;
use serde_json::{Value, json};
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
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!("native-commands-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let options = NativeSessionOptions {
            path: directory.join("session.sqlite").to_str().unwrap().into(),
            document_id: format!("ad100000-0000-4000-8000-{n:012x}"),
            epoch: "ad200000-0000-4000-8000-000000000001".into(),
            writable: true,
            permission_expires_at: None,
        };
        Self { directory, options }
    }
    fn create(&self) -> Arc<NativeSession> {
        NativeSession::create_local(
            self.options.clone(),
            vec![
                NativeSessionSeed {
                    kind: "block".into(),
                    text: "A🦀אבB".into(),
                },
                NativeSessionSeed {
                    kind: "block".into(),
                    text: "second".into(),
                },
            ],
        )
        .unwrap()
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
fn revision(s: &NativeSession) -> Vec<u8> {
    s.read(0).unwrap().revision.unwrap()
}
fn snapshot(s: &NativeSession) -> Value {
    let mut value: Value = serde_json::from_str(&s.rich_snapshot().unwrap().snapshot_json).unwrap();
    // Observation deltas are consumed by reads, independently of semantic mutation.
    value.as_object_mut().unwrap().remove("changedNodes");
    value.as_object_mut().unwrap().remove("touchedRanges");
    value
}
fn node<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["visible"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == id)
        .unwrap()
}

fn text(n: &Value) -> String {
    n["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect()
}
fn plan(s: &NativeSession, commands: Value) -> NativePreparedCommands {
    s.prepare_commands(
        revision(s),
        commands.to_string(),
        "native-command-proof".into(),
        0,
    )
    .unwrap()
}
fn apply(s: &NativeSession, commands: Value) -> NativeSessionCommit {
    let p = plan(s, commands);
    s.commit_commands(p.token, 0).unwrap().unwrap()
}
fn anchor(s: &NativeSession, node: &str, offset: u32) -> String {
    s.capture_anchors(
        revision(s),
        vec![AnchorInput {
            node: node.into(),
            offset_utf16: offset,
            bias: AnchorBias::Right,
        }],
    )
    .unwrap()
    .remove(0)
    .token
}
fn assert_unchanged(s: &NativeSession, before: &Value, rev: &[u8], pending: u64) {
    assert_eq!(&snapshot(s), before);
    assert_eq!(revision(s), rev);
    assert_eq!(s.read(0).unwrap().pending_upload, pending);
}

#[test]
fn split_is_inert_until_one_durable_commit_and_restores_same_document() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let owner = before["visible"][0]["id"].as_str().unwrap();
    let at = anchor(&s, owner, 3);
    let p = plan(&s, json!([{ "type":"split", "owner":owner, "at":at }]));
    assert_eq!(p.revision, revision(&s));
    assert_eq!(snapshot(&s), before);
    let receipt = s.commit_commands(p.token.clone(), 0).unwrap().unwrap();
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.durability, NativeSessionDurability::ProcessCrash);
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    let after = snapshot(&s);
    assert_eq!(after["visible"].as_array().unwrap().len(), 3);
    assert_eq!(text(&after["visible"][0]), "A🦀");
    assert_eq!(text(&after["visible"][1]), "אבB");
    assert_eq!(s.read(0).unwrap().pending_upload, 1);
    s.dispose().unwrap();
    let restored = f.open();
    let read = snapshot(&restored);
    assert_eq!(read["visible"], after["visible"]);
    assert_eq!(read["retainedStructure"], after["retainedStructure"]);
    restored.dispose().unwrap();
}
#[test]
fn join_uses_shared_sources_and_preserves_unicode_and_bidi() {
    let f = Fixture::new();
    let s = f.create();
    let r = s.read(0).unwrap();
    apply(
        &s,
        json!([{ "type":"join", "first":r.nodes[0].id, "second":r.nodes[1].id }]),
    );
    let after = s.read(0).unwrap();
    assert_eq!(after.nodes.len(), 1);
    assert_eq!(after.nodes[0].text, "A🦀אבBsecond");
    assert_eq!(after.pending_upload, 1);
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(reopened.read(0).unwrap().nodes[0].text, after.nodes[0].text);
    reopened.dispose().unwrap();
}
#[test]
fn move_uses_actual_structural_versions_and_shared_order() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let a = &before["visible"][0];
    let b = &before["visible"][1];
    apply(
        &s,
        json!([{ "type":"move", "target":{"id":b["id"],"version":b["editor"]["version"]}, "parent":{"id":"@root","version":"base"}, "before":{"id":a["id"],"version":a["editor"]["version"]} }]),
    );
    let after = snapshot(&s);
    assert_eq!(after["visible"][0]["id"], b["id"]);
    assert_eq!(after["visible"][1]["id"], a["id"]);
    assert_eq!(text(&after["visible"][1]), "A🦀אבB");
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(snapshot(&reopened)["visible"], after["visible"]);
    reopened.dispose().unwrap();
}
#[test]
fn marks_and_code_paragraph_commands_use_existing_rust_semantics() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    apply(
        &s,
        json!([{ "type":"markAt", "owner":owner,"from":1,"to":5,"mark":"bold","action":"apply" }]),
    );
    let rich = snapshot(&s);
    assert!(
        rich["visible"][0]["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["text"] == "🦀אב" && r["attributes"]["bold"] == true)
    );
    apply(
        &s,
        json!([{ "type":"setCode", "owner":owner, "language":"rust" }]),
    );
    assert_eq!(
        snapshot(&s)["visible"][0]["blockAttributes"],
        json!(["code", "rust"])
    );
    apply(&s, json!([{ "type":"setParagraph", "owner":owner }]));
    assert_eq!(
        snapshot(&s)["visible"][0]["blockAttributes"],
        json!(["paragraph"])
    );
    s.dispose().unwrap();
}
#[test]
fn checklist_wrap_style_and_checked_use_shared_container_and_owner() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    apply(
        &s,
        json!([{ "type":"wrap", "targets":[owner], "style":{"type":"checklist"} }]),
    );
    let rich = snapshot(&s);
    let n = node(&rich, &owner);
    let parent = n["parent"].clone();
    assert_ne!(parent, "@root");
    assert_eq!(n["editor"]["checked"], false);
    apply(
        &s,
        json!([{ "type":"setChecked", "owner":owner, "checked":true }]),
    );
    assert_eq!(node(&snapshot(&s), &owner)["editor"]["checked"], true);
    apply(
        &s,
        json!([{ "type":"setStyle", "container":parent, "style":{"type":"ordered","start":3} }]),
    );
    assert_eq!(node(&snapshot(&s), &owner)["editor"]["number"], 3);
    s.dispose().unwrap();
}
#[test]
fn captured_sticky_target_survives_other_edits_and_release_after_prepare() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let at = anchor(&s, &owner, 3);
    apply(
        &s,
        json!([{ "type":"replaceAt", "owner":owner,"from":0,"to":0,"text":"前" }]),
    );
    let p = plan(&s, json!([{ "type":"insert", "at":at, "text":"!" }]));
    s.release_anchor(at).unwrap();
    s.commit_commands(p.token, 0).unwrap();
    assert_eq!(s.read(0).unwrap().nodes[0].text, "前A🦀!אבB");
    s.dispose().unwrap();
}
#[test]
fn invalid_final_command_and_surrogate_cut_leave_no_partial_mutation() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let r = revision(&s);
    let owner = &before["visible"][0]["id"];
    let commands = json!([{ "type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X" },{ "type":"markAt","owner":owner,"from":2,"to":3,"mark":"bold","action":"apply" }]);
    assert!(
        s.prepare_commands(r.clone(), commands.to_string(), "invalid".into(), 0)
            .is_err()
    );
    assert_unchanged(&s, &before, &r, 0);
    s.dispose().unwrap();
}
#[test]
fn invalid_wire_fields_and_unknown_commands_are_typed_and_atomic() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let r = revision(&s);
    for input in [
        "not json",
        "{}",
        "[{\"type\":\"undo\"}]",
        "[{\"type\":\"join\",\"first\":\"x\",\"second\":\"y\",\"extra\":1}]",
    ] {
        assert!(matches!(
            s.prepare_commands(r.clone(), input.into(), "bad".into(), 0),
            Err(NativeSessionError::CommandInput { .. })
        ));
    }
    assert_unchanged(&s, &before, &r, 0);
    s.dispose().unwrap();
}
#[test]
fn stale_preparation_and_stale_commit_reject_without_second_mutation() {
    let f = Fixture::new();
    let s = f.create();
    let old = revision(&s);
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let c = json!([{ "type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X" }]);
    let p = plan(&s, c.clone());
    apply(&s, c.clone());
    let before = snapshot(&s);
    let current = revision(&s);
    assert!(matches!(
        s.prepare_commands(old, c.to_string(), "stale".into(), 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    assert!(matches!(
        s.commit_commands(p.token.clone(), 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert_unchanged(&s, &before, &current, 1);
    s.dispose().unwrap();
}
#[test]
fn foreign_revision_anchor_and_plan_reject_on_other_session() {
    let f = Fixture::new();
    let s = f.create();
    let other_f = Fixture::new();
    let other = other_f.create();
    let before = snapshot(&other);
    let r = revision(&other);
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let at = anchor(&s, &owner, 3);
    assert!(matches!(
        other.prepare_commands(
            r.clone(),
            json!([{ "type":"insert","at":at,"text":"!" }]).to_string(),
            "foreign".into(),
            0
        ),
        Err(NativeSessionError::InvalidAnchor)
    ));
    assert!(matches!(
        other.prepare_commands(revision(&s), "[]".into(), "foreign".into(), 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::ScopeMismatch,
            ..
        })
    ));
    let p = plan(&s, json!([{ "type":"insert","at":at,"text":"!" }]));
    assert!(matches!(
        other.commit_commands(p.token.clone(), 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert_unchanged(&other, &before, &r, 0);
    s.cancel_commands(p.token).unwrap();
    s.dispose().unwrap();
    other.dispose().unwrap();
}
#[test]
fn reopening_same_store_cannot_consume_previous_workers_plan_or_anchor() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let at = anchor(&s, &owner, 3);
    let p = plan(&s, json!([{ "type":"insert","at":at,"text":"!" }]));
    s.dispose().unwrap();
    let reopened = f.open();
    assert!(matches!(
        reopened.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert!(matches!(
        reopened.prepare_commands(
            revision(&reopened),
            json!([{ "type":"insert","at":at,"text":"!" }]).to_string(),
            "reopen".into(),
            0
        ),
        Err(NativeSessionError::InvalidAnchor)
    ));
    reopened.dispose().unwrap();
}
#[test]
fn revoked_or_expired_permission_consumes_plan_without_mutation() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let c = json!([{ "type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X" }]);
    for expiry in [None, Some(5)] {
        s.set_permission(true, None).unwrap();
        let p = plan(&s, c.clone());
        let before = snapshot(&s);
        let r = revision(&s);
        s.set_permission(expiry.is_some(), expiry).unwrap();
        let now = expiry.unwrap_or(0);
        let failure = s.commit_commands(p.token.clone(), now).unwrap_err();
        assert!(matches!(
            failure,
            NativeSessionError::ReadOnly | NativeSessionError::PermissionExpired
        ));
        assert!(matches!(
            s.commit_commands(p.token, now),
            Err(NativeSessionError::InvalidPlan)
        ));
        assert_unchanged(&s, &before, &r, 0);
    }
    s.dispose().unwrap();
}
#[test]
fn bounded_plans_cancel_idempotently_share_legacy_pool_and_dispose() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let before = snapshot(&s);
    let r = revision(&s);
    let c = json!([{ "type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X" }]);
    let mut tokens = vec![];
    for _ in 0..128 {
        tokens.push(plan(&s, c.clone()).token);
    }
    assert!(matches!(
        s.prepare_commands(r.clone(), c.to_string(), "limit".into(), 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    assert!(matches!(
        s.prepare_edits(r.clone(), vec![], "limit".into(), 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    let token = tokens.pop().unwrap();
    s.cancel_commands(token.clone()).unwrap();
    s.cancel_commands(token.clone()).unwrap();
    assert!(matches!(
        s.commit_commands(token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    let replacement = plan(&s, c);
    assert!(!tokens.contains(&replacement.token));
    assert_unchanged(&s, &before, &r, 0);
    s.dispose().unwrap();
    assert!(matches!(
        s.commit_commands(replacement.token, 0),
        Err(NativeSessionError::Disposed)
    ));
}
#[test]
fn command_count_and_byte_limits_reject_before_mutation_or_retaining_plan() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let r = revision(&s);
    let too_many = json!(vec![json!({"type":"join","first":"x","second":"y"}); 129]);
    assert!(matches!(
        s.prepare_commands(r.clone(), too_many.to_string(), "limit".into(), 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    assert!(matches!(
        s.prepare_commands(r.clone(), " ".repeat(1_048_577), "limit".into(), 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    assert_unchanged(&s, &before, &r, 0);
    s.dispose().unwrap();
}
#[test]
fn applicability_uses_planner_without_mutation_or_spending_plan_slots() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let r = revision(&s);
    let owner = &before["visible"][0]["id"];
    let good =
        json!([{ "type":"markAt","owner":owner,"from":1,"to":3,"mark":"bold","action":"apply" }])
            .to_string();
    for _ in 0..130 {
        s.check_commands(r.clone(), good.clone(), "check".into(), 0)
            .unwrap();
    }
    assert!(
        s.check_commands(
            r.clone(),
            json!([{ "type":"join","first":owner,"second":"missing" }]).to_string(),
            "check".into(),
            0
        )
        .is_err()
    );
    assert_unchanged(&s, &before, &r, 0);
    let p = plan(&s, serde_json::from_str(&good).unwrap());
    s.cancel_commands(p.token).unwrap();
    s.dispose().unwrap();
}

#[test]
fn split_wrong_owner_and_stale_move_version_are_pre_mutation_rejections() {
    let f = Fixture::new();
    let s = f.create();
    let r = s.read(0).unwrap();
    let before = snapshot(&s);
    let rev = r.revision.unwrap();
    let at = anchor(&s, &r.nodes[0].id, 3);
    assert!(
        s.prepare_commands(
            rev.clone(),
            json!([{"type":"split","owner":r.nodes[1].id,"at":at}]).to_string(),
            "wrong-owner".into(),
            0
        )
        .is_err()
    );
    assert!(s.check_commands(rev.clone(),json!([{"type":"move","target":{"id":r.nodes[0].id,"version":"foreign-structural-version"},"parent":{"id":"@root","version":"base"}}]).to_string(),"stale-move".into(),0).is_err());
    assert_unchanged(&s, &before, &rev, 0);
    s.dispose().unwrap();
}
#[test]
fn hard_break_separator_insert_and_delete_are_shared_commands() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let at = anchor(&s, &owner, 3);
    apply(&s, json!([{"type":"hardBreak","at":at}]));
    assert_eq!(s.read(0).unwrap().nodes[0].text, "A🦀\nאבB");
    apply(
        &s,
        json!([{"type":"insertSeparator","beside":owner,"side":"after"}]),
    );
    let rich = snapshot(&s);
    let separator = rich["visible"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["blockAttributes"][0] == "separator")
        .unwrap()["id"]
        .clone();
    apply(
        &s,
        json!([{"type":"insertParagraph","separator":separator,"side":"after","text":"new paragraph"}]),
    );
    assert!(
        s.read(0)
            .unwrap()
            .nodes
            .iter()
            .any(|n| n.text == "new paragraph")
    );
    apply(&s, json!([{"type":"deleteSeparator","owner":separator}]));
    assert!(
        !snapshot(&s)["visible"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["blockAttributes"][0] == "separator")
    );
    s.dispose().unwrap();
}
#[test]
fn shared_anchor_range_delete_and_replace_preserve_explicit_targets() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let a = anchor(&s, &owner, 1);
    let b = anchor(&s, &owner, 3);
    apply(
        &s,
        json!([{"type":"replace","range":{"anchor":a,"focus":b},"text":"😀"}]),
    );
    assert_eq!(s.read(0).unwrap().nodes[0].text, "A😀אבB");
    let a = anchor(&s, &owner, 3);
    let b = anchor(&s, &owner, 5);
    apply(
        &s,
        json!([{"type":"delete","range":{"anchor":a,"focus":b}}]),
    );
    assert_eq!(s.read(0).unwrap().nodes[0].text, "A😀B");
    s.dispose().unwrap();
}
#[test]
fn concurrent_alias_commits_consume_the_same_actual_plan_once() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let p = plan(
        &s,
        json!([{"type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X"}]),
    );
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut joins = vec![];
    for _ in 0..2 {
        let owner = s.clone();
        let b = barrier.clone();
        let token = p.token.clone();
        joins.push(std::thread::spawn(move || {
            b.wait();
            owner.commit_commands(token, 0)
        }));
    }
    barrier.wait();
    let mut passed = 0;
    let mut consumed = 0;
    for j in joins {
        match j.join().unwrap() {
            Ok(Some(_)) => passed += 1,
            Err(NativeSessionError::InvalidPlan) => consumed += 1,
            e => panic!("unexpected {e:?}"),
        }
    }
    assert_eq!((passed, consumed), (1, 1));
    assert_eq!(s.read(0).unwrap().pending_upload, 1);
    s.dispose().unwrap();
}

#[test]
fn list_indent_outdent_enter_and_backspace_keep_shared_sources_and_durability() {
    let f = Fixture::new();
    let s = f.create();
    let before = snapshot(&s);
    let first = before["visible"][0]["id"].as_str().unwrap().to_owned();
    let second = before["visible"][1]["id"].as_str().unwrap().to_owned();
    apply(
        &s,
        json!([{"type":"wrap","targets":[first,second],"style":{"type":"unordered"}}]),
    );
    let parent = node(&snapshot(&s), &second)["parent"].clone();
    apply(&s, json!([{"type":"indent","owner":second}]));
    assert_ne!(node(&snapshot(&s), &second)["parent"], parent);
    apply(&s, json!([{"type":"outdent","owner":second}]));
    assert_eq!(node(&snapshot(&s), &second)["parent"], parent);
    let at = anchor(&s, &first, 3);
    apply(&s, json!([{"type":"enter","owner":first,"at":at}]));
    let split = snapshot(&s);
    let blocks = split["visible"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["kind"] == "block")
        .collect::<Vec<_>>();
    assert_eq!(blocks.len(), 3);
    assert_eq!(text(blocks[0]), "A🦀");
    assert_eq!(text(blocks[1]), "אבB");
    let tail = blocks[1]["id"].as_str().unwrap().to_owned();
    let at = anchor(&s, &tail, 0);
    apply(&s, json!([{"type":"backspace","owner":tail,"at":at}]));
    let joined = snapshot(&s);
    assert_eq!(text(node(&joined, &first)), "A🦀אבB");
    assert_eq!(text(node(&joined, &second)), "second");
    let expected = joined["visible"].clone();
    assert_eq!(s.read(0).unwrap().pending_upload, 5);
    s.dispose().unwrap();
    let restored = f.open();
    assert_eq!(snapshot(&restored)["visible"], expected);
    restored.dispose().unwrap();
}

#[test]
fn restored_heading_end_and_selection_commands_use_shared_planner_and_one_commit() {
    use editac_core::{
        Utf16Offset,
        anchors::{Bias, Selection},
        commands::{
            editor::{FragmentBlock, FragmentRun},
            text::TextOrigin,
        },
        document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    };
    use editac_session::{
        ports::{CheckpointRecord, LocalStore, StoreLimits},
        store::NativeStore,
    };
    let f = Fixture::new();
    // Deterministic persisted fixture construction only. This owner is dropped
    // before NativeSession opens the SQLite document; dispatch uses its one worker.
    {
        let identity = DocumentIdentity::v5(&f.options.document_id, &f.options.epoch).unwrap();
        let mut doc = Document::create(
            CreationPermit::authorize_new(identity.clone()).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap();
        let owner = doc.snapshot().unwrap().visible[0].id.clone();
        let at = doc.anchor(&owner, Utf16Offset(0), Bias::Right).unwrap();
        let prepared = doc
            .prepare_fragment(
                &Selection {
                    anchor: at.clone(),
                    focus: at,
                },
                &[FragmentBlock {
                    runs: vec![FragmentRun {
                        opaque_marks: vec![],
                        text: "A🦀אבB".into(),
                        marks: vec![],
                    }],
                    attributes: Some(BlockAttributes::Heading(2)),
                    containers: vec![],
                    checked: None,
                }],
                &TextOrigin::new("prepared-heading-fixture").unwrap(),
            )
            .unwrap();
        doc.commit_editor(prepared).unwrap();
        NativeStore::create_new(&f.options.path, identity, StoreLimits::default())
            .unwrap()
            .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
            .unwrap();
    }
    let s = f.open();
    let before = snapshot(&s);
    let owner = before["visible"][0]["id"].as_str().unwrap();
    let at = anchor(&s, owner, 6);
    let position = json!({"owner": owner, "offset": 6, "bias": "right"});
    let commands = json!([
        {"type":"historySelectionAt","anchor":position,"focus":position},
        {"type":"headingEnd","owner":owner,"at":at},
        {"type":"selectionAt","anchor":position,"focus":position}
    ]);
    let prepared = plan(&s, commands);
    assert_eq!(snapshot(&s), before);
    let commit = s.commit_commands(prepared.token, 0).unwrap().unwrap();
    assert_eq!(commit.sequence, 1);
    let after = snapshot(&s);
    assert_eq!(after["visible"].as_array().unwrap().len(), 2);
    assert_eq!(text(&after["visible"][0]), "A🦀אבB");
    assert_eq!(
        after["visible"][0]["blockAttributes"],
        json!(["heading", 2])
    );
    assert_eq!(after["visible"][1]["blockAttributes"], json!(["paragraph"]));
    assert_eq!(text(&after["visible"][1]), "");
    assert_eq!(s.read(0).unwrap().pending_upload, 1);
    s.undo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(snapshot(&s)["visible"], before["visible"]);
    s.redo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(snapshot(&s)["visible"], after["visible"]);
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(snapshot(&reopened)["visible"], after["visible"]);
    reopened.dispose().unwrap();
}

fn assert_history(s: &NativeSession, now: u64, undo: u64, redo: u64, admitted: bool) {
    let h = s.history_state(now).unwrap();
    assert_eq!(h.revision, s.read(now).unwrap().revision);
    assert_eq!((h.undo_groups, h.redo_groups), (undo, redo));
    assert_eq!(h.can_history, admitted);
    assert_eq!(h.can_undo, admitted && undo > 0);
    assert_eq!(h.can_redo, admitted && redo > 0);
    assert!(!h.recovery_required);
}

#[test]
fn exact_history_tracks_empty_edit_undo_redo_branch_and_durable_reopen() {
    let f = Fixture::new();
    let s = f.create();
    assert_history(&s, 0, 0, 0, true);
    // General admission is true even though neither operation has anything to do.
    assert!(s.undo(revision(&s), 0).unwrap().is_none());
    assert!(s.redo(revision(&s), 0).unwrap().is_none());
    assert_eq!(s.read(0).unwrap().pending_upload, 0);
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    let at = anchor(&s, &owner, 3);
    let p = plan(&s, json!([{"type":"split","owner":owner,"at":at}]));
    assert_history(&s, 0, 0, 0, true);
    assert_eq!(s.commit_commands(p.token, 0).unwrap().unwrap().sequence, 1);
    assert_history(&s, 0, 1, 0, true);
    let split = snapshot(&s);
    assert_eq!(s.undo(revision(&s), 0).unwrap().unwrap().sequence, 2);
    assert_history(&s, 0, 0, 1, true);
    assert_eq!(s.redo(revision(&s), 0).unwrap().unwrap().sequence, 3);
    assert_history(&s, 0, 1, 0, true);
    assert_eq!(snapshot(&s)["visible"], split["visible"]);
    s.undo(revision(&s), 0).unwrap().unwrap();
    assert_history(&s, 0, 0, 1, true);
    let p = plan(
        &s,
        json!([{"type":"replaceAt","owner":owner,"from":0,"to":1,"text":"branch"}]),
    );
    // Preparing a new edit must not clear redo until commit.
    assert_history(&s, 0, 0, 1, true);
    assert_eq!(s.commit_commands(p.token, 0).unwrap().unwrap().sequence, 5);
    assert_history(&s, 0, 1, 0, true);
    assert!(s.redo(revision(&s), 0).unwrap().is_none());
    let durable = s.read(0).unwrap();
    assert_eq!(durable.pending_upload, 5);
    s.dispose().unwrap();
    assert!(matches!(
        s.history_state(0),
        Err(NativeSessionError::Disposed)
    ));
    let restored = f.open();
    assert_eq!(
        restored.read(0).unwrap().nodes[0].text,
        durable.nodes[0].text
    );
    assert_eq!(restored.read(0).unwrap().pending_upload, 5);
    // Shared local history is process-local; durable restore does not invent it.
    assert_history(&restored, 0, 0, 0, true);
    assert!(restored.undo(revision(&restored), 0).unwrap().is_none());
    let node = restored.read(0).unwrap().nodes[0].id.clone();
    apply(
        &restored,
        json!([{"type":"replaceAt","owner":node,"from":0,"to":6,"text":"fresh"}]),
    );
    assert_history(&restored, 0, 1, 0, true);
    restored.undo(revision(&restored), 0).unwrap().unwrap();
    assert_eq!(
        restored.read(0).unwrap().nodes[0].text,
        durable.nodes[0].text
    );
    assert_history(&restored, 0, 0, 1, true);
    restored.dispose().unwrap();
}

#[test]
fn exact_history_preserves_stacks_across_permission_expiry_and_readonly_navigation() {
    let f = Fixture::new();
    let s = f.create();
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    apply(
        &s,
        json!([{"type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X"}]),
    );
    let target = anchor(&s, &owner, 3);
    let h = s.history_state(0).unwrap();
    s.set_permission(true, Some(5)).unwrap();
    assert_history(&s, 4, 1, 0, true);
    assert_history(&s, 5, 1, 0, false);
    assert!(matches!(
        s.undo(h.revision.clone().unwrap(), 5),
        Err(NativeSessionError::PermissionExpired)
    ));
    assert_eq!(s.read(5).unwrap().nodes[0].text, "X🦀אבB");
    // Read-only projection/copy and anchored navigation keep working.
    assert_eq!(
        s.resolve_anchor(target).unwrap().revision,
        h.revision.clone().unwrap()
    );
    assert!(snapshot(&s)["visible"].is_array());
    s.set_permission(false, None).unwrap();
    assert_history(&s, 0, 1, 0, false);
    assert!(matches!(
        s.undo(h.revision.clone().unwrap(), 0),
        Err(NativeSessionError::ReadOnly)
    ));
    s.set_permission(true, None).unwrap();
    assert_history(&s, 0, 1, 0, true);
    s.undo(h.revision.unwrap(), 0).unwrap().unwrap();
    assert_history(&s, 0, 0, 1, true);
    let redo_revision = revision(&s);
    s.set_permission(true, Some(9)).unwrap();
    assert_history(&s, 8, 0, 1, true);
    assert_history(&s, 9, 0, 1, false);
    assert!(matches!(
        s.redo(redo_revision.clone(), 9),
        Err(NativeSessionError::PermissionExpired)
    ));
    s.set_permission(false, None).unwrap();
    assert_history(&s, 0, 0, 1, false);
    assert!(matches!(
        s.redo(redo_revision.clone(), 0),
        Err(NativeSessionError::ReadOnly)
    ));
    s.set_permission(true, None).unwrap();
    s.redo(redo_revision, 0).unwrap().unwrap();
    assert_history(&s, 0, 1, 0, true);
    assert_eq!(s.read(0).unwrap().pending_upload, 3);
    s.dispose().unwrap();
}

#[test]
fn rejected_commands_and_stale_or_foreign_history_leave_real_stacks_unchanged() {
    let f = Fixture::new();
    let s = f.create();
    let foreign_fixture = Fixture::new();
    let foreign = foreign_fixture.create();
    let stale = revision(&s);
    let owner = s.read(0).unwrap().nodes[0].id.clone();
    apply(
        &s,
        json!([{"type":"replaceAt","owner":owner,"from":0,"to":1,"text":"X"}]),
    );
    let before = snapshot(&s);
    let h = s.history_state(0).unwrap();
    for redo in [false, true] {
        for (r, reason) in [
            (stale.clone(), NativeRevisionFailure::Stale),
            (revision(&foreign), NativeRevisionFailure::ScopeMismatch),
        ] {
            let error = if redo { s.redo(r, 0) } else { s.undo(r, 0) }.unwrap_err();
            assert!(
                matches!(error, NativeSessionError::Revision { reason: actual, .. } if actual == reason)
            );
            assert_eq!(s.history_state(0).unwrap(), h);
        }
    }
    // Invalid UTF-16 interior of a surrogate pair, malformed input, canceled and
    // permission-rejected prepared changes must not add history or clear redo.
    for undone in [false, true] {
        if undone {
            s.undo(revision(&s), 0).unwrap().unwrap();
        }
        let before = s.history_state(0).unwrap();
        assert!(
            s.prepare_commands(
                revision(&s),
                json!([{"type":"replaceAt","owner":owner,"from":2,"to":2,"text":"!"}]).to_string(),
                "invalid".into(),
                0
            )
            .is_err()
        );
        assert!(
            s.prepare_commands(revision(&s), "{".into(), "invalid".into(), 0)
                .is_err()
        );
        let p = plan(
            &s,
            json!([{"type":"replaceAt","owner":owner,"from":0,"to":1,"text":"Y"}]),
        );
        s.cancel_commands(p.token).unwrap();
        let p = plan(
            &s,
            json!([{"type":"replaceAt","owner":owner,"from":0,"to":1,"text":"Y"}]),
        );
        s.set_permission(false, None).unwrap();
        assert!(matches!(
            s.commit_commands(p.token, 0),
            Err(NativeSessionError::ReadOnly)
        ));
        s.set_permission(true, None).unwrap();
        assert_eq!(s.history_state(0).unwrap(), before);
    }
    s.redo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(snapshot(&s)["visible"], before["visible"]);
    assert_history(&s, 0, 1, 0, true);
    assert_eq!(s.read(0).unwrap().pending_upload, 3);
    foreign.dispose().unwrap();
    s.dispose().unwrap();
}

#[test]
fn exact_history_reports_multiple_shared_groups_and_alias_lifetime() {
    let f = Fixture::new();
    let s = f.create();
    let alias = s.clone();
    let r = s.read(0).unwrap();
    let owner = r.nodes[0].id.clone();
    let at = anchor(&s, &owner, 3);
    apply(&s, json!([{"type":"split","owner":owner,"at":at}]));
    let first = snapshot(&s);
    apply(
        &s,
        json!([{"type":"setCode","owner":owner,"language":"rust"}]),
    );
    assert_history(&alias, 0, 2, 0, true);
    drop(s);
    alias.undo(revision(&alias), 0).unwrap().unwrap();
    assert_history(&alias, 0, 1, 1, true);
    assert_eq!(snapshot(&alias)["visible"], first["visible"]);
    alias.undo(revision(&alias), 0).unwrap().unwrap();
    assert_history(&alias, 0, 0, 2, true);
    alias.redo(revision(&alias), 0).unwrap().unwrap();
    assert_history(&alias, 0, 1, 1, true);
    alias.redo(revision(&alias), 0).unwrap().unwrap();
    assert_history(&alias, 0, 2, 0, true);
    alias.dispose().unwrap();
    assert!(matches!(
        alias.history_state(0),
        Err(NativeSessionError::Disposed)
    ));
}
