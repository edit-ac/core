//! ENG-1.8-P1 only: real engine snapshots and read-only hierarchy validation.
//! List/quote transitions and persistence await a structural profile contract.
use editac_core::{
    commands::{lists::*, text::MAX_TEXT_DEPTH},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ROOTS},
    projection::Snapshot,
};
use yrs::{
    Any, ClientID, Doc, Map, OffsetKind, Options, ReadTxn, StateVector, Transact, XmlTextPrelim,
};

fn fixture(nodes: &[(&str, &str, &str)], deleted: &[&str]) -> Document {
    let d = Doc::with_options(Options {
        client_id: ClientID::new(11),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for root in ROOTS {
        d.get_or_insert_map(root);
    }
    {
        let mut t = d.transact_mut_with("fixture:hierarchy");
        for (order, (id, kind, parent)) in nodes.iter().enumerate() {
            t.get_map(ROOTS[0]).unwrap().insert(&mut t, *id, *kind);
            t.get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, *id, XmlTextPrelim::new("a😀ב"));
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                *id,
                Any::Array(vec![Any::from(*parent), Any::from(order as u32)].into()),
            );
        }
        t.get_map(ROOTS[4]).unwrap().insert(
            &mut t,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
        for id in deleted {
            t.get_map(ROOTS[3]).unwrap().insert(&mut t, *id, true);
        }
    }
    let identity = DocumentIdentity::v1(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    .unwrap();
    Document::restore(
        &identity,
        &InitializedCheckpoint {
            identity: identity.clone(),
            initialized: true,
            writer_id: 11,
            bytes: d
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
        },
        &[],
    )
    .unwrap()
}
fn engine() -> Document {
    fixture(
        &[
            ("block-1", "list", "@root"),
            ("block-2", "list", "@root"),
            ("nested", "list", "block-1"),
            ("leaf", "item", "nested"),
            ("opaque", "future-extension", "@root"),
        ],
        &[],
    )
}
fn change(node: &str, parent: &str) -> ParentChange {
    ParentChange {
        node: node.into(),
        parent: parent.into(),
    }
}
fn check(d: &Document, changes: &[ParentChange], expected: Result<(), HierarchyError>) {
    let before = d.checkpoint();
    let snapshot = d.snapshot().unwrap();
    assert_eq!(validate_hierarchy(&snapshot, changes), expected);
    assert_eq!(
        d.checkpoint().bytes,
        before.bytes,
        "validator wrote CRDT state"
    );
    let after = d.snapshot().unwrap();
    assert_eq!(
        snapshot.visible, after.visible,
        "validator changed visible semantics/identities"
    );
    assert_eq!(
        snapshot.recovery, after.recovery,
        "validator changed recovery content"
    );
}

#[test]
fn nested_batch_accepts_known_list_parents_without_mutation() {
    check(
        &engine(),
        &[change("nested", "block-2"), change("leaf", "block-1")],
        Ok(()),
    );
}
#[test]
fn root_outdent_is_valid() {
    check(
        &engine(),
        &[change("nested", "@root"), change("leaf", "@root")],
        Ok(()),
    );
}
#[test]
fn empty_batch_retains_opaque_content() {
    check(&engine(), &[], Ok(()));
}
#[test]
fn self_parent_is_a_cycle() {
    check(
        &engine(),
        &[change("nested", "nested")],
        Err(HierarchyError::Cycle("nested".into())),
    );
}
#[test]
fn parent_under_descendant_is_a_cycle() {
    check(
        &engine(),
        &[change("block-1", "nested")],
        Err(HierarchyError::Cycle("block-1".into())),
    );
}
#[test]
fn individually_valid_changes_can_jointly_cycle() {
    let d = engine();
    check(&d, &[change("block-1", "block-2")], Ok(()));
    check(&d, &[change("block-2", "block-1")], Ok(()));
    check(
        &d,
        &[change("block-1", "block-2"), change("block-2", "block-1")],
        Err(HierarchyError::Cycle("block-1".into())),
    );
}
#[test]
fn final_graph_allows_atomic_break_and_reparent() {
    // Validation in isolation would reject the first change. The complete
    // batch breaks the old edge, so order of planning must not invent a cycle.
    for changes in [
        vec![change("block-1", "nested"), change("nested", "@root")],
        vec![change("nested", "@root"), change("block-1", "nested")],
    ] {
        check(&engine(), &changes, Ok(()));
    }
}
#[test]
fn item_cannot_be_a_parent() {
    check(
        &engine(),
        &[change("block-2", "leaf")],
        Err(HierarchyError::IllegalParent("leaf".into())),
    );
}
#[test]
fn unknown_kind_cannot_be_a_parent() {
    check(
        &engine(),
        &[change("leaf", "opaque")],
        Err(HierarchyError::IllegalParent("opaque".into())),
    );
}
#[test]
fn unknown_kind_cannot_be_a_command_target() {
    check(
        &engine(),
        &[change("opaque", "block-1")],
        Err(HierarchyError::UnsupportedTarget("opaque".into())),
    );
}
#[test]
fn duplicate_target_is_rejected_even_for_identical_changes() {
    check(
        &engine(),
        &[change("leaf", "block-1"), change("leaf", "block-1")],
        Err(HierarchyError::DuplicateTarget("leaf".into())),
    );
}
#[test]
fn missing_target_is_not_redirected() {
    check(
        &engine(),
        &[change("missing", "block-1")],
        Err(HierarchyError::MissingNode("missing".into())),
    );
}
#[test]
fn missing_parent_is_not_repaired_to_root() {
    check(
        &engine(),
        &[change("leaf", "missing")],
        Err(HierarchyError::MissingNode("missing".into())),
    );
}
#[test]
fn deleted_target_is_distinct_from_missing() {
    let d = fixture(
        &[("block-1", "list", "@root"), ("block-2", "list", "@root")],
        &["block-2"],
    );
    check(
        &d,
        &[change("block-2", "block-1")],
        Err(HierarchyError::DeletedNode("block-2".into())),
    );
}
#[test]
fn deleted_parent_does_not_resurrect_or_redirect_content() {
    let d = fixture(
        &[("block-1", "list", "@root"), ("block-2", "list", "@root")],
        &["block-2"],
    );
    check(
        &d,
        &[change("block-1", "block-2")],
        Err(HierarchyError::DeletedNode("block-2".into())),
    );
}
fn chain(length: usize) -> Document {
    let mut nodes = vec![
        ("block-1".to_owned(), "list".to_owned(), "@root".to_owned()),
        ("block-2".to_owned(), "list".to_owned(), "@root".to_owned()),
    ];
    for i in 0..length {
        nodes.push((
            format!("depth-{i:03}"),
            "list".into(),
            if i == 0 {
                "@root".into()
            } else {
                format!("depth-{:03}", i - 1)
            },
        ));
    }
    fixture(
        &nodes
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
            .collect::<Vec<_>>(),
        &[],
    )
}
#[test]
fn exact_editing_depth_limit_is_accepted() {
    check(&chain(MAX_TEXT_DEPTH), &[], Ok(()));
}
#[test]
fn unchanged_descendant_depth_is_checked_after_reparenting() {
    // The moved node is shallow; only its unchanged deepest descendant exceeds
    // the limit. Checking just the target's ancestor chain would miss this.
    check(
        &chain(MAX_TEXT_DEPTH),
        &[change("depth-000", "block-1")],
        Err(HierarchyError::DepthLimit("depth-063".into())),
    );
}
#[test]
fn already_excessive_hierarchy_rejects_without_recursion() {
    check(
        &chain(MAX_TEXT_DEPTH + 1),
        &[],
        Err(HierarchyError::DepthLimit("depth-064".into())),
    );
}
#[test]
fn excessive_change_batch_is_bounded_before_graph_work() {
    check(
        &engine(),
        &vec![change("leaf", "block-1"); MAX_HIERARCHY_NODES + 1],
        Err(HierarchyError::ResourceLimit),
    );
}
#[test]
fn excessive_snapshot_is_bounded_before_graph_work() {
    let d = engine();
    let s = d.snapshot().unwrap();
    let oversized = Snapshot {
        visible: vec![s.visible[0].clone(); MAX_HIERARCHY_NODES + 1],
        ..Snapshot::default()
    };
    assert_eq!(
        validate_hierarchy(&oversized, &[]),
        Err(HierarchyError::ResourceLimit)
    );
}
#[test]
fn duplicate_snapshot_ids_are_explicitly_invalid() {
    let d = engine();
    let mut s = d.snapshot().unwrap();
    s.visible.push(s.visible[0].clone());
    assert_eq!(
        validate_hierarchy(&s, &[]),
        Err(HierarchyError::InvalidSnapshot)
    );
}
#[test]
fn visible_recovery_overlap_is_explicitly_invalid() {
    let d = engine();
    let mut s = d.snapshot().unwrap();
    s.recovery.push(s.visible[0].clone());
    assert_eq!(
        validate_hierarchy(&s, &[]),
        Err(HierarchyError::InvalidSnapshot)
    );
}
#[test]
fn ordinary_v3_blocks_do_not_gain_list_semantics() {
    use editac_core::document::{CreationPermit, InitialNode};
    let identity = DocumentIdentity::v3(
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
    )
    .unwrap();
    let d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "abc".into(),
        }],
    )
    .unwrap();
    let id = d.snapshot().unwrap().visible[0].id.clone();
    check(
        &d,
        &[change(&id, "@root")],
        Err(HierarchyError::UnsupportedTarget(id)),
    );
}

#[path = "lists/production.rs"]
mod production;
