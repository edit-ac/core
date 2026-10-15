//! SEC-1.8 prepared adapters. Not compiled into the production library.
//! One immutable asset per BlobHost partition. All descriptive metadata is
//! encrypted. The host supplies opaque IDs, current authorization and old keys;
//! neither authored URLs nor possession of a cache reference grants key access.
//! No network fetch, plaintext persistence, ambient export or fallback exists.
use crate::{
    keys::{HostKeyProvider, KeyContext, KeyFailure, KeyPurpose, KeySession},
    store::{self, Blob, BlobHost, MAX_BLOB, MAX_PLAIN},
};
use editac_core::{document::DocumentIdentity, modules::content::Content};
use editac_diff::representation::*;
use editac_session::{history_store::*, ports::PortError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum AssetKind {
    History,
    Attachment,
    Backup,
    Recovery,
}
/// Public routing fields only. Names, URLs, thumbnails and revision content are
/// never routing metadata. IDs must be opaque, host-issued and access-scoped.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AssetBinding {
    document_id: String,
    epoch: String,
    schema: String,
    profile: String,
    protocol: u32,
    encoding: u32,
    offsets: String,
    document: [u8; 16],
    document_epoch: u64,
    key_epoch: u64,
    kind: AssetKind,
    id: [u8; 16],
    version: u64,
}
impl AssetBinding {
    pub(crate) fn new(
        identity: &DocumentIdentity,
        context: KeyContext,
        kind: AssetKind,
        id: [u8; 16],
        version: u64,
    ) -> Result<Self, AssetError> {
        if context.purpose != KeyPurpose::History
            || version == 0
            || id == [0; 16]
            || context.key_epoch == 0
            || context.document_epoch == 0
            || [
                &identity.document_id,
                &identity.epoch,
                &identity.schema,
                &identity.profile,
                &identity.offsets,
            ]
            .iter()
            .any(|v| v.is_empty() || v.len() > 256)
        {
            return Err(AssetError::Binding);
        }
        Ok(Self {
            document_id: identity.document_id.clone(),
            epoch: identity.epoch.clone(),
            schema: identity.schema.clone(),
            profile: identity.profile.clone(),
            protocol: identity.protocol_version,
            encoding: identity.update_encoding,
            offsets: identity.offsets.clone(),
            document: context.document,
            document_epoch: context.document_epoch,
            key_epoch: context.key_epoch,
            kind,
            id,
            version,
        })
    }
    fn context(&self) -> KeyContext {
        KeyContext {
            document: self.document,
            document_epoch: self.document_epoch,
            key_epoch: self.key_epoch,
            purpose: KeyPurpose::History,
        }
    }
    fn scope_matches(&self, scope: &RevisionScope) -> bool {
        scope.document == self.document_id
            && scope.epoch == self.epoch
            && scope.schema == self.schema
            && scope.module_profile == self.profile
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AssetError {
    Binding,
    Bounds,
    Integrity,
    Missing,
    Policy,
    Host,
    Key(KeyFailure),
    Store(PortError),
}
impl From<PortError> for AssetError {
    fn from(e: PortError) -> Self {
        Self::Store(e)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    name: String,
    key_profile: Option<String>,
    observed: Vec<u8>,
    // No conversion between exact source, normalized projection and semantics.
    representation: u8,
    serializer: String,
    dialect: String,
    hash: [u8; 32],
    bytes: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Attachment {
    url: String,
    alt: String,
    title: String,
    source: String,
    bytes: Vec<u8>,
    thumbnail: Vec<u8>,
    preview: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum Payload {
    History(History),
    Attachment(Attachment),
    // Already protected local-store ciphertext, including exact acknowledged
    // journal/outbox and writer reservations; never an MLS sender-state backup.
    Backup {
        revision: u64,
        ciphertext: Vec<u8>,
    },
    Recovery {
        initialized: bool,
        writer: u32,
        checkpoint: Vec<u8>,
        locally_committed: bool,
        unjournaled: Option<Pending>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    writer: u32,
    sequence: u64,
    checksum: [u8; 32],
    origin: String,
    bytes: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format: u32,
    binding: AssetBinding,
    payload: Payload,
}

/// Prepared adapter uses the same reviewed dependency boundary as LocalStore.
/// Exact age version/qualification KDF and all review limits remain unchanged.
/// Runtime/platform cache and OS wrapping qualification is separate.
pub(crate) struct ProtectedAssets<H, K> {
    binding: AssetBinding,
    host: H,
    keys: K,
    gateway: KeySession,
}
impl<H: BlobHost, K: HostKeyProvider> ProtectedAssets<H, K> {
    /// Routing check before any export authorization, key acquisition or decode.
    /// An explicitly authorized old-key asset may belong to the same document.
    pub(crate) fn belongs_to(
        &self,
        identity: &DocumentIdentity,
        context: &crate::envelope::Context,
    ) -> bool {
        let b = &self.binding;
        b.document_id == identity.document_id
            && b.epoch == identity.epoch
            && b.schema == identity.schema
            && b.profile == identity.profile
            && b.protocol == identity.protocol_version
            && b.encoding == identity.update_encoding
            && b.offsets == identity.offsets
            && b.document == context.document
            && b.document_epoch == context.document_epoch
    }
    pub(crate) fn new(binding: AssetBinding, host: H, keys: K) -> Result<Self, AssetError> {
        let caps = host.capabilities();
        if !caps.atomic_transactions
            || !caps.serialized_writers
            || caps.durability != editac_session::ports::Durability::ProcessCrash
        {
            return Err(AssetError::Host);
        }
        let gateway = KeySession::new(binding.context());
        Ok(Self {
            binding,
            host,
            keys,
            gateway,
        })
    }
    fn put(&mut self, payload: Payload) -> Result<(), AssetError> {
        let record = Record {
            format: 1,
            binding: self.binding.clone(),
            payload,
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&record).map_err(|_| AssetError::Integrity)?);
        if bytes.len() > MAX_PLAIN {
            return Err(AssetError::Bounds);
        }
        let ciphertext = self
            .gateway
            .with_key(&mut self.keys, |key| Ok(store::seal(key, &bytes)))
            .map_err(AssetError::Key)??;
        if ciphertext.len() > MAX_BLOB {
            return Err(AssetError::Bounds);
        }
        // Never overwrite an immutable version, even when an acknowledgement
        // was lost. Caller may reopen/read exact content to reconcile that case.
        self.host.compare_exchange(
            None,
            Blob {
                revision: 1,
                ciphertext,
            },
        )?;
        Ok(())
    }
    fn get(&mut self) -> Result<Record, AssetError> {
        let blob = self.host.read(MAX_BLOB)?.ok_or(AssetError::Missing)?;
        if blob.revision != 1 || blob.ciphertext.len() > MAX_BLOB {
            return Err(AssetError::Bounds);
        }
        let bytes = self
            .gateway
            .with_key(&mut self.keys, |key| Ok(store::open(key, &blob.ciphertext)))
            .map_err(AssetError::Key)??;
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| AssetError::Integrity)?;
        if record.format != 1 || record.binding != self.binding {
            return Err(AssetError::Binding);
        }
        let kind = match record.payload {
            Payload::History(_) => AssetKind::History,
            Payload::Attachment(_) => AssetKind::Attachment,
            Payload::Backup { .. } => AssetKind::Backup,
            Payload::Recovery { .. } => AssetKind::Recovery,
        };
        if kind != self.binding.kind {
            return Err(AssetError::Binding);
        }
        Ok(record)
    }
    pub(crate) fn capture_history(
        &mut self,
        history: &HistoryStore,
        request: &HistoryRequest,
        available_key_profile: Option<&str>,
    ) -> Result<(), AssetError> {
        if self.binding.kind != AssetKind::History || !self.binding.scope_matches(&request.scope) {
            return Err(AssetError::Binding);
        }
        let entry = match history
            .read(request, available_key_profile)
            .map_err(|_| AssetError::Integrity)?
        {
            HistoryAvailability::Available(entry) => entry,
            HistoryAvailability::Unavailable(_) => {
                return Err(AssetError::Key(KeyFailure::Unavailable));
            }
        };
        let revision = entry.revision();
        let (representation, serializer, dialect) = match revision.representation() {
            Representation::ExactSourceUtf8 => (0, String::new(), String::new()),
            Representation::ProjectedMarkdown {
                serializer,
                dialect,
            } => (1, serializer.clone(), dialect.clone()),
            Representation::SemanticV1 => (2, String::new(), String::new()),
        };
        self.put(Payload::History(History {
            name: entry.name().into(),
            key_profile: entry.required_key_profile().map(str::to_owned),
            observed: revision.scope().observed_token.to_vec(),
            representation,
            serializer,
            dialect,
            hash: revision.hash().0,
            bytes: revision.bytes().to_vec(),
        }))
    }
    /// Rehydrate through the actual immutable history adapter. No live document
    /// argument exists, hence an absent old key cannot approximate current text.
    pub(crate) fn restore_history(
        &mut self,
        target: &mut HistoryStore,
    ) -> Result<HistoryAvailability<HistoryRequest>, AssetError> {
        if self.binding.kind != AssetKind::History {
            return Err(AssetError::Binding);
        }
        let record = match self.get() {
            Err(AssetError::Key(
                KeyFailure::Unavailable
                | KeyFailure::Locked
                | KeyFailure::Revoked
                | KeyFailure::RecoveryRequired,
            )) => {
                return Ok(HistoryAvailability::Unavailable(
                    UnavailableReason::KeyUnavailable,
                ));
            }
            Err(AssetError::Missing) => {
                return Ok(HistoryAvailability::Unavailable(UnavailableReason::Missing));
            }
            other => other?,
        };
        let Payload::History(h) = record.payload else {
            return Err(AssetError::Binding);
        };
        let observed_token = h
            .observed
            .as_slice()
            .try_into()
            .map_err(|_| AssetError::Integrity)?;
        let scope = RevisionScope {
            document: self.binding.document_id.clone(),
            epoch: self.binding.epoch.clone(),
            schema: self.binding.schema.clone(),
            module_profile: self.binding.profile.clone(),
            observed_token,
        };
        let semantic;
        let input = match h.representation {
            0 => RevisionInput::ExactSource(&h.bytes),
            1 => RevisionInput::ProjectedMarkdown {
                bytes: &h.bytes,
                serializer: &h.serializer,
                dialect: &h.dialect,
            },
            2 => {
                let prefix = format!("{SEMANTIC_ENCODING}\n");
                let encoded = h
                    .bytes
                    .strip_prefix(prefix.as_bytes())
                    .ok_or(AssetError::Integrity)?;
                semantic = serde_json::from_slice::<SemanticSnapshot>(encoded)
                    .map_err(|_| AssetError::Integrity)?;
                RevisionInput::Semantic(&semantic)
            }
            _ => return Err(AssetError::Integrity),
        };
        let revision = ImmutableRevision::capture(scope, input, RepresentationLimits::default())
            .map_err(|_| AssetError::Integrity)?;
        if revision.hash().0 != h.hash || revision.bytes() != h.bytes {
            return Err(AssetError::Integrity);
        }
        let request = target
            .capture(&h.name, revision, h.key_profile.as_deref())
            .map_err(|_| AssetError::Bounds)?;
        Ok(HistoryAvailability::Available(request))
    }
    /// Host callback has already obtained authorized asset bytes; no authored URL
    /// is dereferenced here. Metadata uses the actual source-preserving module.
    pub(crate) fn cache_attachment(
        &mut self,
        descriptor: &Content,
        bytes: &[u8],
        thumbnail: &[u8],
        preview: &[u8],
    ) -> Result<(), AssetError> {
        if self.binding.kind != AssetKind::Attachment {
            return Err(AssetError::Binding);
        }
        descriptor.validate().map_err(|_| AssetError::Binding)?;
        let Content::Image {
            url,
            alt,
            title,
            source,
        } = descriptor
        else {
            return Err(AssetError::Binding);
        };
        if bytes
            .len()
            .saturating_add(thumbnail.len())
            .saturating_add(preview.len())
            > MAX_PLAIN / 4
        {
            return Err(AssetError::Bounds);
        }
        self.put(Payload::Attachment(Attachment {
            url: url.clone(),
            alt: alt.clone(),
            title: title.clone(),
            source: source.clone(),
            bytes: bytes.to_vec(),
            thumbnail: thumbnail.to_vec(),
            preview: preview.to_vec(),
        }))
    }
    pub(crate) fn read_attachment(&mut self) -> Result<AttachmentView, AssetError> {
        if self.binding.kind != AssetKind::Attachment {
            return Err(AssetError::Binding);
        }
        let Payload::Attachment(a) = self.get()?.payload else {
            return Err(AssetError::Binding);
        };
        let descriptor = Content::Image {
            url: a.url,
            alt: a.alt,
            title: a.title,
            source: a.source,
        };
        descriptor.validate().map_err(|_| AssetError::Integrity)?;
        Ok(AttachmentView {
            descriptor,
            bytes: Zeroizing::new(a.bytes),
            thumbnail: Zeroizing::new(a.thumbnail),
            preview: Zeroizing::new(a.preview),
        })
    }
    /// Default backup never decrypts the source. Context validation of the inner
    /// local store still runs on restore/reopen; a backup is no freshness proof.
    pub(crate) fn backup(&mut self, source: &impl BlobHost) -> Result<(), AssetError> {
        if self.binding.kind != AssetKind::Backup {
            return Err(AssetError::Binding);
        }
        let blob = source.read(MAX_BLOB)?.ok_or(AssetError::Missing)?;
        if blob.ciphertext.len() > MAX_PLAIN / 4 || blob.revision == 0 {
            return Err(AssetError::Bounds);
        }
        self.put(Payload::Backup {
            revision: blob.revision,
            ciphertext: blob.ciphertext,
        })
    }
    /// Returns only protected bytes to a trusted, create-only restoration host.
    /// This never restores MLS sender secrets or bypasses current edit permission.
    pub(crate) fn protected_backup(&mut self) -> Result<Blob, AssetError> {
        if self.binding.kind != AssetKind::Backup {
            return Err(AssetError::Binding);
        }
        let Payload::Backup {
            revision,
            ciphertext,
        } = self.get()?.payload
        else {
            return Err(AssetError::Binding);
        };
        if revision == 0 || ciphertext.len() > MAX_BLOB {
            return Err(AssetError::Bounds);
        }
        Ok(Blob {
            revision,
            ciphertext,
        })
    }
    /// Protect the actual Session salvage representation, including an admitted
    /// but unjournaled edit. This is not a durable acknowledgement or automatic
    /// reinsert path. Deserialization/export cannot mutate the current Session.
    pub(crate) fn retain_recovery(
        &mut self,
        recovery: &editac_session::session::RecoveryExport,
    ) -> Result<(), AssetError> {
        let c = &recovery.checkpoint;
        let expected = AssetBinding::new(
            &c.identity,
            self.binding.context(),
            AssetKind::Recovery,
            self.binding.id,
            self.binding.version,
        )?;
        if self.binding != expected {
            return Err(AssetError::Binding);
        }
        let unjournaled = recovery.unjournaled.as_ref().map(|p| Pending {
            writer: p.id().writer,
            sequence: p.id().sequence,
            checksum: p.id().checksum,
            origin: p.origin().into(),
            bytes: p.bytes().to_vec(),
        });
        if recovery
            .unjournaled
            .as_ref()
            .is_some_and(|p| p.id().identity != c.identity)
        {
            return Err(AssetError::Binding);
        }
        self.put(Payload::Recovery {
            initialized: c.initialized,
            writer: c.writer_id,
            checkpoint: c.bytes.clone(),
            locally_committed: recovery.locally_committed,
            unjournaled,
        })
    }
    /// The only plaintext disclosure operation. Both policy and fresh host action
    /// are mandatory. No transferable grant or environment flag is accepted.
    pub(crate) fn export(
        &mut self,
        policy: ExportPolicy,
        destination: &str,
        host: &mut impl ExportHost,
    ) -> Result<ExportReceipt, AssetError> {
        if policy != ExportPolicy::ExplicitPlaintext
            || destination.is_empty()
            || destination.len() > 256
            || destination.chars().any(char::is_control)
        {
            return Err(AssetError::Policy);
        }
        let binding = self.binding.clone();
        let intent = ExportIntent {
            binding: &binding,
            destination,
            label: "PLAINTEXT RECOVERY EXPORT",
        };
        // Denied actions do not acquire keys or materialize plaintext.
        if !host.authorize(&intent) {
            return Err(AssetError::Policy);
        }
        let record = self.get()?;
        let disclosure = serde_json::json!({"disclosure": intent.label, "destination": intent.destination, "record": record});
        let bytes =
            Zeroizing::new(serde_json::to_vec(&disclosure).map_err(|_| AssetError::Integrity)?);
        let hash = Sha256::digest(&bytes).into();
        // Callback is a trusted plaintext endpoint. Its copies, disk writes,
        // destinations and cleanup are its explicitly authorized responsibility.
        host.write_plaintext(&intent, &bytes)?;
        Ok(ExportReceipt {
            label: intent.label,
            bytes: bytes.len(),
            hash,
        })
    }
}
pub(crate) struct AttachmentView {
    pub descriptor: Content,
    pub bytes: Zeroizing<Vec<u8>>,
    pub thumbnail: Zeroizing<Vec<u8>>,
    pub preview: Zeroizing<Vec<u8>>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportPolicy {
    Deny,
    ExplicitPlaintext,
}
pub(crate) struct ExportIntent<'a> {
    pub binding: &'a AssetBinding,
    pub destination: &'a str,
    pub label: &'static str,
}
pub(crate) trait ExportHost {
    fn authorize(&mut self, intent: &ExportIntent<'_>) -> bool;
    fn write_plaintext(
        &mut self,
        intent: &ExportIntent<'_>,
        bytes: &[u8],
    ) -> Result<(), AssetError>;
}
#[derive(Debug)]
pub(crate) struct ExportReceipt {
    pub label: &'static str,
    pub bytes: usize,
    pub hash: [u8; 32],
}
