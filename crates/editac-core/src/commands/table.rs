//! Bounded table edits on admitted opaque tuples; no new table representation.
use super::editor::{EditorCommand, EditorError, FragmentBlock};
use crate::modules::content::{Content, ContentError};
use std::{collections::HashMap, sync::Arc};
use yrs::Any;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableAction {
    InsertRow,
    DeleteRow,
    InsertColumn,
    DeleteColumn,
}

/// A cell selection, distinct from a text selection inside a native cell control.
/// Indices are captured against the exact expected table descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellRectangle {
    pub row: usize,
    pub column: usize,
    pub rows: usize,
    pub columns: usize,
}

pub enum RectangleEdit<'a> {
    /// Delete/Backspace on cells clears content without removing geometry.
    Clear,
    /// Literal cells with explicit row/column boundaries; no implicit expansion.
    Paste(&'a [Vec<String>]),
    /// Internal/foreign decoded cells. The simple-cell profile admits only
    /// unmarked paragraph text; nested content and lossy flattening reject.
    PasteFragment(&'a [Vec<FragmentBlock>]),
}

fn simple_cells(rows: &[Vec<Any>]) -> bool {
    rows.iter().flatten().all(|c| {
        map(c).is_ok_and(|m| m["rowSpan"] == Any::from(1u32) && m["columnSpan"] == Any::from(1u32))
    })
}

/// Pure bounded preparation for the existing command route. Submit the returned
/// commands together to `Document::prepare_editor`, then commit once. Every step
/// carries its exact staged descriptor; callers must not commit steps separately.
/// Host-owned protected coordinates must be captured with the expected descriptor;
/// the owning EditService still enforces whole-document permissions at commit.
/// At most 128 cells and 1 MiB of replacement text are admitted per action.
pub fn rectangle_commands(
    target: &str,
    expected: &Any,
    rectangle: CellRectangle,
    edit: RectangleEdit<'_>,
    protected: &[(usize, usize)],
) -> Result<Vec<EditorCommand>, EditorError> {
    let CellRectangle {
        row,
        column,
        rows,
        columns,
    } = rectangle;
    let count = rows
        .checked_mul(columns)
        .ok_or(EditorError::ResourceLimit)?;
    if rows == 0 || columns == 0 {
        return Err(EditorError::InvalidCommand);
    }
    if count > 128 || protected.len() > 4096 {
        return Err(EditorError::ResourceLimit);
    }
    let literal;
    let edit = match edit {
        RectangleEdit::PasteFragment(cells) => {
            if cells.len() != rows || cells.iter().any(|r| r.len() != columns) {
                return Err(EditorError::InvalidCommand);
            }
            let mut bytes = 0usize;
            let mut runs = 0usize;
            for block in cells.iter().flatten() {
                if block.containers.len() > 16 {
                    return Err(EditorError::ResourceLimit);
                }
                if !block.containers.is_empty()
                    || block.checked.is_some()
                    || !matches!(
                        block.attributes,
                        None | Some(crate::document::BlockAttributes::Paragraph)
                    )
                {
                    return Err(EditorError::UnsupportedTarget);
                }
                for run in &block.runs {
                    runs += 1;
                    bytes = bytes
                        .checked_add(run.text.len())
                        .ok_or(EditorError::ResourceLimit)?;
                    if runs > 1024 || bytes > 1_048_576 {
                        return Err(EditorError::ResourceLimit);
                    }
                    if !run.marks.is_empty() {
                        return Err(EditorError::UnsupportedTarget);
                    }
                }
            }
            literal = cells
                .iter()
                .map(|r| {
                    r.iter()
                        .map(|b| b.runs.iter().map(|r| r.text.as_str()).collect())
                        .collect()
                })
                .collect::<Vec<Vec<String>>>();
            RectangleEdit::Paste(&literal)
        }
        other => other,
    };
    if !matches!(
        Content::from_tuple(expected).map_err(error)?,
        Some(Content::Table { .. } | Content::RichTable { .. })
    ) {
        return Err(EditorError::UnsupportedTarget);
    }
    let envelope = array(expected)?;
    let data = map(&envelope[2])?;
    let table_rows: Vec<Vec<Any>> = array(&data["rows"])?
        .iter()
        .map(|r| array(r).map(<[Any]>::to_vec))
        .collect::<Result<_, _>>()?;
    let end_row = row.checked_add(rows).ok_or(EditorError::ResourceLimit)?;
    let end_column = column
        .checked_add(columns)
        .ok_or(EditorError::ResourceLimit)?;
    if end_row > table_rows.len() || end_column > array(&data["alignments"])?.len() {
        return Err(EditorError::InvalidCommand);
    }
    if (envelope[1] == Any::from(2u32) && !simple_cells(&table_rows))
        || protected
            .iter()
            .any(|&(r, c)| (row..end_row).contains(&r) && (column..end_column).contains(&c))
    {
        return Err(EditorError::UnsupportedTarget);
    }
    if let RectangleEdit::Paste(cells) = &edit {
        if cells.len() != rows || cells.iter().any(|r| r.len() != columns) {
            return Err(EditorError::InvalidCommand);
        }
        let mut bytes = 0usize;
        for text in cells.iter().flatten() {
            bytes = bytes
                .checked_add(text.len())
                .ok_or(EditorError::ResourceLimit)?;
            if bytes > 1_048_576 {
                return Err(EditorError::ResourceLimit);
            }
            if text.contains(['\n', '\r']) {
                return Err(EditorError::InvalidCommand);
            }
        }
    }
    let mut staged = expected.clone();
    let mut commands = Vec::with_capacity(count);
    for r in 0..rows {
        for c in 0..columns {
            let command = EditorCommand::TableCell {
                target: target.into(),
                expected: staged.clone(),
                row: row + r,
                column: column + c,
                text: match &edit {
                    RectangleEdit::Clear => String::new(),
                    RectangleEdit::Paste(cells) => cells[r][c].clone(),
                    RectangleEdit::PasteFragment(_) => unreachable!(),
                },
            };
            staged = plan(&staged, &command)?.0;
            commands.push(command);
        }
    }
    Ok(commands)
}
fn error(e: ContentError) -> EditorError {
    if e == ContentError::ResourceLimit {
        EditorError::ResourceLimit
    } else {
        EditorError::InvalidCommand
    }
}
fn array(v: &Any) -> Result<&[Any], EditorError> {
    if let Any::Array(v) = v {
        Ok(v)
    } else {
        Err(EditorError::InvalidCommand)
    }
}
fn map(v: &Any) -> Result<&HashMap<String, Any>, EditorError> {
    if let Any::Map(v) = v {
        Ok(v)
    } else {
        Err(EditorError::InvalidCommand)
    }
}
fn data_mut(v: &mut Any) -> &mut HashMap<String, Any> {
    let Any::Map(v) = v else { unreachable!() };
    Arc::make_mut(v)
}
fn values(v: Vec<Any>) -> Any {
    Any::Array(v.into())
}
fn empty_cell(v2: bool) -> Any {
    let runs = values(vec![values(vec![Any::from(""), values(vec![])])]);
    if !v2 {
        return runs;
    }
    Any::Map(Arc::new(HashMap::from([
        (
            "paragraphs".into(),
            values(vec![Any::Map(Arc::new(HashMap::from([
                ("style".into(), values(vec![Any::from("paragraph")])),
                ("runs".into(), runs),
            ])))]),
        ),
        ("rowSpan".into(), Any::from(1u32)),
        ("columnSpan".into(), Any::from(1u32)),
        ("header".into(), Any::Bool(false)),
    ])))
}
fn edit_runs(runs: &Any, text: &str) -> Result<Any, EditorError> {
    // Reuse the owning v1 decoder, mark/link validation and scalar-safe edit policy.
    let tuple = values(vec![
        Any::from("module:editac.table"),
        Any::from(1u32),
        Any::Map(Arc::new(HashMap::from([
            ("alignments".into(), values(vec![Any::from("none")])),
            ("rows".into(), values(vec![values(vec![runs.clone()])])),
            ("source".into(), Any::from("")),
        ]))),
    ]);
    let Some(Content::Table {
        alignments,
        mut rows,
        source,
    }) = Content::from_tuple(&tuple).map_err(error)?
    else {
        unreachable!()
    };
    crate::modules::content::edit_cell(&mut rows[0][0], text);
    let tuple = Content::Table {
        alignments,
        rows,
        source,
    }
    .tuple()
    .map_err(error)?;
    Ok(array(&array(&map(&array(&tuple)?[2])?["rows"])?[0])?[0].clone())
}
/// Returns the validated descriptor and text projection for one staged atom edit.
pub(super) fn plan(expected: &Any, command: &EditorCommand) -> Result<(Any, String), EditorError> {
    if let EditorCommand::TableSource { source, .. } = command {
        let Some(Content::Table {
            alignments, rows, ..
        }) = Content::from_tuple(expected).map_err(error)?
        else {
            return Err(EditorError::UnsupportedTarget);
        };
        let content = Content::Table {
            alignments,
            rows,
            source: source.clone(),
        };
        return Ok((content.tuple().map_err(error)?, String::new()));
    }
    if let EditorCommand::TableRectangle {
        target,
        rectangle,
        cells,
        protected,
        ..
    } = command
    {
        let edit = cells
            .as_deref()
            .map_or(RectangleEdit::Clear, RectangleEdit::Paste);
        let commands = rectangle_commands(target, expected, *rectangle, edit, protected)?;
        let mut result = (expected.clone(), String::new());
        for command in commands {
            result = plan(&result.0, &command)?;
        }
        return Ok(result);
    }
    if !matches!(
        Content::from_tuple(expected).map_err(error)?,
        Some(Content::Table { .. } | Content::RichTable { .. })
    ) {
        return Err(EditorError::UnsupportedTarget);
    }
    let mut envelope = array(expected)?.to_vec();
    let mut v2 = envelope[1] == Any::from(2u32);
    let data = data_mut(&mut envelope[2]);
    let mut rows: Vec<Vec<Any>> = array(&data["rows"])?
        .iter()
        .map(|r| array(r).map(<[Any]>::to_vec))
        .collect::<Result<_, _>>()?;
    let mut alignments = array(&data["alignments"])?.to_vec();
    match command {
        EditorCommand::TableAttributes {
            rectangle,
            alignment,
            header,
            protected,
            ..
        } => {
            let CellRectangle {
                row,
                column,
                rows: height,
                columns: width,
            } = *rectangle;
            let count = height
                .checked_mul(width)
                .ok_or(EditorError::ResourceLimit)?;
            let end_row = row.checked_add(height).ok_or(EditorError::ResourceLimit)?;
            let end_column = column
                .checked_add(width)
                .ok_or(EditorError::ResourceLimit)?;
            if count > 128 || protected.len() > 4096 {
                return Err(EditorError::ResourceLimit);
            }
            if height == 0
                || width == 0
                || end_row > rows.len()
                || end_column > alignments.len()
                || (alignment.is_none() && header.is_none())
            {
                return Err(EditorError::InvalidCommand);
            }
            if (v2 && !simple_cells(&rows))
                || protected.iter().any(|&(r, c)| {
                    (column..end_column).contains(&c)
                        && ((header.is_some() && (row..end_row).contains(&r))
                            || (alignment.is_some() && r < rows.len()))
                })
            {
                return Err(EditorError::UnsupportedTarget);
            }
            // v1 headers are implicit. Promote only when the requested flags cannot
            // be represented there; retain every existing run, source and coordinate.
            if !v2 && header.is_some_and(|h| (row..end_row).any(|r| h != (r == 0))) {
                for (r, cells) in rows.iter_mut().enumerate() {
                    for cell in cells {
                        let mut promoted = empty_cell(true);
                        let data = data_mut(&mut promoted);
                        data.insert("header".into(), Any::Bool(r == 0));
                        data.insert(
                            "paragraphs".into(),
                            values(vec![Any::Map(Arc::new(HashMap::from([
                                ("style".into(), values(vec![Any::from("paragraph")])),
                                ("runs".into(), cell.clone()),
                            ])))]),
                        );
                        *cell = promoted;
                    }
                }
                v2 = true;
            }
            if let Some(h) = header.filter(|_| v2) {
                for cells in &mut rows[row..end_row] {
                    for cell in &mut cells[column..end_column] {
                        data_mut(cell).insert("header".into(), Any::Bool(h));
                    }
                }
            }
            if let Some(alignment) = alignment {
                let value = match alignment {
                    crate::modules::content::Alignment::None => "none",
                    crate::modules::content::Alignment::Left => "left",
                    crate::modules::content::Alignment::Center => "center",
                    crate::modules::content::Alignment::Right => "right",
                };
                alignments[column..end_column].fill(Any::from(value));
            }
        }
        EditorCommand::TableCell {
            row, column, text, ..
        } => {
            if text.len() > 1_048_576 {
                return Err(EditorError::ResourceLimit);
            }
            if text.contains(['\n', '\r']) {
                return Err(EditorError::InvalidCommand);
            }
            let cell = rows
                .get_mut(*row)
                .and_then(|r| r.get_mut(*column))
                .ok_or(EditorError::InvalidCommand)?;
            if v2 {
                if *cell == Any::Null {
                    return Err(EditorError::UnsupportedTarget);
                }
                let blocks = array(&map(cell)?["paragraphs"])?;
                if blocks.len() != 1 {
                    return Err(EditorError::UnsupportedTarget);
                }
                let mut block = blocks[0].clone();
                let runs = edit_runs(&map(&block)?["runs"], text)?;
                data_mut(&mut block).insert("runs".into(), runs);
                data_mut(cell).insert("paragraphs".into(), values(vec![block]));
            } else {
                *cell = edit_runs(cell, text)?;
            }
        }
        EditorCommand::TableStructure { action, index, .. } => {
            // Editing a span boundary requires a separately qualified geometry policy.
            if v2 && !simple_cells(&rows) {
                return Err(EditorError::UnsupportedTarget);
            }
            match action {
                TableAction::InsertRow => {
                    if *index > rows.len() {
                        return Err(EditorError::InvalidCommand);
                    }
                    if rows.len() == 128 {
                        return Err(EditorError::ResourceLimit);
                    }
                    rows.insert(*index, vec![empty_cell(v2); alignments.len()]);
                }
                TableAction::DeleteRow => {
                    if *index >= rows.len() || rows.len() == 1 {
                        return Err(EditorError::InvalidCommand);
                    }
                    rows.remove(*index);
                }
                TableAction::InsertColumn => {
                    if *index > alignments.len() {
                        return Err(EditorError::InvalidCommand);
                    }
                    if alignments.len() == 32 {
                        return Err(EditorError::ResourceLimit);
                    }
                    alignments.insert(*index, Any::from("none"));
                    for row in &mut rows {
                        row.insert(*index, empty_cell(v2));
                    }
                }
                TableAction::DeleteColumn => {
                    if *index >= alignments.len() || alignments.len() == 1 {
                        return Err(EditorError::InvalidCommand);
                    }
                    alignments.remove(*index);
                    for row in &mut rows {
                        row.remove(*index);
                    }
                }
            }
        }
        _ => return Err(EditorError::InvalidCommand),
    }
    let fallback = rows
        .iter()
        .map(|r| {
            r.iter()
                .map(|c| {
                    let runs: Vec<&Any> = if v2 {
                        if *c == Any::Null {
                            return Ok(String::new());
                        }
                        array(&map(c)?["paragraphs"])?
                            .iter()
                            .map(|b| Ok(&map(b)?["runs"]))
                            .collect::<Result<_, EditorError>>()?
                    } else {
                        vec![c]
                    };
                    runs.into_iter()
                        .map(|r| {
                            array(r)?
                                .iter()
                                .map(|run| match &array(run)?[0] {
                                    Any::String(s) => Ok(s.to_string()),
                                    _ => Err(EditorError::InvalidCommand),
                                })
                                .collect::<Result<Vec<_>, _>>()
                                .map(|s| s.concat())
                        })
                        .collect::<Result<Vec<_>, _>>()
                        .map(|s| s.join("\n"))
                })
                .collect::<Result<Vec<_>, EditorError>>()
                .map(|s| s.join("\t"))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    data.insert(
        "rows".into(),
        values(rows.into_iter().map(values).collect()),
    );
    data.insert("alignments".into(), values(alignments));
    envelope[1] = Any::from(if v2 { 2u32 } else { 1u32 });
    let tuple = values(envelope);
    Content::from_tuple(&tuple)
        .map_err(error)?
        .ok_or(EditorError::InvalidCommand)?;
    Ok((tuple, fallback))
}
