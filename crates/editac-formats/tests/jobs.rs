#![cfg(feature = "jobs")]
include!("support/jobs_harness.rs");
#[test]
fn admission_rejects_pdf_and_unavailable_adapters_before_start() {
    let (o, _) = owner();
    let pool = JobPool::new(1).unwrap();
    for hint in 0..4 {
        let mut s = spec(&o, "reject", Direction::Import);
        match hint {
            0 => s.original = b"%PDF-1.7",
            1 => s.filename = "secret.PDF",
            2 => s.media_type = "application/pdf",
            _ => s.profile = PROFILES[1],
        }
        let (p, starts, _) = port();
        assert!(matches!(
            PreparedJob::begin(&o, s, &pool, p, 0),
            Err(JobError::Admission(Code::ExportOnly))
        ));
        assert_eq!(starts.load(Ordering::SeqCst), 0);
    }
    let mut s = spec(&o, "unavailable", Direction::Export);
    s.profile.available = false;
    assert!(matches!(
        PreparedJob::begin(&o, s, &pool, port().0, 0),
        Err(JobError::Admission(Code::AdapterUnavailable))
    ));
    assert_eq!(pool.active(), 0);
}
#[test]
fn immutable_contract_source_target_hash_and_fixed_snapshot() {
    let (mut o, _) = owner();
    let mut bytes = b"original".to_vec();
    let mut s = spec(&o, "immutable", Direction::Import);
    s.original = &bytes;
    let j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 5).unwrap();
    bytes.fill(b'x');
    edit(&mut o, "later");
    assert_eq!(j.source().original(), b"original");
    assert_eq!(text(j.source().snapshot()), "base");
    assert!(j.source().target().is_some());
    assert_eq!(j.contract().deadline, 105);
    assert_ne!(j.contract().revision, o.service().read(0).unwrap().revision);
}
#[test]
fn isolation_requirements_fail_closed_without_fallback() {
    let (o, _) = owner();
    let pool = JobPool::new(1).unwrap();
    for missing in 0..5 {
        let (mut p, starts, _) = port();
        match missing {
            0 => p.enforcement.isolation = Isolation::Unavailable,
            1 => p.enforcement.watchdog = false,
            2 => p.enforcement.no_network = false,
            3 => p.enforcement.restricted_assets = false,
            _ => p.enforcement.hard_memory_bytes = 1,
        }
        assert!(matches!(
            PreparedJob::begin(&o, spec(&o, "isolation", Direction::Export), &pool, p, 0),
            Err(JobError::IsolationUnavailable)
        ));
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert_eq!(pool.active(), 0);
    }
}
#[test]
fn active_limit_failed_start_drop_and_explicit_cancel_release_execution() {
    let (o, _) = owner();
    let pool = JobPool::new(1).unwrap();
    let (p, _, stops) = port();
    let mut j = PreparedJob::begin(&o, spec(&o, "one", Direction::Export), &pool, p, 0).unwrap();
    assert!(matches!(
        PreparedJob::begin(&o, spec(&o, "two", Direction::Export), &pool, port().0, 0),
        Err(JobError::Busy)
    ));
    j.cancel().unwrap();
    assert_eq!(pool.active(), 0);
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    drop(j);
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    let (mut p, _, stops) = port();
    p.fail = true;
    assert!(PreparedJob::begin(&o, spec(&o, "failed", Direction::Export), &pool, p, 0).is_err());
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(pool.active(), 0);
    let j =
        PreparedJob::begin(&o, spec(&o, "drop", Direction::Export), &pool, port().0, 0).unwrap();
    drop(j);
    assert_eq!(pool.active(), 0);
}
#[test]
fn input_and_memory_budget_fail_before_host_start() {
    let (o, _) = owner();
    let pool = JobPool::new(1).unwrap();
    for case in 0..4 {
        let mut s = spec(&o, "budget", Direction::Export);
        match case {
            0 => s.limits.input_bytes = 1,
            1 => s.limits.nodes = usize::MAX,
            2 => s.memory_bytes = 1,
            _ => s.timeout = u64::MAX,
        }
        let (p, starts, _) = port();
        assert!(PreparedJob::begin(&o, s, &pool, p, 1).is_err());
        assert_eq!(starts.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn failed_output_charge_poisoning_never_exposes_successful_prefix() {
    let (o, _) = owner();
    for case in 0..4 {
        let mut s = spec(&o, "output", Direction::Export);
        s.limits.output_bytes = 4;
        s.limits.nodes = 1;
        s.limits.pages = 1;
        let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
        j.append(b"ok", 1, 1, 0).unwrap();
        let (bytes, n, p) = match case {
            0 => (b"xxx".as_slice(), 0, 0),
            1 => (b"".as_slice(), 1, 0),
            2 => (b"".as_slice(), 0, 1),
            _ => (b"".as_slice(), usize::MAX, 0),
        };
        assert!(matches!(
            j.append(bytes, n, p, 0),
            Err(JobError::ResourceLimit)
        ));
        assert!(j.finish_export(0).is_err());
    }
}
#[test]
fn timeout_and_cancelled_import_leave_document_journal_and_history_unchanged() {
    for cancel in [false, true] {
        let (mut o, store) = owner();
        let before = o.service().session().document().checkpoint().bytes;
        let pending = store
            .pending(o.service().session().document().identity())
            .unwrap();
        let mut j = job(&o, "cancel", Direction::Import);
        if cancel {
            j.cancellation().cancel();
        }
        assert!(
            j.finish_import(&mut o, &blocks("private"), if cancel { 0 } else { 100 })
                .is_err()
        );
        assert_eq!(before, o.service().session().document().checkpoint().bytes);
        assert_eq!(
            pending,
            store
                .pending(o.service().session().document().identity())
                .unwrap()
        );
        let r = o.service().read(0).unwrap().revision;
        assert!(o.service_mut().undo(&r, 0).unwrap().is_none());
    }
}
#[test]
fn import_uses_one_real_session_commit_undo_redo_and_reopen() {
    let (mut o, store) = owner();
    let mut j = job(&o, "import", Direction::Import);
    let receipt = j.finish_import(&mut o, &blocks("α🙂"), 0).unwrap().unwrap();
    assert_eq!(receipt.local_commit.durability, Durability::Volatile);
    assert_eq!(current(&o), "α🙂base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    assert_eq!(current(&o), "α🙂base");
    let id = o.service().session().document().identity().clone();
    drop(o);
    let reopened =
        ConversionOwner::open(store, &id, CachedPermission::LOCAL, HostPolicy::default()).unwrap();
    assert_eq!(current(&reopened), "α🙂base");
    assert!(j.finish_export(0).is_err());
}
#[test]
fn stale_foreign_target_and_current_permission_reject_before_mutation() {
    for case in 0..3 {
        let (mut o, _) = owner();
        let mut j = job(&o, "stale", Direction::Import);
        match case {
            0 => edit(&mut o, "new"),
            1 => o.service_mut().set_policy(HostPolicy {
                writable: false,
                ..HostPolicy::default()
            }),
            _ => o = owner().0,
        }
        let before = o.service().session().document().checkpoint().bytes;
        assert!(j.finish_import(&mut o, &blocks("no"), 0).is_err());
        assert_eq!(before, o.service().session().document().checkpoint().bytes);
    }
}
#[test]
fn asset_failure_poisoning_retains_original_and_never_partially_imports() {
    let (mut o, store) = owner();
    let mut j = job(&o, "asset_failure", Direction::Import);
    let mut host = Host {
        fail: true,
        ..Host::default()
    };
    assert!(
        j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
            .is_err()
    );
    assert!(j.finish_import(&mut o, &blocks("no"), 0).is_err());
    assert_eq!(current(&o), "base");
    assert_eq!(j.source().original(), b"hand-authored local source");
    host.fail = false;
    clean(&store, &mut host);
    assert_eq!(
        host.effects.iter().map(|(_, a)| *a).collect::<Vec<_>>(),
        vec![AssetAction::Cancel, AssetAction::ReleaseReference]
    );
}
#[test]
fn denied_or_invalid_asset_actions_poison_the_job() {
    let (mut o, _) = owner();
    for action in [AssetAction::Publish, AssetAction::Ingest] {
        let mut j = job(&o, "asset_denied", Direction::Import);
        let mut host = Host {
            denied: true,
            ..Host::default()
        };
        assert!(j.stage_asset(asset(), action, 12, &mut host, 0).is_err());
        assert!(j.finish_import(&mut o, &blocks("no"), 0).is_err());
        assert!(host.effects.is_empty());
    }
    assert_eq!(current(&o), "base");
}
#[test]
fn cleanup_releases_only_job_owned_references_not_shared_binary_or_committed_assets() {
    let (mut o, store) = owner();
    let mut host = Host::default();
    o.service_mut().set_policy(HostPolicy {
        extensions: true,
        ..HostPolicy::default()
    });
    let mut committed = job(&o, "committed", Direction::Import);
    committed
        .stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    committed.finish_import(&mut o, &asset_blocks(), 0).unwrap();
    let mut cancelled = job(&o, "aborted", Direction::Import);
    cancelled
        .stage_asset(asset(), AssetAction::Cache, 12, &mut host, 0)
        .unwrap();
    cancelled.cancel().unwrap();
    clean(&store, &mut host);
    assert!(
        host.effects
            .iter()
            .filter(|(_, a)| *a == AssetAction::ReleaseReference)
            .all(|(r, _)| r.starts_with("aborted_j"))
    );
    let journal = store.asset_journal().unwrap();
    assert!(
        journal
            .intents()
            .iter()
            .filter(|i| i.reference.starts_with("committed_j"))
            .all(|i| !journal.is_retired(&i.reference))
    );
    assert!(
        journal
            .intents()
            .iter()
            .filter(|i| i.reference.starts_with("aborted_j"))
            .all(|i| journal.is_retired(&i.reference))
    );
    assert!(current(&o).contains("notes.txt"));
}
#[test]
fn successful_export_retires_temporary_asset_references_and_drop_cleans_import() {
    let (o, store) = owner();
    let mut host = Host::default();
    let mut j = job(&o, "export_assets", Direction::Export);
    j.stage_asset(asset(), AssetAction::Read, 12, &mut host, 0)
        .unwrap();
    j.append(b"complete", 1, 1, 0).unwrap();
    let artifact = j.finish_export(0).unwrap();
    assert_eq!(artifact.bytes(), b"complete");
    let mut j = job(&o, "dropped_assets", Direction::Import);
    j.stage_asset(asset(), AssetAction::Cache, 12, &mut host, 0)
        .unwrap();
    drop(j);
    clean(&store, &mut host);
    assert_eq!(
        host.effects
            .iter()
            .filter(|(_, a)| *a == AssetAction::ReleaseReference)
            .count(),
        2
    );
    assert_eq!(current(&o), "base");
}
#[derive(Default)]
struct Sink {
    fail: Option<SaveFailure>,
    writes: usize,
    closes: usize,
    last_valid: Vec<u8>,
    staged: Vec<u8>,
}
impl ArtifactSink for Sink {
    fn write(&mut self, bytes: &[u8]) -> Result<(), SaveFailure> {
        self.writes += 1;
        self.staged = bytes.to_vec();
        if self.fail == Some(SaveFailure::Write) {
            Err(SaveFailure::Write)
        } else {
            Ok(())
        }
    }
    fn close(&mut self) -> Result<(), SaveFailure> {
        self.closes += 1;
        if self.fail == Some(SaveFailure::Close) {
            Err(SaveFailure::Close)
        } else {
            self.last_valid = std::mem::take(&mut self.staged);
            Ok(())
        }
    }
}
fn export(o: &Owner, id: &str) -> (SaveTransition, ExportArtifact) {
    let mut j = job(o, id, Direction::Export);
    let transition = SaveTransition::begin(&j).unwrap();
    let captured = text(j.source().snapshot());
    j.append(captured.as_bytes(), 1, 1, 0).unwrap();
    (transition, j.finish_export(0).unwrap())
}
#[test]
fn wcf03_picker_write_close_failures_preserve_live_recovery_and_last_valid_artifact() {
    let (o, _) = owner();
    let revision = o.service().read(0).unwrap().revision;
    for (case, failure) in [
        ("picker-cancel", SaveFailure::PickerCancelled),
        ("write-failure", SaveFailure::Write),
        ("close-failure", SaveFailure::Close),
    ] {
        let (mut transition, artifact) = export(&o, case);
        let mut sink = Sink {
            fail: Some(failure),
            last_valid: b"last-valid".to_vec(),
            ..Sink::default()
        };
        if failure == SaveFailure::PickerCancelled {
            assert_eq!(transition.cancel(), Err(failure));
            assert_eq!(
                transition.write_and_close(&artifact, &revision, &mut sink),
                Err(SaveFailure::AlreadyFinished)
            );
        } else {
            assert_eq!(
                transition.write_and_close(&artifact, &revision, &mut sink),
                Err(failure)
            );
        }
        assert_eq!(sink.last_valid, b"last-valid");
        assert_eq!(artifact.bytes(), b"base");
        assert_eq!(current(&o), "base");
        assert!(o.service().session().recovery_export().locally_committed);
        println!(
            "WCF03 {case}: bytes={} nodes={} pages={} writes={} closes={} semanticEffects=0 transitions=0",
            artifact.work().bytes,
            artifact.work().nodes,
            artifact.work().pages,
            sink.writes,
            sink.closes
        );
    }
}
#[test]
fn wcf03_revision_completion_duplicates_and_later_edits() {
    let (mut o, _) = owner();
    let (mut transition, artifact) = export(&o, "revision-N-success");
    let mut sink = Sink::default();
    let r = o.service().read(0).unwrap().revision;
    assert!(
        transition
            .write_and_close(&artifact, &r, &mut sink)
            .unwrap()
    );
    assert_eq!(
        transition.write_and_close(&artifact, &r, &mut sink),
        Err(SaveFailure::AlreadyFinished)
    );
    assert_eq!(sink.writes, 1);
    let mut j = job(&o, "revision-N-plus-one", Direction::Export);
    let mut transition = SaveTransition::begin(&j).unwrap();
    edit(&mut o, "later");
    assert_eq!(text(j.source().snapshot()), "base");
    j.append(text(j.source().snapshot()).as_bytes(), 1, 1, 0)
        .unwrap();
    let artifact = j.finish_export(0).unwrap();
    let r = o.service().read(0).unwrap().revision;
    assert!(
        !transition
            .write_and_close(&artifact, &r, &mut Sink::default())
            .unwrap()
    );
    assert_eq!(artifact.bytes(), b"base");
    assert_eq!(current(&o), "laterbase");
    println!(
        "WCF03 revision-N-success/duplicate-completion/revision-N-plus-one: writes=2 duplicateWrites=0 currentRevisionTransitions=1 newerRevisionTransitions=0"
    );
}
#[test]
fn wcf03_foreign_job_and_session_completions_do_not_write_or_transition() {
    let (o, _) = owner();
    let (mut transition, _) = export(&o, "same_job");
    let (_, wrong_job) = export(&o, "other_job");
    let (other, _) = owner();
    let (_, wrong_session) = export(&other, "same_job");
    let r = o.service().read(0).unwrap().revision;
    let mut sink = Sink::default();
    for artifact in [&wrong_job, &wrong_session] {
        assert_eq!(
            transition.write_and_close(artifact, &r, &mut sink),
            Err(SaveFailure::Correlation)
        );
    }
    assert_eq!(sink.writes, 0);
    assert_eq!(sink.closes, 0);
    println!("WCF03 other-job/other-session: writes=0 closes=0 transitions=0");
}
#[test]
fn wcf03_fixture_names_are_complete_and_distinct() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/formats/jobs/wcf03.json")).unwrap();
    let names: BTreeSet<_> = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        BTreeSet::from([
            "picker-cancel",
            "write-failure",
            "close-failure",
            "revision-N-success",
            "revision-N-plus-one",
            "duplicate-completion",
            "other-job",
            "other-session"
        ])
    );
}

fn asset_blocks() -> Vec<FragmentBlock> {
    let descriptor = AssetDescriptor {
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
    };
    vec![FragmentBlock {
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: descriptor.fallback.clone(),
            marks: vec![],
        }],
        attributes: Some(editac_core::document::BlockAttributes::Unknown(
            editac_core::modules::content::Content::Asset { descriptor }
                .tuple()
                .unwrap(),
        )),
        containers: vec![],
        checked: None,
    }]
}

#[test]
fn reused_job_ids_have_distinct_completion_tokens_and_asset_references() {
    let (o, store) = owner();
    let (mut transition, _) = export(&o, "reused");
    let (_, late) = export(&o, "reused");
    assert_eq!(
        transition.write_and_close(
            &late,
            &o.service().read(0).unwrap().revision,
            &mut Sink::default()
        ),
        Err(SaveFailure::Correlation)
    );
    let mut a = job(&o, "same", Direction::Import);
    let mut b = job(&o, "same", Direction::Import);
    let mut host = Host::default();
    a.stage_asset(asset(), AssetAction::Cache, 12, &mut host, 0)
        .unwrap();
    b.stage_asset(asset(), AssetAction::Cache, 12, &mut host, 0)
        .unwrap();
    let journal = store.asset_journal().unwrap();
    assert_eq!(journal.intents().len(), 2);
    assert_ne!(
        journal.intents()[0].reference,
        journal.intents()[1].reference
    );
    a.cancel().unwrap();
    let journal = store.asset_journal().unwrap();
    assert_eq!(
        journal
            .intents()
            .iter()
            .filter(|i| journal.is_retired(&i.reference) && i.request.action == AssetAction::Cache)
            .count(),
        1
    );
}
#[test]
fn cumulative_asset_reservations_check_before_host_work_and_cleanup_unused_staging() {
    let (mut o, store) = owner();
    let mut s = spec(&o, "aggregate", Direction::Import);
    s.limits.input_bytes = 30;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    let mut host = Host::default();
    j.stage_asset(asset(), AssetAction::Read, 20, &mut host, 0)
        .unwrap();
    assert_eq!(j.asset_bytes(), 20);
    assert!(
        j.stage_asset(asset(), AssetAction::Read, 20, &mut host, 0)
            .is_err()
    );
    assert_eq!(host.effects.len(), 1);
    assert!(j.finish_import(&mut o, &blocks("no"), 0).is_err());
    assert_eq!(current(&o), "base");
    clean(&store, &mut host);
    let mut j = job(&o, "unused", Direction::Import);
    j.stage_asset(asset(), AssetAction::Read, 12, &mut host, 0)
        .unwrap();
    let result = j
        .finish_import(&mut o, &blocks("text"), 0)
        .unwrap()
        .unwrap();
    assert!(result.assets.is_empty());
    clean(&store, &mut host);
    assert!(
        host.effects
            .iter()
            .any(|(r, a)| r.starts_with("unused_j") && *a == AssetAction::ReleaseReference)
    );
}
#[test]
fn full_fragment_metadata_budget_is_checked_before_semantic_commit() {
    let (mut o, _) = owner();
    let mut s = spec(&o, "metadata", Direction::Import);
    s.limits.output_bytes = 128;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    assert!(matches!(
        j.finish_import(&mut o, &asset_blocks(), 0),
        Err(JobError::ResourceLimit)
    ));
    assert_eq!(current(&o), "base");
}
#[test]
fn cleanup_persistence_failure_preserves_exact_retry_handles_and_scoped_fences() {
    for boundary in [FaultBoundary::BeforeCommit, FaultBoundary::AfterCommit] {
        let id = identity();
        let store = Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap());
        let o = ConversionOwner::create(
            store.clone(),
            id,
            &[InitialNode {
                kind: "block".into(),
                text: "recoverable".into(),
            }],
            HostPolicy::default(),
        )
        .unwrap();
        let fake = owner().0;
        let s = spec(&fake, "cleanup_failure", Direction::Export);
        let pool = JobPool::new(1).unwrap();
        let (p, _, stops) = port();
        let mut j = PreparedJob::begin(&o, s, &pool, p, 0).unwrap();
        let mut host = Host::default();
        j.stage_asset(asset(), AssetAction::Read, 12, &mut host, 0)
            .unwrap();
        let reference = store.asset_journal().unwrap().intents()[0]
            .reference
            .clone();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::ResourceLimit,
            })
            .unwrap();
        assert!(j.cancel().is_err());
        assert_eq!(pool.active(), 0);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        j.abort().unwrap();
        let journal = store.asset_journal().unwrap();
        assert!(journal.is_retired(&reference));
        assert_eq!(
            journal
                .intents()
                .iter()
                .filter(|i| i.request.action == AssetAction::Cancel)
                .count(),
            1
        );
        assert_eq!(
            journal
                .intents()
                .iter()
                .filter(|i| i.request.action == AssetAction::ReleaseReference)
                .count(),
            1
        );
        assert_eq!(text(&o.service().read(0).unwrap().snapshot), "recoverable");
    }
}
