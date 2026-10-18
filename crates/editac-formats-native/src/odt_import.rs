//! Optional native ODF1.3 import. Media waits for shared atomic original adoption.
use super::*;
use editac_core::modules::assets::*;
use editac_formats::{
    container::Budgets,
    odt::import::{self as odt, OriginalMediaHost},
};
use editac_session::{
    assets::{AssetHost, HostOutcome},
    ports::PortError,
};
#[derive(Default)]
struct Media {
    originals: Vec<Value>,
}
impl AssetHost for Media {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        if r.action != AssetAction::Ingest {
            return Err(PortError::Permission);
        }
        Ok(AssetGrant {
            identity: r.identity.clone(),
            actions: vec![AssetAction::Ingest],
        })
    }
    fn execute(&mut self, _: &str, _: &AssetRequest) -> Result<HostOutcome, PortError> {
        Err(PortError::Permission)
    }
}
impl OriginalMediaHost for Media {
    fn identity(&self, hash: &[u8; 32]) -> Result<AssetIdentity, PortError> {
        Ok(AssetIdentity {
            host: "native-local".into(),
            key: hash.iter().map(|b| format!("{b:02x}")).collect(),
        })
    }
    fn ingest_original(
        &mut self,
        reference: &str,
        r: &AssetRequest,
        bytes: &[u8],
    ) -> Result<HostOutcome, PortError> {
        self.authorize(r)?;
        if r.byte_limit != bytes.len() as u64 || r.identity.key != hash(bytes) {
            return Err(PortError::InvalidRecord);
        }
        self.originals.push(json!({"reference":reference,"identity":{"host":r.identity.host,"key":r.identity.key},"bytes":bytes,"sha256":hash(bytes)}));
        Ok(HostOutcome::Complete)
    }
}
fn diag(d: &odt::Diagnostic) -> Value {
    json!({"code":d.code,"location":d.location,"lossy":d.lossy,"action":d.action})
}
fn diagnostics(r: &odt::Report) -> Value {
    json!({"diagnostics":r.diagnostics.iter().map(diag).collect::<Vec<_>>(),"blocks":r.blocks,"utf16Units":r.utf16_units,"stagedBytes":r.staged_bytes,"work":format!("{:?}",r.work)})
}
#[cfg(feature = "qualification")]
type NativeStore = editac_session::ports::memory::FaultInjectedStore;
#[cfg(not(feature = "qualification"))]
type NativeStore = MemoryStore;
pub fn convert(input: &[u8], args: &[String]) -> Value {
    if !(1..=2).contains(&args.len()) || !matches!(args[0].as_str(), "strict" | "approve-loss") {
        return json!({"state":"rejected","code":"FORMAT_REQUEST_INVALID","liveUnchanged":true});
    }
    #[cfg(not(feature = "qualification"))]
    if args.len() != 1 {
        return json!({"state":"rejected","code":"FORMAT_PROFILE_UNAVAILABLE","liveUnchanged":true});
    }
    let approve_loss = args[0] == "approve-loss";
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
    let store = Arc::new(NativeStore::new(id.clone(), StoreLimits::default()).unwrap());
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
        id: "native-odt",
        profile: odt::PROFILE,
        direction: Direction::Import,
        original: input,
        filename: "input.odt",
        media_type: "application/vnd.oasis.opendocument.text",
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
    let mut media = Media::default();
    let prepared = match odt::prepare(&mut job, Budgets::default(), &mut media, now) {
        Ok(p) => p,
        Err(e) => {
            return json!({"state":"rejected","code":e.code,"report":{"diagnostics":e.diagnostics.iter().map(diag).collect::<Vec<_>>(),"location":e.location,"work":format!("{:?}",e.work)},"liveUnchanged":owner.service().session().document().checkpoint().bytes==before});
        }
    };
    let report = diagnostics(prepared.report());
    // Native shared insertion does not yet atomically adopt prepared originals.
    // Preserve candidates and the caller-owned full source; never insert dangling
    // descriptors or emulate a second document/storage transaction in this adapter.
    if !media.originals.is_empty() {
        job.abort().unwrap();
        return json!({"state":"rejected","code":"FORMAT_NATIVE_ASSET_ADOPTION_UNAVAILABLE","report":report,"mediaCandidates":media.originals,"liveUnchanged":owner.service().session().document().checkpoint().bytes==before,"activeJobs":pool.active(),"originalSha256":hash(input)});
    }
    if !approve_loss && !prepared.report().diagnostics.is_empty() {
        job.abort().unwrap();
        return json!({"state":"rejected","code":"LOSS_APPROVAL","report":report,"liveUnchanged":owner.service().session().document().checkpoint().bytes==before});
    }
    let expected = prepared.blocks().iter().map(|b| json!({"runs":b.runs.iter().map(|r|json!({"text":r.text,"marks":r.marks.iter().map(|m|json!({"mark":format!("{:?}",m.0).to_lowercase(),"href":m.1})).collect::<Vec<_>>()})).collect::<Vec<_>>(),"attributes":attributes(&b.attributes),"containers":b.containers.iter().map(|c|json!({"key":c.0,"style":format!("{:?}",c.1)})).collect::<Vec<_>>()})).collect::<Vec<_>>();
    #[cfg(feature = "qualification")]
    if let Some(mode) = args.get(1) {
        match mode.as_str() {
            "cancel" => job.cancellation().cancel(),
            "denied" => owner.service_mut().set_permission(CachedPermission {
                writable: false,
                expires_at: None,
            }),
            "storage" | "unknown" => store
                .inject(editac_session::ports::memory::InjectedFault {
                    boundary: if mode == "unknown" {
                        editac_session::ports::memory::FaultBoundary::AfterCommit
                    } else {
                        editac_session::ports::memory::FaultBoundary::BeforeCommit
                    },
                    error: PortError::ResourceLimit,
                })
                .unwrap(),
            "stale" => {
                use editac_core::commands::{
                    editor::EditorCommand,
                    text::{TextCommand, TextOrigin},
                };
                let revision = owner.service().read(now()).unwrap().revision;
                let plan = owner
                    .service()
                    .prepare_commands(
                        &revision,
                        &[EditorCommand::Text(TextCommand::Insert {
                            at: job.source().target().unwrap().anchor.clone(),
                            text: "concurrent".into(),
                        })],
                        &TextOrigin::new("native-qualification").unwrap(),
                        now(),
                    )
                    .unwrap();
                owner.service_mut().apply(plan, now()).unwrap();
            }
            _ => {
                job.abort().unwrap();
                return json!({"state":"rejected","code":"FORMAT_REQUEST_INVALID","liveUnchanged":true});
            }
        }
    }
    let before_commit = owner.service().read(now()).unwrap().snapshot.visible;
    if let Err(e) = prepared.commit(&mut job, &mut owner, approve_loss, now()) {
        // Session deliberately retains an unjournaled mutation on storage error.
        // This boundary owns a NEW private candidate: never publish that candidate,
        // retry its write, or present its checkpoint as a completed import.
        drop(owner);
        let recovered = ConversionOwner::open(store.clone(), &id, CachedPermission::LOCAL, policy);
        let unchanged = recovered
            .as_ref()
            .ok()
            .and_then(|o| o.service().read(now()).ok())
            .is_some_and(|r| r.snapshot.visible == before_commit);
        return json!({"state":"rejected","code":if unchanged {e.code.as_str()} else {"FORMAT_RECOVERY_REQUIRED"},"location":e.location,"report":report,"activeJobs":pool.active(),"liveUnchanged":true,"storeUnchanged":unchanged,"candidateDiscarded":true,"checkpointPublished":false});
    }
    let history_groups = owner
        .service()
        .session()
        .document()
        .history_state()
        .undo_groups;
    let updates = owner.service().session().pending_updates().unwrap().len();
    let imported = owner.service().read(now()).unwrap().snapshot;
    let text = |o: &ConversionOwner<NativeStore>| {
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
    json!({"state":"passed","profile":odt::PROFILE.id,"report":report,"lossApproved":approve_loss,"preparedBlocks":expected,"snapshotBlocks":imported.visible.iter().map(|n|json!({"runs":n.runs.iter().map(|r|json!({"text":r.text,"attributes":r.attributes.iter().map(|(k,v)|(k.clone(),{let mut s=String::new();v.to_json(&mut s);serde_json::from_str::<Value>(&s).unwrap()})).collect::<std::collections::BTreeMap<_,_>>()})).collect::<Vec<_>>(),"id":n.id,"parent":n.parent,"kind":n.kind,"listNumber":n.editor.as_ref().and_then(|e|e.number),"attributes":attributes(&n.block_attributes)})).collect::<Vec<_>>(),
        "text":after_text,"historyGroups":history_groups,"updates":updates,"undo":undo,"redo":redo,"reopen":reopen,"commits":1,"activeJobs":pool.active(),"originalSha256":hash(input),
        "epoch":id.epoch,"writerId":reopened.service().session().document().checkpoint().writer_id,"documentId":document_id,"checkpointSha256":hash(&checkpoint),"checkpoint":checkpoint,"assets":0,"networkCalls":0})
}
