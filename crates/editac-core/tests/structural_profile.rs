//! ENG-1.19 disposable v4 qualification; not production v4 support.
#[path = "../../../fixtures/schema-v4/mapping.rs"]
mod m;
use m::*;
use std::{fs, path::PathBuf, process::Command, sync::Arc};
use yrs::updates::encoder::Encode;
use yrs::{Any, Array, Assoc, IndexedSequence, Map, ReadTxn, Text, Transact, XmlTextPrelim};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const L: &str = "c:11:1";
const Q: &str = "c:11:2";
const K: &str = "c:11:3";
const U: &str = "c:11:4";
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn node(d: &yrs::Doc, key: &str) -> Any {
    let Any::Map(s) = snapshot(d).unwrap() else {
        panic!()
    };
    let Any::Array(v) = &s["visible"] else {
        panic!()
    };
    v.iter()
        .find(|n| matches!(n,Any::Map(n) if n["id"] == Any::from(key)))
        .unwrap()
        .clone()
}
fn field(d: &yrs::Doc, key: &str, name: &str) -> Any {
    let Any::Map(n) = node(d, key) else { panic!() };
    n[name].clone()
}
fn outcome(d: &yrs::Doc, key: &str) -> String {
    project(d).unwrap().outcomes[key].clone()
}
fn checked(value: bool) -> Any {
    arr(vec![Any::from("check"), Any::Bool(value)])
}
fn control(d: &yrs::Doc, key: &str, value: bool) {
    set(d, 9, key, arr(vec![Any::from("enabled"), Any::Bool(value)]));
}
fn rejected(d: &yrs::Doc, remote: &yrs::Doc, error: &str) {
    let b = bytes(d);
    let sv = d.transact().state_vector();
    let s = snapshot(d).unwrap();
    assert_eq!(admit(d, &envelope(), &bytes(remote)), Err(error));
    assert_eq!(bytes(d), b);
    assert_eq!(d.transact().state_vector(), sv);
    assert_eq!(snapshot(d).unwrap(), s);
}
fn initial(d: &yrs::Doc, key: &str, parent: &str, order: u32) {
    set(d, 2, key, arr(vec![Any::from(parent), Any::from(order)]));
}
fn chain(d: &yrs::Doc, writer: u32) {
    let op = |n| format!("o:{writer}:{n}");
    split(d, &op(1), C, 0, 1).unwrap();
    join(d, &op(2), C, &op(1)).unwrap();
    join(d, &op(3), C, D).unwrap();
    split(d, &op(4), C, 2, 0).unwrap();
    place(d, &op(5), &op(4), L, Some(A)).unwrap();
    place(d, &op(6), Q, "@root", None).unwrap();
    control(d, &op(6), false);
    control(d, &op(6), true);
}
#[test]
fn exact_ten_root_seed_nested_numbering_check_and_source_identities() {
    let d = seed();
    let v = project(&d).unwrap();
    assert_eq!(
        v.owners.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
        [L, A, B, Q, K, C, D, U]
    );
    assert_eq!(d.transact().root_refs().count(), 10);
    assert_eq!(v.sources.len(), 4);
    assert_eq!(field(&d, A, "number"), Any::from(7u32));
    assert_eq!(field(&d, B, "number"), Any::from(8u32));
    assert_eq!(field(&d, C, "check"), Any::Bool(true));
    assert_eq!(field(&d, D, "check"), Any::Bool(false));
    assert_eq!(field(&d, Q, "number"), Any::Null);
    assert!(
        v.owners
            .iter()
            .filter(|o| o.id.starts_with("c:"))
            .all(|o| o.spans.is_empty())
    );
    let before = bytes(&d);
    snapshot(&d).unwrap();
    assert_eq!(bytes(&d), before);
}
#[test]
fn atomic_modes_starts_checks_and_dormant_outside_checklist() {
    let d = seed();
    set(&d, 7, L, arr(vec![Any::from("unordered")]));
    assert_eq!(field(&d, A, "number"), Any::Null);
    set(
        &d,
        7,
        K,
        arr(vec![Any::from("ordered"), Any::from(2147483647u32)]),
    );
    assert_eq!(field(&d, C, "check"), Any::Null);
    assert_eq!(field(&d, C, "number"), Any::from(2147483647u32));
    set(&d, 7, K, arr(vec![Any::from("checklist")]));
    assert_eq!(field(&d, C, "check"), Any::Bool(true));
    place(&d, "o:21:1", C, L, None).unwrap();
    assert_eq!(field(&d, C, "check"), Any::Null);
    place(&d, "o:21:2", C, K, None).unwrap();
    assert_eq!(field(&d, C, "check"), Any::Bool(true));
}
#[test]
fn checked_split_defaults_unchecked_with_live_block_inheritance_override_and_absorption() {
    let d = seed();
    split(&d, "o:21:1", C, 0, 1).unwrap();
    assert_eq!(field(&d, C, "check"), Any::Bool(true));
    assert_eq!(field(&d, "o:21:1", "check"), Any::Bool(false));
    set(&d, 4, C, arr(vec![Any::from("heading"), Any::from(2u32)]));
    assert_eq!(field(&d, "o:21:1", "tuple"), field(&d, C, "tuple"));
    set(
        &d,
        4,
        "o:21:1",
        arr(vec![Any::from("heading"), Any::from(4u32)]),
    );
    set(&d, 8, "o:21:1", checked(true));
    join(&d, "o:21:2", C, "o:21:1").unwrap();
    assert_eq!(
        field(&d, C, "tuple"),
        arr(vec![Any::from("heading"), Any::from(2u32)])
    );
    let Any::Map(s) = snapshot(&d).unwrap() else {
        panic!()
    };
    let Any::Map(r) = &s["retained"] else {
        panic!()
    };
    assert!(r.contains_key("o:21:1"));
}
#[test]
fn endpoints_empty_join_split_after_join_across_sources_and_stable_marks_anchors() {
    for (source, offset) in [(A, 0), (A, 1), (A, 4), (D, 0)] {
        let d = seed();
        let identities = project(&d).unwrap().sources;
        split(&d, "o:21:1", source, 0, offset).unwrap();
        join(&d, "o:21:2", source, "o:21:1").unwrap();
        assert_eq!(project(&d).unwrap().sources, identities);
    }
    let d = seed();
    let anchor = text(&d, C)
        .sticky_index(&d.transact(), 1, Assoc::After)
        .unwrap()
        .encode_v1();
    chain(&d, 21);
    assert_eq!(resolve(&d, C, &anchor).unwrap(), (C.into(), 1, false));
    assert_eq!(field(&d, "o:21:4", "parent"), Any::from(L));
    assert_eq!(field(&d, "o:21:4", "number"), Any::from(7u32));
    assert_eq!(field(&d, A, "number"), Any::from(8u32));
    let sources = project(&d).unwrap().sources;
    assert_eq!(sources, project(&seed()).unwrap().sources);
}
#[test]
fn place_before_append_container_subtree_and_versions_preserve_original_text() {
    let d = seed();
    let sources = project(&d).unwrap().sources;
    place(&d, "o:21:1", B, L, Some(A)).unwrap();
    assert_eq!(field(&d, B, "number"), Any::from(7u32));
    place(&d, "o:21:2", Q, "@root", None).unwrap();
    assert_eq!(field(&d, Q, "parent"), Any::from("@root"));
    assert_eq!(field(&d, K, "parent"), Any::from(Q));
    assert_eq!(field(&d, C, "parent"), Any::from(K));
    assert_eq!(field(&d, C, "version"), Any::from("base"));
    assert_eq!(project(&d).unwrap().sources, sources);
}
#[test]
fn local_cycle_invalid_before_illegal_parent_and_reused_id_are_atomic() {
    let d = seed();
    let b = bytes(&d);
    assert_eq!(place(&d, "o:21:1", L, K, None), Err("cycle"));
    assert_eq!(bytes(&d), b);
    assert_eq!(place(&d, "o:21:1", A, B, None), Err("illegal-parent"));
    assert_eq!(bytes(&d), b);
    assert_eq!(place(&d, "o:21:1", A, L, Some(A)), Err("invalid-before"));
    assert_eq!(bytes(&d), b);
    assert_eq!(join(&d, "o:21:1", A, C), Err("nonadjacent-target"));
    assert_eq!(bytes(&d), b);
    place(&d, "o:21:1", B, L, Some(A)).unwrap();
    let b = bytes(&d);
    assert_eq!(place(&d, "o:21:1", B, L, None), Err("reused-id"));
    assert_eq!(bytes(&d), b);
}
#[test]
fn initial_cycle_detaches_smallest_canonical_id_without_repair_writes() {
    let d = seed();
    initial(&d, L, Q, 0);
    initial(&d, Q, L, 0);
    let b = bytes(&d);
    assert_eq!(field(&d, L, "parent"), Any::from("@root"));
    assert_eq!(field(&d, Q, "parent"), Any::from(L));
    assert_eq!(bytes(&d), b);
}
#[test]
fn missing_unknown_noncontainer_parents_project_root_raw_intent_retained() {
    for parent in ["c:99:1", A] {
        let d = seed();
        initial(&d, B, parent, 1);
        assert_eq!(field(&d, B, "parent"), Any::from("@root"));
        assert_eq!(
            values_for(&d, 2)[B],
            arr(vec![Any::from(parent), Any::from(1u32)])
        );
    }
    let d = seed();
    set(&d, 0, Q, Any::from("ext:opaque-container"));
    set(&d, 7, Q, arr(vec![Any::from("ext:container"), Any::Null]));
    assert_eq!(field(&d, K, "parent"), Any::from("@root"));
    assert_eq!(place(&d, "o:21:1", Q, L, None), Err("unsupported-target"));
}
fn values_for(d: &yrs::Doc, root: usize) -> std::collections::BTreeMap<String, Any> {
    let t = d.transact();
    t.get_map(ROOTS[root])
        .unwrap()
        .iter(&t)
        .map(|(k, v)| {
            let yrs::Out::Any(v) = v else { panic!() };
            (k.into(), v)
        })
        .collect()
}
#[test]
fn hidden_parent_tombstone_and_disable_keep_descendants_and_edited_recovery() {
    for tombstone in [false, true] {
        let d = seed();
        if tombstone {
            set(&d, 3, Q, Any::Bool(true));
        } else {
            control(&d, Q, false);
        }
        assert_eq!(field(&d, K, "parent"), Any::from("@root"));
        assert_eq!(field(&d, C, "parent"), Any::from(K));
        control(&d, Q, true);
        if tombstone {
            assert!(
                project(&d)
                    .unwrap()
                    .owners
                    .iter()
                    .find(|o| o.id == Q)
                    .unwrap()
                    .deleted
            );
        } else {
            assert_eq!(field(&d, K, "parent"), Any::from(Q));
        }
    }
    let d = seed();
    let anchor = text(&d, A)
        .sticky_index(&d.transact(), 1, Assoc::After)
        .unwrap()
        .encode_v1();
    control(&d, A, false);
    text(&d, A).insert(&mut d.transact_mut_with("remote:edit"), 0, "R");
    assert!(resolve(&d, A, &anchor).unwrap().2);
    control(&d, A, true);
    assert_eq!(resolve(&d, A, &anchor).unwrap(), (A.into(), 2, false));
    assert_eq!(project(&d).unwrap().sources.len(), 4);
}
#[test]
fn operation_controls_disable_dependents_reenable_and_permanent_tombstones_win() {
    let d = seed();
    split(&d, "o:21:1", A, 0, 1).unwrap();
    join(&d, "o:21:2", A, "o:21:1").unwrap();
    let full = snapshot(&d).unwrap();
    control(&d, "o:21:1", false);
    assert_eq!(outcome(&d, "o:21:1"), "disabled");
    assert_eq!(outcome(&d, "o:21:2"), "losing");
    control(&d, "o:21:1", true);
    let mut expected = full;
    let Any::Map(ref mut s) = expected else {
        panic!()
    };
    let map = Arc::make_mut(s);
    map.insert("controls".into(), snapshot_field(&d, "controls"));
    assert_eq!(snapshot(&d).unwrap(), expected);
    set(&d, 3, A, Any::Bool(true));
    control(&d, A, true);
    assert!(
        project(&d)
            .unwrap()
            .owners
            .iter()
            .find(|o| o.id == A)
            .unwrap()
            .deleted
    );
    control(&d, "o:99:9", false);
    assert!(project(&d).is_ok());
}
fn snapshot_field(d: &yrs::Doc, k: &str) -> Any {
    let Any::Map(s) = snapshot(d).unwrap() else {
        panic!()
    };
    s[k].clone()
}
fn race_updates(kind: &str) -> (yrs::Doc, Vec<Vec<u8>>) {
    let base = seed();
    let sv = base.transact().state_vector();
    let mut updates = vec![];
    for client in [21u32, 22, 23] {
        let d = fork(&base, client as u64);
        match (kind, client) {
            ("move", 21) => place(&d, "o:21:1", A, K, Some(C)).unwrap(),
            ("move", 22) => place(&d, "o:22:1", A, "@root", None).unwrap(),
            ("cycle", 21) => place(&d, "o:21:1", Q, "@root", None).unwrap(),
            ("cycle", 22) => {
                initial(&d, Q, "@root", 0);
                place(&d, "o:22:1", L, Q, None).unwrap();
            }
            ("control", 21) => control(&d, L, false),
            ("control", 22) => control(&d, L, true),
            _ => {
                text(&d, A).insert(&mut d.transact_mut(), 0, "R");
                set(&d, 7, L, arr(vec![Any::from("ordered"), Any::from(42u32)]));
            }
        }
        updates.push(d.transact().encode_state_as_update_v1(&sv));
    }
    (base, updates)
}
fn permutations(base: &yrs::Doc, updates: &[Vec<u8>]) -> Any {
    let before = bytes(base);
    let mut expected = None;
    for order in PERMS {
        let d = fork(base, 51);
        for i in order.into_iter().chain(order) {
            apply(&d, &updates[i]).unwrap();
        }
        let s = snapshot(&d).unwrap();
        if let Some(e) = &expected {
            assert_eq!(&s, e);
        } else {
            expected = Some(s.clone());
        }
        let cp = restore_checkpoint(&envelope(), true, &bytes(&d), 52).unwrap();
        assert_eq!(snapshot(&cp).unwrap(), s);
    }
    assert_eq!(bytes(base), before);
    expected.unwrap()
}
#[test]
fn concurrent_move_move_edit_all_six_duplicate_orders_restore_and_ranked_loser() {
    let (base, updates) = race_updates("move");
    let s = permutations(&base, &updates);
    let Any::Map(s) = s else { panic!() };
    let Any::Map(o) = &s["outcomes"] else {
        panic!()
    };
    assert_eq!(o["o:21:1"], Any::from("applied"));
    assert_eq!(o["o:22:1"], Any::from("losing"));
}
#[test]
fn concurrent_potential_cycle_choices_are_deterministic_without_repair() {
    let base = seed();

    let sv = base.transact().state_vector();
    let a = fork(&base, 21);
    let b = fork(&base, 22);
    let c = fork(&base, 23);
    place(&a, "o:21:1", L, U, None).unwrap();
    place(&b, "o:22:1", U, L, None).unwrap();
    text(&c, C).insert(&mut c.transact_mut(), 0, "R");
    let updates = [a, b, c].map(|d| d.transact().encode_state_as_update_v1(&sv));
    let s = permutations(&base, &updates);
    let Any::Map(s) = s else { panic!() };
    let Any::Map(o) = &s["outcomes"] else {
        panic!()
    };
    assert_eq!(o["o:21:1"], Any::from("applied"));
    assert_eq!(o["o:22:1"], Any::from("losing"));
}
#[test]
fn concurrent_controls_use_atomic_map_conflict_and_restore_remote_edits() {
    let (base, updates) = race_updates("control");
    permutations(&base, &updates);
}
#[test]
fn stale_parent_before_target_and_missing_versions_keep_intentions_dormant_or_losing() {
    let d = seed();
    place(&d, "o:21:1", Q, "@root", None).unwrap();
    set(
        &d,
        5,
        "o:22:1",
        arr(vec![
            Any::from("place"),
            Any::from(A),
            Any::from("base"),
            Any::from(Q),
            Any::from("base"),
            Any::Null,
            Any::Null,
        ]),
    );
    assert_eq!(outcome(&d, "o:22:1"), "losing");
    set(
        &d,
        5,
        "o:23:1",
        arr(vec![
            Any::from("place"),
            Any::from(B),
            Any::from("o:99:1"),
            Any::from(L),
            Any::from("base"),
            Any::Null,
            Any::Null,
        ]),
    );
    assert_eq!(outcome(&d, "o:23:1"), "dormant");
    let d = seed();
    place(&d, "o:21:1", B, L, None).unwrap();
    set(
        &d,
        5,
        "o:22:1",
        arr(vec![
            Any::from("place"),
            Any::from(A),
            Any::from("base"),
            Any::from(L),
            Any::from("base"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    assert_eq!(outcome(&d, "o:22:1"), "losing");
}
#[test]
fn unknown_tuples_marks_kinds_and_dormant_controls_are_retained_not_executed() {
    let d = seed();
    set(
        &d,
        4,
        A,
        arr(vec![
            Any::from("ext:future"),
            obj(vec![("data", Any::Null)]),
        ]),
    );
    set(&d, 0, B, Any::from("ext:unknown-source"));
    control(&d, "c:99:1", false);
    assert_eq!(
        field(&d, A, "presentation"),
        arr(vec![Any::from("paragraph")])
    );
    assert_eq!(split(&d, "o:21:1", A, 0, 1), Err("ineligible-operation"));
    assert_eq!(place(&d, "o:21:1", B, L, None), Err("unsupported-target"));
    assert!(matches!(field(&d,B,"runs"),Any::Array(v) if !v.is_empty()));
    let r = restore_checkpoint(&envelope(), true, &bytes(&d), 51).unwrap();
    assert_eq!(snapshot(&r).unwrap(), snapshot(&d).unwrap());
}
#[test]
fn malformed_container_check_control_and_block_tuples_reject_without_partial_mutation() {
    for (root, key, tuple) in [
        (7, L, arr(vec![Any::from("ordered"), Any::from(0u32)])),
        (
            7,
            L,
            arr(vec![Any::from("ordered"), Any::from(2147483648u32)]),
        ),
        (7, L, arr(vec![Any::from("unordered"), Any::Null])),
        (7, L, arr(vec![Any::from("paragraph")])),
        (8, C, arr(vec![Any::from("check"), Any::from(1u32)])),
        (9, Q, arr(vec![Any::from("enabled")])),
        (4, A, arr(vec![Any::from("heading"), Any::from(7u32)])),
        (
            4,
            A,
            arr(vec![Any::from("code"), Any::from("bad language")]),
        ),
        (4, A, arr(vec![Any::from("separator"), Any::Null])),
    ] {
        let d = seed();
        let r = fork(&d, 31);
        set(&r, root, key, tuple);
        text(&r, B).insert(&mut r.transact_mut(), 0, "must-not-leak");
        rejected(&d, &r, "invalid-tuple");
    }
}
#[test]
fn immutable_kinds_initial_placement_operations_origins_text_and_tombstones_are_not_replaceable() {
    for root in [0, 2, 5, 6, 3] {
        let d = seed();
        split(&d, "o:21:1", A, 0, 1).unwrap();
        set(&d, 3, D, Any::Bool(true));
        let r = fork(&d, 31);
        match root {
            0 => set(&r, 0, L, Any::from("ext:opaque")),
            2 => initial(&r, A, "@root", 9),
            5 => set(
                &r,
                5,
                "o:21:1",
                arr(vec![
                    Any::from("join"),
                    Any::from(A),
                    Any::from("base"),
                    Any::from(B),
                    Any::from("base"),
                ]),
            ),
            6 => {
                let mut t = r.transact_mut();
                t.get_map(ROOTS[6]).unwrap().remove(&mut t, A);
            }
            _ => {
                let mut t = r.transact_mut();
                t.get_map(ROOTS[3]).unwrap().remove(&mut t, D);
            }
        }
        let before = bytes(&d);
        assert!(admit(&d, &envelope(), &bytes(&r)).is_err());
        assert_eq!(bytes(&d), before);
    }
    let d = seed();
    let r = fork(&d, 31);
    {
        let mut t = r.transact_mut();
        t.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut t, A, XmlTextPrelim::new("copy"));
    }
    rejected(&d, &r, "immutable-replacement");
}
#[test]
fn exact_profile_epoch_document_initialized_and_binary_dependency_admission() {
    let d = seed();
    for (key, error) in [
        ("profile", "unsupported-profile"),
        ("schema", "unsupported-profile"),
        ("epoch", "wrong-epoch"),
        ("documentId", "wrong-document"),
    ] {
        let Any::Map(mut e) = envelope() else {
            panic!()
        };
        Arc::make_mut(&mut e).insert(key.into(), Any::from("wrong"));
        let before = bytes(&d);
        assert_eq!(admit(&d, &Any::Map(e), &bytes(&d)), Err(error));
        assert_eq!(bytes(&d), before);
    }
    assert!(matches!(
        restore_checkpoint(&envelope(), false, &bytes(&d), 51),
        Err("missing-initializer")
    ));
    assert!(matches!(
        restore_checkpoint(&envelope(), true, &bytes(&d), 0),
        Err("invalid-writer")
    ));
    let empty = replica(11);
    assert!(
        project(&restore_checkpoint(&envelope(), true, &bytes(&empty), 51).unwrap())
            .unwrap()
            .owners
            .is_empty()
    );
    let r = fork(&d, 31);
    let sv = r.transact().state_vector();
    text(&r, A).insert(&mut r.transact_mut(), 0, "X");
    let first = r.transact().encode_state_as_update_v1(&sv);
    let sv = r.transact().state_vector();
    text(&r, A).insert(&mut r.transact_mut(), 1, "Y");
    let second = r.transact().encode_state_as_update_v1(&sv);
    let before = bytes(&d);
    assert_eq!(
        admit(&d, &envelope(), &second),
        Err("missing-binary-dependency")
    );
    assert_eq!(bytes(&d), before);
    admit(&d, &envelope(), &first).unwrap();
    admit(&d, &envelope(), &second).unwrap();
    assert_eq!(snapshot(&d).unwrap(), snapshot(&r).unwrap());
}
#[test]
fn roots_types_container_text_origin_membership_and_id_shapes_reject() {
    for case in 0..6 {
        let d = seed();
        let r = fork(&d, 31);
        match case {
            0 => {
                r.get_or_insert_map("invented")
                    .insert(&mut r.transact_mut(), "payload", true);
            }
            1 => {
                r.get_or_insert_array(ROOTS[9])
                    .insert(&mut r.transact_mut(), 0, "wrong");
            }
            2 => {
                set(&r, 6, L, Any::Bool(true));
            }
            3 => {
                let mut t = r.transact_mut();
                t.get_map(ROOTS[1])
                    .unwrap()
                    .insert(&mut t, L, XmlTextPrelim::new("wrong"));
            }
            4 => set(&r, 0, "c:01:1", Any::from("list")),
            _ => set(&r, 7, Q, arr(vec![Any::from("checklist")])),
        }
        let before = bytes(&d);
        assert!(admit(&d, &envelope(), &bytes(&r)).is_err(), "case {case}");
        assert_eq!(bytes(&d), before);
    }
}
#[test]
fn hierarchy_depth_128_passes_129_and_descendant_move_exhaustion_reject_atomically() {
    let d = seed();
    let mut parent = "@root".to_string();
    for n in 1..=129 {
        let key = format!("c:31:{n}");
        set(&d, 0, &key, Any::from("quote"));
        initial(&d, &key, &parent, n);
        set(&d, 7, &key, arr(vec![Any::from("quote")]));
        parent = key;
    }
    assert!(project(&d).is_ok());
    let b = bytes(&d);
    assert_eq!(place(&d, "o:21:1", Q, &parent, None), Err("resource-limit"));
    assert_eq!(bytes(&d), b);
    let r = fork(&d, 32);
    set(&r, 0, "c:31:130", Any::from("quote"));
    initial(&r, "c:31:130", &parent, 130);
    set(&r, 7, "c:31:130", arr(vec![Any::from("quote")]));
    rejected(&d, &r, "resource-limit");
}
#[test]
fn controls_nodes_operations_text_bytes_and_bounded_binary_values_reject_atomically() {
    for case in 0..7 {
        let d = seed();
        let r = fork(&d, 31);
        match case {
            0 => {
                for n in 1..=8193 {
                    control(&r, &format!("o:31:{n}"), false)
                }
            }
            1 => {
                for n in 1..=4097 {
                    set(&r, 0, &format!("c:31:{n}"), Any::from("quote"))
                }
            }
            2 => {
                for n in 1..=4097 {
                    set(
                        &r,
                        5,
                        &format!("o:31:{n}"),
                        arr(vec![
                            Any::from("join"),
                            Any::from(A),
                            Any::from("o:99:1"),
                            Any::from(B),
                            Any::from("base"),
                        ]),
                    )
                }
            }
            3 => text(&r, A).insert(&mut r.transact_mut(), 0, &"x".repeat(262145)),
            4 => {
                let mut v = Any::Null;
                for _ in 0..40 {
                    v = arr(vec![v]);
                }
                set(&r, 4, A, arr(vec![Any::from("ext:deep"), v]));
            }
            5 => set(
                &r,
                4,
                A,
                arr(vec![Any::from("ext:wide"), arr(vec![Any::Null; 8193])]),
            ),
            _ => set(
                &r,
                5,
                "o:31:1",
                arr(vec![
                    Any::from("split"),
                    Any::from(A),
                    Any::from("base"),
                    Any::from(0u32),
                    Any::from(A),
                    Any::Buffer(vec![0; 257].into()),
                ]),
            ),
        }
        rejected(&d, &r, "resource-limit");
    }
    let d = seed();
    let before = bytes(&d);
    assert_eq!(
        admit(&d, &envelope(), &vec![0; 16777217]),
        Err("resource-limit")
    );
    assert_eq!(bytes(&d), before);
    assert!(admit(&d, &envelope(), &[255, 255, 255, 255, 7]).is_err());
    assert_eq!(bytes(&d), before);
}
#[test]
fn dependency_cycles_and_dormant_graph_depth_are_bounded() {
    let d = seed();
    for (n, dep) in [(1, 2), (2, 1)] {
        set(
            &d,
            5,
            &format!("o:31:{n}"),
            arr(vec![
                Any::from("place"),
                Any::from(A),
                Any::from(format!("o:31:{dep}")),
                Any::from(L),
                Any::from("base"),
                Any::Null,
                Any::Null,
            ]),
        );
    }
    assert_eq!(project(&d), Err("cycle"));
    let d = seed();
    let mut dep = "o:99:1".to_owned();
    for n in 1..=129 {
        let key = format!("o:31:{n}");
        set(
            &d,
            5,
            &key,
            arr(vec![
                Any::from("place"),
                Any::from(A),
                Any::from(dep),
                Any::from(L),
                Any::from("base"),
                Any::Null,
                Any::Null,
            ]),
        );
        dep = key;
    }
    assert_eq!(project(&d), Err("resource-limit"));
}
#[test]
fn editor_hierarchy_validator_accepts_quote_block_and_checks_whole_descendant_depth_batch() {
    use editac_core::{
        commands::lists::{
            HierarchyError, ParentChange, validate_editor_hierarchy, validate_hierarchy,
        },
        projection::{ProjectedNode, Snapshot},
    };
    let mk = |id: &str, kind: &str, parent: &str| {
        Arc::new(ProjectedNode {
            id: id.into(),
            kind: kind.into(),
            parent: parent.into(),
            order: 0,
            spans: vec![],
            runs: vec![],
            block_attributes: None,
            editor: None,
        })
    };
    let s = Snapshot {
        visible: vec![mk(L, "list", "@root"), mk(Q, "quote", L), mk(A, "block", Q)],
        ..Snapshot::default()
    };
    let change = |node: &str, parent: &str| ParentChange {
        node: node.into(),
        parent: parent.into(),
    };
    assert_eq!(validate_editor_hierarchy(&s, &[change(A, L)]), Ok(()));
    assert_eq!(
        validate_editor_hierarchy(&s, &[change(L, Q)]),
        Err(HierarchyError::Cycle(L.into()))
    );
    assert!(validate_hierarchy(&s, &[]).is_err());
    let mut s = Snapshot::default();
    for n in 0..=128 {
        let parent = if n == 0 {
            "@root".to_owned()
        } else {
            format!("c:31:{n}")
        };
        s.visible
            .push(mk(&format!("c:31:{}", n + 1), "quote", &parent));
    }
    assert!(validate_editor_hierarchy(&s, &[]).is_ok());
    s.visible.push(mk("n:31:1", "block", "c:31:129"));
    assert!(matches!(
        validate_editor_hierarchy(&s, &[]),
        Err(HierarchyError::DepthLimit(_))
    ));
}
#[test]
fn pinned_bidirectional_structural_exchange_replay_restore_and_anchors() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::var_os("EDITAC_STRUCTURAL_EXCHANGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join("../architecture/evidence/engine-structural-profile/exchange")
        });
    fs::create_dir_all(&dir).unwrap();
    let d = seed();
    fs::write(dir.join("rust-seed.bin"), bytes(&d)).unwrap();
    fs::write(dir.join("rust-seed.json"), json(&snapshot(&d).unwrap())).unwrap();
    let anchor = text(&d, C)
        .sticky_index(&d.transact(), 1, Assoc::After)
        .unwrap()
        .encode_v1();
    fs::write(dir.join("rust-anchor.bin"), &anchor).unwrap();
    chain(&d, 21);
    fs::write(dir.join("rust-chain.bin"), bytes(&d)).unwrap();
    fs::write(dir.join("rust-chain.json"), json(&snapshot(&d).unwrap())).unwrap();
    for kind in ["move", "control"] {
        let (base, updates) = race_updates(kind);
        for (i, b) in updates.iter().enumerate() {
            fs::write(dir.join(format!("rust-{kind}-{i}.bin")), b).unwrap();
        }
        fs::write(
            dir.join(format!("rust-{kind}.json")),
            json(&permutations(&base, &updates)),
        )
        .unwrap();
    }
    let result = Command::new("node")
        .args(["--test"])
        .arg(root.join("fixtures/schema-v4/exchange.mjs"))
        .env("EDITAC_STRUCTURAL_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "pinned Yjs exchange failed; inspect {}",
        dir.join("node.log").display()
    );
    let js = replica(51);
    apply(&js, &fs::read(dir.join("js-seed.bin")).unwrap()).unwrap();
    let original = project(&js).unwrap().sources;
    let independent = restore_checkpoint(
        &envelope(),
        true,
        &fs::read(dir.join("js-independent.bin")).unwrap(),
        56,
    )
    .unwrap();
    assert_eq!(
        snapshot(&independent).unwrap(),
        Any::from_json(&fs::read_to_string(dir.join("js-independent.json")).unwrap()).unwrap()
    );
    for name in [
        "js-chain",
        "js-disabled",
        "js-reenabled",
        "js-move",
        "js-control",
        "js-cycle",
        "js-unknown",
    ] {
        let b = fs::read(dir.join(format!("{name}.bin"))).unwrap();
        let expected =
            Any::from_json(&fs::read_to_string(dir.join(format!("{name}.json"))).unwrap()).unwrap();
        let r = if name == "js-unknown" {
            replica(52)
        } else {
            fork(&js, 52)
        };
        admit(&r, &envelope(), &b).unwrap();
        admit(&r, &envelope(), &b).unwrap();
        let actual = snapshot(&r).unwrap();
        fs::write(dir.join(format!("{name}-rust.json")), json(&actual)).unwrap();
        assert_eq!(actual, expected, "exchange {name}");
        assert_eq!(
            project(&r).unwrap().sources.keys().collect::<Vec<_>>(),
            original.keys().collect::<Vec<_>>()
        );
        let cp = restore_checkpoint(&envelope(), true, &bytes(&r), 53).unwrap();
        assert_eq!(snapshot(&cp).unwrap(), expected);
    }
    let r = fork(&js, 54);
    apply(&r, &fs::read(dir.join("js-chain.bin")).unwrap()).unwrap();
    assert_eq!(
        resolve(&r, C, &fs::read(dir.join("js-anchor.bin")).unwrap()).unwrap(),
        (C.into(), 1, false)
    );
    for kind in ["move", "control", "cycle"] {
        let updates = (0..3)
            .map(|i| fs::read(dir.join(format!("js-{kind}-{i}.bin"))).unwrap())
            .collect::<Vec<_>>();
        let expected =
            Any::from_json(&fs::read_to_string(dir.join(format!("js-{kind}.json"))).unwrap())
                .unwrap();
        assert_eq!(permutations(&js, &updates), expected);
    }
}

#[test]
fn split_move_join_races_and_remote_cut_edits_preserve_nested_original_ownership() {
    let base = seed();
    let sv = base.transact().state_vector();
    let a = fork(&base, 21);
    let b = fork(&base, 22);
    let c = fork(&base, 23);
    split(&a, "o:21:1", A, 0, 1).unwrap();
    place(&b, "o:22:1", A, K, None).unwrap();
    text(&c, A).insert(&mut c.transact_mut(), 1, "R");
    let updates = [a, b, c].map(|d| d.transact().encode_state_as_update_v1(&sv));
    let Any::Map(s) = permutations(&base, &updates) else {
        panic!()
    };
    let Any::Map(o) = &s["outcomes"] else {
        panic!()
    };
    assert_eq!(o["o:21:1"], Any::from("applied"));
    assert_eq!(o["o:22:1"], Any::from("losing"));
    let d = seed();
    place(&d, "o:21:1", B, K, Some(C)).unwrap();
    let before = bytes(&d);
    assert_eq!(join(&d, "o:21:2", A, B), Err("nonadjacent-target"));
    assert_eq!(bytes(&d), before);
    join(&d, "o:21:2", B, C).unwrap();
    assert_eq!(field(&d, B, "parent"), Any::from(K));
    assert_eq!(field(&d, B, "check"), Any::Bool(false));
}
#[test]
fn concurrent_operation_controls_and_edits_restore_without_destroying_rows() {
    let base = seed();
    split(&base, "o:11:1", A, 0, 1).unwrap();
    join(&base, "o:11:2", A, "o:11:1").unwrap();
    let sv = base.transact().state_vector();
    let a = fork(&base, 21);
    let b = fork(&base, 22);
    let c = fork(&base, 23);
    control(&a, "o:11:1", false);
    control(&b, "o:11:1", true);
    text(&c, A).insert(&mut c.transact_mut(), 0, "remote");
    let updates = [a, b, c].map(|d| d.transact().encode_state_as_update_v1(&sv));
    let s = permutations(&base, &updates);
    let Any::Map(s) = s else { panic!() };
    let Any::Map(o) = &s["outcomes"] else {
        panic!()
    };
    assert_eq!(o["o:11:1"], Any::from("applied"));
    assert_eq!(o["o:11:2"], Any::from("applied"));
}
#[test]
fn deleted_and_disabled_move_destinations_retain_losing_intentions_and_dormant_checks() {
    for disable in [false, true] {
        let d = seed();
        let b = bytes(&d);
        let r = fork(&d, 21);
        place(&r, "o:21:1", A, K, None).unwrap();
        if disable {
            control(&r, K, false);
        } else {
            set(&r, 3, K, Any::Bool(true));
        }
        admit(&d, &envelope(), &bytes(&r)).unwrap();
        assert_eq!(outcome(&d, "o:21:1"), "losing");
        assert_eq!(field(&d, C, "parent"), Any::from("@root"));
        assert_eq!(field(&d, C, "check"), Any::Null);
        assert_eq!(
            project(&d).unwrap().sources,
            project(&restore_checkpoint(&envelope(), true, &b, 31).unwrap())
                .unwrap()
                .sources
        );
    }
}
#[test]
fn dormant_operation_activates_after_missing_version_without_reseeding() {
    let base = seed();
    let a = fork(&base, 21);
    split(&a, "o:21:1", A, 0, 1).unwrap();
    place(&a, "o:21:2", "o:21:1", K, None).unwrap();
    let raw = values_for(&a, 5)["o:21:2"].clone();
    set(&base, 5, "o:21:2", raw);
    assert_eq!(outcome(&base, "o:21:2"), "dormant");
    admit(&base, &envelope(), &bytes(&a)).unwrap();
    assert_eq!(outcome(&base, "o:21:2"), "applied");
    assert_eq!(field(&base, "o:21:1", "parent"), Any::from(K));
}
#[test]
fn invalid_unicode_cuts_versions_place_shapes_and_origin_namespaces_are_atomic() {
    let d = seed();
    let before = bytes(&d);
    assert_eq!(split(&d, "o:21:1", A, 0, 2), Err("invalid-cut"));
    assert_eq!(bytes(&d), before);
    for record in [
        arr(vec![
            Any::from("place"),
            Any::from(A),
            Any::from("base"),
            Any::from("@root"),
            Any::from("o:21:9"),
            Any::Null,
            Any::Null,
        ]),
        arr(vec![
            Any::from("place"),
            Any::from(A),
            Any::from("base"),
            Any::from(L),
            Any::from("base"),
            Any::Null,
            Any::from("base"),
        ]),
        arr(vec![
            Any::from("place"),
            Any::from(A),
            Any::from("n:21:1"),
            Any::from(L),
            Any::from("base"),
            Any::Null,
            Any::Null,
        ]),
    ] {
        let r = fork(&d, 21);
        set(&r, 5, "o:21:1", record);
        assert!(admit(&d, &envelope(), &bytes(&r)).is_err());
        assert_eq!(bytes(&d), before);
    }
    let r = fork(&d, 21);
    let cut = text(&r, A)
        .sticky_index(&r.transact(), 1, Assoc::After)
        .unwrap()
        .encode_v1();
    set(
        &r,
        5,
        "o:21:1",
        arr(vec![
            Any::from("split"),
            Any::from(A),
            Any::from("base"),
            Any::from(0u32),
            Any::from(A),
            Any::Buffer(cut.into()),
        ]),
    );
    rejected(&d, &r, "invalid-cut");
}
#[test]
fn aggregate_source_text_and_ids_membership_and_unknown_target_metadata_are_bounded() {
    let d = seed();
    let r = fork(&d, 21);
    for source in [A, B, C, D] {
        text(&r, source).insert(
            &mut r.transact_mut(),
            0,
            &"x".repeat(if source == D { 262144 } else { 262140 }),
        );
    }
    rejected(&d, &r, "resource-limit");
    for key in ["c:0:1", "c:01:1", "c:4294967296:1", "c:1:0"] {
        let r = fork(&d, 21);
        control(&r, key, false);
        let before = bytes(&d);
        assert!(admit(&d, &envelope(), &bytes(&r)).is_err());
        assert_eq!(bytes(&d), before);
    }
    let r = fork(&d, 21);
    set(&r, 8, "o:21:99", checked(true));
    rejected(&d, &r, "invalid-target");
    let d = seed();
    set(&d, 7, L, arr(vec![Any::from("ext:future-list"), Any::Null]));
    let before = bytes(&d);
    assert_eq!(place(&d, "o:21:1", B, L, None), Err("illegal-parent"));
    assert_eq!(bytes(&d), before);
}
