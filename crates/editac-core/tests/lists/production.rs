//! ENG-1.8: independent transitions over real production preparation/commit.
#[path = "../../../../fixtures/schema-v4/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{editor::*, lists::*, text::*},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
};
use std::{fs, path::PathBuf, process::Command};
use yrs::{Any, Map, ReadTxn, Text, Transact, XmlTextPrelim};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const E: &str = "n:11:4";
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn identity() -> DocumentIdentity {
    DocumentIdentity::v4(
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
            bytes: bytes.to_vec(),
        },
        &[],
    )
    .unwrap()
}
fn engine() -> Document {
    let d = m::replica(11);
    let mut t = d.transact_mut_with("fixture:lists");
    for (order, (id, text)) in [(A, "a😀ב"), (B, "éZ"), (C, "tail"), (E, "")]
        .into_iter()
        .enumerate()
    {
        t.get_map(m::ROOTS[0]).unwrap().insert(&mut t, id, "block");
        t.get_map(m::ROOTS[2]).unwrap().insert(
            &mut t,
            id,
            m::arr(vec![Any::from("@root"), Any::from(order as u32)]),
        );
        let x = t
            .get_map(m::ROOTS[1])
            .unwrap()
            .insert(&mut t, id, XmlTextPrelim::new(text));
        if !text.is_empty() {
            x.format(
                &mut t,
                0,
                text.encode_utf16().count() as u32,
                std::collections::HashMap::from([
                    ("bold".into(), Any::Bool(true)),
                    ("ext:future".into(), Any::from("kept")),
                ]),
            );
        }
        t.get_map(m::ROOTS[4])
            .unwrap()
            .insert(&mut t, id, m::arr(vec![Any::from("paragraph")]));
        t.get_map(m::ROOTS[6]).unwrap().insert(&mut t, id, true);
    }
    drop(t);
    restore(&m::bytes(&d))
}
fn origin() -> TextOrigin {
    TextOrigin::new("lists:explicit").unwrap()
}
fn batch(d: &mut Document, c: &[ListCommand]) -> ReplayUpdate {
    let before = d.checkpoint().bytes;
    let rev = d.revision();
    d.can_lists(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, before);
    let p = d.prepare_lists(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.revision(), rev);
    let result = d.commit_lists(p).unwrap();
    assert_eq!(result.revision, rev + 1);
    assert_eq!(result.origin, origin());
    result.update
}
fn wrap(d: &mut Document, targets: &[&str], style: ContainerStyle) -> String {
    let id = d.next_editor_id(true).unwrap();
    batch(
        d,
        &[ListCommand::Wrap {
            targets: targets.iter().map(|s| s.to_string()).collect(),
            style,
        }],
    );
    id
}
fn enter(d: &Document, id: &str, at: u32) -> ListCommand {
    ListCommand::Enter {
        owner: id.into(),
        at: d.anchor(id, U(at), Bias::Right).unwrap(),
    }
}
fn back(d: &Document, id: &str) -> ListCommand {
    ListCommand::Backspace {
        owner: id.into(),
        at: d.anchor(id, U(0), Bias::Right).unwrap(),
    }
}
fn children(d: &Document, parent: &str) -> Vec<String> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.parent == parent)
        .map(|n| n.id.clone())
        .collect()
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
fn value(d: &Document, id: &str) -> String {
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
fn number(d: &Document, id: &str) -> Option<u32> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .editor
        .as_ref()
        .unwrap()
        .number
}
fn checked(d: &Document, id: &str) -> Option<bool> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .editor
        .as_ref()
        .unwrap()
        .checked
}
fn canonical(d: &Document) -> Any {
    d.snapshot().unwrap().retained_structure.unwrap()
}
fn assert_stable(d: &Document, c: &[ListCommand]) {
    let old = d.checkpoint().bytes;
    let rev = d.revision();
    assert!(d.prepare_lists(c, &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, old);
    assert_eq!(d.revision(), rev);
}
fn sources(d: &Document) -> Any {
    let Any::Map(v) = canonical(d) else { panic!() };
    v["sources"].clone()
}
#[test]
fn all_modes_wrap_contiguous_siblings_and_number_without_projection_writes() {
    for mode in [
        ContainerStyle::Unordered,
        ContainerStyle::Ordered { start: 7 },
        ContainerStyle::Checklist,
        ContainerStyle::Quote,
    ] {
        let mut d = engine();
        let identities = sources(&d);
        let l = wrap(&mut d, &[A, B, C], mode.clone());
        assert_eq!(children(&d, "@root"), vec![l.clone(), E.into()]);
        assert_eq!(children(&d, &l), vec![A, B, C]);
        assert_eq!(sources(&d), identities);
        let bytes = d.checkpoint().bytes;
        assert_eq!(
            number(&d, A),
            if matches!(mode, ContainerStyle::Ordered { .. }) {
                Some(7)
            } else {
                None
            }
        );
        assert_eq!(
            checked(&d, A),
            if mode == ContainerStyle::Checklist {
                Some(false)
            } else {
                None
            }
        );
        assert_eq!(d.checkpoint().bytes, bytes);
        assert_eq!(canonical(&restore(&bytes)), canonical(&d));
    }
}
#[test]
fn nested_list_quote_wrapping_preserves_descendant_marks_and_anchor_identity() {
    let mut d = engine();
    let a = d.anchor(A, U(1), Bias::Left).unwrap();
    let identities = sources(&d);
    let l = wrap(&mut d, &[A, B], ContainerStyle::Checklist);
    let q = wrap(&mut d, &[&l, C], ContainerStyle::Quote);
    assert_eq!(children(&d, &q), vec![l.clone(), C.into()]);
    assert_eq!(children(&d, &l), vec![A, B]);
    assert_eq!(sources(&d), identities);
    assert!(matches!(
        d.resolve_anchor(&a).unwrap(),
        Resolution::Position(_)
    ));
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == A)
            .unwrap()
            .runs[0]
            .attributes
            .contains_key("ext:future")
    );
}
#[test]
fn ordered_mode_start_and_dormant_checks_are_atomic() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B], ContainerStyle::Checklist);
    batch(
        &mut d,
        &[
            ListCommand::SetChecked {
                owner: A.into(),
                checked: true,
            },
            ListCommand::SetStyle {
                container: l.clone(),
                style: ContainerStyle::Ordered { start: 2147483647 },
            },
        ],
    );
    assert_eq!(number(&d, A), Some(2147483647));
    assert_eq!(number(&d, B), Some(2147483648));
    assert_eq!(checked(&d, A), None);
    batch(
        &mut d,
        &[ListCommand::SetStyle {
            container: l,
            style: ContainerStyle::Checklist,
        }],
    );
    assert_eq!(checked(&d, A), Some(true));
}
#[test]
fn nested_containers_do_not_increment_ordered_ordinals() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B, C], ContainerStyle::Ordered { start: 5 });
    batch(&mut d, &[ListCommand::Indent { owner: B.into() }]);
    let nested = parent(&d, B);
    assert_eq!(children(&d, &l), vec![A.into(), nested, C.into()]);
    assert_eq!(number(&d, A), Some(5));
    assert_eq!(number(&d, B), Some(5));
    assert_eq!(number(&d, C), Some(6));
}
#[test]
fn enter_endpoints_and_unicode_preserve_marks_checked_left_and_unchecked_right() {
    for at in [0, 1, 3, 4] {
        let mut d = engine();
        let l = wrap(&mut d, &[A, B], ContainerStyle::Checklist);
        batch(
            &mut d,
            &[ListCommand::SetChecked {
                owner: A.into(),
                checked: true,
            }],
        );
        let identities = sources(&d);
        let c = enter(&d, A, at);
        batch(&mut d, &[c]);
        let kids = children(&d, &l);
        let right = &kids[1];
        assert_eq!(kids[0], A);
        assert_eq!(kids[2], B);
        assert_eq!(format!("{}{}", value(&d, A), value(&d, right)), "a😀ב");
        assert_eq!(checked(&d, A), Some(true));
        assert_eq!(checked(&d, right), Some(false));
        assert_eq!(sources(&d), identities);
        let c = back(&d, right);
        batch(&mut d, &[c]);
        assert_eq!(value(&d, A), "a😀ב");
        assert_eq!(children(&d, &l), vec![A, B]);
    }
}
#[test]
fn enter_combining_and_rtl_cuts_are_fixed_utf16_results() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B], ContainerStyle::Quote);
    let c = enter(&d, B, 2);
    batch(&mut d, &[c]);
    let kids = children(&d, &l);
    assert_eq!(value(&d, B), "é");
    assert_eq!(value(&d, &kids[2]), "Z");
}
#[test]
fn empty_enter_exits_one_level_and_keeps_check_metadata_dormant() {
    let mut d = engine();
    let l = wrap(&mut d, &[C, E], ContainerStyle::Checklist);
    batch(
        &mut d,
        &[ListCommand::SetChecked {
            owner: E.into(),
            checked: true,
        }],
    );
    let c = enter(&d, E, 0);
    batch(&mut d, &[c]);
    assert_eq!(
        children(&d, "@root"),
        vec![A.into(), B.into(), l.clone(), E.into()]
    );
    assert_eq!(children(&d, &l), vec![C]);
    assert_eq!(checked(&d, E), None);
    let q = wrap(&mut d, &[E], ContainerStyle::Quote);
    let c = enter(&d, E, 0);
    batch(&mut d, &[c]);
    assert_eq!(parent(&d, E), "@root");
    assert!(children(&d, &q).is_empty());
    assert_eq!(children(&d, "@root").last(), Some(&q));
}
#[test]
fn indent_reuses_matching_nested_container_and_outdent_retains_tail_order() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B, C], ContainerStyle::Unordered);
    let identities = sources(&d);
    batch(
        &mut d,
        &[
            ListCommand::Indent { owner: B.into() },
            ListCommand::Indent { owner: C.into() },
        ],
    );
    let n = parent(&d, B);
    assert_eq!(parent(&d, C), n);
    assert_eq!(children(&d, &n), vec![B, C]);
    batch(&mut d, &[ListCommand::Outdent { owner: B.into() }]);
    let tail = parent(&d, C);
    assert_eq!(tail, n);
    assert_eq!(children(&d, &l), vec![A.into(), B.into(), tail.clone()]);
    assert_eq!(children(&d, &tail), vec![C]);
    assert_eq!(sources(&d), identities);
}
#[test]
fn middle_outdent_splits_container_without_reordering_trailing_items() {
    for style in [
        ContainerStyle::Ordered { start: 9 },
        ContainerStyle::Checklist,
        ContainerStyle::Quote,
    ] {
        let mut d = engine();
        let l = wrap(&mut d, &[A, B, C], style);
        batch(&mut d, &[ListCommand::Outdent { owner: B.into() }]);
        let tail = parent(&d, C);
        assert_eq!(
            children(&d, "@root"),
            vec![l.clone(), B.into(), tail.clone(), E.into()]
        );
        assert_eq!(children(&d, &l), vec![A]);
        assert_eq!(children(&d, &tail), vec![C]);
    }
}
#[test]
fn first_backspace_exits_but_adjacent_backspace_joins_original_sources() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B, C], ContainerStyle::Quote);
    let identities = sources(&d);
    let c = back(&d, B);
    batch(&mut d, &[c]);
    assert_eq!(value(&d, A), "a😀בéZ");
    assert_eq!(children(&d, &l), vec![A, C]);
    assert_eq!(sources(&d), identities);
    let c = back(&d, A);
    batch(&mut d, &[c]);
    assert_eq!(parent(&d, A), "@root");
    assert_eq!(parent(&d, C), l);
}
#[test]
fn invalid_wrap_modes_parent_targets_and_first_indent_are_silent() {
    let mut d = engine();
    for targets in [
        vec![],
        vec![A.into(), C.into()],
        vec![A.into(), A.into()],
        vec!["missing".into()],
    ] {
        assert_stable(
            &d,
            &[ListCommand::Wrap {
                targets,
                style: ContainerStyle::Unordered,
            }],
        );
    }
    for start in [0, 2147483648] {
        assert_stable(
            &d,
            &[ListCommand::Wrap {
                targets: vec![A.into()],
                style: ContainerStyle::Ordered { start },
            }],
        );
    }
    assert_stable(&d, &[ListCommand::Indent { owner: A.into() }]);
    let l = wrap(&mut d, &[A, B], ContainerStyle::Quote);
    assert_stable(
        &d,
        &[ListCommand::SetStyle {
            container: l,
            style: ContainerStyle::Checklist,
        }],
    );
    assert_stable(&d, &[ListCommand::Indent { owner: A.into() }]);
    assert_stable(
        &d,
        &[ListCommand::SetChecked {
            owner: A.into(),
            checked: true,
        }],
    );
}
#[test]
fn mixed_batch_failure_after_wrapping_and_split_never_reserves_or_writes() {
    let mut d = engine();
    let id = d.next_editor_id(true).unwrap();
    assert_stable(
        &d,
        &[
            ListCommand::Wrap {
                targets: vec![A.into(), B.into()],
                style: ContainerStyle::Checklist,
            },
            ListCommand::SetChecked {
                owner: C.into(),
                checked: true,
            },
        ],
    );
    assert_eq!(d.next_editor_id(true).unwrap(), id);
    wrap(&mut d, &[A, B], ContainerStyle::Checklist);
    let c = enter(&d, A, 1);
    assert_stable(
        &d,
        &[
            c,
            ListCommand::Outdent {
                owner: "missing".into(),
            },
        ],
    );
}
#[test]
fn stale_and_cross_replica_plans_reject_without_mutation() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B], ContainerStyle::Unordered);
    let c = enter(&d, A, 1);
    let p = d.prepare_lists(&[c.clone()], &origin()).unwrap();
    let mut peer = restore(&d.checkpoint().bytes);
    let old = peer.checkpoint().bytes;
    assert!(peer.commit_lists(p).is_err());
    assert_eq!(peer.checkpoint().bytes, old);
    let p = d.prepare_lists(&[c], &origin()).unwrap();
    batch(
        &mut d,
        &[ListCommand::SetStyle {
            container: l,
            style: ContainerStyle::Checklist,
        }],
    );
    let old = d.checkpoint().bytes;
    assert!(matches!(
        d.commit_lists(p),
        Err(EditorError::Text(TextError::StalePlan))
    ));
    assert_eq!(d.checkpoint().bytes, old);
}
#[test]
fn anchor_interior_nonzero_backspace_deleted_and_code_targets_reject() {
    let mut d = engine();
    wrap(&mut d, &[A, B], ContainerStyle::Unordered);
    assert!(d.anchor(A, U(2), Bias::Right).is_err());
    let c = ListCommand::Backspace {
        owner: A.into(),
        at: d.anchor(A, U(1), Bias::Right).unwrap(),
    };
    assert_stable(&d, &[c]);
    let c = enter(&d, B, 1);
    let p = d
        .prepare_editor(
            &[EditorCommand::Enable {
                target: B.into(),
                enabled: false,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    assert_stable(&d, &[c]);
    let c = enter(&d, A, 1);
    let p = d
        .prepare_editor(
            &[EditorCommand::Block {
                target: A.into(),
                tuple: m::arr(vec![Any::from("code"), Any::from("rust")]),
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    assert_stable(&d, &[c]);
}
fn insert(d: &mut Document, id: &str, text: &str) -> ReplayUpdate {
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at: d.anchor(id, U(1), Bias::Right).unwrap(),
                text: text.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap().update.unwrap()
}
fn converge(seed: &[u8], updates: &[ReplayUpdate; 3], acknowledged: &str) {
    // Independent content oracle: structural intentions can lose, characters
    // cannot. Compare the full visible character multiset with seed + edit.
    let visible_text = |d: &Document| {
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .flat_map(|n| n.runs.iter().map(|r| r.text.clone()).collect::<Vec<_>>())
            .collect::<String>()
    };
    let mut chars = format!("{}{}", visible_text(&restore(seed)), acknowledged)
        .chars()
        .collect::<Vec<_>>();
    chars.sort_unstable();
    let mut expected = restore(seed);
    for u in updates {
        expected.apply_replay(u).unwrap();
    }
    let expected = canonical(&expected);
    for order in PERMS {
        let mut r = restore(seed);
        for i in order {
            r.apply_replay(&updates[i]).unwrap();
            r.apply_replay(&updates[i]).unwrap();
        }
        let mut actual = visible_text(&r).chars().collect::<Vec<_>>();
        actual.sort_unstable();
        assert_eq!(
            actual, chars,
            "acknowledged source characters in schedule {order:?}"
        );
        assert_eq!(canonical(&r), expected);
        assert_eq!(canonical(&restore(&r.checkpoint().bytes)), expected);
    }
}
#[test]
fn concurrent_indent_outdent_and_text_edit_converge_in_six_duplicate_orders() {
    let mut base = engine();
    wrap(&mut base, &[A, B, C], ContainerStyle::Unordered);
    let seed = base.checkpoint().bytes;
    let mut one = restore(&seed);
    let mut two = restore(&seed);
    let mut three = restore(&seed);
    let updates = [
        batch(&mut one, &[ListCommand::Indent { owner: B.into() }]),
        batch(&mut two, &[ListCommand::Outdent { owner: B.into() }]),
        insert(&mut three, B, "REMOTE😀"),
    ];
    converge(&seed, &updates, "REMOTE😀");
}
#[test]
fn concurrent_enter_check_mode_and_text_edit_preserve_acknowledged_content() {
    let mut base = engine();
    let l = wrap(&mut base, &[A, B], ContainerStyle::Checklist);
    let seed = base.checkpoint().bytes;
    let mut one = restore(&seed);
    let mut two = restore(&seed);
    let mut three = restore(&seed);
    let c = enter(&one, A, 1);
    let updates = [
        batch(&mut one, &[c]),
        batch(
            &mut two,
            &[
                ListCommand::SetChecked {
                    owner: A.into(),
                    checked: true,
                },
                ListCommand::SetStyle {
                    container: l,
                    style: ContainerStyle::Ordered { start: 12 },
                },
            ],
        ),
        insert(&mut three, A, "REMOTE"),
    ];
    converge(&seed, &updates, "REMOTE");
}
#[test]
fn real_list_commands_exchange_with_pinned_yjs_and_restore() {
    let dir = PathBuf::from(
        std::env::var_os("EDITAC_LIST_EXCHANGE").expect("isolated list exchange required"),
    );
    fs::create_dir_all(&dir).unwrap();
    let mut d = engine();
    fs::write(dir.join("rust-seed.bin"), d.checkpoint().bytes).unwrap();
    let l = wrap(&mut d, &[A, B, C, E], ContainerStyle::Checklist);
    batch(
        &mut d,
        &[
            ListCommand::SetChecked {
                owner: A.into(),
                checked: true,
            },
            ListCommand::Indent { owner: B.into() },
        ],
    );
    let q = wrap(&mut d, &[C], ContainerStyle::Quote);
    let c = enter(&d, A, 1);
    batch(&mut d, &[c]);
    let c = enter(&d, E, 0);
    batch(&mut d, &[c]);
    fs::write(dir.join("rust-final.bin"), d.checkpoint().bytes).unwrap();
    fs::write(dir.join("rust-final.json"), m::json(&canonical(&d))).unwrap();
    fs::write(
        dir.join("ids.json"),
        format!("{{\"list\":\"{l}\",\"quote\":\"{q}\"}}"),
    )
    .unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .args(["--test", "fixtures/schema-v4/lists-exchange.mjs"])
        .current_dir(root)
        .env("EDITAC_LIST_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [output.stdout, output.stderr].concat(),
    )
    .unwrap();
    assert!(
        output.status.success(),
        "pinned Yjs failed; see {}",
        dir.join("node.log").display()
    );
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: fs::read(dir.join("yjs-final.bin")).unwrap(),
    })
    .unwrap();
    let expected =
        Any::from_json(&fs::read_to_string(dir.join("yjs-final.json")).unwrap()).unwrap();
    assert_eq!(canonical(&d), expected);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), expected);
}
#[test]
fn repeated_enter_after_multi_source_backspace_join_preserves_original_spans() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B, C], ContainerStyle::Checklist);
    let before = sources(&d);
    let c = back(&d, B);
    batch(&mut d, &[c]);
    let c = back(&d, C);
    batch(&mut d, &[c]);
    assert_eq!(value(&d, A), "a😀בéZtail");
    for at in [4, 6, 7] {
        let c = enter(&d, A, at);
        batch(&mut d, &[c]);
        let kids = children(&d, &l);
        let c = back(&d, &kids[1]);
        batch(&mut d, &[c]);
        assert_eq!(value(&d, A), "a😀בéZtail");
    }
    assert_eq!(sources(&d), before);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}
#[test]
fn concurrent_split_split_and_join_edit_keep_all_original_content() {
    let mut base = engine();
    wrap(&mut base, &[A, B, C], ContainerStyle::Checklist);
    let seed = base.checkpoint().bytes;
    let mut one = restore(&seed);
    let mut two = restore(&seed);
    let mut three = restore(&seed);
    let c1 = enter(&one, A, 1);
    let c2 = enter(&two, A, 3);
    let updates = [
        batch(&mut one, &[c1]),
        batch(&mut two, &[c2]),
        insert(&mut three, A, "RACE😀"),
    ];
    converge(&seed, &updates, "RACE😀");
    let mut one = restore(&seed);
    let mut two = restore(&seed);
    let mut three = restore(&seed);
    let c1 = back(&one, B);
    let c2 = enter(&two, B, 2);
    let updates = [
        batch(&mut one, &[c1]),
        batch(&mut two, &[c2]),
        insert(&mut three, B, "JOIN😀"),
    ];
    converge(&seed, &updates, "JOIN😀");
}
#[test]
fn depth_128_accepts_exit_and_rejects_wrapping_whole_descendant_batch() {
    let p = m::replica(42);
    let mut t = p.transact_mut_with("fixture:depth");
    for i in 1..=128 {
        let id = format!("c:42:{i}");
        let parent = if i == 1 {
            "@root".into()
        } else {
            format!("c:42:{}", i - 1)
        };
        t.get_map(m::ROOTS[0])
            .unwrap()
            .insert(&mut t, id.clone(), "quote");
        t.get_map(m::ROOTS[2]).unwrap().insert(
            &mut t,
            id.clone(),
            m::arr(vec![Any::from(parent), Any::from(0u32)]),
        );
        t.get_map(m::ROOTS[7])
            .unwrap()
            .insert(&mut t, id, m::arr(vec![Any::from("quote")]));
    }
    t.get_map(m::ROOTS[0]).unwrap().insert(&mut t, A, "block");
    t.get_map(m::ROOTS[2]).unwrap().insert(
        &mut t,
        A,
        m::arr(vec![Any::from("c:42:128"), Any::from(0u32)]),
    );
    t.get_map(m::ROOTS[1])
        .unwrap()
        .insert(&mut t, A, XmlTextPrelim::new("deep"));
    t.get_map(m::ROOTS[6]).unwrap().insert(&mut t, A, true);
    drop(t);
    let mut d = restore(&m::bytes(&p));
    assert_stable(
        &d,
        &[ListCommand::Wrap {
            targets: vec![A.into()],
            style: ContainerStyle::Quote,
        }],
    );
    batch(&mut d, &[ListCommand::Outdent { owner: A.into() }]);
    assert_eq!(parent(&d, A), "c:42:127");
    assert_eq!(value(&d, A), "deep");
}
#[test]
fn prepared_expansion_bound_and_opaque_container_reject_atomically() {
    let mut d = engine();
    let l = wrap(&mut d, &[A, B], ContainerStyle::Unordered);
    let commands = vec![
        ListCommand::SetStyle {
            container: l.clone(),
            style: ContainerStyle::Checklist
        };
        4097
    ];
    assert_stable(&d, &commands);
    let p = m::replica(1500);
    m::apply(&p, &d.checkpoint().bytes).unwrap();
    m::set(
        &p,
        7,
        &l,
        m::arr(vec![Any::from("ext:future-list"), Any::from("kept")]),
    );
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&p),
    })
    .unwrap();
    assert_stable(&d, &[ListCommand::Outdent { owner: A.into() }]);
    assert_stable(
        &d,
        &[ListCommand::SetStyle {
            container: l,
            style: ContainerStyle::Unordered,
        }],
    );
}
#[test]
fn nested_enter_backspace_outdent_transitions_cover_every_container_style() {
    for style in [
        ContainerStyle::Unordered,
        ContainerStyle::Ordered { start: 4 },
        ContainerStyle::Checklist,
        ContainerStyle::Quote,
    ] {
        let mut d = engine();
        let outer = wrap(&mut d, &[A, B, C], style.clone());
        let identities = sources(&d);
        batch(&mut d, &[ListCommand::Indent { owner: B.into() }]);
        let inner = parent(&d, B);
        if style == ContainerStyle::Checklist {
            batch(
                &mut d,
                &[ListCommand::SetChecked {
                    owner: B.into(),
                    checked: true,
                }],
            );
        }
        let c = enter(&d, B, 2);
        batch(&mut d, &[c]);
        let kids = children(&d, &inner);
        assert_eq!(kids[0], B);
        assert_eq!(value(&d, B), "é");
        assert_eq!(value(&d, &kids[1]), "Z");
        if style == ContainerStyle::Checklist {
            assert_eq!(checked(&d, B), Some(true));
            assert_eq!(checked(&d, &kids[1]), Some(false));
        }
        let c = back(&d, &kids[1]);
        batch(&mut d, &[c]);
        assert_eq!(value(&d, B), "éZ");
        batch(&mut d, &[ListCommand::Outdent { owner: B.into() }]);
        assert_eq!(
            children(&d, &outer),
            vec![A.into(), B.into(), inner.clone(), C.into()]
        );
        assert!(children(&d, &inner).is_empty());
        assert_eq!(sources(&d), identities);
    }
}
#[test]
fn empty_middle_item_exit_keeps_trailing_items_and_numbering_in_tail() {
    let mut d = engine();
    let p = d
        .prepare_editor(
            &[EditorCommand::Place {
                target: E.into(),
                parent: "@root".into(),
                before: Some(B.into()),
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    let l = wrap(&mut d, &[A, E, B, C], ContainerStyle::Ordered { start: 8 });
    let before = sources(&d);
    let c = enter(&d, E, 0);
    batch(&mut d, &[c]);
    let tail = parent(&d, B);
    assert_eq!(
        children(&d, "@root"),
        vec![l.clone(), E.into(), tail.clone()]
    );
    assert_eq!(children(&d, &l), vec![A]);
    assert_eq!(children(&d, &tail), vec![B, C]);
    assert_eq!(number(&d, A), Some(8));
    assert_eq!(number(&d, B), Some(8));
    assert_eq!(number(&d, C), Some(9));
    assert_eq!(sources(&d), before);
    assert!(d.anchor(E, U(0), Bias::Right).is_ok());
}
