//! Disposable FND-1.8 extension of the selected registry. No production schema.
//! Split partitions one existing text by a relative boundary; join concatenates
//! references to two existing texts. Neither operation copies/deletes rich text.
//! One atomic descriptor owns this fixture's affected pair, avoiding half-joins.
#[allow(dead_code)]
#[path = "structure_registry.rs"]
pub(crate) mod registry;

use std::collections::HashMap;
use yrs::{
    Any, Assoc, Doc, IndexedSequence, Map, Out, StickyIndex, Text, Transact, XmlOut, XmlTextPrelim,
    XmlTextRef,
    updates::{decoder::Decode, encoder::Encode},
};

pub(crate) const FIRST: &str = "block-1";
pub(crate) const SECOND: &str = "block-2";
const LAYOUT: &str = "probe-split-join";
pub(crate) type Runs = Vec<(String, Vec<(String, String)>)>;

pub(crate) fn fixture() -> Doc {
    let doc = registry::fixture();
    let texts = doc.get_or_insert_map("registry-texts");
    let placements = doc.get_or_insert_map("registry-placements");
    let layout = doc.get_or_insert_map(LAYOUT);
    {
        let mut txn = doc.transact_mut_with("fixture:second-text");
        let t = texts.insert(&mut txn, SECOND, XmlTextPrelim::new("cאבd"));
        t.format(
            &mut txn,
            1,
            2,
            HashMap::from([("code".into(), true.into())]),
        );
        placements.insert(&mut txn, SECOND, registry::placement("right", 0));
        layout.insert(&mut txn, "pair", descriptor("original", None));
    }
    doc
}

pub(crate) fn text(doc: &Doc, key: &str) -> XmlTextRef {
    let texts = doc.get_or_insert_map("registry-texts");
    let Some(Out::YXmlText(t)) = texts.get(&doc.transact(), key) else {
        panic!("missing persistent text {key}");
    };
    t
}

fn descriptor(mode: &str, cut: Option<Vec<u8>>) -> Any {
    let mut tuple = vec![Any::from(mode)];
    if let Some(bytes) = cut {
        tuple.push(Any::Buffer(bytes.into()));
    }
    Any::Array(tuple.into())
}

fn mode(doc: &Doc) -> (String, Option<StickyIndex>) {
    let map = doc.get_or_insert_map(LAYOUT);
    let Some(Out::Any(Any::Array(tuple))) = map.get(&doc.transact(), "pair") else {
        panic!("missing atomic ownership descriptor");
    };
    match tuple.as_ref() {
        [Any::String(mode)] if mode.as_ref() == "original" || mode.as_ref() == "join" => {
            (mode.to_string(), None)
        }
        [Any::String(mode), Any::Buffer(bytes)] if mode.as_ref() == "split" => (
            mode.to_string(),
            Some(StickyIndex::decode_v1(bytes).unwrap()),
        ),
        _ => panic!("invalid ownership descriptor"),
    }
}

fn plain_text<T: yrs::ReadTxn>(t: &XmlTextRef, txn: &T) -> String {
    t.diff(txn, |_| ())
        .into_iter()
        .map(|run| {
            let Out::Any(Any::String(value)) = run.insert else {
                panic!("non-text run");
            };
            value.to_string()
        })
        .collect()
}

fn relative<T: yrs::ReadTxn>(
    t: &XmlTextRef,
    txn: &T,
    index: u32,
    assoc: Assoc,
) -> Option<StickyIndex> {
    // Yrs sticky_index returns None for a right-associated end position.
    // A type-scoped endpoint represents the growing end of this original text.
    if index == t.len(txn) && assoc == Assoc::After {
        Some(StickyIndex::from_type(txn, t, assoc))
    } else {
        t.sticky_index(txn, index, assoc)
    }
}

fn valid_boundary(value: &str, offset: u32) -> bool {
    let mut n = 0;
    for c in value.chars() {
        if n == offset {
            return true;
        }
        n += c.len_utf16() as u32;
    }
    n == offset
}

pub(crate) fn split(doc: &Doc, offset: u32) -> Result<(), &'static str> {
    // Prepare all fallible work before acquiring a mutable transaction.
    if mode(doc).0 != "original" {
        return Err("pair already transformed");
    }
    placement(doc, FIRST)
        .1
        .checked_add(1)
        .ok_or("derived order out of range")?;
    let t = text(doc, FIRST);
    let value = {
        let txn = doc.transact();
        if !valid_boundary(&plain_text(&t, &txn), offset) {
            return Err("invalid UTF-16 boundary");
        }
        // Left affinity: inserts at the original cut belong to the new right block.
        descriptor(
            "split",
            Some(
                t.sticky_index(&txn, offset, Assoc::Before)
                    .ok_or("unresolvable cut")?
                    .encode_v1(),
            ),
        )
    };
    doc.get_or_insert_map(LAYOUT).insert(
        &mut doc.transact_mut_with("fixture:split"),
        "pair",
        value,
    );
    Ok(())
}

pub(crate) fn join(doc: &Doc) -> Result<(), &'static str> {
    if mode(doc).0 != "original" {
        return Err("pair already transformed");
    }
    // Resolve both references before mutation. The first block keeps its placement;
    // the second text remains registered, owned by the first block's second span.
    let _ = (text(doc, FIRST), text(doc, SECOND));
    let value = descriptor("join", None);
    doc.get_or_insert_map(LAYOUT)
        .insert(&mut doc.transact_mut_with("fixture:join"), "pair", value);
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub(crate) source: String,
    pub(crate) identity: String,
    pub(crate) start: u32,
    pub(crate) end: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Block {
    pub(crate) id: String,
    pub(crate) parent: String,
    pub(crate) order: u32,
    pub(crate) spans: Vec<Span>,
    pub(crate) runs: Runs,
}

impl Block {
    pub(crate) fn content(&self) -> String {
        self.runs.iter().map(|(s, _)| s.as_str()).collect()
    }
    pub(crate) fn len(&self) -> u32 {
        self.spans.iter().map(|s| s.end - s.start).sum()
    }
}

pub(crate) fn slice_runs(t: &XmlTextRef, doc: &Doc, start: u32, end: u32) -> Runs {
    let txn = doc.transact();
    let mut pos = 0;
    let mut runs = vec![];
    for run in t.diff(&txn, |_| ()) {
        let Out::Any(Any::String(value)) = run.insert else {
            panic!("non-text run");
        };
        let mut marks: Vec<_> = run
            .attributes
            .into_iter()
            .flat_map(|a| *a)
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        marks.sort();
        let mut part = String::new();
        for c in value.chars() {
            let next = pos + c.len_utf16() as u32;
            if next > start && pos < end {
                assert!(
                    pos >= start && next <= end,
                    "projection split a surrogate pair"
                );
                part.push(c);
            }
            pos = next;
        }
        if !part.is_empty() {
            runs.push((part, marks));
        }
    }
    runs
}

fn placement(doc: &Doc, key: &str) -> (String, u32) {
    let placements = doc.get_or_insert_map("registry-placements");
    let txn = doc.transact();
    let Some(Out::Any(Any::Array(tuple))) = placements.get(&txn, key) else {
        panic!("missing placement");
    };
    let [Any::String(parent), Any::Number(order)] = tuple.as_ref() else {
        panic!("invalid placement");
    };
    (
        parent.to_string(),
        u32::try_from(order.as_i64().unwrap()).unwrap(),
    )
}

/// Positive-case assertion helper; recovery-capable callers use try_project.
pub(crate) fn project(doc: &Doc) -> Vec<Block> {
    try_project(doc).expect("trusted fixture requires explicit recovery")
}

pub(crate) fn try_project(doc: &Doc) -> Result<Vec<Block>, &'static str> {
    let (mode, cut) = mode(doc);
    let a = text(doc, FIRST);
    let b = text(doc, SECOND);
    let texts = doc.get_or_insert_map("registry-texts");
    let (ap, ao) = placement(doc, FIRST);
    let (bp, bo) = placement(doc, SECOND);
    let txn = doc.transact();
    assert_eq!(texts.len(&txn), 2, "never clone shared text");
    let span = |key: &str, t: &XmlTextRef, start, end| Span {
        source: key.into(),
        identity: format!("{:?}", XmlOut::Text(t.clone()).id()),
        start,
        end,
    };
    let first = span(FIRST, &a, 0, a.len(&txn));
    let second = span(SECOND, &b, 0, b.len(&txn));
    let block = |id: &str, parent: &str, order, spans: Vec<Span>| {
        let mut runs = vec![];
        for s in &spans {
            let t = if s.source == FIRST { &a } else { &b };
            runs.extend(slice_runs(t, doc, s.start, s.end));
        }
        Block {
            id: id.into(),
            parent: parent.into(),
            order,
            spans,
            runs,
        }
    };
    // Read the actual atomic registry placements, not fixed projection answers.
    let blocks = match mode.as_str() {
        "original" => vec![
            block(FIRST, &ap, ao, vec![first]),
            block(SECOND, &bp, bo, vec![second]),
        ],
        "join" => vec![block(FIRST, &ap, ao, vec![first, second])],
        "split" => {
            let offset = cut
                .unwrap()
                .get_offset(&txn)
                .expect("split boundary must resolve");
            assert_eq!(
                offset.branch.id(),
                AsRef::<yrs::branch::Branch>::as_ref(&a).id()
            );
            let n = offset.index;
            assert!(n <= first.end && valid_boundary(&plain_text(&a, &txn), n));
            vec![
                block(FIRST, &ap, ao, vec![span(FIRST, &a, 0, n)]),
                block(
                    "block-split",
                    &ap,
                    ao.checked_add(1).ok_or("derived order out of range")?,
                    vec![span(FIRST, &a, n, first.end)],
                ),
                block(SECOND, &bp, bo, vec![second]),
            ]
        }
        _ => unreachable!(),
    };
    // Every registered character has exactly one owner, including empty ranges.
    for (key, t) in [(FIRST, &a), (SECOND, &b)] {
        let mut ranges: Vec<_> = blocks
            .iter()
            .flat_map(|b| &b.spans)
            .filter(|s| s.source == key)
            .map(|s| (s.start, s.end))
            .collect();
        ranges.sort();
        let mut cursor = 0;
        for (start, end) in ranges {
            assert_eq!(start, cursor);
            cursor = end;
        }
        assert_eq!(cursor, t.len(&txn));
    }
    Ok(blocks)
}

#[derive(Clone, Debug)]
pub(crate) struct Anchor {
    pub(crate) source: String,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn anchor(doc: &Doc, key: &str, index: u32, assoc: Assoc) -> Anchor {
    let t = text(doc, key);
    let txn = doc.transact();
    assert!(valid_boundary(&plain_text(&t, &txn), index));
    Anchor {
        source: key.into(),
        bytes: relative(&t, &txn, index, assoc).unwrap().encode_v1(),
    }
}

/// Resolve stored selections to current logical owners. Boundary affinity chooses
/// the left end (Before) or right start (After); join adds the first span's length.
pub(crate) fn resolve(doc: &Doc, anchor: &Anchor) -> Option<(String, u32)> {
    let sticky = StickyIndex::decode_v1(&anchor.bytes).ok()?;
    let t = text(doc, &anchor.source);
    let txn = doc.transact();
    let offset = sticky.get_offset(&txn)?;
    if offset.branch.id() != AsRef::<yrs::branch::Branch>::as_ref(&t).id() {
        return None;
    }
    drop(txn);
    let blocks = project(doc);
    let mut candidates = vec![];
    for block in &blocks {
        let mut prefix = 0;
        for span in &block.spans {
            if span.source == anchor.source
                && offset.index >= span.start
                && offset.index <= span.end
            {
                candidates.push((block.id.clone(), prefix + offset.index - span.start));
            }
            prefix += span.end - span.start;
        }
    }
    if sticky.assoc == Assoc::Before {
        candidates.into_iter().next()
    } else {
        candidates.into_iter().last()
    }
}
