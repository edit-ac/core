//! Stable, inert asset metadata and host port records. No bytes, access URLs,
//! credentials, fetches or asset-storage implementation belong in the document.
use super::content::ContentError;
use serde::{Deserialize, Serialize};

pub const MAX_ASSET_BYTES: u64 = 9_007_199_254_740_991;
pub const MAX_SOURCE_BYTES: usize = 1_048_576;

/// Host namespace and opaque key, never a locator or bearer credential. Hosts
/// must allocate durable non-secret keys; validation cannot identify a secret
/// deliberately encoded as an otherwise valid opaque key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetIdentity {
    pub host: String,
    pub key: String,
}
impl AssetIdentity {
    pub fn validate(&self) -> Result<(), ContentError> {
        for (value, max) in [(&self.host, 64), (&self.key, 256)] {
            if value.is_empty() || value.len() > max {
                return Err(ContentError::ResourceLimit);
            }
            if !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(ContentError::InvalidShape);
            }
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    File,
    Image,
    Media,
}

/// Declared metadata is descriptive, never authority to read or decode bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetMetadata {
    pub filename: String,
    pub media_type: String,
    pub byte_length: Option<u64>,
    pub sha256: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub alt: String,
    pub caption: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetDescriptor {
    pub identity: AssetIdentity,
    pub kind: AssetKind,
    pub metadata: AssetMetadata,
    /// Plain text only; consumers escape it for their output medium.
    pub fallback: String,
    /// Exact inert source, including unknown source syntax. Never interpreted.
    pub source: String,
}
impl AssetDescriptor {
    pub fn validate(&self) -> Result<(), ContentError> {
        self.identity.validate()?;
        let m = &self.metadata;
        if m.filename.is_empty()
            || m.filename.len() > 1024
            || m.media_type.len() > 127
            || m.alt.len() > 8192
            || m.caption.len() > 8192
            || self.fallback.is_empty()
            || self.fallback.encode_utf16().count() > 8192
            || self.source.len() > MAX_SOURCE_BYTES
            || m.byte_length.is_some_and(|v| v > MAX_ASSET_BYTES)
            || m.duration_ms.is_some_and(|v| v > MAX_ASSET_BYTES)
            || m.width.is_some_and(|v| v == 0 || v > 1_000_000)
            || m.height.is_some_and(|v| v == 0 || v > 1_000_000)
        {
            return Err(ContentError::ResourceLimit);
        }
        let Some((major, minor)) = m.media_type.split_once('/') else {
            return Err(ContentError::InvalidShape);
        };
        let token = |s: &str| {
            !s.is_empty()
                && s.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$&^_.+-".contains(&b)
                })
        };
        if !token(major)
            || !token(minor)
            || m.filename
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            || self
                .fallback
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
            || m.sha256.as_ref().is_some_and(|v| {
                v.len() != 64
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || (self.kind == AssetKind::Image && major != "image")
            || (self.kind == AssetKind::Media && major != "audio" && major != "video")
            || m.width.is_some() != m.height.is_some()
            || (self.kind == AssetKind::File && (m.width.is_some() || m.duration_ms.is_some()))
            || (self.kind == AssetKind::Image && m.duration_ms.is_some())
        {
            return Err(ContentError::InvalidShape);
        }
        Ok(())
    }
    /// Missing host knowledge always yields an honest fallback. Local/queued
    /// observations are host-local and must not be copied to another replica.
    pub fn state(
        &self,
        observation: Option<&AssetObservation>,
    ) -> Result<AssetState, ContentError> {
        self.validate()?;
        if let Some(o) = observation {
            o.identity.validate()?;
            if o.identity != self.identity {
                return Err(ContentError::InvalidShape);
            }
            Ok(o.state)
        } else {
            Ok(AssetState::Missing)
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetState {
    Local,
    Queued,
    Available,
    Failed,
    Missing,
    Revoked,
    Locked,
}
/// Derived host state, not persisted collaborative metadata or document receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetObservation {
    pub identity: AssetIdentity,
    pub state: AssetState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetAction {
    Authorize,
    Ingest,
    Read,
    Cache,
    Publish,
    ResolveUrl,
    Cancel,
    ReleaseReference,
    Open,
    Download,
}
/// Explicit asset-scoped host decision. Descriptive metadata grants no actions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetGrant {
    pub identity: AssetIdentity,
    pub actions: Vec<AssetAction>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetRequest {
    pub version: u32,
    pub operation_id: String,
    pub identity: AssetIdentity,
    pub action: AssetAction,
    /// Upper bound on host byte work; bytes never enter this record.
    pub byte_limit: u64,
}
impl AssetRequest {
    pub fn validate(&self, grant: &AssetGrant) -> Result<(), ContentError> {
        self.identity.validate()?;
        AssetIdentity {
            host: "operation".into(),
            key: self.operation_id.clone(),
        }
        .validate()?;
        grant.identity.validate()?;
        if self.version != 1 {
            return Err(ContentError::UnsupportedVersion);
        }
        if self.byte_limit == 0 || self.byte_limit > MAX_ASSET_BYTES {
            return Err(ContentError::ResourceLimit);
        }
        if grant.identity != self.identity
            || grant.actions.len() > 10
            || !grant.actions.contains(&self.action)
            || grant
                .actions
                .iter()
                .enumerate()
                .any(|(i, a)| grant.actions[..i].contains(a))
        {
            return Err(ContentError::InvalidShape);
        }
        Ok(())
    }
}
/// Asset publication evidence is distinct from any document commit/acknowledgment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetCommitReceipt {
    pub operation_id: String,
    pub identity: AssetIdentity,
}
/// URL resolution is ephemeral and intentionally has no Serialize implementation.
/// Only an authorized host may supply it; document descriptors have no URL field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedAssetUrl {
    pub operation_id: String,
    pub identity: AssetIdentity,
    pub url: String,
}

impl AssetCommitReceipt {
    pub fn validate_for(
        &self,
        request: &AssetRequest,
        grant: &AssetGrant,
    ) -> Result<(), ContentError> {
        request.validate(grant)?;
        if request.action != AssetAction::Publish
            || self.operation_id != request.operation_id
            || self.identity != request.identity
        {
            return Err(ContentError::InvalidShape);
        }
        Ok(())
    }
}
impl ResolvedAssetUrl {
    pub fn validate_for(
        &self,
        request: &AssetRequest,
        grant: &AssetGrant,
    ) -> Result<(), ContentError> {
        request.validate(grant)?;
        if request.action != AssetAction::ResolveUrl
            || self.operation_id != request.operation_id
            || self.identity != request.identity
        {
            return Err(ContentError::InvalidShape);
        }
        if self.url.len() > 8192 {
            return Err(ContentError::ResourceLimit);
        }
        let url = url::Url::parse(&self.url).map_err(|_| ContentError::UnsafeUrl)?;
        if !matches!(url.scheme(), "https" | "blob")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(ContentError::UnsafeUrl);
        }
        Ok(())
    }
}
