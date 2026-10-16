//! Read-only, bounded owned ranges over the canonical projection and fragment codec.
use crate::{
    Utf16Offset,
    anchors::{Resolution, Selection},
    commands::editor::{EditorError, FragmentBlock},
    document::{BlockAttributes, Document},
};

pub fn range_blocks(
    document: &Document,
    selection: &Selection,
) -> Result<Vec<FragmentBlock>, EditorError> {
    let position = |anchor| match document.resolve_anchor(anchor) {
        Ok(Resolution::Position(p)) => Ok(p),
        _ => Err(EditorError::UnsupportedTarget),
    };
    let a = position(&selection.anchor)?;
    let b = position(&selection.focus)?;
    let snapshot = document
        .inspect()
        .map_err(|_| EditorError::InvalidCommand)?;
    let nodes: Vec<_> = snapshot
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .collect();
    let ai = nodes
        .iter()
        .position(|n| n.id == a.node)
        .ok_or(EditorError::UnsupportedTarget)?;
    let bi = nodes
        .iter()
        .position(|n| n.id == b.node)
        .ok_or(EditorError::UnsupportedTarget)?;
    let ((start, from), (end, to)) = if (ai, a.offset) <= (bi, b.offset) {
        ((ai, a.offset.0), (bi, b.offset.0))
    } else {
        ((bi, b.offset.0), (ai, a.offset.0))
    };
    if end - start >= 128 {
        return Err(EditorError::ResourceLimit);
    }
    let mut blocks = Vec::new();
    for (index, node) in nodes.iter().enumerate().take(end + 1).skip(start) {
        let mut block = document.fragment_for_node(&node.id)?;
        let length: u32 = block
            .runs
            .iter()
            .map(|r| r.text.encode_utf16().count() as u32)
            .sum();
        let left = if index == start { from } else { 0 };
        let right = if index == end { to } else { length };
        if left > right || right > length {
            return Err(EditorError::InvalidCommand);
        }
        // Atomic descriptors are indivisible: never export a misleading partial fallback.
        if matches!(
            block.attributes,
            Some(BlockAttributes::Unknown(_) | BlockAttributes::Separator)
        ) && (left != 0 || right != length)
        {
            return Err(EditorError::UnsupportedTarget);
        }
        let mut offset = 0;
        for run in &mut block.runs {
            let run_len = run.text.encode_utf16().count() as u32;
            let l = left.saturating_sub(offset).min(run_len);
            let r = right.saturating_sub(offset).min(run_len);
            let bytes = crate::anchors::validate_range(&run.text, Utf16Offset(l)..Utf16Offset(r))
                .map_err(|_| EditorError::InvalidCommand)?;
            run.text = run.text[bytes].to_string();
            offset += run_len;
        }
        block.runs.retain(|r| !r.text.is_empty());
        blocks.push(block);
    }
    crate::commands::fragment::validate(&blocks).map_err(|_| EditorError::InvalidCommand)?;
    Ok(blocks)
}
