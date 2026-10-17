//! EXT-1.13-C3-A: exact v2 tuple admission and explicit Markdown recovery.
use editac_core::{
    commands::editor::{FragmentBlock, FragmentRun},
    document::BlockAttributes,
    modules::content::Content,
};
use serde_json::{Value, json};
use yrs::Any;
fn fixture() -> Value {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../fixtures/extensions/clipboard/conformance.json"
    ))
    .unwrap();
    corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == "table-v2-mixed-cell")
        .unwrap()["envelope"]["payload"][0]["attributes"]["tuple"]
        .clone()
}
fn any(value: &Value) -> Any {
    Any::from_json(&value.to_string()).unwrap()
}
#[test]
fn exact_mixed_cell_roundtrip_preserves_every_field() {
    let tuple = any(&fixture());
    let content = Content::from_tuple(&tuple).unwrap().unwrap();
    assert!(matches!(content, Content::RichTable { .. }));
    assert_eq!(content.tuple().unwrap(), tuple);
}
#[test]
fn malformed_geometry_styles_and_bounds_reject() {
    let mutations: Vec<fn(&mut Value)> = vec![
        |t| t[2]["alignments"] = json!([]),
        |t| t[2]["alignments"][0] = json!("unsupported"),
        |t| t[2]["rows"] = json!([]),
        |t| t[2]["rows"] = json!(vec![t[2]["rows"][0].clone(); 129]),
        |t| t[2]["source"] = json!("x".repeat(1_048_577)),
        |t| t[2]["rows"][1][1] = Value::Null,
        |t| t[2]["rows"][1][1]["paragraphs"] = json!([]),
        |t| {
            t[2]["rows"][1][1]["paragraphs"] =
                json!(vec![t[2]["rows"][1][1]["paragraphs"][0].clone(); 1025])
        },
        |t| t[2]["rows"][0][0]["rowSpan"] = json!(3),
        |t| t[2]["rows"][0][0]["columnSpan"] = json!(0),
        |t| t[2]["rows"][0][0]["rowSpan"] = json!(1.5),
        |t| t[2]["rows"][0][2] = t[2]["rows"][1][1].clone(),
        |t| t[2]["rows"][1][0] = t[2]["rows"][1][1].clone(),
        |t| t[2]["rows"][1][1]["paragraphs"][0]["style"] = json!(["code", "unsafe language"]),
        |t| t[2]["rows"][0][0]["paragraphs"][0]["style"] = json!(["heading", 7]),
        |t| t[2]["rows"][0][0]["header"] = json!("true"),
        |t| t[2]["rows"][0][0]["unexpected"] = json!(true),
        |t| t[2]["rows"][0][0]["paragraphs"][0]["runs"] = json!(vec![json!(["x", []]); 1025]),
        |t| {
            t[2]["rows"][0][0]["paragraphs"][0]["runs"][0][1] =
                json!([["link", "javascript:alert(1)"]])
        },
        |t| t[1] = json!(3),
    ];
    for mutate in mutations {
        let mut value = fixture();
        mutate(&mut value);
        assert!(Content::from_tuple(&any(&value)).is_err(), "{value}");
    }
}
#[test]
fn v1_shape_and_versions_are_not_reinterpreted() {
    let legacy = json!(["module:editac.table", 1, {"alignments":["none"],"rows":[[[["old", [["bold"]]]]]],"source":"old source"}]);
    let content = Content::from_tuple(&any(&legacy)).unwrap().unwrap();
    assert!(matches!(content, Content::Table { .. }));
    assert_eq!(content.tuple().unwrap(), any(&legacy));
    let mut incompatible = fixture();
    incompatible[1] = json!(1);
    assert!(Content::from_tuple(&any(&incompatible)).is_err());
}
#[test]
fn markdown_reports_loss_and_retains_exact_rich_recovery() {
    let tuple = any(&fixture());
    let block = FragmentBlock {
        attributes: Some(BlockAttributes::Unknown(tuple.clone())),
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: "fallback".into(),
            marks: vec![],
        }],
        containers: vec![],
        checked: None,
    };
    let result = editac_markdown::export::export(&[block]);
    assert_eq!(
        result.markdown,
        format!("{}\n", fixture()[2]["source"].as_str().unwrap())
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "rich-table-source-fallback")
    );
    assert_eq!(
        result.recovery[0].attributes.as_ref().unwrap().tuple(),
        tuple
    );
}
