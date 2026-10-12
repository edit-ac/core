//! Real pinned Yrs transactions and update replay; no mocked document state.
#[allow(dead_code)]
#[path = "support/structure_conflicts.rs"]
mod policy;
use editac_core::document::{CreationPermit, Document, DocumentIdentity, InitialNode, ROOTS};
use editac_core::projection::{ProjectionError, ProjectionIndex, Snapshot, TouchedRange};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, Out, ReadTxn, StateVector, Text, Transact, Update, XmlTextPrelim, XmlTextRef,
};

fn content(node: &editac_core::projection::ProjectedNode) -> String {
    node.runs.iter().map(|r| r.text.as_str()).collect()
}
fn text(doc: &Doc, id: &str) -> XmlTextRef {
    let txn = doc.transact();
    let Some(Out::YXmlText(t)) = txn.get_map(ROOTS[1]).unwrap().get(&txn, id) else {
        panic!("missing text")
    };
    t
}
fn ordinary(rows: &[(&str, &str, &str, u32, &str)]) -> Doc {
    let doc = editac_core::new_document();
    for root in ROOTS {
        doc.get_or_insert_map(root);
    }
    let mut txn = doc.transact_mut();
    for (id, kind, parent, order, value) in rows {
        txn.get_map(ROOTS[0]).unwrap().insert(&mut txn, *id, *kind);
        txn.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut txn, *id, XmlTextPrelim::new(*value));
        txn.get_map(ROOTS[2]).unwrap().insert(
            &mut txn,
            *id,
            Any::Array(vec![Any::from(*parent), Any::from(*order)].into()),
        );
    }
    drop(txn);
    doc
}
fn ids(s: &Snapshot) -> Vec<&str> {
    s.visible.iter().map(|n| n.id.as_str()).collect()
}
fn assert_policy(doc: &Doc, index: &ProjectionIndex) {
    let actual = index.read().unwrap();
    let expected = policy::project(doc);
    for (actual, expected) in [
        (&actual.visible, &expected.visible),
        (&actual.recovery, &expected.recovery),
    ] {
        assert_eq!(actual.len(), expected.len());
        for (a, b) in actual.iter().zip(expected) {
            assert_eq!((&a.id, &a.parent, a.order), (&b.id, &b.parent, b.order));
            let runs: Vec<_> = a
                .runs
                .iter()
                .map(|r| {
                    (
                        r.text.clone(),
                        r.attributes
                            .iter()
                            .map(|(k, v)| (k.clone(), v.to_string()))
                            .collect::<Vec<_>>(),
                    )
                })
                .collect();
            assert_eq!(runs, b.runs);
            assert_eq!(
                a.spans
                    .iter()
                    .map(|s| (&s.source, &s.identity, s.start, s.end))
                    .collect::<Vec<_>>(),
                b.spans
                    .iter()
                    .map(|s| (&s.source, &s.identity, s.start, s.end))
                    .collect::<Vec<_>>()
            );
        }
    }
}
#[test]
fn fixed_seed_snapshot_preserves_rich_text_and_integrated_identities() {
    let doc = policy::fixture();
    let index = ProjectionIndex::new(&doc);
    let s = index.read().unwrap();
    assert_eq!(ids(&s), ["block-1", "block-2"]);
    assert_eq!(
        s.visible.iter().map(|n| content(n)).collect::<Vec<_>>(),
        ["a😀b", "cאבd"]
    );
    assert_eq!(
        s.visible[0]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>(),
        ["a", "😀", "b"]
    );
    assert_eq!(s.visible[0].runs[1].attributes["bold"], Any::Bool(true));
    assert_eq!(s.visible[1].runs[1].attributes["code"], Any::Bool(true));
    assert_eq!(s.visible[0].spans[0].end, 4);
    assert_ne!(
        s.visible[0].spans[0].identity,
        s.visible[1].spans[0].identity
    );
    assert_policy(&doc, &index);
}
#[test]
fn one_unicode_edit_reads_only_one_source_and_preserves_untouched_nodes() {
    let rows: Vec<_> = (0..128).map(|i| (format!("n-{i:x}"), i)).collect();
    let doc = ordinary(
        &rows
            .iter()
            .map(|(id, i)| (id.as_str(), "item", "@root", *i, "a😀b"))
            .collect::<Vec<_>>(),
    );
    let index = ProjectionIndex::new(&doc);
    let before = index.read().unwrap();
    let t = text(&doc, "n-0");
    t.insert(&mut doc.transact_mut(), 3, "Z");
    let after = index.read().unwrap();
    assert_eq!(after.changed_nodes, BTreeSet::from(["n-0".into()]));
    assert_eq!(after.source_reads, 1);
    assert!(!after.structure_rebuilt);
    assert_eq!(
        after.touched_ranges,
        [TouchedRange {
            source: "n-0".into(),
            start: 3,
            new_start: 3,
            old_end: 3,
            new_end: 4
        }]
    );
    assert_eq!(content(&after.visible[0]), "a😀Zb");
    for i in 1..128 {
        assert!(Arc::ptr_eq(&before.visible[i], &after.visible[i]));
    }
    assert_eq!(content(&before.visible[0]), "a😀b");
    let idle = index.read().unwrap();
    assert!(idle.changed_nodes.is_empty());
    assert!(idle.touched_ranges.is_empty());
    assert_eq!(idle.source_reads, 0);
}
#[test]
fn formatting_and_deletion_report_utf16_transaction_ranges() {
    let doc = ordinary(&[("a", "item", "@root", 0, "a😀b")]);
    let index = ProjectionIndex::new(&doc);
    index.read().unwrap();
    let t = text(&doc, "a");
    t.format(
        &mut doc.transact_mut(),
        1,
        2,
        HashMap::from([(
            "unknown-mark".into(),
            Any::Array(vec![true.into(), "opaque".into()].into()),
        )]),
    );
    let marked = index.read().unwrap();
    assert_eq!(
        marked.touched_ranges,
        [TouchedRange {
            source: "a".into(),
            start: 1,
            new_start: 1,
            old_end: 3,
            new_end: 3
        }]
    );
    assert_eq!(
        marked.visible[0].runs[1].attributes["unknown-mark"],
        Any::Array(vec![true.into(), "opaque".into()].into())
    );
    t.remove_range(&mut doc.transact_mut(), 1, 2);
    let deleted = index.read().unwrap();
    assert_eq!(content(&deleted.visible[0]), "ab");
    assert_eq!(
        deleted.touched_ranges,
        [TouchedRange {
            source: "a".into(),
            start: 1,
            new_start: 1,
            old_end: 3,
            new_end: 1
        }]
    );
}
#[test]
fn multiple_commits_accumulate_ranges_without_rereading_unrelated_text() {
    let doc = ordinary(&[
        ("a", "item", "@root", 0, "x"),
        ("b", "item", "@root", 1, "y"),
    ]);
    let index = ProjectionIndex::new(&doc);
    index.read().unwrap();
    text(&doc, "a").insert(&mut doc.transact_mut(), 1, "😀");
    text(&doc, "a").insert(&mut doc.transact_mut(), 0, "z");
    let s = index.read().unwrap();
    assert_eq!(s.source_reads, 1);
    assert_eq!(s.touched_ranges.len(), 2);
    assert_eq!(content(&s.visible[0]), "zx😀");
}
#[test]
fn hierarchy_fallback_cycles_and_late_parent_are_read_only() {
    let doc = ordinary(&[
        ("a", "list", "b", 0, "A"),
        ("b", "list", "a", 0, "B"),
        ("c", "item", "missing", 0, "C"),
        ("d", "opaque", "@root", 1, "D"),
        ("e", "item", "d", 2, "E"),
    ]);
    let index = ProjectionIndex::new(&doc);
    let before = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let s = index.read().unwrap();
    assert_eq!(ids(&s), ["a", "b", "c", "d", "e"]);
    assert_eq!(s.visible[0].parent, "@root");
    assert_eq!(s.visible[1].parent, "a");
    assert_eq!(s.visible[4].parent, "@root");
    assert_eq!(s.visible[3].kind, "opaque");
    assert_eq!(
        before,
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    );
    {
        let mut txn = doc.transact_mut();
        txn.get_map(ROOTS[0])
            .unwrap()
            .insert(&mut txn, "missing", "list");
        txn.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut txn, "missing", XmlTextPrelim::new(""));
    }
    let s = index.read().unwrap();
    assert_eq!(
        s.visible.iter().find(|n| n.id == "c").unwrap().parent,
        "missing"
    );
    assert_eq!(s.source_reads, 1);
}
#[test]
fn malformed_and_fractional_placements_use_frozen_root_fallback() {
    let doc = ordinary(&[
        ("a", "item", "@root", 1, "A"),
        ("b", "item", "@root", 2, "B"),
    ]);
    {
        let mut txn = doc.transact_mut();
        let map = txn.get_map(ROOTS[2]).unwrap();
        map.remove(&mut txn, "a");
        map.insert(
            &mut txn,
            "b",
            Any::Array(vec!["a".into(), Any::from(1.5)].into()),
        );
    }
    let s = ProjectionIndex::new(&doc).read().unwrap();
    assert_eq!(ids(&s), ["a", "b"]);
    for n in s.visible {
        assert_eq!((&*n.parent, n.order), ("@root", 0));
    }
}
#[test]
fn split_cut_tracks_remote_text_and_only_changed_owners_are_reported() {
    let doc = policy::fixture();
    policy::layout::split(&doc, 3).unwrap();
    let index = ProjectionIndex::new(&doc);
    let before = index.read().unwrap();
    text(&doc, "block-1").insert(&mut doc.transact_mut(), 3, "X");
    let after = index.read().unwrap();
    assert_eq!(after.source_reads, 1);
    assert!(!after.structure_rebuilt);
    assert_eq!(after.changed_nodes, BTreeSet::from(["block-split".into()]));
    assert_eq!(
        content(
            after
                .visible
                .iter()
                .find(|n| n.id == "block-split")
                .unwrap()
        ),
        "Xb"
    );
    assert!(Arc::ptr_eq(&before.visible[0], &after.visible[0]));
    assert_policy(&doc, &index);
}
#[test]
fn joined_source_edit_updates_its_owner_without_changing_source_identity() {
    let doc = policy::fixture();
    policy::layout::join(&doc).unwrap();
    let index = ProjectionIndex::new(&doc);
    let before = index.read().unwrap();
    text(&doc, "block-2").insert(&mut doc.transact_mut(), 4, "!");
    let after = index.read().unwrap();
    assert_eq!(after.changed_nodes, BTreeSet::from(["block-1".into()]));
    assert_eq!(after.source_reads, 1);
    assert_eq!(content(&after.visible[0]), "a😀bcאבd!");
    assert_eq!(
        after.visible[0].spans[1].identity,
        before.visible[0].spans[1].identity
    );
    assert_policy(&doc, &index);
}
#[test]
fn composed_ownership_deletion_and_hierarchy_match_frozen_fixtures() {
    for mode in ["original", "split", "join"] {
        for deleted in [None, Some("block-1"), Some("block-2"), Some("block-split")] {
            let doc = policy::fixture();
            let index = ProjectionIndex::new(&doc);
            index.read().unwrap();
            if mode == "split" {
                policy::layout::split(&doc, 3).unwrap();
            }
            if mode == "join" {
                policy::layout::join(&doc).unwrap();
            }
            {
                let mut txn = doc.transact_mut();
                txn.get_map(ROOTS[2]).unwrap().insert(
                    &mut txn,
                    "block-2",
                    Any::Array(vec!["block-1".into(), 0u32.into()].into()),
                );
            }
            if let Some(id) = deleted {
                doc.get_or_insert_map(ROOTS[3])
                    .insert(&mut doc.transact_mut(), id, true);
            }
            assert_policy(&doc, &index);
            text(&doc, "block-1").insert(&mut doc.transact_mut(), 0, "z");
            assert_policy(&doc, &index);
        }
    }
}
#[test]
fn reordered_duplicate_real_updates_converge_in_incremental_snapshots() {
    let seed = policy::fixture();
    let bytes = seed
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let replica = |id| {
        let d = policy::hierarchy::registry::replica(id);
        for r in ROOTS {
            d.get_or_insert_map(r);
        }
        d.transact_mut()
            .apply_update(Update::decode_v1(&bytes).unwrap())
            .unwrap();
        d
    };
    let a = replica(21);
    let b = replica(22);
    let sv = a.transact().state_vector();
    text(&a, "block-1").insert(&mut a.transact_mut(), 0, "A");
    text(&b, "block-2").insert(&mut b.transact_mut(), 4, "B");
    let updates = [
        a.transact().encode_state_as_update_v1(&sv),
        b.transact().encode_state_as_update_v1(&sv),
    ];
    let mut expected = None;
    for schedule in [[0, 1, 0], [1, 0, 1]] {
        let d = replica(23);
        let index = ProjectionIndex::new(&d);
        index.read().unwrap();
        for i in schedule {
            d.transact_mut()
                .apply_update(Update::decode_v1(&updates[i]).unwrap())
                .unwrap();
        }
        let s = index.read().unwrap();
        assert_eq!(s.source_reads, 2);
        assert!(!s.structure_rebuilt);
        assert_eq!(
            s.changed_nodes,
            BTreeSet::from(["block-1".into(), "block-2".into()])
        );
        assert_policy(&d, &index);
        let result = s.visible.iter().map(|n| content(n)).collect::<Vec<_>>();
        if let Some(e) = &expected {
            assert_eq!(&result, e);
        } else {
            expected = Some(result);
        }
        d.transact_mut()
            .apply_update(Update::decode_v1(&updates[0]).unwrap())
            .unwrap();
        let duplicate = index.read().unwrap();
        assert_eq!(duplicate.source_reads, 0);
        assert!(duplicate.changed_nodes.is_empty());
    }
}
#[test]
fn malformed_ownership_returns_recovery_error_without_writes_and_can_retry_after_repair() {
    let doc = policy::fixture();
    let index = ProjectionIndex::new(&doc);
    let previous = index.read().unwrap();
    doc.get_or_insert_map(ROOTS[4]).insert(
        &mut doc.transact_mut(),
        "pair",
        Any::Array(vec!["split".into(), Any::Buffer(vec![255].into())].into()),
    );
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    assert_eq!(index.read().unwrap_err(), ProjectionError::InvalidOwnership);
    assert_eq!(
        bytes,
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    );
    doc.get_or_insert_map(ROOTS[4]).insert(
        &mut doc.transact_mut(),
        "pair",
        Any::Array(vec!["original".into()].into()),
    );
    let repaired = index.read().unwrap();
    assert!(repaired.changed_nodes.is_empty());
    assert!(Arc::ptr_eq(&previous.visible[0], &repaired.visible[0]));
}
#[test]
fn empty_and_hidden_source_spans_keep_recovery_identity_and_visible_children() {
    let doc = ordinary(&[("a", "list", "@root", 0, ""), ("b", "item", "a", 0, "B")]);
    let index = ProjectionIndex::new(&doc);
    let before = index.read().unwrap();
    doc.get_or_insert_map(ROOTS[3])
        .insert(&mut doc.transact_mut(), "a", true);
    let s = index.read().unwrap();
    assert_eq!(ids(&s), ["b"]);
    assert_eq!(s.visible[0].parent, "@root");
    assert_eq!(s.recovery[0].spans, before.visible[0].spans);
    assert_eq!(s.recovery[0].spans[0].end, 0);
    text(&doc, "a").insert(&mut doc.transact_mut(), 0, "offline");
    let s = index.read().unwrap();
    assert_eq!(content(&s.recovery[0]), "offline");
    assert_eq!(s.changed_nodes, BTreeSet::from(["a".into()]));
}
#[test]
fn replacing_registry_text_is_detected_as_identity_change() {
    let doc = ordinary(&[("a", "item", "@root", 0, "same")]);
    let index = ProjectionIndex::new(&doc);
    let before = index.read().unwrap();
    doc.get_or_insert_map(ROOTS[1]).insert(
        &mut doc.transact_mut(),
        "a",
        XmlTextPrelim::new("same"),
    );
    let s = index.read().unwrap();
    assert_eq!(s.source_reads, 1);
    assert_ne!(
        before.visible[0].spans[0].identity,
        s.visible[0].spans[0].identity
    );
    assert_eq!(s.changed_nodes, BTreeSet::from(["a".into()]));
}
#[test]
fn owned_document_snapshot_is_the_same_projection_after_checkpoint_restore() {
    let identity = DocumentIdentity::v1(
        "9b21e010-0000-4000-8000-000000000003",
        "9b21e010-0000-4000-8000-000000000004",
    )
    .unwrap();
    let doc = Document::create(
        CreationPermit::authorize_new(identity.clone()).unwrap(),
        &[InitialNode {
            kind: "opaque".into(),
            text: "😀x".into(),
        }],
    )
    .unwrap();
    let before = doc.snapshot().unwrap();
    let checkpoint = doc.checkpoint();
    let restored = Document::restore(&identity, &checkpoint, &[]).unwrap();
    let after = restored.snapshot().unwrap();
    assert_eq!(before.visible, after.visible);
    assert_eq!(after.source_reads, 1);
}
#[test]
fn disposing_an_index_leaves_other_indexes_and_document_available() {
    let doc = ordinary(&[("a", "item", "@root", 0, "A")]);
    let first = ProjectionIndex::new(&doc);
    let second = ProjectionIndex::new(&doc);
    first.read().unwrap();
    second.read().unwrap();
    drop(first);
    text(&doc, "a").insert(&mut doc.transact_mut(), 1, "B");
    assert_eq!(content(&second.read().unwrap().visible[0]), "AB");
}

#[test]
fn index_keeps_the_same_replica_alive_after_external_handle_drop() {
    let doc = ordinary(&[("a", "item", "@root", 0, "A")]);
    let index = ProjectionIndex::new(&doc);
    drop(doc);
    assert_eq!(content(&index.read().unwrap().visible[0]), "A");
    drop(index);
}
