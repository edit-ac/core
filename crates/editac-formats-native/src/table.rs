//! Explicit-dialect native table import through the existing public mapper/Session.
use super::*;
use editac_formats::table_text::import::{
    self as table, Delimiter, Dialect, Encoding, Header, Newline, Ragged,
};
fn dialect(mode: &str, args: &[String]) -> Option<Dialect> {
    if args.len() != 3 {
        return None;
    }
    Some(Dialect {
        delimiter: match mode {
            "csv-import" => Delimiter::Comma,
            "tsv-import" => Delimiter::Tab,
            _ => return None,
        },
        newline: match args[0].as_str() {
            "lf" => Newline::Lf,
            "crlf" => Newline::CrLf,
            _ => return None,
        },
        encoding: match args[1].as_str() {
            "utf8" => Encoding::Utf8,
            "utf8-bom" => Encoding::Utf8OptionalBom,
            _ => return None,
        },
        header: match args[2].as_str() {
            "none" => Header::None,
            "first-row" => Header::FirstRow,
            _ => return None,
        },
        ragged: Ragged::Reject,
    })
}
fn diagnostics(r: &table::Report) -> Value {
    json!({"diagnostics":[],"scannedBytes":r.scanned_bytes,"rows":r.rows,"columns":r.columns,"cells":r.cells,"utf16Units":r.utf16_units,"headerRows":r.header_rows,"bomRemoved":r.bom_removed})
}
pub fn convert(input: &[u8], mode: &str, args: &[String]) -> Value {
    let Some(dialect) = dialect(mode, args) else {
        return json!({"state":"rejected","code":"FORMAT_DIALECT_REQUIRED","liveUnchanged":true});
    };
    let profile = if mode == "csv-import" {
        table::PROFILE
    } else {
        table::TSV_PROFILE
    };
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
        id: "native-table-import",
        profile,
        direction: Direction::Import,
        original: input,
        filename: if mode == "csv-import" {
            "input.csv"
        } else {
            "input.tsv"
        },
        media_type: if mode == "csv-import" {
            "text/csv"
        } else {
            "text/tab-separated-values"
        },
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
    let prepared = match table::prepare(&mut job, dialect, table::Budgets::default(), now) {
        Ok(p) => p,
        Err(e) => {
            return json!({"state":"rejected","code":e.code,"report":{"diagnostics":[{"code":e.code,"offset":e.offset}],"originalRetained":true},"liveUnchanged":owner.service().session().document().checkpoint().bytes==before});
        }
    };
    let report = diagnostics(prepared.report());
    let expected = prepared.blocks().iter().map(|b| json!({"runs":b.runs.iter().map(|r|json!({"text":r.text,"marks":format!("{:?}",r.marks)})).collect::<Vec<_>>(),"attributes":attributes(&b.attributes)})).collect::<Vec<_>>();
    if let Err(e) = prepared.commit(&mut job, &mut owner, now()) {
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
    json!({"state":"passed","profile":profile.id,"report":report,"preparedBlocks":expected,"snapshotBlocks":imported.visible.iter().map(|n|json!({"runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),{let mut s=String::new();v.to_json(&mut s);serde_json::from_str::<Value>(&s).unwrap()})).collect::<std::collections::BTreeMap<_,_>>()})).collect::<Vec<_>>(),"attributes":attributes(&n.block_attributes)})).collect::<Vec<_>>(),
        "dialect":args,"text":after_text,"undo":undo,"redo":redo,"reopen":reopen,"commits":1,"activeJobs":pool.active(),"originalSha256":hash(input),
        "epoch":id.epoch,"writerId":reopened.service().session().document().checkpoint().writer_id,"documentId":document_id,"checkpointSha256":hash(&checkpoint),"checkpoint":checkpoint,"assets":0,"networkCalls":0})
}
