//! Pure public locator admission, before DNS or transport. This token proves only
//! configured URL syntax/host/port policy. Hosts must still admit the actual
//! connection address (including every redirect/asset) and current capabilities.
//! A URL never supplies catalog authority, credentials or document permission.
use super::{LinkHostContext, LinkRequest, LinkState, LinkTarget, LookupAction, MAX_LOCATOR};
use sha2::{Digest, Sha256};
use std::fmt;
use url::{Host, Url};

/// Hard byte cap applies both before parsing and after IDNA/percent normalization.
pub const MAX_PUBLIC_URL_BYTES: usize = MAX_LOCATOR;
const MAX_POLICY_ENTRIES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicScheme {
    Http,
    Https,
}
impl PublicScheme {
    fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }
}

/// Reasons contain no input, parser message, path, query or credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicUrlDenial {
    Overlong,
    Malformed,
    Credentials,
    UnsupportedScheme,
    ForbiddenScheme,
    ForbiddenHost,
    ForbiddenPort,
}
impl PublicUrlDenial {
    pub fn state(self) -> LinkState {
        match self {
            Self::Credentials
            | Self::ForbiddenScheme
            | Self::ForbiddenHost
            | Self::ForbiddenPort => LinkState::Forbidden,
            Self::Overlong | Self::Malformed | Self::UnsupportedScheme => LinkState::Unsupported,
        }
    }
}
impl fmt::Display for PublicUrlDenial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "public URL denied: {self:?}")
    }
}
impl std::error::Error for PublicUrlDenial {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicUrlPolicyError {
    InvalidLimit,
    InvalidPorts,
    InvalidHost,
    TooManyHosts,
}

/// Host-created policy. Defaults allow HTTP:80 and HTTPS:443. All-host mode is
/// public-web *syntax* admission, not permission to connect to arbitrary IPs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicUrlPolicy {
    max_bytes: usize,
    http_ports: Vec<u16>,
    https_ports: Vec<u16>,
    allowed_hosts: Option<Vec<String>>,
}
impl Default for PublicUrlPolicy {
    fn default() -> Self {
        Self {
            max_bytes: MAX_PUBLIC_URL_BYTES,
            http_ports: vec![80],
            https_ports: vec![443],
            allowed_hosts: None,
        }
    }
}
impl PublicUrlPolicy {
    pub fn with_max_bytes(mut self, limit: usize) -> Result<Self, PublicUrlPolicyError> {
        if limit == 0 || limit > MAX_PUBLIC_URL_BYTES {
            return Err(PublicUrlPolicyError::InvalidLimit);
        }
        self.max_bytes = limit;
        Ok(self)
    }

    /// Empty ports disable the scheme; ports are scheme-specific, never inferred
    /// from the locator's claimed identity. Zero and unbounded lists are invalid.
    pub fn with_ports(
        mut self,
        scheme: PublicScheme,
        ports: &[u16],
    ) -> Result<Self, PublicUrlPolicyError> {
        if ports.len() > MAX_POLICY_ENTRIES || ports.contains(&0) {
            return Err(PublicUrlPolicyError::InvalidPorts);
        }
        let mut ports = ports.to_vec();
        ports.sort_unstable();
        ports.dedup();
        match scheme {
            PublicScheme::Http => self.http_ports = ports,
            PublicScheme::Https => self.https_ports = ports,
        }
        Ok(self)
    }

    /// Exact canonical host matches only, with IDNA and IP normalization. No
    /// suffix/wildcard matching. An empty allowlist denies every host.
    pub fn with_allowed_hosts(mut self, hosts: &[&str]) -> Result<Self, PublicUrlPolicyError> {
        if hosts.len() > MAX_POLICY_ENTRIES {
            return Err(PublicUrlPolicyError::TooManyHosts);
        }
        let mut normalized = Vec::with_capacity(hosts.len());
        for host in hosts {
            if host.is_empty()
                || host.len() > 253
                || host.chars().any(|c| c.is_whitespace() || c.is_control())
                || host.contains(['/', '\\', '?', '#', '@', '%'])
            {
                return Err(PublicUrlPolicyError::InvalidHost);
            }
            let host = Host::parse(host).map_err(|_| PublicUrlPolicyError::InvalidHost)?;
            validate_host(&host).map_err(|_| PublicUrlPolicyError::InvalidHost)?;
            normalized.push(host.to_string());
        }
        normalized.sort();
        normalized.dedup();
        self.allowed_hosts = Some(normalized);
        Ok(self)
    }

    pub fn admit(&self, raw: &str) -> Result<AdmittedPublicUrl, PublicUrlDenial> {
        if raw.len() > self.max_bytes {
            return Err(PublicUrlDenial::Overlong);
        }
        // WHATWG parsers repair whitespace, slashes and empty authority forms.
        // Reject those ambiguous candidates before normalization instead.
        if raw.is_empty()
            || raw
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
            || !valid_percent_encoding(raw)
        {
            return Err(PublicUrlDenial::Malformed);
        }
        let scheme_end = raw.find(':').ok_or(PublicUrlDenial::Malformed)?;
        let scheme = &raw[..scheme_end];
        if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
            return Err(PublicUrlDenial::UnsupportedScheme);
        }
        let authority = raw[scheme_end + 1..]
            .strip_prefix("//")
            .ok_or(PublicUrlDenial::Malformed)?
            .split(['/', '?', '#'])
            .next()
            .ok_or(PublicUrlDenial::Malformed)?;
        // Even empty userinfo (`https://@host`) is credential-bearing syntax.
        if authority.contains('@') {
            return Err(PublicUrlDenial::Credentials);
        }
        if authority.is_empty() || authority.ends_with(':') {
            return Err(PublicUrlDenial::Malformed);
        }
        let url = Url::parse(raw).map_err(|_| PublicUrlDenial::Malformed)?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(PublicUrlDenial::Credentials);
        }
        let host = url.host().ok_or(PublicUrlDenial::Malformed)?;
        validate_host(&host)?;
        let ports = match url.scheme() {
            "http" => &self.http_ports,
            "https" => &self.https_ports,
            _ => return Err(PublicUrlDenial::UnsupportedScheme),
        };
        if ports.is_empty() {
            return Err(PublicUrlDenial::ForbiddenScheme);
        }
        let port = url
            .port_or_known_default()
            .ok_or(PublicUrlDenial::Malformed)?;
        if !ports.contains(&port) {
            return Err(PublicUrlDenial::ForbiddenPort);
        }
        if let Some(allowed) = &self.allowed_hosts {
            if !allowed.contains(&host.to_string()) {
                return Err(PublicUrlDenial::ForbiddenHost);
            }
        }
        if url.as_str().len() > self.max_bytes {
            return Err(PublicUrlDenial::Overlong);
        }
        let mut request_url = url.clone();
        // Fragments identify document locations, but are never sent over HTTP.
        request_url.set_fragment(None);
        let cache_key = PublicUrlCacheKey(Sha256::digest(request_url.as_str().as_bytes()).into());
        Ok(AdmittedPublicUrl {
            locator: url,
            request_url,
            cache_key,
        })
    }
}

fn valid_percent_encoding(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() || !bytes[i + 1..i + 3].iter().all(u8::is_ascii_hexdigit) {
                return false;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    true
}

fn validate_host<S: AsRef<str>>(host: &Host<S>) -> Result<(), PublicUrlDenial> {
    if let Host::Domain(domain) = host {
        // A root dot is retained (not silently aliased by allowlist/cache keys).
        let domain = domain.as_ref().strip_suffix('.').unwrap_or(domain.as_ref());
        if domain.is_empty()
            || domain.len() > 253
            || domain.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
        {
            return Err(PublicUrlDenial::Malformed);
        }
    }
    Ok(())
}

/// The key retains path/query distinctions without containing their clear text.
/// Host resolver caches must additionally scope it by policy/authority (LNK-1.5).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PublicUrlCacheKey([u8; 32]);
impl fmt::Debug for PublicUrlCacheKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PublicUrlCacheKey([redacted])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AdmittedPublicUrl {
    locator: Url,
    request_url: Url,
    cache_key: PublicUrlCacheKey,
}
impl AdmittedPublicUrl {
    /// Sensitive locator for identity/host use; never ordinary diagnostic text.
    pub fn locator(&self) -> &str {
        self.locator.as_str()
    }
    /// Sensitive fetch URL, fragment removed. Requires independent egress proof.
    pub fn request_url(&self) -> &str {
        self.request_url.as_str()
    }
    pub fn cache_key(&self) -> &PublicUrlCacheKey {
        &self.cache_key
    }
    pub fn scheme(&self) -> PublicScheme {
        if self.locator.scheme() == "https" {
            PublicScheme::Https
        } else {
            PublicScheme::Http
        }
    }
    pub fn host(&self) -> Host<&str> {
        self.locator.host().expect("admitted URL has host")
    }
    pub fn port(&self) -> u16 {
        self.locator
            .port_or_known_default()
            .expect("HTTP(S) has port")
    }
}
impl fmt::Debug for AdmittedPublicUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdmittedPublicUrl")
            .field("scheme", &self.scheme().as_str())
            .field("host", &self.host())
            .field("port", &self.port())
            .field("locator", &"[redacted]")
            .finish()
    }
}
impl fmt::Display for AdmittedPublicUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicRequestDenial {
    Request(LinkState),
    Url(PublicUrlDenial),
}
impl PublicRequestDenial {
    pub fn state(self) -> LinkState {
        match self {
            Self::Request(state) => state,
            Self::Url(reason) => reason.state(),
        }
    }
}
impl LinkRequest {
    /// Composes the existing host/origin/freshness contract with URL policy. No
    /// IO or document mutation occurs, and no public URL becomes a private target.
    pub fn admit_public_url(
        &self,
        current: &LinkHostContext,
        canceled: bool,
        policy: &PublicUrlPolicy,
    ) -> Result<AdmittedPublicUrl, PublicRequestDenial> {
        if self
            .admit(current, canceled)
            .map_err(PublicRequestDenial::Request)?
            != LookupAction::PublicMetadata
        {
            return Err(PublicRequestDenial::Request(LinkState::Unsupported));
        }
        let LinkTarget::PublicUrl(raw) = &self.target else {
            return Err(PublicRequestDenial::Request(LinkState::Unsupported));
        };
        policy.admit(raw).map_err(PublicRequestDenial::Url)
    }
}
