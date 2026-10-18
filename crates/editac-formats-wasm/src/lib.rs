//! Optional worker transport. Shared Session/jobs own all semantics.
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    document::{DocumentIdentity, InitializedCheckpoint},
    interchange::{identity, transfer_value},
};
use editac_formats::{Direction, LIMITS, Profile, job::*, rtf, table_text};
use editac_session::{
    edit_service::HostPolicy,
    ports::{CheckpointRecord, LocalStore, StoreLimits, memory::MemoryStore},
    session::CachedPermission,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
const MEMORY: usize = 64 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Identity {
    profile: String,
    schema: String,
    protocol_version: u32,
    update_encoding: u32,
    offsets: String,
    document_id: String,
    epoch: String,
}
impl Identity {
    fn admit(&self) -> Result<DocumentIdentity, Value> {
        let i = DocumentIdentity::v5(&self.document_id, &self.epoch)
            .map_err(|_| error("InvalidIdentity"))?;
        if self.profile != i.profile
            || self.schema != i.schema
            || self.protocol_version != i.protocol_version
            || self.update_encoding != i.update_encoding
            || self.offsets != i.offsets
        {
            return Err(error("InvalidIdentity"));
        }
        Ok(i)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    direction: String,
    format: String,
    identity: Identity,
    initialized: bool,
    writer_id: u32,
    selected: Option<String>,
    filename: Option<String>,
    media_type: Option<String>,
    newline: Option<String>,
    header: Option<bool>,
    safe: Option<bool>,
    approve_loss: Option<bool>,
}
fn error(code: &str) -> Value {
    json!({"ok":false,"code":code,"action":"Retain the original input; review the report or choose an available profile."})
}
// This port is used only inside the packaged dedicated worker. The launcher
// enforces wall time/termination; linker max-memory bounds WASM linear memory.
// JS/renderer heap and host CSP remain explicitly separate host requirements.
struct WorkerPort;
impl ExecutionPort for WorkerPort {
    fn enforcement(&self) -> Enforcement {
        Enforcement {
            isolation: Isolation::BrowserWorker,
            hard_memory_bytes: MEMORY,
            watchdog: true,
            restricted_assets: true,
            no_network: true,
        }
    }
    fn start(&mut self, _: &JobContract, _: &JobSource, _: &Cancellation) -> Result<(), JobError> {
        Ok(())
    }
    fn stop(&mut self) {}
}
#[wasm_bindgen]
pub fn convert(request: &str, original: &[u8], checkpoint: &[u8]) -> String {
    match convert_value(request, original, checkpoint) {
        Ok(v) | Err(v) => v.to_string(),
    }
}
fn profile(format: &str, import: bool, safe: bool) -> Result<Profile, Value> {
    Ok(match (format, import, safe) {
        ("rtf", true, false) => rtf::import::PROFILE,
        ("rtf", false, false) => rtf::export::PROFILE,
        ("csv", true, false) => table_text::import::PROFILE,
        ("tsv", true, false) => table_text::import::TSV_PROFILE,
        ("csv", false, false) => table_text::export::PROFILE,
        ("tsv", false, false) => table_text::export::TSV_PROFILE,
        ("csv", false, true) => table_text::export::SAFE_PROFILE,
        ("tsv", false, true) => table_text::export::SAFE_TSV_PROFILE,
        ("pdf", true, _) => return Err(error("FORMAT_EXPORT_ONLY")),
        _ => return Err(error("FORMAT_UNAVAILABLE")),
    })
}
fn fail(e: impl std::fmt::Debug) -> Value {
    json!({"ok":false,"code":"ConversionRejected","detail":format!("{e:?}"),"action":"Retain original input and review diagnostics before any lossy action."})
}
pub fn convert_value(request: &str, original: &[u8], checkpoint: &[u8]) -> Result<Value, Value> {
    if request.len() > 16384
        || original.len() > LIMITS.input_bytes
        || checkpoint.len() > LIMITS.input_bytes
    {
        return Err(error("ResourceLimit"));
    }
    let r: Request = serde_json::from_str(request).map_err(|_| error("InvalidInput"))?;
    let import = match r.direction.as_str() {
        "import" => true,
        "export" => false,
        _ => return Err(error("InvalidDirection")),
    };
    // Reuse conservative shared PDF hints before restoring any Session.
    let filename = r
        .filename
        .clone()
        .unwrap_or_else(|| format!("input.{}", r.format));
    let media_type = r
        .media_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    if import {
        let request = editac_formats::ImportRequest {
            profile_id: if r.format == "pdf" {
                "edit-ac-pdf-v1"
            } else {
                "edit-ac-rtf-v1"
            },
            filename: &filename,
            media_type,
            original,
        };
        if let Err(f) = editac_formats::admit_import(&request) {
            if f.diagnostic.code == editac_formats::Code::ExportOnly {
                return Err(error("FORMAT_EXPORT_ONLY"));
            }
        }
    }
    let p = profile(&r.format, import, r.safe.unwrap_or(false))?;
    let i = r.identity.admit()?;
    let store = Arc::new(MemoryStore::new(i.clone(), StoreLimits::default()).map_err(fail)?);
    store
        .publish(
            0,
            CheckpointRecord::new(
                InitializedCheckpoint {
                    identity: i.clone(),
                    initialized: r.initialized,
                    writer_id: r.writer_id,
                    bytes: checkpoint.to_vec(),
                },
                vec![],
            )
            .map_err(fail)?,
        )
        .map_err(fail)?;
    let mut policy = HostPolicy::default();
    policy.extensions = true;
    policy.codecs.tables = true;
    let mut owner =
        ConversionOwner::open(store, &i, CachedPermission::LOCAL, policy).map_err(fail)?;
    let target = if import {
        let d = owner.service().session().document();
        let snapshot = d.snapshot().map_err(fail)?;
        let node = snapshot
            .visible
            .first()
            .ok_or_else(|| error("MissingTarget"))?;
        let a = d
            .anchor(&node.id, Utf16Offset(0), Bias::Right)
            .map_err(fail)?;
        Some(Selection {
            anchor: a.clone(),
            focus: a,
        })
    } else {
        None
    };
    let mut job = PreparedJob::begin(
        &owner,
        JobSpec {
            id: "public-worker-v1",
            profile: p,
            direction: if import {
                Direction::Import
            } else {
                Direction::Export
            },
            original,
            filename: &filename,
            media_type,
            target,
            limits: LIMITS,
            timeout: 10000,
            memory_bytes: MEMORY,
        },
        &JobPool::new(1).map_err(fail)?,
        Box::new(WorkerPort),
        0,
    )
    .map_err(fail)?;
    let revision = job.contract().revision.to_bytes().to_vec();
    let source_hash = job.contract().input_sha256.to_vec();
    let approve = r.approve_loss.unwrap_or(false);
    let mut v = if import && r.format == "rtf" {
        let prepared =
            rtf::import::prepare(&mut job, rtf::import::Budgets::default(), || 0).map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.code,"offset":e.offset,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"offset":d.offset,"control":d.control,"action":d.action,"lossy":true})).collect::<Vec<_>>(),"action":"Keep original input; reduce complexity or review unsupported controls."}))?;
        let blocks = prepared
            .blocks()
            .iter()
            .map(transfer_value)
            .collect::<Vec<_>>();
        let report = prepared.report();
        let diagnostics=report.diagnostics.iter().map(|d|json!({"code":d.code,"offset":d.offset,"control":d.control,"action":d.action,"lossy":true})).collect::<Vec<_>>();
        let committed = if !approve && !diagnostics.is_empty() {
            job.abort().map_err(fail)?;
            false
        } else {
            prepared
                .commit(&mut job, &mut owner, approve, 0)
                .map_err(fail)?
                .is_some()
        };
        json!({"ok":true,"blocks":blocks,"diagnostics":diagnostics,"sessionCommitted":committed})
    } else if import {
        use table_text::import::*;
        let newline = match r.newline.as_deref() {
            Some("lf") => Newline::Lf,
            Some("crlf") => Newline::CrLf,
            _ => return Err(error("ExplicitDialectRequired")),
        };
        let header = match r.header {
            Some(true) => Header::FirstRow,
            Some(false) => Header::None,
            _ => return Err(error("ExplicitDialectRequired")),
        };
        let prepared = prepare(
            &mut job,
            Dialect {
                delimiter: if r.format == "csv" {
                    Delimiter::Comma
                } else {
                    Delimiter::Tab
                },
                newline,
                encoding: Encoding::Utf8OptionalBom,
                header,
                ragged: Ragged::Reject,
            },
            Budgets::default(),
            || 0,
        )
        .map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.code,"offset":e.offset,"diagnostics":[],"action":"Retain original table source and correct its explicit dialect or size."}))?;
        let blocks = prepared
            .blocks()
            .iter()
            .map(transfer_value)
            .collect::<Vec<_>>();
        let report = prepared.report();
        let report = json!({"rows":report.rows,"columns":report.columns,"cells":report.cells,"headerRows":report.header_rows,"bomRemoved":report.bom_removed});
        let committed = prepared
            .commit(&mut job, &mut owner, 0)
            .map_err(fail)?
            .is_some();
        json!({"ok":true,"blocks":blocks,"report":report,"diagnostics":[],"sessionCommitted":committed})
    } else if r.format == "rtf" {
        let c = rtf::export::export(&mut job, None, approve, || 0).map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.reason,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"action":"Review representability diagnostics; retain the captured source."}))?;
        json!({"ok":true,"bytes":c.artifact.bytes(),"diagnostics":c.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>()})
    } else {
        use table_text::export::*;
        let newline = match r.newline.as_deref() {
            Some("lf") => Newline::Lf,
            Some("crlf") => Newline::CrLf,
            _ => return Err(error("ExplicitDialectRequired")),
        };
        let c = export(
            &mut job,
            r.selected.as_deref(),
            Dialect { newline },
            approve,
            || 0,
        )
        .map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.reason,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"action":"Select a table and review all loss diagnostics."}))?;
        json!({"ok":true,"bytes":c.artifact.bytes(),"diagnostics":c.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"transformedCells":c.report.transformed_cells})
    };
    v["profile"] = json!(p.id);
    v["capturedRevision"] = json!(revision);
    v["inputSha256"] = json!(source_hash);
    v["identity"] = identity(&i);
    v["work"] = json!({"bytes":job.work().bytes,"nodes":job.work().nodes,"pages":job.work().pages});
    if v.to_string().len() > 8 * 1024 * 1024 {
        return Err(error("ResourceLimit"));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use editac_core::document::InitialNode;
    fn fixture() -> (Value, Vec<u8>) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = format!(
            "27000000-0000-4000-8000-{:012x}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        let i = DocumentIdentity::v5(&id, "27000000-0000-4000-8000-000000000000").unwrap();
        let s = Arc::new(MemoryStore::new(i.clone(), StoreLimits::default()).unwrap());
        let o = ConversionOwner::create(
            s,
            i.clone(),
            &[InitialNode {
                kind: "block".into(),
                text: "Hello 🙂".into(),
            }],
            HostPolicy::default(),
        )
        .unwrap();
        let c = o.service().session().document().checkpoint();
        (
            json!({"identity":identity(&i),"initialized":true,"writerId":c.writer_id,"direction":"import","format":"rtf"}),
            c.bytes,
        )
    }
    #[test]
    fn actual_session_rtf_unicode_marks_and_unknown_destination() {
        let (r, c) = fixture();
        let v = convert_value(
            &r.to_string(),
            br"{\rtf1\ansi Hello \b bold\b0 \u-10179?\u-8638?}",
            &c,
        )
        .unwrap();
        assert_eq!(v["sessionCommitted"], true);
        assert!(v["blocks"].to_string().contains("bold"));
        assert!(v["blocks"].to_string().contains("🙂"));
        let v = convert_value(&r.to_string(), br"{\rtf1 hi {\*\unknown secret}}", &c).unwrap();
        assert!(!v["diagnostics"].as_array().unwrap().is_empty());
        assert_eq!(v["sessionCommitted"], false);
    }
    #[test]
    fn csv_requires_dialect_and_uses_shared_table() {
        let (mut r, c) = fixture();
        r["format"] = json!("csv");
        assert_eq!(
            convert_value(&r.to_string(), b"A,B\n", &c).unwrap_err()["code"],
            "ExplicitDialectRequired"
        );
        r["newline"] = json!("lf");
        r["header"] = json!(false);
        let v = convert_value(&r.to_string(), "=1+1,🙂\n".as_bytes(), &c).unwrap();
        assert_eq!(v["report"]["cells"], 2);
        assert_eq!(v["sessionCommitted"], true);
        assert!(v["blocks"].to_string().contains("=1+1"));
    }
    #[test]
    fn fixed_checkpoint_rtf_export() {
        let (mut r, c) = fixture();
        r["direction"] = json!("export");
        let v = convert_value(&r.to_string(), b"", &c).unwrap();
        assert_eq!(v["capturedRevision"].as_array().unwrap().len(), 65);
        let b = v["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        assert!(b.starts_with(br"{\rtf1"));
    }
    #[test]
    fn pdf_magic_and_unavailable_never_restore_or_convert() {
        let (mut r, _) = fixture();
        assert_eq!(
            convert_value(&r.to_string(), b"%PDF-1.7", b"").unwrap_err()["code"],
            "FORMAT_EXPORT_ONLY"
        );
        r["format"] = json!("docx");
        assert_eq!(
            convert_value(&r.to_string(), b"x", b"").unwrap_err()["code"],
            "FORMAT_UNAVAILABLE"
        );
    }
    #[test]
    fn input_envelope_identity_and_buffer_limits() {
        let (mut r, c) = fixture();
        assert!(convert_value("{}", b"", &c).is_err());
        r["identity"]["offsets"] = json!("bytes");
        assert_eq!(
            convert_value(&r.to_string(), b"", &c).unwrap_err()["code"],
            "InvalidIdentity"
        );
        assert_eq!(
            convert_value(&r.to_string(), &vec![0; 1048577], &c).unwrap_err()["code"],
            "ResourceLimit"
        );
    }
}
