//! Optional ODF 1.3 semantic import. Unknown content is inert, diagnosed and
//! recoverable from the immutable job input; no package execution or fetching.
use crate::{
    Direction,
    container::{self, Budgets, Package, Work},
    job::*,
};
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::{Mark, normalize_link_url},
        lists::ContainerStyle,
    },
    document::BlockAttributes,
    modules::{
        assets::*,
        content::{Alignment, Content},
    },
};
use editac_session::{
    assets::{AssetHost, AssetStore, HostOutcome},
    ports::PortError,
    session::SessionStore,
};
use quick_xml::{NsReader, events::Event, name::ResolveResult};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
const O: &str = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const T: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const S: &str = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const F: &str = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const M: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const TB: &str = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const D: &str = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
const X: &str = "http://www.w3.org/1999/xlink";
const SVG: &str = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
const MIME: &str = "application/vnd.oasis.opendocument.text";
pub const PROFILE: crate::Profile = crate::Profile {
    id: "edit-ac-odt-v1",
    format: "odt",
    version: 1,
    import: true,
    export: false,
    available: true,
    fidelity: "odf13-semantic-v1",
    owner: "CNV-1.10",
    limits: crate::LIMITS,
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub location: String,
    pub lossy: bool,
    pub action: &'static str,
}
#[derive(Clone, Debug)]
pub struct Failure {
    pub code: String,
    pub location: String,
    pub diagnostics: Vec<Diagnostic>,
    pub work: Work,
}
type Result<T> = std::result::Result<T, Failure>;
fn fail(code: &str, location: &str) -> Failure {
    Failure {
        code: code.into(),
        location: location.into(),
        diagnostics: vec![],
        work: Work::default(),
    }
}
fn ingress(e: container::Failure) -> Failure {
    Failure {
        code: format!("INGRESS_{:?}", e.code),
        location: e.part,
        diagnostics: vec![],
        work: e.work,
    }
}
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub work: Work,
    pub blocks: usize,
    pub utf16_units: usize,
    pub staged_bytes: usize,
}
impl Report {
    fn diagnostic(&mut self, code: &'static str, location: &str) -> Result<()> {
        if self.diagnostics.len() >= 512 {
            return Err(fail("BUDGET", "diagnostics"));
        }
        self.diagnostics.push(Diagnostic {
            code,
            location: location.into(),
            lossy: true,
            action: "retain original; review diagnostics; explicitly approve lossy import",
        });
        Ok(())
    }
}
pub struct Prepared {
    blocks: Vec<FragmentBlock>,
    report: Report,
    token: Arc<()>,
    pub original_sha256: [u8; 32],
}
impl Prepared {
    pub fn blocks(&self) -> &[FragmentBlock] {
        &self.blocks
    }
    pub fn report(&self) -> &Report {
        &self.report
    }
    pub fn commit<Ss: SessionStore + AssetStore>(
        self,
        job: &mut PreparedJob<Ss>,
        owner: &mut ConversionOwner<Ss>,
        approve_loss: bool,
        now: u64,
    ) -> Result<Option<ImportCompletion>> {
        if !Arc::ptr_eq(&self.token, &job.token) {
            return Err(fail("FOREIGN_JOB", "job"));
        }
        if !approve_loss && !self.report.diagnostics.is_empty() {
            let mut e = fail("LOSS_APPROVAL", "retain-original-and-review");
            e.diagnostics = self.report.diagnostics;
            e.work = self.report.work;
            job.abort().map_err(|_| fail("JOB", "cleanup"))?;
            return Err(e);
        }
        job.finish_import(owner, &self.blocks, now)
            .map_err(|e| fail("JOB", &format!("commit:{e:?}")))
    }
}
/// Normal AssetWork host with digest identity and original-byte ingestion.
pub trait OriginalMediaHost: AssetHost {
    fn identity(&self, sha256: &[u8; 32]) -> std::result::Result<AssetIdentity, PortError>;
    fn ingest_original(
        &mut self,
        reference: &str,
        request: &AssetRequest,
        bytes: &[u8],
    ) -> std::result::Result<HostOutcome, PortError>;
}
struct Media<'a, H> {
    host: &'a mut H,
    bytes: &'a [u8],
}
impl<H: OriginalMediaHost> AssetHost for Media<'_, H> {
    fn authorize(&mut self, r: &AssetRequest) -> std::result::Result<AssetGrant, PortError> {
        self.host.authorize(r)
    }
    fn execute(
        &mut self,
        id: &str,
        r: &AssetRequest,
    ) -> std::result::Result<HostOutcome, PortError> {
        if r.action == AssetAction::Ingest {
            self.host.ingest_original(id, r, self.bytes)
        } else {
            self.host.execute(id, r)
        }
    }
}
#[derive(Clone, Debug)]
enum Item {
    Text(String),
    Node(Node),
}
#[derive(Clone, Debug)]
struct Node {
    ns: String,
    name: String,
    attrs: BTreeMap<(String, String), String>,
    items: Vec<Item>,
    location: String,
}
impl Node {
    fn is(&self, ns: &str, name: &str) -> bool {
        self.ns == ns && self.name == name
    }
    fn attr(&self, ns: &str, name: &str) -> Option<&str> {
        self.attrs
            .get(&(ns.into(), name.into()))
            .map(String::as_str)
    }
    fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.items
            .iter()
            .filter_map(|i| if let Item::Node(n) = i { Some(n) } else { None })
    }
    fn children<'a>(&'a self, ns: &'a str, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.nodes().filter(move |n| n.is(ns, name))
    }
    fn child(&self, ns: &str, name: &str) -> Result<Option<&Node>> {
        let mut it = self.nodes().filter(|n| n.is(ns, name));
        let n = it.next();
        if it.next().is_some() {
            return Err(fail("DUPLICATE_ELEMENT", &self.location));
        }
        Ok(n)
    }
}
fn namespace(ns: ResolveResult<'_>) -> Result<String> {
    match ns {
        ResolveResult::Bound(n) if n.as_ref().len() <= 256 => {
            String::from_utf8(n.as_ref().to_vec()).map_err(|_| fail("XML", "namespace"))
        }
        ResolveResult::Unbound => Ok(String::new()),
        ResolveResult::Bound(_) => Err(fail("BUDGET", "namespace-length")),
        _ => Err(fail("XML", "unbound-prefix")),
    }
}
fn tree(p: &mut Package, part: &str, control: &mut impl FnMut() -> Result<()>) -> Result<Node> {
    let bytes = p
        .raw_part(part)
        .ok_or_else(|| fail("MISSING_PART", part))?
        .to_vec();
    p.charge_mapping_bytes(bytes.len()).map_err(ingress)?;
    let mut reader = NsReader::from_reader(bytes.as_slice());
    let mut stack: Vec<Node> = vec![];
    let mut root = None;
    let mut serial = 0;
    loop {
        control()?;
        let (ns, e) = reader
            .read_resolved_event()
            .map_err(|_| fail("XML", part))?;
        let ns = namespace(ns)?;
        let empty = matches!(e, Event::Empty(_));
        match e {
            Event::Start(e) | Event::Empty(e) => {
                serial += 1;
                p.charge_output_nodes(1).map_err(ingress)?;
                if e.local_name().as_ref().len() > 128 {
                    return Err(fail("BUDGET", "element-name"));
                }
                let mut attrs = BTreeMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|_| fail("XML", part))?;
                    if a.key.as_ref() == b"xmlns" || a.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    if a.key.as_ref().len() > 256 || a.value.len() > 4096 {
                        return Err(fail("BUDGET", "attribute-size"));
                    }
                    let (ns, key) = reader.resolver().resolve_attribute(a.key);
                    let key = (
                        namespace(ns)?,
                        String::from_utf8(key.as_ref().to_vec()).map_err(|_| fail("XML", part))?,
                    );
                    let value = a
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|_| fail("XML", part))?
                        .into_owned();
                    if attrs.insert(key, value).is_some() {
                        return Err(fail("XML", part));
                    }
                }
                let n = Node {
                    ns,
                    name: String::from_utf8(e.local_name().as_ref().to_vec())
                        .map_err(|_| fail("XML", part))?,
                    attrs,
                    items: vec![],
                    location: format!("{part}#{serial}"),
                };
                stack.push(n);
                if !empty {
                    continue;
                }
                let n = stack.pop().unwrap();
                if let Some(parent) = stack.last_mut() {
                    parent.items.push(Item::Node(n))
                } else if root.replace(n).is_some() {
                    return Err(fail("XML", part));
                }
            }
            Event::End(_) => {
                let n = stack.pop().ok_or_else(|| fail("XML", part))?;
                if let Some(parent) = stack.last_mut() {
                    parent.items.push(Item::Node(n))
                } else if root.replace(n).is_some() {
                    return Err(fail("XML", part));
                }
            }
            Event::Text(e) => {
                let v = e
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(|_| fail("XML", part))?
                    .into_owned();
                if let Some(n) = stack.last_mut() {
                    n.items.push(Item::Text(v))
                }
            }
            Event::CData(e) => {
                let v = e
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(|_| fail("XML", part))?
                    .into_owned();
                if let Some(n) = stack.last_mut() {
                    n.items.push(Item::Text(v))
                }
            }
            Event::GeneralRef(e) => {
                let raw = format!(
                    "&{};",
                    std::str::from_utf8(e.as_ref()).map_err(|_| fail("XML", part))?
                );
                let v = quick_xml::escape::unescape(&raw)
                    .map_err(|_| fail("XML", part))?
                    .into_owned();
                if let Some(n) = stack.last_mut() {
                    n.items.push(Item::Text(v))
                }
            }
            Event::DocType(_) => return Err(fail("DTD", part)),
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(fail("XML", part));
    }
    root.ok_or_else(|| fail("XML", part))
}
fn attrs(n: &Node, allowed: &[(&str, &str)], r: &mut Report) -> Result<()> {
    let text_allowed = (n.ns == T && ["p", "h", "span", "a"].contains(&n.name.as_str()))
        || (n.ns == SVG && ["title", "desc"].contains(&n.name.as_str()));
    if !text_allowed
        && n.items
            .iter()
            .any(|i| matches!(i, Item::Text(t) if !t.trim().is_empty()))
    {
        r.diagnostic("UNSUPPORTED_STRUCTURAL_TEXT", &n.location)?;
    }
    for (ns, key) in n.attrs.keys() {
        if !allowed.contains(&(ns.as_str(), key.as_str())) {
            r.diagnostic(
                "UNSUPPORTED_ATTRIBUTE",
                &format!("{}@{{{ns}}}{key}", n.location),
            )?
        }
    }
    Ok(())
}
fn unknown(n: &Node, r: &mut Report) -> Result<()> {
    r.diagnostic(
        "UNSUPPORTED_ELEMENT",
        &format!("{}:{{{}}}{}", n.location, n.ns, n.name),
    )?;
    attrs(n, &[], r)?;
    for c in n.nodes() {
        unknown(c, r)?
    }
    Ok(())
}
fn count(n: &Node, ns: &str, key: &str, default: usize, max: usize) -> Result<usize> {
    n.attr(ns, key).map_or(Ok(default), |v| {
        v.parse::<usize>()
            .ok()
            .filter(|n| *n > 0 && *n <= max)
            .ok_or_else(|| fail("BUDGET", &n.location))
    })
}
fn package(
    p: &mut Package,
    original: &[u8],
    r: &mut Report,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<BTreeMap<String, String>> {
    // Exact ODF 1.3 mimetype first/stored/no-extra header (part2 §3.3).
    if original.len() < 38
        || &original[..4] != b"PK\x03\x04"
        || original[8..10] != [0, 0]
        || original[26..30] != [8, 0, 0, 0]
        || &original[30..38] != b"mimetype"
        || p.raw_part("mimetype") != Some(MIME.as_bytes())
    {
        return Err(fail("ODF_MIMETYPE", "mimetype"));
    }
    let manifest = tree(p, "META-INF/manifest.xml", control)?;
    if !manifest.is(M, "manifest") || manifest.attr(M, "version") != Some("1.3") {
        return Err(fail("ODF_VERSION", "manifest"));
    }
    attrs(&manifest, &[(M, "version")], r)?;
    let mut entries = BTreeMap::new();
    for n in manifest.nodes() {
        if !n.is(M, "file-entry") {
            unknown(n, r)?;
            continue;
        }
        attrs(
            n,
            &[
                (M, "full-path"),
                (M, "media-type"),
                (M, "version"),
                (M, "size"),
            ],
            r,
        )?;
        let path = n
            .attr(M, "full-path")
            .ok_or_else(|| fail("ODF_MANIFEST", &n.location))?;
        if path != "/" {
            container::safe_name(path.strip_suffix('/').unwrap_or(path)).map_err(ingress)?;
            if path == "mimetype" || path == "META-INF/manifest.xml" {
                return Err(fail("ODF_MANIFEST", path));
            }
        }
        let mime = n
            .attr(M, "media-type")
            .ok_or_else(|| fail("ODF_MANIFEST", path))?;
        if entries.insert(path.to_string(), mime.to_string()).is_some() {
            return Err(fail("ODF_DUPLICATE_MANIFEST", path));
        }
        for c in n.nodes() {
            if c.is(M, "encryption-data") {
                return Err(fail("ODF_ENCRYPTED", path));
            }
            unknown(c, r)?
        }
    }
    if entries.get("/").map(String::as_str) != Some(MIME)
        || entries.get("content.xml").map(String::as_str) != Some("text/xml")
    {
        return Err(fail("ODF_MANIFEST", "root/content-type"));
    }
    for part in p.part_names() {
        if part == "mimetype" || part == "META-INF/manifest.xml" {
            continue;
        }
        if part.starts_with("META-INF/") {
            r.diagnostic("UNSUPPORTED_SIGNATURE_OR_METADATA", part)?;
            continue;
        }
        if !entries.contains_key(part) {
            return Err(fail("ODF_UNMANIFESTED", part));
        }
        if !matches!(part, "content.xml" | "styles.xml") && !part.starts_with("Pictures/") {
            r.diagnostic("UNSUPPORTED_PACKAGE_PART", part)?
        }
    }
    for path in entries.keys() {
        if path != "/" && !path.ends_with('/') && p.raw_part(path).is_none() {
            return Err(fail("ODF_MISSING_MANIFEST_PART", path));
        }
    }
    p.scan_odf_xml(&mut || {
        control().map_err(|e| {
            container::Failure::new(
                if e.location.contains("Timeout") {
                    container::Code::Timeout
                } else if e.location.contains("Cancelled") {
                    container::Code::Cancelled
                } else {
                    container::Code::Budget
                },
                "job",
            )
        })
    })
    .map_err(ingress)?;
    Ok(entries)
}
#[derive(Clone, Default)]
struct Props {
    marks: Vec<(Mark, Option<String>)>,
    disabled: Vec<Mark>,
}
impl Props {
    fn set(&mut self, mark: Mark, value: Option<String>) {
        self.marks.retain(|(m, _)| *m != mark);
        self.disabled.retain(|m| *m != mark);
        self.marks.push((mark, value));
    }
    fn off(&mut self, mark: Mark) {
        self.marks.retain(|(m, _)| *m != mark);
        self.disabled.retain(|m| *m != mark);
        self.disabled.push(mark);
    }
    fn overlay(&mut self, p: &Props) {
        for m in &p.disabled {
            self.off(*m)
        }
        for (m, v) in &p.marks {
            self.set(*m, v.clone())
        }
    }
}
#[derive(Clone)]
struct Style {
    family: String,
    parent: Option<String>,
    props: Props,
}
#[derive(Default)]
struct Styles {
    named: BTreeMap<String, Style>,
    defaults: BTreeMap<String, Props>,
    lists: BTreeMap<String, BTreeMap<usize, ContainerStyle>>,
}
fn properties(n: &Node, r: &mut Report) -> Result<Props> {
    let mut p = Props::default();
    attrs(
        n,
        &[
            (F, "font-weight"),
            (F, "font-style"),
            (S, "text-underline-style"),
            (S, "text-line-through-style"),
            (S, "text-position"),
        ],
        r,
    )?;
    for (ns, key, on, off, mark) in [
        (F, "font-weight", "bold", "normal", Mark::Bold),
        (F, "font-style", "italic", "normal", Mark::Italic),
        (S, "text-underline-style", "solid", "none", Mark::Underline),
        (S, "text-line-through-style", "solid", "none", Mark::Strike),
    ] {
        if let Some(v) = n.attr(ns, key) {
            if v == on {
                p.set(mark, None);
            } else if v == off {
                p.off(mark);
            } else {
                r.diagnostic("UNSUPPORTED_TEXT_PROPERTY", &n.location)?
            }
        }
    }
    if n.attr(S, "text-position").is_some() {
        r.diagnostic("UNSUPPORTED_TEXT_POSITION", &n.location)?
    }
    for c in n.nodes() {
        unknown(c, r)?
    }
    Ok(p)
}
impl Styles {
    fn collect(&mut self, n: &Node, r: &mut Report) -> Result<()> {
        attrs(n, &[], r)?;
        for c in n.nodes() {
            if c.is(S, "style") || c.is(S, "default-style") {
                attrs(
                    c,
                    &[
                        (S, "name"),
                        (S, "family"),
                        (S, "parent-style-name"),
                        (S, "display-name"),
                    ],
                    r,
                )?;
                let family = c.attr(S, "family").unwrap_or("");
                if !matches!(family, "text" | "paragraph") {
                    unknown(c, r)?;
                    continue;
                }
                let mut props = Props::default();
                for d in c.nodes() {
                    if d.is(S, "text-properties") {
                        let p = properties(d, r)?;
                        props.overlay(&p)
                    } else {
                        unknown(d, r)?
                    }
                }
                if c.is(S, "default-style") {
                    if self.defaults.insert(family.into(), props).is_some() {
                        return Err(fail("ODF_DUPLICATE_STYLE", &c.location));
                    }
                } else {
                    let name = c
                        .attr(S, "name")
                        .ok_or_else(|| fail("ODF_STYLE", &c.location))?;
                    if self
                        .named
                        .insert(
                            name.into(),
                            Style {
                                family: family.into(),
                                parent: c.attr(S, "parent-style-name").map(str::to_string),
                                props,
                            },
                        )
                        .is_some()
                    {
                        return Err(fail("ODF_DUPLICATE_STYLE", name));
                    }
                }
            } else if c.is(T, "list-style") {
                attrs(c, &[(S, "name")], r)?;
                let name = c
                    .attr(S, "name")
                    .ok_or_else(|| fail("ODF_LIST_STYLE", &c.location))?;
                let mut levels = BTreeMap::new();
                for d in c.nodes() {
                    let style = if d.is(T, "list-level-style-number") {
                        attrs(
                            d,
                            &[
                                (T, "level"),
                                (T, "start-value"),
                                (S, "num-format"),
                                (S, "num-prefix"),
                                (S, "num-suffix"),
                            ],
                            r,
                        )?;
                        if d.attr(S, "num-format") != Some("1")
                            || d.attr(S, "num-prefix").is_some_and(|v| !v.is_empty())
                            || d.attr(S, "num-suffix").is_some_and(|v| v != ".")
                        {
                            r.diagnostic("UNSUPPORTED_NUMBERING_FORMAT", &d.location)?;
                        }
                        ContainerStyle::Ordered {
                            start: count(d, T, "start-value", 1, 2147483647)? as u32,
                        }
                    } else if d.is(T, "list-level-style-bullet") {
                        attrs(d, &[(T, "level"), (T, "bullet-char")], r)?;
                        if d.attr(T, "bullet-char") != Some("•") {
                            r.diagnostic("UNSUPPORTED_BULLET_GLYPH", &d.location)?
                        }
                        ContainerStyle::Unordered
                    } else {
                        unknown(d, r)?;
                        continue;
                    };
                    for child in d.nodes() {
                        unknown(child, r)?
                    }
                    let level = count(d, T, "level", 1, 8)?;
                    if levels.insert(level, style).is_some() {
                        return Err(fail("ODF_DUPLICATE_LIST_LEVEL", &d.location));
                    }
                }
                if self.lists.insert(name.into(), levels).is_some() {
                    return Err(fail("ODF_DUPLICATE_LIST_STYLE", name));
                }
            } else {
                unknown(c, r)?
            }
        }
        Ok(())
    }
    fn apply(
        &self,
        name: Option<&str>,
        family: &str,
        base: &Props,
        r: &mut Report,
    ) -> Result<Props> {
        let mut out = base.clone();
        let mut chain = vec![];
        let mut next = name;
        let mut seen = BTreeSet::new();
        while let Some(n) = next {
            if !seen.insert(n) || seen.len() > 32 {
                return Err(fail("ODF_STYLE_CYCLE", n));
            }
            let Some(s) = self.named.get(n) else {
                r.diagnostic("UNSUPPORTED_STYLE_REFERENCE", n)?;
                break;
            };
            if s.family != family {
                return Err(fail("ODF_STYLE_FAMILY", n));
            }
            chain.push(s);
            next = s.parent.as_deref()
        }
        for s in chain.into_iter().rev() {
            out.overlay(&s.props)
        }
        Ok(out)
    }
}
// Preserve interleaving of text/spans/entities. ODF XML whitespace collapses;
// text:s, tab and line-break represent exact explicit whitespace.
#[derive(Default)]
struct Runs {
    runs: Vec<FragmentRun>,
    pending: bool,
    pending_props: Option<Props>,
    started: bool,
    units: usize,
}
impl Runs {
    fn push(&mut self, text: &str, p: &Props) -> Result<()> {
        self.units = self
            .units
            .checked_add(text.encode_utf16().count())
            .filter(|v| *v <= 1024 * 1024)
            .ok_or_else(|| fail("BUDGET", "text-expansion"))?;
        let marks = p
            .marks
            .iter()
            .map(|(m, v)| (m.clone(), v.clone()))
            .collect::<Vec<_>>();
        if let Some(last) = self.runs.last_mut().filter(|r| r.marks == marks) {
            last.text.push_str(text)
        } else {
            self.runs.push(FragmentRun {
                opaque_marks: vec![],
                text: text.into(),
                marks,
            })
        }
        if self.runs.len() > 1024 {
            return Err(fail("BUDGET", "runs"));
        }
        Ok(())
    }
    fn literal(&mut self, text: &str, p: &Props) -> Result<()> {
        if self.pending && self.started {
            let props = self.pending_props.take().unwrap_or_else(|| p.clone());
            self.push(" ", &props)?
        }
        self.pending = false;
        self.pending_props = None;
        self.push(text, p)?;
        self.started = true;
        Ok(())
    }
    fn text(&mut self, text: &str, p: &Props) -> Result<()> {
        for c in text.chars() {
            if matches!(c, ' ' | '\t' | '\n' | '\r') {
                if !self.pending {
                    self.pending_props = Some(p.clone());
                }
                self.pending = true
            } else {
                self.literal(c.encode_utf8(&mut [0; 4]), p)?
            }
        }
        Ok(())
    }
}
fn inline(n: &Node, p: &Props, styles: &Styles, out: &mut Runs, r: &mut Report) -> Result<()> {
    for i in &n.items {
        match i {
            Item::Text(t) => out.text(t, p)?,
            Item::Node(c) => {
                if c.is(T, "span") {
                    attrs(c, &[(T, "style-name")], r)?;
                    let p = styles.apply(c.attr(T, "style-name"), "text", p, r)?;
                    inline(c, &p, styles, out, r)?
                } else if c.is(T, "a") {
                    attrs(c, &[(X, "href"), (X, "type")], r)?;
                    let mut p = p.clone();
                    if let Some(href) = c.attr(X, "href") {
                        if let Ok(url) = normalize_link_url(href) {
                            p.set(Mark::Link, Some(url));
                        } else {
                            r.diagnostic("UNSAFE_LINK_INERT", &c.location)?
                        }
                    }
                    inline(c, &p, styles, out, r)?
                } else if c.is(T, "s") {
                    attrs(c, &[(T, "c")], r)?;
                    for d in c.nodes() {
                        unknown(d, r)?
                    }
                    let count = count(c, T, "c", 1, 4096)?;
                    out.literal(&" ".repeat(count), p)?
                } else if c.is(T, "tab") || c.is(T, "line-break") {
                    attrs(c, &[], r)?;
                    for d in c.nodes() {
                        unknown(d, r)?
                    }
                    out.literal(if c.is(T, "tab") { "\t" } else { "\n" }, p)?
                } else {
                    unknown(c, r)?
                }
            }
        }
    }
    Ok(())
}
fn paragraph(n: &Node, styles: &Styles, r: &mut Report) -> Result<FragmentBlock> {
    attrs(
        n,
        if n.is(T, "h") {
            &[(T, "style-name"), (T, "outline-level")]
        } else {
            &[(T, "style-name")]
        },
        r,
    )?;
    let mut base = styles.defaults.get("text").cloned().unwrap_or_default();
    if let Some(p) = styles.defaults.get("paragraph") {
        base.overlay(p);
    }
    let p = styles.apply(n.attr(T, "style-name"), "paragraph", &base, r)?;
    let mut runs = Runs::default();
    inline(n, &p, styles, &mut runs, r)?;
    r.utf16_units += runs.units;
    if r.utf16_units > 1024 * 1024 {
        return Err(fail("BUDGET", "total-text"));
    }
    let attributes = if n.is(T, "h") {
        Some(BlockAttributes::Heading(
            count(n, T, "outline-level", 1, 6)? as u8,
        ))
    } else {
        None
    };
    Ok(FragmentBlock {
        runs: runs.runs,
        attributes,
        containers: vec![],
        checked: None,
    })
}
fn atom(content: Content) -> Result<FragmentBlock> {
    let fallback = match &content {
        Content::Table { source, .. } => source.clone(),
        _ => content
            .asset_fallback()
            .or_else(|| content.inert_source())
            .unwrap_or("")
            .to_string(),
    };
    let tuple = content
        .tuple()
        .map_err(|_| fail("SHARED_DESCRIPTOR", "content"))?;
    Ok(FragmentBlock {
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: fallback,
            marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(tuple)),
        containers: vec![],
        checked: None,
    })
}
struct Mapper<'a, Ss: SessionStore + AssetStore, H: OriginalMediaHost, N: FnMut() -> u64> {
    job: &'a mut PreparedJob<Ss>,
    package: &'a mut Package,
    styles: &'a Styles,
    entries: &'a BTreeMap<String, String>,
    host: &'a mut H,
    report: &'a mut Report,
    now: &'a mut N,
    admitted: BTreeMap<String, ([u8; 32], AssetIdentity)>,
    serial: usize,
    blocks: Vec<FragmentBlock>,
}
impl<Ss: SessionStore + AssetStore, H: OriginalMediaHost, N: FnMut() -> u64> Mapper<'_, Ss, H, N> {
    fn check(&mut self) -> Result<()> {
        self.job
            .check((self.now)())
            .map_err(|e| fail("JOB", &format!("control:{e:?}")))
    }
    fn add(&mut self, mut b: FragmentBlock, containers: &[(String, ContainerStyle)]) -> Result<()> {
        self.check()?;
        b.containers = containers.to_vec();
        self.package
            .charge_output_nodes(1 + b.runs.len() + b.containers.len())
            .map_err(ingress)?;
        self.blocks.push(b);
        if self.blocks.len() > 126 {
            return Err(fail("BUDGET", "blocks"));
        }
        Ok(())
    }
    fn body(
        &mut self,
        n: &Node,
        containers: &[(String, ContainerStyle)],
        list_style: Option<&str>,
    ) -> Result<()> {
        for c in n.nodes() {
            self.check()?;
            if c.is(T, "p") || c.is(T, "h") {
                let frames = c.children(D, "frame").collect::<Vec<_>>();
                if !frames.is_empty() {
                    if frames.len() == 1
                        && c.nodes().count() == 1
                        && c.items
                            .iter()
                            .all(|i| !matches!(i,Item::Text(t)if !t.trim().is_empty()))
                    {
                        attrs(c, &[], self.report)?;
                        if let Some(b) = self.image(frames[0])? {
                            self.add(b, containers)?
                        }
                    } else {
                        self.report
                            .diagnostic("UNSUPPORTED_INLINE_IMAGE_PLACEMENT", &c.location)?;
                        let b = paragraph(c, self.styles, self.report)?;
                        self.add(b, containers)?
                    }
                } else {
                    let b = paragraph(c, self.styles, self.report)?;
                    self.add(b, containers)?
                }
            } else if c.is(T, "list") {
                attrs(c, &[(T, "style-name")], self.report)?;
                if containers.len() >= 8 {
                    return Err(fail("BUDGET", "list-depth"));
                }
                let name = c
                    .attr(T, "style-name")
                    .or(list_style)
                    .ok_or_else(|| fail("ODF_LIST_STYLE", &c.location))?;
                let style = self
                    .styles
                    .lists
                    .get(name)
                    .and_then(|m| m.get(&(containers.len() + 1)))
                    .ok_or_else(|| fail("UNSUPPORTED_LIST_LEVEL", &c.location))?
                    .clone();
                self.serial += 1;
                let mut nested = containers.to_vec();
                nested.push((format!("odt-list-{}", self.serial), style));
                for item in c.nodes() {
                    if !item.is(T, "list-item") {
                        unknown(item, self.report)?;
                        continue;
                    }
                    attrs(item, &[], self.report)?;
                    if item.children(T, "p").count() + item.children(T, "h").count() != 1 {
                        self.report
                            .diagnostic("UNSUPPORTED_LIST_ITEM_PARAGRAPHS", &item.location)?;
                    }
                    self.body(item, &nested, Some(name))?
                }
            } else if c.is(TB, "table") {
                if !containers.is_empty() {
                    unknown(c, self.report)?;
                    self.report
                        .diagnostic("UNSUPPORTED_TABLE_IN_LIST", &c.location)?
                } else if let Some(b) = self.table(c)? {
                    self.add(b, &[])?
                }
            } else {
                unknown(c, self.report)?
            }
        }
        Ok(())
    }
    fn table(&mut self, n: &Node) -> Result<Option<FragmentBlock>> {
        attrs(n, &[(TB, "name")], self.report)?;
        let mut rows = vec![];
        let mut labels = vec![];
        let mut width = None;
        for tr in n.nodes() {
            self.check()?;
            if !tr.is(TB, "table-row") {
                unknown(tr, self.report)?;
                continue;
            }
            attrs(tr, &[], self.report)?;
            if tr.attr(TB, "number-rows-repeated").is_some() {
                return Err(fail("UNSUPPORTED_TABLE_REPEAT", &tr.location));
            }
            let mut cells = vec![];
            let mut text = vec![];
            for tc in tr.nodes() {
                if !tc.is(TB, "table-cell") {
                    unknown(n, self.report)?;
                    return Ok(None);
                }
                attrs(tc, &[(O, "value-type")], self.report)?;
                if tc.attrs.keys().any(|(ns, k)| {
                    ns == TB
                        && [
                            "number-columns-spanned",
                            "number-rows-spanned",
                            "number-columns-repeated",
                        ]
                        .contains(&k.as_str())
                }) {
                    return Err(fail("UNSUPPORTED_TABLE_STRUCTURE", &tc.location));
                }
                if tc.attr(O, "value-type").is_some_and(|s| s != "string") {
                    self.report
                        .diagnostic("UNSUPPORTED_TYPED_CELL", &tc.location)?
                }
                let ps = tc.children(T, "p").collect::<Vec<_>>();
                if ps.len() != 1 || tc.nodes().count() != 1 {
                    unknown(n, self.report)?;
                    return Ok(None);
                }
                let b = paragraph(ps[0], self.styles, self.report)?;
                if b.runs.iter().any(|r| r.text.contains(['\r', '\n'])) {
                    self.report
                        .diagnostic("UNSUPPORTED_CELL_BREAK", &tc.location)?;
                    unknown(n, self.report)?;
                    return Ok(None);
                }
                self.package
                    .charge_output_nodes(1 + b.runs.len())
                    .map_err(ingress)?;
                text.push(b.runs.iter().map(|r| r.text.as_str()).collect::<String>());
                cells.push(b.runs);
                if cells.len() > 32 {
                    return Err(fail("BUDGET", "columns"));
                }
            }
            if cells.is_empty() || width.is_some_and(|w| w != cells.len()) {
                return Err(fail("ODF_TABLE_RECTANGLE", &tr.location));
            }
            width = Some(cells.len());
            self.package.charge_output_nodes(1).map_err(ingress)?;
            rows.push(cells);
            labels.push(text.join("\t"));
            if rows.len() > 128 {
                return Err(fail("BUDGET", "rows"));
            }
        }
        let w = width.ok_or_else(|| fail("ODF_TABLE_EMPTY", &n.location))?;
        atom(Content::Table {
            alignments: vec![Alignment::None; w],
            rows,
            source: labels.join("\n"),
        })
        .map(Some)
    }
    fn image(&mut self, n: &Node) -> Result<Option<FragmentBlock>> {
        attrs(n, &[(T, "anchor-type"), (D, "name")], self.report)?;
        if n.attr(T, "anchor-type") != Some("as-char") {
            unknown(n, self.report)?;
            self.report
                .diagnostic("UNSUPPORTED_FLOATING_IMAGE", &n.location)?;
            return Ok(None);
        }
        for c in n.nodes() {
            if !c.is(D, "image") && !c.is(SVG, "title") && !c.is(SVG, "desc") {
                unknown(c, self.report)?
            }
        }
        let image = n
            .child(D, "image")?
            .ok_or_else(|| fail("ODF_IMAGE", &n.location))?;
        attrs(
            image,
            &[(X, "href"), (X, "type"), (X, "show"), (X, "actuate")],
            self.report,
        )?;
        for c in image.nodes() {
            unknown(c, self.report)?
        }
        let href = image
            .attr(X, "href")
            .ok_or_else(|| fail("ODF_IMAGE", &image.location))?;
        if !href.starts_with("Pictures/") || href.contains([':', '%', '#', '?']) {
            self.report
                .diagnostic("EXTERNAL_OR_UNSUPPORTED_IMAGE_INERT", &image.location)?;
            return Ok(None);
        }
        container::safe_name(href).map_err(ingress)?;
        if self.entries.get(href).map(String::as_str) != Some("image/png") {
            self.report.diagnostic("UNSUPPORTED_MEDIA_TYPE", href)?;
            return Ok(None);
        }
        let (width, height) = self
            .job
            .validate_container_media(self.package, href, &mut *self.now)
            .map_err(ingress)?;
        let bytes = self
            .package
            .part(href)
            .ok_or_else(|| fail("ODF_IMAGE", href))?;
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        let identity = if let Some((hash, id)) = self.admitted.get(href) {
            if *hash != digest {
                return Err(fail("ODF_IMAGE_IDENTITY", href));
            }
            id.clone()
        } else {
            let identity = self
                .host
                .identity(&digest)
                .map_err(|_| fail("JOB", "media-identity"))?;
            identity
                .validate()
                .map_err(|_| fail("ODF_IMAGE_IDENTITY", href))?;
            if self
                .admitted
                .values()
                .any(|(hash, id)| *id == identity && *hash != digest)
            {
                return Err(fail("ODF_IMAGE_IDENTITY_COLLISION", href));
            }
            if !self.admitted.values().any(|(_, id)| *id == identity) {
                self.job
                    .stage_asset(
                        identity.clone(),
                        AssetAction::Ingest,
                        bytes.len() as u64,
                        &mut Media {
                            host: self.host,
                            bytes,
                        },
                        (self.now)(),
                    )
                    .map_err(|_| fail("JOB", "media-stage"))?;
                self.report.staged_bytes += bytes.len()
            }
            self.admitted
                .insert(href.into(), (digest, identity.clone()));
            identity
        };
        self.job
            .check((self.now)())
            .map_err(|_| fail("JOB", "post-ingest-control"))?;
        let mut label = |tag| -> Result<String> {
            if let Some(c) = n.child(SVG, tag)? {
                attrs(c, &[], self.report)?;
                for d in c.nodes() {
                    unknown(d, self.report)?
                }
                Ok(c.items
                    .iter()
                    .filter_map(|i| {
                        if let Item::Text(t) = i {
                            Some(t.as_str())
                        } else {
                            None
                        }
                    })
                    .collect())
            } else {
                Ok(String::new())
            }
        };
        let alt = label("desc")?;
        let caption = label("title")?;
        let filename = href.rsplit('/').next().unwrap().to_string();
        let fallback = if alt.is_empty() {
            format!("Image: {filename}")
        } else {
            alt.clone()
        };
        atom(Content::Asset {
            descriptor: AssetDescriptor {
                identity,
                kind: AssetKind::Image,
                metadata: AssetMetadata {
                    filename,
                    media_type: "image/png".into(),
                    byte_length: Some(bytes.len() as u64),
                    sha256: Some(format!("{:x}", Sha256::digest(bytes))),
                    width: Some(width),
                    height: Some(height),
                    duration_ms: None,
                    alt,
                    caption,
                },
                fallback,
                source: String::new(),
            },
        })
        .map(Some)
    }
}
/// Prepare exactly once; all failures retire job-owned staging. Execution and
/// asset authorization use the existing job/AssetWork ports; no ambient I/O.
pub fn prepare<Ss: SessionStore + AssetStore>(
    job: &mut PreparedJob<Ss>,
    budgets: Budgets,
    host: &mut impl OriginalMediaHost,
    mut now: impl FnMut() -> u64,
) -> Result<Prepared> {
    let mut report = Report::default();
    let mut archive = None;
    let result = (|| {
        if job.contract().profile != PROFILE || job.contract().direction != Direction::Import {
            return Err(fail("ODF_PROFILE", "job"));
        }
        archive = Some(
            job.prepare_archive(budgets, &mut now, false)
                .map_err(ingress)?,
        );
        let mut p = archive.as_mut().unwrap();
        let entries = package(&mut p, job.source().original(), &mut report, &mut || {
            job.check(now()).map_err(|e| fail("JOB", &format!("{e:?}")))
        })?;
        let content = tree(&mut p, "content.xml", &mut || {
            job.check(now()).map_err(|_| fail("JOB", "control"))
        })?;
        if !content.is(O, "document-content") || content.attr(O, "version") != Some("1.3") {
            return Err(fail("ODF_VERSION", "content.xml"));
        }
        attrs(&content, &[(O, "version")], &mut report)?;
        let mut styles = Styles::default();
        if p.raw_part("styles.xml").is_some() {
            let root = tree(&mut p, "styles.xml", &mut || {
                job.check(now()).map_err(|_| fail("JOB", "control"))
            })?;
            if !root.is(O, "document-styles") || root.attr(O, "version") != Some("1.3") {
                return Err(fail("ODF_VERSION", "styles.xml"));
            }
            attrs(&root, &[(O, "version")], &mut report)?;
            for c in root.nodes() {
                if c.is(O, "styles") {
                    styles.collect(c, &mut report)?
                } else {
                    unknown(c, &mut report)?
                }
            }
        }
        if let Some(s) = content.child(O, "automatic-styles")? {
            styles.collect(s, &mut report)?
        }
        for c in content.nodes() {
            if !c.is(O, "body") && !c.is(O, "automatic-styles") {
                unknown(c, &mut report)?
            }
        }
        let body = content
            .child(O, "body")?
            .ok_or_else(|| fail("ODF_BODY", "content.xml"))?;
        attrs(body, &[], &mut report)?;
        let text = body
            .child(O, "text")?
            .ok_or_else(|| fail("ODF_TEXT", "content.xml"))?;
        attrs(text, &[], &mut report)?;
        for c in body.nodes() {
            if !c.is(O, "text") {
                unknown(c, &mut report)?
            }
        }
        let mut m = Mapper {
            job,
            package: &mut p,
            styles: &styles,
            entries: &entries,
            host,
            report: &mut report,
            now: &mut now,
            admitted: BTreeMap::new(),
            serial: 0,
            blocks: vec![],
        };
        m.body(text, &[], None)?;
        m.check()?;
        for part in m.package.part_names() {
            if part.starts_with("Pictures/") && !m.admitted.contains_key(part) {
                m.report.diagnostic("UNIMPORTED_EMBEDDED_MEDIA", part)?
            }
        }
        let blocks = m.blocks;
        if blocks.is_empty() {
            return Err(fail("ODF_NO_SUPPORTED_CONTENT", "content.xml"));
        }
        p.charge_output_nodes(blocks.iter().map(|b| b.runs.len() + 1).sum())
            .map_err(ingress)?;
        struct Size {
            n: usize,
            max: usize,
        }
        impl std::fmt::Write for Size {
            fn write_str(&mut self, s: &str) -> std::fmt::Result {
                self.n = self
                    .n
                    .checked_add(s.len())
                    .filter(|n| *n <= self.max)
                    .ok_or(std::fmt::Error)?;
                Ok(())
            }
        }
        use std::fmt::Write;
        write!(
            &mut Size {
                n: 0,
                max: job.contract().limits.output_bytes
            },
            "{blocks:?}"
        )
        .map_err(|_| fail("BUDGET", "output-bytes"))?;
        report.work = p.work();
        report.blocks = blocks.len();
        report
            .diagnostics
            .sort_by(|a, b| (&a.location, a.code).cmp(&(&b.location, b.code)));
        report.diagnostics.dedup();
        Ok(Prepared {
            blocks,
            report: report.clone(),
            token: job.token.clone(),
            original_sha256: job.contract().input_sha256,
        })
    })();
    if let Err(mut e) = result {
        e.diagnostics.extend(report.diagnostics);
        if e.work == Work::default() {
            e.work = archive.as_ref().map(Package::work).unwrap_or_default()
        }
        job.abort().map_err(|_| fail("JOB", "cleanup"))?;
        Err(e)
    } else {
        result
    }
}
