//! Reuse upstream value types; these names do not imply implemented host ports.
pub use editac_core::document::DocumentIdentity;
pub use editac_core::modules::assets::{
    AssetCommitReceipt, AssetGrant, AssetIdentity, AssetRequest,
};
pub use editac_session::ports::{DurableReceipt, JournalEntry, PortError, UpdateId};

/// Frozen spec vocabulary. Implementations are added by their owning CLD gates.
pub const PORT_NAMES: [&str; 7] = [
    "IdentityVerifier",
    "AuthorizationPolicy",
    "CatalogStore",
    "UpdateStore",
    "BlobStore",
    "CommitCoordinator",
    "Relay",
];
