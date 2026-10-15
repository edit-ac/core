//! Per-viewer cache, outside the engine/CRDT. Hosts route logout, switch, revoke
//! and key-lock events here and discard any previously rendered projection.
//! Every delivery still checks current local host/target authorization. Offline
//! endpoint authorization MUST use local grants only; it must not probe a site.
//! Offline reuse is opt-in, bounded by both the last ONLINE authorization lease
//! and metadata expiry. It cannot discover remote revocation before reconnect.
use super::{private_resolver::*, *};
use crate::locator::{Catalog, Connectivity};
use std::collections::VecDeque;

pub const MAX_PRIVATE_CACHE_ENTRIES: usize = 256;
pub const MAX_OFFLINE_LEASE_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug)]
pub struct PrivateCachePolicy {
    pub entries: usize,
    /// Zero disables offline display. Never renewed by an offline hit.
    pub offline_lease_ms: u64,
}
impl Default for PrivateCachePolicy {
    fn default() -> Self {
        Self {
            entries: 64,
            offline_lease_ms: 0,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub enum PrivateInvalidation {
    Logout,
    AccountSwitch,
    Revoked,
    KeyLocked,
    PolicyChanged,
}
struct Entry {
    request: LinkRequest,
    outcome: LinkOutcome,
    offline_until: u64,
}
/// Exact audience snapshot supplied and checked by the host, never by metadata.
#[derive(Clone, PartialEq, Eq)]
pub struct DisclosureScope {
    pub document: String,
    pub recipients: Vec<String>,
    pub permission_revision: String,
}
impl DisclosureScope {
    fn valid(&self) -> bool {
        bounded(&self.document, MAX_TEXT)
            && bounded(&self.permission_revision, MAX_TEXT)
            && !self.recipients.is_empty()
            && self.recipients.len() <= 256
            && self.recipients.iter().all(|s| bounded(s, MAX_TEXT))
    }
}
/// An explicit disclosure decision is separate from target-read capability.
/// Check the actual current document audience, not a caller-asserted recipient
/// list. Serialise this decision and action consumption with document/auth
/// changes; reprepare if either changes before the actual engine commit.
pub trait PrivateDisclosureHost {
    fn authorize_disclosure(
        &mut self,
        request: &LinkRequest,
        scope: &DisclosureScope,
        shared_label: &str,
    ) -> bool;
}
/// Prepared intent only. Consumers must preserve the audience with the action,
/// validate the current document revision/permission, and use engine history.
/// Already disclosed shared text cannot be erased by later cache revocation.
pub struct PrivateDisclosure {
    pub scope: DisclosureScope,
    pub action: LinkAction,
}

pub struct CachedPrivateResolver<'a, H> {
    resolver: PrivateResolver<'a, H>,
    policy: PrivateCachePolicy,
    entries: VecDeque<Entry>,
    last_now: u64,
    disposed: bool,
}
impl<'a, H: PrivateEndpoint> CachedPrivateResolver<'a, H> {
    pub fn new(
        catalog: &'a Catalog,
        endpoint: H,
        connectivity: Connectivity,
        policy: PrivateCachePolicy,
    ) -> Result<Self, LinkState> {
        if policy.entries == 0
            || policy.entries > MAX_PRIVATE_CACHE_ENTRIES
            || policy.offline_lease_ms > MAX_OFFLINE_LEASE_MS
        {
            return Err(LinkState::Unsupported);
        }
        Ok(Self {
            resolver: PrivateResolver::new(catalog, endpoint, connectivity),
            policy,
            entries: VecDeque::new(),
            last_now: 0,
            disposed: false,
        })
    }
    pub fn set_connectivity(&mut self, connectivity: Connectivity) {
        self.resolver.set_connectivity(connectivity);
    }
    /// Conservative full eviction also removes stale field-level grants. The host
    /// must immediately clear projections it previously copied to its presenter.
    pub fn invalidate(&mut self, _event: PrivateInvalidation) {
        self.entries.clear();
    }
    pub fn dispose(&mut self) {
        self.entries.clear();
        self.disposed = true;
    }
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    fn same_key(a: &LinkRequest, b: &LinkRequest) -> bool {
        // Includes principal/tenant/authority/target/policy/permission revision.
        // Conservatively also isolates document/session/revision/capabilities.
        a.host == b.host && a.target == b.target && a.policy == b.policy
    }
    fn lookup(
        &mut self,
        request: &LinkRequest,
        allow_fetch: bool,
        publishing: bool,
    ) -> Result<LinkOutcome, LinkState> {
        if self.disposed {
            return Err(LinkState::Canceled);
        }
        let (session, access) = match self.resolver.check(request, false) {
            Ok(value) => value,
            Err(state) => {
                self.entries
                    .retain(|e| !Self::same_key(&e.request, request));
                return Err(state);
            }
        };
        if publishing {
            let state = request.intent_permission(&session.context, true);
            if state != LinkState::Available {
                return Err(state);
            }
        }
        if session.now_ms < self.last_now {
            self.entries.clear();
            return Err(LinkState::Stale);
        }
        self.last_now = session.now_ms;
        self.entries.retain(|e| {
            matches!(&e.outcome, LinkOutcome::Available { freshness, .. }
            if freshness.expires_at > session.now_ms && freshness.fetched_at <= session.now_ms)
        });
        let online = self.resolver.connectivity() == Connectivity::Online;
        if let Some(entry) = self
            .entries
            .iter()
            .find(|e| Self::same_key(&e.request, request))
        {
            if !online
                && (self.policy.offline_lease_ms == 0 || session.now_ms >= entry.offline_until)
            {
                return Err(LinkState::Unavailable);
            }
            let mut outcome = entry.outcome.clone();
            // Check again after host authorization and intersect both snapshots.
            let (latest, current) = self.resolver.check(request, false)?;
            if publishing {
                let state = request.intent_permission(&latest.context, true);
                if state != LinkState::Available {
                    return Err(state);
                }
            }
            if latest.now_ms < session.now_ms {
                self.entries.clear();
                return Err(LinkState::Stale);
            }
            if !online && latest.now_ms >= entry.offline_until {
                return Err(LinkState::Unavailable);
            }
            if let LinkOutcome::Available {
                metadata: LinkMetadata::Private { display, .. },
                ..
            } = &mut outcome
            {
                if !access.icon || !current.icon {
                    display.icon_asset = None;
                }
                if !access.preview || !current.preview {
                    display.description = None;
                    display.image_asset = None;
                }
            }
            // Rebind only the validated cache projection to this initiating
            // request. Endpoint responses themselves remain request-bound.
            LinkResult {
                request: request.clone(),
                outcome: outcome.clone(),
            }
            .validate(request, latest.now_ms, latest.canceled)?;
            self.last_now = latest.now_ms;
            return Ok(outcome);
        }
        if !online || !allow_fetch {
            return Err(LinkState::Unavailable);
        }
        let mut outcome = self.resolver.resolve(request);
        let (latest, current) = self.resolver.check(request, false)?;
        if latest.now_ms < session.now_ms {
            self.entries.clear();
            return Err(LinkState::Stale);
        }
        self.last_now = latest.now_ms;
        if let LinkOutcome::Available {
            metadata: LinkMetadata::Private { display, .. },
            ..
        } = &mut outcome
        {
            if !access.icon || !current.icon {
                display.icon_asset = None;
            }
            if !access.preview || !current.preview {
                display.description = None;
                display.image_asset = None;
            }
        }
        LinkResult {
            request: request.clone(),
            outcome: outcome.clone(),
        }
        .validate(request, latest.now_ms, latest.canceled)?;
        if matches!(outcome, LinkOutcome::Available { .. }) {
            while self.entries.len() >= self.policy.entries {
                self.entries.pop_front();
            }
            self.entries.push_back(Entry {
                request: request.clone(),
                outcome: outcome.clone(),
                offline_until: latest
                    .now_ms
                    .saturating_add(self.policy.offline_lease_ms)
                    .min(MAX_SAFE_INTEGER),
            });
        }
        Ok(outcome)
    }
    /// Requires an existing validated entry; publication never starts a fetch.
    /// Only the title is deliberately shared. Icons/previews remain per-viewer.
    pub fn prepare_disclosure<D: PrivateDisclosureHost>(
        &mut self,
        request: &LinkRequest,
        scope: DisclosureScope,
        host: &mut D,
    ) -> Result<PrivateDisclosure, LinkState> {
        if !scope.valid() || scope.document != request.host.scope.document {
            return Err(LinkState::Forbidden);
        }
        let outcome = self.lookup(request, false, true)?;
        let LinkOutcome::Available {
            metadata: LinkMetadata::Private { display, .. },
            ..
        } = outcome
        else {
            return Err(LinkState::Unavailable);
        };
        if !host.authorize_disclosure(request, &scope, &display.title) {
            return Err(LinkState::Forbidden);
        }
        // The disclosure host may cross a boundary: revalidate after its decision.
        let checked = self.lookup(request, false, true)?;
        if !matches!(checked, LinkOutcome::Available { metadata: LinkMetadata::Private { display: current, .. }, .. } if current.title == display.title)
        {
            return Err(LinkState::Stale);
        }
        Ok(PrivateDisclosure {
            scope,
            action: LinkAction::CommitMetadata {
                request: Box::new(request.clone()),
                shared_label: display.title,
            },
        })
    }
}
impl<H: PrivateEndpoint> PrivateCatalogPort for CachedPrivateResolver<'_, H> {
    fn resolve(&mut self, request: &LinkRequest) -> LinkOutcome {
        self.lookup(request, true, false)
            .unwrap_or_else(|state| match state {
                LinkState::Forbidden => LinkOutcome::Forbidden,
                LinkState::Locked => LinkOutcome::Locked,
                LinkState::Unsupported => LinkOutcome::Unsupported,
                LinkState::Canceled => LinkOutcome::Canceled,
                LinkState::Stale => LinkOutcome::Stale,
                _ => LinkOutcome::Unavailable,
            })
    }
}
