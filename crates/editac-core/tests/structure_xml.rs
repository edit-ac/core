//! Disposable FND-1.4 candidate, not an editor schema or production move command.
//! Relocation snapshots an XML subtree, inserts fresh shared types, then removes
//! the original. Equal application IDs/content do not imply equal CRDT identity.
#[path = "support/structure_xml.rs"]
mod candidate;
use candidate::*;
use std::{fs, path::PathBuf};
use yrs::{ReadTxn, Transact};

// The FND-1.2 astral fixture: offsets 1..3 cover the emoji; 3 is after it.
const INPUT: &str = "a😀b";
const EDITED: &str = "a😀!b";
const ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

fn assert_content(p: &Projection, edited: bool) {
    let mut expected = vec![
        ("a".into(), vec![]),
        ("😀".into(), vec![("bold".into(), "true".into())]),
    ];
    if edited {
        expected.push(("!".into(), vec![("italic".into(), "true".into())]));
    }
    expected.push(("b".into(), vec![]));
    assert_eq!(p.runs, expected);
    assert_eq!(p.utf16_len, if edited { 5 } else { 4 });
    let content: String = p.runs.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(content, if edited { EDITED } else { INPUT });
}

fn trace(name: &str, value: &str) {
    if let Some(dir) = std::env::var_os("EDITAC_XML_TRACE_OUTPUT") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}.txt")), value).unwrap();
    }
}

#[test]
fn editing_in_place_preserves_element_and_text_identity() {
    let doc = fixture();
    let before = project(&doc, 0);
    assert_content(&before, false);
    edit(&doc, 0);
    let after = project(&doc, 0);
    assert_content(&after, true);
    assert_eq!(before.element_identity, after.element_identity);
    assert_eq!(before.text_identity, after.text_identity);
    trace(
        "edit-in-place",
        &format!("before={before:#?}\nafter={after:#?}\n"),
    );
}

#[test]
fn sequential_clone_remove_move_copies_marks_but_replaces_shared_identity() {
    let doc = fixture();
    edit(&doc, 0);
    let before = project(&doc, 0);
    relocate(&doc);
    let after = project(&doc, 1);
    assert_content(&after, true);
    assert_eq!(before.block_id, after.block_id);
    assert_ne!(before.element_identity, after.element_identity);
    assert_ne!(before.text_identity, after.text_identity);
    let restored = replica(22);
    apply(&restored, &full_update(&doc));
    assert_eq!(project(&restored, 1), after);
    trace(
        "sequential-move",
        &format!(
            "before={before:#?}\nafter={after:#?}\nrestored={:#?}\n",
            project(&restored, 1)
        ),
    );
}

#[test]
fn concurrent_move_edit_converges_but_edit_does_not_follow_replacement() {
    let source = fixture();
    let before = project(&source, 0);
    let base = full_update(&source);
    let baseline = source.transact().state_vector();
    let mover = replica(22);
    let editor = replica(33);
    apply(&mover, &base);
    apply(&editor, &base);
    assert_eq!(project(&mover, 0), before);
    assert_eq!(project(&editor, 0), before);
    relocate(&mover);
    let moved = project(&mover, 1);
    assert_content(&moved, false);
    assert_ne!(moved.text_identity, before.text_identity);
    assert_ne!(moved.element_identity, before.element_identity);
    edit(&editor, 0);
    let edited = project(&editor, 0);
    assert_content(&edited, true);
    assert_eq!(edited.text_identity, before.text_identity);
    let movement = mover.transact().encode_state_as_update_v1(&baseline);
    let editing = editor.transact().encode_state_as_update_v1(&baseline);
    apply(&mover, &editing);
    apply(&editor, &movement);
    assert_eq!(project(&mover, 1), moved);
    assert_eq!(project(&editor, 1), moved);
    let updates = [base, movement, editing];
    let mut report = format!(
        "original={before:#?}\nconcurrent-edit-before-delivery={edited:#?}\nconverged-move={moved:#?}\n"
    );
    for (schedule, order) in ORDERS.iter().enumerate() {
        // Two writers plus a fresh disconnected/replay observer per schedule.
        let observer = replica(100 + schedule as u64);
        for index in order {
            apply(&observer, &updates[*index]);
            apply(&observer, &updates[*index]);
        }
        let delivered = project(&observer, 1);
        assert_eq!(delivered, moved, "arrival order {order:?}");
        for index in order.iter().rev() {
            apply(&observer, &updates[*index]);
        }
        assert_eq!(project(&observer, 1), moved, "replay order {order:?}");
        report.push_str(&format!(
            "order={order:?} duplicate+reverse-replay: {delivered:#?}\n"
        ));
    }
    report.push_str("Outcome: the visible clone retains initial text/marks and logical block ID, but has new element/text BranchIDs. The concurrent !/italic edit targets the removed original and is absent from the visible destination. Convergence alone does not qualify this move candidate.\n");
    trace("concurrent-move-edit", &report);
    if let Some(dir) = std::env::var_os("EDITAC_XML_TRACE_OUTPUT") {
        for (name, bytes) in ["base", "move", "edit"].into_iter().zip(&updates) {
            fs::write(PathBuf::from(&dir).join(format!("{name}.bin")), bytes).unwrap();
        }
    }
}
