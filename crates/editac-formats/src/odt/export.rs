//! Captured-revision ODF 1.3 semantic output. No source-package or pagination
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
    id: "edit-ac-odt-v1",
    format: "odt",
    version: 1,
    import: false,
    export: true,
    available: true,
    fidelity: "odf13-export-semantic-v1",
    owner: "CNV-1.11",
    limits: crate::LIMITS,
};
const MIME: &str = "application/vnd.oasis.opendocument.text";
const NS: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink""#;
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
    #[cfg(feature = "odt-import")]
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
            .ok_or_else(|| io::Error::other("ODT output limit"))?;
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
            return Err(io::Error::other("ODT seek limit"));
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
fn mask(r: &FragmentRun) -> u8 {
    r.marks.iter().fold(0, |a, (m, _)| {
        a | match m {
            Mark::Bold => 1,
            Mark::Italic => 2,
            Mark::Underline => 4,
            Mark::Strike => 8,
            Mark::Code => 16,
            Mark::Link => 0,
        }
    })
}
fn runs(x: &mut Xml, rs: &[FragmentRun]) -> Result<(), String> {
    for r in rs {
        if let Some((_, url)) = r.marks.iter().find(|(m, _)| *m == Mark::Link) {
            let url = url.as_deref().ok_or("missing-link")?;
            if normalize_link_url(url).ok().as_deref() != Some(url) {
                return Err("unsafe-link".into());
            }
            x.add("<text:a xlink:type=\"simple\" xlink:href=\"")?;
            x.escaped(url)?;
            x.add("\">")?;
        }
        x.add(&format!("<text:span text:style-name=\"T{}\">", mask(r)))?;
        for c in r.text.chars() {
            match c {
                ' ' => x.add("<text:s/>")?,
                '\t' => x.add("<text:tab/>")?,
                '\n' => x.add("<text:line-break/>")?,
                '\r' => x.add("&#13;")?,
                _ => {
                    let mut b = [0; 4];
                    x.escaped(c.encode_utf8(&mut b))?
                }
            }
        }
        x.add("</text:span>")?;
        if r.marks.iter().any(|(m, _)| *m == Mark::Link) {
            x.add("</text:a>")?;
        }
    }
    Ok(())
}
fn paragraph(x: &mut Xml, b: &FragmentBlock) -> Result<(), String> {
    let heading = if let Some(BlockAttributes::Heading(n)) = b.attributes {
        Some(n)
    } else {
        None
    };
    if let Some(n) = heading {
        x.add(&format!("<text:h text:outline-level=\"{n}\">"))?
    } else {
        x.add("<text:p>")?
    }
    runs(x, &b.runs)?;
    x.add(if heading.is_some() {
        "</text:h>"
    } else {
        "</text:p>"
    })
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
/// Original ODF styles are not copied. This bounded vocabulary has 32 text mark
/// combinations, alignment styles, and per-container list defaults only.
fn styles(x: &mut Xml, lists: &BTreeMap<String, (usize, ContainerStyle)>) -> Result<(), String> {
    x.add("<office:automatic-styles>")?;
    for m in 0..32 {
        x.add(&format!(
            "<style:style style:name=\"T{m}\" style:family=\"text\"><style:text-properties"
        ))?;
        for (bit, p) in [
            (1, " fo:font-weight=\"bold\""),
            (2, " fo:font-style=\"italic\""),
            (4, " style:text-underline-style=\"solid\""),
            (8, " style:text-line-through-style=\"solid\""),
            (16, " fo:font-family=\"monospace\""),
        ] {
            if m & bit != 0 {
                x.add(p)?
            }
        }
        x.add("/></style:style>")?;
    }
    for a in ["left", "center", "right"] {
        x.add(&format!("<style:style style:name=\"A{a}\" style:family=\"paragraph\"><style:paragraph-properties fo:text-align=\"{a}\"/></style:style>"))?
    }
    for (n, s) in lists.values() {
        x.add(&format!("<text:list-style style:name=\"L{n}\">"))?;
        for level in 1..=9 {
            match s {
        ContainerStyle::Ordered{start}=>x.add(&format!("<text:list-level-style-number text:level=\"{level}\" style:num-format=\"1\" text:start-value=\"{start}\"/>"))?,
        _=>x.add(&format!("<text:list-level-style-bullet text:level=\"{level}\" text:bullet-char=\"•\"/>"))?,
    }
        }
        x.add("</text:list-style>")?;
    }
    x.add("</office:automatic-styles>")
}
fn close_lists(x: &mut Xml, stack: &mut Vec<String>, keep: usize) -> Result<(), String> {
    while stack.len() > keep {
        x.add("</text:list-item></text:list>")?;
        stack.pop();
    }
    Ok(())
}
fn list_prefix(
    x: &mut Xml,
    stack: &mut Vec<String>,
    containers: &[(String, ContainerStyle)],
    lists: &BTreeMap<String, (usize, ContainerStyle)>,
) -> Result<(), String> {
    let common = stack
        .iter()
        .zip(containers)
        .take_while(|(a, (b, _))| *a == b)
        .count();
    close_lists(x, stack, common)?;
    if common == containers.len() && common > 0 {
        x.add("</text:list-item><text:list-item>")?;
    }
    for (id, _) in &containers[common..] {
        x.add(&format!(
            "<text:list text:style-name=\"L{}\"><text:list-item>",
            lists[id].0
        ))?;
        stack.push(id.clone());
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
            "ODF1.3; original package bytes/layout are not retained",
            false,
        )?;
        report.add(
            "STYLE_DEFAULTS",
            "reader page defaults; semantic styles only; no fonts embedded/fetched",
            false,
        )?;
        report.add(
            "METADATA_DEFAULTS",
            "omit creator/timestamps/private metadata/signatures/active content",
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
        x.add(&format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><office:document-content {NS} office:version=\"1.3\">"))?;
        styles(&mut x, &lists)?;
        x.add("<office:body><office:text>")?;
        let mut stack = vec![];
        let mut media = BTreeMap::<String, Vec<u8>>::new();
        // Clone only one already-bounded block at a time to permit job checks and
        // authorized asset effects without borrowing the source across mutation.
        for i in 0..job.source().export_blocks().len() {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            let b = job.source().export_blocks()[i].1.as_ref().unwrap().clone();
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
                list_prefix(&mut x, &mut stack, cs, &lists)?
            }
            match content {
                Some(Content::Table {
                    rows, alignments, ..
                }) => {
                    x.add(&format!("<table:table table:name=\"Table{i}\"><table:table-column table:number-columns-repeated=\"{}\"/>",alignments.len()))?;
                    for row in rows {
                        x.add("<table:table-row>")?;
                        for (c, runs_) in row.iter().enumerate() {
                            x.add("<table:table-cell office:value-type=\"string\"><text:p")?;
                            let a = match alignments[c] {
                                Alignment::Left => Some("left"),
                                Alignment::Center => Some("center"),
                                Alignment::Right => Some("right"),
                                _ => None,
                            };
                            if let Some(a) = a {
                                x.add(&format!(" text:style-name=\"A{a}\""))?
                            }
                            x.add(">")?;
                            runs(&mut x, runs_)?;
                            x.add("</text:p></table:table-cell>")?;
                        }
                        x.add("</table:table-row>")?;
                    }
                    x.add("</table:table>")?;
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
                    let name = format!("Pictures/{hash}.png");
                    {
                        // Validate and authorize every reference even when content hashes match.
                        let remaining = limit
                            .checked_sub(report.original_bytes + x.s.len())
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
                        media.insert(name.clone(), bytes);
                    }
                    let w = descriptor.metadata.width.unwrap() as f64 * 2.54 / 96.0;
                    let h = descriptor.metadata.height.unwrap() as f64 * 2.54 / 96.0;
                    x.add(&format!("<text:p><draw:frame draw:name=\"Image{i}\" text:anchor-type=\"as-char\" svg:width=\"{w:.6}cm\" svg:height=\"{h:.6}cm\"><draw:image xlink:type=\"simple\" xlink:show=\"embed\" xlink:actuate=\"onLoad\" xlink:href=\"{name}\"/><svg:title>"))?;
                    x.escaped(&descriptor.metadata.caption)?;
                    x.add("</svg:title><svg:desc>")?;
                    x.escaped(&descriptor.metadata.alt)?;
                    x.add("</svg:desc></draw:frame></text:p>")?;
                }
                _ => paragraph(&mut x, &b)?,
            }
        }
        close_lists(&mut x, &mut stack, 0)?;
        x.add("</office:text></office:body></office:document-content>")?;
        let mut m = Xml::new(limit);
        m.add("<?xml version=\"1.0\" encoding=\"UTF-8\"?><manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.3\">")?;
        m.add(&format!("<manifest:file-entry manifest:full-path=\"/\" manifest:media-type=\"{MIME}\" manifest:version=\"1.3\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/>"))?;
        for name in media.keys() {
            m.add(&format!("<manifest:file-entry manifest:full-path=\"{name}\" manifest:media-type=\"image/png\"/>"))?;
        }
        m.add("</manifest:manifest>")?;
        let mut zip = zip::ZipWriter::new(Sink {
            c: Cursor::new(vec![]),
            limit,
        });
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .last_modified_time(zip::DateTime::default())
            .large_file(false);
        // ODF mandates first, stored mimetype without a ZIP extra field.
        for (name, bytes) in [
            ("mimetype", MIME.as_bytes()),
            ("content.xml", x.s.as_bytes()),
            ("META-INF/manifest.xml", m.s.as_bytes()),
        ]
        .into_iter()
        .chain(media.iter().map(|(n, b)| (n.as_str(), b.as_slice())))
        {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            zip.start_file(name, options)
                .map_err(|e| format!("package:{e}"))?;
            zip.write_all(bytes).map_err(|e| format!("package:{e}"))?;
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
