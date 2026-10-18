//! Private worker for runner.py. Public conversion semantics come exclusively
//! from editac-formats and the shared Session; no independent writable model.
#[cfg(feature = "docx-export")]
mod docx;
#[cfg(feature = "docx-import")]
mod docx_import;
#[cfg(feature = "epub-export")]
mod epub;
#[cfg(feature = "epub-import")]
mod epub_import;
mod export;
#[cfg(feature = "qualification")]
mod fixture;
mod heap;
#[cfg(any(
    feature = "odt-export",
    feature = "docx-export",
    feature = "epub-export",
    feature = "pdf-export"
))]
mod media;
#[cfg(feature = "odt-export")]
mod odt;
#[cfg(feature = "odt-import")]
mod odt_import;
#[cfg(feature = "pdf-export")]
mod pdf;
#[cfg(feature = "qualification")]
mod pdf_fixture;
mod table;
#[cfg(feature = "qualification")]
use std::io::Write;
#[global_allocator]
static ALLOCATOR: heap::Bounded = heap::Bounded::new();
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    document::{BlockAttributes, DocumentIdentity, InitialNode},
};
use editac_formats::{
    Direction, LIMITS,
    job::*,
    rtf::import::{self as rtf, Budgets},
};
use editac_session::{
    edit_service::HostPolicy,
    ports::{StoreLimits, memory::MemoryStore},
    session::CachedPermission,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, sync::Arc, time::Instant};

// The runner installs the sandbox, process watchdog and inherited hard resource
// limits before exec. The Rust heap cap is installed above before main executes.
struct NativePort;
impl ExecutionPort for NativePort {
    fn enforcement(&self) -> Enforcement {
        Enforcement {
            isolation: Isolation::NativeProcess,
            hard_memory_bytes: heap::LIMIT,
            watchdog: true,
            restricted_assets: true,
            no_network: true,
        }
    }
    fn start(&mut self, _: &JobContract, _: &JobSource, _: &Cancellation) -> Result<(), JobError> {
        if std::env::var("EDITAC_NATIVE_RUNNER").as_deref() != Ok("rtf-v1") {
            return Err(JobError::IsolationUnavailable);
        }
        Ok(())
    }
    fn stop(&mut self) {}
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn attributes(a: &Option<BlockAttributes>) -> Value {
    match a {
        None => Value::Null,
        Some(a) => {
            let mut s = String::new();
            a.tuple().to_json(&mut s);
            serde_json::from_str(&s).unwrap()
        }
    }
}
fn diagnostics(r: &rtf::Report) -> Value {
    json!({"diagnostics": r.diagnostics.iter().map(|d| json!({"code": d.code,"offset":d.offset,"control":d.control,"action":d.action})).collect::<Vec<_>>(),
        "scannedBytes":r.scanned_bytes,"tokens":r.tokens,"binaryBytes":r.binary_bytes,"maxDepth":r.max_depth,"utf16Units":r.utf16_units,"nodes":r.nodes})
}
fn convert(input: &[u8]) -> Value {
    let started = Instant::now();
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let raw = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let document_id = format!(
        "{}-{}-{}-{}-{}",
        &raw[..8],
        &raw[8..12],
        &raw[12..16],
        &raw[16..20],
        &raw[20..]
    );
    let id = DocumentIdentity::v5(&document_id, "27000000-0000-4000-8000-000000000000").unwrap();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let mut policy = HostPolicy::default();
    policy.extensions = true;
    policy.codecs.tables = true;
    let mut owner = ConversionOwner::create(
        store.clone(),
        id.clone(),
        &[InitialNode {
            kind: "block".into(),
            text: "".into(),
        }],
        policy.clone(),
    )
    .unwrap();
    let before = owner.service().session().document().checkpoint().bytes;
    let d = owner.service().session().document();
    let node = d.snapshot().unwrap().visible[0].id.clone();
    let anchor = d.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    let spec = JobSpec {
        id: "native-rtf",
        profile: rtf::PROFILE,
        direction: Direction::Import,
        original: input,
        filename: "input.rtf",
        media_type: "application/rtf",
        target: Some(Selection {
            anchor: anchor.clone(),
            focus: anchor,
        }),
        limits: LIMITS,
        timeout: 4000,
        memory_bytes: 32 * 1024 * 1024,
    };
    let pool = JobPool::new(1).unwrap();
    let now = || started.elapsed().as_millis() as u64;
    let mut job = match PreparedJob::begin(&owner, spec, &pool, Box::new(NativePort), now()) {
        Ok(j) => j,
        Err(e) => {
            return json!({"state":"rejected","code":match e {JobError::Admission(code)=>code.as_str().to_string(), _=>format!("{e:?}")},"liveUnchanged":true});
        }
    };
    let prepared = match rtf::prepare(&mut job, Budgets::default(), now) {
        Ok(p) => p,
        Err(e) => {
            return json!({"state":"rejected","code":e.code,"report":diagnostics(&e.report),"liveUnchanged":owner.service().session().document().checkpoint().bytes==before});
        }
    };
    let report = diagnostics(prepared.report());
    // No implicit lossy operation is exposed by this first native profile.
    if !prepared.report().diagnostics.is_empty() {
        job.abort().unwrap();
        return json!({"state":"rejected","code":"LOSS_APPROVAL","report":report,"liveUnchanged":owner.service().session().document().checkpoint().bytes==before});
    }
    let expected = prepared.blocks().iter().map(|b| json!({"runs":b.runs.iter().map(|r|json!({"text":r.text,"marks":format!("{:?}",r.marks)})).collect::<Vec<_>>(),"attributes":attributes(&b.attributes)})).collect::<Vec<_>>();
    if let Err(e) = prepared.commit(&mut job, &mut owner, false, now()) {
        return json!({"state":"rejected","code":e.code,"report":report,"liveUnchanged":owner.service().session().document().checkpoint().bytes==before});
    }
    let imported = owner.service().read(now()).unwrap().snapshot;
    let text = |o: &ConversionOwner<MemoryStore>| {
        o.service()
            .read(0)
            .unwrap()
            .snapshot
            .visible
            .iter()
            .flat_map(|n| n.runs.iter().map(|r| r.text.as_str()))
            .collect::<String>()
    };
    let after_text = text(&owner);
    let revision = owner.service().read(now()).unwrap().revision;
    owner.service_mut().undo(&revision, now()).unwrap();
    let undo = text(&owner) == "";
    let revision = owner.service().read(now()).unwrap().revision;
    owner.service_mut().redo(&revision, now()).unwrap();
    let redo = text(&owner) == after_text;
    let reopened = ConversionOwner::open(store, &id, CachedPermission::LOCAL, policy).unwrap();
    let reopen = text(&reopened) == after_text
        && reopened.service().read(0).unwrap().snapshot.visible == imported.visible;
    let checkpoint = reopened.service().session().document().checkpoint().bytes;
    json!({"state":"passed","profile":rtf::PROFILE.id,"report":report,"preparedBlocks":expected,"snapshotBlocks":imported.visible.iter().map(|n|json!({"runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),{let mut s=String::new();v.to_json(&mut s);serde_json::from_str::<Value>(&s).unwrap()})).collect::<std::collections::BTreeMap<_,_>>()})).collect::<Vec<_>>(),"attributes":attributes(&n.block_attributes)})).collect::<Vec<_>>(),
        "text":after_text,"undo":undo,"redo":redo,"reopen":reopen,"commits":1,"activeJobs":pool.active(),"originalSha256":hash(input),
        "epoch":id.epoch,"writerId":reopened.service().session().document().checkpoint().writer_id,"documentId":document_id,"checkpointSha256":hash(&checkpoint),"checkpoint":checkpoint,"assets":0,"networkCalls":0})
}
#[cfg(feature = "qualification")]
fn probe(mode: &str) -> Option<Value> {
    match mode {
        "export-fixture" => Some(fixture::make()),
        "read" => Some(json!({"denied":std::fs::read(std::env::args().nth(2).unwrap()).is_err()})),
        "write" => Some(
            json!({"denied":std::fs::write(std::env::args().nth(2).unwrap(),b"escape").is_err()}),
        ),
        "network" => Some(
            json!({"denied":std::net::TcpStream::connect("127.0.0.1:9").err().is_some_and(|e| e.kind()==std::io::ErrorKind::PermissionDenied)}),
        ),
        "child" => {
            Some(json!({"denied":std::process::Command::new("/usr/bin/true").status().is_err()}))
        }
        "spin" => loop {
            std::hint::spin_loop();
        },
        "heap" => {
            let v = vec![0u8; heap::LIMIT + 1];
            std::hint::black_box(v);
            unreachable!()
        }
        "output" => {
            let mut out = std::io::stdout().lock();
            loop {
                out.write_all(&[b'x'; 8192]).unwrap();
            }
        }
        _ => None,
    }
}
fn main() {
    if std::env::var("EDITAC_NATIVE_RUNNER").as_deref() != Ok("rtf-v1") {
        eprintln!("FORMAT_ISOLATION_UNAVAILABLE");
        std::process::exit(78);
    }
    let mode = std::env::args().nth(1).unwrap_or_default();
    #[cfg(feature = "qualification")]
    if let Some(v) = probe(&mode) {
        println!("{v}");
        return;
    }
    if mode != "rtf-import"
        && mode != "rtf-export"
        && mode != "csv-import"
        && mode != "tsv-import"
        && mode != "table-export"
        && mode != "odt-export"
        && mode != "odt-import"
        && mode != "docx-import"
        && mode != "docx-export"
        && mode != "epub-import"
        && mode != "epub-export"
        && mode != "pdf-export"
    {
        eprintln!("FORMAT_PROFILE_UNAVAILABLE");
        std::process::exit(78);
    }
    let mut input = Vec::new();
    std::io::stdin()
        .take((LIMITS.input_bytes + 1) as u64)
        .read_to_end(&mut input)
        .unwrap();
    let mut result = if input.len() > LIMITS.input_bytes {
        json!({"state":"rejected","code":"FORMAT_INPUT_LIMIT","liveUnchanged":true})
    } else {
        if mode == "epub-import" {
            #[cfg(feature = "epub-import")]
            {
                epub_import::convert(&input, &std::env::args().skip(2).collect::<Vec<_>>())
            }
            #[cfg(not(feature = "epub-import"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "docx-import" {
            #[cfg(feature = "docx-import")]
            {
                docx_import::convert(&input, &std::env::args().skip(2).collect::<Vec<_>>())
            }
            #[cfg(not(feature = "docx-import"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "odt-import" {
            #[cfg(feature = "odt-import")]
            {
                odt_import::convert(&input, &std::env::args().skip(2).collect::<Vec<_>>())
            }
            #[cfg(not(feature = "odt-import"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "odt-export" {
            #[cfg(feature = "odt-export")]
            {
                export::convert_odt(&input)
            }
            #[cfg(not(feature = "odt-export"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "pdf-export" {
            #[cfg(feature = "pdf-export")]
            {
                export::convert_pdf(&input)
            }
            #[cfg(not(feature = "pdf-export"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "epub-export" {
            #[cfg(feature = "epub-export")]
            {
                export::convert_epub(&input)
            }
            #[cfg(not(feature = "epub-export"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "docx-export" {
            #[cfg(feature = "docx-export")]
            {
                export::convert_docx(&input)
            }
            #[cfg(not(feature = "docx-export"))]
            {
                json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true})
            }
        } else if mode == "rtf-export" {
            export::convert(&input)
        } else if mode == "table-export" {
            export::convert_table(&input)
        } else if mode == "csv-import" || mode == "tsv-import" {
            table::convert(&input, &mode, &std::env::args().skip(2).collect::<Vec<_>>())
        } else {
            convert(&input)
        }
    };
    result["peakRustHeapBytes"] = json!(ALLOCATOR.peak());
    result["hardRustHeapBytes"] = json!(heap::LIMIT);
    println!("{result}");
}
