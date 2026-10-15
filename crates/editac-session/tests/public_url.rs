mod support;
use editac_session::{
    links::{public_url::*, *},
    locator::{Authority, Locator},
    service_lifecycle::ServiceScope,
};

// Prepared downstream counter, not a connection/egress implementation. Every
// denied case shares this harness and proves the admission boundary makes no IO.
#[derive(Default)]
struct PreparedTransport {
    calls: usize,
}
impl PreparedTransport {
    fn lookup(&mut self, admitted: &AdmittedPublicUrl) {
        assert!(admitted.request_url().starts_with("http"));
        self.calls += 1;
    }
    fn resolve(&mut self, policy: &PublicUrlPolicy, raw: &str) -> Result<(), PublicUrlDenial> {
        let admitted = policy.admit(raw)?;
        self.lookup(&admitted);
        Ok(())
    }
}
macro_rules! denied {
    ($name:ident, $url:expr, $reason:ident) => {
        #[test]
        fn $name() {
            let mut transport = PreparedTransport::default();
            let result = transport.resolve(&PublicUrlPolicy::default(), $url);
            assert_eq!(result, Err(PublicUrlDenial::$reason));
            assert_eq!(transport.calls, 0);
        }
    };
}
denied!(empty, "", Malformed);
denied!(relative, "/secret", Malformed);
denied!(scheme_relative, "//example.test/path", Malformed);
denied!(missing_slashes, "https:example.test", Malformed);
denied!(one_slash, "https:/example.test", Malformed);
denied!(extra_slashes, "https:///example.test", Malformed);
denied!(missing_host, "https://", Malformed);
denied!(empty_authority_query, "https://?secret", Malformed);
denied!(leading_space, " https://example.test", Malformed);
denied!(trailing_space, "https://example.test ", Malformed);
denied!(embedded_tab, "https://exam\tple.test", Malformed);
denied!(embedded_newline, "https://example.test/\nsecret", Malformed);
denied!(unicode_control, "https://example.test/\u{0085}", Malformed);
denied!(unicode_space, "https://example.test/\u{00a0}", Malformed);
denied!(
    backslash_authority,
    "https://example.test\\@evil.test",
    Malformed
);
denied!(backslash_path, "https://example.test/a\\b", Malformed);
denied!(username, "https://user@example.test", Credentials);
denied!(password, "https://user:secret@example.test", Credentials);
denied!(password_only, "https://:secret@example.test", Credentials);
denied!(empty_userinfo, "https://@example.test", Credentials);
denied!(empty_credentials, "https://:@example.test", Credentials);
denied!(
    encoded_credentials,
    "https://u%73er:p%40ss@example.test",
    Credentials
);
denied!(javascript, "javascript:alert(1)", UnsupportedScheme);
denied!(data, "data:text/html,secret", UnsupportedScheme);
denied!(file, "file:///secret", UnsupportedScheme);
denied!(ftp, "ftp://example.test", UnsupportedScheme);
denied!(
    private_catalog_scheme,
    "ac://team/71000000-0000-4000-8000-000000000008",
    UnsupportedScheme
);
denied!(bad_port, "https://example.test:abc", Malformed);
denied!(empty_port, "https://example.test:", Malformed);
denied!(too_large_port, "https://example.test:65536", Malformed);
denied!(port_zero, "https://example.test:0", ForbiddenPort);
denied!(
    unconfigured_port,
    "https://example.test:8443",
    ForbiddenPort
);
denied!(wrong_scheme_port, "https://example.test:80", ForbiddenPort);
denied!(invalid_ipv6, "https://[not-ipv6]/", Malformed);
denied!(unbracketed_ipv6, "https://::1/", Malformed);
denied!(empty_label, "https://example..test", Malformed);
denied!(underscore_host, "https://bad_host.test", Malformed);
denied!(leading_hyphen_host, "https://-bad.test", Malformed);
denied!(trailing_hyphen_host, "https://bad-.test", Malformed);
denied!(encoded_host_delimiter, "https://example%2ftest", Malformed);
denied!(truncated_escape, "https://example.test/%", Malformed);
denied!(short_escape, "https://example.test/%2", Malformed);
denied!(nonhex_escape, "https://example.test/%xx", Malformed);

macro_rules! valid {
    ($name:ident, $raw:expr, $normalized:expr) => {
        #[test]
        fn $name() {
            let policy = PublicUrlPolicy::default();
            let admitted = policy.admit($raw).unwrap();
            assert_eq!(admitted.locator(), $normalized);
            assert_eq!(
                admitted.cache_key(),
                policy.admit($normalized).unwrap().cache_key()
            );
            let mut transport = PreparedTransport::default();
            transport.resolve(&policy, $raw).unwrap();
            assert_eq!(transport.calls, 1);
        }
    };
}
valid!(http_default, "http://example.test", "http://example.test/");
valid!(
    https_case_default_port,
    "HTTPS://EXAMPLE.TEST:443/a",
    "https://example.test/a"
);
valid!(
    http_explicit_default_port,
    "http://EXAMPLE.TEST:80/a",
    "http://example.test/a"
);
valid!(
    idna,
    "https://bücher.test/你好",
    "https://xn--bcher-kva.test/%E4%BD%A0%E5%A5%BD"
);
valid!(
    encoded_spaces,
    "https://example.test/a%20b?q=a%20b",
    "https://example.test/a%20b?q=a%20b"
);
valid!(
    encoded_separators,
    "https://example.test/a%2Fb?x=%26%3D",
    "https://example.test/a%2Fb?x=%26%3D"
);
valid!(
    query_order_duplicates,
    "https://example.test/?b=2&a=1&a=3",
    "https://example.test/?b=2&a=1&a=3"
);
valid!(
    plus_semantics,
    "https://example.test/a+b?q=a+b",
    "https://example.test/a+b?q=a+b"
);
valid!(
    query_url_is_inert,
    "https://example.test/?next=https://user:secret@evil.test",
    "https://example.test/?next=https://user:secret@evil.test"
);
valid!(
    empty_query,
    "https://example.test/?",
    "https://example.test/?"
);
valid!(
    root_dot_preserved,
    "https://example.test./a",
    "https://example.test./a"
);
valid!(
    standard_dot_segments,
    "https://example.test/a/../b/./c",
    "https://example.test/b/c"
);
valid!(
    ipv4_canonicalization_for_egress,
    "http://0x7f000001",
    "http://127.0.0.1/"
);
valid!(
    ipv6_canonicalization_for_egress,
    "https://[2001:4860:4860:0000:0000:0000:0000:8888]",
    "https://[2001:4860:4860::8888]/"
);

#[test]
fn exact_host_allowlist_cannot_be_spoofed() {
    let policy = PublicUrlPolicy::default()
        .with_allowed_hosts(&["EXAMPLE.test", "bücher.test", "[2001:4860:4860::8888]"])
        .unwrap();
    for raw in [
        "https://example.test",
        "https://xn--bcher-kva.test",
        "https://[2001:4860:4860::8888]",
    ] {
        assert!(policy.admit(raw).is_ok());
    }
    for raw in [
        "https://example.test.evil.test",
        "https://sub.example.test",
        "https://example.test.",
        "https://evil.test/?example.test",
        "https://127.0.0.1",
    ] {
        let mut transport = PreparedTransport::default();
        assert_eq!(
            transport.resolve(&policy, raw),
            Err(PublicUrlDenial::ForbiddenHost)
        );
        assert_eq!(transport.calls, 0);
    }
    assert_eq!(
        PublicUrlPolicy::default()
            .with_allowed_hosts(&[])
            .unwrap()
            .admit("https://example.test"),
        Err(PublicUrlDenial::ForbiddenHost)
    );
}

#[test]
fn configured_scheme_and_ports_are_finite_and_independent() {
    let policy = PublicUrlPolicy::default()
        .with_ports(PublicScheme::Http, &[])
        .unwrap()
        .with_ports(PublicScheme::Https, &[443, 8443, 443])
        .unwrap();
    assert!(policy.admit("https://example.test:8443").is_ok());
    let mut transport = PreparedTransport::default();
    assert_eq!(
        transport.resolve(&policy, "http://example.test"),
        Err(PublicUrlDenial::ForbiddenScheme)
    );
    assert_eq!(
        transport.resolve(&policy, "https://example.test:8080"),
        Err(PublicUrlDenial::ForbiddenPort)
    );
    assert_eq!(transport.calls, 0);
    assert_eq!(
        PublicUrlPolicy::default().with_ports(PublicScheme::Http, &[0]),
        Err(PublicUrlPolicyError::InvalidPorts)
    );
    assert_eq!(
        PublicUrlPolicy::default().with_ports(PublicScheme::Https, &[443; 257]),
        Err(PublicUrlPolicyError::InvalidPorts)
    );
}

#[test]
fn invalid_host_configuration_never_falls_back_to_all_hosts() {
    for host in [
        "",
        "bad_host.test",
        "example..test",
        "-example.test",
        "https://example.test",
        "example.test:443",
        "user@example.test",
        "example.test/path",
        "example.test?x",
        "example.test#x",
        "exam%70le.test",
        "*.test",
        "example.test\n",
    ] {
        assert_eq!(
            PublicUrlPolicy::default().with_allowed_hosts(&[host]),
            Err(PublicUrlPolicyError::InvalidHost)
        );
    }
    assert_eq!(
        PublicUrlPolicy::default().with_allowed_hosts(&["example.test"; 257]),
        Err(PublicUrlPolicyError::TooManyHosts)
    );
}

#[test]
fn both_raw_and_normalized_byte_limits_are_enforced_before_transport() {
    assert_eq!(
        PublicUrlPolicy::default().with_max_bytes(0),
        Err(PublicUrlPolicyError::InvalidLimit)
    );
    assert_eq!(
        PublicUrlPolicy::default().with_max_bytes(MAX_PUBLIC_URL_BYTES + 1),
        Err(PublicUrlPolicyError::InvalidLimit)
    );
    let prefix = "https://example.test/";
    let exact = format!(
        "{prefix}{}",
        "a".repeat(MAX_PUBLIC_URL_BYTES - prefix.len())
    );
    assert!(PublicUrlPolicy::default().admit(&exact).is_ok());
    let expanded = format!("{prefix}{}", "é".repeat(2000));
    let small = PublicUrlPolicy::default()
        .with_max_bytes(prefix.len() + 3)
        .unwrap();
    assert!(small.admit(&format!("{prefix}abc")).is_ok());
    for (policy, raw) in [
        (PublicUrlPolicy::default(), format!("{exact}b")),
        (PublicUrlPolicy::default(), expanded),
        (small, format!("{prefix}éé")),
    ] {
        let mut transport = PreparedTransport::default();
        assert_eq!(
            transport.resolve(&policy, &raw),
            Err(PublicUrlDenial::Overlong)
        );
        assert_eq!(transport.calls, 0);
    }
    let long_host = format!("https://{}.test", "a".repeat(64));
    assert_eq!(
        PublicUrlPolicy::default().admit(&long_host),
        Err(PublicUrlDenial::Malformed)
    );
}

#[test]
fn cache_keys_preserve_http_semantics_and_omit_fragment_only() {
    let policy = PublicUrlPolicy::default();
    let base = policy
        .admit("https://example.test/a?q=secret#node-1")
        .unwrap();
    assert_eq!(base.locator(), "https://example.test/a?q=secret#node-1");
    assert_eq!(base.request_url(), "https://example.test/a?q=secret");
    for equivalent in [
        "HTTPS://EXAMPLE.TEST:443/a?q=secret",
        "https://example.test/a?q=secret#node-2",
    ] {
        assert_eq!(
            base.cache_key(),
            policy.admit(equivalent).unwrap().cache_key()
        );
    }
    for distinct in [
        "http://example.test/a?q=secret",
        "https://example.test/A?q=secret",
        "https://example.test/a?q=other",
        "https://example.test/a?q=secret&",
        "https://example.test./a?q=secret",
    ] {
        assert_ne!(
            base.cache_key(),
            policy.admit(distinct).unwrap().cache_key()
        );
    }
    for (a, b) in [
        ("/a%2Fb", "/a/b"),
        ("/?a=1&b=2", "/?b=2&a=1"),
        ("/?q=a+b", "/?q=a%20b"),
        ("/", "/?"),
        ("/a", "/a/"),
    ] {
        assert_ne!(
            policy
                .admit(&format!("https://example.test{a}"))
                .unwrap()
                .cache_key(),
            policy
                .admit(&format!("https://example.test{b}"))
                .unwrap()
                .cache_key()
        );
    }
}

#[test]
fn ordinary_diagnostics_never_contain_path_query_fragment_or_parser_input() {
    let policy = PublicUrlPolicy::default();
    let admitted = policy
        .admit("https://example.test/secret-path?token=secret-query#secret-fragment")
        .unwrap();
    for diagnostic in [
        format!("{admitted:?}"),
        format!("{admitted}"),
        format!("{:?}", admitted.cache_key()),
    ] {
        for secret in ["secret-path", "secret-query", "secret-fragment", "token="] {
            assert!(!diagnostic.contains(secret));
        }
    }
    let reason = policy
        .admit("https://user:secret-password@example.test/")
        .unwrap_err();
    assert_eq!(reason.state(), LinkState::Forbidden);
    assert!(!format!("{reason:?} {reason}").contains("secret-password"));
    assert_eq!(
        policy.admit("javascript:secret").unwrap_err().state(),
        LinkState::Unsupported
    );
}

fn request(raw: &str) -> LinkRequest {
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
            readonly: true,
            capabilities: LinkCapabilities {
                public_metadata: true,
                private_lookup: false,
                title: true,
                icon: true,
                preview: false,
                activate: false,
                publish_metadata: false,
            },
        },
        target: LinkTarget::PublicUrl(raw.into()),
        policy: EnrichmentPolicy::LocalPaste,
        origin: LinkOrigin::LocalPaste,
    }
}

#[test]
fn current_request_authority_policy_and_cancellation_remain_required() {
    let policy = PublicUrlPolicy::default();
    let captured = request("https://example.test/path");
    assert!(
        captured
            .admit_public_url(&captured.host, false, &policy)
            .is_ok()
    );
    let mut calls = PreparedTransport::default();
    for (current, canceled, expected) in [
        (captured.host.clone(), true, LinkState::Canceled),
        (
            {
                let mut h = captured.host.clone();
                h.capabilities.public_metadata = false;
                h
            },
            false,
            LinkState::Forbidden,
        ),
        (
            {
                let mut h = captured.host.clone();
                h.scope.authorized = false;
                h
            },
            false,
            LinkState::Forbidden,
        ),
        (
            {
                let mut h = captured.host.clone();
                h.principal = "principal:2".into();
                h
            },
            false,
            LinkState::Forbidden,
        ),
        (
            {
                let mut h = captured.host.clone();
                h.tenant = "tenant:2".into();
                h
            },
            false,
            LinkState::Forbidden,
        ),
        (
            {
                let mut h = captured.host.clone();
                h.policy_revision = "policy:2".into();
                h
            },
            false,
            LinkState::Stale,
        ),
        (
            {
                let mut h = captured.host.clone();
                h.scope.permission = "permission:2".into();
                h
            },
            false,
            LinkState::Forbidden,
        ),
    ] {
        let result = captured.admit_public_url(&current, canceled, &policy);
        if let Ok(admitted) = &result {
            calls.lookup(admitted);
        }
        assert_eq!(result.unwrap_err().state(), expected);
    }
    for origin in [
        LinkOrigin::Open,
        LinkOrigin::Render,
        LinkOrigin::Remote,
        LinkOrigin::Replay,
        LinkOrigin::History,
    ] {
        let mut captured = captured.clone();
        captured.origin = origin;
        assert_eq!(
            captured
                .admit_public_url(&captured.host, false, &policy)
                .unwrap_err()
                .state(),
            LinkState::Unavailable
        );
    }
    assert_eq!(calls.calls, 0);
    let mut private = captured.clone();
    private.host.capabilities.private_lookup = true;
    private.target = LinkTarget::Private(
        Locator::parse("ac://team/71000000-0000-4000-8000-000000000008").unwrap(),
    );
    assert_eq!(
        private.admit_public_url(&private.host, false, &policy),
        Err(PublicRequestDenial::Request(LinkState::Unsupported))
    );
}

#[test]
fn url_admission_is_inert_and_grants_no_document_or_activation_access() {
    let document = support::document();
    let before = document.checkpoint().bytes;
    let captured = request("https://example.test/?principal=admin&tenant=other&publish=true");
    let policy = PublicUrlPolicy::default();
    let admitted = captured
        .admit_public_url(&captured.host, false, &policy)
        .unwrap();
    assert_eq!(admitted.scheme(), PublicScheme::Https);
    assert_eq!(admitted.port(), 443);
    assert_eq!(captured.host.principal, "principal:1");
    assert_eq!(captured.host.tenant, "tenant:1");
    assert!(captured.host.readonly);
    assert!(!captured.host.capabilities.activate);
    assert!(!captured.host.capabilities.publish_metadata);
    assert_eq!(document.checkpoint().bytes, before);
    let mut denied = captured.clone();
    denied.target = LinkTarget::PublicUrl("https://user:password@example.test".into());
    assert_eq!(
        denied
            .admit_public_url(&denied.host, false, &policy)
            .unwrap_err()
            .state(),
        LinkState::Forbidden
    );
    assert_eq!(document.checkpoint().bytes, before);
}
