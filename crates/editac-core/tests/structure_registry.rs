//! Disposable FND-1.5 candidate, not the frozen schema or production commands.
//! A move replaces one atomic placement value, never the integrated rich text.
//! Each replica has one Yrs document; projection is a read, not a second CRDT.
#[path = "support/structure_registry.rs"]
mod candidate;
use candidate::*;
use std::{fs, path::PathBuf};
use yrs::{ReadTxn, Transact};

// Identical logical content/parents/offsets to the FND-1.4 XML candidate.
const BLOCK: &str = "block-1";
const INPUT: &str = "a😀b";
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
    assert_eq!(
        p.runs.iter().map(|(s, _)| s.as_str()).collect::<String>(),
        if edited { "a😀!b" } else { INPUT }
    );
}

fn trace(name: &str, report: &str, updates: &[Vec<u8>]) {
    if let Some(dir) = std::env::var_os("EDITAC_REGISTRY_TRACE_OUTPUT") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}.txt")), report).unwrap();
        for (i, bytes) in updates.iter().enumerate() {
            fs::write(dir.join(format!("{name}-{i}.bin")), bytes).unwrap();
        }
    }
}

fn assert_replay(updates: &[Vec<u8>; 3], expected: &Projection) -> String {
    let mut report = String::new();
    for (schedule, order) in ORDERS.iter().enumerate() {
        let observer = replica(100 + schedule as u64);
        for index in order {
            apply(&observer, &updates[*index]);
            apply(&observer, &updates[*index]);
        }
        let delivered = project(&observer);
        assert_eq!(&delivered, expected, "arrival order {order:?}");
        for index in order.iter().rev() {
            apply(&observer, &updates[*index]);
        }
        assert_eq!(&project(&observer), expected, "replay order {order:?}");
        report.push_str(&format!(
            "order={order:?} duplicate+reverse-replay: {delivered:#?}\n"
        ));
    }
    report
}

#[test]
fn editing_in_place_preserves_registry_text_identity() {
    let doc = fixture();
    let before = project(&doc);
    assert_content(&before, false);
    edit(&doc);
    let after = project(&doc);
    assert_content(&after, true);
    assert_eq!(before.text_identity, after.text_identity);
    assert_eq!((&after.parent, after.order), (&before.parent, before.order));
    trace(
        "edit-in-place",
        &format!("before={before:#?}\nafter={after:#?}\n"),
        &[],
    );
}

#[test]
fn sequential_move_and_restore_retain_text_identity_and_marks() {
    let doc = fixture();
    edit(&doc);
    let before = project(&doc);
    relocate(&doc, "right", 0);
    let after = project(&doc);
    assert_content(&after, true);
    assert_eq!(after.parent, "right");
    assert_eq!(after.order, 0);
    assert_eq!(before.text_identity, after.text_identity);
    let bytes = full_update(&doc);
    let restored = replica(22);
    apply(&restored, &bytes);
    assert_eq!(project(&restored), after);
    trace(
        "sequential-move",
        &format!(
            "before={before:#?}\nafter={after:#?}\nrestored={:#?}\n",
            project(&restored)
        ),
        &[bytes],
    );
}

#[test]
fn concurrent_move_edit_follows_retained_text_on_both_writers_and_replay() {
    let source = fixture();
    let before = project(&source);
    let base = full_update(&source);
    let baseline = source.transact().state_vector();
    let mover = replica(22);
    let editor = replica(33);
    apply(&mover, &base);
    apply(&editor, &base);
    assert_eq!(project(&mover), before);
    assert_eq!(project(&editor), before);
    relocate(&mover, "right", 0);
    edit(&editor);
    let moved = project(&mover);
    let edited = project(&editor);
    assert_content(&moved, false);
    assert_content(&edited, true);
    assert_eq!(moved.text_identity, before.text_identity);
    assert_eq!(edited.text_identity, before.text_identity);
    let movement = mover.transact().encode_state_as_update_v1(&baseline);
    let editing = editor.transact().encode_state_as_update_v1(&baseline);
    apply(&mover, &editing);
    apply(&editor, &movement);
    let expected = Projection {
        parent: "right".into(),
        order: 0,
        ..edited
    };
    assert_eq!(project(&mover), expected);
    assert_eq!(project(&editor), expected);
    let updates = [base, movement, editing];
    let replay = assert_replay(&updates, &expected);
    trace(
        "concurrent-move-edit",
        &format!(
            "original={before:#?}\nmover={:#?}\neditor={:#?}\n{replay}",
            project(&mover),
            project(&editor)
        ),
        &updates,
    );
}

#[test]
fn concurrent_moves_select_one_complete_tuple_and_retain_identity() {
    let source = fixture();
    let before = project(&source);
    let base = full_update(&source);
    let baseline = source.transact().state_vector();
    let first = replica(22);
    let second = replica(33);
    apply(&first, &base);
    apply(&second, &base);
    relocate(&first, "right", 10);
    relocate(&second, "left", 20);
    let requested_first = project(&first);
    let requested_second = project(&second);
    let first_move = first.transact().encode_state_as_update_v1(&baseline);
    let second_move = second.transact().encode_state_as_update_v1(&baseline);
    apply(&first, &second_move);
    apply(&second, &first_move);
    // Pinned Yrs resolves same-key concurrent map replacements by client ID.
    // These two sibling assignments share the same baseline; writer 33 wins.
    // This assertion is a measured candidate policy, not a final schema rule.
    let expected = Projection {
        parent: "left".into(),
        order: 20,
        ..before
    };
    assert_content(&expected, false);
    assert_eq!(project(&first), expected);
    assert_eq!(project(&second), expected);
    let updates = [base, first_move, second_move];
    let replay = assert_replay(&updates, &expected);
    trace(
        "concurrent-moves",
        &format!(
            "requested-22={requested_first:#?}\nrequested-33={requested_second:#?}\nwriter-22={:#?}\nwriter-33={:#?}\n{replay}",
            project(&first),
            project(&second)
        ),
        &updates,
    );
}
