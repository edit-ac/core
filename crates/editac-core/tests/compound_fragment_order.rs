//! Regression captured from the exact packed Markdown Task consumer.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::{EditorCommand, FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{Document, DocumentIdentity, InitializedCheckpoint},
};

const FIRST: &str = "n:1923565734:1";
const BODY: &str = "prefix alpha 😀literalBISUCLG";
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "d37ec784-d2d2-48af-9cad-58beb96403ac",
        "2e06becb-8396-47a1-be72-40150e283ca3",
    )
    .unwrap()
}
fn restore(bytes: &[u8]) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 440034565,
            bytes: bytes.to_vec(),
        },
        &[],
    )
    .unwrap()
}
fn origin() -> TextOrigin {
    TextOrigin::new("local:compound-order-regression").unwrap()
}
fn text(d: &Document) -> String {
    d.snapshot().unwrap().visible[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
fn commit(d: &mut Document, commands: &[EditorCommand]) {
    let before = d.checkpoint().bytes;
    let plan = d.prepare_editor(commands, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, before, "preparation must be isolated");
    d.commit_editor(plan).unwrap();
}
fn split_join(d: &mut Document) {
    let before = d.snapshot().unwrap().visible;
    let at = d
        .anchor(FIRST, U(text(d).encode_utf16().count() as u32), Bias::Left)
        .unwrap();
    commit(
        d,
        &[EditorCommand::Split {
            owner: FIRST.into(),
            at,
        }],
    );
    let split = d.snapshot().unwrap().visible;
    assert_eq!(
        split[0].runs, before[0].runs,
        "terminal Enter must preserve the rich owner"
    );
    assert!(split[1].runs.iter().all(|r| r.text.is_empty()));
    for (actual, expected) in split[2..].iter().zip(&before[1..]) {
        let mut actual = actual.as_ref().clone();
        actual.order = expected.order; // The inserted block shifts root indices.
        assert_eq!(
            &actual,
            expected.as_ref(),
            "stored optional content must stay in order"
        );
    }
    assert_eq!(split.len(), before.len() + 1);
    commit(
        d,
        &[EditorCommand::Join {
            first: FIRST.into(),
            second: split[1].id.clone(),
        }],
    );
    let joined = d.snapshot().unwrap().visible;
    assert_eq!(joined[0].runs, before[0].runs);
    assert_eq!(&joined[1..], &before[1..]);
}
#[test]
fn captured_old_terminal_enter_is_a_durable_ordering_negative_control() {
    let before = restore(include_bytes!(
        "../../../fixtures/compound-fragment-order/before-enter.bin"
    ));
    let failed = restore(include_bytes!(
        "../../../fixtures/compound-fragment-order/after-enter.bin"
    ));
    assert_eq!(text(&before), BODY);
    assert_eq!(text(&failed), "");
    assert!(
        failed.snapshot().unwrap().visible.iter().any(|n| n
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>()
            == BODY)
    );
}
#[test]
fn captured_rich_fragments_keep_order_through_terminal_split_join_restore_and_peer() {
    let mut d = restore(include_bytes!(
        "../../../fixtures/compound-fragment-order/before-enter.bin"
    ));
    assert_eq!(text(&d), BODY);
    split_join(&mut d);
    let mut peer = restore(&d.checkpoint().bytes);
    let at = peer.anchor(FIRST, U(0), Bias::Right).unwrap();
    commit(
        &mut peer,
        &[EditorCommand::Text(
            editac_core::commands::text::TextCommand::Insert {
                at,
                text: "remote ".into(),
            },
        )],
    );
    d.apply_replay(&editac_core::document::ReplayUpdate {
        identity: identity(),
        bytes: peer.update_v1(&d.state_vector_v1()).unwrap(),
    })
    .unwrap();
    assert_eq!(text(&d), format!("remote {BODY}"));
    assert_eq!(
        restore(&d.checkpoint().bytes).snapshot().unwrap().visible,
        d.snapshot().unwrap().visible
    );
}
#[test]
fn repeated_rich_replacement_and_append_preserve_the_original_lineage() {
    let mut d = restore(include_bytes!(
        "../../../fixtures/compound-fragment-order/before-enter.bin"
    ));
    for _ in 0..3 {
        let fragment = d.fragment_for_node(FIRST).unwrap();
        let range = Selection {
            anchor: d.anchor(FIRST, U(0), Bias::Right).unwrap(),
            focus: d
                .anchor(FIRST, U(text(&d).encode_utf16().count() as u32), Bias::Left)
                .unwrap(),
        };
        let plan = d.prepare_fragment(&range, &[fragment], &origin()).unwrap();
        d.commit_editor(plan).unwrap();
        assert_eq!(text(&d), BODY);
        split_join(&mut d);
    }
    let end = d
        .anchor(FIRST, U(BODY.encode_utf16().count() as u32), Bias::Left)
        .unwrap();
    let plan = d
        .prepare_fragment(
            &Selection {
                anchor: end.clone(),
                focus: end,
            },
            &[FragmentBlock {
                runs: vec![FragmentRun {
                    opaque_marks: vec![],
                    text: " tail".into(),
                    marks: vec![],
                }],
                attributes: None,
                containers: vec![],
                checked: None,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(plan).unwrap();
    assert_eq!(text(&d), format!("{BODY} tail"));
    split_join(&mut d);
}
