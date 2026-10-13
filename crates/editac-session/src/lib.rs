//! Portable local-first companion to the semantic engine.
//! Locator/catalog resolution and prepared store/transport ports are available.
//! Optional native persistence is available; lifecycle and edit service are later gates.
pub mod locator;
pub mod ports;

#[cfg(feature = "native-store")]
pub mod store;
