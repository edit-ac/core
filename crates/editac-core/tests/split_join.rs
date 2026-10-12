//! Actual prepared commands, retained source identities and deterministic v1 replay.
use editac_core::{
    Utf16Offset as U,
    anchors::{Anchor, AnchorError, Bias, BoundaryError, Resolution},
    commands::{structure::*, text::*},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ROOTS},
    projection::ProjectedNode,
};
use std::collections::BTreeMap;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, ClientID, Doc, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact,
    Update, XmlTextPrelim, XmlTextRef,
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
            let text = t
                .get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, id, XmlTextPrelim::new(value));
            let attrs = if id == "block-1" {
                [
                    ("bold".into(), Any::Bool(true)),
                    (
                        "ext:v1".into(),
                        Any::Map(
                            BTreeMap::from([("retained".into(), Any::Bool(true))])
                                .into_iter()
                                .collect::<std::collections::HashMap<_, _>>()
                                .into(),
                        ),
                    ),
                ]
                .into_iter()
                .collect()
            } else {
                [("code".into(), Any::Bool(true))].into_iter().collect()
            };
            text.format(&mut t, 0, value.encode_utf16().count() as u32, attrs);
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
    let Some(Out::YXmlText(text)) = t.get_map(ROOTS[1]).unwrap().get(&t, id) else {
        panic!("text");
    };
    text
}
fn apply(d: &Doc, data: &[u8]) {
    d.transact_mut_with("fixture:remote")
        .apply_update(Update::decode_v1(data).unwrap())
        .unwrap();
}
fn origin() -> TextOrigin {
    TextOrigin::new("structure:explicit").unwrap()
}
fn anchor(d: &Document, id: &str, offset: u32, bias: Bias) -> Anchor {
    d.anchor(id, U(offset), bias).unwrap()
}
fn split(d: &Document, offset: u32) -> StructureCommand {
    StructureCommand::Split {
        at: anchor(d, "block-1", offset, Bias::Left),
    }
}
fn join(d: &Document) -> StructureCommand {
    StructureCommand::Join {
        first: anchor(d, "block-1", 0, Bias::Right),
        second: anchor(d, "block-2", 0, Bias::Right),
    }
}
fn run(d: &mut Document, c: &StructureCommand) -> StructureCommit {
    let p = d.prepare_structure(c, &origin()).unwrap();
    d.commit_structure(p).unwrap()
}
fn content(n: &ProjectedNode) -> String {
    n.runs.iter().map(|r| r.text.as_str()).collect()
}
fn visible(d: &Document) -> Vec<(String, String)> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .map(|n| (n.id.clone(), content(n)))
        .collect()
}
fn unchanged(d: &Document, c: &StructureCommand, expected: StructureError) {
    let before = d.checkpoint().bytes;
    let revision = d.revision();
    assert_eq!(d.can_structure(c, &origin()), Err(expected.clone()));
    assert_eq!(d.prepare_structure(c, &origin()).unwrap_err(), expected);
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), revision);
}
fn raw_mode(d: &Doc) -> String {
    let t = d.transact();
    let Some(Out::Any(Any::Array(a))) = t.get_map(ROOTS[4]).unwrap().get(&t, "pair") else {
        panic!("pair");
    };
    let Any::String(s) = &a[0] else {
        panic!("mode");
    };
    s.to_string()
}
fn assert_sources_preserved(before: &Document, after: &Document) {
    let a = replica(31);
    apply(&a, &before.checkpoint().bytes);
    let b = replica(32);
    apply(&b, &after.checkpoint().bytes);
    for id in ["block-1", "block-2"] {
        let x = text(&a, id);
        let y = text(&b, id);
        assert_eq!(
            format!("{:?}", yrs::XmlOut::Text(x.clone()).id()),
            format!("{:?}", yrs::XmlOut::Text(y.clone()).id())
        );
        assert_eq!(x.diff(&a.transact(), |_| ()), y.diff(&b.transact(), |_| ()));
        for root in [ROOTS[0], ROOTS[2]] {
            assert_eq!(
                a.transact().get_map(root).unwrap().get(&a.transact(), id),
                b.transact().get_map(root).unwrap().get(&b.transact(), id)
            );
        }
    }
    assert!(
        !b.transact()
            .get_map(ROOTS[1])
            .unwrap()
            .contains_key(&b.transact(), "block-split")
    );
}
fn split_case(first: &str, cut: u32, left: &str, right: &str) {
    let s = seed(first, "Z");
    let before = engine(&s);
    let mut d = engine(&s);
    let c = split(&d, cut);
    let r = run(&mut d, &c);
    assert_eq!(r.revision, 1);
    assert_eq!(r.origin, origin());
    assert!(!r.update.bytes.is_empty());
    assert_eq!(
        visible(&d),
        vec![
            ("block-1".into(), left.into()),
            ("block-2".into(), "Z".into()),
            ("block-split".into(), right.into())
        ]
    );
    assert_sources_preserved(&before, &d);
    let snapshot = d.snapshot().unwrap();
    let right = snapshot
        .visible
        .iter()
        .find(|n| n.id == "block-split")
        .unwrap();
    assert_eq!(right.kind, "list");
    assert_eq!(right.parent, "@root");
    assert_eq!(right.order, 1);
    assert_eq!(right.spans[0].source, "block-1");
    assert_eq!(right.spans[0].start, cut);
}
#[test]
fn split_at_beginning() {
    split_case("abcd", 0, "", "abcd");
}
#[test]
fn split_at_middle() {
    split_case("abcd", 2, "ab", "cd");
}
#[test]
fn split_at_end() {
    split_case("abcd", 4, "abcd", "");
}
#[test]
fn split_empty_text_retains_both_empty_owner_identities() {
    split_case("", 0, "", "");
}
#[test]
fn unicode_split_uses_utf16_without_normalizing_graphemes_or_rtl() {
    for (s, cut, l, r) in [
        ("a😀b", 3, "a😀", "b"),
        ("👩‍💻x", 5, "👩‍💻", "x"),
        ("e\u{301}x", 2, "e\u{301}", "x"),
        ("אבג", 2, "אב", "ג"),
    ] {
        split_case(s, cut, l, r);
    }
}
fn join_case(first: &str, second: &str) {
    let s = seed(first, second);
    let before = engine(&s);
    let mut d = engine(&s);
    let c = join(&d);
    run(&mut d, &c);
    assert_eq!(
        visible(&d),
        vec![("block-1".into(), format!("{first}{second}"))]
    );
    let n = &d.snapshot().unwrap().visible[0];
    assert_eq!(
        n.spans
            .iter()
            .map(|s| s.source.as_str())
            .collect::<Vec<_>>(),
        ["block-1", "block-2"]
    );
    assert_eq!(n.order, 0);
    assert_sources_preserved(&before, &d);
}
#[test]
fn join_nonempty_marked_sources() {
    join_case("a😀b", "cאבd");
}
#[test]
fn join_empty_first() {
    join_case("", "right");
}
#[test]
fn join_empty_second() {
    join_case("left", "");
}
#[test]
fn join_both_empty() {
    join_case("", "");
}
#[test]
fn source_selections_resolve_after_split_and_join() {
    let s = seed("abcd", "EF");
    for split_mode in [true, false] {
        let mut d = engine(&s);
        let left = anchor(&d, "block-1", 2, Bias::Left);
        let right = anchor(&d, "block-1", 2, Bias::Right);
        let second = anchor(&d, "block-2", 1, Bias::Right);
        let c = if split_mode { split(&d, 2) } else { join(&d) };
        run(&mut d, &c);
        let pos = |a: &Anchor| {
            let Resolution::Position(p) = d.resolve_anchor(a).unwrap() else {
                panic!("position");
            };
            p
        };
        assert_eq!(pos(&left).node, "block-1");
        assert_eq!(
            pos(&right).node,
            if split_mode { "block-split" } else { "block-1" }
        );
        assert_eq!(pos(&right).offset, U(if split_mode { 0 } else { 2 }));
        assert_eq!(
            pos(&second).node,
            if split_mode { "block-2" } else { "block-1" }
        );
        assert_eq!(pos(&second).offset, U(if split_mode { 1 } else { 5 }));
    }
}
#[test]
fn split_cut_always_has_left_affinity_even_with_right_biased_command() {
    let s = seed("abcd", "EF");
    let mut d = engine(&s);
    let c = StructureCommand::Split {
        at: anchor(&d, "block-1", 2, Bias::Right),
    };
    run(&mut d, &c);
    let peer = replica(41);
    apply(&peer, &d.checkpoint().bytes);
    text(&peer, "block-1").insert(&mut peer.transact_mut(), 2, "R");
    let restored = engine(&peer);
    assert_eq!(
        visible(&restored),
        vec![
            ("block-1".into(), "ab".into()),
            ("block-2".into(), "EF".into()),
            ("block-split".into(), "Rcd".into())
        ]
    );
}
#[test]
fn remote_insert_before_preparation_resolves_the_original_anchor() {
    let s = seed("abcd", "EF");
    let d = engine(&s);
    let c = split(&d, 2);
    let remote = replica(41);
    apply(&remote, &bytes(&s));
    text(&remote, "block-1").insert(&mut remote.transact_mut(), 0, "X");
    let mut d = engine(&remote);
    run(&mut d, &c);
    assert_eq!(
        visible(&d),
        vec![
            ("block-1".into(), "Xab".into()),
            ("block-2".into(), "EF".into()),
            ("block-split".into(), "cd".into())
        ]
    );
}
#[test]
fn deleted_characters_move_the_cut_without_absolute_offset_drift() {
    let s = seed("abcd", "EF");
    let mut d = engine(&s);
    let c = split(&d, 2);
    run(&mut d, &c);
    let peer = replica(41);
    apply(&peer, &d.checkpoint().bytes);
    text(&peer, "block-1").remove_range(&mut peer.transact_mut(), 0, 2);
    assert_eq!(
        visible(&engine(&peer)),
        vec![
            ("block-1".into(), "".into()),
            ("block-2".into(), "EF".into()),
            ("block-split".into(), "cd".into())
        ]
    );
}
#[test]
fn surrogate_interior_and_out_of_bounds_fail_without_mutation() {
    let d = engine(&seed("a😀b", "Z"));
    let before = d.checkpoint().bytes;
    assert!(matches!(
        d.anchor("block-1", U(2), Bias::Left),
        Err(AnchorError::Boundary(BoundaryError::SurrogateInterior))
    ));
    assert!(d.anchor("block-1", U(99), Bias::Left).is_err());
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn known_deleted_targets_and_deleted_split_output_reject_before_mutation() {
    for deleted in ["block-1", "block-2", "block-split"] {
        let s = seed("abcd", "EF");
        let d = engine(&s);
        let c = if deleted == "block-2" {
            join(&d)
        } else {
            split(&d, 2)
        };
        let mut t = s.transact_mut();
        t.get_map(ROOTS[3]).unwrap().insert(&mut t, deleted, true);
        drop(t);
        let d = engine(&s);
        unchanged(
            &d,
            &c,
            if deleted == "block-split" {
                StructureError::DeletedOutput
            } else {
                StructureError::Text(TextError::DeletedTarget)
            },
        );
    }
}
#[test]
fn unsupported_pair_and_unknown_target_kinds_fail_atomically() {
    let s = seed("abcd", "EF");
    let d = engine(&s);
    let c = split(&d, 2);
    let mut t = s.transact_mut();
    t.get_map(ROOTS[4]).unwrap().remove(&mut t, "pair");
    drop(t);
    unchanged(&engine(&s), &c, StructureError::UnsupportedPair);
    for (id, is_join) in [("block-1", false), ("block-2", true)] {
        let s = seed("abcd", "EF");
        let mut t = s.transact_mut();
        t.get_map(ROOTS[0])
            .unwrap()
            .insert(&mut t, id, "extension:v1");
        drop(t);
        let d = engine(&s);
        let c = if is_join { join(&d) } else { split(&d, 2) };
        unchanged(&d, &c, StructureError::Text(TextError::UnsupportedKind));
    }
}
#[test]
fn reversed_or_wrong_source_targets_are_explicitly_unsupported() {
    let d = engine(&seed("abcd", "EF"));
    unchanged(
        &d,
        &StructureCommand::Split {
            at: anchor(&d, "block-2", 1, Bias::Left),
        },
        StructureError::UnsupportedPair,
    );
    unchanged(
        &d,
        &StructureCommand::Join {
            first: anchor(&d, "block-2", 0, Bias::Right),
            second: anchor(&d, "block-1", 0, Bias::Right),
        },
        StructureError::UnsupportedPair,
    );
}
#[test]
fn split_at_maximum_order_is_rejected_before_descriptor_write() {
    let s = seed("abcd", "EF");
    let mut t = s.transact_mut();
    t.get_map(ROOTS[2]).unwrap().insert(
        &mut t,
        "block-1",
        Any::Array(vec![Any::from("@root"), Any::from(u32::MAX as f64)].into()),
    );
    drop(t);
    let d = engine(&s);
    unchanged(&d, &split(&d, 2), StructureError::OrderOverflow);
}
#[test]
fn repeated_transformations_are_rejected_instead_of_rebinding_or_cloning() {
    for split_mode in [true, false] {
        let mut d = engine(&seed("abcd", "EF"));
        let c = if split_mode { split(&d, 2) } else { join(&d) };
        run(&mut d, &c);
        unchanged(&d, &c, StructureError::AlreadyTransformed);
    }
}
#[test]
fn wrong_replica_and_intervening_local_edit_invalidate_plans() {
    let s = seed("abcd", "EF");
    let mut a = engine(&s);
    let mut b = engine(&s);
    let c = split(&a, 2);
    let p = a.prepare_structure(&c, &origin()).unwrap();
    let before = b.checkpoint().bytes;
    assert_eq!(
        b.commit_structure(p).unwrap_err(),
        StructureError::Text(TextError::WrongReplica)
    );
    assert_eq!(b.checkpoint().bytes, before);
    let p = a.prepare_structure(&c, &origin()).unwrap();
    let edit = TextCommand::Insert {
        at: anchor(&a, "block-1", 0, Bias::Right),
        text: "X".into(),
    };
    let ep = a.prepare_text(&edit, &origin()).unwrap();
    a.commit_text(ep).unwrap();
    let before = a.checkpoint().bytes;
    assert_eq!(
        a.commit_structure(p).unwrap_err(),
        StructureError::Text(TextError::StalePlan)
    );
    assert_eq!(a.checkpoint().bytes, before);
}

fn permutations<const N: usize>() -> Vec<[usize; N]> {
    fn walk<const N: usize>(a: &mut [usize; N], at: usize, out: &mut Vec<[usize; N]>) {
        if at == N {
            out.push(*a);
            return;
        }
        for i in at..N {
            a.swap(at, i);
            walk(a, at + 1, out);
            a.swap(at, i);
        }
    }
    let mut a = std::array::from_fn(|i| i);
    let mut out = Vec::new();
    walk(&mut a, 0, &mut out);
    out
}
fn canonical(
    d: &Document,
) -> (
    Vec<std::sync::Arc<ProjectedNode>>,
    Vec<std::sync::Arc<ProjectedNode>>,
) {
    let s = d.snapshot().unwrap();
    (s.visible, s.recovery)
}
fn remote_edits(s: &Doc) -> Vec<u8> {
    let mut d = engine(s);
    for (id, offset, inserted) in [("block-1", 2, "R"), ("block-2", 2, "S")] {
        let edit = TextCommand::Insert {
            at: anchor(&d, id, offset, Bias::Right),
            text: inserted.into(),
        };
        let p = d
            .prepare_text(&edit, &TextOrigin::new("race:edit").unwrap())
            .unwrap();
        d.commit_text(p).unwrap();
    }
    // Send only the new causal items. A receiver scheduled before initialization
    // must really buffer these edits, rather than getting the seed in a checkpoint.
    let peer = replica(44);
    apply(&peer, &d.checkpoint().bytes);
    let delta = peer
        .transact()
        .encode_state_as_update_v1(&s.transact().state_vector());
    delta
}
#[test]
fn split_and_join_each_preserve_acknowledged_remote_edits_on_three_replicas() {
    let orders = permutations::<3>();
    assert_eq!(orders.len(), 6);
    for split_mode in [true, false] {
        let s = seed("abcd", "WXYZ");
        let mut d = engine(&s);
        let c = if split_mode { split(&d, 2) } else { join(&d) };
        let u = run(&mut d, &c).update.bytes;
        let edits = remote_edits(&s);
        let inputs = [bytes(&s), u, edits];
        let mut reference = None;
        for order in &orders {
            for client in [21, 22, 23] {
                let peer = replica(client);
                for i in order {
                    apply(&peer, &inputs[*i]);
                    apply(&peer, &inputs[*i]);
                }
                for i in order.iter().rev() {
                    apply(&peer, &inputs[*i]);
                }
                let restored = engine(&peer);
                let expected = if split_mode {
                    vec![
                        ("block-1".into(), "ab".into()),
                        ("block-2".into(), "WXSYZ".into()),
                        ("block-split".into(), "Rcd".into()),
                    ]
                } else {
                    vec![("block-1".into(), "abRcdWXSYZ".into())]
                };
                assert_eq!(visible(&restored), expected);
                for n in &restored.snapshot().unwrap().visible {
                    for run in &n.runs {
                        if n.id == "block-2" || (n.id == "block-1" && run.text.contains('W')) {
                            assert_eq!(run.attributes.get("code"), Some(&Any::Bool(true)));
                        } else {
                            assert_eq!(run.attributes.get("bold"), Some(&Any::Bool(true)));
                            assert!(run.attributes.contains_key("ext:v1"));
                        }
                    }
                }
                let actual = canonical(&restored);
                if let Some(ref expected) = reference {
                    assert_eq!(&actual, expected);
                } else {
                    reference = Some(actual);
                }
                let checkpoint = restored.checkpoint();
                let restarted = Document::restore(&identity(), &checkpoint, &[]).unwrap();
                assert_eq!(canonical(&restored), canonical(&restarted));
            }
        }
    }
}
#[test]
fn concurrent_split_join_and_text_edits_converge_for_both_writer_priorities() {
    let orders = permutations::<4>();
    assert_eq!(orders.len(), 24);
    for split_wins in [true, false] {
        let s = seed("abcd", "WXYZ");
        let a = engine(&s);
        let b = engine(&s);
        let (lower, higher) = if a.writer_id() < b.writer_id() {
            (a, b)
        } else {
            (b, a)
        };
        let (mut splitter, mut joiner) = if split_wins {
            (higher, lower)
        } else {
            (lower, higher)
        };
        let sc = split(&splitter, 2);
        let jc = join(&joiner);
        let su = run(&mut splitter, &sc).update.bytes;
        let ju = run(&mut joiner, &jc).update.bytes;
        let inputs = [bytes(&s), su, ju, remote_edits(&s)];
        let mut reference = None;
        for order in &orders {
            for client in [21, 22, 23] {
                let peer = replica(client);
                for i in order {
                    apply(&peer, &inputs[*i]);
                    apply(&peer, &inputs[*i]);
                }
                for i in order.iter().rev() {
                    apply(&peer, &inputs[*i]);
                }
                assert_eq!(raw_mode(&peer), if split_wins { "split" } else { "join" });
                let restored = engine(&peer);
                assert_eq!(
                    visible(&restored),
                    if split_wins {
                        vec![
                            ("block-1".into(), "ab".into()),
                            ("block-2".into(), "WXSYZ".into()),
                            ("block-split".into(), "Rcd".into()),
                        ]
                    } else {
                        vec![("block-1".into(), "abRcdWXSYZ".into())]
                    }
                );
                let actual = canonical(&restored);
                if let Some(ref expected) = reference {
                    assert_eq!(&actual, expected);
                } else {
                    reference = Some(actual);
                }
                // Merge back into both disconnected writers' actual CRDT states.
                for checkpoint in [splitter.checkpoint(), joiner.checkpoint()] {
                    let writer = replica(51);
                    apply(&writer, &checkpoint.bytes);
                    apply(&writer, &bytes(&peer));
                    assert_eq!(canonical(&engine(&writer)), canonical(&restored));
                }
            }
        }
    }
}
#[test]
fn concurrent_deletion_retains_marked_source_recovery_without_resurrecting_targets() {
    let orders = permutations::<3>();
    for (split_mode, deleted) in [
        (true, "block-1"),
        (true, "block-split"),
        (false, "block-1"),
        (false, "block-2"),
    ] {
        let s = seed("abcd", "EF");
        let mut d = engine(&s);
        let at = anchor(&d, "block-1", 3, Bias::Right);
        let c = if split_mode { split(&d, 2) } else { join(&d) };
        let u = run(&mut d, &c).update.bytes;
        let remote = replica(42);
        apply(&remote, &bytes(&s));
        let deletion = {
            let mut t = remote.transact_mut_with("fixture:delete");
            t.get_map(ROOTS[3]).unwrap().insert(&mut t, deleted, true);
            t.encode_update_v1()
        };
        let inputs = [bytes(&s), u, deletion];
        let mut reference = None;
        for order in &orders {
            for client in [21, 22, 23] {
                let peer = replica(client);
                for i in order {
                    apply(&peer, &inputs[*i]);
                    apply(&peer, &inputs[*i]);
                }
                let restored = engine(&peer);
                let snap = restored.snapshot().unwrap();
                let retained: String = snap
                    .visible
                    .iter()
                    .chain(&snap.recovery)
                    .map(|n| content(n))
                    .collect();
                assert_eq!(retained.chars().count(), 6);
                let actual_visible: Vec<_> = snap
                    .visible
                    .iter()
                    .map(|n| (n.id.as_str(), content(n)))
                    .collect();
                let actual_recovery: Vec<_> = snap
                    .recovery
                    .iter()
                    .map(|n| (n.id.as_str(), content(n)))
                    .collect();
                let (expected_visible, expected_recovery) = match (split_mode, deleted) {
                    (true, "block-1") => (
                        vec![("block-2", "EF".into())],
                        vec![("block-1", "ab".into()), ("block-split", "cd".into())],
                    ),
                    (true, "block-split") => (
                        vec![("block-1", "ab".into()), ("block-2", "EF".into())],
                        vec![("block-split", "cd".into())],
                    ),
                    (false, "block-1") => (vec![], vec![("block-1", "abcdEF".into())]),
                    (false, "block-2") => (
                        vec![("block-1", "abcd".into())],
                        vec![("block-1", "EF".into())],
                    ),
                    _ => unreachable!(),
                };
                assert_eq!(actual_visible, expected_visible);
                assert_eq!(actual_recovery, expected_recovery);
                assert!(snap.recovery.iter().any(|n| {
                    n.spans
                        .iter()
                        .any(|s| s.source == deleted || deleted == "block-split")
                }));
                for run in snap.recovery.iter().flat_map(|n| &n.runs) {
                    assert!(!run.attributes.is_empty());
                }
                if deleted != "block-2" {
                    assert!(matches!(
                        restored.resolve_anchor(&at).unwrap(),
                        Resolution::Deleted { .. }
                    ));
                }
                let actual = canonical(&restored);
                if let Some(ref expected) = reference {
                    assert_eq!(&actual, expected);
                } else {
                    reference = Some(actual);
                }
            }
        }
    }
}
#[test]
fn split_inherits_resolved_parent_and_order_without_rewriting_raw_placement() {
    let s = seed("abcd", "EF");
    {
        let mut t = s.transact_mut();
        t.get_map(ROOTS[0])
            .unwrap()
            .insert(&mut t, "parent", "list");
        t.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut t, "parent", XmlTextPrelim::new("P"));
        t.get_map(ROOTS[2]).unwrap().insert(
            &mut t,
            "parent",
            Any::Array(vec![Any::from("@root"), Any::from(0)].into()),
        );
        t.get_map(ROOTS[2]).unwrap().insert(
            &mut t,
            "block-1",
            Any::Array(vec![Any::from("parent"), Any::from(7)].into()),
        );
    }
    let before = engine(&s);
    let mut d = engine(&s);
    let c = split(&d, 2);
    run(&mut d, &c);
    let snap = d.snapshot().unwrap();
    let n = snap.visible.iter().find(|n| n.id == "block-split").unwrap();
    assert_eq!(n.parent, "parent");
    assert_eq!(n.order, 8);
    assert_sources_preserved(&before, &d);
}
#[test]
fn pinned_yjs_resolves_rust_cut_and_rust_restores_js_join_and_raced_edits() {
    use std::{fs, path::Path, process::Command};
    let s = seed("a😀b", "cאבd");
    let before = engine(&s);
    let mut d = engine(&s);
    let at = anchor(&d, "block-1", 4, Bias::Right);
    let c = split(&d, 3);
    run(&mut d, &c);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::var_os("EDITAC_SPLIT_JOIN_EXCHANGE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("target/split-join-command-interop"));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("seed.bin"), bytes(&s)).unwrap();
    fs::write(dir.join("rust-split.bin"), d.checkpoint().bytes).unwrap();
    let mut j = engine(&s);
    let c = join(&j);
    run(&mut j, &c);
    fs::write(dir.join("rust-join.bin"), j.checkpoint().bytes).unwrap();
    let result = Command::new("node")
        .arg(root.join("fixtures/schema-v1/split-join-exchange.mjs"))
        .arg(&dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("bridge.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "Yjs bridge failed; inspect {}",
        dir.join("bridge.log").display()
    );
    let peer = replica(22);
    apply(&peer, &fs::read(dir.join("js-split-edit.bin")).unwrap());
    let restored = engine(&peer);
    assert_eq!(
        visible(&restored),
        vec![
            ("block-1".into(), "a😀".into()),
            ("block-2".into(), "cאבdS".into()),
            ("block-split".into(), "Rb".into())
        ]
    );
    let Resolution::Position(p) = restored.resolve_anchor(&at).unwrap() else {
        panic!("anchor");
    };
    assert_eq!(p.node, "block-split");
    assert_eq!(p.offset, U(2));
    let peer = replica(23);
    apply(&peer, &fs::read(dir.join("js-join.bin")).unwrap());
    let restored = engine(&peer);
    assert_eq!(
        visible(&restored),
        vec![("block-1".into(), "aJ😀bcKאבd".into())]
    );
    let snap = restored.snapshot().unwrap();
    assert_eq!(
        snap.visible[0].spans[0].identity,
        before.snapshot().unwrap().visible[0].spans[0].identity
    );
    assert_eq!(
        snap.visible[0].spans[1].identity,
        before.snapshot().unwrap().visible[1].spans[0].identity
    );
    assert!(
        snap.visible[0]
            .runs
            .iter()
            .any(|r| r.attributes.contains_key("ext:v1"))
    );
}

#[test]
fn mixed_attributed_runs_created_by_format_commands_survive_split_and_join() {
    use editac_core::commands::format::{FormatAction, FormatCommand, Mark};
    for split_mode in [true, false] {
        let mut d = engine(&seed("abcd", "EF"));
        let commands: Vec<_> = [Mark::Italic, Mark::Underline, Mark::Strike, Mark::Link]
            .into_iter()
            .map(|mark| FormatCommand {
                selection: d
                    .selection(
                        ("block-1", U(1), Bias::Right),
                        ("block-1", U(3), Bias::Left),
                    )
                    .unwrap(),
                mark,
                action: FormatAction::Apply,
                href: (mark == Mark::Link).then(|| "https://example.com/".into()),
            })
            .collect();
        let plan = d.prepare_format(&commands, &origin()).unwrap();
        d.commit_format(plan).unwrap();
        let peer = replica(61);
        apply(&peer, &d.checkpoint().bytes);
        let before = engine(&peer);
        let c = if split_mode { split(&d, 2) } else { join(&d) };
        run(&mut d, &c);
        assert_sources_preserved(&before, &d);
        let snap = d.snapshot().unwrap();
        let owners: Vec<_> = snap.visible.iter().filter(|n| n.id != "block-2").collect();
        let formatted: String = owners
            .iter()
            .flat_map(|n| &n.runs)
            .filter(|r| r.attributes.contains_key("link"))
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(formatted, "bc");
        for run in owners
            .iter()
            .flat_map(|n| &n.runs)
            .filter(|r| r.attributes.contains_key("link"))
        {
            for name in ["bold", "italic", "underline", "strike"] {
                assert_eq!(run.attributes.get(name), Some(&Any::Bool(true)));
            }
            assert_eq!(
                run.attributes.get("link"),
                Some(&Any::from("https://example.com/"))
            );
            assert!(run.attributes.contains_key("ext:v1"));
        }
    }
}
#[test]
fn join_targets_may_be_stable_beginning_middle_or_end_positions() {
    for (first_offset, second_offset) in [(0, 0), (2, 1), (4, 2)] {
        let mut d = engine(&seed("abcd", "EF"));
        let c = StructureCommand::Join {
            first: anchor(&d, "block-1", first_offset, Bias::Left),
            second: anchor(&d, "block-2", second_offset, Bias::Left),
        };
        run(&mut d, &c);
        assert_eq!(visible(&d), vec![("block-1".into(), "abcdEF".into())]);
    }
}

#[path = "support/general_structure.rs"]
mod general;
