//! The pinned Yrs patch is local metadata only, with fail-closed clone guards.
use yrs::updates::decoder::Decode;
use yrs::{Doc, Options, ReadTxn, StateVector, Text, Transact, Update};

fn replica(gc: bool) -> Doc {
    Doc::with_options(Options {
        skip_gc: !gc,
        ..Options::default()
    })
}

#[test]
fn metadata_copy_rejects_different_snapshots_without_mutation() {
    let source = replica(false);
    source
        .get_or_insert_text("text")
        .insert(&mut source.transact_mut(), 0, "a");
    let target = replica(false);
    let before = target.transact().snapshot();
    assert!(
        !target
            .transact_mut()
            .copy_local_redone_from(&source.transact())
    );
    assert_eq!(before, target.transact().snapshot());
}

#[test]
fn metadata_copy_rejects_garbage_collected_replica() {
    let source = replica(false);
    let target = replica(true);
    assert!(
        !target
            .transact_mut()
            .copy_local_redone_from(&source.transact())
    );
}

#[test]
fn metadata_copy_preserves_wire_state_and_clock() {
    let source = replica(false);
    source
        .get_or_insert_text("text")
        .insert(&mut source.transact_mut(), 0, "a😀bc");
    let target = replica(false);
    let bytes = source
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    target
        .transact_mut()
        .apply_update(Update::decode_v1(&bytes).unwrap())
        .unwrap();
    let before = target.transact().snapshot();
    assert!(
        target
            .transact_mut()
            .copy_local_redone_from(&source.transact())
    );
    assert_eq!(before, target.transact().snapshot());
    assert_eq!(
        bytes,
        target
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    );
}

#[test]
fn copied_redone_links_make_later_probe_match_live_selective_undo() {
    use yrs::UndoManager;
    use yrs::undo::{Options as HistoryOptions, StackItem};
    // Production source may GC unretained items; managers keep their payloads.
    let source = replica(true);
    let text = source.get_or_insert_text("text");
    text.insert(&mut source.transact_mut(), 0, "x");
    let mut first: UndoManager = UndoManager::new();
    first.expand_scope(&source, &text);
    first.include_origin("first");
    {
        let mut txn = source.transact_mut_with("first");
        text.remove_range(&mut txn, 0, 1);
        text.insert(&mut txn, 0, "a");
    }
    first.exclude_origin("first");
    let mut second: UndoManager = UndoManager::new();
    second.expand_scope(&source, &text);
    second.include_origin("second");
    {
        let mut txn = source.transact_mut_with("second");
        text.remove_range(&mut txn, 0, 1);
        text.insert(&mut txn, 0, "b");
    }
    second.exclude_origin("second");
    second.undo_blocking();
    for copy in [false, true] {
        let target = Doc::with_options(Options {
            client_id: source.client_id(),
            skip_gc: true,
            ..Options::default()
        });
        let target_text = target.get_or_insert_text("text");
        let bytes = source
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        target
            .transact_mut()
            .apply_update(Update::decode_v1(&bytes).unwrap())
            .unwrap();
        if copy {
            assert!(
                target
                    .transact_mut()
                    .copy_local_redone_from(&source.transact())
            );
            assert_eq!(
                bytes,
                target
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default())
            );
        }
        let mut probe: UndoManager = UndoManager::with_options(HistoryOptions {
            init_undo_stack: first
                .undo_stack()
                .iter()
                .map(|s| {
                    StackItem::new(target.guid(), s.deletions().clone(), s.insertions().clone())
                })
                .collect(),
            ..HistoryOptions::default()
        });
        probe.expand_scope(&target, &target_text);
        probe.undo_blocking();
        use yrs::GetString;
        assert_eq!(
            target_text.get_string(&target.transact()) == "x",
            copy,
            "negative control without local metadata must diverge"
        );
    }
    first.undo_blocking();
    use yrs::GetString;
    assert_eq!(text.get_string(&source.transact()), "x");
}
