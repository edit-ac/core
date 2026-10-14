//! RGS-1.5 supported-profile production Markdown round trips.
use editac_markdown::{FragmentBlock, export::export, import::import};
use serde_json::{Value, json};
fn semantic(blocks: &[FragmentBlock]) -> Value {
    json!(blocks.iter().map(|b|json!({"attributes":format!("{:?}",b.attributes),"checked":b.checked,"containers":b.containers.iter().map(|(_,s)|format!("{s:?}")).collect::<Vec<_>>(),"runs":b.runs.iter().map(|r|json!([r.text,format!("{:?}",r.marks)])).collect::<Vec<_>>()})).collect::<Vec<_>>())
}
#[test]
fn seeded_supported_profile_export_import_and_fixed_point() {
    let profile: Value = serde_json::from_str(include_str!(
        "../../../fixtures/editing-failures/property-profile.json"
    ))
    .unwrap();
    let mut samples = 0;
    let mut max = 0;
    for seed in profile["seeds"].as_array().unwrap() {
        let vector = profile["vectors"][(seed.as_u64().unwrap() as usize) % 9]
            .as_str()
            .unwrap();
        for source in [
            format!("# Heading x{vector}y\n\n**bold** x{vector}y\n"),
            format!("```rust\n  {vector}\t \n```\n"),
            format!("- first x{vector}y\n- second\n"),
            format!("[link](https://example.com) x{vector}y\n"),
        ] {
            max = max.max(source.len());
            let a = import(&source).unwrap();
            assert_eq!(a.source, source);
            assert!(a.diagnostics.is_empty());
            let first = export(&a.blocks);
            assert!(first.diagnostics.is_empty());
            let b = import(&first.markdown).unwrap();
            assert_eq!(semantic(&a.blocks), semantic(&b.blocks));
            let second = export(&b.blocks);
            assert_eq!(first.markdown, second.markdown);
            assert!(second.diagnostics.is_empty());
            assert!(
                a.blocks
                    .iter()
                    .flat_map(|b| &b.runs)
                    .any(|r| r.text.contains(vector)),
                "independent retained Unicode"
            );
            samples += 1;
        }
    }
    println!(
        "RGS_PROPERTY {}",
        json!({"case":"supported-Markdown-v1-roundtrip-fixed-point","samples":samples,"maxInputBytes":max,"passed":true})
    );
}
