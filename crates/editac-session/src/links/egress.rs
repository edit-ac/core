//! Host-owned public metadata transport. No ambient HTTP client is accepted.
//!
//! Adapters MUST dial only `PinnedTarget::address` (no proxy, DNS fallback,
//! redirect, cookie jar, authentication or connection coalescing), verify TLS
//! against `url.host`, and honor every absolute deadline and allocation cap
//! before returning. Resolve/connect/head/read must abort at their deadline;
//! these synchronous ports cannot preempt a broken blocking adapter. `close`
//! cancels outstanding IO and releases the connection, including on errors.
//! A dedicated backend implementation and network firewall remain host duties.
//! This module composes the same boundary with deterministic prepared adapters.
use super::public_url::{AdmittedPublicUrl, PublicUrlDenial, PublicUrlPolicy};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Instant,
};
use url::{Host, Url};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EgressError {
    Url(PublicUrlDenial),
    InvalidLimits,
    AddressDenied,
    Dns,
    PeerMismatch,
    Timeout,
    Transport,
    RedirectDenied,
    RedirectLimit,
    InvalidHeaders,
    UnsupportedContent,
    EncodedResponse,
    TooLarge,
    TooManyChunks,
}

/// Finite hard ceilings, further reducible by each host. Compression is refused:
/// identity-only transfer bounds both encoded and decoded bytes, avoiding bombs.
#[derive(Clone, Copy, Debug)]
pub struct EgressLimits {
    pub connect_ms: u64,
    pub total_ms: u64,
    pub idle_ms: u64,
    pub max_bytes: usize,
    pub max_header_bytes: usize,
    pub max_dns_addresses: usize,
    pub max_chunks: usize,
    /// Zero (default) disables redirects, even same-origin redirects.
    pub max_redirects: usize,
}
impl Default for EgressLimits {
    fn default() -> Self {
        Self {
            connect_ms: 2_000,
            total_ms: 5_000,
            idle_ms: 1_000,
            max_bytes: 262_144,
            max_header_bytes: 16_384,
            max_dns_addresses: 16,
            max_chunks: 1024,
            max_redirects: 0,
        }
    }
}
impl EgressLimits {
    fn validate(self) -> Result<Self, EgressError> {
        if self.connect_ms == 0
            || self.connect_ms > 10_000
            || self.total_ms == 0
            || self.total_ms > 30_000
            || self.idle_ms == 0
            || self.idle_ms > self.total_ms
            || self.max_bytes == 0
            || self.max_bytes > 1_048_576
            || self.max_header_bytes == 0
            || self.max_header_bytes > 32_768
            || self.max_dns_addresses == 0
            || self.max_dns_addresses > 64
            || self.max_chunks == 0
            || self.max_chunks > 4096
            || self.max_redirects > 5
        {
            return Err(EgressError::InvalidLimits);
        }
        Ok(self)
    }
}

/// One monotonic time domain shared by adapter deadlines and the controller.
/// Production hosts use MonotonicClock; prepared adapters may advance fake time.
pub trait EgressClock {
    fn now_ms(&self) -> u64;
}
pub struct MonotonicClock(Instant);
impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}
impl EgressClock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        self.0.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
}

/// Unforgeable dial instruction. It is tied to the admitted URL and a specific
/// checked socket address, never an independently re-resolved hostname.
pub struct PinnedTarget<'a> {
    url: &'a AdmittedPublicUrl,
    address: SocketAddr,
}
impl PinnedTarget<'_> {
    pub fn url(&self) -> &AdmittedPublicUrl {
        self.url
    }
    pub fn address(&self) -> SocketAddr {
        self.address
    }
}
/// Exactly one GET, without caller-controlled headers or request bodies. Host
/// and TLS identity come from the URL, not from the numeric socket destination.
pub struct PublicGet<'a>(&'a AdmittedPublicUrl);
impl PublicGet<'_> {
    pub fn url(&self) -> &AdmittedPublicUrl {
        self.0
    }
    pub fn method(&self) -> &'static str {
        "GET"
    }
    pub fn headers(&self) -> [(&'static str, &'static str); 2] {
        [
            ("Accept", "text/html, application/xhtml+xml"),
            ("Accept-Encoding", "identity"),
        ]
    }
}
/// Raw head is sensitive; deliberately has no Debug implementation. Adapters
/// cap parsing/allocation BEFORE constructing this record, including status line.
pub struct ResponseHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}
pub trait PublicConnection {
    fn peer_addr(&self) -> Result<SocketAddr, EgressError>;
    fn get(
        &mut self,
        request: PublicGet<'_>,
        deadline_ms: u64,
        max_head_bytes: usize,
    ) -> Result<ResponseHead, EgressError>;
    /// Return raw, undecoded identity bytes. Never allocate beyond max_bytes.
    /// None is EOF. No transparent decompression, cookies or redirect handling.
    fn read(&mut self, deadline_ms: u64, max_bytes: usize) -> Result<Option<Vec<u8>>, EgressError>;
    fn close(&mut self);
}
pub trait PublicTransport {
    type Connection: PublicConnection;
    /// Bounded results, no search suffixes or implicit proxy DNS.
    fn resolve(
        &mut self,
        host: &str,
        deadline_ms: u64,
        max_addresses: usize,
    ) -> Result<Vec<IpAddr>, EgressError>;
    fn connect(
        &mut self,
        target: PinnedTarget<'_>,
        deadline_ms: u64,
    ) -> Result<Self::Connection, EgressError>;
}
struct OpenConnection<C: PublicConnection>(C);
impl<C: PublicConnection> Drop for OpenConnection<C> {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Only globally routable unicast. Conservative denial includes transition,
/// mapped, translation and documentation networks to avoid embedded IPv4 bypass.
pub fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let n = u32::from(ip);
            let denied = [
                (0x00000000, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0586300, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 3),
            ];
            ip != Ipv4Addr::new(168, 63, 129, 16)
                && !denied
                    .iter()
                    .any(|&(base, bits)| n >> (32 - bits) == base >> (32 - bits))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && s[1] < 0x200)
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

pub struct PublicEgress {
    urls: PublicUrlPolicy,
    limits: EgressLimits,
}
/// Sensitive body/URL are explicit host inputs, never ordinary diagnostics.
pub struct PublicResponse {
    pub url: AdmittedPublicUrl,
    pub body: Vec<u8>,
    pub redirects: usize,
}
impl PublicEgress {
    pub fn new(urls: PublicUrlPolicy, limits: EgressLimits) -> Result<Self, EgressError> {
        Ok(Self {
            urls,
            limits: limits.validate()?,
        })
    }
    pub fn fetch<T: PublicTransport>(
        &self,
        transport: &mut T,
        clock: &impl EgressClock,
        raw: &str,
    ) -> Result<PublicResponse, EgressError> {
        let mut url = self.urls.admit(raw).map_err(EgressError::Url)?;
        let total = clock.now_ms().saturating_add(self.limits.total_ms);
        let mut redirects = 0;
        loop {
            let connect_deadline = total.min(clock.now_ms().saturating_add(self.limits.connect_ms));
            check_time(clock, connect_deadline)?;
            let addresses = match url.host() {
                Host::Ipv4(ip) => vec![IpAddr::V4(ip)],
                Host::Ipv6(ip) => vec![IpAddr::V6(ip)],
                Host::Domain(host) => {
                    transport.resolve(host, connect_deadline, self.limits.max_dns_addresses)?
                }
            };
            check_time(clock, connect_deadline)?;
            if addresses.is_empty() || addresses.len() > self.limits.max_dns_addresses {
                return Err(EgressError::Dns);
            }
            // Fail closed on mixed answers; no fallback can pick a denied IP.
            if addresses.iter().any(|ip| !public_address(*ip)) {
                return Err(EgressError::AddressDenied);
            }
            let address = SocketAddr::new(addresses[0], url.port());
            let mut conn = OpenConnection(
                transport.connect(PinnedTarget { url: &url, address }, connect_deadline)?,
            );
            check_time(clock, connect_deadline)?;
            if conn.0.peer_addr()? != address {
                return Err(EgressError::PeerMismatch);
            }
            let deadline = total.min(clock.now_ms().saturating_add(self.limits.idle_ms));
            let head = conn
                .0
                .get(PublicGet(&url), deadline, self.limits.max_header_bytes)?;
            check_time(clock, deadline)?;
            let head = validate_head(head, self.limits.max_header_bytes)?;
            if matches!(head.status, 301 | 302 | 303 | 307 | 308) {
                if self.limits.max_redirects == 0 {
                    return Err(EgressError::RedirectDenied);
                }
                if redirects >= self.limits.max_redirects {
                    return Err(EgressError::RedirectLimit);
                }
                let location = head.location.ok_or(EgressError::InvalidHeaders)?;
                let next = Url::parse(url.request_url())
                    .map_err(|_| EgressError::InvalidHeaders)?
                    .join(&location)
                    .map_err(|_| EgressError::InvalidHeaders)?;
                url = self.urls.admit(next.as_str()).map_err(EgressError::Url)?;
                redirects += 1;
                // No body reuse or automatic client redirects. Next hop resolves
                // afresh, and runs the same address policy before any dial.
                continue;
            }
            if head.status != 200 {
                return Err(EgressError::UnsupportedContent);
            }
            if !head.html {
                return Err(EgressError::UnsupportedContent);
            }
            if head.encoded {
                return Err(EgressError::EncodedResponse);
            }
            if head.length.is_some_and(|n| n > self.limits.max_bytes) {
                return Err(EgressError::TooLarge);
            }
            let mut body = Vec::new();
            let mut chunks = 0;
            loop {
                check_time(clock, total)?;
                let deadline = total.min(clock.now_ms().saturating_add(self.limits.idle_ms));
                let cap = (self.limits.max_bytes - body.len() + 1).min(16_384);
                let chunk = conn.0.read(deadline, cap)?;
                check_time(clock, deadline)?;
                let Some(chunk) = chunk else {
                    break;
                };
                if chunk.len() > cap || chunk.len() > self.limits.max_bytes - body.len() {
                    return Err(EgressError::TooLarge);
                }
                chunks += 1;
                if chunks > self.limits.max_chunks {
                    return Err(EgressError::TooManyChunks);
                }
                body.extend_from_slice(&chunk);
            }
            if head.length.is_some_and(|n| n != body.len()) {
                return Err(EgressError::InvalidHeaders);
            }
            return Ok(PublicResponse {
                url,
                body,
                redirects,
            });
        }
    }
}
fn check_time(clock: &impl EgressClock, deadline: u64) -> Result<(), EgressError> {
    if clock.now_ms() >= deadline {
        Err(EgressError::Timeout)
    } else {
        Ok(())
    }
}
struct CheckedHead {
    status: u16,
    location: Option<String>,
    length: Option<usize>,
    html: bool,
    encoded: bool,
}
fn validate_head(head: ResponseHead, cap: usize) -> Result<CheckedHead, EgressError> {
    if head.headers.len() > 128 {
        return Err(EgressError::InvalidHeaders);
    }
    let mut checked = CheckedHead {
        status: head.status,
        location: None,
        length: None,
        html: false,
        encoded: false,
    };
    let mut bytes = 0usize;
    let mut seen = Vec::new();
    for (name, value) in head.headers {
        bytes = bytes
            .saturating_add(name.len())
            .saturating_add(value.len())
            .saturating_add(4);
        if bytes > cap
            || name.is_empty()
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || value.chars().any(|c| c.is_control())
        {
            return Err(EgressError::InvalidHeaders);
        }
        let name = name.to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "location"
                | "content-type"
                | "content-encoding"
                | "content-length"
                | "transfer-encoding"
        ) {
            if seen.contains(&name) {
                return Err(EgressError::InvalidHeaders);
            }
            seen.push(name.clone());
        }
        match name.as_str() {
            "location" => checked.location = Some(value),
            "content-length" => {
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(EgressError::InvalidHeaders);
                }
                checked.length = Some(value.parse().map_err(|_| EgressError::InvalidHeaders)?);
            }
            "content-type" => {
                checked.html = matches!(
                    value
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase()
                        .as_str(),
                    "text/html" | "application/xhtml+xml"
                )
            }
            "content-encoding" => checked.encoded = !value.trim().eq_ignore_ascii_case("identity"),
            "transfer-encoding" => {
                if !value.eq_ignore_ascii_case("chunked") {
                    return Err(EgressError::InvalidHeaders);
                }
            }
            _ => {}
        }
    }
    if checked.length.is_some() && seen.iter().any(|s| s == "transfer-encoding") {
        return Err(EgressError::InvalidHeaders);
    }
    Ok(checked)
}
