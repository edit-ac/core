//! Canonical FND-1.10 aggregator: original families plus same-document races.
#[path = "delete_edit_probe.rs"]
mod delete_edit;
#[path = "hierarchy_probe.rs"]
mod hierarchy;
#[path = "support/structure_conflicts.rs"]
mod policy;
#[path = "split_join_probe.rs"]
mod split_join;
use policy::{hierarchy::registry, layout};
use yrs::{Any, Doc, ReadTxn, Text, Transact};

#[test]
fn maximum_order_local_split_rejects_without_mutation() {
    let doc = policy::fixture();
    policy::hierarchy::raw_place(&doc, layout::FIRST, policy::hierarchy::ROOT, u32::MAX);
    let before = registry::full_update(&doc);
    let vector = doc.transact().state_vector();
    assert_eq!(layout::split(&doc, 3), Err("derived order out of range"));
    assert_eq!(registry::full_update(&doc), before);
    assert_eq!(doc.transact().state_vector(), vector);
}

#[test]
fn concurrent_split_and_maximum_order_move_preserve_explicit_recovery() {
    let base = registry::full_update(&policy::fixture());
    let split_writer = writer(21, &base);
    let move_writer = writer(22, &base);
    let vector = split_writer.transact().state_vector();
    layout::split(&split_writer, 3).unwrap();
    policy::hierarchy::raw_place(
        &move_writer,
        layout::FIRST,
        policy::hierarchy::ROOT,
        u32::MAX,
    );
    let updates = [
        base,
        split_writer.transact().encode_state_as_update_v1(&vector),
        move_writer.transact().encode_state_as_update_v1(&vector),
    ];
    for order in permutations(3) {
        for id in [101, 102, 103] {
            let doc = registry::replica(id);
            for &i in order.iter().chain(&order).chain(order.iter().rev()) {
                registry::apply(&doc, &updates[i]);
            }
            let before = registry::full_update(&doc);
            let vector = doc.transact().state_vector();
            let recovery = policy::try_project(&doc).unwrap_err();
            assert_eq!(recovery.reason, "derived order out of range");
            assert_eq!(recovery.update_v1, before);
            assert_eq!(registry::full_update(&doc), before);
            assert_eq!(doc.transact().state_vector(), vector);
            let restored = writer(201, &recovery.update_v1);
            assert_eq!(policy::try_project(&restored).unwrap_err(), recovery);
        }
    }
}

fn writer(id: u64, base: &[u8]) -> Doc {
    let doc = registry::replica(id);
    registry::apply(&doc, base);
    doc
}
fn permutations(n: usize) -> Vec<Vec<usize>> {
    fn visit(prefix: Vec<usize>, rest: Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if rest.is_empty() {
            out.push(prefix.clone());
        }
        for i in 0..rest.len() {
            let mut remaining = rest.clone();
            let mut next = prefix.clone();
            next.push(remaining.remove(i));
            visit(next, remaining, out);
        }
    }
    let mut out = vec![];
    visit(vec![], (0..n).collect(), &mut out);
    out
}
fn read(doc: &Doc) -> policy::Projection {
    let before = registry::full_update(doc);
    let sv = doc.transact().state_vector();
    let p = policy::project(doc);
    assert_eq!(p, policy::project(doc));
    assert_eq!(sv, doc.transact().state_vector());
    assert_eq!(before, registry::full_update(doc));
    p
}
fn race(name: &str, operations: &[fn(&Doc)], expected: fn(&policy::Projection)) {
    let base = registry::full_update(&policy::fixture());
    let initial = writer(81, &base);
    let identities = read(&initial).identities;
    let sv = initial.transact().state_vector();
    let writers: Vec<_> = operations
        .iter()
        .enumerate()
        .map(|(i, op)| {
            let w = writer(21 + i as u64, &base);
            op(&w);
            w
        })
        .collect();
    let mut updates = vec![base];
    updates.extend(
        writers
            .iter()
            .map(|w| w.transact().encode_state_as_update_v1(&sv)),
    );
    let mut projection = None;
    for order in permutations(updates.len()) {
        for id in [101, 102, 103] {
            let replica = registry::replica(id);
            for &i in &order {
                registry::apply(&replica, &updates[i]);
                registry::apply(&replica, &updates[i]);
            }
            for &i in order.iter().rev() {
                registry::apply(&replica, &updates[i]);
            }
            let p = read(&replica);
            expected(&p);
            assert_eq!(p.identities, identities);
            if let Some(prior) = &projection {
                assert_eq!(prior, &p);
            }
            assert_eq!(p, read(&writer(201, &registry::full_update(&replica))));
            projection = Some(p);
        }
    }
    for w in writers {
        for update in &updates {
            registry::apply(&w, update);
        }
        assert_eq!(projection.as_ref().unwrap(), &read(&w));
    }
    if let Some(dir) = std::env::var_os("EDITAC_CONFLICTS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{name}.txt")),
            format!("{:#?}\n", projection.unwrap()),
        )
        .unwrap();
        for (i, bytes) in updates.iter().enumerate() {
            std::fs::write(dir.join(format!("{name}-{i}.bin")), bytes).unwrap();
        }
    }
}
fn delete_first(d: &Doc) {
    policy::delete(d, layout::FIRST);
}
fn delete_second(d: &Doc) {
    policy::delete(d, layout::SECOND);
}
fn edit(d: &Doc) {
    layout::text(d, layout::FIRST).insert_with_attributes(
        &mut d.transact_mut_with("fixture:edit"),
        3,
        "!",
        std::collections::HashMap::from([("italic".into(), Any::Bool(true))]),
    );
}
fn split(d: &Doc) {
    layout::split(d, 3).unwrap();
}
fn join(d: &Doc) {
    layout::join(d).unwrap();
}
fn nest(d: &Doc) {
    policy::hierarchy::move_node(d, layout::SECOND, layout::FIRST, 0).unwrap();
}
fn first_under_second(d: &Doc) {
    policy::hierarchy::move_node(d, layout::FIRST, layout::SECOND, 0).unwrap();
}
fn contents(blocks: &[layout::Block]) -> Vec<String> {
    blocks.iter().map(|b| b.content()).collect()
}

#[test]
fn deletion_masks_both_split_owners_but_retains_concurrent_marked_content() {
    race("delete-split-edit", &[delete_first, split, edit], |p| {
        assert_eq!(contents(&p.visible), ["cאבd"]);
        assert_eq!(contents(&p.recovery), ["a😀", "!b"]);
        assert_eq!(p.recovery[1].runs[0].1, [("italic".into(), "true".into())]);
    });
}
#[test]
fn deleting_join_owner_hides_all_owned_sources_without_losing_identity() {
    race("delete-join-edit", &[delete_first, join, edit], |p| {
        assert!(p.visible.is_empty());
        assert_eq!(contents(&p.recovery), ["a😀!bcאבd"]);
        assert_eq!(p.recovery[0].spans.len(), 2);
    });
}
#[test]
fn deleting_absorbed_source_hides_only_its_span() {
    race(
        "delete-source-join-edit",
        &[delete_second, join, edit],
        |p| {
            assert_eq!(contents(&p.visible), ["a😀!b"]);
            assert_eq!(contents(&p.recovery), ["cאבd"]);
        },
    );
}
#[test]
fn deleted_parent_promotes_visible_child_without_repair_writes() {
    race("delete-nest-edit", &[delete_first, nest, edit], |p| {
        assert_eq!(contents(&p.visible), ["cאבd"]);
        assert_eq!(p.visible[0].parent, policy::hierarchy::ROOT);
        assert_eq!(contents(&p.recovery), ["a😀!b"]);
    });
}
#[test]
fn joined_owner_with_absorbed_parent_is_projected_at_root() {
    race("join-nest-edit", &[join, first_under_second, edit], |p| {
        assert_eq!(contents(&p.visible), ["a😀!bcאבd"]);
        assert_eq!(p.visible[0].parent, policy::hierarchy::ROOT);
        assert!(p.recovery.is_empty());
    });
}
#[test]
fn concurrent_cycle_and_delete_preserve_one_visible_root_and_recovery() {
    race(
        "cycle-delete",
        &[first_under_second, nest, delete_first],
        |p| {
            assert_eq!(contents(&p.visible), ["cאבd"]);
            assert_eq!(p.visible[0].parent, policy::hierarchy::ROOT);
            assert_eq!(contents(&p.recovery), ["a😀b"]);
        },
    );
}

#[test]
fn concurrent_split_join_selects_complete_join_descriptor() {
    race("split-join-edit", &[split, join, edit], |p| {
        assert_eq!(contents(&p.visible), ["a😀!bcאבd"]);
        assert_eq!(p.visible[0].spans.len(), 2);
        assert!(p.recovery.is_empty());
    });
}
#[test]
fn reversed_writer_assignment_selects_complete_split_descriptor() {
    race("join-split-edit", &[join, split, edit], |p| {
        // Both outputs have order 1; stable ID puts block-2 before block-split.
        assert_eq!(contents(&p.visible), ["a😀", "cאבd", "!b"]);
        assert!(p.visible.iter().all(|b| b.spans.len() == 1));
        assert!(p.recovery.is_empty());
    });
}
