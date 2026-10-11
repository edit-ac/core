//! FND-1.6 comparison only: real Yrs candidates, no production schema adoption.
#[path = "support/structure_registry.rs"]
#[allow(dead_code)]
mod registry;
#[path = "support/structure_xml.rs"]
#[allow(dead_code)]
mod xml;

use std::{fs, path::PathBuf};
use yrs::{Any, Doc, ReadTxn, Text, Transact, Xml, XmlFragment, XmlOut, types::AsPrelim};

const SEED: u32 = 1592594996;
const ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Block {
    id: String,
    parent: String,
    order: u32,
    identity: String,
    runs: Vec<(String, Vec<(String, String)>)>,
    utf16_len: u32,
}

#[derive(Clone, Copy, Debug)]
enum Candidate {
    Xml,
    Registry,
}

impl Candidate {
    fn fixture(self, input: &str) -> Doc {
        match self {
            Self::Xml => xml::fixture_with_input(input),
            Self::Registry => registry::fixture_with_input(input),
        }
    }

    fn move_to(self, doc: &Doc, parent: usize, order: u32) {
        match self {
            Self::Registry => registry::relocate(doc, ["left", "right"][parent], order),
            Self::Xml => {
                let parents = xml::containers(doc);
                let source = xml::block(doc, 0);
                // The existing clone/remove candidate, generalized to either target.
                // Snapshot first; removal first also permits a same-parent relocation.
                let copy = source.as_prelim(&doc.transact());
                let mut txn = doc.transact_mut_with("fixture:clone-remove-move");
                parents[0].remove(&mut txn, 0);
                let cloned = parents[parent].insert(&mut txn, 0, copy);
                cloned.insert_attribute(&mut txn, "order", order.to_string());
            }
        }
    }

    fn edit(self, doc: &Doc) {
        match self {
            Self::Xml => xml::edit(doc, 0),
            Self::Registry => registry::edit(doc),
        }
    }

    fn project(self, doc: &Doc) -> Vec<Block> {
        match self {
            Self::Registry => {
                let p = registry::project(doc);
                vec![Block {
                    id: p.block_id,
                    parent: p.parent,
                    order: p.order,
                    identity: p.text_identity,
                    runs: p.runs,
                    utf16_len: p.utf16_len,
                }]
            }
            Self::Xml => {
                let parents = xml::containers(doc);
                let txn = doc.transact();
                let mut blocks = vec![];
                for (parent, container) in parents.iter().enumerate() {
                    for i in 0..container.len(&txn) {
                        let p = container.get(&txn, i).unwrap().into_xml_element().unwrap();
                        assert_eq!(p.len(&txn), 1);
                        let t = p.get(&txn, 0).unwrap().into_xml_text().unwrap();
                        let mut runs = vec![];
                        for run in t.diff(&txn, |_| ()) {
                            let yrs::Out::Any(Any::String(s)) = run.insert else {
                                panic!("non-text run")
                            };
                            let mut marks: Vec<_> = run
                                .attributes
                                .into_iter()
                                .flat_map(|a| *a)
                                .map(|(k, v)| (k.to_string(), v.to_string()))
                                .collect();
                            marks.sort();
                            runs.push((s.to_string(), marks));
                        }
                        blocks.push(Block {
                            id: p.get_attribute(&txn, "id").unwrap().to_string(&txn),
                            parent: ["left", "right"][parent].into(),
                            order: p
                                .get_attribute(&txn, "order")
                                .map(|v| v.to_string(&txn).parse().unwrap())
                                .unwrap_or(0),
                            identity: format!("{:?}", XmlOut::Text(t.clone()).id()),
                            runs,
                            utf16_len: t.len(&txn),
                        });
                    }
                }
                blocks.sort_by(|a, b| {
                    (&a.parent, a.order, &a.identity).cmp(&(&b.parent, b.order, &b.identity))
                });
                blocks
            }
        }
    }
}

fn inputs() -> Vec<(String, u32, u32)> {
    let mut state = SEED;
    ["e\u{301}", "👩‍💻", "🇭🇺", "אבג"]
        .map(|suffix| {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            (
                format!("a😀b{suffix}-{:08x}", state),
                state % 17 + 1,
                state % 23 + 30,
            )
        })
        .into()
}

fn expected_runs(input: &str, edited: bool) -> Vec<(String, Vec<(String, String)>)> {
    let mut runs = vec![
        ("a".into(), vec![]),
        ("😀".into(), vec![("bold".into(), "true".into())]),
    ];
    if edited {
        runs.push(("!".into(), vec![("italic".into(), "true".into())]));
    }
    runs.push((input.strip_prefix("a😀").unwrap().into(), vec![]));
    runs
}

fn compare(move_move: bool) {
    let race = if move_move { "move-move" } else { "move-edit" };
    let mut report = format!("seed={SEED}\nrace={race}\nwriters=[11,22,33]\n");
    for (case, (input, first_order, second_order)) in inputs().into_iter().enumerate() {
        report.push_str(&format!("case={case} input={input:?} bold_utf16=1..3 edit_utf16=3 first=(right,{first_order}) second={}\n", if move_move { format!("(left,{second_order})") } else { "(!,italic)".into() }));
        for candidate in [Candidate::Xml, Candidate::Registry] {
            let source = candidate.fixture(&input);
            let before = candidate.project(&source);
            assert_eq!(before.len(), 1);
            assert_eq!(before[0].runs, expected_runs(&input, false));
            let base = xml::full_update(&source);
            let baseline = source.transact().state_vector();
            let first = xml::replica(22);
            let second = xml::replica(33);
            for doc in [&first, &second] {
                xml::apply(doc, &base);
                assert_eq!(candidate.project(doc), before);
            }
            candidate.move_to(&first, 1, first_order);
            if move_move {
                candidate.move_to(&second, 0, second_order);
            } else {
                candidate.edit(&second);
            }
            let requests = [candidate.project(&first), candidate.project(&second)];
            let updates = [
                base,
                first.transact().encode_state_as_update_v1(&baseline),
                second.transact().encode_state_as_update_v1(&baseline),
            ];
            xml::apply(&first, &updates[2]);
            xml::apply(&second, &updates[1]);
            let outcome = candidate.project(&first);
            assert_eq!(candidate.project(&second), outcome);
            match candidate {
                Candidate::Registry => {
                    assert_eq!(outcome.len(), 1);
                    assert_eq!(outcome[0].identity, before[0].identity);
                    assert_eq!(
                        (&outcome[0].parent[..], outcome[0].order),
                        if move_move {
                            ("left", second_order)
                        } else {
                            ("right", first_order)
                        }
                    );
                }
                Candidate::Xml => {
                    assert_eq!(outcome.len(), if move_move { 2 } else { 1 });
                    assert!(outcome.iter().all(|b| b.identity != before[0].identity));
                    assert_eq!(
                        (&outcome[0].parent[..], outcome[0].order),
                        if move_move {
                            ("left", second_order)
                        } else {
                            ("right", first_order)
                        }
                    );
                    if move_move {
                        assert_eq!(
                            (&outcome[1].parent[..], outcome[1].order),
                            ("right", first_order)
                        );
                    }
                }
            }
            let edited = !move_move && matches!(candidate, Candidate::Registry);
            for b in &outcome {
                assert_eq!(b.id, "block-1");
                assert_eq!(b.runs, expected_runs(&input, edited));
                assert_eq!(
                    b.utf16_len as usize,
                    input.encode_utf16().count() + usize::from(edited)
                );
            }
            report.push_str(&format!("candidate={candidate:?}\noriginal={before:#?}\nrequests={requests:#?}\nwriter22={outcome:#?}\nwriter33={:#?}\ntext_utf8_bytes={} updates_v1_bytes={:?}\n", candidate.project(&second), input.len(), updates.each_ref().map(|u| u.len())));
            for (schedule, order) in ORDERS.iter().enumerate() {
                let observer = xml::replica(100 + schedule as u64);
                for index in order {
                    xml::apply(&observer, &updates[*index]);
                    xml::apply(&observer, &updates[*index]);
                }
                assert_eq!(
                    candidate.project(&observer),
                    outcome,
                    "{candidate:?} {order:?}"
                );
                for index in order.iter().rev() {
                    xml::apply(&observer, &updates[*index]);
                }
                assert_eq!(candidate.project(&observer), outcome);
                report.push_str(&format!("order={order:?}: exact semantic+identity projection matches, duplicate and reverse replay\n"));
            }
            if let Some(dir) = std::env::var_os("EDITAC_STRUCTURE_OUTPUT") {
                let dir = PathBuf::from(dir);
                fs::create_dir_all(&dir).unwrap();
                for (i, bytes) in updates.iter().enumerate() {
                    fs::write(
                        dir.join(format!("{race}-{case}-{candidate:?}-{i}.bin")),
                        bytes,
                    )
                    .unwrap();
                }
            }
        }
    }
    if let Some(dir) = std::env::var_os("EDITAC_STRUCTURE_OUTPUT") {
        fs::write(PathBuf::from(dir).join(format!("{race}.txt")), report).unwrap();
    }
}

#[test]
fn seeded_move_edit_compares_marks_identity_and_visible_content() {
    compare(false);
}

#[test]
fn seeded_move_move_compares_duplicate_blocks_and_atomic_winner() {
    compare(true);
}
