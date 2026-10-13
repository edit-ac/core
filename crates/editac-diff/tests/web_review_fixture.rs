use editac_diff::{representation::*, semantic::*, text::*};
use serde_json::json;
fn scope() -> RevisionScope {
    RevisionScope {
        document: "web-review".into(),
        epoch: "1".into(),
        schema: "v5".into(),
        module_profile: "task".into(),
        observed_token: [1; 65],
    }
}
fn source(bytes: &[u8]) -> ImmutableRevision {
    ImmutableRevision::capture(
        scope(),
        RevisionInput::ExactSource(bytes),
        RepresentationLimits::default(),
    )
    .unwrap()
}
fn exact(before: &str, after: &str) -> serde_json::Value {
    let p = TextPatch::between(
        &source(before.as_bytes()),
        &source(after.as_bytes()),
        PatchLimits::default(),
    )
    .unwrap();
    assert_eq!(
        p.apply(before.as_bytes(), PatchLimits::default()).unwrap(),
        after.as_bytes()
    );
    json!({"representation":"exact-source", "wire":p.encode(PatchLimits::default()).unwrap()})
}
fn semantic(a: &SemanticSnapshot, b: &SemanticSnapshot) -> serde_json::Value {
    let a = ImmutableRevision::capture(
        scope(),
        RevisionInput::Semantic(a),
        RepresentationLimits::default(),
    )
    .unwrap();
    let b = ImmutableRevision::capture(
        scope(),
        RevisionInput::Semantic(b),
        RepresentationLimits::default(),
    )
    .unwrap();
    json!({"representation":"semantic","model":compare(&a,&b,SemanticLimits::default()).unwrap()})
}
#[test]
fn generate_canonical_browser_review_inputs() {
    let before: SemanticSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/diff/semantic-before.json")).unwrap();
    let format: SemanticSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/diff/semantic-format.json")).unwrap();
    let mut moved: SemanticSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/diff/semantic-move.json")).unwrap();
    moved.visible[0].runs[0].text = "changed beta".into();
    moved.visible[0].runs[0].marks = json!({"link":"https://example.test/new","bold":true});
    moved.visible[0].opaque =
        json!(["unknown-widget",{"revision":2,"html":"<img src=x onerror=alert(1)>"}]);
    moved.retained_structure = json!({"future":"changed"});
    let long = (0..5000)
        .map(|i| format!("line {i} \t🙂\r\n"))
        .collect::<String>();
    let many = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
    let changed = many
        .replace("line 0\n", "changed 0\n")
        .replace("line 39\n", "changed 39\n");
    let huge = format!("{}\n", "<img src=x onerror=alert(1)> ".repeat(3000));
    let mut projected = exact("**alpha**\n", "__alpha__\n");
    projected["representation"] = json!("projected-markdown");
    projected["serializer"] = json!("editac-markdown-v1");
    projected["dialect"] = json!("commonmark");
    let mut large_before = before.clone();
    large_before.visible = (0..1000)
        .map(|i| {
            let mut n = before.visible[0].clone();
            n.id = format!("large-{i}");
            n.order = i;
            n.spans.clear();
            n
        })
        .collect();
    let mut large_after = large_before.clone();
    for n in &mut large_after.visible {
        n.runs[0].marks = json!({"bold":true});
    }
    let output = json!({"source":exact("alpha\r\nbeta", "alpha \r\ngamma"),"delete":exact("alpha\nbeta\n","alpha\n"),"unchanged":exact("alpha\n","alpha\n"),"selection":exact(&many,&changed),"large":exact("",&long),"huge":exact("",&huge),"format":semantic(&before,&format),"semantic":semantic(&before,&moved),"projected":projected,"largeSemantic":semantic(&large_before,&large_after)});
    assert_eq!(
        output["format"]["model"]["changes"][0]["facets"],
        json!(["Formatting"])
    );
    assert!(
        output["semantic"]["model"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["facets"]
                .as_array()
                .unwrap()
                .contains(&json!("Placement")))
    );
    if let Ok(path) = std::env::var("EDITAC_REVIEW_FIXTURE") {
        std::fs::write(path, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
    }
}
