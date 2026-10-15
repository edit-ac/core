//! Explicit offline fixture preparation, never invoked by tests or CI.
//! Uses only local cryptography and fixed disposable identities, no transport.
//! HPKE bootstrap entropy is captured in the resulting immutable snapshots;
//! tests replay those snapshots and use a seeded application-message RNG.
#[allow(dead_code)]
#[path = "../tests/support/mod.rs"]
mod support;

use openmls::prelude::*;
use openmls_traits::OpenMlsProvider;
use std::{collections::BTreeMap, path::PathBuf};
use support::*;

fn main() {
    let output = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("explicit output directory required"),
    );
    prepare(&output, false);
    prepare(&output, true);
}

fn prepare(output: &std::path::Path, wrong_key: bool) {
    let offset = if wrong_key { 20 } else { 0 };
    let providers = [
        FixtureProvider::new(1 + offset),
        FixtureProvider::new(2 + offset),
        FixtureProvider::new(3 + offset),
    ];
    let signers = [signer(1), signer(2), signer(3)];
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(SUITE)
        .use_ratchet_tree_extension(true)
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .build();
    let mut writer = MlsGroup::new_with_group_id(
        &providers[0],
        &signers[0],
        &config,
        GroupId::from_slice(&DOCUMENT),
        credential(&signers[0]),
    )
    .unwrap();
    let packages: Vec<_> = (1..3)
        .map(|i| {
            KeyPackage::builder()
                .build(SUITE, &providers[i], &signers[i], credential(&signers[i]))
                .unwrap()
                .key_package()
                .clone()
        })
        .collect();
    let (_, welcome, _) = writer
        .add_members(&providers[0], &signers[0], &packages)
        .unwrap();
    writer.merge_pending_commit(&providers[0]).unwrap();
    let welcome: MlsMessageIn = welcome.into();
    let MlsMessageBodyIn::Welcome(welcome) = welcome.extract() else {
        panic!("expected Welcome")
    };
    let config = MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .max_past_epochs(0)
        .sender_ratchet_configuration(SenderRatchetConfiguration::new(0, 32))
        .build();
    for provider in &providers[1..] {
        StagedWelcome::new_from_welcome(provider, &config, welcome.clone(), None)
            .unwrap()
            .into_group(provider)
            .unwrap();
    }
    std::fs::create_dir_all(&output).unwrap();
    for (provider, name) in providers.iter().zip(["writer", "receiver", "reader"]) {
        if wrong_key && name != "receiver" {
            continue;
        }
        let name = if wrong_key { "wrong-key" } else { name };
        let entries: BTreeMap<_, _> = provider
            .storage()
            .values
            .read()
            .unwrap()
            .iter()
            .map(|(k, v)| (hex(k), hex(v)))
            .collect();
        let entries: Vec<_> = entries.into_iter().collect();
        std::fs::write(
            output.join(format!("{name}.json")),
            serde_json::to_string(&entries).unwrap() + "\n",
        )
        .unwrap();
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
