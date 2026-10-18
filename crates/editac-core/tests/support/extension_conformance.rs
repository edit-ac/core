//! Shared descriptor + fixed-fixture harness, reusing the qualified registry.
use editac_core::modules::v1::{Registry, RegistryError};
use serde_json::{Value, json};
use yrs::Any;

/// Optional host services use their owning extension admission, not stored modules.
/// Shared fixed corpus is also consumed through the public TypeScript entry point.
#[allow(dead_code)]
pub fn assistive_fixture(case: &Value) -> bool {
    use editac_core::extensions::assistive_input::*;
    let mut registration = Registration::default();
    if !case["descriptor"].is_null() {
        let Ok(d) = serde_json::from_value::<Descriptor>(case["descriptor"].clone()) else {
            return false;
        };
        if registration.register(d).is_err() {
            return false;
        }
    }
    if case["dispose"] == true {
        registration.dispose();
    }
    match case["operation"].as_str().unwrap() {
        "register" => true,
        "status" => serde_json::from_value::<PresenterStatus>(case["value"].clone())
            .is_ok_and(|s| registration.validate_status(&s).is_ok()),
        "commands" => serde_json::from_value::<Vec<CommandApplicability>>(case["value"].clone())
            .is_ok_and(|c| registration.validate_commands(&c).is_ok()),
        "result" => serde_json::from_value::<ResultEnvelope>(case["value"].clone())
            .is_ok_and(|r| registration.validate_result(&r).is_ok()),
        "start" => serde_json::from_value::<StartRequest>(case["value"].clone())
            .is_ok_and(|r| registration.validate_start(&r).is_ok()),
        _ => panic!("unknown assistive conformance operation"),
    }
}

pub fn any(value: &Value) -> Any {
    Any::from_json(&serde_json::to_string(value).unwrap()).unwrap()
}
pub fn fixture_result(definitions: &[Value], case: &Value) -> Value {
    let mut registry = Registry::default();
    let mut result = json!({"id":case["id"],"outcome":"registered"});
    let admitted = match case["category"].as_str().unwrap() {
        "descriptor" => registry.register(&any(&case["definition"])),
        "run" => {
            let run = &case["run"];
            result["payload"] = run["attributes"].clone();
            result["fallback"] = run["text"].clone();
            if case["disabled"] != true {
                for d in definitions {
                    registry.register(&any(d)).unwrap();
                }
            }
            let registry = registry.freeze();
            result["outcome"] = json!("opaque");
            let mut status = Ok(());
            for (key, value) in run["attributes"].as_object().unwrap() {
                match registry.resolve(key, &any(value), run["text"].as_str().unwrap()) {
                    Ok(Some(_)) => result["outcome"] = json!("known"),
                    Ok(None) => (),
                    Err(e) => {
                        status = Err(e);
                        break;
                    }
                }
            }
            status
        }
        "block" => {
            result["outcome"] = json!("preserved");
            result["payload"] = case["blockAttributes"].clone();
            result["fallback"] = case["text"].clone();
            Ok(())
        }
        _ => panic!("unknown fixture category"),
    };
    if let Err(e) = admitted {
        result["outcome"] = json!(match e {
            RegistryError::InvalidDefinition => "invalid-definition",
            RegistryError::InvalidContent => "invalid-content",
            RegistryError::ResourceLimit => "resource-limit",
            RegistryError::Duplicate => "duplicate",
            RegistryError::Incompatible => "incompatible",
        });
    }
    result
}
