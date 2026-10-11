//! FND-1.8: single-Yrs registry split/join, real updates, no provider transport.
#[path = "support/split_join.rs"]
mod policy;

use policy::{Anchor, Block, FIRST, Runs, SECOND, registry};
use std::{collections::HashMap, fs, path::PathBuf};
use yrs::{Any, Assoc, Doc, ReadTxn, StateVector, Text, Transact};

type ExpectedAnchors = Vec<(Anchor, (&'static str, u32))>;

fn writer(id: u64, base: &[u8]) -> Doc {
    let doc = registry::replica(id);
    registry::apply(&doc, base);
    doc
}

fn delta(doc: &Doc, sv: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(sv)
}

fn insert(doc: &Doc, key: &str, index: u32, value: &str, mark: &str) {
    policy::text(doc, key).insert_with_attributes(
        &mut doc.transact_mut_with("fixture:edit"),
        index,
        value,
        HashMap::from([(mark.into(), Any::Bool(true))]),
    );
}

fn runs(items: &[(&str, Option<&str>)]) -> Runs {
    items
        .iter()
        .map(|(s, mark)| {
            (
                s.to_string(),
                mark.map(|m| vec![(m.into(), "true".into())])
                    .unwrap_or_default(),
            )
        })
        .collect()
}

fn original_first() -> Runs {
    runs(&[("a", None), ("😀", Some("bold")), ("b", None)])
}
fn original_second() -> Runs {
    runs(&[("c", None), ("אב", Some("code")), ("d", None)])
}
fn edited_first() -> Runs {
    runs(&[
        ("a", None),
        ("😀", Some("bold")),
        ("!", Some("italic")),
        ("b", None),
    ])
}
fn edited_second() -> Runs {
    runs(&[
        ("c", None),
        ("👩‍💻", Some("underline")),
        ("אב", Some("code")),
        ("d", None),
    ])
}

fn check_anchors(doc: &Doc, anchors: &ExpectedAnchors) {
    for (anchor, (block, offset)) in anchors {
        assert_eq!(
            policy::resolve(doc, anchor),
            Some((block.to_string(), *offset)),
            "{anchor:?}"
        );
    }
}

fn check_block(block: &Block, id: &str, parent: &str, order: u32, expected: Runs) {
    assert_eq!(
        (&*block.id, &*block.parent, block.order),
        (id, parent, order)
    );
    assert_eq!(
        block.runs, expected,
        "rich text marks must follow original content"
    );
    assert_eq!(block.len() as usize, block.content().encode_utf16().count());
}

fn check_identities(blocks: &[Block], initial: &[Block]) {
    for span in blocks.iter().flat_map(|b| &b.spans) {
        let original = initial
            .iter()
            .flat_map(|b| &b.spans)
            .find(|s| s.source == span.source)
            .unwrap();
        assert_eq!(
            span.identity, original.identity,
            "shared text must never be replaced"
        );
    }
}

fn permutations(n: usize) -> Vec<Vec<usize>> {
    fn visit(prefix: &mut Vec<usize>, left: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if left.is_empty() {
            out.push(prefix.clone());
            return;
        }
        for i in 0..left.len() {
            let v = left.remove(i);
            prefix.push(v);
            visit(prefix, left, out);
            prefix.pop();
            left.insert(i, v);
        }
    }
    let mut out = vec![];
    visit(&mut vec![], &mut (0..n).collect(), &mut out);
    out
}

fn record(name: &str, report: &str, updates: &[Vec<u8>]) {
    if let Some(dir) = std::env::var_os("EDITAC_SPLIT_JOIN_OUTPUT") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}.txt")), report).unwrap();
        for (i, bytes) in updates.iter().enumerate() {
            fs::write(dir.join(format!("{name}-{i}.bin")), bytes).unwrap();
        }
    }
}

fn replay(name: &str, updates: &[Vec<u8>], expected: &[Block], anchors: &ExpectedAnchors) {
    let orders = permutations(updates.len());
    assert_eq!(orders.len(), (1..=updates.len()).product::<usize>());
    let mut report = format!(
        "inputs=a😀b (bold [1,3)); cאבd (code [1,3)); UTF-16\nexpected={expected:#?}\nanchors={anchors:#?}\n"
    );
    for (schedule, order) in orders.iter().enumerate() {
        let doc = registry::replica(100 + schedule as u64);
        for i in order {
            registry::apply(&doc, &updates[*i]);
            registry::apply(&doc, &updates[*i]);
        }
        let before = registry::full_update(&doc);
        let sv = doc.transact().state_vector();
        assert_eq!(policy::project(&doc), expected, "arrival {order:?}");
        check_anchors(&doc, anchors);
        assert_eq!(
            registry::full_update(&doc),
            before,
            "read must not repair-write"
        );
        assert_eq!(doc.transact().state_vector(), sv);
        for i in order.iter().rev() {
            registry::apply(&doc, &updates[*i]);
        }
        assert_eq!(policy::project(&doc), expected, "reverse replay {order:?}");
        check_anchors(&doc, anchors);
        let restored = writer(1000 + schedule as u64, &registry::full_update(&doc));
        assert_eq!(policy::project(&restored), expected, "restore {order:?}");
        check_anchors(&restored, anchors);
        report.push_str(&format!("{order:?}: duplicate/reverse replay/restore; content/marks/placement/identities/anchors agree\n"));
    }
    record(name, &report, updates);
}

#[test]
fn concurrent_split_edit_partitions_original_text_and_selection_with_fixed_affinity() {
    for (splitter, editor) in [(21, 22), (22, 21)] {
        let source = policy::fixture();
        let initial = policy::project(&source);
        let anchors = vec![
            (policy::anchor(&source, FIRST, 1, Assoc::After), (FIRST, 2)),
            (policy::anchor(&source, FIRST, 3, Assoc::Before), (FIRST, 4)),
            (
                policy::anchor(&source, FIRST, 3, Assoc::After),
                ("block-split", 1),
            ),
            (
                policy::anchor(&source, FIRST, 4, Assoc::Before),
                ("block-split", 2),
            ),
            (
                policy::anchor(&source, FIRST, 4, Assoc::After),
                ("block-split", 4),
            ),
        ];
        let base = registry::full_update(&source);
        let sv = source.transact().state_vector();
        let a = writer(splitter, &base);
        let b = writer(editor, &base);
        policy::split(&a, 3).unwrap();
        insert(&b, FIRST, 0, "^", "underline");
        insert(&b, FIRST, 4, "!", "italic");
        insert(&b, FIRST, 6, "אב", "code");
        let updates = vec![base, delta(&a, &sv), delta(&b, &sv)];
        registry::apply(&a, &updates[2]);
        registry::apply(&b, &updates[1]);
        let expected = policy::project(&a);
        assert_eq!(expected.len(), 3);
        check_block(
            &expected[0],
            FIRST,
            "left",
            0,
            runs(&[("^", Some("underline")), ("a", None), ("😀", Some("bold"))]),
        );
        check_block(
            &expected[1],
            "block-split",
            "left",
            1,
            runs(&[("!", Some("italic")), ("b", None), ("אב", Some("code"))]),
        );
        check_block(&expected[2], SECOND, "right", 0, original_second());
        check_identities(&expected, &initial);
        assert_eq!(policy::project(&b), expected);
        check_anchors(&a, &anchors);
        check_anchors(&b, &anchors);
        replay(
            &format!("split-insert-{splitter}"),
            &updates,
            &expected,
            &anchors,
        );
    }
}

#[test]
fn split_survives_concurrent_deletion_of_boundary_and_preserves_replacement_marks() {
    for (splitter, editor) in [(31, 32), (32, 31)] {
        let source = policy::fixture();
        let initial = policy::project(&source);
        let base = registry::full_update(&source);
        let sv = source.transact().state_vector();
        let anchors = vec![
            (policy::anchor(&source, FIRST, 1, Assoc::Before), (FIRST, 1)),
            (policy::anchor(&source, FIRST, 4, Assoc::Before), (FIRST, 6)),
        ];
        let a = writer(splitter, &base);
        let b = writer(editor, &base);
        policy::split(&a, 3).unwrap();
        policy::text(&b, FIRST).remove_range(
            &mut b.transact_mut_with("fixture:delete-across-cut"),
            1,
            3,
        );
        insert(&b, FIRST, 1, "👩‍💻", "code");
        let updates = vec![base, delta(&a, &sv), delta(&b, &sv)];
        registry::apply(&a, &updates[2]);
        registry::apply(&b, &updates[1]);
        let expected = policy::project(&a);
        check_block(
            &expected[0],
            FIRST,
            "left",
            0,
            runs(&[("a", None), ("👩‍💻", Some("code"))]),
        );
        check_block(&expected[1], "block-split", "left", 1, vec![]);
        check_block(&expected[2], SECOND, "right", 0, original_second());
        check_identities(&expected, &initial);
        assert_eq!(policy::project(&b), expected);
        check_anchors(&a, &anchors);
        check_anchors(&b, &anchors);
        replay(
            &format!("split-delete-{splitter}"),
            &updates,
            &expected,
            &anchors,
        );
    }
}

#[test]
fn concurrent_join_edit_keeps_both_texts_and_routes_original_selections_to_joined_owner() {
    for (joiner, editor) in [(41, 42), (42, 41)] {
        let source = policy::fixture();
        let initial = policy::project(&source);
        let base = registry::full_update(&source);
        let sv = source.transact().state_vector();
        let anchors = vec![
            (policy::anchor(&source, FIRST, 4, Assoc::After), (FIRST, 5)),
            (
                policy::anchor(&source, SECOND, 0, Assoc::Before),
                (FIRST, 5),
            ),
            (
                policy::anchor(&source, SECOND, 1, Assoc::After),
                (FIRST, 11),
            ),
            (
                policy::anchor(&source, SECOND, 3, Assoc::Before),
                (FIRST, 13),
            ),
        ];
        let a = writer(joiner, &base);
        let b = writer(editor, &base);
        policy::join(&a).unwrap();
        insert(&b, FIRST, 3, "!", "italic");
        insert(&b, SECOND, 1, "👩‍💻", "underline");
        let updates = vec![base, delta(&a, &sv), delta(&b, &sv)];
        registry::apply(&a, &updates[2]);
        registry::apply(&b, &updates[1]);
        let expected = policy::project(&a);
        assert_eq!(expected.len(), 1);
        let mut rich = edited_first();
        rich.extend(edited_second());
        check_block(&expected[0], FIRST, "left", 0, rich);
        assert_eq!(expected[0].content(), "a😀!bc👩‍💻אבd");
        assert_eq!(expected[0].spans.len(), 2);
        check_identities(&expected, &initial);
        assert_eq!(policy::project(&b), expected);
        check_anchors(&a, &anchors);
        check_anchors(&b, &anchors);
        replay(
            &format!("join-edit-{joiner}"),
            &updates,
            &expected,
            &anchors,
        );
    }
}

#[test]
fn disconnected_join_edit_and_dependent_delta_replay_keep_stable_target_ownership() {
    let source = policy::fixture();
    let initial = policy::project(&source);
    let base = registry::full_update(&source);
    let sv = source.transact().state_vector();
    let a = writer(51, &base);
    let b = writer(52, &base);
    let offline = writer(53, &base);
    let cursor = policy::anchor(&source, SECOND, 1, Assoc::After);
    policy::join(&a).unwrap();
    let join = delta(&a, &sv);
    registry::apply(&b, &join);
    insert(&b, SECOND, 1, "👩‍💻", "underline");
    let first_edit = delta(&b, &sv);
    let after_first = b.transact().state_vector();
    // This target was captured before the join and resolves inside the same
    // original second shared text, now displayed by block-1. Never a stale offset.
    let relative = yrs::StickyIndex::decode_v1(&cursor.bytes).unwrap();
    let pos = relative.get_offset(&b.transact()).unwrap().index;
    assert_eq!(pos, 6);
    insert(&b, SECOND, pos, "!", "italic");
    let dependent = delta(&b, &after_first);
    insert(&offline, FIRST, 3, "!", "italic");
    let offline_edit = delta(&offline, &sv);
    let updates = vec![base, join, first_edit, dependent, offline_edit];
    for doc in [&a, &b, &offline] {
        for update in &updates {
            registry::apply(doc, update);
        }
    }
    let expected = policy::project(&a);
    assert_eq!(expected.len(), 1);
    let mut rich = edited_first();
    rich.extend(runs(&[
        ("c", None),
        ("👩‍💻", Some("underline")),
        ("!", Some("italic")),
        ("אב", Some("code")),
        ("d", None),
    ]));
    check_block(&expected[0], FIRST, "left", 0, rich);
    check_identities(&expected, &initial);
    assert_eq!(policy::project(&b), expected);
    assert_eq!(policy::project(&offline), expected);
    let anchors = vec![(cursor, (FIRST, 12))];
    for doc in [&a, &b, &offline] {
        check_anchors(doc, &anchors);
    }
    replay("join-disconnected-dependent", &updates, &expected, &anchors);
}

#[test]
fn invalid_split_and_repeated_transform_reject_before_mutation_and_edge_splits_keep_identity() {
    let doc = policy::fixture();
    let initial = policy::project(&doc);
    let before = registry::full_update(&doc);
    let sv = doc.transact().state_vector();
    for offset in [2, 5, u32::MAX] {
        assert_eq!(policy::split(&doc, offset), Err("invalid UTF-16 boundary"));
        assert_eq!(registry::full_update(&doc), before);
        assert_eq!(doc.transact().state_vector(), sv);
        assert_eq!(policy::project(&doc), initial);
    }
    for offset in [0, 4] {
        let edge = writer(61 + u64::from(offset), &before);
        policy::split(&edge, offset).unwrap();
        let expected = policy::project(&edge);
        check_identities(&expected, &initial);
        let (left, right) = if offset == 0 {
            (vec![], original_first())
        } else {
            (original_first(), vec![])
        };
        check_block(&expected[0], FIRST, "left", 0, left);
        check_block(&expected[1], "block-split", "left", 1, right);
        check_block(&expected[2], SECOND, "right", 0, original_second());
        let after = registry::full_update(&edge);
        assert_eq!(policy::split(&edge, 1), Err("pair already transformed"));
        assert_eq!(policy::join(&edge), Err("pair already transformed"));
        assert_eq!(registry::full_update(&edge), after);
        replay(
            &format!("split-edge-{offset}"),
            &[before.clone(), delta(&edge, &sv)],
            &expected,
            &vec![],
        );
    }
}

use yrs::updates::decoder::Decode;
