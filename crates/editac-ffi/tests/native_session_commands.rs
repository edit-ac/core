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
