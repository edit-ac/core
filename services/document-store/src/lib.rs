//! Reference-host bootstrap. No network admission or document semantics live here.
pub mod backend;
pub mod contracts;

pub use backend::{BackendError, Capabilities, CommitState, Retryability, SqliteBackend};
