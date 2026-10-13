//! Portable local-first companion to the semantic engine.
//!
//! Strict locator/catalog resolution and the compatibility harness are available.
//! Storage, transport, authorization enforcement and edit-service lifecycle remain
//! subsequent gates; resolving a locator never fetches or initializes a document.

pub mod locator;
