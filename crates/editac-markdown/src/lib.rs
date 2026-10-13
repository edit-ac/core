//! Portable Markdown interchange. Parsing produces inert content; callers
//! validate and commit through the engine's prepared fragment boundary.
pub use editac_core::commands::editor::{FragmentBlock, FragmentRun};
pub mod export;
pub mod extensions;
pub mod import;
pub mod optional;
pub mod profile;
pub mod reconcile;
