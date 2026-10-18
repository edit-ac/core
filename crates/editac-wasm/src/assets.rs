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
    FenceJob {
        job: String,
    },
    Validate {
        request: AssetRequest,
        grant: Grant,
    },
    StageOriginal {
        job: String,
        reference: String,
        request: AssetRequest,
        grant: Grant,
        bytes: Vec<u8>,
    },
    PreparedSource {
        job: String,
        reference: String,
        grant: Grant,
    },
    IngestSource {
        reference: String,
        grant: Grant,
    },
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
    let mut result = match input.action {
        Action::Inspect => json!(null),
        Action::FenceJob { job } => {
            work.fence_job(&job).map_err(fail)?;
            json!(null)
        }
        Action::Validate { request, grant } => {
            request
                .validate(&grant.into())
                .map_err(|e| err("InvalidInput", "assetWork", format!("{e:?}")))?;
            json!(null)
        }
        Action::StageOriginal {
            job,
            reference,
            request,
            grant,
            bytes,
        } => {
            let r = work
                .stage_original(&job, &reference, request, &grant.into(), &bytes)
                .map_err(fail)?;
            json!({"operationId":r.operation_id})
        }
        Action::PreparedSource {
            job,
            reference,
            grant,
        } => {
            json!(
                work.prepared_source(&job, &reference, &grant.into())
                    .map_err(fail)?
            )
        }
        Action::IngestSource { reference, grant } => {
            let journal = store.asset_journal().map_err(fail)?;
            let original = journal
                .prepared()
                .iter()
                .find(|p| p.reference == reference)
                .ok_or_else(|| err("InvalidInput", "assetWork", "prepared source missing"))?;
            if !journal.is_prepared(&reference) {
                return Err(err("EngineRejected", "assetWork", "prepared source fenced"));
            }
            original
                .request
                .validate(&grant.into())
                .map_err(|e| err("InvalidInput", "assetWork", format!("{e:?}")))?;
            json!(original.bytes)
        }
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
    if let Some(reference) = result
        .get("reference")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        result["hostReference"] = json!(journal.host_reference(&reference));
    }
    let intents: Vec<_> = journal
        .intents()
        .iter()
        .map(|intent| {
            let mut value = json!(intent);
            value["hostReference"] = json!(journal.host_reference(&intent.reference));
            value
        })
        .collect();
    let raw = serde_json::to_string(&(scope, &journal))
        .map_err(|e| err("InvalidInput", "assetWork", e.to_string()))?;
    let prepared: Vec<_> = journal
        .prepared()
        .iter()
        .map(|p| {
            json!({
                "job":p.job,"reference":p.reference,"request":p.request,
                "grantActions":p.grant_actions,"byteLength":p.bytes.len(),"adoptedReference":p.adopted_reference,
                "active":journal.is_prepared(&p.reference)
            })
        })
        .collect();
    Ok(
        json!({"journal":raw,"intents":intents,"prepared":prepared,"fencedJobs":journal.fenced_jobs(),"result":result}),
    )
}

pub(crate) fn adoption(
    identity: &DocumentIdentity,
    raw: &str,
    job: &str,
    references: &[String],
    targets: &[(String, AssetIdentity)],
) -> Result<String, Error> {
    use editac_session::assets::{PreparedAssetBinding, WorkStatus};
    // Reuse the existing scope, bounds and integrity admission before transfer.
    transaction(
        identity,
        &json!({"journal":raw,"action":{"type":"inspect"}}).to_string(),
    )?;
    let (scope, journal): (String, AssetJournal) = serde_json::from_str(raw)
        .map_err(|e| err("InvalidInput", "prepareAssetCommit", e.to_string()))?;
    if references.len() != targets.len() || references.is_empty() {
        return Err(err(
            "EngineRejected",
            "prepareAssetCommit",
            "exact new asset references required",
        ));
    }
    let bindings = references
        .iter()
        .zip(targets)
        .map(|(reference, (target, identity))| {
            if !journal.intents().iter().any(|i| {
                i.reference == *reference
                    && i.request.action == AssetAction::Ingest
                    && i.status == WorkStatus::Complete
            }) {
                return Err(err(
                    "EngineRejected",
                    "prepareAssetCommit",
                    "original ingest must complete before insertion",
                ));
            }
            Ok(PreparedAssetBinding {
                reference: reference.clone(),
                target: target.clone(),
                identity: identity.clone(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let candidate = journal
        .prepare_adoption(job, &bindings)
        .map_err(|e| err("EngineRejected", "prepareAssetCommit", format!("{e:?}")))?;
    let raw = serde_json::to_string(&(scope, candidate))
        .map_err(|e| err("InvalidInput", "prepareAssetCommit", e.to_string()))?;
    // A successful transfer must remain readable through the bounded codec.
    transaction(
        identity,
        &json!({"journal":raw,"action":{"type":"inspect"}}).to_string(),
    )?;
    Ok(raw)
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
    fn stage() -> Value {
        json!({"type":"stageOriginal","job":"import_a","reference":"prepared_a","request":request("stage_a","ingest"),"grant":grant(),"bytes":[0,255,13,10,128,42]})
    }
    #[test]
    fn prepared_job_codec_fence_survives_roundtrip_and_blocks_empty_job_late_stage() {
        let empty = call(None, json!({"type":"fenceJob","job":"import_a"}));
        assert_eq!(empty["fencedJobs"], json!(["import_a"]));
        assert!(
            transaction(
                &identity(),
                &json!({"journal":empty["journal"],"action":stage()}).to_string()
            )
            .is_err()
        );
        let staged = call(None, stage());
        let fenced = call(
            staged["journal"].as_str(),
            json!({"type":"fenceJob","job":"import_a"}),
        );
        assert_eq!(fenced["prepared"][0]["active"], false);
        assert_eq!(fenced["intents"][0]["status"], "Canceled");
        assert_eq!(fenced["intents"].as_array().unwrap().len(), 3);
        let recovered = call(fenced["journal"].as_str(), json!({"type":"inspect"}));
        assert_eq!(recovered["fencedJobs"], json!(["import_a"]));
        assert_eq!(
            call(
                fenced["journal"].as_str(),
                json!({"type":"fenceJob","job":"import_a"})
            ),
            fenced
        );
        let source = call(
            fenced["journal"].as_str(),
            json!({"type":"preparedSource","job":"import_a","reference":"prepared_a","grant":grant()}),
        );
        assert_eq!(source["result"], json!([0, 255, 13, 10, 128, 42]));
    }
    #[test]
    fn prepared_original_codec_roundtrip_ownership_and_fresh_read_authority() {
        let staged = call(None, stage());
        let raw = staged["journal"].as_str().unwrap();
        assert_eq!(staged["result"], json!({"operationId":"stage_a"}));
        assert_eq!(staged["prepared"][0]["active"], true);
        assert_eq!(staged["prepared"][0]["byteLength"], 6);
        assert_eq!(staged["prepared"][0]["request"]["identity"], asset());
        assert_eq!(staged["prepared"][0]["grantActions"], grant()["actions"]);
        assert!(staged["prepared"][0].get("bytes").is_none());
        assert_eq!(call(Some(raw), stage()), staged);
        let read = json!({"type":"preparedSource","job":"import_a","reference":"prepared_a","grant":grant()});
        assert_eq!(
            call(Some(raw), read.clone())["result"],
            json!([0, 255, 13, 10, 128, 42])
        );
        let mut denied = read;
        denied["grant"]["actions"] = json!(["ingest"]);
        assert!(
            transaction(
                &identity(),
                &json!({"journal":raw,"action":denied}).to_string()
            )
            .is_err()
        );
        let retired = call(
            Some(raw),
            json!({"type":"retire","reference":"prepared_a","identity":asset(),"prefix":"cleanup_a"}),
        );
        assert_eq!(retired["prepared"][0]["active"], false);
        let raw = retired["journal"].as_str().unwrap();
        assert!(
            transaction(
                &identity(),
                &json!({"journal":raw,"action":stage()}).to_string()
            )
            .is_err()
        );
    }
    #[test]
    fn prepared_original_codec_denial_conflict_and_old_journal_compatibility() {
        let live = call(None, enqueue("live_a", "ingest"));
        assert!(live["prepared"].as_array().unwrap().is_empty());
        let mut claim = stage();
        claim["reference"] = json!("n-1-2");
        assert!(
            transaction(
                &identity(),
                &json!({"journal":live["journal"],"action":claim}).to_string()
            )
            .is_err()
        );
        let staged = call(Some(live["journal"].as_str().unwrap()), stage());
        for (field, value) in [
            ("bytes", json!([4, 3, 2, 1])),
            ("job", json!("import_b")),
            ("grant", json!({"identity":asset(),"actions":[]})),
        ] {
            let mut invalid = stage();
            invalid[field] = value;
            assert!(
                transaction(
                    &identity(),
                    &json!({"journal":staged["journal"],"action":invalid}).to_string()
                )
                .is_err()
            );
        }
        let recovered = call(
            Some(staged["journal"].as_str().unwrap()),
            json!({"type":"inspect"}),
        );
        assert_eq!(recovered["intents"], staged["intents"]);
        let mut legacy: Value = serde_json::from_str(live["journal"].as_str().unwrap()).unwrap();
        legacy[1].as_object_mut().unwrap().remove("prepared");
        assert!(
            call(Some(&legacy.to_string()), json!({"type":"inspect"}))["prepared"]
                .as_array()
                .unwrap()
                .is_empty()
        );
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
