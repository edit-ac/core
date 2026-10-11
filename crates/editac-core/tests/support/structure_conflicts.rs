//! Disposable composed FND-1.10 policy; schema/profile freeze is a separate gate.
#[path = "hierarchy.rs"]
pub(crate) mod hierarchy;
#[path = "split_join.rs"]
pub(crate) mod layout;
use hierarchy::registry;
use std::collections::BTreeSet;
use yrs::{Doc, Map, Transact};

pub(crate) fn fixture() -> Doc {
    let doc = layout::fixture();
    let kinds = doc.get_or_insert_map("registry-parents");
    let placements = doc.get_or_insert_map("registry-placements");
    {
        let mut txn = doc.transact_mut_with("fixture:compose");
        // The pair itself is the hierarchy fixture; no extra texts or identities.
        kinds.remove(&mut txn, "left");
        kinds.remove(&mut txn, "right");
        for (id, order) in [(layout::FIRST, 0), (layout::SECOND, 1)] {
            kinds.insert(&mut txn, id, "list");
            placements.insert(&mut txn, id, registry::placement(hierarchy::ROOT, order));
        }
    }
    doc.get_or_insert_map("delete-probe-tombstones");
    doc
}

pub(crate) fn delete(doc: &Doc, id: &str) {
    assert!([layout::FIRST, layout::SECOND].contains(&id));
    doc.get_or_insert_map("delete-probe-tombstones").insert(
        &mut doc.transact_mut_with("fixture:delete"),
        id,
        true,
    );
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub visible: Vec<layout::Block>,
    pub recovery: Vec<layout::Block>,
    pub identities: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Recovery {
    pub reason: &'static str,
    pub update_v1: Vec<u8>,
}

/// Positive-case assertion helper; restored or concurrent state uses try_project.
pub(crate) fn project(doc: &Doc) -> Projection {
    try_project(doc).expect("trusted fixture requires explicit recovery")
}

pub(crate) fn try_project(doc: &Doc) -> Result<Projection, Recovery> {
    let preserve = |reason| Recovery {
        reason,
        update_v1: registry::full_update(doc),
    };
    let graph = hierarchy::project(doc);
    let tombstones = doc.get_or_insert_map("delete-probe-tombstones");
    let deleted: BTreeSet<String> = {
        let txn = doc.transact();
        tombstones
            .iter(&txn)
            .map(|(id, value)| {
                assert_eq!(value, yrs::Out::Any(true.into()));
                id.to_owned()
            })
            .collect()
    };
    let mut visible = vec![];
    let mut recovery = vec![];
    for mut block in layout::try_project(doc).map_err(preserve)? {
        // A split's new logical owner inherits the source placement. A join's
        // first owner keeps its placement. Repair cycles before visibility.
        let placement_id = if block.id == "block-split" {
            layout::FIRST
        } else {
            &block.id
        };
        let node = &graph.nodes[placement_id];
        block.parent = node.parent.clone();
        block.order = node
            .order
            .checked_add(u32::from(block.id == "block-split"))
            .ok_or_else(|| preserve("derived order out of range"))?;
        for hidden in [false, true] {
            let mut part = block.clone();
            part.spans.retain(|span| {
                (deleted.contains(&block.id) || deleted.contains(&span.source)) == hidden
            });
            if part.spans.is_empty() {
                continue;
            }
            part.runs = part
                .spans
                .iter()
                .flat_map(|s| {
                    layout::slice_runs(&layout::text(doc, &s.source), doc, s.start, s.end)
                })
                .collect();
            if hidden {
                recovery.push(part);
            } else {
                visible.push(part);
            }
        }
    }
    let visible_ids: BTreeSet<_> = visible.iter().map(|b| b.id.clone()).collect();
    // Hidden/absorbed parents do not make their visible children disappear.
    for b in &mut visible {
        if b.parent != hierarchy::ROOT && !visible_ids.contains(&b.parent) {
            b.parent = hierarchy::ROOT.into();
        }
    }
    // Deterministic preorder over the surviving projected owners.
    let children = |parent: &str| {
        let mut items: Vec<_> = visible
            .iter()
            .filter(|b| b.parent == parent)
            .cloned()
            .collect();
        items.sort_by_key(|b| (b.order, b.id.clone()));
        items
    };
    let mut ordered = vec![];
    let mut stack: Vec<_> = children(hierarchy::ROOT).into_iter().rev().collect();
    while let Some(block) = stack.pop() {
        stack.extend(children(&block.id).into_iter().rev());
        ordered.push(block);
        assert!(ordered.len() <= visible.len());
    }
    assert_eq!(ordered.len(), visible.len());
    Ok(Projection {
        visible: ordered,
        recovery,
        identities: graph
            .nodes
            .into_iter()
            .map(|(id, n)| (id, n.identity))
            .collect(),
    })
}
