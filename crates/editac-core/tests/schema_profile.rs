//! FND-1.11 local construction mapping, not cross-language qualification.
#[allow(dead_code)]
#[path = "support/structure_conflicts.rs"]
mod policy;
use std::collections::HashMap;
use yrs::{Any, Doc, Map, Out, ReadTxn, Text, Transact, XmlTextPrelim};

fn construct_seed() -> Doc {
    let doc = policy::hierarchy::registry::replica(11);
    let kinds = doc.get_or_insert_map("registry-parents");
    let texts = doc.get_or_insert_map("registry-texts");
    let placements = doc.get_or_insert_map("registry-placements");
    let _tombstones = doc.get_or_insert_map("delete-probe-tombstones");
    let layout = doc.get_or_insert_map("probe-split-join");
    {
        let mut txn = doc.transact_mut_with("initialize");
        for (id, input, order, mark) in [
            ("block-1", "a😀b", 0u32, "bold"),
            ("block-2", "cאבd", 1u32, "code"),
        ] {
            kinds.insert(&mut txn, id, "list");
            let text = texts.insert(&mut txn, id, XmlTextPrelim::new(input));
            text.format(
                &mut txn,
                1,
                2,
                HashMap::from([(mark.into(), Any::Bool(true))]),
            );
            placements.insert(
                &mut txn,
                id,
                Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
            );
        }
        layout.insert(
            &mut txn,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    doc
}

#[test]
fn frozen_rust_construction_matches_selected_semantics_and_typed_roots() {
    let doc = construct_seed();
    let selected = policy::fixture();
    let actual = policy::project(&doc);
    let expected = policy::project(&selected);
    assert!(actual.recovery.is_empty());
    assert_eq!(actual.visible.len(), 2);
    for (a, b) in actual.visible.iter().zip(&expected.visible) {
        assert_eq!(
            (&a.id, &a.parent, a.order, &a.runs),
            (&b.id, &b.parent, b.order, &b.runs)
        );
    }
    let kinds = doc.get_or_insert_map("registry-parents");
    let texts = doc.get_or_insert_map("registry-texts");
    let places = doc.get_or_insert_map("registry-placements");
    let deleted = doc.get_or_insert_map("delete-probe-tombstones");
    let layouts = doc.get_or_insert_map("probe-split-join");
    let txn = doc.transact();
    let mut root_names: Vec<_> = txn.root_refs().map(|(name, _)| name.to_owned()).collect();
    root_names.sort();
    assert_eq!(
        root_names,
        [
            "delete-probe-tombstones",
            "probe-split-join",
            "registry-parents",
            "registry-placements",
            "registry-texts"
        ]
    );
    assert_eq!(deleted.len(&txn), 0);
    assert_eq!(layouts.len(&txn), 1);
    for (id, order) in [("block-1", 0u32), ("block-2", 1u32)] {
        assert_eq!(kinds.get(&txn, id), Some(Out::Any("list".into())));
        let Some(Out::YXmlText(text)) = texts.get(&txn, id) else {
            panic!("nested XmlText required")
        };
        assert_eq!(text.len(&txn), 4);
        assert_eq!(
            places.get(&txn, id),
            Some(Out::Any(Any::Array(
                vec![Any::from("@root"), Any::from(order)].into()
            )))
        );
    }
}

#[test]
fn frozen_atomic_split_descriptor_preserves_original_identities_on_restore() {
    let doc = construct_seed();
    let identities = policy::project(&doc).identities;
    policy::layout::split(&doc, 3).unwrap();
    let map = doc.get_or_insert_map("probe-split-join");
    {
        let txn = doc.transact();
        let Some(Out::Any(Any::Array(value))) = map.get(&txn, "pair") else {
            panic!("atomic array required")
        };
        assert!(
            matches!(value.as_ref(), [Any::String(mode), Any::Buffer(bytes)] if mode.as_ref() == "split" && !bytes.is_empty())
        );
    }
    let restored = policy::hierarchy::registry::replica(91);
    let bytes = policy::hierarchy::registry::full_update(&doc);
    policy::hierarchy::registry::apply(&restored, &bytes);
    policy::hierarchy::registry::apply(&restored, &bytes);
    let projected = policy::project(&restored);
    assert_eq!(projected.identities, identities);
    assert_eq!(
        projected
            .visible
            .iter()
            .map(|b| (b.id.as_str(), b.content()))
            .collect::<Vec<_>>(),
        vec![
            ("block-1", "a😀".into()),
            ("block-2", "cאבd".into()),
            ("block-split", "b".into())
        ]
    );
}

#[test]
fn frozen_unknown_kind_and_mark_remain_retained_without_projection_writes() {
    let doc = construct_seed();
    let kinds = doc.get_or_insert_map("registry-parents");
    let text = policy::layout::text(&doc, "block-2");
    {
        let mut txn = doc.transact_mut_with("local:fixture");
        kinds.insert(&mut txn, "block-2", "unknown-widget");
        text.format(
            &mut txn,
            1,
            2,
            HashMap::from([("unknown-mark".into(), Any::from("retained"))]),
        );
    }
    let before = policy::hierarchy::registry::full_update(&doc);
    let view = policy::project(&doc);
    assert_eq!(view.visible[1].content(), "cאבd");
    assert!(
        view.visible[1].runs[1]
            .1
            .contains(&("unknown-mark".into(), "retained".into()))
    );
    assert_eq!(policy::hierarchy::registry::full_update(&doc), before);
    assert_eq!(
        kinds.get(&doc.transact(), "block-2"),
        Some(Out::Any("unknown-widget".into()))
    );
}
