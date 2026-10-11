//! FND-1.9 canonical real-Yrs hierarchy schedules; no provider/network calls.
#[path = "support/hierarchy.rs"]
mod policy;
use policy::{ROOT, registry};
use std::{collections::BTreeSet, fs};
use yrs::{Doc, Map, ReadTxn, Text, Transact};

fn writer(id: u64, base: &[u8]) -> Doc {
    let d = registry::replica(id);
    registry::apply(&d, base);
    d
}
fn permutations(n: usize) -> Vec<Vec<usize>> {
    fn visit(prefix: &mut Vec<usize>, rest: Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if rest.is_empty() {
            out.push(prefix.clone());
        }
        for i in 0..rest.len() {
            let mut next = rest.clone();
            prefix.push(next.remove(i));
            visit(prefix, next, out);
            prefix.pop();
        }
    }
    let mut out = vec![];
    visit(&mut vec![], (0..n).collect(), &mut out);
    out
}
fn assert_read_only(doc: &Doc) -> policy::Projection {
    let before = registry::full_update(doc);
    let sv = doc.transact().state_vector();
    let p = policy::project(doc);
    for _ in 0..8 {
        assert_eq!(p, policy::project(doc));
    }
    assert_eq!(sv, doc.transact().state_vector());
    assert_eq!(
        before,
        registry::full_update(doc),
        "projection wrote CRDT state"
    );
    assert_eq!(
        p.nodes.len(),
        p.traversal.iter().collect::<BTreeSet<_>>().len()
    );
    assert!(p.edge_visits <= p.nodes.len().pow(2));
    p
}
fn schedules(name: &str, base: &[u8], writers: &[Doc]) -> policy::Projection {
    let initial = writer(91, base);
    let originals = policy::project(&initial);
    let sv = initial.transact().state_vector();
    let mut updates = vec![base.to_vec()];
    updates.extend(
        writers
            .iter()
            .map(|d| d.transact().encode_state_as_update_v1(&sv)),
    );
    let mut merged = None;
    // Include initialization in every permutation, exercising buffered updates.
    for order in permutations(updates.len()) {
        for id in [101, 102, 103] {
            let d = registry::replica(id);
            for &i in &order {
                registry::apply(&d, &updates[i]);
                registry::apply(&d, &updates[i]);
            }
            for &i in order.iter().rev() {
                registry::apply(&d, &updates[i]);
            }
            let p = assert_read_only(&d);
            for (id, n) in &p.nodes {
                assert_eq!(n.identity, originals.nodes[id].identity);
                if name != "nested" || id != "d" {
                    assert_eq!(
                        n.runs, originals.nodes[id].runs,
                        "placement lost text/marks"
                    );
                }
            }
            if let Some(expected) = &merged {
                assert_eq!(&p, expected);
            }
            let restored = writer(201, &registry::full_update(&d));
            assert_eq!(p, assert_read_only(&restored));
            merged = Some(p);
        }
    }
    let p = merged.unwrap();
    for w in writers {
        for update in &updates {
            registry::apply(w, update);
        }
        assert_eq!(p, assert_read_only(w));
    }
    if let Some(dir) = std::env::var_os("EDITAC_HIERARCHY_OUTPUT") {
        fs::create_dir_all(&dir).unwrap();
        let dir = std::path::PathBuf::from(dir);
        fs::write(dir.join(format!("{name}.txt")), format!("{p:#?}\n")).unwrap();
        for (i, u) in updates.iter().enumerate() {
            fs::write(dir.join(format!("{name}-{i}.bin")), u).unwrap();
        }
    }
    p
}
fn base() -> Vec<u8> {
    registry::full_update(&policy::fixture())
}

#[test]
fn duplicate_placements_choose_one_atomic_tuple_with_both_writer_assignments() {
    let base = base();
    for (i, (left, right)) in [(21, 22), (22, 21)].into_iter().enumerate() {
        let a = writer(left, &base);
        let b = writer(right, &base);
        policy::move_node(&a, "d", "a", 7).unwrap();
        policy::move_node(&b, "d", "b", 9).unwrap();
        let p = schedules(&format!("duplicate-{i}"), &base, &[a, b]);
        assert_eq!(
            (&*p.nodes["d"].parent, p.nodes["d"].order),
            if left > right { ("a", 7) } else { ("b", 9) }
        );
        assert_eq!(p.traversal.iter().filter(|id| *id == "d").count(), 1);
        assert_eq!(
            p.nodes["d"].runs,
            vec![
                ("a".into(), vec![]),
                ("😀".into(), vec![("bold".into(), "true".into())]),
                ("b".into(), vec![])
            ]
        );
    }
}
#[test]
fn concurrent_valid_moves_create_cycle_cut_without_repair_writes() {
    let base = base();
    let a = writer(21, &base);
    let b = writer(22, &base);
    // Each move is legal in its disconnected writer; together they form a cycle.
    policy::move_node(&a, "a", "b", 0).unwrap();
    policy::move_node(&b, "b", "a", 0).unwrap();
    let p = schedules("cycle", &base, &[a, b]);
    assert_eq!(
        (&*p.nodes["a"].parent, p.nodes["a"].reason.as_deref()),
        (ROOT, Some("cycle-cut"))
    );
    assert_eq!(p.nodes["b"].parent, "a");
    assert_eq!(p.traversal, ["a", "b", "e", "c", "d"]);
}
#[test]
fn self_cycle_orphans_invalid_parent_and_missing_placement_preserve_content() {
    let base = base();
    let a = writer(21, &base);
    let b = writer(22, &base);
    policy::raw_place(&a, "a", "a", 3);
    policy::raw_place(&a, "d", "missing", 0);
    policy::raw_place(&b, "e", "d", 0);
    let map = b.get_or_insert_map("registry-placements");
    map.remove(&mut b.transact_mut_with("fixture:remove"), "c");
    let p = schedules("orphans", &base, &[a, b]);
    for id in ["a", "c", "d", "e"] {
        assert_eq!(p.nodes[id].parent, ROOT);
    }
    assert_eq!(p.nodes["a"].reason.as_deref(), Some("cycle-cut"));
    assert_eq!(
        p.nodes["c"].reason.as_deref(),
        Some("invalid-or-missing-placement")
    );
    for id in ["d", "e"] {
        assert_eq!(
            p.nodes[id].reason.as_deref(),
            Some("orphan-or-invalid-parent")
        );
    }
}
#[test]
fn nested_list_moves_retain_subtree_and_concurrent_marked_edit() {
    let base = base();
    let a = writer(21, &base);
    let b = writer(22, &base);
    let c = writer(23, &base);
    policy::move_node(&a, "c", "b", 2).unwrap();
    policy::move_node(&b, "e", "c", 1).unwrap();
    let texts = c.get_or_insert_map("registry-texts");
    let Some(yrs::Out::YXmlText(t)) = texts.get(&c.transact(), "d") else {
        panic!("text")
    };
    t.insert_with_attributes(
        &mut c.transact_mut_with("fixture:edit"),
        3,
        "!",
        std::collections::HashMap::from([("italic".into(), yrs::Any::Bool(true))]),
    );
    let p = schedules("nested", &base, &[a, b, c]);
    assert_eq!(p.traversal, ["a", "b", "c", "d", "e"]);
    assert_eq!(p.nodes["c"].parent, "b");
    assert_eq!(p.nodes["d"].parent, "c");
    assert_eq!(p.nodes["e"].parent, "c");
    assert_eq!(
        p.nodes["d"].runs,
        vec![
            ("a".into(), vec![]),
            ("😀".into(), vec![("bold".into(), "true".into())]),
            ("!".into(), vec![("italic".into(), "true".into())]),
            ("b".into(), vec![])
        ]
    );
}
#[test]
fn invalid_local_moves_reject_before_mutation_and_order_ties_use_stable_ids() {
    let d = policy::fixture();
    for (id, parent) in [
        ("a", "c"),
        ("c", "c"),
        ("a", "d"),
        ("d", "absent"),
        ("absent", "a"),
    ] {
        let bytes = registry::full_update(&d);
        assert!(policy::move_node(&d, id, parent, 0).is_err());
        assert_eq!(bytes, registry::full_update(&d));
    }
    policy::move_node(&d, "c", ROOT, 0).unwrap();
    policy::move_node(&d, "b", ROOT, 0).unwrap();
    let p = assert_read_only(&d);
    assert_eq!(p.traversal, ["a", "b", "e", "c", "d"]);
}
#[test]
fn deep_remote_hierarchy_is_iterative_and_bounded() {
    let d = policy::fixture();
    let nodes = d.get_or_insert_map("registry-parents");
    let texts = d.get_or_insert_map("registry-texts");
    let placements = d.get_or_insert_map("registry-placements");
    {
        let mut txn = d.transact_mut_with("fixture:deep");
        for i in 0..512 {
            let id = format!("deep-{i:04}");
            let parent = if i == 0 {
                ROOT.into()
            } else {
                format!("deep-{:04}", i - 1)
            };
            nodes.insert(&mut txn, id.clone(), "list");
            texts.insert(&mut txn, id.clone(), yrs::XmlTextPrelim::new("x"));
            placements.insert(&mut txn, id, registry::placement(&parent, 0));
        }
    }
    let p = assert_read_only(&d);
    assert_eq!(p.nodes.len(), 517);
    assert_eq!(p.traversal.len(), 517);
}

#[test]
fn late_parent_arrival_resolves_orphan_without_persisting_a_repair() {
    let base = base();
    let a = writer(21, &base);
    let b = writer(22, &base);
    policy::raw_place(&a, "d", "late", 2);
    let orphan = assert_read_only(&a);
    assert_eq!(orphan.nodes["d"].parent, ROOT);
    assert_eq!(
        orphan.nodes["d"].reason.as_deref(),
        Some("orphan-or-invalid-parent")
    );
    {
        let nodes = b.get_or_insert_map("registry-parents");
        let texts = b.get_or_insert_map("registry-texts");
        let placements = b.get_or_insert_map("registry-placements");
        let mut txn = b.transact_mut_with("fixture:late-parent");
        nodes.insert(&mut txn, "late", "list");
        texts.insert(&mut txn, "late", yrs::XmlTextPrelim::new("later"));
        placements.insert(&mut txn, "late", registry::placement(ROOT, 2));
    }
    // This parent is new, so retain its identity from its actual writer in the base
    // identity oracle; the schedules themselves still start from the old base.
    let sv = writer(91, &base).transact().state_vector();
    let updates = [
        base.clone(),
        a.transact().encode_state_as_update_v1(&sv),
        b.transact().encode_state_as_update_v1(&sv),
    ];
    let late_identity = policy::project(&b).nodes["late"].identity.clone();
    let mut expected = None;
    for order in permutations(3) {
        for id in [101, 102, 103] {
            let d = registry::replica(id);
            for &i in &order {
                registry::apply(&d, &updates[i]);
                registry::apply(&d, &updates[i]);
            }
            for &i in order.iter().rev() {
                registry::apply(&d, &updates[i]);
            }
            let p = assert_read_only(&d);
            assert_eq!(p.nodes["d"].parent, "late");
            assert_eq!(p.nodes["d"].reason, None);
            assert_eq!(p.nodes["late"].identity, late_identity);
            for (id, n) in &orphan.nodes {
                assert_eq!(p.nodes[id].identity, n.identity);
                assert_eq!(p.nodes[id].runs, n.runs);
            }
            let restored = writer(201, &registry::full_update(&d));
            assert_eq!(p, assert_read_only(&restored));
            if let Some(e) = &expected {
                assert_eq!(&p, e);
            }
            expected = Some(p);
        }
    }
    if let Some(dir) = std::env::var_os("EDITAC_HIERARCHY_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("late-parent.txt"),
            format!("{:#?}\n", expected.unwrap()),
        )
        .unwrap();
        for (i, u) in updates.iter().enumerate() {
            fs::write(dir.join(format!("late-parent-{i}.bin")), u).unwrap();
        }
    }
}
