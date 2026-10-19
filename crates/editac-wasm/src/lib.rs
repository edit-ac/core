//! Semantic engine handles and the preserved foundation fixture bridge.
mod assets;
mod bridge;
#[cfg(test)]
mod cases;
mod comparison;
mod engine;
#[cfg(feature = "fitness-trace")]
mod fitness;
#[cfg(test)]
mod updates;

#[cfg(any(test, feature = "foundation-fixture"))]
mod fixture;
#[cfg(any(test, feature = "foundation-fixture"))]
pub use fixture::{Fixture, created_document_count};
