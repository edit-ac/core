//! Bounded text publication prerequisite. Rich structures are reported and refused;
//! this module does not install or qualify the aggregate PDF publication profile.
use crate::{Direction, Limits, Profile, job::*};
use editac_core::document::BlockAttributes;
use editac_session::{assets::AssetStore, session::SessionStore};
use krilla::{
    Document,
    geom::{Point, Size},
    page::PageSettings,
    tagging::{ContentTag, SpanTag, Tag, TagGroup, TagTree},
    text::{Font, TextDirection},
};
use sha2::{Digest, Sha256};

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

fn shape(
    text: &str,
    bytes: &[u8],
    rtl: bool,
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
        advance as f32 * FONT_SIZE / face.units_per_em() as f32,
        boundaries,
    ))
}

/// A deliberately limited single-script paragraph policy. No host bidi service,
/// font substitution, arbitrary script/template execution or text normalization.
fn direction(text: &str) -> Result<bool, String> {
    let arabic = text.chars().any(|c| ('\u{0600}'..='\u{06ff}').contains(&c));
    if arabic && text.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("MIXED_BIDI_UNAVAILABLE".into());
    }
    Ok(arabic)
}

fn layout(
    texts: &[String],
    fonts: [&[u8]; 2],
    max_pages: usize,
    report: &mut Report,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut page = 0;
    let mut y = MARGIN + FONT_SIZE;
    for (block, text) in texts.iter().enumerate() {
        let rtl = direction(text)?;
        let font = fonts[usize::from(rtl)];
        // split_inclusive preserves every authored newline and trailing whitespace.
        let chunks = if text.is_empty() {
            vec![""]
        } else {
            text.split_inclusive('\n').collect()
        };
        for chunk in chunks {
            let body = chunk.strip_suffix('\n').unwrap_or(chunk);
            check()?;
            let (_, boundaries) = shape(body, font, rtl, report)?;
            let mut start = 0;
            loop {
                check()?;
                let mut end = start;
                let mut width = 0.0;
                let mut word_break = None;
                for &candidate in boundaries.iter().filter(|&&n| n > start) {
                    check()?;
                    let (w, _) = shape(&body[start..candidate], font, rtl, report)?;
                    if w > WIDTH - 2.0 * MARGIN {
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
                if y > HEIGHT - MARGIN {
                    page += 1;
                    y = MARGIN + FONT_SIZE;
                }
                if page >= max_pages {
                    return Err("PAGE_LIMIT".into());
                }
                let last = end == body.len();
                let exact_end = if last { chunk.len() } else { end };
                report.lines.push(Line {
                    block,
                    page,
                    y,
                    width,
                    text: chunk[start..exact_end].into(),
                    rtl,
                });
                y += LEADING;
                if last {
                    break;
                }
                start = end;
            }
        }
    }
    report.pages = page + 1;
    Ok(())
}

fn render(
    report: &Report,
    fonts: [&[u8]; 2],
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let faces = [
        Font::new(fonts[0].to_vec().into(), 0).ok_or("FONT_INVALID")?,
        Font::new(fonts[1].to_vec().into(), 0).ok_or("FONT_INVALID")?,
    ];
    let mut document = Document::new();
    let mut groups = (0..report.nodes)
        .map(|_| TagGroup::new(Tag::P))
        .collect::<Vec<_>>();
    for number in 0..report.pages {
        check()?;
        let mut page =
            document.start_page_with(PageSettings::new(Size::from_wh(WIDTH, HEIGHT).unwrap()));
        let mut surface = page.surface();
        for line in report.lines.iter().filter(|line| line.page == number) {
            check()?;
            let id = surface.start_tagged(ContentTag::Span(
                SpanTag::empty()
                    .with_lang(Some(if line.rtl { "ar" } else { "en" }))
                    .with_actual_text(Some(&line.text)),
            ));
            let x = if line.rtl {
                WIDTH - MARGIN - line.width
            } else {
                MARGIN
            };
            surface.draw_text(
                Point::from_xy(x, line.y),
                faces[usize::from(line.rtl)].clone(),
                FONT_SIZE,
                line.text.strip_suffix('\n').unwrap_or(&line.text),
                false,
                if line.rtl {
                    TextDirection::RightToLeft
                } else {
                    TextDirection::LeftToRight
                },
            );
            surface.end_tagged();
            groups[line.block].push(id);
        }
        surface.finish();
        page.finish();
    }
    let mut tree = TagTree::new();
    for group in groups {
        tree.push(group);
    }
    document.set_tag_tree(tree);
    check()?;
    document.finish().map_err(|e| format!("PDF_WRITE:{e:?}"))
}

/// Captures were produced by the shared Session when the PreparedJob began.
/// Prepared ports are portable integration evidence only; an isolated native
/// document launcher remains a full-profile qualification requirement.
pub fn export<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    fonts: [&[u8]; 2],
    approve_mark_loss: bool,
    mut now: impl FnMut() -> u64,
) -> Result<Completion, Failure> {
    let mut report = Report::default();
    let result = (|| -> Result<ExportArtifact, String> {
        job.check(now()).map_err(|e| format!("JOB:{e:?}"))?;
        if job.contract().direction != Direction::Export || job.contract().profile != PROFILE {
            return Err("PDF_EXPORT_PROFILE_REQUIRED".into());
        }
        for (i, bytes) in fonts.iter().enumerate() {
            let digest = format!("{:x}", Sha256::digest(bytes));
            if digest != super::FONT_HASHES[i] {
                return Err("FONT_UNAVAILABLE".into());
            }
        }
        report.add(
            "LAYOUT_DEFAULTS",
            "420x360pt;28pt margins;14pt Noto;24pt leading;single-script paragraphs",
            false,
        );
        if !job.source().original().is_empty() {
            report.add("SOURCE_PROVENANCE_UNAVAILABLE", "original", true);
        }
        let mut unsupported = false;
        let mut texts = vec![];
        for (id, block) in job.source().export_blocks() {
            let Ok(block) = block else {
                report.add("SHARED_FRAGMENT_UNAVAILABLE", id, true);
                unsupported = true;
                continue;
            };
            if !block.containers.is_empty() || block.checked.is_some() {
                report.add("STRUCTURED_CONTAINER_UNIMPLEMENTED", id, true);
                unsupported = true;
            }
            if !matches!(block.attributes, None | Some(BlockAttributes::Paragraph)) {
                report.add("BLOCK_RENDERING_UNIMPLEMENTED", id, true);
                unsupported = true;
            }
            let mut text = String::new();
            for run in &block.runs {
                for (mark, _) in &run.marks {
                    report.add(&format!("MARK_RENDERING_UNIMPLEMENTED:{mark:?}"), id, true);
                }
                if run.text.chars().any(|c| c.is_control() && c != '\n') {
                    report.add("CONTROL_LAYOUT_UNAVAILABLE", id, true);
                    unsupported = true;
                }
                text.push_str(&run.text);
            }
            texts.push(text);
        }
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
            if node.kind != "block" {
                report.add("CONTAINER_UNIMPLEMENTED", &node.id, true);
                unsupported = true;
            }
        }
        if !job.source().snapshot().recovery.is_empty() {
            report.add("RETAINED_RECOVERY", "snapshot.recovery", true);
        }
        report.nodes = texts.len();
        if report.diagnostics.len() > 4096 {
            return Err("DIAGNOSTIC_LIMIT".into());
        }
        if unsupported {
            return Err("SEMANTIC_RENDERING_UNIMPLEMENTED".into());
        }
        if !approve_mark_loss && report.diagnostics.iter().any(|d| d.lossy) {
            return Err("LOSS_APPROVAL_REQUIRED".into());
        }
        let total = texts
            .iter()
            .try_fold(0usize, |n, s| n.checked_add(s.len()))
            .ok_or("TEXT_LIMIT")?;
        if total > PROFILE.limits.input_bytes || texts.len() > job.contract().limits.nodes {
            return Err("TEXT_LIMIT".into());
        }
        layout(
            &texts,
            fonts,
            job.contract().limits.pages.min(8),
            &mut report,
            || job.check(now()).map_err(|e| format!("JOB:{e:?}")),
        )?;
        let bytes = render(&report, fonts, || {
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
