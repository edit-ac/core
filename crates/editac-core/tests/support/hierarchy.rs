//! Disposable FND-1.9 read policy; not production schema or repair commands.
#[allow(dead_code)]
#[path = "structure_registry.rs"]
pub(crate) mod registry;
use std::collections::{BTreeMap, BTreeSet};
use yrs::{Any, Doc, Map, Out, Text, Transact, XmlOut, XmlTextPrelim};

pub(crate) const ROOT: &str = "@root";
pub(crate) fn fixture() -> Doc {
    let doc = registry::replica(11);
    let nodes = doc.get_or_insert_map("registry-parents");
    let placements = doc.get_or_insert_map("registry-placements");
    let texts = doc.get_or_insert_map("registry-texts");
    {
        let mut txn = doc.transact_mut_with("fixture:init");
        for (id, parent, order, kind) in [
            ("a", ROOT, 0, "list"),
            ("b", ROOT, 1, "list"),
            ("c", "a", 0, "list"),
            ("d", "c", 0, "item"),
            ("e", "b", 0, "item"),
        ] {
            nodes.insert(&mut txn, id, kind);
            placements.insert(&mut txn, id, registry::placement(parent, order));
            let t = texts.insert(&mut txn, id, XmlTextPrelim::new("a😀b"));
            t.format(
                &mut txn,
                1,
                2,
                std::collections::HashMap::from([("bold".into(), Any::Bool(true))]),
            );
        }
    }
    doc
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Node {
    pub parent: String,
    pub order: u32,
    pub reason: Option<String>,
    pub identity: String,
    pub runs: Vec<(String, Vec<(String, String)>)>,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub nodes: BTreeMap<String, Node>,
    pub traversal: Vec<String>,
    pub edge_visits: usize,
}

pub(crate) fn project(doc: &Doc) -> Projection {
    let kinds = doc.get_or_insert_map("registry-parents");
    let placements = doc.get_or_insert_map("registry-placements");
    let texts = doc.get_or_insert_map("registry-texts");
    let txn = doc.transact();
    let ids: BTreeSet<String> = kinds.keys(&txn).map(str::to_owned).collect();
    let mut nodes = BTreeMap::new();
    for id in &ids {
        // Y.Map selects one entire concurrent tuple. Never recombine fields.
        let parsed = match placements.get(&txn, id) {
            Some(Out::Any(Any::Array(v))) => match v.as_ref() {
                [Any::String(p), Any::Number(n)] => n
                    .as_i64()
                    .and_then(|v| u32::try_from(v).ok())
                    .map(|n| (p.to_string(), n)),
                _ => None,
            },
            _ => None,
        };
        let (mut parent, order, mut reason) = match parsed {
            Some((p, n)) => (p, n, None),
            None => (ROOT.into(), 0, Some("invalid-or-missing-placement".into())),
        };
        if parent != ROOT
            && (!ids.contains(&parent) || kinds.get(&txn, &parent) != Some(Out::Any("list".into())))
        {
            parent = ROOT.into();
            reason = Some("orphan-or-invalid-parent".into());
        }
        let Some(Out::YXmlText(t)) = texts.get(&txn, id) else {
            panic!("missing retained text")
        };
        let runs = t
            .diff(&txn, |_| ())
            .into_iter()
            .map(|r| {
                let Out::Any(Any::String(s)) = r.insert else {
                    panic!("non-text")
                };
                let mut marks: Vec<_> = r
                    .attributes
                    .into_iter()
                    .flat_map(|a| *a)
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
                marks.sort();
                (s.to_string(), marks)
            })
            .collect();
        nodes.insert(
            id.clone(),
            Node {
                parent,
                order,
                reason,
                identity: format!("{:?}", XmlOut::Text(t).id()),
                runs,
            },
        );
    }
    // Functional graph: detach lexicographically smallest ID of each cycle.
    // Iterative bounded walks; no recursion and no platform repair writes.
    let mut edge_visits = 0;
    for start in &ids {
        let mut path: Vec<String> = Vec::new();
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        let mut current = start.clone();
        while current != ROOT {
            if let Some(&i) = seen.get(&current) {
                let cut = path[i..].iter().min().unwrap().clone();
                let node = nodes.get_mut(&cut).unwrap();
                node.parent = ROOT.into();
                node.reason = Some("cycle-cut".into());
                break;
            }
            assert!(path.len() < ids.len());
            seen.insert(current.clone(), path.len());
            path.push(current.clone());
            current = nodes[&current].parent.clone();
            edge_visits += 1;
        }
    }
    assert!(edge_visits <= ids.len() * ids.len());
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, n) in &nodes {
        children
            .entry(n.parent.clone())
            .or_default()
            .push(id.clone());
    }
    for children in children.values_mut() {
        children.sort_by_key(|id| (nodes[id].order, id.clone()));
    }
    let mut stack: Vec<_> = children
        .get(ROOT)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .rev()
        .collect();
    let mut traversal = Vec::new();
    while let Some(id) = stack.pop() {
        assert!(traversal.len() < ids.len());
        stack.extend(
            children
                .get(&id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .rev(),
        );
        traversal.push(id);
    }
    assert_eq!(traversal.len(), ids.len());
    Projection {
        nodes,
        traversal,
        edge_visits,
    }
}

// Raw admission represents remote/concurrent data, including invalid references.
pub(crate) fn raw_place(doc: &Doc, id: &str, parent: &str, order: u32) {
    let map = doc.get_or_insert_map("registry-placements");
    map.insert(
        &mut doc.transact_mut_with("fixture:move"),
        id,
        registry::placement(parent, order),
    );
}
pub(crate) fn move_node(doc: &Doc, id: &str, parent: &str, order: u32) -> Result<(), &'static str> {
    let p = project(doc);
    let kinds = doc.get_or_insert_map("registry-parents");
    if !p.nodes.contains_key(id)
        || (parent != ROOT && kinds.get(&doc.transact(), parent) != Some(Out::Any("list".into())))
    {
        return Err("invalid target");
    }
    let mut ancestor = parent;
    while ancestor != ROOT {
        if ancestor == id {
            return Err("ancestor/descendant move");
        }
        ancestor = &p.nodes[ancestor].parent;
    }
    raw_place(doc, id, parent, order);
    Ok(())
}
