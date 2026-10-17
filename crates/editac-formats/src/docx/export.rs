//! Optional captured-revision semantic DOCX export. No source-package, layout,
//! signature, active-content, platform sandbox or aggregate availability promise.
use super::import::{Diagnostic, PreparedText};
use crate::{Direction, job::*};
use docx_rs::*;
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::{Mark, normalize_link_url},
        lists::ContainerStyle,
    },
    document::BlockAttributes,
    modules::{assets::*, content::Content},
};
use editac_session::{
    assets::{AssetHost, AssetStore, HostOutcome},
    ports::PortError,
    session::SessionStore,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
};

pub const PROFILE: crate::Profile = crate::Profile {
    import: false,
    export: true,
    fidelity: "docx-export-semantic-v1",
    owner: "CNV-1.7",
    ..super::import::STRUCTURE_PROFILE
};
/// Keep this alongside the original bytes after an import. A newly authored
/// document uses None and empty original bytes. Hosts retain both for recovery.
#[derive(Clone, Debug)]
pub struct Provenance {
    digest: [u8; 32],
    diagnostics: Vec<Diagnostic>,
}
impl Provenance {
    pub fn from_import(prepared: &PreparedText) -> Self {
        Self {
            digest: prepared.original_sha256,
            diagnostics: prepared.report().diagnostics.clone(),
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
    fn add(&mut self, code: &str, location: &str, lossy: bool) {
        self.diagnostics.push(Diagnostic { code: code.into(), location: location.into(), lossy, action: "Retain captured semantics/original input; review and explicitly approve any loss." });
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
/// Read exactly the granted immutable identity, never a URL/path. The host must
/// enforce the byte limit before allocation. Digest/length are checked again here.
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
    fn execute(&mut self, reference: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        if r.action == AssetAction::Read {
            let b = self.host.read_original(r)?;
            if b.len() as u64 > r.byte_limit {
                return Err(PortError::Quota);
            }
            self.bytes = Some(b);
            Ok(HostOutcome::Complete)
        } else {
            self.host.execute(reference, r)
        }
    }
}
/// Bounded random-access ZIP sink; limit checked before every growth/seek.
struct Sink {
    cursor: Cursor<Vec<u8>>,
    limit: usize,
}
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let end = self
            .cursor
            .position()
            .checked_add(b.len() as u64)
            .filter(|n| *n <= self.limit as u64)
            .ok_or_else(|| io::Error::other("DOCX output limit"))?;
        if end > self.limit as u64 {
            return Err(io::Error::other("DOCX output limit"));
        }
        self.cursor.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for Sink {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        let old = self.cursor.position();
        let n = self.cursor.seek(p)?;
        if n > self.limit as u64 {
            self.cursor.set_position(old);
            return Err(io::Error::other("DOCX seek limit"));
        }
        Ok(n)
    }
}
fn valid_text(s: &str) -> bool {
    s.chars().all(|c| {
        c == '\t' || c == '\n' || c == '\r' || c >= ' ' && c != '\u{fffe}' && c != '\u{ffff}'
    })
}
fn runs(p: &mut Paragraph, source: &[FragmentRun]) -> Result<(), String> {
    for r in source {
        if !valid_text(&r.text) {
            return Err("invalid-xml-text".into());
        }
        let mut run = Run::new();
        let mut chunk = String::new();
        for c in r.text.chars() {
            if matches!(c, '\n' | '\r' | '\t') {
                if !chunk.is_empty() {
                    run = run.add_text(std::mem::take(&mut chunk));
                }
                run = match c {
                    '\t' => run.add_tab(),
                    '\r' => run.add_carriage_return(),
                    _ => run.add_break(BreakType::TextWrapping),
                };
            } else {
                chunk.push(c);
            }
        }
        if !chunk.is_empty() {
            run = run.add_text(chunk);
        }
        let mut link = None;
        for (mark, href) in &r.marks {
            run = match mark {
                Mark::Bold => run.bold(),
                Mark::Italic => run.italic(),
                Mark::Strike => run.strike(),
                Mark::Underline => run.underline("single"),
                Mark::Code => {
                    run.fonts(RunFonts::new().ascii("Courier New").hi_ansi("Courier New"))
                }
                Mark::Link => {
                    link = Some(
                        normalize_link_url(href.as_deref().ok_or("missing-link")?)
                            .map_err(|_| "unsafe-link")?,
                    );
                    run
                }
            };
        }
        *p = if let Some(href) = link {
            p.clone()
                .add_hyperlink(Hyperlink::new(href, HyperlinkType::External).add_run(run))
        } else {
            p.clone().add_run(run)
        };
    }
    Ok(())
}
fn preflight(
    blocks: &[(String, Result<FragmentBlock, String>)],
    report: &mut Report,
) -> Result<(), String> {
    for (id, b) in blocks {
        let b = match b {
            Ok(b) => b,
            Err(_) => {
                report.add("SHARED_FRAGMENT_UNAVAILABLE", id, true);
                continue;
            }
        };
        report.nodes += 1 + b.runs.len();
        for (container, style) in &b.containers {
            if matches!(style, ContainerStyle::Checklist | ContainerStyle::Quote) {
                report.add("UNSUPPORTED_CONTAINER", container, true);
            }
        }
        if b.containers.len() > 9 {
            report.add("LIST_DEPTH", id, true);
        }
        if b.checked.is_some() {
            report.add("CHECK_STATE", id, true);
        }
        for r in &b.runs {
            if r.marks.iter().any(|(m, _)| *m == Mark::Code) {
                report.add("CODE_MARK_FORMATTING", id, true);
            }
            if !valid_text(&r.text) {
                return Err("invalid-xml-text".into());
            }
        }
        match &b.attributes {
            None | Some(BlockAttributes::Paragraph | BlockAttributes::Heading(_)) => {}
            Some(BlockAttributes::Code(_)) => report.add("CODE_BLOCK_LANGUAGE_LAYOUT", id, true),
            Some(BlockAttributes::Separator) => report.add("SEPARATOR", id, true),
            Some(BlockAttributes::Unknown(tuple)) => {
                if !b.containers.is_empty() {
                    report.add("ATOMIC_CONTAINER_PLACEMENT", id, true);
                }
                match Content::from_tuple(tuple).map_err(|_| "invalid-content")? {
                    Some(Content::Table {
                        rows, alignments, ..
                    }) => {
                        for (i, row) in rows.iter().enumerate() {
                            report.nodes += 1 + row.len();
                            for cell in row {
                                report.nodes += cell.len();
                                for r in cell {
                                    if r.marks.iter().any(|(m, _)| *m == Mark::Code) {
                                        report.add("CODE_MARK_FORMATTING", id, true);
                                    }
                                    if !valid_text(&r.text) {
                                        return Err("invalid-xml-text".into());
                                    }
                                }
                            }
                            if row.len() != alignments.len() {
                                return Err(format!("ragged-table:{id}:{i}"));
                            }
                        }
                        if alignments
                            .iter()
                            .any(|a| *a != editac_core::modules::content::Alignment::None)
                        {
                            report.add("TABLE_ALIGNMENT", id, true);
                        }
                    }
                    Some(Content::Asset { descriptor })
                        if descriptor.kind == AssetKind::Image
                            && descriptor.metadata.media_type == "image/png"
                            && descriptor.metadata.byte_length.is_some()
                            && descriptor.metadata.sha256.is_some()
                            && descriptor.metadata.width.is_some() =>
                    {
                        descriptor.validate().map_err(|_| "invalid-asset")?;
                        report.assets += 1;
                        if !descriptor.metadata.alt.is_empty() {
                            report.add("IMAGE_ALT", id, true);
                        }
                        if !descriptor.metadata.caption.is_empty() {
                            report.add("IMAGE_CAPTION", id, true);
                        }
                    }
                    _ => report.add("UNSUPPORTED_CONTENT", id, true),
                }
            }
        }
    }
    Ok(())
}
type NumberingPlan = BTreeMap<String, (usize, BTreeMap<usize, ContainerStyle>)>;
fn numbering_plan(
    blocks: &[(String, Result<FragmentBlock, String>)],
    report: &mut Report,
) -> NumberingPlan {
    let mut plan = NumberingPlan::new();
    for (_, block) in blocks {
        let Ok(block) = block else { continue };
        let Some((root, _)) = block.containers.first() else {
            continue;
        };
        let next = plan.len() + 1;
        let (_, levels) = plan
            .entry(root.clone())
            .or_insert_with(|| (next, BTreeMap::new()));
        for (level, (_, style)) in block.containers.iter().enumerate() {
            if let Some(previous) = levels.get(&level) {
                if previous != style {
                    report.add("LIST_LEVEL_STYLE_CONFLICT", root, true);
                }
            } else {
                levels.insert(level, style.clone());
            }
        }
    }
    plan
}
// The writer always injects a default numId=1 and presentation properties.
// Emit exactly our bounded approved numbering plan in the normalized package.
fn numbering_xml(plan: &NumberingPlan) -> Vec<u8> {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">"#,
    );
    for (number, levels) in plan.values() {
        xml.push_str(&format!(r#"<w:abstractNum w:abstractNumId="{number}">"#));
        for (level, style) in levels {
            let (start, format, text) = match style {
                ContainerStyle::Ordered { start } => {
                    (*start, "decimal", format!("%{}.", level + 1))
                }
                _ => (1, "bullet", "•".into()),
            };
            xml.push_str(&format!(r#"<w:lvl w:ilvl="{level}"><w:start w:val="{start}"/><w:numFmt w:val="{format}"/><w:lvlText w:val="{text}"/></w:lvl>"#));
        }
        xml.push_str("</w:abstractNum>");
    }
    for (number, _) in plan.values() {
        xml.push_str(&format!(
            r#"<w:num w:numId="{number}"><w:abstractNumId w:val="{number}"/></w:num>"#
        ));
    }
    xml.push_str("</w:numbering>");
    xml.into_bytes()
}
// Only normalize known generated empty properties/IDs, never authored text.
fn document_xml(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    use quick_xml::{
        Reader, Writer,
        events::{BytesStart, Event},
    };
    let source = String::from_utf8(bytes)
        .map_err(|_| "writer-encoding")?
        .replace("<w:rPr />", "")
        .replace("<w:rPr/>", "")
        .replace("<w:pPr></w:pPr>", "")
        .replace("<w:pPr />", "");
    let mut reader = Reader::from_str(&source);
    let mut writer = Writer::new(Vec::new());
    let mut drawing = 0usize;
    loop {
        let e = reader.read_event().map_err(|e| format!("writer-xml:{e}"))?;
        match e {
            Event::Eof => break,
            Event::Empty(ref node)
                if node.name().as_ref() == b"wp:docPr" || node.name().as_ref() == b"pic:cNvPr" =>
            {
                let is_drawing = node.name().as_ref() == b"wp:docPr";
                if is_drawing {
                    drawing += 1;
                }
                let mut tag = BytesStart::new(if is_drawing { "wp:docPr" } else { "pic:cNvPr" });
                let id = drawing.to_string();
                tag.push_attribute(("id", id.as_str()));
                tag.push_attribute(("name", if is_drawing { "Figure" } else { "" }));
                writer
                    .write_event(Event::Empty(tag))
                    .map_err(|e| format!("writer-xml:{e}"))?;
            }
            _ => writer
                .write_event(e)
                .map_err(|e| format!("writer-xml:{e}"))?,
        }
    }
    Ok(writer.into_inner())
}
/// No output or asset work is performed before complete representability review.
/// Failure retains the immutable job source; abort fences only job-owned work.
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
            report.diagnostics.extend(p.diagnostics.clone());
        } else if !job.source().original().is_empty() {
            report.add("SOURCE_PROVENANCE_UNAVAILABLE", "original", true);
        }
        report.add("PACKAGE_REGENERATED", "package", false);
        report.add(
            "PAGE_STYLE_DEFAULTS",
            "A4; 11pt Arial; no host font embedding",
            false,
        );
        report.add(
            "METADATA_DEFAULTS",
            "new package; fixed creation time; no original signatures/macros",
            false,
        );
        preflight(job.source().export_blocks(), &mut report)?;
        for node in &job.source().snapshot().visible {
            for run in &node.runs {
                for key in run.attributes.keys().filter(|k| {
                    !matches!(
                        k.as_str(),
                        "bold" | "italic" | "strike" | "underline" | "code" | "link"
                    )
                }) {
                    report.add(&format!("UNSUPPORTED_MARK:{key}"), &node.id, true);
                }
            }
            if node.kind != "block"
                && !job.source().export_blocks().iter().any(|(_, b)| {
                    b.as_ref()
                        .is_ok_and(|b| b.containers.iter().any(|(id, _)| *id == node.id))
                })
            {
                report.add("EMPTY_OR_UNMAPPED_CONTAINER", &node.id, true);
            }
        }
        let numbering = numbering_plan(job.source().export_blocks(), &mut report);
        if !job.source().snapshot().recovery.is_empty() {
            report.add("RETAINED_RECOVERY", "snapshot.recovery", true);
        }
        if report.nodes > job.contract().limits.nodes
            || report.assets > 64
            || report.diagnostics.len() > 4096
        {
            return Err("semantic-budget".into());
        }
        if report
            .diagnostics
            .iter()
            .any(|d| d.code == "SHARED_FRAGMENT_UNAVAILABLE" || d.code == "LIST_DEPTH")
        {
            return Err("shared-fragment-required".into());
        }
        if !approve_loss && report.diagnostics.iter().any(|d| d.lossy) {
            return Err("loss-approval-required".into());
        }
        let blocks = job
            .source()
            .export_blocks()
            .iter()
            .map(|(id, b)| (id.clone(), b.as_ref().unwrap().clone()))
            .collect::<Vec<_>>();
        let mut doc = Docx::new()
            .page_size(11906, 16838)
            .default_size(22)
            .default_fonts(RunFonts::new().ascii("Arial").hi_ansi("Arial"))
            .created_at("2000-01-01T00:00:00Z")
            .updated_at("2000-01-01T00:00:00Z");
        for n in 1..=6 {
            doc = doc.add_style(
                Style::new(format!("Heading{n}"), StyleType::Paragraph)
                    .name(format!("heading {n}"))
                    .based_on("Normal")
                    .outline_lvl(n - 1)
                    .size(32 - (n - 1) * 2),
            );
        }
        for (number, levels) in numbering.values() {
            let mut abstract_num = AbstractNumbering::new(*number);
            for (level, style) in levels {
                let (start, format, text) = match style {
                    ContainerStyle::Ordered { start } => {
                        (*start, "decimal", format!("%{}.", level + 1))
                    }
                    _ => (1, "bullet", "•".into()),
                };
                abstract_num = abstract_num.add_level(Level::new(
                    *level,
                    Start::new(start as usize),
                    NumberFormat::new(format),
                    LevelText::new(text),
                    LevelJc::new("left"),
                ));
            }
            doc = doc
                .add_abstract_numbering(abstract_num)
                .add_numbering(Numbering::new(*number, *number));
        }
        for (index, (id, b)) in blocks.into_iter().enumerate() {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            let mut paragraph = Paragraph::new().id(format!("{:08X}", index + 1));
            if let Some(BlockAttributes::Heading(n)) = b.attributes {
                paragraph = paragraph
                    .style(&format!("Heading{n}"))
                    .outline_lvl((n - 1) as usize);
            }
            if let Some((root, _)) = b.containers.first() {
                if b.containers.iter().all(|(_, style)| {
                    matches!(
                        style,
                        ContainerStyle::Ordered { .. } | ContainerStyle::Unordered
                    )
                }) {
                    paragraph = paragraph.numbering(
                        NumberingId::new(numbering[root].0),
                        IndentLevel::new(b.containers.len() - 1),
                    );
                }
            }
            let content = if let Some(BlockAttributes::Unknown(t)) = &b.attributes {
                Content::from_tuple(t).map_err(|_| "invalid-content")?
            } else {
                None
            };
            match content {
                Some(Content::Table { rows, .. }) => {
                    let mut table = vec![];
                    for row in rows {
                        let mut cells = vec![];
                        for cell in row {
                            let mut p = Paragraph::new();
                            runs(&mut p, &cell)?;
                            cells.push(TableCell::new().add_paragraph(p));
                        }
                        table.push(TableRow::new(cells));
                    }
                    doc = doc.add_table(Table::new(table));
                }
                Some(Content::Asset { descriptor })
                    if descriptor.kind == AssetKind::Image
                        && descriptor.metadata.media_type == "image/png"
                        && descriptor.metadata.sha256.is_some()
                        && descriptor.metadata.byte_length.is_some()
                        && descriptor.metadata.width.is_some() =>
                {
                    let limit = descriptor.metadata.byte_length.unwrap();
                    let mut reader = Reader { host, bytes: None };
                    job.stage_asset(
                        descriptor.identity.clone(),
                        AssetAction::Read,
                        limit,
                        &mut reader,
                        now(),
                    )
                    .map_err(|e| format!("asset-read:{e:?}"))?;
                    let bytes = reader.bytes.take().ok_or("asset-read-missing")?;
                    if bytes.len() as u64 != limit
                        || format!("{:x}", Sha256::digest(&bytes))
                            != descriptor.metadata.sha256.unwrap()
                    {
                        return Err("asset-identity-mismatch".into());
                    }
                    // Original PNG admitted by the ingestion owner; no preview decoder.
                    if bytes.len() < 24
                        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
                        || &bytes[12..16] != b"IHDR"
                    {
                        return Err("asset-png-required".into());
                    }
                    let (w, h) = crate::container::validate_png(
                        &bytes,
                        "export-original",
                        &mut report.media_work,
                        crate::container::Budgets::default(),
                        &mut || {
                            job.check(now()).map_err(|_| {
                                crate::container::Failure::new(
                                    crate::container::Code::Cancelled,
                                    "export-original",
                                )
                            })
                        },
                    )
                    .map_err(|e| format!("asset-media:{e:?}"))?;
                    if Some(w) != descriptor.metadata.width
                        || Some(h) != descriptor.metadata.height
                        || u64::from(w) * u64::from(h) > 16_777_216
                        || w > 4096
                        || h > 4096
                    {
                        return Err("asset-dimensions".into());
                    }
                    report.original_bytes += bytes.len();
                    paragraph = paragraph
                        .add_run(Run::new().add_image(Pic::new_with_dimensions(bytes, w, h)));
                    doc = doc.add_paragraph(paragraph);
                }
                _ => {
                    runs(&mut paragraph, &b.runs)?;
                    doc = doc.add_paragraph(paragraph);
                }
            }
            let _ = id;
        }
        let mut sink = Sink {
            cursor: Cursor::new(vec![]),
            limit: job.contract().limits.output_bytes,
        };
        doc.pack(&mut sink).map_err(|e| format!("writer:{e}"))?;
        // Normalize our own trusted writer's directory records rather than
        // relaxing the hostile-input directory/file-alias guard.
        let packed = sink.cursor.into_inner();
        let limit = job.contract().limits.output_bytes;
        let mut archive = zip::ZipArchive::new(Cursor::new(&packed))
            .map_err(|e| format!("writer-package:{e}"))?;
        let mut normalized = zip::ZipWriter::new(Sink {
            cursor: Cursor::new(vec![]),
            limit,
        });
        let mut inflated = 0usize;
        for i in 0..archive.len() {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("writer-part:{e}"))?;
            if entry.is_dir() {
                continue;
            }
            let remaining = limit.checked_sub(inflated).ok_or("writer-part-budget")?;
            let mut bytes = vec![];
            (&mut entry)
                .take(remaining as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("writer-read:{e}"))?;
            if entry.name() == "word/numbering.xml" {
                bytes = numbering_xml(&numbering);
            }
            if entry.name() == "word/document.xml" {
                bytes = document_xml(bytes)?;
            }
            inflated = inflated
                .checked_add(bytes.len())
                .filter(|n| *n <= limit)
                .ok_or("writer-part-budget")?;
            normalized
                .start_file(
                    entry.name(),
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .map_err(|e| format!("writer-normalize:{e}"))?;
            normalized
                .write_all(&bytes)
                .map_err(|e| format!("writer-normalize:{e}"))?;
        }
        let bytes = normalized
            .finish()
            .map_err(|e| format!("writer-finish:{e}"))?
            .cursor
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
                reason.push_str(&format!(";cleanup:{e:?}"));
            }
            Err(Failure { reason, report })
        }
    }
}
