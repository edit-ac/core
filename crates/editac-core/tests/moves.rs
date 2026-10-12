//! ENG-1.10: canonical production move API, independent tree/content oracles,
//! original identities, three writers and real pinned Yjs exchange.
#[path = "../../../fixtures/schema-v4/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution, Selection},
    commands::{editor::*, r#move::*, text::*},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
};
use std::{fs, path::PathBuf, process::Command};
use yrs::Any;
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const L: &str = "c:11:1";
const Q: &str = "c:11:2";
const K: &str = "c:11:3";
const W: &str = "c:11:4";
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
    restore(&m::bytes(&m::seed()))
}
fn origin() -> TextOrigin {
    TextOrigin::new("move:explicit").unwrap()
}
fn canonical(d: &Document) -> Any {
    d.snapshot().unwrap().retained_structure.unwrap()
}
fn mapped(d: &Document) -> yrs::Doc {
    let x = m::replica(2001);
    m::apply(&x, &d.checkpoint().bytes).unwrap();
    x
}
fn sources(d: &Document) -> Any {
    let Any::Map(s) = canonical(d) else { panic!() };
    s["sources"].clone()
}
fn owner(d: &Document, id: &str) -> m::Owner {
    m::project(&mapped(d))
        .unwrap()
        .owners
        .into_iter()
        .find(|o| o.id == id)
        .unwrap()
}
fn visible(d: &Document) -> Vec<String> {
    d.snapshot()
        .unwrap()
        .visible
        .into_iter()
        .map(|n| n.id.clone())
        .collect()
}
fn value(d: &Document, id: &str) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == id)
        .unwrap()
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
fn batch(d: &mut Document, c: &[EditorCommand]) -> ReplayUpdate {
    let bytes = d.checkpoint().bytes;
    let plan = d.prepare_editor(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    d.commit_editor(plan).unwrap().update
}
fn move_to(d: &mut Document, id: &str, parent: &str, before: Option<&str>) -> ReplayUpdate {
    let c = d.move_command(id, parent, before).unwrap();
    let bytes = d.checkpoint().bytes;
    d.can_move(&c, &origin(), None).unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    let plan = d.prepare_move(&c, &origin(), None).unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    d.commit_move(plan).unwrap().edit.update
}
fn insert(d: &mut Document, id: &str, text: &str) -> ReplayUpdate {
    let at = d.anchor(id, U(1), Bias::Right).unwrap();
    let plan = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: text.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(plan).unwrap().update.unwrap()
}
fn selection(d: &Document) -> Selection {
    d.selection((C, U(2), Bias::Left), (A, U(3), Bias::Right))
        .unwrap()
}
fn unchanged_rejection(d: &Document, c: &MoveCommand, why: MoveRejection) {
    let bytes = d.checkpoint().bytes;
    let revision = d.revision();
    let before = canonical(d);
    assert!(
        matches!(d.prepare_move(c,&origin(),None),Err(MoveError::Editor(EditorError::Move(e))) if e==why)
    );
    assert_eq!(
        d.can_move(c, &origin(), None),
        Err(MoveError::Editor(EditorError::Move(why)))
    );
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), revision);
    assert_eq!(canonical(d), before);
}
fn raw(target: &str, parent: &str, before: Option<&str>) -> MoveCommand {
    let t = |id: &str| MoveTarget {
        id: id.into(),
        version: "base".into(),
    };
    MoveCommand {
        target: t(target),
        parent: t(parent),
        before: before.map(t),
    }
}
#[test]
fn leaf_reordering_before_sibling_and_append_preserve_sources() {
    let mut d = engine();
    let source = sources(&d);
    move_to(&mut d, B, L, Some(A));
    assert_eq!(visible(&d), [L, B, A, Q, K, C, D, W]);
    move_to(&mut d, B, L, None);
    assert_eq!(visible(&d), [L, A, Q, K, C, D, B, W]);
    assert_eq!(sources(&d), source);
    assert_eq!(owner(&d, B).spans.len(), 1);
}
#[test]
fn nested_leaf_move_preserves_unicode_marks_and_original_text_identity() {
    let mut d = engine();
    let source = sources(&d);
    let a = d.anchor(A, U(3), Bias::Right).unwrap();
    move_to(&mut d, A, K, Some(C));
    assert_eq!(visible(&d), [L, B, Q, K, A, C, D, W]);
    assert_eq!(value(&d, A), "a😀b");
    assert_eq!(sources(&d), source);
    assert!(
        matches!(d.resolve_anchor(&a).unwrap(),Resolution::Position(p) if p.node==A&&p.offset==U(3)&&p.source==A)
    );
}
#[test]
fn container_move_retains_subtree_order_check_state_and_cross_subtree_selection() {
    let mut d = engine();
    let source = sources(&d);
    let s = selection(&d);
    let resolved = d.resolve_selection(&s).unwrap();
    let c = d.move_command(Q, W, None).unwrap();
    let p = d.prepare_move(&c, &origin(), Some(&s)).unwrap();
    let r = d.commit_move(p).unwrap();
    assert_eq!(
        d.resolve_selection(r.selection.as_ref().unwrap()).unwrap(),
        resolved
    );
    assert_eq!(visible(&d), [L, A, B, W, Q, K, C, D]);
    assert_eq!(owner(&d, K).parent, Q);
    assert_eq!(owner(&d, C).parent, K);
    assert_eq!(sources(&d), source);
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == C)
            .unwrap()
            .editor
            .as_ref()
            .unwrap()
            .checked,
        Some(true)
    );
}
#[test]
fn empty_owner_moves_without_replacing_its_empty_source() {
    let mut d = engine();
    let source = sources(&d);
    move_to(&mut d, D, "@root", Some(W));
    assert_eq!(value(&d, D), "");
    assert_eq!(sources(&d), source);
    assert_eq!(owner(&d, D).parent, "@root");
}
#[test]
fn code_and_separator_moves_are_structural_and_do_not_modify_presentation_or_marks() {
    let mut d = engine();
    let source = sources(&d);
    batch(
        &mut d,
        &[
            EditorCommand::Block {
                target: A.into(),
                tuple: m::arr(vec![Any::from("code"), Any::from("future-lang")]),
            },
            EditorCommand::Block {
                target: D.into(),
                tuple: m::arr(vec![Any::from("separator")]),
            },
        ],
    );
    move_to(&mut d, A, W, None);
    move_to(&mut d, D, W, Some(A));
    assert_eq!(
        owner(&d, A).attrs,
        m::arr(vec![Any::from("code"), Any::from("future-lang")])
    );
    assert_eq!(owner(&d, D).attrs, m::arr(vec![Any::from("separator")]));
    assert_eq!(sources(&d), source);
}
#[test]
fn derived_multi_source_owner_moves_and_anchors_follow_the_same_sources() {
    let mut d = engine();
    let source = sources(&d);
    let a = d.anchor(B, U(2), Bias::Right).unwrap();
    batch(
        &mut d,
        &[EditorCommand::Join {
            first: A.into(),
            second: B.into(),
        }],
    );
    let at = d.anchor(A, U(3), Bias::Right).unwrap();
    batch(
        &mut d,
        &[EditorCommand::Split {
            owner: A.into(),
            at,
        }],
    );
    let right = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id.starts_with("o:"))
        .unwrap()
        .id
        .clone();
    move_to(&mut d, &right, K, Some(C));
    assert_eq!(value(&d, &right), "bcאבd");
    assert_eq!(sources(&d), source);
    assert!(
        matches!(d.resolve_anchor(&a).unwrap(),Resolution::Position(p) if p.node==right&&p.source==B&&p.offset==U(3))
    );
}
#[test]
fn captured_structural_versions_survive_text_edits_and_selection_affinity() {
    let mut d = engine();
    let c = d.move_command(A, K, Some(C)).unwrap();
    let s = d
        .selection((A, U(1), Bias::Left), (A, U(1), Bias::Right))
        .unwrap();
    insert(&mut d, A, "X😀");
    let p = d.prepare_move(&c, &origin(), Some(&s)).unwrap();
    let r = d.commit_move(p).unwrap();
    let resolved = d.resolve_selection(r.selection.as_ref().unwrap()).unwrap();
    assert!(matches!(resolved.anchor,Resolution::Position(p) if p.offset==U(1)));
    assert!(matches!(resolved.focus,Resolution::Position(p) if p.offset==U(4)));
    assert_eq!(value(&d, A), "aX😀😀b");
}
#[test]
fn stale_target_version_rejects_without_retargeting() {
    let mut d = engine();
    let c = d.move_command(A, K, None).unwrap();
    move_to(&mut d, A, W, None);
    unchanged_rejection(&d, &c, MoveRejection::StaleTarget);
}
#[test]
fn stale_parent_version_rejects_even_when_destination_stays_visible() {
    let mut d = engine();
    let c = d.move_command(A, K, None).unwrap();
    move_to(&mut d, K, W, None);
    unchanged_rejection(&d, &c, MoveRejection::StaleDestination);
}
#[test]
fn stale_before_version_rejects_even_when_sibling_stays_under_parent() {
    let mut d = engine();
    let c = d.move_command(A, K, Some(C)).unwrap();
    move_to(&mut d, C, K, None);
    unchanged_rejection(&d, &c, MoveRejection::StaleBefore);
}
#[test]
fn deleted_destination_rejects_preparation_and_retains_target_content() {
    let mut d = engine();
    let c = d.move_command(A, K, None).unwrap();
    let x = mapped(&d);
    m::set(&x, 3, K, Any::Bool(true));
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&x),
    })
    .unwrap();
    unchanged_rejection(&d, &c, MoveRejection::DestinationGone);
    assert_eq!(value(&d, A), "a😀b");
    assert_eq!(owner(&d, C).parent, "@root");
}
#[test]
fn disabled_destination_rejects_without_silently_moving_to_root() {
    let mut d = engine();
    let c = d.move_command(A, K, None).unwrap();
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: K.into(),
            enabled: false,
        }],
    );
    unchanged_rejection(&d, &c, MoveRejection::DestinationGone);
}
#[test]
fn deleted_target_has_explicit_result() {
    let mut d = engine();
    let c = d.move_command(A, K, None).unwrap();
    let x = mapped(&d);
    m::set(&x, 3, A, Any::Bool(true));
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&x),
    })
    .unwrap();
    unchanged_rejection(&d, &c, MoveRejection::TargetGone);
}
#[test]
fn absorbed_target_has_explicit_result() {
    let mut d = engine();
    let c = d.move_command(B, K, None).unwrap();
    batch(
        &mut d,
        &[EditorCommand::Join {
            first: A.into(),
            second: B.into(),
        }],
    );
    unchanged_rejection(&d, &c, MoveRejection::TargetGone);
}
#[test]
fn disabled_before_has_explicit_result() {
    let mut d = engine();
    let c = d.move_command(A, K, Some(C)).unwrap();
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: C.into(),
            enabled: false,
        }],
    );
    unchanged_rejection(&d, &c, MoveRejection::BeforeGone);
}
#[test]
fn wrong_parent_and_self_before_are_rejected() {
    let d = engine();
    unchanged_rejection(&d, &raw(A, K, Some(B)), MoveRejection::InvalidBefore);
    unchanged_rejection(&d, &raw(A, L, Some(A)), MoveRejection::InvalidBefore);
}
#[test]
fn missing_targets_and_noncontainer_destination_are_rejected() {
    let d = engine();
    unchanged_rejection(&d, &raw("n:404:1", K, None), MoveRejection::TargetGone);
    unchanged_rejection(&d, &raw(A, "c:404:1", None), MoveRejection::DestinationGone);
    unchanged_rejection(&d, &raw(A, B, None), MoveRejection::InvalidDestination);
    unchanged_rejection(&d, &raw(A, K, Some("n:404:1")), MoveRejection::BeforeGone);
}
#[test]
fn opaque_target_and_destination_never_gain_a_guessed_structural_role() {
    let x = m::seed();
    m::set(&x, 7, W, m::arr(vec![Any::from("ext:future-list")]));
    let d = restore(&m::bytes(&x));
    unchanged_rejection(&d, &raw(W, "@root", None), MoveRejection::UnsupportedTarget);
    unchanged_rejection(&d, &raw(A, W, None), MoveRejection::InvalidDestination);
}
#[test]
fn self_and_descendant_cycles_reject_before_live_mutation() {
    let d = engine();
    unchanged_rejection(&d, &raw(L, L, None), MoveRejection::Cycle);
    unchanged_rejection(&d, &raw(L, K, None), MoveRejection::Cycle);
}
#[test]
fn malformed_root_version_rejects() {
    let d = engine();
    let mut c = raw(A, "@root", None);
    c.parent.version = "o:404:1".into();
    unchanged_rejection(&d, &c, MoveRejection::StaleDestination);
}
#[test]
fn mixed_batch_cycle_and_stale_version_reject_every_staged_move() {
    let d = engine();
    let bytes = d.checkpoint().bytes;
    let rev = d.revision();
    let a = d.move_command(A, K, None).unwrap();
    let cyclic = raw(L, K, None);
    assert!(matches!(
        d.prepare_editor(
            &[EditorCommand::Move(a.clone()), EditorCommand::Move(cyclic)],
            &origin()
        ),
        Err(EditorError::Move(MoveRejection::Cycle))
    ));
    assert!(matches!(
        d.prepare_editor(
            &[EditorCommand::Move(a.clone()), EditorCommand::Move(a)],
            &origin()
        ),
        Err(EditorError::Move(MoveRejection::StaleTarget))
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), rev);
}
#[test]
fn depth_limit_accounts_for_every_descendant_and_rejects_whole_batch() {
    let x = m::seed();
    for i in 1..=127u32 {
        let id = format!("c:22:{i}");
        m::set(&x, 0, &id, Any::from("quote"));
        m::set(&x, 7, &id, m::arr(vec![Any::from("quote")]));
        m::set(
            &x,
            2,
            &id,
            m::arr(vec![
                Any::from(if i == 1 {
                    "@root".into()
                } else {
                    format!("c:22:{}", i - 1)
                }),
                Any::from(0u32),
            ]),
        );
    }
    let d = restore(&m::bytes(&x));
    let bytes = d.checkpoint().bytes;
    let c = d.move_command(L, "c:22:127", None).unwrap();
    assert!(matches!(
        d.prepare_move(&c, &origin(), None),
        Err(MoveError::Editor(EditorError::ResourceLimit))
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
}
#[test]
fn prepared_move_rejects_intervening_text_or_deletion_and_wrong_replica() {
    let mut d = engine();
    let c = d.move_command(A, K, None).unwrap();
    let p = d.prepare_move(&c, &origin(), None).unwrap();
    insert(&mut d, A, "R");
    let bytes = d.checkpoint().bytes;
    assert!(matches!(
        d.commit_move(p),
        Err(MoveError::Editor(EditorError::Text(TextError::StalePlan)))
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
    let p = d.prepare_move(&c, &origin(), None).unwrap();
    let mut peer = restore(&bytes);
    let before = peer.checkpoint().bytes;
    assert!(matches!(
        peer.commit_move(p),
        Err(MoveError::Editor(EditorError::Text(
            TextError::WrongReplica
        )))
    ));
    assert_eq!(peer.checkpoint().bytes, before);
    let p = d.prepare_move(&c, &origin(), None).unwrap();
    let x = mapped(&d);
    m::set(&x, 3, K, Any::Bool(true));
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&x),
    })
    .unwrap();
    let before = d.checkpoint().bytes;
    assert!(matches!(
        d.commit_move(p),
        Err(MoveError::Editor(EditorError::Text(TextError::StalePlan)))
    ));
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn foreign_or_deleted_selection_rejects_before_mutation() {
    let mut d = engine();
    let s = selection(&d);
    let c = d.move_command(B, W, None).unwrap();
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: A.into(),
            enabled: false,
        }],
    );
    let bytes = d.checkpoint().bytes;
    assert!(matches!(
        d.prepare_move(&c, &origin(), Some(&s)),
        Err(MoveError::UnresolvableSelection)
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
    let x = m::seed();
    let identity = DocumentIdentity::v4(
        "99999999-9999-4999-8999-999999999999",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let foreign = Document::restore(
        &identity,
        &InitializedCheckpoint {
            identity: identity.clone(),
            initialized: true,
            writer_id: 11,
            bytes: m::bytes(&x),
        },
        &[],
    )
    .unwrap();
    let s = selection(&foreign);
    assert!(matches!(
        d.prepare_move(&c, &origin(), Some(&s)),
        Err(MoveError::UnresolvableSelection)
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
}
#[test]
fn legacy_profile_never_acquires_v4_move_roots() {
    use editac_core::document::{CreationPermit, InitialNode};
    let identity = DocumentIdentity::v1(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )
    .unwrap();
    let d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "text".into(),
        }],
    )
    .unwrap();
    let bytes = d.checkpoint().bytes;
    let target = d.snapshot().unwrap().visible[0].id.clone();
    assert!(matches!(
        d.move_command(&target, "@root", None),
        Err(EditorError::UnsupportedProfile)
    ));
    assert!(matches!(
        d.prepare_move(&raw(&target, "@root", None), &origin(), None),
        Err(MoveError::Editor(EditorError::UnsupportedProfile))
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
}

fn writers(seed: &[u8]) -> [Document; 3] {
    let mut v = [restore(seed), restore(seed), restore(seed)];
    v.sort_by_key(Document::writer_id);
    assert!(v[0].writer_id() < v[1].writer_id() && v[1].writer_id() < v[2].writer_id());
    v
}
fn converge(seed: &[u8], updates: &[ReplayUpdate; 3], check: impl Fn(&Document)) {
    let baseline = restore(seed);
    let anchors = [
        baseline.anchor(A, U(3), Bias::Left).unwrap(),
        baseline.anchor(C, U(2), Bias::Right).unwrap(),
    ];
    let mut oracle = restore(seed);
    for u in updates {
        oracle.apply_replay(u).unwrap();
    }
    check(&oracle);
    let expected = canonical(&oracle);
    for order in PERMS {
        let mut r = restore(seed);
        for i in order {
            r.apply_replay(&updates[i]).unwrap();
            r.apply_replay(&updates[i]).unwrap();
        }
        assert_eq!(canonical(&r), expected);
        check(&r);
        assert_eq!(canonical(&restore(&r.checkpoint().bytes)), expected);
        for a in &anchors {
            assert!(
                matches!(r.resolve_anchor(a).unwrap(),Resolution::Position(p) if p.source==a.source())
            );
        }
    }
}
#[test]
fn concurrent_same_target_move_move_and_edit_have_ranked_winner_in_six_orders() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let updates = [
        move_to(&mut a, A, K, None),
        move_to(&mut b, A, W, None),
        insert(&mut c, A, "REMOTE😀"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, A).parent, K);
        assert_eq!(value(d, A), "aREMOTE😀😀b");
        assert_eq!(value(d, B), "cאבd");
    });
}
#[test]
fn concurrent_disjoint_nested_moves_and_descendant_edit_coexist_in_six_orders() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let updates = [
        move_to(&mut a, A, K, Some(C)),
        move_to(&mut b, Q, W, None),
        insert(&mut c, C, "REMOTE"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, A).parent, K);
        assert_eq!(owner(d, Q).parent, W);
        assert_eq!(owner(d, K).parent, Q);
        assert_eq!(value(d, C), "eREMOTÉZ");
    });
}
#[test]
fn concurrent_container_cycle_keeps_losing_intention_and_all_content_in_six_orders() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let updates = [
        move_to(&mut a, L, W, None),
        move_to(&mut b, W, L, None),
        insert(&mut c, A, "R"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, L).parent, W);
        assert_eq!(owner(d, W).parent, "@root");
        assert_eq!(value(d, A), "aR😀b");
        let v = m::project(&mapped(d)).unwrap();
        assert_eq!(
            v.outcomes
                .values()
                .filter(|s| s.as_str() == "applied")
                .count(),
            1
        );
        assert_eq!(
            v.outcomes
                .values()
                .filter(|s| s.as_str() == "losing")
                .count(),
            1
        );
    });
}
#[test]
fn concurrent_parent_version_change_makes_later_move_recoverable_in_six_orders() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let updates = [
        move_to(&mut a, K, W, None),
        move_to(&mut b, A, K, None),
        insert(&mut c, C, "R"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, K).parent, W);
        assert_eq!(owner(d, A).parent, L);
        assert_eq!(value(d, C), "eŔZ");
    });
}
#[test]
fn concurrent_before_version_change_makes_later_move_recoverable_in_six_orders() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let updates = [
        move_to(&mut a, C, K, None),
        move_to(&mut b, A, K, Some(C)),
        insert(&mut c, A, "R"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, A).parent, L);
        assert_eq!(owner(d, C).parent, K);
        assert_eq!(value(d, A), "aR😀b");
    });
}
#[test]
fn concurrent_move_and_destination_disable_keep_losing_move_and_recover_children_at_root() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let updates = [
        move_to(&mut a, A, K, None),
        batch(
            &mut b,
            &[EditorCommand::Enable {
                target: K.into(),
                enabled: false,
            }],
        ),
        insert(&mut c, A, "R"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, A).parent, L);
        assert_eq!(owner(d, C).parent, "@root");
        assert_eq!(value(d, A), "aR😀b");
    });
}
#[test]
fn concurrent_move_and_destination_tombstone_retain_all_live_sources_at_explicit_parents() {
    let seed = engine().checkpoint().bytes;
    let [mut a, mut b, mut c] = writers(&seed);
    let x = mapped(&b);
    m::set(&x, 3, K, Any::Bool(true));
    let deletion = ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&x),
    };
    b.apply_replay(&deletion).unwrap();
    let updates = [
        move_to(&mut a, A, K, None),
        deletion,
        insert(&mut c, C, "R"),
    ];
    converge(&seed, &updates, |d| {
        assert_eq!(owner(d, A).parent, L);
        assert_eq!(owner(d, C).parent, "@root");
        assert_eq!(value(d, C), "eŔZ");
    });
}
#[test]
fn tombstoned_before_sibling_rejects_without_falling_back_to_append() {
    let mut d = engine();
    let c = d.move_command(A, K, Some(C)).unwrap();
    let x = mapped(&d);
    m::set(&x, 3, C, Any::Bool(true));
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&x),
    })
    .unwrap();
    unchanged_rejection(&d, &c, MoveRejection::BeforeGone);
}
#[test]
fn multiple_versioned_moves_commit_as_one_prepared_batch() {
    let mut d = engine();
    let source = sources(&d);
    let a = d.move_command(A, K, Some(C)).unwrap();
    let q = d.move_command(Q, W, None).unwrap();
    let revision = d.revision();
    batch(&mut d, &[EditorCommand::Move(a), EditorCommand::Move(q)]);
    assert_eq!(d.revision(), revision + 1);
    assert_eq!(visible(&d), [L, B, W, Q, K, A, C, D]);
    assert_eq!(sources(&d), source);
}

fn exchange_race(seed: &[u8], name: &str) -> [ReplayUpdate; 3] {
    let [mut a, mut b, mut c] = writers(seed);
    match name {
        "same-target" => [
            move_to(&mut a, A, K, None),
            move_to(&mut b, A, W, None),
            insert(&mut c, A, "REMOTE😀"),
        ],
        "disjoint" => [
            move_to(&mut a, A, K, Some(C)),
            move_to(&mut b, Q, W, None),
            insert(&mut c, C, "REMOTE"),
        ],
        "cycle" => [
            move_to(&mut a, L, W, None),
            move_to(&mut b, W, L, None),
            insert(&mut c, A, "R"),
        ],
        "parent-version" => [
            move_to(&mut a, K, W, None),
            move_to(&mut b, A, K, None),
            insert(&mut c, C, "R"),
        ],
        "before-version" => [
            move_to(&mut a, C, K, None),
            move_to(&mut b, A, K, Some(C)),
            insert(&mut c, A, "R"),
        ],
        "disabled-destination" => [
            move_to(&mut a, A, K, None),
            batch(
                &mut b,
                &[EditorCommand::Enable {
                    target: K.into(),
                    enabled: false,
                }],
            ),
            insert(&mut c, A, "R"),
        ],
        "deleted-destination" => {
            let x = mapped(&b);
            m::set(&x, 3, K, Any::Bool(true));
            [
                move_to(&mut a, A, K, None),
                ReplayUpdate {
                    identity: identity(),
                    bytes: m::bytes(&x),
                },
                insert(&mut c, C, "R"),
            ]
        }
        _ => panic!("unknown race"),
    }
}
#[test]
fn production_moves_exchange_with_pinned_yjs_and_restore_concurrent_schedules() {
    let dir = PathBuf::from(
        std::env::var_os("EDITAC_MOVE_EXCHANGE").expect("isolated move exchange required"),
    );
    fs::create_dir_all(&dir).unwrap();
    let mut d = engine();
    fs::write(dir.join("rust-seed.bin"), d.checkpoint().bytes).unwrap();
    let source = sources(&d);
    let s = selection(&d);
    move_to(&mut d, A, K, Some(C));
    move_to(&mut d, Q, W, None);
    fs::write(dir.join("rust-final.bin"), d.checkpoint().bytes).unwrap();
    fs::write(dir.join("rust-final.json"), m::json(&canonical(&d))).unwrap();
    let seed = engine().checkpoint().bytes;
    for name in [
        "same-target",
        "disjoint",
        "cycle",
        "parent-version",
        "before-version",
        "disabled-destination",
        "deleted-destination",
    ] {
        let updates = exchange_race(&seed, name);
        for (i, u) in updates.iter().enumerate() {
            fs::write(dir.join(format!("{name}-{i}.bin")), &u.bytes).unwrap();
        }
        let mut expected = restore(&seed);
        for u in &updates {
            expected.apply_replay(u).unwrap();
        }
        fs::write(
            dir.join(format!("{name}-final.json")),
            m::json(&canonical(&expected)),
        )
        .unwrap();
    }
    let output = Command::new("node")
        .args(["--test", "fixtures/schema-v4/moves-exchange.mjs"])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("EDITAC_MOVE_EXCHANGE", &dir)
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
    assert_eq!(owner(&d, Q).parent, "@root");
    assert_eq!(owner(&d, A).parent, L);
    assert_eq!(value(&d, B), "cYJS😀אבd");
    // Only the peer's explicit text edit changes sources; all move-only source
    // identities/marks already compared independently in both languages.
    assert_ne!(sources(&d), source);
    assert!(
        matches!(d.resolve_selection(&s).unwrap().anchor,Resolution::Position(p) if p.node==C&&p.source==C)
    );
    // Independent Yjs writers, duplicate/reordered delivery back into the real
    // Rust admission port, and checkpoint restore in every schedule.
    let rust_final = fs::read(dir.join("rust-final.bin")).unwrap();
    let expected =
        Any::from_json(&fs::read_to_string(dir.join("yjs-race-final.json")).unwrap()).unwrap();
    let updates: [ReplayUpdate; 3] = std::array::from_fn(|i| ReplayUpdate {
        identity: identity(),
        bytes: fs::read(dir.join(format!("yjs-race-{i}.bin"))).unwrap(),
    });
    for order in PERMS {
        let mut r = restore(&rust_final);
        for i in order {
            r.apply_replay(&updates[i]).unwrap();
            r.apply_replay(&updates[i]).unwrap();
        }
        assert_eq!(canonical(&r), expected);
        assert_eq!(owner(&r, Q).parent, "@root");
        assert_eq!(value(&r, C), "ePEER😀́Z");
        assert_eq!(canonical(&restore(&r.checkpoint().bytes)), expected);
    }
}
