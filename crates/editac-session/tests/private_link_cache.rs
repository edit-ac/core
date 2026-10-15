//! LNK-1.8 canonical composition: Catalog + current grants + private resolver +
//! per-viewer cache + actual engine reference/checkpoint + scoped disclosure.
//! All endpoint responses are prepared in memory. No sockets or credentials.
mod support;
use editac_core::{
    Utf16Offset,
    anchors::{Bias, Selection},
    commands::{
        editor::{FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{BlockAttributes, Document, DocumentIdentity},
    modules::content::Content,
};
use editac_session::{
    links::{private_cache::*, private_resolver::*, *},
    locator::*,
    service_lifecycle::ServiceScope,
};
use std::{cell::RefCell, rc::Rc};
const ID: &str = "12345678-1234-4234-8234-123456789abc";
const SECRET: &str = "Secret private title";
const ICON: &str = "secret-private-icon";
fn request() -> LinkRequest {
    LinkRequest {
        request_id: "r1".into(),
        cancellation_token: "c1".into(),
        node: "n1".into(),
        epoch: "e1".into(),
        label_revision: "l1".into(),
        host: LinkHostContext {
            principal: "alice".into(),
            tenant: "tenant-a".into(),
            authority: Some(Authority::parse("team").unwrap()),
            scope: ServiceScope {
                document: "shared-doc".into(),
                session: "s1".into(),
                revision: "v1".into(),
                permission: "p1".into(),
                authorized: true,
            },
            policy_revision: "policy1".into(),
            readonly: false,
            capabilities: LinkCapabilities {
                public_metadata: false,
                private_lookup: true,
                title: true,
                icon: true,
                preview: true,
                activate: true,
                publish_metadata: true,
            },
        },
        target: LinkTarget::Private(Locator::parse(&format!("ac://team/{ID}")).unwrap()),
        policy: EnrichmentPolicy::ExplicitRefresh,
        origin: LinkOrigin::ExplicitRefresh,
    }
}
fn catalog() -> Catalog {
    let mut c = Catalog::default();
    for authority in ["team", "other"] {
        c.configure_authority(authority).unwrap();
        for id in [ID, "22345678-1234-4234-8234-123456789abc"] {
            c.insert(
                Locator::parse(&format!("ac://{authority}/{id}")).unwrap(),
                CatalogEntry {
                    identity: DocumentIdentity::v5(id, "23456789-2345-4345-8345-23456789abcd")
                        .unwrap(),
                    source: SourceBinding::Cached,
                    access: AccessState::Allowed,
                },
            )
            .unwrap();
        }
    }
    c
}
struct State {
    context: LinkHostContext,
    now: u64,
    canceled: bool,
    locked: bool,
    access: TargetAccess,
    reads: usize,
    auths: usize,
    revoke_on: Option<usize>,
    secret_title: String,
    secret_icon: String,
    strip_fields_on: Option<usize>,
    malformed: bool,
    fail: bool,
}
#[derive(Clone)]
struct Endpoint(Rc<RefCell<State>>);
fn endpoint(r: &LinkRequest) -> Endpoint {
    Endpoint(Rc::new(RefCell::new(State {
        context: r.host.clone(),
        now: 100,
        canceled: false,
        locked: false,
        access: TargetAccess {
            lookup: true,
            title: true,
            icon: true,
            preview: true,
            activate: true,
        },
        reads: 0,
        auths: 0,
        revoke_on: None,
        secret_title: SECRET.into(),
        secret_icon: ICON.into(),
        strip_fields_on: None,
        malformed: false,
        fail: false,
    })))
}
impl PrivateEndpoint for Endpoint {
    fn session(&mut self, _: &LinkRequest) -> PrivateSession {
        let s = self.0.borrow();
        PrivateSession {
            context: s.context.clone(),
            canceled: s.canceled,
            now_ms: s.now,
        }
    }
    fn authorize(
        &mut self,
        context: &LinkHostContext,
        _: &Locator,
    ) -> Result<TargetAccess, PrivateFailure> {
        let mut s = self.0.borrow_mut();
        s.auths += 1;
        if s.revoke_on == Some(s.auths) {
            s.access.lookup = false;
        }
        if s.strip_fields_on == Some(s.auths) {
            s.access.icon = false;
            s.access.preview = false;
        }
        if s.locked {
            return Err(PrivateFailure::Locked);
        }
        if context != &s.context {
            return Err(PrivateFailure::Hidden);
        }
        Ok(s.access)
    }
    fn metadata(
        &mut self,
        request: &LinkRequest,
        _: TargetAccess,
    ) -> Result<LinkResult, PrivateFailure> {
        let mut s = self.0.borrow_mut();
        s.reads += 1;
        if s.fail {
            return Err(PrivateFailure::Unavailable);
        }
        let LinkTarget::Private(target) = &request.target else {
            panic!("private only")
        };
        Ok(LinkResult {
            request: request.clone(),
            outcome: LinkOutcome::Available {
                metadata: LinkMetadata::Private {
                    target: target.clone(),
                    display: LinkDisplay {
                        title: if s.malformed {
                            "bad\n".into()
                        } else {
                            s.secret_title.clone()
                        },
                        icon_asset: Some(s.secret_icon.clone()),
                        description: Some("Secret preview".into()),
                        image_asset: Some("secret-image".into()),
                    },
                },
                freshness: LinkFreshness {
                    fetched_at: s.now,
                    expires_at: s.now + 900,
                    policy_revision: request.host.policy_revision.clone(),
                },
            },
        })
    }
}
fn cache<'a>(c: &'a Catalog, h: &Endpoint) -> CachedPrivateResolver<'a, Endpoint> {
    CachedPrivateResolver::new(
        c,
        h.clone(),
        Connectivity::Online,
        PrivateCachePolicy {
            entries: 4,
            offline_lease_ms: 50,
        },
    )
    .unwrap()
}
fn available(outcome: LinkOutcome) -> LinkDisplay {
    match outcome {
        LinkOutcome::Available {
            metadata: LinkMetadata::Private { display, .. },
            ..
        } => display,
        _ => panic!("expected private metadata"),
    }
}
#[test]
fn cache_reuses_title_icon_without_another_metadata_read_and_rebinds_request() {
    let c = catalog();
    let mut r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    assert_eq!(available(cache.resolve(&r)).title, SECRET);
    r.request_id = "r2".into();
    r.cancellation_token = "c2".into();
    r.node = "n2".into();
    r.label_revision = "l2".into();
    let result = cache.resolve(&r);
    let d = available(result.clone());
    assert_eq!(d.icon_asset.as_deref(), Some(ICON));
    assert!(
        LinkResult {
            request: r.clone(),
            outcome: result
        }
        .validate(&r, 100, false)
        .is_ok()
    );
    assert_eq!(h.0.borrow().reads, 1);
    assert!(h.0.borrow().auths >= 4);
}
macro_rules! isolation {
    ($name:ident, $change:expr) => {
        #[test]
        fn $name() {
            let c = catalog();
            let r = request();
            let h = endpoint(&r);
            let mut cache = cache(&c, &h);
            available(cache.resolve(&r));
            let mut other = r.clone();
            ($change)(&mut other);
            {
                let mut s = h.0.borrow_mut();
                s.context = other.host.clone();
                s.secret_title = "Other viewer secret".into();
                s.secret_icon = "other-secret-icon".into();
            }
            cache.set_connectivity(Connectivity::Offline);
            assert_eq!(cache.resolve(&other).state(), LinkState::Unavailable);
            assert_eq!(h.0.borrow().reads, 1);
            cache.set_connectivity(Connectivity::Online);
            let other_display = available(cache.resolve(&other));
            assert_eq!(other_display.title, "Other viewer secret");
            if other.host.capabilities.icon {
                assert_eq!(
                    other_display.icon_asset.as_deref(),
                    Some("other-secret-icon")
                );
            }
            assert_eq!(h.0.borrow().reads, 2);
            h.0.borrow_mut().context = r.host.clone();
            cache.set_connectivity(Connectivity::Offline);
            assert_eq!(available(cache.resolve(&r)).title, SECRET);
            assert_eq!(h.0.borrow().reads, 2);
        }
    };
}
isolation!(
    two_principals_never_share_secret_title_or_icon,
    |r: &mut LinkRequest| r.host.principal = "bob".into()
);
isolation!(
    two_tenants_never_share_secret_title_or_icon,
    |r: &mut LinkRequest| r.host.tenant = "tenant-b".into()
);
isolation!(
    same_id_different_authority_never_collides,
    |r: &mut LinkRequest| {
        r.host.authority = Some(Authority::parse("other").unwrap());
        r.target = LinkTarget::Private(Locator::parse(&format!("ac://other/{ID}")).unwrap());
    }
);
isolation!(different_target_never_collides, |r: &mut LinkRequest| r
    .target =
    LinkTarget::Private(
        Locator::parse("ac://team/22345678-1234-4234-8234-123456789abc").unwrap()
    ));
isolation!(
    policy_revision_is_part_of_cache_key,
    |r: &mut LinkRequest| r.host.policy_revision = "policy2".into()
);
isolation!(
    permission_revision_is_part_of_cache_key,
    |r: &mut LinkRequest| r.host.scope.permission = "p2".into()
);
isolation!(
    containing_document_is_also_isolated,
    |r: &mut LinkRequest| r.host.scope.document = "other-doc".into()
);
isolation!(capability_scope_is_also_isolated, |r: &mut LinkRequest| {
    r.host.capabilities.icon = false;
    r.host.capabilities.preview = false;
});
#[test]
fn offline_hit_uses_finite_nonrenewable_online_lease() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    cache.set_connectivity(Connectivity::Offline);
    for now in [110, 125, 149] {
        h.0.borrow_mut().now = now;
        available(cache.resolve(&r));
    }
    h.0.borrow_mut().now = 150;
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(h.0.borrow().reads, 1);
    cache.set_connectivity(Connectivity::Online);
    available(cache.resolve(&r));
    cache.set_connectivity(Connectivity::Offline);
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(h.0.borrow().reads, 1); // Online cache hit cannot silently renew authorization lease.
}
#[test]
fn offline_miss_never_invokes_metadata_transport() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    cache.set_connectivity(Connectivity::Offline);
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(h.0.borrow().reads, 0);
}
#[test]
fn default_policy_hides_all_offline_metadata() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = CachedPrivateResolver::new(
        &c,
        h.clone(),
        Connectivity::Online,
        PrivateCachePolicy::default(),
    )
    .unwrap();
    available(cache.resolve(&r));
    cache.set_connectivity(Connectivity::Offline);
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn metadata_expiry_always_caps_offline_lease_and_evicts_entry() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = CachedPrivateResolver::new(
        &c,
        h.clone(),
        Connectivity::Online,
        PrivateCachePolicy {
            entries: 4,
            offline_lease_ms: 2000,
        },
    )
    .unwrap();
    available(cache.resolve(&r));
    cache.set_connectivity(Connectivity::Offline);
    h.0.borrow_mut().now = 1000;
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(h.0.borrow().reads, 1);
}
macro_rules! invalidate {
    ($name:ident, $event:expr) => {
        #[test]
        fn $name() {
            let c = catalog();
            let r = request();
            let h = endpoint(&r);
            let mut cache = cache(&c, &h);
            available(cache.resolve(&r));
            cache.invalidate($event);
            assert_eq!(cache.entry_count(), 0);
            cache.set_connectivity(Connectivity::Offline);
            assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
            assert_eq!(h.0.borrow().reads, 1);
        }
    };
}
invalidate!(
    logout_evicts_private_projection,
    PrivateInvalidation::Logout
);
invalidate!(
    account_switch_evicts_private_projection,
    PrivateInvalidation::AccountSwitch
);
invalidate!(
    revocation_event_evicts_private_projection,
    PrivateInvalidation::Revoked
);
invalidate!(
    key_lock_event_evicts_private_projection,
    PrivateInvalidation::KeyLocked
);
invalidate!(
    policy_event_evicts_private_projection,
    PrivateInvalidation::PolicyChanged
);
#[test]
fn live_revocation_hides_and_evicts_a_cached_title() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    h.0.borrow_mut().access.title = false;
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn live_lock_hides_and_evicts_a_cached_title_offline() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    cache.set_connectivity(Connectivity::Offline);
    h.0.borrow_mut().locked = true;
    assert_eq!(cache.resolve(&r).state(), LinkState::Locked);
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn revoked_icon_preview_grants_strip_cached_fields_without_io() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    {
        let mut s = h.0.borrow_mut();
        s.access.icon = false;
        s.access.preview = false;
    }
    let d = available(cache.resolve(&r));
    assert_eq!(d.title, SECRET);
    assert!(d.icon_asset.is_none() && d.description.is_none() && d.image_asset.is_none());
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn revocation_during_cache_hit_authorization_cannot_leak_fields() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    {
        let mut s = h.0.borrow_mut();
        s.revoke_on = Some(s.auths + 2);
    }
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn cancellation_hides_cached_display_without_io() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    h.0.borrow_mut().canceled = true;
    assert_eq!(cache.resolve(&r).state(), LinkState::Canceled);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn captured_request_cannot_survive_host_account_change() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    h.0.borrow_mut().context.principal = "bob".into();
    assert_eq!(cache.resolve(&r).state(), LinkState::Forbidden);
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn dispose_drops_entries_and_prevents_reuse_or_new_reads() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    cache.dispose();
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(cache.resolve(&r).state(), LinkState::Canceled);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn rollback_of_host_clock_hides_and_clears_cache() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    h.0.borrow_mut().now = 99;
    assert_eq!(cache.resolve(&r).state(), LinkState::Stale);
    assert_eq!(cache.entry_count(), 0);
}
#[test]
fn bounded_fifo_eviction_never_reuses_evicted_principals_data() {
    let c = catalog();
    let mut r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    for i in 0..8 {
        r.host.principal = format!("viewer-{i}");
        h.0.borrow_mut().context = r.host.clone();
        available(cache.resolve(&r));
        assert!(cache.entry_count() <= 4);
    }
    r.host.principal = "viewer-0".into();
    h.0.borrow_mut().context = r.host.clone();
    cache.set_connectivity(Connectivity::Offline);
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(h.0.borrow().reads, 8);
}
#[test]
fn invalid_cache_limits_fail_closed() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    for p in [
        PrivateCachePolicy {
            entries: 0,
            offline_lease_ms: 1,
        },
        PrivateCachePolicy {
            entries: 257,
            offline_lease_ms: 1,
        },
        PrivateCachePolicy {
            entries: 1,
            offline_lease_ms: 300001,
        },
    ] {
        assert!(matches!(
            CachedPrivateResolver::new(&c, h.clone(), Connectivity::Online, p),
            Err(LinkState::Unsupported)
        ));
    }
    assert_eq!(h.0.borrow().reads, 0);
}
#[test]
fn malformed_metadata_is_not_admitted_to_cache() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    h.0.borrow_mut().malformed = true;
    let mut cache = cache(&c, &h);
    assert_eq!(cache.resolve(&r).state(), LinkState::Unsupported);
    assert_eq!(cache.entry_count(), 0);
}
#[test]
fn unavailable_metadata_is_not_cached_as_a_secret_or_a_permanent_negative() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    h.0.borrow_mut().fail = true;
    let mut cache = cache(&c, &h);
    assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    assert_eq!(cache.entry_count(), 0);
    h.0.borrow_mut().fail = false;
    available(cache.resolve(&r));
    assert_eq!(h.0.borrow().reads, 2);
}
fn audience() -> DisclosureScope {
    DisclosureScope {
        document: "shared-doc".into(),
        recipients: vec!["alice".into(), "bob".into()],
        permission_revision: "audience1".into(),
    }
}
struct DisclosureHost {
    current: DisclosureScope,
    allow: bool,
    calls: usize,
    revoke: Option<Endpoint>,
    change: u8,
}
impl PrivateDisclosureHost for DisclosureHost {
    fn authorize_disclosure(
        &mut self,
        r: &LinkRequest,
        scope: &DisclosureScope,
        label: &str,
    ) -> bool {
        self.calls += 1;
        assert_eq!(r.host.scope.document, self.current.document);
        assert_eq!(label, SECRET);
        if let Some(h) = &self.revoke {
            let mut s = h.0.borrow_mut();
            match self.change {
                1 => s.context.readonly = true,
                2 => s.now = 1000,
                3 => s.now = 150,
                _ => s.access.lookup = false,
            }
        }
        self.allow && scope == &self.current
    }
}
fn disclosure_host() -> DisclosureHost {
    DisclosureHost {
        current: audience(),
        allow: true,
        calls: 0,
        revoke: None,
        change: 0,
    }
}
#[test]
fn target_read_and_cache_insert_do_not_authorize_disclosure() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    host.allow = false;
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Forbidden)
    ));
    assert_eq!(host.calls, 1);
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn disclosure_rejects_wrong_document_without_even_consulting_host() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    let mut scope = audience();
    scope.document = "another-doc".into();
    assert!(matches!(
        cache.prepare_disclosure(&r, scope, &mut host),
        Err(LinkState::Forbidden)
    ));
    assert_eq!(host.calls, 0);
}
#[test]
fn disclosure_rejects_wrong_actual_recipient_scope() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    let mut scope = audience();
    scope.recipients.pop();
    assert!(matches!(
        cache.prepare_disclosure(&r, scope, &mut host),
        Err(LinkState::Forbidden)
    ));
    assert_eq!(host.calls, 1);
}
#[test]
fn disclosure_rejects_stale_audience_permission_revision() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    host.current.permission_revision = "audience2".into();
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Forbidden)
    ));
}
#[test]
fn readonly_and_missing_publish_capability_each_deny_disclosure() {
    for mode in 0..2 {
        let c = catalog();
        let mut r = request();
        if mode == 0 {
            r.host.readonly = true;
        } else {
            r.host.capabilities.publish_metadata = false;
        }
        let h = endpoint(&r);
        let mut cache = cache(&c, &h);
        available(cache.resolve(&r));
        let mut host = disclosure_host();
        assert!(matches!(
            cache.prepare_disclosure(&r, audience(), &mut host),
            Err(LinkState::Forbidden)
        ));
        assert_eq!(host.calls, 0);
    }
}
#[test]
fn disclosure_never_fetches_on_cache_miss() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    let mut host = disclosure_host();
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Unavailable)
    ));
    assert_eq!(h.0.borrow().reads, 0);
    assert_eq!(host.calls, 0);
}
#[test]
fn revocation_during_disclosure_decision_prevents_action() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    host.revoke = Some(h.clone());
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Unavailable)
    ));
}
fn add_reference(d: &mut Document, owner: &str, target: &str, label: &str) {
    let anchor = d.anchor(owner, Utf16Offset(0), Bias::Right).unwrap();
    let range = Selection {
        anchor: anchor.clone(),
        focus: anchor,
    };
    let plan = d
        .prepare_fragment(
            &range,
            &[FragmentBlock {
                attributes: Some(BlockAttributes::Unknown(
                    Content::Reference {
                        target_id: target.into(),
                        label: label.into(),
                    }
                    .tuple()
                    .unwrap(),
                )),
                containers: vec![],
                checked: None,
                runs: vec![FragmentRun {
                    text: label.into(),
                    marks: vec![],
                }],
            }],
            &TextOrigin::new("explicit-reference").unwrap(),
        )
        .unwrap();
    d.commit_editor(plan).unwrap();
}
#[test]
fn actual_shared_reference_snapshots_stay_secret_free_until_explicit_scoped_disclosure() {
    let mut document = support::document();
    let owner = support::owner(&document);
    let mut r = request();
    let LinkTarget::Private(target) = &r.target else {
        panic!("target")
    };
    let target = target.to_string();
    add_reference(&mut document, &owner, &target, "User-authored label");
    r.host.scope.document = document.checkpoint().identity.document_id.clone();
    let before = document.checkpoint();
    let c = catalog();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    let display = available(cache.resolve(&r));
    assert_eq!(display.title, SECRET);
    assert_eq!(document.checkpoint().bytes, before.bytes);
    for secret in [SECRET, ICON, "Secret preview", "secret-image"] {
        assert!(
            !before
                .bytes
                .windows(secret.len())
                .any(|w| w == secret.as_bytes())
        );
    }
    if let Ok(path) = std::env::var("EDITAC_PRIVATE_CACHE_EVIDENCE") {
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            std::path::Path::new(&path).join("default-shared.bin"),
            &before.bytes,
        )
        .unwrap();
    }
    let recipient = Document::restore(&before.identity, &before, &[]).unwrap();
    let snap = recipient.snapshot().unwrap();
    assert!(snap.visible.iter().any(|n| matches!(&n.block_attributes, Some(BlockAttributes::Unknown(tuple)) if matches!(Content::from_tuple(tuple).unwrap(), Some(Content::Reference { target_id, label }) if target_id == target && label == "User-authored label"))));
    let mut scope = audience();
    scope.document = r.host.scope.document.clone();
    let mut host = disclosure_host();
    host.current = scope.clone();
    let prepared = cache
        .prepare_disclosure(&r, scope.clone(), &mut host)
        .unwrap();
    assert!(prepared.scope == scope);
    assert!(prepared.action.valid());
    assert_eq!(document.checkpoint().bytes, before.bytes);
    let LinkAction::CommitMetadata {
        shared_label,
        request: captured,
    } = prepared.action
    else {
        panic!("explicit shared action")
    };
    assert!(*captured == r);
    assert_eq!(shared_label, SECRET);
    // Host applies only after the exact audience check. Real engine serialization
    // and recipient restore prove this is an explicit shared disclosure.
    add_reference(&mut document, &owner, &target, &shared_label);
    let shared = document.checkpoint();
    if let Ok(path) = std::env::var("EDITAC_PRIVATE_CACHE_EVIDENCE") {
        std::fs::write(
            std::path::Path::new(&path).join("authorized-shared.bin"),
            &shared.bytes,
        )
        .unwrap();
    }
    let recipient = Document::restore(&shared.identity, &shared, &[]).unwrap();
    assert!(recipient.snapshot().unwrap().visible.iter().any(|n| matches!(&n.block_attributes, Some(BlockAttributes::Unknown(tuple)) if matches!(Content::from_tuple(tuple).unwrap(), Some(Content::Reference { target_id, label }) if target_id == target && label == SECRET))));
    assert!(
        shared
            .bytes
            .windows(SECRET.len())
            .any(|w| w == SECRET.as_bytes())
    );
    assert!(
        !shared
            .bytes
            .windows(ICON.len())
            .any(|w| w == ICON.as_bytes())
    );
    cache.invalidate(PrivateInvalidation::Revoked);
    assert_eq!(document.checkpoint().bytes, shared.bytes);
    assert!(!format!("{r:?}").contains(SECRET));
}

#[test]
fn final_online_authorization_filters_fields_revoked_after_endpoint_response() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    // Initial cache check, resolver pre/post checks, then cache final check.
    h.0.borrow_mut().strip_fields_on = Some(4);
    let mut cache = cache(&c, &h);
    let d = available(cache.resolve(&r));
    assert!(d.icon_asset.is_none() && d.description.is_none() && d.image_asset.is_none());
    assert_eq!(h.0.borrow().reads, 1);
    let d = available(cache.resolve(&r));
    assert!(d.icon_asset.is_none());
}
#[test]
fn cache_hit_second_authorization_filters_newly_revoked_fields() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    {
        let mut s = h.0.borrow_mut();
        s.strip_fields_on = Some(s.auths + 2);
    }
    let d = available(cache.resolve(&r));
    assert!(d.icon_asset.is_none() && d.description.is_none() && d.image_asset.is_none());
    assert_eq!(h.0.borrow().reads, 1);
}

#[test]
fn noninitiating_origins_cannot_even_reuse_cached_secret_fields() {
    let c = catalog();
    let mut r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    for origin in [
        LinkOrigin::Open,
        LinkOrigin::Render,
        LinkOrigin::Remote,
        LinkOrigin::Replay,
        LinkOrigin::History,
    ] {
        r.origin = origin;
        assert_eq!(cache.resolve(&r).state(), LinkState::Unavailable);
    }
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn expired_online_entry_requires_new_validated_metadata() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    {
        let mut s = h.0.borrow_mut();
        s.now = 1000;
        s.secret_title = "New authorized title".into();
    }
    assert_eq!(available(cache.resolve(&r)).title, "New authorized title");
    assert_eq!(h.0.borrow().reads, 2);
    assert_eq!(cache.entry_count(), 1);
}
#[test]
fn public_urls_cannot_enter_the_private_cache_or_transport() {
    let c = catalog();
    let mut r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    r.target = LinkTarget::PublicUrl("https://example.test/".into());
    assert_eq!(cache.resolve(&r).state(), LinkState::Forbidden);
    assert_eq!(h.0.borrow().reads, 0);
    assert_eq!(cache.entry_count(), 0);
}

#[test]
fn readonly_change_during_disclosure_decision_prevents_action() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    host.revoke = Some(h.clone());
    host.change = 1;
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Forbidden)
    ));
}
#[test]
fn expiry_during_disclosure_decision_prevents_action_without_refetch() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    let mut host = disclosure_host();
    host.revoke = Some(h.clone());
    host.change = 2;
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Unavailable)
    ));
    assert_eq!(h.0.borrow().reads, 1);
}
#[test]
fn offline_lease_expiry_during_disclosure_decision_prevents_action() {
    let c = catalog();
    let r = request();
    let h = endpoint(&r);
    let mut cache = cache(&c, &h);
    available(cache.resolve(&r));
    cache.set_connectivity(Connectivity::Offline);
    let mut host = disclosure_host();
    host.revoke = Some(h.clone());
    host.change = 3;
    assert!(matches!(
        cache.prepare_disclosure(&r, audience(), &mut host),
        Err(LinkState::Unavailable)
    ));
    assert_eq!(h.0.borrow().reads, 1);
}
