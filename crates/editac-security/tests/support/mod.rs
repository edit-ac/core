//! Fixed, public, disposable test keys/state. Never use for actual documents.
use std::{cell::RefCell, collections::BTreeSet};

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::{MemoryStorage, OpenMlsRustCrypto, RustCrypto};
use openmls_traits::{OpenMlsProvider, random::OpenMlsRand};
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};

pub const DOCUMENT: [u8; 16] = [7; 16];
pub const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

pub struct FixtureRandom(RefCell<ChaCha20Rng>);

impl OpenMlsRand for FixtureRandom {
    type Error = std::convert::Infallible;
    fn random_array<const N: usize>(&self) -> Result<[u8; N], Self::Error> {
        let mut bytes = [0; N];
        self.0.borrow_mut().fill_bytes(&mut bytes);
        Ok(bytes)
    }
    fn random_vec(&self, len: usize) -> Result<Vec<u8>, Self::Error> {
        let mut bytes = vec![0; len];
        self.0.borrow_mut().fill_bytes(&mut bytes);
        Ok(bytes)
    }
}

pub struct FixtureProvider {
    inner: OpenMlsRustCrypto,
    random: FixtureRandom,
}

impl FixtureProvider {
    pub fn new(seed: u8) -> Self {
        Self {
            inner: OpenMlsRustCrypto::default(),
            random: FixtureRandom(RefCell::new(ChaCha20Rng::from_seed([seed; 32]))),
        }
    }
}

impl OpenMlsProvider for FixtureProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = FixtureRandom;
    type StorageProvider = MemoryStorage;
    fn crypto(&self) -> &RustCrypto {
        self.inner.crypto()
    }
    fn rand(&self) -> &FixtureRandom {
        &self.random
    }
    fn storage(&self) -> &MemoryStorage {
        self.inner.storage()
    }
}

pub fn signer(seed: u8) -> SignatureKeyPair {
    let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    SignatureKeyPair::from_raw(
        SUITE.signature_algorithm(),
        key.to_bytes().to_vec(),
        key.verifying_key().to_bytes().to_vec(),
    )
}

pub fn credential(signer: &SignatureKeyPair) -> CredentialWithKey {
    CredentialWithKey {
        // Deliberately identical labels: policy must bind the signing key.
        credential: BasicCredential::new(b"claimed-writer".to_vec()).into(),
        signature_key: signer.to_public_vec().into(),
    }
}

pub fn writers() -> BTreeSet<Vec<u8>> {
    [signer(1).to_public_vec()].into()
}

pub fn decode_hex(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

pub fn prepared(seed: u8) -> (FixtureProvider, MlsGroup) {
    let text = match seed {
        1 => include_str!("../fixtures/writer.json"),
        2 => include_str!("../fixtures/receiver.json"),
        3 => include_str!("../fixtures/reader.json"),
        4 => include_str!("../fixtures/wrong-key.json"),
        _ => panic!("unknown prepared identity"),
    };
    let entries: Vec<(String, String)> = serde_json::from_str(text).unwrap();
    let provider = FixtureProvider::new(seed + 100);
    *provider.storage().values.write().unwrap() = entries
        .into_iter()
        .map(|(key, value)| (decode_hex(&key), decode_hex(&value)))
        .collect();
    let group = MlsGroup::load(provider.storage(), &GroupId::from_slice(&DOCUMENT))
        .unwrap()
        .unwrap();
    (provider, group)
}
