use crate::support::*;
use editac_core::document::{Document, DocumentIdentity, ReplayUpdate};
use editac_session::ports::*;
use std::sync::Arc;

pub(super) fn identity() -> DocumentIdentity {
    checkpoint().identity.clone()
}
pub(super) fn initial() -> CheckpointRecord {
    CheckpointRecord::new(checkpoint().clone(), vec![]).unwrap()
}
pub(super) fn update() -> JournalEntry {
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
pub(super) fn boot<S: LocalStore>(store: &S) {
    assert_eq!(store.publish(0, initial()).unwrap().generation, 1);
}
pub(super) fn restore<S: LocalStore>(store: &S) -> Document {
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
pub(super) fn receipt(entry: &JournalEntry) -> DurableReceipt {
    DurableReceipt {
        protocol: ReceiptCapability::DurableV1,
        update: entry.id().clone(),
    }
}

pub(super) fn initialized_empty<S: LocalStore>(store: S) {
    assert_ne!(store.capabilities().durability, Durability::Unknown);
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
pub(super) fn owned_updates<S: LocalStore>(store: S) {
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
    assert_eq!(ack.durability, store.capabilities().durability);
    let mut detached = store.pending(&identity()).unwrap();
    detached.clear();
    assert_eq!(store.pending(&identity()).unwrap(), vec![saved]);
    assert_eq!(text(&restore(&store)), "port 😀");
}
pub(super) fn journal_identity_and_sequence<S: LocalStore>(store: S) {
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
pub(super) fn two_writers<S: LocalStore>(store: S) {
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
pub(super) fn checkpoint_retains_outbox<S: LocalStore>(store: S) {
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
pub(super) fn semantic_fallback_available<S: LocalStore>(store: S) {
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
pub(super) fn stale_and_uncommitted_coverage<S: LocalStore>(store: S) {
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
pub(super) fn exact_receipts<S: LocalStore>(store: S) {
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
pub(super) fn serialized_cas<S: LocalStore + 'static>(store: S) {
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
pub(super) fn bounded_records<S: LocalStore>(store: S) {
    // Factory supplies one-record capacity, enough checkpoint/update bytes.
    boot(&store);
    let first = update();
    store.append(first.clone()).unwrap();
    let second = update();
    assert_eq!(store.append(second), Err(PortError::ResourceLimit));
    assert_eq!(store.pending(&identity()).unwrap(), vec![first]);
    assert_eq!(text(&restore(&store)), "port 😀");
}
