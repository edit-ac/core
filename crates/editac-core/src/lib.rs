//! Platform-independent contract scaffolding for edit.ac.
//!
//! The protocol factory creates a single UTF-16 Yrs replica. There is no editor,
//! schema, command execution or persistence implementation yet.

/// Create a fresh, independently editing replica for the candidate Yjs 13 profile.
///
/// Yrs generates a new client identity; callers must not restore a persisted
/// writer identity into multiple live replicas. Root types and document/epoch
/// metadata remain subject to the foundation schema gate.
pub fn new_document() -> yrs::Doc {
    yrs::Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..yrs::Options::default()
    })
}

/// An offset measured in UTF-16 code units at a platform boundary.
///
/// This value alone does not identify a document, prove a valid text boundary,
/// or guarantee a grapheme boundary. It must not be retained as a stable anchor
/// across edits. The owning text operation will need to validate and convert it.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Utf16Offset(pub u32);
