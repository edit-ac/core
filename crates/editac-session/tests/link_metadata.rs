//! Canonical prepared integration: real URL/egress/parser/secondary egress.
//! No sockets, provider transports, credentials or browser requests.
use editac_session::links::{
    LinkMetadata, MAX_DESCRIPTION, MAX_TEXT, egress::*, metadata::*, public_url::*,
};
use std::{
    cell::RefCell,
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    rc::Rc,
};
#[derive(Default)]
struct Trace {
    dials: usize,
    gets: usize,
    reads: usize,
    closed: usize,
}
struct Clock;
impl EgressClock for Clock {
    fn now_ms(&self) -> u64 {
        0
    }
}
struct Reply {
    mime: String,
    body: Vec<u8>,
    redirect: Option<String>,
    encoding: Option<String>,
}
impl Reply {
    fn new(mime: &str, body: &[u8]) -> Self {
        Self {
            mime: mime.into(),
            body: body.into(),
            redirect: None,
            encoding: None,
        }
    }
}
struct Transport {
    ip: IpAddr,
    replies: VecDeque<Reply>,
    trace: Rc<RefCell<Trace>>,
}
impl Transport {
    fn new(replies: Vec<Reply>) -> Self {
        Self {
            ip: "93.184.215.14".parse().unwrap(),
            replies: replies.into(),
            trace: Rc::default(),
        }
    }
}
struct Connection {
    peer: SocketAddr,
    reply: Reply,
    trace: Rc<RefCell<Trace>>,
}
impl PublicTransport for Transport {
    type Connection = Connection;
    fn resolve(&mut self, _: &str, _: u64, _: usize) -> Result<Vec<IpAddr>, EgressError> {
        Ok(vec![self.ip])
    }
    fn connect(&mut self, target: PinnedTarget<'_>, _: u64) -> Result<Connection, EgressError> {
        self.trace.borrow_mut().dials += 1;
        Ok(Connection {
            peer: target.address(),
            reply: self.replies.pop_front().expect("unexpected outbound call"),
            trace: self.trace.clone(),
        })
    }
}
impl PublicConnection for Connection {
    fn peer_addr(&self) -> Result<SocketAddr, EgressError> {
        Ok(self.peer)
    }
    fn get(
        &mut self,
        request: PublicGet<'_>,
        _: u64,
        _: usize,
    ) -> Result<ResponseHead, EgressError> {
        self.trace.borrow_mut().gets += 1;
        assert_eq!(request.method(), "GET");
        assert!(
            request
                .headers()
                .iter()
                .all(|(k, _)| !matches!(*k, "cookie" | "authorization"))
        );
        let mut headers = vec![("content-type".into(), self.reply.mime.clone())];
        if let Some(location) = &self.reply.redirect {
            headers.push(("location".into(), location.clone()));
        }
        if let Some(encoding) = &self.reply.encoding {
            headers.push(("content-encoding".into(), encoding.clone()));
        }
        Ok(ResponseHead {
            status: if self.reply.redirect.is_some() {
                302
            } else {
                200
            },
            headers,
        })
    }
    fn read(&mut self, _: u64, max: usize) -> Result<Option<Vec<u8>>, EgressError> {
        self.trace.borrow_mut().reads += 1;
        if self.reply.body.is_empty() {
            return Ok(None);
        }
        let n = max.min(self.reply.body.len());
        Ok(Some(self.reply.body.drain(..n).collect()))
    }
    fn close(&mut self) {
        self.trace.borrow_mut().closed += 1;
    }
}
fn egress(policy: PublicUrlPolicy) -> PublicEgress {
    PublicEgress::new(policy, EgressLimits::default()).unwrap()
}
fn parsed(html: &[u8]) -> ParsedMetadata {
    let policy = PublicUrlPolicy::default();
    let url = policy
        .admit("https://public.example/original?secret=value#anchor")
        .unwrap();
    let response = PublicResponse {
        url: policy.admit("https://public.example/final/page").unwrap(),
        body: html.into(),
        redirects: 0,
    };
    MetadataParser::new(policy).parse(url, &response)
}
fn parsed_str(html: &str) -> ParsedMetadata {
    parsed(html.as_bytes())
}
#[test]
fn declared_fixture_composes_page_parser_and_asset_egress() {
    let policy = PublicUrlPolicy::default();
    let controller = egress(policy.clone());
    let mut transport = Transport::new(vec![
        Reply::new(
            "text/html; charset=utf-8",
            include_bytes!("../../../fixtures/links/html/declared.html"),
        ),
        Reply::new("image/png", b"prepared-png"),
        Reply::new("image/webp", b"prepared-webp"),
    ]);
    let requested = policy
        .admit("https://public.example/original?secret=value")
        .unwrap();
    let response = controller
        .fetch(&mut transport, &Clock, requested.locator())
        .unwrap();
    let out = MetadataParser::new(policy).parse(requested, &response);
    assert_eq!(out.display.title, "Public & safe 😀");
    assert_eq!(out.display.description.as_deref(), Some("Line one two"));
    assert_eq!(
        out.requested.locator(),
        "https://public.example/original?secret=value"
    );
    assert_eq!(
        out.canonical.as_ref().unwrap().locator(),
        "https://public.example/advisory?view=1&sort=2"
    );
    assert!(out.display.icon_asset.is_none() && out.display.image_asset.is_none());
    assert_eq!(
        out.icon
            .as_ref()
            .unwrap()
            .fetch(&controller, &mut transport, &Clock)
            .unwrap(),
        b"prepared-png"
    );
    assert_eq!(
        out.image
            .as_ref()
            .unwrap()
            .fetch(&controller, &mut transport, &Clock)
            .unwrap(),
        b"prepared-webp"
    );
    assert_eq!(transport.trace.borrow().gets, 3);
    assert_eq!(transport.trace.borrow().closed, 3);
    let LinkMetadata::Public {
        requested_url,
        display,
        ..
    } = out.into_metadata()
    else {
        panic!()
    };
    assert!(requested_url.contains("/original"));
    assert!(display.icon_asset.is_none());
}
#[test]
fn hostile_fixture_is_inert_and_no_asset_is_automatically_fetched() {
    let out = parsed(include_bytes!("../../../fixtures/links/html/hostile.html"));
    assert_eq!(out.display.title, "Safe title");
    assert!(out.canonical.is_none() && out.image.is_none());
    assert!(out.icon.is_some()); // syntax token is NOT address permission
    let mut transport = Transport::new(vec![]);
    assert_eq!(
        out.icon
            .unwrap()
            .fetch(&egress(PublicUrlPolicy::default()), &mut transport, &Clock),
        Err(EgressError::AddressDenied)
    );
    assert_eq!(transport.trace.borrow().dials, 0);
}
macro_rules! title_case {
    ($name:ident, $html:expr, $expected:expr) => {
        #[test]
        fn $name() {
            assert_eq!(parsed_str($html).display.title, $expected);
        }
    };
}
title_case!(plain_title, "<title>Hello</title>", "Hello");
title_case!(
    case_and_unquoted,
    "<META CONTENT='OG wins' PROPERTY=OG:TITLE><TITLE>Other</TITLE>",
    "OG wins"
);
title_case!(
    first_declared_wins,
    "<meta property='og:title' content=First><meta property='og:title' content=Second>",
    "First"
);
title_case!(
    entity_single_decode,
    "<title>&amp;lt; &#128512; &unknown;</title>",
    "&lt; 😀 &unknown;"
);
title_case!(
    quoted_greater_than,
    "<meta property='og:title' content='A > B'>",
    "A > B"
);
title_case!(
    controls_and_bidi,
    "<title>A\0\u{202e}B\n  C\u{200b}</title>",
    "AB C"
);
title_case!(empty_fallback, "<title>  </title>", "public.example");
title_case!(body_ignored, "<body><title>evil</title>", "public.example");
title_case!(
    unknown_body_element_stops,
    "<div><title>evil</title>",
    "public.example"
);
title_case!(
    comment_ignored,
    "<!--<title>evil</title>--><title>Good</title>",
    "Good"
);
title_case!(
    raw_script_ignored,
    "<script>var x='<title>evil</title>'</script><title>Good</title>",
    "Good"
);
title_case!(
    unclosed_script_fallback,
    "<script><title>evil</title>",
    "public.example"
);
title_case!(
    malformed_quote_fallback,
    "<meta content='broken><title>evil</title>",
    "public.example"
);
title_case!(
    duplicate_attribute_fallback,
    "<meta property='og:title' content=one content=two>",
    "public.example"
);
title_case!(
    markup_in_title_fallback,
    "<title>A<b>B</b></title>",
    "public.example"
);
title_case!(
    closed_head_stops,
    "<title>Good</title></head><meta property='og:title' content=evil>",
    "Good"
);
title_case!(
    invalid_numeric_entity,
    "<title>&#xD800; &#99999999999;</title>",
    "� �"
);
#[test]
fn invalid_utf8_falls_back() {
    assert!(parsed(&[255, 0]).fallback);
}
#[test]
fn oversized_html_falls_back_without_partial_hints() {
    assert!(
        parsed_str(&format!(
            "<title>Good</title>{}",
            "x".repeat(MAX_HTML_BYTES)
        ))
        .fallback
    );
}
#[test]
fn huge_tag_falls_back() {
    assert!(
        parsed_str(&format!(
            "<meta content='{}' property='og:title'>",
            "x".repeat(MAX_TAG_BYTES)
        ))
        .fallback
    );
}
#[test]
fn many_tags_fall_back() {
    assert!(parsed_str(&"<meta>".repeat(MAX_TAGS + 1)).fallback);
}
#[test]
fn text_limits_preserve_unicode_scalars_and_utf16_caps() {
    let out = parsed_str(&format!(
        "<title>{}</title><meta name=description content='{}'>",
        "😀".repeat(2000),
        "😀".repeat(2000)
    ));
    assert_eq!(out.display.title.encode_utf16().count(), MAX_TEXT);
    assert_eq!(
        out.display.description.unwrap().encode_utf16().count(),
        MAX_DESCRIPTION
    );
}
#[test]
fn relative_urls_use_final_response_not_base_or_canonical() {
    let out = parsed_str(
        "<base href='http://127.0.0.1/'><link rel=canonical href='https://different.example/'><link rel=icon href=icon.png>",
    );
    let mut transport = Transport::new(vec![Reply::new("image/png", b"ok")]);
    out.icon
        .unwrap()
        .fetch(
            &egress(
                PublicUrlPolicy::default()
                    .with_allowed_hosts(&["public.example"])
                    .unwrap(),
            ),
            &mut transport,
            &Clock,
        )
        .unwrap();
    assert_eq!(
        out.requested.locator(),
        "https://public.example/original?secret=value#anchor"
    );
}
macro_rules! denied_hint { ($name:ident, $url:expr) => { #[test] fn $name() {
    let out = parsed_str(&format!("<link rel=icon href='{}'><link rel=canonical href='{}'><meta property='og:image' content='{}'>", $url, $url, $url));
    assert!(out.icon.is_none() && out.canonical.is_none() && out.image.is_none());
} }; }
denied_hint!(javascript_hint, "javascript:alert(1)");
denied_hint!(data_hint, "data:image/png;base64,AA");
denied_hint!(file_hint, "file:///etc/passwd");
denied_hint!(credentials_hint, "https://user:secret@public.example/a");
denied_hint!(entity_obfuscated_hint, "java&#x73;cript:alert(1)");
denied_hint!(control_hint, "https://public.example/&#10;secret");
denied_hint!(disallowed_port_hint, "https://public.example:22/icon");
#[test]
fn allowlist_applies_to_all_hints() {
    let p = PublicUrlPolicy::default()
        .with_allowed_hosts(&["public.example"])
        .unwrap();
    let r = PublicResponse { url: p.admit("https://public.example/").unwrap(), body: b"<link rel=icon href='https://other.example/'><link rel=canonical href='https://other.example/'><meta property='og:image' content='https://other.example/'>".into(), redirects: 0 };
    let out = MetadataParser::new(p.clone()).parse(p.admit("https://public.example/").unwrap(), &r);
    assert!(out.icon.is_none() && out.image.is_none() && out.canonical.is_none());
}
macro_rules! address_denied {
    ($name:ident, $url:expr) => {
        #[test]
        fn $name() {
            let out = parsed_str(&format!("<link rel=icon href='{}'>", $url));
            let mut t = Transport::new(vec![]);
            assert_eq!(
                out.icon
                    .unwrap()
                    .fetch(&egress(PublicUrlPolicy::default()), &mut t, &Clock),
                Err(EgressError::AddressDenied)
            );
            assert_eq!(t.trace.borrow().dials, 0);
        }
    };
}
address_denied!(loopback_asset, "http://127.0.0.1/icon");
address_denied!(numeric_loopback_asset, "http://2130706433/icon");
address_denied!(private_asset, "http://10.0.0.1/icon");
address_denied!(metadata_asset, "http://169.254.169.254/icon");
address_denied!(ipv6_asset, "http://[::1]/icon");
#[test]
fn rebinding_asset_cannot_dial_private_address() {
    let out = parsed_str("<link rel=icon href='https://public.example/icon'>");
    let mut t = Transport::new(vec![]);
    t.ip = "10.1.2.3".parse().unwrap();
    assert_eq!(
        out.icon
            .unwrap()
            .fetch(&egress(PublicUrlPolicy::default()), &mut t, &Clock),
        Err(EgressError::AddressDenied)
    );
    assert_eq!(t.trace.borrow().dials, 0);
}
#[test]
fn asset_redirect_revalidates_private_hop() {
    let out = parsed_str("<link rel=icon href='/icon'>");
    let mut reply = Reply::new("image/png", b"");
    reply.redirect = Some("http://127.0.0.1/private".into());
    let mut t = Transport::new(vec![reply]);
    let controller = PublicEgress::new(
        PublicUrlPolicy::default(),
        EgressLimits {
            max_redirects: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        out.icon.unwrap().fetch(&controller, &mut t, &Clock),
        Err(EgressError::AddressDenied)
    );
    assert_eq!(t.trace.borrow().gets, 1);
    assert_eq!(t.trace.borrow().closed, 1);
}
macro_rules! media_denied {
    ($name:ident, $mime:expr, $encoding:expr, $body:expr, $error:expr) => {
        #[test]
        fn $name() {
            let out = parsed_str("<meta property='og:image' content='/image'>");
            let mut reply = Reply::new($mime, $body);
            reply.encoding = $encoding;
            let mut t = Transport::new(vec![reply]);
            assert_eq!(
                out.image
                    .unwrap()
                    .fetch(&egress(PublicUrlPolicy::default()), &mut t, &Clock),
                Err($error)
            );
            assert_eq!(t.trace.borrow().closed, 1);
        }
    };
}
media_denied!(
    svg_denied,
    "image/svg+xml",
    None,
    b"<svg/>",
    EgressError::UnsupportedContent
);
media_denied!(
    html_asset_denied,
    "text/html",
    None,
    b"<script/>",
    EgressError::UnsupportedContent
);
media_denied!(
    compressed_asset_denied,
    "image/png",
    Some("gzip".into()),
    b"bomb",
    EgressError::EncodedResponse
);
media_denied!(
    media_size_bounded,
    "image/png",
    None,
    &vec![0; MAX_MEDIA_BYTES + 1],
    EgressError::TooLarge
);
#[test]
fn diagnostics_redact_page_and_asset_secrets() {
    let out = parsed_str("<title>private title</title><link rel=icon href='/icon?token=secret'>");
    let debug = format!("{out:?} {:?}", out.icon.as_ref().unwrap());
    for secret in ["secret", "private title", "/original", "/icon"] {
        assert!(!debug.contains(secret));
    }
}
