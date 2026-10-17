//! Deliberately bounded RTF 1.9.1 grammar; see fixtures/formats/rtf/profile.md.
//! No OS controls, embedded-object activation, filesystem or network capabilities.
use crate::{Direction, Limits, Profile, job::*};
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
    },
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_session::{assets::AssetStore, session::SessionStore};
use std::sync::Arc;

pub const PROFILE: Profile = Profile {
    id: "edit-ac-rtf-v1",
    format: "rtf",
    version: 1,
    import: true,
    export: false,
    available: true,
    fidelity: "rtf191-cp1252-unicode-simple-table-v1",
    owner: "CNV-1.12",
    limits: crate::LIMITS,
};
#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub depth: usize,
    pub tokens: usize,
    pub binary_bytes: usize,
    pub diagnostics: usize,
    pub utf16_units: usize,
    pub rows: usize,
    pub columns: usize,
}
impl Default for Budgets {
    fn default() -> Self {
        Self {
            depth: 64,
            tokens: 131072,
            binary_bytes: 65536,
            diagnostics: 256,
            utf16_units: 262144,
            rows: 128,
            columns: 32,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub offset: usize,
    pub control: String,
    pub action: &'static str,
}
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub scanned_bytes: usize,
    pub tokens: usize,
    pub binary_bytes: usize,
    pub max_depth: usize,
    pub utf16_units: usize,
    pub nodes: usize,
}
#[derive(Clone, Debug)]
pub struct Failure {
    pub code: &'static str,
    pub offset: usize,
    pub report: Report,
}
type Result<T> = std::result::Result<T, Failure>;
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
        approve_loss: bool,
        now: u64,
    ) -> Result<Option<ImportCompletion>> {
        let failure = |code| Failure {
            code,
            offset: 0,
            report: self.report.clone(),
        };
        if !Arc::ptr_eq(&self.token, &job.token) {
            return Err(failure("FOREIGN_JOB"));
        }
        if !approve_loss && !self.report.diagnostics.is_empty() {
            job.abort().map_err(|_| failure("JOB_CLEANUP"))?;
            return Err(failure("LOSS_APPROVAL"));
        }
        job.finish_import(owner, &self.blocks, now)
            .map_err(|e| failure(job_code(&e)))
    }
}
fn job_code(e: &JobError) -> &'static str {
    match e {
        JobError::Cancelled => "CANCELLED",
        JobError::Timeout => "TIMEOUT",
        JobError::ResourceLimit => "BUDGET",
        _ => "JOB",
    }
}
#[derive(Clone)]
struct State {
    marks: Vec<(Mark, Option<String>)>,
    uc: usize,
    skip: bool,
    start: bool,
    star: bool,
    intbl: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            marks: vec![],
            uc: 1,
            skip: false,
            start: true,
            star: false,
            intbl: false,
        }
    }
}
struct Parser<'a, C> {
    input: &'a [u8],
    pos: usize,
    limits: Limits,
    budgets: Budgets,
    report: Report,
    state: State,
    stack: Vec<State>,
    runs: Vec<FragmentRun>,
    blocks: Vec<FragmentBlock>,
    rows: Vec<Vec<Vec<FragmentRun>>>,
    cells: Option<Vec<Vec<FragmentRun>>>,
    edges: Vec<i32>,
    fallback: usize,
    surrogate: Option<(u16, Vec<(Mark, Option<String>)>)>,
    output_bytes: usize,
    check: C,
}
impl<C: FnMut() -> std::result::Result<(), JobError>> Parser<'_, C> {
    fn err(&self, code: &'static str) -> Failure {
        Failure {
            code,
            offset: self.pos,
            report: {
                let mut r = self.report.clone();
                r.scanned_bytes = self.pos;
                r
            },
        }
    }
    fn diag(&mut self, code: &'static str, control: &str, offset: usize) -> Result<()> {
        if self.report.diagnostics.len() >= self.budgets.diagnostics {
            return Err(self.err("DIAGNOSTIC_BUDGET"));
        }
        self.report.diagnostics.push(Diagnostic { code, control: control.into(), offset, action: "retain original input; review report; explicitly approve loss or choose another profile" });
        Ok(())
    }
    fn node(&mut self, n: usize) -> Result<()> {
        self.report.nodes = self
            .report
            .nodes
            .checked_add(n)
            .filter(|n| *n <= self.limits.nodes)
            .ok_or_else(|| self.err("NODE_BUDGET"))?;
        Ok(())
    }
    fn scalar(&mut self, ch: char) -> Result<()> {
        if self.surrogate.is_some() {
            return Err(self.err("UNICODE_SURROGATE"));
        }
        if self.cells.is_none() && !self.rows.is_empty() {
            if self.state.intbl {
                return Err(self.err("TABLE_ROW_REQUIRED"));
            }
            self.flush_table()?;
        }
        if self.cells.is_some() && (!self.state.intbl || ch == '\n' || ch == '\r' || ch == '\t') {
            return Err(self.err("UNSUPPORTED_CELL_STRUCTURE"));
        }
        self.report.utf16_units = self
            .report
            .utf16_units
            .checked_add(ch.len_utf16())
            .filter(|n| *n <= self.budgets.utf16_units)
            .ok_or_else(|| self.err("TEXT_BUDGET"))?;
        self.output_bytes = self
            .output_bytes
            .checked_add(ch.len_utf8())
            .filter(|n| *n <= self.limits.output_bytes)
            .ok_or_else(|| self.err("OUTPUT_BUDGET"))?;
        if self.runs.last().is_none_or(|r| r.marks != self.state.marks) {
            self.node(1)?;
            self.runs.push(FragmentRun {
                opaque_marks: vec![],
                text: String::new(),
                marks: self.state.marks.clone(),
            });
        }
        self.runs.last_mut().unwrap().text.push(ch);
        Ok(())
    }
    fn unicode(&mut self, n: i32) -> Result<()> {
        if !(-32768..=32767).contains(&n) {
            return Err(self.err("UNICODE_RANGE"));
        }
        let unit = n as i16 as u16;
        if (0xd800..=0xdbff).contains(&unit) {
            if self.surrogate.is_some() {
                return Err(self.err("UNICODE_SURROGATE"));
            }
            self.surrogate = Some((unit, self.state.marks.clone()));
        } else if (0xdc00..=0xdfff).contains(&unit) {
            let (hi, marks) = self
                .surrogate
                .take()
                .ok_or_else(|| self.err("UNICODE_SURROGATE"))?;
            if marks != self.state.marks {
                return Err(self.err("UNICODE_MARK_BOUNDARY"));
            }
            self.scalar(
                char::from_u32(0x10000 + ((hi as u32 - 0xd800) << 10) + (unit as u32 - 0xdc00))
                    .unwrap(),
            )?;
        } else {
            self.scalar(char::from_u32(unit as u32).ok_or_else(|| self.err("UNICODE_RANGE"))?)?;
        }
        self.fallback = self.state.uc;
        Ok(())
    }
    fn byte(&mut self, b: u8) -> Result<()> {
        if self.state.skip {
            return Ok(());
        }
        if self.fallback > 0 {
            self.fallback -= 1;
            return Ok(());
        }
        let ch = cp1252(b).ok_or_else(|| self.err("CODEPAGE_BYTE"))?;
        self.scalar(ch)
    }
    fn paragraph(&mut self) -> Result<()> {
        if self.surrogate.is_some() {
            return Err(self.err("UNICODE_SURROGATE"));
        }
        if self.cells.is_some() {
            return Err(self.err("UNSUPPORTED_CELL_PARAGRAPHS"));
        }
        self.flush_table()?;
        self.node(1)?;
        self.blocks.push(FragmentBlock {
            runs: std::mem::take(&mut self.runs),
            attributes: None,
            containers: vec![],
            checked: None,
        });
        Ok(())
    }
    fn flush_table(&mut self) -> Result<()> {
        if self.rows.is_empty() {
            return Ok(());
        }
        if !self.runs.is_empty() {
            return Err(self.err("TABLE_BOUNDARY"));
        }
        let rows = std::mem::take(&mut self.rows);
        let width = rows[0].len();
        let source = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|cell| cell.iter().map(|r| r.text.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\t")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let tuple = Content::Table {
            alignments: vec![Alignment::None; width],
            rows,
            source: source.clone(),
        }
        .tuple()
        .map_err(|_| self.err("SHARED_TABLE_DESCRIPTOR"))?;
        self.node(2)?;
        self.blocks.push(FragmentBlock {
            runs: vec![FragmentRun {
                opaque_marks: vec![],
                text: source,
                marks: vec![],
            }],
            attributes: Some(BlockAttributes::Unknown(tuple)),
            containers: vec![],
            checked: None,
        });
        Ok(())
    }
    fn required(&self, n: Option<i32>) -> Result<i32> {
        n.ok_or_else(|| self.err("MISSING_PARAMETER"))
    }
    fn word(&mut self, w: &str, n: Option<i32>, at: usize) -> Result<()> {
        if w == "bin" {
            let len = self.required(n)?;
            if len < 0 {
                return Err(self.err("BINARY_LENGTH"));
            }
            let len = len as usize;
            if len > self.input.len() - self.pos {
                return Err(self.err("BINARY_LENGTH"));
            }
            if len
                > self
                    .budgets
                    .binary_bytes
                    .saturating_sub(self.report.binary_bytes)
            {
                return Err(self.err("BINARY_BUDGET"));
            }
            self.pos += len;
            self.report.binary_bytes += len;
            if self.fallback > 0 && !self.state.skip {
                self.fallback -= 1;
            } else {
                self.diag("UNSUPPORTED_BINARY", w, at)?;
            }
            return Ok(());
        }
        if self.state.skip {
            return Ok(());
        }
        if self.fallback > 0 {
            self.fallback -= 1;
            return Ok(());
        }
        let first = self.state.start;
        self.state.start = false;
        if self.state.star {
            self.state.star = false;
            self.diag("UNSUPPORTED_DESTINATION", w, at)?;
            self.state.skip = true;
            return Ok(());
        }
        match w {
            "rtf" => {
                if at != 1 || n != Some(1) {
                    return Err(self.err("RTF_VERSION"));
                }
            }
            "ansi" => {
                if n.is_some() {
                    return Err(self.err("PARAMETER"));
                }
            }
            "ansicpg" => {
                if n != Some(1252) {
                    return Err(self.err("UNSUPPORTED_CODEPAGE"));
                }
            }
            "mac" | "pc" | "pca" | "utf8" | "cpg" | "fcharset" | "f" | "fonttbl" | "deff" => {
                return Err(self.err("UNSUPPORTED_FONT_OR_CODEPAGE"));
            }
            "uc" => {
                let n = self.required(n)?;
                if !(0..=16).contains(&n) {
                    return Err(self.err("UNICODE_FALLBACK_COUNT"));
                }
                self.state.uc = n as usize;
            }
            "u" => {
                let n = self.required(n)?;
                self.unicode(n)?;
            }
            "b" | "i" | "ul" | "strike" => {
                let m = match w {
                    "b" => Mark::Bold,
                    "i" => Mark::Italic,
                    "ul" => Mark::Underline,
                    _ => Mark::Strike,
                };
                self.state.marks.retain(|(v, _)| *v != m);
                if n != Some(0) {
                    self.state.marks.push((m, None));
                    self.state.marks.sort_by_key(|(v, _)| match v {
                        Mark::Bold => 0,
                        Mark::Italic => 1,
                        Mark::Strike => 2,
                        Mark::Underline => 3,
                        _ => 4,
                    });
                }
            }
            "ulnone" => self.state.marks.retain(|(v, _)| *v != Mark::Underline),
            "plain" => self.state.marks.clear(),
            "pard" => self.state.intbl = false,
            "par" => self.paragraph()?,
            "line" => self.scalar('\n')?,
            "tab" => self.scalar('\t')?,
            "emdash" => self.scalar('—')?,
            "endash" => self.scalar('–')?,
            "bullet" => self.scalar('•')?,
            "lquote" => self.scalar('‘')?,
            "rquote" => self.scalar('’')?,
            "ldblquote" => self.scalar('“')?,
            "rdblquote" => self.scalar('”')?,
            "trowd" => {
                if self.cells.is_some() {
                    return Err(self.err("UNSUPPORTED_NESTED_TABLE"));
                }
                if !self.runs.is_empty() {
                    self.paragraph()?;
                }
                self.cells = Some(vec![]);
                self.edges.clear();
            }
            "cellx" => {
                let n = self.required(n)?;
                if self.cells.is_none()
                    || !self.runs.is_empty()
                    || n <= 0
                    || self.edges.last().is_some_and(|last| *last >= n)
                {
                    return Err(self.err("TABLE_BOUNDARY"));
                }
                if self.edges.len() >= self.budgets.columns {
                    return Err(self.err("COLUMN_BUDGET"));
                }
                self.edges.push(n);
            }
            "intbl" => {
                if n.is_some_and(|n| n != 0 && n != 1) {
                    return Err(self.err("PARAMETER"));
                }
                self.state.intbl = n != Some(0);
            }
            "cell" => {
                if self.surrogate.is_some() || !self.state.intbl || self.cells.is_none() {
                    return Err(self.err("TABLE_CELL"));
                }
                if self.cells.as_ref().unwrap().len() >= self.edges.len() {
                    return Err(self.err("TABLE_CELL_COUNT"));
                }
                self.node(1)?;
                self.cells
                    .as_mut()
                    .unwrap()
                    .push(std::mem::take(&mut self.runs));
            }
            "row" => {
                let cells = self.cells.take().ok_or_else(|| self.err("TABLE_ROW"))?;
                if self.edges.is_empty()
                    || cells.len() != self.edges.len()
                    || !self.runs.is_empty()
                    || self.rows.first().is_some_and(|r| r.len() != cells.len())
                {
                    return Err(self.err("TABLE_RECTANGLE"));
                }
                if self.rows.len() >= self.budgets.rows {
                    return Err(self.err("ROW_BUDGET"));
                }
                self.node(1)?;
                self.rows.push(cells);
            }
            "nestrow" | "nestcell" | "itap" | "clmgf" | "clmrg" | "clvmgf" | "clvmrg" => {
                return Err(self.err("UNSUPPORTED_TABLE_STRUCTURE"));
            }
            "object" | "objdata" | "pict" | "field" | "fldinst" | "fldrslt" | "colortbl"
            | "stylesheet" | "info" | "header" | "footer" | "footnote" | "annotation"
            | "filetbl" | "datastore" | "xmlopen" | "shp" | "upr" | "ud" => {
                self.diag("UNSUPPORTED_DESTINATION", w, at)?;
                self.state.skip = true;
            }
            _ if first => {
                self.diag("UNSUPPORTED_DESTINATION", w, at)?;
                self.state.skip = true;
            }
            _ => self.diag("UNSUPPORTED_CONTROL", w, at)?,
        }
        Ok(())
    }
    fn parse(&mut self) -> Result<()> {
        if !self.input.starts_with(b"{\\rtf1") || self.input.get(6).is_some_and(u8::is_ascii_digit)
        {
            return Err(self.err("RTF_SIGNATURE"));
        }
        while self.pos < self.input.len() {
            (self.check)().map_err(|e| self.err(job_code(&e)))?;
            if self.report.tokens >= self.budgets.tokens {
                return Err(self.err("WORK_BUDGET"));
            }
            self.report.tokens += 1;
            let at = self.pos;
            let b = self.input[self.pos];
            self.pos += 1;
            if self.state.star && b != b'\\' && b != b'\r' && b != b'\n' {
                return Err(self.err("DESTINATION_CONTROL_REQUIRED"));
            }
            if self.stack.is_empty() && at > 0 {
                if !b.is_ascii_whitespace() {
                    return Err(self.err("TRAILING_DATA"));
                }
                self.report.scanned_bytes = self.pos;
                continue;
            }
            match b {
                b'{' => {
                    self.fallback = 0;
                    if self.stack.len() >= self.budgets.depth {
                        return Err(self.err("DEPTH_BUDGET"));
                    }
                    self.stack.push(self.state.clone());
                    self.state.start = true;
                    self.state.star = false;
                    self.report.max_depth = self.report.max_depth.max(self.stack.len());
                }
                b'}' => {
                    self.fallback = 0;
                    self.state = self.stack.pop().ok_or_else(|| self.err("GROUP_BALANCE"))?;
                }
                b'\r' | b'\n' => {}
                b'\\' => {
                    let next = *self
                        .input
                        .get(self.pos)
                        .ok_or_else(|| self.err("TRUNCATED_CONTROL"))?;
                    self.pos += 1;
                    if self.state.star && !next.is_ascii_alphabetic() {
                        return Err(self.err("DESTINATION_CONTROL_REQUIRED"));
                    }
                    match next {
                        b'\\' | b'{' | b'}' => {
                            self.state.start = false;
                            self.byte(next)?;
                        }
                        b'\'' => {
                            let h = self
                                .input
                                .get(self.pos..self.pos + 2)
                                .ok_or_else(|| self.err("HEX_ESCAPE"))?;
                            let h = std::str::from_utf8(h).map_err(|_| self.err("HEX_ESCAPE"))?;
                            let v =
                                u8::from_str_radix(h, 16).map_err(|_| self.err("HEX_ESCAPE"))?;
                            self.pos += 2;
                            self.state.start = false;
                            self.byte(v)?;
                        }
                        b'*' if self.state.start => {
                            self.state.star = true;
                        }
                        c if c.is_ascii_alphabetic() => {
                            let start = self.pos - 1;
                            while self
                                .input
                                .get(self.pos)
                                .is_some_and(u8::is_ascii_alphabetic)
                            {
                                self.pos += 1;
                                if self.pos - start > 32 {
                                    return Err(self.err("CONTROL_LENGTH"));
                                }
                            }
                            let w = std::str::from_utf8(&self.input[start..self.pos]).unwrap();
                            let ns = self.pos;
                            if self.input.get(self.pos) == Some(&b'-') {
                                self.pos += 1;
                            }
                            while self.input.get(self.pos).is_some_and(u8::is_ascii_digit) {
                                self.pos += 1;
                                if self.pos - ns > 11 {
                                    return Err(self.err("PARAMETER_RANGE"));
                                }
                            }
                            let n = if ns == self.pos {
                                None
                            } else {
                                Some(
                                    std::str::from_utf8(&self.input[ns..self.pos])
                                        .unwrap()
                                        .parse::<i32>()
                                        .map_err(|_| self.err("PARAMETER_RANGE"))?,
                                )
                            };
                            if self.input.get(self.pos) == Some(&b' ') {
                                self.pos += 1;
                            }
                            self.word(w, n, at)?;
                        }
                        b'~' | b'_' | b'-' => {
                            self.state.start = false;
                            if self.state.skip {
                            } else if self.fallback > 0 {
                                self.fallback -= 1;
                            } else {
                                self.scalar(match next {
                                    b'~' => '\u{a0}',
                                    b'_' => '\u{2011}',
                                    _ => '\u{ad}',
                                })?;
                            }
                        }
                        _ => {
                            if !self.state.skip {
                                if self.fallback > 0 {
                                    self.fallback -= 1;
                                } else {
                                    self.diag(
                                        "UNSUPPORTED_SYMBOL",
                                        &(next as char).to_string(),
                                        at,
                                    )?;
                                }
                            }
                        }
                    }
                }
                b if b < 0x20 => return Err(self.err("CONTROL_BYTE")),
                b => {
                    self.state.start = false;
                    self.byte(b)?;
                }
            }
            self.report.scanned_bytes = self.pos;
        }
        if !self.stack.is_empty() {
            return Err(self.err("GROUP_BALANCE"));
        }
        if self.surrogate.is_some() {
            return Err(self.err("UNICODE_SURROGATE"));
        }
        if self.cells.is_some() {
            return Err(self.err("TABLE_INCOMPLETE"));
        }
        if !self.runs.is_empty() {
            self.paragraph()?;
        }
        self.flush_table()?;
        if self.blocks.is_empty() {
            self.node(1)?;
            self.blocks.push(FragmentBlock {
                runs: vec![],
                attributes: None,
                containers: vec![],
                checked: None,
            });
        }
        Ok(())
    }
}
fn cp1252(b: u8) -> Option<char> {
    const SPECIAL: [u32; 32] = [
        0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039,
        0x152, 0, 0x17d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc,
        0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178,
    ];
    if (0x80..=0x9f).contains(&b) {
        let v = SPECIAL[(b - 0x80) as usize];
        if v == 0 { None } else { char::from_u32(v) }
    } else {
        char::from_u32(b as u32)
    }
}
/// Preparation never mutates the live document. Failures abort only this job;
/// callers retain original bytes through JobSource and their retention policy.
pub fn prepare<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    budgets: Budgets,
    mut now: impl FnMut() -> u64,
) -> Result<Prepared> {
    let result = (|| {
        let hard = Budgets::default();
        if budgets.depth > hard.depth
            || budgets.tokens > hard.tokens
            || budgets.binary_bytes > hard.binary_bytes
            || budgets.diagnostics > hard.diagnostics
            || budgets.utf16_units > hard.utf16_units
            || budgets.rows > hard.rows
            || budgets.columns > hard.columns
        {
            return Err(Failure {
                code: "INVALID_BUDGET",
                offset: 0,
                report: Report::default(),
            });
        }

        if job.contract().profile != PROFILE || job.contract().direction != Direction::Import {
            return Err(Failure {
                code: "RTF_PROFILE",
                offset: 0,
                report: Report::default(),
            });
        }
        let mut parser = Parser {
            input: job.source().original(),
            pos: 0,
            limits: job.contract().limits,
            budgets,
            report: Report::default(),
            state: State::default(),
            stack: vec![],
            runs: vec![],
            blocks: vec![],
            rows: vec![],
            cells: None,
            edges: vec![],
            fallback: 0,
            surrogate: None,
            output_bytes: 0,
            check: || job.check(now()),
        };
        parser.parse()?;
        // Full representation (including duplicated table fallback and attributes)
        // is bounded without allocating a second serialization.
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
                max: parser.limits.output_bytes
            },
            "{:?}",
            parser.blocks
        )
        .map_err(|_| parser.err("OUTPUT_BUDGET"))?;
        let control = (parser.check)();
        control.map_err(|e| parser.err(job_code(&e)))?;
        Ok(Prepared {
            blocks: parser.blocks,
            report: parser.report,
            token: job.token.clone(),
            original_sha256: job.contract().input_sha256,
        })
    })();
    if result.is_err() {
        job.abort().map_err(|_| Failure {
            code: "JOB_CLEANUP",
            offset: 0,
            report: Report::default(),
        })?;
    }
    result
}
