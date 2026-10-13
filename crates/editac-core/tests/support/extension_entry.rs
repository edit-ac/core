//! MOD-1.1: one data corpus shared with the packed browser/WASM proof.
use super::*;
use editac_core::{document::BlockAttributes, modules::content::Content};
use yrs::{Text, Transact};

fn corpus() -> std::sync::Arc<std::collections::HashMap<String, Any>> {
    let Any::Map(value) =
        Any::from_json(include_str!("../../../../fixtures/modules/entry.json")).unwrap()
    else {
        panic!()
    };
    value
}

#[test]
fn extension_descriptors_commit_as_owned_patches_and_restore_without_callbacks() {
    let corpus = corpus();
    let Any::Array(cases) = &corpus["known"] else {
        panic!()
    };
    assert_eq!(cases.len(), 3);
    for case in cases.iter() {
        let Any::Map(case) = case else { panic!() };
        let tuple = &case["tuple"];
        let content = Content::from_tuple(tuple).unwrap().unwrap();
        assert_eq!(&content.tuple().unwrap(), tuple);
        let mut d = restore(&m::bytes(&m::seed()));
        let original = d
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|n| n.id == A)
            .unwrap();
        let (_subscription, events) = capture(&mut d, PatchScope::All);
        let before = d.checkpoint().bytes;
        let plan = d
            .prepare_editor(
                &[EditorCommand::Content {
                    target: A.into(),
                    content,
                }],
                &origin(),
            )
            .unwrap();
        assert_eq!(d.checkpoint().bytes, before);
        d.commit_editor(plan).unwrap();
        let after = d
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|n| n.id == A)
            .unwrap();
        assert_eq!(
            after.block_attributes,
            Some(BlockAttributes::Unknown(tuple.clone()))
        );
        assert_eq!(after.spans, original.spans);
        assert_eq!(after.runs, original.runs);
        assert_eq!(events.borrow().len(), 1);
        assert!(events.borrow()[0].update.is_some());
        assert_eq!(
            restore(&d.checkpoint().bytes).snapshot().unwrap().visible,
            d.snapshot().unwrap().visible
        );
    }
}

#[test]
fn invalid_extension_descriptors_reject_and_future_data_survives_checkpoint() {
    let corpus = corpus();
    let Any::Array(invalid) = &corpus["invalid"] else {
        panic!()
    };
    assert_eq!(invalid.len(), 3);
    for tuple in invalid.iter() {
        assert!(Content::from_tuple(tuple).is_err());
    }
    let Any::Map(unknown) = &corpus["unknown"] else {
        panic!()
    };
    assert!(Content::from_tuple(&unknown["tuple"]).unwrap().is_none());
    let x = m::seed();
    m::set(&x, 4, A, unknown["tuple"].clone());
    let Any::String(label) = &unknown["text"] else {
        panic!()
    };
    let Any::String(mark) = &unknown["mark"] else {
        panic!()
    };
    let t = m::text(&x, A);
    {
        let mut tx = x.transact_mut();
        let len = t.len(&tx);
        t.remove_range(&mut tx, 0, len);
        t.insert_with_attributes(
            &mut tx,
            0,
            label,
            [(mark.to_string().into(), unknown["attributes"].clone())].into(),
        );
    }
    let d = restore(&m::bytes(&x));
    let node = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == A)
        .unwrap();
    assert_eq!(
        node.block_attributes,
        Some(BlockAttributes::Unknown(unknown["tuple"].clone()))
    );
    assert_eq!(
        node.runs[0].attributes[mark.as_ref()],
        unknown["attributes"]
    );
    assert_eq!(text(&d, A), label.as_ref());
    assert_eq!(
        restore(&d.checkpoint().bytes).snapshot().unwrap().visible,
        d.snapshot().unwrap().visible
    );
    // A browser consumes these exact Rust-produced bytes, not a second seed.
    let path = std::path::PathBuf::from(
        std::env::var_os("EDITAC_EXTENSION_ENTRY_OUTPUT")
            .expect("explicit extension evidence directory required"),
    );
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("unknown-checkpoint.bin"), d.checkpoint().bytes).unwrap();
    std::fs::write(path.join("unknown-identity.json"), m::json(&m::envelope())).unwrap();
}

#[test]
fn invalid_content_in_a_mixed_command_batch_emits_no_patch_or_update() {
    let mut d = restore(&m::bytes(&m::seed()));
    let (_subscription, events) = capture(&mut d, PatchScope::All);
    let before = d.checkpoint().bytes;
    let at = d.anchor(B, U(0), Bias::Right).unwrap();
    let commands = [
        EditorCommand::Text(TextCommand::Insert {
            at,
            text: "staged only".into(),
        }),
        EditorCommand::Content {
            target: A.into(),
            content: Content::Image {
                url: "javascript:alert(1)".into(),
                alt: "safe fallback".into(),
                title: String::new(),
                source: "original source".into(),
            },
        },
    ];
    assert!(matches!(
        d.prepare_editor(&commands, &origin()),
        Err(EditorError::InvalidCommand)
    ));
    assert_eq!(d.checkpoint().bytes, before);
    assert!(events.borrow().is_empty());
}
