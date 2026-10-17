//! Host-authenticated request identity and immutable retained proposals.
//! Records are retained for the lifetime of the store, bounded by StoreLimits.
//! Capacity exhaustion rejects/fails closed; no receipt is silently evicted.
use crate::{
    edit_service::PreparedEdit, operations::HostActor, ports::*, revision::ObservedRevision,
};
use editac_core::document::DocumentIdentity;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestToken {
    pub(crate) actor: String,
    pub(crate) id: String,
    pub(crate) scope: [u8; 32],
    pub(crate) payload: [u8; 32],
}
impl RequestToken {
    /// Bounded v1 retry envelope, not a credential. Persist with the caller's request.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = vec![1, self.actor.len() as u8, self.id.len() as u8];
        bytes.extend(self.actor.as_bytes());
        bytes.extend(self.id.as_bytes());
        bytes.extend(self.scope);
        bytes.extend(self.payload);
        bytes
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, RequestError> {
        if bytes.len() < 67 || bytes.len() > 323 || bytes[0] != 1 {
            return Err(RequestError::InvalidRequest);
        }
        let a = bytes[1] as usize;
        let b = bytes[2] as usize;
        if a == 0 || a > 128 || b == 0 || b > 128 || bytes.len() != 67 + a + b {
            return Err(RequestError::InvalidRequest);
        }
        let actor = std::str::from_utf8(&bytes[3..3 + a])
            .map_err(|_| RequestError::InvalidRequest)?
            .to_owned();
        let id = std::str::from_utf8(&bytes[3 + a..3 + a + b])
            .map_err(|_| RequestError::InvalidRequest)?
            .to_owned();
        if actor.chars().chain(id.chars()).any(char::is_control) {
            return Err(RequestError::InvalidRequest);
        }
        let mut scope = [0; 32];
        let mut payload = [0; 32];
        scope.copy_from_slice(&bytes[3 + a + b..35 + a + b]);
        payload.copy_from_slice(&bytes[35 + a + b..]);
        Ok(Self {
            actor,
            id,
            scope,
            payload,
        })
    }
    pub fn request_id(&self) -> &str {
        &self.id
    }
    pub(crate) fn matches(&self, identity: &DocumentIdentity) -> bool {
        self.scope == scope_hash(identity)
    }
}
pub(crate) fn scope_hash(identity: &DocumentIdentity) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash_scope(&mut hash, identity);
    hash.finalize().into()
}
pub(crate) fn payload_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}
pub(crate) fn payload_hash(value: impl AsRef<[u8]>) -> [u8; 32] {
    Sha256::digest(value.as_ref()).into()
}

/// The host keeps this opaque token with its bounded immutable proposal.
/// Its actor is authenticated independently again at apply/lookup. A token grants no access.
pub struct RequestProposal {
    pub(crate) token: RequestToken,
    pub(crate) prepared: PreparedEdit,
    pub(crate) expires_at: u64,
}
impl RequestProposal {
    pub fn token(&self) -> &RequestToken {
        &self.token
    }
}

/// Snapshot encoding is private to the store. Scope includes document, epoch and profile.
#[cfg_attr(feature = "native-store", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "native-store", serde(deny_unknown_fields))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestRecord {
    pub(crate) actor: String,
    pub(crate) id: String,
    pub(crate) scope: [u8; 32],
    pub(crate) payload: [u8; 32],
    pub(crate) revision: Vec<u8>,
    pub(crate) update: Option<(u32, u64, [u8; 32])>,
}
impl RequestRecord {
    pub(crate) fn key_matches(&self, token: &RequestToken) -> bool {
        self.scope == token.scope && self.actor == token.actor && self.id == token.id
    }
    pub(crate) fn verify(&self, identity: &DocumentIdentity) -> Result<(), PortError> {
        if self.scope != scope_hash(identity)
            || self.actor.is_empty()
            || self.actor.len() > 128
            || self.id.is_empty()
            || self.id.len() > 128
            || self.actor.chars().any(char::is_control)
            || self.id.chars().any(char::is_control)
            || ObservedRevision::from_bytes(&self.revision).is_err()
        {
            return Err(PortError::Integrity);
        }
        Ok(())
    }
    pub fn revision(&self) -> ObservedRevision {
        ObservedRevision::from_bytes(&self.revision).expect("verified receipt")
    }
    pub fn update(&self, identity: &DocumentIdentity) -> Option<UpdateId> {
        self.update.map(|(writer, sequence, checksum)| UpdateId {
            identity: identity.clone(),
            writer,
            sequence,
            checksum,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestReceipt {
    pub result: RequestRecord,
    pub local: Durability,
}
#[derive(Debug)]
pub enum RequestError {
    Unauthorized,
    InvalidRequest,
    ChangedPayload,
    Expired,
    Cancelled,
    MissingProposal,
    Service(crate::edit_service::ServiceError),
    /// The engine may have committed. Recover this identity, never retry as a new request.
    Pending {
        request: RequestToken,
        error: PortError,
    },
}
impl From<crate::edit_service::ServiceError> for RequestError {
    fn from(error: crate::edit_service::ServiceError) -> Self {
        Self::Service(error)
    }
}
impl From<crate::session::SessionError> for RequestError {
    fn from(error: crate::session::SessionError) -> Self {
        Self::Service(error.into())
    }
}
pub(crate) fn authorize(
    token: &RequestToken,
    actor: &HostActor,
    identity: &DocumentIdentity,
) -> Result<(), RequestError> {
    if token.actor != actor.subject() || !token.matches(identity) {
        Err(RequestError::Unauthorized)
    } else {
        Ok(())
    }
}
