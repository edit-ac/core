//! Transaction codec for the existing per-document AssetWork owner. The browser
//! persists the returned journal atomically; this bridge owns no second journal.
use editac_core::{
    document::DocumentIdentity,
    interchange::{Error, err},
    modules::assets::{AssetAction, AssetCommitReceipt, AssetGrant, AssetIdentity, AssetRequest},
};
use editac_session::{
    assets::{AssetJournal, AssetStore, AssetWork, HostOutcome},
    ports::{StoreLimits, memory::MemoryStore},
};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    identity: AssetIdentity,
    actions: Vec<AssetAction>,
}
impl From<Grant> for AssetGrant {
    fn from(g: Grant) -> Self {
        Self {
            identity: g.identity,
            actions: g.actions,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Inspect,
    Validate { request: AssetRequest, grant: Grant },
    Enqueue {
        reference: String,
        request: AssetRequest,
        grant: Grant,
    },
    Retire {
        reference: String,
        identity: AssetIdentity,
        prefix: String,
    },
    Begin {
        operation: String,
        online: bool,
        grant: Grant,
    },
    Complete {
        operation: String,
        receipt: Option<AssetCommitReceipt>,
        grant: Grant,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    journal: Option<String>,
    action: Action,
}
pub(crate) fn transaction(identity: &DocumentIdentity, input: &str) -> Result<Value, Error> {
    let fail = |e| err("InvalidInput", "assetWork", format!("{e:?}"));
    if input.len() > 2 * 1024 * 1024 {
        return Err(err("ResourceLimit", "assetWork", "asset input limit"));
    }
    let scope = json!([
        identity.profile,
        identity.schema,
        identity.protocol_version,
        identity.update_encoding,
        identity.offsets,
        identity.document_id,
        identity.epoch
    ])
    .to_string();
    let input: Input =
        serde_json::from_str(input).map_err(|e| err("InvalidInput", "assetWork", e.to_string()))?;
    let store = MemoryStore::new(identity.clone(), StoreLimits::default()).map_err(fail)?;
    if let Some(raw) = input.journal {
        let (stored_scope, journal): (String, AssetJournal) = serde_json::from_str(&raw)
            .map_err(|e| err("InvalidInput", "assetWork", e.to_string()))?;
        if stored_scope != scope {
            return Err(err("InvalidInput", "assetWork", "journal scope mismatch"));
        }
        store
            .update_assets(|current| {
                *current = journal;
                Ok(())
            })
            .map_err(fail)?;
    }
    let work = AssetWork::new(&store);
    let result = match input.action {
        Action::Inspect => json!(null),
        Action::Validate { request, grant } => { request.validate(&grant.into()).map_err(|e| err("InvalidInput", "assetWork", format!("{e:?}")))?; json!(null) },
        Action::Enqueue {
            reference,
            request,
            grant,
        } => {
            let r = work
                .enqueue(&reference, request, &grant.into())
                .map_err(fail)?;
            json!({"operationId":r.operation_id})
        }
        Action::Retire {
            reference,
            identity,
            prefix,
        } => {
            work.retire(&reference, &identity, &prefix).map_err(fail)?;
            json!(null)
        }
        Action::Begin {
            operation,
            online,
            grant,
        } => {
            let g = grant.into();
            json!(
                work.begin_dispatch(&operation, online, |_| Ok(g))
                    .map_err(fail)?
            )
        }
        Action::Complete {
            operation,
            receipt,
            grant,
        } => {
            work.complete(
                &operation,
                receipt.map_or(HostOutcome::Complete, HostOutcome::Published),
                &grant.into(),
            )
            .map_err(fail)?;
            json!(null)
        }
    };
    let journal = store.asset_journal().map_err(fail)?;
    let raw = serde_json::to_string(&(scope, &journal))
        .map_err(|e| err("InvalidInput", "assetWork", e.to_string()))?;
    Ok(json!({"journal":raw,"intents":journal.intents(),"result":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> DocumentIdentity {
        DocumentIdentity::v5(
            "45678901-4567-4567-8567-45678901abcd",
            "56789012-5678-4678-8678-56789012abcd",
        )
        .unwrap()
    }
    fn asset() -> Value {
        json!({"host":"fixture","key":"retained"})
    }
    fn grant() -> Value {
        json!({"identity":asset(),"actions":["ingest","publish","read","cancel","release-reference"]})
    }
    fn request(operation: &str, action: &str) -> Value {
        json!({"version":1,"operationId":operation,"identity":asset(),"action":action,"byteLimit":32})
    }
    fn call(journal: Option<&str>, action: Value) -> Value {
        transaction(
            &identity(),
            &json!({"journal":journal,"action":action}).to_string(),
        )
        .unwrap()
    }
    fn enqueue(operation: &str, action: &str) -> Value {
        json!({"type":"enqueue","reference":"n-1-2","request":request(operation,action),"grant":grant()})
    }
    #[test]
    fn asset_codec_idempotent_operation_receipts_and_scoped_recovery() {
        let a = call(None, enqueue("ingest_1", "ingest"));
        let j = a["journal"].as_str().unwrap();
        let b = call(Some(j), enqueue("ingest_1", "ingest"));
        assert_eq!(a, b);
        assert_eq!(a["result"], json!({"operationId":"ingest_1"}));
        let c = call(Some(j), json!({"type":"inspect"}));
        assert_eq!(c["intents"], a["intents"]);
        let other = DocumentIdentity::v5(
            "45678901-4567-4567-8567-45678901abce",
            "56789012-5678-4678-8678-56789012abcd",
        )
        .unwrap();
        assert!(
            transaction(
                &other,
                &json!({"journal":j,"action":{"type":"inspect"}}).to_string()
            )
            .is_err()
        );
    }
    #[test]
    fn asset_codec_attempt_offline_denied_and_complete() {
        let a = call(None, enqueue("ingest_1", "ingest"));
        let j = a["journal"].as_str().unwrap();
        for (online, g) in [
            (false, grant()),
            (true, json!({"identity":asset(),"actions":[]})),
        ] {
            assert!(transaction(&identity(),&json!({"journal":j,"action":{"type":"begin","operation":"ingest_1","online":online,"grant":g}}).to_string()).is_err());
        }
        let b = call(
            Some(j),
            json!({"type":"begin","operation":"ingest_1","online":true,"grant":grant()}),
        );
        assert_eq!(b["result"]["attempts"], 1);
        let c = call(
            b["journal"].as_str(),
            json!({"type":"complete","operation":"ingest_1","receipt":null,"grant":grant()}),
        );
        assert_eq!(c["intents"][0]["status"], "Complete");
        let d = call(
            c["journal"].as_str(),
            json!({"type":"begin","operation":"ingest_1","online":true,"grant":grant()}),
        );
        assert!(d["result"].is_null());
    }
    #[test]
    fn asset_codec_retirement_fences_late_publication_and_cleanup_order() {
        let a = call(None, enqueue("publish_1", "publish"));
        let b = call(
            a["journal"].as_str(),
            json!({"type":"retire","reference":"n-1-2","identity":asset(),"prefix":"retire_1"}),
        );
        let c = call(
            b["journal"].as_str(),
            json!({"type":"complete","operation":"publish_1","receipt":{"operationId":"publish_1","identity":asset()},"grant":grant()}),
        );
        assert_eq!(c["intents"][0]["status"], "Canceled");
        let release =
            json!({"type":"begin","operation":"retire_1_release","online":true,"grant":grant()});
        assert!(
            transaction(
                &identity(),
                &json!({"journal":c["journal"],"action":release}).to_string()
            )
            .is_err()
        );
        let d = call(
            c["journal"].as_str(),
            json!({"type":"complete","operation":"retire_1_cancel","receipt":null,"grant":grant()}),
        );
        assert!(call(d["journal"].as_str(), release)["result"].is_object());
        assert!(
            transaction(
                &identity(),
                &json!({"journal":d["journal"],"action":enqueue("again","ingest")}).to_string()
            )
            .is_err()
        );
    }
    #[test]
    fn asset_codec_invalid_journal_and_unsupported_action_reject() {
        assert!(
            transaction(
                &identity(),
                &json!({"journal":"[]","action":{"type":"inspect"}}).to_string()
            )
            .is_err()
        );
        assert!(
            transaction(
                &identity(),
                &json!({"journal":null,"action":enqueue("resolve","resolve-url")}).to_string()
            )
            .is_err()
        );
    }
}
