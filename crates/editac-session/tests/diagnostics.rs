use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    diagnostics::*,
    locator::{Catalog, Locator, LocatorError},
    ports::{memory::*, *},
    service_lifecycle::ServiceOutcome,
    session::*,
};
use std::sync::Arc;
const PRIVATE: &[&str] = &[
    "PRIVATE_DOC_SENTINEL",
    "PRIVATE_TITLE_SENTINEL",
    "https://private-user:PRIVATE_TOKEN_SENTINEL@example.test/file?key=PRIVATE_KEY_SENTINEL",
    "PRIVATE_TOKEN_SENTINEL",
    "PRIVATE_KEY_SENTINEL",
];
fn no_private(value: &str) {
    for seed in PRIVATE {
        assert!(!value.contains(seed), "private seed in support artifact");
    }
}
fn artifact(name: &str, report: &str) {
    if let Ok(output) = std::env::var("EDITAC_ARCHITECTURE_OUTPUT") {
        std::fs::write(std::path::Path::new(&output).join(name), report).unwrap();
    }
}

#[test]
fn exact_store_and_service_recovery_vocabulary() {
    use PortError::*;
    let stores = [
        ("InvalidRecord", InvalidRecord),
        ("Incompatible", Incompatible),
        ("Integrity", Integrity),
        ("Conflict", Conflict),
        ("Sequence", Sequence),
        ("Quota", Quota),
        ("Permission", Permission),
        ("Unavailable", Unavailable),
        ("ResourceLimit", ResourceLimit),
        ("Backpressure", Backpressure),
        ("CommitUnknown", CommitUnknown),
    ];
    let services = [
        ("Ready", ServiceOutcome::Ready),
        ("Invalid", ServiceOutcome::Invalid),
        ("ResourceLimit", ServiceOutcome::ResourceLimit),
        ("Saturated", ServiceOutcome::Saturated),
        ("Cancelled", ServiceOutcome::Cancelled),
        ("Disposed", ServiceOutcome::Disposed),
        ("Deadline", ServiceOutcome::Deadline),
        ("StaleRevision", ServiceOutcome::StaleRevision),
        ("ReplacedSession", ServiceOutcome::ReplacedSession),
        ("PermissionLoss", ServiceOutcome::PermissionLoss),
        ("ProviderFailed", ServiceOutcome::ProviderFailed),
    ];
    let mut seen = std::collections::BTreeSet::new();
    for row in include_str!("../../../tests/architecture/diagnostics/failures.tsv")
        .lines()
        .filter(|l| !l.starts_with('#'))
    {
        let fields: Vec<_> = row.split_whitespace().collect();
        assert_eq!(fields.len(), 4);
        let failure = match fields[0] {
            "store" => store_failure(
                stores
                    .iter()
                    .find(|(name, _)| *name == fields[1])
                    .unwrap()
                    .1,
            ),
            "service" => service_failure(
                services
                    .iter()
                    .find(|(name, _)| *name == fields[1])
                    .unwrap()
                    .1,
            ),
            _ => panic!("unknown boundary"),
        };
        assert!(seen.insert((fields[0], fields[1])));
        assert_eq!(failure.code.code(), fields[2]);
        assert_eq!(failure.recovery.code(), fields[3]);
    }
    assert_eq!(seen.len(), stores.len() + services.len());
}
#[test]
fn actual_store_failure_preserves_unacknowledged_and_acknowledged_work() {
    let mut log = SupportDiagnostics::default();
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ]
    .into_iter()
    .enumerate()
    {
        let (index, boundary) = boundary;
        let id = DocumentIdentity::v5(
            &format!("12345678-1234-4234-8234-{index:012x}"),
            "23456789-2345-4345-8345-23456789abcd",
        )
        .unwrap();
        let store = Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap());
        let mut session = Session::create_local(
            store.clone(),
            id.clone(),
            &[InitialNode {
                kind: "block".into(),
                text: PRIVATE.join(" "),
            }],
        )
        .unwrap();
        let owner = session.document().snapshot().unwrap().visible[0].id.clone();
        let command = |s: &Session<Arc<FaultInjectedStore>>, value: &str| TextCommand::Insert {
            at: s
                .document()
                .anchor(&owner, Utf16Offset(0), Bias::Right)
                .unwrap(),
            text: value.into(),
        };
        let origin = TextOrigin::new(PRIVATE[1]).unwrap();
        let acknowledged = session
            .edit_text(&command(&session, "ACKNOWLEDGED-"), &origin, 0)
            .unwrap()
            .unwrap();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        let error = session
            .edit_text(&command(&session, "RETAINED-"), &origin, 1)
            .unwrap_err();
        let expected = if boundary == FaultBoundary::AfterCommit {
            ErrorCode::CommitUnknown
        } else {
            ErrorCode::Quota
        };
        assert_eq!(
            session_failure(&error),
            Failure {
                code: expected,
                recovery: RecoveryAction::RecoverStore
            }
        );
        let bytes = session.document().checkpoint().bytes;
        log.record_session(&session.state(1), Some(&error), 12);
        let report = log.export();
        no_private(&report);
        assert!(report.contains("\"local\":\"unsaved\""));
        assert!(report.contains("\"readiness\":\"recovery-required\""));
        assert_eq!(
            session.document().checkpoint().bytes,
            bytes,
            "observability cannot mutate recovery state"
        );
        assert!(session.recovery_export().unjournaled.is_some());
        session.recover().unwrap();
        session.recover().unwrap();
        assert_eq!(session.state(2).readiness, Readiness::Ready);
        let journal = store.recover(&id).unwrap().journal;
        assert_eq!(journal.len(), 2);
        assert!(
            journal
                .iter()
                .any(|entry| entry.id() == &acknowledged.update)
        );
        let text: String = session
            .document()
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .flat_map(|n| n.runs.iter().map(|r| r.text.clone()))
            .collect();
        assert!(text.starts_with("RETAINED-ACKNOWLEDGED-"));
        assert!(text.contains(PRIVATE[0]));
        log.record_session(&session.state(2), None, 3);
    }
    artifact("store-support.json", &log.export());
}
#[test]
fn integrity_and_schema_failures_preserve_export_and_do_not_retry_writes() {
    assert_eq!(
        store_failure(PortError::Integrity).recovery,
        RecoveryAction::PreserveExport
    );
    assert_eq!(
        store_failure(PortError::Incompatible).recovery,
        RecoveryAction::MigrationExport
    );
    assert_eq!(
        session_failure(&SessionError::RecoveryRequired).recovery,
        RecoveryAction::RecoverStore
    );
    assert_eq!(
        session_failure(&SessionError::PermissionExpired).recovery,
        RecoveryAction::Reauthorize
    );
    assert_eq!(
        session_failure(&SessionError::ReadOnly).code,
        ErrorCode::PermissionLoss
    );
}
#[test]
fn credential_locator_errors_never_echo_input() {
    let mut log = SupportDiagnostics::default();
    let catalog = Catalog::default();
    for seed in PRIVATE {
        let error = Locator::parse(seed).unwrap_err();
        log.record(Source::Resolver, locator_failure(&error), 1, 0, 0);
        no_private(&error.to_string());
        assert!(catalog.parse(seed).is_err());
    }
    for error in [LocatorError::UnknownAuthority, LocatorError::UnknownAppHost] {
        assert_eq!(
            locator_failure(&error).recovery,
            RecoveryAction::Reauthorize
        );
    }
    no_private(&log.export());
    artifact("locator-support.json", &log.export());
}
#[test]
fn export_is_bounded_and_uses_local_ids_and_clamped_metrics() {
    let mut log = SupportDiagnostics::default();
    for i in 0..1000 {
        assert_eq!(
            log.record(
                Source::Host,
                service_failure(ServiceOutcome::ProviderFailed),
                u64::MAX,
                usize::MAX,
                usize::MAX
            ),
            i + 1
        );
    }
    let report = log.export();
    assert!(report.len() < 32 * 1024);
    assert!(report.contains("\"dropped\":936"));
    assert!(report.contains("\"elapsedMs\":86400000"));
    assert!(report.contains("\"active\":4096"));
    assert!(!report.contains("\"operation\":1,"));
    artifact("bounded-support.json", &report);
}
#[test]
fn derived_error_routes_do_not_claim_durable_commits() {
    let mut log = SupportDiagnostics::default();
    for source in [Source::Resolver, Source::Converter, Source::Host] {
        for status in [
            ServiceOutcome::ProviderFailed,
            ServiceOutcome::PermissionLoss,
            ServiceOutcome::StaleRevision,
            ServiceOutcome::ReplacedSession,
            ServiceOutcome::Saturated,
            ServiceOutcome::Disposed,
        ] {
            log.record(source, service_failure(status), 7, 1, 1);
        }
    }
    let report = log.export();
    no_private(&report);
    assert!(!report.contains("durability"));
    assert!(!report.contains("remotely-committed"));
    artifact("derived-support.json", &report);
}

#[test]
fn frozen_session_overrides_transient_retry_and_bounds_snapshot() {
    let state = SessionState {
        readiness: Readiness::RecoveryRequired,
        local: LocalState::Unsaved,
        pending_upload: usize::MAX,
        remote: RemoteState::SentDurabilityUnknown,
        connection: ConnectionState::Incompatible,
        auth: AuthState::Expired,
        permission: PermissionState::Expired,
        conflict: true,
        recovery_error: Some(PortError::Unavailable),
    };
    let mut log = SupportDiagnostics::default();
    for _ in 0..1000 {
        log.record_session(&state, None, u64::MAX);
    }
    let report = log.export();
    assert!(report.contains("\"recovery\":\"recover-store\""));
    assert!(report.contains("\"pending\":4096"));
    assert!(report.len() < 32 * 1024);
    no_private(&report);
    artifact("session-bounded-support.json", &report);
}
