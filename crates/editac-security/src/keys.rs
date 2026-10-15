//! Prepared host-key ports, absent from production builds. No cipher or keystore.
//!
//! Providers are trusted plaintext endpoints. They authenticate wrapping context,
//! check current key access on EVERY acquisition, and own platform unlock, backup,
//! retention and deletion. Host authentication alone never supplies a key.
//! Callbacks are trusted: they must not copy keys into logs/tools/locators or
//! retain decoded copies. Zeroization covers our owned buffer, not registers,
//! provider copies, paging, crash dumps, or memory retained by a hostile callback.

use std::fmt;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyPurpose {
    ProtocolState,
    LocalStore,
    History,
}

/// Public identity only. No locator, password, credential or bearer token.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeyContext {
    pub document: [u8; 16],
    pub document_epoch: u64,
    pub key_epoch: u64,
    pub purpose: KeyPurpose,
}

/// Fixed safe codes; arbitrary provider error strings never cross this port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyFailure {
    Locked,
    Unavailable,
    Revoked,
    RecoveryRequired,
    Incompatible,
    Context,
    Provider,
    Bounds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyState {
    Locked,
    /// Last acquisition succeeded, not a cached credential or freshness proof.
    Ready,
    Unavailable,
    Revoked,
    RecoveryRequired,
    Incompatible,
}

/// No Debug, Clone, serialization or public byte-export implementation.
/// This fixed 32-byte host wrapping/storage key is NOT an MLS epoch exporter or
/// a complete MLS state snapshot. The selected protocol retains its own secrets.
pub(crate) struct DecodedKey {
    context: KeyContext,
    bytes: Zeroizing<[u8; 32]>,
    #[cfg(test)]
    pub(crate) cleared: Option<std::rc::Rc<std::cell::Cell<usize>>>,
}

impl DecodedKey {
    /// Provider transfers ownership; it must clear any acquisition intermediates.
    pub(crate) fn from_host(context: KeyContext, bytes: Zeroizing<[u8; 32]>) -> Self {
        Self {
            context,
            bytes,
            #[cfg(test)]
            cleared: None,
        }
    }
}

impl Drop for DecodedKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
        // Test-only observation happens before deallocation, never reads freed
        // memory, and records only a count, never key material.
        #[cfg(test)]
        if let Some(observer) = &self.cleared {
            assert!(self.bytes.iter().all(|byte| *byte == 0));
            observer.set(observer.get() + 1);
        }
    }
}

/// Opaque authenticated host wrapping result. The host must authenticate the
/// context inside the wrapped representation; this outer label is not proof.
/// No Debug/Clone/serialization: persistence is an explicit host operation.
pub(crate) struct WrappedKey {
    context: KeyContext,
    bytes: Vec<u8>,
}

impl WrappedKey {
    pub(crate) const MAX_BYTES: usize = 4096;

    pub(crate) fn from_host(context: KeyContext, bytes: Vec<u8>) -> Result<Self, KeyFailure> {
        if bytes.is_empty() || bytes.len() > Self::MAX_BYTES {
            return Err(KeyFailure::Bounds);
        }
        Ok(Self { context, bytes })
    }

    /// Only the trusted host storage/wrapping adapter receives these bytes.
    pub(crate) fn host_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Prepared synchronous boundary. Unlock/recovery invoke explicit host UI/policy;
/// no passwords or recovery secrets are accepted by the session/tool interface.
/// An async host must cancel pending work at lock/revoke and recheck authority
/// before delivering the decoded key. These ports do not certify such a host.
pub(crate) trait HostKeyProvider {
    fn acquire(&mut self, context: KeyContext) -> Result<DecodedKey, KeyFailure>;
    fn unlock(&mut self, context: KeyContext) -> Result<(), KeyFailure>;
    fn recover(&mut self, context: KeyContext) -> Result<(), KeyFailure>;
    fn wrap(&mut self, context: KeyContext, key: &[u8; 32]) -> Result<WrappedKey, KeyFailure>;
    fn unwrap(
        &mut self,
        context: KeyContext,
        wrapped: &WrappedKey,
    ) -> Result<DecodedKey, KeyFailure>;
}

/// Contains no decoded key. Successful calls never establish a plaintext fallback.
pub(crate) struct KeySession {
    context: KeyContext,
    state: KeyState,
    locally_locked: bool,
}

impl fmt::Debug for KeySession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeySession")
            .field("state", &self.state)
            .finish()
    }
}

impl KeySession {
    pub(crate) fn new(context: KeyContext) -> Self {
        Self {
            context,
            state: KeyState::Locked,
            locally_locked: false,
        }
    }

    pub(crate) fn state(&self) -> KeyState {
        self.state
    }

    pub(crate) fn lock(&mut self) {
        self.locally_locked = true;
        self.state = KeyState::Locked;
    }

    fn record<T>(&mut self, result: Result<T, KeyFailure>) -> Result<T, KeyFailure> {
        if let Err(error) = result {
            self.state = match error {
                KeyFailure::Locked => KeyState::Locked,
                KeyFailure::Revoked => KeyState::Revoked,
                KeyFailure::RecoveryRequired => KeyState::RecoveryRequired,
                KeyFailure::Incompatible => KeyState::Incompatible,
                _ => KeyState::Unavailable,
            };
        }
        result
    }

    /// Success only permits a fresh acquisition; it supplies no key itself.
    pub(crate) fn unlock(&mut self, host: &mut impl HostKeyProvider) -> Result<(), KeyFailure> {
        self.state = KeyState::Locked;
        self.locally_locked = true;
        let result = host.unlock(self.context);
        self.record(result)?;
        self.locally_locked = false;
        Ok(())
    }

    /// Recovery is explicit and cannot reconstruct a lost key from host login.
    pub(crate) fn recover(&mut self, host: &mut impl HostKeyProvider) -> Result<(), KeyFailure> {
        self.state = KeyState::Locked;
        self.locally_locked = true;
        let result = host.recover(self.context);
        self.record(result)?;
        self.locally_locked = false;
        Ok(())
    }

    fn acquire(&mut self, host: &mut impl HostKeyProvider) -> Result<DecodedKey, KeyFailure> {
        if self.locally_locked {
            return Err(KeyFailure::Locked);
        }
        // Fail closed also if provider unwinds while reacquiring.
        self.state = KeyState::Locked;
        let result = host.acquire(self.context);
        let key = self.record(result)?;
        if key.context != self.context {
            return self.record(Err(KeyFailure::Context));
        }
        Ok(key)
    }

    /// The higher-ranked borrow prevents returning a borrowed key. Trusted host
    /// code can still copy bytes; downstream cleanup is explicitly its obligation.
    pub(crate) fn with_key<R>(
        &mut self,
        host: &mut impl HostKeyProvider,
        use_key: impl for<'key> FnOnce(&'key [u8; 32]) -> Result<R, KeyFailure>,
    ) -> Result<R, KeyFailure> {
        let key = self.acquire(host)?;
        let result = use_key(&key.bytes);
        drop(key); // Zeroizing runs on success/error and unwinding as well.
        let value = self.record(result)?;
        self.state = KeyState::Ready;
        Ok(value)
    }

    pub(crate) fn wrap(
        &mut self,
        host: &mut impl HostKeyProvider,
    ) -> Result<WrappedKey, KeyFailure> {
        let key = self.acquire(host)?;
        let result = host.wrap(self.context, &key.bytes);
        drop(key);
        let wrapped = self.record(result)?;
        if wrapped.context != self.context {
            return self.record(Err(KeyFailure::Context));
        }
        self.state = KeyState::Ready;
        Ok(wrapped)
    }

    /// Never unlock implicitly. Possessing a wrapped blob is not key authority.
    pub(crate) fn with_wrapped_key<R>(
        &mut self,
        host: &mut impl HostKeyProvider,
        wrapped: &WrappedKey,
        use_key: impl for<'key> FnOnce(&'key [u8; 32]) -> Result<R, KeyFailure>,
    ) -> Result<R, KeyFailure> {
        if self.locally_locked {
            return Err(KeyFailure::Locked);
        }
        self.state = KeyState::Locked;
        if wrapped.context != self.context {
            return self.record(Err(KeyFailure::Context));
        }
        let result = host.unwrap(self.context, wrapped);
        let key = self.record(result)?;
        if key.context != self.context {
            return self.record(Err(KeyFailure::Context));
        }
        let result = use_key(&key.bytes);
        drop(key);
        let value = self.record(result)?;
        self.state = KeyState::Ready;
        Ok(value)
    }
}
