//! RCH-1.12: real Session/store with prepared binary-host responses. No network.
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::{
        editor::{FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    modules::{assets::*, content::Content},
};
use editac_session::{
    assets::*,
    ports::{memory::*, *},
    session::*,
};
use std::{collections::BTreeSet, sync::Arc};
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "ac120000-0000-4000-8000-000000000012",
        "ac120000-0000-4000-8000-000000000001",
    )
    .unwrap()
}
fn asset() -> AssetIdentity {
    AssetIdentity {
        host: "prepared".into(),
        key: "shared_binary".into(),
    }
}
fn request(action: AssetAction, op: &str) -> AssetRequest {
    AssetRequest {
        version: 1,
        operation_id: op.into(),
        identity: asset(),
        action,
        byte_limit: 1024,
    }
}
fn grant(action: AssetAction) -> AssetGrant {
    AssetGrant {
        identity: asset(),
        actions: vec![action],
    }
}
fn descriptor() -> AssetDescriptor {
    AssetDescriptor {
        identity: asset(),
        kind: AssetKind::File,
        metadata: AssetMetadata {
            filename: "notes.txt".into(),
            media_type: "text/plain".into(),
            byte_length: Some(12),
            sha256: None,
            width: None,
            height: None,
            duration_ms: None,
            alt: String::new(),
            caption: String::new(),
        },
        fallback: "notes.txt".into(),
        source: "[notes](inert-original)".into(),
    }
}
fn base() -> CheckpointRecord {
    static BASE: std::sync::OnceLock<CheckpointRecord> = std::sync::OnceLock::new();
    BASE.get_or_init(|| {
        let mut doc = Document::create(
            CreationPermit::authorize_new(identity()).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "".into(),
            }],
        )
        .unwrap();
        let node = doc.snapshot().unwrap().visible[0].id.clone();
        let a = doc.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
        let d = descriptor();
        let prepared = doc
            .prepare_fragment(
                &Selection {
                    anchor: a.clone(),
                    focus: a,
                },
                &[FragmentBlock {
                    attributes: Some(BlockAttributes::Unknown(
                        Content::Asset {
                            descriptor: d.clone(),
                        }
                        .tuple()
                        .unwrap(),
                    )),
                    runs: vec![FragmentRun {
                        opaque_marks: vec![],
                        text: d.fallback,
                        marks: vec![],
                    }],
                    containers: vec![],
                    checked: None,
                }],
                &TextOrigin::new("asset-fixture").unwrap(),
            )
            .unwrap();
        doc.commit_editor(prepared).unwrap();
        CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap()
    })
    .clone()
}
fn memory() -> Arc<MemoryStore> {
    let s = Arc::new(MemoryStore::new(identity(), StoreLimits::default()).unwrap());
    s.publish(0, base()).unwrap();
    s
}
#[derive(Default)]
struct Host {
    ids: BTreeSet<String>,
    calls: usize,
    denied: bool,
    fail: bool,
    releases: usize,
    local_bytes: Option<Vec<u8>>,
    cache_bytes: Option<Vec<u8>>,
}
impl AssetHost for Host {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        if self.denied {
            return Err(PortError::Permission);
        }
        Ok(grant(r.action))
    }
    fn execute(&mut self, reference: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        assert!(!reference.is_empty());
        self.calls += 1;
        if self.fail {
            return Err(PortError::Unavailable);
        }
        if self.ids.insert(r.operation_id.clone()) {
            match r.action {
                AssetAction::Ingest => {
                    assert!(12 <= r.byte_limit);
                    self.local_bytes = Some(b"hello asset!".to_vec());
                }
                AssetAction::Read => assert_eq!(
                    self.local_bytes.as_deref(),
                    Some(b"hello asset!".as_slice())
                ),
                AssetAction::Cache => {
                    let bytes = self.local_bytes.clone().unwrap();
                    assert!(bytes.len() as u64 <= r.byte_limit);
                    self.cache_bytes = Some(bytes);
                }
                AssetAction::ReleaseReference => {
                    self.releases += 1;
                    self.cache_bytes = None;
                }
                _ => {}
            }
        }
        Ok(if r.action == AssetAction::Publish {
            HostOutcome::Published(AssetCommitReceipt {
                operation_id: r.operation_id.clone(),
                identity: r.identity.clone(),
            })
        } else {
            HostOutcome::Complete
        })
    }
}
fn queue<S: AssetStore>(s: &S, action: AssetAction, op: &str) {
    AssetWork::new(s)
        .enqueue("node_ref", request(action, op), &grant(action))
        .unwrap();
}
#[test]
fn host_pipeline_keeps_asset_document_receipts_and_semantics_separate() {
    let store = memory();
    let session = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    let before = session.document().checkpoint().bytes;
    let before_visible = session.document().snapshot().unwrap().visible;
    let history = session.document().history_state();
    let mut host = Host::default();
    for (action, op) in [
        (AssetAction::Ingest, "ingest"),
        (AssetAction::Read, "read"),
        (AssetAction::Cache, "cache"),
        (AssetAction::Publish, "publish"),
    ] {
        queue(&store, action, op);
        assert!(AssetWork::new(&store).run_one(op, true, &mut host).unwrap());
        assert!(!AssetWork::new(&store).run_one(op, true, &mut host).unwrap());
    }
    assert_eq!(host.calls, 4);
    assert_eq!(host.ids.len(), 4);
    assert_eq!(
        host.local_bytes.as_deref(),
        Some(b"hello asset!".as_slice())
    );
    assert_eq!(host.cache_bytes, host.local_bytes);
    assert_eq!(store.pending(&identity()).unwrap().len(), 0);
    assert_eq!(store.generation(&identity()).unwrap(), 1);
    assert_eq!(session.document().checkpoint().bytes, before);
    assert_eq!(
        Session::open(store.clone(), &identity(), CachedPermission::LOCAL)
            .unwrap()
            .document()
            .snapshot()
            .unwrap()
            .visible,
        before_visible
    );
    assert_eq!(session.document().history_state(), history);
    assert!(matches!(
        &store.asset_journal().unwrap().intents()[3].status,
        WorkStatus::Published(_)
    ));
}
#[test]
fn duplicate_intent_is_idempotent_and_reused_id_or_reference_conflicts() {
    let s = memory();
    queue(&s, AssetAction::Publish, "op");
    queue(&s, AssetAction::Publish, "op");
    assert_eq!(s.asset_journal().unwrap().intents().len(), 1);
    assert_eq!(
        AssetWork::new(&s).enqueue(
            "other",
            request(AssetAction::Publish, "op"),
            &grant(AssetAction::Publish)
        ),
        Err(PortError::Conflict)
    );
    let mut r = request(AssetAction::Read, "new");
    r.identity.key = "other".into();
    let g = AssetGrant {
        identity: r.identity.clone(),
        actions: vec![AssetAction::Read],
    };
    assert_eq!(
        AssetWork::new(&s).enqueue("node_ref", r, &g),
        Err(PortError::Conflict)
    );
}
#[test]
fn offline_and_auth_expiry_preserve_pending_work_without_host_execution() {
    let s = memory();
    queue(&s, AssetAction::Publish, "op");
    let mut h = Host::default();
    assert_eq!(
        AssetWork::new(&s).run_one("op", false, &mut h),
        Err(PortError::Unavailable)
    );
    h.denied = true;
    assert_eq!(
        AssetWork::new(&s).run_one("op", true, &mut h),
        Err(PortError::Permission)
    );
    assert_eq!(h.calls, 0);
    assert_eq!(s.asset_journal().unwrap().intents()[0].attempts, 0);
    h.denied = false;
    assert!(AssetWork::new(&s).run_one("op", true, &mut h).unwrap());
}
#[test]
fn failed_upload_retries_only_explicitly_with_same_id_and_bounded_attempts() {
    let s = memory();
    queue(&s, AssetAction::Publish, "op");
    let mut h = Host {
        fail: true,
        ..Host::default()
    };
    for _ in 0..MAX_ATTEMPTS {
        assert_eq!(
            AssetWork::new(&s).run_one("op", true, &mut h),
            Err(PortError::Unavailable)
        );
    }
    assert_eq!(h.calls, MAX_ATTEMPTS as usize);
    assert_eq!(
        AssetWork::new(&s).run_one("op", true, &mut h),
        Err(PortError::Backpressure)
    );
    assert_eq!(
        s.asset_journal().unwrap().intents()[0].status,
        WorkStatus::Pending
    );
}
#[test]
fn canceled_upload_ignores_late_publication_and_releases_only_reference() {
    let s = memory();
    queue(&s, AssetAction::Publish, "op");
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "deleted")
        .unwrap();
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "deleted")
        .unwrap();
    let mut h = Host::default();
    assert!(!AssetWork::new(&s).run_one("op", true, &mut h).unwrap());
    AssetWork::new(&s)
        .complete(
            "op",
            HostOutcome::Published(AssetCommitReceipt {
                operation_id: "op".into(),
                identity: asset(),
            }),
            &grant(AssetAction::Publish),
        )
        .unwrap();
    assert_eq!(
        s.asset_journal().unwrap().intents()[0].status,
        WorkStatus::Canceled
    );
    for op in ["deleted_cancel", "deleted_release"] {
        assert!(AssetWork::new(&s).run_one(op, true, &mut h).unwrap());
    }
    assert_eq!(h.releases, 1);
    assert_eq!(h.calls, 2);
    assert_eq!(
        AssetWork::new(&s).enqueue(
            "node_ref",
            request(AssetAction::Publish, "resurrect"),
            &grant(AssetAction::Publish)
        ),
        Err(PortError::Conflict)
    );
}
#[test]
fn invalid_receipt_or_grant_cannot_settle_publish() {
    let s = memory();
    queue(&s, AssetAction::Publish, "op");
    let w = AssetWork::new(&s);
    assert_eq!(
        w.complete("op", HostOutcome::Complete, &grant(AssetAction::Publish)),
        Err(PortError::Integrity)
    );
    assert_eq!(
        w.complete(
            "op",
            HostOutcome::Published(AssetCommitReceipt {
                operation_id: "wrong".into(),
                identity: asset()
            }),
            &grant(AssetAction::Publish)
        ),
        Err(PortError::Integrity)
    );
    assert_eq!(
        w.enqueue(
            "node_ref",
            request(AssetAction::Read, "read"),
            &grant(AssetAction::Publish)
        ),
        Err(PortError::Permission)
    );
    assert_eq!(
        s.asset_journal().unwrap().intents()[0].status,
        WorkStatus::Pending
    );
}
#[test]
fn cache_budget_rejects_atomically_and_keeps_recovery_state() {
    let s = memory();
    let mut r = request(AssetAction::Cache, "cache");
    r.byte_limit = MAX_CACHE_BYTES;
    AssetWork::new(&s)
        .enqueue("node_ref", r, &grant(AssetAction::Cache))
        .unwrap();
    let before = s.asset_journal().unwrap();
    assert_eq!(
        AssetWork::new(&s).enqueue(
            "node_ref",
            request(AssetAction::Cache, "extra"),
            &grant(AssetAction::Cache)
        ),
        Err(PortError::Quota)
    );
    assert_eq!(s.asset_journal().unwrap(), before);
}
#[test]
fn outbox_is_bounded_without_silent_dedup_or_tombstone_eviction() {
    let s = memory();
    for n in 0..MAX_ASSET_INTENTS - 2 {
        queue(&s, AssetAction::Read, &format!("read_{n}"));
    }
    assert_eq!(
        AssetWork::new(&s).enqueue(
            "node_ref",
            request(AssetAction::Read, "overflow"),
            &grant(AssetAction::Read)
        ),
        Err(PortError::Backpressure)
    );
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "retire")
        .unwrap();
    assert_eq!(
        s.asset_journal().unwrap().intents().len(),
        MAX_ASSET_INTENTS
    );
    assert!(s.asset_journal().unwrap().is_retired("node_ref"));
}
#[test]
fn failed_local_commit_never_dispatches_and_unknown_commit_deduplicates() {
    let s = FaultInjectedStore::new(identity(), StoreLimits::default()).unwrap();
    s.publish(0, base()).unwrap();
    s.inject(InjectedFault {
        boundary: FaultBoundary::BeforeCommit,
        error: PortError::Quota,
    })
    .unwrap();
    assert_eq!(
        AssetWork::new(&s).enqueue(
            "node_ref",
            request(AssetAction::Ingest, "op"),
            &grant(AssetAction::Ingest)
        ),
        Err(PortError::Quota)
    );
    assert!(s.asset_journal().unwrap().intents().is_empty());
    s.inject(InjectedFault {
        boundary: FaultBoundary::AfterCommit,
        error: PortError::Unavailable,
    })
    .unwrap();
    assert_eq!(
        AssetWork::new(&s).enqueue(
            "node_ref",
            request(AssetAction::Ingest, "op"),
            &grant(AssetAction::Ingest)
        ),
        Err(PortError::CommitUnknown)
    );
    queue(&s, AssetAction::Ingest, "op");
    assert_eq!(s.asset_journal().unwrap().intents().len(), 1);
}
#[cfg(feature = "native-store")]
mod native {
    use super::*;
    use editac_session::store::NativeStore;
    struct Fixture {
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let directory = std::env::var_os("EDITAC_ASSET_EVIDENCE")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join(format!("asset-lifecycle-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&directory).unwrap();
            Self {
                path: directory.join("state.sqlite"),
            }
        }
        fn create(&self) -> NativeStore {
            let s =
                NativeStore::create_new(&self.path, identity(), StoreLimits::default()).unwrap();
            s.publish(0, base()).unwrap();
            s
        }
        fn reopen(&self) -> NativeStore {
            NativeStore::open_existing(&self.path, identity(), StoreLimits::default()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if std::env::var_os("EDITAC_ASSET_EVIDENCE").is_none() {
                let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
            }
        }
    }
    #[test]
    fn sqlite_reopen_retains_pending_ids_and_document_checkpoint() {
        let f = Fixture::new();
        let s = f.create();
        queue(&s, AssetAction::Ingest, "ingest");
        queue(&s, AssetAction::Publish, "publish");
        let before = s
            .recover(&identity())
            .unwrap()
            .checkpoint
            .checkpoint()
            .bytes
            .clone();
        drop(s);
        let s = f.reopen();
        let mut h = Host::default();
        assert!(AssetWork::new(&s).run_one("publish", true, &mut h).unwrap());
        drop(s);
        let s = f.reopen();
        assert!(!AssetWork::new(&s).run_one("publish", true, &mut h).unwrap());
        assert_eq!(h.calls, 1);
        assert_eq!(s.pending(&identity()).unwrap().len(), 0);
        assert_eq!(
            s.recover(&identity())
                .unwrap()
                .checkpoint
                .checkpoint()
                .bytes
                .clone(),
            before
        );
    }
    #[test]
    fn sqlite_full_disk_and_unknown_commit_recover_without_duplicate_intent() {
        let f = Fixture::new();
        let s = f.create();
        s.inject_once(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
        assert_eq!(
            AssetWork::new(&s).enqueue(
                "node_ref",
                request(AssetAction::Publish, "op"),
                &grant(AssetAction::Publish)
            ),
            Err(PortError::Quota)
        );
        drop(s);
        let s = f.reopen();
        assert!(s.asset_journal().unwrap().intents().is_empty());
        s.inject_once(InjectedFault {
            boundary: FaultBoundary::AfterCommit,
            error: PortError::Unavailable,
        })
        .unwrap();
        assert_eq!(
            AssetWork::new(&s).enqueue(
                "node_ref",
                request(AssetAction::Publish, "op"),
                &grant(AssetAction::Publish)
            ),
            Err(PortError::CommitUnknown)
        );
        drop(s);
        let s = f.reopen();
        queue(&s, AssetAction::Publish, "op");
        assert_eq!(s.asset_journal().unwrap().intents().len(), 1);
    }
    #[test]
    fn sqlite_deletion_fence_and_cleanup_survive_restart() {
        let f = Fixture::new();
        let s = f.create();
        queue(&s, AssetAction::Publish, "op");
        AssetWork::new(&s)
            .retire("node_ref", &asset(), "deleted")
            .unwrap();
        drop(s);
        let s = f.reopen();
        let mut h = Host::default();
        assert!(!AssetWork::new(&s).run_one("op", true, &mut h).unwrap());
        for op in ["deleted_cancel", "deleted_release"] {
            AssetWork::new(&s).run_one(op, true, &mut h).unwrap();
        }
        assert_eq!(h.calls, 2);
        assert_eq!(h.releases, 1);
    }
}
#[cfg(feature = "native-store")]
#[test]
fn process_crash_rolls_back_before_commit_and_recovers_after_commit() {
    use editac_session::store::NativeStore;
    for (mode, count) in [("before", 0), ("after", 1)] {
        let path = std::env::temp_dir().join(format!(
            "asset-process-{}-{mode}.sqlite",
            std::process::id()
        ));
        let s = NativeStore::create_new(&path, identity(), StoreLimits::default()).unwrap();
        s.publish(0, base()).unwrap();
        drop(s);
        let status = std::process::Command::new(env!("CARGO_BIN_EXE_editac-asset-crash-probe"))
            .arg(&path)
            .arg(mode)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73));
        let s = NativeStore::open_existing(&path, identity(), StoreLimits::default()).unwrap();
        assert_eq!(s.asset_journal().unwrap().intents().len(), count);
        assert_eq!(s.generation(&identity()).unwrap(), 1);
        drop(s);
        std::fs::remove_file(&path).unwrap();
    }
}
#[cfg(feature = "native-store")]
#[test]
fn process_crash_after_host_effect_reuses_id_without_second_publish_intent() {
    use editac_session::store::NativeStore;
    let path = std::env::temp_dir().join(format!("asset-host-crash-{}.sqlite", std::process::id()));
    let s = NativeStore::create_new(&path, identity(), StoreLimits::default()).unwrap();
    s.publish(0, base()).unwrap();
    drop(s);
    std::fs::write(path.with_extension("local-bytes"), b"hello asset!").unwrap();
    std::fs::File::open(path.with_extension("local-bytes"))
        .unwrap()
        .sync_all()
        .unwrap();
    let run = |mode| {
        std::process::Command::new(env!("CARGO_BIN_EXE_editac-asset-crash-probe"))
            .arg(&path)
            .arg(mode)
            .status()
            .unwrap()
    };
    assert_eq!(run("effect").code(), Some(74));
    let s = NativeStore::open_existing(&path, identity(), StoreLimits::default()).unwrap();
    assert_eq!(
        s.asset_journal().unwrap().intents()[0].status,
        WorkStatus::Pending
    );
    drop(s);
    assert_eq!(
        std::fs::read(path.with_extension("local-bytes")).unwrap(),
        b"hello asset!"
    );
    assert!(run("resume").success());
    let s = NativeStore::open_existing(&path, identity(), StoreLimits::default()).unwrap();
    let j = s.asset_journal().unwrap();
    assert_eq!(j.intents().len(), 1);
    assert_eq!(j.intents()[0].attempts, 2);
    assert!(matches!(j.intents()[0].status, WorkStatus::Published(_)));
    assert_eq!(
        std::fs::read_to_string(path.with_extension("host-effect")).unwrap(),
        "crash_op"
    );
    drop(s);
    std::fs::remove_file(path.with_extension("local-bytes")).unwrap();
    std::fs::remove_file(path.with_extension("host-effect")).unwrap();
    std::fs::remove_file(&path).unwrap();
}
#[test]
fn real_session_deletion_then_late_upload_cannot_resurrect_asset() {
    use editac_core::commands::editor::EditorCommand;
    use editac_session::edit_service::{EditService, HostPolicy};
    let s = memory();
    let session = Session::open(s.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    let mut service = EditService::new(
        session,
        HostPolicy {
            extensions: true,
            ..HostPolicy::default()
        },
    );
    let snapshot = service.session().document().snapshot().unwrap();
    let node=snapshot.visible.iter().find(|n| matches!(&n.block_attributes,Some(BlockAttributes::Unknown(t)) if matches!(Content::from_tuple(t),Ok(Some(Content::Asset {..}))))).unwrap();
    let target = node.id.clone();
    let expected = node.block_attributes.as_ref().unwrap().tuple();
    let at = service
        .session()
        .document()
        .anchor(&target, Utf16Offset(0), Bias::Right)
        .unwrap();
    queue(&s, AssetAction::Publish, "upload");
    let before = service.session().document().checkpoint().bytes;
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "deleted")
        .unwrap();
    assert_eq!(service.session().document().checkpoint().bytes, before);
    let revision = service.session().observed_revision().unwrap();
    let prepared = service
        .prepare_commands(
            &revision,
            &[EditorCommand::AtomicContent {
                target,
                expected,
                at,
                replacement: None,
            }],
            &TextOrigin::new("delete-asset").unwrap(),
            0,
        )
        .unwrap();
    service.apply(prepared, 0).unwrap().unwrap();
    let after = service.session().document().checkpoint().bytes;
    assert_ne!(before, after);
    let pending = s.pending(&identity()).unwrap().len();
    assert_eq!(pending, 1);
    AssetWork::new(&s)
        .complete(
            "upload",
            HostOutcome::Published(AssetCommitReceipt {
                operation_id: "upload".into(),
                identity: asset(),
            }),
            &grant(AssetAction::Publish),
        )
        .unwrap();
    let reopened = Session::open(s.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(service.session().document().checkpoint().bytes, after);
    assert_eq!(
        reopened.document().snapshot().unwrap().visible,
        service.session().document().snapshot().unwrap().visible
    );
    assert_eq!(s.pending(&identity()).unwrap().len(), pending);
    assert!(!reopened.document().snapshot().unwrap().visible.iter().any(|n| matches!(&n.block_attributes,Some(BlockAttributes::Unknown(t)) if matches!(Content::from_tuple(t),Ok(Some(Content::Asset {..}))))));
}

#[test]
fn cache_reservation_waits_for_host_release_then_allows_new_work() {
    let s = memory();
    let mut r = request(AssetAction::Cache, "cache");
    r.byte_limit = MAX_CACHE_BYTES;
    AssetWork::new(&s)
        .enqueue("node_ref", r, &grant(AssetAction::Cache))
        .unwrap();
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "retire")
        .unwrap();
    assert_eq!(
        s.asset_journal().unwrap().reserved_cache_bytes(),
        MAX_CACHE_BYTES
    );
    let mut h = Host::default();
    AssetWork::new(&s)
        .run_one("retire_cancel", true, &mut h)
        .unwrap();
    assert_eq!(
        s.asset_journal().unwrap().reserved_cache_bytes(),
        MAX_CACHE_BYTES
    );
    AssetWork::new(&s)
        .run_one("retire_release", true, &mut h)
        .unwrap();
    assert_eq!(s.asset_journal().unwrap().reserved_cache_bytes(), 0);
    let mut r = request(AssetAction::Cache, "cache2");
    r.byte_limit = MAX_CACHE_BYTES;
    AssetWork::new(&s)
        .enqueue("second_ref", r, &grant(AssetAction::Cache))
        .unwrap();
}
#[test]
fn deletion_during_actual_host_dispatch_fences_the_in_flight_completion() {
    struct DeletingHost {
        s: Arc<MemoryStore>,
    }
    impl AssetHost for DeletingHost {
        fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
            Ok(grant(r.action))
        }
        fn execute(
            &mut self,
            _reference: &str,
            r: &AssetRequest,
        ) -> Result<HostOutcome, PortError> {
            AssetWork::new(&self.s).retire("node_ref", &asset(), "during_upload")?;
            Ok(HostOutcome::Published(AssetCommitReceipt {
                operation_id: r.operation_id.clone(),
                identity: r.identity.clone(),
            }))
        }
    }
    let s = memory();
    queue(&s, AssetAction::Publish, "upload");
    AssetWork::new(&s)
        .run_one("upload", true, &mut DeletingHost { s: s.clone() })
        .unwrap();
    let j = s.asset_journal().unwrap();
    assert_eq!(j.intents()[0].status, WorkStatus::Canceled);
    assert_eq!(j.intents().len(), 3);
    assert_eq!(s.pending(&identity()).unwrap().len(), 0);
}
#[test]
fn releasing_one_reference_preserves_shared_host_binary_and_other_reference() {
    struct SharedHost {
        references: BTreeSet<String>,
        binary: Vec<u8>,
    }
    impl AssetHost for SharedHost {
        fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
            Ok(grant(r.action))
        }
        fn execute(&mut self, reference: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
            if r.action == AssetAction::ReleaseReference {
                assert!(self.references.remove(reference));
            }
            Ok(HostOutcome::Complete)
        }
    }
    let s = memory();
    queue(&s, AssetAction::Ingest, "ingest");
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "release")
        .unwrap();
    let mut h = SharedHost {
        references: ["node_ref".into(), "other_document_ref".into()].into(),
        binary: b"shared bytes".to_vec(),
    };
    for op in ["release_cancel", "release_release"] {
        AssetWork::new(&s).run_one(op, true, &mut h).unwrap();
    }
    assert_eq!(h.references, ["other_document_ref".into()].into());
    assert_eq!(h.binary, b"shared bytes");
}

#[test]
fn reference_release_waits_for_acknowledged_host_cancellation() {
    let s = memory();
    queue(&s, AssetAction::Publish, "publish");
    AssetWork::new(&s)
        .retire("node_ref", &asset(), "retire")
        .unwrap();
    let mut h = Host::default();
    assert_eq!(
        AssetWork::new(&s).run_one("retire_release", true, &mut h),
        Err(PortError::Backpressure)
    );
    assert_eq!(h.calls, 0);
    assert_eq!(
        AssetWork::new(&s).complete(
            "retire_release",
            HostOutcome::Complete,
            &grant(AssetAction::ReleaseReference)
        ),
        Err(PortError::Backpressure)
    );
    AssetWork::new(&s)
        .run_one("retire_cancel", true, &mut h)
        .unwrap();
    AssetWork::new(&s)
        .run_one("retire_release", true, &mut h)
        .unwrap();
    assert_eq!(h.releases, 1);
}
