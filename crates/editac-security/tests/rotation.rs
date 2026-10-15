//! SEC-1.7 canonical integration: selected MLS, real protected Session stores,
//! persistent opaque relay, offline removed writers/readers and retained work.
#[allow(dead_code)]
#[path = "../src/envelope.rs"]
mod envelope;
#[allow(dead_code)]
#[path = "../src/keys.rs"]
mod keys;
#[allow(dead_code)]
#[path = "support/protected_sync.rs"]
mod protected_sync;
#[allow(dead_code)]
#[path = "../src/store.rs"]
mod store;
#[allow(dead_code)]
#[path = "../src/store_native.rs"]
mod store_native;
mod support;
#[allow(dead_code)]
#[path = "../src/sync.rs"]
mod sync;

use editac_session::{
    ports::*,
    session::{CachedPermission, Session},
};
use envelope::{membership::*, *};
use openmls::prelude::{MlsMessageIn, ProcessedMessageContent};
use protected_sync::*;
use support::*;
use sync::*;
use tls_codec::Deserialize as _;

fn plan(remove: &[u8]) -> Rotation {
    Rotation {
        from: context(),
        next_epoch: 2,
        remove: remove
            .iter()
            .map(|seed| signer(*seed).to_public_vec())
            .collect(),
    }
}
fn admission(seed: u8) -> Admission<FixtureProvider> {
    let (p, g) = prepared(seed);
    Admission::fresh_prepared_membership(
        p,
        g,
        context(),
        [signer(1).to_public_vec(), signer(2).to_public_vec()].into(),
        signer(1).to_public_vec(),
    )
    .ok()
    .unwrap()
}

#[test]
fn offline_removed_writer_cannot_decrypt_future_epoch_and_retains_old_plaintext_and_pending() {
    let mut h = Harness::new("rotation-writer");
    edit(&mut h.b, B);
    let pending = h.sb.pending(&identity()).unwrap();
    h.cb.prepare_update([31; 16], &pending[0]).unwrap();
    // This valid old-epoch offline packet exists before the peer sees removal.
    h.cb.send(&h.relay, [31; 16]).unwrap();
    let old = h.relay.fetch(h.cb.scope()).unwrap().last().unwrap().clone();
    let plan = plan(&[2]);
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    let receipt = h.relay.put(commit.clone()).unwrap();
    assert_eq!(receipt.scope.key_epoch(), plan.from.key_epoch);
    let disk_relay = relay(&h.dir.join("relay.sqlite"), None);
    let commit = disk_relay
        .fetch(&commit.scope)
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert!(h.relay.negotiate(h.ca.scope()).is_err());
    let next_relay = relay_for_scope(&h.dir.join("epoch2.sqlite"), None, h.ca.scope().clone());
    edit(&mut h.a, A);
    h.ca.prepare_update([32; 16], h.sa.pending(&identity()).unwrap().last().unwrap())
        .unwrap();
    h.ca.send(&next_relay, [32; 16]).unwrap();
    let future = next_relay
        .fetch(h.ca.scope())
        .unwrap()
        .last()
        .unwrap()
        .clone();
    // Exercise MLS directly too: exclusion is not just an application scope
    // comparison. Removal yields no next-epoch secrets to the removed leaf.
    let (provider, mut removed_group) = prepared(2);
    let message = MlsMessageIn::tls_deserialize_exact(&commit.ciphertext)
        .unwrap()
        .try_into_protocol_message()
        .unwrap();
    let processed = removed_group.process_message(&provider, message).unwrap();
    let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
        panic!("not a commit")
    };
    assert!(staged.self_removed());
    assert!(staged.epoch_authenticator().is_none());
    removed_group
        .merge_staged_commit(&provider, *staged)
        .unwrap();
    assert!(!removed_group.is_active());
    let message = MlsMessageIn::tls_deserialize_exact(&future.ciphertext)
        .unwrap()
        .try_into_protocol_message()
        .unwrap();
    assert!(removed_group.process_message(&provider, message).is_err());
    // A revoked offline member can forge the public scope but cannot decrypt.
    let mut forged = future.clone();
    forged.scope = h.cb.scope().clone();
    assert!(h.cb.decrypt(&forged).is_err());
    assert!(h.ca.receive_update(&old, &mut h.a).is_err());
    assert!(!text(&h.a).contains(B));
    // A distinct honest replica processes the actual removal commit, becomes
    // inactive and cannot emit; it cannot be made live by later rotation.
    let mut revoked = client(2);
    assert_eq!(
        revoked.receive_membership(&plan, &commit, &*h.sb).unwrap(),
        MembershipState::Revoked
    );
    assert_eq!(revoked.recovery_required(), &[pending[0].id().clone()]);
    assert!(revoked.prepare_update([33; 16], &pending[0]).is_err());
    assert!(revoked.send(&h.relay, [33; 16]).is_err());
    assert_eq!(h.sb.pending(&identity()).unwrap(), pending);
    let reopened = Session::open(h.sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert!(text(&reopened).contains(B));
    assert!(text(&reopened).contains(SEED)); // acquired plaintext is NOT erased
    no_plaintext(&h.dir);
}

#[test]
fn removed_reader_loses_future_keys_while_remaining_writers_rotate_and_converge() {
    let mut h = Harness::new("rotation-reader");
    let plan = plan(&[3]);
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    let receipt = h.relay.put(commit.clone()).unwrap();
    assert_eq!(receipt.scope.key_epoch(), plan.from.key_epoch);
    let disk_relay = relay(&h.dir.join("relay.sqlite"), None);
    let commit = disk_relay
        .fetch(&commit.scope)
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(
        h.cb.receive_membership(&plan, &commit, &*h.sb).unwrap(),
        MembershipState::Active
    );
    assert!(h.relay.negotiate(h.ca.scope()).is_err());
    let next_relay = relay_for_scope(&h.dir.join("epoch2.sqlite"), None, h.ca.scope().clone());
    edit(&mut h.a, A);
    edit(&mut h.b, B);
    h.ca.prepare_update([41; 16], h.sa.pending(&identity()).unwrap().last().unwrap())
        .unwrap();
    h.cb.prepare_update([42; 16], h.sb.pending(&identity()).unwrap().last().unwrap())
        .unwrap();
    h.ca.send(&next_relay, [41; 16]).unwrap();
    h.cb.send(&next_relay, [42; 16]).unwrap();
    let packets = next_relay.fetch(h.ca.scope()).unwrap();
    h.cb.receive_update(&packets[0], &mut h.b).unwrap();
    h.ca.receive_update(&packets[1], &mut h.a).unwrap();
    assert_eq!(text(&h.a), text(&h.b));
    assert!(text(&h.a).contains(A) && text(&h.a).contains(B));
    let mut reader = admission(3);
    assert_eq!(
        reader.receive_rotation(&plan, &commit.ciphertext).unwrap(),
        MembershipState::Revoked
    );
    assert_eq!(
        reader.admit(&packets[0].ciphertext).err(),
        Some(Rejection::Locked)
    );
    assert!(
        reader
            .seal(&signer(3), [43; 16], b"malicious writer")
            .is_err()
    );
    let reopened = Session::open(h.sa.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(text(&reopened), text(&h.a));
    no_plaintext(&h.dir);
}

#[test]
fn old_pending_is_quarantined_without_discard_reseal_or_plaintext_fallback() {
    let mut h = Harness::new("rotation-pending");
    edit(&mut h.b, B);
    let pending = h.sb.pending(&identity()).unwrap();
    h.cb.prepare_update([51; 16], &pending[0]).unwrap();
    h.cb.send(&h.relay, [51; 16]).unwrap();
    let plan = plan(&[]);
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    assert_eq!(
        h.cb.receive_membership(&plan, &commit, &*h.sb).unwrap(),
        MembershipState::Active
    );
    assert!(h.cb.quarantined([51; 16]));
    assert!(h.cb.stored([51; 16])); // old receipt never clears retained work
    assert_eq!(
        h.cb.send(&h.relay, [51; 16]).err(),
        Some(PortError::Incompatible)
    );
    assert_eq!(
        h.cb.prepare_update([52; 16], &pending[0]).err(),
        Some(Rejection::Unauthorized)
    );
    assert_eq!(h.cb.recovery_required(), &[pending[0].id().clone()]);
    assert!(
        h.cb.prepare_checkpoint([53; 16], &h.b.document().checkpoint())
            .is_err()
    );
    edit(&mut h.b, "NEW_AFTER_QUARANTINE");
    let new_entries = h.sb.pending(&identity()).unwrap();
    assert!(
        h.cb.prepare_update([54; 16], new_entries.last().unwrap())
            .is_err()
    );
    assert_eq!(&new_entries[..pending.len()], pending.as_slice());
    assert_eq!(h.sb.pending(&identity()).unwrap(), new_entries);
    assert!(h.relay.fetch(h.ca.scope()).is_err());
    let next_relay = relay_for_scope(&h.dir.join("epoch2.sqlite"), None, h.ca.scope().clone());
    assert_eq!(next_relay.fetch(h.ca.scope()).unwrap().len(), 0);
    let reopened = Session::open(h.sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert!(text(&reopened).contains(B));
    no_plaintext(&h.dir);
}

#[test]
fn unsealed_old_journal_is_also_retained_and_cannot_be_implicitly_admitted() {
    let mut h = Harness::new("rotation-unsealed");
    edit(&mut h.a, A);
    let pending = h.sa.pending(&identity()).unwrap();
    h.ca.rotate_membership(&plan(&[]), &*h.sa).unwrap();
    assert_eq!(
        h.ca.prepare_update([61; 16], &pending[0]).err(),
        Some(Rejection::Unauthorized)
    );
    assert_eq!(h.ca.recovery_required(), &[pending[0].id().clone()]);
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    no_plaintext(&h.dir);
}

#[test]
fn ordinary_writer_and_reader_cannot_issue_membership_commits() {
    for seed in [2, 3] {
        let mut member = admission(seed);
        assert_eq!(
            member.rotate(&signer(seed), &plan(&[2])).err(),
            Some(Rejection::Unauthorized)
        );
    }
    let mut a = admission(1);
    assert_eq!(
        a.rotate(&signer(2), &plan(&[3])).err(),
        Some(Rejection::Unauthorized)
    );
}

#[test]
fn authenticated_commit_from_wrong_authority_is_rejected_and_endpoint_retires() {
    let (p, g) = prepared(2);
    let mut malicious = Admission::fresh_prepared_membership(
        p,
        g,
        context(),
        [signer(1).to_public_vec(), signer(2).to_public_vec()].into(),
        signer(2).to_public_vec(),
    )
    .ok()
    .unwrap();
    let plan = plan(&[]);
    let commit = malicious.rotate(&signer(2), &plan).unwrap();
    let mut receiver = admission(1);
    assert_eq!(
        receiver.receive_rotation(&plan, &commit).err(),
        Some(Rejection::Unauthorized)
    );
    assert_eq!(
        receiver.seal(&signer(1), [71; 16], b"no resume").err(),
        Some(Rejection::Locked)
    );
}

#[test]
fn tampered_rotation_retires_without_modifying_protected_pending_work() {
    let mut h = Harness::new("rotation-tamper");
    edit(&mut h.b, B);
    let pending = h.sb.pending(&identity()).unwrap();
    let plan = plan(&[3]);
    let mut commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    let last = commit.ciphertext.len() - 1;
    commit.ciphertext[last] ^= 1;
    assert!(h.cb.receive_membership(&plan, &commit, &*h.sb).is_err());
    assert!(h.cb.prepare_update([81; 16], &pending[0]).is_err());
    assert_eq!(h.sb.pending(&identity()).unwrap(), pending);
    no_plaintext(&h.dir);
}

#[test]
fn removal_intent_cannot_be_substituted_and_replay_cannot_advance_epoch_twice() {
    let mut a = admission(1);
    let mut b = admission(2);
    let plan = plan(&[3]);
    let commit = a.rotate(&signer(1), &plan).unwrap();
    let mut wrong = plan.clone();
    wrong.remove.clear();
    assert!(b.receive_rotation(&wrong, &commit).is_err());
    let mut b = admission(2);
    assert_eq!(
        b.receive_rotation(&plan, &commit).unwrap(),
        MembershipState::Active
    );
    assert_eq!(
        b.receive_rotation(&plan, &commit).err(),
        Some(Rejection::Context)
    );
}

#[test]
fn application_operation_identity_is_not_reset_by_rotation() {
    let mut a = admission(1);
    let mut b = admission(2);
    let before = a.seal(&signer(1), [91; 16], b"before").unwrap();
    b.admit(&before).unwrap();
    let plan = plan(&[]);
    let commit = a.rotate(&signer(1), &plan).unwrap();
    b.receive_rotation(&plan, &commit).unwrap();
    assert_eq!(
        a.seal(&signer(1), [91; 16], b"reused").err(),
        Some(Rejection::Replay)
    );
    let after = a.seal(&signer(1), [92; 16], b"after").unwrap();
    assert_eq!(b.admit(&after).unwrap(), b"after");
}

#[test]
fn old_epoch_wire_is_rejected_even_with_forged_new_epoch_scope() {
    let mut h = Harness::new("rotation-stale");
    edit(&mut h.a, A);
    let mut old = h.upload_a();
    let plan = plan(&[]);
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    h.cb.receive_membership(&plan, &commit, &*h.sb).unwrap();
    old.scope = h.cb.scope().clone();
    assert!(h.cb.receive_update(&old, &mut h.b).is_err());
    assert!(!text(&h.b).contains(A));
    no_plaintext(&h.dir);
}

#[test]
fn restore_retirement_and_invalid_epoch_or_member_never_unlock() {
    let mut a = admission(1);
    a.retire_after_restore();
    assert_eq!(
        a.rotate(&signer(1), &plan(&[])).err(),
        Some(Rejection::Locked)
    );
    for bad in [0, 1, 3, u64::MAX] {
        let mut a = admission(1);
        let mut plan = plan(&[]);
        plan.next_epoch = bad;
        assert_eq!(a.rotate(&signer(1), &plan).err(), Some(Rejection::Context));
    }
    for removed in [&[1][..], &[4][..]] {
        let mut a = admission(1);
        assert_eq!(
            a.rotate(&signer(1), &plan(removed)).err(),
            Some(Rejection::Unauthorized)
        );
    }
}

#[test]
fn unavailable_local_key_prevents_transition_without_touching_protocol_or_pending() {
    let mut h = Harness::new("rotation-key-unavailable");
    edit(&mut h.b, B);
    let pending = h.sb.pending(&identity()).unwrap();
    let mut unavailable = key_context();
    unavailable.key_epoch += 1;
    let locked = store::ProtectedStore::new(
        identity(),
        unavailable,
        StoreLimits::default(),
        store_native::SqliteHost::open(&h.dir.join("b.sqlite"), None).unwrap(),
        Keys,
    )
    .ok()
    .unwrap();
    let plan = plan(&[3]);
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    assert!(h.cb.receive_membership(&plan, &commit, &locked).is_err());
    assert_eq!(h.cb.scope().key_epoch(), 1);
    assert_eq!(h.sb.pending(&identity()).unwrap(), pending);
    // Restoring actual authorized key access changes the failed prerequisite;
    // MLS was not touched, so the exact commit may now be processed once.
    assert_eq!(
        h.cb.receive_membership(&plan, &commit, &*h.sb).unwrap(),
        MembershipState::Active
    );
    assert_eq!(h.cb.recovery_required(), &[pending[0].id().clone()]);
    no_plaintext(&h.dir);
}

#[test]
fn rotation_waits_for_authenticated_protected_append_retry() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use store_native::Boundary;
    let mut h = Harness::new("rotation-append-retry");
    edit(&mut h.a, A);
    let packet = h.upload_a();
    let fail = Arc::new(AtomicBool::new(false));
    let flag = fail.clone();
    let sb = protected(
        &h.dir.join("b.sqlite"),
        Some(Arc::new(move |at| {
            if at == Boundary::BeforeCommit && flag.load(Ordering::SeqCst) {
                Err(PortError::Quota)
            } else {
                Ok(())
            }
        })),
    );
    let mut b = Session::open(sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    fail.store(true, Ordering::SeqCst);
    assert!(h.cb.receive_update(&packet, &mut b).is_err());
    let plan = plan(&[]);
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    assert_eq!(
        h.cb.receive_membership(&plan, &commit, &*sb).err(),
        Some(PortError::Conflict)
    );
    assert_eq!(h.cb.scope().key_epoch(), 1);
    fail.store(false, Ordering::SeqCst);
    b.recover().unwrap();
    h.cb.receive_update(&packet, &mut b).unwrap();
    assert!(text(&b).contains(A));
    h.cb.receive_membership(&plan, &commit, &*sb).unwrap();
    assert_eq!(h.cb.recovery_required().len(), 1);
    assert!(
        text(&Session::open(sb.clone(), &identity(), CachedPermission::LOCAL).unwrap()).contains(A)
    );
    no_plaintext(&h.dir);
}

#[test]
fn rotation_commit_relay_failure_retries_exact_ciphertext_and_survives_reopen() {
    use std::sync::Arc;
    use store_native::Boundary;
    for boundary in [
        Boundary::BeforeWrite,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let mut h = Harness::new("rotation-relay-retry");
        let plan = plan(&[3]);
        let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
        let broken = relay(
            &h.dir.join("relay.sqlite"),
            Some(Arc::new(move |at| {
                if at == boundary {
                    Err(PortError::Unavailable)
                } else {
                    Ok(())
                }
            })),
        );
        assert!(broken.put(commit.clone()).is_err());
        drop(broken);
        let reopened = relay(&h.dir.join("relay.sqlite"), None);
        let r1 = reopened.put(commit.clone()).unwrap();
        let r2 = reopened.put(commit.clone()).unwrap();
        assert_eq!(r1.digest, r2.digest);
        assert_eq!(r1.scope.key_epoch(), 1); // receipt is for the old-epoch commit
        let packets = reopened.fetch(&commit.scope).unwrap();
        assert_eq!(packets.len(), 2); // initial checkpoint + one exact commit
        assert_eq!(packets[1].ciphertext, commit.ciphertext);
        h.cb.receive_membership(&plan, &packets[1], &*h.sb).unwrap();
        assert_eq!(h.cb.scope().key_epoch(), 2);
        no_plaintext(&h.dir);
    }
}
