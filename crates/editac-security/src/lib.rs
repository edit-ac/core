//! Compile-only protocol selection boundary. No production encryption API.
//! Application admission, persistence, identity policy and review are pending.

/// No encryption profile is production qualified by this dependency probe.
pub const PRODUCTION_ENCRYPTION_QUALIFIED: bool = false;

#[cfg(feature = "protocol-probe")]
mod probe;
