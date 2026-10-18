//! Explicit local text-only table dialects; no spreadsheet evaluation.
use crate::{Direction, Profile, job::*};
use csv_core::{ReadFieldResult, ReaderBuilder, Terminator};
use editac_core::{
    commands::editor::{FragmentBlock, FragmentRun},
    document::BlockAttributes,
    modules::content::Content,
};
use editac_session::{assets::AssetStore, session::SessionStore};
use std::{collections::HashMap, sync::Arc};
use yrs::Any;

pub const PROFILE: Profile = Profile {
    id: "edit-ac-csv-v1",
    format: "csv",
    version: 1,
    import: true,
    export: false,
    available: true,
    fidelity: "explicit-utf8-text-table-v1",
    owner: "CNV-1.16",
    limits: crate::LIMITS,
};
pub const TSV_PROFILE: Profile = Profile {
    id: "edit-ac-tsv-v1",
    format: "tsv",
    ..PROFILE
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delimiter {
    Comma,
    Tab,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Newline {
    Lf,
    CrLf,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8OptionalBom,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Header {
    None,
    FirstRow,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ragged {
    Reject,
}
/// Quote is ASCII double quote, escape is doubled quote; no detection/default dialect.
#[derive(Clone, Copy, Debug)]
pub struct Dialect {
    pub delimiter: Delimiter,
    pub newline: Newline,
    pub encoding: Encoding,
    pub header: Header,
    pub ragged: Ragged,
}
#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub rows: usize,
    pub columns: usize,
    pub cells: usize,
    pub cell_utf16: usize,
    pub total_utf16: usize,
}
impl Default for Budgets {
    fn default() -> Self {
        Self {
            rows: 128,
            columns: 32,
            cells: 1024,
            cell_utf16: 8192,
            total_utf16: 262144,
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub scanned_bytes: usize,
    pub rows: usize,
    pub columns: usize,
    pub cells: usize,
    pub utf16_units: usize,
    pub header_rows: usize,
    pub bom_removed: bool,
}
#[derive(Clone, Debug)]
pub struct Failure {
    pub code: &'static str,
    pub offset: usize,
}
type Result<T> = std::result::Result<T, Failure>;
fn fail(code: &'static str, offset: usize) -> Failure {
    Failure { code, offset }
}
fn job_error(e: JobError) -> Failure {
    fail(
        match e {
            JobError::Cancelled => "CANCELLED",
            JobError::Timeout => "TIMEOUT",
            JobError::ResourceLimit => "BUDGET",
            _ => "JOB",
        },
        0,
    )
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
    pub fn commit<S: SessionStore + AssetStore>(
        self,
        job: &mut PreparedJob<S>,
        owner: &mut ConversionOwner<S>,
        now: u64,
    ) -> Result<Option<ImportCompletion>> {
        if !Arc::ptr_eq(&self.token, &job.token) {
            return Err(fail("FOREIGN_JOB", 0));
        }
        job.finish_import(owner, &self.blocks, now)
            .map_err(job_error)
    }
}
// csv-core deliberately accepts malformed input. Enforce the selected strict
// vocabulary first, including empty-record behavior that its reader skips.
fn guard(
    input: &[u8],
    delimiter: u8,
    newline: Newline,
    b: Budgets,
    mut check: impl FnMut() -> Result<()>,
) -> Result<(usize, usize)> {
    let (mut state, mut i, mut fields, mut width, mut rows, mut touched) =
        (0u8, 0, 1usize, 0usize, 0usize, false);
    let record = |fields: usize, width: &mut usize, rows: &mut usize| -> Result<()> {
        if fields > b.columns {
            return Err(fail("COLUMN_BUDGET", 0));
        }
        if *width == 0 {
            *width = fields;
        } else if fields != *width {
            return Err(fail("RAGGED_ROW", 0));
        }
        *rows += 1;
        if *rows > b.rows || rows.checked_mul(*width).is_none_or(|n| n > b.cells) {
            return Err(fail("TABLE_BUDGET", 0));
        }
        Ok(())
    };
    while i < input.len() {
        if i % 1024 == 0 {
            check()?;
        }
        let c = input[i];
        if state == 2 {
            // quoted content
            if c == b'"' {
                state = 3;
            } else if c == b'\r' {
                return Err(fail("SHARED_CELL_CR_UNSUPPORTED", i));
            }
            i += 1;
            continue;
        }
        if c == delimiter {
            fields += 1;
            if fields > b.columns {
                return Err(fail("COLUMN_BUDGET", i));
            }
            state = 0;
            touched = true;
            i += 1;
            continue;
        }
        if c == b'\r' || c == b'\n' {
            let n = match newline {
                Newline::Lf if c == b'\n' => 1,
                Newline::CrLf if c == b'\r' && input.get(i + 1) == Some(&b'\n') => 2,
                _ => return Err(fail("NEWLINE_POLICY", i)),
            };
            if !touched {
                return Err(fail("EMPTY_RECORD", i));
            }
            record(fields, &mut width, &mut rows)?;
            fields = 1;
            state = 0;
            touched = false;
            i += n;
            continue;
        }
        if c == b'"' {
            match state {
                0 => state = 2,
                3 => state = 2,
                _ => return Err(fail("QUOTE_POLICY", i)),
            };
        } else if state == 3 {
            return Err(fail("QUOTE_POLICY", i));
        } else {
            state = 1;
        }
        touched = true;
        i += 1;
    }
    check()?;
    if state == 2 {
        return Err(fail("UNCLOSED_QUOTE", i));
    }
    if touched {
        record(fields, &mut width, &mut rows)?;
    }
    if rows == 0 {
        return Err(fail("EMPTY_INPUT", 0));
    }
    Ok((rows, width))
}
fn object(values: Vec<(&str, Any)>) -> Any {
    Any::Map(Arc::new(
        values
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect::<HashMap<_, _>>(),
    ))
}
fn array(v: Vec<Any>) -> Any {
    Any::Array(v.into())
}
pub fn prepare<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    dialect: Dialect,
    b: Budgets,
    mut now: impl FnMut() -> u64,
) -> Result<Prepared> {
    let result = (|| {
        let hard = Budgets::default();
        if b.rows == 0
            || b.columns == 0
            || b.cells == 0
            || b.cell_utf16 == 0
            || b.total_utf16 == 0
            || b.rows > hard.rows
            || b.columns > hard.columns
            || b.cells > hard.cells
            || b.cell_utf16 > hard.cell_utf16
            || b.total_utf16 > hard.total_utf16
        {
            return Err(fail("INVALID_BUDGET", 0));
        }
        let expected = match dialect.delimiter {
            Delimiter::Comma => PROFILE,
            Delimiter::Tab => TSV_PROFILE,
        };
        if job.contract().profile != expected || job.contract().direction != Direction::Import {
            return Err(fail("TABLE_TEXT_PROFILE", 0));
        }
        job.check(now()).map_err(job_error)?;
        let original = job.source().original();
        let mut input = original;
        let bom = input.starts_with(&[239, 187, 191]);
        if bom {
            if dialect.encoding != Encoding::Utf8OptionalBom {
                return Err(fail("BOM_POLICY", 0));
            }
            input = &input[3..];
        }
        std::str::from_utf8(input).map_err(|e| fail("UTF8", e.valid_up_to()))?;
        // Reject NUL and bidi-unrelated ASCII controls that cannot be plain table text.
        if let Some(i) = input.iter().position(|c| *c < 32 && !b"\t\r\n".contains(c)) {
            return Err(fail("CONTROL_CHARACTER", i));
        }
        let delimiter = match dialect.delimiter {
            Delimiter::Comma => b',',
            Delimiter::Tab => b'\t',
        };
        let (height, width) = guard(input, delimiter, dialect.newline, b, || {
            job.check(now()).map_err(job_error)
        })?;
        if height
            .checked_mul(width)
            .and_then(|n| n.checked_add(1))
            .is_none_or(|n| n > job.contract().limits.nodes)
        {
            return Err(fail("NODE_BUDGET", 0));
        }
        let mut reader = ReaderBuilder::new()
            .delimiter(delimiter)
            .terminator(match dialect.newline {
                Newline::Lf => Terminator::Any(b'\n'),
                Newline::CrLf => Terminator::CRLF,
            })
            .quote(b'"')
            .double_quote(true)
            .escape(None)
            .build();
        let mut buf = [0u8; 1024];
        let mut field = Vec::new();
        let mut cells = Vec::new();
        let mut rows = Vec::new();
        let mut pos = 0;
        let mut fallback = String::new();
        let mut report = Report {
            scanned_bytes: original.len(),
            rows: height,
            columns: width,
            cells: height * width,
            header_rows: usize::from(dialect.header == Header::FirstRow),
            bom_removed: bom,
            ..Report::default()
        };
        loop {
            job.check(now()).map_err(job_error)?;
            let (r, read, written) = reader.read_field(&input[pos..], &mut buf);
            pos += read;
            if field
                .len()
                .checked_add(written)
                .is_none_or(|n| n > b.cell_utf16 * 4)
            {
                return Err(fail("CELL_BUDGET", pos));
            }
            field.extend_from_slice(&buf[..written]);
            match r {
                ReadFieldResult::Field { record_end } => {
                    let text = std::str::from_utf8(&field).map_err(|_| fail("UTF8", pos))?;
                    let units = text.encode_utf16().count();
                    if units > b.cell_utf16
                        || report
                            .utf16_units
                            .checked_add(units)
                            .is_none_or(|n| n > b.total_utf16)
                    {
                        return Err(fail("TEXT_BUDGET", pos));
                    }
                    report.utf16_units += units;
                    if !cells.is_empty() {
                        fallback.push('\t');
                    }
                    fallback.push_str(text);
                    cells.push(object(vec![
                        (
                            "paragraphs",
                            array(vec![object(vec![
                                ("style", array(vec![Any::from("paragraph")])),
                                (
                                    "runs",
                                    array(vec![array(vec![Any::from(text), array(vec![])])]),
                                ),
                            ])]),
                        ),
                        ("rowSpan", Any::from(1u32)),
                        ("columnSpan", Any::from(1u32)),
                        (
                            "header",
                            Any::Bool(dialect.header == Header::FirstRow && rows.is_empty()),
                        ),
                    ]));
                    field.clear();
                    if record_end {
                        rows.push(array(std::mem::take(&mut cells)));
                        fallback.push('\n');
                    }
                }
                ReadFieldResult::End => break,
                _ => {}
            }
        }
        if rows.len() != height || !cells.is_empty() {
            return Err(fail("CODEC_SHAPE", pos));
        }
        // Retain exact source only in inert tuple metadata. Original bytes/hash also
        // remain available on JobSource, including BOM and line ending policy.
        let source = std::str::from_utf8(input).unwrap();
        let tuple = Content::RichTable {
            data: object(vec![
                ("alignments", array(vec![Any::from("none"); width])),
                ("rows", array(rows)),
                ("source", Any::from(source)),
            ]),
        }
        .tuple()
        .map_err(|_| fail("SHARED_TABLE_DESCRIPTOR", pos))?;
        let blocks = vec![FragmentBlock {
            runs: vec![FragmentRun {
                text: fallback.strip_suffix('\n').unwrap_or(&fallback).into(),
                marks: vec![],
                opaque_marks: vec![],
            }],
            attributes: Some(BlockAttributes::Unknown(tuple)),
            containers: vec![],
            checked: None,
        }];
        // Debug-encoding upper bound checks the full tuple, not only text cells.
        struct Count {
            n: usize,
            max: usize,
        }
        impl std::fmt::Write for Count {
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
            &mut Count {
                n: 0,
                max: job.contract().limits.output_bytes
            },
            "{blocks:?}"
        )
        .map_err(|_| fail("OUTPUT_BUDGET", 0))?;
        job.check(now()).map_err(job_error)?;
        Ok(Prepared {
            blocks,
            report,
            token: job.token.clone(),
            original_sha256: job.contract().input_sha256,
        })
    })();
    if result.is_err() {
        job.abort().map_err(|_| fail("JOB_CLEANUP", 0))?;
    }
    result
}
