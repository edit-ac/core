//! FIT-1.8: unchanged reads are bounded; real mutations/replay invalidate them.
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
};
use std::sync::Arc;

#[test]
fn checkpoint_restore_retains_first_read_evidence_and_observes_pre_read_mutation() {
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777703",
        "88888888-8888-4888-8888-888888888803",
    ).unwrap();
    let document = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode { kind: "block".into(), text: "a😀bc".into() },
          InitialNode { kind: "block".into(), text: "second".into() }],
    ).unwrap();
    let checkpoint = document.checkpoint();
    let restored = Document::restore(document.identity(), &checkpoint, &[]).unwrap();
    let mut before_read = Document::restore(document.identity(), &checkpoint, &[]).unwrap();
    assert_ne!(restored.writer_id(), checkpoint.writer_id);
    assert_ne!(before_read.writer_id(), checkpoint.writer_id);
    assert_ne!(restored.writer_id(), before_read.writer_id());
    assert_eq!(restored.checkpoint().bytes, checkpoint.bytes);
    assert_eq!(before_read.checkpoint().bytes, checkpoint.bytes);
    let original = document.snapshot().unwrap();
    let first = restored.snapshot().unwrap();
    assert_eq!(first.visible, original.visible);
    assert_eq!(first.changed_nodes, original.changed_nodes);
    assert_eq!(first.touched_ranges, original.touched_ranges);
    assert!(first.source_reads > 0 && first.structure_rebuilt);
    assert_eq!(restored.snapshot().unwrap().source_reads, 0);

    // Mutation/inspection before the first public snapshot must discard the
    // admitted snapshot and observe the real change, including UTF-16 offsets.
    let node = original.visible[0].id.clone();
    let at = before_read.anchor(&node, Utf16Offset(1), Bias::Right).unwrap();
    let plan = before_read.prepare_text(&TextCommand::Insert { at, text: "x".into() },
        &TextOrigin::new("fitness:restore-before-read").unwrap()).unwrap();
    let update = before_read.commit_text(plan).unwrap().update.unwrap();
    let changed = before_read.snapshot().unwrap();
    assert_eq!(changed.visible[0].runs.iter().map(|r| r.text.as_str()).collect::<String>(), "ax😀bc");
    assert!(changed.changed_nodes.contains(&node) && changed.source_reads > 0);
    let replayed = Document::restore(document.identity(), &checkpoint, &[update]).unwrap();
    assert_eq!(replayed.snapshot().unwrap().visible, changed.visible);
    assert_eq!(replayed.checkpoint().bytes, before_read.checkpoint().bytes);
    assert_eq!(before_read.snapshot().unwrap().source_reads, 0);
}

#[test]
fn unchanged_v5_projection_preserves_nodes_and_retained_state_without_source_reads() {
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777701",
        "88888888-8888-4888-8888-888888888801",
    )
    .unwrap();
    let mut document = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "café 😀 original".into(),
        }],
    )
    .unwrap();
    let first = document.snapshot().unwrap();
    let node = first.visible[0].id.clone();
    let idle = document.snapshot().unwrap();
    assert_eq!(idle.source_reads, 0);
    assert!(
        !idle.structure_rebuilt && idle.changed_nodes.is_empty() && idle.touched_ranges.is_empty()
    );
    assert!(Arc::ptr_eq(&first.visible[0], &idle.visible[0]));
    assert_eq!(idle.retained_structure, first.retained_structure);
    let anchor = document.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    document.resolve_anchor(&anchor).unwrap();
    assert_eq!(document.snapshot().unwrap().source_reads, 0);
    let checkpoint = document.checkpoint();
    let mut peer = Document::restore(document.identity(), &checkpoint, &[]).unwrap();
    peer.snapshot().unwrap();
    let plan = document
        .prepare_text(
            &TextCommand::Insert {
                at: anchor,
                text: "x".into(),
            },
            &TextOrigin::new("fitness:cache").unwrap(),
        )
        .unwrap();
    let update = document.commit_text(plan).unwrap().update.unwrap();
    let anchor = document.anchor(&node, Utf16Offset(1), Bias::Right).unwrap();
    document.resolve_anchor(&anchor).unwrap(); // Inspect must not consume dirtiness.
    let changed = document.snapshot().unwrap();
    assert!(changed.source_reads > 0 && changed.changed_nodes.contains(&node));
    assert_eq!(
        changed.visible[0]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "xcafé 😀 original"
    );
    assert_ne!(changed.retained_structure, first.retained_structure);
    assert_eq!(document.snapshot().unwrap().source_reads, 0);
    peer.apply_replay(&update).unwrap();
    let received = peer.snapshot().unwrap();
    assert_eq!(received.visible, changed.visible);
    assert_eq!(received.retained_structure, changed.retained_structure);
    assert!(received.source_reads > 0);
    assert_eq!(peer.snapshot().unwrap().source_reads, 0);
    let plan = document
        .prepare_editor(
            &[EditorCommand::Block {
                target: node.clone(),
                tuple: yrs::Any::Array(vec![yrs::Any::from("heading"), yrs::Any::from(2)].into()),
            }],
            &TextOrigin::new("fitness:structure").unwrap(),
        )
        .unwrap();
    document.commit_editor(plan).unwrap();
    let structural = document.snapshot().unwrap();
    assert!(structural.structure_rebuilt && structural.changed_nodes.contains(&node));
    assert_ne!(
        structural.visible[0].block_attributes,
        changed.visible[0].block_attributes
    );
    assert_eq!(document.snapshot().unwrap().source_reads, 0);
}

#[test]
fn inspected_dirty_projection_invalidates_on_second_edit_and_remote_deletion() {
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777702",
        "88888888-8888-4888-8888-888888888802",
    ).unwrap();
    let mut document = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode { kind: "block".into(), text: "a😀bc".into() },
          InitialNode { kind: "block".into(), text: "second".into() }],
    ).unwrap();
    let initial = document.snapshot().unwrap();
    let first = initial.visible[0].id.clone();
    let second = initial.visible[1].id.clone();
    for (node, offset, text) in [(&first, 1, "x"), (&second, 0, "y")] {
        let at = document.anchor(node, Utf16Offset(offset), Bias::Right).unwrap();
        let plan = document.prepare_text(&TextCommand::Insert { at, text: text.into() },
            &TextOrigin::new("fitness:dirty-inspection").unwrap()).unwrap();
        document.commit_text(plan).unwrap();
        // Resolve through inspect without consuming either edit's public deltas.
        let at = document.anchor(node, Utf16Offset(0), Bias::Right).unwrap();
        document.resolve_anchor(&at).unwrap();
    }
    let changed = document.snapshot().unwrap();
    assert!(changed.changed_nodes.contains(&first) && changed.changed_nodes.contains(&second));
    assert!(changed.touched_ranges.iter().any(|r| r.source == first));
    assert!(changed.touched_ranges.iter().any(|r| r.source == second));
    assert!(changed.source_reads > 0);
    assert_eq!(changed.visible[0].runs.iter().map(|r| r.text.as_str()).collect::<String>(), "ax😀bc");
    assert_eq!(changed.visible[1].runs.iter().map(|r| r.text.as_str()).collect::<String>(), "ysecond");
    assert_eq!(document.snapshot().unwrap().source_reads, 0);

    let checkpoint = document.checkpoint();
    let mut peer = Document::restore(document.identity(), &checkpoint, &[]).unwrap();
    let selection = peer.selection((&first, Utf16Offset(1), Bias::Right),
        (&first, Utf16Offset(2), Bias::Left)).unwrap();
    let plan = peer.prepare_text(&TextCommand::Delete { selection },
        &TextOrigin::new("fitness:remote-delete").unwrap()).unwrap();
    let update = peer.commit_text(plan).unwrap().update.unwrap();
    document.apply_replay(&update).unwrap();
    let at = document.anchor(&first, Utf16Offset(1), Bias::Right).unwrap();
    document.resolve_anchor(&at).unwrap();
    let received = document.snapshot().unwrap();
    assert!(received.changed_nodes.contains(&first));
    assert!(received.source_reads > 0 && !received.touched_ranges.is_empty());
    assert_eq!(received.visible[0].runs.iter().map(|r| r.text.as_str()).collect::<String>(), "a😀bc");
    let checkpoint = document.checkpoint();
    let fresh = Document::restore(document.identity(), &checkpoint, &[]).unwrap().snapshot().unwrap();
    assert_eq!(received.visible, fresh.visible);
    assert_eq!(received.recovery, fresh.recovery);
    assert_eq!(received.retained_structure, fresh.retained_structure);
    assert_eq!(document.snapshot().unwrap().source_reads, 0);
}
