//! Portable resolver ports. Admission is pure; a ready action is not URL/egress
//! approval, a document capability, or permission to publish metadata.
//! Hosts compose these records with ServiceLifecycle and the existing Catalog.
pub mod public_url;

use crate::{
    locator::{Authority, Locator, ResolutionState},
    service_lifecycle::ServiceScope,
};

pub const MAX_LOCATOR: usize = 8192;
pub const MAX_TEXT: usize = 512;
pub const MAX_DESCRIPTION: usize = 2048;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn bounded(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= limit
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnrichmentPolicy {
    Disabled,
    LocalPaste,
    ExplicitRefresh,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkOrigin {
    LocalPaste,
    LocalInsert,
    ExplicitRefresh,
    Open,
    Render,
    Remote,
    Replay,
    History,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkState {
    Available,
    Unavailable,
    Forbidden,
    Missing,
    Locked,
    Unsupported,
    Canceled,
    Stale,
}
impl LinkState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Forbidden => "forbidden",
            Self::Missing => "missing",
            Self::Locked => "locked",
            Self::Unsupported => "unsupported",
            Self::Canceled => "canceled",
            Self::Stale => "stale",
        }
    }
}

/// Supplied by the host, never recovered from URI text or fetched metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkCapabilities {
    pub public_metadata: bool,
    pub private_lookup: bool,
    pub title: bool,
    pub icon: bool,
    pub preview: bool,
    pub activate: bool,
    pub publish_metadata: bool,
}
#[derive(Clone, PartialEq, Eq)]
pub struct LinkHostContext {
    pub principal: String,
    pub tenant: String,
    pub authority: Option<Authority>,
    pub scope: ServiceScope,
    pub policy_revision: String,
    pub capabilities: LinkCapabilities,
    pub readonly: bool,
}
#[derive(Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// Bounded candidate only. Public URL/connection admission is a separate port.
    PublicUrl(String),
    /// Parse configured app links with Catalog::parse before constructing this.
    Private(Locator),
}
#[derive(Clone, PartialEq, Eq)]
pub struct LinkRequest {
    pub request_id: String,
    pub cancellation_token: String,
    pub node: String,
    pub epoch: String,
    pub label_revision: String,
    pub host: LinkHostContext,
    pub target: LinkTarget,
    pub policy: EnrichmentPolicy,
    pub origin: LinkOrigin,
}
impl std::fmt::Debug for LinkRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LinkRequest([redacted])")
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookupAction {
    PublicMetadata,
    PrivateCatalog,
}

/// Native/TUI/browser hosts consume these actions; none executes IO, a shell,
/// document mutation or activation. Activation must recheck the current host.
pub enum LinkAction {
    Lookup {
        request: Box<LinkRequest>,
        port: LookupAction,
    },
    Activate {
        request: Box<LinkRequest>,
    },
    CopyLocator {
        target: LinkTarget,
    },
    CommitMetadata {
        request: Box<LinkRequest>,
        shared_label: String,
    },
}

impl LinkTarget {
    fn valid(&self) -> bool {
        match self {
            Self::PublicUrl(url) => bounded(url, MAX_LOCATOR),
            Self::Private(locator) => bounded(&locator.to_string(), MAX_LOCATOR),
        }
    }
}
impl LinkAction {
    /// Shape/size admission only; never execution or URL/credential approval.
    pub fn valid(&self) -> bool {
        match self {
            Self::Lookup { request, port } => {
                request.valid()
                    && matches!(
                        (&request.target, port),
                        (LinkTarget::PublicUrl(_), LookupAction::PublicMetadata)
                            | (LinkTarget::Private(_), LookupAction::PrivateCatalog)
                    )
            }
            Self::Activate { request } => request.valid(),
            Self::CopyLocator { target } => target.valid(),
            Self::CommitMetadata {
                request,
                shared_label,
            } => request.valid() && bounded(shared_label, MAX_TEXT),
        }
    }
}

impl LinkHostContext {
    fn valid(&self) -> bool {
        self.scope.valid()
            && [&self.principal, &self.tenant, &self.policy_revision]
                .iter()
                .all(|s| bounded(s, MAX_TEXT))
    }
}
impl LinkRequest {
    pub fn valid(&self) -> bool {
        self.host.valid()
            && [
                &self.request_id,
                &self.cancellation_token,
                &self.node,
                &self.epoch,
                &self.label_revision,
            ]
            .iter()
            .all(|s| bounded(s, MAX_TEXT))
            && self.target.valid()
    }
    /// Captured node/URL/label identity is also compared on response delivery.
    pub fn admit(
        &self,
        current: &LinkHostContext,
        canceled: bool,
    ) -> Result<LookupAction, LinkState> {
        if !self.valid() || !current.valid() {
            return Err(LinkState::Unsupported);
        }
        if canceled {
            return Err(LinkState::Canceled);
        }
        if self.host.principal != current.principal
            || self.host.tenant != current.tenant
            || self.host.authority != current.authority
            || !self.host.scope.authorized
            || !current.scope.authorized
            || self.host.scope.permission != current.scope.permission
            || self.host.capabilities != current.capabilities
        {
            return Err(LinkState::Forbidden);
        }
        if self.host.scope.failure(&current.scope).is_some()
            || self.host.policy_revision != current.policy_revision
        {
            return Err(LinkState::Stale);
        }
        let enabled = match self.origin {
            LinkOrigin::LocalPaste | LinkOrigin::LocalInsert => {
                self.policy == EnrichmentPolicy::LocalPaste
            }
            LinkOrigin::ExplicitRefresh => self.policy != EnrichmentPolicy::Disabled,
            _ => false,
        };
        if !enabled {
            return Err(LinkState::Unavailable);
        }
        match &self.target {
            LinkTarget::PublicUrl(_) if current.capabilities.public_metadata => {
                Ok(LookupAction::PublicMetadata)
            }
            LinkTarget::Private(locator)
                if current.capabilities.private_lookup
                    && locator.authority() == current.authority.as_ref() =>
            {
                Ok(LookupAction::PrivateCatalog)
            }
            _ => Err(LinkState::Forbidden),
        }
    }

    /// Only validates host intent. Safe URL/deep-link execution remains a host obligation.
    pub fn intent_permission(&self, current: &LinkHostContext, publish: bool) -> LinkState {
        if !self.valid() || !current.valid() {
            return LinkState::Unsupported;
        }
        if self.host.principal != current.principal
            || self.host.tenant != current.tenant
            || self.host.authority != current.authority
            || !self.host.scope.authorized
            || !current.scope.authorized
            || self.host.scope.permission != current.scope.permission
            || self.host.capabilities != current.capabilities
        {
            return LinkState::Forbidden;
        }
        if self.host.scope.failure(&current.scope).is_some()
            || self.host.policy_revision != current.policy_revision
        {
            return LinkState::Stale;
        }
        if matches!(&self.target, LinkTarget::Private(locator) if locator.authority() != current.authority.as_ref())
        {
            return LinkState::Forbidden;
        }
        if if publish {
            !current.readonly && current.capabilities.publish_metadata
        } else {
            current.capabilities.activate
        } {
            LinkState::Available
        } else {
            LinkState::Forbidden
        }
    }
}

/// A projection of the existing catalog outcome, never an alternate catalog.
/// Missing and denied are deliberately indistinguishable at this adapter.
pub fn catalog_state(state: ResolutionState) -> LinkState {
    match state {
        ResolutionState::Local | ResolutionState::Cached | ResolutionState::Hosted => {
            LinkState::Available
        }
        ResolutionState::Locked => LinkState::Locked,
        ResolutionState::Incompatible => LinkState::Unsupported,
        ResolutionState::Unavailable | ResolutionState::Unauthorized => LinkState::Unavailable,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkFreshness {
    pub fetched_at: u64,
    pub expires_at: u64,
    pub policy_revision: String,
}
pub struct LinkDisplay {
    pub title: String,
    pub description: Option<String>,
    /// Opaque host-managed asset handles, never a browser-fetchable URL.
    pub icon_asset: Option<String>,
    pub image_asset: Option<String>,
}
impl LinkDisplay {
    fn valid(&self) -> bool {
        bounded(&self.title, MAX_TEXT)
            && self
                .description
                .as_ref()
                .is_none_or(|s| bounded(s, MAX_DESCRIPTION))
            && [&self.icon_asset, &self.image_asset].iter().all(|s| {
                s.as_ref().is_none_or(|s| {
                    bounded(s, MAX_TEXT)
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
                })
            })
    }
}
pub enum LinkMetadata {
    Public {
        display: LinkDisplay,
        provider: String,
        requested_url: String,
        canonical_url: Option<String>,
    },
    /// Per-viewer only. Not a CRDT node/attribute or implicit shared label.
    Private {
        display: LinkDisplay,
        target: Locator,
    },
}
pub enum LinkOutcome {
    Available {
        metadata: LinkMetadata,
        freshness: LinkFreshness,
    },
    Unavailable,
    Forbidden,
    Missing,
    Locked,
    Unsupported,
    Canceled,
    Stale,
}
impl LinkOutcome {
    pub fn state(&self) -> LinkState {
        match self {
            Self::Available { .. } => LinkState::Available,
            Self::Unavailable => LinkState::Unavailable,
            Self::Forbidden => LinkState::Forbidden,
            Self::Missing => LinkState::Missing,
            Self::Locked => LinkState::Locked,
            Self::Unsupported => LinkState::Unsupported,
            Self::Canceled => LinkState::Canceled,
            Self::Stale => LinkState::Stale,
        }
    }
}
pub struct LinkResult {
    pub request: LinkRequest,
    pub outcome: LinkOutcome,
}
impl LinkResult {
    /// Validate delivery against the current captured target, not a page's canonical URL.
    pub fn validate(
        &self,
        current: &LinkRequest,
        now: u64,
        canceled: bool,
    ) -> Result<LinkState, LinkState> {
        if !current.valid() {
            return Err(LinkState::Unsupported);
        }
        self.request.admit(&current.host, canceled)?;
        if self.request != *current {
            return Err(LinkState::Stale);
        }
        if let LinkOutcome::Available {
            metadata,
            freshness,
        } = &self.outcome
        {
            if now > MAX_SAFE_INTEGER
                || freshness.expires_at > MAX_SAFE_INTEGER
                || freshness.fetched_at > now
                || freshness.expires_at <= now
                || freshness.policy_revision != current.host.policy_revision
            {
                return Err(LinkState::Stale);
            }
            let display = match (metadata, &current.target) {
                (
                    LinkMetadata::Public {
                        display,
                        provider,
                        requested_url,
                        canonical_url,
                    },
                    LinkTarget::PublicUrl(url),
                ) if requested_url == url
                    && bounded(provider, MAX_TEXT)
                    && canonical_url
                        .as_ref()
                        .is_none_or(|u| bounded(u, MAX_LOCATOR)) =>
                {
                    display
                }
                (LinkMetadata::Private { display, target }, LinkTarget::Private(locator))
                    if target == locator =>
                {
                    display
                }
                _ => return Err(LinkState::Unsupported),
            };
            if !display.valid() {
                return Err(LinkState::Unsupported);
            }
            if matches!(metadata, LinkMetadata::Private { .. }) {
                let cap = &current.host.capabilities;
                if !cap.title
                    || (display.icon_asset.is_some() && !cap.icon)
                    || ((display.description.is_some() || display.image_asset.is_some())
                        && !cap.preview)
                {
                    return Err(LinkState::Forbidden);
                }
            }
        }
        Ok(self.outcome.state())
    }
}

/// Implemented by a host/backend, called only outside engine transactions.
/// Public hosts MUST perform URL and actual-connection egress admission. Private
/// hosts MUST consult current configured Catalog/endpoint permission; never use
/// the public transport as a privileged private-site fallback.
pub trait PublicMetadataPort {
    fn resolve(&mut self, request: &LinkRequest) -> LinkOutcome;
}
pub trait PrivateCatalogPort {
    fn resolve(&mut self, request: &LinkRequest) -> LinkOutcome;
}
