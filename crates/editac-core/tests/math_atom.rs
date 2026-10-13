//! MOD-1.8 portable inline atoms use the unchanged frozen module registry.
use editac_core::{
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::registry::{Registry, RegistryError},
};
use yrs::{Any, Text, Transact};
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
fn corpus() -> Any {
    Any::from_json(include_str!("../../../fixtures/modules/math.json")).unwrap()
}
fn get<'a>(v: &'a Any, key: &str) -> &'a Any {
    let Any::Map(map) = v else { panic!() };
    &map[key]
}
fn string(v: &Any) -> &str {
    let Any::String(s) = v else { panic!() };
    s
}
fn registry() -> editac_core::modules::registry::FrozenRegistry {
    let mut r = Registry::default();
    r.register(get(&corpus(), "definition")).unwrap();
    r.freeze()
}
#[test]
fn bounded_utf16_source_and_attributes_reject_before_use() {
    let r = registry();
    for (latex, display, valid) in [
        ("😀".repeat(2048), Any::Bool(false), true),
        ("😀".repeat(2049), Any::Bool(false), false),
        ("x".into(), Any::String("false".into()), false),
    ] {
        let value = m::arr(vec![
            Any::Number(1.0.into()),
            m::obj(vec![
                ("latex", Any::String(latex.clone().into())),
                ("display", display),
            ]),
        ]);
        let result = r.resolve(
            "module:editac.math",
            &value,
            &format!("LaTeX source: {latex}"),
        );
        if valid {
            assert!(result.unwrap().is_some());
        } else {
            assert_eq!(result, Err(RegistryError::InvalidContent));
        }
    }
}
#[test]
fn math_sources_survive_real_yrs_storage_without_renderer_semantics() {
    let c = corpus();
    let Any::Array(cases) = get(&c, "cases") else {
        panic!()
    };
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let r = registry();
    for case in cases.iter() {
        let latex = string(get(case, "latex"));
        let text = format!("LaTeX source: {latex}");
        let envelope = m::arr(vec![
            Any::Number(1.0.into()),
            m::obj(vec![
                ("latex", Any::String(latex.into())),
                ("display", get(case, "display").clone()),
            ]),
        ]);
        assert!(
            r.resolve("module:editac.math", &envelope, &text)
                .unwrap()
                .is_some()
        );
        let x = m::seed();
        let t = m::text(&x, "n:11:1");
        {
            let mut tx = x.transact_mut();
            let len = t.len(&tx);
            t.remove_range(&mut tx, 0, len);
            t.insert_with_attributes(
                &mut tx,
                0,
                &text,
                [("module:editac.math".into(), envelope.clone())].into(),
            );
        }
        let checkpoint = InitializedCheckpoint {
            identity: identity.clone(),
            initialized: true,
            writer_id: 11,
            bytes: m::bytes(&x),
        };
        let d = Document::restore(&identity, &checkpoint, &[]).unwrap();
        let snapshot = d.snapshot().unwrap();
        let node = snapshot.visible.iter().find(|n| n.id == "n:11:1").unwrap();
        assert_eq!(node.runs[0].text, text);
        assert_eq!(node.runs[0].attributes["module:editac.math"], envelope);
        r.validate_run(&node.runs[0].text, &node.runs[0].attributes)
            .unwrap();
        let restored = Document::restore(&identity, &d.checkpoint(), &[]).unwrap();
        assert_eq!(restored.snapshot().unwrap().visible, snapshot.visible);
        if let Ok(path) = std::env::var("EDITAC_MATH_FIXTURES") {
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(
                format!("{path}/{}.bin", string(get(case, "name"))),
                d.checkpoint().bytes,
            )
            .unwrap();
        }
    }
}
