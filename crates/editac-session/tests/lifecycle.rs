mod support;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::TextCommand,
    document::{DocumentIdentity, InitialNode},
};
use editac_session::{
    locator::*,
    ports::{memory::*, *},
    session::*,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use support::{origin, owner, text};

fn identity() -> DocumentIdentity {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    DocumentIdentity::v5(
        &format!("12345678-1234-4234-8234-{n:012x}"),
        "23456789-2345-4345-8345-23456789abcd",
    )
    .unwrap()
}
fn initial() -> Vec<InitialNode> {
    vec![InitialNode {
        kind: "block".into(),
        text: String::new(),
    }]
}
fn memory(id: &DocumentIdentity) -> Arc<MemoryStore> {
    Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap())
}
fn fault(id: &DocumentIdentity) -> Arc<FaultInjectedStore> {
    Arc::new(FaultInjectedStore::new(id.clone(), StoreLimits::default()).unwrap())
}
fn insert<S: SessionStore>(
    session: &mut Session<S>,
    value: &str,
    now: u64,
) -> Result<Option<LocalCommit>, SessionError> {
    let at = session
        .document()
        .anchor(&owner(session.document()), Utf16Offset(0), Bias::Right)
        .unwrap();
    session.edit_text(
        &TextCommand::Insert {
            at,
            text: value.into(),
        },
        &origin(),
        now,
    )
}

#[derive(Default)]
struct Wire {
    sent: Vec<TransportFrame>,
    state: Option<ConnectionState>,
}
struct PreparedTransport {
    wire: Arc<Mutex<Wire>>,
    receipts: ReceiptCapability,
    max_frame: usize,
}
impl Transport for PreparedTransport {
    fn state(&self) -> ConnectionState {
        self.wire
            .lock()
            .unwrap()
            .state
            .unwrap_or(ConnectionState::Authorized)
    }
    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            receipts: self.receipts,
            max_frame_bytes: self.max_frame,
            max_queue_bytes: 16 * 1024 * 1024,
            max_queue_frames: 16,
        }
    }
    fn send(&mut self, frame: TransportFrame) -> Result<(), PortError> {
        if self.state() != ConnectionState::Authorized {
            return Err(PortError::Permission);
        }
        let mut wire = self.wire.lock().unwrap();
        if wire.sent.len() >= 16 {
            return Err(PortError::Backpressure);
        }
        wire.sent.push(frame);
        Ok(())
    }
    fn receive(&mut self) -> Result<Option<TransportFrame>, PortError> {
        Ok(None)
    }
}
fn transport(receipts: ReceiptCapability) -> (Box<dyn Transport>, Arc<Mutex<Wire>>) {
    let wire = Arc::new(Mutex::new(Wire::default()));
    (
        Box::new(PreparedTransport {
            wire: wire.clone(),
            receipts,
            max_frame: 16 * 1024 * 1024,
        }),
        wire,
    )
}
fn offline_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    assert_eq!(session.state(0).connection, ConnectionState::Disconnected);
    assert_eq!(session.state(0).auth, AuthState::Detached);
    assert_eq!(text(session.document()), "");
    let first_owner = owner(session.document());
    let first_writer = session.document().writer_id();
    let commit = insert(&mut session, "a😀b", 0).unwrap().unwrap();
    assert_eq!(
        session.state(0).local,
        LocalState::Committed(store.capabilities().durability)
    );
    assert_eq!(session.state(0).pending_upload, 1);
    assert_eq!(session.state(0).remote, RemoteState::Unknown);
    assert_eq!(commit.update.writer, first_writer);
    session.undo(0).unwrap().unwrap();
    assert_eq!(text(session.document()), "");
    session.redo(0).unwrap().unwrap();
    assert_eq!(text(session.document()), "a😀b");
    assert_eq!(session.state(0).pending_upload, 3);
    assert_eq!(store.recover(&id).unwrap().journal.len(), 3);
    drop(session);
    // Idempotent creation of an existing document ignores proposed initial content.
    let session = Session::create_local(
        store.clone(),
        id.clone(),
        &[InitialNode {
            kind: "block".into(),
            text: "do not replace".into(),
        }],
    )
    .unwrap();
    assert_eq!(text(session.document()), "a😀b");
    assert_eq!(owner(session.document()), first_owner);
    assert_ne!(session.document().writer_id(), first_writer);
    assert_eq!(session.state(0).pending_upload, 3);
    assert_eq!(session.state(0).remote, RemoteState::Unknown);
}
fn cached_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    let local_owner = owner(session.document());
    drop(session);
    let mut catalog = Catalog::default();
    catalog.configure_authority("team").unwrap();
    let locator = Locator::parse(&format!("ac://team/{}", id.document_id)).unwrap();
    catalog
        .insert(
            locator.clone(),
            CatalogEntry {
                identity: id,
                source: SourceBinding::Hosted { cached: true },
                access: AccessState::Allowed,
            },
        )
        .unwrap();
    session = Session::open_locator(
        store,
        &catalog,
        &locator,
        CachedPermission {
            writable: true,
            expires_at: Some(10),
        },
    )
    .unwrap();
    assert_eq!(text(session.document()), "");
    assert_eq!(owner(session.document()), local_owner);
    insert(&mut session, "cached", 9).unwrap();
    let before = session.document().checkpoint().bytes;
    assert_eq!(
        insert(&mut session, "expired", 10).unwrap_err(),
        SessionError::PermissionExpired
    );
    assert_eq!(
        session.undo(10).unwrap_err(),
        SessionError::PermissionExpired
    );
    assert_eq!(
        session.redo(10).unwrap_err(),
        SessionError::PermissionExpired
    );
    assert_eq!(session.document().checkpoint().bytes, before);
    assert_eq!(session.state(10).pending_upload, 1);
    assert_eq!(session.state(10).permission, PermissionState::Expired);
    session.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    assert_eq!(
        insert(&mut session, "denied", 11).unwrap_err(),
        SessionError::ReadOnly
    );
    assert_eq!(session.undo(11).unwrap_err(), SessionError::ReadOnly);
    assert_eq!(session.redo(11).unwrap_err(), SessionError::ReadOnly);
    session.set_permission(CachedPermission::LOCAL);
    session.undo(11).unwrap();
    assert_eq!(text(session.document()), "");
}
fn auth_case<S: SessionStore>(store: Arc<S>, id: DocumentIdentity) {
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    insert(&mut session, "pending", 0).unwrap();
    let (port, wire) = transport(ReceiptCapability::DurableV1);
    session.attach_transport(port, 10, 0).unwrap();
    assert_eq!(session.flush_pending(9).unwrap(), 1);
    assert_eq!(session.state(9).remote, RemoteState::SentDurabilityUnknown);
    let receipt = DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: store.pending(&id).unwrap()[0].id().clone(),
    };
    assert_eq!(
        session.flush_pending(10).unwrap_err(),
        SessionError::Unauthorized
    );
    assert_eq!(
        session.accept_receipt(receipt.clone(), 10).unwrap_err(),
        SessionError::Unauthorized
    );
    assert_eq!(session.state(10).auth, AuthState::Expired);
    assert_eq!(session.state(10).pending_upload, 1);
    assert_ne!(session.state(10).remote, RemoteState::RemotelyCommitted);
    assert_eq!(wire.lock().unwrap().sent.len(), 1);
    // Independent unexpired cached permission still admits offline local edits.
    insert(&mut session, "local-", 10).unwrap();
    assert_eq!(text(session.document()), "local-pending");
    session.detach_transport();
    assert_eq!(session.state(10).auth, AuthState::Detached);
    let (port, _) = transport(ReceiptCapability::DurableV1);
    session.attach_transport(port, 20, 10).unwrap();
    assert_eq!(
        session.accept_receipt(receipt, 10).unwrap(),
        ReceiptResult::RemoteCommitted
    );
    assert_eq!(session.state(10).pending_upload, 1);
    assert_ne!(session.state(10).remote, RemoteState::RemotelyCommitted);
    let receipt = DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: store.pending(&id).unwrap()[0].id().clone(),
    };
    session.accept_receipt(receipt, 10).unwrap();
    assert_eq!(session.state(10).remote, RemoteState::RemotelyCommitted);
    assert_eq!(session.state(10).pending_upload, 0);
    drop(session);
    let session = Session::open(store, &id, CachedPermission::LOCAL).unwrap();
    assert_eq!(session.state(30).remote, RemoteState::RemotelyCommitted);
    assert_eq!(session.state(30).auth, AuthState::Detached);
    assert_eq!(text(session.document()), "local-pending");
}
macro_rules! shared_cases {
    ($module:ident, $factory:ident) => {
        mod $module {
            use super::*;
            #[test]
            fn offline_creation_edit_history_and_idempotent_reopen() {
                let id = identity();
                offline_case($factory(&id), id);
            }
            #[test]
            fn cached_initialized_empty_readonly_and_lease_expiry() {
                let id = identity();
                cached_case($factory(&id), id);
            }
            #[test]
            fn auth_expiry_preserves_outbox_and_exact_receipts() {
                let id = identity();
                auth_case($factory(&id), id);
            }
        }
    };
}
shared_cases!(memory_lifecycle, memory);
shared_cases!(fault_lifecycle, fault);
#[cfg(feature = "native-store")]
fn native(id: &DocumentIdentity) -> Arc<editac_session::store::NativeStore> {
    let directory = std::path::PathBuf::from(
        std::env::var_os("EDITAC_LIFECYCLE_EVIDENCE")
            .expect("native lifecycle requires its task-owned evidence directory"),
    );
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{}-{}.sqlite", std::process::id(), id.document_id));
    Arc::new(
        editac_session::store::NativeStore::create_new(path, id.clone(), StoreLimits::default())
            .unwrap(),
    )
}
#[cfg(feature = "native-store")]
shared_cases!(native_lifecycle, native);

#[test]
fn uncached_hosted_and_missing_catalog_never_initialize_or_fetch() {
    let id = identity();
    let store = memory(&id);
    let mut catalog = Catalog::default();
    catalog.configure_authority("team").unwrap();
    let locator = Locator::parse(&format!("ac://team/{}", id.document_id)).unwrap();
    assert!(matches!(
        Session::open_locator(store.clone(), &catalog, &locator, CachedPermission::LOCAL),
        Err(SessionError::Unavailable)
    ));
    catalog
        .insert(
            locator.clone(),
            CatalogEntry {
                identity: id.clone(),
                source: SourceBinding::Hosted { cached: false },
                access: AccessState::Allowed,
            },
        )
        .unwrap();
    assert!(matches!(
        Session::open_locator(store.clone(), &catalog, &locator, CachedPermission::LOCAL),
        Err(SessionError::Unavailable)
    ));
    assert_eq!(store.generation(&id).unwrap(), 0);
    assert!(store.pending(&id).unwrap().is_empty());
    assert!(matches!(
        Session::open(store, &id, CachedPermission::LOCAL),
        Err(SessionError::Store(PortError::Integrity))
    ));
}
#[test]
fn locked_unauthorized_and_incompatible_catalog_reject() {
    for (access, expected) in [
        (AccessState::Locked, SessionError::Locked),
        (AccessState::Unauthorized, SessionError::Unauthorized),
        (AccessState::Incompatible, SessionError::Incompatible),
    ] {
        let id = identity();
        let store = memory(&id);
        let mut catalog = Catalog::default();
        let locator = Locator::parse(&format!("ac://{}", id.document_id)).unwrap();
        catalog
            .insert(
                locator.clone(),
                CatalogEntry {
                    identity: id.clone(),
                    source: SourceBinding::Cached,
                    access,
                },
            )
            .unwrap();
        assert!(
            matches!(Session::open_locator(store.clone(),&catalog,&locator,CachedPermission::LOCAL),Err(e) if e==expected)
        );
        assert_eq!(store.generation(&id).unwrap(), 0);
    }
}
#[test]
fn persistence_failure_freezes_all_mutations_and_publication_until_exact_recovery() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let id = identity();
        let store = fault(&id);
        let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
        insert(&mut session, "durable", 0).unwrap();
        let (port, wire) = transport(ReceiptCapability::DurableV1);
        session.attach_transport(port, 100, 0).unwrap();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(matches!(
            insert(&mut session, "retained-", 1),
            Err(SessionError::Store(_))
        ));
        assert_eq!(text(session.document()), "retained-durable");
        assert_eq!(session.state(1).readiness, Readiness::RecoveryRequired);
        assert_eq!(session.state(1).local, LocalState::Unsaved);
        let export = session.recovery_export();
        assert!(!export.locally_committed);
        assert!(export.unjournaled.is_some());
        let before = session.document().checkpoint().bytes;
        assert_eq!(
            insert(&mut session, "blocked", 1).unwrap_err(),
            SessionError::RecoveryRequired
        );
        assert_eq!(session.undo(1).unwrap_err(), SessionError::RecoveryRequired);
        assert_eq!(session.redo(1).unwrap_err(), SessionError::RecoveryRequired);
        assert_eq!(
            session.flush_pending(1).unwrap_err(),
            SessionError::RecoveryRequired
        );
        let receipt = DurableReceipt {
            protocol: ReceiptCapability::DurableV1,
            update: store.pending(&id).unwrap()[0].id().clone(),
        };
        assert_eq!(
            session.accept_receipt(receipt, 1).unwrap_err(),
            SessionError::RecoveryRequired
        );
        assert_eq!(session.document().checkpoint().bytes, before);
        assert!(wire.lock().unwrap().sent.is_empty());
        // Even an expired cached write lease cannot prevent settlement of admitted work.
        session.set_permission(CachedPermission {
            writable: true,
            expires_at: Some(2),
        });
        session.recover().unwrap();
        assert_eq!(store.recover(&id).unwrap().journal.len(), 2);
        assert_eq!(session.state(3).pending_upload, 2);
        assert_eq!(session.state(3).readiness, Readiness::Ready);
        assert_eq!(
            insert(&mut session, "expired", 3).unwrap_err(),
            SessionError::PermissionExpired
        );
        session.set_permission(CachedPermission::LOCAL);
        session.undo(3).unwrap();
        assert_eq!(text(session.document()), "durable");
        session.redo(3).unwrap();
        assert_eq!(text(session.document()), "retained-durable");
        session.flush_pending(3).unwrap();
        let restored = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
        assert_eq!(text(restored.document()), "retained-durable");
    }
}
#[test]
fn initialization_failure_never_exposes_ready_or_publishable_empty_document() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let id = identity();
        let store = fault(&id);
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
        assert_eq!(session.state(0).readiness, Readiness::RecoveryRequired);
        assert_eq!(
            insert(&mut session, "blocked", 0).unwrap_err(),
            SessionError::RecoveryRequired
        );
        session.recover().unwrap();
        assert_eq!(session.state(0).readiness, Readiness::Ready);
        insert(&mut session, "recovered", 0).unwrap();
        assert_eq!(
            text(
                Session::open(store, &id, CachedPermission::LOCAL)
                    .unwrap()
                    .document()
            ),
            "recovered"
        );
    }
}
#[test]
fn receipt_transaction_failure_requires_recovery_and_does_not_guess_remote_commit() {
    for boundary in [FaultBoundary::BeforeCommit, FaultBoundary::AfterCommit] {
        let id = identity();
        let store = fault(&id);
        let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
        insert(&mut session, "x", 0).unwrap();
        let (port, _) = transport(ReceiptCapability::DurableV1);
        session.attach_transport(port, 100, 0).unwrap();
        let receipt = DurableReceipt {
            protocol: ReceiptCapability::DurableV1,
            update: store.pending(&id).unwrap()[0].id().clone(),
        };
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(session.accept_receipt(receipt.clone(), 0).is_err());
        assert_eq!(session.state(0).readiness, Readiness::RecoveryRequired);
        assert_ne!(session.state(0).remote, RemoteState::RemotelyCommitted);
        session.recover().unwrap();
        session.accept_receipt(receipt, 0).unwrap();
        assert_eq!(session.state(0).remote, RemoteState::RemotelyCommitted);
    }
}
#[test]
fn transport_disconnect_unknown_receipts_backpressure_and_wrong_scope_preserve_pending() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    insert(&mut session, "x", 0).unwrap();
    let receipt = DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: store.pending(&id).unwrap()[0].id().clone(),
    };
    let (port, wire) = transport(ReceiptCapability::Unknown);
    session.attach_transport(port, 100, 0).unwrap();
    assert_eq!(
        session.accept_receipt(receipt.clone(), 0).unwrap(),
        ReceiptResult::CapabilityUnavailable
    );
    let port = Box::new(PreparedTransport {
        wire: wire.clone(),
        receipts: ReceiptCapability::DurableV1,
        max_frame: 16 * 1024 * 1024,
    });
    session.attach_transport(port, 100, 0).unwrap();
    let mut wrong = receipt.clone();
    wrong.update.identity.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    assert!(session.accept_receipt(wrong, 0).is_err());
    session.recover().unwrap();
    // Decoding the exact baseline update frame with a real peer engine proves portable framing.
    session.flush_pending(0).unwrap();
    let frame = wire.lock().unwrap().sent[0].clone();
    assert_eq!(frame.bytes[0], 2);
    let mut at = 1;
    let mut length = 0usize;
    let mut shift = 0;
    loop {
        let b = frame.bytes[at];
        at += 1;
        length |= ((b & 127) as usize) << shift;
        if b & 128 == 0 {
            break;
        }
        shift += 7;
    }
    assert_eq!(length, frame.bytes.len() - at);
    let recovery = store.recover(&id).unwrap();
    let mut peer =
        editac_core::document::Document::restore(&id, recovery.checkpoint.checkpoint(), &[])
            .unwrap();
    peer.apply_replay(&editac_core::document::ReplayUpdate {
        identity: id.clone(),
        bytes: frame.bytes[at..].to_vec(),
    })
    .unwrap();
    assert_eq!(text(&peer), "x");
    wire.lock().unwrap().state = Some(ConnectionState::Disconnected);
    assert_eq!(
        session.flush_pending(0).unwrap_err(),
        SessionError::Unauthorized
    );
    insert(&mut session, "offline", 0).unwrap();
    assert_eq!(session.state(0).pending_upload, 2);
    wire.lock().unwrap().state = Some(ConnectionState::Authorized);
    for _ in 0..7 {
        session.flush_pending(0).unwrap();
    }
    assert_eq!(
        session.flush_pending(0).unwrap_err(),
        SessionError::Store(PortError::Backpressure)
    );
    assert_eq!(session.state(0).readiness, Readiness::Ready);
    assert_eq!(session.state(0).pending_upload, 2);
}
#[test]
fn corrupt_store_and_wrong_epoch_never_reseed_existing_document() {
    let id = identity();
    let store = fault(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    insert(&mut session, "keep", 0).unwrap();
    drop(session);
    store.corrupt_journal().unwrap();
    assert!(matches!(
        Session::open(store.clone(), &id, CachedPermission::LOCAL),
        Err(SessionError::Store(PortError::Integrity))
    ));
    assert!(Session::create_local(store.clone(), id.clone(), &initial()).is_err());
    let mut wrong = id.clone();
    wrong.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    assert!(matches!(
        Session::open(store.clone(), &wrong, CachedPermission::LOCAL),
        Err(SessionError::Store(PortError::Incompatible))
    ));
    assert_eq!(store.generation(&id).unwrap(), 1);
}
#[test]
fn native_style_writer_reservations_are_shared_and_bounded() {
    let id = identity();
    let store = MemoryStore::new(
        id,
        StoreLimits {
            max_records: 1,
            ..StoreLimits::default()
        },
    )
    .unwrap();
    store.claim_writer(12).unwrap();
    assert_eq!(
        store.clone().claim_writer(12).unwrap_err(),
        PortError::Conflict
    );
    assert_eq!(
        store.claim_writer(13).unwrap_err(),
        PortError::ResourceLimit
    );
    assert_eq!(store.claim_writer(0).unwrap_err(), PortError::InvalidRecord);
}
#[cfg(feature = "native-store")]
#[test]
fn native_reopen_uses_actual_new_connection_and_recovers_failed_local_commit() {
    use editac_session::store::NativeStore;
    let id = identity();
    let store = native(&id);
    let path = store.path().to_path_buf();
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    insert(&mut session, "disk", 0).unwrap();
    store
        .inject_once(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    assert!(insert(&mut session, "retry-", 0).is_err());
    assert_eq!(
        session.flush_pending(0).unwrap_err(),
        SessionError::RecoveryRequired
    );
    session.recover().unwrap();
    assert_eq!(
        session.state(0).local,
        LocalState::Committed(Durability::ProcessCrash)
    );
    let writer = session.document().writer_id();
    drop(session);
    drop(store);
    let store =
        Arc::new(NativeStore::open_existing(&path, id.clone(), StoreLimits::default()).unwrap());
    let mut reopened = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    assert_eq!(text(reopened.document()), "retry-disk");
    assert_ne!(reopened.document().writer_id(), writer);
    assert_eq!(reopened.state(0).pending_upload, 2);
    insert(&mut reopened, "new-", 0).unwrap();
    assert_eq!(store.recover(&id).unwrap().journal.len(), 3);
}

#[test]
fn semantic_checkpoint_fallback_restores_full_tail_without_empty_replacement() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    insert(&mut session, "keep", 0).unwrap();
    let mut invalid = session.document().checkpoint();
    invalid.bytes = vec![255, 255, 255];
    let coverage = store
        .recover(&id)
        .unwrap()
        .journal
        .iter()
        .map(|e| e.id().clone())
        .collect();
    store
        .publish(1, CheckpointRecord::new(invalid, coverage).unwrap())
        .unwrap();
    drop(session);
    let mut restored = Session::open(store.clone(), &id, CachedPermission::LOCAL).unwrap();
    assert_eq!(text(restored.document()), "keep");
    assert_eq!(
        restored.state(0).local,
        LocalState::Committed(Durability::Volatile)
    );
    assert_eq!(restored.state(0).pending_upload, 1);
    insert(&mut restored, "tail-", 0).unwrap();
    assert_eq!(
        text(
            Session::open(store, &id, CachedPermission::LOCAL)
                .unwrap()
                .document()
        ),
        "tail-keep"
    );
}
#[test]
fn orphan_pending_journal_is_not_reinitialized_as_a_new_document() {
    let id = identity();
    let store = memory(&id);
    store
        .append(JournalEntry::new(id.clone(), 123, 1, "orphan".into(), vec![1, 2]).unwrap())
        .unwrap();
    assert!(matches!(
        Session::create_local(store.clone(), id.clone(), &initial()),
        Err(SessionError::Store(PortError::Integrity))
    ));
    assert_eq!(store.generation(&id).unwrap(), 0);
    assert_eq!(store.pending(&id).unwrap().len(), 1);
}
#[test]
fn transport_attachment_rejects_expired_denied_and_incompatible_hosts() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store, id, &initial()).unwrap();
    let (port, _) = transport(ReceiptCapability::DurableV1);
    assert_eq!(
        session.attach_transport(port, 10, 10).unwrap_err(),
        SessionError::Unauthorized
    );
    for state in [
        ConnectionState::Unauthorized,
        ConnectionState::Incompatible,
        ConnectionState::Disconnected,
    ] {
        let (port, wire) = transport(ReceiptCapability::DurableV1);
        wire.lock().unwrap().state = Some(state);
        assert_eq!(
            session.attach_transport(port, 10, 0).unwrap_err(),
            SessionError::Unauthorized
        );
        assert_eq!(session.state(0).auth, AuthState::Detached);
        insert(&mut session, "offline", 0).unwrap();
    }
}

#[test]
fn failed_recovery_retains_exact_update_and_freeze_until_store_repairs() {
    let id = identity();
    let store = fault(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    assert!(insert(&mut session, "retained", 0).is_err());
    let update = session.recovery_export().unjournaled.unwrap();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    assert_eq!(
        session.recover().unwrap_err(),
        SessionError::Store(PortError::Quota)
    );
    assert_eq!(session.recovery_export().unjournaled.unwrap(), update);
    assert_eq!(session.state(0).readiness, Readiness::RecoveryRequired);
    assert_eq!(
        insert(&mut session, "blocked", 0).unwrap_err(),
        SessionError::RecoveryRequired
    );
    session.recover().unwrap();
    assert_eq!(store.recover(&id).unwrap().journal.len(), 1);
    assert_eq!(text(session.document()), "retained");
    assert_eq!(session.state(0).readiness, Readiness::Ready);
}
#[test]
fn oversized_transport_frame_preserves_committed_outbox_and_local_admission() {
    let id = identity();
    let store = memory(&id);
    let mut session = Session::create_local(store.clone(), id.clone(), &initial()).unwrap();
    insert(&mut session, "pending", 0).unwrap();
    let wire = Arc::new(Mutex::new(Wire::default()));
    let port = Box::new(PreparedTransport {
        wire: wire.clone(),
        receipts: ReceiptCapability::DurableV1,
        max_frame: 1,
    });
    session.attach_transport(port, 10, 0).unwrap();
    assert_eq!(
        session.flush_pending(0).unwrap_err(),
        SessionError::Store(PortError::ResourceLimit)
    );
    assert!(wire.lock().unwrap().sent.is_empty());
    assert_eq!(session.state(0).pending_upload, 1);
    assert_eq!(session.state(0).readiness, Readiness::Ready);
    insert(&mut session, "local-", 0).unwrap();
    assert_eq!(store.pending(&id).unwrap().len(), 2);
}
