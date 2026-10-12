//! Deterministic real v1 update fixtures for the prepared text command boundary.
use editac_core::{
    Utf16Offset as U,
    anchors::*,
    commands::text::*,
    document::{Document, DocumentIdentity, InitializedCheckpoint, ROOTS},
    projection::TouchedRange,
};
use std::collections::BTreeSet;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    Any, Assoc, ClientID, Doc, GetString, IndexedSequence, Map, OffsetKind, Options, Out, ReadTxn,
    StateVector, Text, Transact, Update, XmlTextPrelim, XmlTextRef,
};
fn identity() -> DocumentIdentity {
    DocumentIdentity::v1(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    .unwrap()
}
fn replica(client: u64) -> Doc {
    let d = Doc::with_options(Options {
        client_id: ClientID::new(client),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for root in ROOTS {
        d.get_or_insert_map(root);
    }
    d
}
fn seed(first: &str, second: &str) -> Doc {
    let d = replica(11);
    {
        let mut t = d.transact_mut_with("fixture:seed");
        for (id, value, order) in [("block-1", first, 0), ("block-2", second, 1)] {
            t.get_map(ROOTS[0]).unwrap().insert(&mut t, id, "list");
            t.get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, id, XmlTextPrelim::new(value));
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                id,
                Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
            );
        }
        t.get_map(ROOTS[4]).unwrap().insert(
            &mut t,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    d
}
fn bytes(d: &Doc) -> Vec<u8> {
    d.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
fn engine(d: &Doc) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 11,
            bytes: bytes(d),
        },
        &[],
    )
    .unwrap()
}
fn text(d: &Doc, id: &str) -> XmlTextRef {
    let t = d.transact();
    let Some(Out::YXmlText(x)) = t.get_map(ROOTS[1]).unwrap().get(&t, id) else {
        panic!("text")
    };
    x
}
fn mode(d: &Doc, mode: &str, cut: u32) {
    let mut value = vec![Any::from(mode)];
    if mode == "split" {
        value.push(Any::Buffer(
            text(d, "block-1")
                .sticky_index(&d.transact(), cut, Assoc::Before)
                .unwrap()
                .encode_v1()
                .into(),
        ));
    }
    let mut t = d.transact_mut();
    t.get_map(ROOTS[4])
        .unwrap()
        .insert(&mut t, "pair", Any::Array(value.into()));
}
fn origin() -> TextOrigin {
    TextOrigin::new("paste").unwrap()
}
fn replace(d: &Document, node: &str, a: u32, b: u32, value: &str) -> TextCommand {
    TextCommand::Replace {
        selection: d
            .selection((node, U(a), Bias::Right), (node, U(b), Bias::Left))
            .unwrap(),
        text: value.into(),
    }
}
fn insert(d: &Document, node: &str, at: u32, value: &str) -> TextCommand {
    TextCommand::Insert {
        at: d.anchor(node, U(at), Bias::Right).unwrap(),
        text: value.into(),
    }
}
fn value(d: &Document, node: &str) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == node)
        .unwrap()
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
fn apply(d: &Doc, update: &[u8]) {
    d.transact_mut_with("fixture:remote")
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}
fn commit(d: &mut Document, c: &TextCommand) -> TextCommit {
    let p = d.prepare_text(c, &origin()).unwrap();
    d.commit_text(p).unwrap()
}
fn assert_unchanged(d: &Document, c: &TextCommand, error: TextError) {
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    assert_eq!(d.can_text(c, &origin()), Err(error.clone()));
    assert_eq!(d.prepare_text(c, &origin()).unwrap_err(), error);
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), revision);
}
#[test]
fn replacement_commits_one_revision_update_and_exact_utf16_range() {
    let seed = seed("a😀b", "cאבd");
    let mut d = engine(&seed);
    let before = d.snapshot().unwrap();
    let c = replace(&d, "block-1", 1, 3, "XY");
    let state = d.checkpoint().bytes;
    assert_eq!(d.can_text(&c, &origin()), Ok(()));
    assert_eq!(d.checkpoint().bytes, state);
    let result = commit(&mut d, &c);
    assert_eq!(result.revision, 1);
    assert_eq!(result.origin, origin());
    assert_eq!(
        result.touched_ranges,
        [TouchedRange {
            source: "block-1".into(),
            start: 1,
            new_start: 1,
            old_end: 3,
            new_end: 3
        }]
    );
    let s = d.snapshot().unwrap();
    assert_eq!(s.changed_nodes, BTreeSet::from(["block-1".into()]));
    assert_eq!(s.touched_ranges, result.touched_ranges);
    assert_eq!(s.source_reads, 1);
    assert!(!s.structure_rebuilt);
    assert_eq!(
        s.visible[0].spans[0].identity,
        before.visible[0].spans[0].identity
    );
    assert!(std::sync::Arc::ptr_eq(&s.visible[1], &before.visible[1]));
    assert_eq!(value(&d, "block-1"), "aXYb");
    let peer = replica(21);
    apply(&peer, &bytes(&seed));
    apply(&peer, &result.update.unwrap().bytes);
    assert_eq!(text(&peer, "block-1").get_string(&peer.transact()), "aXYb");
}
#[test]
fn insert_delete_and_backward_replace_use_the_same_prepared_boundary() {
    let mut d = engine(&seed("ab", "other"));
    let c = insert(&d, "block-1", 1, "😀");
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "a😀b");
    let c = TextCommand::Delete {
        selection: d
            .selection(
                ("block-1", U(1), Bias::Right),
                ("block-1", U(3), Bias::Left),
            )
            .unwrap(),
    };
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "ab");
    let c = replace(&d, "block-1", 2, 0, "e\u{301}אב");
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "e\u{301}אב");
    assert_eq!(d.revision(), 3);
}
#[test]
fn empty_insert_delete_and_replace_are_noops() {
    let mut d = engine(&seed("", "x"));
    let state = d.checkpoint().bytes;
    d.snapshot().unwrap();
    for c in [
        insert(&d, "block-1", 0, ""),
        TextCommand::Delete {
            selection: d
                .selection(
                    ("block-1", U(0), Bias::Left),
                    ("block-1", U(0), Bias::Right),
                )
                .unwrap(),
        },
        replace(&d, "block-1", 0, 0, ""),
    ] {
        let r = commit(&mut d, &c);
        assert!(r.update.is_none());
        assert!(r.touched_ranges.is_empty());
        assert_eq!(r.revision, 0);
    }
    assert_eq!(d.checkpoint().bytes, state);
    assert!(d.snapshot().unwrap().touched_ranges.is_empty());
    let c = insert(&d, "block-1", 0, "👩‍💻");
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "👩‍💻");
}
#[test]
fn malformed_public_offsets_fail_before_any_mutation() {
    let d = engine(&seed("a😀b", "x"));
    let before = d.checkpoint().bytes;
    for at in [2, 5, u32::MAX] {
        assert!(d.anchor("block-1", U(at), Bias::Right).is_err());
    }
    assert!(
        d.selection(
            ("block-1", U(0), Bias::Right),
            ("block-1", U(2), Bias::Left)
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), 0);
}
#[test]
fn cross_node_range_rejects_the_entire_replacement() {
    let d = engine(&seed("abc", "def"));
    let c = TextCommand::Replace {
        selection: d
            .selection(
                ("block-1", U(1), Bias::Right),
                ("block-2", U(2), Bias::Left),
            )
            .unwrap(),
        text: "x".into(),
    };
    assert_unchanged(&d, &c, TextError::CrossNodeRange);
}
#[test]
fn byte_limits_and_origin_validation_are_nonmutating() {
    let d = engine(&seed("abc", "x"));
    let c = insert(&d, "block-1", 1, &"x".repeat(MAX_EDIT_BYTES + 1));
    assert_unchanged(&d, &c, TextError::ResourceLimit);
    let c = insert(&d, "block-1", 0, &"😀".repeat(MAX_EDIT_BYTES / 4 + 1));
    assert_unchanged(&d, &c, TextError::ResourceLimit);
    for tag in [
        "".to_owned(),
        "x".repeat(MAX_ORIGIN_BYTES + 1),
        "line\nbreak".into(),
    ] {
        assert_eq!(TextOrigin::new(&tag), Err(TextError::InvalidOrigin));
    }
    assert!(TextOrigin::new(&"x".repeat(MAX_ORIGIN_BYTES)).is_ok());
}
#[test]
fn exact_edit_byte_limit_is_accepted() {
    let mut d = engine(&seed("", "x"));
    let c = insert(&d, "block-1", 0, &"x".repeat(MAX_EDIT_BYTES));
    let r = commit(&mut d, &c);
    assert_eq!(value(&d, "block-1").len(), MAX_EDIT_BYTES);
    assert_eq!(r.touched_ranges[0].new_end, MAX_EDIT_BYTES as u32);
}
#[test]
fn resulting_text_byte_limit_rejects_growth_but_allows_a_bounded_replacement() {
    let mut d = engine(&seed(&"x".repeat(MAX_TEXT_BYTES), "z"));
    let c = insert(&d, "block-1", 0, "y");
    assert_unchanged(&d, &c, TextError::ResourceLimit);
    let c = replace(&d, "block-1", 0, 1, "😀");
    assert_unchanged(&d, &c, TextError::ResourceLimit);
    let c = replace(&d, "block-1", 0, 1, "y");
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1").len(), MAX_TEXT_BYTES);
}
#[test]
fn depth_limit_rejects_one_level_over_and_accepts_the_boundary() {
    let seed = seed("x", "y");
    {
        let mut t = seed.transact_mut();
        for i in 0..MAX_TEXT_DEPTH {
            let id = format!("n-{i:x}");
            let parent = if i == 0 {
                "@root".into()
            } else {
                format!("n-{:x}", i - 1)
            };
            t.get_map(ROOTS[0])
                .unwrap()
                .insert(&mut t, id.clone(), "list");
            t.get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, id.clone(), XmlTextPrelim::new("x"));
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                id,
                Any::Array(vec![Any::from(parent), Any::from(0)].into()),
            );
        }
        t.get_map(ROOTS[2]).unwrap().insert(
            &mut t,
            "block-1",
            Any::Array(
                vec![
                    Any::from(format!("n-{:x}", MAX_TEXT_DEPTH - 1)),
                    Any::from(0),
                ]
                .into(),
            ),
        );
    }
    let d = engine(&seed);
    let c = insert(&d, "block-1", 0, "x");
    assert_unchanged(&d, &c, TextError::ResourceLimit);
    assert_eq!(
        d.can_text(
            &insert(&d, &format!("n-{:x}", MAX_TEXT_DEPTH - 1), 0, "y"),
            &origin()
        ),
        Ok(())
    );
}
#[test]
fn unknown_kind_retains_content_but_rejects_semantic_edits() {
    let seed = seed("opaque", "x");
    {
        let mut t = seed.transact_mut();
        t.get_map(ROOTS[0])
            .unwrap()
            .insert(&mut t, "block-1", "extension");
    }
    let d = engine(&seed);
    assert_unchanged(
        &d,
        &insert(&d, "block-1", 0, "x"),
        TextError::UnsupportedKind,
    );
}
#[test]
fn deleted_source_and_deleted_split_owner_reject_stable_targets() {
    for target in ["block-1", "block-split"] {
        let seed = seed("abcd", "x");
        if target == "block-split" {
            mode(&seed, "split", 2);
        }
        let d = engine(&seed);
        let c = insert(&d, target, 0, "x");
        {
            let mut t = seed.transact_mut();
            t.get_map(ROOTS[3]).unwrap().insert(&mut t, target, true);
        }
        let after = engine(&seed);
        assert_unchanged(&after, &c, TextError::DeletedTarget);
    }
}
#[test]
fn foreign_epoch_and_replaced_source_reject_without_mutation() {
    let seed = seed("abc", "x");
    let d = engine(&seed);
    let c = insert(&d, "block-1", 1, "z");
    let mut cp = d.checkpoint();
    cp.identity.epoch = "33333333-3333-4333-8333-333333333333".into();
    let other = Document::restore(&cp.identity, &cp, &[]).unwrap();
    assert_unchanged(
        &other,
        &c,
        TextError::Unresolvable(Unresolvable::IdentityMismatch),
    );
    {
        let mut t = seed.transact_mut();
        t.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut t, "block-1", XmlTextPrelim::new("replacement"));
    }
    let other = engine(&seed);
    assert_unchanged(
        &other,
        &c,
        TextError::Unresolvable(Unresolvable::ReplacedSource),
    );
}
#[test]
fn stale_plan_rejects_after_an_intervening_edit() {
    let mut d = engine(&seed("abcd", "x"));
    let p = d
        .prepare_text(&replace(&d, "block-1", 1, 3, "z"), &origin())
        .unwrap();
    let c = insert(&d, "block-2", 1, "y");
    commit(&mut d, &c);
    let before = d.checkpoint().bytes;
    assert_eq!(d.commit_text(p).unwrap_err(), TextError::StalePlan);
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), 1);
}
#[test]
fn prepared_plan_cannot_commit_on_a_different_live_replica() {
    let seed = seed("abc", "x");
    let d = engine(&seed);
    let p = d
        .prepare_text(&insert(&d, "block-1", 1, "x"), &origin())
        .unwrap();
    let mut other = engine(&seed);
    let before = other.checkpoint().bytes;
    assert_eq!(other.commit_text(p).unwrap_err(), TextError::WrongReplica);
    assert_eq!(other.checkpoint().bytes, before);
}
#[test]
fn preparation_and_applicability_do_not_consume_pending_changes() {
    let mut d = engine(&seed("abc", "x"));
    d.snapshot().unwrap();
    let c = insert(&d, "block-1", 1, "z");
    let result = commit(&mut d, &c);
    let c = insert(&d, "block-1", 0, "y");
    d.can_text(&c, &origin()).unwrap();
    d.prepare_text(&c, &origin()).unwrap();
    let s = d.snapshot().unwrap();
    assert_eq!(s.changed_nodes, BTreeSet::from(["block-1".into()]));
    assert_eq!(s.touched_ranges, result.touched_ranges);
    assert!(d.snapshot().unwrap().changed_nodes.is_empty());
}
#[test]
fn joined_replacement_crosses_original_sources_without_cloning_texts() {
    let seed = seed("ab😀", "cאבd");
    mode(&seed, "join", 0);
    let mut d = engine(&seed);
    let before = d.snapshot().unwrap();
    let c = replace(&d, "block-1", 1, 7, "X");
    let r = commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "aXd");
    assert_eq!(
        r.touched_ranges,
        vec![
            TouchedRange {
                source: "block-1".into(),
                start: 1,
                new_start: 1,
                old_end: 4,
                new_end: 2
            },
            TouchedRange {
                source: "block-2".into(),
                start: 0,
                new_start: 0,
                old_end: 3,
                new_end: 0
            }
        ]
    );
    let s = d.snapshot().unwrap();
    for (a, b) in s.visible[0].spans.iter().zip(&before.visible[0].spans) {
        assert_eq!(a.identity, b.identity);
    }
    let peer = replica(21);
    apply(&peer, &bytes(&seed));
    apply(&peer, &r.update.unwrap().bytes);
    assert_eq!(value(&engine(&peer), "block-1"), "aXd");
}
#[test]
fn joined_seam_insertion_respects_original_source_affinity() {
    for bias in [Bias::Left, Bias::Right] {
        let seed = seed("ab", "cd");
        mode(&seed, "join", 0);
        let mut d = engine(&seed);
        let c = TextCommand::Insert {
            at: d.anchor("block-1", U(2), bias).unwrap(),
            text: "X".into(),
        };
        let r = commit(&mut d, &c);
        assert_eq!(
            r.touched_ranges[0].source,
            if bias == Bias::Left {
                "block-1"
            } else {
                "block-2"
            }
        );
        assert_eq!(value(&d, "block-1"), "abXcd");
    }
}
#[test]
fn split_suffix_replacement_maps_to_original_utf16_source() {
    let seed = seed("a😀bcd", "other");
    mode(&seed, "split", 3);
    let mut d = engine(&seed);
    let before = d.snapshot().unwrap();
    let c = replace(&d, "block-split", 0, 2, "👩‍💻");
    let r = commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "a😀");
    assert_eq!(value(&d, "block-split"), "👩‍💻d");
    assert_eq!(r.touched_ranges[0].start, 3);
    assert_eq!(r.touched_ranges[0].old_end, 5);
    assert_eq!(r.touched_ranges[0].new_end, 8);
    assert_eq!(
        d.snapshot().unwrap().visible[0].spans[0].identity,
        before.visible[0].spans[0].identity
    );
}
#[test]
fn split_cut_insertion_follows_frozen_left_affinity_ownership() {
    let seed = seed("abcd", "x");
    mode(&seed, "split", 2);
    let mut d = engine(&seed);
    let c = TextCommand::Insert {
        at: d.anchor("block-1", U(2), Bias::Left).unwrap(),
        text: "X".into(),
    };
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "ab");
    assert_eq!(value(&d, "block-split"), "Xcd");
}
#[test]
fn remote_insert_before_prepare_rebases_stable_selection_and_replay_converges() {
    let seed = seed("a😀b", "cאבd");
    let original = engine(&seed);
    let c = replace(&original, "block-1", 1, 3, "Z");
    let peer = replica(21);
    apply(&peer, &bytes(&seed));
    text(&peer, "block-1").insert(&mut peer.transact_mut_with("fixture:remote"), 0, "e\u{301}");
    let mut d = engine(&peer);
    let r = commit(&mut d, &c);
    assert_eq!(r.touched_ranges[0].start, 3);
    assert_eq!(value(&d, "block-1"), "e\u{301}aZb");
    let third = replica(22);
    let local = r.update.unwrap().bytes;
    apply(&third, &local);
    apply(&third, &bytes(&peer));
    apply(&third, &local);
    apply(&third, &bytes(&peer));
    apply(&peer, &local);
    assert_eq!(
        value(&engine(&third), "block-1"),
        value(&engine(&peer), "block-1")
    );
}
#[test]
fn remote_deleted_selection_collapses_without_redirecting_to_document_end() {
    let seed = seed("a😀b", "x");
    let original = engine(&seed);
    let c = replace(&original, "block-1", 1, 3, "Z");
    text(&seed, "block-1").remove_range(&mut seed.transact_mut(), 1, 2);
    let mut d = engine(&seed);
    commit(&mut d, &c);
    assert_eq!(value(&d, "block-1"), "aZb");
}
#[test]
fn retained_marks_and_shared_text_identity_survive_a_nearby_edit() {
    let seed = seed("a😀b", "x");
    text(&seed, "block-1").format(
        &mut seed.transact_mut(),
        1,
        2,
        std::collections::HashMap::from([
            ("bold".into(), Any::Bool(true)),
            ("opaque".into(), Any::from("kept")),
        ]),
    );
    let mut d = engine(&seed);
    let before = d.snapshot().unwrap();
    let c = insert(&d, "block-1", 0, "Q");
    commit(&mut d, &c);
    let s = d.snapshot().unwrap();
    assert_eq!(
        s.visible[0].spans[0].identity,
        before.visible[0].spans[0].identity
    );
    let run = s.visible[0].runs.iter().find(|r| r.text == "😀").unwrap();
    assert_eq!(run.attributes["bold"], Any::Bool(true));
    assert_eq!(run.attributes["opaque"], Any::from("kept"));
}
#[test]
fn unicode_fixture_replacements_have_fixed_content_and_ranges() {
    for (source, a, b, replacement, expected) in [
        ("a👩‍💻b", 1, 6, "X", "aXb"),
        ("ae\u{301}b", 1, 3, "😀", "a😀b"),
        ("אבגד", 1, 3, "e\u{301}", "אe\u{301}ד"),
        ("a🇭🇺b", 1, 5, "X", "aXb"),
    ] {
        let mut d = engine(&seed(source, "x"));
        let c = replace(&d, "block-1", a, b, replacement);
        let r = commit(&mut d, &c);
        assert_eq!(value(&d, "block-1"), expected);
        assert_eq!(r.touched_ranges[0].old_end, b);
        assert_eq!(
            r.touched_ranges[0].new_end,
            a + replacement.encode_utf16().count() as u32
        );
    }
}
