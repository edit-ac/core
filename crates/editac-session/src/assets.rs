//! Durable host work on the existing per-document store. No binary bytes or URLs,
//! semantic mutations, automatic retries, or binary deletion enter this journal.
use crate::ports::{Durability, LocalStore, PortError};
use editac_core::modules::assets::{
    AssetAction, AssetCommitReceipt, AssetGrant, AssetIdentity, AssetRequest,
};
use std::sync::Arc;

pub const MAX_ASSET_INTENTS: usize = 256;
pub const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ATTEMPTS: u32 = 8;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[cfg_attr(feature = "asset-serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "asset-serde", serde(deny_unknown_fields))]
pub struct AssetJournal {
    intents: Vec<AssetIntent>,
    retired: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "asset-serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "asset-serde", serde(deny_unknown_fields))]
pub struct AssetIntent {
    pub reference: String,
    pub request: AssetRequest,
    pub status: WorkStatus,
    pub attempts: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "asset-serde", derive(serde::Serialize, serde::Deserialize))]
pub enum WorkStatus {
    Pending,
    Complete,
    Canceled,
    Published(AssetCommitReceipt),
}

/// Separate from LocalCommit/UpdateId: never acknowledges document persistence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIntentReceipt {
    pub operation_id: String,
    pub durability: Durability,
}

/// Implementations execute the closure once in their existing atomic transaction.
/// A failed/unknown commit must be resolved by reading/retrying the same operation ID.
pub trait AssetStore: LocalStore {
    fn asset_journal(&self) -> Result<AssetJournal, PortError>;
    fn update_assets<R>(
        &self,
        work: impl FnOnce(&mut AssetJournal) -> Result<R, PortError>,
    ) -> Result<R, PortError>;
}
impl<S: AssetStore + crate::session::SessionStore> AssetStore for Arc<S> {
    fn asset_journal(&self) -> Result<AssetJournal, PortError> {
        (**self).asset_journal()
    }
    fn update_assets<R>(
        &self,
        work: impl FnOnce(&mut AssetJournal) -> Result<R, PortError>,
    ) -> Result<R, PortError> {
        (**self).update_assets(work)
    }
}

fn valid_key(key: &str) -> Result<(), PortError> {
    AssetIdentity {
        host: "reference".into(),
        key: key.into(),
    }
    .validate()
    .map_err(|_| PortError::InvalidRecord)
}
fn cleanup(action: AssetAction) -> bool {
    matches!(action, AssetAction::Cancel | AssetAction::ReleaseReference)
}
impl AssetJournal {
    pub fn intents(&self) -> &[AssetIntent] {
        &self.intents
    }
    pub fn is_retired(&self, reference: &str) -> bool {
        self.retired.iter().any(|r| r == reference)
    }
    /// Reservation remains owned until the host acknowledges scoped release.
    /// Cancellation alone does not attest that an in-flight decoder/cache stopped.
    pub fn reserved_cache_bytes(&self) -> u64 {
        self.intents
            .iter()
            .filter(|i| {
                i.request.action == AssetAction::Cache
                    && !self.intents.iter().any(|release| {
                        release.reference == i.reference
                            && release.request.action == AssetAction::ReleaseReference
                            && release.status == WorkStatus::Complete
                    })
            })
            .map(|i| i.request.byte_limit)
            .sum()
    }
    fn release_ready(&self, intent: &AssetIntent) -> bool {
        intent.request.action != AssetAction::ReleaseReference
            || self.intents.iter().any(|cancel| {
                cancel.reference == intent.reference
                    && cancel.request.action == AssetAction::Cancel
                    && cancel.status == WorkStatus::Complete
            })
    }
    pub(crate) fn validate(&self) -> Result<(), PortError> {
        if self.intents.len() > MAX_ASSET_INTENTS || self.retired.len() > MAX_ASSET_INTENTS {
            return Err(PortError::ResourceLimit);
        }
        for (i, intent) in self.intents.iter().enumerate() {
            valid_key(&intent.reference)?;
            intent
                .request
                .validate(&AssetGrant {
                    identity: intent.request.identity.clone(),
                    actions: vec![intent.request.action],
                })
                .map_err(|_| PortError::InvalidRecord)?;
            if intent.attempts > MAX_ATTEMPTS
                || self.intents[..i]
                    .iter()
                    .any(|v| v.request.operation_id == intent.request.operation_id)
            {
                return Err(PortError::Integrity);
            }
            if let WorkStatus::Published(receipt) = &intent.status {
                receipt
                    .validate_for(
                        &intent.request,
                        &AssetGrant {
                            identity: intent.request.identity.clone(),
                            actions: vec![AssetAction::Publish],
                        },
                    )
                    .map_err(|_| PortError::Integrity)?;
            }
            if self.is_retired(&intent.reference)
                && !cleanup(intent.request.action)
                && intent.status == WorkStatus::Pending
            {
                return Err(PortError::Integrity);
            }
            if !matches!(
                intent.request.action,
                AssetAction::Ingest
                    | AssetAction::Read
                    | AssetAction::Cache
                    | AssetAction::Publish
                    | AssetAction::Cancel
                    | AssetAction::ReleaseReference
            ) || (cleanup(intent.request.action) && !self.is_retired(&intent.reference))
                || (intent.request.action == AssetAction::Publish
                    && intent.status == WorkStatus::Complete)
                || self.intents[..i].iter().any(|old| {
                    old.reference == intent.reference
                        && old.request.identity != intent.request.identity
                })
            {
                return Err(PortError::Integrity);
            }
        }
        for (i, r) in self.retired.iter().enumerate() {
            valid_key(r)?;
            if self.retired[..i].contains(r) {
                return Err(PortError::Integrity);
            }
        }
        if self.reserved_cache_bytes() > MAX_CACHE_BYTES {
            return Err(PortError::Quota);
        }
        Ok(())
    }
    pub(crate) fn byte_size(&self) -> usize {
        self.intents
            .iter()
            .map(|i| {
                1024 + i.reference.len()
                    + i.request.operation_id.len()
                    + i.request.identity.host.len()
                    + i.request.identity.key.len()
            })
            .sum::<usize>()
            + self.retired.iter().map(String::len).sum::<usize>()
    }
    fn enqueue(&mut self, reference: &str, request: AssetRequest) -> Result<(), PortError> {
        valid_key(reference)?;
        if let Some(old) = self
            .intents
            .iter()
            .find(|i| i.request.operation_id == request.operation_id)
        {
            return if old.reference == reference && old.request == request {
                Ok(())
            } else {
                Err(PortError::Conflict)
            };
        }
        if self.is_retired(reference)
            || self
                .intents
                .iter()
                .any(|i| i.reference == reference && i.request.identity != request.identity)
        {
            return Err(PortError::Conflict);
        }
        // Reserve cleanup capacity before accepting work; tombstones and IDs are never
        // silently evicted, so late completions cannot target a recycled reference.
        let mut references: std::collections::BTreeSet<_> = self
            .intents
            .iter()
            .filter(|i| !self.is_retired(&i.reference))
            .map(|i| i.reference.as_str())
            .collect();
        references.insert(reference);
        if self.intents.len() + 1 + 2 * references.len() > MAX_ASSET_INTENTS {
            return Err(PortError::Backpressure);
        }
        self.intents.push(AssetIntent {
            reference: reference.into(),
            request,
            status: WorkStatus::Pending,
            attempts: 0,
        });
        self.validate()
    }
}

/// The host must reauthorize every dispatch and implement idempotency by operation ID.
/// Ingest/publish bytes, encryption, cache eviction and global reference counts remain
/// host-owned. ReleaseReference only releases this document/reference, never a binary.
pub trait AssetHost {
    fn authorize(&mut self, request: &AssetRequest) -> Result<AssetGrant, PortError>;
    fn execute(
        &mut self,
        reference: &str,
        request: &AssetRequest,
    ) -> Result<HostOutcome, PortError>;
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostOutcome {
    Complete,
    Published(AssetCommitReceipt),
}

pub struct AssetWork<'a, S: AssetStore> {
    store: &'a S,
}
impl<'a, S: AssetStore> AssetWork<'a, S> {
    pub fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub fn enqueue(
        &self,
        reference: &str,
        request: AssetRequest,
        grant: &AssetGrant,
    ) -> Result<AssetIntentReceipt, PortError> {
        request.validate(grant).map_err(|_| PortError::Permission)?;
        if !matches!(
            request.action,
            AssetAction::Ingest | AssetAction::Read | AssetAction::Cache | AssetAction::Publish
        ) {
            return Err(PortError::InvalidRecord);
        }
        let operation_id = request.operation_id.clone();
        self.store
            .update_assets(|j| j.enqueue(reference, request))?;
        Ok(AssetIntentReceipt {
            operation_id,
            durability: self.store.capabilities().durability,
        })
    }
    /// Persist deletion/cancel fencing before any host operation. No node mutation.
    /// A reference is scoped by this per-document store and cannot be reused.
    pub fn retire(
        &self,
        reference: &str,
        identity: &AssetIdentity,
        operation_prefix: &str,
    ) -> Result<(), PortError> {
        valid_key(reference)?;
        valid_key(operation_prefix)?;
        identity.validate().map_err(|_| PortError::InvalidRecord)?;
        self.store.update_assets(|j| {
            if j.is_retired(reference) {
                return Ok(());
            }
            if j.retired.len() >= MAX_ASSET_INTENTS || j.intents.len() + 2 > MAX_ASSET_INTENTS {
                return Err(PortError::Backpressure);
            }
            if j.intents
                .iter()
                .any(|i| i.reference == reference && i.request.identity != *identity)
            {
                return Err(PortError::Conflict);
            }
            for (suffix, action) in [
                ("cancel", AssetAction::Cancel),
                ("release", AssetAction::ReleaseReference),
            ] {
                let request = AssetRequest {
                    version: 1,
                    operation_id: format!("{operation_prefix}_{suffix}"),
                    identity: identity.clone(),
                    action,
                    byte_limit: 1,
                };
                request
                    .validate(&AssetGrant {
                        identity: identity.clone(),
                        actions: vec![action],
                    })
                    .map_err(|_| PortError::InvalidRecord)?;
                if j.intents
                    .iter()
                    .any(|i| i.request.operation_id == request.operation_id)
                {
                    return Err(PortError::Conflict);
                }
                j.intents.push(AssetIntent {
                    reference: reference.into(),
                    request,
                    status: WorkStatus::Pending,
                    attempts: 0,
                });
            }
            j.retired.push(reference.into());
            for i in &mut j.intents {
                if i.reference == reference
                    && !cleanup(i.request.action)
                    && i.status == WorkStatus::Pending
                {
                    i.status = WorkStatus::Canceled;
                }
            }
            j.validate()
        })
    }
    /// One explicit attempt, no loops, network discovery or ambient authorization.
    /// A crash after execute retries the exact ID; only the host can deduplicate bytes.
    pub fn run_one(
        &self,
        operation_id: &str,
        online: bool,
        host: &mut impl AssetHost,
    ) -> Result<bool, PortError> {
        let mut authorized = None;
        let Some(captured) = self.begin_dispatch(operation_id, online, |request| {
            let grant = host.authorize(request)?;
            authorized = Some(grant.clone());
            Ok(grant)
        })?
        else {
            return Ok(false);
        };
        let grant = authorized.ok_or(PortError::Permission)?;
        let outcome = host.execute(&captured.reference, &captured.request)?;
        self.complete(operation_id, outcome, &grant)?;
        Ok(true)
    }
    /// Persist one authorized attempt before asynchronous host work. Completion
    /// must reauthorize through `complete`; no host effect runs in this transaction.
    pub fn begin_dispatch(
        &self,
        operation_id: &str,
        online: bool,
        authorize: impl FnOnce(&AssetRequest) -> Result<AssetGrant, PortError>,
    ) -> Result<Option<AssetIntent>, PortError> {
        let j = self.store.asset_journal()?;
        let intent = j
            .intents
            .iter()
            .find(|i| i.request.operation_id == operation_id)
            .ok_or(PortError::InvalidRecord)?;
        if intent.status != WorkStatus::Pending {
            return Ok(None);
        }
        if !online {
            return Err(PortError::Unavailable);
        }
        let grant = authorize(&intent.request)?;
        intent
            .request
            .validate(&grant)
            .map_err(|_| PortError::Permission)?;
        let captured = self.store.update_assets(|j| {
            let current = j
                .intents
                .iter()
                .find(|i| i.request.operation_id == operation_id)
                .ok_or(PortError::InvalidRecord)?;
            if !j.release_ready(current) {
                return Err(PortError::Backpressure);
            }
            let i = j
                .intents
                .iter_mut()
                .find(|i| i.request.operation_id == operation_id)
                .ok_or(PortError::InvalidRecord)?;
            if i.status != WorkStatus::Pending {
                return Ok(None);
            }
            if i.attempts >= MAX_ATTEMPTS {
                return Err(PortError::Backpressure);
            }
            i.attempts += 1;
            Ok(Some(i.clone()))
        })?;
        Ok(captured)
    }
    /// Public completion boundary for hosts with asynchronous transport. Late results
    /// on a retired reference are ignored; matching receipts never touch the document.
    pub fn complete(
        &self,
        operation_id: &str,
        outcome: HostOutcome,
        grant: &AssetGrant,
    ) -> Result<(), PortError> {
        self.store.update_assets(|j| {
            let current = j
                .intents
                .iter()
                .find(|i| i.request.operation_id == operation_id)
                .ok_or(PortError::InvalidRecord)?;
            if !j.release_ready(current) {
                return Err(PortError::Backpressure);
            }
            let i = j
                .intents
                .iter_mut()
                .find(|i| i.request.operation_id == operation_id)
                .ok_or(PortError::InvalidRecord)?;
            i.request
                .validate(grant)
                .map_err(|_| PortError::Permission)?;
            let status = match outcome {
                HostOutcome::Published(receipt) => {
                    receipt
                        .validate_for(&i.request, grant)
                        .map_err(|_| PortError::Integrity)?;
                    WorkStatus::Published(receipt)
                }
                HostOutcome::Complete if i.request.action != AssetAction::Publish => {
                    WorkStatus::Complete
                }
                _ => return Err(PortError::Integrity),
            };
            if i.status == WorkStatus::Canceled {
                return Ok(());
            }
            if i.status != WorkStatus::Pending && i.status != status {
                return Err(PortError::Conflict);
            }
            i.status = status;
            Ok(())
        })
    }
}
