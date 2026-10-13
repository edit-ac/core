mod support;
use editac_core::document::{Document, DocumentIdentity, ReplayUpdate};
use editac_session::ports::{memory::*, *};
use std::sync::Arc;
use support::*;

fn identity() -> DocumentIdentity {
    checkpoint().identity.clone()
}
fn initial() -> CheckpointRecord {
    CheckpointRecord::new(checkpoint().clone(), vec![]).unwrap()
}
fn update() -> JournalEntry {
    let mut doc = document();
    insert(&mut doc, 0, "port 😀");
    JournalEntry::new(
        identity(),
        doc.writer_id(),
        1,
        "human".into(),
        doc.last_patch()
            .unwrap()
            .update
            .as_ref()
            .unwrap()
            .bytes
            .clone(),
    )
    .unwrap()
}
fn boot<S: LocalStore>(store: &S) {
    assert_eq!(store.publish(0, initial()).unwrap().generation, 1);
}
fn restore<S: LocalStore>(store: &S) -> Document {
    let recovery = store.recover(&identity()).unwrap();
    let tail: Vec<_> = recovery
        .journal
        .iter()
        .map(|e| ReplayUpdate {
            identity: e.id().identity.clone(),
            bytes: e.bytes().to_vec(),
        })
        .collect();
    Document::restore(&identity(), recovery.checkpoint.checkpoint(), &tail).unwrap()
}
fn receipt(entry: &JournalEntry) -> DurableReceipt {
    DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: entry.id().clone(),
    }
}

fn initialized_empty<S: LocalStore>(store: S) {
    assert_eq!(store.capabilities().durability, Durability::Volatile);
    assert!(store.capabilities().atomic_transactions && store.capabilities().serialized_writers);
    assert_eq!(store.generation(&identity()).unwrap(), 0);
    assert!(matches!(
        store.recover(&identity()),
        Err(PortError::Integrity)
    ));
    boot(&store);
    let doc = restore(&store);
    assert!(doc.is_initialized());
    assert_eq!(text(&doc), "");
    assert_ne!(doc.writer_id(), checkpoint().writer_id);
    assert_eq!(owner(&doc), owner(&document()));
}
fn owned_updates<S: LocalStore>(store: S) {
    boot(&store);
    let entry = update();
    let saved = entry.clone();
    let mut caller_bytes = entry.bytes().to_vec();
    let owned = JournalEntry::new(
        identity(),
        entry.id().writer,
        1,
        entry.origin().into(),
        caller_bytes.clone(),
    )
    .unwrap();
    caller_bytes.fill(0);
    let ack = store.append(owned).unwrap();
    assert_eq!(ack.update, *entry.id());
    assert_eq!(ack.durability, Durability::Volatile);
    let mut detached = store.pending(&identity()).unwrap();
    detached.clear();
    assert_eq!(store.pending(&identity()).unwrap(), vec![saved]);
    assert_eq!(text(&restore(&store)), "port 😀");
}
fn journal_identity_and_sequence<S: LocalStore>(store: S) {
    boot(&store);
    let entry = update();
    store.append(entry.clone()).unwrap();
    assert_eq!(store.append(entry.clone()).unwrap().update, *entry.id());
    let changed = JournalEntry::new(
        identity(),
        entry.id().writer,
        1,
        "agent".into(),
        entry.bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(store.append(changed), Err(PortError::Integrity));
    let changed =
        JournalEntry::new(identity(), entry.id().writer, 1, "human".into(), vec![9]).unwrap();
    assert_eq!(store.append(changed), Err(PortError::Integrity));
    let gap = JournalEntry::new(
        identity(),
        entry.id().writer,
        3,
        "human".into(),
        entry.bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(store.append(gap), Err(PortError::Sequence));
    let mut wrong = identity();
    wrong.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    let foreign = JournalEntry::new(
        wrong.clone(),
        entry.id().writer,
        2,
        "human".into(),
        entry.bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(store.append(foreign), Err(PortError::Incompatible));
    assert!(matches!(
        store.recover(&wrong),
        Err(PortError::Incompatible)
    ));
    assert_eq!(store.pending(&identity()).unwrap(), vec![entry]);
}
fn two_writers<S: LocalStore>(store: S) {
    boot(&store);
    let first = update();
    let mut second = document();
    insert(&mut second, 0, "peer");
    let other = JournalEntry::new(
        identity(),
        second.writer_id(),
        1,
        "peer".into(),
        second
            .last_patch()
            .unwrap()
            .update
            .as_ref()
            .unwrap()
            .bytes
            .clone(),
    )
    .unwrap();
    assert_ne!(first.id().writer, other.id().writer);
    store.append(other.clone()).unwrap();
    store.append(first.clone()).unwrap();
    let mut expected = document();
    for entry in [&first, &other, &first] {
        expected
            .apply_replay(&ReplayUpdate {
                identity: identity(),
                bytes: entry.bytes().to_vec(),
            })
            .unwrap();
    }
    assert_eq!(text(&restore(&store)), text(&expected));
    assert_eq!(store.pending(&identity()).unwrap().len(), 2);
}
fn checkpoint_retains_outbox<S: LocalStore>(store: S) {
    boot(&store);
    let entry = update();
    store.append(entry.clone()).unwrap();
    let doc = restore(&store);
    let point = CheckpointRecord::new(doc.checkpoint(), vec![entry.id().clone()]).unwrap();
    assert_eq!(store.publish(1, point).unwrap().generation, 2);
    let recovery = store.recover(&identity()).unwrap();
    assert_eq!(recovery.source, RecoverySource::Latest);
    assert!(recovery.rejected.is_empty());
    assert_eq!(recovery.checkpoint.coverage(), &[entry.id().clone()]);
    assert_eq!(recovery.journal, vec![entry.clone()]);
    assert_eq!(recovery.pending, vec![entry]);
    assert_eq!(text(&restore(&store)), "port 😀");
}
fn semantic_fallback_available<S: LocalStore>(store: S) {
    boot(&store);
    let mut malformed = checkpoint().clone();
    malformed.bytes = vec![0xff];
    // Storage validates integrity; semantic decoding remains owned by the engine.
    store
        .publish(1, CheckpointRecord::new(malformed, vec![]).unwrap())
        .unwrap();
    let recovered = store.recover(&identity()).unwrap();
    assert!(Document::restore(&identity(), recovered.checkpoint.checkpoint(), &[]).is_err());
    let previous = recovered.fallback.unwrap();
    let doc = Document::restore(&identity(), previous.checkpoint(), &[]).unwrap();
    assert!(doc.is_initialized());
    assert_eq!(text(&doc), "");
}
fn stale_and_uncommitted_coverage<S: LocalStore>(store: S) {
    boot(&store);
    let entry = update();
    let uncommitted =
        CheckpointRecord::new(checkpoint().clone(), vec![entry.id().clone()]).unwrap();
    assert_eq!(store.publish(1, uncommitted), Err(PortError::InvalidRecord));
    store.publish(1, initial()).unwrap();
    assert_eq!(store.publish(1, initial()), Err(PortError::Conflict));
    assert_eq!(store.generation(&identity()).unwrap(), 2);
    assert_eq!(text(&restore(&store)), "");
}
fn exact_receipts<S: LocalStore>(store: S) {
    boot(&store);
    let entry = update();
    store.append(entry.clone()).unwrap();
    assert_eq!(
        store
            .accept_receipt(ReceiptCapability::Unknown, receipt(&entry))
            .unwrap(),
        ReceiptResult::CapabilityUnavailable
    );
    let mut unnegotiated = receipt(&entry);
    unnegotiated.protocol = ReceiptCapability::Unknown;
    assert_eq!(
        store
            .accept_receipt(ReceiptCapability::DurableV1, unnegotiated)
            .unwrap(),
        ReceiptResult::CapabilityUnavailable
    );
    for field in 0..10 {
        let mut wrong = receipt(&entry);
        match field {
            0 => wrong.update.identity.document_id = "34567890-3456-4456-8456-34567890abcd".into(),
            1 => wrong.update.identity.epoch = "34567890-3456-4456-8456-34567890abcd".into(),
            2 => wrong.update.identity.profile.push('x'),
            3 => wrong.update.identity.schema.push('x'),
            4 => wrong.update.identity.protocol_version += 1,
            5 => wrong.update.identity.update_encoding += 1,
            6 => wrong.update.identity.offsets = "utf8".into(),
            7 => wrong.update.writer += 1,
            8 => wrong.update.sequence += 1,
            _ => wrong.update.checksum[0] ^= 1,
        }
        if field < 7 {
            assert_eq!(
                store.accept_receipt(ReceiptCapability::DurableV1, wrong),
                Err(PortError::Incompatible)
            );
        } else {
            assert_eq!(
                store
                    .accept_receipt(ReceiptCapability::DurableV1, wrong)
                    .unwrap(),
                ReceiptResult::UnknownUpdate
            );
        }
        assert_eq!(store.pending(&identity()).unwrap(), vec![entry.clone()]);
    }
    for _ in 0..2 {
        assert_eq!(
            store
                .accept_receipt(ReceiptCapability::DurableV1, receipt(&entry))
                .unwrap(),
            ReceiptResult::RemoteCommitted
        );
    }
    assert!(store.pending(&identity()).unwrap().is_empty());
    assert_eq!(store.recover(&identity()).unwrap().journal, vec![entry]);
    assert_eq!(text(&restore(&store)), "port 😀");
}
fn serialized_cas<S: LocalStore + 'static>(store: S) {
    boot(&store);
    let store = Arc::new(store);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let expected = store.generation(&identity()).unwrap();
                barrier.wait();
                store.publish(expected, initial())
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == Err(PortError::Conflict))
            .count(),
        1
    );
    assert_eq!(store.generation(&identity()).unwrap(), 2);
}
fn bounded_records<S: LocalStore>(store: S) {
    // Factory supplies one-record capacity, enough checkpoint/update bytes.
    boot(&store);
    let first = update();
    store.append(first.clone()).unwrap();
    let second = update();
    assert_eq!(store.append(second), Err(PortError::ResourceLimit));
    assert_eq!(store.pending(&identity()).unwrap(), vec![first]);
    assert_eq!(text(&restore(&store)), "port 😀");
}

macro_rules! common {
    ($name:ident, $adapter:ty) => {
        mod $name {
            use super::*;
            fn store() -> $adapter {
                <$adapter>::new(identity(), StoreLimits::default()).unwrap()
            }
            #[test]
            fn initialized_empty() {
                super::initialized_empty(store());
            }
            #[test]
            fn owned_updates() {
                super::owned_updates(store());
            }
            #[test]
            fn journal_identity_and_sequence() {
                super::journal_identity_and_sequence(store());
            }
            #[test]
            fn two_writers() {
                super::two_writers(store());
            }
            #[test]
            fn checkpoint_retains_outbox() {
                super::checkpoint_retains_outbox(store());
            }
            #[test]
            fn semantic_fallback_available() {
                super::semantic_fallback_available(store());
            }
            #[test]
            fn stale_and_uncommitted_coverage() {
                super::stale_and_uncommitted_coverage(store());
            }
            #[test]
            fn exact_receipts() {
                super::exact_receipts(store());
            }
            #[test]
            fn serialized_cas() {
                super::serialized_cas(store());
            }
            #[test]
            fn bounded_records() {
                super::bounded_records(
                    <$adapter>::new(
                        identity(),
                        StoreLimits {
                            max_records: 1,
                            ..StoreLimits::default()
                        },
                    )
                    .unwrap(),
                );
            }
        }
    };
}
common!(memory, MemoryStore);
common!(fault_adapter, FaultInjectedStore);

fn fault_store() -> FaultInjectedStore {
    FaultInjectedStore::new(identity(), StoreLimits::default()).unwrap()
}
#[test]
fn journal_failure_boundaries_and_idempotent_ack_recovery() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        for error in [
            PortError::Quota,
            PortError::Permission,
            PortError::Unavailable,
        ] {
            let store = fault_store();
            boot(&store);
            let entry = update();
            store.inject(InjectedFault { boundary, error }).unwrap();
            assert_eq!(
                store.append(entry.clone()),
                Err(if boundary == FaultBoundary::AfterCommit {
                    PortError::CommitUnknown
                } else {
                    error
                })
            );
            assert_eq!(
                store.pending(&identity()).unwrap().len(),
                usize::from(boundary == FaultBoundary::AfterCommit)
            );
            assert_eq!(
                text(&restore(&store)),
                if boundary == FaultBoundary::AfterCommit {
                    "port 😀"
                } else {
                    ""
                }
            );
            assert_eq!(store.append(entry.clone()).unwrap().update, *entry.id());
            assert_eq!(store.pending(&identity()).unwrap(), vec![entry]);
        }
    }
}
#[test]
fn checkpoint_failure_boundaries_preserve_journal_and_atomic_generation() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let store = fault_store();
        boot(&store);
        let entry = update();
        store.append(entry.clone()).unwrap();
        let point =
            CheckpointRecord::new(restore(&store).checkpoint(), vec![entry.id().clone()]).unwrap();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert_eq!(
            store.publish(1, point.clone()),
            Err(if boundary == FaultBoundary::AfterCommit {
                PortError::CommitUnknown
            } else {
                PortError::Quota
            })
        );
        let committed = boundary == FaultBoundary::AfterCommit;
        assert_eq!(
            store.generation(&identity()).unwrap(),
            if committed { 2 } else { 1 }
        );
        assert_eq!(
            store
                .recover(&identity())
                .unwrap()
                .checkpoint
                .coverage()
                .len(),
            usize::from(committed)
        );
        assert_eq!(store.pending(&identity()).unwrap(), vec![entry]);
        assert_eq!(text(&restore(&store)), "port 😀");
        if !committed {
            store.publish(1, point).unwrap();
        }
    }
}
#[test]
fn receipt_failure_boundaries_do_not_erase_recovery_bytes() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let store = fault_store();
        boot(&store);
        let entry = update();
        store.append(entry.clone()).unwrap();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::Permission,
            })
            .unwrap();
        assert_eq!(
            store.accept_receipt(ReceiptCapability::DurableV1, receipt(&entry)),
            Err(if boundary == FaultBoundary::AfterCommit {
                PortError::CommitUnknown
            } else {
                PortError::Permission
            })
        );
        assert_eq!(
            store.pending(&identity()).unwrap().len(),
            usize::from(boundary != FaultBoundary::AfterCommit)
        );
        assert_eq!(
            store.recover(&identity()).unwrap().journal,
            vec![entry.clone()]
        );
        store
            .accept_receipt(ReceiptCapability::DurableV1, receipt(&entry))
            .unwrap();
        assert!(store.pending(&identity()).unwrap().is_empty());
    }
}
#[test]
fn corrupt_latest_falls_back_and_replays_full_tail_then_repairs() {
    let store = fault_store();
    boot(&store);
    let entry = update();
    store.append(entry.clone()).unwrap();
    store
        .publish(
            1,
            CheckpointRecord::new(restore(&store).checkpoint(), vec![entry.id().clone()]).unwrap(),
        )
        .unwrap();
    store.corrupt_latest().unwrap();
    let recovered = store.recover(&identity()).unwrap();
    assert_eq!(recovered.source, RecoverySource::Previous);
    assert_eq!(
        recovered.rejected,
        vec![(RecoverySource::Latest, PortError::Integrity)]
    );
    assert_eq!(recovered.pending, vec![entry.clone()]);
    assert_eq!(text(&restore(&store)), "port 😀");
    store
        .publish(
            2,
            CheckpointRecord::new(restore(&store).checkpoint(), vec![entry.id().clone()]).unwrap(),
        )
        .unwrap();
    store.corrupt_latest().unwrap();
    assert_eq!(
        store.recover(&identity()).unwrap().source,
        RecoverySource::Previous
    );
    assert_eq!(text(&restore(&store)), "port 😀");
}
#[test]
fn corrupt_journal_freezes_recovery_pending_and_publication() {
    let store = fault_store();
    boot(&store);
    store.append(update()).unwrap();
    store.corrupt_journal().unwrap();
    assert!(matches!(
        store.recover(&identity()),
        Err(PortError::Integrity)
    ));
    assert_eq!(store.pending(&identity()), Err(PortError::Integrity));
    assert_eq!(store.publish(1, initial()), Err(PortError::Integrity));
    assert_eq!(store.generation(&identity()).unwrap(), 1);
}
#[test]
fn byte_and_record_budgets_leave_prior_state_intact() {
    for adapter in 0..2 {
        let limits = StoreLimits {
            max_record_bytes: 1,
            ..StoreLimits::default()
        };
        let store: Box<dyn LocalStore> = if adapter == 0 {
            Box::new(MemoryStore::new(identity(), limits).unwrap())
        } else {
            Box::new(FaultInjectedStore::new(identity(), limits).unwrap())
        };
        assert_eq!(store.publish(0, initial()), Err(PortError::ResourceLimit));
        assert_eq!(store.append(update()), Err(PortError::ResourceLimit));
        assert_eq!(store.generation(&identity()).unwrap(), 0);
        let entry = update();
        let budget = checkpoint().bytes.len() + entry.bytes().len() - 1;
        let limits = StoreLimits {
            max_total_bytes: budget,
            ..StoreLimits::default()
        };
        let store: Box<dyn LocalStore> = if adapter == 0 {
            Box::new(MemoryStore::new(identity(), limits).unwrap())
        } else {
            Box::new(FaultInjectedStore::new(identity(), limits).unwrap())
        };
        store.publish(0, initial()).unwrap();
        assert_eq!(store.append(entry), Err(PortError::Quota));
        assert!(store.pending(&identity()).unwrap().is_empty());
    }
}
#[test]
fn invalid_envelopes_reject_before_storage() {
    let entry = update();
    assert!(matches!(
        JournalEntry::new(identity(), 0, 1, "human".into(), vec![1]),
        Err(PortError::InvalidRecord)
    ));
    assert!(matches!(
        JournalEntry::new(identity(), 1, 0, "human".into(), vec![1]),
        Err(PortError::InvalidRecord)
    ));
    assert!(matches!(
        JournalEntry::new(identity(), 1, 1, "".into(), vec![1]),
        Err(PortError::InvalidRecord)
    ));
    assert!(matches!(
        JournalEntry::new(identity(), 1, 1, "human".into(), vec![]),
        Err(PortError::InvalidRecord)
    ));
    let mut bad = identity();
    bad.profile = "unknown".into();
    assert!(matches!(
        MemoryStore::new(bad, StoreLimits::default()),
        Err(PortError::Incompatible)
    ));
    assert!(matches!(
        CheckpointRecord::new(
            checkpoint().clone(),
            vec![entry.id().clone(), entry.id().clone()]
        ),
        Err(PortError::InvalidRecord)
    ));
    let mut bad = checkpoint().clone();
    bad.initialized = false;
    assert!(matches!(
        CheckpointRecord::new(bad, vec![]),
        Err(PortError::InvalidRecord)
    ));
}
#[test]
fn admission_serializes_semantic_commit_and_durable_capture_on_engine_owner() {
    let store = MemoryStore::new(identity(), StoreLimits::default()).unwrap();
    boot(&store);
    // Document listeners/history are intentionally not Send. Host requests are
    // marshaled to its one engine owner; only owned requests cross threads.
    let admission = SerializedAdmission::new((document(), store.clone(), 0u64));
    let (send, receive) = std::sync::mpsc::channel();
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let send = send.clone();
            std::thread::spawn(move || {
                for _ in 0..10 {
                    send.send("x").unwrap();
                }
            })
        })
        .collect();
    drop(send);
    for value in receive {
        admission
            .with(|(doc, store, sequence)| {
                insert(doc, 0, value);
                *sequence += 1;
                let entry = JournalEntry::new(
                    identity(),
                    doc.writer_id(),
                    *sequence,
                    "human".into(),
                    doc.last_patch()
                        .unwrap()
                        .update
                        .as_ref()
                        .unwrap()
                        .bytes
                        .clone(),
                )?;
                store.append(entry)?;
                Ok(())
            })
            .unwrap();
    }
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(text(&restore(&store)), "x".repeat(40));
    assert_eq!(store.pending(&identity()).unwrap().len(), 40);
}
#[test]
fn admission_mutex_keeps_parallel_sequence_capture_atomic() {
    let store = MemoryStore::new(identity(), StoreLimits::default()).unwrap();
    boot(&store);
    let entry = update();
    let admission = Arc::new(SerializedAdmission::new(0u64));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let admission = admission.clone();
            let store = store.clone();
            let entry = entry.clone();
            std::thread::spawn(move || {
                for _ in 0..10 {
                    admission
                        .with(|sequence| {
                            *sequence += 1;
                            store.append(JournalEntry::new(
                                identity(),
                                entry.id().writer,
                                *sequence,
                                "prepared".into(),
                                entry.bytes().to_vec(),
                            )?)?;
                            Ok(())
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let entries = store.pending(&identity()).unwrap();
    assert_eq!(entries.len(), 40);
    assert_eq!(
        entries.iter().map(|e| e.id().sequence).collect::<Vec<_>>(),
        (1..=40).collect::<Vec<_>>()
    );
}
fn transport(state: ConnectionState) -> PreparedTransport {
    PreparedTransport::new(
        identity(),
        state,
        TransportCapabilities {
            receipts: ReceiptCapability::Unknown,
            max_frame_bytes: 4,
            max_queue_bytes: 6,
            max_queue_frames: 2,
        },
    )
    .unwrap()
}
fn frame(kind: FrameKind, bytes: &[u8]) -> TransportFrame {
    TransportFrame {
        identity: identity(),
        kind,
        bytes: bytes.to_vec(),
    }
}
#[test]
fn transport_authorization_scope_backpressure_and_owned_frames() {
    let mut transport = transport(ConnectionState::Disconnected);
    assert_eq!(
        transport.send(frame(FrameKind::Sync, &[1])),
        Err(PortError::Unavailable)
    );
    transport.set_state(ConnectionState::Unauthorized);
    assert_eq!(
        transport.send(frame(FrameKind::Sync, &[1])),
        Err(PortError::Permission)
    );
    transport.set_state(ConnectionState::Incompatible);
    assert_eq!(transport.receive(), Err(PortError::Incompatible));
    transport.set_state(ConnectionState::Authorized);
    let mut wrong = frame(FrameKind::Sync, &[1]);
    wrong.identity.epoch = "wrong".into();
    assert_eq!(transport.send(wrong), Err(PortError::Incompatible));
    assert_eq!(
        transport.send(frame(FrameKind::Sync, &[])),
        Err(PortError::InvalidRecord)
    );
    assert_eq!(
        transport.send(frame(FrameKind::Sync, &[1; 5])),
        Err(PortError::ResourceLimit)
    );
    let mut bytes = vec![1; 4];
    transport.send(frame(FrameKind::Sync, &bytes)).unwrap();
    bytes.fill(2);
    assert_eq!(
        transport.send(frame(FrameKind::Sync, &[3; 3])),
        Err(PortError::Backpressure)
    );
    transport
        .send(frame(FrameKind::Awareness, &[4; 2]))
        .unwrap();
    transport.set_state(ConnectionState::Disconnected);
    assert_eq!(transport.receive(), Err(PortError::Unavailable));
    transport.set_state(ConnectionState::Authorized);
    assert_eq!(
        transport.receive().unwrap(),
        Some(frame(FrameKind::Sync, &[1; 4]))
    );
    assert_eq!(
        transport.receive().unwrap(),
        Some(frame(FrameKind::Awareness, &[4; 2]))
    );
    assert_eq!(transport.receive().unwrap(), None);
    assert_eq!(
        transport.capabilities().receipts,
        ReceiptCapability::Unknown
    );
}
#[test]
fn sync_awareness_and_auth_failure_never_prune_durable_outbox() {
    let store = MemoryStore::new(identity(), StoreLimits::default()).unwrap();
    boot(&store);
    let entry = update();
    store.append(entry.clone()).unwrap();
    let mut transport = PreparedTransport::new(
        identity(),
        ConnectionState::Authorized,
        TransportCapabilities {
            receipts: ReceiptCapability::Unknown,
            max_frame_bytes: 65536,
            max_queue_bytes: 65536,
            max_queue_frames: 2,
        },
    )
    .unwrap();
    for kind in [FrameKind::Sync, FrameKind::Awareness] {
        transport.send(frame(kind, entry.bytes())).unwrap();
        transport.receive().unwrap();
        assert_eq!(store.pending(&identity()).unwrap(), vec![entry.clone()]);
    }
    transport.set_state(ConnectionState::Unauthorized);
    assert_eq!(
        transport.send(frame(FrameKind::Sync, entry.bytes())),
        Err(PortError::Permission)
    );
    assert_eq!(text(&restore(&store)), "port 😀");
    assert_eq!(store.pending(&identity()).unwrap(), vec![entry]);
}

#[test]
fn persisted_records_verify_original_digest_and_coverage_manifest() {
    let entry = update();
    let imported = JournalEntry::from_stored(
        entry.id().clone(),
        entry.origin().into(),
        entry.bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(imported, entry);
    let mut corrupt = entry.bytes().to_vec();
    corrupt[0] ^= 1;
    assert_eq!(
        JournalEntry::from_stored(entry.id().clone(), entry.origin().into(), corrupt),
        Err(PortError::Integrity)
    );
    let record = CheckpointRecord::new(checkpoint().clone(), vec![entry.id().clone()]).unwrap();
    let imported = CheckpointRecord::from_stored(
        record.checkpoint().clone(),
        record.coverage().to_vec(),
        *record.manifest(),
    )
    .unwrap();
    assert_eq!(imported.manifest(), record.manifest());
    assert!(matches!(
        CheckpointRecord::from_stored(record.checkpoint().clone(), vec![], *record.manifest()),
        Err(PortError::Integrity)
    ));
    let mut wrong = record.checkpoint().clone();
    wrong.bytes[0] ^= 1;
    assert!(matches!(
        CheckpointRecord::from_stored(wrong, record.coverage().to_vec(), *record.manifest()),
        Err(PortError::Integrity)
    ));
    let mut wrong = record.checkpoint().clone();
    wrong.writer_id += 1;
    assert!(matches!(
        CheckpointRecord::from_stored(wrong, record.coverage().to_vec(), *record.manifest()),
        Err(PortError::Integrity)
    ));
}
#[test]
fn transport_frame_count_bounds_small_frame_metadata() {
    let mut transport = transport(ConnectionState::Authorized);
    for _ in 0..2 {
        transport.send(frame(FrameKind::Sync, &[1])).unwrap();
    }
    assert_eq!(
        transport.send(frame(FrameKind::Sync, &[1])),
        Err(PortError::Backpressure)
    );
    transport.receive().unwrap();
    transport.send(frame(FrameKind::Awareness, &[1])).unwrap();
}

#[test]
fn sequence_range_does_not_round_browser_receipt_identity() {
    let entry = update();
    assert!(
        JournalEntry::new(
            identity(),
            entry.id().writer,
            MAX_SEQUENCE,
            "human".into(),
            entry.bytes().to_vec()
        )
        .is_ok()
    );
    assert!(matches!(
        JournalEntry::new(
            identity(),
            entry.id().writer,
            MAX_SEQUENCE + 1,
            "human".into(),
            entry.bytes().to_vec()
        ),
        Err(PortError::InvalidRecord)
    ));
}
