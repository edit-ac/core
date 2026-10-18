//! Captured Session checkpoint export; no alternate semantic model or OS parser.
use super::*;
#[cfg(feature = "qualification")]
use editac_core::commands::{
    editor::EditorCommand,
    text::{TextCommand, TextOrigin},
};
use editac_core::document::InitializedCheckpoint;
use editac_formats::rtf::export as writer;
use editac_session::ports::{CheckpointRecord, LocalStore};

fn report(r: &writer::Report) -> Value {
    json!({"diagnostics":r.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"nodes":r.nodes,"utf16Units":r.utf16_units})
}
fn attempt(input: &[u8]) -> Result<Value, String> {
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    let request: Value = serde_json::from_slice(input).map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
    if !request.is_object() || request.get("approveLoss").is_some_and(|v| !v.is_boolean()) {
        return Err("FORMAT_REQUEST_INVALID".into());
    }
    #[cfg(not(feature = "qualification"))]
    if request.get("laterText").is_some() {
        return Err("FORMAT_PROFILE_UNAVAILABLE".into());
    }
    let id = DocumentIdentity::v5(
        request["documentId"]
            .as_str()
            .ok_or("FORMAT_CHECKPOINT_INVALID")?,
        request["epoch"]
            .as_str()
            .ok_or("FORMAT_CHECKPOINT_INVALID")?,
    )
    .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
    let writer_id = request["writerId"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or("FORMAT_CHECKPOINT_INVALID")?;
    let bytes: Vec<u8> = serde_json::from_value(request["checkpoint"].clone())
        .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
    let source_hash = hash(&bytes);
    if request["checkpointSha256"].as_str() != Some(&source_hash) {
        return Err("FORMAT_CHECKPOINT_INVALID".into());
    }
    let store = Arc::new(
        MemoryStore::new(id.clone(), StoreLimits::default())
            .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?,
    );
    let record = CheckpointRecord::new(
        InitializedCheckpoint {
            identity: id.clone(),
            initialized: true,
            writer_id,
            bytes: bytes.clone(),
        },
        vec![],
    )
    .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
    store
        .publish(0, record)
        .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
    let mut policy = HostPolicy::default();
    policy.extensions = true;
    policy.codecs.tables = true;
    policy.codecs.images = true;
    let mut owner =
        ConversionOwner::open(store.clone(), &id, CachedPermission::LOCAL, policy.clone())
            .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
    let before = owner.service().session().document().checkpoint().bytes;
    let mut limits = LIMITS;
    if let Some(value) = request.get("outputLimit") {
        let n = value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0 && *n <= limits.output_bytes)
            .ok_or("FORMAT_OUTPUT_LIMIT_UNAVAILABLE")?;
        limits.output_bytes = n;
    }
    let spec = JobSpec {
        id: "native-rtf-export",
        profile: writer::PROFILE,
        direction: Direction::Export,
        original: b"",
        filename: "snapshot.rtf",
        media_type: "application/rtf",
        target: None,
        limits,
        timeout: 4000,
        memory_bytes: 32 * 1024 * 1024,
    };
    let pool = JobPool::new(1).unwrap();
    let mut job = PreparedJob::begin(&owner, spec, &pool, Box::new(NativePort), now())
        .map_err(|e| format!("job:{e:?}"))?;
    let captured = format!("{:?}", job.contract().revision);
    // Qualification-only later mutation exercises the same capture/writer;
    // production exports only the admitted checkpoint and rejects this hook.
    #[cfg(feature = "qualification")]
    if let Some(text) = request["laterText"].as_str() {
        let d = owner.service().session().document();
        let node = d
            .snapshot()
            .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?
            .visible[0]
            .id
            .clone();
        let at = d
            .anchor(&node, Utf16Offset(0), Bias::Right)
            .map_err(|_| "FORMAT_CHECKPOINT_INVALID")?;
        let revision = owner.service().read(now()).unwrap().revision;
        let prepared = owner
            .service()
            .prepare_commands(
                &revision,
                &[EditorCommand::Text(TextCommand::Insert {
                    at,
                    text: text.into(),
                })],
                &TextOrigin::new("human").unwrap(),
                now(),
            )
            .map_err(|e| format!("edit:{e:?}"))?;
        owner
            .service_mut()
            .apply(prepared, now())
            .map_err(|e| format!("edit:{e:?}"))?;
    }
    let at_export = owner.service().session().document().checkpoint().bytes;
    let result = writer::export(
        &mut job,
        None,
        request["approveLoss"].as_bool().unwrap_or(false),
        now,
    );
    let unchanged = owner.service().session().document().checkpoint().bytes == at_export;
    let reopened = ConversionOwner::open(store, &id, CachedPermission::LOCAL, policy)
        .map_err(|_| "FORMAT_REOPEN_FAILED")?;
    let reopen = reopened.service().read(0).unwrap().snapshot.visible
        == owner.service().read(0).unwrap().snapshot.visible;
    let current = format!("{:?}", owner.service().read(now()).unwrap().revision);
    Ok(match result {
        Ok(c) => {
            json!({"state":"passed","profile":writer::PROFILE.id,"direction":"export","originalSha256":hash(input),"sourceCheckpointSha256":source_hash,"artifact":c.artifact.bytes(),"artifactSha256":hash(c.artifact.bytes()),"revision":format!("{:?}",c.artifact.revision()),"capturedRevision":captured,"currentRevision":current,"report":report(&c.report),"liveUnchanged":unchanged,"reopen":reopen,"laterEdit":at_export!=before,"activeJobs":pool.active(),"assets":0,"networkCalls":0})
        }
        Err(e) => {
            json!({"state":"rejected","code":e.reason,"report":report(&e.report),"liveUnchanged":unchanged,"reopen":reopen,"activeJobs":pool.active()})
        }
    })
}
pub fn convert(input: &[u8]) -> Value {
    attempt(input)
        .unwrap_or_else(|code| json!({"state":"rejected","code":code,"liveUnchanged":true}))
}
