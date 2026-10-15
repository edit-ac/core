//! Type-check real MLS group/application-message APIs without running crypto.
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

#[allow(dead_code)]
fn protocol_surface() {
    let provider = OpenMlsRustCrypto::default();
    let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    let signer = SignatureKeyPair::new(suite.signature_algorithm()).unwrap();
    let credential = CredentialWithKey {
        credential: BasicCredential::new(b"compile-only-identity".to_vec()).into(),
        signature_key: signer.to_public_vec().into(),
    };
    let config = MlsGroupCreateConfig::builder().ciphersuite(suite).build();
    let mut group = MlsGroup::new_with_group_id(
        &provider,
        &signer,
        &config,
        GroupId::from_slice(b"compile-only-document"),
        credential,
    )
    .unwrap();
    let _message = group
        .create_message(&provider, &signer, b"compile-only")
        .unwrap();
    let _epoch = group.epoch();
}

#[allow(dead_code)]
fn membership_surface(
    group: &mut MlsGroup,
    provider: &OpenMlsRustCrypto,
    signer: &SignatureKeyPair,
    package: KeyPackage,
    message: ProtocolMessage,
    removed: LeafNodeIndex,
    commit: StagedCommit,
) {
    let _ = group.add_members(provider, signer, &[package]);
    let _ = group.remove_members(provider, signer, &[removed]);
    let _ = group.self_update(provider, signer, LeafNodeParameters::default());
    let _ = group.process_message(provider, message);
    let _ = group.merge_staged_commit(provider, commit);
}
