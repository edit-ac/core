//! Document admission and one-time initialization for explicit registry profiles.
//!
//! Metadata and initialization authority live outside the CRDT. The host must grant
//! creation only for a new lineage and persist the resulting checkpoint atomically;
//! an empty state vector is never evidence that an existing document is new.
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use yrs::encoding::read::{Cursor, Read};
use yrs::updates::{
    decoder::{Decode, Decoder, DecoderV1},
    encoder::Encode,
};
use yrs::{Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Transaction, Update, XmlTextPrelim};

pub const SCHEMA: &str = "editac.registry.v1";
pub const PROFILE: &str = "editac.yrs-yjs.v1";
pub const BLOCK_SCHEMA: &str = "editac.registry.blocks.v2";
pub const BLOCK_PROFILE: &str = "editac.yrs-yjs.blocks.v2";
pub const STRUCTURE_SCHEMA: &str = "editac.registry.structure.v3";
pub const STRUCTURE_PROFILE: &str = "editac.yrs-yjs.structure.v3";
pub const EDITOR_SCHEMA: &str = "editac.registry.editor.v4";
pub const EDITOR_PROFILE: &str = "editac.yrs-yjs.editor.v4";
pub const STABLE_EDITOR_SCHEMA: &str = "editac.registry.editor.v5";
pub const STABLE_EDITOR_PROFILE: &str = "editac.yrs-yjs.editor.v5";
pub const BLOCK_ATTRIBUTES: &str = "registry-block-attributes";

/// Atomic owner presentation. Unknown JSON array tuples remain recoverable.
#[derive(Clone, Debug, PartialEq)]
pub enum BlockAttributes {
    Paragraph,
    Heading(u8),
    Code(String),
    Separator,
    Unknown(Any),
}
impl BlockAttributes {
    /// Unknown extension tuples render as a paragraph without executing extensions.
    pub fn presentation(&self) -> Self {
        match self {
            Self::Unknown(_) => Self::Paragraph,
            known => known.clone(),
        }
    }
    pub fn tuple(&self) -> Any {
        match self {
            Self::Paragraph => Any::Array(vec![Any::from("paragraph")].into()),
            Self::Heading(level) => {
                Any::Array(vec![Any::from("heading"), Any::from(*level as u32)].into())
            }
            Self::Code(language) => {
                Any::Array(vec![Any::from("code"), Any::from(language.clone())].into())
            }
            Self::Separator => Any::Array(vec![Any::from("separator")].into()),
            Self::Unknown(value) => value.clone(),
        }
    }
}
fn json_value(value: &Any, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Any::Null | Any::Bool(_) | Any::String(_) => true,
        Any::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        Any::Array(v) => v.iter().all(|x| json_value(x, depth + 1)),
        Any::Map(v) => v.values().all(|x| json_value(x, depth + 1)),
        _ => false,
    }
}
pub(crate) fn parse_block_tuple(value: &Any) -> Result<BlockAttributes, DocumentError> {
    let Any::Array(values) = value else {
        return Err(DocumentError::UnsupportedSchema);
    };
    match values.as_ref() {
        [Any::String(tag)] if tag.as_ref() == "paragraph" => Ok(BlockAttributes::Paragraph),
        [Any::String(tag), Any::Number(n)]
            if tag.as_ref() == "heading" && n.as_i64().is_some_and(|n| (1..=6).contains(&n)) =>
        {
            Ok(BlockAttributes::Heading(n.as_i64().unwrap() as u8))
        }
        [Any::String(tag), ..]
            if tag.as_ref() != "paragraph" && tag.as_ref() != "heading" && json_value(value, 0) =>
        {
            Ok(BlockAttributes::Unknown(value.clone()))
        }
        _ => Err(DocumentError::UnsupportedSchema),
    }
}
pub(crate) fn parse_editor_tuple(value: &Any) -> Result<BlockAttributes, DocumentError> {
    let Any::Array(values) = value else {
        return Err(DocumentError::UnsupportedSchema);
    };
    match values.as_ref() {
        [Any::String(tag)] if tag.as_ref() == "separator" => Ok(BlockAttributes::Separator),
        [Any::String(tag), Any::String(language)]
            if tag.as_ref() == "code"
                && language.len() <= 64
                && language
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+._-".contains(&b)) =>
        {
            Ok(BlockAttributes::Code(language.to_string()))
        }
        [Any::String(tag), ..] if matches!(tag.as_ref(), "code" | "separator") => {
            Err(DocumentError::UnsupportedSchema)
        }
        _ => parse_block_tuple(value),
    }
}
pub const ROOTS: [&str; 5] = [
    "registry-parents",
    "registry-texts",
    "registry-placements",
    "delete-probe-tombstones",
    "probe-split-join",
];
/// Bound the encoded input before decoding. Broader resource qualification is a
/// separate gate; this initialization API is not an untrusted transport port.
pub const MAX_RESTORE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentIdentity {
    pub profile: String,
    pub schema: String,
    pub protocol_version: u32,
    pub update_encoding: u32,
    pub offsets: String,
    pub document_id: String,
    pub epoch: String,
}
impl DocumentIdentity {
    /// IDs are independently assigned canonical lowercase UUIDs by the host.
    pub fn v1(
        document_id: impl Into<String>,
        epoch: impl Into<String>,
    ) -> Result<Self, DocumentError> {
        let identity = Self {
            profile: PROFILE.into(),
            schema: SCHEMA.into(),
            protocol_version: 1,
            update_encoding: 1,
            offsets: "utf16".into(),
            document_id: document_id.into(),
            epoch: epoch.into(),
        };
        identity.validate()?;
        Ok(identity)
    }
    pub fn v2(
        document_id: impl Into<String>,
        epoch: impl Into<String>,
    ) -> Result<Self, DocumentError> {
        let mut identity = Self::v1(document_id, epoch)?;
        identity.profile = BLOCK_PROFILE.into();
        identity.schema = BLOCK_SCHEMA.into();
        Ok(identity)
    }
    pub fn v3(
        document_id: impl Into<String>,
        epoch: impl Into<String>,
    ) -> Result<Self, DocumentError> {
        let mut identity = Self::v1(document_id, epoch)?;
        identity.profile = STRUCTURE_PROFILE.into();
        identity.schema = STRUCTURE_SCHEMA.into();
        Ok(identity)
    }
    pub fn v4(
        document_id: impl Into<String>,
        epoch: impl Into<String>,
    ) -> Result<Self, DocumentError> {
        let mut identity = Self::v1(document_id, epoch)?;
        identity.profile = EDITOR_PROFILE.into();
        identity.schema = EDITOR_SCHEMA.into();
        Ok(identity)
    }
    /// Select the qualified witnessed profile explicitly; never migrate restored data.
    pub fn v5(
        document_id: impl Into<String>,
        epoch: impl Into<String>,
    ) -> Result<Self, DocumentError> {
        let mut identity = Self::v1(document_id, epoch)?;
        identity.profile = STABLE_EDITOR_PROFILE.into();
        identity.schema = STABLE_EDITOR_SCHEMA.into();
        Ok(identity)
    }
    pub fn has_stable_presentation(&self) -> bool {
        self.profile == STABLE_EDITOR_PROFILE && self.schema == STABLE_EDITOR_SCHEMA
    }
    pub fn has_editor(&self) -> bool {
        (self.profile == EDITOR_PROFILE && self.schema == EDITOR_SCHEMA)
            || self.has_stable_presentation()
    }
    pub fn has_structure(&self) -> bool {
        (self.profile == STRUCTURE_PROFILE && self.schema == STRUCTURE_SCHEMA) || self.has_editor()
    }
    pub fn has_blocks(&self) -> bool {
        (self.profile == BLOCK_PROFILE && self.schema == BLOCK_SCHEMA) || self.has_structure()
    }
    fn validate(&self) -> Result<(), DocumentError> {
        if !canonical_uuid(&self.document_id) || !canonical_uuid(&self.epoch) {
            return Err(DocumentError::InvalidMetadata);
        }
        if !((self.profile == PROFILE && self.schema == SCHEMA) || self.has_blocks())
            || self.protocol_version != 1
            || self.update_encoding != 1
            || self.offsets != "utf16"
        {
            return Err(DocumentError::UnsupportedProfile);
        }
        Ok(())
    }
    fn admit(&self, incoming: &Self) -> Result<(), DocumentError> {
        self.validate()?;
        incoming.validate()?;
        if self.profile != incoming.profile || self.schema != incoming.schema {
            return Err(DocumentError::UnsupportedProfile);
        }
        if self.document_id != incoming.document_id {
            return Err(DocumentError::WrongDocument);
        }
        if self.epoch != incoming.epoch {
            return Err(DocumentError::WrongEpoch);
        }
        Ok(())
    }
}
fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentError {
    InvalidMetadata,
    UnsupportedProfile,
    WrongDocument,
    WrongEpoch,
    MissingInitialization,
    AlreadyInitialized,
    InvalidInitialContent,
    InvalidUpdate,
    IncompleteRestore,
    UnsupportedSchema,
    ResourceLimit,
    WriterUnavailable,
}
impl std::fmt::Display for DocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DocumentError {}

/// Non-cloneable authority for the one initializer. The host must also enforce
/// this across processes/durable storage. This process rejects repeat grants.
#[derive(Debug)]
pub struct CreationPermit {
    identity: DocumentIdentity,
    committed: bool,
}
// false reserves an in-flight creator; true means authoritative existing state.
static CREATED: OnceLock<Mutex<HashMap<(String, String), bool>>> = OnceLock::new();
impl CreationPermit {
    pub fn authorize_new(identity: DocumentIdentity) -> Result<Self, DocumentError> {
        identity.validate()?;
        let mut created = CREATED
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| DocumentError::WriterUnavailable)?;
        let key = (identity.document_id.clone(), identity.epoch.clone());
        if created.contains_key(&key) {
            return Err(DocumentError::AlreadyInitialized);
        }
        created.insert(key, false);
        Ok(Self {
            identity,
            committed: false,
        })
    }
}
impl Drop for CreationPermit {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut created) = CREATED.get_or_init(Default::default).lock() {
                let key = (
                    self.identity.document_id.clone(),
                    self.identity.epoch.clone(),
                );
                if created.get(&key) == Some(&false) {
                    created.remove(&key);
                }
            }
        }
    }
}

/// Ordinary initial nodes use the schema's writer-local ID allocation. Pair
/// fixtures are restored from the qualified initializer, never independently seeded.
#[derive(Clone, Debug)]
pub struct InitialNode {
    pub kind: String,
    pub text: String,
}
#[derive(Clone, Debug)]
pub struct ReplayUpdate {
    pub identity: DocumentIdentity,
    pub bytes: Vec<u8>,
}
/// Store this envelope even when `bytes` encodes an empty document. Initialization
/// cannot be inferred from bytes. Writer identity is provenance, never restored.
#[derive(Clone, Debug)]
pub struct InitializedCheckpoint {
    pub identity: DocumentIdentity,
    pub initialized: bool,
    pub writer_id: u32,
    pub bytes: Vec<u8>,
}

static LIVE_WRITERS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
#[derive(Debug)]
struct WriterLease(u32);
impl WriterLease {
    fn acquire(id: u32) -> Result<Option<Self>, DocumentError> {
        let mut live = LIVE_WRITERS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| DocumentError::WriterUnavailable)?;
        // Construct a lease only after insertion succeeds. Eager then_some
        // would drop a rejected lease while this mutex is held and deadlock
        // when Drop tries to release that same writer.
        Ok(live.insert(id).then(|| Self(id)))
    }
}
impl Drop for WriterLease {
    fn drop(&mut self) {
        if let Ok(mut live) = LIVE_WRITERS.get_or_init(Default::default).lock() {
            live.remove(&self.0);
        }
    }
}

#[derive(Debug)]
pub(crate) struct CheckpointStamp {
    owner: Arc<AtomicU64>,
    value: u64,
}

/// At most one fully admitted disposable replica. It is never authoritative and
/// can only be reused while its owning live replica has not been transacted on.
#[derive(Debug)]
pub(crate) struct EditorStage {
    pub(crate) doc: Doc,
    pub(crate) projection: crate::projection::ProjectionIndex,
    pub(crate) stamp: CheckpointStamp,
    pub(crate) bytes: Vec<u8>,
    pub(crate) token: Arc<()>,
    pub(crate) committed: bool,
}

/// One authoritative Yrs replica. No public mutable Yrs handle or clone is exposed.
#[derive(Debug)]
pub struct Document {
    pub(crate) doc: Doc,
    projection: crate::projection::ProjectionIndex,
    checkpoint_stamp: Arc<AtomicU64>,
    pub(crate) editor_stage: std::cell::RefCell<Option<EditorStage>>,
    identity: DocumentIdentity,
    _writer: WriterLease,
    next_node_counter: u64,
    pub(crate) next_structure_counter: u32,
    pub(crate) revision: u64,
    pub(crate) history: Option<crate::history::History>,
    pub(crate) patches: crate::patches::PatchState,
}
impl Document {
    pub fn create(
        mut permit: CreationPermit,
        nodes: &[InitialNode],
    ) -> Result<Self, DocumentError> {
        if permit.identity.has_structure() {
            if nodes.iter().any(|n| n.kind != "block") {
                return Err(DocumentError::InvalidInitialContent);
            }
            if nodes.len() > 4096
                || nodes.iter().any(|n| n.text.encode_utf16().count() > 262144)
                || nodes.iter().map(|n| n.text.len()).sum::<usize>() > 1048576
            {
                return Err(DocumentError::ResourceLimit);
            }
        }
        let size = nodes
            .iter()
            .try_fold(0usize, |n, node| {
                n.checked_add(node.text.len())
                    .and_then(|n| n.checked_add(node.kind.len()))
            })
            .ok_or(DocumentError::ResourceLimit)?;
        if size > MAX_RESTORE_BYTES || nodes.len() > 100_000 {
            return Err(DocumentError::ResourceLimit);
        }
        if nodes.iter().any(|n| n.kind.is_empty()) {
            return Err(DocumentError::InvalidInitialContent);
        }
        let key = (
            permit.identity.document_id.clone(),
            permit.identity.epoch.clone(),
        );
        let mut created = CREATED
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| DocumentError::WriterUnavailable)?;
        if created.get(&key) != Some(&false) {
            return Err(DocumentError::AlreadyInitialized);
        }
        let (doc, writer) = fresh_replica(&HashSet::new(), &permit.identity)?;
        if permit.identity.has_blocks() {
            doc.get_or_insert_map(BLOCK_ATTRIBUTES);
        }
        {
            let kinds = doc.get_or_insert_map(ROOTS[0]);
            let texts = doc.get_or_insert_map(ROOTS[1]);
            let placements = doc.get_or_insert_map(ROOTS[2]);
            let mut txn = doc.transact_mut_with("initialize");
            for (counter, node) in nodes.iter().enumerate() {
                let id = if permit.identity.has_structure() {
                    format!("n:{}:{}", doc.client_id().get(), counter + 1)
                } else {
                    format!("n-{:x}-{:x}", doc.client_id().get(), counter)
                };
                if permit.identity.has_structure() {
                    txn.get_map(crate::ownership::ROOTS[6]).unwrap().insert(
                        &mut txn,
                        id.clone(),
                        true,
                    );
                }
                kinds.insert(&mut txn, id.clone(), node.kind.as_str());
                texts.insert(&mut txn, id.clone(), XmlTextPrelim::new(node.text.as_str()));
                placements.insert(
                    &mut txn,
                    id.clone(),
                    Any::Array(vec![Any::from("@root"), Any::from(counter as u32)].into()),
                );
                if permit.identity.has_blocks() && node.kind == "block" {
                    txn.get_map(BLOCK_ATTRIBUTES).unwrap().insert(
                        &mut txn,
                        id,
                        BlockAttributes::Paragraph.tuple(),
                    );
                }
            }
        }
        if permit.identity.has_structure() {
            crate::editor::project(&doc, permit.identity.has_stable_presentation())
                .map_err(ownership_error)?;
        }
        // Ensure a document accepted by creation can also pass its restore bound.
        if doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len()
            > MAX_RESTORE_BYTES
        {
            return Err(DocumentError::ResourceLimit);
        }
        created.insert(key, true);
        permit.committed = true;
        Ok(Self {
            projection: crate::projection::ProjectionIndex::with_identity(&doc, &permit.identity),
            checkpoint_stamp: observe_checkpoint_stamp(&doc),
            editor_stage: Default::default(),
            doc,
            identity: permit.identity.clone(),
            _writer: writer,
            next_node_counter: nodes.len() as u64,
            next_structure_counter: 1,
            revision: 0,
            history: None,
            patches: Default::default(),
        })
    }

    /// Replay on a disposable replica; publish a live document only after all
    /// identity checks, decoding, dependency integration and root checks succeed.
    /// Failure leaves the borrowed checkpoint/journal available for recovery.
    pub fn restore(
        expected: &DocumentIdentity,
        checkpoint: &InitializedCheckpoint,
        journal: &[ReplayUpdate],
    ) -> Result<Self, DocumentError> {
        expected.admit(&checkpoint.identity)?;
        if !checkpoint.initialized {
            return Err(DocumentError::MissingInitialization);
        }
        let mut total = checkpoint.bytes.len();
        for update in journal {
            expected.admit(&update.identity)?;
            total = total
                .checked_add(update.bytes.len())
                .ok_or(DocumentError::ResourceLimit)?;
        }
        if total > MAX_RESTORE_BYTES {
            return Err(DocumentError::ResourceLimit);
        }
        let mut decoded = Vec::with_capacity(journal.len() + 1);
        for bytes in std::iter::once(&checkpoint.bytes).chain(journal.iter().map(|u| &u.bytes)) {
            decoded.push(if expected.has_structure() {
                crate::ownership::decode(bytes).map_err(ownership_error)?
            } else {
                Update::decode_v1(bytes).map_err(|_| DocumentError::InvalidUpdate)?
            });
        }
        // Staging has no editing lease and never performs local writes.
        let staging = crate::new_document();
        register_profile_roots(&staging, expected);
        if expected.has_blocks() {
            staging.get_or_insert_map(BLOCK_ATTRIBUTES);
        }
        {
            let mut txn = staging.transact_mut_with("restore");
            // A journal is one bounded causal corpus. Integrate its merged
            // structs/delete set together: incremental out-of-order application
            // can leave pending history deletions in Yrs even when every missing
            // struct is present later in this same journal. Genuine missing
            // dependencies still fail the pending-state check below.
            txn.apply_update(Update::merge_updates(decoded))
                .map_err(|_| DocumentError::InvalidUpdate)?;
        }
        let baseline = if expected.has_structure() && !journal.is_empty() {
            let baseline = crate::new_document();
            register_profile_roots(&baseline, expected);
            baseline
                .transact_mut_with("restore:baseline")
                .apply_update(crate::ownership::decode(&checkpoint.bytes).map_err(ownership_error)?)
                .map_err(|_| DocumentError::InvalidUpdate)?;
            crate::editor::project(&baseline, expected.has_stable_presentation())
                .map_err(ownership_error)?;
            // A journal must not repair an invalid checkpoint or replace an
            // immutable source. With no journal, staging IS the checkpoint;
            // its complete projection admission below qualifies that corpus.
            validate_immutable_maps(&baseline, &staging)?;
            Some(baseline)
        } else {
            None
        };
        let txn = staging.transact();
        if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
            return Err(DocumentError::IncompleteRestore);
        }
        // Structured profiles receive complete projection admission below.
        if !expected.has_structure() {
            validate_roots(&txn, expected.has_blocks())?;
        }
        // The v2 profile qualifies the inherited ownership descriptor as well as
        // its tuples. Never publish/admit a split with corrupt binary anchors.
        let qualified_projection = if expected.has_blocks() {
            let projection = crate::projection::ProjectionIndex::with_identity(&staging, expected);
            let snapshot = projection.read_restore(expected.has_structure())?;
            Some((projection, snapshot))
        } else {
            None
        };
        if let Some(baseline) = baseline {
            validate_immutable_projected_structure(&baseline, &staging)?;
        }
        let mut excluded: HashSet<u32> = txn
            .state_vector()
            .iter()
            .map(|(id, _)| id.get() as u32)
            .collect();
        excluded.insert(checkpoint.writer_id);
        // Checkpoint-only staging has never written locally. Its random writer
        // can become the editor lease after admission if it is absent from both
        // the restored corpus and the live-writer registry. Avoid serializing,
        // decoding and integrating that same admitted state a second time.
        let admitted_writer = if journal.is_empty() {
            lease_admitted_restore(&staging, &excluded)?
        } else {
            None
        };
        let bytes = admitted_writer
            .is_none()
            .then(|| txn.encode_state_as_update_v1(&StateVector::default()));
        drop(txn);
        let (doc, writer, projection) = if let Some(writer) = admitted_writer {
            let projection = match qualified_projection {
                Some((projection, snapshot)) => projection.into_admitted_restore(snapshot),
                None => crate::projection::ProjectionIndex::with_identity(&staging, expected),
            };
            (staging, writer, projection)
        } else {
            let (doc, writer) = fresh_replica(&excluded, expected)?;
            if expected.has_blocks() {
                doc.get_or_insert_map(BLOCK_ATTRIBUTES);
            }
            doc.transact_mut_with("restore")
                .apply_update(
                    Update::decode_v1(&bytes.unwrap()).map_err(|_| DocumentError::InvalidUpdate)?,
                )
                .map_err(|_| DocumentError::InvalidUpdate)?;
            let projection = match qualified_projection {
                Some((projection, snapshot)) => projection
                    .into_restored_replica(&doc, snapshot)
                    .map_err(|_| DocumentError::UnsupportedSchema)?,
                None => crate::projection::ProjectionIndex::with_identity(&doc, expected),
            };
            (doc, writer, projection)
        };
        CREATED
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| DocumentError::WriterUnavailable)?
            .insert((expected.document_id.clone(), expected.epoch.clone()), true);
        Ok(Self {
            projection,
            checkpoint_stamp: observe_checkpoint_stamp(&doc),
            editor_stage: Default::default(),
            doc,
            identity: expected.clone(),
            _writer: writer,
            next_node_counter: 0,
            next_structure_counter: 1,
            revision: 0,
            history: None,
            patches: Default::default(),
        })
    }
    /// Qualify incoming bytes against a disposable combined checkpoint first.
    /// The caller retains the borrowed rejected envelope/bytes for recovery.
    pub fn apply_replay(&mut self, update: &ReplayUpdate) -> Result<(), DocumentError> {
        self.identity.admit(&update.identity)?;
        let checkpoint = self.checkpoint();
        let candidate = Self::restore(&self.identity, &checkpoint, std::slice::from_ref(update))?;
        if candidate.checkpoint().bytes == checkpoint.bytes {
            return Ok(());
        }
        if self.identity.has_structure() {
            validate_immutable_structure(
                &self.doc,
                &candidate.doc,
                self.identity.has_stable_presentation(),
            )?;
        }
        drop(candidate);
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(DocumentError::ResourceLimit)?;
        let decoded = Update::decode_v1(&update.bytes).map_err(|_| DocumentError::InvalidUpdate)?;
        let patch_before = self
            .patch_before()
            .map_err(|_| DocumentError::UnsupportedSchema)?;
        self.doc
            .transact_mut_with("remote")
            .apply_update(decoded)
            .expect("validated combined update");
        self.revision = next_revision;
        self.reset_history_group();
        self.patch_finish(
            patch_before,
            crate::patches::PatchOperation::Remote,
            "remote",
            Some(update.clone()),
        );
        Ok(())
    }

    pub(crate) fn general_view(&self) -> crate::ownership::Result<crate::ownership::View> {
        crate::editor::project(&self.doc, self.identity.has_stable_presentation())
    }
    /// Exercise the complete mutation on an isolated replica, then validate replay
    /// and resource bounds. No temporary writer is admitted to the live document.
    pub(crate) fn validate_general_mutation(
        &self,
        mutate: impl FnOnce(&mut yrs::TransactionMut<'_>),
    ) -> Result<(), DocumentError> {
        let excluded: HashSet<_> = self
            .read()
            .state_vector()
            .iter()
            .map(|(id, _)| id.get() as u32)
            .chain([self.writer_id()])
            .collect();
        let stage = (0..128)
            .map(|_| crate::new_document())
            .find(|d| !excluded.contains(&(d.client_id().get() as u32)))
            .ok_or(DocumentError::WriterUnavailable)?;
        register_profile_roots(&stage, &self.identity);
        let bytes = self.checkpoint().bytes;
        stage
            .transact_mut_with("prepare:stage")
            .apply_update(crate::ownership::decode(&bytes).map_err(ownership_error)?)
            .map_err(|_| DocumentError::InvalidUpdate)?;
        {
            let mut txn = stage.transact_mut_with("prepare:stage");
            mutate(&mut txn);
        }
        if stage
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len()
            > MAX_RESTORE_BYTES
        {
            return Err(DocumentError::ResourceLimit);
        }
        crate::editor::project(&stage, self.identity.has_stable_presentation())
            .map_err(ownership_error)?;
        validate_immutable_structure(&self.doc, &stage, self.identity.has_stable_presentation())
    }
    pub fn snapshot(
        &self,
    ) -> Result<crate::projection::Snapshot, crate::projection::ProjectionError> {
        self.projection.read()
    }
    pub(crate) fn inspect(
        &self,
    ) -> Result<crate::projection::Snapshot, crate::projection::ProjectionError> {
        self.projection.inspect()
    }
    /// Called immediately after applying our exact checkpoint to a fresh editor
    /// stage. Neither replica can change through this shared Document borrow.
    pub(crate) fn editor_stage_projection(
        &self,
        stage: &Doc,
    ) -> Result<crate::projection::ProjectionIndex, crate::projection::ProjectionError> {
        self.projection.fork_encoded_replica(stage)
    }
    pub(crate) fn write(&mut self, origin: &str) -> yrs::TransactionMut<'_> {
        self.doc.transact_mut_with(origin)
    }
    /// Local observation token; not a globally comparable CRDT timestamp.
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn identity(&self) -> &DocumentIdentity {
        &self.identity
    }
    pub fn is_initialized(&self) -> bool {
        true
    }
    pub fn writer_id(&self) -> u32 {
        self._writer.0
    }
    pub fn next_node_counter(&self) -> u64 {
        self.next_node_counter
    }
    /// Read-only view for subsequent engine projection; callers cannot write roots.
    pub(crate) fn read(&self) -> Transaction<'_> {
        self.doc.transact()
    }
    /// Owned v1 clock summary for sync. It is not an exact revision token.
    pub fn state_vector_v1(&self) -> Vec<u8> {
        self.read().state_vector().encode_v1()
    }
    /// Encode missing structs and the delete set without mutating the replica.
    /// Reject malformed/trailing state-vector bytes before encoding.
    pub fn update_v1(&self, state_vector: &[u8]) -> Result<Vec<u8>, DocumentError> {
        if state_vector.len() > MAX_RESTORE_BYTES {
            return Err(DocumentError::ResourceLimit);
        }
        let mut decoder = DecoderV1::new(Cursor::new(state_vector));
        let count: u32 = decoder
            .read_var()
            .map_err(|_| DocumentError::InvalidUpdate)?;
        // Every entry requires at least a client and clock byte. Bound the
        // attacker-controlled allocation before the library reserves the map.
        if count as usize > state_vector.len() / 2 {
            return Err(DocumentError::InvalidUpdate);
        }
        let mut decoder = DecoderV1::new(Cursor::new(state_vector));
        let vector = StateVector::decode(&mut decoder).map_err(|_| DocumentError::InvalidUpdate)?;
        if !decoder
            .read_to_end()
            .map_err(|_| DocumentError::InvalidUpdate)?
            .is_empty()
        {
            return Err(DocumentError::InvalidUpdate);
        }
        Ok(self.read().encode_state_as_update_v1(&vector))
    }
    /// Private local transaction stamp, independent of public revision and CRDT
    /// clocks. A delete-only write must invalidate prepared checkpoint equality.
    pub(crate) fn checkpoint_stamp(&self) -> CheckpointStamp {
        CheckpointStamp {
            owner: self.checkpoint_stamp.clone(),
            value: self.checkpoint_stamp.load(Ordering::Relaxed),
        }
    }
    pub(crate) fn matches_checkpoint(&self, stamp: &CheckpointStamp, bytes: &[u8]) -> bool {
        // Same owned replica, no intervening mutable transaction: no need to
        // re-encode the entire corpus. After any transaction (including a no-op)
        // retain the exact original byte comparison. Saturation cannot wrap and
        // accidentally admit an old plan.
        self.matches_checkpoint_stamp(stamp) || self.checkpoint().bytes == bytes
    }
    pub(crate) fn matches_checkpoint_stamp(&self, stamp: &CheckpointStamp) -> bool {
        stamp.value != u64::MAX
            && Arc::ptr_eq(&stamp.owner, &self.checkpoint_stamp)
            && stamp.value == self.checkpoint_stamp.load(Ordering::Relaxed)
    }
    pub(crate) fn retain_editor_stage(&self, token: Option<&Arc<()>>) {
        let mut retained = self.editor_stage.borrow_mut();
        match (retained.as_mut(), token) {
            (Some(stage), Some(token)) if Arc::ptr_eq(&stage.token, token) => {
                stage.stamp = self.checkpoint_stamp();
                stage.committed = true;
            }
            _ => *retained = None,
        }
    }
    pub fn checkpoint(&self) -> InitializedCheckpoint {
        InitializedCheckpoint {
            identity: self.identity.clone(),
            initialized: true,
            writer_id: self.writer_id(),
            bytes: self
                .read()
                .encode_state_as_update_v1(&StateVector::default()),
        }
    }
}
fn observe_checkpoint_stamp(doc: &Doc) -> Arc<AtomicU64> {
    let stamp = Arc::new(AtomicU64::new(0));
    let observed = stamp.clone();
    // Unlike update observers this hook does not encode an update. It also
    // covers deletes, history, remote writes and internal/raw transactions.
    doc.observe_after_transaction("editac:checkpoint-stamp", move |_| {
        let _ = observed.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(value.saturating_add(1))
        });
    })
    .expect("owned document has no active transaction");
    stamp
}
fn register_roots(doc: &Doc) {
    for root in ROOTS {
        doc.get_or_insert_map(root);
    }
}
fn lease_admitted_restore(
    doc: &Doc,
    excluded: &HashSet<u32>,
) -> Result<Option<WriterLease>, DocumentError> {
    let id = doc.client_id().get() as u32;
    if excluded.contains(&id) {
        return Ok(None);
    }
    WriterLease::acquire(id)
}

#[cfg(test)]
mod restore_writer_tests {
    use super::*;

    #[test]
    fn admitted_restore_rejects_corpus_and_live_writer_collisions() {
        let doc = crate::new_document();
        let id = doc.client_id().get() as u32;
        assert!(
            lease_admitted_restore(&doc, &HashSet::from([id]))
                .unwrap()
                .is_none()
        );
        let lease = lease_admitted_restore(&doc, &HashSet::new())
            .unwrap()
            .unwrap();
        assert_eq!(lease.0, id);
        assert!(
            lease_admitted_restore(&doc, &HashSet::new())
                .unwrap()
                .is_none()
        );
        drop(lease);
        assert!(
            lease_admitted_restore(&doc, &HashSet::new())
                .unwrap()
                .is_some()
        );
    }
}

fn fresh_replica(
    excluded: &HashSet<u32>,
    identity: &DocumentIdentity,
) -> Result<(Doc, WriterLease), DocumentError> {
    for _ in 0..128 {
        let doc = crate::new_document();
        let id = doc.client_id().get() as u32;
        if excluded.contains(&id) {
            continue;
        }
        if let Some(lease) = WriterLease::acquire(id)? {
            register_profile_roots(&doc, identity);
            return Ok((doc, lease));
        }
    }
    Err(DocumentError::WriterUnavailable)
}
fn validate_roots(txn: &Transaction<'_>, blocks: bool) -> Result<(), DocumentError> {
    for (name, value) in txn.root_refs() {
        if !(ROOTS.contains(&name) || (blocks && name == BLOCK_ATTRIBUTES))
            || !matches!(value, Out::YMap(map) if map.as_ref().len() == 0)
        {
            return Err(DocumentError::UnsupportedSchema);
        }
    }
    let kinds = txn
        .get_map(ROOTS[0])
        .ok_or(DocumentError::UnsupportedSchema)?;
    let texts = txn
        .get_map(ROOTS[1])
        .ok_or(DocumentError::UnsupportedSchema)?;
    for (id, kind) in kinds.iter(txn) {
        if !valid_node_id(id)
            || !matches!(kind, Out::Any(Any::String(_)))
            || !matches!(texts.get(txn, id), Some(Out::YXmlText(_)))
        {
            return Err(DocumentError::UnsupportedSchema);
        }
    }
    if texts.iter(txn).any(|(id, _)| !kinds.contains_key(txn, id)) {
        return Err(DocumentError::UnsupportedSchema);
    }
    let tombstones = txn
        .get_map(ROOTS[3])
        .ok_or(DocumentError::UnsupportedSchema)?;
    if tombstones
        .iter(txn)
        // The reserved split owner has no registry text of its own, but its
        // tombstone is part of the frozen ownership/visibility contract.
        .any(|(id, v)| {
            (!valid_node_id(id) && id != "block-split") || !matches!(v, Out::Any(Any::Bool(true)))
        })
    {
        return Err(DocumentError::UnsupportedSchema);
    }
    // Placements deliberately retain malformed values for the frozen read fallback.
    let layout = txn
        .get_map(ROOTS[4])
        .ok_or(DocumentError::UnsupportedSchema)?;
    for (key, value) in layout.iter(txn) {
        let valid = if let Out::Any(Any::Array(values)) = value {
            matches!(values.as_ref(), [Any::String(mode)] if mode.as_ref() == "original" || mode.as_ref() == "join")
                || matches!(values.as_ref(), [Any::String(mode), Any::Buffer(_)] if mode.as_ref() == "split")
        } else {
            false
        };
        if key != "pair"
            || !valid
            || !kinds.contains_key(txn, "block-1")
            || !kinds.contains_key(txn, "block-2")
        {
            return Err(DocumentError::UnsupportedSchema);
        }
    }
    if blocks {
        let attributes = txn
            .get_map(BLOCK_ATTRIBUTES)
            .ok_or(DocumentError::UnsupportedSchema)?;
        for (id, value) in attributes.iter(txn) {
            let ordinary = matches!(kinds.get(txn, id), Some(Out::Any(Any::String(kind))) if kind.as_ref() == "block");
            let derived = id == "block-split" && ["block-1", "block-2"].iter().all(|id| matches!(kinds.get(txn, id), Some(Out::Any(Any::String(kind))) if kind.as_ref() == "block"));
            if !ordinary && !derived {
                return Err(DocumentError::UnsupportedSchema);
            }
            let Out::Any(value) = value else {
                return Err(DocumentError::UnsupportedSchema);
            };
            parse_block_tuple(&value)?;
        }
        if layout.contains_key(txn, "pair") && !["block-1", "block-2"].iter().all(|id| matches!(kinds.get(txn, id), Some(Out::Any(Any::String(kind))) if kind.as_ref() == "block")) {
            return Err(DocumentError::UnsupportedSchema);
        }
    }
    Ok(())
}
pub(crate) fn valid_node_id(id: &str) -> bool {
    id != "block-split"
        && (1..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn register_profile_roots(doc: &Doc, identity: &DocumentIdentity) {
    if identity.has_editor() {
        for root in crate::editor_mapping::ROOTS {
            doc.get_or_insert_map(root);
        }
    } else if identity.has_structure() {
        for root in crate::ownership::ROOTS {
            doc.get_or_insert_map(root);
        }
    } else {
        register_roots(doc);
    }
    if identity.has_blocks() {
        doc.get_or_insert_map(BLOCK_ATTRIBUTES);
    }
}
pub(crate) fn ownership_error(error: &str) -> DocumentError {
    match error {
        "resource-limit" => DocumentError::ResourceLimit,
        "missing-binary-dependency" => DocumentError::IncompleteRestore,
        "invalid-bytes" => DocumentError::InvalidUpdate,
        _ => DocumentError::UnsupportedSchema,
    }
}
pub(crate) fn validate_immutable_structure(
    before: &Doc,
    after: &Doc,
    stable: bool,
) -> Result<(), DocumentError> {
    validate_immutable_maps(before, after)?;
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.beforeOwnership");
    let old = crate::editor::project(before, stable).map_err(ownership_error)?;
    #[cfg(feature = "fitness-trace")]
    drop(_phase);
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.afterOwnership");
    let new = crate::editor::project(after, stable).map_err(ownership_error)?;
    #[cfg(feature = "fitness-trace")]
    drop(_phase);
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.sourceIdentity");
    for (key, value) in old.sources {
        let Any::Map(v) = value else { unreachable!() };
        let Some(Any::Map(w)) = new.sources.get(&key) else {
            return Err(DocumentError::UnsupportedSchema);
        };
        if v["identity"] != w["identity"] {
            return Err(DocumentError::UnsupportedSchema);
        }
    }
    Ok(())
}

// Shared by the full replay validator and the already-qualified editor stage.
fn validate_immutable_maps(before: &Doc, after: &Doc) -> Result<(), DocumentError> {
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.immutableMaps");
    let a = before.transact();
    let b = after.transact();
    for root in if a.get_map(crate::editor_mapping::ROOTS[9]).is_some() {
        vec![0, 2, 3, 5, 6]
    } else {
        vec![0, 3, 5, 6]
    } {
        let old = a.get_map(crate::ownership::ROOTS[root]).unwrap();
        let new = b.get_map(crate::ownership::ROOTS[root]).unwrap();
        for (key, value) in old.iter(&a) {
            if new.get(&b, key) != Some(value) {
                return Err(DocumentError::UnsupportedSchema);
            }
        }
    }
    Ok(())
}

/// Call only after fully qualifying both replicas, with no intervening writes.
/// Restore qualifies its baseline/staging pair; ProjectionIndex re-reads its
/// stage against the owning Document's admitted `before`. Identity comparison needs
/// neither source text serialization nor a second complete ownership replay.
pub(super) fn validate_immutable_projected_structure(
    before: &Doc,
    after: &Doc,
) -> Result<(), DocumentError> {
    validate_immutable_maps(before, after)?;
    fn sources(
        doc: &Doc,
    ) -> Result<std::collections::BTreeMap<String, yrs::branch::BranchID>, DocumentError> {
        let t = doc.transact();
        let texts = t
            .get_map(crate::ownership::ROOTS[1])
            .ok_or(DocumentError::UnsupportedSchema)?;
        texts
            .iter(&t)
            .map(|(key, value)| {
                let Out::YXmlText(text) = value else {
                    return Err(DocumentError::UnsupportedSchema);
                };
                Ok((key.to_owned(), yrs::XmlOut::Text(text).id()))
            })
            .collect()
    }
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.beforeOwnership");
    let old = sources(before)?;
    #[cfg(feature = "fitness-trace")]
    drop(_phase);
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.afterOwnership");
    let new = sources(after)?;
    #[cfg(feature = "fitness-trace")]
    drop(_phase);
    #[cfg(feature = "fitness-trace")]
    let _phase = crate::fitness::Span::new("engine.editor.validation.sourceIdentity");
    for (key, value) in old {
        if new.get(&key) != Some(&value) {
            return Err(DocumentError::UnsupportedSchema);
        }
    }
    Ok(())
}

#[cfg(test)]
mod checkpoint_stamp_tests {
    use super::*;
    use crate::{
        Utf16Offset,
        commands::{
            editor::{EditorCommand, EditorError},
            text::{TextError, TextOrigin},
        },
        editor_mapping as mapping,
    };
    use yrs::Text;

    fn fixture(case: u8, stable: bool, restored: bool) -> Document {
        let document_id = format!(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaa55{case:02x}{:02x}{:02x}",
            u8::from(stable),
            u8::from(restored)
        );
        let epoch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb5500";
        let identity = if stable {
            DocumentIdentity::v5(&document_id, epoch)
        } else {
            DocumentIdentity::v4(&document_id, epoch)
        }
        .unwrap();
        let doc = Document::create(
            CreationPermit::authorize_new(identity).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: "A😀e\u{301}Z".into(),
            }],
        )
        .unwrap();
        if restored {
            Document::restore(doc.identity(), &doc.checkpoint(), &[]).unwrap()
        } else {
            doc
        }
    }
    fn check(case: u8) {
        for stable in [false, true] {
            for restored in [false, true] {
                let mut doc = fixture(case, stable, restored);
                let id = doc.snapshot().unwrap().visible[0].id.clone();
                let baseline = doc.checkpoint().bytes;
                let stamp = doc.checkpoint_stamp();
                let revision = doc.revision();
                let vector = doc.state_vector_v1();
                let origin = TextOrigin::new("checkpoint-stamp-proof").unwrap();
                let plan = doc
                    .prepare_editor(
                        &[EditorCommand::ReplaceAt {
                            owner: id.clone(),
                            from: Utf16Offset(0),
                            to: Utf16Offset(1),
                            text: "z".into(),
                        }],
                        &origin,
                    )
                    .unwrap();
                match case {
                    0 => {
                        drop(doc.doc.transact_mut());
                    }
                    1 => mapping::text(&doc.doc, &id).insert(&mut doc.doc.transact_mut(), 0, "界"),
                    2 => {
                        mapping::text(&doc.doc, &id).remove_range(&mut doc.doc.transact_mut(), 0, 1)
                    }
                    3 => {
                        let mut txn = doc.doc.transact_mut();
                        txn.get_map(mapping::ROOTS[4]).unwrap().insert(
                            &mut txn,
                            id.as_str(),
                            BlockAttributes::Heading(2).tuple(),
                        );
                    }
                    4 => {
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                            || {
                                let text = mapping::text(&doc.doc, &id);
                                let mut txn = doc.doc.transact_mut();
                                text.insert(&mut txn, 0, "界");
                                panic!(
                                    "prepared rejection must observe a transaction dropped during unwind"
                                );
                            },
                        ));
                        assert!(outcome.is_err());
                    }
                    5 => {
                        let text = mapping::text(&doc.doc, &id);
                        text.insert(&mut doc.doc.transact_mut(), 0, "x");
                        text.remove_range(&mut doc.doc.transact_mut(), 0, 1);
                    }
                    6 => {
                        mapping::apply(&doc.doc, &baseline).unwrap();
                    }
                    7 => {
                        doc.inspect().unwrap();
                        doc.snapshot().unwrap();
                        doc.checkpoint();
                        assert_eq!(
                            stamp.value,
                            doc.checkpoint_stamp().value,
                            "read-only work must retain the fast path"
                        );
                    }
                    _ => unreachable!(),
                }
                assert_eq!(
                    doc.revision(),
                    revision,
                    "raw changes bypass public revision"
                );
                if case == 2 {
                    assert_eq!(
                        doc.state_vector_v1(),
                        vector,
                        "delete-only regression must not advance clocks"
                    );
                }
                let unchanged = doc.checkpoint().bytes == baseline;
                assert_eq!(
                    unchanged,
                    matches!(case, 0 | 6 | 7),
                    "independent byte oracle, case {case}"
                );
                assert_eq!(doc.matches_checkpoint(&stamp, &baseline), unchanged);
                let before_commit = doc.checkpoint().bytes;
                let result = doc.commit_editor(plan);
                if unchanged {
                    result.unwrap();
                    assert!(
                        doc.snapshot().unwrap().visible[0]
                            .runs
                            .iter()
                            .map(|r| r.text.as_str())
                            .collect::<String>()
                            .starts_with('z')
                    );
                } else {
                    assert!(matches!(
                        result,
                        Err(EditorError::Text(TextError::StalePlan))
                    ));
                    assert_eq!(doc.checkpoint().bytes, before_commit, "rejection is atomic");
                }
            }
        }
    }
    #[test]
    fn checkpoint_stamp_noop_transaction_preserves_exact_admission() {
        check(0);
    }
    #[test]
    fn checkpoint_stamp_raw_insert_rejects_without_revision_change() {
        check(1);
    }
    #[test]
    fn checkpoint_stamp_delete_only_rejects_without_clock_change() {
        check(2);
    }
    #[test]
    fn checkpoint_stamp_structural_write_rejects() {
        check(3);
    }
    #[test]
    fn checkpoint_stamp_unwound_transaction_rejects() {
        check(4);
    }
    #[test]
    fn checkpoint_stamp_reverted_text_keeps_tombstone_equality_rule() {
        check(5);
    }
    #[test]
    fn checkpoint_stamp_duplicate_update_preserves_admission() {
        check(6);
    }
    #[test]
    fn checkpoint_stamp_readonly_work_keeps_fast_path() {
        check(7);
    }
    #[test]
    fn checkpoint_stamp_saturation_and_foreign_owner_use_exact_bytes() {
        let doc = fixture(8, true, false);
        let baseline = doc.checkpoint().bytes;
        let foreign_live_stamp = CheckpointStamp {
            owner: Arc::new(AtomicU64::new(doc.checkpoint_stamp().value)),
            value: doc.checkpoint_stamp().value,
        };
        assert!(
            !doc.matches_checkpoint(&foreign_live_stamp, &[0]),
            "an equal counter from another owner cannot bypass exact bytes"
        );
        doc.checkpoint_stamp.store(u64::MAX - 1, Ordering::Relaxed);
        let before = doc.checkpoint_stamp();
        drop(doc.doc.transact_mut());
        assert_eq!(doc.checkpoint_stamp().value, u64::MAX);
        assert!(doc.matches_checkpoint(&before, &baseline));
        let saturated = doc.checkpoint_stamp();
        let foreign = CheckpointStamp {
            owner: Arc::new(AtomicU64::new(u64::MAX)),
            value: u64::MAX,
        };
        assert!(doc.matches_checkpoint(&foreign, &baseline));
        let id = doc.snapshot().unwrap().visible[0].id.clone();
        mapping::text(&doc.doc, &id).remove_range(&mut doc.doc.transact_mut(), 0, 1);
        assert_eq!(doc.checkpoint_stamp().value, u64::MAX, "stamp cannot wrap");
        assert!(!doc.matches_checkpoint(&saturated, &baseline));
        assert!(!doc.matches_checkpoint(&foreign, &baseline));
        let current = doc.checkpoint().bytes;
        let different_owner_same_value = CheckpointStamp {
            owner: Arc::new(AtomicU64::new(0)),
            value: 0,
        };
        assert!(doc.matches_checkpoint(&different_owner_same_value, &current));
        assert!(!doc.matches_checkpoint(&different_owner_same_value, &baseline));
    }
}
