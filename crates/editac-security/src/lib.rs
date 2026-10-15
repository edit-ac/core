//! Optional protocol qualification boundary. No production encryption API.
//! Prepared admission mechanics live in `envelope.rs`, included only by the
//! qualification harness. Host identity, durable persistence and review remain
//! pending; default builds expose no cryptographic implementation.

/// No encryption profile is production qualified by this dependency probe.
pub const PRODUCTION_ENCRYPTION_QUALIFIED: bool = false;

#[cfg(feature = "protocol-probe")]
mod probe;
