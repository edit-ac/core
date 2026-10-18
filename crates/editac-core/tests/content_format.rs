//! Touch-format admission uses the existing prepared format/history owner.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::Bias,
    commands::{
        editor::EditorCommand,
        format::{FormatAction, FormatCommand, FormatError, Mark},
        text::TextOrigin,
    },
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::content::Content,
};
use serde_json::{Value, json};
use yrs::Any;
const OWNER: &str = "n:11:1";
fn origin() -> TextOrigin {
    TextOrigin::new("touch-format").unwrap()
}
fn engine(tuple: &Value) -> Document {
    let id = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let mut d = Document::restore(
        &id,
        &InitializedCheckpoint {
            identity: id.clone(),
            initialized: true,
            writer_id: 11,
            bytes: m::bytes(&m::seed()),
        },
        &[],
    )
    .unwrap();
    let content = Content::from_tuple(&Any::from_json(&tuple.to_string()).unwrap())
        .unwrap()
        .unwrap();
    let text = content
        .asset_fallback()
        .or_else(|| content.inert_source())
        .map(str::to_owned)
        .unwrap_or_else(|| match &content {
            Content::Reference { label, .. } => label.clone(),
            _ => "table source".into(),
        });
    let length = text.encode_utf16().count() as u32;
    let plan = d
        .prepare_editor(
            &[
                EditorCommand::ReplaceAt {
                    owner: OWNER.into(),
                    from: U(0),
                    to: U(4),
                    text,
                },
                EditorCommand::MarkAt {
                    owner: OWNER.into(),
                    from: U(0),
                    to: U(length),
                    mark: Mark::Bold,
                    action: FormatAction::Remove,
                    href: None,
                },
                EditorCommand::Content {
                    target: OWNER.into(),
                    content,
                },
            ],
            &origin(),
        )
        .unwrap();
    d.commit_editor(plan).unwrap();
    let mut d = Document::restore(&id, &d.checkpoint(), &[]).unwrap();
    d.enable_history(Default::default()).unwrap();
    d
}
fn carrier(name: &str) -> Value {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../fixtures/rich-presenters/formatting/mixed-extensions.json"
    ))
    .unwrap();
    corpus["returnedCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == format!("{name}-bold"))
        .unwrap()["envelope"]["payload"][0]["attributes"]["tuple"]
        .clone()
}
fn exercise(name: &str) {
    for mark in [
        Mark::Bold,
        Mark::Italic,
        Mark::Strike,
        Mark::Underline,
        Mark::Code,
        Mark::Link,
    ] {
        let mut d = engine(&carrier(name));
        let before = d.snapshot().unwrap();
        let node = before.visible.iter().find(|n| n.id == OWNER).unwrap();
        let text: String = node.runs.iter().map(|r| r.text.as_str()).collect();
        let end = text.encode_utf16().count() as u32;
        let selection = d
            .selection((OWNER, U(end), Bias::Left), (OWNER, U(0), Bias::Right))
            .unwrap();
        let anchor = selection.anchor.clone();
        let bookmark = d.resolve_anchor(&anchor).unwrap();
        let command = FormatCommand {
            selection,
            mark,
            action: FormatAction::Apply,
            href: (mark == Mark::Link).then(|| "https://EXAMPLE.test/path".into()),
        };
        let opening = d.checkpoint().bytes;
        let plan = d.prepare_format(&[command], &origin()).unwrap();
        assert_eq!(d.checkpoint().bytes, opening);
        d.commit_format(plan).unwrap();
        assert_eq!(d.history_state().undo_groups, 1);
        let after = d.snapshot().unwrap();
        let changed = after.visible.iter().find(|n| n.id == OWNER).unwrap();
        assert_eq!(changed.block_attributes, node.block_attributes);
        assert_eq!(
            changed
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>(),
            text
        );
        let key = match mark {
            Mark::Bold => "bold",
            Mark::Italic => "italic",
            Mark::Strike => "strike",
            Mark::Underline => "underline",
            Mark::Code => "code",
            Mark::Link => "link",
        };
        assert!(changed.runs.iter().all(|r| r.attributes.contains_key(key)));
        let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
        assert_eq!(restored.snapshot().unwrap().visible, after.visible);
        d.undo().unwrap().unwrap();
        assert_eq!(d.snapshot().unwrap().visible, before.visible);
        d.redo().unwrap().unwrap();
        assert_eq!(d.snapshot().unwrap().visible, after.visible);
        assert_eq!(d.resolve_anchor(&anchor).unwrap(), bookmark);
    }
}
#[test]
fn reference_text_uses_all_six_prepared_marks() {
    exercise("reference");
}
#[test]
fn file_fallback_uses_all_six_prepared_marks() {
    exercise("file");
}
#[test]
fn image_fallback_uses_all_six_prepared_marks() {
    exercise("image-asset");
}
#[test]
fn inert_source_uses_all_six_prepared_marks() {
    exercise("inert");
}
#[test]
fn tables_still_require_scoped_cell_commands() {
    let d = engine(
        &json!(["module:editac.table",1,{"alignments":["none"],"rows":[[[["cell",[]]]]],"source":"table source"}]),
    );
    let n = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == OWNER)
        .unwrap();
    let length = n
        .runs
        .iter()
        .map(|r| r.text.encode_utf16().count())
        .sum::<usize>() as u32;
    let c = FormatCommand {
        selection: d
            .selection((OWNER, U(0), Bias::Right), (OWNER, U(length), Bias::Left))
            .unwrap(),
        mark: Mark::Bold,
        action: FormatAction::Apply,
        href: None,
    };
    let before = d.checkpoint().bytes;
    assert_eq!(
        d.prepare_format(&[c], &origin()).unwrap_err(),
        FormatError::UnsupportedBlockTarget
    );
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 0);
}
#[test]
fn unknown_malformed_unsupported_and_code_targets_still_reject_without_mutation() {
    use yrs::{Map, ReadTxn, Transact};
    for tuple in [
        json!(["vendor:unknown", 1, {}]),
        json!(["module:editac.reference",99,{"label":"a😀b","targetId":"opaque"}]),
        json!(["module:editac.reference",1,{"label":"a😀b"}]),
        json!(["module:editac.asset", 1, {}]),
        json!(["module:editac.inert-extension", 2, {}]),
        json!(["code", "rust"]),
    ] {
        let source = m::seed();
        {
            let mut txn = source.transact_mut();
            txn.get_map(editac_core::document::BLOCK_ATTRIBUTES)
                .unwrap()
                .insert(&mut txn, OWNER, Any::from_json(&tuple.to_string()).unwrap());
        }
        let id = DocumentIdentity::v5(
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888888",
        )
        .unwrap();
        let d = Document::restore(
            &id,
            &InitializedCheckpoint {
                identity: id.clone(),
                initialized: true,
                writer_id: 11,
                bytes: m::bytes(&source),
            },
            &[],
        )
        .unwrap();
        let selection = d
            .selection((OWNER, U(0), Bias::Right), (OWNER, U(4), Bias::Left))
            .unwrap();
        let command = FormatCommand {
            selection,
            mark: Mark::Italic,
            action: FormatAction::Apply,
            href: None,
        };
        let before = d.checkpoint().bytes;
        assert_eq!(
            d.prepare_format(&[command], &origin()).unwrap_err(),
            FormatError::UnsupportedBlockTarget,
            "{tuple}"
        );
        assert_eq!(d.checkpoint().bytes, before);
    }
}
