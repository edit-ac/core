//! WEB-1.14: independent content, stable-caret and selective-history oracles.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution},
    commands::{editor::*, format::*, text::*},
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    patches::PatchScope,
};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
use yrs::Any;

fn origin() -> TextOrigin {
    TextOrigin::new("heading-end:explicit").unwrap()
}
fn edit(d: &mut Document, commands: &[EditorCommand]) -> EditorCommit {
    let plan = d.prepare_editor(commands, &origin()).unwrap();
    d.commit_editor(plan).unwrap()
}
fn engine(texts: &[&str]) -> Document {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
    let identity = DocumentIdentity::v5(
        format!("91000000-0000-4000-8000-{suffix:012}"),
        format!("92000000-0000-4000-8000-{suffix:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &texts
            .iter()
            .map(|s| InitialNode {
                kind: "block".into(),
                text: (*s).into(),
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let id = blocks(&d)[0].id.clone();
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: id.clone(),
            tuple: Any::Array(vec![Any::from("heading"), Any::from(3u32)].into()),
        }],
    );
    if !texts[0].is_empty() {
        let selection = d
            .selection(
                (&id, U(0), Bias::Left),
                (&id, U(texts[0].encode_utf16().count() as u32), Bias::Right),
            )
            .unwrap();
        let p = d
            .prepare_format(
                &[FormatCommand {
                    selection,
                    mark: Mark::Bold,
                    action: FormatAction::Apply,
                    href: None,
                }],
                &origin(),
            )
            .unwrap();
        d.commit_format(p).unwrap();
    }
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn blocks(d: &Document) -> Vec<editac_core::projection::ProjectedNode> {
    d.snapshot()
        .unwrap()
        .visible
        .into_iter()
        .filter(|n| n.kind == "block")
        .map(|n| (*n).clone())
        .collect()
}
fn text(n: &editac_core::projection::ProjectedNode) -> String {
    n.runs.iter().map(|r| r.text.as_str()).collect()
}
fn heading(d: &Document, offset: u32) -> EditorCommand {
    let id = blocks(d)[0].id.clone();
    EditorCommand::HeadingEnd {
        owner: id.clone(),
        at: d.anchor(&id, U(offset), Bias::Right).unwrap(),
    }
}
fn frozen(d: &Document) -> (Vec<u8>, Vec<u8>, u64, editac_core::history::HistoryState) {
    (
        d.checkpoint().bytes,
        d.state_vector_v1(),
        d.revision(),
        d.history_state(),
    )
}
fn reject(d: &mut Document, commands: &[EditorCommand]) {
    let events = Rc::new(RefCell::new(0));
    let count = events.clone();
    let _sub = d
        .subscribe(PatchScope::All, move |_, _| {
            *count.borrow_mut() += 1;
            Ok(())
        })
        .unwrap();
    let old = frozen(d);
    assert!(d.can_editor(commands, &origin()).is_err());
    assert!(d.prepare_editor(commands, &origin()).is_err());
    assert_eq!(frozen(d), old);
    assert_eq!(*events.borrow(), 0);
}

#[test]
fn heading_end_preserves_heading_marks_and_one_update_history_with_stable_utf16_caret() {
    let mut d = engine(&["A😀Z", "untouched"]);
    let before = blocks(&d);
    let cmd = heading(&d, 4);
    let EditorCommand::HeadingEnd { at, .. } = &cmd else {
        unreachable!()
    };
    let at = at.clone();
    let events = Rc::new(RefCell::new(Vec::new()));
    let count = events.clone();
    let _sub = d
        .subscribe(PatchScope::Updates, move |_, p| {
            count.borrow_mut().push(p.clone());
            Ok(())
        })
        .unwrap();
    let old = frozen(&d);
    d.can_editor(std::slice::from_ref(&cmd), &origin()).unwrap();
    let plan = d.prepare_editor(&[cmd], &origin()).unwrap();
    assert_eq!(frozen(&d), old);
    assert!(events.borrow().is_empty());
    let commit = d.commit_editor(plan).unwrap();
    let after = blocks(&d);
    assert_eq!(after.len(), 3);
    assert_eq!(after[0].id, before[0].id);
    assert_eq!(after[0].parent, before[0].parent);
    assert_eq!(after[0].block_attributes, Some(BlockAttributes::Heading(3)));
    assert_eq!(after[0].runs, before[0].runs);
    assert_eq!(after[2].runs, before[1].runs);
    assert_eq!(after[2].id, before[1].id);
    assert_eq!(after[1].block_attributes, Some(BlockAttributes::Paragraph));
    assert_eq!(after[1].parent, after[0].parent);
    assert_eq!(text(&after[1]), "");
    assert!(
        matches!(d.resolve_anchor(commit.result_caret.as_ref().unwrap()).unwrap(), Resolution::Position(p) if p.node == after[1].id && p.offset == U(0))
    );
    assert!(
        matches!(d.resolve_anchor(&at).unwrap(), Resolution::Position(p) if p.node == after[0].id && p.offset == U(4))
    );
    assert_eq!(d.history_state().undo_groups, 1);
    assert_eq!(d.revision(), old.2 + 1);
    let events = events.borrow();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].update.as_ref().unwrap().bytes,
        commit.update.bytes
    );
}

#[test]
fn heading_end_selected_suffix_replacement_is_one_prepared_batch() {
    let mut d = engine(&["A😀Z", "keep"]);
    let id = blocks(&d)[0].id.clone();
    let selection = d
        .selection((&id, U(1), Bias::Left), (&id, U(4), Bias::Right))
        .unwrap();
    let at = d.anchor(&id, U(1), Bias::Right).unwrap();
    let commit = edit(
        &mut d,
        &[
            EditorCommand::Text(TextCommand::Delete { selection }),
            EditorCommand::HeadingEnd {
                owner: id.clone(),
                at: at.clone(),
            },
        ],
    );
    let b = blocks(&d);
    assert_eq!(b.iter().map(text).collect::<Vec<_>>(), ["A", "", "keep"]);
    assert_eq!(b[0].block_attributes, Some(BlockAttributes::Heading(3)));
    assert!(
        b[0].runs
            .iter()
            .all(|r| r.attributes.get("bold") == Some(&Any::Bool(true)))
    );
    assert!(
        matches!(d.resolve_anchor(commit.result_caret.as_ref().unwrap()).unwrap(), Resolution::Position(p) if p.node == b[1].id && p.offset == U(0))
    );
    assert!(
        matches!(d.resolve_anchor(&at).unwrap(), Resolution::Position(p) if p.node == id && p.offset == U(1))
    );
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "keep"]
    );
    d.redo().unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A", "", "keep"]
    );
}

#[test]
fn heading_end_cross_block_selected_replacement_stages_deletions_join_and_destination() {
    let mut d = engine(&["A😀Z", "remove", "peer"]);
    let b = blocks(&d);
    let at = d.anchor(&b[0].id, U(1), Bias::Right).unwrap();
    let a_range = d
        .selection((&b[0].id, U(1), Bias::Left), (&b[0].id, U(4), Bias::Right))
        .unwrap();
    let b_range = d
        .selection((&b[1].id, U(0), Bias::Left), (&b[1].id, U(6), Bias::Right))
        .unwrap();
    let commit = edit(
        &mut d,
        &[
            EditorCommand::Text(TextCommand::Delete { selection: a_range }),
            EditorCommand::Text(TextCommand::Delete { selection: b_range }),
            EditorCommand::Join {
                first: b[0].id.clone(),
                second: b[1].id.clone(),
            },
            EditorCommand::HeadingEnd {
                owner: b[0].id.clone(),
                at: at.clone(),
            },
        ],
    );
    let result = blocks(&d);
    assert_eq!(
        result.iter().map(text).collect::<Vec<_>>(),
        ["A", "", "peer"]
    );
    assert_eq!(result[0].id, b[0].id);
    assert_eq!(
        result[0].block_attributes,
        Some(BlockAttributes::Heading(3))
    );
    assert_eq!(result[1].block_attributes, Some(BlockAttributes::Paragraph));
    assert!(
        matches!(d.resolve_anchor(commit.result_caret.as_ref().unwrap()).unwrap(), Resolution::Position(p) if p.node == result[1].id && p.offset == U(0))
    );
    assert!(
        matches!(d.resolve_anchor(&at).unwrap(), Resolution::Position(p) if p.node == b[0].id && p.offset == U(1))
    );
    assert_eq!(d.history_state().undo_groups, 1);
    d.undo().unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "remove", "peer"]
    );
    d.redo().unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A", "", "peer"]
    );
}

#[test]
fn heading_end_ineligible_targets_and_resource_rejection_are_atomic() {
    let mut d = engine(&["A😀Z", "paragraph"]);
    for offset in [0, 1, 3] {
        let cmd = heading(&d, offset);
        reject(&mut d, &[cmd]);
    }
    let b = blocks(&d);
    let at = d.anchor(&b[1].id, U(9), Bias::Right).unwrap();
    reject(
        &mut d,
        &[EditorCommand::HeadingEnd {
            owner: b[1].id.clone(),
            at,
        }],
    );
    let at = d.anchor(&b[0].id, U(4), Bias::Right).unwrap();
    reject(
        &mut d,
        &[EditorCommand::HeadingEnd {
            owner: "missing".into(),
            at: at.clone(),
        }],
    );
    let cmd = heading(&d, 4);
    reject(&mut d, &vec![cmd; 4097]);
    let mut empty = engine(&[""]);
    let cmd = heading(&empty, 0);
    reject(&mut empty, &[cmd]);
}

#[test]
fn heading_end_later_invalid_command_rolls_back_entire_preparation() {
    let mut d = engine(&["A😀Z"]);
    let cmd = heading(&d, 4);
    reject(
        &mut d,
        &[
            cmd,
            EditorCommand::Join {
                first: "missing".into(),
                second: "missing".into(),
            },
        ],
    );
    let b = blocks(&d);
    let selection = d
        .selection((&b[0].id, U(0), Bias::Left), (&b[0].id, U(4), Bias::Right))
        .unwrap();
    let cmd = heading(&d, 4);
    reject(
        &mut d,
        &[EditorCommand::Text(TextCommand::Delete { selection }), cmd],
    );
}

#[test]
fn heading_end_stale_and_wrong_replica_plans_are_silent() {
    let mut d = engine(&["A😀Z", "peer"]);
    let cmd = heading(&d, 4);
    let plan = d.prepare_editor(&[cmd], &origin()).unwrap();
    let b = blocks(&d);
    let at = d.anchor(&b[1].id, U(0), Bias::Right).unwrap();
    edit(
        &mut d,
        &[EditorCommand::Text(TextCommand::Insert {
            at,
            text: "R".into(),
        })],
    );
    let before = frozen(&d);
    assert!(d.commit_editor(plan).is_err());
    assert_eq!(frozen(&d), before);
    let plan = d.prepare_editor(&[heading(&d, 4)], &origin()).unwrap();
    let mut peer = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let before = frozen(&peer);
    assert!(peer.commit_editor(plan).is_err());
    assert_eq!(frozen(&peer), before);
}

#[test]
fn heading_end_undo_redo_preserves_unrelated_remote_text_and_peer_convergence() {
    let mut d = engine(&["A😀Z", "peer"]);
    let b = blocks(&d);
    let mut peer = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let at = peer.anchor(&b[1].id, U(4), Bias::Right).unwrap();
    let plan = peer
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: "R".into(),
            },
            &origin(),
        )
        .unwrap();
    let remote = peer.commit_text(plan).unwrap().update.unwrap();
    let cmd = heading(&d, 4);
    edit(&mut d, &[cmd]);
    peer.apply_replay(&editac_core::document::ReplayUpdate {
        identity: d.identity().clone(),
        bytes: d.update_v1(&peer.state_vector_v1()).unwrap(),
    })
    .unwrap();
    d.apply_replay(&remote).unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "peerR"]
    );
    assert_eq!(d.history_state().undo_groups, 1);
    let undo = d.undo().unwrap().unwrap();
    peer.apply_replay(&undo.update.unwrap()).unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "peerR"]
    );
    assert_eq!(
        blocks(&peer).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "peerR"]
    );
    assert_eq!(
        blocks(&d)[0].block_attributes,
        Some(BlockAttributes::Heading(3))
    );
    let redo = d.redo().unwrap().unwrap();
    peer.apply_replay(&redo.update.unwrap()).unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "peerR"]
    );
    assert_eq!(
        blocks(&peer).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "peerR"]
    );
    assert_eq!(
        blocks(&peer)[1].block_attributes,
        Some(BlockAttributes::Paragraph)
    );
}

#[test]
fn heading_end_under_quote_keeps_parent_and_does_not_change_context_commands() {
    use editac_core::commands::lists::{ContainerStyle, ListCommand};
    let mut d = engine(&["A😀Z", "peer"]);
    let id = blocks(&d)[0].id.clone();
    edit(
        &mut d,
        &[EditorCommand::List(ListCommand::Wrap {
            targets: vec![id],
            style: ContainerStyle::Quote,
        })],
    );
    d.clear_history();
    let before = blocks(&d);
    let cmd = heading(&d, 4);
    edit(&mut d, &[cmd]);
    let b = blocks(&d);
    assert_eq!(b[0].parent, before[0].parent);
    assert_eq!(b[1].parent, before[0].parent);
    assert_eq!(b[0].runs, before[0].runs);
    assert_eq!(b[1].block_attributes, Some(BlockAttributes::Paragraph));
    assert_eq!(d.history_state().undo_groups, 1);
}

#[test]
fn heading_end_deleted_stable_target_is_rejected_without_redirect() {
    let mut d = engine(&["A😀Z", "peer"]);
    let cmd = heading(&d, 4);
    let id = blocks(&d)[0].id.clone();
    edit(
        &mut d,
        &[EditorCommand::Enable {
            target: id,
            enabled: false,
        }],
    );
    reject(&mut d, &[cmd]);
    assert_eq!(blocks(&d).iter().map(text).collect::<Vec<_>>(), ["peer"]);
}

#[test]
fn heading_end_caret_identifies_new_paragraph_before_existing_shared_source_sibling() {
    let mut d = engine(&["A😀Ztail", "peer"]);
    let owner = blocks(&d)[0].id.clone();
    let cut = d.anchor(&owner, U(4), Bias::Right).unwrap();
    edit(
        &mut d,
        &[EditorCommand::Split {
            owner: owner.clone(),
            at: cut.clone(),
        }],
    );
    let Resolution::Position(sibling) = d.resolve_anchor(&cut).unwrap() else {
        panic!()
    };
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: sibling.node,
            tuple: Any::Array(vec![Any::from("paragraph")].into()),
        }],
    );
    d.clear_history();
    let cmd = heading(&d, 4);
    let EditorCommand::HeadingEnd { at, .. } = &cmd else {
        unreachable!()
    };
    let at = at.clone();
    let commit = edit(&mut d, &[cmd]);
    let b = blocks(&d);
    assert_eq!(
        b.iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "tail", "peer"]
    );
    assert_eq!(b[1].block_attributes, Some(BlockAttributes::Paragraph));
    assert!(
        matches!(d.resolve_anchor(commit.result_caret.as_ref().unwrap()).unwrap(), Resolution::Position(p) if p.node == b[1].id && p.offset == U(0)),
        "separate result must identify the new paragraph"
    );
    assert!(
        matches!(d.resolve_anchor(&at).unwrap(), Resolution::Position(p) if p.node == b[2].id && p.offset == U(0))
    );
}

fn shared_source_heading() -> Document {
    let mut d = engine(&["A😀Ztail", "peer"]);
    let owner = blocks(&d)[0].id.clone();
    let cut = d.anchor(&owner, U(4), Bias::Right).unwrap();
    edit(
        &mut d,
        &[EditorCommand::Split {
            owner: owner.clone(),
            at: cut.clone(),
        }],
    );
    let Resolution::Position(sibling) = d.resolve_anchor(&cut).unwrap() else {
        panic!()
    };
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: sibling.node,
            tuple: Any::Array(vec![Any::from("paragraph")].into()),
        }],
    );
    d
}

fn shared_source_destination() -> (
    Document,
    editac_core::anchors::Anchor,
    editac_core::anchors::Anchor,
) {
    let mut d = shared_source_heading();
    let command = heading(&d, 4);
    let EditorCommand::HeadingEnd { at, .. } = &command else {
        unreachable!()
    };
    let old_cut = at.clone();
    let result = edit(&mut d, &[command]).result_caret.unwrap();
    (d, old_cut, result)
}

// Construction probes, not headingEnd qualification. All candidate operations
// occur on a disposable replica, followed by one admitted update on the target.
// These positive diagnostics deliberately assert the original cut's mismatch;
// they must never be counted as passing stable-result acceptance cases.
fn fresh_source_construction_probe(join_then_split: bool) {
    use editac_core::document::ReplayUpdate;

    let mut d = shared_source_heading();
    let before = blocks(&d);
    let cut = d.anchor(&before[0].id, U(4), Bias::Right).unwrap();
    let baseline = frozen(&d);
    let mut stage = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let id = stage.next_editor_id(false).unwrap();
    edit(
        &mut stage,
        &[
            EditorCommand::Create {
                id: id.clone(),
                kind: "block".into(),
                text: String::new(),
                tuple: Any::Array(vec![Any::from("paragraph")].into()),
            },
            EditorCommand::Place {
                target: id.clone(),
                parent: before[0].parent.clone(),
                before: Some(before[1].id.clone()),
            },
        ],
    );
    let fresh_cut = stage.anchor(&id, U(0), Bias::Right).unwrap();
    if join_then_split {
        edit(
            &mut stage,
            &[EditorCommand::Join {
                first: before[0].id.clone(),
                second: id,
            }],
        );
        edit(
            &mut stage,
            &[EditorCommand::Split {
                owner: before[0].id.clone(),
                at: fresh_cut.clone(),
            }],
        );
        let Resolution::Position(destination) = stage.resolve_anchor(&fresh_cut).unwrap() else {
            panic!("fresh source must identify the staged split destination")
        };
        edit(
            &mut stage,
            &[EditorCommand::Block {
                target: destination.node,
                tuple: Any::Array(vec![Any::from("paragraph")].into()),
            }],
        );
    }
    assert_eq!(
        frozen(&d),
        baseline,
        "construction cannot mutate the target"
    );
    d.apply_replay(&ReplayUpdate {
        identity: d.identity().clone(),
        bytes: stage.checkpoint().bytes,
    })
    .unwrap();
    let constructed = blocks(&d);
    assert_eq!(
        constructed.iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "tail", "peer"]
    );
    assert_eq!(constructed[0].id, before[0].id);
    assert_eq!(constructed[0].runs, before[0].runs);
    assert_eq!(
        constructed[0].block_attributes,
        Some(BlockAttributes::Heading(3))
    );
    assert_eq!(constructed[1].parent, before[0].parent);
    assert_eq!(
        constructed[1].block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    assert_eq!(constructed[2].id, before[1].id);
    assert_eq!(constructed[3].id, before[2].id);
    for (after, original) in [(2, 1), (3, 2)] {
        assert_eq!(constructed[after].spans, before[original].spans);
        assert_eq!(constructed[after].runs, before[original].runs);
        assert_eq!(constructed[after].parent, before[original].parent);
    }
    assert_ne!(
        constructed[1].spans[0].source,
        constructed[2].spans[0].source
    );
    assert!(
        matches!(d.resolve_anchor(&fresh_cut).unwrap(), Resolution::Position(p) if p.node == constructed[1].id && p.offset == U(0))
    );
    assert!(
        matches!(d.resolve_anchor(&cut).unwrap(), Resolution::Position(p) if p.node == constructed[2].id && p.offset == U(0)),
        "unchanged original right-biased cut still selects the existing sibling"
    );

    let plan = d
        .prepare_text(
            &TextCommand::Insert {
                at: fresh_cut.clone(),
                text: "X".into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(plan).unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "X", "tail", "peer"]
    );
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    assert!(
        matches!(restored.resolve_anchor(&fresh_cut).unwrap(), Resolution::Position(p) if p.node == constructed[1].id && p.offset == U(1))
    );
    assert!(
        matches!(restored.resolve_anchor(&cut).unwrap(), Resolution::Position(p) if p.node == constructed[2].id && p.offset == U(0))
    );
    edit(
        &mut d,
        &[EditorCommand::Enable {
            target: constructed[1].id.clone(),
            enabled: false,
        }],
    );
    if join_then_split {
        // Disabling a split undoes ownership; it is not an owner tombstone.
        // The retained fresh source returns to the surviving joined heading.
        assert!(
            matches!(d.resolve_anchor(&fresh_cut).unwrap(), Resolution::Position(p) if p.node == before[0].id && p.offset == U(5))
        );
    } else {
        assert!(
            matches!(d.resolve_anchor(&fresh_cut).unwrap(), Resolution::Deleted { owner, .. } if owner == constructed[1].id)
        );
    }
}

#[test]
fn heading_end_v5_construction_fresh_create_place_requires_new_result_anchor() {
    fresh_source_construction_probe(false);
}

#[test]
fn heading_end_v5_construction_fresh_join_split_requires_new_result_anchor() {
    fresh_source_construction_probe(true);
}

#[test]
fn heading_end_destination_typing_preserves_existing_shared_source_sibling() {
    let (mut d, old_cut, result) = shared_source_destination();
    let before = blocks(&d);
    assert!(
        matches!(d.resolve_anchor(&old_cut).unwrap(), Resolution::Position(p) if p.node == before[2].id && p.offset == U(0))
    );
    assert!(
        matches!(d.resolve_anchor(&result).unwrap(), Resolution::Position(p) if p.node == before[1].id && p.offset == U(0))
    );
    assert_eq!(
        before.iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "tail", "peer"]
    );
    d.clear_history();

    // Follow-up text uses the returned caret; the unchanged old cut still
    // resolves to the sibling and is never substituted for this result.
    let at = result;
    let plan = d
        .prepare_text(
            &TextCommand::Insert {
                at,
                text: "X".into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(plan).unwrap();
    let after = blocks(&d);
    assert_eq!(
        after.iter().map(|n| &n.id).collect::<Vec<_>>(),
        before.iter().map(|n| &n.id).collect::<Vec<_>>()
    );
    assert_eq!(
        after.iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "X", "tail", "peer"],
        "typing in the new paragraph must not mutate its shared-source sibling"
    );
}

#[test]
fn heading_end_destination_source_owns_insert_before_shared_source_sibling() {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, Map, OffsetKind, Options, Out, ReadTxn, Text, Transact, Update};

    let (mut d, old_cut, result) = shared_source_destination();
    let before = blocks(&d);
    assert!(
        matches!(d.resolve_anchor(&old_cut).unwrap(), Resolution::Position(p) if p.node == before[2].id && p.offset == U(0))
    );
    assert!(
        matches!(d.resolve_anchor(&result).unwrap(), Resolution::Position(p) if p.node == before[1].id && p.offset == U(0))
    );
    let span = &before[1].spans[0];
    assert_eq!(span.start, span.end);
    assert_ne!(span.source, before[2].spans[0].source);

    // Isolate ownership replay from anchor candidate selection: insert directly
    // into the destination's admitted source at its projected source offset.
    // This is prepared real Yrs input, not an alternate engine implementation.
    let peer = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::with_client_id(yrs::ClientID::new(31337))
    });
    peer.transact_mut()
        .apply_update(Update::decode_v1(&d.checkpoint().bytes).unwrap())
        .unwrap();
    let state = peer.transact().state_vector();
    let Out::YXmlText(source) = peer
        .transact()
        .get_map(editac_core::document::ROOTS[1])
        .unwrap()
        .get(&peer.transact(), &span.source)
        .unwrap()
    else {
        panic!()
    };
    source.insert(&mut peer.transact_mut(), span.start, "X");
    d.apply_replay(&editac_core::document::ReplayUpdate {
        identity: d.identity().clone(),
        bytes: peer.transact().encode_state_as_update_v1(&state),
    })
    .unwrap();
    assert_eq!(
        blocks(&d).iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "X", "tail", "peer"],
        "correct source insertion must belong to the new paragraph, independently of caret routing"
    );
}

#[test]
fn heading_end_result_survives_recovery_and_followup_typing() {
    let mut d = shared_source_heading();
    let before = blocks(&d);
    let command = heading(&d, 4);
    let plan = d.prepare_editor(&[command], &origin()).unwrap();
    assert!(plan.result_caret().is_some());
    let commit = d.commit_editor(plan).unwrap();
    let caret = commit.result_caret.unwrap();
    let checkpoint = d.checkpoint();
    let mut restored = Document::restore(d.identity(), &checkpoint, &[]).unwrap();
    let result = blocks(&restored);
    assert!(
        matches!(restored.resolve_anchor(&caret).unwrap(), Resolution::Position(p) if p.node == result[1].id && p.offset == U(0))
    );
    let plan = restored
        .prepare_text(
            &TextCommand::Insert {
                at: caret,
                text: "X".into(),
            },
            &origin(),
        )
        .unwrap();
    restored.commit_text(plan).unwrap();
    let after = blocks(&restored);
    assert_eq!(
        after.iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "X", "tail", "peer"]
    );
    assert_eq!(after[2].id, before[1].id);
    assert_eq!(after[2].runs, before[1].runs);
}

#[test]
fn heading_end_batch_last_heading_owns_result() {
    let mut d = engine(&["A😀Z", "peer"]);
    let before = blocks(&d);
    edit(
        &mut d,
        &[EditorCommand::Block {
            target: before[1].id.clone(),
            tuple: Any::Array(vec![Any::from("heading"), Any::from(2u32)].into()),
        }],
    );
    let second = d.anchor(&before[1].id, U(4), Bias::Right).unwrap();
    let commands = [
        heading(&d, 4),
        EditorCommand::HeadingEnd {
            owner: before[1].id.clone(),
            at: second,
        },
    ];
    let commit = edit(&mut d, &commands);
    let after = blocks(&d);
    assert_eq!(
        after.iter().map(text).collect::<Vec<_>>(),
        ["A😀Z", "", "peer", ""]
    );
    assert!(
        matches!(d.resolve_anchor(commit.result_caret.as_ref().unwrap()).unwrap(), Resolution::Position(p) if p.node == after[3].id && p.offset == U(0))
    );
}

#[test]
fn paragraph_end_split_returns_a_fresh_caret_without_rerouting_the_input_cut() {
    for value in ["A😀Z", ""] {
        let mut d = engine(&[value, "untouched"]);
        let id = blocks(&d)[0].id.clone();
        edit(
            &mut d,
            &[EditorCommand::Block {
                target: id.clone(),
                tuple: Any::Array(vec![Any::from("paragraph")].into()),
            }],
        );
        d.clear_history();
        let at = d
            .anchor(&id, U(value.encode_utf16().count() as u32), Bias::Right)
            .unwrap();
        let before = frozen(&d);
        let command = EditorCommand::Split {
            owner: id.clone(),
            at: at.clone(),
        };
        d.can_editor(&[command.clone()], &origin()).unwrap();
        assert_eq!(frozen(&d), before);
        let result = edit(&mut d, &[command]);
        let nodes = blocks(&d);
        assert_eq!(
            nodes.iter().map(text).collect::<Vec<_>>(),
            vec![value, "", "untouched"]
        );
        assert_eq!(nodes[0].id, id);
        let caret = result
            .result_caret
            .expect("terminal split must author its empty destination caret");
        let Resolution::Position(position) = d.resolve_anchor(&caret).unwrap() else {
            panic!("result caret must resolve");
        };
        assert_eq!(position.node, nodes[1].id);
        assert_eq!(position.offset, U(0));
        // The existing caller's source cut remains attached to its old paragraph.
        let Resolution::Position(input) = d.resolve_anchor(&at).unwrap() else {
            panic!("input cut must resolve");
        };
        assert_eq!(input.node, id);
        edit(
            &mut d,
            &[EditorCommand::Text(TextCommand::Insert {
                at: caret,
                text: "next".into(),
            })],
        );
        assert_eq!(
            blocks(&d).iter().map(text).collect::<Vec<_>>(),
            vec![value, "next", "untouched"]
        );
    }
}

#[test]
fn paragraph_end_destination_accepts_a_formatted_fragment() {
    // Exercise both relative writer orderings used by disposable staging replicas.
    for case in 0..64 {
        let tail = case % 2 == 0;
        let mut d = engine(if tail {
            &["task", "untouched"]
        } else {
            &["task"]
        });
        let id = blocks(&d)[0].id.clone();
        edit(
            &mut d,
            &[EditorCommand::Block {
                target: id.clone(),
                tuple: Any::Array(vec![Any::from("paragraph")].into()),
            }],
        );
        let at = d.anchor(&id, U(4), Bias::Right).unwrap();
        let result = edit(&mut d, &[EditorCommand::Split { owner: id, at }]);
        let caret = result.result_caret.unwrap();
        let selection = editac_core::anchors::Selection {
            anchor: caret.clone(),
            focus: caret,
        };
        let fragment = vec![
            FragmentBlock {
                runs: vec![FragmentRun {
                    opaque_marks: vec![],
                    text: "Offline heading".into(),
                    marks: vec![],
                }],
                attributes: Some(BlockAttributes::Heading(1)),
                containers: vec![],
                checked: None,
            },
            FragmentBlock {
                runs: vec![FragmentRun {
                    opaque_marks: vec![],
                    text: "Saved".into(),
                    marks: vec![(Mark::Bold, None)],
                }],
                attributes: Some(BlockAttributes::Paragraph),
                containers: vec![],
                checked: None,
            },
        ];
        let before = d.checkpoint();
        let plan = d
            .prepare_fragment(&selection, &fragment, &origin())
            .unwrap();
        assert_eq!(
            d.checkpoint().bytes,
            before.bytes,
            "preparation mutated the live replica"
        );
        d.commit_editor(plan).unwrap();
        assert_eq!(
            blocks(&d).iter().map(text).collect::<Vec<_>>(),
            if tail {
                vec!["task", "Offline heading", "Saved", "untouched"]
            } else {
                vec!["task", "Offline heading", "Saved"]
            }
        );
        let expected = blocks(&d);
        assert_eq!(
            expected[1].block_attributes,
            Some(BlockAttributes::Heading(1))
        );
        assert_eq!(
            expected[2].runs[0].attributes.get("bold"),
            Some(&Any::Bool(true))
        );
        let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
        assert_eq!(
            blocks(&restored),
            expected,
            "checkpoint lost fragment identity or presentation"
        );
    }
}
