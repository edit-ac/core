//! Explicit selected-table source formatting; never a whole-file serializer.
//!
//! Padding counts Unicode scalars (including combining marks, tabs and ZWJ)
//! as one column each, not terminal cells or font-dependent visual widths. Cell
//! lexemes are retained exactly except outer ASCII spaces/tabs. Each original
//! LF/CRLF ending and absence of an EOF newline is retained. Nested containers,
//! excess cells, bare CR and ambiguous mappings reject rather than lose source.
use crate::reconcile::{Conflict, ConflictKind, PreparedSourceEdit, SourceCommit};
use editac_core::{
    document::{Document, InitializedCheckpoint},
    modules::content::Alignment,
};

/// A revision-pinned source edit, including the no-op case. Hosts still own
/// write authorization, as for ordinary source reconciliation.
pub struct PreparedTableFormat {
    edit: PreparedSourceEdit,
    checkpoint: InitializedCheckpoint,
}
impl PreparedTableFormat {
    pub(crate) fn new(edit: PreparedSourceEdit, checkpoint: InitializedCheckpoint) -> Self {
        Self { edit, checkpoint }
    }
    pub fn source(&self) -> &str {
        &self.edit.source
    }
    pub fn changed(&self) -> bool {
        self.edit.changed != 0
    }
    pub fn commit(self, document: &mut Document) -> Result<SourceCommit, Conflict> {
        let kind = if document.identity() != &self.checkpoint.identity {
            Some(ConflictKind::IdentityMismatch)
        } else if document.checkpoint().bytes != self.checkpoint.bytes {
            Some(ConflictKind::StalePlan)
        } else {
            None
        };
        if let Some(kind) = kind {
            return Err(Conflict {
                kind,
                target: None,
                detail: None,
                source: Some(self.edit.source),
            });
        }
        self.edit.commit(document)
    }
}

fn cells(line: &str) -> Vec<&str> {
    let line = line.trim_matches([' ', '\t']);
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < line.len() {
        match line.as_bytes()[i] {
            // GFM table tokenization treats a pipe immediately preceded by a
            // backslash as escaped, even after an even-length backslash run.
            // Ordinary Markdown escape parity would change the cell boundary.
            b'|' if i == 0 || line.as_bytes()[i - 1] != b'\\' => {
                parts.push(&line[start..i]);
                start = i + 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    parts.push(&line[start..]);
    if line.starts_with('|') {
        parts.remove(0);
    }
    // An escaped final pipe belongs to the cell, not the outer border.
    if parts.last() == Some(&"") && line.ends_with('|') {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|s| s.trim_matches([' ', '\t']))
        .collect()
}

pub(crate) fn format(
    source: &str,
    alignments: &[Alignment],
    rows: usize,
) -> Result<String, ConflictKind> {
    if source.len() > 1_048_576 || alignments.is_empty() {
        return Err(ConflictKind::ResourceLimit);
    }
    let mut lines = Vec::new();
    for raw in source.split_inclusive('\n') {
        let (body, ending) = if let Some(body) = raw.strip_suffix("\r\n") {
            (body, "\r\n")
        } else if let Some(body) = raw.strip_suffix('\n') {
            (body, "\n")
        } else {
            (raw, "")
        };
        if body.contains('\r') || body.starts_with(['>', '\t']) || body.starts_with("    ") {
            return Err(ConflictKind::UnsupportedContent);
        }
        let mut row = cells(body);
        if row.len() > alignments.len() {
            return Err(ConflictKind::UnsupportedContent);
        }
        row.resize(alignments.len(), "");
        lines.push((row, ending));
    }
    if lines.len() != rows + 1 {
        return Err(ConflictKind::AmbiguousMapping);
    }
    let mut widths: Vec<_> = alignments
        .iter()
        .map(|a| match a {
            Alignment::None => 3,
            Alignment::Center => 5,
            _ => 4,
        })
        .collect();
    for (index, (row, _)) in lines.iter().enumerate() {
        if index == 1 {
            continue;
        }
        for (width, value) in widths.iter_mut().zip(row) {
            *width = (*width).max(value.chars().count());
        }
    }
    let mut result = String::new();
    for (index, (row, ending)) in lines.into_iter().enumerate() {
        result.push('|');
        for (column, value) in row.into_iter().enumerate() {
            result.push(' ');
            if index == 1 {
                let (left, right) = match alignments[column] {
                    Alignment::None => (false, false),
                    Alignment::Left => (true, false),
                    Alignment::Center => (true, true),
                    Alignment::Right => (false, true),
                };
                if left {
                    result.push(':');
                }
                result.extend(std::iter::repeat_n(
                    '-',
                    widths[column] - usize::from(left) - usize::from(right),
                ));
                if right {
                    result.push(':');
                }
            } else {
                result.push_str(value);
                result.extend(std::iter::repeat_n(
                    ' ',
                    widths[column] - value.chars().count(),
                ));
            }
            result.push_str(" |");
            if result.len() > 1_048_576 {
                return Err(ConflictKind::ResourceLimit);
            }
        }
        result.push_str(ending);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_lexeme_corpus_agrees_with_real_gfm_codec() {
        use crate::{
            export::equivalent,
            optional::{Codecs, import_with_codecs},
        };
        let codecs = Codecs {
            tables: true,
            ..Codecs::default()
        };
        for cell in [
            r"a\|b",
            "``a ` b``",
            r"`x\| y`",
            "**bold** &amp;",
            r"a\\",
            "~~end~~",
            "[ok](https://example.com)",
        ] {
            let source = format!("|a|b|\n|---|---|\n|{cell}|x|\n");
            let formatted = format(&source, &[Alignment::None; 2], 2).unwrap();
            let a = import_with_codecs(&source, codecs).unwrap();
            let b = import_with_codecs(&formatted, codecs).unwrap();
            assert!(
                equivalent(&a.blocks, &b.blocks),
                "cell={cell:?}\nsource={source:?}\nformatted={formatted:?}\nold={:?}\nnew={:?}",
                a.blocks,
                b.blocks
            );
        }
    }
}
