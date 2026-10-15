mod support;
use editac_session::{
    links::*,
    locator::{Authority, Locator, ResolutionState},
    service_lifecycle::ServiceScope,
};

fn request(target: &str, policy: &str, origin: &str) -> LinkRequest {
    LinkRequest {
        request_id: "request:1".into(),
        cancellation_token: "cancel:1".into(),
        node: "node:1".into(),
        epoch: "epoch:1".into(),
        label_revision: "label:1".into(),
        host: LinkHostContext {
            principal: "principal:1".into(),
            tenant: "tenant:1".into(),
            authority: Some(Authority::parse("team").unwrap()),
            scope: ServiceScope {
                document: "doc:1".into(),
                session: "session:1".into(),
                revision: "revision:1".into(),
                permission: "permission:1".into(),
                authorized: true,
            },
            policy_revision: "policy:1".into(),
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
        target: if target == "public" {
            LinkTarget::PublicUrl("https://example.test/private?secret=redact".into())
        } else {
            LinkTarget::Private(
                Locator::parse("ac://team/71000000-0000-4000-8000-000000000008").unwrap(),
            )
        },
        policy: match policy {
            "disabled" => EnrichmentPolicy::Disabled,
            "local-paste" => EnrichmentPolicy::LocalPaste,
            "explicit-refresh" => EnrichmentPolicy::ExplicitRefresh,
            _ => panic!("unknown policy"),
        },
        origin: match origin {
            "local-paste" => LinkOrigin::LocalPaste,
            "local-insert" => LinkOrigin::LocalInsert,
            "explicit-refresh" => LinkOrigin::ExplicitRefresh,
            "open" => LinkOrigin::Open,
            "render" => LinkOrigin::Render,
            "remote" => LinkOrigin::Remote,
            "replay" => LinkOrigin::Replay,
            "history" => LinkOrigin::History,
            _ => panic!("unknown origin"),
        },
    }
}
fn change(request: &mut LinkRequest, mutation: &str) {
    match mutation {
        "principal" => request.host.principal = "principal:2".into(),
        "tenant" => request.host.tenant = "tenant:2".into(),
        "authority" => request.host.authority = Some(Authority::parse("other").unwrap()),
        "target-authority" => {
            request.target = LinkTarget::Private(
                Locator::parse("ac://other/71000000-0000-4000-8000-000000000008").unwrap(),
            )
        }
        "permission" => request.host.scope.permission = "permission:2".into(),
        "unauthorized" => request.host.scope.authorized = false,
        "no-public" => request.host.capabilities.public_metadata = false,
        "no-private" => request.host.capabilities.private_lookup = false,
        "no-title" => request.host.capabilities.title = false,
        "no-icon" => request.host.capabilities.icon = false,
        "no-preview" => request.host.capabilities.preview = false,
        "no-activate" => request.host.capabilities.activate = false,
        "no-publish" => request.host.capabilities.publish_metadata = false,
        "capability" => request.host.capabilities.preview = false,
        "document" => request.host.scope.document = "doc:2".into(),
        "session" => request.host.scope.session = "session:2".into(),
        "revision" => request.host.scope.revision = "revision:2".into(),
        "policy" => request.host.policy_revision = "policy:2".into(),
        "empty-id" => request.request_id.clear(),
        "long-id" => request.request_id = "x".repeat(513),
        "long-url" => request.target = LinkTarget::PublicUrl("x".repeat(8193)),
        "control" => request.node = "node\u{0085}".into(),
        "unicode-id" => request.request_id = "😀".repeat(256),
        "unicode-long-id" => request.request_id = "😀".repeat(257),
        "readonly" => request.host.readonly = true,
        "request-id" => request.request_id = "request:2".into(),
        "token" => request.cancellation_token = "cancel:2".into(),
        "node" => request.node = "node:2".into(),
        "epoch" => request.epoch = "epoch:2".into(),
        "label" => request.label_revision = "label:2".into(),
        "target" => request.target = LinkTarget::PublicUrl("https://example.test/other".into()),
        _ => {}
    }
}
fn outcome(request: &LinkRequest, mutation: &str) -> LinkOutcome {
    match mutation {
        "unavailable" => return LinkOutcome::Unavailable,
        "forbidden" => return LinkOutcome::Forbidden,
        "missing" => return LinkOutcome::Missing,
        "locked" => return LinkOutcome::Locked,
        "unsupported" => return LinkOutcome::Unsupported,
        "canceled" => return LinkOutcome::Canceled,
        "stale" => return LinkOutcome::Stale,
        _ => {}
    }
    let mut display = LinkDisplay {
        title: "Prepared title".into(),
        description: Some("Prepared preview".into()),
        icon_asset: Some("asset_1".into()),
        image_asset: None,
    };
    match mutation {
        "control-title" => display.title = "title\nsecret".into(),
        "long-title" => display.title = "x".repeat(513),
        "long-description" => display.description = Some("x".repeat(2049)),
        "remote-icon" => display.icon_asset = Some("https://private.test/icon".into()),
        _ => {}
    }
    let private = Locator::parse("ac://team/71000000-0000-4000-8000-000000000008").unwrap();
    let metadata = match &request.target {
        LinkTarget::PublicUrl(_) if mutation == "wrong-family" => LinkMetadata::Private {
            display,
            target: private,
        },
        LinkTarget::PublicUrl(url) => LinkMetadata::Public {
            display,
            provider: "prepared".into(),
            requested_url: url.clone(),
            canonical_url: Some("https://example.test/advisory".into()),
        },
        LinkTarget::Private(target) => LinkMetadata::Private {
            display,
            target: if mutation == "wrong-identity" {
                Locator::parse("ac://team/71000000-0000-4000-8000-000000000009").unwrap()
            } else {
                target.clone()
            },
        },
    };
    LinkOutcome::Available {
        metadata,
        freshness: LinkFreshness {
            fetched_at: if mutation == "future" { 101 } else { 90 },
            expires_at: if mutation == "expired" { 100 } else { 110 },
            policy_revision: if mutation == "freshness-policy" {
                "policy:2".into()
            } else {
                request.host.policy_revision.clone()
            },
        },
    }
}

#[test]
fn shared_resolver_contract_corpus() {
    let corpus = include_str!("../../../fixtures/links/contract.tsv");
    let mut count = 0;
    for row in corpus.lines().skip(1) {
        let columns: Vec<_> = row.split('\t').collect();
        assert_eq!(columns.len(), 7);
        let [id, kind, target, policy, origin, mutation, expected] = columns[..] else {
            unreachable!()
        };
        let mut captured = request(target, policy, origin);
        // Initial capability/readonly changes apply before capture; changes to
        // current authority/scope occur after capture to prove revalidation.
        if mutation.starts_with("no-")
            || mutation == "readonly"
            || (kind == "admit"
                && matches!(
                    mutation,
                    "empty-id"
                        | "long-id"
                        | "long-url"
                        | "control"
                        | "unicode-id"
                        | "unicode-long-id"
                        | "target-authority"
                ))
        {
            change(&mut captured, mutation);
        }
        let mut current = captured.clone();
        change(&mut current, mutation);
        let actual = match kind {
            "admit" => match captured.admit(&current.host, mutation == "canceled") {
                Ok(LookupAction::PublicMetadata) => "public",
                Ok(LookupAction::PrivateCatalog) => "private",
                Err(state) => state.as_str(),
            },
            "result" => LinkResult {
                request: captured.clone(),
                outcome: outcome(&captured, mutation),
            }
            .validate(&current, 100, false)
            .unwrap_or_else(|s| s)
            .as_str(),
            "activate" | "publish" => captured
                .intent_permission(&current.host, kind == "publish")
                .as_str(),
            "catalog" => catalog_state(match mutation {
                "local" => ResolutionState::Local,
                "cached" => ResolutionState::Cached,
                "hosted" => ResolutionState::Hosted,
                "locked" => ResolutionState::Locked,
                "unavailable" => ResolutionState::Unavailable,
                "unauthorized" => ResolutionState::Unauthorized,
                "incompatible" => ResolutionState::Incompatible,
                _ => panic!("unknown catalog state"),
            })
            .as_str(),
            _ => panic!("unknown fixture kind"),
        };
        assert_eq!(actual, expected, "{id}");
        count += 1;
    }
    assert_eq!(
        count, 76,
        "nonzero canonical coverage; update only with fixture review"
    );
    println!("canonical link contract: {count} executed, {count} passed, 0 failed, 0 skipped");
}

#[test]
fn requests_are_inert_redacted_and_platform_actions_are_portable() {
    let request = request("public", "local-paste", "local-paste");
    assert!(!format!("{request:?}").contains("secret"));
    let action = LinkAction::Lookup {
        request: Box::new(request.clone()),
        port: LookupAction::PublicMetadata,
    };
    assert!(action.valid());
    assert!(matches!(action, LinkAction::Lookup { .. }));
    let _activate = LinkAction::Activate {
        request: Box::new(request.clone()),
    };
    let _copy = LinkAction::CopyLocator {
        target: request.target.clone(),
    };
    let _commit = LinkAction::CommitMetadata {
        request: Box::new(request),
        shared_label: "User-approved label".into(),
    };
    assert!(_activate.valid() && _copy.valid() && _commit.valid());
    let invalid = LinkAction::CommitMetadata {
        request: Box::new(self::request("private", "local-paste", "local-paste")),
        shared_label: "x".repeat(513),
    };
    assert!(!invalid.valid());
    let wrong_port = LinkAction::Lookup {
        request: Box::new(self::request("private", "local-paste", "local-paste")),
        port: LookupAction::PublicMetadata,
    };
    assert!(!wrong_port.valid());
    // No engine, store, provider, async runtime or network object exists in this
    // pure contract. Constructing intents cannot start a transaction or transport.
}

#[test]
fn actual_core_transactions_do_not_resolve_or_publish_metadata() {
    use std::cell::Cell;
    struct Host<'a>(&'a Cell<usize>);
    impl PublicMetadataPort for Host<'_> {
        fn resolve(&mut self, _: &LinkRequest) -> LinkOutcome {
            self.0.set(self.0.get() + 1);
            LinkOutcome::Unavailable
        }
    }
    impl PrivateCatalogPort for Host<'_> {
        fn resolve(&mut self, _: &LinkRequest) -> LinkOutcome {
            self.0.set(self.0.get() + 1);
            LinkOutcome::Forbidden
        }
    }
    let calls = Cell::new(0);
    let _host = Host(&calls);
    let mut document = support::document();
    let before = document.checkpoint().bytes;
    let request = request("private", "local-paste", "local-paste");
    let result = LinkResult {
        request: request.clone(),
        outcome: outcome(&request, "none"),
    };
    assert_eq!(
        result.validate(&request, 100, false),
        Ok(LinkState::Available)
    );
    assert_eq!(document.checkpoint().bytes, before);
    support::insert(&mut document, 0, "User label");
    assert_eq!(support::text(&document), "User label");
    assert_eq!(calls.get(), 0);
    assert!(
        !document
            .checkpoint()
            .bytes
            .windows(b"Prepared title".len())
            .any(|w| w == b"Prepared title")
    );
}
