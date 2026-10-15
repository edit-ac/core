//! Bounded table edits on admitted opaque tuples; no new table representation.
use super::editor::{EditorCommand, EditorError};
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
    if !matches!(
        Content::from_tuple(expected).map_err(error)?,
        Some(Content::Table { .. } | Content::RichTable { .. })
    ) {
        return Err(EditorError::UnsupportedTarget);
    }
    let mut envelope = array(expected)?.to_vec();
    let v2 = envelope[1] == Any::from(2u32);
    let data = data_mut(&mut envelope[2]);
    let mut rows: Vec<Vec<Any>> = array(&data["rows"])?
        .iter()
        .map(|r| array(r).map(<[Any]>::to_vec))
        .collect::<Result<_, _>>()?;
    let mut alignments = array(&data["alignments"])?.to_vec();
    match command {
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
            if v2
                && rows.iter().flatten().any(|c| {
                    map(c).map_or(true, |m| {
                        m["rowSpan"] != Any::from(1u32) || m["columnSpan"] != Any::from(1u32)
                    })
                })
            {
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
    let tuple = values(envelope);
    Content::from_tuple(&tuple)
        .map_err(error)?
        .ok_or(EditorError::InvalidCommand)?;
    Ok((tuple, fallback))
}
