//! Optional worker transport. Shared Session/jobs own all semantics.
use editac_core::modules::assets::{AssetAction, AssetGrant, AssetIdentity, AssetRequest};
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    document::{DocumentIdentity, InitializedCheckpoint},
    interchange::{identity, transfer_value},
};
use editac_formats::{Direction, LIMITS, Profile, docx, epub, job::*, odt, pdf, rtf, table_text};
use editac_session::{
    assets::{AssetHost, HostOutcome},
    ports::PortError,
};
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
    #[serde(default)]
    assets: Vec<ApprovedAsset>,
    #[serde(default)]
    import_grants: Vec<ImportGrant>,
}
// Explicit caller-held read grants and immutable bytes only. No locators,
// implicit fetches or descriptor-derived authority enter this transport.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovedAsset {
    identity: AssetIdentity,
    actions: Vec<AssetAction>,
    offset: usize,
    length: usize,
}
struct ApprovedAssets<'a> {
    records: &'a [ApprovedAsset],
    bytes: &'a [u8],
}
impl AssetHost for ApprovedAssets<'_> {
    fn authorize(&mut self, request: &AssetRequest) -> Result<AssetGrant, PortError> {
        if request.action != AssetAction::Read {
            return Err(PortError::Unavailable);
        }
        let record = self
            .records
            .iter()
            .find(|r| r.identity == request.identity)
            .ok_or(PortError::Unavailable)?;
        let grant = AssetGrant {
            identity: record.identity.clone(),
            actions: record.actions.clone(),
        };
        request
            .validate(&grant)
            .map_err(|_| PortError::Unavailable)?;
        Ok(grant)
    }
    fn execute(&mut self, _: &str, request: &AssetRequest) -> Result<HostOutcome, PortError> {
        self.authorize(request)?;
        Ok(HostOutcome::Complete)
    }
}
impl docx::export::OriginalAssetHost for ApprovedAssets<'_> {
    fn read_original(&mut self, request: &AssetRequest) -> Result<Vec<u8>, PortError> {
        self.authorize(request)?;
        let record = self
            .records
            .iter()
            .find(|r| r.identity == request.identity)
            .ok_or(PortError::Unavailable)?;
        if record.length as u64 > request.byte_limit {
            return Err(PortError::Quota);
        }
        let end = record
            .offset
            .checked_add(record.length)
            .ok_or(PortError::Quota)?;
        Ok(self
            .bytes
            .get(record.offset..end)
            .ok_or(PortError::Quota)?
            .to_vec())
    }
}
impl odt::export::OriginalAssetHost for ApprovedAssets<'_> {
    fn read_original(&mut self, request: &AssetRequest) -> Result<Vec<u8>, PortError> {
        docx::export::OriginalAssetHost::read_original(self, request)
    }
}
impl epub::export::OriginalAssetHost for ApprovedAssets<'_> {
    fn read_original(&mut self, request: &AssetRequest) -> Result<Vec<u8>, PortError> {
        docx::export::OriginalAssetHost::read_original(self, request)
    }
}
impl pdf::export::OriginalAssetHost for ApprovedAssets<'_> {
    fn read_original(&mut self, request: &AssetRequest) -> Result<Vec<u8>, PortError> {
        docx::export::OriginalAssetHost::read_original(self, request)
    }
}
// Exact reviewed OFL faces are part of this optional module, never host fonts.
// The build receipt pins all bytes/notices; the renderer revalidates their hashes.
fn publication_fonts() -> pdf::export::Fonts<'static> {
    pdf::export::Fonts {
        base: [
            include_bytes!("../../../fixtures/formats/fonts/NotoSans-Regular.ttf"),
            include_bytes!("../../../fixtures/formats/fonts/NotoNaskhArabic-Regular.ttf"),
        ],
        rich: Some([
            include_bytes!("../../../fixtures/formats/fonts/NotoSans-Bold.ttf"),
            include_bytes!("../../../fixtures/formats/fonts/NotoSans-Italic.ttf"),
            include_bytes!("../../../fixtures/formats/fonts/NotoSans-BoldItalic.ttf"),
            include_bytes!("../../../fixtures/formats/fonts/NotoSansMono-Regular.ttf"),
        ]),
    }
}
// Worker-local codec projection only: these bytes are not durable staging or
// host ingestion. The public caller must stage and atomically adopt every item
// using the real storage owner before any live descriptor can be inserted.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ImportGrant {
    sha256: Vec<u8>,
    identity: AssetIdentity,
    actions: Vec<AssetAction>,
}
struct PreparedImportMedia<'a> {
    grants: &'a [ImportGrant],
    requested: std::cell::Cell<bool>,
    originals: Vec<Value>,
}
impl AssetHost for PreparedImportMedia<'_> {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        let record = self
            .grants
            .iter()
            .find(|g| g.identity == r.identity)
            .ok_or(PortError::Permission)?;
        let grant = AssetGrant {
            identity: record.identity.clone(),
            actions: record.actions.clone(),
        };
        r.validate(&grant).map_err(|_| PortError::Permission)?;
        Ok(grant)
    }
    fn execute(&mut self, _: &str, _: &AssetRequest) -> Result<HostOutcome, PortError> {
        Err(PortError::Unavailable)
    }
}
impl docx::import::OriginalMediaHost for PreparedImportMedia<'_> {
    fn identity(&self, hash: &[u8; 32]) -> Result<AssetIdentity, PortError> {
        self.requested.set(true);
        self.grants
            .iter()
            .find(|g| g.sha256.as_slice() == hash)
            .map(|g| g.identity.clone())
            .ok_or(PortError::Permission)
    }
    fn ingest_original(
        &mut self,
        _: &str,
        r: &AssetRequest,
        bytes: &[u8],
    ) -> Result<HostOutcome, PortError> {
        self.originals
            .push(json!({"identity":r.identity,"bytes":bytes}));
        Ok(HostOutcome::Complete)
    }
}
#[wasm_bindgen]
pub fn convert_with_assets(
    request: &str,
    original: &[u8],
    checkpoint: &[u8],
    assets: &[u8],
) -> String {
    match convert_value_with_assets(request, original, checkpoint, assets) {
        Ok(v) | Err(v) => v.to_string(),
    }
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
        ("docx", false, false) => docx::export::PROFILE,
        ("odt", false, false) => odt::export::PROFILE,
        ("epub", false, false) => epub::export::PROFILE,
        ("pdf", false, false) => pdf::export::PROFILE,
        ("docx", true, false) => docx::import::STRUCTURE_PROFILE,
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
    convert_value_with_assets(request, original, checkpoint, &[])
}
pub fn convert_value_with_assets(
    request: &str,
    original: &[u8],
    checkpoint: &[u8],
    assets: &[u8],
) -> Result<Value, Value> {
    if assets.len() > LIMITS.input_bytes
        || request.len() > 16384
        || original.len() > LIMITS.input_bytes
        || checkpoint.len() > LIMITS.input_bytes
    {
        return Err(error("ResourceLimit"));
    }
    let r: Request = serde_json::from_str(request).map_err(|_| error("InvalidInput"))?;
    if r.assets.len() > 64 {
        return Err(error("ResourceLimit"));
    }
    let mut offset = 0usize;
    for (index, a) in r.assets.iter().enumerate() {
        if a.offset != offset
            || a.length == 0
            || r.assets[..index]
                .iter()
                .any(|old| old.identity == a.identity)
        {
            return Err(error("InvalidAssets"));
        }
        offset = offset
            .checked_add(a.length)
            .filter(|end| *end <= assets.len())
            .ok_or_else(|| error("ResourceLimit"))?;
    }
    if offset != assets.len() {
        return Err(error("InvalidAssets"));
    }
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
            limits: if r.format == "pdf" { p.limits } else { LIMITS },
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
    let mut v = if import && r.format == "docx" {
        if r.import_grants.len() > 64
            || r.import_grants
                .iter()
                .any(|g| g.sha256.len() != 32 || g.identity.validate().is_err())
        {
            return Err(error("InvalidAssets"));
        }
        for (n, g) in r.import_grants.iter().enumerate() {
            if r.import_grants[..n]
                .iter()
                .any(|other| other.sha256 == g.sha256 || other.identity == g.identity)
            {
                return Err(error("InvalidAssets"));
            }
        }
        let mut host = PreparedImportMedia {
            grants: &r.import_grants,
            requested: std::cell::Cell::new(false),
            originals: vec![],
        };
        let prepared = docx::import::prepare_structure(
            &mut job, editac_formats::container::Budgets::default(), &mut host, || 0,
        ).map_err(|e| json!({"ok":false,
            "code":if host.requested.get() { "AssetStagingUnavailable" } else { "ConversionRejected" },
            "reason":format!("{:?}",e.code),"location":e.location,
            "diagnostics":e.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy,"action":d.action})).collect::<Vec<_>>(),
            "action":"Keep the complete original DOCX. Explicit matching media grants and atomic storage adoption are required; no live content was inserted."}))?;
        let blocks = prepared
            .blocks()
            .iter()
            .map(transfer_value)
            .collect::<Vec<_>>();
        let diagnostics = prepared
            .report()
            .diagnostics
            .iter()
            .map(|d| json!({"code":d.code,"location":d.location,"lossy":d.lossy,"action":d.action}))
            .collect::<Vec<_>>();
        let committed = if !host.originals.is_empty()
            || (!approve && diagnostics.iter().any(|d| d["lossy"] == true))
        {
            job.abort().map_err(fail)?;
            false
        } else {
            prepared
                .commit(&mut job, &mut owner, approve, 0)
                .map_err(fail)?
                .is_some()
        };
        json!({"ok":true,"blocks":blocks,"diagnostics":diagnostics,"sessionCommitted":committed,
            "mediaCandidates":host.originals,"mediaStaging":"requires-durable-owner-adoption","fidelity":"docx-structure-semantic-v1"})
    } else if import && r.format == "rtf" {
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
    } else if r.format == "docx" {
        let mut host = ApprovedAssets {
            records: &r.assets,
            bytes: assets,
        };
        let c = docx::export::export(&mut job, None, approve, &mut host, || 0)
            .map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.reason,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy,"action":d.action})).collect::<Vec<_>>(),"action":"Retain the captured checkpoint; supply explicitly granted original assets or review loss diagnostics."}))?;
        json!({"ok":true,"bytes":c.artifact.bytes(),"diagnostics":c.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy,"action":d.action})).collect::<Vec<_>>(),"assetCount":c.report.assets,"originalAssetBytes":c.report.original_bytes})
    } else if r.format == "odt" {
        let mut host = ApprovedAssets {
            records: &r.assets,
            bytes: assets,
        };
        let c = odt::export::export(&mut job, None, approve, &mut host, || 0)
            .map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.reason,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"action":"Retain the captured checkpoint; supply explicitly granted original assets or review loss diagnostics."}))?;
        json!({"ok":true,"bytes":c.artifact.bytes(),"diagnostics":c.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"assetCount":c.report.assets,"originalAssetBytes":c.report.original_bytes})
    } else if r.format == "epub" {
        let mut host = ApprovedAssets {
            records: &r.assets,
            bytes: assets,
        };
        let c = epub::export::export(&mut job, None, approve, &mut host, || 0)
            .map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.reason,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"action":"Retain the captured checkpoint; supply explicitly granted original assets or review loss diagnostics."}))?;
        json!({"ok":true,"bytes":c.artifact.bytes(),"diagnostics":c.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"assetCount":c.report.assets,"originalAssetBytes":c.report.original_bytes})
    } else if r.format == "pdf" {
        let mut host = ApprovedAssets {
            records: &r.assets,
            bytes: assets,
        };
        let c = pdf::export::export_with_assets(&mut job, publication_fonts(), &mut host, approve, || 0)
            .map_err(|e|json!({"ok":false,"code":"ConversionRejected","reason":e.reason,"diagnostics":e.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"action":"Retain the captured checkpoint; use supported publication content and explicitly authorized originals, or review loss diagnostics."}))?;
        json!({"ok":true,"bytes":c.artifact.bytes(),"diagnostics":c.report.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"pages":c.report.pages,"shapedBytes":c.report.shaped_bytes,"assetCount":c.report.images.len(),"originalAssetBytes":c.report.original_bytes,"pixels":c.report.pixels})
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
        fixture_text("Hello 🙂")
    }
    fn fixture_text(text: &str) -> (Value, Vec<u8>) {
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
                text: text.into(),
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
    fn public_docx_import_reuses_guarded_structure_session_and_unicode() {
        let (mut r, c) = fixture();
        r["direction"] = json!("export");
        r["format"] = json!("docx");
        let exported = convert_value(&r.to_string(), &[], &c).unwrap();
        let bytes = exported["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        r["direction"] = json!("import");
        r["approveLoss"] = json!(true);
        let value = convert_value(&r.to_string(), &bytes, &c).unwrap();
        assert_eq!(value["sessionCommitted"], true);
        assert_eq!(value["blocks"][0]["runs"][0]["text"], "Hello 🙂");
        assert_eq!(value["mediaStaging"], "requires-durable-owner-adoption");
        assert_eq!(value["profile"], "edit-ac-docx-v1");
    }
    #[test]
    fn public_docx_import_rejects_malformed_containers_before_mutation() {
        let (mut r, c) = fixture();
        r["format"] = json!("docx");
        let e = convert_value(&r.to_string(), b"PK invalid", &c).unwrap_err();
        assert_eq!(e["code"], "ConversionRejected");
        assert!(e["location"].as_str().is_some());
        assert!(e["diagnostics"].is_array());
    }
    #[test]
    fn public_odt_export_uses_captured_writer_and_keeps_import_unavailable() {
        let (mut r, c) = fixture();
        r["direction"] = json!("export");
        r["format"] = json!("odt");
        let v = convert_value(&r.to_string(), &[], &c).unwrap();
        assert_eq!(v["profile"], "edit-ac-odt-v1");
        assert!(v["bytes"].as_array().unwrap().len() > 100);
        assert!(
            v["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "PACKAGE_REGENERATED")
        );
        r["direction"] = json!("import");
        assert_eq!(
            convert_value(&r.to_string(), b"PK", &c).unwrap_err()["code"],
            "FORMAT_UNAVAILABLE"
        );
    }
    #[test]
    fn public_pdf_uses_pinned_publication_renderer_and_remains_export_only() {
        let (mut r, c) = fixture_text("Hello publication");
        r["direction"] = json!("export");
        r["format"] = json!("pdf");
        let v = convert_value(&r.to_string(), &[], &c).unwrap();
        assert_eq!(v["profile"], "edit-ac-pdf-publication-v1");
        let bytes = v["bytes"].as_array().unwrap();
        assert_eq!(
            bytes[..5],
            [json!(37), json!(80), json!(68), json!(70), json!(45)]
        );
        assert_eq!(v["pages"], 1);
        assert_eq!(v["assetCount"], 0);
        assert!(
            v["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "LAYOUT_DEFAULTS")
        );
        r["direction"] = json!("import");
        assert_eq!(
            convert_value(&r.to_string(), b"%PDF-", &c).unwrap_err()["code"],
            "FORMAT_EXPORT_ONLY"
        );
    }
    #[test]
    fn public_epub_export_uses_captured_writer_and_keeps_import_unavailable() {
        let (mut r, c) = fixture();
        r["direction"] = json!("export");
        r["format"] = json!("epub");
        let v = convert_value(&r.to_string(), &[], &c).unwrap();
        assert_eq!(v["profile"], "edit-ac-epub-v1");
        assert!(v["bytes"].as_array().unwrap().len() > 100);
        assert!(
            v["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "PACKAGE_REGENERATED")
        );
        r["direction"] = json!("import");
        assert_eq!(
            convert_value(&r.to_string(), b"PK", &c).unwrap_err()["code"],
            "FORMAT_UNAVAILABLE"
        );
    }
    #[test]
    fn public_docx_export_uses_existing_captured_writer() {
        let (mut r, c) = fixture();
        r["direction"] = json!("export");
        r["format"] = json!("docx");
        let v = convert_value(&r.to_string(), &[], &c).unwrap();
        assert!(v["bytes"].as_array().unwrap().len() > 100);
        assert!(
            v["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "PACKAGE_REGENERATED")
        );
        r["direction"] = json!("import");
        assert_eq!(
            convert_value(&r.to_string(), b"PK", &c).unwrap_err()["code"],
            "ConversionRejected"
        );
    }
    #[test]
    fn asset_transport_rejects_alias_ranges_duplicates_and_exhaustion() {
        let (mut r, c) = fixture();
        r["direction"] = json!("export");
        r["format"] = json!("docx");
        r["assets"] = json!([{"identity":{"host":"local","key":"image"},"actions":["read"],"offset":1,"length":1}]);
        assert_eq!(
            convert_value_with_assets(&r.to_string(), &[], &c, &[1]).unwrap_err()["code"],
            "InvalidAssets"
        );
        r["assets"][0]["offset"] = json!(0);
        let duplicate = r["assets"][0].clone();
        r["assets"].as_array_mut().unwrap().push(duplicate);
        assert_eq!(
            convert_value_with_assets(&r.to_string(), &[], &c, &[1, 2]).unwrap_err()["code"],
            "InvalidAssets"
        );
        assert_eq!(
            convert_value_with_assets(&r.to_string(), &[], &c, &vec![0; LIMITS.input_bytes + 1])
                .unwrap_err()["code"],
            "ResourceLimit"
        );
    }
    #[test]
    fn approved_asset_port_requires_exact_read_grant_and_preallocation_budget() {
        let identity = AssetIdentity {
            host: "local".into(),
            key: "image".into(),
        };
        let records = [ApprovedAsset {
            identity: identity.clone(),
            actions: vec![AssetAction::Read],
            offset: 0,
            length: 3,
        }];
        let mut host = ApprovedAssets {
            records: &records,
            bytes: &[1, 2, 3],
        };
        let mut request = AssetRequest {
            version: 1,
            operation_id: "read1".into(),
            identity,
            action: AssetAction::Read,
            byte_limit: 2,
        };
        use docx::export::OriginalAssetHost;
        assert!(host.read_original(&request).is_err());
        request.byte_limit = 3;
        assert_eq!(host.read_original(&request).unwrap(), vec![1, 2, 3]);
        request.action = AssetAction::Ingest;
        assert!(host.authorize(&request).is_err());
        request.action = AssetAction::Read;
        request.identity.key = "foreign".into();
        assert!(host.authorize(&request).is_err());
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
        r["format"] = json!("odt");
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
