use editac_core::modules::content::{Content, ContentError};
use yrs::Any;
#[test]
fn reference_tuple_round_trip_keeps_opaque_identity_and_label() {
    let value = Content::Reference {
        target_id: "host:unknown/😀".into(),
        label: "Unresolved <label> 😀".into(),
    };
    let tuple = value.tuple().unwrap();
    match Content::from_tuple(&tuple).unwrap().unwrap() {
        Content::Reference { target_id, label } => {
            assert_eq!(target_id, "host:unknown/😀");
            assert_eq!(label, "Unresolved <label> 😀");
        }
        _ => panic!("wrong descriptor"),
    }
}
#[test]
fn invalid_reference_bounds_fields_and_versions_reject() {
    for (target_id, label) in [
        ("".to_string(), "x".to_string()),
        ("id".into(), "😀".repeat(257)),
        ("id\n".into(), "x".into()),
        ("id".into(), "x\n".into()),
    ] {
        assert!(Content::Reference { target_id, label }.tuple().is_err());
    }
    for (json, error) in [
        (
            r#"["module:editac.reference",2,{"targetId":"id","label":"x"}]"#,
            ContentError::UnsupportedVersion,
        ),
        (
            r#"["module:editac.reference",1,{"targetId":"id","label":"x","execute":"code"}]"#,
            ContentError::InvalidShape,
        ),
        (
            r#"["module:editac.reference",1,{"targetId":true,"label":"x"}]"#,
            ContentError::InvalidShape,
        ),
    ] {
        assert_eq!(
            Content::from_tuple(&Any::from_json(json).unwrap()).unwrap_err(),
            error
        );
    }
    assert!(
        Content::Reference {
            target_id: "😀".repeat(256),
            label: "😀".repeat(256)
        }
        .tuple()
        .is_ok()
    );
}
