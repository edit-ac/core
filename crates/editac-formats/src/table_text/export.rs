//! Explicit selected-table text export from one immutable Session revision.
use crate::{Direction, Profile, job::*};
use editac_core::{
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_session::{assets::AssetStore, session::SessionStore};
use yrs::Any;

pub const PROFILE: Profile = Profile {
    id: "edit-ac-csv-v1",
    format: "csv",
    version: 1,
    import: false,
    export: true,
    available: true,
    fidelity: "selected-table-exact-v1",
    owner: "CNV-1.17",
    limits: crate::LIMITS,
};
pub const TSV_PROFILE: Profile = Profile {
    id: "edit-ac-tsv-v1",
    format: "tsv",
    ..PROFILE
};
pub const SAFE_PROFILE: Profile = Profile {
    id: "edit-ac-csv-spreadsheet-safe-v1",
    fidelity: "selected-table-spreadsheet-safe-v1",
    ..PROFILE
};
pub const SAFE_TSV_PROFILE: Profile = Profile {
    id: "edit-ac-tsv-spreadsheet-safe-v1",
    format: "tsv",
    ..SAFE_PROFILE
};
#[derive(Clone, Copy, Debug)]
pub enum Newline {
    Lf,
    CrLf,
}
/// UTF-8 without BOM; every cell quoted with doubled double quotes; final newline
/// always present. Header row is retained in place, never synthesized or dropped.
#[derive(Clone, Copy, Debug)]
pub struct Dialect {
    pub newline: Newline,
}
#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub code: &'static str,
    pub location: String,
    pub lossy: bool,
}
#[derive(Default, Debug)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub rows: usize,
    pub columns: usize,
    pub cells: usize,
    pub nodes: usize,
    pub utf16_units: usize,
    pub transformed_cells: usize,
}
impl Report {
    fn add(
        &mut self,
        code: &'static str,
        at: impl Into<String>,
        lossy: bool,
    ) -> Result<(), String> {
        if self.diagnostics.len() >= 4096 {
            return Err("diagnostic-budget".into());
        }
        self.diagnostics.push(Diagnostic {
            code,
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
fn array(a: &Any) -> Result<&[Any], String> {
    if let Any::Array(a) = a {
        Ok(a)
    } else {
        Err("invalid-table".into())
    }
}
fn field<'a>(a: &'a Any, key: &str) -> Result<&'a Any, String> {
    if let Any::Map(a) = a {
        a.get(key).ok_or("invalid-table".into())
    } else {
        Err("invalid-table".into())
    }
}
fn string(a: &Any) -> Result<&str, String> {
    if let Any::String(s) = a {
        Ok(s)
    } else {
        Err("invalid-table".into())
    }
}
fn formula(s: &str) -> bool {
    s.starts_with(['\t', '\r', '\n'])
        || s.trim_start_matches(|c: char| c.is_whitespace() || c.is_control())
            .starts_with(['=', '+', '-', '@'])
}
fn push(out: &mut String, s: &str, limit: usize) -> Result<(), String> {
    out.len()
        .checked_add(s.len())
        .filter(|n| *n <= limit)
        .ok_or("output-budget")?;
    out.push_str(s);
    Ok(())
}
/// `selected` must name exactly one captured table block. None is never an
/// implicit whole-document/first-table export. Loss approval covers rich-format
/// loss only; selecting a safe profile explicitly authorizes its text transform.
pub fn export<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    selected: Option<&str>,
    dialect: Dialect,
    approve_loss: bool,
    mut now: impl FnMut() -> u64,
) -> Result<Completion, Failure> {
    let mut report = Report::default();
    let result = (|| -> Result<ExportArtifact, String> {
        job.check(now()).map_err(|e| format!("job:{e:?}"))?;
        let profile = job.contract().profile;
        if ![PROFILE, TSV_PROFILE, SAFE_PROFILE, SAFE_TSV_PROFILE].contains(&profile)
            || job.contract().direction != Direction::Export
        {
            return Err("export-profile-required".into());
        }
        let safe = profile == SAFE_PROFILE || profile == SAFE_TSV_PROFILE;
        let delimiter = if profile.format == "tsv" { "\t" } else { "," };
        let selected = selected
            .filter(|s| !s.is_empty())
            .ok_or("explicit-table-selection-required")?;
        let bs = job.source().export_blocks();
        let (_, b) = bs
            .iter()
            .find(|(id, _)| id == selected)
            .ok_or("selected-table-not-captured")?;
        let b = b.as_ref().map_err(|_| "shared-fragment-required")?;
        let Some(BlockAttributes::Unknown(tuple)) = &b.attributes else {
            return Err("selected-target-not-table".into());
        };
        let content = Content::from_tuple(tuple)
            .map_err(|_| "invalid-table")?
            .ok_or("selected-target-not-table")?;
        if !b.containers.is_empty() || b.checked.is_some() {
            report.add("TABLE_CONTEXT_LOST", selected, true)?;
        }
        report.add("TEXT_ONLY_FORMAT", "UTF-8; all fields quoted; doubled quotes; final newline; all rows retained; no types/formula evaluation", false)?;
        for n in &job.source().snapshot().visible {
            if n.id != selected {
                report.add("OUTSIDE_SELECTED_TABLE", &n.id, false)?;
            }
        }
        if !job.source().original().is_empty() {
            report.add("ORIGINAL_RETAINED_NOT_EXPORTED", "job.original", false)?;
        }
        if !job.source().snapshot().recovery.is_empty() {
            report.add("RECOVERY_RETAINED_NOT_EXPORTED", "snapshot.recovery", false)?;
        }
        let mut cells: Vec<Vec<String>> = vec![];
        let limit = job.contract().limits.nodes.min(4096);
        report.node(1, limit)?;
        match content {
            Content::RichTable { data } => {
                if array(field(&data, "alignments")?)?
                    .iter()
                    .any(|a| !matches!(a, Any::String(s) if s.as_ref() == "none"))
                {
                    report.add("TABLE_ALIGNMENT_LOST", selected, true)?;
                }
                for (ri, row) in array(field(&data, "rows")?)?.iter().enumerate() {
                    job.check(now()).map_err(|e| format!("job:{e:?}"))?;
                    report.node(1, limit)?;
                    let mut texts = vec![];
                    for (ci, cell) in array(row)?.iter().enumerate() {
                        let at = format!("{selected}/row{ri}/cell{ci}");
                        report.node(1, limit)?;
                        if !matches!(field(cell, "rowSpan")?, Any::Number(n) if n.as_f64()==Some(1.0))
                            || !matches!(field(cell, "columnSpan")?, Any::Number(n) if n.as_f64()==Some(1.0))
                        {
                            return Err("merged-table-unrepresentable".into());
                        }
                        if matches!(field(cell, "header")?, Any::Bool(true)) {
                            report.add("HEADER_FLAG_LOST_ROW_RETAINED", &at, true)?;
                        }
                        let ps = array(field(cell, "paragraphs")?)?;
                        if ps.len() != 1 {
                            return Err("multi-paragraph-cell-unrepresentable".into());
                        }
                        let mut text = String::new();
                        for p in ps {
                            report.node(1, limit)?;
                            let style = array(field(p, "style")?)?;
                            if !matches!(style, [Any::String(s)] if s.as_ref()=="paragraph") {
                                report.add("CELL_STYLE_LOST", &at, true)?;
                            }
                            for run in array(field(p, "runs")?)? {
                                report.node(1, limit)?;
                                let r = array(run)?;
                                let value = string(r.first().ok_or("invalid-run")?)?;
                                if r.len() > 1 && !matches!(&r[1], Any::Array(a) if a.is_empty()) {
                                    report.add("CELL_MARKS_LOST", &at, true)?;
                                }
                                if text
                                    .len()
                                    .checked_add(value.len())
                                    .is_none_or(|n| n > 32768)
                                {
                                    return Err("cell-budget".into());
                                }
                                text.push_str(value);
                            }
                        }
                        texts.push(text);
                    }
                    cells.push(texts);
                }
            }
            Content::Table {
                rows, alignments, ..
            } => {
                report.add("IMPLICIT_HEADER_LOST_ROW_RETAINED", selected, true)?;
                if alignments.iter().any(|a| *a != Alignment::None) {
                    report.add("TABLE_ALIGNMENT_LOST", selected, true)?;
                }
                for (ri, row) in rows.iter().enumerate() {
                    report.node(1, limit)?;
                    let mut texts = vec![];
                    for (ci, runs) in row.iter().enumerate() {
                        report.node(1 + runs.len(), limit)?;
                        if runs
                            .iter()
                            .any(|r| !r.marks.is_empty() || !r.opaque_marks.is_empty())
                        {
                            report.add(
                                "CELL_MARKS_LOST",
                                format!("{selected}/row{ri}/cell{ci}"),
                                true,
                            )?;
                        }
                        texts.push(runs.iter().map(|r| r.text.as_str()).collect());
                    }
                    cells.push(texts);
                }
            }
            _ => return Err("selected-target-not-table".into()),
        }
        report.rows = cells.len();
        report.columns = cells.first().map_or(0, Vec::len);
        if report.rows == 0
            || report.rows > 128
            || report.columns == 0
            || report.columns > 32
            || report
                .rows
                .checked_mul(report.columns)
                .is_none_or(|n| n > 1024)
        {
            return Err("table-budget".into());
        }
        let mut out = String::new();
        let output_limit = job.contract().limits.output_bytes.min(4194304);
        for (ri, row) in cells.iter().enumerate() {
            if row.len() != report.columns {
                return Err("ragged-table".into());
            }
            for (ci, text) in row.iter().enumerate() {
                job.check(now()).map_err(|e| format!("job:{e:?}"))?;
                let units = text.encode_utf16().count();
                if units > 8192 {
                    return Err("cell-budget".into());
                }
                report.utf16_units = report
                    .utf16_units
                    .checked_add(units)
                    .filter(|n| *n <= 262144)
                    .ok_or("text-budget")?;
                if text
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                {
                    return Err("unsupported-control-character".into());
                }
                if ci > 0 {
                    push(&mut out, delimiter, output_limit)?;
                }
                push(&mut out, "\"", output_limit)?;
                if safe && formula(text) {
                    push(&mut out, "'", output_limit)?;
                    report.transformed_cells += 1;
                    report.add(
                        "SPREADSHEET_SAFE_PREFIX",
                        format!("{selected}/row{ri}/cell{ci}"),
                        false,
                    )?;
                }
                for c in text.chars() {
                    job.check(now()).map_err(|e| format!("job:{e:?}"))?;
                    if c == '"' {
                        push(&mut out, "\"", output_limit)?;
                    }
                    push(&mut out, c.encode_utf8(&mut [0; 4]), output_limit)?;
                }
                push(&mut out, "\"", output_limit)?;
                report.cells += 1;
            }
            push(
                &mut out,
                match dialect.newline {
                    Newline::Lf => "\n",
                    Newline::CrLf => "\r\n",
                },
                output_limit,
            )?;
        }
        if !approve_loss && report.diagnostics.iter().any(|d| d.lossy) {
            return Err("loss-approval-required".into());
        }
        job.append(out.as_bytes(), report.nodes, 0, now())
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
