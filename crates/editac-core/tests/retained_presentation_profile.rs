//! ENG-1.22 isolated v5 qualification. Production integration remains ENG-1.23.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
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
use yrs::types::ToJson;
use yrs::updates::encoder::Encode;
use yrs::{Any, Assoc, IndexedSequence, Map, ReadTxn, Text, Transact};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const J: &str = "o:21:1";
const S: &str = "o:21:2";
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn tuple_json(s: &str) -> Any {
    Any::from_json(s).unwrap()
}
fn block(owner: &str, s: &str) -> Command {
    Command::Block {
        owner: owner.into(),
        tuple: tuple_json(s),
    }
}
fn code(owner: &str, language: &str) -> Command {
    Command::Block {
        owner: owner.into(),
        tuple: arr(vec![Any::from("code"), Any::from(language)]),
    }
}
fn replace(owner: &str, offset: u32, len: u32, value: &str) -> Command {
    Command::Replace {
        owner: owner.into(),
        offset,
        len,
        value: value.into(),
    }
}
fn owner(d: &yrs::Doc, key: &str) -> Owner {
    project(d)
        .unwrap()
        .owners
        .into_iter()
        .find(|o| o.id == key && !o.deleted)
        .unwrap()
}
fn field(d: &yrs::Doc, key: &str, field: &str) -> Any {
    let Any::Map(v) = snapshot(d).unwrap() else {
        panic!()
    };
    let Any::Array(nodes) = &v["visible"] else {
        panic!()
    };
    nodes
        .iter()
        .find_map(|n| match n {
            Any::Map(n) if n["id"] == Any::from(key) => Some(n[field].clone()),
            _ => None,
        })
        .unwrap()
}
fn plain(d: &yrs::Doc, key: &str) -> String {
    let Any::Array(runs) = field(d, key, "runs") else {
        panic!()
    };
    runs.iter()
        .map(|r| {
            let Any::Map(r) = r else { panic!() };
            let Any::String(s) = &r["insert"] else {
                panic!()
            };
            s.to_string()
        })
        .collect()
}
fn structural(d: &yrs::Doc, key: &str) -> (String, String, Vec<Span>) {
    let o = owner(d, key);
    (o.version, o.parent, o.spans)
}
fn anchor(d: &yrs::Doc, source: &str, offset: u32) -> Vec<u8> {
    text(d, source)
        .sticky_index(&d.transact(), offset, Assoc::After)
        .or_else(|| text(d, source).sticky_index(&d.transact(), offset, Assoc::Before))
        .unwrap()
        .encode_v1()
}
fn stable(d: &yrs::Doc, f: impl FnOnce() -> Result<()>) {
    let b = bytes(d);
    let sv = d.transact().state_vector();
    let s = snapshot(d).unwrap();
    assert!(f().is_err());
    assert_eq!(bytes(d), b);
    assert_eq!(d.transact().state_vector(), sv);
    assert_eq!(snapshot(d).unwrap(), s);
}
fn restored(d: &yrs::Doc) {
    let r = restore_checkpoint(&envelope(), true, &bytes(d), 59).unwrap();
    assert_eq!(snapshot(&r).unwrap(), snapshot(d).unwrap());
}
fn joined() -> yrs::Doc {
    let d = seed();
    batch(&d, &[code(A, "rs"), code(B, "rs")], None).unwrap();
    join(&d, J, A, B).unwrap();
    d
}
fn set_control(d: &yrs::Doc, id: &str, enabled: bool) {
    set(
        d,
        9,
        id,
        arr(vec![Any::from("enabled"), Any::Bool(enabled)]),
    );
}
fn record(d: &yrs::Doc, id: &str) -> Any {
    d.transact()
        .get_map(ROOTS[5])
        .unwrap()
        .get(&d.transact(), id)
        .unwrap()
        .to_json(&d.transact())
}
fn write(dir: &std::path::Path, name: &str, d: &yrs::Doc) {
    fs::write(dir.join(format!("{name}.bin")), bytes(d)).unwrap();
    fs::write(
        dir.join(format!("{name}.json")),
        json(&snapshot(d).unwrap()),
    )
    .unwrap();
}

#[test]
fn exact_v5_descriptor_envelope_ten_roots_and_witness_shapes() {
    let profile = Any::from_json(include_str!("../../../fixtures/schema-v5/profile.json")).unwrap();
    let Any::Map(profile) = profile else { panic!() };
    assert_eq!(profile["profile"], Any::from("editac.yrs-yjs.editor.v5"));
    assert_eq!(profile["schema"], Any::from("editac.registry.editor.v5"));
    assert_eq!(
        profile["roots"],
        arr(ROOTS.iter().map(|r| Any::from(*r)).collect())
    );
    let d = joined();
    split(&d, S, A, 1, 1).unwrap();
    for (id, kind) in [(J, "join"), (S, "split")] {
        let Any::Array(a) = record(&d, id) else {
            panic!()
        };
        assert_eq!(a.len(), 7);
        assert_eq!(a[0], Any::from(kind));
        assert_eq!(a[6], tuple_json("[\"code\",\"rs\"]"));
        if kind == "join" {
            assert_eq!(a[5], a[6]);
        }
    }
    restored(&d);
}

#[test]
fn established_join_survives_paragraph_heading_language_and_opaque_metadata() {
    for tuple in [
        "[\"paragraph\"]",
        "[\"heading\",6]",
        "[\"code\",\"js\"]",
        "[\"ext:opaque\",{\"retained\":true}]",
    ] {
        let d = joined();
        let state = structural(&d, A);
        let sources = project(&d).unwrap().sources;
        let op = record(&d, J);
        let a = anchor(&d, B, 1);
        set(&d, 4, A, tuple_json(tuple));
        assert_eq!(structural(&d, A), state);
        assert_eq!(project(&d).unwrap().sources, sources);
        assert_eq!(record(&d, J), op);
        assert_eq!(project(&d).unwrap().outcomes[J], "applied");
        assert!(!project(&d).unwrap().owners.iter().any(|o| o.id == B));
        assert_eq!(plain(&d, A), "a😀bcאבd");
        assert_eq!(resolve(&d, B, &a).unwrap(), (A.into(), 5, false));
        assert_eq!(field(&d, A, "runs"), field(&joined(), A, "runs"));
        restored(&d);
    }
}

#[test]
fn original_positive_cross_source_literal_replace_delete_and_paragraph_conversion_commit_once() {
    let d = joined();
    let ids = project(&d).unwrap().sources;
    let b_anchor = anchor(&d, B, 4);
    let before = Arc::new(AtomicUsize::new(0));
    let n = before.clone();
    let _sub = d
        .observe_update_v1("v5-commit-proof", move |_, _| {
            n.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
    batch(&d, &[replace(A, 3, 3, "\n\n")], None).unwrap();
    assert_eq!(before.load(Ordering::SeqCst), 1);
    assert_eq!(plain(&d, A), "a😀\n\nבd");
    let Any::Array(runs) = rendered_runs(&d, A).unwrap() else {
        panic!()
    };
    for r in runs.iter() {
        let Any::Map(r) = r else { panic!() };
        assert_eq!(r["attributes"], obj(vec![]));
    }
    let retained = field(&d, A, "runs");
    let Any::Array(runs) = retained else { panic!() };
    assert!(runs.iter().any(|r|matches!(r,Any::Map(r) if r["insert"]==Any::from("\n\n") && r["attributes"]==obj(vec![]))));
    let state = owner(&d, A);
    before.store(0, Ordering::SeqCst);
    batch(
        &d,
        &[replace(A, 3, 2, ""), block(A, "[\"paragraph\"]")],
        None,
    )
    .unwrap();
    assert_eq!(before.load(Ordering::SeqCst), 1);
    let after = owner(&d, A);
    assert_eq!((after.version, after.parent), (state.version, state.parent));
    assert_eq!(plain(&d, A), "a😀בd");
    assert_eq!(resolve(&d, B, &b_anchor).unwrap(), (A.into(), 5, false));
    for (id, original) in ids {
        let Any::Map(original) = original else {
            panic!()
        };
        let Any::Map(actual) = project(&d).unwrap().sources[&id].clone() else {
            panic!()
        };
        assert_eq!(actual["identity"], original["identity"]);
    }
    let Any::Array(runs) = rendered_runs(&d, A).unwrap() else {
        panic!()
    };
    assert!(runs.iter().all(|r|matches!(r,Any::Map(r) if matches!(&r["attributes"],Any::Map(a) if a.get("bold")==Some(&Any::Bool(true))))));
    restored(&d);
}

#[test]
fn split_derived_empty_and_inherited_owners_survive_later_presentation_changes() {
    for offset in [0, 1, 4] {
        let d = seed();
        batch(&d, &[code(A, "rs")], None).unwrap();
        split(&d, S, A, 0, offset).unwrap();
        let left = structural(&d, A);
        let right = structural(&d, S);
        let sources = project(&d).unwrap().sources;
        batch(&d, &[code(A, "js"), block(S, "[\"heading\",2]")], None).unwrap();
        assert_eq!(structural(&d, A), left);
        assert_eq!(structural(&d, S), right);
        assert_eq!(project(&d).unwrap().sources, sources);
        let empty = if offset == 0 {
            Some(A)
        } else if offset == 4 {
            Some(S)
        } else {
            None
        };
        if let Some(key) = empty {
            batch(&d, &[block(key, "[\"separator\"]")], None).unwrap();
            assert_eq!(project(&d).unwrap().outcomes[S], "applied");
        }
        set(&d, 4, S, tuple_json("[\"ext:opaque\",{\"derived\":true}]"));
        assert_eq!(structural(&d, S), right);
        restored(&d);
    }
    let d = joined();
    split(&d, S, A, 1, 1).unwrap();
    let state = structural(&d, S);
    batch(&d, &[code(A, "new")], None).unwrap();
    assert_eq!(owner(&d, S).attrs, tuple_json("[\"code\",\"new\"]"));
    assert_eq!(structural(&d, S), state);
}

#[test]
fn three_source_join_split_after_join_and_later_metadata_preserve_all_sources() {
    let d = joined();
    place(&d, "o:21:3", C, "c:11:1", None).unwrap();
    batch(&d, &[code(C, "rs")], None).unwrap();
    join(&d, "o:21:4", A, C).unwrap();
    assert_eq!(owner(&d, A).spans.len(), 3);
    split(&d, S, A, 1, 1).unwrap();
    let state = structural(&d, A);
    let right = structural(&d, S);
    let sources = project(&d).unwrap().sources;
    set(&d, 4, A, tuple_json("[\"heading\",1]"));
    set(&d, 4, S, tuple_json("[\"ext:opaque\"]"));
    assert_eq!(structural(&d, A), state);
    assert_eq!(structural(&d, S), right);
    assert_eq!(project(&d).unwrap().sources, sources);
    assert_eq!(plain(&d, A), "a😀bc");
    assert_eq!(plain(&d, S), "אבdéZ");
    restored(&d);
}

#[test]
fn fresh_mismatched_code_ordinary_separator_opaque_and_container_commands_reject_atomically() {
    for (a, b) in [
        ("[\"code\",\"rs\"]", "[\"code\",\"js\"]"),
        ("[\"code\",\"rs\"]", "[\"paragraph\"]"),
        ("[\"paragraph\"]", "[\"code\",\"rs\"]"),
        ("[\"ext:opaque\"]", "[\"paragraph\"]"),
    ] {
        let d = seed();
        set(&d, 4, A, tuple_json(a));
        set(&d, 4, B, tuple_json(b));
        stable(&d, || join(&d, J, A, B));
    }
    let d = seed();
    set(&d, 4, D, tuple_json("[\"separator\"]"));
    stable(&d, || split(&d, S, D, 0, 0));
    stable(&d, || join(&d, J, C, D));
    set(&d, 4, A, tuple_json("[\"ext:opaque\"]"));
    stable(&d, || split(&d, S, A, 0, 0));
    stable(&d, || split(&d, S, "c:11:1", 0, 0));
    stable(&d, || join(&d, J, "c:11:1", A));
    let d = seed();
    set(&d, 3, A, Any::Bool(true));
    stable(&d, || split(&d, S, A, 0, 0));
}

#[test]
fn paragraph_heading_witness_pairs_and_code_language_bounds_pass() {
    for (a, b) in [
        ("[\"paragraph\"]", "[\"heading\",6]"),
        ("[\"heading\",1]", "[\"heading\",6]"),
        ("[\"code\",\"\"]", "[\"code\",\"\"]"),
        ("[\"code\",\"C++._-\"]", "[\"code\",\"C++._-\"]"),
    ] {
        let d = seed();
        set(&d, 4, A, tuple_json(a));
        set(&d, 4, B, tuple_json(b));
        join(&d, J, A, B).unwrap();
        assert_eq!(plain(&d, A), "a😀bcאבd");
        restored(&d);
    }
    let d = seed();
    let lang = "x".repeat(64);
    batch(&d, &[code(A, &lang), code(B, &lang)], None).unwrap();
    join(&d, J, A, B).unwrap();
    restored(&d);
}

#[test]
fn malformed_arity_witness_values_and_forged_incompatible_witnesses_reject_admission() {
    let d = joined();
    let Any::Array(valid) = record(&d, J) else {
        panic!()
    };
    let mut rows = vec![];
    rows.push(arr(valid[..5].to_vec()));
    let mut extra = valid.to_vec();
    extra.push(Any::Null);
    rows.push(arr(extra));
    for bad in [
        "null",
        "[\"separator\"]",
        "[\"ext:opaque\"]",
        "[\"paragraph\",0]",
        "[\"heading\",0]",
        "[\"heading\",7]",
        "[\"code\",\"bad space\"]",
        "[\"code\",7]",
        "[\"code\",\"é\"]",
    ] {
        let mut r = valid.to_vec();
        r[5] = tuple_json(bad);
        rows.push(arr(r));
    }
    for bad in ["[\"paragraph\"]", "[\"code\",\"js\"]"] {
        let mut r = valid.to_vec();
        r[6] = tuple_json(bad);
        rows.push(arr(r));
    }
    let mut r = valid.to_vec();
    r[5] = arr(vec![Any::from("code"), Any::from("x".repeat(65))]);
    rows.push(arr(r));
    for row in rows {
        let source = seed();
        set(&source, 5, J, row);
        let live = seed();
        stable(&live, || admit(&live, &envelope(), &bytes(&source)));
    }
    let d = joined();
    split(&d, S, A, 0, 1).unwrap();
    let Any::Array(valid) = record(&d, S) else {
        panic!()
    };
    for row in [
        arr(valid[..6].to_vec()),
        {
            let mut r = valid.to_vec();
            r[6] = tuple_json("[\"separator\"]");
            arr(r)
        },
        {
            let mut r = valid.to_vec();
            r[5] = Any::Buffer(vec![0xff].into());
            arr(r)
        },
    ] {
        let source = joined();
        set(&source, 5, S, row);
        let live = joined();
        stable(&live, || admit(&live, &envelope(), &bytes(&source)));
    }
}

#[test]
fn admission_does_not_compare_authored_witnesses_with_current_presentation() {
    let source = seed();
    join(&source, J, A, B).unwrap();
    set(&source, 4, A, tuple_json("[\"code\",\"rs\"]"));
    set(&source, 4, B, tuple_json("[\"code\",\"js\"]"));
    let live = replica(61);
    admit(&live, &envelope(), &bytes(&source)).unwrap();
    assert_eq!(project(&live).unwrap().outcomes[J], "applied");
    assert_eq!(plain(&live, A), "a😀bcאבd");
    restored(&live);
    // Witness declaration is not provenance; compatible authored values differing from final tuples are admissible.
    let Any::Array(row) = record(&source, J) else {
        panic!()
    };
    let mut r = row.to_vec();
    r[5] = tuple_json("[\"heading\",2]");
    r[6] = tuple_json("[\"paragraph\"]");
    set(&source, 5, J, arr(r));
    let fresh = replica(62);
    admit(&fresh, &envelope(), &bytes(&source)).unwrap();
    assert_eq!(project(&fresh).unwrap().outcomes[J], "applied");
}

#[test]
fn invalid_mixed_batches_stale_preparation_unicode_and_resources_never_partially_apply() {
    let d = joined();
    for bad in [
        "[\"heading\",7]",
        "[\"code\",\"bad space\"]",
        "[\"separator\"]",
    ] {
        stable(&d, || {
            batch(&d, &[replace(A, 0, 1, "R"), block(A, bad)], None)
        });
    }
    stable(&d, || {
        batch(
            &d,
            &[
                replace(A, 0, 1, "R"),
                Command::Mark {
                    owner: A.into(),
                    span: 0,
                    offset: 0,
                    len: 1,
                },
            ],
            None,
        )
    });
    stable(&d, || {
        batch(
            &d,
            &[
                replace(A, 0, 1, "R"),
                Command::Join {
                    op: S.into(),
                    left: A.into(),
                    right: C.into(),
                },
            ],
            None,
        )
    });
    stable(&d, || {
        batch(
            &d,
            &[replace(A, 2, 1, "R"), block(A, "[\"paragraph\"]")],
            None,
        )
    });
    stable(&d, || {
        batch(
            &d,
            &[code(A, "js"), replace(A, 0, 0, &"x".repeat(1048577))],
            None,
        )
    });
    let p = prepare(&d, &[code(A, "js")], None).unwrap();
    text(&d, B).insert(&mut d.transact_mut_with("remote"), 0, "R");
    stable(&d, || commit(&d, p));
    let d = seed();
    stable(&d, || {
        batch(
            &d,
            &[
                replace(A, 0, 1, "R"),
                code(A, "rs"),
                Command::Join {
                    op: J.into(),
                    left: A.into(),
                    right: B.into(),
                },
            ],
            None,
        )
    });
    assert!(!project(&d).unwrap().outcomes.contains_key(J));
}

#[test]
fn immutable_witness_replacement_profile_epoch_root_and_checkpoint_limits_reject_atomically() {
    let d = joined();
    let offered = tuple_json(&json(&envelope()).replace("editor.v5", "editor.v4"));
    stable(&d, || admit(&d, &offered, &bytes(&d)));
    let offered = tuple_json(&json(&envelope()).replace(
        "88888888-8888-4888-8888-888888888888",
        "99999999-9999-4999-8999-999999999999",
    ));
    stable(&d, || admit(&d, &offered, &bytes(&d)));
    let source = fork(&d, 70);
    let Any::Array(row) = record(&source, J) else {
        panic!()
    };
    let mut r = row.to_vec();
    r[5] = tuple_json("[\"code\",\"js\"]");
    r[6] = r[5].clone();
    set(&source, 5, J, arr(r));
    stable(&d, || admit(&d, &envelope(), &bytes(&source)));
    let source = fork(&d, 71);
    source.get_or_insert_map("invented-root");
    set(&source, 4, A, tuple_json("[\"heading\",8]"));
    stable(&d, || admit(&d, &envelope(), &bytes(&source)));
    stable(&d, || admit(&d, &envelope(), &vec![0; 16777217]));
    assert!(restore_checkpoint(&envelope(), false, &bytes(&d), 73).is_err());
    assert!(restore_checkpoint(&envelope(), true, &bytes(&d), 0).is_err());
}

#[test]
fn reversible_controls_tombstones_remote_bytes_and_dependent_intentions_retain_identities() {
    let d = joined();
    split(&d, S, A, 1, 1).unwrap();
    let a = anchor(&d, B, 3);
    text(&d, B).insert(&mut d.transact_mut_with("remote"), 4, "R");
    let original = project(&d).unwrap().sources;
    let active = snapshot(&d).unwrap();
    set_control(&d, J, false);
    assert_eq!(project(&d).unwrap().outcomes[J], "disabled");
    assert_eq!(project(&d).unwrap().outcomes[S], "losing");
    restored(&d);
    set_control(&d, J, true);
    assert_eq!(snapshot(&d).unwrap(), {
        let Any::Map(mut s) = active else { panic!() };
        let mut map = s.as_ref().clone();
        map.insert(
            "controls".into(),
            obj(vec![(J, arr(vec![Any::from("enabled"), Any::Bool(true)]))]),
        );
        s = Arc::new(map);
        Any::Map(s)
    });
    assert_eq!(project(&d).unwrap().sources, original);
    assert_eq!(resolve(&d, B, &a).unwrap(), (S.into(), 2, false));
    set_control(&d, "c:11:1", false);
    assert_eq!(owner(&d, A).parent, "@root");
    set_control(&d, "c:11:1", true);
    assert_eq!(owner(&d, A).parent, "c:11:1");
    set(&d, 3, A, Any::Bool(true));
    set_control(&d, A, false);
    set_control(&d, A, true);
    assert!(
        project(&d)
            .unwrap()
            .owners
            .iter()
            .any(|o| o.id == A && o.deleted)
    );
    assert_eq!(project(&d).unwrap().sources, original);
    restored(&d);
}

#[test]
fn version_conflicts_earlier_ranked_intentions_and_deleted_targets_still_have_structural_effects() {
    let base = seed();
    let a = fork(&base, 21);
    join(&a, "o:21:1", A, B).unwrap();
    let b = fork(&base, 20);
    split(&b, "o:20:1", A, 0, 1).unwrap();
    let live = fork(&base, 72);
    admit(&live, &envelope(), &bytes(&a)).unwrap();
    assert_eq!(project(&live).unwrap().outcomes["o:21:1"], "applied");
    admit(&live, &envelope(), &bytes(&b)).unwrap();
    assert_eq!(project(&live).unwrap().outcomes["o:21:1"], "losing");
    assert_eq!(project(&live).unwrap().outcomes["o:20:1"], "applied");
    restored(&live);
    let source = joined();
    set(&source, 3, A, Any::Bool(true));
    assert_ne!(project(&source).unwrap().outcomes[J], "applied");
    restored(&source);
}

#[test]
fn established_place_survives_opaque_presentation_and_split_separator_conversion_is_nontrapping() {
    let d = seed();
    place(&d, "o:21:3", A, "c:11:4", None).unwrap();
    let state = structural(&d, A);
    set(&d, 4, A, tuple_json("[\"ext:opaque\"]"));
    assert_eq!(structural(&d, A), state);
    restored(&d);
    let d = seed();
    split(&d, S, D, 0, 0).unwrap();
    batch(
        &d,
        &[block(D, "[\"separator\"]"), block(S, "[\"separator\"]")],
        None,
    )
    .unwrap();
    assert_eq!(project(&d).unwrap().outcomes[S], "applied");
    batch(
        &d,
        &[
            Command::Delete { owner: A.into() },
            Command::Delete { owner: B.into() },
            Command::Delete { owner: C.into() },
        ],
        Some(&Neighbor {
            id: "n:21:1".into(),
            place: "o:21:4".into(),
        }),
    )
    .unwrap();
    assert_eq!(owner(&d, "n:21:1").attrs, tuple_json("[\"paragraph\"]"));
    assert_eq!(owner(&d, "n:21:1").parent, "c:11:3");
    restored(&d);
}

fn race_base(kind: &str) -> yrs::Doc {
    if kind == "join" {
        let d = seed();
        batch(&d, &[code(A, "rs"), code(B, "rs")], None).unwrap();
        d
    } else {
        joined()
    }
}
fn race_updates(kind: &str, base: &yrs::Doc) -> Vec<Vec<u8>> {
    let sv = base.transact().state_vector();
    (0..3)
        .map(|i| {
            let d = fork(base, 31 + i);
            match (kind, i) {
                ("join", 0) => join(&d, "o:31:1", A, B).unwrap(),
                ("join", 1) => batch(&d, &[code(A, "js")], None).unwrap(),
                ("join", 2) => batch(&d, &[block(B, "[\"heading\",2]")], None).unwrap(),
                ("split", 0) => split(&d, "o:31:1", A, 1, 1).unwrap(),
                ("split", 1) => batch(&d, &[block(A, "[\"paragraph\"]")], None).unwrap(),
                ("split", 2) => set(&d, 4, B, tuple_json("[\"ext:opaque\",{\"dormant\":true}]")),
                ("control", 0) => set_control(&d, J, false),
                ("control", 1) => batch(&d, &[code(A, "js")], None).unwrap(),
                ("control", 2) => text(&d, B).insert(&mut d.transact_mut_with("remote"), 4, "R"),
                _ => panic!(),
            };
            d.transact().encode_state_as_update_v1(&sv)
        })
        .collect()
}
fn permutations(base: &yrs::Doc, updates: &[Vec<u8>]) -> Any {
    let mut expected = None;
    for order in PERMS {
        let d = fork(base, 74);
        for i in order {
            admit(&d, &envelope(), &updates[i]).unwrap();
            admit(&d, &envelope(), &updates[i]).unwrap();
        }
        let actual = snapshot(&d).unwrap();
        restored(&d);
        if let Some(e) = &expected {
            assert_eq!(&actual, e);
        } else {
            expected = Some(actual);
        }
    }
    expected.unwrap()
}
#[test]
fn three_writer_metadata_structural_and_control_races_converge_in_all_duplicate_orders() {
    for kind in ["join", "split", "control"] {
        let base = race_base(kind);
        let updates = race_updates(kind, &base);
        let s = permutations(&base, &updates);
        let Any::Map(s) = s else { panic!() };
        let Any::Map(outcomes) = &s["outcomes"] else {
            panic!()
        };
        assert_eq!(
            outcomes[if kind == "control" { J } else { "o:31:1" }],
            Any::from(if kind == "control" {
                "disabled"
            } else {
                "applied"
            })
        );
    }
}

#[test]
fn pinned_bidirectional_witness_exchange_metadata_reordering_checkpoint_controls_and_anchors() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::var_os("EDITAC_RETAINED_EXCHANGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join("../architecture/evidence/engine-retained-presentation-profile/exchange")
        });
    fs::create_dir_all(&dir).unwrap();
    let base = seed();
    write(&dir, "rust-seed", &base);
    let d = joined();
    let a = anchor(&d, B, 1);
    fs::write(dir.join("rust-anchor.bin"), &a).unwrap();
    write(&dir, "rust-joined", &d);
    batch(&d, &[replace(A, 3, 3, "\n\n")], None).unwrap();
    write(&dir, "rust-replaced", &d);
    batch(
        &d,
        &[replace(A, 3, 2, ""), block(A, "[\"paragraph\"]")],
        None,
    )
    .unwrap();
    write(&dir, "rust-paragraph", &d);
    for (name, tuple) in [
        ("language", "[\"code\",\"js\"]"),
        ("opaque", "[\"ext:opaque\",{\"x\":true}]"),
    ] {
        let d = joined();
        set(&d, 4, A, tuple_json(tuple));
        write(&dir, &format!("rust-{name}"), &d);
    }
    let d = joined();
    split(&d, S, A, 1, 1).unwrap();
    batch(&d, &[code(A, "js"), block(S, "[\"heading\",2]")], None).unwrap();
    write(&dir, "rust-split", &d);
    set_control(&d, J, false);
    write(&dir, "rust-disabled", &d);
    set_control(&d, J, true);
    write(&dir, "rust-reenabled", &d);
    for kind in ["join", "split", "control"] {
        let base = race_base(kind);
        let updates = race_updates(kind, &base);
        write(&dir, &format!("rust-{kind}-base"), &base);
        for (i, u) in updates.iter().enumerate() {
            fs::write(dir.join(format!("rust-{kind}-{i}.bin")), u).unwrap();
        }
        fs::write(
            dir.join(format!("rust-{kind}-race.json")),
            json(&permutations(&base, &updates)),
        )
        .unwrap();
    }
    let result = Process::new("node")
        .args(["--test"])
        .arg(root.join("fixtures/schema-v5/exchange.mjs"))
        .env("EDITAC_RETAINED_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "pinned exchange failed; inspect {}",
        dir.join("node.log").display()
    );
    for name in [
        "seed",
        "joined",
        "replaced",
        "paragraph",
        "language",
        "opaque",
        "split",
        "disabled",
        "reenabled",
        "empty-separator",
    ] {
        let r = replica(81);
        admit(
            &r,
            &envelope(),
            &fs::read(dir.join(format!("js-{name}.bin"))).unwrap(),
        )
        .unwrap();
        admit(
            &r,
            &envelope(),
            &fs::read(dir.join(format!("js-{name}.bin"))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            snapshot(&r).unwrap(),
            Any::from_json(&fs::read_to_string(dir.join(format!("js-{name}.json"))).unwrap())
                .unwrap(),
            "JS {name}"
        );
        restored(&r);
    }
    let r = replica(82);
    admit(
        &r,
        &envelope(),
        &fs::read(dir.join("js-language.bin")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        resolve(&r, B, &fs::read(dir.join("js-anchor.bin")).unwrap()).unwrap(),
        (A.into(), 5, false)
    );
    for kind in ["join", "split", "control"] {
        let base = replica(83);
        admit(
            &base,
            &envelope(),
            &fs::read(dir.join(format!("js-{kind}-base.bin"))).unwrap(),
        )
        .unwrap();
        let updates = (0..3)
            .map(|i| fs::read(dir.join(format!("js-{kind}-{i}.bin"))).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            permutations(&base, &updates),
            Any::from_json(&fs::read_to_string(dir.join(format!("js-{kind}-race.json"))).unwrap())
                .unwrap()
        );
    }
}

#[test]
fn staged_structural_and_presentation_batch_captures_each_preparation_witness_and_rejects_invalid_tail()
 {
    let d = seed();
    let n = Arc::new(AtomicUsize::new(0));
    let copy = n.clone();
    let _sub = d
        .observe_update_v1("witness-batch", move |_, _| {
            copy.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
    batch(
        &d,
        &[
            code(A, "rs"),
            code(B, "rs"),
            Command::Join {
                op: J.into(),
                left: A.into(),
                right: B.into(),
            },
            Command::Split {
                op: S.into(),
                owner: A.into(),
                span: 1,
                offset: 1,
            },
            block(A, "[\"paragraph\"]"),
            code(S, "js"),
        ],
        None,
    )
    .unwrap();
    assert_eq!(n.load(Ordering::SeqCst), 1);
    assert_eq!(plain(&d, A), "a😀bc");
    assert_eq!(plain(&d, S), "אבd");
    let Any::Array(row) = record(&d, S) else {
        panic!()
    };
    assert_eq!(row[6], tuple_json("[\"code\",\"rs\"]"));
    stable(&d, || {
        batch(
            &d,
            &[
                replace(A, 0, 1, "R"),
                Command::Join {
                    op: "o:21:3".into(),
                    left: A.into(),
                    right: S.into(),
                },
            ],
            None,
        )
    });
    batch(
        &d,
        &[
            block(S, "[\"heading\",2]"),
            Command::Join {
                op: "o:21:3".into(),
                left: A.into(),
                right: S.into(),
            },
        ],
        None,
    )
    .unwrap();
    let Any::Array(row) = record(&d, "o:21:3") else {
        panic!()
    };
    assert_eq!(row[5], tuple_json("[\"paragraph\"]"));
    assert_eq!(row[6], tuple_json("[\"heading\",2]"));
    restored(&d);
    let fresh = seed();
    stable(&fresh, || {
        batch(
            &fresh,
            &[
                Command::Split {
                    op: S.into(),
                    owner: A.into(),
                    span: 0,
                    offset: 1,
                },
                block(S, "[\"heading\",9]"),
            ],
            None,
        )
    });
    assert!(!project(&fresh).unwrap().outcomes.contains_key(S));
}

#[test]
fn new_witnesses_share_exact_json_depth_binary_cut_id_and_operation_count_limits() {
    let valid = joined();
    let Any::Array(row) = record(&valid, J) else {
        panic!()
    };
    let mut deep = Any::Null;
    for _ in 0..34 {
        deep = arr(vec![deep]);
    }
    let mut r = row.to_vec();
    r[5] = arr(vec![Any::from("ext:witness"), deep]);
    let bad = seed();
    set(&bad, 5, J, arr(r));
    let live = seed();
    stable(&live, || admit(&live, &envelope(), &bytes(&bad)));
    let d = seed();
    split(&d, S, A, 0, 1).unwrap();
    let Any::Array(row) = record(&d, S) else {
        panic!()
    };
    for (index, value) in [
        (5, Any::Buffer(vec![0; 257].into())),
        (1, Any::from("n:0:1")),
        (2, Any::from("o:21:2")),
        (3, Any::from(-1_i32)),
    ] {
        let source = seed();
        let mut r = row.to_vec();
        r[index] = value;
        set(&source, 5, S, arr(r));
        stable(&live, || admit(&live, &envelope(), &bytes(&source)));
    }
    let source = seed();
    for i in 1..=4097 {
        set(
            &source,
            5,
            &format!("o:50:{i}"),
            arr(vec![
                Any::from("join"),
                Any::from(A),
                Any::from("base"),
                Any::from(B),
                Any::from("base"),
                tuple_json("[\"heading\",1]"),
                tuple_json("[\"paragraph\"]"),
            ]),
        );
    }
    stable(&live, || admit(&live, &envelope(), &bytes(&source)));
    let source = seed();
    set(&source, 4, A, tuple_json("[\"heading\",7]"));
    stable(&live, || admit(&live, &envelope(), &bytes(&source)));
}

#[test]
fn literal_insert_and_separator_insertion_keep_exact_source_identities_and_accessible_neighbors() {
    let d = joined();
    batch(
        &d,
        &[Command::Insert {
            owner: A.into(),
            span: 1,
            offset: 1,
            value: " \n\n".into(),
        }],
        None,
    )
    .unwrap();
    assert_eq!(plain(&d, A), "a😀bc \n\nאבd");
    batch(
        &d,
        &[Command::Separator {
            id: "n:21:1".into(),
            parent: "c:11:1".into(),
            before: Some(A.into()),
            place: "o:21:5".into(),
        }],
        None,
    )
    .unwrap();
    assert_eq!(owner(&d, "n:21:1").attrs, tuple_json("[\"separator\"]"));
    assert_eq!(owner(&d, A).spans.len(), 2);
    restored(&d);
}

#[test]
fn zero_start_container_tuple_and_invalid_starts_are_atomic_in_v5() {
    let d = seed();
    set(&d, 7, "c:11:3", tuple_json(r#"["ordered",0]"#));
    assert_eq!(field(&d, C, "number"), Any::from(0u32));
    assert_eq!(field(&d, D, "number"), Any::from(1u32));
    restored(&d);
    for invalid in [
        r#"["ordered",-1]"#,
        r#"["ordered",0.5]"#,
        r#"["ordered",2147483648]"#,
        r#"["ordered"]"#,
        r#"["ordered",0,null]"#,
        r#"["ordered","0"]"#,
    ] {
        let peer = fork(&d, 31);
        set(&peer, 7, "c:11:3", tuple_json(invalid));
        let before = bytes(&d);
        assert_eq!(admit(&d, &envelope(), &bytes(&peer)), Err("invalid-tuple"));
        assert_eq!(bytes(&d), before);
    }
}
