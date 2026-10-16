//! Owned native translation of the shared immutable HistoryStore and ChangeModel.
//! No alternate diff, live checkout, attribution authority or archival persistence.
use super::*;
use editac_diff::{
    portable::{ChangeInput, ChangeModel, ExportError, MAX_BYTES},
    representation::{
        ContentHash, HistoryAvailability, Representation, RepresentationError,
        RepresentationLimits, RetentionPolicy, RevisionScope, UnavailableReason,
    },
    semantic::{SemanticLimits, capture_projection, compare},
};
use editac_session::history_store::{HistoryError, HistoryRequest, HistoryStore};

const MAX_HISTORY_BYTES: usize = 32 * 1024 * 1024;
const MAX_HISTORY_REVISIONS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeReviewFailure {
    Invalid,
    ScopeMismatch,
    RepresentationMismatch,
    HashMismatch,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeReviewRepresentation {
    ExactSource,
    ProjectedMarkdown { serializer: String, dialect: String },
    Semantic,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeReviewRevision {
    /// Opaque, process-local HistoryStore key. Never a persisted ordering token.
    pub key: String,
    pub document_id: String,
    pub epoch: String,
    pub schema: String,
    pub module_profile: String,
    pub observed_revision: Vec<u8>,
    pub representation: NativeReviewRepresentation,
    pub hash: Vec<u8>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeChangeModel {
    /// Canonical editac-change-model-v1 bytes, not a writable replica.
    pub json: Vec<u8>,
    pub representation: NativeReviewRepresentation,
    pub attribution: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeReviewUnavailable {
    Missing,
    Pruned,
    IncompatibleSchema,
    KeyUnavailable,
}
#[derive(Clone, Debug, uniffi::Enum)]
pub enum NativeReviewRead {
    Available { name: String, bytes: Vec<u8> },
    Unavailable { reason: NativeReviewUnavailable },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeReviewSide {
    Before,
    After,
}
#[derive(Clone, Debug, uniffi::Enum)]
pub enum NativeReviewComparison {
    Available {
        model: NativeChangeModel,
    },
    Unavailable {
        side: NativeReviewSide,
        reason: NativeReviewUnavailable,
    },
}

fn invalid(reason: NativeReviewFailure) -> NativeSessionError {
    NativeSessionError::ReviewInput { reason }
}
impl From<RepresentationError> for NativeSessionError {
    fn from(error: RepresentationError) -> Self {
        match error {
            RepresentationError::ResourceLimit => Self::ResourceLimit,
            RepresentationError::IncompatibleScope => invalid(NativeReviewFailure::ScopeMismatch),
            RepresentationError::IncompatibleRepresentation => {
                invalid(NativeReviewFailure::RepresentationMismatch)
            }
            _ => invalid(NativeReviewFailure::Invalid),
        }
    }
}
impl From<HistoryError> for NativeSessionError {
    fn from(error: HistoryError) -> Self {
        match error {
            HistoryError::ResourceLimit | HistoryError::SequenceExhausted => Self::ResourceLimit,
            HistoryError::Session(error) => error.into(),
            HistoryError::Representation(error) => error.into(),
            HistoryError::ScopeMismatch => invalid(NativeReviewFailure::ScopeMismatch),
            HistoryError::RepresentationMismatch => {
                invalid(NativeReviewFailure::RepresentationMismatch)
            }
            HistoryError::HashMismatch => invalid(NativeReviewFailure::HashMismatch),
            HistoryError::InvalidLabel => invalid(NativeReviewFailure::Invalid),
        }
    }
}
impl From<UnavailableReason> for NativeReviewUnavailable {
    fn from(reason: UnavailableReason) -> Self {
        match reason {
            UnavailableReason::Missing => Self::Missing,
            UnavailableReason::Pruned => Self::Pruned,
            UnavailableReason::KeyUnavailable => Self::KeyUnavailable,
            UnavailableReason::IncompatibleSchema => Self::IncompatibleSchema,
        }
    }
}
impl From<Representation> for NativeReviewRepresentation {
    fn from(value: Representation) -> Self {
        match value {
            Representation::ExactSourceUtf8 => Self::ExactSource,
            Representation::ProjectedMarkdown {
                serializer,
                dialect,
            } => Self::ProjectedMarkdown {
                serializer,
                dialect,
            },
            Representation::SemanticV1 => Self::Semantic,
        }
    }
}
fn valid_label(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 {
        return Err(invalid(NativeReviewFailure::Invalid));
    }
    Ok(())
}
impl NativeReviewRevision {
    fn from_request(request: HistoryRequest) -> Result<Self> {
        Ok(Self {
            key: serde_json::to_string(&request.key)
                .map_err(|_| invalid(NativeReviewFailure::Invalid))?,
            document_id: request.scope.document,
            epoch: request.scope.epoch,
            schema: request.scope.schema,
            module_profile: request.scope.module_profile,
            observed_revision: request.scope.observed_token.to_vec(),
            representation: request.representation.into(),
            hash: request.hash.0.to_vec(),
        })
    }
    fn into_request(self) -> Result<HistoryRequest> {
        if self.key.len() > 1024 {
            return Err(NativeSessionError::ResourceLimit);
        }
        for value in [
            &self.document_id,
            &self.epoch,
            &self.schema,
            &self.module_profile,
        ] {
            valid_label(value)?;
        }
        let representation = match self.representation {
            NativeReviewRepresentation::ExactSource => Representation::ExactSourceUtf8,
            NativeReviewRepresentation::ProjectedMarkdown {
                serializer,
                dialect,
            } => {
                valid_label(&serializer)?;
                valid_label(&dialect)?;
                Representation::ProjectedMarkdown {
                    serializer,
                    dialect,
                }
            }
            NativeReviewRepresentation::Semantic => Representation::SemanticV1,
        };
        // Validate the public observed-token encoding as well as its exact length.
        let observed = ObservedRevision::from_bytes(&self.observed_revision)?;
        Ok(HistoryRequest {
            key: serde_json::from_str(&self.key)
                .map_err(|_| invalid(NativeReviewFailure::Invalid))?,
            scope: RevisionScope {
                document: self.document_id,
                epoch: self.epoch,
                schema: self.schema,
                module_profile: self.module_profile,
                observed_token: observed.to_bytes(),
            },
            representation,
            hash: ContentHash(
                self.hash
                    .try_into()
                    .map_err(|_| invalid(NativeReviewFailure::Invalid))?,
            ),
        })
    }
}
fn output_limit(max_bytes: u64) -> Result<usize> {
    if max_bytes == 0 || max_bytes > MAX_BYTES as u64 {
        return Err(NativeSessionError::ResourceLimit);
    }
    Ok(max_bytes as usize)
}
fn portable_error(error: ExportError) -> NativeSessionError {
    match error {
        ExportError::Limit => NativeSessionError::ResourceLimit,
        ExportError::Invalid => invalid(NativeReviewFailure::Invalid),
    }
}
fn owned_model(model: ChangeModel, max_bytes: usize) -> Result<NativeChangeModel> {
    let representation = match &model.input {
        ChangeInput::ExactSource { .. } => NativeReviewRepresentation::ExactSource,
        ChangeInput::ProjectedMarkdown {
            serializer,
            dialect,
            ..
        } => NativeReviewRepresentation::ProjectedMarkdown {
            serializer: serializer.clone(),
            dialect: dialect.clone(),
        },
        ChangeInput::Semantic { .. } => NativeReviewRepresentation::Semantic,
    };
    Ok(NativeChangeModel {
        json: model.encode(max_bytes).map_err(portable_error)?,
        representation,
        attribution: "unknown".into(),
    })
}
pub(super) fn new_review_history() -> Result<HistoryStore> {
    Ok(HistoryStore::new(
        "native-session-review-v1",
        RetentionPolicy {
            max_revisions: 16,
            max_total_bytes: MAX_HISTORY_BYTES,
        },
    )?)
}
fn capture_limits() -> RepresentationLimits {
    RepresentationLimits {
        max_bytes: MAX_PROJECTION_BYTES,
        ..RepresentationLimits::default()
    }
}
#[uniffi::export]
impl NativeSession {
    /// Canonical shared decoder/validator. No native semantic parser or author inference.
    pub fn validate_change_model(
        &self,
        bytes: Vec<u8>,
        max_bytes: u64,
    ) -> Result<NativeChangeModel> {
        self.call(move |_| {
            let limit = output_limit(max_bytes)?;
            owned_model(
                ChangeModel::decode(&bytes, limit).map_err(portable_error)?,
                limit,
            )
        })
    }
    /// Explicit acknowledged-state capture; never called from typing/edit/history hooks.
    pub fn capture_review_revision(
        &self,
        revision: Vec<u8>,
        name: String,
        required_key_profile: Option<String>,
    ) -> Result<NativeReviewRevision> {
        self.call(move |state| {
            let expected = ObservedRevision::from_bytes(&revision)?;
            let request = state.review_history.capture_session(
                state.service.session(),
                &expected,
                &name,
                required_key_profile.as_deref(),
                |document, scope| {
                    let snapshot = document
                        .snapshot()
                        .map_err(|_| RepresentationError::InvalidSemantic)?;
                    capture_projection(scope, &snapshot, capture_limits())
                },
            )?;
            NativeReviewRevision::from_request(request)
        })
    }
    pub fn read_review_revision(
        &self,
        revision: NativeReviewRevision,
        available_key_profile: Option<String>,
    ) -> Result<NativeReviewRead> {
        self.call(move |state| {
            if let Some(profile) = &available_key_profile {
                valid_label(profile)?;
            }
            match state
                .review_history
                .read(&revision.into_request()?, available_key_profile.as_deref())?
            {
                HistoryAvailability::Available(entry) => Ok(NativeReviewRead::Available {
                    name: entry.name().into(),
                    bytes: entry.revision().bytes().to_vec(),
                }),
                HistoryAvailability::Unavailable(reason) => Ok(NativeReviewRead::Unavailable {
                    reason: reason.into(),
                }),
            }
        })
    }
    pub fn compare_review_revisions(
        &self,
        before: NativeReviewRevision,
        after: NativeReviewRevision,
        before_key_profile: Option<String>,
        after_key_profile: Option<String>,
        max_bytes: u64,
    ) -> Result<NativeReviewComparison> {
        self.call(move |state| {
            let limit = output_limit(max_bytes)?;
            for profile in [before_key_profile.as_deref(), after_key_profile.as_deref()]
                .into_iter()
                .flatten()
            {
                valid_label(profile)?;
            }
            let before = before.into_request()?;
            let after = after.into_request()?;
            let read = |request, key| state.review_history.read(request, key);
            let left = match read(&before, before_key_profile.as_deref())? {
                HistoryAvailability::Available(entry) => entry.revision(),
                HistoryAvailability::Unavailable(reason) => {
                    return Ok(NativeReviewComparison::Unavailable {
                        side: NativeReviewSide::Before,
                        reason: reason.into(),
                    });
                }
            };
            let right = match read(&after, after_key_profile.as_deref())? {
                HistoryAvailability::Available(entry) => entry.revision(),
                HistoryAvailability::Unavailable(reason) => {
                    return Ok(NativeReviewComparison::Unavailable {
                        side: NativeReviewSide::After,
                        reason: reason.into(),
                    });
                }
            };
            let model = compare(
                left,
                right,
                SemanticLimits {
                    input: capture_limits(),
                    max_output_bytes: limit,
                    ..SemanticLimits::default()
                },
            )?;
            Ok(NativeReviewComparison::Available {
                model: owned_model(
                    ChangeModel::new(ChangeInput::Semantic { model }).map_err(portable_error)?,
                    limit,
                )?,
            })
        })
    }
    /// Tightening immediately prunes; widening cannot recreate evicted history.
    pub fn set_review_retention(&self, max_revisions: u32, max_total_bytes: u64) -> Result<()> {
        self.call(move |state| {
            if max_revisions as usize > MAX_HISTORY_REVISIONS
                || max_total_bytes > MAX_HISTORY_BYTES as u64
            {
                return Err(NativeSessionError::ResourceLimit);
            }
            state.review_history.set_retention(RetentionPolicy {
                max_revisions: max_revisions as usize,
                max_total_bytes: max_total_bytes as usize,
            });
            Ok(())
        })
    }
}
