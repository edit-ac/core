//! Platform-independent contract scaffolding for edit.ac.
//!
//! There is no document store, editor, command execution, persistence, or CRDT
//! implementation yet. The architectural gates must define those contracts
//! before adapters expose an editor API.

/// An offset measured in UTF-16 code units at a platform boundary.
///
/// This value alone does not identify a document, prove a valid text boundary,
/// or guarantee a grapheme boundary. It must not be retained as a stable anchor
/// across edits. The owning text operation will need to validate and convert it.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Utf16Offset(pub u32);
