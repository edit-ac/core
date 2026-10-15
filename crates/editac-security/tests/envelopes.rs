//! SEC-1.3: actual MLS private framing/authentication; fixed local fixture state.
//! Rejected inputs never cross the observable plaintext-apply sink.
#[path = "../src/envelope.rs"]
mod envelope;
mod support;

use envelope::{Admission, Context, MAX_ENVELOPE, MAX_UPDATE, Rejection};
use openmls::prelude::*;
use openmls_traits::OpenMlsProvider;
use support::*;
use tls_codec::Serialize as _;

const SENTINEL: &[u8] = b"SEC-1.3 authorized prepared update";

fn context() -> Context {
    Context {
        document: DOCUMENT,
        document_epoch: 11,
        schema: 3,
        key_epoch: 1,
    }
}

fn endpoint(seed: u8) -> Admission<FixtureProvider> {
    let (provider, group) = prepared(seed);
    Admission::fresh_prepared(provider, group, context(), writers())
        .ok()
        .unwrap()
}

fn valid() -> Vec<u8> {
    endpoint(1).seal(&signer(1), [1; 16], SENTINEL).unwrap()
}

/// Bypasses honest sender guards, as a malicious key-holding member can.
fn raw(seed: u8, aad: Vec<u8>, payload: &[u8]) -> Vec<u8> {
    let (provider, mut group) = prepared(seed);
    group.set_aad(aad);
    group
        .create_message(&provider, &signer(seed), payload)
        .unwrap()
        .tls_serialize_detached()
        .unwrap()
}

fn apply(
    receiver: &mut Admission<FixtureProvider>,
    wire: &[u8],
    sink: &mut Vec<Vec<u8>>,
) -> Result<(), Rejection> {
    let admitted = receiver.admit(wire)?;
    sink.push(admitted);
    Ok(())
}

fn rejects(wire: &[u8], expected: Rejection) {
    let mut sink = vec![];
    assert_eq!(apply(&mut endpoint(2), wire, &mut sink), Err(expected));
    assert!(sink.is_empty(), "rejected input applied plaintext");
}

#[test]
fn authorized_writer_applies_exactly_once() {
    let mut sink = vec![];
    let mut receiver = endpoint(2);
    apply(&mut receiver, &valid(), &mut sink).unwrap();
    assert_eq!(sink, [SENTINEL]);
}

#[test]
fn prepared_application_messages_are_byte_reproducible() {
    assert_eq!(valid(), valid());
    assert!(!valid().windows(SENTINEL.len()).any(|w| w == SENTINEL));
}

#[test]
fn wrong_epoch_secrets_cannot_apply_plaintext() {
    // Same document/epoch/roster/signing keys, independently established secrets.
    let mut sink = vec![];
    assert_eq!(
        apply(&mut endpoint(4), &valid(), &mut sink),
        Err(Rejection::Authentication)
    );
    assert!(sink.is_empty());
}

#[test]
fn tampered_ciphertext_never_applies() {
    let mut message = valid();
    *message.last_mut().unwrap() ^= 1;
    rejects(&message, Rejection::Authentication);
}

#[test]
fn altered_authenticated_context_never_applies() {
    let mut message = valid();
    let aad = context().aad([1; 16]);
    let offset = message.windows(aad.len()).position(|w| w == aad).unwrap();
    message[offset + aad.len() - 1] ^= 1;
    rejects(&message, Rejection::Authentication);
}

#[test]
fn cross_document_authenticated_message_never_applies() {
    let mut other = context();
    other.document = [9; 16];
    rejects(&raw(1, other.aad([1; 16]), SENTINEL), Rejection::Context);
}

#[test]
fn cross_document_epoch_authenticated_message_never_applies() {
    let mut other = context();
    other.document_epoch += 1;
    rejects(&raw(1, other.aad([1; 16]), SENTINEL), Rejection::Context);
}

#[test]
fn cross_schema_authenticated_message_never_applies() {
    let mut other = context();
    other.schema += 1;
    rejects(&raw(1, other.aad([1; 16]), SENTINEL), Rejection::Context);
}

#[test]
fn cross_key_epoch_authenticated_message_never_applies() {
    let mut other = context();
    other.key_epoch += 1;
    rejects(&raw(1, other.aad([1; 16]), SENTINEL), Rejection::Context);
}

#[test]
fn context_is_exact_and_operation_identity_is_mandatory() {
    rejects(&raw(1, vec![], SENTINEL), Rejection::Context);
    let mut aad = context().aad([1; 16]);
    aad.push(0);
    rejects(&raw(1, aad, SENTINEL), Rejection::Context);
    rejects(&raw(1, context().aad([0; 16]), SENTINEL), Rejection::Replay);
}

#[test]
fn replay_cannot_apply_a_second_plaintext_update() {
    let mut receiver = endpoint(2);
    let mut sink = vec![];
    let message = valid();
    apply(&mut receiver, &message, &mut sink).unwrap();
    assert!(apply(&mut receiver, &message, &mut sink).is_err());
    assert_eq!(sink, [SENTINEL]);
}

#[test]
fn duplicate_operation_in_new_authenticated_frame_cannot_apply_twice() {
    let mut sender = endpoint(1);
    let first = sender.seal(&signer(1), [1; 16], SENTINEL).unwrap();
    // Independently valid MLS frame with the same application operation ID.
    let (provider, mut group) = prepared(1);
    group.set_aad(context().aad([1; 16]));
    group
        .create_message(&provider, &signer(1), SENTINEL)
        .unwrap();
    group.set_aad(context().aad([1; 16]));
    let second = group
        .create_message(&provider, &signer(1), b"duplicate mutation")
        .unwrap()
        .tls_serialize_detached()
        .unwrap();
    let mut sink = vec![];
    let mut receiver = endpoint(2);
    apply(&mut receiver, &first, &mut sink).unwrap();
    assert_eq!(
        apply(&mut receiver, &second, &mut sink),
        Err(Rejection::Replay)
    );
    assert_eq!(sink, [SENTINEL]);
}

#[test]
fn malicious_readonly_member_with_writer_label_cannot_write() {
    let (provider, mut reader_group) = prepared(3);
    // Prove this member can decrypt the writer's update.
    let incoming = MlsMessageIn::tls_deserialize_exact(valid())
        .unwrap()
        .try_into_protocol_message()
        .unwrap();
    let decrypted = reader_group.process_message(&provider, incoming).unwrap();
    assert!(matches!(
        decrypted.content(),
        ProcessedMessageContent::ApplicationMessage(_)
    ));
    // Reader has a real decrypt key and same BasicCredential label as the writer.
    rejects(
        &raw(3, context().aad([2; 16]), b"forged write"),
        Rejection::Unauthorized,
    );
}

#[test]
fn honest_sender_refuses_reader_or_wrong_signer_and_duplicate_operation() {
    assert_eq!(
        endpoint(3).seal(&signer(3), [1; 16], SENTINEL),
        Err(Rejection::Unauthorized)
    );
    assert_eq!(
        endpoint(3).seal(&signer(1), [1; 16], SENTINEL),
        Err(Rejection::Unauthorized)
    );
    assert_eq!(
        endpoint(1).seal(&signer(3), [1; 16], SENTINEL),
        Err(Rejection::Unauthorized)
    );
    let mut sender = endpoint(1);
    sender.seal(&signer(1), [1; 16], SENTINEL).unwrap();
    assert_eq!(
        sender.seal(&signer(1), [1; 16], SENTINEL),
        Err(Rejection::Replay)
    );
}

#[test]
fn oversized_and_empty_outer_input_is_rejected_before_decode() {
    rejects(&vec![0; MAX_ENVELOPE + 1], Rejection::Bounds);
    rejects(&[], Rejection::Bounds);
    assert_eq!(
        endpoint(1).seal(&signer(1), [1; 16], &vec![0; MAX_UPDATE + 1]),
        Err(Rejection::Bounds)
    );
}

#[test]
fn authenticated_oversize_or_empty_plaintext_is_never_applied() {
    rejects(
        &raw(1, context().aad([1; 16]), &vec![0; MAX_UPDATE + 1]),
        Rejection::Bounds,
    );
    rejects(&raw(1, context().aad([1; 16]), &[]), Rejection::Bounds);
    let mut sink = vec![];
    apply(
        &mut endpoint(2),
        &raw(1, context().aad([1; 16]), &vec![42; MAX_UPDATE]),
        &mut sink,
    )
    .unwrap();
    assert_eq!(sink, [vec![42; MAX_UPDATE]]);
}

#[test]
fn trailing_frames_truncation_and_length_bombs_never_apply() {
    let mut message = valid();
    message.extend_from_slice(&valid());
    rejects(&message, Rejection::Authentication);
    let message = valid();
    rejects(&message[..message.len() - 1], Rejection::Authentication);
    rejects(&[255; 128], Rejection::Authentication);
    // Private-message group_id<V> declares 2^30-1 bytes in a tiny input.
    // This exercises the actual vector decoder, rather than an invalid version.
    rejects(
        &[0, 1, 0, 2, 0xbf, 0xff, 0xff, 0xff],
        Rejection::Authentication,
    );
    // Oversized AAD length in an otherwise real private-message header.
    let mut message = valid();
    let aad = context().aad([1; 16]);
    let offset = message.windows(aad.len()).position(|w| w == aad).unwrap();
    message.splice(offset - 2..offset, [0xbf, 0xff, 0xff, 0xff]);
    rejects(&message, Rejection::Authentication);
}

#[test]
fn nonprivate_source_families_are_rejected_before_body_decode() {
    for kind in [1, 3, 4, 5] {
        // PublicMessage/Welcome/GroupInfo/KeyPackage with malicious body bytes.
        rejects(&[0, 1, 0, kind, 0xff, 0xff], Rejection::Unsupported);
    }
}

#[test]
fn readonly_membership_commit_is_never_merged() {
    let (provider, mut reader) = prepared(3);
    let commit = reader
        .self_update(&provider, &signer(3), LeafNodeParameters::default())
        .unwrap();
    let message = commit.into_commit().tls_serialize_detached().unwrap();
    let mut receiver = endpoint(2);
    let mut sink = vec![];
    assert_eq!(
        apply(&mut receiver, &message, &mut sink),
        Err(Rejection::Unsupported)
    );
    assert!(sink.is_empty());
    // Receiver remains in the original epoch, so an authorized update still works.
    apply(&mut receiver, &valid(), &mut sink).unwrap();
    assert_eq!(sink, [SENTINEL]);
}

#[test]
fn receiver_restored_before_applied_counter_is_locked() {
    let mut original = endpoint(2);
    let mut sink = vec![];
    apply(&mut original, &valid(), &mut sink).unwrap();
    // Reload an actual older serialized MLS snapshot, not a mocked replay flag.
    let (provider, old_group) = prepared(2);
    let mut restored = Admission::restored_prepared(provider, old_group, context(), writers())
        .ok()
        .unwrap();
    assert_eq!(
        apply(&mut restored, &valid(), &mut sink),
        Err(Rejection::Locked)
    );
    assert_eq!(sink, [SENTINEL]);
}

#[test]
fn restored_sender_cannot_reuse_an_old_ratchet_or_publish_ciphertext() {
    let first = valid();
    let (provider, old_group) = prepared(1);
    let mut restored = Admission::restored_prepared(provider, old_group, context(), writers())
        .ok()
        .unwrap();
    assert_eq!(
        restored.seal(&signer(1), [2; 16], SENTINEL),
        Err(Rejection::Locked)
    );
    assert!(!first.is_empty());
    let mut active = endpoint(1);
    active.retire_after_restore();
    assert_eq!(
        active.seal(&signer(1), [2; 16], SENTINEL),
        Err(Rejection::Locked)
    );
}

#[test]
fn fresh_prepared_context_and_policy_must_match_actual_group() {
    let (provider, group) = prepared(2);
    let mut wrong = context();
    wrong.document = [9; 16];
    assert!(matches!(
        Admission::fresh_prepared(provider, group, wrong, writers()),
        Err(Rejection::Context)
    ));
    let (provider, group) = prepared(2);
    let mut wrong = context();
    wrong.key_epoch += 1;
    assert!(matches!(
        Admission::fresh_prepared(provider, group, wrong, writers()),
        Err(Rejection::Context)
    ));
    let (provider, group) = prepared(2);
    assert!(matches!(
        Admission::fresh_prepared(
            provider,
            group,
            context(),
            [signer(9).to_public_vec()].into()
        ),
        Err(Rejection::Unauthorized)
    ));
}

use tls_codec::Deserialize as _;
