//! Conservative, inert HTML-head metadata extraction. This is a bounded subset,
//! not a DOM or browser parser: ambiguous/malformed input falls back safely.
//! No scripts, styles, embeds, base URL overrides or automatic asset IO.
use super::{
    LinkDisplay, LinkMetadata, MAX_DESCRIPTION, MAX_TEXT,
    egress::{EgressClock, EgressError, PublicEgress, PublicResponse, PublicTransport},
    public_url::{AdmittedPublicUrl, PublicUrlPolicy},
};
use std::{collections::BTreeMap, fmt};
use url::Url;

pub const MAX_HTML_BYTES: usize = 262_144;
pub const MAX_TAG_BYTES: usize = 8192;
pub const MAX_TAGS: usize = 2048;
pub const MAX_MEDIA_BYTES: usize = 65_536;

/// A non-renderable candidate, never a browser URL/asset handle. Admission at
/// parse time is syntax only; fetching ALWAYS repeats actual egress admission.
pub struct AssetCandidate(AdmittedPublicUrl);
impl fmt::Debug for AssetCandidate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AssetCandidate([redacted])")
    }
}
impl AssetCandidate {
    /// Host retains these bytes, validates/decodes with its bounded media codec,
    /// and issues an opaque asset handle. Never render the response URL directly.
    pub fn fetch<T: PublicTransport>(
        &self,
        egress: &PublicEgress,
        transport: &mut T,
        clock: &impl EgressClock,
    ) -> Result<Vec<u8>, EgressError> {
        let response = egress.fetch_asset(transport, clock, self.0.request_url())?;
        if response.body.len() > MAX_MEDIA_BYTES {
            return Err(EgressError::TooLarge);
        }
        Ok(response.body)
    }
}

pub struct ParsedMetadata {
    /// Stable requested identity; canonical metadata never replaces it.
    pub requested: AdmittedPublicUrl,
    pub canonical: Option<AdmittedPublicUrl>,
    pub display: LinkDisplay,
    pub icon: Option<AssetCandidate>,
    pub image: Option<AssetCandidate>,
    pub fallback: bool,
}
impl fmt::Debug for ParsedMetadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ParsedMetadata")
            .field("fallback", &self.fallback)
            .finish_non_exhaustive()
    }
}
impl ParsedMetadata {
    /// Existing result family, with no raw HTML or fetchable asset URL.
    /// Hosts attach separately validated opaque media handles afterward.
    pub fn into_metadata(self) -> LinkMetadata {
        LinkMetadata::Public {
            display: self.display,
            provider: "public-web".into(),
            requested_url: self.requested.locator().into(),
            canonical_url: self.canonical.map(|u| u.locator().into()),
        }
    }
}

pub struct MetadataParser {
    urls: PublicUrlPolicy,
}
impl MetadataParser {
    pub fn new(urls: PublicUrlPolicy) -> Self {
        Self { urls }
    }
    /// `requested` is the initiating admitted target, not a page's canonical or
    /// redirect destination. Relative hints use the final validated response URL.
    pub fn parse(&self, requested: AdmittedPublicUrl, response: &PublicResponse) -> ParsedMetadata {
        let mut out = ParsedMetadata {
            display: LinkDisplay {
                title: match requested.host() {
                    url::Host::Domain(h) => h.into(),
                    h => h.to_string(),
                },
                description: None,
                icon_asset: None,
                image_asset: None,
            },
            requested,
            canonical: None,
            icon: None,
            image: None,
            fallback: true,
        };
        if response.body.len() > MAX_HTML_BYTES {
            return out;
        }
        let Ok(html) = std::str::from_utf8(&response.body) else {
            return out;
        };
        let Some(fields) = extract(html) else {
            return out;
        };
        let title = ["og:title", "title"]
            .into_iter()
            .filter_map(|key| fields.get(key))
            .map(|s| text(s, MAX_TEXT))
            .find(|s| !s.is_empty());
        if let Some(title) = title {
            out.display.title = title;
            out.fallback = false;
        }
        out.display.description = fields
            .get("og:description")
            .or_else(|| fields.get("description"))
            .map(|s| text(s, MAX_DESCRIPTION))
            .filter(|s| !s.is_empty());
        let hint = |key: &str| {
            fields.get(key).and_then(|raw| {
                let raw = entities(raw);
                // Reject whitespace/control obfuscation instead of letting URL parsing trim it.
                if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
                    return None;
                }
                let url = Url::parse(response.url.request_url())
                    .ok()?
                    .join(&raw)
                    .ok()?;
                self.urls.admit(url.as_str()).ok()
            })
        };
        out.canonical = hint("canonical");
        out.icon = hint("icon").map(AssetCandidate);
        out.image = hint("og:image").map(AssetCandidate);
        out
    }
}

fn text(raw: &str, cap: usize) -> String {
    let decoded = entities(raw);
    let mut out = String::new();
    let mut count = 0;
    let mut space = false;
    for c in decoded.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if c.is_control()
            || matches!(c, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
        {
            continue;
        }
        let size = c.len_utf16() + usize::from(space);
        if count + size > cap {
            break;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        count += size;
    }
    out
}

// Decode once. Unknown named entities remain inert literal text. Numeric
// entities are checked Unicode scalars; invalid values become replacement text.
fn entities(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|n| *n <= 16);
        let decoded = end.and_then(|n| {
            let e = &rest[1..n];
            match e {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ if e.starts_with('#') => {
                    let n = if e.starts_with("#x") || e.starts_with("#X") {
                        u32::from_str_radix(&e[2..], 16)
                    } else {
                        e[1..].parse()
                    };
                    Some(n.ok().and_then(char::from_u32).unwrap_or('\u{fffd}'))
                }
                _ => None,
            }
        });
        if let Some(c) = decoded {
            out.push(c);
            rest = &rest[end.unwrap() + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

fn extract(html: &str) -> Option<BTreeMap<String, String>> {
    let lower = html.to_ascii_lowercase();
    let mut pos = 0;
    let mut tags = 0;
    let mut fields = BTreeMap::new();
    while let Some(offset) = html[pos..].find('<') {
        pos += offset;
        if html[pos..].starts_with("<!--") {
            pos += html[pos + 4..].find("-->")? + 7;
            continue;
        }
        // Only quoted attributes can contain '>'; never scan an unbounded tag.
        let start = pos + 1;
        let mut quote = None;
        let mut end = None;
        for (i, c) in html[start..].char_indices().take(MAX_TAG_BYTES + 1) {
            if i > MAX_TAG_BYTES {
                return None;
            }
            if let Some(q) = quote {
                if c == q {
                    quote = None;
                }
            } else if c == '\'' || c == '"' {
                quote = Some(c);
            } else if c == '>' {
                end = Some(start + i);
                break;
            }
        }
        let end = end?;
        let tag = &html[start..end];
        pos = end + 1;
        tags += 1;
        if tags > MAX_TAGS {
            return None;
        }
        let name_end = tag
            .find(|c: char| c.is_ascii_whitespace() || c == '/')
            .unwrap_or(tag.len());
        let name = tag[..name_end].to_ascii_lowercase();
        if tag.starts_with('/') {
            if tag.trim().eq_ignore_ascii_case("/head") {
                break;
            }
            continue;
        }
        if name == "body" {
            break;
        }
        if !matches!(
            name.as_str(),
            "html"
                | "head"
                | "!doctype"
                | "meta"
                | "link"
                | "title"
                | "base"
                | "script"
                | "style"
                | "template"
                | "noscript"
                | "svg"
                | "math"
                | "iframe"
                | "textarea"
                | "xmp"
                | "plaintext"
        ) {
            break;
        }
        // Ambiguous raw text, foreign content and templates are not metadata.
        if matches!(
            name.as_str(),
            "script"
                | "style"
                | "template"
                | "noscript"
                | "svg"
                | "math"
                | "iframe"
                | "textarea"
                | "xmp"
                | "plaintext"
        ) {
            let close = format!("</{name}>");
            let Some(i) = lower[pos..].find(&close) else {
                break;
            };
            pos += i + close.len();
            continue;
        }
        if name == "title" {
            let close = lower[pos..].find("</title>")?;
            let title = &html[pos..pos + close];
            if title.contains('<') {
                return None;
            }
            fields.entry("title".into()).or_insert_with(|| title.into());
            pos += close + 8;
        } else if name == "meta" || name == "link" {
            let attrs = attributes(&tag[name_end..])?;
            let get = |key: &str| attrs.get(key).map(String::as_str).unwrap_or("");
            if name == "meta" {
                let key = if get("property").is_empty() {
                    get("name")
                } else {
                    get("property")
                }
                .to_ascii_lowercase();
                if matches!(
                    key.as_str(),
                    "og:title" | "og:description" | "og:image" | "description"
                ) {
                    fields.entry(key).or_insert_with(|| get("content").into());
                }
            } else {
                let rel = get("rel").to_ascii_lowercase();
                let key = if rel.split_ascii_whitespace().any(|s| s == "icon") {
                    "icon"
                } else if rel.split_ascii_whitespace().any(|s| s == "canonical") {
                    "canonical"
                } else {
                    continue;
                };
                fields
                    .entry(key.into())
                    .or_insert_with(|| get("href").into());
            }
        }
    }
    Some(fields)
}
fn attributes(mut s: &str) -> Option<BTreeMap<String, String>> {
    let mut attrs = BTreeMap::new();
    let mut count = 0;
    loop {
        s = s.trim_start_matches(|c: char| c.is_ascii_whitespace());
        if s.is_empty() || s == "/" {
            break;
        }
        count += 1;
        if count > 32 {
            return None;
        }
        let n = s
            .find(|c: char| c.is_ascii_whitespace() || c == '=' || c == '/')
            .unwrap_or(s.len());
        if n == 0
            || !s[..n]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        {
            return None;
        }
        let name = s[..n].to_ascii_lowercase();
        s = &s[n..];
        s = s.trim_start_matches(|c: char| c.is_ascii_whitespace());
        let mut value = "";
        if let Some(tail) = s.strip_prefix('=') {
            s = tail.trim_start_matches(|c: char| c.is_ascii_whitespace());
            if s.starts_with(['\'', '"']) {
                let quote = s.chars().next()?;
                s = &s[1..];
                let end = s.find(quote)?;
                value = &s[..end];
                s = &s[end + 1..];
            } else {
                let end = s.find(char::is_whitespace).unwrap_or(s.len());
                value = &s[..end];
                s = &s[end..];
                if value.is_empty() || value.contains(['\'', '"', '<', '=', '`']) {
                    return None;
                }
            }
        }
        // Duplicate attributes are ambiguous; reject rather than disagree with a browser.
        if attrs.insert(name, value.into()).is_some() {
            return None;
        }
    }
    Some(attrs)
}
