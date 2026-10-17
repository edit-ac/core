include!("jobs_harness.rs");
fn begin(o: &Owner, original: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Import);
    s.original = original;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut execution = port().0;
    execution.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), execution, 0).unwrap()
}
#[test]
fn ingress_failure_retires_only_owned_staging_and_preserves_session_history_recovery() {
    let (mut o, store) = owner();
    let original = super::input(&[("a.xml", b"<!DOCTYPE p><p/>")]);
    let mut sibling = begin(&o, &super::input(&[("a.xml", b"<p/>")]), "sibling");
    let mut j = begin(&o, &original, "guarded");
    let mut host = Host::default();
    sibling
        .stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    let before = o.service().read(0).unwrap();
    assert_eq!(
        j.prepare_container(super::Budgets::default(), || 0)
            .unwrap_err()
            .code,
        super::Code::Dtd
    );
    assert_eq!(j.source().original(), original);
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    let after = o.service().read(0).unwrap();
    assert_eq!(before.revision, after.revision);
    assert_eq!(current(&o), "base");
    clean(&store, &mut host);
    let cleanup: Vec<_> = host
        .effects
        .iter()
        .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
        .collect();
    assert_eq!(cleanup.len(), 2);
    assert!(cleanup.iter().all(|(id, _)| id.starts_with("guarded_")));
    assert!(
        host.effects
            .iter()
            .filter(|(id, a)| id.starts_with("sibling_")
                && matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count()
            == 0
    );
    let reopened = ConversionOwner::open(
        store.clone(),
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        HostPolicy::default(),
    )
    .unwrap();
    assert_eq!(current(&reopened), "base");
    println!(
        "INGRESS_STAGING effects={} cleanup={} live_commits=0 preserved_sibling=1 original_bytes={}",
        host.effects.len(),
        cleanup.len(),
        original.len()
    );
}
#[test]
fn cancelled_and_expired_jobs_abort_during_real_guard_work() {
    let (o, store) = owner();
    let original = super::input(&[("a.xml", b"<p><a/><b/></p>")]);
    for timeout in [false, true] {
        let mut j = begin(&o, &original, if timeout { "expired" } else { "cancelled" });
        let mut host = Host::default();
        j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
            .unwrap();
        let cancel = j.cancellation();
        let mut calls = 0;
        let e = j
            .prepare_container(super::Budgets::default(), || {
                calls += 1;
                if calls == 8 {
                    if timeout {
                        return 100;
                    }
                    cancel.cancel();
                }
                0
            })
            .unwrap_err();
        assert_eq!(
            e.code,
            if timeout {
                super::Code::Timeout
            } else {
                super::Code::Cancelled
            }
        );
        assert_eq!(calls, 8);
        clean(&store, &mut host);
        assert_eq!(current(&o), "base");
        assert_eq!(j.source().original(), original);
        assert_eq!(
            host.effects
                .iter()
                .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
                .count(),
            2
        );
    }
}
#[test]
fn failed_asset_after_valid_guard_never_commits_and_preserves_recoverable_input() {
    let (mut o, store) = owner();
    let original = super::input(&[("a.xml", b"<p/>")]);
    let mut j = begin(&o, &original, "asset_after_guard");
    let package = j
        .prepare_container(super::Budgets::default(), || 0)
        .unwrap();
    assert!(package.part("a.xml").is_some());
    let mut host = Host {
        fail: true,
        ..Host::default()
    };
    assert!(
        j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
            .is_err()
    );
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    assert_eq!(current(&o), "base");
    assert_eq!(j.source().original(), original);
    host.fail = false;
    clean(&store, &mut host);
    assert_eq!(host.effects.len(), 2);
}
#[test]
fn real_job_rejects_repeated_container_preparation_and_excess_memory_budget() {
    let (mut o, _) = owner();
    let original = super::input(&[("a.xml", b"<p/>")]);
    let mut j = begin(&o, &original, "single_guard");
    j.prepare_container(super::Budgets::default(), || 0)
        .unwrap();
    assert_eq!(
        j.prepare_container(super::Budgets::default(), || 0)
            .unwrap_err()
            .code,
        super::Code::Budget
    );
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    let mut j = begin(&o, &original, "memory_guard");
    assert_eq!(
        j.prepare_container(
            super::Budgets {
                inflated: usize::MAX,
                ..super::Budgets::default()
            },
            || 0
        )
        .unwrap_err()
        .code,
        super::Code::Budget
    );
    assert_eq!(current(&o), "base");
}
#[test]
fn wcf06_actual_media_failure_aborts_own_staging_before_live_commit() {
    let (mut o, store) = owner();
    let bomb = super::generated_png(1, 1, &vec![0; 65536]);
    let original = super::input(&[("a.xml", b"<p/>"), ("a.png", &bomb)]);
    let mut j = begin(&o, &original, "media_failure");
    let mut package = j
        .prepare_container(super::Budgets::default(), || 0)
        .unwrap();
    let mut host = Host::default();
    j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    let before = o.service().read(0).unwrap().revision;
    assert_eq!(
        j.validate_container_media(&mut package, "a.png", || 0)
            .unwrap_err()
            .code,
        super::Code::Budget
    );
    let attempts = package.work().decode_calls;
    assert!(attempts > 0);
    assert!(
        j.validate_container_media(&mut package, "a.png", || 0)
            .is_err()
    );
    assert_eq!(package.work().decode_calls, attempts);
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    assert_eq!(current(&o), "base");
    assert_eq!(before, o.service().read(0).unwrap().revision);
    assert_eq!(j.source().original(), original);
    clean(&store, &mut host);
    assert_eq!(
        host.effects
            .iter()
            .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        2
    );
    assert!(o.service_mut().undo(&before, 0).unwrap().is_none());
    println!(
        "WCF06_JOB_MEDIA work={:?} cleanup_effects=2 live_commits=0 history_steps=0 recovery_bytes={}",
        package.work(),
        original.len()
    );
}
#[test]
fn foreign_package_and_cancel_during_media_work_poison_only_the_target_job() {
    let (o, store) = owner();
    let original = super::input(&[("a.png", super::png())]);
    let mut a = begin(&o, &original, "owner_a");
    let mut p = a
        .prepare_container(super::Budgets::default(), || 0)
        .unwrap();
    let mut b = begin(&o, &original, "owner_b");
    assert_eq!(
        b.validate_container_media(&mut p, "a.png", || 0)
            .unwrap_err()
            .code,
        super::Code::Relationship
    );
    assert_eq!(
        a.validate_container_media(&mut p, "a.png", || 0).unwrap(),
        (1, 1)
    );
    let mut a = begin(&o, &original, "media_cancel");
    let mut p = a
        .prepare_container(super::Budgets::default(), || 0)
        .unwrap();
    let mut host = Host::default();
    a.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    let cancel = a.cancellation();
    let mut calls = 0;
    assert_eq!(
        a.validate_container_media(&mut p, "a.png", || {
            calls += 1;
            if calls == 3 {
                cancel.cancel();
            }
            0
        })
        .unwrap_err()
        .code,
        super::Code::Cancelled
    );
    assert_eq!(calls, 3);
    clean(&store, &mut host);
    assert_eq!(host.effects.len(), 3);
    assert_eq!(current(&o), "base");
}
