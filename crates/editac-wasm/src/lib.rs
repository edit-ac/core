//! Reserved binding boundary between Rust semantics and the browser SDK.
//!
//! This crate intentionally exports no bindings. Binding generation, loading,
//! memory ownership, error transport, and WASM size/startup measurement belong
//! to the foundation milestones. DOM editing belongs in `@edit-ac/web`.
//!
//! The current semantic contract is limited to [`editac_core::Utf16Offset`].
