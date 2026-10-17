//! EXT-1.13-C3-B: ordinary inert content, not an external recovery side channel.
use editac_core::{
    commands::editor::{FragmentBlock, FragmentRun},
    document::BlockAttributes,
    modules::content::{Content, ContentError},
};
use serde_json::{Value, json};
use yrs::Any;
fn tuple() -> Value {
    json!(["module:editac.inert-extension",1,{"version":1,"type":"vendor.atom","dataVersion":99,"source":"<script>unsafe()</script> ![x](https://example.invalid/x) 😀","payload":{"formula":"=unsafe()","url":"javascript:unsafe()","nested":[null,true,17]}}])
}
fn any(value: &Value) -> Any {
    Any::from_json(&value.to_string()).unwrap()
}
#[test]
fn unknown_identity_version_and_payload_roundtrip_exactly() {
    let t = any(&tuple());
    let content = Content::from_tuple(&t).unwrap().unwrap();
    assert!(matches!(content, Content::InertExtension { .. }));
    assert_eq!(content.tuple().unwrap(), t);
    assert_eq!(
        content.inert_source().unwrap(),
        tuple()[2]["source"].as_str().unwrap()
    );
}
#[test]
fn malformed_and_unbounded_carriers_reject() {
    let mutations: Vec<fn(&mut Value)> = vec![
        |v| v[1] = json!(2),
        |v| v[2]["version"] = json!(2),
        |v| v[2]["type"] = json!("bad/name"),
        |v| v[2]["type"] = json!("vendor.atom.extra"),
        |v| v[2]["type"] = json!("Vendor.atom"),
        |v| v[2]["dataVersion"] = json!(0),
        |v| v[2]["dataVersion"] = json!(1.5),
        |v| v[2]["dataVersion"] = json!(4294967296u64),
        |v| v[2]["source"] = json!(false),
        |v| {
            v[2].as_object_mut().unwrap().remove("payload");
        },
        |v| v[2]["extra"] = json!(true),
        |v| v[2]["payload"] = json!({"constructor":null}),
        |v| v[2]["payload"] = json!({"deep":{"__proto__":null}}),
        |v| v[2]["payload"] = json!(vec![Value::Null; 65536]),
        |v| v[2]["source"] = json!("x".repeat(1_048_577)),
        |v| {
            let mut x = json!(null);
            for _ in 0..17 {
                x = json!([x]);
            }
            v[2]["payload"] = x;
        },
        // JSON escaping counts against serialized size, not only source bytes.
        |v| v[2]["source"] = json!("\u{1}".repeat(180000)),
    ];
    for mutate in mutations {
        let mut v = tuple();
        mutate(&mut v);
        assert!(
            Content::from_tuple(&any(&v)).is_err(),
            "unrejected mutation"
        );
    }
    for data in [
        Any::Undefined,
        Any::Buffer(vec![1u8].into()),
        Any::from(f64::NAN),
    ] {
        assert_eq!(
            Content::InertExtension { data }.validate(),
            Err(ContentError::InvalidShape)
        );
    }
}
#[test]
fn markdown_reports_fallback_and_preserves_typed_recovery_without_active_syntax() {
    let t = any(&tuple());
    let content = Content::from_tuple(&t).unwrap().unwrap();
    let block = FragmentBlock {
        attributes: Some(BlockAttributes::Unknown(t.clone())),
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: content.inert_source().unwrap().into(),
            marks: vec![],
        }],
        containers: vec![],
        checked: None,
    };
    let result = editac_markdown::export::export(&[block]);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "inert-extension-source-fallback")
    );
    assert!(result.markdown.contains("\\<script\\>"));
    assert!(result.markdown.contains("\\!\\[x\\]"));
    assert_eq!(result.recovery[0].attributes.as_ref().unwrap().tuple(), t);
    let imported = editac_markdown::import::import(&result.markdown).unwrap();
    assert!(
        imported
            .blocks
            .iter()
            .all(|b| !matches!(b.attributes, Some(BlockAttributes::Unknown(_))))
    );
}
