//! Canonical prepared integration: real URL admission + egress controller +
//! pinned host transport + streamed HTTP. No sockets, credentials or providers.
use editac_session::links::{egress::*, public_url::*};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    rc::Rc,
};

#[derive(Clone, Default)]
struct Clock(Rc<Cell<u64>>);
impl EgressClock for Clock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}
impl Clock {
    fn wait(&self, delay: u64, deadline: u64) -> Result<(), EgressError> {
        let end = self.now_ms() + delay;
        self.0.set(end.min(deadline));
        if end >= deadline {
            Err(EgressError::Timeout)
        } else {
            Ok(())
        }
    }
}
#[derive(Default)]
struct Trace {
    dns: Vec<String>,
    dials: Vec<SocketAddr>,
    sent: Vec<(String, Vec<(String, String)>)>,
    closed: usize,
    reads: Vec<usize>,
    deadlines: Vec<u64>,
    active: usize,
}
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: VecDeque<Vec<u8>>,
}
impl Reply {
    fn html(body: &[u8]) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "text/html; charset=utf-8".into())],
            chunks: [body.to_vec()].into(),
        }
    }
    fn redirect(location: &str) -> Self {
        Self {
            status: 302,
            headers: vec![
                ("Location".into(), location.into()),
                ("Set-Cookie".into(), "session=prepared-secret".into()),
            ],
            chunks: VecDeque::new(),
        }
    }
}
struct Prepared {
    clock: Clock,
    trace: Rc<RefCell<Trace>>,
    dns: VecDeque<Vec<IpAddr>>,
    replies: VecDeque<Reply>,
    peer: Option<SocketAddr>,
    dns_delay: u64,
    connect_delay: u64,
    head_delay: u64,
    read_delay: u64,
    late_head: bool,
    failure: Option<&'static str>,
    // Simulate a host that also owns a private authenticated client. PublicGet
    // accepts neither this client's headers nor a cookie jar.
    ambient: Vec<(String, String)>,
}
impl Default for Prepared {
    fn default() -> Self {
        Self {
            clock: Clock::default(),
            trace: Rc::default(),
            dns: [vec!["93.184.215.14".parse().unwrap()]].into(),
            replies: [Reply::html(b"<title>fixture</title>")].into(),
            peer: None,
            dns_delay: 0,
            connect_delay: 0,
            head_delay: 0,
            read_delay: 0,
            late_head: false,
            failure: None,
            ambient: vec![
                ("Authorization".into(), "Bearer prepared-secret".into()),
                ("Cookie".into(), "private=prepared-secret".into()),
                ("Proxy-Authorization".into(), "prepared-secret".into()),
                ("Referer".into(), "https://private.test/secret".into()),
            ],
        }
    }
}
struct Connection {
    clock: Clock,
    trace: Rc<RefCell<Trace>>,
    peer: SocketAddr,
    reply: Reply,
    head_delay: u64,
    read_delay: u64,
    late_head: bool,
    failure: Option<&'static str>,
}
impl PublicTransport for Prepared {
    type Connection = Connection;
    fn resolve(
        &mut self,
        host: &str,
        deadline: u64,
        max: usize,
    ) -> Result<Vec<IpAddr>, EgressError> {
        self.trace.borrow_mut().dns.push(host.to_owned());
        self.clock.wait(self.dns_delay, deadline)?;
        if self.failure == Some("dns") {
            return Err(EgressError::Dns);
        }
        let result = self
            .dns
            .pop_front()
            .expect("unexpected second DNS resolution");
        assert!(max <= 64);
        Ok(result)
    }
    fn connect(
        &mut self,
        target: PinnedTarget<'_>,
        deadline: u64,
    ) -> Result<Connection, EgressError> {
        assert!(
            public_address(target.address().ip()),
            "denied dial instruction"
        );
        assert_eq!(target.address().port(), target.url().port());
        self.trace.borrow_mut().deadlines.push(deadline);
        self.clock.wait(self.connect_delay, deadline)?;
        if self.failure == Some("connect") {
            return Err(EgressError::Transport);
        }
        let mut trace = self.trace.borrow_mut();
        trace.dials.push(target.address());
        trace.active += 1;
        assert_eq!(trace.active, 1, "previous redirect connection not closed");
        Ok(Connection {
            clock: self.clock.clone(),
            trace: self.trace.clone(),
            peer: self.peer.unwrap_or(target.address()),
            reply: self.replies.pop_front().unwrap(),
            head_delay: self.head_delay,
            read_delay: self.read_delay,
            late_head: self.late_head,
            failure: self.failure,
        })
    }
}
impl PublicConnection for Connection {
    fn peer_addr(&self) -> Result<SocketAddr, EgressError> {
        if self.failure == Some("peer") {
            Err(EgressError::Transport)
        } else {
            Ok(self.peer)
        }
    }
    fn get(
        &mut self,
        req: PublicGet<'_>,
        deadline: u64,
        max: usize,
    ) -> Result<ResponseHead, EgressError> {
        assert_eq!(req.method(), "GET");
        assert_eq!(
            req.headers(),
            [
                ("Accept", "text/html, application/xhtml+xml"),
                ("Accept-Encoding", "identity")
            ]
        );
        self.trace.borrow_mut().sent.push((
            req.url().request_url().to_owned(),
            req.headers()
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .into(),
        ));
        if self.late_head {
            self.clock.0.set(deadline);
        } else {
            self.clock.wait(self.head_delay, deadline)?;
        }
        if self.failure == Some("head") {
            return Err(EgressError::Transport);
        }
        assert!(max <= 32_768);
        Ok(ResponseHead {
            status: self.reply.status,
            headers: std::mem::take(&mut self.reply.headers),
        })
    }
    fn read(&mut self, deadline: u64, max: usize) -> Result<Option<Vec<u8>>, EgressError> {
        let mut trace = self.trace.borrow_mut();
        trace.reads.push(max);
        trace.deadlines.push(deadline);
        drop(trace);
        self.clock.wait(self.read_delay, deadline)?;
        if self.failure == Some("read") {
            return Err(EgressError::Transport);
        }
        // Split at the actual caller cap: this fixture models a bounded reader,
        // rather than returning an oversized response then counting after EOF.
        Ok(self.reply.chunks.pop_front().map(|mut chunk| {
            if chunk.len() > max {
                let rest = chunk.split_off(max);
                self.reply.chunks.push_front(rest);
            }
            chunk
        }))
    }
    fn close(&mut self) {
        let mut t = self.trace.borrow_mut();
        t.closed += 1;
        t.active -= 1;
    }
}
fn fetch(p: &mut Prepared, limits: EgressLimits, raw: &str) -> Result<PublicResponse, EgressError> {
    let clock = p.clock.clone();
    PublicEgress::new(PublicUrlPolicy::default(), limits)
        .unwrap()
        .fetch(p, &clock, raw)
}
fn denied(raw: &str, dns: Option<Vec<IpAddr>>, expected: EgressError) {
    let mut p = Prepared::default();
    if let Some(dns) = dns {
        p.dns = [dns].into();
    }
    assert_eq!(
        fetch(&mut p, EgressLimits::default(), raw).err(),
        Some(expected)
    );
    let t = p.trace.borrow();
    assert!(t.dials.is_empty());
    assert!(t.sent.is_empty());
    assert_eq!(t.active, 0);
}
macro_rules! denied_address {
    ($name:ident, $ip:literal) => {
        #[test]
        fn $name() {
            let ip: IpAddr = $ip.parse().unwrap();
            let url = match ip {
                IpAddr::V4(ip) => format!("https://{ip}/"),
                IpAddr::V6(ip) => format!("https://[{ip}]/"),
            };
            denied(&url, None, EgressError::AddressDenied);
            denied(
                "https://public.test/",
                Some(vec![ip]),
                EgressError::AddressDenied,
            );
        }
    };
}
denied_address!(unspecified4, "0.0.0.0");
denied_address!(zero_network, "0.8.2.3");
denied_address!(private10, "10.1.2.3");
denied_address!(cgn_start, "100.64.0.0");
denied_address!(alibaba_metadata, "100.100.100.200");
denied_address!(cgn_end, "100.127.255.255");
denied_address!(loopback4, "127.0.0.1");
denied_address!(metadata4, "169.254.169.254");
denied_address!(linklocal4, "169.254.0.1");
denied_address!(private172_start, "172.16.0.0");
denied_address!(private172_end, "172.31.255.255");
denied_address!(protocol_assignments, "192.0.0.9");
denied_address!(documentation4a, "192.0.2.1");
denied_address!(six_to_four_relay, "192.88.99.1");
denied_address!(private192, "192.168.0.1");
denied_address!(benchmark_start, "198.18.0.0");
denied_address!(benchmark_end, "198.19.255.255");
denied_address!(documentation4b, "198.51.100.1");
denied_address!(documentation4c, "203.0.113.1");
denied_address!(azure_platform, "168.63.129.16");
denied_address!(multicast4, "224.0.0.1");
denied_address!(reserved4, "240.0.0.1");
denied_address!(broadcast4, "255.255.255.255");
denied_address!(unspecified6, "::");
denied_address!(loopback6, "::1");
denied_address!(mapped_private, "::ffff:192.168.1.1");
denied_address!(mapped_public, "::ffff:8.8.8.8");
denied_address!(compatible4, "::127.0.0.1");
denied_address!(nat64, "64:ff9b::a9fe:a9fe");
denied_address!(nat64_local, "64:ff9b:1::1");
denied_address!(discard6, "100::1");
denied_address!(teredo, "2001::1");
denied_address!(benchmark6, "2001:2::1");
denied_address!(orchid6, "2001:20::1");
denied_address!(documentation6, "2001:db8::1");
denied_address!(six_to_four, "2002:7f00:1::");
denied_address!(documentation6_new, "3fff:fff::1");
denied_address!(unique_local, "fc00::1");
denied_address!(unique_local_end, "fdff::1");
denied_address!(metadata6, "fd00:ec2::254");
denied_address!(linklocal6, "fe80::1");
denied_address!(site_local6, "fec0::1");
denied_address!(multicast6, "ff02::1");

#[test]
fn numeric_encodings_are_normalized_before_dial() {
    for url in [
        "https://2130706433",
        "https://0x7f000001",
        "https://0177.0.0.1",
        "https://127.1",
        "https://0xa9fea9fe",
    ] {
        denied(url, None, EgressError::AddressDenied);
    }
}
#[test]
fn malformed_and_credential_urls_never_reach_dns() {
    for raw in [
        "https://user:secret@public.test/",
        "file:///etc/passwd",
        "https://public.test:22/",
        "https://",
    ] {
        let mut p = Prepared::default();
        assert!(fetch(&mut p, EgressLimits::default(), raw).is_err());
        assert!(p.trace.borrow().dns.is_empty());
        assert!(p.trace.borrow().dials.is_empty());
    }
}
#[test]
fn mixed_dns_answer_is_denied_before_any_connection() {
    denied(
        "https://public.test",
        Some(vec![
            "8.8.8.8".parse().unwrap(),
            "127.0.0.1".parse().unwrap(),
        ]),
        EgressError::AddressDenied,
    );
}
#[test]
fn bounded_dns_answers() {
    for dns in [vec![], vec!["8.8.8.8".parse().unwrap(); 17]] {
        denied("https://public.test", Some(dns), EgressError::Dns);
    }
}
#[test]
fn dns_rebinding_cannot_trigger_second_unrestricted_resolution() {
    let mut p = Prepared::default();
    p.dns.push_back(vec!["127.0.0.1".parse().unwrap()]);
    let response = fetch(
        &mut p,
        EgressLimits::default(),
        "https://public.test/path?q=kept#fragment",
    )
    .unwrap();
    assert_eq!(response.body, b"<title>fixture</title>");
    let t = p.trace.borrow();
    assert_eq!(t.dns, ["public.test"]);
    assert_eq!(p.dns.len(), 1);
    assert_eq!(
        t.dials,
        ["93.184.215.14:443".parse::<SocketAddr>().unwrap()]
    );
    assert_eq!(t.sent[0].0, "https://public.test/path?q=kept");
    assert_eq!(t.closed, 1);
    assert_eq!(t.active, 0);
}
#[test]
fn wrong_actual_peer_never_receives_http() {
    for peer in ["127.0.0.1:443", "8.8.8.8:443", "93.184.215.14:80"] {
        let mut p = Prepared {
            peer: Some(peer.parse().unwrap()),
            ..Prepared::default()
        };
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::PeerMismatch)
        );
        assert!(p.trace.borrow().sent.is_empty());
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
#[test]
fn public_ipv4_ipv6_and_configured_ports_work() {
    for raw in [
        "https://8.8.8.8",
        "https://[2606:4700:4700::1111]",
        "http://1.1.1.1:8080/path",
    ] {
        let mut p = Prepared::default();
        let policy = PublicUrlPolicy::default()
            .with_ports(PublicScheme::Http, &[8080])
            .unwrap();
        let clock = p.clock.clone();
        let response = PublicEgress::new(policy, EgressLimits::default())
            .unwrap()
            .fetch(&mut p, &clock, raw)
            .unwrap();
        assert!(!response.body.is_empty());
        assert!(p.trace.borrow().dns.is_empty());
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
fn redirects() -> EgressLimits {
    EgressLimits {
        max_redirects: 2,
        ..EgressLimits::default()
    }
}
#[test]
fn redirects_disabled_by_default() {
    let mut p = Prepared::default();
    p.replies = [Reply::redirect("https://other.test/")].into();
    assert_eq!(
        fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
        Some(EgressError::RedirectDenied)
    );
    assert_eq!(p.trace.borrow().dns.len(), 1);
    assert_eq!(p.trace.borrow().dials.len(), 1);
    assert_eq!(p.trace.borrow().closed, 1);
}
#[test]
fn every_redirect_rechecks_url_and_address_without_dialing_denied_hop() {
    for location in [
        "http://169.254.169.254/latest",
        "https://[::1]",
        "https://0x7f000001",
    ] {
        let mut p = Prepared::default();
        p.replies = [Reply::redirect(location)].into();
        assert_eq!(
            fetch(&mut p, redirects(), "https://public.test").err(),
            Some(EgressError::AddressDenied)
        );
        assert_eq!(p.trace.borrow().dials.len(), 1);
        assert_eq!(p.trace.borrow().sent.len(), 1);
        assert_eq!(p.trace.borrow().active, 0);
    }
}
#[test]
fn same_host_redirect_rebinding_is_denied() {
    let mut p = Prepared::default();
    p.dns.push_back(vec!["10.0.0.1".parse().unwrap()]);
    p.replies = [Reply::redirect("/next")].into();
    assert_eq!(
        fetch(&mut p, redirects(), "https://public.test").err(),
        Some(EgressError::AddressDenied)
    );
    assert_eq!(p.trace.borrow().dns, ["public.test", "public.test"]);
    assert_eq!(p.trace.borrow().dials.len(), 1);
}
#[test]
fn redirect_scheme_credentials_port_and_allowlist_are_rechecked() {
    for location in [
        "file:///private",
        "https://u:p@public.test",
        "https://public.test:22",
        "https://other.test",
    ] {
        let mut p = Prepared::default();
        p.replies = [Reply::redirect(location)].into();
        let policy = PublicUrlPolicy::default()
            .with_allowed_hosts(&["public.test"])
            .unwrap();
        let clock = p.clock.clone();
        assert!(matches!(
            PublicEgress::new(policy, redirects())
                .unwrap()
                .fetch(&mut p, &clock, "https://public.test")
                .err(),
            Some(EgressError::Url(_))
        ));
        assert_eq!(p.trace.borrow().dials.len(), 1);
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
#[test]
fn initial_allowlist_denial_has_zero_dns_and_connections() {
    let mut p = Prepared::default();
    let clock = p.clock.clone();
    let policy = PublicUrlPolicy::default().with_allowed_hosts(&[]).unwrap();
    assert!(
        PublicEgress::new(policy, redirects())
            .unwrap()
            .fetch(&mut p, &clock, "https://public.test")
            .is_err()
    );
    assert!(p.trace.borrow().dns.is_empty());
    assert!(p.trace.borrow().dials.is_empty());
}
#[test]
fn enabled_cross_origin_and_relative_redirects_never_forward_credentials() {
    let mut p = Prepared::default();
    p.dns.extend([
        vec!["8.8.8.8".parse().unwrap()],
        vec!["1.1.1.1".parse().unwrap()],
    ]);
    p.replies = [
        Reply::redirect("https://other.test/a"),
        Reply::redirect("../b"),
        Reply::html(b"final"),
    ]
    .into();
    assert!(!p.ambient.is_empty());
    let response = fetch(
        &mut p,
        redirects(),
        "https://public.test/start?secret=fixture",
    )
    .unwrap();
    assert_eq!(response.redirects, 2);
    assert_eq!(response.url.locator(), "https://other.test/b");
    let t = p.trace.borrow();
    assert_eq!(t.closed, 3);
    assert_eq!(t.active, 0);
    for (_, headers) in &t.sent {
        assert_eq!(headers.len(), 2);
        assert!(!headers.iter().any(|(k, v)| {
            p.ambient.iter().any(|(a, _)| k.eq_ignore_ascii_case(a))
                || v.contains("prepared-secret")
        }));
    }
}
#[test]
fn redirect_cycles_stop_at_finite_hop_limit() {
    let mut p = Prepared::default();
    p.dns.extend(vec![vec!["8.8.8.8".parse().unwrap()]; 2]);
    p.replies = [
        Reply::redirect("/a"),
        Reply::redirect("/b"),
        Reply::redirect("/a"),
    ]
    .into();
    assert_eq!(
        fetch(&mut p, redirects(), "https://public.test").err(),
        Some(EgressError::RedirectLimit)
    );
    assert_eq!(p.trace.borrow().sent.len(), 3);
    assert_eq!(p.trace.borrow().closed, 3);
}
#[test]
fn all_supported_redirect_statuses_use_the_same_admission() {
    for status in [301, 302, 303, 307, 308] {
        let mut p = Prepared::default();
        let mut reply = Reply::redirect("http://127.0.0.1");
        reply.status = status;
        p.replies = [reply].into();
        assert_eq!(
            fetch(&mut p, redirects(), "https://public.test").err(),
            Some(EgressError::AddressDenied)
        );
        assert_eq!(p.trace.borrow().dials.len(), 1);
    }
}
#[test]
fn declared_oversize_aborts_before_reading() {
    let mut p = Prepared::default();
    p.replies[0]
        .headers
        .push(("Content-Length".into(), "262145".into()));
    assert_eq!(
        fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
        Some(EgressError::TooLarge)
    );
    assert!(p.trace.borrow().reads.is_empty());
    assert_eq!(p.trace.borrow().closed, 1);
}
#[test]
fn streamed_oversize_aborts_at_limit_plus_one_not_full_download() {
    let mut p = Prepared::default();
    p.replies = [Reply::html(&vec![b'x'; 1_000_000])].into();
    let limits = EgressLimits {
        max_bytes: 31,
        ..EgressLimits::default()
    };
    assert_eq!(
        fetch(&mut p, limits, "https://public.test").err(),
        Some(EgressError::TooLarge)
    );
    assert_eq!(p.trace.borrow().reads, [32]);
    assert_eq!(p.trace.borrow().closed, 1);
}
#[test]
fn exact_byte_limit_succeeds_with_bounded_eof_probe() {
    let mut p = Prepared::default();
    p.replies = [Reply::html(b"1234")].into();
    assert_eq!(
        fetch(
            &mut p,
            EgressLimits {
                max_bytes: 4,
                ..EgressLimits::default()
            },
            "https://public.test"
        )
        .unwrap()
        .body,
        b"1234"
    );
    assert_eq!(p.trace.borrow().reads, [5, 1]);
}
#[test]
fn compression_bombs_never_reach_decompression_or_body_reads() {
    for encoding in ["gzip", "br", "deflate", "gzip, br", "unknown", ""] {
        let mut p = Prepared::default();
        p.replies[0]
            .headers
            .push(("Content-Encoding".into(), encoding.into()));
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::EncodedResponse)
        );
        assert!(p.trace.borrow().reads.is_empty());
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
#[test]
fn unsupported_status_and_content_types_never_read_body() {
    for (status, ty) in [
        (200, "application/json"),
        (200, "image/svg+xml"),
        (404, "text/html"),
        (304, "text/html"),
        (206, "text/html"),
    ] {
        let mut p = Prepared::default();
        p.replies[0].status = status;
        p.replies[0].headers[0].1 = ty.into();
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::UnsupportedContent)
        );
        assert!(p.trace.borrow().reads.is_empty());
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
#[test]
fn malformed_duplicate_and_smuggling_headers_abort() {
    for headers in [
        vec![("Content-Length", "5"), ("content-length", "5")],
        vec![("Content-Length", "+5")],
        vec![("Location", "/a\r\nCookie: secret")],
        vec![("Content-Length", "5"), ("Transfer-Encoding", "chunked")],
        vec![("Transfer-Encoding", "gzip")],
        vec![("Content-Type", "text/html"), ("CONTENT-TYPE", "text/html")],
        vec![("Bad Name", "value")],
        vec![("Content-Length", "999999999999999999999999999999999999999")],
    ] {
        let mut p = Prepared::default();
        p.replies[0].headers = headers
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::InvalidHeaders)
        );
        assert!(p.trace.borrow().reads.is_empty());
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
#[test]
fn response_header_bytes_and_count_are_bounded() {
    for headers in [
        vec![("X-Long".into(), "x".repeat(16_384))],
        vec![("X".into(), "v".into()); 129],
    ] {
        let mut p = Prepared::default();
        p.replies[0].headers = headers;
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::InvalidHeaders)
        );
        assert!(p.trace.borrow().reads.is_empty());
    }
}
#[test]
fn truncated_and_extra_content_length_are_rejected() {
    for len in ["1", "100"] {
        let mut p = Prepared::default();
        p.replies[0]
            .headers
            .push(("Content-Length".into(), len.into()));
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::InvalidHeaders)
        );
        assert_eq!(p.trace.borrow().closed, 1);
    }
}
#[test]
fn empty_chunks_cannot_spin_without_bound() {
    let mut p = Prepared::default();
    p.replies[0].chunks = vec![Vec::new(); 10].into();
    assert_eq!(
        fetch(
            &mut p,
            EgressLimits {
                max_chunks: 2,
                ..EgressLimits::default()
            },
            "https://public.test"
        )
        .err(),
        Some(EgressError::TooManyChunks)
    );
    assert_eq!(p.trace.borrow().reads.len(), 3);
    assert_eq!(p.trace.borrow().closed, 1);
}
#[test]
fn slow_dns_and_connect_abort_at_connection_deadline() {
    for stage in ["dns", "connect"] {
        let mut p = Prepared::default();
        if stage == "dns" {
            p.dns_delay = 3000;
        } else {
            p.connect_delay = 3000;
        }
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::Timeout)
        );
        assert_eq!(p.clock.now_ms(), 2000);
        assert!(p.trace.borrow().dials.is_empty());
        assert!(p.trace.borrow().sent.is_empty());
    }
}
#[test]
fn slow_headers_and_body_abort_and_close_at_idle_deadline() {
    for stage in ["head", "read"] {
        let mut p = Prepared::default();
        if stage == "head" {
            p.head_delay = 1001;
        } else {
            p.read_delay = 1001;
        }
        assert_eq!(
            fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
            Some(EgressError::Timeout)
        );
        assert_eq!(p.clock.now_ms(), 1000);
        assert_eq!(p.trace.borrow().closed, 1);
        assert_eq!(p.trace.borrow().active, 0);
    }
}
#[test]
fn dribbling_response_cannot_extend_total_deadline() {
    let mut p = Prepared::default();
    p.read_delay = 900;
    p.replies[0].chunks = vec![vec![b'x']; 100].into();
    assert_eq!(
        fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
        Some(EgressError::Timeout)
    );
    assert_eq!(p.clock.now_ms(), 5000);
    assert_eq!(p.trace.borrow().reads.len(), 6);
    assert_eq!(p.trace.borrow().closed, 1);
}
#[test]
fn redirects_share_total_deadline_instead_of_resetting_it() {
    let mut p = Prepared::default();
    p.head_delay = 900;
    p.connect_delay = 1200;
    p.dns.extend(vec![vec!["8.8.8.8".parse().unwrap()]; 2]);
    p.replies = [
        Reply::redirect("/a"),
        Reply::redirect("/b"),
        Reply::html(b"done"),
    ]
    .into();
    assert_eq!(
        fetch(&mut p, redirects(), "https://public.test").err(),
        Some(EgressError::Timeout)
    );
    assert_eq!(p.clock.now_ms(), 5000);
    assert_eq!(p.trace.borrow().closed, 2);
    assert_eq!(p.trace.borrow().sent.len(), 2);
}
#[test]
fn late_adapter_result_is_rejected_before_body() {
    let mut p = Prepared {
        late_head: true,
        ..Prepared::default()
    };
    assert_eq!(
        fetch(&mut p, EgressLimits::default(), "https://public.test").err(),
        Some(EgressError::Timeout)
    );
    assert!(p.trace.borrow().reads.is_empty());
    assert_eq!(p.trace.borrow().closed, 1);
}
#[test]
fn transport_failures_close_every_open_connection() {
    for stage in ["dns", "connect", "peer", "head", "read"] {
        let mut p = Prepared {
            failure: Some(stage),
            ..Prepared::default()
        };
        assert!(fetch(&mut p, EgressLimits::default(), "https://public.test").is_err());
        assert_eq!(p.trace.borrow().active, 0);
        assert_eq!(
            p.trace.borrow().closed,
            usize::from(!matches!(stage, "dns" | "connect"))
        );
    }
}
#[test]
fn invalid_and_unbounded_limits_are_rejected_before_transport() {
    let base = EgressLimits::default();
    for limits in [
        EgressLimits {
            connect_ms: 0,
            ..base
        },
        EgressLimits {
            total_ms: 30_001,
            ..base
        },
        EgressLimits { idle_ms: 0, ..base },
        EgressLimits {
            max_bytes: 0,
            ..base
        },
        EgressLimits {
            max_header_bytes: 32_769,
            ..base
        },
        EgressLimits {
            max_dns_addresses: 65,
            ..base
        },
        EgressLimits {
            max_chunks: 0,
            ..base
        },
        EgressLimits {
            max_redirects: 6,
            ..base
        },
    ] {
        assert_eq!(
            PublicEgress::new(PublicUrlPolicy::default(), limits)
                .err()
                .unwrap(),
            EgressError::InvalidLimits
        );
    }
}
#[test]
fn ordinary_error_diagnostics_do_not_include_url_or_response_secrets() {
    let mut p = Prepared::default();
    p.replies = [Reply::redirect(
        "https://u:secret@private.test/path?token=secret",
    )]
    .into();
    let error = fetch(&mut p, redirects(), "https://public.test/path?token=secret")
        .err()
        .unwrap();
    assert!(!format!("{error:?}").contains("secret"));
    assert!(!format!("{error:?}").contains("private.test"));
}
