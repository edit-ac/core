//! Disposable FND-1.4 candidate, not an editor schema or production move command.
//! Relocation snapshots an XML subtree, inserts fresh shared types, then removes
//! the original. Equal application IDs/content do not imply equal CRDT identity.
use std::collections::HashMap;
use yrs::{
    Any, Doc, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact, Update, Xml,
    XmlElementPrelim, XmlElementRef, XmlFragment, XmlOut, XmlTextPrelim, XmlTextRef,
    types::AsPrelim, updates::decoder::Decode,
};

// The FND-1.2 astral fixture: offsets 1..3 cover the emoji; 3 is after it.
const INPUT: &str = "a😀b";
pub(crate) fn replica(id: u64) -> Doc {
    Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(id),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

pub(crate) fn containers(doc: &Doc) -> [XmlElementRef; 2] {
    let root = doc.get_or_insert_xml_fragment("xml-probe");
    let txn = doc.transact();
    assert_eq!(root.len(&txn), 2);
    [0, 1].map(|i| root.get(&txn, i).unwrap().into_xml_element().unwrap())
}

pub(crate) fn block(doc: &Doc, parent: usize) -> XmlElementRef {
    let parents = containers(doc);
    let txn = doc.transact();
    assert_eq!(parents[parent].len(&txn), 1);
    parents[parent]
        .get(&txn, 0)
        .unwrap()
        .into_xml_element()
        .unwrap()
}

pub(crate) fn text(doc: &Doc, parent: usize) -> XmlTextRef {
    let block = block(doc, parent);
    let txn = doc.transact();
    assert_eq!(block.len(&txn), 1);
    block.get(&txn, 0).unwrap().into_xml_text().unwrap()
}

pub(crate) fn identity(text: &XmlTextRef) -> String {
    format!("{:?}", XmlOut::Text(text.clone()).id())
}

pub(crate) fn fixture() -> Doc {
    fixture_with_input(INPUT)
}

pub(crate) fn fixture_with_input(input: &str) -> Doc {
    let doc = replica(11);
    let root = doc.get_or_insert_xml_fragment("xml-probe");
    {
        let mut txn = doc.transact_mut_with("fixture:init");
        let left = root.insert(&mut txn, 0, XmlElementPrelim::empty("section"));
        left.insert_attribute(&mut txn, "id", "left");
        let right = root.insert(&mut txn, 1, XmlElementPrelim::empty("section"));
        right.insert_attribute(&mut txn, "id", "right");
        let p = left.insert(&mut txn, 0, XmlElementPrelim::empty("p"));
        p.insert_attribute(&mut txn, "id", "block-1");
        let t = p.insert(&mut txn, 0, XmlTextPrelim::new(input));
        t.format(
            &mut txn,
            1,
            2,
            HashMap::from([("bold".into(), Any::Bool(true))]),
        );
    }
    doc
}

pub(crate) fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut_with("fixture:remote")
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

pub(crate) fn full_update(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub(crate) fn edit(doc: &Doc, parent: usize) {
    let t = text(doc, parent);
    let mut txn = doc.transact_mut_with("fixture:edit");
    t.insert_with_attributes(
        &mut txn,
        3,
        "!",
        HashMap::from([("italic".into(), Any::Bool(true))]),
    );
}

pub(crate) fn relocate(doc: &Doc) {
    let parents = containers(doc);
    let source = block(doc, 0);
    // Prepare the immutable content/mark snapshot before mutation. This is a
    // fresh preliminary subtree, not the already integrated original branch.
    let copy = source.as_prelim(&doc.transact());
    let mut txn = doc.transact_mut_with("fixture:clone-remove-move");
    parents[1].insert(&mut txn, 0, copy);
    parents[0].remove(&mut txn, 0);
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub(crate) parent: usize,
    pub(crate) block_id: String,
    pub(crate) element_identity: String,
    pub(crate) text_identity: String,
    // Text content and exact rich-text marks, independently of update bytes.
    pub(crate) runs: Vec<(String, Vec<(String, String)>)>,
    pub(crate) utf16_len: u32,
}

pub(crate) fn project(doc: &Doc, parent: usize) -> Projection {
    let parents = containers(doc);
    let p = block(doc, parent);
    let t = text(doc, parent);
    let txn = doc.transact();
    assert_eq!(parents[1 - parent].len(&txn), 0);
    assert_eq!(
        parents[0].get_attribute(&txn, "id"),
        Some(Out::Any("left".into()))
    );
    assert_eq!(
        parents[1].get_attribute(&txn, "id"),
        Some(Out::Any("right".into()))
    );
    assert_eq!(p.tag().as_ref(), "p");
    assert_eq!(
        p.get_attribute(&txn, "id"),
        Some(Out::Any("block-1".into()))
    );
    let runs = t
        .diff(&txn, |_| ())
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(value)) = run.insert else {
                panic!("unexpected non-text run");
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
        parent,
        block_id: "block-1".into(),
        element_identity: format!("{:?}", XmlOut::Element(p).id()),
        text_identity: identity(&t),
        runs,
        utf16_len: t.len(&txn),
    }
}
