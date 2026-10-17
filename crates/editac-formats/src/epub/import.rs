//! Optional EPUB 3.3 reflowable import. Unknown content is inert, diagnosed and
//! recoverable from the immutable job input; no package execution or fetching.
use crate::{
    Direction,
    container::{self, Budgets, Package, Work},
    job::*,
};
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::normalize_link_url,
    },
    document::BlockAttributes,
    modules::{assets::*, content::Content},
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
const C: &str = "urn:oasis:names:tc:opendocument:xmlns:container";
const O: &str = "http://www.idpf.org/2007/opf";
const H: &str = "http://www.w3.org/1999/xhtml";
const E: &str = "http://www.idpf.org/2007/ops";
const DC: &str = "http://purl.org/dc/elements/1.1/";
const MIME: &str = "application/epub+zip";
pub const PROFILE: crate::Profile = crate::Profile {
    id: "edit-ac-epub-v1",
    format: "epub",
    version: 1,
    import: true,
    export: false,
    available: true,
    fidelity: "epub33-reflowable-semantic-v1",
    owner: "CNV-1.14",
    limits: crate::LIMITS,
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chapter {
    pub part: String,
    pub first_block: usize,
    pub block_count: usize,
    pub source_sha256: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Navigation {
    pub label: String,
    pub part: String,
    pub fragment: Option<String>,
}
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
    pub chapters: Vec<Chapter>,
    pub navigation: Vec<Navigation>,
    pub metadata: BTreeMap<String, String>,
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
    p.scan_mapping_xml(part, &mut || {
        control().map_err(|_| container::Failure::new(container::Code::Cancelled, part))
    })
    .map_err(ingress)?;
    let bytes = p
        .raw_part(part)
        .ok_or_else(|| fail("MISSING_PART", part))?
        .to_vec();
    p.charge_mapping_bytes(bytes.len()).map_err(ingress)?;
    let raw = std::str::from_utf8(&bytes).map_err(|_| fail("XML_ENCODING", part))?;
    if raw.chars().any(|c| !matches!(c as u32, 0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)) { return Err(fail("XML_CHAR", part)); }
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
                if stack.len() >= 32 || e.attributes().count() > 64 {
                    return Err(fail("BUDGET", part));
                }
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
                } else if !v.trim().is_empty() {
                    return Err(fail("XML", part));
                }
            }
            Event::CData(e) => {
                let v = e
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(|_| fail("XML", part))?
                    .into_owned();
                if let Some(n) = stack.last_mut() {
                    n.items.push(Item::Text(v))
                } else if !v.trim().is_empty() {
                    return Err(fail("XML", part));
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
                } else if !v.trim().is_empty() {
                    return Err(fail("XML", part));
                }
            }
            Event::Decl(d) => {
                if let Some(enc) = d.encoding() {
                    let enc = enc.map_err(|_| fail("XML_ENCODING", part))?;
                    if !enc.eq_ignore_ascii_case(b"utf-8") {
                        return Err(fail("XML_ENCODING", part));
                    }
                }
            }
            Event::PI(_) => return Err(fail("XML_PROCESSING_INSTRUCTION", part)),
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
// URLs stay inside this immutable package. Percent-encoded and query references
// are outside v1; no fallback resolver, filesystem access or remote transport.
fn resolve(base: &str, href: &str) -> Result<(String, Option<String>)> {
    if href.len() > 4096
        || href.contains([':', '%', '?', '\\'])
        || href.starts_with('/')
        || href.chars().any(|c| c.is_control())
    {
        return Err(fail("EPUB_UNSUPPORTED_URL", href));
    }
    let (path, fragment) = href
        .split_once('#')
        .map_or((href, None), |(p, f)| (p, Some(f.to_string())));
    if path.is_empty() {
        return Ok((base.into(), fragment));
    }
    let mut parts: Vec<&str> = base
        .rsplit_once('/')
        .map_or(vec![], |(dir, _)| dir.split('/').collect());
    for part in path.split('/') {
        match part {
            ".." => {
                if parts.pop().is_none() {
                    return Err(fail("EPUB_PATH", href));
                }
            }
            "." => (),
            "" => return Err(fail("EPUB_PATH", href)),
            _ => parts.push(part),
        }
    }
    let path = parts.join("/");
    container::safe_name(&path).map_err(ingress)?;
    Ok((path, fragment))
}
fn text(n: &Node) -> String {
    n.items
        .iter()
        .map(|i| match i {
            Item::Text(t) => t.clone(),
            Item::Node(n) => text(n),
        })
        .collect()
}
fn required<'a>(n: &'a Node, key: &str) -> Result<&'a str> {
    n.attr("", key)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail("EPUB_REQUIRED_ATTRIBUTE", &n.location))
}
fn child<'a>(n: &'a Node, ns: &str, key: &str) -> Result<&'a Node> {
    n.child(ns, key)?
        .ok_or_else(|| fail("EPUB_REQUIRED_ELEMENT", &n.location))
}
fn structural(n: &Node, r: &mut Report) -> Result<()> {
    if n.items
        .iter()
        .any(|i| matches!(i,Item::Text(t) if !t.trim().is_empty()))
    {
        r.diagnostic("UNSUPPORTED_STRUCTURAL_TEXT", &n.location)?;
    }
    Ok(())
}
fn attributes(n: &Node, allowed: &[(&str, &str)], r: &mut Report) -> Result<()> {
    for ((ns, key), _) in &n.attrs {
        if !allowed.contains(&(ns.as_str(), key.as_str())) {
            r.diagnostic(
                "UNSUPPORTED_ATTRIBUTE",
                &format!("{}@{{{ns}}}{key}", n.location),
            )?;
        }
    }
    Ok(())
}
fn unknown(n: &Node, r: &mut Report) -> Result<()> {
    r.diagnostic(
        "UNSUPPORTED_ELEMENT",
        &format!("{}:{{{}}}{}", n.location, n.ns, n.name),
    )?;
    attributes(n, &[], r)?;
    for c in n.nodes() {
        unknown(c, r)?;
    }
    Ok(())
}
#[derive(Clone)]
struct Entry {
    path: Option<String>,
    mime: String,
    nav: bool,
}
struct Publication {
    spine: Vec<String>,
    nav: String,
    entries: BTreeMap<String, Entry>,
}
fn package(
    p: &mut Package,
    original: &[u8],
    r: &mut Report,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<Publication> {
    if p.raw_part("mimetype") != Some(MIME.as_bytes())
        || original.get(0..4) != Some(b"PK\x03\x04")
        || original.get(8..10) != Some(&[0, 0])
        || original.get(26..30) != Some(&[8, 0, 0, 0])
        || original.get(30..38) != Some(b"mimetype")
    {
        return Err(fail("EPUB_MIMETYPE", "mimetype"));
    }
    for name in ["META-INF/encryption.xml", "META-INF/rights.xml"] {
        if p.raw_part(name).is_some() {
            return Err(fail("EPUB_DRM_OR_ENCRYPTION_UNSUPPORTED", name));
        }
    }
    let root = tree(p, "META-INF/container.xml", control)?;
    if !root.is(C, "container") || root.attr("", "version") != Some("1.0") {
        return Err(fail("EPUB_CONTAINER", "META-INF/container.xml"));
    }
    attributes(&root, &[("", "version")], r)?;
    structural(&root, r)?;
    for c in root.nodes() {
        if !c.is(C, "rootfiles") {
            unknown(c, r)?;
        }
    }
    let roots = child(&root, C, "rootfiles")?;
    attributes(roots, &[], r)?;
    structural(roots, r)?;
    if roots.nodes().count() != 1 {
        return Err(fail("EPUB_MULTIPLE_RENDITIONS", "META-INF/container.xml"));
    }
    let rf = child(roots, C, "rootfile")?;
    attributes(rf, &[("", "full-path"), ("", "media-type")], r)?;
    structural(rf, r)?;
    for c in rf.nodes() {
        unknown(c, r)?;
    }
    if rf.attr("", "media-type") != Some("application/oebps-package+xml") {
        return Err(fail("EPUB_PACKAGE_TYPE", &rf.location));
    }
    let path = required(rf, "full-path")?;
    container::safe_name(path).map_err(ingress)?;
    let root = tree(p, path, control)?;
    if !root.is(O, "package") || root.attr("", "version") != Some("3.0") {
        return Err(fail("EPUB_VERSION", path));
    }
    attributes(
        &root,
        &[
            ("", "version"),
            ("", "unique-identifier"),
            ("http://www.w3.org/XML/1998/namespace", "lang"),
        ],
        r,
    )?;
    let metadata = child(&root, O, "metadata")?;
    attributes(metadata, &[], r)?;
    structural(&root, r)?;
    structural(metadata, r)?;
    let unique = required(&root, "unique-identifier")?;
    for n in metadata.nodes() {
        if n.is(DC, "title") || n.is(DC, "language") || n.is(DC, "identifier") {
            attributes(n, &[("", "id")], r)?;
            for c in n.nodes() {
                unknown(c, r)?;
            }
            if r.metadata.insert(n.name.clone(), text(n)).is_some() {
                return Err(fail("EPUB_AMBIGUOUS_METADATA", &n.location));
            }
        } else if n.is(O, "meta") && n.attr("", "property") == Some("dcterms:modified") {
            attributes(n, &[("", "property")], r)?;
            for c in n.nodes() {
                unknown(c, r)?;
            }
            if r.metadata.insert("modified".into(), text(n)).is_some() {
                return Err(fail("EPUB_AMBIGUOUS_METADATA", &n.location));
            }
        } else if n.is(O, "meta")
            && n.attr("", "property") == Some("rendition:layout")
            && text(n).trim() == "pre-paginated"
        {
            return Err(fail("EPUB_FIXED_LAYOUT_UNSUPPORTED", &n.location));
        } else {
            unknown(n, r)?;
        }
    }
    for key in ["title", "language", "identifier", "modified"] {
        if r.metadata.get(key).is_none_or(|s| s.trim().is_empty()) {
            return Err(fail("EPUB_METADATA", key));
        }
    }
    if !metadata
        .nodes()
        .any(|n| n.is(DC, "identifier") && n.attr("", "id") == Some(unique))
    {
        return Err(fail("EPUB_IDENTIFIER", path));
    }
    let manifest = child(&root, O, "manifest")?;
    attributes(manifest, &[], r)?;
    structural(manifest, r)?;
    let mut entries = BTreeMap::new();
    let mut paths = BTreeSet::new();
    let mut nav = None;
    for n in manifest.nodes() {
        control()?;
        if !n.is(O, "item") {
            unknown(n, r)?;
            continue;
        }
        attributes(
            n,
            &[
                ("", "id"),
                ("", "href"),
                ("", "media-type"),
                ("", "properties"),
            ],
            r,
        )?;
        structural(n, r)?;
        for c in n.nodes() {
            unknown(c, r)?;
        }
        let id = required(n, "id")?.to_string();
        let href = required(n, "href")?;
        let mime = required(n, "media-type")?.to_string();
        let resolved = match resolve(path, href) {
            Ok((path, None)) => Some(path),
            _ => {
                r.diagnostic("UNSUPPORTED_MANIFEST_RESOURCE_URL", href)?;
                None
            }
        };
        if let Some(ref part) = resolved {
            if !paths.insert(part.clone()) {
                return Err(fail("EPUB_MANIFEST_ALIAS", part));
            }
            if p.raw_part(part).is_none() {
                return Err(fail("MISSING_PART", part));
            }
        }
        let mut is_nav = false;
        for property in n.attr("", "properties").unwrap_or("").split_whitespace() {
            if property == "nav" {
                is_nav = true;
            } else {
                r.diagnostic(
                    "UNSUPPORTED_RESOURCE_PROPERTY",
                    &format!("{}:{property}", n.location),
                )?;
            }
        }
        if is_nav {
            if mime != "application/xhtml+xml"
                || resolved.is_none()
                || nav.replace(resolved.clone().unwrap()).is_some()
            {
                return Err(fail("EPUB_NAV", href));
            }
        }
        if !["application/xhtml+xml", "image/png"].contains(&mime.as_str()) {
            r.diagnostic("UNSUPPORTED_RESOURCE_TYPE", &format!("{href}:{mime}"))?;
        }
        if entries
            .insert(
                id,
                Entry {
                    path: resolved,
                    mime,
                    nav: is_nav,
                },
            )
            .is_some()
        {
            return Err(fail("EPUB_DUPLICATE_ID", &n.location));
        }
    }
    let spine_node = child(&root, O, "spine")?;
    attributes(spine_node, &[], r)?;
    structural(spine_node, r)?;
    let mut spine = vec![];
    let mut seen = BTreeSet::new();
    for n in spine_node.nodes() {
        if !n.is(O, "itemref") {
            unknown(n, r)?;
            continue;
        }
        attributes(n, &[("", "idref"), ("", "linear")], r)?;
        structural(n, r)?;
        for c in n.nodes() {
            unknown(c, r)?;
        }
        let e = entries
            .get(required(n, "idref")?)
            .ok_or_else(|| fail("EPUB_IDREF", &n.location))?;
        if n.attrs.values().any(|v| v.contains("pre-paginated")) {
            return Err(fail("EPUB_FIXED_LAYOUT_UNSUPPORTED", &n.location));
        }
        match n.attr("", "linear") {
            Some("no") => {
                r.diagnostic("UNSUPPORTED_NONLINEAR_CHAPTER", &n.location)?;
                continue;
            }
            None | Some("yes") => (),
            _ => return Err(fail("EPUB_LINEAR", &n.location)),
        }
        if e.mime != "application/xhtml+xml" || e.path.is_none() {
            return Err(fail("EPUB_UNSUPPORTED_SPINE_RESOURCE", &n.location));
        }
        let part = e.path.clone().unwrap();
        if !seen.insert(part.clone()) {
            return Err(fail("EPUB_REPEATED_SPINE", &part));
        }
        spine.push(part);
    }
    if spine.is_empty() {
        return Err(fail("EPUB_EMPTY_SPINE", path));
    }
    for n in root.nodes() {
        if !n.is(O, "metadata") && !n.is(O, "manifest") && !n.is(O, "spine") {
            unknown(n, r)?;
        }
    }
    for n in roots.nodes() {
        attributes(n, &[("", "full-path"), ("", "media-type")], r)?;
    }
    let declared: BTreeSet<_> = entries
        .values()
        .filter_map(|e| e.path.as_deref())
        .chain([path, "mimetype", "META-INF/container.xml"])
        .collect();
    for part in p.part_names() {
        if !declared.contains(part) {
            r.diagnostic("UNDECLARED_PACKAGE_PART", part)?;
        }
    }
    Ok(Publication {
        spine,
        nav: nav.ok_or_else(|| fail("EPUB_MISSING_NAV", path))?,
        entries,
    })
}
fn navigation(n: &Node, base: &str, pubn: &Publication, r: &mut Report) -> Result<()> {
    if n.is(H, "a") {
        attributes(n, &[("", "href")], r)?;
        for c in n.nodes() {
            unknown(c, r)?;
        }
        let href = required(n, "href")?;
        match resolve(base, href) {
            Ok((part, fragment)) if pubn.spine.contains(&part) => r.navigation.push(Navigation {
                label: text(n),
                part,
                fragment,
            }),
            _ => r.diagnostic("UNSUPPORTED_NAVIGATION_TARGET", href)?,
        }
    } else {
        structural(n, r)?;
        if !n.is(H, "nav") && !n.is(H, "ol") && !n.is(H, "li") {
            unknown(n, r)?;
            return Ok(());
        }
        attributes(
            n,
            if n.is(H, "nav") {
                &[(E, "type"), ("", "id")]
            } else {
                &[]
            },
            r,
        )?;
        for c in n.nodes() {
            navigation(c, base, pubn, r)?;
        }
    }
    Ok(())
}
fn collect_ids(n: &Node, ids: &mut BTreeSet<String>) -> Result<()> {
    if let Some(id) = n.attr("", "id") {
        if !ids.insert(id.into()) {
            return Err(fail("EPUB_DUPLICATE_XHTML_ID", &n.location));
        }
    }
    for c in n.nodes() {
        collect_ids(c, ids)?;
    }
    Ok(())
}
fn find_toc<'a>(n: &'a Node, out: &mut Vec<&'a Node>) {
    if n.is(H, "nav")
        && n.attr(E, "type")
            .is_some_and(|s| s.split_whitespace().any(|s| s == "toc"))
    {
        out.push(n);
    }
    for c in n.nodes() {
        find_toc(c, out);
    }
}
fn audit_navigation(n: &Node, r: &mut Report) -> Result<()> {
    if n.is(H, "nav") && n.attr(E, "type") == Some("toc") {
        return Ok(());
    }
    if n.ns == H && ["html", "head", "body", "title"].contains(&n.name.as_str()) {
        if !n.is(H, "title") {
            structural(n, r)?;
        }
        attributes(
            n,
            &[
                ("http://www.w3.org/XML/1998/namespace", "lang"),
                ("", "lang"),
            ],
            r,
        )?;
        for c in n.nodes() {
            audit_navigation(c, r)?;
        }
    } else {
        unknown(n, r)?;
    }
    Ok(())
}
// Build the existing inert HTML tree contract, never a live browser document.
fn safe(n: &Node, r: &mut Report) -> Result<serde_json::Value> {
    use serde_json::json;
    attributes(
        n,
        &[("", "href"), ("", "start"), ("", "id"), ("", "style")],
        r,
    )?;
    if n.ns != H
        || [
            "script", "style", "form", "iframe", "object", "embed", "input", "button", "textarea",
            "select", "video", "audio", "canvas", "svg", "math", "table", "link", "meta", "img",
        ]
        .contains(&n.name.as_str())
    {
        unknown(n, r)?;
        r.diagnostic("UNSUPPORTED_XHTML_CONTENT_INERT", &n.location)?;
        return Ok(json!({"kind":"inert"}));
    }
    if ![
        "p",
        "div",
        "span",
        "li",
        "ul",
        "ol",
        "blockquote",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "br",
        "b",
        "strong",
        "i",
        "em",
        "s",
        "del",
        "strike",
        "u",
        "code",
        "a",
    ]
    .contains(&n.name.as_str())
    {
        r.diagnostic("UNSUPPORTED_XHTML_WRAPPER_REDUCED", &n.location)?;
    }
    let mut attrs = vec![];
    for ((ns, key), value) in &n.attrs {
        if ns.is_empty() && ["start", "style"].contains(&key.as_str()) {
            attrs.push(json!({"name":key,"value":value,"namespaced":false}));
        }
        if ns.is_empty() && key == "href" {
            if normalize_link_url(value).is_ok() {
                attrs.push(json!({"name":key,"value":value,"namespaced":false}));
            } else {
                r.diagnostic("UNSUPPORTED_LOCAL_OR_UNSAFE_CONTENT_LINK", &n.location)?;
            }
        }
    }
    let mut children = vec![];
    for i in &n.items {
        children.push(match i {
            Item::Text(t) => json!({"kind":"text","text":t}),
            Item::Node(c) => safe(c, r)?,
        });
    }
    Ok(json!({"kind":"element","tag":n.name,"attributes":attrs,"children":children}))
}
struct Mapper<'a, Ss: SessionStore + AssetStore, Hh: OriginalMediaHost, N: FnMut() -> u64> {
    job: &'a mut PreparedJob<Ss>,
    package: &'a mut Package,
    host: &'a mut Hh,
    report: &'a mut Report,
    now: &'a mut N,
    admitted: BTreeMap<String, ([u8; 32], AssetIdentity)>,
    blocks: Vec<FragmentBlock>,
}
impl<Ss: SessionStore + AssetStore, Hh: OriginalMediaHost, N: FnMut() -> u64>
    Mapper<'_, Ss, Hh, N>
{
    fn check(&mut self) -> Result<()> {
        self.job
            .check((self.now)())
            .map_err(|_| fail("JOB", "control"))
    }
    fn flush(&mut self, nodes: &mut Vec<serde_json::Value>, part: &str) -> Result<()> {
        if nodes.is_empty() {
            return Ok(());
        }
        let imported = match editac_html::import_tree(nodes) {
            Ok(imported) => imported,
            // Inactive/unsupported chunks can sit between supported chapters or
            // images. Their diagnostics were recorded before this shared codec;
            // they contribute no editable blocks and must not poison the rest.
            Err(e) if e == "html-empty" => {
                nodes.clear();
                return Ok(());
            }
            Err(e) => return Err(fail("SAFE_HTML", &format!("{part}:{e}"))),
        };
        for d in imported.diagnostics {
            self.report
                .diagnostic("SAFE_HTML_REDUCTION", &format!("{part}:{d}"))?;
        }
        let prefix = format!("epub-{}-{}", self.report.chapters.len(), self.blocks.len());
        for mut b in imported.blocks {
            for (id, _) in &mut b.containers {
                *id = format!("{prefix}-{id}");
            }
            self.blocks.push(b);
        }
        nodes.clear();
        Ok(())
    }
    fn image(&mut self, n: &Node, base: &str, pubn: &Publication) -> Result<Option<FragmentBlock>> {
        attributes(
            n,
            &[("", "src"), ("", "alt"), ("", "title"), ("", "id")],
            self.report,
        )?;
        for c in n.nodes() {
            unknown(c, self.report)?;
        }
        let href = required(n, "src")?;
        let part = match resolve(base, href) {
            Ok((p, None)) => p,
            _ => {
                self.report
                    .diagnostic("REMOTE_OR_UNSUPPORTED_IMAGE_INERT", href)?;
                return Ok(None);
            }
        };
        if !pubn
            .entries
            .values()
            .any(|e| e.path.as_deref() == Some(&part) && e.mime == "image/png")
        {
            self.report
                .diagnostic("UNSUPPORTED_IMAGE_RESOURCE", &part)?;
            return Ok(None);
        }
        let (width, height) = self
            .job
            .validate_container_media(self.package, &part, &mut *self.now)
            .map_err(ingress)?;
        let bytes = self
            .package
            .part(&part)
            .ok_or_else(|| fail("EPUB_IMAGE", &part))?;
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        let identity = if let Some((_, id)) = self.admitted.get(&part) {
            id.clone()
        } else {
            let id = self
                .host
                .identity(&digest)
                .map_err(|_| fail("JOB", "media-identity"))?;
            id.validate()
                .map_err(|_| fail("EPUB_IMAGE_IDENTITY", &part))?;
            if self
                .admitted
                .values()
                .any(|(h, i)| i == &id && h != &digest)
            {
                return Err(fail("EPUB_IMAGE_IDENTITY_COLLISION", &part));
            }
            if !self.admitted.values().any(|(_, i)| i == &id) {
                self.job
                    .stage_asset(
                        id.clone(),
                        AssetAction::Ingest,
                        bytes.len() as u64,
                        &mut Media {
                            host: self.host,
                            bytes,
                        },
                        (self.now)(),
                    )
                    .map_err(|_| fail("JOB", "media-stage"))?;
                self.report.staged_bytes += bytes.len();
            }
            self.admitted.insert(part.clone(), (digest, id.clone()));
            id
        };
        self.job
            .check((self.now)())
            .map_err(|_| fail("JOB", "post-ingest-control"))?;
        let alt = n.attr("", "alt").unwrap_or("").to_string();
        let filename = part.rsplit('/').next().unwrap().to_string();
        atom(Content::Asset {
            descriptor: AssetDescriptor {
                identity,
                kind: AssetKind::Image,
                metadata: AssetMetadata {
                    filename: filename.clone(),
                    media_type: "image/png".into(),
                    byte_length: Some(bytes.len() as u64),
                    sha256: Some(format!("{:x}", Sha256::digest(bytes))),
                    width: Some(width),
                    height: Some(height),
                    duration_ms: None,
                    alt: alt.clone(),
                    caption: n.attr("", "title").unwrap_or("").into(),
                },
                fallback: if alt.is_empty() {
                    format!("Image: {filename}")
                } else {
                    alt
                },
                source: String::new(),
            },
        })
        .map(Some)
    }
    fn chapter(&mut self, n: &Node, part: &str, pubn: &Publication) -> Result<()> {
        if !n.is(H, "html") {
            return Err(fail("EPUB_XHTML", part));
        }
        attributes(
            n,
            &[
                ("http://www.w3.org/XML/1998/namespace", "lang"),
                ("", "lang"),
            ],
            self.report,
        )?;
        if let Some(head) = n.child(H, "head")? {
            attributes(head, &[], self.report)?;
            for c in head.nodes() {
                if c.is(H, "title") {
                    attributes(c, &[], self.report)?;
                    for d in c.nodes() {
                        unknown(d, self.report)?;
                    }
                    self.report
                        .metadata
                        .insert(format!("chapter-title:{part}"), text(c));
                } else {
                    unknown(c, self.report)?;
                }
            }
        }
        let body = child(n, H, "body")?;
        attributes(body, &[], self.report)?;
        for c in n.nodes() {
            if !c.is(H, "head") && !c.is(H, "body") {
                unknown(c, self.report)?;
            }
        }
        let mut nodes = vec![];
        for i in &body.items {
            self.check()?;
            match i {
                Item::Text(t) if !t.trim().is_empty() => {
                    nodes.push(serde_json::json!({"kind":"text","text":t}))
                }
                Item::Text(_) => (),
                Item::Node(c) => {
                    let image = if c.is(H, "img") {
                        Some(c)
                    } else if c.is(H, "p")
                        && c.nodes().count() == 1
                        && c.items
                            .iter()
                            .all(|i| !matches!(i,Item::Text(t) if !t.trim().is_empty()))
                    {
                        c.nodes().find(|c| c.is(H, "img"))
                    } else {
                        None
                    };
                    if let Some(img) = image {
                        if !c.is(H, "img") {
                            attributes(c, &[("", "id")], self.report)?;
                        }
                        self.flush(&mut nodes, part)?;
                        if let Some(b) = self.image(img, part, pubn)? {
                            self.blocks.push(b);
                        }
                    } else {
                        nodes.push(safe(c, self.report)?);
                    }
                }
            }
        }
        self.flush(&mut nodes, part)
    }
}
/// Preparation is local and token-bound; every error aborts job-owned staging.
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
            return Err(fail("EPUB_PROFILE", "job"));
        }
        archive = Some(
            job.prepare_archive(budgets, &mut now, false)
                .map_err(ingress)?,
        );
        let p = archive.as_mut().unwrap();
        let pubn = package(p, job.source().original(), &mut report, &mut || {
            job.check(now()).map_err(|_| fail("JOB", "control"))
        })?;
        let nav = tree(p, &pubn.nav, &mut || {
            job.check(now()).map_err(|_| fail("JOB", "control"))
        })?;
        if !nav.is(H, "html") {
            return Err(fail("EPUB_XHTML", &pubn.nav));
        }
        let _ = child(&nav, H, "body")?;
        let mut tocs = vec![];
        find_toc(&nav, &mut tocs);
        if tocs.len() != 1 {
            return Err(fail("EPUB_TOC", &pubn.nav));
        }
        navigation(tocs[0], &pubn.nav, &pubn, &mut report)?;
        if report.navigation.is_empty() {
            return Err(fail("EPUB_EMPTY_TOC", &pubn.nav));
        }
        audit_navigation(&nav, &mut report)?;
        let mut m = Mapper {
            job,
            package: p,
            host,
            report: &mut report,
            now: &mut now,
            admitted: BTreeMap::new(),
            blocks: vec![],
        };
        for part in &pubn.spine {
            let n = tree(m.package, part, &mut || {
                m.job.check((m.now)()).map_err(|_| fail("JOB", "control"))
            })?;
            let mut ids = BTreeSet::new();
            collect_ids(&n, &mut ids)?;
            for entry in &m.report.navigation {
                if entry.part == *part
                    && entry
                        .fragment
                        .as_ref()
                        .is_some_and(|f| !f.is_empty() && !ids.contains(f))
                {
                    return Err(fail("EPUB_NAVIGATION_FRAGMENT", part));
                }
            }
            let first = m.blocks.len();
            m.chapter(&n, part, &pubn)?;
            if m.blocks.len() == first {
                return Err(fail("EPUB_NO_SUPPORTED_CHAPTER_CONTENT", part));
            }
            let hash = Sha256::digest(m.package.raw_part(part).unwrap()).into();
            m.report.chapters.push(Chapter {
                part: part.clone(),
                first_block: first,
                block_count: m.blocks.len() - first,
                source_sha256: hash,
            });
        }
        for e in pubn.entries.values() {
            if let Some(part) = &e.path {
                if !pubn.spine.contains(part) && !e.nav && !m.admitted.contains_key(part) {
                    m.report
                        .diagnostic("UNIMPORTED_PUBLICATION_RESOURCE", part)?;
                }
            }
        }
        m.check()?;
        let blocks = m.blocks;
        if blocks.len() > 128 {
            return Err(fail("BUDGET", "blocks"));
        }
        p.charge_output_nodes(blocks.iter().map(|b| 1 + b.runs.len()).sum())
            .map_err(ingress)?;
        report.work = p.work();
        report.blocks = blocks.len();
        report.utf16_units = blocks
            .iter()
            .flat_map(|b| &b.runs)
            .map(|r| r.text.encode_utf16().count())
            .sum();
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
            "{blocks:?}{report:?}"
        )
        .map_err(|_| fail("BUDGET", "output-bytes"))?;
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
    match result {
        Err(mut e) => {
            e.diagnostics.extend(report.diagnostics);
            if e.work == Work::default() {
                e.work = archive.as_ref().map(Package::work).unwrap_or_default();
            }
            job.abort().map_err(|_| fail("JOB", "cleanup"))?;
            Err(e)
        }
        ok => ok,
    }
}
