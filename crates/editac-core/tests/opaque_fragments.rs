//! SFR-1.2: actual common prepared commands, without an alternate schema.
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
};
use yrs::Any;
fn fixture() -> Document {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let identity = DocumentIdentity::v5(
        format!("a1000000-0000-4000-8000-{n:012x}"),
        format!("a2000000-0000-4000-8000-{n:012x}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(identity).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "original".into(),
        }],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn origin() -> TextOrigin {
    TextOrigin::new("local:opaque-test").unwrap()
}
fn all(d: &Document) -> Selection {
    let n = d.snapshot().unwrap().visible[0].clone();
    Selection {
        anchor: d.anchor(&n.id, Utf16Offset(0), Bias::Right).unwrap(),
        focus: d
            .anchor(
                &n.id,
                Utf16Offset(
                    n.runs
                        .iter()
                        .map(|r| r.text.encode_utf16().count() as u32)
                        .sum(),
                ),
                Bias::Left,
            )
            .unwrap(),
    }
}
fn block() -> FragmentBlock {
    FragmentBlock {
        attributes: Some(BlockAttributes::Paragraph),
        containers: vec![],
        checked: None,
        runs: vec![FragmentRun {
            text: "A😀B".into(),
            marks: vec![(Mark::Bold, None)],
            opaque_marks: vec![(
                "vendor-note".into(),
                Any::from_json(r#"{"version":1,"payload":{"nested":[false,"😀",42]}}"#).unwrap(),
            )],
        }],
    }
}
fn wire(d: &Document) -> serde_json::Value {
    editac_core::interchange::transfer_value(
        &d.fragment_for_node(&d.snapshot().unwrap().visible[0].id)
            .unwrap(),
    )
}
#[test]
fn prepared_opaque_fragment_roundtrip_is_isolated_one_history_and_durable() {
    let mut d = fixture();
    let before = d.checkpoint();
    let identity = d.identity().clone();
    let b = block();
    let p = d
        .prepare_fragment(&all(&d), &[b.clone()], &origin())
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before.bytes);
    d.commit_editor(p).unwrap();
    assert_eq!(d.history_state().undo_groups, 1);
    assert_eq!(wire(&d), editac_core::interchange::transfer_value(&b));
    let c = d.checkpoint();
    let reopened = Document::restore(&identity, &c, &[]).unwrap();
    assert_eq!(wire(&reopened), wire(&d));
    assert_eq!(reopened.identity(), &identity);
    d.undo().unwrap();
    assert_eq!(d.snapshot().unwrap().visible[0].runs[0].text, "original");
    d.redo().unwrap();
    assert_eq!(wire(&d), wire(&reopened));
}
#[test]
fn source_edits_remove_absent_opaque_keys_and_preserve_present_values_exactly() {
    let mut d = fixture();
    let b = block();
    let p = d
        .prepare_fragment(&all(&d), &[b.clone()], &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    let p = d
        .prepare_source_edits(&[(all(&d), vec![b.clone()])], &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    assert_eq!(wire(&d), editac_core::interchange::transfer_value(&b));
    let mut plain = b;
    plain.runs[0].opaque_marks.clear();
    plain.runs[0].marks.clear();
    plain.runs[0].text = "plain".into();
    let p = d
        .prepare_source_edits(&[(all(&d), vec![plain.clone()])], &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    assert_eq!(wire(&d), editac_core::interchange::transfer_value(&plain));
}
#[test]
fn invalid_direct_opaque_preparation_is_atomic_and_does_not_bypass_wire_checks() {
    let d = fixture();
    let before = d.checkpoint();
    let history = d.history_state();
    let b = block();
    for marks in [
        vec![("bold".into(), Any::Bool(true))],
        vec![("x".into(), Any::Null)],
        vec![("x".into(), Any::Bool(true)); 33],
        vec![
            ("x".into(), Any::Bool(true)),
            ("x".into(), Any::Bool(false)),
        ],
        vec![("x".repeat(129), Any::Bool(true))],
    ] {
        let mut invalid = b.clone();
        invalid.runs[0].opaque_marks = marks;
        assert!(
            d.prepare_fragment(&all(&d), &[invalid.clone()], &origin())
                .is_err()
        );
        assert!(
            d.prepare_source_edits(&[(all(&d), vec![invalid])], &origin())
                .is_err()
        );
        assert_eq!(d.checkpoint().bytes, before.bytes);
        assert_eq!(d.history_state().undo_groups, history.undo_groups);
    }
}

#[test]
fn markdown_retains_opaque_recovery_and_never_claims_named_only_equivalence() {
    use editac_markdown::{
        export,
        optional::Codecs,
        reconcile::{SourceBaseline, SourceMode},
    };
    let mut d = fixture();
    let b = block();
    let p = d
        .prepare_fragment(&all(&d), &[b.clone()], &origin())
        .unwrap();
    d.commit_editor(p).unwrap();
    assert!(export::equivalent(&[b.clone()], &[b.clone()]));
    let mut segmented = b.clone();
    let mut tail = segmented.runs[0].clone();
    segmented.runs[0].text = "A".into();
    tail.text = "😀B".into();
    segmented.runs.push(tail);
    assert!(export::equivalent(&[b.clone()], &[segmented]));
    let result = export::export(&[b.clone()]);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "opaque-marks-internal-only")
    );
    assert_eq!(
        editac_core::interchange::transfer_value(&result.recovery[0]),
        editac_core::interchange::transfer_value(&b)
    );
    let mut named = b.clone();
    named.runs[0].opaque_marks.clear();
    assert!(!export::equivalent(&[b], &[named.clone()]));
    assert!(
        editac_core::interchange::transfer_value(&named)["runs"][0]
            .get("opaqueMarks")
            .is_none()
    );
    let owners = vec![d.snapshot().unwrap().visible[0].id.clone()];
    let baseline = SourceBaseline::capture(
        &d,
        "**A😀B**",
        SourceMode::Markdown(Codecs::default()),
        &owners,
    )
    .unwrap();
    let before = d.checkpoint();
    assert!(baseline.prepare(&d, "**changed**", &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, before.bytes);
}
