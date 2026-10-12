//! Fixed production oracles for post-transaction semantic batches and lifecycle.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{editor::*, format::*, structure::*, text::*},
    document::{Document, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
    history::HistoryConfig,
    patches::*,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};
use yrs::Any;
const A: &str = "n:11:1";
const B: &str = "n:11:2";
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap()
}
fn restore(bytes: &[u8]) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 11,
            bytes: bytes.into(),
        },
        &[],
    )
    .unwrap()
}
fn engine() -> Document {
    restore(&m::bytes(&m::seed()))
}
fn origin() -> TextOrigin {
    TextOrigin::new("patch:explicit").unwrap()
}
fn insert(d: &mut Document, id: &str, at: u32, text: &str) -> ReplayUpdate {
    let at = d.anchor(id, U(at), Bias::Right).unwrap();
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: text.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap().update.unwrap()
}
fn editor(d: &mut Document, commands: &[EditorCommand]) -> ReplayUpdate {
    let p = d.prepare_editor(commands, &origin()).unwrap();
    d.commit_editor(p).unwrap().update
}
fn ids(id: &str) -> BTreeSet<String> {
    [id.into()].into()
}
fn capture(d: &mut Document, scope: PatchScope) -> (Subscription, Rc<RefCell<Vec<Patch>>>) {
    let events = Rc::new(RefCell::new(vec![]));
    let seen = events.clone();
    let sub = d
        .subscribe(scope, move |d, p| {
            // These acquire fresh Yrs read transactions and projection locks.
            assert_eq!(p.identity, *d.identity());
            assert!(p.projection_error.is_none());
            d.snapshot().unwrap();
            d.checkpoint();
            d.history_state();
            seen.borrow_mut().push(p.clone());
            Ok(())
        })
        .unwrap();
    (sub, events)
}
fn text(d: &Document, id: &str) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
#[test]
fn text_batch_has_exact_version_origin_bytes_node_and_utf16_range() {
    let mut d = engine();
    let (_s, events) = capture(&mut d, PatchScope::All);
    let u = insert(&mut d, A, 1, "😀");
    let e = events.borrow();
    assert_eq!(e.len(), 1);
    let p = &e[0];
    assert_eq!(p.version, 1);
    assert_eq!((p.sequence, p.revision), (1, 1));
    assert_eq!(p.operation, PatchOperation::Text);
    assert_eq!(p.origin, origin().as_str());
    assert_eq!(p.changed_nodes, ids(A));
    assert_eq!(p.changed_sources, ids(A));
    assert_eq!(p.update.as_ref().unwrap().bytes, u.bytes);
    assert_eq!(p.writer_id, d.writer_id());
    assert_eq!(p.touched_ranges.len(), 1);
    let r = &p.touched_ranges[0];
    assert_eq!(
        (&*r.source, r.start, r.new_start, r.old_end, r.new_end),
        (A, 1, 1, 1, 3)
    );
    assert!(matches!(&p.nodes[0], NodePatch::Visible(n) if n.id == A));
}
#[test]
fn irrelevant_node_source_selection_listeners_are_silent() {
    let mut d = engine();
    let (_a, ae) = capture(&mut d, PatchScope::Nodes(ids(A)));
    let (_b, be) = capture(&mut d, PatchScope::Nodes(ids(B)));
    let (_src, se) = capture(&mut d, PatchScope::Sources(ids(B)));
    let (_sel, selection) = capture(&mut d, PatchScope::Selection);
    let (_up, updates) = capture(&mut d, PatchScope::Updates);
    insert(&mut d, A, 0, "X");
    assert_eq!(ae.borrow().len(), 1);
    assert!(be.borrow().is_empty());
    assert!(se.borrow().is_empty());
    assert!(selection.borrow().is_empty());
    assert_eq!(updates.borrow().len(), 1);
}
#[test]
fn each_commit_excludes_older_pending_ranges_without_consuming_snapshot_evidence() {
    let mut d = engine();
    d.snapshot().unwrap();
    insert(&mut d, A, 0, "X");
    insert(&mut d, B, 1, "Y");
    let p = d.last_patch().unwrap();
    assert_eq!(p.changed_nodes, ids(B));
    assert_eq!(p.touched_ranges.len(), 1);
    assert_eq!(p.touched_ranges[0].source, B);
    let s = d.snapshot().unwrap();
    assert_eq!(s.changed_nodes, [A.into(), B.into()].into());
    assert_eq!(s.touched_ranges.len(), 2);
    assert!(d.snapshot().unwrap().changed_nodes.is_empty());
}
#[test]
fn preparation_applicability_invalid_stale_and_noop_do_not_emit() {
    let mut d = engine();
    let (_s, events) = capture(&mut d, PatchScope::All);
    let at = d.anchor(A, U(0), Bias::Right).unwrap();
    let c = TextCommand::Insert {
        at,
        text: "".into(),
    };
    d.can_text(&c, &origin()).unwrap();
    let p = d.prepare_text(&c, &origin()).unwrap();
    d.commit_text(p).unwrap();
    assert!(events.borrow().is_empty());
    let at = d.anchor(A, U(1), Bias::Right).unwrap();
    let c = TextCommand::Insert {
        at,
        text: "S".into(),
    };
    let p = d.prepare_text(&c, &origin()).unwrap();
    let before = d.checkpoint().bytes;
    assert!(
        d.prepare_editor(
            &[EditorCommand::Block {
                target: A.into(),
                tuple: Any::Null
            }],
            &origin()
        )
        .is_err()
    );
    assert_eq!(before, d.checkpoint().bytes);
    assert!(events.borrow().is_empty());
    insert(&mut d, B, 0, "X");
    assert!(d.commit_text(p).is_err());
    assert_eq!(events.borrow().len(), 1);
}
#[test]
fn nested_commit_callbacks_can_read_prepare_commit_and_preserve_delivery_order() {
    let mut d = engine();
    let order = Rc::new(RefCell::new(vec![]));
    let o = order.clone();
    let _first = d
        .subscribe(PatchScope::All, move |d, p| {
            o.borrow_mut().push((1, p.sequence));
            if p.sequence == 1 {
                insert(d, B, 0, "Y");
            }
            Ok(())
        })
        .unwrap();
    let o = order.clone();
    let _second = d
        .subscribe(PatchScope::All, move |d, p| {
            d.snapshot().unwrap();
            o.borrow_mut().push((2, p.sequence));
            Ok(())
        })
        .unwrap();
    let u = insert(&mut d, A, 0, "X");
    assert_eq!(*order.borrow(), vec![(1, 1), (2, 1), (1, 2), (2, 2)]);
    assert_eq!(d.revision(), 2);
    assert_eq!(d.last_patch().unwrap().sequence, 2);
    let mut r = engine();
    r.apply_replay(&u).unwrap();
    assert_eq!(text(&r, A), text(&d, A));
}
#[test]
fn returned_errors_and_unwinding_panics_do_not_corrupt_commit_or_other_observers() {
    let mut d = engine();
    let bad = d
        .subscribe(PatchScope::All, |_, _| Err("adapter failed".into()))
        .unwrap();
    let panic = d
        .subscribe(PatchScope::All, |_, _| panic!("fixture observer panic"))
        .unwrap();
    let (_good, events) = capture(&mut d, PatchScope::All);
    let u = insert(&mut d, A, 0, "X");
    assert!(!bad.is_active());
    assert!(!panic.is_active());
    assert_eq!(events.borrow().len(), 1);
    let f = d.take_observer_failures();
    assert_eq!(f.len(), 2);
    assert!(matches!(&f[0].kind,ObserverFailureKind::Returned(s) if s=="adapter failed"));
    assert_eq!(f[1].kind, ObserverFailureKind::Panicked);
    assert!(d.take_observer_failures().is_empty());
    let mut r = engine();
    r.apply_replay(&u).unwrap();
    assert_eq!(text(&r, A), text(&d, A));
    insert(&mut d, A, 0, "Y");
    assert_eq!(events.borrow().len(), 2);
    assert!(d.take_observer_failures().is_empty());
}
#[test]
fn disposal_is_idempotent_releases_capture_and_drop_unsubscribes() {
    struct Capture(Rc<RefCell<bool>>);
    impl Drop for Capture {
        fn drop(&mut self) {
            *self.0.borrow_mut() = true;
        }
    }
    let mut d = engine();
    let dropped = Rc::new(RefCell::new(false));
    let capture = Capture(dropped.clone());
    let sub = d
        .subscribe(PatchScope::All, move |_, _| {
            let _ = &capture;
            panic!("disposed callback");
        })
        .unwrap();
    sub.dispose();
    sub.dispose();
    assert!(*dropped.borrow());
    insert(&mut d, A, 0, "X");
    assert!(d.take_observer_failures().is_empty());
    let (s, e) = capture_events(&mut d);
    drop(s);
    insert(&mut d, A, 0, "Y");
    assert!(e.borrow().is_empty());
}
fn capture_events(d: &mut Document) -> (Subscription, Rc<RefCell<Vec<Patch>>>) {
    capture(d, PatchScope::All)
}
#[test]
fn dispose_during_callback_suppresses_later_listener_in_same_batch() {
    let mut d = engine();
    let handle = Rc::new(RefCell::new(None::<Subscription>));
    let h = handle.clone();
    let _first = d
        .subscribe(PatchScope::All, move |_, _| {
            h.borrow().as_ref().unwrap().dispose();
            Ok(())
        })
        .unwrap();
    let (second, e) = capture(&mut d, PatchScope::All);
    *handle.borrow_mut() = Some(second);
    insert(&mut d, A, 0, "X");
    assert!(e.borrow().is_empty());
}
#[test]
fn self_disposal_is_safe_and_subscription_after_commit_does_not_receive_old_batch() {
    let mut d = engine();
    let handles = Rc::new(RefCell::new(Vec::<Subscription>::new()));
    let hs = handles.clone();
    let calls = Rc::new(RefCell::new(vec![]));
    let cs = calls.clone();
    let first = d
        .subscribe(PatchScope::All, move |d, p| {
            cs.borrow_mut().push(p.sequence);
            hs.borrow()[0].dispose();
            let (new, _events) = capture(d, PatchScope::All);
            hs.borrow_mut().push(new);
            Ok(())
        })
        .unwrap();
    handles.borrow_mut().push(first);
    insert(&mut d, A, 0, "X");
    insert(&mut d, A, 0, "Y");
    assert_eq!(*calls.borrow(), vec![1]);
}
#[test]
fn document_drop_invalidates_outstanding_subscription_and_owned_patch_survives() {
    let mut d = engine();
    let (s, e) = capture(&mut d, PatchScope::All);
    insert(&mut d, A, 0, "X");
    let p = d.last_patch().unwrap();
    drop(d);
    assert!(!s.is_active());
    assert_eq!(e.borrow().len(), 1);
    assert!(p.update.is_some());
    assert_eq!(p.changed_nodes, ids(A));
}
#[test]
fn selection_events_have_no_content_update_or_history_and_commit_resolves_anchor() {
    let mut d = engine();
    d.enable_history(HistoryConfig::default()).unwrap();
    let before = d.checkpoint().bytes;
    let (_s, e) = capture(&mut d, PatchScope::Selection);
    let sel = d
        .selection((A, U(1), Bias::Right), (A, U(1), Bias::Right))
        .unwrap();
    d.set_selection(Some(sel)).unwrap();
    assert_eq!(before, d.checkpoint().bytes);
    assert_eq!(d.revision(), 0);
    assert_eq!(d.history_state().undo_groups, 0);
    assert!(e.borrow()[0].update.is_none());
    assert_eq!(e.borrow()[0].operation, PatchOperation::Selection);
    insert(&mut d, A, 0, "😀");
    assert_eq!(e.borrow().len(), 2);
    let ev = e.borrow();
    assert!(
        matches!(&ev[1].resolved_selection,Some(Ok(s)) if matches!(&s.focus,Resolution::Position(p) if p.offset==U(3)))
    );
    drop(ev);
    d.set_selection(None).unwrap();
    assert_eq!(e.borrow().len(), 3);
    assert!(d.current_selection().is_none());
}
#[test]
fn rich_and_block_format_are_single_batches_with_fixed_ranges() {
    let mut d = engine();
    let (_s, e) = capture(&mut d, PatchScope::All);
    let c = FormatCommand {
        selection: d
            .selection((A, U(0), Bias::Left), (A, U(3), Bias::Right))
            .unwrap(),
        mark: Mark::Underline,
        action: FormatAction::Apply,
        href: None,
    };
    let b = BlockFormatCommand {
        targets: vec![B.into()],
        attributes: editac_core::document::BlockAttributes::Heading(2),
        action: FormatAction::Apply,
    };
    let plan = d.prepare_format_batch(&[c], &[b], &origin()).unwrap();
    let commit = d.commit_format(plan).unwrap();
    let ev = e.borrow();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].operation, PatchOperation::Format);
    assert_eq!(ev[0].changed_nodes, [A.into(), B.into()].into());
    assert_eq!(
        ev[0].update.as_ref().unwrap().bytes,
        commit.update.unwrap().bytes
    );
    assert_eq!(ev[0].touched_ranges.len(), 1);
    assert_eq!(
        (
            ev[0].touched_ranges[0].old_end,
            ev[0].touched_ranges[0].new_end
        ),
        (3, 3)
    );
}
#[test]
fn block_only_batch_has_changed_node_without_text_range() {
    let mut d = engine();
    let (_s, e) = capture(&mut d, PatchScope::Nodes(ids(A)));
    editor(
        &mut d,
        &[EditorCommand::Block {
            target: A.into(),
            tuple: m::arr(vec![Any::from("heading"), Any::from(3.)]),
        }],
    );
    let ev = e.borrow();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].changed_nodes, ids(A));
    assert!(ev[0].touched_ranges.is_empty());
}
#[test]
fn production_mixed_editor_batch_emits_once_with_all_touched_families() {
    let mut d = engine();
    let (_s, e) = capture(&mut d, PatchScope::All);
    let at = d.anchor(A, U(1), Bias::Right).unwrap();
    editor(
        &mut d,
        &[
            EditorCommand::Text(TextCommand::Insert {
                at,
                text: "X".into(),
            }),
            EditorCommand::Block {
                target: B.into(),
                tuple: m::arr(vec![Any::from("heading"), Any::from(2.)]),
            },
        ],
    );
    let ev = e.borrow();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].operation, PatchOperation::Editor);
    assert_eq!(ev[0].changed_nodes, [A.into(), B.into()].into());
    assert_eq!(ev[0].touched_ranges.len(), 1);
}
#[test]
fn split_join_batches_preserve_source_identity_and_report_visibility_changes() {
    let mut d = engine();
    let (_s, e) = capture(&mut d, PatchScope::All);
    editor(
        &mut d,
        &[EditorCommand::Join {
            first: A.into(),
            second: B.into(),
        }],
    );
    assert!(e.borrow()[0].changed_nodes.contains(B));
    assert!(
        e.borrow()[0]
            .nodes
            .iter()
            .any(|n| matches!(n,NodePatch::Recovery(n) if n.id==B)
                || matches!(n,NodePatch::Removed(id) if id==B))
    );
    let at = d.anchor(A, U(3), Bias::Right).unwrap();
    editor(
        &mut d,
        &[EditorCommand::Split {
            owner: A.into(),
            at,
        }],
    );
    assert_eq!(e.borrow().len(), 2);
    assert!(e.borrow().iter().all(|p| p.touched_ranges.is_empty()));
}
#[test]
fn replay_is_one_remote_batch_and_duplicate_rejected_input_are_silent() {
    let mut d = engine();
    let mut remote = engine();
    let (_s, e) = capture(&mut d, PatchScope::All);
    let u = insert(&mut remote, A, 0, "R");
    d.apply_replay(&u).unwrap();
    d.apply_replay(&u).unwrap();
    let mut invalid = u.clone();
    invalid.bytes = vec![255];
    assert!(d.apply_replay(&invalid).is_err());
    let ev = e.borrow();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].operation, PatchOperation::Remote);
    assert_eq!(ev[0].origin, "remote");
    assert_eq!(ev[0].update.as_ref().unwrap().bytes, u.bytes);
}
#[test]
fn undo_redo_emit_one_semantic_batch_and_preserve_remote_edits() {
    let mut d = engine();
    d.enable_history(HistoryConfig::default()).unwrap();
    let mut remote = engine();
    let (_s, e) = capture(&mut d, PatchScope::All);
    insert(&mut d, A, 0, "LOCAL");
    let r = insert(&mut remote, B, 0, "REMOTE");
    d.apply_replay(&r).unwrap();
    let u = d.undo().unwrap().unwrap();
    assert_eq!(e.borrow().len(), 3);
    assert_eq!(e.borrow()[2].operation, PatchOperation::Undo);
    assert_eq!(e.borrow()[2].changed_nodes, ids(A));
    assert_eq!(
        e.borrow()[2].update.as_ref().unwrap().bytes,
        u.update.unwrap().bytes
    );
    assert!(text(&d, B).starts_with("REMOTE"));
    d.redo().unwrap().unwrap();
    assert_eq!(e.borrow().len(), 4);
    assert_eq!(e.borrow()[3].operation, PatchOperation::Redo);
}
#[test]
fn structural_history_multitransaction_work_is_one_batch_per_undo_redo() {
    let mut d = engine();
    d.enable_history(HistoryConfig::default()).unwrap();
    let (_s, e) = capture(&mut d, PatchScope::All);
    let new_id = format!("n:{}:1", d.writer_id());
    editor(
        &mut d,
        &[EditorCommand::Create {
            id: new_id.clone(),
            kind: "block".into(),
            text: "new".into(),
            tuple: m::arr(vec![Any::from("paragraph")]),
        }],
    );
    d.undo().unwrap().unwrap();
    d.redo().unwrap().unwrap();
    let ev = e.borrow();
    assert_eq!(ev.len(), 3);
    assert_eq!(ev[1].operation, PatchOperation::Undo);
    assert!(ev[1].changed_nodes.contains(&new_id));
    assert_eq!(ev[2].operation, PatchOperation::Redo);
}
#[test]
fn reordered_duplicate_three_replica_batches_converge_with_fixed_distinct_counts() {
    let seed = m::bytes(&m::seed());
    let mut a = restore(&seed);
    let mut b = restore(&seed);
    let mut c = restore(&seed);
    let ua = insert(&mut a, A, 0, "A");
    let ub = insert(&mut b, B, 0, "B");
    let uc = insert(&mut c, A, 4, "C");
    for (d, updates) in [
        (&mut a, vec![ub.clone(), uc.clone(), ub.clone()]),
        (&mut b, vec![uc.clone(), ua.clone(), ua.clone()]),
        (&mut c, vec![ua.clone(), ub.clone(), ua.clone()]),
    ] {
        let (_s, e) = capture(d, PatchScope::All);
        for u in updates {
            d.apply_replay(&u).unwrap();
        }
        assert_eq!(e.borrow().len(), 2);
    }
    assert_eq!(text(&a, A), text(&b, A));
    assert_eq!(text(&b, A), text(&c, A));
    assert_eq!(text(&a, B), text(&c, B));
}
#[test]
fn legacy_profile_text_format_and_structure_commits_also_publish_once() {
    let identity = DocumentIdentity::v1(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )
    .unwrap();
    let mut d = Document::create(
        editac_core::document::CreationPermit::authorize_new(identity).unwrap(),
        &[editac_core::document::InitialNode {
            kind: "item".into(),
            text: "abcd".into(),
        }],
    )
    .unwrap();
    let a = d.snapshot().unwrap().visible[0].id.clone();
    let (_s, e) = capture(&mut d, PatchScope::All);
    insert(&mut d, &a, 1, "X");
    let c = FormatCommand {
        selection: d
            .selection((&a, U(0), Bias::Left), (&a, U(2), Bias::Right))
            .unwrap(),
        mark: Mark::Underline,
        action: FormatAction::Apply,
        href: None,
    };
    let p = d.prepare_format(&[c], &origin()).unwrap();
    d.commit_format(p).unwrap();
    assert_eq!(e.borrow().len(), 2);
    assert_eq!(e.borrow()[1].operation, PatchOperation::Format);
}

#[test]
fn direct_structure_commit_has_one_batch_with_derived_owner_nodes() {
    let mut d = engine();
    let (_s, e) = capture(&mut d, PatchScope::All);
    let at = d.anchor(A, U(3), Bias::Right).unwrap();
    let p = d
        .prepare_structure(
            &StructureCommand::SplitOwner {
                owner: A.into(),
                at,
            },
            &origin(),
        )
        .unwrap();
    let c = d.commit_structure(p).unwrap();
    let ev = e.borrow();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].operation, PatchOperation::Structure);
    assert!(ev[0].changed_nodes.contains(A));
    assert!(ev[0].changed_nodes.len() > 1);
    assert!(ev[0].touched_ranges.is_empty());
    assert_eq!(ev[0].update.as_ref().unwrap().bytes, c.update.bytes);
}
#[test]
fn deleted_selection_endpoint_is_explicit_and_node_scopes_see_recovery() {
    let mut d = engine();
    let selection = d
        .selection((A, U(1), Bias::Right), (A, U(1), Bias::Right))
        .unwrap();
    d.set_selection(Some(selection)).unwrap();
    let (_s, e) = capture(&mut d, PatchScope::Selection);
    editor(
        &mut d,
        &[EditorCommand::Enable {
            target: A.into(),
            enabled: false,
        }],
    );
    assert_eq!(e.borrow().len(), 1);
    assert!(
        matches!(&e.borrow()[0].resolved_selection,Some(Ok(s)) if matches!(s.anchor,Resolution::Deleted{..}))
    );
}
#[test]
fn new_listener_excludes_batches_already_queued_before_subscription() {
    let mut d = engine();
    let holders = Rc::new(RefCell::new(Vec::<Subscription>::new()));
    let h = holders.clone();
    let seen = Rc::new(RefCell::new(vec![]));
    let seen_in = seen.clone();
    let _first = d
        .subscribe(PatchScope::All, move |d, p| {
            if p.sequence == 1 {
                insert(d, B, 0, "Y");
                let seen = seen_in.clone();
                h.borrow_mut().push(
                    d.subscribe(PatchScope::All, move |_, p| {
                        seen.borrow_mut().push(p.sequence);
                        Ok(())
                    })
                    .unwrap(),
                );
            }
            Ok(())
        })
        .unwrap();
    insert(&mut d, A, 0, "X");
    assert!(seen.borrow().is_empty());
    insert(&mut d, A, 0, "Z");
    assert_eq!(*seen.borrow(), vec![3]);
}
