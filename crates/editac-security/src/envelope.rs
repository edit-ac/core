//! Prepared MLS admission mechanics, deliberately absent from production builds.
//!
//! The fixture harness supplies a freshly established, trusted group and pinned
//! policy. No host identity verifier or durable freshness provider is qualified.
//! Restored groups are locked unconditionally: rejoin with a fresh MLS sender is
//! required. Memory storage is never represented as transactional persistence.

#[path = "membership.rs"]
pub(crate) mod membership;

use std::collections::BTreeSet;

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize as _, Serialize as _};

pub(crate) const MAX_UPDATE: usize = 64 * 1024;
pub(crate) const MAX_ENVELOPE: usize = MAX_UPDATE + 4096;
const MAX_OPERATIONS: usize = 4096;
const DOMAIN: &[u8] = b"editac/prepared-mls-update/v1\0";

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Context {
    pub document: [u8; 16],
    pub document_epoch: u64,
    pub schema: u32,
    pub key_epoch: u64,
}

impl Context {
    pub(crate) fn aad(&self, operation: [u8; 16]) -> Vec<u8> {
        [
            DOMAIN,
            self.document.as_slice(),
            self.document_epoch.to_be_bytes().as_slice(),
            self.schema.to_be_bytes().as_slice(),
            self.key_epoch.to_be_bytes().as_slice(),
            operation.as_slice(),
        ]
        .concat()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    Locked,
    Bounds,
    Context,
    Authentication,
    Unauthorized,
    Unsupported,
    Replay,
}

/// Deliberately no Debug, Clone, export, or state-resume API.
pub(crate) struct Admission<P: OpenMlsProvider> {
    provider: P,
    group: MlsGroup,
    context: Context,
    // Trusted host policy pins MLS signature keys, never BasicCredential labels.
    writers: BTreeSet<Vec<u8>>,
    applied: BTreeSet<[u8; 16]>,
    emitted: BTreeSet<[u8; 16]>,
    locked: bool,
    membership_authority: Option<Vec<u8>>,
}

impl<P: OpenMlsProvider> Admission<P> {
    /// Only the prepared harness can establish this fresh-session trust root.
    /// A real host must prove authenticated policy, freshness and transactional
    /// persistence before an equivalent constructor can be exposed.
    pub(crate) fn fresh_prepared(
        provider: P,
        group: MlsGroup,
        context: Context,
        writers: BTreeSet<Vec<u8>>,
    ) -> Result<Self, Rejection> {
        if group.group_id().as_slice() != context.document
            || group.epoch().as_u64() != context.key_epoch
        {
            return Err(Rejection::Context);
        }
        if writers.is_empty()
            || writers
                .iter()
                .any(|key| !group.members().any(|member| member.signature_key == *key))
        {
            return Err(Rejection::Unauthorized);
        }
        Ok(Self {
            provider,
            group,
            context,
            writers,
            applied: BTreeSet::new(),
            emitted: BTreeSet::new(),
            locked: false,
            membership_authority: None,
        })
    }

    /// Compare the pinned MLS binding before attaching a prepared transport.
    pub(crate) fn matches_context(&self, context: &Context) -> bool {
        &self.context == context
    }

    /// Any restore/crash/fork notification permanently retires this session.
    /// No ciphertext is emitted and no plaintext is returned while locked.
    pub(crate) fn retire_after_restore(&mut self) {
        self.locked = true;
    }

    /// Loading protocol bytes never establishes freshness, even if every byte
    /// authenticates. There is intentionally no unlock/resume method.
    pub(crate) fn restored_prepared(
        provider: P,
        group: MlsGroup,
        context: Context,
        writers: BTreeSet<Vec<u8>>,
    ) -> Result<Self, Rejection> {
        let mut admission = Self::fresh_prepared(provider, group, context, writers)?;
        admission.retire_after_restore();
        Ok(admission)
    }

    pub(crate) fn seal(
        &mut self,
        signer: &SignatureKeyPair,
        operation: [u8; 16],
        update: &[u8],
    ) -> Result<Vec<u8>, Rejection> {
        self.require_live()?;
        if update.is_empty() || update.len() > MAX_UPDATE {
            return Err(Rejection::Bounds);
        }
        // Check own pinned leaf as well as signer: passing another writer's key
        // must not authorize a reader's MLS leaf.
        let own = self.group.own_leaf_node().ok_or(Rejection::Locked)?;
        if !self.writers.contains(own.signature_key().as_slice())
            || own.signature_key().as_slice() != signer.to_public_vec()
        {
            return Err(Rejection::Unauthorized);
        }
        if operation == [0; 16] || !self.emitted.insert(operation) {
            return Err(Rejection::Replay);
        }
        self.group.set_aad(self.context.aad(operation));
        let result = self
            .group
            .create_message(&self.provider, signer, update)
            .map_err(|_| Rejection::Authentication)
            .and_then(|message| {
                message
                    .tls_serialize_detached()
                    .map_err(|_| Rejection::Authentication)
            });
        // Ambiguous protocol/persistence failure can never retry a sender state.
        if result.is_err() {
            self.locked = true;
        }
        result
    }

    /// Returns plaintext only after all authentication/context/policy checks.
    /// The host must separately validate update semantics before engine apply.
    /// Receipt/journal atomicity is a later gate, not supplied by this return.
    pub(crate) fn admit(&mut self, wire: &[u8]) -> Result<Vec<u8>, Rejection> {
        self.require_live()?;
        if wire.is_empty() || wire.len() > MAX_ENVELOPE {
            return Err(Rejection::Bounds);
        }
        // MLS 1.0, private_message only. Reject other MLS source families before
        // decoding their potentially nested key packages/proposals/extensions.
        if wire.len() < 4 || wire[..2] != [0, 1] {
            return Err(Rejection::Authentication);
        }
        if wire[2..4] != [0, 2] {
            return Err(Rejection::Unsupported);
        }
        // Bound the outer bytes before the upstream TLS decoder allocates.
        // Exact decoding rejects a valid message with an appended second frame.
        let message =
            MlsMessageIn::tls_deserialize_exact(wire).map_err(|_| Rejection::Authentication)?;
        if message.wire_format() != WireFormat::PrivateMessage {
            return Err(Rejection::Unsupported);
        }
        let message = message
            .try_into_protocol_message()
            .map_err(|_| Rejection::Unsupported)?;
        if message.group_id().as_slice() != self.context.document
            || message.epoch().as_u64() != self.context.key_epoch
        {
            return Err(Rejection::Context);
        }
        let processed = self
            .group
            .process_message(&self.provider, message)
            .map_err(|_| Rejection::Authentication)?;
        // No proposals are queued and no commits are merged by this adapter.
        if !matches!(
            processed.content(),
            ProcessedMessageContent::ApplicationMessage(_)
        ) {
            return Err(Rejection::Unsupported);
        }
        let Sender::Member(index) = processed.sender() else {
            return Err(Rejection::Unauthorized);
        };
        let member = self
            .group
            .members()
            .find(|member| member.index == *index)
            .ok_or(Rejection::Unauthorized)?;
        if !self.writers.contains(&member.signature_key)
            || &member.credential != processed.credential()
        {
            return Err(Rejection::Unauthorized);
        }
        let aad = processed.aad();
        let expected_length = self.context.aad([0; 16]).len();
        if aad.len() != expected_length {
            return Err(Rejection::Context);
        }
        let operation: [u8; 16] = aad[aad.len() - 16..].try_into().unwrap();
        if aad != self.context.aad(operation) {
            return Err(Rejection::Context);
        }
        if operation == [0; 16] || self.applied.contains(&operation) {
            return Err(Rejection::Replay);
        }
        let ProcessedMessageContent::ApplicationMessage(application) = processed.into_content()
        else {
            return Err(Rejection::Unsupported);
        };
        let update = application.into_bytes();
        if update.is_empty() || update.len() > MAX_UPDATE {
            return Err(Rejection::Bounds);
        }
        self.applied.insert(operation);
        Ok(update)
    }

    fn require_live(&self) -> Result<(), Rejection> {
        if self.locked {
            Err(Rejection::Locked)
        } else if self.applied.len() >= MAX_OPERATIONS || self.emitted.len() >= MAX_OPERATIONS {
            Err(Rejection::Bounds)
        } else {
            Ok(())
        }
    }
}
