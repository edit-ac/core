//! Current-principal adapter over the owning Catalog. No public transport, cache,
//! credentials, document mutation or OS activation belongs to this adapter.
use super::*;
use crate::locator::{Catalog, Connectivity};

/// Target-specific permissions, intersected with the host's overall capabilities.
/// A containing-document read permission is never a target grant.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct TargetAccess {
    pub lookup: bool,
    pub title: bool,
    pub icon: bool,
    pub preview: bool,
    pub activate: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivateFailure {
    /// Missing and unauthorized intentionally share one non-disclosing result.
    Hidden,
    Locked,
    Unavailable,
    Unsupported,
}
impl PrivateFailure {
    fn state(self) -> LinkState {
        match self {
            Self::Hidden | Self::Unavailable => LinkState::Unavailable,
            Self::Locked => LinkState::Locked,
            Self::Unsupported => LinkState::Unsupported,
        }
    }
}

pub struct PrivateSession {
    pub context: LinkHostContext,
    pub canceled: bool,
    pub now_ms: u64,
}

/// Trusted host adapter. Credentials stay inside its implementation. Every
/// authorize call checks the exact principal/tenant/authority/target and current
/// endpoint permissions (including key lock/plaintext availability). The endpoint
/// must bound response allocation and honor request cancellation/deadlines.
/// `metadata` reads only requested fields and never follows arbitrary URLs.
/// Session and permission snapshots must be serialized with host auth changes;
/// delayed consumers must use LinkResult::validate and reauthorize activation.
pub trait PrivateEndpoint {
    fn session(&mut self, request: &LinkRequest) -> PrivateSession;
    fn authorize(
        &mut self,
        context: &LinkHostContext,
        target: &Locator,
    ) -> Result<TargetAccess, PrivateFailure>;
    fn metadata(
        &mut self,
        request: &LinkRequest,
        fields: TargetAccess,
    ) -> Result<LinkResult, PrivateFailure>;
}

pub struct PrivateResolver<'a, H> {
    catalog: &'a Catalog,
    endpoint: H,
    connectivity: Connectivity,
}
impl<'a, H: PrivateEndpoint> PrivateResolver<'a, H> {
    pub fn new(catalog: &'a Catalog, endpoint: H, connectivity: Connectivity) -> Self {
        Self {
            catalog,
            endpoint,
            connectivity,
        }
    }
    pub fn into_endpoint(self) -> H {
        self.endpoint
    }

    fn check(
        &mut self,
        request: &LinkRequest,
        activation: bool,
    ) -> Result<(PrivateSession, TargetAccess), LinkState> {
        let session = self.endpoint.session(request);
        if session.now_ms > MAX_SAFE_INTEGER {
            return Err(LinkState::Unsupported);
        }
        if activation {
            if session.canceled {
                return Err(LinkState::Canceled);
            }
            let state = request.intent_permission(&session.context, false);
            if state != LinkState::Available {
                return Err(state);
            }
        } else if request.admit(&session.context, session.canceled)? != LookupAction::PrivateCatalog
        {
            return Err(LinkState::Unsupported);
        }
        let LinkTarget::Private(target) = &request.target else {
            return Err(LinkState::Unsupported);
        };
        // Reuse configured authority admission, including local ac:// targets.
        if self.catalog.parse(&target.to_string()).as_ref() != Ok(target) {
            return Err(LinkState::Unavailable);
        }
        // Authorization precedes even catalog state disclosure.
        let mut access = self
            .endpoint
            .authorize(&session.context, target)
            .map_err(PrivateFailure::state)?;
        let cap = &session.context.capabilities;
        access.lookup &= cap.private_lookup;
        access.title &= cap.title;
        access.icon &= cap.icon;
        access.preview &= cap.preview;
        access.activate &= cap.activate;
        if !access.lookup
            || if activation {
                !access.activate
            } else {
                !access.title
            }
        {
            return Err(LinkState::Unavailable);
        }
        let resolution = self
            .catalog
            .resolve(target, self.connectivity)
            .map_err(|_| LinkState::Unavailable)?;
        let state = catalog_state(resolution.state);
        if state != LinkState::Available {
            return Err(state);
        }
        // Permission checks can themselves cross an endpoint boundary.
        let latest = self.endpoint.session(request);
        if latest.now_ms > MAX_SAFE_INTEGER {
            return Err(LinkState::Unsupported);
        }
        if activation {
            if latest.canceled {
                return Err(LinkState::Canceled);
            }
            let state = request.intent_permission(&latest.context, false);
            if state != LinkState::Available {
                return Err(state);
            }
        } else {
            request.admit(&latest.context, latest.canceled)?;
        }
        Ok((latest, access))
    }

    fn lookup(&mut self, request: &LinkRequest) -> Result<LinkOutcome, LinkState> {
        let (_, access) = self.check(request, false)?;
        let mut result = self
            .endpoint
            .metadata(request, access)
            .map_err(PrivateFailure::state)?;
        // Revalidate principal, policy, cancellation, endpoint lock and target
        // grants after IO. A response is never itself an authorization grant.
        let (session, current) = self.check(request, false)?;
        // Validate the endpoint's captured request, target, policy, freshness and
        // record family before accepting any fields. Never stamp current identity
        // onto an unscoped response or relabel a response from another target.
        if let LinkOutcome::Available { metadata, .. } = &mut result.outcome {
            let LinkMetadata::Private { display, .. } = metadata else {
                return Err(LinkState::Unsupported);
            };
            if !access.icon || !current.icon {
                display.icon_asset = None;
            }
            if !access.preview || !current.preview {
                display.description = None;
                display.image_asset = None;
            }
        }
        result.validate(request, session.now_ms, session.canceled)?;
        Ok(match result.outcome {
            LinkOutcome::Missing | LinkOutcome::Forbidden => LinkOutcome::Unavailable,
            outcome => outcome,
        })
    }

    /// Prepared action only; executing hosts recheck at the actual navigation
    /// boundary. Readonly navigation does not acquire document write permission.
    pub fn activation(&mut self, request: &LinkRequest) -> Result<LinkAction, LinkState> {
        self.check(request, true)?;
        // authorize may cross a host boundary; discard a changed session/grant.
        self.check(request, true)?;
        Ok(LinkAction::Activate {
            request: Box::new(request.clone()),
        })
    }
}
impl<H: PrivateEndpoint> PrivateCatalogPort for PrivateResolver<'_, H> {
    fn resolve(&mut self, request: &LinkRequest) -> LinkOutcome {
        self.lookup(request).unwrap_or_else(|state| match state {
            LinkState::Forbidden => LinkOutcome::Forbidden,
            LinkState::Locked => LinkOutcome::Locked,
            LinkState::Unsupported => LinkOutcome::Unsupported,
            LinkState::Canceled => LinkOutcome::Canceled,
            LinkState::Stale => LinkOutcome::Stale,
            _ => LinkOutcome::Unavailable,
        })
    }
}
