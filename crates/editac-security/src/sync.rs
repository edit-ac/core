//! SEC-1.6 prepared collaboration adapter, absent from production builds.
//! The relay has no MLS keys, semantic validator, search or plaintext receipt.
//! Its authenticated host transport is a prepared trust boundary, not TLS proof.
use crate::envelope::membership::{MembershipState, Rotation};
use crate::{
    envelope::{Admission, Context, MAX_ENVELOPE, MAX_UPDATE, Rejection},
    store::{Blob, BlobHost},
};
use editac_core::document::{Document, DocumentIdentity, InitializedCheckpoint};
use editac_session::ports::*;
use editac_session::session::{Session, SessionError, SessionStore};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::OpenMlsProvider;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const MAX_PACKETS: usize = 24;
const MAX_RELAY: usize = 2 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Scope {
    profile: String,
    version: u32,
    document: [u8; 16],
    document_epoch: u64,
    schema: u32,
    key_epoch: u64,
    // Bind every engine identity field too, rather than trusting relay routing.
    engine: Vec<String>,
}
impl Scope {
    pub(crate) fn key_epoch(&self) -> u64 {
        self.key_epoch
    }
    pub(crate) fn prepared(identity: &DocumentIdentity, context: &Context) -> Self {
        Self {
            profile: "editac/prepared-mls/v1".into(),
            version: 1,
            document: context.document,
            document_epoch: context.document_epoch,
            schema: context.schema,
            key_epoch: context.key_epoch,
            engine: vec![
                identity.document_id.clone(),
                identity.epoch.clone(),
                identity.schema.clone(),
                identity.profile.clone(),
                identity.offsets.clone(),
                identity.protocol_version.to_string(),
                identity.update_encoding.to_string(),
            ],
        }
    }
    fn valid(&self) -> bool {
        self.profile == "editac/prepared-mls/v1"
            && self.version == 1
            && self.document != [0; 16]
            && self.document_epoch != 0
            && self.schema != 0
            && self.engine.len() == 7
            && self.engine.iter().all(|s| !s.is_empty() && s.len() <= 256)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Packet {
    pub scope: Scope,
    pub ciphertext: Vec<u8>,
}
impl Packet {
    fn validate(&self, scope: &Scope) -> Result<(), PortError> {
        if &self.scope != scope || !scope.valid() {
            return Err(PortError::Incompatible);
        }
        if self.ciphertext.is_empty() || self.ciphertext.len() > MAX_ENVELOPE {
            return Err(PortError::ResourceLimit);
        }
        // Public MLS 1.0/private-message framing is inspectable without keys.
        // Reject accidental plaintext and unsupported MLS families at the relay.
        // This is framing admission only, never authentication/schema validation.
        if self.ciphertext.len() < 4 || self.ciphertext[..4] != [0, 1, 0, 2] {
            return Err(PortError::Incompatible);
        }
        Ok(())
    }
    fn digest(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"editac/ciphertext-receipt/v1\0");
        let binding = serde_json::to_vec(&self.scope).expect("bounded public metadata");
        h.update((binding.len() as u64).to_be_bytes());
        h.update(binding);
        h.update((self.ciphertext.len() as u64).to_be_bytes());
        h.update(&self.ciphertext);
        h.finalize().into()
    }
}
/// This deliberately cannot be passed to Session::accept_receipt. It attests to
/// storage of exact ciphertext in this scope, never plaintext validation/apply.
#[derive(Clone)]
pub(crate) struct CiphertextReceipt {
    pub scope: Scope,
    pub digest: [u8; 32],
}

/// Host authenticates and authorizes this channel independently of MLS keys.
/// No plaintext send method and no optional/baseline negotiation fallback.
pub(crate) trait CiphertextTransport {
    fn negotiate(&self, expected: &Scope) -> Result<(), PortError>;
    fn put(&self, packet: Packet) -> Result<CiphertextReceipt, PortError>;
    fn fetch(&self, expected: &Scope) -> Result<Vec<Packet>, PortError>;
}
pub(crate) struct OpaqueRelay<H> {
    host: H,
    scope: Scope,
}
impl<H: BlobHost> OpaqueRelay<H> {
    pub(crate) fn new(host: H, scope: Scope) -> Result<Self, PortError> {
        let c = host.capabilities();
        if !scope.valid()
            || c.durability != Durability::ProcessCrash
            || !c.atomic_transactions
            || !c.serialized_writers
        {
            return Err(PortError::Incompatible);
        }
        Ok(Self { host, scope })
    }
    fn load(&self) -> Result<(Option<u64>, Vec<Packet>), PortError> {
        let Some(blob) = self.host.read(MAX_RELAY)? else {
            return Ok((None, vec![]));
        };
        let packets: Vec<Packet> =
            serde_json::from_slice(&blob.ciphertext).map_err(|_| PortError::Integrity)?;
        if packets.len() > MAX_PACKETS {
            return Err(PortError::ResourceLimit);
        }
        for packet in &packets {
            packet.validate(&self.scope)?;
        }
        Ok((Some(blob.revision), packets))
    }
}
impl<H: BlobHost> CiphertextTransport for OpaqueRelay<H> {
    fn negotiate(&self, expected: &Scope) -> Result<(), PortError> {
        if expected == &self.scope && expected.valid() {
            Ok(())
        } else {
            Err(PortError::Incompatible)
        }
    }
    fn put(&self, packet: Packet) -> Result<CiphertextReceipt, PortError> {
        packet.validate(&self.scope)?;
        let digest = packet.digest();
        let (revision, mut packets) = self.load()?;
        if !packets.iter().any(|p| p.digest() == digest) {
            if packets.len() >= MAX_PACKETS {
                return Err(PortError::Backpressure);
            }
            packets.push(packet);
            let bytes = serde_json::to_vec(&packets).map_err(|_| PortError::Integrity)?;
            if bytes.len() > MAX_RELAY {
                return Err(PortError::Backpressure);
            }
            let next = revision
                .unwrap_or(0)
                .checked_add(1)
                .ok_or(PortError::ResourceLimit)?;
            self.host.compare_exchange(
                revision,
                Blob {
                    revision: next,
                    ciphertext: bytes,
                },
            )?;
        }
        Ok(CiphertextReceipt {
            scope: self.scope.clone(),
            digest,
        })
    }
    fn fetch(&self, expected: &Scope) -> Result<Vec<Packet>, PortError> {
        self.negotiate(expected)?;
        Ok(self.load()?.1)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    scope: Scope,
    checkpoint: bool,
    writer: u32,
    sequence: u64,
    origin: String,
    bytes: Vec<u8>,
}
pub(crate) enum Admitted {
    Checkpoint(InitializedCheckpoint),
    Update(JournalEntry),
}
struct Pending {
    packet: Packet,
    update: Option<UpdateId>,
    acknowledged: bool,
}
/// A fresh trusted MLS admission is mandatory. Restored Admission stays locked.
/// Retry uses retained exact bytes; failure never reseals the same operation.
/// After process loss, retain protected journal and rejoin with a fresh sender;
/// neither persisted document bytes nor CRDT writer reservations unlock MLS.
pub(crate) struct EncryptedClient<P: OpenMlsProvider> {
    admission: Admission<P>,
    signer: SignatureKeyPair,
    scope: Scope,
    identity: DocumentIdentity,
    pending: BTreeMap<[u8; 16], Pending>,
    retry_apply: BTreeMap<[u8; 32], JournalEntry>,
    retired: bool,
    // Retained protected journal IDs cannot be relabeled as new epoch work.
    // No release/export API exists here: recovery is retain-only until an
    // explicit separately authorized host recovery/export workflow is used.
    recovery: Vec<UpdateId>,
}
impl<P: OpenMlsProvider> EncryptedClient<P> {
    pub(crate) fn fresh_prepared(
        admission: Admission<P>,
        signer: SignatureKeyPair,
        identity: DocumentIdentity,
        context: Context,
    ) -> Result<Self, Rejection> {
        if !admission.matches_context(&context) {
            return Err(Rejection::Context);
        }
        Ok(Self {
            admission,
            signer,
            scope: Scope::prepared(&identity, &context),
            identity,
            pending: BTreeMap::new(),
            retry_apply: BTreeMap::new(),
            retired: false,
            recovery: Vec::new(),
        })
    }
    pub(crate) fn scope(&self) -> &Scope {
        &self.scope
    }
    pub(crate) fn retire_after_restore(&mut self) {
        self.retired = true;
        self.admission.retire_after_restore();
    }
    fn retain_before_rotation(&mut self, store: &impl LocalStore) -> Result<(), PortError> {
        if self.retired {
            return Err(PortError::Permission);
        }
        // Finish an authenticated local-append retry before changing epochs.
        if !self.retry_apply.is_empty() {
            return Err(PortError::Conflict);
        }
        let entries = store.pending(&self.identity)?;
        if entries.len() > 4096 {
            return Err(PortError::Backpressure);
        }
        let additional = entries
            .iter()
            .filter(|entry| !self.recovery.contains(entry.id()))
            .count();
        if self.recovery.len() + additional > 4096 {
            return Err(PortError::Backpressure);
        }
        for entry in entries {
            if !self.recovery.contains(entry.id()) {
                self.recovery.push(entry.id().clone());
            }
        }
        Ok(())
    }
    /// Host quiesces Session writes for this synchronous transition. Local
    /// at-rest keys are independent of MLS epochs and are never deleted here.
    pub(crate) fn rotate_membership(
        &mut self,
        plan: &Rotation,
        store: &impl LocalStore,
    ) -> Result<Packet, PortError> {
        self.retain_before_rotation(store)?;
        match self.admission.rotate(&self.signer, plan) {
            Ok(wire) => {
                let packet = Packet {
                    scope: self.scope.clone(),
                    ciphertext: wire,
                };
                self.scope.key_epoch = plan.next_epoch;
                Ok(packet)
            }
            Err(_) => {
                self.retire_after_restore();
                Err(PortError::Permission)
            }
        }
    }
    pub(crate) fn receive_membership(
        &mut self,
        plan: &Rotation,
        packet: &Packet,
        store: &impl LocalStore,
    ) -> Result<MembershipState, PortError> {
        packet.validate(&self.scope)?;
        self.retain_before_rotation(store)?;
        match self.admission.receive_rotation(plan, &packet.ciphertext) {
            Ok(state) => {
                self.scope.key_epoch = plan.next_epoch;
                if state == MembershipState::Revoked {
                    self.retired = true;
                }
                Ok(state)
            }
            Err(_) => {
                self.retire_after_restore();
                Err(PortError::Permission)
            }
        }
    }
    /// Metadata only. The journal remains protected in LocalStore; acquired
    /// plaintext/keys are not erased, and nothing is implicitly exported.
    pub(crate) fn recovery_required(&self) -> &[UpdateId] {
        &self.recovery
    }
    pub(crate) fn quarantined(&self, operation: [u8; 16]) -> bool {
        self.pending
            .get(&operation)
            .is_some_and(|p| p.packet.scope != self.scope || self.retired)
    }
    fn prepare(
        &mut self,
        operation: [u8; 16],
        payload: Payload,
        update: Option<UpdateId>,
    ) -> Result<(), Rejection> {
        if self.retired {
            return Err(Rejection::Locked);
        }
        // A new checkpoint/delta may incorporate quarantined local state.
        // Freeze ALL outbound publication until a separate explicit recovery
        // workflow rebases that work; never smuggle it into a fresh operation.
        if !self.recovery.is_empty() {
            return Err(Rejection::Unauthorized);
        }
        if self.pending.contains_key(&operation) {
            return Err(Rejection::Replay);
        }
        let plain = Zeroizing::new(serde_json::to_vec(&payload).map_err(|_| Rejection::Context)?);
        if plain.len() > MAX_UPDATE {
            return Err(Rejection::Bounds);
        }
        let ciphertext = self.admission.seal(&self.signer, operation, &plain)?;
        self.pending.insert(
            operation,
            Pending {
                packet: Packet {
                    scope: self.scope.clone(),
                    ciphertext,
                },
                update,
                acknowledged: false,
            },
        );
        Ok(())
    }
    /// Called only for committed protected-store entries, verified before sealing.
    pub(crate) fn prepare_update(
        &mut self,
        operation: [u8; 16],
        entry: &JournalEntry,
    ) -> Result<(), Rejection> {
        if self.recovery.contains(entry.id()) {
            return Err(Rejection::Unauthorized);
        }
        if entry.id().identity != self.identity {
            return Err(Rejection::Context);
        }
        JournalEntry::from_stored(
            entry.id().clone(),
            entry.origin().into(),
            entry.bytes().to_vec(),
        )
        .map_err(|_| Rejection::Context)?;
        self.prepare(
            operation,
            Payload {
                scope: self.scope.clone(),
                checkpoint: false,
                writer: entry.id().writer,
                sequence: entry.id().sequence,
                origin: entry.origin().into(),
                bytes: entry.bytes().to_vec(),
            },
            Some(entry.id().clone()),
        )
    }
    pub(crate) fn prepare_checkpoint(
        &mut self,
        operation: [u8; 16],
        point: &InitializedCheckpoint,
    ) -> Result<(), Rejection> {
        if point.identity != self.identity || !point.initialized {
            return Err(Rejection::Context);
        }
        self.prepare(
            operation,
            Payload {
                scope: self.scope.clone(),
                checkpoint: true,
                writer: point.writer_id,
                sequence: 0,
                origin: "checkpoint".into(),
                bytes: point.bytes.clone(),
            },
            None,
        )
    }
    pub(crate) fn send(
        &mut self,
        transport: &impl CiphertextTransport,
        operation: [u8; 16],
    ) -> Result<CiphertextReceipt, PortError> {
        if self.retired {
            return Err(PortError::Permission);
        }
        transport.negotiate(&self.scope)?;
        let pending = self
            .pending
            .get(&operation)
            .ok_or(PortError::InvalidRecord)?;
        if pending.packet.scope != self.scope {
            return Err(PortError::Incompatible);
        }
        let receipt = transport.put(pending.packet.clone())?;
        self.accept(&receipt)?;
        Ok(receipt)
    }
    /// Marks only the client's exact ciphertext mapping; never prunes LocalStore
    /// through a plaintext DurableReceipt or claims that peers applied semantics.
    pub(crate) fn accept(
        &mut self,
        receipt: &CiphertextReceipt,
    ) -> Result<Option<UpdateId>, PortError> {
        if receipt.scope != self.scope {
            return Err(PortError::Incompatible);
        }
        let pending = self
            .pending
            .values_mut()
            .find(|p| p.packet.digest() == receipt.digest)
            .ok_or(PortError::Integrity)?;
        pending.acknowledged = true;
        Ok(pending.update.clone())
    }
    pub(crate) fn stored(&self, operation: [u8; 16]) -> bool {
        self.pending.get(&operation).is_some_and(|p| p.acknowledged)
    }
    /// Explicit initial import. Existing state cannot be replaced by a remote
    /// checkpoint. Validate Yrs/schema before protected publication.
    pub(crate) fn bootstrap(
        &mut self,
        packet: &Packet,
        store: &impl LocalStore,
    ) -> Result<(), PortError> {
        if store.generation(&self.identity)? != 0 {
            return Err(PortError::Conflict);
        }
        let Admitted::Checkpoint(point) = self.decrypt(packet).map_err(|_| PortError::Integrity)?
        else {
            return Err(PortError::InvalidRecord);
        };
        Document::restore(&self.identity, &point, &[]).map_err(|_| PortError::Integrity)?;
        store.publish(0, CheckpointRecord::new(point, vec![])?)?;
        Ok(())
    }
    /// Authentication precedes Session's real schema validation, protected store
    /// append and Yrs apply. A failed local append retains the authenticated entry
    /// in scoped memory for retry after host recovery, never reusing a sender.
    pub(crate) fn receive_update<S: SessionStore>(
        &mut self,
        packet: &Packet,
        session: &mut Session<S>,
    ) -> Result<LocalCommit, PortError> {
        if self.retired {
            return Err(PortError::Permission);
        }
        packet.validate(&self.scope)?;
        let digest = packet.digest();
        if !self.retry_apply.contains_key(&digest) {
            if self.retry_apply.len() >= MAX_PACKETS {
                return Err(PortError::Backpressure);
            }
            let Admitted::Update(entry) = self.decrypt(packet).map_err(|_| PortError::Integrity)?
            else {
                return Err(PortError::InvalidRecord);
            };
            self.retry_apply.insert(digest, entry);
        }
        let entry = self.retry_apply.get(&digest).unwrap().clone();
        match session.receive_peer(entry) {
            Ok(commit) => {
                self.retry_apply.remove(&digest);
                Ok(commit)
            }
            Err(SessionError::Store(error)) => Err(error),
            Err(SessionError::RecoveryRequired) => Err(PortError::Unavailable),
            Err(_) => {
                // A semantic rejection is not a transient storage retry.
                self.retry_apply.remove(&digest);
                Err(PortError::Integrity)
            }
        }
    }
    pub(crate) fn decrypt(&mut self, packet: &Packet) -> Result<Admitted, Rejection> {
        if self.retired {
            return Err(Rejection::Locked);
        }
        packet
            .validate(&self.scope)
            .map_err(|_| Rejection::Context)?;
        let plain = match self.admission.admit(&packet.ciphertext) {
            Ok(plain) => Zeroizing::new(plain),
            Err(error) => {
                // MLS processing can consume receive ratchet state even when
                // authentication fails. Do not pretend the endpoint can resume
                // or roll back protocol state. Retire and preserve local work.
                self.retire_after_restore();
                return Err(error);
            }
        };
        let payload: Payload = serde_json::from_slice(&plain).map_err(|_| Rejection::Context)?;
        if payload.scope != self.scope {
            return Err(Rejection::Context);
        }
        if payload.checkpoint {
            if payload.sequence != 0 || payload.writer == 0 || payload.bytes.is_empty() {
                return Err(Rejection::Context);
            }
            Ok(Admitted::Checkpoint(InitializedCheckpoint {
                identity: self.identity.clone(),
                initialized: true,
                writer_id: payload.writer,
                bytes: payload.bytes,
            }))
        } else {
            JournalEntry::new(
                self.identity.clone(),
                payload.writer,
                payload.sequence,
                payload.origin,
                payload.bytes,
            )
            .map(Admitted::Update)
            .map_err(|_| Rejection::Context)
        }
    }
}
