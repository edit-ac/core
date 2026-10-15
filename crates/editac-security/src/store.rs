//! SEC-1.5 qualification adapter, intentionally absent from production builds.
//! Only ciphertext crosses BlobHost. The host owns atomic durability, key policy,
//! browser transaction lifetimes and trusted freshness. No MLS sender is restored.

use crate::keys::{HostKeyProvider, KeyContext, KeyPurpose, KeySession};
use editac_core::document::{DocumentIdentity, InitializedCheckpoint};
use editac_session::ports::{memory::MemoryStore, *};
use editac_session::session::SessionStore;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    sync::Mutex,
};
use zeroize::Zeroizing;

pub(crate) const MAX_PLAIN: usize = 4 * 1024 * 1024;
pub(crate) const MAX_BLOB: usize = MAX_PLAIN + 64 * 1024;
const MAX_EVENTS: usize = 512;
// Disposable high-entropy test keys only. This is NOT a password policy.
const QUALIFICATION_WORK_FACTOR: u8 = 10;

/// The revision is a CAS token, not a cryptographic sender counter or a proof
/// against malicious full-database rollback. Only successful CAS can acknowledge.
pub(crate) struct Blob {
    pub revision: u64,
    pub ciphertext: Vec<u8>,
}

/// One document/key scope per host instance. Read must bound allocation to limit.
/// CAS is an atomic compare/replacement; Some means expected existing revision,
/// None means create-if-absent. A lost postcommit acknowledgement is CommitUnknown.
/// Native: serialized transaction + fsync. Browser: one IndexedDB readwrite
/// transaction, resolve only on transaction completion, never request success.
/// No plaintext staging, localStorage fallback, silent eviction or volatile ack.
pub(crate) trait BlobHost: Send + Sync {
    fn capabilities(&self) -> StoreCapabilities;
    fn read(&self, limit: usize) -> Result<Option<Blob>, PortError>;
    fn compare_exchange(&self, expected: Option<u64>, next: Blob) -> Result<(), PortError>;
}

/// Browser host port: unlike the synchronous native LocalStore port, IndexedDB
/// cannot run a transaction across an await for key acquisition or encryption.
/// Hosts prepare/seal the complete candidate FIRST, then perform revision read +
/// replacement in ONE readwrite transaction. `compare_exchange` resolves only on
/// `transaction.oncomplete`; abort/quota/versionchange reject without a local ack.
/// Strict durability must be requested/qualified; eviction or unavailable strict
/// durability cannot be advertised as ProcessCrash. On lock/revoke, cancel queued
/// operations and reacquire authorization before preparing the next candidate.
/// The future need not be Send (browser event loops); core never depends on it.
/// This contract alone does not qualify IndexedDB runtime behavior.
#[allow(dead_code)]
pub(crate) trait BrowserBlobHost {
    fn capabilities(&self) -> StoreCapabilities;
    fn read(
        &self,
        limit: usize,
    ) -> impl std::future::Future<Output = Result<Option<Blob>, PortError>>;
    fn compare_exchange(
        &self,
        expected: Option<u64>,
        next: Blob,
    ) -> impl std::future::Future<Output = Result<(), PortError>>;
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Scope {
    profile: String,
    schema: String,
    protocol_version: u32,
    update_encoding: u32,
    offsets: String,
    document_id: String,
    epoch: String,
}
impl From<&DocumentIdentity> for Scope {
    fn from(i: &DocumentIdentity) -> Self {
        Self {
            profile: i.profile.clone(),
            schema: i.schema.clone(),
            protocol_version: i.protocol_version,
            update_encoding: i.update_encoding,
            offsets: i.offsets.clone(),
            document_id: i.document_id.clone(),
            epoch: i.epoch.clone(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    writer: u32,
    sequence: u64,
    checksum: [u8; 32],
}
impl Id {
    fn encode(id: &UpdateId) -> Self {
        Self {
            writer: id.writer,
            sequence: id.sequence,
            checksum: id.checksum,
        }
    }
    fn decode(&self, identity: &DocumentIdentity) -> UpdateId {
        UpdateId {
            identity: identity.clone(),
            writer: self.writer,
            sequence: self.sequence,
            checksum: self.checksum,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    initialized: bool,
    writer: u32,
    bytes: Vec<u8>,
    coverage: Vec<Id>,
    manifest: [u8; 32],
}
impl Point {
    fn encode(c: &CheckpointRecord) -> Self {
        Self {
            initialized: c.checkpoint().initialized,
            writer: c.checkpoint().writer_id,
            bytes: c.checkpoint().bytes.clone(),
            coverage: c.coverage().iter().map(Id::encode).collect(),
            manifest: *c.manifest(),
        }
    }
    fn decode(&self, i: &DocumentIdentity) -> Result<CheckpointRecord, PortError> {
        CheckpointRecord::from_stored(
            InitializedCheckpoint {
                identity: i.clone(),
                initialized: self.initialized,
                writer_id: self.writer,
                bytes: self.bytes.clone(),
            },
            self.coverage.iter().map(|id| id.decode(i)).collect(),
            self.manifest,
        )
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum Event {
    ClaimWriter {
        writer: u32,
    },
    Append {
        id: Id,
        origin: String,
        bytes: Vec<u8>,
    },
    Publish {
        expected: u64,
        point: Point,
    },
    Receipt {
        id: Id,
    },
}
impl Event {
    fn apply(&self, store: &MemoryStore, identity: &DocumentIdentity) -> Result<(), PortError> {
        match self {
            Self::ClaimWriter { writer } => store.claim_writer(*writer)?,
            Self::Append { id, origin, bytes } => {
                store.append(JournalEntry::from_stored(
                    id.decode(identity),
                    origin.clone(),
                    bytes.clone(),
                )?)?;
            }
            Self::Publish { expected, point } => {
                store.publish(*expected, point.decode(identity)?)?;
            }
            Self::Receipt { id } => {
                if store.accept_receipt(
                    ReceiptCapability::DurableV1,
                    DurableReceipt {
                        protocol: ReceiptCapability::DurableV1,
                        update: id.decode(identity),
                    },
                )? != ReceiptResult::RemoteCommitted
                {
                    return Err(PortError::Integrity);
                }
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    scope: Scope,
    document: [u8; 16],
    document_epoch: u64,
    key_epoch: u64,
    revision: u64,
    events: Vec<Event>,
}

/// No plaintext cache survives a call. Key acquisition is checked on each read
/// and before each seal. MemoryStore is only detached validation, never a sink.
pub(crate) struct ProtectedStore<H, K> {
    identity: DocumentIdentity,
    context: KeyContext,
    limits: StoreLimits,
    host: H,
    keys: Mutex<(KeySession, K)>,
}
impl<H: BlobHost, K: HostKeyProvider + Send> ProtectedStore<H, K> {
    pub(crate) fn new(
        identity: DocumentIdentity,
        context: KeyContext,
        limits: StoreLimits,
        host: H,
        keys: K,
    ) -> Result<Self, PortError> {
        if context.purpose != KeyPurpose::LocalStore {
            return Err(PortError::Incompatible);
        }
        let c = host.capabilities();
        if !c.atomic_transactions
            || !c.serialized_writers
            || c.durability != Durability::ProcessCrash
        {
            return Err(PortError::Incompatible);
        }
        MemoryStore::new(identity.clone(), limits)?;
        Ok(Self {
            identity,
            context,
            limits,
            host,
            keys: Mutex::new((KeySession::new(context), keys)),
        })
    }
    fn matches(&self, identity: &DocumentIdentity) -> Result<(), PortError> {
        if identity == &self.identity {
            Ok(())
        } else {
            Err(PortError::Incompatible)
        }
    }
    fn with_key<R>(
        &self,
        f: impl FnOnce(&[u8; 32]) -> Result<R, PortError>,
    ) -> Result<R, PortError> {
        let mut keys = self.keys.lock().map_err(|_| PortError::Unavailable)?;
        let (gateway, host) = &mut *keys;
        gateway
            .with_key(host, |key| Ok(f(key)))
            .map_err(|_| PortError::Permission)?
    }
    fn blank(&self) -> Snapshot {
        Snapshot {
            version: 1,
            scope: Scope::from(&self.identity),
            document: self.context.document,
            document_epoch: self.context.document_epoch,
            key_epoch: self.context.key_epoch,
            revision: 0,
            events: vec![],
        }
    }
    fn load(&self) -> Result<(Option<u64>, Snapshot, MemoryStore), PortError> {
        let blob = self.host.read(MAX_BLOB)?;
        // Even an empty database cannot bypass the host's key-access decision.
        let mut snapshot = self.with_key(|key| match &blob {
            None => Ok(self.blank()),
            Some(blob) => {
                if blob.ciphertext.len() > MAX_BLOB {
                    return Err(PortError::ResourceLimit);
                }
                let bytes = open(key, &blob.ciphertext)?;
                serde_json::from_slice::<Snapshot>(&bytes).map_err(|_| PortError::Integrity)
            }
        })?;
        let revision = blob.as_ref().map(|b| b.revision);
        if snapshot.version != 1
            || snapshot.scope != Scope::from(&self.identity)
            || snapshot.document != self.context.document
            || snapshot.document_epoch != self.context.document_epoch
            || snapshot.key_epoch != self.context.key_epoch
            || snapshot.revision != revision.unwrap_or(0)
            || snapshot.events.len() > MAX_EVENTS
            || (revision.is_some() && snapshot.events.is_empty())
        {
            return Err(PortError::Integrity);
        }
        let store = MemoryStore::new(self.identity.clone(), self.limits)?;
        // Replay only authenticated local-store history, never MLS secret trees.
        for event in &snapshot.events {
            event.apply(&store, &self.identity)?;
        }
        // Keep sensitive data behind the scoped operation, no Debug/log exposure.
        snapshot.events.shrink_to_fit();
        Ok((revision, snapshot, store))
    }
    fn commit(
        &self,
        expected: Option<u64>,
        mut snapshot: Snapshot,
        event: Event,
    ) -> Result<(), PortError> {
        if snapshot.events.len() >= MAX_EVENTS {
            return Err(PortError::ResourceLimit);
        }
        snapshot.revision = expected
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(PortError::ResourceLimit)?;
        snapshot.events.push(event);
        let bytes =
            Zeroizing::new(serde_json::to_vec(&snapshot).map_err(|_| PortError::Integrity)?);
        if bytes.len() > MAX_PLAIN {
            return Err(PortError::ResourceLimit);
        }
        let ciphertext = self.with_key(|key| seal(key, &bytes))?;
        if ciphertext.len() > MAX_BLOB {
            return Err(PortError::ResourceLimit);
        }
        self.host.compare_exchange(
            expected,
            Blob {
                revision: snapshot.revision,
                ciphertext,
            },
        )
    }
}
impl<H: BlobHost, K: HostKeyProvider + Send> SessionStore for ProtectedStore<H, K> {
    fn claim_writer(&self, writer: u32) -> Result<(), PortError> {
        let (revision, snapshot, store) = self.load()?;
        store.claim_writer(writer)?;
        // Persist reservations in the same protected CAS domain as the journal.
        // Reopening must not reuse a previous CRDT writer, even before its first
        // edit. This is NOT an MLS sender ratchet/freshness grant.
        self.commit(revision, snapshot, Event::ClaimWriter { writer })
    }
}
impl<H: BlobHost, K: HostKeyProvider + Send> LocalStore for ProtectedStore<H, K> {
    fn capabilities(&self) -> StoreCapabilities {
        self.host.capabilities()
    }
    fn append(&self, entry: JournalEntry) -> Result<LocalCommit, PortError> {
        self.matches(&entry.id().identity)?;
        let (revision, snapshot, store) = self.load()?;
        let mut result = store.append(entry.clone())?;
        let event = Event::Append {
            id: Id::encode(entry.id()),
            origin: entry.origin().into(),
            bytes: entry.bytes().to_vec(),
        };
        self.commit(revision, snapshot, event)?;
        result.durability = Durability::ProcessCrash;
        Ok(result)
    }
    fn generation(&self, identity: &DocumentIdentity) -> Result<u64, PortError> {
        self.matches(identity)?;
        self.load()?.2.generation(identity)
    }
    fn publish(
        &self,
        expected: u64,
        checkpoint: CheckpointRecord,
    ) -> Result<PublicationCommit, PortError> {
        self.matches(&checkpoint.checkpoint().identity)?;
        let (revision, snapshot, store) = self.load()?;
        let mut result = store.publish(expected, checkpoint.clone())?;
        self.commit(
            revision,
            snapshot,
            Event::Publish {
                expected,
                point: Point::encode(&checkpoint),
            },
        )?;
        result.durability = Durability::ProcessCrash;
        Ok(result)
    }
    fn recover(&self, identity: &DocumentIdentity) -> Result<Recovery, PortError> {
        self.matches(identity)?;
        self.load()?.2.recover(identity)
    }
    fn pending(&self, identity: &DocumentIdentity) -> Result<Vec<JournalEntry>, PortError> {
        self.matches(identity)?;
        self.load()?.2.pending(identity)
    }
    fn accept_receipt(
        &self,
        negotiated: ReceiptCapability,
        receipt: DurableReceipt,
    ) -> Result<ReceiptResult, PortError> {
        self.matches(&receipt.update.identity)?;
        let (revision, snapshot, store) = self.load()?;
        let id = Id::encode(&receipt.update);
        let result = store.accept_receipt(negotiated, receipt)?;
        if result == ReceiptResult::RemoteCommitted {
            self.commit(revision, snapshot, Event::Receipt { id })?;
        }
        Ok(result)
    }
}

fn passphrase(key: &[u8; 32]) -> age::secrecy::SecretString {
    // Encoding, not a KDF or an MLS exporter. The age implementation owns KDF,
    // file keys, nonces, chunk authentication and the final-chunk marker.
    let mut text = Zeroizing::new(String::with_capacity(64));
    use std::fmt::Write;
    for byte in key {
        write!(&mut *text, "{byte:02x}").expect("String write");
    }
    age::secrecy::SecretString::from(std::mem::take(&mut *text))
}
fn seal(key: &[u8; 32], bytes: &[u8]) -> Result<Vec<u8>, PortError> {
    let mut recipient = age::scrypt::Recipient::new(passphrase(key));
    recipient.set_work_factor(QUALIFICATION_WORK_FACTOR);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|_| PortError::Integrity)?;
    let mut ciphertext = Vec::new();
    let mut output = encryptor
        .wrap_output(&mut ciphertext)
        .map_err(|_| PortError::Integrity)?;
    output.write_all(bytes).map_err(|_| PortError::Integrity)?;
    output.finish().map_err(|_| PortError::Integrity)?;
    Ok(ciphertext)
}
fn open(key: &[u8; 32], ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>, PortError> {
    let mut identity = age::scrypt::Identity::new(passphrase(key));
    identity.set_max_work_factor(QUALIFICATION_WORK_FACTOR);
    let decryptor = age::Decryptor::new(ciphertext).map_err(|_| PortError::Integrity)?;
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| PortError::Integrity)?;
    let mut bytes = Zeroizing::new(Vec::new());
    reader
        .take((MAX_PLAIN + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| PortError::Integrity)?;
    if bytes.len() > MAX_PLAIN {
        return Err(PortError::ResourceLimit);
    }
    Ok(bytes)
}
