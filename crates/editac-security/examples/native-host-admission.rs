//! Disposable STB-1.4 host fixture. NOT an exported security API or a relay.
//! JSON lines are local harness control, never an edit.ac transport protocol.
//! Reuses the owning prepared key and MLS services before returning an admitted
//! journal entry to the generated Swift host. No credentials, sockets or IO other
//! than stdin/stdout and an explicitly granted disposable ciphertext SQLite file.
#![allow(dead_code)]
#[path = "../src/envelope.rs"]
mod envelope;
#[path = "../src/keys.rs"]
mod keys;
#[path = "../src/store.rs"]
mod store;
#[path = "../src/store_native.rs"]
mod store_native;
#[path = "../tests/support/mod.rs"]
mod support;
#[path = "../src/sync.rs"]
mod sync;

use editac_core::document::DocumentIdentity;
use editac_session::ports::JournalEntry;
use envelope::{Admission, Context};
use keys::*;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use support::{FixtureProvider, prepared, signer, writers};
use sync::{Admitted, CiphertextTransport, EncryptedClient, OpaqueRelay};
use zeroize::Zeroizing;

fn key_context() -> KeyContext {
    KeyContext {
        document: support::DOCUMENT,
        document_epoch: 11,
        key_epoch: 1,
        purpose: KeyPurpose::ProtocolState,
    }
}
struct PreparedKeys {
    access: Result<(), KeyFailure>,
    foreign: bool,
    acquisitions: usize,
}
impl HostKeyProvider for PreparedKeys {
    fn acquire(&mut self, context: KeyContext) -> Result<DecodedKey, KeyFailure> {
        self.acquisitions += 1;
        self.access?;
        if context != key_context() {
            return Err(KeyFailure::Context);
        }
        let mut returned = context;
        if self.foreign {
            returned.document[0] ^= 1;
        }
        Ok(DecodedKey::from_host(returned, Zeroizing::new([0x61; 32])))
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        self.access
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::RecoveryRequired)
    }
    fn wrap(&mut self, _: KeyContext, _: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn unwrap(&mut self, _: KeyContext, _: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
}
struct Host {
    identity: DocumentIdentity,
    key: KeySession,
    keys: PreparedKeys,
    sender: EncryptedClient<FixtureProvider>,
    receiver: EncryptedClient<FixtureProvider>,
    relay: OpaqueRelay<store_native::SqliteHost>,
    operation: u64,
}
fn identity(value: &Value) -> DocumentIdentity {
    let result = DocumentIdentity::v5(
        value["documentId"].as_str().unwrap(),
        value["epoch"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(editac_core::interchange::identity(&result), *value);
    result
}
impl Host {
    fn new(request: &Value) -> Self {
        let identity = identity(&request["identity"]);
        let context = Context {
            document: support::DOCUMENT,
            document_epoch: 11,
            schema: 3,
            key_epoch: 1,
        };
        let client = |seed| {
            let (provider, group) = prepared(seed);
            let admission = Admission::fresh_prepared_membership(
                provider,
                group,
                context.clone(),
                writers(),
                signer(1).to_public_vec(),
            )
            .ok()
            .unwrap();
            EncryptedClient::fresh_prepared(
                admission,
                signer(seed),
                identity.clone(),
                context.clone(),
            )
            .ok()
            .unwrap()
        };
        let sender = client(1);
        let receiver = client(2);
        let relay = OpaqueRelay::new(
            store_native::SqliteHost::open(
                std::path::Path::new(request["relayPath"].as_str().unwrap()),
                None,
            )
            .unwrap(),
            sender.scope().clone(),
        )
        .unwrap();
        Self {
            identity,
            key: KeySession::new(key_context()),
            keys: PreparedKeys {
                access: Ok(()),
                foreign: false,
                acquisitions: 0,
            },
            sender,
            receiver,
            relay,
            operation: 0,
        }
    }
    fn handle(&mut self, request: &Value) -> Value {
        // Authority is a prepared host decision. It never supplies key access.
        // Native Session independently enforces its actual exclusive lease.
        if request["authorized"] != true {
            return json!({"status":"denied","reason":"authority"});
        }
        self.keys.foreign = request["key"] == "foreign";
        self.keys.access = match request["key"].as_str().unwrap() {
            "ready" | "foreign" => Ok(()),
            "locked" => Err(KeyFailure::Locked),
            "revoked" => Err(KeyFailure::Revoked),
            "unavailable" => Err(KeyFailure::Unavailable),
            _ => panic!("unknown prepared key state"),
        };
        // Owning KeySession checks fresh acquisition and exact context before
        // the plaintext callback. No previous success is a credential cache.
        if let Err(error) = self.key.with_key(&mut self.keys, |_| Ok(())) {
            return json!({"status":"denied","reason":format!("{error:?}"),"acquisitions":self.keys.acquisitions});
        }
        if request.get("update").is_none() {
            return json!({"status":"authorized","acquisitions":self.keys.acquisitions});
        }
        let update = &request["update"];
        if update["identity"] != editac_core::interchange::identity(&self.identity) {
            return json!({"status":"denied","reason":"Context"});
        }
        let entry = JournalEntry::new(
            self.identity.clone(),
            u32::try_from(update["writer"].as_u64().unwrap()).unwrap(),
            update["sequence"].as_u64().unwrap(),
            update["origin"].as_str().unwrap().into(),
            serde_json::from_value(update["bytes"].clone()).unwrap(),
        )
        .unwrap();
        if serde_json::to_value(entry.id().checksum).unwrap() != update["checksum"] {
            return json!({"status":"denied","reason":"Integrity"});
        }
        self.operation += 1;
        let mut operation = [0; 16];
        operation[..8].copy_from_slice(&self.operation.to_be_bytes());
        self.sender.prepare_update(operation, &entry).unwrap();
        self.sender.send(&self.relay, operation).unwrap();
        let mut packet = self
            .relay
            .fetch(self.sender.scope())
            .unwrap()
            .pop()
            .unwrap();
        if request["tamper"] == true {
            *packet.ciphertext.last_mut().unwrap() ^= 1;
        }
        let admitted = match self.receiver.decrypt(&packet) {
            Ok(Admitted::Update(entry)) => entry,
            Ok(Admitted::Checkpoint(_)) => panic!("unexpected checkpoint"),
            Err(error) => {
                return json!({"status":"denied","reason":format!("{error:?}"),"acquisitions":self.keys.acquisitions});
            }
        };
        assert_eq!(entry.id(), admitted.id());
        assert_eq!(entry.bytes(), admitted.bytes());
        json!({"status":"admitted","acquisitions":self.keys.acquisitions,
            "ciphertextBytes":packet.ciphertext.len(),
            "update":{"identity":editac_core::interchange::identity(&self.identity),
                "writer":admitted.id().writer,"sequence":admitted.id().sequence,
                "checksum":admitted.id().checksum,"origin":admitted.origin(),"bytes":admitted.bytes()}})
    }
}
fn main() {
    let mut host = None;
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        assert!(line.len() <= 2 * 1024 * 1024, "fixture input bound");
        let request: Value = serde_json::from_str(&line).unwrap();
        let response = if request["action"] == "start" {
            assert!(host.is_none());
            host = Some(Host::new(&request));
            json!({"status":"started","productionEncryptionQualified":false})
        } else {
            host.as_mut().unwrap().handle(&request)
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
