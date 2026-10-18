//! LCR-1.2: the existing atomic-content owner edits retained callouts.
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::{
        editor::{EditorCommand, FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    modules::content::Content,
};
use yrs::Any;
fn origin() -> TextOrigin {
    TextOrigin::new("local:callout-recipe").unwrap()
}
fn content(kind: &str, body: &str) -> Content {
    Content::Callout {
        kind: kind.into(),
        body: body.into(),
        source: format!("> [!{kind}]\n> {body}\n"),
    }
}
fn setup() -> Document {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let identity = DocumentIdentity::v5(
        format!("95000000-0000-4000-8000-{next:012}"),
        format!("96000000-0000-4000-8000-{next:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: String::new(),
        }],
    )
    .unwrap();
    let id = d.snapshot().unwrap().visible[0].id.clone();
    let a = d.anchor(&id, Utf16Offset(0), Bias::Right).unwrap();
    let p = d
        .prepare_fragment(
            &Selection {
                anchor: a.clone(),
                focus: a,
            },
            &[FragmentBlock {
                attributes: Some(BlockAttributes::Unknown(
                    content("NOTE", "Project kickoff").tuple().unwrap(),
                )),
                runs: vec![FragmentRun {
                    text: "NOTE\nProject kickoff".into(),
                    marks: vec![],
                    opaque_marks: vec![],
                }],
                containers: vec![],
                checked: None,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap()
}
fn node(d: &Document) -> std::sync::Arc<editac_core::projection::ProjectedNode> {
    d.snapshot().unwrap().visible.into_iter().find(|n| matches!(&n.block_attributes, Some(BlockAttributes::Unknown(t)) if matches!(Content::from_tuple(t), Ok(Some(Content::Callout { .. }))))).unwrap()
}
fn command(d: &Document, replacement: Option<Content>) -> EditorCommand {
    let n = node(d);
    EditorCommand::AtomicContent {
        target: n.id.clone(),
        expected: n.block_attributes.clone().unwrap().tuple(),
        at: d.anchor(&n.id, Utf16Offset(0), Bias::Right).unwrap(),
        replacement,
    }
}
#[test]
fn callout_replacement_is_same_owner_pure_preparation_one_history_and_exact_peer_replay() {
    let mut d = setup();
    d.enable_history(HistoryConfig::default()).unwrap();
    let before = d.checkpoint();
    let original = node(&d);
    let mut peer = Document::restore(d.identity(), &before, &[]).unwrap();
    let replacement = content("TIP", "Owner: Sam 😀");
    let expected = replacement.tuple().unwrap();
    let p = d
        .prepare_editor(&[command(&d, Some(replacement))], &origin())
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before.bytes);
    let update = d.commit_editor(p).unwrap().update;
    peer.apply_replay(&update).unwrap();
    assert_eq!(node(&d).id, original.id);
    assert_eq!(
        node(&d).block_attributes,
        Some(BlockAttributes::Unknown(expected))
    );
    assert_eq!(d.history_state().undo_groups, 1);
    assert_eq!(
        d.snapshot().unwrap().visible,
        peer.snapshot().unwrap().visible
    );
    assert_eq!(
        node(&d)
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "TIP\nOwner: Sam 😀"
    );
    d.undo().unwrap().unwrap();
    assert_eq!(node(&d).block_attributes, original.block_attributes);
    assert_eq!(node(&d).runs, original.runs);
    d.redo().unwrap().unwrap();
    assert_eq!(node(&d).block_attributes, node(&peer).block_attributes);
}
#[test]
fn callout_invalid_kind_stale_descriptor_wrong_family_anchor_and_late_failure_are_atomic() {
    let mut d = setup();
    d.enable_history(HistoryConfig::default()).unwrap();
    let before = d.checkpoint().bytes;
    let mut stale = command(&d, Some(content("TIP", "valid")));
    if let EditorCommand::AtomicContent { expected, .. } = &mut stale {
        *expected = Any::Null;
    }
    let mut bad_anchor = command(&d, Some(content("TIP", "valid")));
    if let EditorCommand::AtomicContent { at, .. } = &mut bad_anchor {
        *at = d.anchor(&node(&d).id, Utf16Offset(1), Bias::Right).unwrap();
    }
    for c in [
        command(&d, Some(content("BOGUS", "invalid"))),
        stale,
        bad_anchor,
        command(
            &d,
            Some(Content::Reference {
                target_id: "other".into(),
                label: "wrong family".into(),
            }),
        ),
    ] {
        assert!(d.prepare_editor(&[c], &origin()).is_err());
        assert_eq!(d.checkpoint().bytes, before);
    }
    assert!(
        d.prepare_editor(
            &[
                command(&d, Some(content("TIP", "valid"))),
                command(&d, Some(content("NOTE", "stale later")))
            ],
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 0);
}
#[test]
fn callout_whole_removal_and_undo_restore_exact_descriptor_and_fallback() {
    let mut d = setup();
    d.enable_history(HistoryConfig::default()).unwrap();
    let original = node(&d);
    let p = d.prepare_editor(&[command(&d, None)], &origin()).unwrap();
    d.commit_editor(p).unwrap();
    let current = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == original.id)
        .unwrap();
    assert_eq!(current.block_attributes, Some(BlockAttributes::Paragraph));
    assert!(current.runs.iter().all(|r| r.text.is_empty()));
    d.undo().unwrap().unwrap();
    assert_eq!(node(&d).block_attributes, original.block_attributes);
    assert_eq!(node(&d).runs, original.runs);
}
