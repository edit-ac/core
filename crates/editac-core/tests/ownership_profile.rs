//! ENG-1.17 exact layout qualification; no production integration claim.
#[path = "../../../fixtures/schema-v3/mapping.rs"]
mod m;
use m::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use yrs::updates::encoder::Encode;
use yrs::{Any, Assoc, IndexedSequence, Map, ReadTxn, Text, Transact};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
fn dir() -> PathBuf {
    std::env::var_os("EDITAC_OWNERSHIP_EXCHANGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../architecture/evidence/engine-ownership-profile/exchange")
        })
}
fn chain(d: &yrs::Doc, writer: u32) {
    let op = |n| format!("o:{writer}:{n}");
    split(d, &op(1), A, 0, 3).unwrap();
    join(d, &op(2), A, &op(1)).unwrap();
    join(d, &op(3), A, B).unwrap();
    split(d, &op(4), A, 2, 1).unwrap();
    split(d, &op(5), &op(4), 0, 3).unwrap();
    join(d, &op(6), &op(4), &op(5)).unwrap();
    join(d, "o:22:1", C, D).unwrap();
    split(d, "o:22:2", C, 0, 0).unwrap();
}
fn owner_text(d: &yrs::Doc, id: &str) -> String {
    let Any::Map(s) = snapshot(d).unwrap() else {
        panic!()
    };
    let Any::Array(v) = &s["visible"] else {
        panic!()
    };
    for node in v.iter() {
        let Any::Map(n) = node else { panic!() };
        if n["id"] == Any::from(id) {
            let Any::Array(r) = &n["runs"] else { panic!() };
            return r
                .iter()
                .map(|r| {
                    let Any::Map(r) = r else { panic!() };
                    let Any::String(s) = &r["insert"] else {
                        panic!()
                    };
                    s.as_ref()
                })
                .collect();
        }
    }
    panic!("owner")
}
fn rejected(d: &yrs::Doc, remote: &yrs::Doc, expected: &str) {
    let b = bytes(d);
    let s = snapshot(d).unwrap();
    assert_eq!(admit(d, &envelope(), &bytes(remote)), Err(expected));
    assert_eq!(bytes(d), b);
    assert_eq!(snapshot(d).unwrap(), s);
}
#[test]
fn machine_seed_exact_seven_roots_and_nonreserved_ids() {
    let d = seed();
    assert_eq!(project(&d).unwrap().owners.len(), 4);
    for s in [
        "block-1",
        "block-split",
        "n:0:1",
        "n:01:1",
        "n:11:0",
        "n:4294967296:1",
    ] {
        assert!(id(s, "n").is_err())
    }
    assert!(id("n:4294967295:4294967295", "n").is_ok());
    assert_eq!(owner_text(&d, A), "a😀b");
    assert_eq!(owner_text(&d, D), "");
}
#[test]
fn repeated_transforms_two_disjoint_pairs_and_multisource_split_after_join() {
    let d = seed();
    let source = project(&d).unwrap().sources;
    chain(&d, 21);
    let v = project(&d).unwrap();
    assert_eq!(v.sources, source);
    assert_eq!(v.outcomes.len(), 8);
    assert!(v.outcomes.values().all(|s| s == "applied"));
    assert_eq!(owner_text(&d, A), "a😀bc");
    assert_eq!(owner_text(&d, "o:21:4"), "אבd");
    assert_eq!(owner_text(&d, C), "");
    assert_eq!(owner_text(&d, "o:22:2"), "éZ");
    assert_eq!(v.owners[0].spans.len(), 3);
    assert_eq!(
        v.owners[1].attrs,
        arr(vec![Any::from("heading"), Any::from(1)])
    );
}
#[test]
fn begin_middle_end_empty_and_unicode_cuts_preserve_identity() {
    for (source, offset) in [(A, 0), (A, 1), (A, 3), (A, 4), (C, 1), (C, 2), (D, 0)] {
        let d = seed();
        let initial = project(&d).unwrap().sources;
        split(&d, "o:21:1", source, 0, offset).unwrap();
        let v = project(&d).unwrap();
        assert_eq!(v.sources, initial);
        assert_eq!(v.outcomes["o:21:1"], "applied");
        assert_eq!(
            v.owners
                .iter()
                .filter(|o| o.id == source || o.id == "o:21:1")
                .flat_map(|o| &o.spans)
                .map(|s| s.end - s.start)
                .sum::<u32>(),
            text(&d, source).len(&d.transact())
        );
    }
    let d = seed();
    let b = bytes(&d);
    assert_eq!(split(&d, "o:21:1", A, 0, 2), Err("invalid-cut"));
    assert_eq!(bytes(&d), b);
}
#[test]
fn marks_empty_heading_live_inheritance_override_and_absorbed_retention() {
    let d = seed();
    split(&d, "o:21:1", A, 0, 0).unwrap();
    set(&d, 4, A, arr(vec![Any::from("heading"), Any::from(6)]));
    let v = project(&d).unwrap();
    assert_eq!(v.owners[0].attrs, v.owners[1].attrs);
    assert_eq!(owner_text(&d, A), "");
    set(&d, 4, "o:21:1", arr(vec![Any::from("paragraph")]));
    join(&d, "o:21:2", A, "o:21:1").unwrap();
    let v = project(&d).unwrap();
    assert_eq!(v.retained["o:21:1"], arr(vec![Any::from("paragraph")]));
    assert_eq!(
        v.owners[0].attrs,
        arr(vec![Any::from("heading"), Any::from(6)])
    );
    let Any::Map(s) = snapshot(&d).unwrap() else {
        panic!()
    };
    let Any::Array(nodes) = &s["visible"] else {
        panic!()
    };
    let Any::Map(n) = &nodes[0] else { panic!() };
    let Any::Array(r) = &n["runs"] else { panic!() };
    let Any::Map(run) = &r[0] else { panic!() };
    let Any::Map(a) = &run["attributes"] else {
        panic!()
    };
    assert_eq!(a["bold"], Any::Bool(true));
    assert!(a.contains_key("ext:future"));
}
#[test]
fn binary_anchor_routes_original_identity_across_repeat_join_split_and_empty_ties() {
    let d = seed();
    let before = text(&d, A)
        .sticky_index(&d.transact(), 3, Assoc::Before)
        .unwrap()
        .encode_v1();
    let after = text(&d, A)
        .sticky_index(&d.transact(), 3, Assoc::After)
        .unwrap()
        .encode_v1();
    split(&d, "o:21:1", A, 0, 3).unwrap();
    assert_eq!(resolve(&d, A, &before).unwrap(), (A.into(), 3, false));
    assert_eq!(resolve(&d, A, &after).unwrap(), ("o:21:1".into(), 0, false));
    join(&d, "o:21:2", A, "o:21:1").unwrap();
    join(&d, "o:21:3", A, B).unwrap();
    split(&d, "o:21:4", A, 2, 1).unwrap();
    assert_eq!(resolve(&d, A, &before).unwrap(), (A.into(), 3, false));
    let empty = yrs::StickyIndex::from_type(&d.transact(), &text(&d, D), Assoc::After).encode_v1();
    split(&d, "o:21:5", D, 0, 0).unwrap();
    assert_eq!(resolve(&d, D, &empty).unwrap(), ("o:21:5".into(), 0, false));
    set(&d, 3, A, Any::Bool(true));
    assert!(resolve(&d, A, &before).unwrap().2);
}
#[test]
fn conflicting_branches_dependency_descendants_and_disjoint_operations_reorder() {
    let d = seed();
    let baseline = d.transact().state_vector();
    let x = fork(&d, 41);
    let y = fork(&d, 42);
    split(&x, "o:41:1", A, 0, 1).unwrap();
    split(&x, "o:41:2", "o:41:1", 0, 3).unwrap();
    join(&y, "o:42:1", A, B).unwrap();
    split(&y, "o:42:2", A, 1, 1).unwrap();
    join(&y, "o:42:3", C, D).unwrap();
    let deltas = [
        x.transact().encode_state_as_update_v1(&baseline),
        y.transact().encode_state_as_update_v1(&baseline),
    ];
    let mut expected = None;
    for order in [[0, 1, 0], [1, 0, 1]] {
        let r = fork(&d, 43);
        for n in order {
            apply(&r, &deltas[n]).unwrap()
        }
        let s = snapshot(&r).unwrap();
        let v = project(&r).unwrap();
        assert_eq!(v.outcomes["o:41:1"], "applied");
        assert_eq!(v.outcomes["o:42:1"], "losing");
        assert_eq!(v.outcomes["o:42:2"], "losing");
        assert_eq!(v.outcomes["o:42:3"], "applied");
        if let Some(e) = &expected {
            assert_eq!(&s, e)
        } else {
            expected = Some(s)
        };
        assert_eq!(snapshot(&fork(&r, 44)).unwrap(), snapshot(&r).unwrap());
    }
}
#[test]
fn both_sides_cut_concurrent_edits_and_mark_writes_route_without_copy() {
    let d = seed();
    let x = fork(&d, 41);
    split(&d, "o:21:1", A, 0, 3).unwrap();
    let source = text(&x, A);
    {
        let mut t = x.transact_mut_with("local:edit");
        source.insert(&mut t, 0, "L");
        source.insert(&mut t, 4, "R");
        source.insert(&mut t, 6, "E");
    }
    apply(&d, &bytes(&x)).unwrap();
    assert_eq!(owner_text(&d, A), "La😀");
    assert_eq!(owner_text(&d, "o:21:1"), "RbE");
    let b = bytes(&d);
    snapshot(&d).unwrap();
    assert_eq!(bytes(&d), b);
}
#[test]
fn delete_original_and_derived_keep_content_metadata_and_losing_intentions() {
    let d = seed();
    split(&d, "o:21:1", A, 0, 3).unwrap();
    set(
        &d,
        4,
        "o:21:1",
        arr(vec![Any::from("heading"), Any::from(6)]),
    );
    set(&d, 3, "o:21:1", Any::Bool(true));
    let b = bytes(&d);
    assert_eq!(split(&d, "o:21:2", "o:21:1", 0, 3), Err("deleted-target"));
    assert_eq!(bytes(&d), b);
    let v = project(&d).unwrap();
    assert!(v.owners[1].deleted);
    assert_eq!(v.owners[1].spans[0].start, 3);
    set(&d, 3, A, Any::Bool(true));
    let v = project(&d).unwrap();
    assert_eq!(v.outcomes["o:21:1"], "losing");
    assert!(v.owners[0].deleted);
    assert!(v.retained.contains_key("o:21:1"));
    assert_eq!(v.sources.len(), 4);
}
#[test]
fn deletion_of_cut_characters_collapses_without_losing_remaining_coverage() {
    let d = seed();
    split(&d, "o:21:1", A, 0, 3).unwrap();
    let x = text(&d, A);
    x.remove_range(&mut d.transact_mut_with("local:delete"), 0, 3);
    assert_eq!(owner_text(&d, A), "");
    assert_eq!(owner_text(&d, "o:21:1"), "b");
    assert_eq!(project(&d).unwrap().outcomes["o:21:1"], "applied");
}
#[test]
fn missing_graph_dependencies_dormant_then_activate_without_reseed() {
    let d = seed();
    let x = fork(&d, 21);
    split(&x, "o:21:1", A, 0, 1).unwrap();
    split(&x, "o:21:2", "o:21:1", 0, 3).unwrap();
    let t = x.transact();
    let record = t.get_map(ROOTS[5]).unwrap().get(&t, "o:21:2").unwrap();
    let yrs::Out::Any(record) = record else {
        panic!()
    };
    drop(t);
    set(&d, 5, "o:21:2", record);
    assert_eq!(project(&d).unwrap().outcomes["o:21:2"], "dormant");
    apply(&d, &bytes(&x)).unwrap();
    assert_eq!(project(&d).unwrap().outcomes["o:21:2"], "applied");
}
#[test]
fn unknown_metadata_and_character_attributes_retained_opaquely() {
    let d = seed();
    set(
        &d,
        4,
        A,
        arr(vec![
            Any::from("ext:new"),
            obj(vec![("retained", Any::Bool(true))]),
        ]),
    );
    split(&d, "o:21:1", A, 0, 1).unwrap();
    let v = project(&d).unwrap();
    assert_eq!(v.owners[0].attrs, v.owners[1].attrs);
    assert_eq!(snapshot(&fork(&d, 31)).unwrap(), snapshot(&d).unwrap());
}
#[test]
fn exact_profile_document_epoch_encoding_and_missing_metadata_before_decode() {
    let d = seed();
    let Any::Map(e) = envelope() else { panic!() };
    let b = bytes(&d);
    for k in [
        "profile",
        "schema",
        "protocolVersion",
        "updateEncoding",
        "offsets",
        "documentId",
        "epoch",
    ] {
        let mut n = (*e).clone();
        n.insert(k.into(), Any::from("unsupported"));
        assert!(admit(&d, &Any::Map(n.into()), &[255]).is_err());
        assert_eq!(bytes(&d), b);
    }
    let mut missing = (*e).clone();
    missing.remove("epoch");
    assert_eq!(
        admit(&d, &Any::Map(missing.into()), &b),
        Err("invalid-metadata")
    );
}
#[test]
fn invalid_tuple_target_shared_type_and_atomic_text_rejection() {
    for value in [
        Any::Null,
        arr(vec![]),
        arr(vec![Any::from("heading"), Any::from(0)]),
        arr(vec![Any::from("heading"), Any::from(7)]),
        arr(vec![Any::from("heading"), Any::from(1.5)]),
        arr(vec![Any::from("paragraph"), Any::Bool(true)]),
    ] {
        let d = seed();
        let x = fork(&d, 31);
        set(&x, 4, A, value);
        text(&x, A).insert(&mut x.transact_mut(), 0, "reject");
        rejected(&d, &x, "invalid-tuple");
    }
    let d = seed();
    let x = fork(&d, 31);
    set(&x, 4, "o:31:999", arr(vec![Any::from("paragraph")]));
    rejected(&d, &x, "invalid-target");
    let x = fork(&d, 32);
    {
        let mut t = x.transact_mut();
        t.get_map(ROOTS[4])
            .unwrap()
            .insert(&mut t, A, yrs::ArrayPrelim::from(["heading"]));
    }
    rejected(&d, &x, "invalid-shape");
}
#[test]
fn invalid_operation_graph_cycle_and_immutable_replacement_are_recovery() {
    let d = seed();
    let x = fork(&d, 31);
    set(
        &x,
        5,
        "o:31:1",
        arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:31:2"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    set(
        &x,
        5,
        "o:31:2",
        arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:31:1"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    rejected(&d, &x, "cycle");
    split(&d, "o:21:1", A, 0, 1).unwrap();
    let x = fork(&d, 31);
    set(
        &x,
        5,
        "o:21:1",
        arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("base"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    rejected(&d, &x, "immutable-replacement");
}
#[test]
fn cut_wrong_source_affinity_surrogate_and_bad_binary_reject_before_live_write() {
    for (source, offset, assoc) in [
        (B, 1, Assoc::Before),
        (A, 2, Assoc::Before),
        (A, 1, Assoc::After),
    ] {
        let d = seed();
        let x = fork(&d, 31);
        let cut = text(&x, source)
            .sticky_index(&x.transact(), offset, assoc)
            .unwrap()
            .encode_v1();
        set(
            &x,
            5,
            "o:31:1",
            arr(vec![
                Any::from("split"),
                Any::from(A),
                Any::from("base"),
                Any::from(0),
                Any::from(A),
                Any::Buffer(cut.into()),
            ]),
        );
        rejected(&d, &x, "invalid-cut");
    }
    let d = seed();
    let x = fork(&d, 31);
    set(
        &x,
        5,
        "o:31:1",
        arr(vec![
            Any::from("split"),
            Any::from(A),
            Any::from("base"),
            Any::from(0),
            Any::from(A),
            Any::Buffer(vec![255].into()),
        ]),
    );
    rejected(&d, &x, "invalid-cut");
}
#[test]
fn bounds_depth_sources_operations_wire_text_and_json_do_not_silently_omit() {
    let d = seed();
    let mut previous = "base".to_owned();
    for n in 1..=129 {
        let op = format!("o:31:{n}");
        set(
            &d,
            5,
            &op,
            arr(vec![
                Any::from("join"),
                Any::from(A),
                Any::from(previous.clone()),
                Any::from(B),
                Any::from("base"),
            ]),
        );
        previous = op;
    }
    assert_eq!(project(&d), Err("resource-limit"));
    let d = seed();
    let x = fork(&d, 31);
    text(&x, A).insert(&mut x.transact_mut(), 0, &"x".repeat(262145));
    rejected(&d, &x, "resource-limit");
    let b = bytes(&d);
    assert_eq!(
        admit(&d, &envelope(), &vec![0; 16777217]),
        Err("resource-limit")
    );
    assert_eq!(bytes(&d), b);
    let x = fork(&d, 31);
    let mut v = Any::Null;
    for _ in 0..33 {
        v = arr(vec![v])
    }
    set(&x, 4, A, arr(vec![Any::from("ext:deep"), v]));
    rejected(&d, &x, "resource-limit");
}
#[test]
fn checkpoint_restore_duplicate_updates_and_projection_are_read_only() {
    let d = seed();
    chain(&d, 21);
    let before = bytes(&d);
    let expected = snapshot(&d).unwrap();
    let r = replica(31);
    for _ in 0..3 {
        apply(&r, &before).unwrap();
        assert_eq!(snapshot(&r).unwrap(), expected);
    }
    assert_eq!(bytes(&d), before);
    assert_eq!(snapshot(&fork(&r, 32)).unwrap(), expected);
}
#[test]
fn pinned_rust_yjs_exchange_complete_matrix_and_all_three_update_permutations() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = dir();
    fs::create_dir_all(&dir).unwrap();
    let d = seed();
    fs::write(dir.join("rust-seed.bin"), bytes(&d)).unwrap();
    fs::write(dir.join("rust-seed.json"), json(&snapshot(&d).unwrap())).unwrap();
    let anchor = text(&d, B)
        .sticky_index(&d.transact(), 3, Assoc::After)
        .unwrap()
        .encode_v1();
    fs::write(dir.join("rust-anchor.bin"), &anchor).unwrap();
    chain(&d, 21);
    set(
        &d,
        4,
        "o:21:4",
        arr(vec![Any::from("heading"), Any::from(6)]),
    );
    fs::write(dir.join("rust-chain.bin"), bytes(&d)).unwrap();
    fs::write(dir.join("rust-chain.json"), json(&snapshot(&d).unwrap())).unwrap();
    let base = seed();
    let baseline = base.transact().state_vector();
    for (name, client, join_op) in [("a", 41, false), ("b", 42, true), ("c", 43, false)] {
        let r = fork(&base, client);
        if name == "c" {
            let x = text(&r, A);
            x.insert(&mut r.transact_mut(), 0, "L");
            x.insert(&mut r.transact_mut(), 4, "R");
            set(&r, 4, A, arr(vec![Any::from("heading"), Any::from(6)]));
        } else if join_op {
            join(&r, "o:42:1", A, B).unwrap();
            split(&r, "o:42:2", A, 1, 1).unwrap();
            join(&r, "o:42:3", C, D).unwrap();
        } else {
            split(&r, "o:41:1", A, 0, 3).unwrap();
            split(&r, "o:41:2", "o:41:1", 0, 4).unwrap();
        }
        fs::write(
            dir.join(format!("rust-race-{name}.bin")),
            r.transact().encode_state_as_update_v1(&baseline),
        )
        .unwrap();
    }
    let result = Command::new("node")
        .arg("--test")
        .arg(root.join("fixtures/schema-v3/exchange.mjs"))
        .env("EDITAC_OWNERSHIP_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "Yjs exchange failed: inspect node.log"
    );
    let js = replica(51);
    apply(&js, &fs::read(dir.join("js-seed.bin")).unwrap()).unwrap();
    let original = project(&js).unwrap().sources;
    for name in ["js-chain", "js-deleted", "js-race"] {
        let update = fs::read(dir.join(format!("{name}.bin"))).unwrap();
        let expected =
            Any::from_json(&fs::read_to_string(dir.join(format!("{name}.json"))).unwrap()).unwrap();
        let r = fork(&js, 52);
        admit(&r, &envelope(), &update).unwrap();
        assert_eq!(snapshot(&r).unwrap(), expected);
        assert_eq!(snapshot(&fork(&r, 53)).unwrap(), expected);
        if name == "js-chain" {
            assert_eq!(project(&r).unwrap().sources, original);
            let anchor = fs::read(dir.join("js-anchor.bin")).unwrap();
            assert_eq!(resolve(&r, B, &anchor).unwrap().0, "o:31:4");
        }
    }
    let independently_created = replica(61);
    apply(
        &independently_created,
        &fs::read(dir.join("js-independent.bin")).unwrap(),
    )
    .unwrap();
    let view = project(&independently_created).unwrap();
    assert_eq!(view.owners.len(), 4);
    assert_eq!(owner_text(&independently_created, A), "a😀b");
    for o in view.owners {
        assert_eq!(
            o.attrs,
            project(&base)
                .unwrap()
                .owners
                .iter()
                .find(|v| v.id == o.id)
                .unwrap()
                .attrs
        );
    }
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let r = fork(&base, 62);
        for i in order.into_iter().chain(order) {
            let name = ["a", "b", "c"][i];
            apply(
                &r,
                &fs::read(dir.join(format!("rust-race-{name}.bin"))).unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            snapshot(&r).unwrap(),
            Any::from_json(&fs::read_to_string(dir.join("rust-race.json")).unwrap()).unwrap()
        );
    }
    for name in [
        "js-invalid-tuple",
        "js-invalid-operation",
        "js-invalid-root",
    ] {
        let r = fork(&js, 63);
        let b = bytes(&r);
        assert!(
            admit(
                &r,
                &envelope(),
                &fs::read(dir.join(format!("{name}.bin"))).unwrap()
            )
            .is_err()
        );
        assert_eq!(bytes(&r), b);
    }
}
#[test]
fn staged_admission_retains_text_identity_and_monotonic_deletion() {
    let d = seed();
    let x = fork(&d, 31);
    {
        let mut t = x.transact_mut();
        t.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut t, A, yrs::XmlTextPrelim::new("copied"));
    }
    rejected(&d, &x, "immutable-replacement");
    set(&d, 3, A, Any::Bool(true));
    let x = fork(&d, 32);
    {
        let mut t = x.transact_mut();
        t.get_map(ROOTS[3]).unwrap().remove(&mut t, A);
    }
    rejected(&d, &x, "immutable-replacement");
    let x = fork(&d, 33);
    x.get_or_insert_map("unknown-root");
    set(&x, 0, "n:11:1", Any::from("opaque"));
    rejected(&d, &x, "invalid-source");
}
#[test]
fn initialized_empty_restore_never_seeds_and_uses_independent_writer() {
    let d = replica(11);
    let cp = bytes(&d);
    let r = restore_checkpoint(&envelope(), true, &cp, 31).unwrap();
    assert!(project(&r).unwrap().owners.is_empty());
    assert_ne!(d.client_id(), r.client_id());
    assert!(matches!(
        restore_checkpoint(&envelope(), false, &cp, 32),
        Err("missing-initializer")
    ));
    assert!(matches!(
        restore_checkpoint(&envelope(), true, &cp, 0),
        Err("invalid-writer")
    ));
    let d = seed();
    let r = restore_checkpoint(&envelope(), true, &bytes(&d), 33).unwrap();
    assert_eq!(snapshot(&r).unwrap(), snapshot(&d).unwrap());
}
#[test]
fn incomplete_binary_dependencies_reject_staged_then_activate_after_prerequisite() {
    let d = seed();
    let x = fork(&d, 21);
    let sv = x.transact().state_vector();
    let source = text(&x, A);
    source.insert(&mut x.transact_mut_with("local:edit"), 0, "X");
    let first = x.transact().encode_state_as_update_v1(&sv);
    let sv = x.transact().state_vector();
    source.insert(&mut x.transact_mut_with("local:edit"), 1, "Y");
    let second = x.transact().encode_state_as_update_v1(&sv);
    let before = bytes(&d);
    assert_eq!(
        admit(&d, &envelope(), &second),
        Err("missing-binary-dependency")
    );
    assert_eq!(bytes(&d), before);
    admit(&d, &envelope(), &first).unwrap();
    admit(&d, &envelope(), &second).unwrap();
    assert_eq!(snapshot(&d).unwrap(), snapshot(&x).unwrap());
}
#[test]
fn bounded_decode_rejects_nested_any_and_allocation_amplification() {
    let d = seed();
    let x = fork(&d, 31);
    let mut value = Any::Null;
    for _ in 0..40 {
        value = arr(vec![value])
    }
    set(&x, 4, A, arr(vec![Any::from("ext:deep"), value]));
    rejected(&d, &x, "resource-limit");
    let before = bytes(&d);
    assert_eq!(
        admit(&d, &envelope(), &[255, 255, 255, 255, 7]),
        Err("resource-limit")
    );
    assert_eq!(bytes(&d), before);
}
#[test]
fn complete_known_graph_cycles_and_dormant_depth_remain_bounded() {
    let d = seed();
    set(
        &d,
        5,
        "o:31:1",
        arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:31:2"),
            Any::from(B),
            Any::from("o:31:99"),
        ]),
    );
    set(
        &d,
        5,
        "o:31:2",
        arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:31:1"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    assert_eq!(project(&d), Err("cycle"));
    let d = seed();
    let mut previous = "o:31:999".to_owned();
    for n in 1..=129 {
        let op = format!("o:31:{n}");
        set(
            &d,
            5,
            &op,
            arr(vec![
                Any::from("join"),
                Any::from(A),
                Any::from(previous),
                Any::from(B),
                Any::from("base"),
            ]),
        );
        previous = op;
    }
    assert_eq!(project(&d), Err("resource-limit"));
}
#[test]
fn source_operation_container_limits_and_unknown_source_anchor_are_explicit() {
    let d = seed();
    for n in 1..=4097 {
        set(
            &d,
            5,
            &format!("o:31:{n}"),
            arr(vec![
                Any::from("join"),
                Any::from(A),
                Any::from("o:32:1"),
                Any::from(B),
                Any::from("base"),
            ]),
        );
    }
    assert_eq!(project(&d), Err("resource-limit"));
    let d = seed();
    for n in 1..=4097 {
        set(&d, 0, &format!("n:31:{n}"), Any::from("block"));
    }
    assert_eq!(project(&d), Err("resource-limit"));
    let d = seed();
    let anchor = text(&d, A)
        .sticky_index(&d.transact(), 1, Assoc::Before)
        .unwrap()
        .encode_v1();
    assert_eq!(resolve(&d, "n:31:999", &anchor), Err("unresolvable"));
    let x = fork(&d, 31);
    set(
        &x,
        4,
        A,
        arr(vec![Any::from("ext:wide"), arr(vec![Any::Null; 8193])]),
    );
    rejected(&d, &x, "resource-limit");
}
#[test]
fn aggregate_text_and_cut_byte_bounds_reject_staged_without_partial_mutation() {
    let d = seed();
    let x = fork(&d, 31);
    for source in [A, B, C, D] {
        text(&x, source).insert(
            &mut x.transact_mut(),
            0,
            &"x".repeat(if source == D { 262144 } else { 262140 }),
        );
    }
    rejected(&d, &x, "resource-limit");
    let x = fork(&d, 32);
    set(
        &x,
        5,
        "o:32:1",
        arr(vec![
            Any::from("split"),
            Any::from(A),
            Any::from("base"),
            Any::from(0),
            Any::from(A),
            Any::Buffer(vec![0; 257].into()),
        ]),
    );
    rejected(&d, &x, "resource-limit");
}

#[test]
fn next_visible_join_crosses_tombstone_without_absorbing_recovery_content() {
    let d = seed();
    set(&d, 3, B, Any::Bool(true));
    join(&d, "o:251:1", A, C).unwrap();
    assert_eq!(owner_text(&d, A), "a😀béZ");
    assert_eq!(project(&d).unwrap().outcomes["o:251:1"], "applied");
    let view = project(&d).unwrap();
    let deleted = view.owners.iter().find(|o| o.id == B).unwrap();
    assert!(deleted.deleted);
    assert_eq!(
        deleted.spans,
        vec![Span {
            source: B.into(),
            start: 0,
            end: 4
        }]
    );
    let restored = restore_checkpoint(&envelope(), true, &bytes(&d), 252).unwrap();
    assert_eq!(snapshot(&restored).unwrap(), snapshot(&d).unwrap());
}
