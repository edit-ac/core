//! Captured-revision EPUB 3.3 semantic output. No source-package or pagination
//! preservation. Only authorized original PNG bytes enter the optional package.
use crate::{Direction, job::*};
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
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Cursor, Seek, SeekFrom, Write},
};

pub const PROFILE: crate::Profile = crate::Profile {
    id: "edit-ac-epub-v1",
    format: "epub",
    version: 1,
    import: false,
    export: true,
    available: true,
    fidelity: "epub33-reflowable-export-v1",
    owner: "CNV-1.15",
    limits: crate::LIMITS,
};
const MIME: &str = "application/epub+zip";
#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub code: String,
    pub location: String,
    pub lossy: bool,
}
/// Carries original import diagnostics without granting source-package fidelity.
/// Host must retain the original input; exported packages never embed it.
#[derive(Clone, Debug)]
pub struct Provenance {
    digest: [u8; 32],
    diagnostics: Vec<Diagnostic>,
}
impl Provenance {
    #[cfg(feature = "epub-import")]
    pub fn from_import(p: &super::import::Prepared) -> Self {
        Self {
            digest: p.original_sha256,
            diagnostics: p
                .report()
                .diagnostics
                .iter()
                .map(|d| Diagnostic {
                    code: d.code.into(),
                    location: d.location.clone(),
                    lossy: d.lossy,
                })
                .collect(),
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub nodes: usize,
    pub assets: usize,
    pub original_bytes: usize,
    pub media_work: crate::container::Work,
}
impl Report {
    fn add(&mut self, code: &str, location: &str, lossy: bool) -> Result<(), String> {
        if self.diagnostics.len() >= 512 {
            return Err("diagnostic-budget".into());
        }
        self.diagnostics.push(Diagnostic {
            code: code.into(),
            location: location.into(),
            lossy,
        });
        Ok(())
    }
}
#[derive(Debug)]
pub struct Failure {
    pub reason: String,
    pub report: Report,
}
pub struct Completion {
    pub artifact: ExportArtifact,
    pub report: Report,
}
/// The host enforces the granted byte limit before allocating/reading bytes.
pub trait OriginalAssetHost: AssetHost {
    fn read_original(&mut self, request: &AssetRequest) -> Result<Vec<u8>, PortError>;
}
struct Reader<'a, H> {
    host: &'a mut H,
    bytes: Option<Vec<u8>>,
}
impl<H: OriginalAssetHost> AssetHost for Reader<'_, H> {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        self.host.authorize(r)
    }
    fn execute(&mut self, id: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        if r.action == AssetAction::Read {
            let b = self.host.read_original(r)?;
            if b.len() as u64 > r.byte_limit {
                return Err(PortError::Quota);
            }
            self.bytes = Some(b);
            Ok(HostOutcome::Complete)
        } else {
            self.host.execute(id, r)
        }
    }
}
struct Sink {
    c: Cursor<Vec<u8>>,
    limit: usize,
}
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.c
            .position()
            .checked_add(b.len() as u64)
            .filter(|n| *n <= self.limit as u64)
            .ok_or_else(|| io::Error::other("EPUB output limit"))?;
        self.c.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for Sink {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        let old = self.c.position();
        let n = self.c.seek(p)?;
        if n > self.limit as u64 {
            self.c.set_position(old);
            return Err(io::Error::other("EPUB seek limit"));
        }
        Ok(n)
    }
}
/// Bound escaped XML before growth, including entity expansion and style markup.
struct Xml {
    s: String,
    limit: usize,
}
impl Xml {
    fn new(limit: usize) -> Self {
        Self {
            s: String::new(),
            limit,
        }
    }
    fn add(&mut self, s: &str) -> Result<(), String> {
        self.s
            .len()
            .checked_add(s.len())
            .filter(|n| *n <= self.limit)
            .ok_or("xml-output-budget")?;
        self.s.push_str(s);
        Ok(())
    }
    fn escaped(&mut self, s: &str) -> Result<(), String> {
        for c in s.chars() {
            match c {
                '&' => self.add("&amp;")?,
                '<' => self.add("&lt;")?,
                '>' => self.add("&gt;")?,
                '"' => self.add("&quot;")?,
                '\'' => self.add("&apos;")?,
                '\t' => self.add("&#9;")?,
                '\n' => self.add("&#10;")?,
                '\r' => self.add("&#13;")?,
                c if c == '\t'
                    || c == '\n'
                    || c == '\r'
                    || c >= ' ' && c != '\u{fffe}' && c != '\u{ffff}' =>
                {
                    let mut b = [0; 4];
                    self.add(c.encode_utf8(&mut b))?
                }
                _ => return Err("invalid-xml-text".into()),
            }
        }
        Ok(())
    }
}
fn runs(x: &mut Xml, rs: &[FragmentRun]) -> Result<(), String> {
    for r in rs {
        let tags = [
            (Mark::Bold, "strong"),
            (Mark::Italic, "em"),
            (Mark::Underline, "u"),
            (Mark::Strike, "s"),
            (Mark::Code, "code"),
        ];
        let link = r.marks.iter().find(|(m, _)| *m == Mark::Link);
        if let Some((_, url)) = link {
            let url = url.as_deref().ok_or("missing-link")?;
            if normalize_link_url(url).ok().as_deref() != Some(url) {
                return Err("unsafe-link".into());
            }
            x.add("<a href=\"")?;
            x.escaped(url)?;
            x.add("\">")?;
        }
        for (m, t) in &tags {
            if r.marks.iter().any(|(k, _)| k == m) {
                x.add(&format!("<{t}>"))?
            }
        }
        for c in r.text.chars() {
            match c {
                '\n' => x.add("<br/>")?,
                '\r' => x.add("&#13;")?,
                _ => {
                    let mut b = [0; 4];
                    x.escaped(c.encode_utf8(&mut b))?
                }
            }
        }
        for (m, t) in tags.iter().rev() {
            if r.marks.iter().any(|(k, _)| k == m) {
                x.add(&format!("</{t}>"))?
            }
        }
        if link.is_some() {
            x.add("</a>")?
        }
    }
    Ok(())
}
fn paragraph(x: &mut Xml, b: &FragmentBlock) -> Result<(), String> {
    let tag = match b.attributes {
        Some(BlockAttributes::Heading(n @ 1..=6)) => format!("h{n}"),
        _ => "p".into(),
    };
    x.add(&format!("<{tag} style=\"white-space:pre-wrap\">"))?;
    runs(x, &b.runs)?;
    x.add(&format!("</{tag}>"))
}
fn document(x: &mut Xml, title: &str) -> Result<(), String> {
    x.add("<?xml version=\"1.0\" encoding=\"UTF-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" lang=\"und\" xml:lang=\"und\"><head><title>")?;
    x.escaped(title)?;
    x.add("</title></head><body>")
}
fn preflight(
    blocks: &[(String, Result<FragmentBlock, String>)],
    r: &mut Report,
) -> Result<(), String> {
    for (id, b) in blocks {
        let b = match b {
            Ok(b) => b,
            Err(_) => {
                r.add("SHARED_FRAGMENT_UNAVAILABLE", id, true)?;
                continue;
            }
        };
        r.nodes = r.nodes.checked_add(1 + b.runs.len()).ok_or("node-budget")?;
        if b.checked.is_some() {
            r.add("CHECK_STATE", id, true)?
        }
        if b.containers.len() > 9 {
            return Err("list-depth".into());
        }
        for (cid, s) in &b.containers {
            if !matches!(
                s,
                ContainerStyle::Ordered { .. } | ContainerStyle::Unordered
            ) {
                r.add("UNSUPPORTED_CONTAINER", cid, true)?
            }
        }
        match &b.attributes {
            None | Some(BlockAttributes::Paragraph | BlockAttributes::Heading(1..=6)) => {}
            Some(BlockAttributes::Unknown(t)) => {
                if !b.containers.is_empty() {
                    r.add("ATOMIC_CONTAINER_PLACEMENT", id, true)?
                }
                match Content::from_tuple(t).map_err(|_| "invalid-content")? {
                    Some(Content::Table {
                        rows, alignments, ..
                    }) => {
                        for row in &rows {
                            if row.len() != alignments.len() {
                                return Err("ragged-table".into());
                            }
                            r.nodes = r
                                .nodes
                                .checked_add(
                                    1 + row.len() + row.iter().map(Vec::len).sum::<usize>(),
                                )
                                .ok_or("node-budget")?;
                        }
                    }
                    Some(Content::Asset { descriptor })
                        if descriptor.kind == AssetKind::Image
                            && descriptor.metadata.media_type == "image/png"
                            && descriptor.metadata.byte_length.is_some()
                            && descriptor.metadata.sha256.is_some()
                            && descriptor.metadata.width.is_some()
                            && descriptor.metadata.height.is_some() =>
                    {
                        descriptor.validate().map_err(|_| "invalid-asset")?;
                        r.assets += 1
                    }
                    _ => r.add("UNSUPPORTED_CONTENT", id, true)?,
                }
            }
            _ => r.add("UNSUPPORTED_BLOCK_STYLE", id, true)?,
        }
    }
    Ok(())
}
fn close_lists(
    x: &mut Xml,
    stack: &mut Vec<(String, &'static str)>,
    keep: usize,
) -> Result<(), String> {
    while stack.len() > keep {
        let (_, tag) = stack.pop().unwrap();
        x.add(&format!("</li></{tag}>"))?
    }
    Ok(())
}
fn list_prefix(
    x: &mut Xml,
    stack: &mut Vec<(String, &'static str)>,
    containers: &[(String, ContainerStyle)],
) -> Result<(), String> {
    let common = stack
        .iter()
        .zip(containers)
        .take_while(|((a, _), (b, _))| a == b)
        .count();
    close_lists(x, stack, common)?;
    if common == containers.len() && common > 0 {
        x.add("</li><li>")?
    }
    for (id, s) in &containers[common..] {
        let tag = if matches!(s, ContainerStyle::Ordered { .. }) {
            "ol"
        } else {
            "ul"
        };
        if let ContainerStyle::Ordered { start } = s {
            x.add(&format!("<ol start=\"{start}\"><li>"))?
        } else {
            x.add("<ul><li>")?
        }
        stack.push((id.clone(), tag));
    }
    Ok(())
}
pub fn export<S: SessionStore + AssetStore, H: OriginalAssetHost>(
    job: &mut PreparedJob<S>,
    provenance: Option<&Provenance>,
    approve_loss: bool,
    host: &mut H,
    mut now: impl FnMut() -> u64,
) -> Result<Completion, Failure> {
    let mut report = Report::default();
    let result = (|| -> Result<ExportArtifact, String> {
        job.check(now()).map_err(|e| format!("job:{e:?}"))?;
        if job.contract().profile != PROFILE || job.contract().direction != Direction::Export {
            return Err("export-profile-required".into());
        }
        if let Some(p) = provenance {
            if p.digest != job.contract().input_sha256 {
                return Err("foreign-provenance".into());
            }
            for d in &p.diagnostics {
                report.add(&d.code, &d.location, d.lossy)?;
            }
        } else if !job.source().original().is_empty() {
            report.add("SOURCE_PROVENANCE_UNAVAILABLE", "original", true)?
        }
        report.add(
            "PACKAGE_REGENERATED",
            "EPUB3.3 reflowable; original package, navigation hierarchy and pagination are not retained",
            false,
        )?;
        report.add(
            "STYLE_DEFAULTS",
            "reader page defaults; semantic styles only; no fonts embedded/fetched",
            false,
        )?;
        report.add(
            "METADATA_DEFAULTS",
            "title from first chapter heading or Untitled publication; language und; content-derived identifier; fixed modified 1970-01-01T00:00:00Z; omit creator/private metadata/signatures",
            false,
        )?;
        preflight(job.source().export_blocks(), &mut report)?;
        for n in &job.source().snapshot().visible {
            for run in &n.runs {
                for key in run.attributes.keys().filter(|k| {
                    !matches!(
                        k.as_str(),
                        "bold" | "italic" | "strike" | "underline" | "code" | "link"
                    )
                }) {
                    report.add(&format!("UNSUPPORTED_MARK:{key}"), &n.id, true)?
                }
            }
            if n.kind != "block"
                && !job.source().export_blocks().iter().any(|(_, b)| {
                    b.as_ref()
                        .is_ok_and(|b| b.containers.iter().any(|(id, _)| *id == n.id))
                })
            {
                report.add("EMPTY_OR_UNMAPPED_CONTAINER", &n.id, true)?
            }
        }
        if !job.source().snapshot().recovery.is_empty() {
            report.add("RETAINED_RECOVERY", "snapshot.recovery", true)?
        }
        if report.nodes > job.contract().limits.nodes || report.assets > 64 {
            return Err("semantic-budget".into());
        }
        if report
            .diagnostics
            .iter()
            .any(|d| d.code == "SHARED_FRAGMENT_UNAVAILABLE")
        {
            return Err("shared-fragment-required".into());
        }
        let mut lists = BTreeMap::new();
        for (_, b) in job.source().export_blocks() {
            for (id, s) in &b.as_ref().unwrap().containers {
                if !matches!(
                    s,
                    ContainerStyle::Unordered | ContainerStyle::Ordered { .. }
                ) {
                    continue;
                }
                let next = lists.len() + 1;
                if let Some((_, previous)) = lists.get(id) {
                    if previous != s {
                        return Err("conflicting-list-style".into());
                    }
                } else {
                    lists.insert(id.clone(), (next, s.clone()));
                }
            }
        }
        if !approve_loss && report.diagnostics.iter().any(|d| d.lossy) {
            return Err("loss-approval-required".into());
        }
        let limit = job.contract().limits.output_bytes;
        let mut x = Xml::new(limit);
        let mut chapters = Vec::<(String, String)>::new();
        let mut title = "Untitled publication".to_string();
        let mut chapter_blocks = 0;
        let mut serialized_bytes = 0usize;
        // Chapter boundaries are top-level headings; nested headings stay in their list.
        // No arbitrary source navigation hierarchy or metadata is copied.
        report.add(
            "CHAPTER_NAVIGATION_POLICY",
            "top-level headings; flat TOC in exact spine order",
            false,
        )?;
        let mut stack = vec![];
        let mut media = BTreeMap::<String, Vec<u8>>::new();
        // Clone only one already-bounded block at a time to permit job checks and
        // authorized asset effects without borrowing the source across mutation.
        for i in 0..job.source().export_blocks().len() {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            let b = job.source().export_blocks()[i].1.as_ref().unwrap().clone();
            let heading = matches!(b.attributes, Some(BlockAttributes::Heading(1..=6)))
                && b.containers.is_empty();
            if heading && chapter_blocks > 0 {
                close_lists(&mut x, &mut stack, 0)?;
                x.add("</body></html>")?;
                serialized_bytes = serialized_bytes
                    .checked_add(x.s.len())
                    .ok_or("output-budget")?;
                x.limit = limit
                    .checked_sub(serialized_bytes + report.original_bytes)
                    .ok_or("output-budget")?;
                chapters.push((title.clone(), std::mem::take(&mut x.s)));
                chapter_blocks = 0;
            }
            if chapter_blocks == 0 {
                title = if heading {
                    b.runs.iter().map(|r| r.text.as_str()).collect::<String>()
                } else {
                    "Untitled publication".into()
                };
                if title.trim().is_empty() {
                    title = "Untitled chapter".into()
                }
                if title.len() > 4096 {
                    return Err("chapter-title-budget".into());
                }
                if chapters.len() >= 256 {
                    return Err("chapter-budget".into());
                }
                document(&mut x, &title)?;
            }
            chapter_blocks += 1;
            let cs = if b.containers.iter().all(|(_, s)| {
                matches!(
                    s,
                    ContainerStyle::Unordered | ContainerStyle::Ordered { .. }
                )
            }) {
                b.containers.as_slice()
            } else {
                &[]
            };
            let content = if let Some(BlockAttributes::Unknown(t)) = &b.attributes {
                Content::from_tuple(t).map_err(|_| "invalid-content")?
            } else {
                None
            };
            if matches!(content, Some(Content::Table { .. } | Content::Asset { .. })) {
                close_lists(&mut x, &mut stack, 0)?
            } else {
                list_prefix(&mut x, &mut stack, cs)?
            }
            match content {
                Some(Content::Table {
                    rows, alignments, ..
                }) => {
                    x.add("<table><tbody>")?;
                    for row in rows {
                        x.add("<tr>")?;
                        for (c, rs) in row.iter().enumerate() {
                            let align = match alignments[c] {
                                Alignment::Left => "left",
                                Alignment::Right => "right",
                                Alignment::Center => "center",
                                _ => "start",
                            };
                            x.add(&format!(
                                "<td style=\"white-space:pre-wrap;text-align:{align}\">"
                            ))?;
                            runs(&mut x, rs)?;
                            x.add("</td>")?;
                        }
                        x.add("</tr>")?
                    }
                    x.add("</tbody></table>")?;
                }
                Some(Content::Asset { descriptor })
                    if descriptor.kind == AssetKind::Image
                        && descriptor.metadata.media_type == "image/png"
                        && descriptor.metadata.byte_length.is_some()
                        && descriptor.metadata.sha256.is_some()
                        && descriptor.metadata.width.is_some()
                        && descriptor.metadata.height.is_some() =>
                {
                    let length = descriptor.metadata.byte_length.unwrap();
                    let hash = descriptor.metadata.sha256.as_ref().unwrap();
                    let name = format!("media/{hash}.png");
                    {
                        // Validate and authorize every reference even when content hashes match.
                        let remaining = limit
                            .checked_sub(report.original_bytes + serialized_bytes + x.s.len())
                            .ok_or("media-output-budget")?;
                        if length > remaining as u64 {
                            return Err("media-output-budget".into());
                        }
                        let mut reader = Reader { host, bytes: None };
                        job.stage_asset(
                            descriptor.identity.clone(),
                            AssetAction::Read,
                            length,
                            &mut reader,
                            now(),
                        )
                        .map_err(|e| format!("asset-read:{e:?}"))?;
                        let bytes = reader.bytes.take().ok_or("asset-read-missing")?;
                        if bytes.len() as u64 != length
                            || format!("{:x}", Sha256::digest(&bytes)) != *hash
                        {
                            return Err("asset-identity-mismatch".into());
                        }
                        let (w, h) = crate::container::validate_png(
                            &bytes,
                            &name,
                            &mut report.media_work,
                            crate::container::Budgets::default(),
                            &mut || {
                                job.check(now()).map_err(|_| {
                                    crate::container::Failure::new(
                                        crate::container::Code::Cancelled,
                                        &name,
                                    )
                                })
                            },
                        )
                        .map_err(|e| format!("asset-media:{e:?}"))?;
                        if Some(w) != descriptor.metadata.width
                            || Some(h) != descriptor.metadata.height
                        {
                            return Err("asset-dimensions".into());
                        }
                        report.original_bytes += bytes.len();
                        x.limit = limit
                            .checked_sub(serialized_bytes + report.original_bytes)
                            .ok_or("output-budget")?;
                        media.insert(name.clone(), bytes);
                    }
                    x.add(&format!(
                        "<figure><img src=\"{name}\" width=\"{}\" height=\"{}\" alt=\"",
                        descriptor.metadata.width.unwrap(),
                        descriptor.metadata.height.unwrap()
                    ))?;
                    x.escaped(&descriptor.metadata.alt)?;
                    x.add("\"/><figcaption>")?;
                    x.escaped(&descriptor.metadata.caption)?;
                    x.add("</figcaption></figure>")?;
                }
                _ => paragraph(&mut x, &b)?,
            }
        }
        close_lists(&mut x, &mut stack, 0)?;
        if chapter_blocks == 0 {
            document(&mut x, &title)?
        }
        x.add("</body></html>")?;
        chapters.push((title, std::mem::take(&mut x.s)));
        let total = chapters
            .iter()
            .try_fold(report.original_bytes, |a, (_, s)| {
                a.checked_add(s.len()).ok_or("output-budget")
            })?;
        if total > limit {
            return Err("output-budget".into());
        }
        let mut identity = Sha256::new();
        for (_, s) in &chapters {
            identity.update(s.as_bytes())
        }
        for (n, b) in &media {
            identity.update(n.as_bytes());
            identity.update(b)
        }
        let identifier = format!("urn:sha256:{:x}", identity.finalize());
        let mut m = Xml::new(limit);
        m.add("<?xml version=\"1.0\" encoding=\"UTF-8\"?><package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"pub-id\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:identifier id=\"pub-id\">")?;
        m.escaped(&identifier)?;
        m.add("</dc:identifier><dc:title>")?;
        m.escaped(&chapters[0].0)?;
        m.add("</dc:title><dc:language>und</dc:language><meta property=\"dcterms:modified\">1970-01-01T00:00:00Z</meta><meta property=\"rendition:layout\">reflowable</meta></metadata><manifest><item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>")?;
        let mut nav = Xml::new(limit);
        document(&mut nav, &chapters[0].0)?;
        nav.add("<nav epub:type=\"toc\" id=\"toc\"><h1>Contents</h1><ol>")?;
        for (i, (label, _)) in chapters.iter().enumerate() {
            m.add(&format!("<item id=\"c{i}\" href=\"chapter-{i}.xhtml\" media-type=\"application/xhtml+xml\"/>"))?;
            nav.add(&format!("<li><a href=\"chapter-{i}.xhtml\">"))?;
            nav.escaped(label)?;
            nav.add("</a></li>")?;
        }
        nav.add("</ol></nav></body></html>")?;
        for (i, name) in media.keys().enumerate() {
            m.add(&format!(
                "<item id=\"m{i}\" href=\"{name}\" media-type=\"image/png\"/>"
            ))?
        }
        m.add("</manifest><spine>")?;
        for i in 0..chapters.len() {
            m.add(&format!("<itemref idref=\"c{i}\"/>"))?
        }
        m.add("</spine></package>")?;
        let container=b"<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\" version=\"1.0\"><rootfiles><rootfile full-path=\"EPUB/package.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>";
        let mut zip = zip::ZipWriter::new(Sink {
            c: Cursor::new(vec![]),
            limit,
        });
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .last_modified_time(zip::DateTime::default())
            .large_file(false);
        let mut parts = vec![
            ("mimetype".to_string(), MIME.as_bytes().to_vec()),
            ("META-INF/container.xml".into(), container.to_vec()),
            ("EPUB/package.opf".into(), m.s.into_bytes()),
            ("EPUB/nav.xhtml".into(), nav.s.into_bytes()),
        ];
        for (i, (_, xml)) in chapters.into_iter().enumerate() {
            parts.push((format!("EPUB/chapter-{i}.xhtml"), xml.into_bytes()))
        }
        for (n, b) in media {
            parts.push((format!("EPUB/{n}"), b))
        }
        if parts.iter().try_fold(0usize, |a, (_, b)| {
            a.checked_add(b.len()).ok_or("output-budget")
        })? > limit
        {
            return Err("output-budget".into());
        }
        for (name, bytes) in parts {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            zip.start_file(name, options)
                .map_err(|e| format!("package:{e}"))?;
            zip.write_all(&bytes).map_err(|e| format!("package:{e}"))?;
        }
        let bytes = zip
            .finish()
            .map_err(|e| format!("package:{e}"))?
            .c
            .into_inner();
        job.append(&bytes, report.nodes, 0, now())
            .map_err(|e| format!("output:{e:?}"))?;
        job.finish_export(now())
            .map_err(|e| format!("completion:{e:?}"))
    })();
    match result {
        Ok(artifact) => Ok(Completion { artifact, report }),
        Err(mut reason) => {
            if let Err(e) = job.abort() {
                reason.push_str(&format!(";cleanup:{e:?}"))
            }
            Err(Failure { reason, report })
        }
    }
}
