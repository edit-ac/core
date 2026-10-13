mod support;
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Resolution},
    document::{Document, DocumentError},
    patches::PatchOperation,
};
use editac_markdown::reconcile::{ConflictKind, SourceBaseline, SourceMode};
use support::*;

#[test]
fn initialized_empty_checkpoint_restores_with_distinct_live_writers() {
    let first = document();
    let second = document();
    assert!(first.is_initialized() && second.is_initialized());
    assert_eq!(text(&first), "");
    assert_eq!(first.identity(), second.identity());
    assert_eq!(owner(&first), owner(&second));
    assert_ne!(first.writer_id(), second.writer_id());
    assert_ne!(first.writer_id(), checkpoint().writer_id);
}

#[test]
fn committed_owned_patch_replays_without_reseeding_and_keeps_utf16_anchor() {
    let mut local = document();
    let mut peer = document();
    insert(&mut local, 0, "a😀b");
    let patch = local.last_patch().unwrap();
    assert_eq!(patch.operation, PatchOperation::Text);
    let update = patch.update.as_ref().unwrap().clone();
    drop(patch);
    drop(local);
    peer.apply_replay(&update).unwrap();
    assert_eq!(text(&peer), "a😀b");
    let anchor = peer
        .anchor(&owner(&peer), Utf16Offset(3), Bias::Right)
        .unwrap();
    insert(&mut peer, 0, "é");
    assert!(
        matches!(peer.resolve_anchor(&anchor).unwrap(), Resolution::Position(p) if p.offset == Utf16Offset(4))
    );
    let restored = Document::restore(peer.identity(), &peer.checkpoint(), &[]).unwrap();
    assert_eq!(text(&restored), "éa😀b");
    assert_eq!(owner(&restored), owner(&peer));
}

#[test]
fn wrong_epoch_and_frozen_profile_reject_before_restore() {
    let point = checkpoint();
    let mut wrong = point.identity.clone();
    wrong.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    assert!(matches!(
        Document::restore(&wrong, point, &[]),
        Err(DocumentError::WrongEpoch)
    ));
    let legacy = editac_core::document::DocumentIdentity::v4(
        &point.identity.document_id,
        &point.identity.epoch,
    )
    .unwrap();
    assert!(Document::restore(&legacy, point, &[]).is_err());
    assert_eq!(point.bytes, checkpoint().bytes);
}

#[test]
fn exact_source_baseline_uses_existing_prepare_commit_and_stale_rejection() {
    let mut doc = document();
    insert(&mut doc, 0, "a😀b");
    let owners = vec![owner(&doc)];
    let baseline = SourceBaseline::capture(&doc, "a😀b", SourceMode::Literal, &owners).unwrap();
    let unchanged = doc.checkpoint().bytes;
    assert!(
        baseline
            .prepare(&doc, "a😀b", &origin())
            .unwrap()
            .commit(&mut doc)
            .unwrap()
            .commit
            .is_none()
    );
    assert_eq!(doc.checkpoint().bytes, unchanged);
    let prepared = baseline.prepare(&doc, "a😀B", &origin()).unwrap();
    insert(&mut doc, 0, "é");
    let before = doc.checkpoint().bytes;
    let vector = doc.state_vector_v1();
    let failure = prepared.commit(&mut doc).err().unwrap();
    assert_eq!(failure.kind, ConflictKind::StalePlan);
    assert_eq!(doc.checkpoint().bytes, before);
    assert_eq!(doc.state_vector_v1(), vector);
    let fresh = SourceBaseline::capture(&doc, "éa😀b", SourceMode::Literal, &owners).unwrap();
    fresh
        .prepare(&doc, "éa😀B", &origin())
        .unwrap()
        .commit(&mut doc)
        .unwrap();
    assert_eq!(text(&doc), "éa😀B");
    assert_eq!(owner(&doc), owners[0]);
}
