use editac_session::service_lifecycle::*;
fn scope() -> ServiceScope {
    ServiceScope {
        document: "d".into(),
        session: "s".into(),
        revision: "r".into(),
        permission: "p".into(),
        authorized: true,
    }
}
fn limits() -> ServiceLimits {
    ServiceLimits {
        concurrency: 1,
        queue: 1,
        bytes: 8,
        items: 2,
        deadline_ms: 100,
    }
}
fn request() -> ServiceRequest {
    ServiceRequest {
        scope: scope(),
        bytes: 8,
        items: 2,
        deadline: 100,
    }
}
fn start(l: &mut ServiceLifecycle) -> ServiceTicket {
    l.start_next(&scope(), 0).unwrap().unwrap().0
}
#[test]
fn shared_scope_vectors() {
    for line in include_str!("../../../tests/architecture/service-lifecycle/scopes.tsv")
        .lines()
        .filter(|l| !l.starts_with('#'))
    {
        let v: Vec<_> = line.split_whitespace().collect();
        let current = ServiceScope {
            document: if v[1] == "-" { "" } else { v[1] }.into(),
            session: v[2].into(),
            revision: v[3].into(),
            permission: v[4].into(),
            authorized: v[5] == "true",
        };
        let expected = match v[6] {
            "ready" => None,
            "invalid" => Some(ServiceOutcome::Invalid),
            "stale-revision" => Some(ServiceOutcome::StaleRevision),
            "replaced-session" => Some(ServiceOutcome::ReplacedSession),
            "permission-loss" => Some(ServiceOutcome::PermissionLoss),
            _ => panic!("unknown vector"),
        };
        assert_eq!(scope().failure(&current), expected, "{}", v[0]);
    }
}
#[test]
fn bounded_fifo_and_explicit_saturation() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    let b = l.admit(request(), &scope(), 0).unwrap();
    assert_eq!(
        l.admit(request(), &scope(), 0),
        Err(ServiceOutcome::Saturated)
    );
    assert_eq!(start(&mut l), a);
    assert!(l.start_next(&scope(), 0).is_none());
    assert_eq!(
        l.complete(a, &scope(), 1, true),
        Some(ServiceOutcome::Ready)
    );
    assert_eq!(start(&mut l), b);
    assert_eq!(
        l.complete(b, &scope(), 2, true),
        Some(ServiceOutcome::Ready)
    );
    assert_eq!(l.state(), (0, 0, false));
}
#[test]
fn cancelled_provider_retains_slot_and_cannot_resurrect() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    start(&mut l);
    assert_eq!(l.cancel(a), Some(ServiceOutcome::Cancelled));
    assert_eq!(l.cancel(a), None);
    let b = l.admit(request(), &scope(), 0).unwrap();
    assert_eq!(
        l.admit(request(), &scope(), 0),
        Err(ServiceOutcome::Saturated)
    );
    assert!(l.start_next(&scope(), 0).is_none());
    assert_eq!(l.complete(a, &scope(), 1, true), None);
    assert_eq!(start(&mut l), b);
}
#[test]
fn queued_cancellation_releases_capacity_without_provider_start() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    start(&mut l);
    let b = l.admit(request(), &scope(), 0).unwrap();
    assert_eq!(l.cancel(b), Some(ServiceOutcome::Cancelled));
    assert_eq!(l.state(), (1, 0, false));
    assert_eq!(
        l.complete(a, &scope(), 1, false),
        Some(ServiceOutcome::ProviderFailed)
    );
}
#[test]
fn silent_scope_changes_reject_completion() {
    for (current, outcome) in [
        (
            ServiceScope {
                revision: "r2".into(),
                ..scope()
            },
            ServiceOutcome::StaleRevision,
        ),
        (
            ServiceScope {
                session: "s2".into(),
                ..scope()
            },
            ServiceOutcome::ReplacedSession,
        ),
        (
            ServiceScope {
                authorized: false,
                ..scope()
            },
            ServiceOutcome::PermissionLoss,
        ),
    ] {
        let mut l = ServiceLifecycle::new(limits()).unwrap();
        let a = l.admit(request(), &scope(), 0).unwrap();
        start(&mut l);
        assert_eq!(l.complete(a, &current, 1, true), Some(outcome));
    }
}
#[test]
fn notified_revocation_settles_running_and_queued_once() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    start(&mut l);
    let b = l.admit(request(), &scope(), 0).unwrap();
    let revoked = ServiceScope {
        authorized: false,
        ..scope()
    };
    assert_eq!(
        l.revalidate(&revoked, 1),
        vec![
            (a, ServiceOutcome::PermissionLoss),
            (b, ServiceOutcome::PermissionLoss)
        ]
    );
    assert!(l.revalidate(&revoked, 1).is_empty());
    assert_eq!(l.complete(a, &scope(), 2, true), None);
}
#[test]
fn disposal_settles_all_work_and_stops_admission() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    start(&mut l);
    let b = l.admit(request(), &scope(), 0).unwrap();
    assert_eq!(
        l.dispose(),
        vec![(a, ServiceOutcome::Disposed), (b, ServiceOutcome::Disposed)]
    );
    assert!(l.dispose().is_empty());
    assert_eq!(
        l.admit(request(), &scope(), 1),
        Err(ServiceOutcome::Disposed)
    );
    assert_eq!(l.complete(a, &scope(), 2, true), None);
    assert_eq!(l.state(), (0, 0, true));
}
#[test]
fn deadlines_release_queued_but_not_running_slots() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    start(&mut l);
    let b = l.admit(request(), &scope(), 0).unwrap();
    assert_eq!(
        l.revalidate(&scope(), 100),
        vec![(a, ServiceOutcome::Deadline), (b, ServiceOutcome::Deadline)]
    );
    assert_eq!(l.state(), (1, 0, false));
    assert_eq!(l.complete(a, &scope(), 101, true), None);
}
#[test]
fn bounds_invalid_scope_and_deadline_fail_before_admission() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    for r in [
        ServiceRequest {
            bytes: 9,
            ..request()
        },
        ServiceRequest {
            items: 3,
            ..request()
        },
    ] {
        assert_eq!(l.admit(r, &scope(), 0), Err(ServiceOutcome::ResourceLimit));
    }
    assert_eq!(
        l.admit(
            ServiceRequest {
                deadline: 101,
                ..request()
            },
            &scope(),
            0
        ),
        Err(ServiceOutcome::Invalid)
    );
    assert_eq!(
        l.admit(request(), &scope(), 100),
        Err(ServiceOutcome::Deadline)
    );
    assert_eq!(l.state(), (0, 0, false));
}
#[test]
fn queued_work_rechecks_scope_before_provider_start() {
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let a = l.admit(request(), &scope(), 0).unwrap();
    assert_eq!(
        l.start_next(
            &ServiceScope {
                revision: "r2".into(),
                ..scope()
            },
            1
        )
        .unwrap()
        .unwrap_err(),
        (a, ServiceOutcome::StaleRevision)
    );
}
#[test]
fn actual_session_acknowledgments_survive_derived_cancellation_and_disposal() {
    use editac_core::{
        Utf16Offset,
        anchors::Bias,
        commands::text::{TextCommand, TextOrigin},
        document::{DocumentIdentity, InitialNode},
    };
    use editac_session::{
        ports::{LocalStore, StoreLimits, memory::MemoryStore},
        session::Session,
    };
    use std::sync::Arc;
    let id = DocumentIdentity::v5(
        "12345678-1234-4234-8234-123456789abc",
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let mut session = Session::create_local(
        store.clone(),
        id.clone(),
        &[InitialNode {
            kind: "block".into(),
            text: "".into(),
        }],
    )
    .unwrap();
    let owner = session.document().snapshot().unwrap().visible[0].id.clone();
    let at = session
        .document()
        .anchor(&owner, Utf16Offset(0), Bias::Right)
        .unwrap();
    let commit = session
        .edit_text(
            &TextCommand::Insert {
                at,
                text: "acknowledged".into(),
            },
            &TextOrigin::new("service:test").unwrap(),
            0,
        )
        .unwrap()
        .unwrap();
    let before = store.recover(&id).unwrap().journal;
    let mut l = ServiceLifecycle::new(limits()).unwrap();
    let ticket = l.admit(request(), &scope(), 0).unwrap();
    start(&mut l);
    l.cancel(ticket);
    l.dispose();
    assert_eq!(store.recover(&id).unwrap().journal, before);
    assert_eq!(store.pending(&id).unwrap()[0].id(), &commit.update);
    assert_eq!(session.state(0).pending_upload, 1);
}
