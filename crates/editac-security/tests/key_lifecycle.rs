//! SEC-1.4 prepared lifecycle gateway, not an OS/browser wrapping test.
#[path = "../src/keys.rs"]
mod keys;

use keys::*;
use std::{cell::Cell, rc::Rc};
use zeroize::Zeroizing;

const KEY: [u8; 32] = *b"SEC1.4-DISPOSABLE-KEY-NEVER-REAL";
const HANDLE: &[u8] = b"prepared-opaque-handle-01";

fn context() -> KeyContext {
    KeyContext {
        document: [4; 16],
        document_epoch: 3,
        key_epoch: 7,
        purpose: KeyPurpose::LocalStore,
    }
}

/// A lookup table stands in for wrapping, never a homegrown test cipher. Handles
/// are bound to trusted context and current access, not reusable bearer keys.
struct PreparedHost {
    access: Result<(), KeyFailure>,
    returned_context: KeyContext,
    wrapped_context: KeyContext,
    retained: bool,
    recovery_copy: bool,
    acquired: usize,
    unlocks: usize,
    recoveries: usize,
    wraps: usize,
    unwraps: usize,
    wrap_failure: Option<KeyFailure>,
    cleared: Rc<Cell<usize>>,
}

impl PreparedHost {
    fn ready() -> Self {
        Self {
            access: Ok(()),
            returned_context: context(),
            wrapped_context: context(),
            retained: true,
            recovery_copy: true,
            acquired: 0,
            unlocks: 0,
            recoveries: 0,
            wraps: 0,
            unwraps: 0,
            wrap_failure: None,
            cleared: Rc::new(Cell::new(0)),
        }
    }
    fn key(&self) -> DecodedKey {
        let mut key = DecodedKey::from_host(self.returned_context, Zeroizing::new(KEY));
        key.cleared = Some(self.cleared.clone());
        key
    }
    fn check(&self) -> Result<(), KeyFailure> {
        self.access?;
        if !self.retained {
            return Err(KeyFailure::Unavailable);
        }
        Ok(())
    }
}

impl HostKeyProvider for PreparedHost {
    fn acquire(&mut self, _: KeyContext) -> Result<DecodedKey, KeyFailure> {
        self.acquired += 1;
        self.check()?;
        Ok(self.key())
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        self.unlocks += 1;
        match self.access {
            Err(KeyFailure::Locked) => {
                self.access = Ok(());
                Ok(())
            }
            result => result,
        }
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        self.recoveries += 1;
        if self.access == Err(KeyFailure::Revoked) {
            return Err(KeyFailure::Revoked);
        }
        if !self.recovery_copy {
            return Err(KeyFailure::Unavailable);
        }
        self.retained = true;
        self.access = Ok(());
        Ok(())
    }
    fn wrap(&mut self, _: KeyContext, key: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        self.wraps += 1;
        self.check()?;
        assert_eq!(key, &KEY);
        if let Some(error) = self.wrap_failure {
            return Err(error);
        }
        WrappedKey::from_host(self.wrapped_context, HANDLE.to_vec())
    }
    fn unwrap(&mut self, ctx: KeyContext, wrapped: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        self.unwraps += 1;
        self.check()?;
        // Trusted table binds context, not just the caller-controlled outer label.
        if ctx != context() || wrapped.host_bytes() != HANDLE {
            return Err(KeyFailure::Context);
        }
        Ok(self.key())
    }
}

#[test]
fn absent_keys_fail_closed_without_invoking_plaintext_callback() {
    for (error, state) in [
        (KeyFailure::Locked, KeyState::Locked),
        (KeyFailure::Unavailable, KeyState::Unavailable),
        (KeyFailure::Revoked, KeyState::Revoked),
        (KeyFailure::RecoveryRequired, KeyState::RecoveryRequired),
        (KeyFailure::Incompatible, KeyState::Incompatible),
        (KeyFailure::Provider, KeyState::Unavailable),
    ] {
        let mut host = PreparedHost::ready();
        host.access = Err(error);
        let mut session = KeySession::new(context());
        let mut plaintext_writes = 0;
        let result = session.with_key(&mut host, |_| {
            plaintext_writes += 1;
            Ok(())
        });
        assert_eq!(result, Err(error));
        assert_eq!(session.state(), state);
        assert_eq!(plaintext_writes, 0);
        assert_eq!(
            (host.unlocks, host.recoveries, host.wraps, host.unwraps),
            (0, 0, 0, 0)
        );
    }
}

#[test]
fn host_authentication_and_document_locator_supply_no_key() {
    let authenticated_host = true;
    let locator = "ac://document/04040404";
    assert!(authenticated_host && locator.starts_with("ac://"));
    let mut host = PreparedHost::ready();
    host.retained = false;
    let mut session = KeySession::new(context());
    assert_eq!(
        session.with_key(&mut host, |_| Ok("plaintext")),
        Err(KeyFailure::Unavailable)
    );
    assert_eq!(host.recoveries, 0);
}

#[test]
fn authorized_success_clears_owned_key_before_return() {
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    assert_eq!(
        session.with_key(&mut host, |key| {
            assert_eq!(key, &KEY);
            Ok(19)
        }),
        Ok(19)
    );
    assert_eq!(host.cleared.get(), 1);
    assert_eq!(session.state(), KeyState::Ready);
}

#[test]
fn callback_failure_and_unwind_clear_owned_key_and_leave_no_ready_state() {
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    assert_eq!(
        session.with_key(&mut host, |_| Err::<(), _>(KeyFailure::Provider)),
        Err(KeyFailure::Provider)
    );
    assert_eq!(host.cleared.get(), 1);
    assert_eq!(session.state(), KeyState::Unavailable);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = session.with_key(&mut host, |_| -> Result<(), KeyFailure> {
            panic!("prepared callback failure")
        });
    }));
    assert!(panic.is_err());
    assert_eq!(host.cleared.get(), 2);
    assert_eq!(session.state(), KeyState::Locked);
}

#[test]
fn lock_cancels_access_until_explicit_unlock_and_unlock_is_not_a_key() {
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    session.with_key(&mut host, |_| Ok(())).unwrap();
    session.lock();
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::Locked)
    );
    assert_eq!(host.acquired, 1);
    session.unlock(&mut host).unwrap();
    assert_eq!(session.state(), KeyState::Locked);
    host.access = Err(KeyFailure::Unavailable);
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::Unavailable)
    );
}

#[test]
fn locked_provider_requires_explicit_host_unlock() {
    let mut host = PreparedHost::ready();
    host.access = Err(KeyFailure::Locked);
    let mut session = KeySession::new(context());
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::Locked)
    );
    session.unlock(&mut host).unwrap();
    session.with_key(&mut host, |_| Ok(())).unwrap();
    assert_eq!((host.unlocks, host.acquired, host.cleared.get()), (1, 2, 1));
}

#[test]
fn revocation_is_rechecked_on_each_acquisition_and_cannot_be_unlocked_or_recovered() {
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    session.with_key(&mut host, |_| Ok(())).unwrap();
    host.access = Err(KeyFailure::Revoked);
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::Revoked)
    );
    assert_eq!(session.unlock(&mut host), Err(KeyFailure::Revoked));
    assert_eq!(session.recover(&mut host), Err(KeyFailure::Revoked));
    assert_eq!(session.state(), KeyState::Revoked);
    assert_eq!(host.cleared.get(), 1);
}

#[test]
fn retained_recovery_requires_explicit_action_and_fresh_acquisition() {
    let mut host = PreparedHost::ready();
    host.access = Err(KeyFailure::RecoveryRequired);
    host.retained = false;
    let mut session = KeySession::new(context());
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::RecoveryRequired)
    );
    assert_eq!(host.recoveries, 0);
    session.recover(&mut host).unwrap();
    assert_eq!(session.state(), KeyState::Locked);
    session
        .with_key(&mut host, |key| {
            assert_eq!(key, &KEY);
            Ok(())
        })
        .unwrap();
    assert_eq!(host.recoveries, 1);
}

#[test]
fn total_key_loss_is_unrecoverable_without_retained_material() {
    let mut host = PreparedHost::ready();
    host.retained = false;
    host.recovery_copy = false;
    let mut session = KeySession::new(context());
    assert_eq!(session.recover(&mut host), Err(KeyFailure::Unavailable));
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::Locked)
    );
    session.unlock(&mut host).unwrap();
    assert_eq!(
        session.with_key(&mut host, |_| Ok(())),
        Err(KeyFailure::Unavailable)
    );
    assert_eq!(host.cleared.get(), 0);
}

fn other_contexts() -> Vec<KeyContext> {
    let ctx = context();
    vec![
        KeyContext {
            document: [5; 16],
            ..ctx
        },
        KeyContext {
            document_epoch: 4,
            ..ctx
        },
        KeyContext {
            key_epoch: 8,
            ..ctx
        },
        KeyContext {
            purpose: KeyPurpose::History,
            ..ctx
        },
        KeyContext {
            purpose: KeyPurpose::ProtocolState,
            ..ctx
        },
    ]
}

#[test]
fn wrong_document_epoch_or_purpose_never_reaches_key_callback_and_is_cleared() {
    for wrong in other_contexts() {
        let mut host = PreparedHost::ready();
        host.returned_context = wrong;
        let mut session = KeySession::new(context());
        assert_eq!(
            session.with_key(&mut host, |_| panic!("wrong key exposed")),
            Err::<(), _>(KeyFailure::Context)
        );
        assert_eq!(host.cleared.get(), 1);
        assert_eq!(session.state(), KeyState::Unavailable);
    }
}

#[test]
fn wrap_and_explicit_unwrap_preserve_context_without_plaintext_serialization() {
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    let wrapped = session.wrap(&mut host).ok().unwrap();
    assert_eq!(host.cleared.get(), 1);
    assert_eq!(wrapped.host_bytes(), HANDLE);
    assert!(
        !wrapped
            .host_bytes()
            .windows(KEY.len())
            .any(|bytes| bytes == KEY)
    );
    session
        .with_wrapped_key(&mut host, &wrapped, |key| {
            assert_eq!(key, &KEY);
            Ok(())
        })
        .unwrap();
    assert_eq!(host.cleared.get(), 2);
    session.lock();
    assert_eq!(
        session.with_wrapped_key(&mut host, &wrapped, |_| Ok(())),
        Err(KeyFailure::Locked)
    );
    assert_eq!(host.unwraps, 1);
}

#[test]
fn wrap_failure_has_no_plaintext_fallback_and_clears_acquired_key() {
    let mut host = PreparedHost::ready();
    host.wrap_failure = Some(KeyFailure::Provider);
    let mut session = KeySession::new(context());
    assert!(matches!(session.wrap(&mut host), Err(KeyFailure::Provider)));
    assert_eq!(host.cleared.get(), 1);
    assert_eq!(session.state(), KeyState::Unavailable);
}

#[test]
fn mismatched_wrapping_result_is_not_persistable() {
    for wrong in other_contexts() {
        let mut host = PreparedHost::ready();
        host.wrapped_context = wrong;
        assert!(matches!(
            KeySession::new(context()).wrap(&mut host),
            Err(KeyFailure::Context)
        ));
        assert_eq!(host.cleared.get(), 1);
    }
}

#[test]
fn substituted_wrapped_context_rejected_before_provider_and_forged_handle_rejected_by_provider() {
    for wrong in other_contexts() {
        let mut host = PreparedHost::ready();
        let mut session = KeySession::new(context());
        let wrapped = WrappedKey::from_host(wrong, HANDLE.to_vec()).ok().unwrap();
        assert_eq!(
            session.with_wrapped_key(&mut host, &wrapped, |_| Ok(())),
            Err(KeyFailure::Context)
        );
        assert_eq!(host.unwraps, 0);
    }
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    let wrapped = WrappedKey::from_host(context(), b"forged".to_vec())
        .ok()
        .unwrap();
    assert_eq!(
        session.with_wrapped_key(&mut host, &wrapped, |_| Ok(())),
        Err(KeyFailure::Context)
    );
    assert_eq!(host.cleared.get(), 0);
}

#[test]
fn unwrapped_key_context_is_checked_and_cleared_before_callback() {
    let mut host = PreparedHost::ready();
    let wrapped = KeySession::new(context()).wrap(&mut host).ok().unwrap();
    host.returned_context = other_contexts()[0];
    assert_eq!(
        KeySession::new(context()).with_wrapped_key(&mut host, &wrapped, |_| panic!("wrong key")),
        Err::<(), _>(KeyFailure::Context)
    );
    assert_eq!(host.cleared.get(), 2);
}

#[test]
fn wrapped_blob_is_not_authority_after_loss_or_revocation() {
    for error in [
        KeyFailure::Unavailable,
        KeyFailure::Revoked,
        KeyFailure::Locked,
        KeyFailure::Incompatible,
    ] {
        let mut host = PreparedHost::ready();
        let mut session = KeySession::new(context());
        let wrapped = session.wrap(&mut host).ok().unwrap();
        host.access = Err(error);
        assert_eq!(
            session.with_wrapped_key(&mut host, &wrapped, |_| Ok(())),
            Err(error)
        );
        assert_eq!(host.cleared.get(), 1);
    }
}

#[test]
fn wrapped_inputs_are_bounded_and_nonempty() {
    for len in [0, WrappedKey::MAX_BYTES + 1] {
        assert!(matches!(
            WrappedKey::from_host(context(), vec![0; len]),
            Err(KeyFailure::Bounds)
        ));
    }
    assert!(WrappedKey::from_host(context(), vec![0; WrappedKey::MAX_BYTES]).is_ok());
}

#[test]
fn diagnostic_surface_contains_only_fixed_codes_and_state() {
    let mut session = KeySession::new(context());
    let mut host = PreparedHost::ready();
    session.with_key(&mut host, |_| Ok(())).unwrap();
    assert_eq!(format!("{session:?}"), "KeySession { state: Ready }");
    assert_eq!(
        format!("{:?}", KeyFailure::RecoveryRequired),
        "RecoveryRequired"
    );
    let diagnostic = format!("{session:?} {:?}", KeyFailure::Provider);
    assert!(!diagnostic.contains(std::str::from_utf8(&KEY).unwrap()));
    assert!(!diagnostic.contains("04040404"));
}

#[test]
fn unwrap_callback_error_and_unwind_clear_owned_key() {
    let mut host = PreparedHost::ready();
    let mut session = KeySession::new(context());
    let wrapped = session.wrap(&mut host).ok().unwrap();
    assert_eq!(
        session.with_wrapped_key(&mut host, &wrapped, |_| Err::<(), _>(KeyFailure::Provider)),
        Err(KeyFailure::Provider)
    );
    assert_eq!(host.cleared.get(), 2);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = session.with_wrapped_key(&mut host, &wrapped, |_| -> Result<(), KeyFailure> {
            panic!("prepared unwrap callback")
        });
    }));
    assert!(panic.is_err());
    assert_eq!(host.cleared.get(), 3);
    assert_eq!(session.state(), KeyState::Locked);
}

#[test]
fn key_cannot_be_borrowed_past_scope_debugged_or_cloned() {
    use std::{fs, process::Command};
    let deps = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let rlib = fs::read_dir(&deps)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            name.starts_with("libzeroize-") && name.ends_with(".rlib")
        })
        .unwrap();
    let output = std::env::var_os("EDITAC_KEY_EVIDENCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| deps.join(format!("key-contract-{}", std::process::id())));
    fs::create_dir_all(&output).unwrap();
    let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/keys.rs");
    for (name, body, expected) in [
        (
            "valid",
            "fn scoped(s: &mut KeySession, h: &mut impl HostKeyProvider) -> u8 { s.with_key(h, |k| Ok(k[0])).unwrap() }",
            None,
        ),
        (
            "borrow",
            "fn escape<'a>(s: &'a mut KeySession, h: &mut impl HostKeyProvider) -> &'a [u8;32] { s.with_key(h, |k| Ok(k)).unwrap() }",
            Some("lifetime may not live long enough"),
        ),
        (
            "debug",
            "fn leak(k: DecodedKey) { let _ = format!(\"{k:?}\"); }",
            Some("E0277"),
        ),
        (
            "clone",
            "fn copy(k: DecodedKey) { let _ = k.clone(); }",
            Some("E0599"),
        ),
        (
            "private",
            "fn export(k: DecodedKey) { let _ = k.bytes; }",
            Some("E0616"),
        ),
    ] {
        let source = output.join(format!("{name}.rs"));
        fs::write(
            &source,
            format!("#![allow(dead_code)]\n#[path = {module:?}] mod keys;\nuse keys::*;\n{body}\n"),
        )
        .unwrap();
        let result = Command::new("rustc")
            .arg("--edition=2024")
            .arg("--crate-type=lib")
            .arg("--emit=metadata")
            .arg(&source)
            .arg("--extern")
            .arg(format!("zeroize={}", rlib.display()))
            .arg("-L")
            .arg(format!("dependency={}", deps.display()))
            .arg("--out-dir")
            .arg(&output)
            .output()
            .unwrap();
        fs::write(output.join(format!("{name}.stderr")), &result.stderr).unwrap();
        match expected {
            None => assert!(result.status.success(), "positive compile control failed"),
            Some(message) => {
                assert!(!result.status.success(), "{name} unexpectedly compiled");
                assert!(
                    String::from_utf8_lossy(&result.stderr).contains(message),
                    "{name} wrong failure"
                );
            }
        }
    }
}
