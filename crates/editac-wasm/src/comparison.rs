//! Explicit read-only browser capture/comparison; the existing diff companion owns semantics.
use editac_core::{
    document::Document,
    interchange::{self, Result, err},
};
use editac_diff::{
    representation::*,
    semantic::{self, SemanticLimits},
};
use editac_session::revision::ObservedRevision;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const VERSION: &str = "editac-browser-semantic-capture-v1";
const INPUT_BYTES: usize = 4 * 1024 * 1024;
fn limits() -> RepresentationLimits {
    RepresentationLimits {
        max_bytes: 1024 * 1024,
        max_nodes: 10_000,
        max_depth: 32,
    }
}
fn failure(e: RepresentationError, op: &'static str) -> interchange::Error {
    err(
        if e == RepresentationError::ResourceLimit {
            "ResourceLimit"
        } else {
            "InvalidInput"
        },
        op,
        e.to_string(),
    )
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Capture {
    version: String,
    identity: Value,
    module_profile: String,
    observed_token: Vec<u8>,
    hash: String,
    binding_hash: String,
    payload: String,
}
impl Capture {
    fn binding(&self) -> String {
        ContentHash::of(
            &serde_json::to_vec(&json!([
                "editac-browser-semantic-capture-binding-v1",
                self.version,
                self.identity,
                self.module_profile,
                self.observed_token,
                self.hash,
                self.payload
            ]))
            .expect("capture binding JSON"),
        )
        .hex()
    }
    fn revision(&self, op: &'static str) -> Result<ImmutableRevision> {
        if self.version != VERSION {
            return Err(err("InvalidInput", op, "unsupported semantic capture"));
        }
        if self.binding_hash != self.binding() {
            return Err(err("InvalidInput", op, "semantic capture binding mismatch"));
        }
        let token = ObservedRevision::from_bytes(&self.observed_token)
            .map_err(|_| err("InvalidInput", op, "invalid observed token"))?;
        let scope = RevisionScope {
            document: self.identity["documentId"]
                .as_str()
                .unwrap_or_default()
                .into(),
            epoch: self.identity["epoch"].as_str().unwrap_or_default().into(),
            schema: self.identity["schema"].as_str().unwrap_or_default().into(),
            module_profile: self.module_profile.clone(),
            observed_token: token.to_bytes(),
        };
        if self.payload.len() > limits().max_bytes {
            return Err(failure(RepresentationError::ResourceLimit, op));
        }
        let prefix = format!("{SEMANTIC_ENCODING}\n");
        let payload = self
            .payload
            .strip_prefix(&prefix)
            .ok_or_else(|| err("InvalidInput", op, "invalid semantic encoding"))?;
        let semantic: SemanticSnapshot = serde_json::from_str(payload)
            .map_err(|_| err("InvalidInput", op, "invalid semantic payload"))?;
        let revision =
            ImmutableRevision::capture(scope, RevisionInput::Semantic(&semantic), limits())
                .map_err(|e| failure(e, op))?;
        if revision.hash().hex() != self.hash {
            return Err(err("InvalidInput", op, "semantic capture hash mismatch"));
        }
        Ok(revision)
    }
}
pub(crate) fn capture(doc: &Document, profile: &str) -> Result<Value> {
    const OP: &str = "captureSemantic";
    let observed = ObservedRevision::observe(doc)
        .map_err(|_| err("EngineRejected", OP, "observed revision unavailable"))?;
    let i = doc.identity();
    let scope = RevisionScope {
        document: i.document_id.clone(),
        epoch: i.epoch.clone(),
        schema: i.schema.clone(),
        module_profile: profile.into(),
        observed_token: observed.to_bytes(),
    };
    let projection = doc.snapshot().map_err(|e| interchange::kernel(OP, e))?;
    let revision =
        semantic::capture_projection(scope, &projection, limits()).map_err(|e| failure(e, OP))?;
    let mut comparison = Capture {
        version: VERSION.into(),
        identity: interchange::identity(i),
        module_profile: profile.into(),
        observed_token: observed.to_bytes().to_vec(),
        hash: revision.hash().hex(),
        binding_hash: String::new(),
        payload: String::from_utf8(revision.bytes().to_vec()).expect("canonical UTF-8"),
    };
    comparison.binding_hash = comparison.binding();
    Ok(json!({"snapshot":interchange::projection_snapshot(doc)?, "comparison":comparison}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    before: Capture,
    after: Capture,
}
pub(crate) fn compare(doc: &Document, input: &str) -> Result<Value> {
    const OP: &str = "compareSemantic";
    if input.len() > INPUT_BYTES {
        return Err(err(
            "ResourceLimit",
            OP,
            "comparison request exceeds byte limit",
        ));
    }
    let request: Request = serde_json::from_str(input)
        .map_err(|_| err("InvalidInput", OP, "invalid semantic comparison request"))?;
    let identity = interchange::identity(doc.identity());
    if request.before.identity != identity
        || request.after.identity != identity
        || request.before.module_profile != request.after.module_profile
    {
        return Err(err(
            "InvalidInput",
            OP,
            "incompatible semantic capture scope",
        ));
    }
    let before = request.before.revision(OP)?;
    let after = request.after.revision(OP)?;
    let model = semantic::compare(
        &before,
        &after,
        SemanticLimits {
            input: limits(),
            max_changes: 10_001,
            max_output_bytes: 4 * 1024 * 1024,
        },
    )
    .map_err(|e| failure(e, OP))?;
    serde_json::to_value(model).map_err(|_| err("EngineRejected", OP, "semantic model unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Bridge;
    fn bridge(serial: u32) -> Bridge {
        Bridge::create(&json!({"profile":"v5","documentId":format!("91000000-0000-4000-8000-{serial:012}"),"epoch":format!("92000000-0000-4000-8000-{serial:012}"),"nodes":[{"text":"hello 😀"},{"text":"second"}]}).to_string()).unwrap()
    }
    fn request(a: &Value, b: &Value) -> String {
        json!({"before":a["comparison"],"after":b["comparison"]}).to_string()
    }
    #[test]
    fn actual_captures_compare_text_format_and_reference_without_mutation() {
        let mut b = bridge(1);
        let initial = b.doc_state();
        let before = b.capture_semantic("builtin-v5").unwrap();
        assert_eq!(b.doc_state(), initial);
        let id = before["snapshot"]["visible"][0]["id"].as_str().unwrap();
        for command in [
            json!({"type":"replaceAt","owner":id,"from":0,"to":5,"text":"changed"}),
            json!({"type":"markAt","owner":id,"from":0,"to":7,"mark":"bold","action":"apply"}),
            json!({"type":"markAt","owner":id,"from":0,"to":7,"mark":"link","action":"apply","href":"https://example.test/"}),
        ] {
            let plan = b
                .prepare(
                    &json!({"kind":"editor","origin":"comparison-test","commands":[command]})
                        .to_string(),
                )
                .unwrap();
            b.commit(plan["token"].as_str().unwrap()).unwrap();
        }
        let after = b.capture_semantic("builtin-v5").unwrap();
        let state = b.doc_state();
        let snapshot = b.read().unwrap();
        let pending = b.take_patch();
        let model = b.compare_semantic(&request(&before, &after)).unwrap();
        assert_eq!(model["version"], "editac-semantic-diff-v1");
        assert_eq!(model["attribution"], "unknown");
        let c = model["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap();
        for f in ["Text", "Formatting", "References"] {
            assert!(
                c["facets"].as_array().unwrap().contains(&json!(f)),
                "{model}"
            );
        }
        assert_eq!(b.doc_state(), state);
        assert_eq!(b.read().unwrap(), snapshot);
        assert_eq!(b.take_patch(), Value::Null);
        assert!(!pending.is_null());
        assert_eq!(
            b.compare_semantic(&request(&before, &after)).unwrap(),
            model
        );
        let equal = b.compare_semantic(&request(&after, &after)).unwrap();
        assert_eq!(equal["changes"], json!([]));
        assert_ne!(
            before["comparison"]["observedToken"],
            after["comparison"]["observedToken"]
        );
    }
    #[test]
    fn complete_semantic_fixture_preserves_independent_facets_and_retained_payloads() {
        let b = bridge(2);
        let base = b.capture_semantic("builtin-v5").unwrap();
        let mut left: Capture = serde_json::from_value(base["comparison"].clone()).unwrap();
        let mut semantic: SemanticSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/diff/semantic-before.json"))
                .unwrap();
        let bind = |c: &mut Capture, semantic: &SemanticSnapshot| {
            let scope = RevisionScope {
                document: c.identity["documentId"].as_str().unwrap().into(),
                epoch: c.identity["epoch"].as_str().unwrap().into(),
                schema: c.identity["schema"].as_str().unwrap().into(),
                module_profile: c.module_profile.clone(),
                observed_token: ObservedRevision::from_bytes(&c.observed_token)
                    .unwrap()
                    .to_bytes(),
            };
            let revision =
                ImmutableRevision::capture(scope, RevisionInput::Semantic(semantic), limits())
                    .unwrap();
            c.hash = revision.hash().hex();
            c.payload = String::from_utf8(revision.bytes().to_vec()).unwrap();
            c.binding_hash = c.binding();
        };
        bind(&mut left, &semantic);
        let mut right: Capture =
            serde_json::from_value(serde_json::to_value(&left).unwrap()).unwrap();
        let n = &mut semantic.visible[0];
        n.parent = "moved-parent".into();
        n.order += 1;
        n.runs[0].text.push_str("new");
        n.runs[0].marks = json!({"bold":true,"link":"https://example.test/","future-mark":["opaque",{"nested":true}]});
        n.attributes = json!(["future-module", {"keep":[1,2,3]}]);
        n.opaque = json!({"exact":"tuple"});
        n.editor = json!({"future":"metadata"});
        n.spans[0].identity.push_str("changed");
        semantic.retained_structure = json!({"deleted":{"keep":["opaque",3]}});
        bind(&mut right, &semantic);
        let state = b.doc_state();
        let model = b
            .compare_semantic(&json!({"before":left,"after":right}).to_string())
            .unwrap();
        let change = &model["changes"][0];
        for f in [
            "Placement",
            "Text",
            "Formatting",
            "References",
            "Attributes",
            "UnknownModule",
            "Sources",
        ] {
            assert!(
                change["facets"].as_array().unwrap().contains(&json!(f)),
                "{model}"
            );
        }
        assert_eq!(
            change["after"]["attributes"],
            json!(["future-module",{"keep":[1,2,3]}])
        );
        assert_eq!(
            change["after"]["runs"][0]["marks"]["future-mark"],
            json!(["opaque",{"nested":true}])
        );
        assert_eq!(
            model["retained_structure"][1],
            json!({"deleted":{"keep":["opaque",3]}})
        );
        assert_eq!(b.doc_state(), state);
    }
    #[test]
    fn malformed_hash_scope_token_and_payloads_reject_without_mutation() {
        let b = bridge(3);
        let a = b.capture_semantic("builtin-v5").unwrap();
        let state = b.doc_state();
        for (field, value) in [
            ("version", json!("future")),
            ("hash", json!("0".repeat(64))),
            ("moduleProfile", json!("other")),
            ("identity", json!({})),
            ("observedToken", json!([2])),
            ("payload", json!("invalid")),
        ] {
            let mut bad = a.clone();
            bad["comparison"][field] = value;
            assert!(b.compare_semantic(&request(&a, &bad)).is_err(), "{field}");
            assert_eq!(b.doc_state(), state);
        }
        let mut bad: Capture = serde_json::from_value(a["comparison"].clone()).unwrap();
        bad.hash = "0".repeat(64);
        bad.binding_hash = bad.binding();
        assert!(
            b.compare_semantic(&json!({"before":bad,"after":a["comparison"]}).to_string())
                .unwrap_err()
                .message
                .contains("hash mismatch")
        );
        let mut bad = a.clone();
        bad["comparison"]["moduleProfile"] = json!("rescope-both");
        assert!(
            b.compare_semantic(&request(&bad, &bad))
                .unwrap_err()
                .message
                .contains("binding mismatch")
        );
        assert!(b.compare_semantic("{}").is_err());
        assert!(b.compare_semantic("{not json}").is_err());
        assert_eq!(
            b.compare_semantic(&"x".repeat(INPUT_BYTES + 1))
                .unwrap_err()
                .code,
            "ResourceLimit"
        );
        assert!(b.capture_semantic("").is_err());
        assert!(b.capture_semantic(&"x".repeat(257)).is_err());
        assert_eq!(b.doc_state(), state);
    }
    #[test]
    fn other_engine_identity_rejects_and_oversize_capture_is_readonly() {
        let b = bridge(4);
        let other = bridge(5);
        let a = b.capture_semantic("builtin-v5").unwrap();
        let c = other.capture_semantic("builtin-v5").unwrap();
        let state = b.doc_state();
        assert!(b.compare_semantic(&request(&a, &c)).is_err());
        assert_eq!(b.doc_state(), state);
        let big=Bridge::create(&json!({"profile":"v5","documentId":"93000000-0000-4000-8000-000000000001","epoch":"94000000-0000-4000-8000-000000000001","nodes":[{"text":"x".repeat(262144)},{"text":"x".repeat(262144)},{"text":"x".repeat(262144)},{"text":"x".repeat(262144)}]}).to_string()).unwrap();
        let state = big.doc_state();
        assert_eq!(
            big.capture_semantic("builtin-v5").unwrap_err().code,
            "ResourceLimit"
        );
        assert_eq!(big.doc_state(), state);
    }
}
