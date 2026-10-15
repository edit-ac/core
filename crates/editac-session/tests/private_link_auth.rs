//! LNK-1.7 canonical integration: owning Catalog + current host target grants +
//! PrivateCatalogPort + actual engine snapshot. Prepared endpoint only; no sockets.
mod support;
use editac_core::document::DocumentIdentity;
use editac_session::{
    links::{private_resolver::*, *},
    locator::*,
    service_lifecycle::ServiceScope,
};
use std::{cell::RefCell, rc::Rc};

const ID: &str = "12345678-1234-4234-8234-123456789abc";
const TARGET: &str = "ac://team/12345678-1234-4234-8234-123456789abc";
const SECRET: &str = "Private title SECRET";
fn request() -> LinkRequest {
    LinkRequest {
        request_id: "request-1".into(),
        cancellation_token: "cancel-1".into(),
        node: "node-1".into(),
        epoch: "epoch-1".into(),
        label_revision: "label-1".into(),
        host: LinkHostContext {
            principal: "alice".into(),
            tenant: "tenant-1".into(),
            authority: Some(Authority::parse("team").unwrap()),
            scope: ServiceScope {
                document: "containing-doc".into(),
                session: "session-1".into(),
                revision: "rev-1".into(),
                permission: "perm-1".into(),
                authorized: true,
            },
            policy_revision: "policy-1".into(),
            readonly: false,
            capabilities: LinkCapabilities {
                public_metadata: true,
                private_lookup: true,
                title: true,
                icon: true,
                preview: true,
                activate: true,
                publish_metadata: true,
            },
        },
        target: LinkTarget::Private(Locator::parse(TARGET).unwrap()),
        policy: EnrichmentPolicy::ExplicitRefresh,
        origin: LinkOrigin::ExplicitRefresh,
    }
}
fn catalog(access: AccessState, source: SourceBinding, present: bool) -> Catalog {
    let mut c = Catalog::default();
    c.configure_authority("team").unwrap();
    c.configure_authority("other").unwrap();
    c.configure_app_host("app.example.test", "team").unwrap();
    if present {
        c.insert(
            c.parse(TARGET).unwrap(),
            CatalogEntry {
                identity: DocumentIdentity::v5(ID, "23456789-2345-4345-8345-23456789abcd").unwrap(),
                source,
                access,
            },
        )
        .unwrap();
    }
    c
}
#[derive(Clone, Copy, Default)]
enum Change {
    #[default]
    None,
    Principal,
    Tenant,
    Policy,
    Permission,
    Session,
    Revision,
    Cancel,
    Revoke,
    Lock,
    Fields,
    Title,
}
struct State {
    response_fault: u8,
    grant_target: String,
    context: LinkHostContext,
    canceled: bool,
    access: TargetAccess,
    auth_calls: usize,
    reads: usize,
    fields: Vec<TargetAccess>,
    failure: Option<PrivateFailure>,
    change: Change,
    change_on_auth: bool,
    expires_at: u64,
    fetched_at: u64,
    title: String,
    icon: String,
}
#[derive(Clone)]
struct Endpoint(Rc<RefCell<State>>);
fn endpoint(r: &LinkRequest) -> Endpoint {
    Endpoint(Rc::new(RefCell::new(State {
        response_fault: 0,
        grant_target: TARGET.into(),
        context: r.host.clone(),
        canceled: false,
        access: TargetAccess {
            lookup: true,
            title: true,
            icon: true,
            preview: true,
            activate: true,
        },
        auth_calls: 0,
        reads: 0,
        fields: vec![],
        failure: None,
        change: Change::None,
        change_on_auth: false,
        expires_at: 200,
        fetched_at: 90,
        title: SECRET.into(),
        icon: "private-icon".into(),
    })))
}
fn change(s: &mut State) {
    match s.change {
        Change::None => {}
        Change::Principal => s.context.principal = "bob".into(),
        Change::Tenant => s.context.tenant = "tenant-2".into(),
        Change::Policy => s.context.policy_revision = "policy-2".into(),
        Change::Permission => s.context.scope.permission = "perm-2".into(),
        Change::Session => s.context.scope.session = "session-2".into(),
        Change::Revision => s.context.scope.revision = "rev-2".into(),
        Change::Cancel => s.canceled = true,
        Change::Revoke => s.access.lookup = false,
        Change::Lock => s.failure = Some(PrivateFailure::Locked),
        Change::Fields => {
            s.access.icon = false;
            s.access.preview = false;
        }
        Change::Title => s.access.title = false,
    }
}
impl PrivateEndpoint for Endpoint {
    fn session(&mut self, _: &LinkRequest) -> PrivateSession {
        let s = self.0.borrow();
        PrivateSession {
            context: s.context.clone(),
            canceled: s.canceled,
            now_ms: 100,
        }
    }
    fn authorize(
        &mut self,
        context: &LinkHostContext,
        target: &Locator,
    ) -> Result<TargetAccess, PrivateFailure> {
        let mut s = self.0.borrow_mut();
        s.auth_calls += 1;
        // Fixture grants belong to this exact viewer/tenant/authority/target.
        if context.principal != "alice"
            || context.tenant != "tenant-1"
            || target.to_string() != s.grant_target
        {
            return Err(PrivateFailure::Hidden);
        }
        if let Some(f) = s.failure {
            return Err(f);
        }
        let access = s.access;
        if s.change_on_auth {
            change(&mut s);
        }
        Ok(access)
    }
    fn metadata(
        &mut self,
        request: &LinkRequest,
        fields: TargetAccess,
    ) -> Result<LinkResult, PrivateFailure> {
        let mut s = self.0.borrow_mut();
        s.reads += 1;
        s.fields.push(fields);
        let LinkTarget::Private(target) = &request.target else {
            panic!("private endpoint only")
        };
        let mut record = LinkResult {
            request: request.clone(),
            outcome: LinkOutcome::Available {
                metadata: LinkMetadata::Private {
                    target: target.clone(),
                    display: LinkDisplay {
                        title: s.title.clone(),
                        description: Some("Private preview SECRET".into()),
                        icon_asset: Some(s.icon.clone()),
                        image_asset: Some("private-image".into()),
                    },
                },
                freshness: LinkFreshness {
                    fetched_at: s.fetched_at,
                    expires_at: s.expires_at,
                    policy_revision: request.host.policy_revision.clone(),
                },
            },
        };
        match s.response_fault {
            1 => record.request.host.tenant = "tenant-2".into(),
            2 => record.request.request_id = "other-request".into(),
            3 => {
                if let LinkOutcome::Available {
                    metadata: LinkMetadata::Private { target, .. },
                    ..
                } = &mut record.outcome
                {
                    *target = Locator::parse(&format!("ac://other/{ID}")).unwrap();
                }
            }
            4 => {
                if let LinkOutcome::Available { freshness, .. } = &mut record.outcome {
                    freshness.policy_revision = "old-policy".into();
                }
            }
            5 => record.outcome = LinkOutcome::Missing,
            6 => record.outcome = LinkOutcome::Forbidden,
            7 => {
                if let LinkOutcome::Available { metadata, .. } = &mut record.outcome {
                    *metadata = LinkMetadata::Public {
                        display: LinkDisplay {
                            title: SECRET.into(),
                            description: None,
                            icon_asset: None,
                            image_asset: None,
                        },
                        provider: "private".into(),
                        requested_url: "https://private.test".into(),
                        canonical_url: None,
                    };
                }
            }
            _ => {}
        }
        change(&mut s);
        Ok(record)
    }
}
fn resolve(r: &LinkRequest, h: &Endpoint) -> LinkOutcome {
    let c = catalog(
        AccessState::Allowed,
        SourceBinding::Hosted { cached: false },
        true,
    );
    PrivateResolver::new(&c, h.clone(), Connectivity::Online).resolve(r)
}
fn assert_no_metadata(outcome: LinkOutcome, expected: LinkState, h: &Endpoint, reads: usize) {
    assert_eq!(outcome.state(), expected);
    assert!(!matches!(outcome, LinkOutcome::Available { .. }));
    assert_eq!(h.0.borrow().reads, reads);
}
#[test]
fn authorized_viewer_uses_catalog_app_mapping_and_scoped_private_record() {
    let c = catalog(
        AccessState::Allowed,
        SourceBinding::Hosted { cached: false },
        true,
    );
    let mut r = request();
    r.target = LinkTarget::Private(
        c.parse(&format!("https://app.example.test/ac/{ID}"))
            .unwrap(),
    );
    let h = endpoint(&r);
    let result = PrivateResolver::new(&c, h.clone(), Connectivity::Online).resolve(&r);
    let LinkOutcome::Available {
        metadata: LinkMetadata::Private { display, target },
        freshness,
    } = result
    else {
        panic!("private record required")
    };
    assert_eq!(display.title, SECRET);
    assert_eq!(display.icon_asset.as_deref(), Some("private-icon"));
    assert_eq!(target.to_string(), TARGET);
    assert_eq!(freshness.policy_revision, "policy-1");
    assert_eq!(h.0.borrow().auth_calls, 2);
    assert_eq!(h.0.borrow().reads, 1);
}
macro_rules! preflight {
    ($name:ident, $state:expr, $r:ident, $h:ident, $body:block) => {
        #[test] fn $name() { let mut $r = request(); let $h = endpoint(&$r); $body
            assert_no_metadata(resolve(&$r, &$h), $state, &$h, 0);
        }
    }
}
preflight!(
    document_reader_without_target_lookup_is_hidden,
    LinkState::Unavailable,
    r,
    h,
    {
        h.0.borrow_mut().access.lookup = false;
        r.host.scope.authorized = true;
    }
);
preflight!(
    different_principal_cannot_use_containing_document_access,
    LinkState::Unavailable,
    r,
    h,
    {
        r.host.principal = "bob".into();
        h.0.borrow_mut().context = r.host.clone();
    }
);
preflight!(
    different_tenant_cannot_use_same_id,
    LinkState::Unavailable,
    r,
    h,
    {
        r.host.tenant = "tenant-2".into();
        h.0.borrow_mut().context = r.host.clone();
    }
);
preflight!(
    different_authority_same_id_has_no_grant,
    LinkState::Unavailable,
    r,
    h,
    {
        r.target = LinkTarget::Private(Locator::parse(&format!("ac://other/{ID}")).unwrap());
        r.host.authority = Some(Authority::parse("other").unwrap());
        h.0.borrow_mut().context = r.host.clone();
    }
);
preflight!(
    unconfigured_authority_is_denied_before_endpoint,
    LinkState::Unavailable,
    r,
    h,
    {
        r.target = LinkTarget::Private(Locator::parse(&format!("ac://unknown/{ID}")).unwrap());
        r.host.authority = Some(Authority::parse("unknown").unwrap());
        h.0.borrow_mut().context = r.host.clone();
    }
);
preflight!(
    host_target_authority_mismatch_is_forbidden,
    LinkState::Forbidden,
    r,
    h,
    {
        r.host.authority = None;
        h.0.borrow_mut().context = r.host.clone();
    }
);
preflight!(
    locked_plaintext_endpoint_is_explicit,
    LinkState::Locked,
    r,
    h,
    {
        r.node = "node-2".into();
        h.0.borrow_mut().failure = Some(PrivateFailure::Locked);
    }
);
preflight!(
    opaque_relay_cannot_resolve_plaintext,
    LinkState::Unsupported,
    r,
    h,
    {
        r.node = "node-2".into();
        h.0.borrow_mut().failure = Some(PrivateFailure::Unsupported);
    }
);
preflight!(
    missing_and_forbidden_endpoint_are_non_disclosing,
    LinkState::Unavailable,
    r,
    h,
    {
        r.node = "node-2".into();
        h.0.borrow_mut().failure = Some(PrivateFailure::Hidden);
    }
);
preflight!(
    stale_permission_never_reads_metadata,
    LinkState::Forbidden,
    r,
    h,
    {
        r.node = "node-2".into();
        h.0.borrow_mut().context.scope.permission = "perm-2".into();
    }
);
preflight!(stale_policy_never_reads_metadata, LinkState::Stale, r, h, {
    r.node = "node-2".into();
    h.0.borrow_mut().context.policy_revision = "policy-2".into();
});
preflight!(
    canceled_request_never_reads_metadata,
    LinkState::Canceled,
    r,
    h,
    {
        r.node = "node-2".into();
        h.0.borrow_mut().canceled = true;
    }
);
preflight!(
    target_title_requires_its_own_grant,
    LinkState::Unavailable,
    r,
    h,
    {
        r.node = "node-2".into();
        h.0.borrow_mut().access.title = false;
    }
);
preflight!(
    host_title_capability_cannot_be_escalated,
    LinkState::Unavailable,
    r,
    h,
    {
        r.host.capabilities.title = false;
        h.0.borrow_mut().context = r.host.clone();
    }
);
preflight!(
    public_target_never_uses_private_endpoint,
    LinkState::Unsupported,
    r,
    h,
    {
        r.target = LinkTarget::PublicUrl("http://127.0.0.1/secret".into());
    }
);
preflight!(
    disabled_policy_never_uses_endpoint,
    LinkState::Unavailable,
    r,
    h,
    {
        r.policy = EnrichmentPolicy::Disabled;
    }
);

#[test]
fn non_initiating_origins_make_zero_endpoint_calls() {
    for origin in [
        LinkOrigin::Open,
        LinkOrigin::Render,
        LinkOrigin::Remote,
        LinkOrigin::Replay,
        LinkOrigin::History,
    ] {
        let mut r = request();
        r.origin = origin;
        let h = endpoint(&r);
        assert_no_metadata(resolve(&r, &h), LinkState::Unavailable, &h, 0);
        assert_eq!(h.0.borrow().auth_calls, 0);
    }
}
macro_rules! late {
    ($name:ident, $change:ident, $expected:expr) => {
        #[test]
        fn $name() {
            let r = request();
            let h = endpoint(&r);
            h.0.borrow_mut().change = Change::$change;
            assert_no_metadata(resolve(&r, &h), $expected, &h, 1);
        }
    };
}
late!(
    principal_switch_during_io_discards_private_fields,
    Principal,
    LinkState::Forbidden
);
late!(
    tenant_switch_during_io_discards_private_fields,
    Tenant,
    LinkState::Forbidden
);
late!(
    policy_change_during_io_discards_private_fields,
    Policy,
    LinkState::Stale
);
late!(
    permission_change_during_io_discards_private_fields,
    Permission,
    LinkState::Forbidden
);
late!(
    session_change_during_io_discards_private_fields,
    Session,
    LinkState::Stale
);
late!(
    revision_change_during_io_discards_private_fields,
    Revision,
    LinkState::Stale
);
late!(
    cancellation_during_io_discards_private_fields,
    Cancel,
    LinkState::Canceled
);
late!(
    target_revocation_during_io_discards_private_fields,
    Revoke,
    LinkState::Unavailable
);
late!(
    endpoint_lock_during_io_discards_private_fields,
    Lock,
    LinkState::Locked
);

#[test]
fn session_change_during_authorization_prevents_metadata_read() {
    let r = request();
    let h = endpoint(&r);
    {
        let mut s = h.0.borrow_mut();
        s.change = Change::Policy;
        s.change_on_auth = true;
    }
    assert_no_metadata(resolve(&r, &h), LinkState::Stale, &h, 0);
}
#[test]
fn title_icon_preview_permissions_are_intersected_and_filtered() {
    for host_restricts in [true, false] {
        let mut r = request();
        if host_restricts {
            r.host.capabilities.icon = false;
            r.host.capabilities.preview = false;
        }
        let h = endpoint(&r);
        if !host_restricts {
            let mut s = h.0.borrow_mut();
            s.access.icon = false;
            s.access.preview = false;
        }
        let LinkOutcome::Available {
            metadata: LinkMetadata::Private { display, .. },
            ..
        } = resolve(&r, &h)
        else {
            panic!("title allowed")
        };
        assert_eq!(display.title, SECRET);
        assert!(
            display.icon_asset.is_none()
                && display.description.is_none()
                && display.image_asset.is_none()
        );
        let s = h.0.borrow();
        assert!(!s.fields[0].icon && !s.fields[0].preview);
    }
}
#[test]
fn catalog_missing_and_unauthorized_have_identical_results_without_metadata_reads() {
    for (present, access) in [
        (false, AccessState::Allowed),
        (true, AccessState::Unauthorized),
    ] {
        let r = request();
        let h = endpoint(&r);
        let c = catalog(access, SourceBinding::Cached, present);
        assert_no_metadata(
            PrivateResolver::new(&c, h.clone(), Connectivity::Online).resolve(&r),
            LinkState::Unavailable,
            &h,
            0,
        );
    }
}
#[test]
fn catalog_lock_incompatible_and_offline_source_preserve_existing_semantics() {
    for (access, connection, expected) in [
        (AccessState::Locked, Connectivity::Online, LinkState::Locked),
        (
            AccessState::Incompatible,
            Connectivity::Online,
            LinkState::Unsupported,
        ),
        (
            AccessState::Allowed,
            Connectivity::Offline,
            LinkState::Unavailable,
        ),
    ] {
        let r = request();
        let h = endpoint(&r);
        let c = catalog(access, SourceBinding::Hosted { cached: false }, true);
        assert_no_metadata(
            PrivateResolver::new(&c, h.clone(), connection).resolve(&r),
            expected,
            &h,
            0,
        );
    }
}
#[test]
fn cached_catalog_source_still_requires_current_endpoint_authority_offline() {
    let r = request();
    let h = endpoint(&r);
    let c = catalog(AccessState::Allowed, SourceBinding::Cached, true);
    h.0.borrow_mut().failure = Some(PrivateFailure::Unavailable);
    assert_no_metadata(
        PrivateResolver::new(&c, h.clone(), Connectivity::Offline).resolve(&r),
        LinkState::Unavailable,
        &h,
        0,
    );
}
#[test]
fn malformed_oversize_control_and_remote_asset_records_are_rejected() {
    for (title, icon) in [
        ("x".repeat(MAX_TEXT + 1), "asset".into()),
        ("bad\ncontrol".into(), "asset".into()),
        (
            "title".into(),
            "https://private.test/icon?token=SECRET".into(),
        ),
    ] {
        let r = request();
        let h = endpoint(&r);
        {
            let mut s = h.0.borrow_mut();
            s.title = title;
            s.icon = icon;
        }
        assert_no_metadata(resolve(&r, &h), LinkState::Unsupported, &h, 1);
    }
}
#[test]
fn expired_future_and_unsafe_integer_freshness_are_rejected() {
    for (fetched, expires) in [(90, 100), (101, 200), (90, MAX_SAFE_INTEGER + 1)] {
        let r = request();
        let h = endpoint(&r);
        {
            let mut s = h.0.borrow_mut();
            s.fetched_at = fetched;
            s.expires_at = expires;
        }
        assert_no_metadata(resolve(&r, &h), LinkState::Stale, &h, 1);
    }
}
#[test]
fn readonly_activation_is_separate_from_metadata_and_write_authority() {
    let mut r = request();
    r.host.readonly = true;
    r.host.capabilities.title = false;
    r.policy = EnrichmentPolicy::Disabled;
    let h = endpoint(&r);
    let c = catalog(AccessState::Allowed, SourceBinding::Cached, true);
    let mut resolver = PrivateResolver::new(&c, h.clone(), Connectivity::Online);
    assert!(matches!(
        resolver.activation(&r),
        Ok(LinkAction::Activate { .. })
    ));
    assert_eq!(h.0.borrow().reads, 0);
    assert_eq!(r.intent_permission(&r.host, true), LinkState::Forbidden);
    h.0.borrow_mut().access.activate = false;
    assert!(matches!(
        resolver.activation(&r),
        Err(LinkState::Unavailable)
    ));
}
#[test]
fn previous_metadata_never_grants_activation_after_target_revocation() {
    let r = request();
    let h = endpoint(&r);
    let c = catalog(AccessState::Allowed, SourceBinding::Cached, true);
    let mut resolver = PrivateResolver::new(&c, h.clone(), Connectivity::Online);
    assert_eq!(resolver.resolve(&r).state(), LinkState::Available);
    h.0.borrow_mut().access.lookup = false;
    assert!(matches!(
        resolver.activation(&r),
        Err(LinkState::Unavailable)
    ));
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn private_resolution_and_activation_cannot_mutate_or_publish_engine_state() {
    let mut document = support::document();
    support::insert(&mut document, 0, "User-authored label");
    let before = document.checkpoint().bytes;
    let r = request();
    let h = endpoint(&r);
    assert_eq!(resolve(&r, &h).state(), LinkState::Available);
    let c = catalog(AccessState::Allowed, SourceBinding::Cached, true);
    assert!(
        PrivateResolver::new(&c, h, Connectivity::Online)
            .activation(&r)
            .is_ok()
    );
    assert_eq!(document.checkpoint().bytes, before);
    assert_eq!(support::text(&document), "User-authored label");
    assert!(!before.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
    assert!(!format!("{r:?} {:?}", PrivateFailure::Hidden).contains(SECRET));
}

#[test]
fn all_catalog_source_families_reuse_the_same_authorization_boundary() {
    for source in [
        SourceBinding::Cached,
        SourceBinding::Hosted { cached: true },
        SourceBinding::Hosted { cached: false },
        SourceBinding::LocalPath(std::path::PathBuf::from("/prepared/private-document")),
    ] {
        let r = request();
        let h = endpoint(&r);
        let c = catalog(AccessState::Allowed, source, true);
        assert_eq!(
            PrivateResolver::new(&c, h.clone(), Connectivity::Online)
                .resolve(&r)
                .state(),
            LinkState::Available
        );
        assert_eq!(h.0.borrow().reads, 1);
    }
}
#[test]
fn local_ac_locator_requires_current_target_grant_too() {
    let mut r = request();
    r.host.authority = None;
    let target = Locator::parse(&format!("ac://{ID}")).unwrap();
    r.target = LinkTarget::Private(target.clone());
    let h = endpoint(&r);
    h.0.borrow_mut().grant_target = target.to_string();
    let mut c = Catalog::default();
    c.insert(
        target,
        CatalogEntry {
            identity: DocumentIdentity::v5(ID, "23456789-2345-4345-8345-23456789abcd").unwrap(),
            source: SourceBinding::Cached,
            access: AccessState::Allowed,
        },
    )
    .unwrap();
    let mut resolver = PrivateResolver::new(&c, h.clone(), Connectivity::Offline);
    assert_eq!(resolver.resolve(&r).state(), LinkState::Available);
    h.0.borrow_mut().access.lookup = false;
    assert_no_metadata(resolver.resolve(&r), LinkState::Unavailable, &h, 1);
}
#[test]
fn late_field_revocation_removes_icon_and_preview_before_delivery() {
    let r = request();
    let h = endpoint(&r);
    h.0.borrow_mut().change = Change::Fields;
    let LinkOutcome::Available {
        metadata: LinkMetadata::Private { display, .. },
        ..
    } = resolve(&r, &h)
    else {
        panic!("title allowed")
    };
    assert!(
        display.icon_asset.is_none()
            && display.description.is_none()
            && display.image_asset.is_none()
    );
}
late!(
    late_title_revocation_discards_record,
    Title,
    LinkState::Unavailable
);
#[test]
fn activation_rejects_host_capability_loss_cancellation_and_lock() {
    for mode in 0..3 {
        let mut r = request();
        if mode == 0 {
            r.host.capabilities.activate = false;
        }
        let h = endpoint(&r);
        if mode == 1 {
            h.0.borrow_mut().canceled = true;
        }
        if mode == 2 {
            h.0.borrow_mut().failure = Some(PrivateFailure::Locked);
        }
        let c = catalog(AccessState::Allowed, SourceBinding::Cached, true);
        let expected = [LinkState::Forbidden, LinkState::Canceled, LinkState::Locked][mode];
        assert!(
            matches!(PrivateResolver::new(&c,h.clone(),Connectivity::Online).activation(&r), Err(state) if state == expected)
        );
        assert_eq!(h.0.borrow().reads, 0);
    }
}
#[test]
fn activation_rejects_session_changes_inside_authorization() {
    let r = request();
    let h = endpoint(&r);
    {
        let mut s = h.0.borrow_mut();
        s.change = Change::Principal;
        s.change_on_auth = true;
    }
    let c = catalog(AccessState::Allowed, SourceBinding::Cached, true);
    assert!(matches!(
        PrivateResolver::new(&c, h.clone(), Connectivity::Online).activation(&r),
        Err(LinkState::Forbidden)
    ));
    assert_eq!(h.0.borrow().reads, 0);
}

#[test]
fn endpoint_response_must_bind_to_exact_request_target_tenant_and_policy() {
    for (fault, expected) in [
        (1, LinkState::Forbidden),
        (2, LinkState::Stale),
        (3, LinkState::Unsupported),
        (4, LinkState::Stale),
        (7, LinkState::Unsupported),
    ] {
        let r = request();
        let h = endpoint(&r);
        h.0.borrow_mut().response_fault = fault;
        assert_no_metadata(resolve(&r, &h), expected, &h, 1);
    }
}
#[test]
fn endpoint_missing_and_denied_records_remain_non_disclosing() {
    for fault in [5, 6] {
        let r = request();
        let h = endpoint(&r);
        h.0.borrow_mut().response_fault = fault;
        assert_no_metadata(resolve(&r, &h), LinkState::Unavailable, &h, 1);
    }
}
