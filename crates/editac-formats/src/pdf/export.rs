//! Bounded captured text and rich publication prerequisites. Tables/images remain refused;
//! this module does not install or qualify the aggregate PDF publication profile.
use crate::{Direction, Limits, Profile, job::*};
use editac_core::{
    commands::{
        editor::FragmentBlock,
        format::{Mark, normalize_link_url},
        lists::ContainerStyle,
    },
    document::BlockAttributes,
};
use editac_session::{assets::AssetStore, session::SessionStore};
use krilla::{
    Document,
    action::{Action, LinkAction},
    annotation::{Annotation, LinkAnnotation, Target},
    geom::{PathBuilder, Point, Rect, Size},
    page::PageSettings,
    paint::{Fill, Stroke},
    tagging::{ContentTag, ListNumbering, Node, SpanTag, Tag, TagGroup, TagTree},
    text::{Font, TextDirection},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, num::NonZeroU16, ops::Range};

pub const PROFILE: Profile = Profile {
    id: "edit-ac-pdf-text-prerequisite-v1",
    format: "pdf",
    version: 1,
    import: false,
    export: true,
    available: true,
    fidelity: "bounded-text-prerequisite",
    owner: "CNV-1.9",
    limits: Limits {
        input_bytes: 64 * 1024,
        output_bytes: 4 * 1024 * 1024,
        nodes: 4096,
        pages: 8,
    },
};
const WIDTH: f32 = 420.0;
const HEIGHT: f32 = 360.0;
const MARGIN: f32 = 28.0;
const FONT_SIZE: f32 = 14.0;
const LEADING: f32 = 24.0;
const SHAPING_BUDGET: usize = 2_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: String,
    pub location: String,
    pub lossy: bool,
}
#[derive(Clone, Debug)]
pub struct Line {
    pub block: usize,
    pub page: usize,
    pub y: f32,
    pub width: f32,
    /// Exact source slice, including authored newline at the end when present.
    pub text: String,
    pub rtl: bool,
    pub x: f32,
    pub size: f32,
    pub marker: Option<String>,
    pub marker_width: f32,
    pub runs: Vec<PaintRun>,
}
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub lines: Vec<Line>,
    pub pages: usize,
    pub shaped_bytes: usize,
    pub nodes: usize,
}
impl Report {
    fn add(&mut self, code: &str, location: &str, lossy: bool) {
        self.diagnostics.push(Diagnostic {
            code: code.into(),
            location: location.into(),
            lossy,
        });
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

/// Host-approved immutable faces. Rich faces are optional, never substituted or
/// fetched. Indices are regular Latin, Arabic, bold, italic, bold-italic, mono.
#[derive(Clone, Copy)]
pub struct Fonts<'a> {
    pub base: [&'a [u8]; 2],
    pub rich: Option<[&'a [u8]; 4]>,
}
const RICH_HASHES: [&str; 4] = [
    "c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a",
    "36cff144df01309dab648bea71baff9bb074026914afe63aeacc8bc90b67a28b",
    "6edf4227ef0fa846aca70e86a307804ca4401741830f5b3af0f2554abe2b8466",
    "d9e2b23d19f8230be7146f409a52b1d23117e635e28f2e2892cf91b7382f325b",
];
impl<'a> Fonts<'a> {
    fn bytes(&self, face: usize) -> Result<&'a [u8], String> {
        if face < 2 {
            Ok(self.base[face])
        } else {
            self.rich
                .map(|r| r[face - 2])
                .ok_or("RICH_FONT_UNAVAILABLE".into())
        }
    }
    fn validate(&self) -> Result<(), String> {
        for (i, bytes) in self.base.iter().enumerate() {
            if format!("{:x}", Sha256::digest(bytes)) != super::FONT_HASHES[i] {
                return Err("FONT_UNAVAILABLE".into());
            }
        }
        if let Some(rich) = self.rich {
            for (i, bytes) in rich.iter().enumerate() {
                if format!("{:x}", Sha256::digest(bytes)) != RICH_HASHES[i] {
                    return Err("RICH_FONT_UNAVAILABLE".into());
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub face: usize,
    pub underline: bool,
    pub strike: bool,
    pub link: Option<String>,
}
#[derive(Clone, Debug)]
pub struct PaintRun {
    pub text: String,
    pub width: f32,
    pub style: Style,
}
struct SourceRun {
    range: Range<usize>,
    style: Style,
}
struct Paragraph {
    text: String,
    runs: Vec<SourceRun>,
    heading: Option<u8>,
    path: Vec<(String, ContainerStyle)>,
    marker: Option<String>,
}
fn shape(
    text: &str,
    bytes: &[u8],
    rtl: bool,
    size: f32,
    report: &mut Report,
) -> Result<(f32, Vec<usize>), String> {
    report.shaped_bytes = report
        .shaped_bytes
        .checked_add(text.len())
        .ok_or("SHAPING_BUDGET")?;
    if report.shaped_bytes > SHAPING_BUDGET {
        return Err("SHAPING_BUDGET".into());
    }
    let face = rustybuzz::Face::from_slice(bytes, 0).ok_or("FONT_INVALID")?;
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    buffer.set_direction(if rtl {
        rustybuzz::Direction::RightToLeft
    } else {
        rustybuzz::Direction::LeftToRight
    });
    let glyphs = rustybuzz::shape(&face, &[], buffer);
    if glyphs.glyph_infos().iter().any(|g| g.glyph_id == 0) {
        return Err("FONT_COVERAGE_UNAVAILABLE".into());
    }
    let advance: i64 = glyphs
        .glyph_positions()
        .iter()
        .map(|p| i64::from(p.x_advance))
        .sum();
    let mut boundaries = glyphs
        .glyph_infos()
        .iter()
        .map(|g| g.cluster as usize)
        .collect::<Vec<_>>();
    boundaries.extend([0, text.len()]);
    boundaries.sort_unstable();
    boundaries.dedup();
    Ok((
        advance as f32 * size / face.units_per_em() as f32,
        boundaries,
    ))
}
/// Single-script paragraph policy. Styled RTL is restricted to one homogeneous
/// run, so joining/ligatures cannot be broken at an unqualified style boundary.
fn direction(text: &str) -> Result<bool, String> {
    let arabic = text.chars().any(|c| ('\u{0600}'..='\u{06ff}').contains(&c));
    if arabic && text.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("MIXED_BIDI_UNAVAILABLE".into());
    }
    Ok(arabic)
}
fn paragraphs(
    blocks: &[(String, Result<FragmentBlock, String>)],
    report: &mut Report,
) -> Result<Vec<Paragraph>, String> {
    let mut result = vec![];
    let mut unsupported = false;
    let mut counters = BTreeMap::<String, u32>::new();
    let mut previous_path: Vec<(String, ContainerStyle)> = vec![];
    for (id, block) in blocks {
        let Ok(block) = block else {
            report.add("SHARED_FRAGMENT_UNAVAILABLE", id, true);
            unsupported = true;
            continue;
        };
        let heading = match block.attributes {
            None | Some(BlockAttributes::Paragraph) => None,
            Some(BlockAttributes::Heading(n)) if (1..=6).contains(&n) => Some(n),
            _ => {
                report.add("BLOCK_RENDERING_UNIMPLEMENTED", id, true);
                unsupported = true;
                None
            }
        };
        if block.checked.is_some()
            || block.containers.len() > 4
            || block.containers.iter().any(|(_, s)| {
                !matches!(
                    s,
                    ContainerStyle::Ordered { .. } | ContainerStyle::Unordered
                )
            })
        {
            report.add("UNSUPPORTED_LIST_CONTEXT", id, true);
            unsupported = true;
        }
        // A nested list must follow its actual parent item. Missing/empty list
        // owners are never fabricated from indentation alone.
        let common = previous_path
            .iter()
            .zip(&block.containers)
            .take_while(|(a, b)| a == b)
            .count();
        if block.containers.len() > common + 1 {
            report.add("LIST_PARENT_ITEM_UNAVAILABLE", id, true);
            unsupported = true;
        }
        previous_path = block.containers.clone();
        let marker = if let Some((container, style)) = block.containers.last() {
            match style {
                ContainerStyle::Unordered => Some("•".into()),
                ContainerStyle::Ordered { start } => {
                    let count = counters.entry(container.clone()).or_insert(*start);
                    let label = format!("{count}.");
                    *count = count.checked_add(1).ok_or("LIST_COUNTER_LIMIT")?;
                    Some(label)
                }
                _ => None,
            }
        } else {
            None
        };
        let mut text = String::new();
        let mut runs: Vec<SourceRun> = vec![];
        for (index, run) in block.runs.iter().enumerate() {
            let location = format!("{id}/run/{index}");
            let mut style = Style::default();
            let bold = run.marks.iter().any(|(m, _)| *m == Mark::Bold);
            let italic = run.marks.iter().any(|(m, _)| *m == Mark::Italic);
            let code = run.marks.iter().any(|(m, _)| *m == Mark::Code);
            style.face = if code {
                5
            } else {
                match (bold, italic) {
                    (true, true) => 4,
                    (true, false) => 2,
                    (false, true) => 3,
                    _ => 0,
                }
            };
            if code && (bold || italic) {
                report.add("CODE_FACE_COMBINATION_UNAVAILABLE", &location, true);
                unsupported = true;
            }
            for (mark, href) in &run.marks {
                match mark {
                    Mark::Underline => style.underline = true,
                    Mark::Strike => style.strike = true,
                    Mark::Link => match href.as_deref().and_then(|u| normalize_link_url(u).ok()) {
                        Some(url) => {
                            style.link = Some(url);
                            style.underline = true;
                        }
                        None => {
                            report.add("UNSAFE_LINK", &location, true);
                            unsupported = true;
                        }
                    },
                    _ => {}
                }
            }
            if run.text.chars().any(|c| c.is_control() && c != '\n') {
                report.add("CONTROL_LAYOUT_UNAVAILABLE", &location, true);
                unsupported = true;
            }
            let start = text.len();
            text.push_str(&run.text);
            // Coalesce identical styles, including split combining sequences.
            if let Some(last) = runs.last_mut().filter(|r| r.style == style) {
                last.range.end = text.len();
            } else {
                runs.push(SourceRun {
                    range: start..text.len(),
                    style,
                });
            }
        }
        result.push(Paragraph {
            text,
            runs,
            heading,
            path: block.containers.clone(),
            marker,
        });
    }
    if unsupported {
        return Err("SEMANTIC_RENDERING_UNIMPLEMENTED".into());
    }
    Ok(result)
}
fn paint_runs(
    p: &Paragraph,
    range: Range<usize>,
    fonts: Fonts<'_>,
    rtl: bool,
    size: f32,
    report: &mut Report,
) -> Result<Vec<PaintRun>, String> {
    let mut out = vec![];
    for source in &p.runs {
        let start = source.range.start.max(range.start);
        let end = source.range.end.min(range.end);
        if start >= end {
            continue;
        }
        let text = &p.text[start..end];
        let mut style = source.style.clone();
        if rtl {
            if style.face != 0 {
                return Err("RTL_FONT_STYLE_UNAVAILABLE".into());
            }
            style.face = 1;
        }
        let visible = text.strip_suffix('\n').unwrap_or(text);
        let width = shape(visible, fonts.bytes(style.face)?, rtl, size, report)?.0;
        out.push(PaintRun {
            text: text.into(),
            width,
            style,
        });
    }
    if out.is_empty() {
        out.push(PaintRun {
            text: p.text[range].into(),
            width: 0.0,
            style: Style {
                face: usize::from(rtl),
                ..Style::default()
            },
        });
    }
    Ok(out)
}
fn layout(
    paragraphs: &[Paragraph],
    fonts: Fonts<'_>,
    max_pages: usize,
    report: &mut Report,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut page = 0;
    let mut top = MARGIN;
    for (block, p) in paragraphs.iter().enumerate() {
        let rtl = direction(&p.text)?;
        if rtl && !p.path.is_empty() {
            return Err("RTL_LIST_LAYOUT_UNAVAILABLE".into());
        }
        if rtl && p.runs.len() > 1 {
            return Err("RTL_STYLE_BOUNDARY_UNAVAILABLE".into());
        }
        let size = p.heading.map_or(FONT_SIZE, |n| 28.0 - 2.0 * f32::from(n));
        let marker_width = match &p.marker {
            Some(s) => shape(s, fonts.base[0], false, FONT_SIZE, report)?.0,
            None => 0.0,
        };
        let indent = if p.path.is_empty() {
            0.0
        } else {
            p.path.len() as f32 * 24.0 + (marker_width - 18.0).max(0.0)
        };
        let available = WIDTH - 2.0 * MARGIN - indent;
        let mut offset = 0;
        let chunks = if p.text.is_empty() {
            vec![""]
        } else {
            p.text.split_inclusive('\n').collect::<Vec<_>>()
        };
        let mut first = true;
        for chunk in chunks {
            check()?;
            let body = chunk.strip_suffix('\n').unwrap_or(chunk);
            let (_, boundaries) = shape(body, fonts.base[usize::from(rtl)], rtl, size, report)?;
            for source in &p.runs {
                let boundary = source.range.start;
                if boundary > offset
                    && boundary < offset + body.len()
                    && !boundaries.contains(&(boundary - offset))
                {
                    return Err("MARK_CLUSTER_BOUNDARY_UNAVAILABLE".into());
                }
            }
            let mut start = 0;
            loop {
                check()?;
                let mut end = start;
                let mut width = 0.0;
                let mut word_break = None;
                for &candidate in boundaries.iter().filter(|&&n| n > start) {
                    check()?;
                    let runs = paint_runs(
                        p,
                        offset + start..offset + candidate,
                        fonts,
                        rtl,
                        size,
                        report,
                    )?;
                    let w: f32 = runs.iter().map(|r| r.width).sum();
                    if w > available {
                        break;
                    }
                    end = candidate;
                    width = w;
                    if body[..candidate]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_whitespace)
                    {
                        word_break = Some((candidate, w));
                    }
                }
                if end < body.len() {
                    if let Some((boundary, advance)) = word_break {
                        end = boundary;
                        width = advance;
                    }
                }
                if end == start && start < body.len() {
                    return Err("UNBREAKABLE_CLUSTER".into());
                }
                if top + size > HEIGHT - MARGIN {
                    page += 1;
                    top = MARGIN;
                }
                if page >= max_pages {
                    return Err("PAGE_LIMIT".into());
                }
                let last = end == body.len();
                let exact_end = if last { chunk.len() } else { end };
                let runs = paint_runs(
                    p,
                    offset + start..offset + exact_end,
                    fonts,
                    rtl,
                    size,
                    report,
                )?;
                report.lines.push(Line {
                    block,
                    page,
                    y: top + size,
                    width,
                    text: chunk[start..exact_end].into(),
                    rtl,
                    x: if rtl {
                        WIDTH - MARGIN - width
                    } else {
                        MARGIN + indent
                    },
                    size,
                    marker: if first { p.marker.clone() } else { None },
                    marker_width,
                    runs,
                });
                first = false;
                top += LEADING.max(size * 1.55);
                if last {
                    break;
                }
                start = end;
            }
            offset += chunk.len();
        }
    }
    report.pages = page + 1;
    Ok(())
}
fn list_tree(
    paragraphs: &[Paragraph],
    bodies: &mut [Option<TagGroup>],
    labels: &mut [Option<TagGroup>],
    index: &mut usize,
    depth: usize,
) -> TagGroup {
    let (id, style) = &paragraphs[*index].path[depth];
    let mut list = TagGroup::new(Tag::L(if matches!(style, ContainerStyle::Ordered { .. }) {
        ListNumbering::Decimal
    } else {
        ListNumbering::Disc
    }));
    while *index < paragraphs.len()
        && paragraphs[*index]
            .path
            .get(depth)
            .is_some_and(|(next, _)| next == id)
    {
        let i = *index;
        let mut item = TagGroup::new(Tag::LI);
        if let Some(label) = labels[i].take() {
            item.push(label);
        }
        let mut body = TagGroup::new(Tag::LBody);
        body.push(bodies[i].take().unwrap());
        *index += 1;
        while *index < paragraphs.len()
            && paragraphs[*index].path.len() > depth + 1
            && paragraphs[*index]
                .path
                .get(depth)
                .is_some_and(|(next, _)| next == id)
        {
            body.push(list_tree(paragraphs, bodies, labels, index, depth + 1));
        }
        item.push(body);
        list.push(item);
    }
    list
}
fn render(
    report: &Report,
    paragraphs: &[Paragraph],
    fonts: Fonts<'_>,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let mut faces = vec![];
    for i in 0..if fonts.rich.is_some() { 6 } else { 2 } {
        faces.push(Font::new(fonts.bytes(i)?.to_vec().into(), 0).ok_or("FONT_INVALID")?);
    }
    let mut document = Document::new();
    let mut groups = paragraphs
        .iter()
        .map(|p| {
            Some(match p.heading {
                Some(n) => TagGroup::new(Tag::Hn(
                    NonZeroU16::new(u16::from(n)).unwrap(),
                    Some(p.text.clone()),
                )),
                None => TagGroup::new(Tag::P),
            })
        })
        .collect::<Vec<_>>();
    let mut labels = vec![None; paragraphs.len()];
    for number in 0..report.pages {
        check()?;
        let mut page =
            document.start_page_with(PageSettings::new(Size::from_wh(WIDTH, HEIGHT).unwrap()));
        let mut annotations: Vec<(usize, usize, Annotation)> = vec![];
        let mut surface = page.surface();
        for line in report.lines.iter().filter(|l| l.page == number) {
            check()?;
            if let Some(marker) = &line.marker {
                let width = line.marker_width;
                let id = surface.start_tagged(ContentTag::Span(
                    SpanTag::empty().with_actual_text(Some(marker)),
                ));
                surface.draw_text(
                    Point::from_xy(line.x - width - 6.0, line.y),
                    faces[0].clone(),
                    FONT_SIZE,
                    marker,
                    false,
                    TextDirection::LeftToRight,
                );
                surface.end_tagged();
                let mut label = TagGroup::new(Tag::Lbl);
                label.push(id);
                labels[line.block] = Some(label);
            }
            let mut x = line.x;
            for run in &line.runs {
                check()?;
                let id = surface.start_tagged(ContentTag::Span(
                    SpanTag::empty()
                        .with_lang(Some(if line.rtl { "ar" } else { "en" }))
                        .with_actual_text(Some(&run.text)),
                ));
                surface.draw_text(
                    Point::from_xy(x, line.y),
                    faces[run.style.face].clone(),
                    line.size,
                    run.text.strip_suffix('\n').unwrap_or(&run.text),
                    false,
                    if line.rtl {
                        TextDirection::RightToLeft
                    } else {
                        TextDirection::LeftToRight
                    },
                );
                // Stroke decorations are part of the same marked semantic span.
                for y in [
                    run.style.underline.then_some(line.y + 2.0),
                    run.style.strike.then_some(line.y - line.size * 0.3),
                ]
                .into_iter()
                .flatten()
                {
                    if run.width == 0.0 {
                        continue;
                    }
                    let mut path = PathBuilder::new();
                    path.move_to(x, y);
                    path.line_to(x + run.width, y);
                    surface.set_fill(None);
                    surface.set_stroke(Some(Stroke {
                        width: 0.8,
                        ..Default::default()
                    }));
                    surface.draw_path(&path.finish().unwrap());
                    surface.set_stroke(None);
                    surface.set_fill(Some(Fill::default()));
                }
                surface.end_tagged();
                let group = groups[line.block].as_mut().unwrap();
                if let Some(href) = &run.style.link {
                    let mut link = TagGroup::new(Tag::Link);
                    link.push(id);
                    let index = group.children.len();
                    group.push(link);
                    if run.width > 0.0 {
                        let rect =
                            Rect::from_xywh(x, line.y - line.size, run.width, line.size + 4.0)
                                .ok_or("LINK_RECT")?;
                        annotations.push((
                            line.block,
                            index,
                            Annotation::new_link(
                                LinkAnnotation::new(
                                    rect,
                                    Target::Action(Action::Link(LinkAction::new(href.clone()))),
                                ),
                                Some(run.text.clone()),
                            ),
                        ));
                    }
                } else if run.style.face == 5 {
                    let mut code = TagGroup::new(Tag::Code);
                    code.push(id);
                    group.push(code);
                } else {
                    group.push(id);
                }
                x += run.width;
            }
        }
        surface.finish();
        for (block, index, annotation) in annotations {
            let id = page.add_tagged_annotation(annotation);
            if let Node::Group(link) = &mut groups[block].as_mut().unwrap().children[index] {
                link.children.insert(0, id.into());
            }
        }
        page.finish();
    }
    let mut tree = TagTree::new();
    let mut i = 0;
    while i < paragraphs.len() {
        if paragraphs[i].path.is_empty() {
            tree.push(groups[i].take().unwrap());
            i += 1;
        } else {
            tree.push(list_tree(paragraphs, &mut groups, &mut labels, &mut i, 0));
        }
    }
    document.set_tag_tree(tree);
    check()?;
    document.finish().map_err(|e| format!("PDF_WRITE:{e:?}"))
}
/// Captures were produced by the shared Session when the PreparedJob began.
/// Prepared ports are portable integration evidence only; an isolated native
/// document launcher remains a full-profile qualification requirement.
pub fn export_with_fonts<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    fonts: Fonts<'_>,
    approve_mark_loss: bool,
    mut now: impl FnMut() -> u64,
) -> Result<Completion, Failure> {
    let mut report = Report::default();
    let result = (|| -> Result<ExportArtifact, String> {
        job.check(now()).map_err(|e| format!("JOB:{e:?}"))?;
        if job.contract().direction != Direction::Export || job.contract().profile != PROFILE {
            return Err("PDF_EXPORT_PROFILE_REQUIRED".into());
        }
        fonts.validate()?;
        report.add(
            "LAYOUT_DEFAULTS",
            "420x360pt;28pt margins;pinned Noto;single-script;bounded rich headings/lists",
            false,
        );
        if !job.source().original().is_empty() {
            report.add("SOURCE_PROVENANCE_UNAVAILABLE", "original", true);
        }
        // Collect all representability diagnostics before refusing any output.
        let mapped = paragraphs(job.source().export_blocks(), &mut report);
        let mut unsupported = mapped.is_err();
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
                report.add("CONTAINER_UNIMPLEMENTED", &node.id, true);
                unsupported = true;
            }
        }
        if !job.source().snapshot().recovery.is_empty() {
            report.add("RETAINED_RECOVERY", "snapshot.recovery", true);
        }
        let paragraphs = mapped.unwrap_or_default();
        report.nodes = paragraphs.len();
        if report.diagnostics.len() > 4096 {
            return Err("DIAGNOSTIC_LIMIT".into());
        }
        if unsupported {
            return Err("SEMANTIC_RENDERING_UNIMPLEMENTED".into());
        }
        if !approve_mark_loss && report.diagnostics.iter().any(|d| d.lossy) {
            return Err("LOSS_APPROVAL_REQUIRED".into());
        }
        let total = paragraphs
            .iter()
            .try_fold(0usize, |n, p| n.checked_add(p.text.len()))
            .ok_or("TEXT_LIMIT")?;
        if total > PROFILE.limits.input_bytes || paragraphs.len() > job.contract().limits.nodes {
            return Err("TEXT_LIMIT".into());
        }
        let layout_result = layout(
            &paragraphs,
            fonts,
            job.contract().limits.pages.min(8),
            &mut report,
            || job.check(now()).map_err(|e| format!("JOB:{e:?}")),
        );
        if let Err(reason) = layout_result {
            report.add(&reason, "layout", true);
            return Err(reason);
        }
        let bytes = render(&report, &paragraphs, fonts, || {
            job.check(now()).map_err(|e| format!("JOB:{e:?}"))
        })?;
        job.append(&bytes, report.nodes, report.pages, now())
            .map_err(|e| format!("JOB:{e:?}"))?;
        job.finish_export(now()).map_err(|e| format!("JOB:{e:?}"))
    })();
    match result {
        Ok(artifact) => Ok(Completion { artifact, report }),
        Err(reason) => {
            let cleanup = job.abort();
            Err(Failure {
                reason: match cleanup {
                    Ok(()) => reason,
                    Err(e) => format!("{reason};CLEANUP:{e:?}"),
                },
                report,
            })
        }
    }
}

/// Base-face compatibility entry point. Rich faces must be provided explicitly;
/// approval never substitutes host fonts or enables an unimplemented structure.
pub fn export<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    fonts: [&[u8]; 2],
    approve_loss: bool,
    now: impl FnMut() -> u64,
) -> Result<Completion, Failure> {
    export_with_fonts(
        job,
        Fonts {
            base: fonts,
            rich: None,
        },
        approve_loss,
        now,
    )
}
