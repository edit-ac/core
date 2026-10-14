//! ENG-1.11: production selective history, independent content/tree oracles,
//! retained identities, actual replica delivery and pinned Rust/Yjs exchange.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
#[path = "../../../fixtures/schema-v4/mapping.rs"]
#[allow(dead_code)]
mod v4;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{editor::*, format::*, text::*},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
    history::*,
};
use std::{fs, path::PathBuf, process::Command};
use yrs::{Any, GetString, Map, Out, ReadTxn, Text, Transact};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const L: &str = "c:11:1";
const K: &str = "c:11:3";
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap()
}
fn restore(bytes: &[u8]) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 11,
            bytes: bytes.into(),
        },
        &[],
    )
    .unwrap()
}
fn engine() -> Document {
    let mut d = restore(&m::bytes(&m::seed()));
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn origin() -> TextOrigin {
    TextOrigin::new("history:test").unwrap()
}
fn raw(d: &Document) -> yrs::Doc {
    let x = m::replica(20001);
    m::apply(&x, &d.checkpoint().bytes).unwrap();
    x
}
fn tuple(tag: &str) -> Any {
    m::arr(vec![Any::from(tag)])
}
fn edit(d: &mut Document, cmds: &[EditorCommand]) -> ReplayUpdate {
    let p = d.prepare_editor(cmds, &origin()).unwrap();
    d.commit_editor(p).unwrap().update
}
fn insert(d: &mut Document, id: &str, at: u32, s: &str) -> ReplayUpdate {
    let at = d.anchor(id, U(at), Bias::Right).unwrap();
    let p = d
        .prepare_text(&TextCommand::Insert { at, text: s.into() }, &origin())
        .unwrap();
    d.commit_text(p).unwrap().update.unwrap()
}
fn replace(d: &mut Document, id: &str, start: u32, end: u32, s: &str) -> ReplayUpdate {
    let selection = d
        .selection((id, U(start), Bias::Left), (id, U(end), Bias::Right))
        .unwrap();
    let p = d
        .prepare_text(
            &TextCommand::Replace {
                selection,
                text: s.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap().update.unwrap()
}
fn text(d: &Document, id: &str) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
fn source_text(d: &Document, id: &str) -> String {
    let x = raw(d);
    let t = x.transact();
    let Out::YXmlText(s) = t.get_map("registry-texts").unwrap().get(&t, id).unwrap() else {
        panic!()
    };
    s.get_string(&t)
}
fn visible(d: &Document, id: &str) -> bool {
    d.snapshot().unwrap().visible.iter().any(|n| n.id == id)
}
fn parent(d: &Document, id: &str) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .parent
        .clone()
}
fn immutable(d: &Document) -> Any {
    let x = raw(d);
    let t = x.transact();
    let names = [
        "registry-parents",
        "registry-placements",
        "registry-owner-origins",
        "registry-ownership-ops",
        "delete-probe-tombstones",
    ];
    let mut v = std::collections::HashMap::new();
    for r in names {
        let map = t.get_map(r).unwrap();
        let values: std::collections::HashMap<_, _> = map
            .iter(&t)
            .map(|(k, v)| {
                let Out::Any(a) = v else { panic!() };
                (k.into(), a)
            })
            .collect();
        v.insert(r.into(), Any::Map(values.into()));
    }
    Any::Map(v.into())
}
fn identities(d: &Document) -> Vec<(String, String)> {
    let s = d.snapshot().unwrap();
    let mut v: Vec<_> = s
        .visible
        .iter()
        .chain(s.recovery.iter())
        .flat_map(|n| {
            n.spans
                .iter()
                .map(|s| (s.source.clone(), s.identity.clone()))
        })
        .collect();
    v.sort();
    v.dedup();
    v
}
fn undone(d: &mut Document) -> ReplayUpdate {
    d.undo().unwrap().unwrap().update.unwrap()
}
fn redone(d: &mut Document) -> ReplayUpdate {
    d.redo().unwrap().unwrap().update.unwrap()
}

#[test]
fn explicit_edits_are_separate_inside_capture_interval_and_clear_redo() {
    let mut d = engine();
    insert(&mut d, A, 1, "X");
    insert(&mut d, A, 2, "Y");
    assert_eq!(d.history_state().undo_groups, 2);
    undone(&mut d);
    assert_eq!(text(&d, A), "aX😀b");
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
    redone(&mut d);
    assert_eq!(text(&d, A), "aX😀b");
    insert(&mut d, A, 2, "Z");
    assert_eq!(d.history_state().redo_groups, 0);
    assert!(d.redo().unwrap().is_none());
}
#[test]
fn deterministic_typing_capture_timeout_origin_and_reset_boundaries() {
    let mut d = engine();
    for (time, s, at) in [(1, "X", 1), (500, "Y", 2)] {
        d.set_history_group(HistoryGroup::Typing {
            session: 1,
            time_ms: time,
        });
        insert(&mut d, A, at, s);
    }
    assert_eq!(d.history_state().undo_groups, 1);
    d.set_history_group(HistoryGroup::Typing {
        session: 1,
        time_ms: 1001,
    });
    insert(&mut d, A, 3, "Z");
    assert_eq!(d.history_state().undo_groups, 2);
    d.reset_history_group();
    insert(&mut d, A, 4, "W");
    assert_eq!(d.history_state().undo_groups, 3);
    undone(&mut d);
    undone(&mut d);
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
}
#[test]
fn composition_group_is_explicit_and_paste_format_move_break_coalescing() {
    let mut d = engine();
    d.set_history_group(HistoryGroup::Composition { session: 7 });
    insert(&mut d, A, 1, "X");
    insert(&mut d, A, 2, "Y");
    assert_eq!(d.history_state().undo_groups, 1);
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: A.into(),
            tuple: tuple("paragraph"),
        }],
    );
    insert(&mut d, A, 3, "Z");
    assert_eq!(d.history_state().undo_groups, 3);
    d.set_history_group(HistoryGroup::Explicit);
    insert(&mut d, A, 4, "PASTE");
    let c = d.move_command(B, "@root", None).unwrap();
    let p = d.prepare_move(&c, &origin(), None).unwrap();
    d.commit_move(p).unwrap();
    assert_eq!(d.history_state().undo_groups, 5);
    for _ in 0..5 {
        undone(&mut d);
    }
    assert_eq!(text(&d, A), "a😀b");
    assert_eq!(parent(&d, B), L);
}
#[test]
fn local_undo_after_remote_insertion_keeps_remote_unicode_and_anchor() {
    let mut a = engine();
    let mut b = restore(&a.checkpoint().bytes);
    insert(&mut a, A, 1, "LOCAL");
    let remote = insert(&mut b, A, 4, "REMOTE😀");
    a.apply_replay(&remote).unwrap();
    let anchor = a.anchor(A, U(10), Bias::Right).unwrap();
    undone(&mut a);
    assert_eq!(text(&a, A), "a😀bREMOTE😀");
    assert!(matches!(
        a.resolve_anchor(&anchor).unwrap(),
        Resolution::Position(_)
    ));
    redone(&mut a);
    assert_eq!(text(&a, A), "aLOCAL😀bREMOTE😀");
}
#[test]
fn remote_replay_restore_and_selection_do_not_enter_history_or_clear_redo() {
    let mut a = engine();
    let mut b = restore(&a.checkpoint().bytes);
    insert(&mut a, A, 1, "X");
    undone(&mut a);
    let r = insert(&mut b, B, 1, "REMOTE");
    a.apply_replay(&r).unwrap();
    a.apply_replay(&r).unwrap();
    a.selection((A, U(0), Bias::Left), (A, U(1), Bias::Right))
        .unwrap();
    assert_eq!(a.history_state().undo_groups, 0);
    assert_eq!(a.history_state().redo_groups, 1);
    redone(&mut a);
    assert_eq!(text(&a, B), "cREMOTEאבd");
    let restored = restore(&a.checkpoint().bytes);
    assert_eq!(restored.history_state().undo_groups, 0);
}
#[test]
fn deletion_replacement_unicode_undo_restores_original_identity_and_marks() {
    let mut d = engine();
    let ids = identities(&d);
    let before = d.snapshot().unwrap().visible;
    replace(&mut d, A, 1, 3, "Q");
    assert_eq!(text(&d, A), "aQb");
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
    assert_eq!(identities(&d), ids);
    assert_eq!(d.snapshot().unwrap().visible, before);
    redone(&mut d);
    assert_eq!(text(&d, A), "aQb");
}
#[test]
fn rich_format_command_is_one_group_and_remote_text_survives() {
    let mut d = engine();
    let mut remote = restore(&d.checkpoint().bytes);
    let c = FormatCommand {
        selection: d
            .selection((A, U(0), Bias::Left), (A, U(4), Bias::Right))
            .unwrap(),
        mark: Mark::Underline,
        action: FormatAction::Apply,
        href: None,
    };
    let p = d.prepare_format(&[c], &origin()).unwrap();
    d.commit_format(p).unwrap();
    let r = insert(&mut remote, B, 1, "REMOTE");
    d.apply_replay(&r).unwrap();
    assert_eq!(d.history_state().undo_groups, 1);
    undone(&mut d);
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == A)
            .unwrap()
            .runs
            .iter()
            .all(|r| !r.attributes.contains_key("underline"))
    );
    assert_eq!(text(&d, B), "cREMOTEאבd");
    redone(&mut d);
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == A)
            .unwrap()
            .runs
            .iter()
            .any(|r| r.attributes.contains_key("underline"))
    );
}
#[test]
fn initial_creation_rows_text_and_required_metadata_survive_undo_redo() {
    let mut d = engine();
    let n = format!("n:{}:1", d.writer_id());
    let c = format!("c:{}:1", d.writer_id());
    edit(
        &mut d,
        &[
            EditorCommand::Create {
                id: n.clone(),
                kind: "block".into(),
                text: "CREATED😀".into(),
                tuple: tuple("paragraph"),
            },
            EditorCommand::Create {
                id: c.clone(),
                kind: "list".into(),
                text: String::new(),
                tuple: tuple("unordered"),
            },
            EditorCommand::Place {
                target: n.clone(),
                parent: c.clone(),
                before: None,
            },
        ],
    );
    let imm = immutable(&d);
    let ids = identities(&d);
    let anchor = d.anchor(&n, U(1), Bias::Right).unwrap();
    undone(&mut d);
    assert!(!visible(&d, &n));
    assert!(!visible(&d, &c));
    assert_eq!(source_text(&d, &n), "CREATED😀");
    assert_eq!(immutable(&d), imm);
    assert!(matches!(
        d.resolve_anchor(&anchor).unwrap(),
        Resolution::Deleted { .. }
    ));
    redone(&mut d);
    assert!(visible(&d, &n));
    assert_eq!(parent(&d, &n), c);
    assert_eq!(identities(&d), ids);
    assert_eq!(immutable(&d), imm);
    assert!(matches!(
        d.resolve_anchor(&anchor).unwrap(),
        Resolution::Position(_)
    ));
    restore(&d.checkpoint().bytes);
}
#[test]
fn newly_created_text_enters_scope_for_later_typing_but_creation_content_is_retained() {
    let mut d = engine();
    let n = format!("n:{}:1", d.writer_id());
    edit(
        &mut d,
        &[EditorCommand::Create {
            id: n.clone(),
            kind: "block".into(),
            text: "seed".into(),
            tuple: tuple("paragraph"),
        }],
    );
    insert(&mut d, &n, 4, "LOCAL");
    undone(&mut d);
    assert_eq!(text(&d, &n), "seed");
    undone(&mut d);
    assert_eq!(source_text(&d, &n), "seed");
    redone(&mut d);
    redone(&mut d);
    assert_eq!(text(&d, &n), "seedLOCAL");
}
#[test]
fn structural_move_undo_retains_operation_and_remote_descendant_edits() {
    let mut d = engine();
    let mut remote = restore(&d.checkpoint().bytes);
    let c = d.move_command(K, "@root", None).unwrap();
    let p = d.prepare_move(&c, &origin(), None).unwrap();
    d.commit_move(p).unwrap();
    let imm = immutable(&d);
    let ids = identities(&d);
    let r = insert(&mut remote, C, 2, "REMOTE");
    d.apply_replay(&r).unwrap();
    undone(&mut d);
    assert_eq!(parent(&d, K), "c:11:2");
    assert_eq!(text(&d, C), "éREMOTEZ");
    assert_eq!(immutable(&d), imm);
    assert_eq!(identities(&d), ids);
    redone(&mut d);
    assert_eq!(parent(&d, K), "@root");
    assert_eq!(parent(&d, B), L);
    assert_eq!(immutable(&d), imm);
}
#[test]
fn split_join_history_keeps_multisource_ownership_marks_and_anchors() {
    let mut d = engine();
    let at = d.anchor(A, U(1), Bias::Right).unwrap();
    edit(
        &mut d,
        &[EditorCommand::Split {
            owner: A.into(),
            at,
        }],
    );
    let s = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id.starts_with("o:"))
        .unwrap()
        .id
        .clone();
    let anchor = d.anchor(&s, U(2), Bias::Right).unwrap();
    let split_imm = immutable(&d);
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
    assert_eq!(immutable(&d), split_imm);
    assert!(matches!(
        d.resolve_anchor(&anchor).unwrap(),
        Resolution::Position(_)
    ));
    redone(&mut d);
    assert_eq!(text(&d, &s), "😀b");
    edit(
        &mut d,
        &[EditorCommand::Join {
            first: A.into(),
            second: s.clone(),
        }],
    );
    let joined = immutable(&d);
    undone(&mut d);
    assert!(visible(&d, &s));
    assert_eq!(immutable(&d), joined);
    redone(&mut d);
    assert!(!visible(&d, &s));
    assert_eq!(text(&d, A), "a😀b");
}
#[test]
fn dependent_remote_place_is_retained_dormant_and_anchor_reroutes_when_split_undone() {
    let mut d = engine();
    let at = d.anchor(A, U(1), Bias::Right).unwrap();
    edit(
        &mut d,
        &[EditorCommand::Split {
            owner: A.into(),
            at,
        }],
    );
    let s = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id.starts_with("o:"))
        .unwrap()
        .id
        .clone();
    let anchor = d.anchor(&s, U(2), Bias::Right).unwrap();
    let mut remote = restore(&d.checkpoint().bytes);
    let remote_op = format!("o:{}:1", remote.writer_id());
    let r = edit(
        &mut remote,
        &[EditorCommand::Place {
            target: s.clone(),
            parent: "@root".into(),
            before: None,
        }],
    );
    d.apply_replay(&r).unwrap();
    let imm = immutable(&d);
    undone(&mut d);
    assert!(!visible(&d, &s));
    assert_eq!(text(&d, A), "a😀b");
    assert_eq!(immutable(&d), imm);
    let Any::Map(retained) = d.snapshot().unwrap().retained_structure.unwrap() else {
        panic!()
    };
    let Any::Map(outcomes) = &retained["outcomes"] else {
        panic!()
    };
    assert_eq!(outcomes[&s], Any::from("disabled"));
    assert_eq!(outcomes[&remote_op], Any::from("losing"));
    assert!(
        matches!(d.resolve_anchor(&anchor).unwrap(), Resolution::Position(p) if p.node == A && p.offset == U(3))
    );
    redone(&mut d);
    assert!(visible(&d, &s));
    assert_eq!(parent(&d, &s), "@root");
}
#[test]
fn permanent_remote_tombstone_wins_over_structural_redo_and_keeps_recovery_bytes() {
    let mut d = engine();
    let n = format!("n:{}:1", d.writer_id());
    edit(
        &mut d,
        &[EditorCommand::Create {
            id: n.clone(),
            kind: "block".into(),
            text: "original".into(),
            tuple: tuple("paragraph"),
        }],
    );
    let remote = raw(&d);
    let t = remote.transact();
    let sv = t.state_vector();
    drop(t);
    {
        let mut t = remote.transact_mut_with("remote:fixture");
        t.get_map("delete-probe-tombstones")
            .unwrap()
            .insert(&mut t, n.as_str(), true);
        let Out::YXmlText(x) = t.get_map("registry-texts").unwrap().get(&t, &n).unwrap() else {
            panic!()
        };
        x.insert(&mut t, 8, "REMOTE");
    }
    let u = ReplayUpdate {
        identity: identity(),
        bytes: remote.transact().encode_state_as_update_v1(&sv),
    };
    d.apply_replay(&u).unwrap();
    let imm = immutable(&d);
    undone(&mut d);
    redone(&mut d);
    assert!(!visible(&d, &n));
    assert_eq!(source_text(&d, &n), "originalREMOTE");
    assert_eq!(immutable(&d), imm);
}
#[test]
fn container_control_undo_does_not_swallow_live_children() {
    let mut d = engine();
    edit(
        &mut d,
        &[EditorCommand::Enable {
            target: L.into(),
            enabled: false,
        }],
    );
    assert!(!visible(&d, L));
    assert_eq!(parent(&d, A), "@root");
    undone(&mut d);
    assert!(visible(&d, L));
    assert_eq!(parent(&d, A), L);
    redone(&mut d);
    assert_eq!(parent(&d, B), "@root");
}
#[test]
fn metadata_history_does_not_rewrite_established_v5_join_witnesses() {
    let mut d = engine();
    edit(
        &mut d,
        &[EditorCommand::Join {
            first: A.into(),
            second: B.into(),
        }],
    );
    let imm = immutable(&d);
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: A.into(),
            tuple: m::arr(vec![Any::from("code"), Any::from("rust")]),
        }],
    );
    undone(&mut d);
    assert!(!visible(&d, B));
    assert_eq!(text(&d, A), "a😀bcאבd");
    assert_eq!(immutable(&d), imm);
    redone(&mut d);
    assert_eq!(immutable(&d), imm);
    assert!(!visible(&d, B));
}
#[test]
fn group_count_payload_and_commit_caps_evict_old_history_without_content_writes() {
    let mut d = engine();
    d.enable_history(HistoryConfig {
        max_groups: 2,
        max_update_bytes: 100000,
        max_group_commits: 2,
        ..HistoryConfig::default()
    })
    .unwrap();
    for (at, s) in [(1, "X"), (2, "Y"), (3, "Z")] {
        insert(&mut d, A, at, s);
    }
    assert_eq!(d.history_state().undo_groups, 2);
    undone(&mut d);
    undone(&mut d);
    assert!(d.undo().unwrap().is_none());
    assert_eq!(text(&d, A), "aX😀b");
    d.clear_history();
    d.set_history_group(HistoryGroup::Composition { session: 1 });
    for (at, s) in [(2, "P"), (3, "Q"), (4, "R")] {
        insert(&mut d, A, at, s);
    }
    assert_eq!(d.history_state().undo_groups, 2);
    d.enable_history(HistoryConfig {
        max_update_bytes: 1,
        ..HistoryConfig::default()
    })
    .unwrap();
    insert(&mut d, A, 5, "S");
    assert_eq!(d.history_state().retained_update_bytes, 0);
    assert_eq!(d.history_state().undo_groups, 0);
    assert!(text(&d, A).contains('S'));
}
#[test]
fn clear_and_invalid_configuration_are_nonmutating() {
    let mut d = engine();
    insert(&mut d, A, 1, "X");
    let bytes = d.checkpoint().bytes;
    let rev = d.revision();
    assert_eq!(
        d.enable_history(HistoryConfig {
            max_groups: 0,
            ..HistoryConfig::default()
        }),
        Err(HistoryError::InvalidConfig)
    );
    assert_eq!(d.history_state().undo_groups, 1);
    d.clear_history();
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), rev);
    assert!(d.undo().unwrap().is_none());
}
#[test]
fn rejected_and_stale_preparation_preserve_history_state_and_redo() {
    let mut d = engine();
    insert(&mut d, A, 1, "X");
    undone(&mut d);
    let state = d.history_state();
    let before = d.checkpoint().bytes;
    assert!(
        d.prepare_editor(
            &[EditorCommand::Block {
                target: A.into(),
                tuple: tuple("separator")
            }],
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.history_state(), state);
    assert_eq!(d.checkpoint().bytes, before);
    let at = d.anchor(A, U(1), Bias::Right).unwrap();
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: "STALE".into(),
            },
            &origin(),
        )
        .unwrap();
    let mut remote = restore(&d.checkpoint().bytes);
    let u = insert(&mut remote, B, 1, "R");
    d.apply_replay(&u).unwrap();
    let before = d.checkpoint().bytes;
    assert_eq!(d.commit_text(p).unwrap_err(), TextError::StalePlan);
    assert_eq!(d.history_state(), state);
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn history_updates_converge_under_six_three_writer_duplicate_reorder_schedules() {
    let seed = m::bytes(&m::seed());
    let mut a = restore(&seed);
    a.enable_history(HistoryConfig::default()).unwrap();
    let mut b = restore(&seed);
    let mut c = restore(&seed);
    let local = insert(&mut a, A, 1, "LOCAL");
    let r1 = insert(&mut b, B, 1, "B");
    let r2 = insert(&mut c, C, 2, "C");
    a.apply_replay(&r1).unwrap();
    a.apply_replay(&r2).unwrap();
    let undo = undone(&mut a);
    let redo = redone(&mut a);
    for perm in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let updates = [&local, &r1, &r2];
        let mut receiver = restore(&seed);
        let before = receiver.checkpoint().bytes;
        assert!(receiver.apply_replay(&undo).is_err());
        assert_eq!(receiver.checkpoint().bytes, before);
        for i in perm {
            receiver.apply_replay(updates[i]).unwrap();
            receiver.apply_replay(updates[i]).unwrap();
        }
        receiver.apply_replay(&undo).unwrap();
        assert_eq!(text(&receiver, A), "a😀b");
        assert_eq!(text(&receiver, B), "cBאבd");
        assert_eq!(text(&receiver, C), "éCZ");
        receiver.apply_replay(&redo).unwrap();
        receiver.apply_replay(&redo).unwrap();
        assert_eq!(
            receiver.snapshot().unwrap().retained_structure,
            a.snapshot().unwrap().retained_structure
        );
        restore(&receiver.checkpoint().bytes);
    }
}
#[test]
fn v4_profile_uses_same_selective_controls_without_mutating_frozen_mapping() {
    let id = DocumentIdentity::v4(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();

    let mut d = Document::restore(
        &id,
        &InitializedCheckpoint {
            identity: id.clone(),
            initialized: true,
            writer_id: 11,
            bytes: v4::bytes(&v4::seed()),
        },
        &[],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    insert(&mut d, A, 1, "X");
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
    redone(&mut d);
    assert_eq!(text(&d, A), "aX😀b");
}
#[test]
fn pinned_bidirectional_yjs_history_exchange_and_remote_text_preservation() {
    let dir = PathBuf::from(
        std::env::var_os("EDITAC_HISTORY_EXCHANGE")
            .expect("isolated exchange evidence path required"),
    );
    fs::create_dir_all(&dir).unwrap();
    let mut d = engine();
    let mut checkpoints = vec![];
    for (name, action) in [("seed", 0), ("insert", 1), ("undo", 2), ("redo", 3)] {
        match action {
            1 => {
                insert(&mut d, A, 1, "LOCAL");
            }
            2 => {
                undone(&mut d);
            }
            3 => {
                redone(&mut d);
            }
            _ => {}
        }
        fs::write(dir.join(format!("{name}.bin")), d.checkpoint().bytes).unwrap();
        fs::write(
            dir.join(format!("{name}.json")),
            m::json(&d.snapshot().unwrap().retained_structure.unwrap()),
        )
        .unwrap();
        checkpoints.push(name);
    }
    fn run(dir: &PathBuf, phase: &str) {
        let out = Command::new("node")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args(["--test", "tests/history-exchange.mjs"])
            .env("EDITAC_HISTORY_EXCHANGE", dir)
            .env("HISTORY_PHASE", phase)
            .output()
            .unwrap();
        fs::write(
            dir.join(format!("node-{phase}.log")),
            [out.stdout.as_slice(), out.stderr.as_slice()].concat(),
        )
        .unwrap();
        assert!(
            out.status.success(),
            "pinned Node {phase} failed; see evidence log"
        );
    }
    run(&dir, "setup");
    let u = ReplayUpdate {
        identity: identity(),
        bytes: fs::read(dir.join("yjs-remote.bin")).unwrap(),
    };
    d.apply_replay(&u).unwrap();
    d.apply_replay(&u).unwrap();
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀bYJS😀");
    fs::write(dir.join("final.bin"), d.checkpoint().bytes).unwrap();
    fs::write(
        dir.join("final.json"),
        m::json(&d.snapshot().unwrap().retained_structure.unwrap()),
    )
    .unwrap();
    run(&dir, "final");
}

#[test]
fn text_and_metadata_history_can_repeat_undo_redo_without_losing_deleted_payloads() {
    let mut d = engine();
    let initial = d.snapshot().unwrap().visible;
    insert(&mut d, D, 0, "abcd");
    replace(&mut d, D, 1, 3, "Q");
    replace(&mut d, D, 0, 3, "");
    edit(
        &mut d,
        &[
            EditorCommand::Check {
                target: C.into(),
                checked: false,
            },
            EditorCommand::Container {
                target: K.into(),
                tuple: tuple("unordered"),
            },
        ],
    );
    for _ in 0..3 {
        for _ in 0..4 {
            undone(&mut d);
        }
        assert_eq!(d.snapshot().unwrap().visible, initial);
        for _ in 0..4 {
            redone(&mut d);
        }
        assert_eq!(text(&d, D), "");
    }
}
#[test]
fn distinct_typing_origins_and_composition_sessions_never_merge() {
    let mut d = engine();
    d.set_history_group(HistoryGroup::Typing {
        session: 1,
        time_ms: 1,
    });
    insert(&mut d, A, 1, "X");
    let at = d.anchor(A, U(2), Bias::Right).unwrap();
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: "Y".into(),
            },
            &TextOrigin::new("other:local").unwrap(),
        )
        .unwrap();
    d.commit_text(p).unwrap();
    assert_eq!(d.history_state().undo_groups, 2);
    d.set_history_group(HistoryGroup::Composition { session: 1 });
    insert(&mut d, A, 3, "Z");
    d.set_history_group(HistoryGroup::Composition { session: 2 });
    insert(&mut d, A, 4, "W");
    assert_eq!(d.history_state().undo_groups, 4);
}
#[test]
fn staged_history_resource_rejection_is_atomic_and_retry_requires_changed_remote_state() {
    let mut d = engine();
    let at = d.anchor(A, U(1), Bias::Right).unwrap();
    edit(
        &mut d,
        &[EditorCommand::Split {
            owner: A.into(),
            at,
        }],
    );
    let x = raw(&d);
    let sv = x.transact().state_vector();
    {
        let mut t = x.transact_mut_with("remote:fixture");
        let controls = t.get_map("registry-entity-controls").unwrap();
        for i in 1..=8192 {
            controls.insert(
                &mut t,
                format!("n:404:{i}"),
                m::arr(vec![Any::from("enabled"), Any::Bool(false)]),
            );
        }
    }
    let u = ReplayUpdate {
        identity: identity(),
        bytes: x.transact().encode_state_as_update_v1(&sv),
    };
    d.apply_replay(&u).unwrap();
    let before = d.checkpoint().bytes;
    let state = d.history_state();
    let rev = d.revision();
    assert!(d.undo().is_err());
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state(), state);
    assert_eq!(d.revision(), rev);
    let x = raw(&d);
    let sv = x.transact().state_vector();
    {
        let mut t = x.transact_mut_with("remote:fixture");
        t.get_map("registry-entity-controls")
            .unwrap()
            .remove(&mut t, "n:404:8192");
    }
    let u = ReplayUpdate {
        identity: identity(),
        bytes: x.transact().encode_state_as_update_v1(&sv),
    };
    d.apply_replay(&u).unwrap();
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
}

#[test]
fn one_mixed_prepared_operation_undoes_text_metadata_and_move_as_one_group() {
    let mut d = engine();
    let before = d.snapshot().unwrap().visible;
    let at = d.anchor(B, U(1), Bias::Right).unwrap();
    edit(
        &mut d,
        &[
            EditorCommand::Text(TextCommand::Insert {
                at,
                text: "LOCAL".into(),
            }),
            EditorCommand::Block {
                target: A.into(),
                tuple: m::arr(vec![Any::from("heading"), Any::from(6u32)]),
            },
            EditorCommand::Place {
                target: B.into(),
                parent: "@root".into(),
                before: None,
            },
        ],
    );
    let imm = immutable(&d);
    assert_eq!(d.history_state().undo_groups, 1);
    undone(&mut d);
    assert_eq!(d.snapshot().unwrap().visible, before);
    assert_eq!(immutable(&d), imm);
    redone(&mut d);
    assert_eq!(text(&d, B), "cLOCALאבd");
    assert_eq!(parent(&d, B), "@root");
}
#[test]
fn remote_text_and_presentation_on_local_creation_survive_control_undo_redo() {
    let mut d = engine();
    let n = format!("n:{}:1", d.writer_id());
    edit(
        &mut d,
        &[EditorCommand::Create {
            id: n.clone(),
            kind: "block".into(),
            text: "seed".into(),
            tuple: tuple("paragraph"),
        }],
    );
    let mut remote = restore(&d.checkpoint().bytes);
    let u = insert(&mut remote, &n, 4, "REMOTE");
    d.apply_replay(&u).unwrap();
    let u = edit(
        &mut remote,
        &[EditorCommand::Block {
            target: n.clone(),
            tuple: m::arr(vec![Any::from("heading"), Any::from(4u32)]),
        }],
    );
    d.apply_replay(&u).unwrap();
    let imm = immutable(&d);
    undone(&mut d);
    assert!(!visible(&d, &n));
    assert_eq!(source_text(&d, &n), "seedREMOTE");
    assert_eq!(immutable(&d), imm);
    redone(&mut d);
    assert_eq!(text(&d, &n), "seedREMOTE");
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|o| o.id == n)
            .unwrap()
            .block_attributes,
        Some(editac_core::document::BlockAttributes::Heading(4))
    );
}
#[test]
fn literal_code_history_keeps_dormant_marks_and_exact_whitespace() {
    let mut d = engine();
    let original = d.snapshot().unwrap().visible;
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: A.into(),
            tuple: m::arr(vec![Any::from("code"), Any::from("unknown.lang")]),
        }],
    );
    insert(&mut d, A, 1, " \n\n\t");
    assert_eq!(text(&d, A), "a \n\n\t😀b");
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == A)
            .unwrap()
            .runs
            .iter()
            .any(|r| r.text == " \n\n\t" && r.attributes.is_empty())
    );
    undone(&mut d);
    assert_eq!(text(&d, A), "a😀b");
    undone(&mut d);
    assert_eq!(d.snapshot().unwrap().visible, original);
    redone(&mut d);
    redone(&mut d);
    assert_eq!(text(&d, A), "a \n\n\t😀b");
}

#[test]
fn concurrent_separator_presentation_blocks_incompatible_undo_before_live_mutation() {
    let mut d = engine();
    insert(&mut d, D, 0, "original");
    replace(&mut d, D, 0, 8, "");
    let mut remote = restore(&d.checkpoint().bytes);
    let u = edit(
        &mut remote,
        &[EditorCommand::Block {
            target: D.into(),
            tuple: tuple("separator"),
        }],
    );
    d.apply_replay(&u).unwrap();
    let state = d.history_state();
    let bytes = d.checkpoint().bytes;
    let rev = d.revision();
    assert!(matches!(d.undo(), Err(HistoryError::ConcurrentConflict)));
    assert_eq!(d.history_state(), state);
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), rev);
    let u = edit(
        &mut remote,
        &[EditorCommand::Block {
            target: D.into(),
            tuple: tuple("paragraph"),
        }],
    );
    d.apply_replay(&u).unwrap();
    undone(&mut d);
    assert_eq!(text(&d, D), "original");
}

fn bookmark_position(owner: &str, offset: u32, bias: Bias) -> EditorPosition {
    EditorPosition {
        owner: owner.into(),
        offset: U(offset),
        bias,
    }
}
fn bookmark_cuts(
    d: &Document,
    s: &editac_core::anchors::Selection,
) -> (String, u32, Bias, String, u32, Bias) {
    let s = d.resolve_selection(s).unwrap();
    let (Resolution::Position(a), Resolution::Position(f)) = (s.anchor, s.focus) else {
        panic!("bookmark must resolve")
    };
    (a.node, a.offset.0, a.bias, f.node, f.offset.0, f.bias)
}
#[test]
fn history_bookmarks_restore_deleted_backward_range_and_result_affinity() {
    for bias in [Bias::Left, Bias::Right] {
        let mut d = engine();
        edit(
            &mut d,
            &[
                EditorCommand::HistorySelectionAt {
                    anchor: bookmark_position(A, 3, bias),
                    focus: bookmark_position(A, 1, bias),
                },
                EditorCommand::ReplaceAt {
                    owner: A.into(),
                    from: U(1),
                    to: U(3),
                    text: "X".into(),
                },
                EditorCommand::SelectionAt {
                    anchor: bookmark_position(A, 2, bias),
                    focus: bookmark_position(A, 2, bias),
                },
            ],
        );
        assert_eq!(text(&d, A), "aXb");
        assert_eq!(d.history_state().undo_groups, 1);
        let undo = d.undo().unwrap().unwrap();
        assert_eq!(text(&d, A), "a😀b");
        assert_eq!(
            bookmark_cuts(&d, &undo.selection.unwrap()),
            (A.into(), 3, bias, A.into(), 1, bias)
        );
        let redo = d.redo().unwrap().unwrap();
        assert_eq!(text(&d, A), "aXb");
        assert_eq!(
            bookmark_cuts(&d, &redo.selection.unwrap()),
            (A.into(), 2, bias, A.into(), 2, bias)
        );
        insert(&mut d, A, 2, "S");
        assert_eq!(text(&d, A), "aXSb");
    }
}

#[test]
fn history_bookmarks_rebase_both_endpoints_and_preserve_repeated_roundtrips() {
    for bias in [Bias::Left, Bias::Right] {
        let mut d = engine();
        replace(&mut d, A, 0, 4, "abcdef");
        d.clear_history();
        edit(
            &mut d,
            &[
                EditorCommand::HistorySelectionAt {
                    anchor: bookmark_position(A, 5, bias),
                    focus: bookmark_position(A, 2, bias),
                },
                EditorCommand::ReplaceAt {
                    owner: A.into(),
                    from: U(1),
                    to: U(5),
                    text: "X".into(),
                },
                EditorCommand::SelectionAt {
                    anchor: bookmark_position(A, 2, bias),
                    focus: bookmark_position(A, 1, bias),
                },
            ],
        );
        let mut remote = restore(&d.checkpoint().bytes);
        let update = insert(&mut remote, A, 0, "R");
        d.apply_replay(&update).unwrap();
        assert_eq!(text(&d, A), "RaXf");
        for _ in 0..3 {
            let u = d.undo().unwrap().unwrap();
            assert_eq!(text(&d, A), "Rabcdef");
            assert_eq!(
                bookmark_cuts(&d, &u.selection.unwrap()),
                (A.into(), 6, bias, A.into(), 3, bias)
            );
            let r = d.redo().unwrap().unwrap();
            assert_eq!(text(&d, A), "RaXf");
            assert_eq!(
                bookmark_cuts(&d, &r.selection.unwrap()),
                (A.into(), 3, bias, A.into(), 2, bias)
            );
        }
        insert(&mut d, A, 3, "S");
        assert_eq!(text(&d, A), "RaXSf");
    }
}

#[test]
fn history_bookmark_admission_and_metadata_only_batches_are_atomic() {
    let mut d = engine();
    let before = (d.checkpoint().bytes, d.revision(), d.history_state());
    let entry = EditorCommand::HistorySelectionAt {
        anchor: bookmark_position(A, 3, Bias::Left),
        focus: bookmark_position(A, 1, Bias::Right),
    };
    for cmds in [
        vec![EditorCommand::HistorySelectionAt {
            anchor: bookmark_position(A, 2, Bias::Left),
            focus: bookmark_position(A, 1, Bias::Right),
        }],
        vec![
            entry.clone(),
            EditorCommand::ReplaceAt {
                owner: A.into(),
                from: U(1),
                to: U(3),
                text: "X".into(),
            },
            EditorCommand::SelectionAt {
                anchor: bookmark_position(A, 99, Bias::Left),
                focus: bookmark_position(A, 1, Bias::Right),
            },
        ],
        vec![
            EditorCommand::ReplaceAt {
                owner: A.into(),
                from: U(1),
                to: U(3),
                text: "X".into(),
            },
            entry.clone(),
        ],
    ] {
        assert!(d.prepare_editor(&cmds, &origin()).is_err());
        assert_eq!(
            (d.checkpoint().bytes, d.revision(), d.history_state()),
            before
        );
    }
    let plan = d.prepare_editor(&[entry], &origin()).unwrap();
    let commit = d.commit_editor(plan).unwrap();
    assert_eq!(commit.revision, before.1);
    assert_eq!(
        (d.checkpoint().bytes, d.revision(), d.history_state()),
        before
    );
    assert!(d.undo().unwrap().is_none());
}

#[test]
fn original_seq13_seq14_fragment_history_restores_backward_entry_and_sentinel() {
    use editac_core::document::BlockAttributes;
    for hard_break in [false, true] {
        for bias in [Bias::Left, Bias::Right] {
            let mut d = engine();
            replace(&mut d, A, 0, 4, "abcd");
            d.clear_history();
            let entry = d.selection((A, U(3), bias), (A, U(1), bias)).unwrap();
            let empty = || FragmentBlock {
                runs: vec![],
                attributes: Some(BlockAttributes::Paragraph),
                containers: vec![],
                checked: None,
            };
            let blocks = if hard_break {
                vec![FragmentBlock {
                    runs: vec![FragmentRun {
                        text: "\n".into(),
                        marks: vec![],
                    }],
                    ..empty()
                }]
            } else {
                vec![empty(), empty()]
            };
            let plan = d.prepare_fragment(&entry, &blocks, &origin()).unwrap();
            let result = d.commit_editor(plan).unwrap();
            let Resolution::Position(p) = d.resolve_anchor(&result.result_caret.unwrap()).unwrap()
            else {
                panic!()
            };
            let destination = p.node;
            assert_eq!(p.offset.0, if hard_break { 2 } else { 0 });
            assert_eq!(p.bias, Bias::Right);
            assert_eq!(text(&d, A), if hard_break { "a\nd" } else { "a" });
            let u = d.undo().unwrap().unwrap();
            assert_eq!(text(&d, A), "abcd");
            assert_eq!(
                bookmark_cuts(&d, &u.selection.unwrap()),
                (A.into(), 3, bias, A.into(), 1, bias)
            );
            let r = d.redo().unwrap().unwrap();
            assert_eq!(
                bookmark_cuts(&d, &r.selection.unwrap()),
                (
                    destination.clone(),
                    if hard_break { 2 } else { 0 },
                    Bias::Right,
                    destination.clone(),
                    if hard_break { 2 } else { 0 },
                    Bias::Right
                )
            );
            insert(&mut d, &destination, if hard_break { 2 } else { 0 }, "X");
            assert_eq!(
                text(&d, &destination),
                if hard_break { "a\nXd" } else { "Xd" }
            );
        }
    }
}

#[test]
fn original_seq03_format_history_returns_range_after_selection_move() {
    let mut d = engine();
    replace(&mut d, A, 0, 4, "abcd");
    d.clear_history();
    edit(
        &mut d,
        &[
            EditorCommand::HistorySelectionAt {
                anchor: bookmark_position(A, 1, Bias::Right),
                focus: bookmark_position(A, 3, Bias::Right),
            },
            EditorCommand::MarkAt {
                owner: A.into(),
                from: U(1),
                to: U(3),
                mark: Mark::Bold,
                action: FormatAction::Toggle,
                href: None,
            },
            EditorCommand::SelectionAt {
                anchor: bookmark_position(A, 1, Bias::Right),
                focus: bookmark_position(A, 3, Bias::Right),
            },
        ],
    );
    d.selection((A, U(4), Bias::Right), (A, U(4), Bias::Right))
        .unwrap();
    let u = d.undo().unwrap().unwrap();
    assert_eq!(text(&d, A), "abcd");
    assert_eq!(
        bookmark_cuts(&d, &u.selection.unwrap()),
        (A.into(), 1, Bias::Right, A.into(), 3, Bias::Right)
    );
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == A)
            .unwrap()
            .runs
            .iter()
            .all(|r| r.attributes.is_empty())
    );
    let r = d.redo().unwrap().unwrap();
    assert_eq!(
        bookmark_cuts(&d, &r.selection.unwrap()),
        (A.into(), 1, Bias::Right, A.into(), 3, Bias::Right)
    );
    let runs = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == A)
        .unwrap()
        .runs
        .clone();
    assert_eq!(
        runs.iter()
            .filter(|r| r.attributes.contains_key("bold"))
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "bc"
    );
}

#[test]
fn original_seq07_cross_owner_history_restores_both_source_endpoints() {
    for bias in [Bias::Left, Bias::Right] {
        let mut d = engine();
        replace(&mut d, A, 0, 4, "abc");
        replace(&mut d, B, 0, 4, "def");
        d.clear_history();
        let before = d.snapshot().unwrap().visible;
        let entry = d.selection((B, U(2), bias), (A, U(1), bias)).unwrap();
        let plan = d
            .prepare_fragment(
                &entry,
                &[FragmentBlock {
                    runs: vec![],
                    attributes: None,
                    containers: vec![],
                    checked: None,
                }],
                &origin(),
            )
            .unwrap();
        let c = d.commit_editor(plan).unwrap();
        assert_eq!(text(&d, A), "af");
        let Resolution::Position(caret) = d.resolve_anchor(&c.result_caret.unwrap()).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (caret.node.as_str(), caret.offset.0, caret.bias),
            (A, 1, Bias::Right)
        );
        let u = d.undo().unwrap().unwrap();
        assert_eq!(d.snapshot().unwrap().visible, before);
        assert_eq!(
            bookmark_cuts(&d, &u.selection.unwrap()),
            (B.into(), 2, bias, A.into(), 1, bias)
        );
    }
}

#[test]
fn original_seq03_seq13_seq14_typing_consumes_native_undo_range() {
    use editac_core::document::BlockAttributes;
    for kind in ["format", "enter", "hard-break"] {
        for bias in [Bias::Left, Bias::Right] {
            let mut d = engine();
            replace(&mut d, A, 0, 4, "abcd");
            d.clear_history();
            let original = d.snapshot().unwrap().visible;
            let (a, f) = if kind == "format" { (1, 3) } else { (3, 1) };
            let entry = d.selection((A, U(a), bias), (A, U(f), bias)).unwrap();
            let plan = if kind == "format" {
                d.prepare_editor(
                    &[
                        EditorCommand::HistorySelectionAt {
                            anchor: bookmark_position(A, a, bias),
                            focus: bookmark_position(A, f, bias),
                        },
                        EditorCommand::MarkAt {
                            owner: A.into(),
                            from: U(1),
                            to: U(3),
                            mark: Mark::Bold,
                            action: FormatAction::Toggle,
                            href: None,
                        },
                        EditorCommand::SelectionAt {
                            anchor: bookmark_position(A, a, bias),
                            focus: bookmark_position(A, f, bias),
                        },
                    ],
                    &origin(),
                )
                .unwrap()
            } else {
                let empty = || FragmentBlock {
                    runs: vec![],
                    attributes: Some(BlockAttributes::Paragraph),
                    containers: vec![],
                    checked: None,
                };
                let blocks = if kind == "enter" {
                    vec![empty(), empty()]
                } else {
                    vec![FragmentBlock {
                        runs: vec![FragmentRun {
                            text: "\n".into(),
                            marks: vec![],
                        }],
                        ..empty()
                    }]
                };
                d.prepare_fragment(&entry, &blocks, &origin()).unwrap()
            };
            d.commit_editor(plan).unwrap();
            let undo = d.undo().unwrap().unwrap();
            let restored = undo.selection.unwrap();
            assert_eq!(d.snapshot().unwrap().visible, original);
            assert_eq!(
                bookmark_cuts(&d, &restored),
                (A.into(), a, bias, A.into(), f, bias)
            );
            let Resolution::Position(anchor) = d.resolve_anchor(&restored.anchor).unwrap() else {
                panic!()
            };
            let Resolution::Position(focus) = d.resolve_anchor(&restored.focus).unwrap() else {
                panic!()
            };
            let plan = d
                .prepare_editor(
                    &[
                        EditorCommand::HistorySelectionAt {
                            anchor: bookmark_position(&anchor.node, anchor.offset.0, anchor.bias),
                            focus: bookmark_position(&focus.node, focus.offset.0, focus.bias),
                        },
                        EditorCommand::ReplaceAt {
                            owner: anchor.node,
                            from: U(anchor.offset.0.min(focus.offset.0)),
                            to: U(anchor.offset.0.max(focus.offset.0)),
                            text: "!".into(),
                        },
                        EditorCommand::SelectionAt {
                            anchor: bookmark_position(A, 2, bias),
                            focus: bookmark_position(A, 2, bias),
                        },
                    ],
                    &origin(),
                )
                .unwrap();
            let before = (d.checkpoint().bytes, d.state_vector_v1(), d.revision());
            assert_eq!(
                text(&d, A),
                "abcd",
                "prepare cannot mutate the restored range"
            );
            let committed = d.commit_editor(plan).unwrap();
            assert_eq!(text(&d, A), "a!d");
            assert_eq!(
                bookmark_cuts(&d, &committed.result_selection.unwrap()),
                (A.into(), 2, bias, A.into(), 2, bias)
            );
            assert_eq!(d.revision(), before.2 + 1);
            assert_ne!(d.state_vector_v1(), before.1);
            assert_ne!(d.checkpoint().bytes, before.0);
            assert_eq!(d.history_state().redo_groups, 0);
            assert_eq!(d.history_state().undo_groups, 1);
            let visible = d.snapshot().unwrap().visible;
            let node = visible.iter().find(|n| n.id == A).unwrap();
            assert!(node.runs.iter().all(|r| r.attributes.is_empty()));
            let original_owner = original.iter().find(|n| n.id == A).unwrap();
            assert_eq!(node.spans[0].source, original_owner.spans[0].source);
            assert_ne!(
                text(&d, A),
                "abcd!",
                "a later caret cannot replace the bookmark"
            );
        }
    }
}

#[test]
fn history_bookmark_remote_owner_removal_rejects_before_mutation() {
    let mut d = engine();
    edit(
        &mut d,
        &[
            EditorCommand::HistorySelectionAt {
                anchor: bookmark_position(A, 3, Bias::Left),
                focus: bookmark_position(A, 1, Bias::Right),
            },
            EditorCommand::ReplaceAt {
                owner: A.into(),
                from: U(1),
                to: U(3),
                text: "X".into(),
            },
            EditorCommand::SelectionAt {
                anchor: bookmark_position(A, 2, Bias::Left),
                focus: bookmark_position(A, 2, Bias::Right),
            },
        ],
    );
    let mut remote = restore(&d.checkpoint().bytes);
    let update = edit(
        &mut remote,
        &[EditorCommand::Enable {
            target: A.into(),
            enabled: false,
        }],
    );
    d.apply_replay(&update).unwrap();
    let before = (d.checkpoint().bytes, d.revision(), d.history_state());
    assert!(matches!(d.undo(), Err(HistoryError::ConcurrentConflict)));
    assert_eq!(
        (d.checkpoint().bytes, d.revision(), d.history_state()),
        before
    );
}
