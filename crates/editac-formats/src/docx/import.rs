//! Guarded Transitional WordprocessingML text profile v1. No Word layout,
//! revision-branch selection, field evaluation, fetching, or source reconstruction.
use crate::{
    Direction,
    container::{Budgets, Package, Work},
    job::*,
};
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::{Mark, normalize_link_url},
    },
    document::BlockAttributes,
};
use editac_session::{assets::AssetStore, session::SessionStore};
use quick_xml::{NsReader, events::Event, name::ResolveResult};
use std::{collections::BTreeMap, sync::Arc};
/// Qualified portable text subset only. This does not install the aggregate
/// DOCX direction in the host registry or claim platform isolation.
pub const TEXT_PROFILE: crate::Profile = crate::Profile {
    id: "edit-ac-docx-v1",
    format: "docx",
    version: 1,
    import: true,
    export: false,
    available: true,
    fidelity: "docx-text-semantic-v1",
    owner: "CNV-1.5",
    limits: crate::LIMITS,
};
mod structure;
pub use structure::{OriginalMediaHost, STRUCTURE_PROFILE, prepare_structure};

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PR: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const DOC: &str = "word/document.xml";
const STYLES: &str = "word/styles.xml";
const RELS: &str = "word/_rels/document.xml.rels";
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Code {
    Package,
    Xml,
    Profile,
    StyleCycle,
    Span,
    Budget,
    Job,
    LossApproval,
    ForeignJob,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: Code,
    pub location: String,
    pub diagnostics: Vec<Diagnostic>,
    pub work: Work,
}
type Result<T> = std::result::Result<T, Failure>;
fn fail(code: Code, location: &str) -> Failure {
    Failure {
        code,
        location: location.into(),
        diagnostics: vec![],
        work: Work::default(),
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: String,
    pub location: String,
    pub lossy: bool,
    pub action: &'static str,
}
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub package_work: Work,
    pub utf16_units: usize,
    pub runs: usize,
    pub paragraphs: usize,
    diagnostic_overflow: bool,
}
impl Report {
    fn diagnostic(&mut self, code: &str, location: &str) {
        if self
            .diagnostics
            .iter()
            .any(|d| d.code == code && d.location == location)
        {
            return;
        }
        if self.diagnostics.len() >= 4096 {
            self.diagnostic_overflow = true;
            return;
        }
        self.diagnostics.push(Diagnostic {
            code: code.into(),
            location: location.into(),
            lossy: true,
            action:"Review this unsupported construct; retain original input or explicitly approve loss.",
        });
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Coordinates {
    Utf8Bytes,
    UnicodeScalars,
    Utf16,
}
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub start: usize,
    pub length: usize,
    pub coordinates: Coordinates,
    pub declared_utf16: usize,
}
/// Validates *before* slicing or shared batch preparation. Returns public UTF-16
/// offsets and exact authored substring, without normalization or panic recovery.
pub fn validate_span(text: &str, span: Span) -> Result<(u32, u32, &str)> {
    let end = span
        .start
        .checked_add(span.length)
        .ok_or_else(|| fail(Code::Span, "overflow"))?;
    let boundary = |offset: usize| -> Option<usize> {
        match span.coordinates {
            Coordinates::Utf8Bytes => text.is_char_boundary(offset).then_some(offset),
            Coordinates::UnicodeScalars => text
                .char_indices()
                .map(|(i, _)| i)
                .chain(std::iter::once(text.len()))
                .nth(offset),
            Coordinates::Utf16 => {
                let mut units = 0usize;
                for (byte, c) in text.char_indices() {
                    if units == offset {
                        return Some(byte);
                    }
                    units = units.checked_add(c.len_utf16())?;
                    if units > offset {
                        return None;
                    }
                }
                (units == offset).then_some(text.len())
            }
        }
    };
    let a = boundary(span.start).ok_or_else(|| fail(Code::Span, "start-boundary"))?;
    let b = boundary(end).ok_or_else(|| fail(Code::Span, "end-boundary"))?;
    let value = text.get(a..b).ok_or_else(|| fail(Code::Span, "range"))?;
    let length = value.encode_utf16().count();
    if length != span.declared_utf16 {
        return Err(fail(Code::Span, "declared-length"));
    }
    let start = text[..a].encode_utf16().count();
    let finish = start
        .checked_add(length)
        .ok_or_else(|| fail(Code::Span, "utf16-overflow"))?;
    Ok((
        u32::try_from(start).map_err(|_| fail(Code::Span, "public-offset"))?,
        u32::try_from(finish).map_err(|_| fail(Code::Span, "public-offset"))?,
        value,
    ))
}
/// Adapter-owned spans cross this boundary before becoming shared primitives.
/// It also serves other trusted parsers; callers cannot alter an admitted batch.
pub struct AdapterRun {
    pub source: String,
    pub span: Span,
    pub marks: Vec<(Mark, Option<String>)>,
}
pub struct AdapterParagraph {
    pub runs: Vec<AdapterRun>,
    pub heading: Option<u8>,
}
pub struct PreparedText {
    blocks: Vec<FragmentBlock>,
    report: Report,
    token: Arc<()>,
    pub original_sha256: [u8; 32],
}
impl PreparedText {
    pub fn report(&self) -> &Report {
        &self.report
    }
    pub fn blocks(&self) -> &[FragmentBlock] {
        &self.blocks
    }
    pub fn commit<S: SessionStore + AssetStore>(
        self,
        job: &mut PreparedJob<S>,
        owner: &mut ConversionOwner<S>,
        approve_loss: bool,
        now: u64,
    ) -> Result<Option<ImportCompletion>> {
        if !Arc::ptr_eq(&self.token, &job.token) {
            return Err(fail(Code::ForeignJob, "job"));
        }
        if !approve_loss && self.report.diagnostics.iter().any(|d| d.lossy) {
            let mut error = fail(Code::LossApproval, "retain-original-and-review-diagnostics");
            error.diagnostics = self.report.diagnostics;
            error.work = self.report.package_work;
            job.abort()
                .map_err(|_| fail(Code::Job, "loss-rejection-cleanup"))?;
            return Err(error);
        }
        job.finish_import(owner, &self.blocks, now)
            .map_err(|e| fail(Code::Job, &format!("shared-commit:{e:?}")))
    }
}
pub fn admit_adapter_spans<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    paragraphs: Vec<AdapterParagraph>,
    now: u64,
) -> Result<PreparedText> {
    let result = admit(job, paragraphs, Report::default(), now);
    if result.is_err() {
        job.abort().map_err(|_| fail(Code::Job, "cleanup"))?;
    }
    result
}
fn admit<S: SessionStore + AssetStore>(
    job: &PreparedJob<S>,
    paragraphs: Vec<AdapterParagraph>,
    mut report: Report,
    now: u64,
) -> Result<PreparedText> {
    job.check(now).map_err(|_| fail(Code::Job, "job"))?;
    if job.contract().direction != Direction::Import || paragraphs.is_empty() {
        return Err(fail(Code::Profile, "import-paragraphs"));
    }
    if paragraphs.len() > 128 {
        return Err(fail(Code::Budget, "shared-paragraph-limit"));
    }
    let mut nodes = 0usize;
    let mut bytes = 0usize;
    let mut blocks = Vec::new();
    for p in paragraphs {
        nodes = nodes
            .checked_add(1)
            .ok_or_else(|| fail(Code::Budget, "nodes"))?;
        if p.heading.is_some_and(|h| !(1..=6).contains(&h)) {
            return Err(fail(Code::Profile, "heading"));
        }
        let mut runs = Vec::new();
        for run in p.runs {
            nodes = nodes
                .checked_add(1)
                .ok_or_else(|| fail(Code::Budget, "nodes"))?;
            let (_, _, text) = validate_span(&run.source, run.span)?;
            bytes = bytes
                .checked_add(text.len())
                .and_then(|n| n.checked_add(run.marks.len().checked_mul(64)?))
                .ok_or_else(|| fail(Code::Budget, "bytes"))?;
            for (_, href) in &run.marks {
                if let Some(h) = href {
                    bytes = bytes
                        .checked_add(h.len())
                        .ok_or_else(|| fail(Code::Budget, "href"))?;
                }
            }
            if nodes > job.contract().limits.nodes || bytes > job.contract().limits.output_bytes {
                return Err(fail(Code::Budget, "semantic-output"));
            }
            report.utf16_units = report
                .utf16_units
                .checked_add(text.encode_utf16().count())
                .ok_or_else(|| fail(Code::Span, "aggregate"))?;
            // Aggregate public coordinates must also remain representable.
            u32::try_from(report.utf16_units)
                .map_err(|_| fail(Code::Span, "aggregate-public-offset"))?;
            report.runs += 1;
            if report.runs > 1024 {
                return Err(fail(Code::Budget, "shared-run-limit"));
            }
            runs.push(FragmentRun {
                opaque_marks: vec![],
                text: text.into(),
                marks: run.marks,
            });
        }
        if nodes > job.contract().limits.nodes {
            return Err(fail(Code::Budget, "nodes"));
        }
        blocks.push(FragmentBlock {
            runs,
            attributes: Some(
                p.heading
                    .map_or(BlockAttributes::Paragraph, BlockAttributes::Heading),
            ),
            containers: vec![],
            checked: None,
        });
    }
    report.paragraphs = blocks.len();
    Ok(PreparedText {
        blocks,
        report,
        token: job.token.clone(),
        original_sha256: job.contract().input_sha256,
    })
}
#[derive(Clone, Debug)]
struct Node {
    ns: String,
    name: String,
    attrs: BTreeMap<(String, String), String>,
    children: Vec<Node>,
    text: String,
    location: String,
}
impl Node {
    fn is(&self, name: &str) -> bool {
        self.ns == W && self.name == name
    }
    fn attr(&self, ns: &str, key: &str) -> Option<&str> {
        self.attrs.get(&(ns.into(), key.into())).map(String::as_str)
    }
    fn val(&self) -> Option<&str> {
        self.attr(W, "val")
    }
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|n| n.is(name))
    }
}
fn namespace(ns: ResolveResult<'_>) -> Result<String> {
    match ns {
        ResolveResult::Bound(n) => {
            String::from_utf8(n.as_ref().to_vec()).map_err(|_| fail(Code::Xml, "namespace"))
        }
        ResolveResult::Unbound => Ok(String::new()),
        _ => Err(fail(Code::Xml, "unbound-prefix")),
    }
}
fn tree(
    package: &mut Package,
    part: &str,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<Option<Node>> {
    let Some(bytes) = package.part(part) else {
        return Ok(None);
    };
    let bytes = bytes.to_vec();
    package
        .charge_mapping_bytes(bytes.len())
        .map_err(|_| fail(Code::Budget, part))?;
    let mut reader = NsReader::from_reader(bytes.as_slice());
    let mut stack: Vec<Node> = vec![];
    let mut root = None;
    let mut count = 0usize;
    loop {
        control()?;
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|_| fail(Code::Xml, part))?;
        let ns = namespace(ns)?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                count += 1;
                package
                    .charge_output_nodes(1)
                    .map_err(|_| fail(Code::Budget, part))?;
                let mut attrs = BTreeMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|_| fail(Code::Xml, part))?;
                    if a.key.as_ref() == b"xmlns" || a.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    let (ns, local) = reader.resolver().resolve_attribute(a.key);
                    let key = (
                        namespace(ns)?,
                        String::from_utf8(local.as_ref().to_vec())
                            .map_err(|_| fail(Code::Xml, part))?,
                    );
                    let value = a
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(|_| fail(Code::Xml, part))?
                        .into_owned();
                    if attrs.insert(key, value).is_some() {
                        return Err(fail(Code::Xml, part));
                    }
                }
                let node = Node {
                    ns,
                    name: String::from_utf8(e.local_name().as_ref().to_vec())
                        .map_err(|_| fail(Code::Xml, part))?,
                    attrs,
                    children: vec![],
                    text: String::new(),
                    location: format!("{part}#{count}"),
                };
                if empty {
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(node)
                    } else if root.replace(node).is_some() {
                        return Err(fail(Code::Xml, part));
                    }
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                let n = stack.pop().ok_or_else(|| fail(Code::Xml, part))?;
                singletons(&n)?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(n)
                } else if root.replace(n).is_some() {
                    return Err(fail(Code::Xml, part));
                }
            }
            Event::Text(e) => {
                let value = e
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(|_| fail(Code::Xml, part))?;
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&value)
                }
            }
            Event::CData(e) => {
                let value = e
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(|_| fail(Code::Xml, part))?;
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&value)
                }
            }
            Event::GeneralRef(e) => {
                let raw = format!(
                    "&{};",
                    std::str::from_utf8(e.as_ref()).map_err(|_| fail(Code::Xml, part))?
                );
                let value = quick_xml::escape::unescape(&raw).map_err(|_| fail(Code::Xml, part))?;
                if let Some(n) = stack.last_mut() {
                    n.text.push_str(&value)
                }
            }
            Event::Eof => break,
            Event::DocType(_) => return Err(fail(Code::Xml, part)),
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(fail(Code::Xml, part));
    }
    Ok(root)
}
fn singletons(n: &Node) -> Result<()> {
    let names: &[&str] = match n.name.as_str() {
        "document" => &["body"],
        "styles" => &["docDefaults"],
        "docDefaults" => &["rPrDefault", "pPrDefault"],
        "rPrDefault" => &["rPr"],
        "p" => &["pPr"],
        "r" => &["rPr"],
        "style" => &["basedOn", "name", "pPr", "rPr"],
        "pPr" => &["pStyle", "outlineLvl", "numPr"],
        "numPr" => &["numId", "ilvl"],
        "rPr" => &["rStyle"],
        _ => &[],
    };
    if n.ns == W {
        for name in names {
            if n.children.iter().filter(|c| c.is(name)).count() > 1 {
                return Err(fail(Code::Profile, &n.location));
            }
        }
    }
    Ok(())
}
fn unknown(report: &mut Report, n: &Node) {
    report.diagnostic(
        &format!("UNSUPPORTED_ELEMENT:{{{}}}{}", n.ns, n.name),
        &n.location,
    );
    // Unknown wrappers can hide fields/active constructs. Diagnose the complete
    // bounded subtree without choosing or importing any branch.
    for child in &n.children {
        unknown(report, child);
    }
}
fn attrs(report: &mut Report, n: &Node, allowed: &[(&str, &str)]) {
    for (ns, key) in n.attrs.keys() {
        if !allowed.iter().any(|(a, b)| a == ns && b == key) {
            report.diagnostic(&format!("UNSUPPORTED_ATTRIBUTE:{{{ns}}}{key}"), &n.location);
        }
    }
    if !n.text.trim().is_empty() && !n.is("t") {
        report.diagnostic("UNSUPPORTED_ELEMENT_TEXT", &n.location);
    }
}
#[derive(Clone, Default)]
struct Props {
    marks: BTreeMap<&'static str, bool>,
    heading: Option<u8>,
}
fn on(n: &Node) -> Result<bool> {
    match n.val().unwrap_or("true") {
        "true" | "1" | "on" => Ok(true),
        "false" | "0" | "off" => Ok(false),
        _ => Err(fail(Code::Profile, &n.location)),
    }
}
fn properties(n: &Node, p: &mut Props, toggle: bool, report: &mut Report) -> Result<()> {
    attrs(report, n, &[]);
    let mut seen = std::collections::BTreeSet::new();
    for c in &n.children {
        if !seen.insert((c.ns.clone(), c.name.clone())) {
            return Err(fail(Code::Profile, &c.location));
        }
        attrs(report, c, &[(W, "val")]);
        let key = if c.ns == W {
            match c.name.as_str() {
                "b" => Some("bold"),
                "i" => Some("italic"),
                "strike" => Some("strike"),
                "u" => Some("underline"),
                _ => None,
            }
        } else {
            None
        };
        if let Some(key) = key.filter(|_| n.is("rPr")) {
            let value = if key == "underline" {
                match c.val().unwrap_or("single") {
                    "single" => true,
                    "none" => false,
                    _ => {
                        unknown(report, c);
                        continue;
                    }
                }
            } else {
                on(c)?
            };
            let value = if toggle && key != "underline" {
                if value {
                    !p.marks.get(key).copied().unwrap_or(false)
                } else {
                    continue;
                }
            } else {
                value
            };
            p.marks.insert(key, value);
            for child in &c.children {
                unknown(report, child);
            }
        } else if c.is("outlineLvl") && n.is("pPr") {
            match c.val().and_then(|v| v.parse::<u8>().ok()) {
                Some(v @ 0..=5) => p.heading = Some(v + 1),
                Some(9) => p.heading = None,
                _ => unknown(report, c),
            }
        } else {
            unknown(report, c);
        }
    }
    Ok(())
}
struct Styles {
    map: BTreeMap<String, Node>,
    default_p: Option<String>,
    default_c: Option<String>,
    defaults: Props,
}
fn styles(root: Option<Node>, report: &mut Report) -> Result<Styles> {
    let mut s = Styles {
        map: BTreeMap::new(),
        default_p: None,
        default_c: None,
        defaults: Props::default(),
    };
    let Some(root) = root else { return Ok(s) };
    if !root.is("styles") {
        return Err(fail(Code::Profile, STYLES));
    }
    attrs(report, &root, &[]);
    for n in root.children {
        if n.is("docDefaults") {
            attrs(report, &n, &[]);
            for d in &n.children {
                if d.is("rPrDefault") {
                    attrs(report, d, &[]);
                    for c in &d.children {
                        if c.is("rPr") {
                            properties(c, &mut s.defaults, false, report)?
                        } else {
                            unknown(report, c)
                        }
                    }
                } else {
                    unknown(report, d)
                }
            }
        } else if n.is("style") {
            attrs(
                report,
                &n,
                &[
                    (W, "type"),
                    (W, "styleId"),
                    (W, "default"),
                    (W, "customStyle"),
                ],
            );
            let id = n
                .attr(W, "styleId")
                .filter(|v| !v.is_empty())
                .ok_or_else(|| fail(Code::Profile, &n.location))?
                .to_owned();
            if !matches!(n.attr(W, "type"), Some("paragraph" | "character")) {
                unknown(report, &n);
                continue;
            }
            if n.attr(W, "default")
                .is_some_and(|v| v == "1" || v == "true")
            {
                let default = if n.attr(W, "type") == Some("paragraph") {
                    &mut s.default_p
                } else {
                    &mut s.default_c
                };
                if default.replace(id.clone()).is_some() {
                    return Err(fail(Code::Profile, &n.location));
                }
            }
            for c in &n.children {
                if !["basedOn", "rPr", "pPr", "name"]
                    .iter()
                    .any(|name| c.is(name))
                {
                    unknown(report, c)
                } else if c.is("name") || c.is("basedOn") {
                    attrs(report, c, &[(W, "val")]);
                }
            }
            if s.map.len() >= 256 || s.map.insert(id, n).is_some() {
                return Err(fail(Code::Profile, STYLES));
            }
        } else {
            unknown(report, &n)
        }
    }
    // Check even unused chains: cycles must never depend on selected content.
    for id in s.map.keys() {
        s.apply(id, "", &mut Props::default(), report, &mut vec![])?;
    }
    Ok(s)
}
impl Styles {
    fn apply(
        &self,
        id: &str,
        kind: &str,
        p: &mut Props,
        report: &mut Report,
        path: &mut Vec<String>,
    ) -> Result<()> {
        if path.len() >= 32 {
            return Err(fail(Code::Budget, "style-depth"));
        }
        if path.iter().any(|s| s == id) {
            return Err(fail(Code::StyleCycle, id));
        }
        let Some(n) = self.map.get(id) else {
            report.diagnostic("UNSUPPORTED_STYLE_REFERENCE", id);
            return Ok(());
        };
        if !kind.is_empty() && n.attr(W, "type") != Some(kind) {
            report.diagnostic("UNSUPPORTED_STYLE_TYPE", &n.location);
            return Ok(());
        }
        path.push(id.into());
        if let Some(base) = n.child("basedOn") {
            if let Some(id) = style_reference(Some(base), None, report) {
                self.apply(id, n.attr(W, "type").unwrap_or(""), p, report, path)?
            }
        }
        if let Some(pp) = n.child("pPr") {
            if n.attr(W, "type") == Some("paragraph") {
                properties(pp, p, false, report)?;
            } else {
                unknown(report, pp);
            }
        }
        if let Some(rp) = n.child("rPr") {
            properties(rp, p, true, report)?;
        }
        path.pop();
        Ok(())
    }
}
fn style_reference<'a>(
    node: Option<&'a Node>,
    default: Option<&'a str>,
    report: &mut Report,
) -> Option<&'a str> {
    if let Some(n) = node {
        attrs(report, n, &[(W, "val")]);
        for child in &n.children {
            unknown(report, child)
        }
        if n.val().is_none_or(str::is_empty) {
            report.diagnostic("UNSUPPORTED_EMPTY_STYLE_REFERENCE", &n.location);
        }
        n.val().filter(|v| !v.is_empty())
    } else {
        default
    }
}
fn marks(p: &Props, link: Option<&str>) -> Vec<(Mark, Option<String>)> {
    let mut result = vec![];
    for (key, mark) in [
        ("bold", Mark::Bold),
        ("italic", Mark::Italic),
        ("strike", Mark::Strike),
        ("underline", Mark::Underline),
    ] {
        if p.marks.get(key) == Some(&true) {
            result.push((mark, None));
        }
    }
    if let Some(url) = link {
        result.push((Mark::Link, Some(url.into())));
    }
    result
}
fn push(runs: &mut Vec<AdapterRun>, text: String, p: &Props, link: Option<&str>) {
    let span = Span {
        start: 0,
        length: text.len(),
        coordinates: Coordinates::Utf8Bytes,
        declared_utf16: text.encode_utf16().count(),
    };
    runs.push(AdapterRun {
        source: text,
        span,
        marks: marks(p, link),
    });
}
fn has_complex_field(n: &Node) -> bool {
    n.is("fldChar") || n.is("instrText") || n.children.iter().any(has_complex_field)
}
fn field_diagnostics(n: &Node, report: &mut Report) {
    if n.is("fldChar") || n.is("instrText") {
        report.diagnostic("UNSUPPORTED_COMPLEX_FIELD", &n.location);
    }
    for c in &n.children {
        field_diagnostics(c, report)
    }
}
fn run(
    n: &Node,
    base: &Props,
    link: Option<&str>,
    styles: &Styles,
    runs: &mut Vec<AdapterRun>,
    report: &mut Report,
) -> Result<()> {
    attrs(report, n, &[]);
    let mut p = base.clone();
    if let Some(rp) = n.child("rPr") {
        if let Some(style) =
            style_reference(rp.child("rStyle"), styles.default_c.as_deref(), report)
        {
            styles.apply(style, "character", &mut p, report, &mut vec![])?;
        }
        // rStyle selects a style; it is not itself an unsupported property.
        let mut direct = rp.clone();
        direct.children.retain(|c| !c.is("rStyle"));
        properties(&direct, &mut p, false, report)?;
    } else if let Some(style) = &styles.default_c {
        styles.apply(style, "character", &mut p, report, &mut vec![])?;
    }
    for c in &n.children {
        if c.is("rPr") {
            continue;
        }
        if c.is("t") {
            attrs(
                report,
                c,
                &[("http://www.w3.org/XML/1998/namespace", "space")],
            );
            if !c.children.is_empty() {
                return Err(fail(Code::Profile, &c.location));
            }
            if (p.marks.get("bold")==Some(&true)||p.marks.get("italic")==Some(&true)) && c.text.chars().any(|ch|!matches!(ch as u32,0..=0x052f|0x2000..=0x206f|0x2e80..=0x9fff|0xac00..=0xd7af|0x1f000..=0x1faff)){
                report.diagnostic("UNSUPPORTED_SCRIPT_SPECIFIC_MARKS",&c.location);
            }
            push(runs, c.text.clone(), &p, link);
        } else if c.is("tab") {
            attrs(report, c, &[]);
            push(runs, "\t".into(), &p, link);
        } else if c.is("br") || c.is("cr") {
            attrs(report, c, &[(W, "type"), (W, "clear")]);
            if c.attr(W, "type").is_none_or(|v| v == "textWrapping")
                && c.attr(W, "clear").is_none_or(|v| v == "none")
            {
                push(runs, "\n".into(), &p, link)
            } else {
                report.diagnostic("UNSUPPORTED_BREAK_LAYOUT", &c.location)
            }
        } else {
            unknown(report, c)
        }
    }
    Ok(())
}
fn hyperlinks(root: Option<Node>, report: &mut Report) -> Result<BTreeMap<String, String>> {
    let mut links = BTreeMap::new();
    let Some(root) = root else { return Ok(links) };
    if root.ns != PR || root.name != "Relationships" {
        return Err(fail(Code::Profile, RELS));
    }
    for n in root.children {
        if n.attr("", "Type") == Some(&format!("{R}/hyperlink")) {
            let id = n
                .attr("", "Id")
                .ok_or_else(|| fail(Code::Profile, &n.location))?;
            if n.attr("", "TargetMode") != Some("External") {
                report.diagnostic("UNSUPPORTED_INTERNAL_LINK", &n.location);
                continue;
            }
            match n
                .attr("", "Target")
                .and_then(|v| normalize_link_url(v).ok())
            {
                Some(url) => {
                    links.insert(id.into(), url);
                }
                None => report.diagnostic("UNSUPPORTED_UNSAFE_LINK", &n.location),
            }
        }
    }
    Ok(links)
}
fn context(
    package: &mut Package,
    control: &mut impl FnMut() -> Result<()>,
    structured: bool,
) -> Result<(Node, Styles, BTreeMap<String, String>, Report)> {
    let mut report = Report::default();
    for d in package.diagnostics() {
        report.diagnostic(d.code, &d.part);
        if d.code == "EXTERNAL_RELATIONSHIP_INERT" {
            if let Some(diag) = report
                .diagnostics
                .iter_mut()
                .find(|entry| entry.code == d.code && entry.location == d.part)
            {
                diag.lossy = false;
                diag.action = "Keep this relationship inert; no network request is performed.";
            }
        }
    }
    for part in package.part_names() {
        if ![DOC, STYLES, RELS, "_rels/.rels", "[Content_Types].xml"].contains(&part)
            && !(structured && (part == "word/numbering.xml" || part.starts_with("word/media/")))
        {
            report.diagnostic(
                if structured
                    && (part.starts_with("word/header") || part.starts_with("word/footer"))
                {
                    "UNSUPPORTED_HEADER_FOOTER"
                } else if structured
                    && (part == "word/footnotes.xml" || part == "word/endnotes.xml")
                {
                    "UNSUPPORTED_FOOTNOTES"
                } else {
                    "UNSUPPORTED_PART"
                },
                part,
            );
        }
    }
    let types = tree(package, "[Content_Types].xml", control)?
        .ok_or_else(|| fail(Code::Profile, "content-types"))?;
    if types.ns!=CT||types.name!="Types"||!types.children.iter().any(|n|n.attr("","PartName")==Some("/word/document.xml")&&n.attr("","ContentType")==Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")){return Err(fail(Code::Profile,"document-content-type"));}
    let root_rels = tree(package, "_rels/.rels", control)?
        .ok_or_else(|| fail(Code::Profile, "root-relationships"))?;
    if !root_rels.children.iter().any(|n| {
        n.attr("", "Type") == Some(&format!("{R}/officeDocument"))
            && matches!(
                n.attr("", "Target"),
                Some("word/document.xml" | "/word/document.xml")
            )
            && n.attr("", "TargetMode").is_none_or(|v| v == "Internal")
    }) {
        return Err(fail(Code::Profile, "main-document-relationship"));
    }
    let relroot = tree(package, RELS, control)?;
    // Only conventional, explicitly related styles are in v1. Never guess a
    // different style part from a filename or use an unreferenced style file.
    if let Some(root) = &relroot {
        for n in &root.children {
            if ![format!("{R}/styles"), format!("{R}/hyperlink")]
                .into_iter()
                .chain(if structured {
                    vec![format!("{R}/numbering"), format!("{R}/image")]
                } else {
                    vec![]
                })
                .any(|ty| n.attr("", "Type") == Some(ty.as_str()))
            {
                report.diagnostic("UNSUPPORTED_RELATIONSHIP_TYPE", &n.location);
            }
        }
    }
    let style_rel = relroot.as_ref().is_some_and(|root| {
        root.children.iter().any(|n| {
            n.attr("", "Type") == Some(&format!("{R}/styles"))
                && matches!(
                    n.attr("", "Target"),
                    Some("styles.xml" | "/word/styles.xml")
                )
                && n.attr("", "TargetMode").is_none_or(|v| v == "Internal")
        })
    });
    let styletree = if style_rel {
        tree(package, STYLES, control)?
    } else {
        if package.part(STYLES).is_some() {
            report.diagnostic("UNSUPPORTED_UNRELATED_STYLES", STYLES);
        }
        None
    };
    if package.part("word/theme/theme1.xml").is_some() {
        report.diagnostic("UNSUPPORTED_THEME", "word/theme/theme1.xml");
    }
    let styles = styles(styletree, &mut report)?;
    let links = hyperlinks(relroot, &mut report)?;
    let document = tree(package, DOC, control)?.ok_or_else(|| fail(Code::Profile, DOC))?;
    if !document.is("document") {
        return Err(fail(Code::Profile, DOC));
    }
    attrs(&mut report, &document, &[]);
    let bodies: Vec<_> = document.children.iter().filter(|n| n.is("body")).collect();
    if bodies.len() != 1 {
        return Err(fail(Code::Profile, "document-body"));
    }
    for n in &document.children {
        if !n.is("body") {
            unknown(&mut report, n)
        }
    }
    Ok((document, styles, links, report))
}
fn paragraph(
    n: &Node,
    styles: &Styles,
    links: &BTreeMap<String, String>,
    report: &mut Report,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<AdapterParagraph> {
    attrs(report, n, &[]);
    if has_complex_field(n) {
        field_diagnostics(n, report);
        report.diagnostic("UNSUPPORTED_FIELD_PARAGRAPH_OMITTED", &n.location);
        return Ok(AdapterParagraph {
            runs: vec![],
            heading: None,
        });
    }
    let mut props = styles.defaults.clone();
    let pp = n.child("pPr");
    let style = style_reference(
        pp.and_then(|n| n.child("pStyle")),
        styles.default_p.as_deref(),
        report,
    );
    if let Some(style) = style {
        styles.apply(style, "paragraph", &mut props, report, &mut vec![])?;
    }
    if let Some(pp) = pp {
        let mut pp = pp.clone();
        pp.children.retain(|n| !n.is("pStyle"));
        properties(&pp, &mut props, false, report)?;
    }
    let mut runs = vec![];
    for c in &n.children {
        control()?;
        if c.is("pPr") {
            continue;
        }
        if c.is("r") {
            run(c, &props, None, styles, &mut runs, report)?;
        } else if c.is("hyperlink") {
            attrs(report, c, &[(R, "id"), (W, "history")]);
            let link = c
                .attr(R, "id")
                .and_then(|id| links.get(id))
                .map(String::as_str);
            if link.is_none() {
                report.diagnostic("UNSUPPORTED_LINK_TARGET", &c.location);
            }
            for r in &c.children {
                if r.is("r") {
                    run(r, &props, link, styles, &mut runs, report)?
                } else {
                    unknown(report, r)
                }
            }
        } else {
            unknown(report, c)
        }
    }
    Ok(AdapterParagraph {
        runs,
        heading: props.heading,
    })
}
fn map(
    package: &mut Package,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<(Vec<AdapterParagraph>, Report)> {
    let (document, styles, links, mut report) = context(package, control, false)?;
    let body = document.children.iter().find(|n| n.is("body")).unwrap();
    attrs(&mut report, body, &[]);
    let mut paragraphs = vec![];
    for n in &body.children {
        control()?;
        if !n.is("p") {
            unknown(&mut report, n);
            continue;
        }
        let p = paragraph(n, &styles, &links, &mut report, control)?;
        package
            .charge_output_nodes(1 + p.runs.len())
            .map_err(|_| fail(Code::Budget, "semantic-output"))?;
        paragraphs.push(p);
    }
    if paragraphs.is_empty() {
        let mut error = fail(Code::Profile, "no-supported-paragraphs");
        error.diagnostics = report.diagnostics;
        error.work = package.work();
        return Err(error);
    }
    if report.diagnostic_overflow {
        return Err(fail(Code::Budget, "diagnostics"));
    }
    report.package_work = package.work();
    // Deterministic deduplication of diagnostics emitted by inherited styles.
    report
        .diagnostics
        .sort_by(|a, b| (&a.location, &a.code).cmp(&(&b.location, &b.code)));
    report.diagnostics.dedup();
    Ok((paragraphs, report))
}
/// Uses the real guarded package bound to the job's immutable original input.
/// Any parse/span/control failure aborts only this job's owned staging.
pub fn prepare_text<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    budgets: Budgets,
    mut now: impl FnMut() -> u64,
) -> Result<PreparedText> {
    let result = (|| {
        if job.contract().direction != Direction::Import || job.contract().profile.format != "docx"
        {
            return Err(fail(Code::Profile, "docx-import"));
        }
        let mut package = job
            .prepare_container(budgets, &mut now)
            .map_err(|e| fail(Code::Package, &format!("{:?}:{}", e.code, e.part)))?;
        let (paragraphs, report) = map(&mut package, &mut || {
            job.check(now())
                .map_err(|_| fail(Code::Job, "mapping-control"))
        })?;
        admit(job, paragraphs, report, now())
    })();
    if result.is_err() {
        job.abort().map_err(|_| fail(Code::Job, "cleanup"))?;
    }
    result
}
