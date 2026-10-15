//! SEC-1.9 prepared plaintext router; absent from default/production builds.
//! Routing never acquires, unlocks, copies or delegates keys. The host explicitly
//! selects an existing decrypting client and supplies current per-action authority.
//! Opaque relay requests have no plaintext implementation or fallback endpoint.
use crate::{
    assets::{ExportHost, ExportPolicy, ExportReceipt, ProtectedAssets},
    keys::HostKeyProvider,
    store::BlobHost,
    sync::{EncryptedClient, OpaqueRelay, Scope},
};
use editac_core::{
    commands::{editor::EditorCommand, text::TextOrigin},
    document::DocumentIdentity,
};
use editac_diff::{
    representation::*,
    semantic::{self, SemanticDiff, SemanticLimits},
};
use editac_session::{
    edit_service::{EditService, PreparedEdit, ReadSnapshot},
    operations::HostOperation,
    ports::LocalCommit,
    revision::ObservedRevision,
    session::{PermissionState, Readiness, SessionStore},
};
use openmls_traits::OpenMlsProvider;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Decrypt,
    Export,
    Diff,
    Edit,
    Mcp,
    Search,
    Preview,
}
impl Action {
    pub(crate) const ALL: [Self; 7] = [
        Self::Decrypt,
        Self::Export,
        Self::Diff,
        Self::Edit,
        Self::Mcp,
        Self::Search,
        Self::Preview,
    ];
}
/// Host server credentials/tool names alone are not decryption authority. This
/// trusted host policy is checked against the exact route on every operation.
/// It must include caller identity, read access/expiry and requested disclosure.
/// It receives neither keys nor content; querying it never grants either.
pub(crate) trait PlaintextHost {
    fn allows(&self, scope: &Scope, identity: &DocumentIdentity, action: Action) -> bool;
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Capabilities {
    pub decrypt: bool,
    pub export: bool,
    pub diff: bool,
    pub edit: bool,
    pub mcp: bool,
    pub search: bool,
    pub preview: bool,
}
impl Capabilities {
    pub(crate) fn permits(self, action: Action) -> bool {
        match action {
            Action::Decrypt => self.decrypt,
            Action::Export => self.export,
            Action::Diff => self.diff,
            Action::Edit => self.edit,
            Action::Mcp => self.mcp,
            Action::Search => self.search,
            Action::Preview => self.preview,
        }
    }
}
/// Fixed safe errors deliberately omit content, host diagnostics and key material.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilityError {
    Incompatible,
    Opaque,
    Unavailable,
    Denied,
    InvalidAction,
    ResourceLimit,
    Service,
    Representation,
    Asset,
}

pub(crate) enum Endpoint<'a, S: SessionStore, P: OpenMlsProvider> {
    Opaque {
        scope: &'a Scope,
    },
    Local {
        client: &'a mut EncryptedClient<P>,
        service: &'a mut EditService<S>,
    },
}
impl<'a, S: SessionStore, P: OpenMlsProvider> Endpoint<'a, S, P> {
    pub(crate) fn opaque<H: BlobHost>(relay: &'a OpaqueRelay<H>) -> Self {
        Self::Opaque {
            scope: relay.scope(),
        }
    }
    pub(crate) fn local(
        client: &'a mut EncryptedClient<P>,
        service: &'a mut EditService<S>,
    ) -> Self {
        Self::Local { client, service }
    }
    fn scope(&self) -> &Scope {
        match self {
            Self::Opaque { scope } => scope,
            Self::Local { client, .. } => client.scope(),
        }
    }
    fn route(&self, requested: &Scope) -> Result<(), CapabilityError> {
        if requested != self.scope() {
            return Err(CapabilityError::Incompatible);
        }
        Ok(())
    }
    fn admit(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        action: Action,
        now: u64,
    ) -> Result<(), CapabilityError> {
        self.route(scope)?;
        let Self::Local { client, service } = self else {
            return Err(CapabilityError::Opaque);
        };
        let identity = service.session().document().identity();
        let state = service.session().state(now);
        if !client.plaintext_available(identity) || state.readiness != Readiness::Ready {
            return Err(CapabilityError::Unavailable);
        }
        if state.permission == PermissionState::Expired || !host.allows(scope, identity, action) {
            return Err(CapabilityError::Denied);
        }
        if action == Action::Edit
            && (!client.edit_available() || !service.capabilities(now).can_apply)
        {
            return Err(CapabilityError::Denied);
        }
        Ok(())
    }
    /// Metadata only, with no provider calls, plaintext read or export grant.
    /// These are advisory; every actual operation rechecks live authorization.
    pub(crate) fn capabilities(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        now: u64,
    ) -> Result<Capabilities, CapabilityError> {
        self.route(scope)?;
        let allowed = |a| self.admit(scope, host, a, now).is_ok();
        Ok(Capabilities {
            decrypt: allowed(Action::Decrypt),
            export: allowed(Action::Export),
            diff: allowed(Action::Diff),
            edit: allowed(Action::Edit),
            mcp: allowed(Action::Mcp),
            search: allowed(Action::Search),
            preview: allowed(Action::Preview),
        })
    }
    /// MCP means a read tool here; MCP writes must use prepare/apply below.
    pub(crate) fn read(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        action: Action,
        now: u64,
    ) -> Result<ReadSnapshot, CapabilityError> {
        self.admit(scope, host, action, now)?;
        if !matches!(action, Action::Decrypt | Action::Mcp | Action::Preview) {
            return Err(CapabilityError::InvalidAction);
        }
        let Self::Local { service, .. } = self else {
            unreachable!()
        };
        let mut read = service.read(now).map_err(|_| CapabilityError::Service)?;
        // The Session's host cache alone cannot advertise encrypted write
        // authority. Read responses must expose the same live intersection as
        // discovery/prepare/apply, including a decrypting MLS reader's limits.
        let edit = self.admit(scope, host, Action::Edit, now).is_ok();
        read.capabilities.can_prepare &= edit;
        read.capabilities.can_apply &= edit;
        read.capabilities.can_history &= edit;
        read.capabilities.policy.writable &= edit;
        Ok(read)
    }
    /// Bounded local-only search; the relay receives neither query nor content.
    pub(crate) fn search(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        query: &str,
        now: u64,
    ) -> Result<Vec<String>, CapabilityError> {
        self.admit(scope, host, Action::Search, now)?;
        if query.is_empty() || query.len() > 256 {
            return Err(CapabilityError::ResourceLimit);
        }
        let Self::Local { service, .. } = self else {
            unreachable!()
        };
        let read = service.read(now).map_err(|_| CapabilityError::Service)?;
        let mut found = Vec::new();
        for node in &read.snapshot.visible {
            let text: String = node.runs.iter().map(|r| r.text.as_str()).collect();
            if text.contains(query) {
                if found.len() == 64 {
                    return Err(CapabilityError::ResourceLimit);
                }
                found.push(node.id.clone());
            }
        }
        Ok(found)
    }
    pub(crate) fn capture(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        now: u64,
    ) -> Result<ImmutableRevision, CapabilityError> {
        self.admit(scope, host, Action::Diff, now)?;
        let Self::Local { service, .. } = self else {
            unreachable!()
        };
        let read = service.read(now).map_err(|_| CapabilityError::Service)?;
        let id = service.session().document().identity();
        semantic::capture_projection(
            RevisionScope {
                document: id.document_id.clone(),
                epoch: id.epoch.clone(),
                schema: id.schema.clone(),
                module_profile: id.profile.clone(),
                observed_token: read.revision.to_bytes(),
            },
            &read.snapshot,
            RepresentationLimits::default(),
        )
        .map_err(|_| CapabilityError::Representation)
    }
    pub(crate) fn diff(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        before: &ImmutableRevision,
        now: u64,
    ) -> Result<SemanticDiff, CapabilityError> {
        let after = self.capture(scope, host, now)?;
        semantic::compare(before, &after, SemanticLimits::default())
            .map_err(|_| CapabilityError::Representation)
    }
    pub(crate) fn prepare(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        expected: &ObservedRevision,
        commands: &[EditorCommand],
        origin: &TextOrigin,
        now: u64,
    ) -> Result<PreparedEdit, CapabilityError> {
        self.admit(scope, host, Action::Edit, now)?;
        let Self::Local { service, .. } = self else {
            unreachable!()
        };
        service
            .prepare_commands(expected, commands, origin, now)
            .map_err(|_| CapabilityError::Service)
    }
    pub(crate) fn apply(
        &mut self,
        scope: &Scope,
        host: &impl PlaintextHost,
        plan: PreparedEdit,
        operation: HostOperation,
        now: u64,
    ) -> Result<Option<LocalCommit>, CapabilityError> {
        self.admit(scope, host, Action::Edit, now)?;
        let Self::Local { service, .. } = self else {
            unreachable!()
        };
        service
            .apply_as(plan, operation, now)
            .map_err(|_| CapabilityError::Service)
    }
    /// The SEC-1.8 exporter still requires a fresh exact destination authorization
    /// and labels plaintext. Capability discovery cannot replace that decision.
    pub(crate) fn export<H: BlobHost, K: HostKeyProvider>(
        &self,
        scope: &Scope,
        host: &impl PlaintextHost,
        assets: &mut ProtectedAssets<H, K>,
        policy: ExportPolicy,
        destination: &str,
        sink: &mut impl ExportHost,
        now: u64,
    ) -> Result<ExportReceipt, CapabilityError> {
        self.admit(scope, host, Action::Export, now)?;
        let Self::Local { service, .. } = self else {
            unreachable!()
        };
        if !assets.belongs_to(service.session().document().identity(), &scope.context()) {
            return Err(CapabilityError::Incompatible);
        }
        assets
            .export(policy, destination, sink)
            .map_err(|_| CapabilityError::Asset)
    }
    /// Host lock/logout/revoke disables future routing, without claiming to erase
    /// plaintext previously copied by authorized callers. Rejoin is separate.
    pub(crate) fn retire(&mut self) {
        if let Self::Local { client, .. } = self {
            client.retire_after_restore();
        }
    }
}
