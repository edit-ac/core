//! Disposable FND-1.5 candidate, not the frozen schema or production commands.
//! A move replaces one atomic placement value, never the integrated rich text.
//! Each replica has one Yrs document; projection is a read, not a second CRDT.
use std::collections::HashMap;
use yrs::{
    Any, Doc, Map, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact, Update, XmlOut,
    XmlTextPrelim, XmlTextRef, updates::decoder::Decode,
};

// Identical logical content/parents/offsets to the FND-1.4 XML candidate.
const BLOCK: &str = "block-1";
const INPUT: &str = "a😀b";
pub(crate) fn replica(id: u64) -> Doc {
    Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(id),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

pub(crate) fn placement(parent: &str, order: u32) -> Any {
    // One immutable Any array in one map entry. Independent parent/order map
    // fields could merge into a placement neither writer actually requested.
    Any::Array(vec![Any::from(parent), Any::from(order)].into())
}

pub(crate) fn fixture() -> Doc {
    fixture_with_input(INPUT)
}

pub(crate) fn fixture_with_input(input: &str) -> Doc {
    let doc = replica(11);
    let parents = doc.get_or_insert_map("registry-parents");
    let texts = doc.get_or_insert_map("registry-texts");
    let placements = doc.get_or_insert_map("registry-placements");
    {
        let mut txn = doc.transact_mut_with("fixture:init");
        parents.insert(&mut txn, "left", "section");
        parents.insert(&mut txn, "right", "section");
        let t = texts.insert(&mut txn, BLOCK, XmlTextPrelim::new(input));
        t.format(
            &mut txn,
            1,
            2,
            HashMap::from([("bold".into(), Any::Bool(true))]),
        );
        placements.insert(&mut txn, BLOCK, placement("left", 0));
    }
    doc
}

pub(crate) fn text(doc: &Doc) -> XmlTextRef {
    let texts = doc.get_or_insert_map("registry-texts");
    let txn = doc.transact();
    assert_eq!(texts.len(&txn), 1);
    let Some(Out::YXmlText(t)) = texts.get(&txn, BLOCK) else {
        panic!("missing stable rich text");
    };
    t
}

pub(crate) fn apply(doc: &Doc, bytes: &[u8]) {
    doc.transact_mut_with("fixture:remote")
        .apply_update(Update::decode_v1(bytes).unwrap())
        .unwrap();
}

pub(crate) fn full_update(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub(crate) fn edit(doc: &Doc) {
    let t = text(doc);
    t.insert_with_attributes(
        &mut doc.transact_mut_with("fixture:edit"),
        3,
        "!",
        HashMap::from([("italic".into(), Any::Bool(true))]),
    );
}

pub(crate) fn relocate(doc: &Doc, parent: &str, order: u32) {
    let parents = doc.get_or_insert_map("registry-parents");
    let placements = doc.get_or_insert_map("registry-placements");
    // Prepare the complete value and validate the target before mutating.
    assert_eq!(
        parents.get(&doc.transact(), parent),
        Some(Out::Any("section".into()))
    );
    let value = placement(parent, order);
    placements.insert(&mut doc.transact_mut_with("fixture:move"), BLOCK, value);
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub(crate) block_id: String,
    pub(crate) parent: String,
    pub(crate) order: u32,
    pub(crate) text_identity: String,
    pub(crate) runs: Vec<(String, Vec<(String, String)>)>,
    pub(crate) utf16_len: u32,
}

pub(crate) fn project(doc: &Doc) -> Projection {
    let parents = doc.get_or_insert_map("registry-parents");
    let placements = doc.get_or_insert_map("registry-placements");
    let t = text(doc);
    let txn = doc.transact();
    assert_eq!(parents.len(&txn), 2);
    for parent in ["left", "right"] {
        assert_eq!(parents.get(&txn, parent), Some(Out::Any("section".into())));
    }
    // Exactly one visible placement and one shared text for the logical block.
    assert_eq!(placements.len(&txn), 1);
    let Some(Out::Any(Any::Array(tuple))) = placements.get(&txn, BLOCK) else {
        panic!("placement must be one atomic tuple");
    };
    let [Any::String(parent), Any::Number(order)] = tuple.as_ref() else {
        panic!("unexpected placement shape");
    };
    assert!(parent.as_ref() == "left" || parent.as_ref() == "right");
    let order = u32::try_from(order.as_i64().expect("integer placement order")).unwrap();
    let runs = t
        .diff(&txn, |_| ())
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(value)) = run.insert else {
                panic!("non-text run");
            };
            let mut marks: Vec<_> = run
                .attributes
                .into_iter()
                .flat_map(|attrs| *attrs)
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect();
            marks.sort();
            (value.to_string(), marks)
        })
        .collect();
    Projection {
        block_id: BLOCK.into(),
        parent: parent.to_string(),
        order,
        text_identity: format!("{:?}", XmlOut::Text(t.clone()).id()),
        runs,
        utf16_len: t.len(&txn),
    }
}
