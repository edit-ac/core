//! Native macOS Session/Yrs integration with prepared output only; zero provider I/O.
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    extensions::ai::*,
};
use editac_session::{
    ai_proposal::*,
    edit_service::*,
    operations::*,
    ports::{memory::MemoryStore, *},
    session::*,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
type Service = EditService<Arc<MemoryStore>>;
fn fixture() -> Service {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = DocumentIdentity::v5(
        format!(
            "a1220000-0000-4000-8000-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "a1220000-0000-4000-8000-000000000001",
    )
    .unwrap();
    let doc = Document::create(
        CreationPermit::authorize_new(id.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "base".into(),
        }],
    )
    .unwrap();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    store
        .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
        .unwrap();
    EditService::new(
        Session::open(store, &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    )
}
fn request() -> Request {
    Request {
        version: 1,
        request_id: "prepared".into(),
        operation: Operation::Rewrite,
        scope: Scope::Selection,
        instruction: "Rewrite".into(),
        context: "base".into(),
        format: "plain-text".into(),
        output_bytes: 100,
    }
}
fn capture(s: &Service) -> AiProposal {
    AiProposal::capture(
        s,
        request(),
        7,
        "base",
        &[s.read(0).unwrap().snapshot.visible[0].id.clone()],
        0,
        100,
    )
    .unwrap()
}
fn delta(text: &str, sequence: u32) -> Response {
    Response::Delta {
        version: 1,
        request_id: "prepared".into(),
        sequence,
        text: text.into(),
    }
}
fn finish(sequence: u32) -> Response {
    Response::Finish {
        version: 1,
        request_id: "prepared".into(),
        sequence,
        usage: None,
    }
}
fn ready(s: &Service) -> AiProposal {
    let mut p = capture(s);
    p.event(7, delta("שלום 🧪", 0), 1).unwrap();
    p.event(7, finish(1), 2).unwrap();
    p
}
fn host() -> HostOperation {
    HostOperation {
        actor: None,
        origin: OperationOrigin::Agent,
        request_id: "prepared".into(),
    }
}
fn unchanged(s: &Service) -> (Vec<u8>, usize, usize, usize, String) {
    let h = s.session().document().history_state();
    (
        s.session().document().checkpoint().bytes,
        s.operations().len(),
        h.undo_groups,
        h.redo_groups,
        format!("{:?}", s.session().document().current_selection()),
    )
}
fn text(s: &Service) -> String {
    s.read(0)
        .unwrap()
        .snapshot
        .visible
        .iter()
        .flat_map(|n| n.runs.iter().map(|r| r.text.as_str()))
        .collect()
}
fn edit(s: &mut Service, delete: bool) {
    let owner = s.read(0).unwrap().snapshot.visible[0].id.clone();
    let a = s
        .session()
        .document()
        .anchor(&owner, Utf16Offset(0), Bias::Right)
        .unwrap();
    let command = if delete {
        let f = s
            .session()
            .document()
            .anchor(&owner, Utf16Offset(4), Bias::Left)
            .unwrap();
        TextCommand::Delete {
            selection: editac_core::anchors::Selection {
                anchor: a,
                focus: f,
            },
        }
    } else {
        TextCommand::Insert {
            at: a,
            text: "changed".into(),
        }
    };
    let p = s
        .prepare_commands(
            &s.read(0).unwrap().revision,
            &[EditorCommand::Text(command)],
            &TextOrigin::new("fixture").unwrap(),
            0,
        )
        .unwrap();
    s.apply(p, 0).unwrap();
}
#[test]
fn ephemeral_stream_accept_once_origin_undo_redo() {
    let mut s = fixture();
    let before = unchanged(&s);
    let mut p = ready(&s);
    assert_eq!(unchanged(&s), before);
    assert_eq!(p.status(), ProposalStatus::Review);
    p.accept(&mut s, host(), 3).unwrap();
    assert_eq!(text(&s), "שלום 🧪");
    assert_eq!(p.status(), ProposalStatus::Accepted);
    assert_eq!(s.session().document().history_state().undo_groups, 1);
    assert_eq!(
        s.operations().back().unwrap().origin,
        OperationOrigin::Agent
    );
    assert_eq!(
        s.operations().back().unwrap().engine_origin,
        "editac:local:ai:reviewed"
    );
    assert!(p.accept(&mut s, host(), 4).is_err());
    s.undo(&s.read(0).unwrap().revision, 4).unwrap();
    assert_eq!(text(&s), "base");
    s.redo(&s.read(0).unwrap().revision, 5).unwrap();
    assert_eq!(text(&s), "שלום 🧪");
}
fn invalid(events: Vec<Response>, now: u64) {
    let mut s = fixture();
    let before = unchanged(&s);
    let mut p = capture(&s);
    let mut failed = false;
    for event in events {
        if p.event(7, event, now).is_err() {
            failed = true;
            break;
        }
    }
    assert!(failed);
    assert_eq!(p.status(), ProposalStatus::Failed);
    assert!(p.accept(&mut s, host(), now).is_err());
    assert_eq!(unchanged(&s), before);
    assert!(p.recovery_copy().len() <= 100);
}
#[test]
fn duplicate_chunk() {
    invalid(vec![delta("part", 0), delta("duplicate", 0)], 1)
}
#[test]
fn out_of_order_chunk() {
    invalid(vec![delta("part", 1)], 1)
}
#[test]
fn oversized_utf8() {
    invalid(vec![delta(&"é".repeat(51), 0)], 1)
}
#[test]
fn empty_output() {
    invalid(vec![finish(0)], 1)
}
#[test]
fn empty_delta() {
    invalid(vec![delta("", 0)], 1)
}
#[test]
fn timeout() {
    invalid(vec![delta("late", 0)], 100)
}
#[test]
fn invalid_version() {
    invalid(
        vec![Response::Delta {
            version: 2,
            request_id: "prepared".into(),
            sequence: 0,
            text: "bad".into(),
        }],
        1,
    )
}
#[test]
fn wrong_request() {
    invalid(
        vec![Response::Delta {
            version: 1,
            request_id: "other".into(),
            sequence: 0,
            text: "bad".into(),
        }],
        1,
    )
}
#[test]
fn prepared_disconnect() {
    invalid(
        vec![
            delta("part", 0),
            Response::Error {
                version: 1,
                request_id: "prepared".into(),
                sequence: 1,
                code: Error::Transport,
            },
        ],
        1,
    )
}
#[test]
fn cancel_late_result() {
    let mut s = fixture();
    let before = unchanged(&s);
    let mut p = capture(&s);
    p.event(7, delta("part", 0), 1).unwrap();
    p.cancel();
    assert_eq!(p.recovery_copy(), "part");
    assert_eq!(p.event(7, finish(1), 2), Err(Error::Canceled));
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn generation_mismatch_ignored() {
    let s = fixture();
    let mut p = capture(&s);
    assert_eq!(p.event(6, delta("wrong", 0), 1), Err(Error::Canceled));
    assert_eq!(p.recovery_copy(), "");
    p.event(7, delta("correct", 0), 1).unwrap();
    p.event(7, finish(1), 2).unwrap();
    assert_eq!(p.recovery_copy(), "correct");
}
#[test]
fn dispose_releases_review() {
    let mut s = fixture();
    let before = unchanged(&s);
    let mut p = ready(&s);
    p.dispose();
    p.dispose();
    assert_eq!(p.recovery_copy(), "");
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn changed_context_rejects() {
    let mut s = fixture();
    let mut p = ready(&s);
    edit(&mut s, false);
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(p.status(), ProposalStatus::Stale);
    assert_eq!(p.recovery_copy(), "שלום 🧪");
    assert_eq!(unchanged(&s), before);
}
#[test]
fn deleted_target_rejects() {
    let mut s = fixture();
    let mut p = ready(&s);
    edit(&mut s, true);
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn document_switch_rejects() {
    let s = fixture();
    let mut p = ready(&s);
    let mut other = fixture();
    let before = unchanged(&other);
    assert!(p.accept(&mut other, host(), 3).is_err());
    assert_eq!(unchanged(&other), before);
}
#[test]
fn readonly_rejects() {
    let mut s = fixture();
    let mut p = ready(&s);
    s.set_policy(HostPolicy {
        writable: false,
        ..HostPolicy::default()
    });
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn history_view_rejects() {
    let mut s = fixture();
    let mut p = ready(&s);
    s.set_policy(HostPolicy {
        history_view: true,
        ..HostPolicy::default()
    });
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn answer_never_applies() {
    let mut s = fixture();
    let mut r = request();
    r.operation = Operation::Ask;
    let owner = s.read(0).unwrap().snapshot.visible[0].id.clone();
    let mut p = AiProposal::capture(&s, r, 7, "base", &[owner], 0, 100).unwrap();
    p.event(7, delta("answer", 0), 1).unwrap();
    p.event(7, finish(1), 2).unwrap();
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}

#[test]
fn permission_loss_rejects() {
    let mut s = fixture();
    let mut p = ready(&s);
    s.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn expired_permission_rejects() {
    let mut s = fixture();
    let mut p = ready(&s);
    s.set_permission(CachedPermission {
        writable: true,
        expires_at: Some(3),
    });
    let before = unchanged(&s);
    assert!(p.accept(&mut s, host(), 3).is_err());
    assert_eq!(unchanged(&s), before);
}
#[test]
fn terminal_delivery_cannot_reopen() {
    let s = fixture();
    let mut p = ready(&s);
    assert_eq!(p.event(7, delta("late", 2), 3), Err(Error::Canceled));
    assert_eq!(p.status(), ProposalStatus::Review);
    assert_eq!(p.recovery_copy(), "שלום 🧪");
}
#[test]
fn post_commit_store_failure_preserves_real_recovery_state() {
    use editac_session::ports::memory::{FaultBoundary, FaultInjectedStore, InjectedFault};
    let id = DocumentIdentity::v5(
        "a122ffff-0000-4000-8000-000000000001",
        "a1220000-0000-4000-8000-000000000001",
    )
    .unwrap();
    let doc = Document::create(
        CreationPermit::authorize_new(id.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "base".into(),
        }],
    )
    .unwrap();
    let store = Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap());
    store
        .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
        .unwrap();
    let mut s = EditService::new(
        Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    let owner = s.read(0).unwrap().snapshot.visible[0].id.clone();
    let mut p = AiProposal::capture(&s, request(), 7, "base", &[owner], 0, 100).unwrap();
    p.event(7, delta("reviewed", 0), 1).unwrap();
    p.event(7, finish(1), 2).unwrap();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeWrite,
            error: PortError::Unavailable,
        })
        .unwrap();
    let error = p.accept(&mut s, host(), 3).unwrap_err();
    let AiAcceptanceError::Review(error) = error else {
        panic!("missing real review recovery")
    };
    assert_eq!(p.status(), ProposalStatus::RecoveryRequired);
    assert_eq!(error.recovery.proposed.as_deref(), Some("reviewed"));
    let current = error.recovery.current.unwrap();
    assert_eq!(current.visible[0].runs[0].text, "reviewed");
    assert_eq!(s.session().state(3).readiness, Readiness::RecoveryRequired);
    assert!(p.accept(&mut s, host(), 3).is_err());
    s.recover().unwrap();
}
#[test]
fn reopened_same_document_session_cannot_consume_old_proposal() {
    let s = fixture();
    let mut p = ready(&s);
    let id = s.session().document().identity().clone();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    store
        .publish(
            0,
            CheckpointRecord::new(s.session().document().checkpoint(), vec![]).unwrap(),
        )
        .unwrap();
    let mut reopened = EditService::new(
        Session::open(store, &id, CachedPermission::LOCAL).unwrap(),
        HostPolicy::default(),
    );
    assert_ne!(
        s.session().document().writer_id(),
        reopened.session().document().writer_id()
    );
    let before = unchanged(&reopened);
    assert!(p.accept(&mut reopened, host(), 3).is_err());
    assert_eq!(p.status(), ProposalStatus::Stale);
    assert_eq!(unchanged(&reopened), before);
}
