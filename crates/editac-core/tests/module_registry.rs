//! MOD-1.2 shared data-only corpus and genuine retained Yrs text fixture.
use editac_core::{
    document::{Document, DocumentIdentity, InitializedCheckpoint},
    modules::registry::{ModuleKind, Registry, RegistryError},
};
use yrs::{Any, Text, Transact};
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
fn corpus() -> Any {
    Any::from_json(include_str!("../../../fixtures/modules/registration.json")).unwrap()
}
fn get<'a>(v: &'a Any, k: &str) -> &'a Any {
    let Any::Map(m) = v else { panic!() };
    &m[k]
}
fn array(v: &Any) -> &[Any] {
    let Any::Array(a) = v else { panic!() };
    a
}
fn text(v: &Any) -> &str {
    let Any::String(s) = v else { panic!() };
    s
}
fn registered() -> Registry {
    let c = corpus();
    let mut r = Registry::default();
    for d in array(get(&c, "definitions")) {
        r.register(d).unwrap();
    }
    r
}
#[test]
fn duplicate_and_incompatible_definitions_reject_atomically() {
    let c = corpus();
    let d = &array(get(&c, "definitions"))[0];
    let mut r = registered();
    assert_eq!(r.register(d), Err(RegistryError::Duplicate));
    let mut other = d.clone();
    let Any::Map(ref mut values) = other else {
        panic!()
    };
    std::sync::Arc::make_mut(values).insert("version".into(), Any::Number(2.0.into()));
    assert_eq!(r.register(&other), Err(RegistryError::Incompatible));
    let mut changed = d.clone();
    let Any::Map(ref mut values) = changed else {
        panic!()
    };
    std::sync::Arc::make_mut(values).insert("kind".into(), Any::String("inline-atom".into()));
    assert_eq!(r.register(&changed), Err(RegistryError::Incompatible));
    assert_eq!(r.freeze().len(), 2);
}
#[test]
fn shared_invalid_definitions_fail_before_registration() {
    let c = corpus();
    let mut r = registered();
    assert_eq!(array(get(&c, "invalidDefinitions")).len(), 15);
    for case in array(get(&c, "invalidDefinitions")) {
        assert_eq!(
            r.register(get(case, "definition")),
            Err(RegistryError::InvalidDefinition),
            "{}",
            text(get(case, "name"))
        );
    }
    assert_eq!(r.freeze().len(), 2);
}
#[test]
fn frozen_registry_accepts_custom_marks_atoms_and_opaque_future_data() {
    let c = corpus();
    let r = registered().freeze();
    for (i, run) in array(get(&c, "runs")).iter().enumerate() {
        let Any::Map(attrs) = get(run, "attributes") else {
            panic!()
        };
        for (key, value) in attrs.iter() {
            let d = r.resolve(key, value, text(get(run, "text"))).unwrap();
            if i < 2 {
                assert_eq!(
                    d.unwrap().kind,
                    if i == 0 {
                        ModuleKind::Mark
                    } else {
                        ModuleKind::InlineAtom
                    }
                );
            } else {
                assert!(d.is_none());
            }
        }
    }
}
#[test]
fn known_invalid_content_is_rejected_without_mutation() {
    let c = corpus();
    let r = registered().freeze();
    assert_eq!(array(get(&c, "invalidRuns")).len(), 8);
    for run in array(get(&c, "invalidRuns")) {
        let Any::Map(attrs) = get(run, "attributes") else {
            panic!()
        };
        let original = run.clone();
        for (key, value) in attrs.iter() {
            assert!(r.resolve(key, value, text(get(run, "text"))).is_err());
        }
        assert_eq!(run, &original);
    }
}
#[test]
fn shared_custom_runs_retain_identity_attributes_and_checkpoint() {
    let c = corpus();
    let x = m::seed();
    let t = m::text(&x, "n:11:1");
    {
        let mut tx = x.transact_mut();
        let len = t.len(&tx);
        t.remove_range(&mut tx, 0, len);
        let mut offset = 0;
        for run in array(get(&c, "runs")) {
            let s = text(get(run, "text"));
            let Any::Map(attrs) = get(run, "attributes") else {
                panic!()
            };
            t.insert_with_attributes(
                &mut tx,
                offset,
                s,
                attrs
                    .iter()
                    .map(|(k, v)| (k.clone().into(), v.clone()))
                    .collect(),
            );
            offset += s.encode_utf16().count() as u32;
        }
    }
    let identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let checkpoint = InitializedCheckpoint {
        identity: identity.clone(),
        initialized: true,
        writer_id: 11,
        bytes: m::bytes(&x),
    };
    let d = Document::restore(&identity, &checkpoint, &[]).unwrap();
    let snapshot = d.snapshot().unwrap();
    let node = snapshot.visible.iter().find(|n| n.id == "n:11:1").unwrap();
    assert_eq!(node.runs.len(), 4);
    let r = registered().freeze();
    for (actual, expected) in node.runs.iter().zip(array(get(&c, "runs"))) {
        assert_eq!(actual.text, text(get(expected, "text")));
        let Any::Map(attrs) = get(expected, "attributes") else {
            panic!()
        };
        assert_eq!(
            actual.attributes,
            attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        );
        r.validate_run(&actual.text, &actual.attributes).unwrap();
    }
    let restored = Document::restore(&identity, &d.checkpoint(), &[]).unwrap();
    assert_eq!(restored.snapshot().unwrap().visible, snapshot.visible);
    if let Ok(path) = std::env::var("EDITAC_MODULE_REGISTRY_FIXTURES") {
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            format!("{path}/custom-checkpoint.bin"),
            d.checkpoint().bytes,
        )
        .unwrap();
        std::fs::write(format!("{path}/identity.json"),r#"{"offsets":"utf16","protocolVersion":1,"documentId":"77777777-7777-4777-8777-777777777777","epoch":"88888888-8888-4888-8888-888888888888","profile":"editac.yrs-yjs.editor.v5","updateEncoding":1,"schema":"editac.registry.editor.v5"}"#).unwrap();
        let invalid = &array(get(&c, "invalidRuns"))[1];
        let Any::Map(attrs) = get(invalid, "attributes") else {
            panic!()
        };
        t.format(
            &mut x.transact_mut(),
            0,
            1,
            attrs
                .iter()
                .map(|(k, v)| (k.clone().into(), v.clone()))
                .collect(),
        );
        std::fs::write(format!("{path}/invalid-checkpoint.bin"), m::bytes(&x)).unwrap();
    }
}
