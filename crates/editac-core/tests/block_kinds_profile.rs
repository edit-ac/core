//! ENG-1.20 deterministic qualification, not production v4 support.
#[path = "../../../fixtures/schema-v4/mapping.rs"]
mod m;
use m::{policy::*, *};
use std::{
    fs,
    path::PathBuf,
    process::Command as Process,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use yrs::updates::encoder::Encode;
use yrs::{Any, Assoc, IndexedSequence, Map, ReadTxn, Text, Transact, XmlTextPrelim};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
fn block(owner: &str, v: Vec<Any>) -> Command {
    Command::Block {
        owner: owner.into(),
        tuple: arr(v),
    }
}
fn code(owner: &str, language: &str) -> Command {
    block(owner, vec![Any::from("code"), Any::from(language)])
}
fn insert(owner: &str, offset: u32, value: &str) -> Command {
    Command::Insert {
        owner: owner.into(),
        span: 0,
        offset,
        value: value.into(),
    }
}
fn mark(owner: &str) -> Command {
    Command::Mark {
        owner: owner.into(),
        span: 0,
        offset: 0,
        len: 1,
    }
}
fn field(d: &yrs::Doc, key: &str, name: &str) -> Any {
    let Any::Map(s) = snapshot(d).unwrap() else {
        panic!()
    };
    let Any::Array(v) = &s["visible"] else {
        panic!()
    };
    let Any::Map(n) = v
        .iter()
        .find(|v| matches!(v,Any::Map(n) if n["id"]==Any::from(key)))
        .unwrap()
    else {
        panic!()
    };
    n[name].clone()
}
fn plain(d: &yrs::Doc, key: &str) -> String {
    let Any::Array(r) = field(d, key, "runs") else {
        panic!()
    };
    r.iter()
        .map(|r| {
            let Any::Map(r) = r else { panic!() };
            let Any::String(s) = &r["insert"] else {
                panic!()
            };
            s.to_string()
        })
        .collect()
}
fn stable(d: &yrs::Doc, f: impl FnOnce() -> m::Result<()>, error: &str) {
    let b = bytes(d);
    let s = snapshot(d).unwrap();
    let sv = d.transact().state_vector();
    assert_eq!(f(), Err(error));
    assert_eq!(bytes(d), b);
    assert_eq!(snapshot(d).unwrap(), s);
    assert_eq!(d.transact().state_vector(), sv);
}
fn identity(d: &yrs::Doc, key: &str) -> Any {
    let v = project(d).unwrap();
    let Any::Map(m) = &v.sources[key] else {
        panic!()
    };
    m["identity"].clone()
}
fn one() -> yrs::Doc {
    let d = replica(11);
    let mut t = d.transact_mut_with("initialize");
    t.get_map(ROOTS[0]).unwrap().insert(&mut t, A, "block");
    t.get_map(ROOTS[1])
        .unwrap()
        .insert(&mut t, A, XmlTextPrelim::new(""));
    t.get_map(ROOTS[2])
        .unwrap()
        .insert(&mut t, A, arr(vec![Any::from("@root"), Any::from(0u32)]));
    t.get_map(ROOTS[4])
        .unwrap()
        .insert(&mut t, A, arr(vec![Any::from("paragraph")]));
    t.get_map(ROOTS[6]).unwrap().insert(&mut t, A, true);
    drop(t);
    d
}
fn neighbor() -> Neighbor {
    Neighbor {
        id: "n:21:1".into(),
        place: "o:21:1".into(),
    }
}
fn restore(d: &yrs::Doc) {
    let r = restore_checkpoint(&envelope(), true, &bytes(d), 57).unwrap();
    assert_eq!(snapshot(&r).unwrap(), snapshot(d).unwrap());
}
#[test]
fn atomic_tuple_language_level_matrix_and_unknown_retention() {
    let d = seed();
    let identities = project(&d).unwrap().sources;
    for v in [
        vec![Any::from("paragraph")],
        vec![Any::from("heading"), Any::from(1u32)],
        vec![Any::from("heading"), Any::from(6u32)],
        vec![Any::from("code"), Any::from("")],
        vec![Any::from("code"), Any::from("A_z-1.2+c")],
        vec![Any::from("code"), Any::from("x".repeat(64))],
    ] {
        batch(&d, &[block(A, v)], None).unwrap();
        assert_eq!(project(&d).unwrap().sources, identities);
        restore(&d);
    }
    set(
        &d,
        4,
        B,
        arr(vec![
            Any::from("ext:opaque"),
            obj(vec![("opaque", Any::Bool(true))]),
        ]),
    );
    let raw = field(&d, B, "tuple");
    restore(&d);
    assert_eq!(
        field(&d, B, "presentation"),
        arr(vec![Any::from("paragraph")])
    );
    stable(
        &d,
        || batch(&d, &[code(A, "rust"), code(B, "rust")], None),
        "unsupported-target",
    );
    assert_eq!(field(&d, B, "tuple"), raw);
}
#[test]
fn malformed_known_tuples_reject_admission_and_whole_preparation() {
    let d = seed();
    for v in [
        vec![Any::from("code")],
        vec![Any::from("code"), Any::Null],
        vec![Any::from("code"), Any::from("x".repeat(65))],
        vec![Any::from("code"), Any::from("é")],
        vec![Any::from("code"), Any::from("a b")],
        vec![Any::from("code"), Any::from("rust\n")],
        vec![Any::from("heading"), Any::from(0u32)],
        vec![Any::from("heading"), Any::from(7u32)],
        vec![Any::from("heading"), Any::from(1.5f64)],
        vec![Any::from("paragraph"), Any::Null],
        vec![Any::from("separator"), Any::Null],
    ] {
        let r = fork(&d, 21);
        set(&r, 4, A, arr(v.clone()));
        stable(&d, || admit(&d, &envelope(), &bytes(&r)), "invalid-tuple");
        stable(
            &d,
            || batch(&d, &[code(B, "rust"), block(A, v)], None),
            "invalid-tuple",
        );
    }
}
#[test]
fn literal_newlines_whitespace_dormant_marks_and_paragraph_restoration() {
    let d = seed();
    let id = identity(&d, A);
    let old = field(&d, A, "runs");
    batch(&d, &[code(A, "rust"), insert(A, 1, " \t\n\nX\n")], None).unwrap();
    assert_eq!(plain(&d, A), "a \t\n\nX\n😀b");
    let Any::Array(r) = field(&d, A, "runs") else {
        panic!()
    };
    assert!(r.iter().any(|r|matches!(r,Any::Map(r) if r["insert"]==Any::from(" \t\n\nX\n") && r["attributes"]==obj(vec![]))));
    let Any::Array(r) = rendered_runs(&d, A).unwrap() else {
        panic!()
    };
    assert!(
        r.iter()
            .all(|r| matches!(r,Any::Map(r) if r["attributes"]==obj(vec![])))
    );
    stable(
        &d,
        || batch(&d, &[mark(B), mark(A)], None),
        "unsupported-target",
    );
    batch(&d, &[block(A, vec![Any::from("paragraph")])], None).unwrap();
    assert_eq!(identity(&d, A), id);
    let Any::Array(old) = old else { panic!() };
    let Any::Map(old) = &old[0] else { panic!() };
    let Any::Array(now) = rendered_runs(&d, A).unwrap() else {
        panic!()
    };
    assert!(
        now.iter()
            .any(|r| matches!(r,Any::Map(r) if r["attributes"]==old["attributes"]))
    );
    restore(&d);
}
#[test]
fn empty_code_and_blank_lines_restore_without_reseeding() {
    let d = one();
    let id = identity(&d, A);
    batch(&d, &[code(A, "")], None).unwrap();
    restore(&d);
    batch(&d, &[insert(A, 0, "\n\n \t\n")], None).unwrap();
    assert_eq!(plain(&d, A), "\n\n \t\n");
    restore(&d);
    assert_eq!(identity(&d, A), id);
    assert_eq!(project(&d).unwrap().owners.len(), 1);
}
#[test]
fn code_explicit_split_join_endpoints_empty_and_multisource_identity() {
    for offset in [0, 1, 4] {
        let d = seed();
        batch(&d, &[code(A, "rs")], None).unwrap();
        let id = identity(&d, A);
        split(&d, "o:21:1", A, 0, offset).unwrap();
        assert_eq!(
            field(&d, "o:21:1", "tuple"),
            arr(vec![Any::from("code"), Any::from("rs")])
        );
        join(&d, "o:21:2", A, "o:21:1").unwrap();
        assert_eq!(plain(&d, A), "a😀b");
        assert_eq!(identity(&d, A), id);
        restore(&d);
    }
    let d = seed();
    batch(&d, &[code(A, "rs"), code(B, "rs"), code(D, "")], None).unwrap();
    let ids = project(&d).unwrap().sources;
    join(&d, "o:21:1", A, B).unwrap();
    split(&d, "o:21:2", A, 1, 1).unwrap();
    join(&d, "o:21:3", A, "o:21:2").unwrap();
    split(&d, "o:21:4", D, 0, 0).unwrap();
    join(&d, "o:21:5", D, "o:21:4").unwrap();
    assert_eq!(project(&d).unwrap().sources, ids);
    assert_eq!(plain(&d, A), "a😀bcאבd");
    restore(&d);
}
#[test]
fn mismatched_language_code_rich_and_separator_joins_fail_without_mutation() {
    let d = seed();
    batch(
        &d,
        &[
            code(A, "rust"),
            code(B, "js"),
            block(D, vec![Any::from("separator")]),
        ],
        None,
    )
    .unwrap();
    stable(&d, || join(&d, "o:21:1", A, B), "ineligible-operation");
    batch(&d, &[block(B, vec![Any::from("paragraph")])], None).unwrap();
    stable(&d, || join(&d, "o:21:1", A, B), "ineligible-operation");
    stable(&d, || join(&d, "o:21:1", C, D), "unsupported-target");
    stable(&d, || join(&d, "o:21:1", D, C), "unsupported-target");
    stable(&d, || join(&d, "o:21:1", A, D), "unsupported-target");
}
#[test]
fn separator_nonempty_conversion_and_text_mark_split_join_targets_reject() {
    let d = seed();
    stable(
        &d,
        || {
            batch(
                &d,
                &[code(B, "rs"), block(A, vec![Any::from("separator")])],
                None,
            )
        },
        "nonempty-separator",
    );
    let id = identity(&d, D);
    batch(&d, &[block(D, vec![Any::from("separator")])], None).unwrap();
    assert_eq!(identity(&d, D), id);
    for c in [insert(D, 0, "x"), mark(D)] {
        stable(&d, || batch(&d, &[c], None), "unsupported-target");
    }
    stable(&d, || split(&d, "o:21:1", D, 0, 0), "unsupported-target");
    restore(&d);
}
#[test]
fn last_editable_convert_delete_insert_reserve_accessible_adjacent_paragraph_atomically() {
    for kind in 0..3 {
        let d = one();
        if kind == 2 {
            set(&d, 4, A, arr(vec![Any::from("separator")]));
        }
        let c = match kind {
            0 => block(A, vec![Any::from("separator")]),
            1 => Command::Delete { owner: A.into() },
            _ => Command::Separator {
                id: "n:21:2".into(),
                parent: "@root".into(),
                before: None,
                place: "o:21:2".into(),
            },
        };
        stable(
            &d,
            || batch(&d, &[c.clone()], None),
            "missing-editable-neighbor",
        );
        let before = bytes(&d);
        let p = prepare(&d, &[c], Some(&neighbor())).unwrap();
        assert_eq!(bytes(&d), before);
        let count = Arc::new(AtomicUsize::new(0));
        let copy = count.clone();
        let _sub = d
            .observe_update_v1("policy-proof", move |_, _| {
                copy.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
        commit(&d, p).unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let v = project(&d).unwrap();
        let n = v.owners.iter().find(|o| o.id == "n:21:1").unwrap();
        assert!(!n.deleted);
        assert_eq!(n.parent, "@root");
        assert_eq!(n.attrs, arr(vec![Any::from("paragraph")]));
        assert_eq!(plain(&d, "n:21:1"), "");
        batch(&d, &[insert("n:21:1", 0, "accessible")], None).unwrap();
        restore(&d);
    }
}
#[test]
fn empty_heading_and_code_count_as_editable_no_unnecessary_neighbor() {
    for tuple in [
        vec![Any::from("heading"), Any::from(6u32)],
        vec![Any::from("code"), Any::from("")],
    ] {
        let d = one();
        batch(
            &d,
            &[
                block(A, tuple),
                Command::Separator {
                    id: "n:21:2".into(),
                    parent: "@root".into(),
                    before: None,
                    place: "o:21:2".into(),
                },
            ],
            None,
        )
        .unwrap();
        assert_eq!(project(&d).unwrap().sources.len(), 2);
        assert!(!project(&d).unwrap().sources.contains_key("n:21:1"));
        restore(&d);
    }
}
#[test]
fn neighbor_identity_operation_and_resource_failures_leave_no_partial_separator() {
    let d = one();
    let c = block(A, vec![Any::from("separator")]);
    for (n, e) in [
        (
            Neighbor {
                id: A.into(),
                place: "o:21:1".into(),
            },
            "reused-id",
        ),
        (
            Neighbor {
                id: "n:0:1".into(),
                place: "o:21:1".into(),
            },
            "invalid-id",
        ),
        (
            Neighbor {
                id: "n:21:1".into(),
                place: "o:0:1".into(),
            },
            "invalid-id",
        ),
    ] {
        stable(&d, || batch(&d, &[c.clone()], Some(&n)), e);
    }
    // 4096 immutable registrations; reserving another original must fail atomically.
    let d = one();
    {
        let mut t = d.transact_mut();
        for n in 1..=4095 {
            let k = format!("c:31:{n}");
            t.get_map(ROOTS[0])
                .unwrap()
                .insert(&mut t, k.clone(), "quote");
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                k.clone(),
                arr(vec![Any::from("@root"), Any::from(n)]),
            );
            t.get_map(ROOTS[7])
                .unwrap()
                .insert(&mut t, k, arr(vec![Any::from("quote")]));
        }
    }
    stable(&d, || batch(&d, &[c], Some(&neighbor())), "resource-limit");
}
#[test]
fn stale_preparation_utf16_and_oversized_literal_batch_are_atomic() {
    let d = seed();
    let p = prepare(&d, &[code(A, "rs")], None).unwrap();
    text(&d, B).insert(&mut d.transact_mut_with("remote"), 0, "R");
    stable(&d, || commit(&d, p), "stale-preparation");
    stable(
        &d,
        || batch(&d, &[code(A, "rs"), insert(A, 2, "x")], None),
        "invalid-cut",
    );
    stable(
        &d,
        || {
            batch(
                &d,
                &[code(A, "rs"), insert(A, 1, &"x".repeat(262145))],
                None,
            )
        },
        "resource-limit",
    );
}
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn races() -> (yrs::Doc, Vec<Vec<u8>>) {
    let base = seed();
    batch(&base, &[code(A, "base")], None).unwrap();
    let sv = base.transact().state_vector();
    let mut updates = vec![];
    for writer in [21, 22, 23] {
        let d = fork(&base, writer);
        match writer {
            21 => batch(&d, &[code(A, "rust"), insert(A, 1, " \n\n")], None).unwrap(),
            22 => batch(&d, &[code(A, "js"), insert(A, 4, "\tR")], None).unwrap(),
            _ => {
                text(&d, A).format(
                    &mut d.transact_mut_with("remote:rich"),
                    0,
                    1,
                    std::collections::HashMap::from([("ext:remote".into(), Any::Bool(true))]),
                );
            }
        }
        updates.push(d.transact().encode_state_as_update_v1(&sv));
    }
    (base, updates)
}
fn permutations(base: &yrs::Doc, updates: &[Vec<u8>]) -> Any {
    let mut expected = None;
    for p in PERMS {
        let d = fork(base, 55);
        for i in p.into_iter().chain(p) {
            admit(&d, &envelope(), &updates[i]).unwrap();
        }
        let s = snapshot(&d).unwrap();
        assert_eq!(plain(&d, A), "a \n\n😀b\tR");
        assert_eq!(
            field(&d, A, "tuple"),
            arr(vec![Any::from("code"), Any::from("js")])
        );
        assert_eq!(identity(&d, A), identity(base, A));
        restore(&d);
        if let Some(e) = &expected {
            assert_eq!(e, &s);
        } else {
            expected = Some(s);
        }
    }
    expected.unwrap()
}
#[test]
fn three_replica_duplicate_reordered_metadata_literal_and_remote_mark_races() {
    let (base, u) = races();
    permutations(&base, &u);
}
fn chain(d: &yrs::Doc, writer: u32) {
    batch(
        d,
        &[
            code(A, "rust"),
            insert(A, 1, " \t\n\nX\n"),
            code(B, "rust"),
            block(D, vec![Any::from("separator")]),
        ],
        None,
    )
    .unwrap();
    split(d, &format!("o:{writer}:1"), A, 0, 1).unwrap();
    join(d, &format!("o:{writer}:2"), A, &format!("o:{writer}:1")).unwrap();
    join(d, &format!("o:{writer}:3"), A, B).unwrap();
    split(d, &format!("o:{writer}:4"), A, 1, 1).unwrap();
    join(d, &format!("o:{writer}:5"), A, &format!("o:{writer}:4")).unwrap();
}
#[test]
fn pinned_bidirectional_block_kinds_exchange_complete_policies_races_and_restore() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::var_os("EDITAC_BLOCK_KINDS_EXCHANGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("../architecture/evidence/engine-block-kinds/exchange"));
    fs::create_dir_all(&dir).unwrap();
    let d = seed();
    fs::write(dir.join("rust-seed.bin"), bytes(&d)).unwrap();
    fs::write(dir.join("rust-seed.json"), json(&snapshot(&d).unwrap())).unwrap();
    let anchor = text(&d, A)
        .sticky_index(&d.transact(), 1, Assoc::After)
        .unwrap()
        .encode_v1();
    fs::write(dir.join("rust-anchor.bin"), anchor).unwrap();
    chain(&d, 21);
    fs::write(dir.join("rust-chain.bin"), bytes(&d)).unwrap();
    fs::write(dir.join("rust-chain.json"), json(&snapshot(&d).unwrap())).unwrap();
    let (base, u) = races();
    fs::write(dir.join("rust-race-base.bin"), bytes(&base)).unwrap();
    for (i, b) in u.iter().enumerate() {
        fs::write(dir.join(format!("rust-race-{i}.bin")), b).unwrap();
    }
    fs::write(dir.join("rust-race.json"), json(&permutations(&base, &u))).unwrap();
    let result = Process::new("node")
        .arg("--test")
        .arg(root.join("fixtures/schema-v4/block-kinds-exchange.mjs"))
        .env("EDITAC_BLOCK_KINDS_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "inspect {}",
        dir.join("node.log").display()
    );
    for name in ["js-independent", "js-chain", "js-neighbor", "js-race"] {
        let b = fs::read(dir.join(format!("{name}.bin"))).unwrap();
        let expected =
            Any::from_json(&fs::read_to_string(dir.join(format!("{name}.json"))).unwrap()).unwrap();
        let d = replica(59);
        admit(&d, &envelope(), &b).unwrap();
        admit(&d, &envelope(), &b).unwrap();
        assert_eq!(snapshot(&d).unwrap(), expected, "{name}");
        restore(&d);
        fs::write(
            dir.join(format!("{name}-rust.json")),
            json(&snapshot(&d).unwrap()),
        )
        .unwrap();
    }
    // A real JS-produced race is replayed against its shared checkpoint in all orders.
    let base = replica(60);
    admit(
        &base,
        &envelope(),
        &fs::read(dir.join("js-race-base.bin")).unwrap(),
    )
    .unwrap();
    let u = (0..3)
        .map(|i| fs::read(dir.join(format!("js-race-{i}.bin"))).unwrap())
        .collect::<Vec<_>>();
    let s = permutations(&base, &u);
    assert_eq!(
        s,
        Any::from_json(&fs::read_to_string(dir.join("js-race.json")).unwrap()).unwrap()
    );
}
#[test]
fn nested_last_owner_neighbor_keeps_parent_adjacent_and_original_identity() {
    let d = seed();
    for key in [A, B, C] {
        set(&d, 3, key, Any::Bool(true));
    }
    let id = identity(&d, D);
    batch(
        &d,
        &[block(D, vec![Any::from("separator")])],
        Some(&neighbor()),
    )
    .unwrap();
    let v = project(&d).unwrap();
    let at = v.owners.iter().position(|o| o.id == D).unwrap();
    assert_eq!(v.owners[at + 1].id, "n:21:1");
    assert_eq!(v.owners[at + 1].parent, "c:11:3");
    assert_eq!(identity(&d, D), id);
    restore(&d);
}
#[test]
fn empty_derived_separator_retains_original_span_and_typed_target_policy() {
    let d = seed();
    split(&d, "o:21:1", D, 0, 0).unwrap();
    let id = identity(&d, D);
    batch(&d, &[block("o:21:1", vec![Any::from("separator")])], None).unwrap();
    assert_eq!(identity(&d, D), id);
    assert_eq!(
        field(&d, "o:21:1", "spans"),
        arr(vec![arr(vec![
            Any::from(D),
            Any::from(0u32),
            Any::from(0u32)
        ])])
    );
    stable(
        &d,
        || batch(&d, &[insert("o:21:1", 0, "x")], None),
        "unsupported-target",
    );
    restore(&d);
}
