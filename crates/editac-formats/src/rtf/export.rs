//! Bounded RTF 1.9.1 output from an immutable shared Session capture.
use crate::{Direction, job::*};
use editac_core::{
    commands::{editor::FragmentRun, format::Mark},
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_session::{assets::AssetStore, session::SessionStore};
pub const PROFILE: crate::Profile = crate::Profile {
    id: "edit-ac-rtf-v1",
    format: "rtf",
    version: 1,
    import: false,
    export: true,
    available: true,
    fidelity: "rtf191-export-semantic-v1",
    owner: "CNV-1.13",
    limits: crate::LIMITS,
};
#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub code: String,
    pub location: String,
    pub lossy: bool,
}
#[derive(Clone, Debug)]
pub struct Provenance {
    digest: [u8; 32],
    diagnostics: Vec<Diagnostic>,
}
impl Provenance {
    #[cfg(feature = "rtf-import")]
    pub fn from_import(p: &super::import::Prepared) -> Self {
        Self {
            digest: p.original_sha256,
            diagnostics: p
                .report()
                .diagnostics
                .iter()
                .map(|d| Diagnostic {
                    code: d.code.into(),
                    location: format!("byte{}:{}:{}", d.offset, d.control, d.action),
                    lossy: true,
                })
                .collect(),
        }
    }
}
#[derive(Default, Debug)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub nodes: usize,
    pub utf16_units: usize,
}
impl Report {
    fn add(&mut self, code: &str, at: &str, lossy: bool) -> Result<(), String> {
        if self.diagnostics.len() >= 256 {
            return Err("diagnostic-budget".into());
        }
        self.diagnostics.push(Diagnostic {
            code: code.into(),
            location: at.into(),
            lossy,
        });
        Ok(())
    }
    fn node(&mut self, n: usize, limit: usize) -> Result<(), String> {
        self.nodes = self
            .nodes
            .checked_add(n)
            .filter(|n| *n <= limit)
            .ok_or("node-budget")?;
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
struct Output {
    text: String,
    limit: usize,
}
impl Output {
    fn add(&mut self, s: &str) -> Result<(), String> {
        self.text
            .len()
            .checked_add(s.len())
            .filter(|n| *n <= self.limit)
            .ok_or("output-budget")?;
        self.text.push_str(s);
        Ok(())
    }
    fn runs(
        &mut self,
        runs: &[FragmentRun],
        cell: bool,
        report: &mut Report,
        mut check: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        for r in runs {
            check()?;
            self.add("{\\plain\\f0\\fs24\\cf1 ")?;
            for (m, _) in &r.marks {
                match m {
                    Mark::Bold => self.add("\\b ")?,
                    Mark::Italic => self.add("\\i ")?,
                    Mark::Underline => self.add("\\ul ")?,
                    Mark::Strike => self.add("\\strike ")?,
                    _ => {}
                }
            }
            for c in r.text.chars() {
                check()?;
                report.utf16_units = report
                    .utf16_units
                    .checked_add(c.len_utf16())
                    .filter(|n| *n <= 262144)
                    .ok_or("text-budget")?;
                match c {
                    '{' => self.add("\\{")?,
                    '}' => self.add("\\}")?,
                    '\\' => self.add("\\\\")?,
                    '\n' if !cell => self.add("\\line ")?,
                    '\t' => self.add("\\tab ")?,
                    c if c.is_ascii() && c >= ' ' => self.add(&c.to_string())?,
                    c => {
                        for u in c.encode_utf16(&mut [0; 2]) {
                            self.add(&format!("\\u{}?", *u as i16))?;
                        }
                    }
                }
            }
            self.add("}")?;
        }
        Ok(())
    }
}
fn marks(runs: &[FragmentRun], at: &str, cell: bool, report: &mut Report) -> Result<(), String> {
    for (i, r) in runs.iter().enumerate() {
        let loc = format!("{at}/run{i}");
        for (m, value) in &r.marks {
            if !matches!(
                m,
                Mark::Bold | Mark::Italic | Mark::Underline | Mark::Strike
            ) || value.is_some()
            {
                report.add(&format!("UNSUPPORTED_MARK:{m:?}"), &loc, true)?;
            }
        }
        if cell && r.text.contains('\n') {
            return Err("shared-table-break-unavailable".into());
        }
        if r.text.chars().any(|c| c < ' ' && c != '\n' && c != '\t') {
            return Err("unsupported-control-character".into());
        }
    }
    Ok(())
}
pub fn export<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    provenance: Option<&Provenance>,
    approve_loss: bool,
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
            report.add("SOURCE_PROVENANCE_UNAVAILABLE", "original", true)?;
        }
        report.add("STYLE_DEFAULTS","RTF1/CP1252; Unicode uc1; Helvetica 12pt; black auto background; reader layout; no embedded fonts",false)?;
        report.add(
            "METADATA_DEFAULTS",
            "omit private metadata, OLE, macros, fields, original source bytes/layout",
            false,
        )?;
        let limit = job.contract().limits.nodes.min(4096);
        for (id, b) in job.source().export_blocks() {
            job.check(now()).map_err(|e| format!("job:{e:?}"))?;
            let b = match b {
                Ok(b) => b,
                Err(_) => {
                    report.add("SHARED_FRAGMENT_UNAVAILABLE", id, true)?;
                    continue;
                }
            };
            report.node(1 + b.runs.len(), limit)?;
            if !b.containers.is_empty() {
                report.add("UNSUPPORTED_CONTAINERS", id, true)?;
            }
            if b.checked.is_some() {
                report.add("CHECK_STATE", id, true)?;
            }
            marks(&b.runs, id, false, &mut report)?;
            match &b.attributes {
                None | Some(BlockAttributes::Paragraph) => {}
                Some(BlockAttributes::Unknown(t)) => match Content::from_tuple(t)
                    .map_err(|_| "invalid-content")?
                {
                    Some(Content::Table {
                        rows, alignments, ..
                    }) => {
                        if rows.is_empty()
                            || rows.len() > 128
                            || alignments.is_empty()
                            || alignments.len() > 32
                        {
                            return Err("table-budget".into());
                        }
                        if alignments.iter().any(|a| !matches!(a, Alignment::None)) {
                            report.add("TABLE_ALIGNMENT_DEFAULTS", id, true)?;
                        }
                        for (ri, row) in rows.iter().enumerate() {
                            if row.len() != alignments.len() {
                                return Err("ragged-table".into());
                            }
                            report.node(1 + row.len(), limit)?;
                            for (ci, rs) in row.iter().enumerate() {
                                report.node(rs.len(), limit)?;
                                marks(rs, &format!("{id}/row{ri}/cell{ci}"), true, &mut report)?;
                            }
                        }
                    }
                    _ => report.add("UNSUPPORTED_CONTENT", id, true)?,
                },
                _ => report.add("UNSUPPORTED_BLOCK_STYLE", id, true)?,
            }
        }
        for n in &job.source().snapshot().visible {
            for (i, r) in n.runs.iter().enumerate() {
                for key in r.attributes.keys().filter(|k| {
                    !matches!(
                        k.as_str(),
                        "bold" | "italic" | "underline" | "strike" | "code" | "link"
                    )
                }) {
                    report.add(
                        &format!("UNSUPPORTED_MARK:{key}"),
                        &format!("{}/run{i}", n.id),
                        true,
                    )?;
                }
            }
            if n.kind != "block" {
                report.add("UNMAPPED_CONTAINER", &n.id, true)?;
            }
        }
        if !job.source().snapshot().recovery.is_empty() {
            report.add("RETAINED_RECOVERY", "snapshot.recovery", true)?;
        }
        if report
            .diagnostics
            .iter()
            .any(|d| d.code == "SHARED_FRAGMENT_UNAVAILABLE")
        {
            return Err("shared-fragment-required".into());
        }
        if !approve_loss && report.diagnostics.iter().any(|d| d.lossy) {
            return Err("loss-approval-required".into());
        }
        let mut out = Output {
            text: String::new(),
            limit: job.contract().limits.output_bytes.min(4 * 1024 * 1024),
        };
        out.add("{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fswiss Helvetica;}}{\\colortbl;\\red0\\green0\\blue0;}\n")?;
        for (_, b) in job.source().export_blocks() {
            let b = b.as_ref().map_err(|_| "shared-fragment-required")?;
            let content = if let Some(BlockAttributes::Unknown(t)) = &b.attributes {
                Content::from_tuple(t).map_err(|_| "invalid-content")?
            } else {
                None
            };
            if let Some(Content::Table {
                rows, alignments, ..
            }) = content
            {
                for row in rows {
                    out.add("\\trowd\\trgaph0")?;
                    for c in 1..=alignments.len() {
                        out.add(&format!("\\cellx{}", c * 2000))?;
                    }
                    out.add("\n")?;
                    for rs in row {
                        out.add("\\pard\\intbl ")?;
                        out.runs(&rs, true, &mut report, || {
                            job.check(now()).map_err(|e| format!("job:{e:?}"))
                        })?;
                        out.add("\\cell ")?;
                    }
                    out.add("\\row\n")?;
                }
            } else {
                out.add("\\pard ")?;
                out.runs(&b.runs, false, &mut report, || {
                    job.check(now()).map_err(|e| format!("job:{e:?}"))
                })?;
                out.add("\\par\n")?;
            }
        }
        out.add("}")?;
        job.append(out.text.as_bytes(), report.nodes, 0, now())
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
