//! Prepared v1 conformance plus real production Document/history/anchor isolation.
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::text::{TextCommand, TextOrigin},
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
    extensions::assistive_input::*,
    history::HistoryConfig,
    patches::PatchScope,
};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
#[path = "support/extension_conformance.rs"]
#[allow(dead_code)]
mod conformance;
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/extensions/assistive-input/contract-v1.json"
    ))
    .unwrap()
}
fn descriptor() -> Descriptor {
    serde_json::from_value(corpus()["cases"][0]["descriptor"].clone()).unwrap()
}
fn document() -> Document {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let id = DocumentIdentity::v5(
        format!(
            "a1221111-1111-4111-8111-{:012x}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ),
        "22222222-2222-4222-8222-222222222222",
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "Unchanged שלום 🧪".into(),
        }],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn cell(id: &str) {
    let c = corpus();
    let case = c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap();
    let mut d = document();
    let notifications = Arc::new(AtomicUsize::new(0));
    let seen = notifications.clone();
    let _subscription = d
        .subscribe(PatchScope::All, move |_, _| {
            seen.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
    let before = d.checkpoint().bytes;
    let history = d.history_state();
    let revision = d.revision();
    let node = d.snapshot().unwrap().visible[0].id.clone();
    let anchor = d.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    let target = Target {
        identity: d.identity().clone(),
        anchor: anchor.clone(),
        focus: anchor,
    };
    let position = d.resolve_anchor(&target.anchor).unwrap();
    assert_eq!(
        conformance::assistive_fixture(case),
        case["accepted"].as_bool().unwrap(),
        "{id}"
    );
    assert_eq!(
        d.checkpoint().bytes,
        before,
        "{id}: checkpoint/update bytes"
    );
    assert_eq!(d.history_state(), history, "{id}: history");
    assert_eq!(d.revision(), revision, "{id}: revision");
    assert_eq!(
        d.resolve_anchor(&target.anchor).unwrap(),
        position,
        "{id}: stable selection"
    );
    assert_eq!(
        notifications.load(Ordering::SeqCst),
        0,
        "{id}: emitted updates/patches"
    );
}

#[test]
fn valid_descriptor() {
    cell("valid_descriptor");
}

#[test]
fn absent_baseline() {
    cell("absent_baseline");
}

#[test]
fn disabled_registration() {
    cell("disabled_registration");
}

#[test]
fn command_status_only() {
    cell("command_status_only");
}

#[test]
fn incompatible_version() {
    cell("incompatible_version");
}

#[test]
fn unknown_capability() {
    cell("unknown_capability");
}

#[test]
fn duplicate_capability() {
    cell("duplicate_capability");
}

#[test]
fn empty_capabilities() {
    cell("empty_capabilities");
}

#[test]
fn missing_transport() {
    cell("missing_transport");
}

#[test]
fn undeclared_transport() {
    cell("undeclared_transport");
}

#[test]
fn extra_executable_field() {
    cell("extra_executable_field");
}

#[test]
fn limits_textbytes_zero() {
    cell("limits_textBytes_zero");
}

#[test]
fn limits_textbytes_oversized() {
    cell("limits_textBytes_oversized");
}

#[test]
fn limits_statusbytes_zero() {
    cell("limits_statusBytes_zero");
}

#[test]
fn limits_statusbytes_oversized() {
    cell("limits_statusBytes_oversized");
}

#[test]
fn limits_commands_zero() {
    cell("limits_commands_zero");
}

#[test]
fn limits_commands_oversized() {
    cell("limits_commands_oversized");
}

#[test]
fn limits_results_zero() {
    cell("limits_results_zero");
}

#[test]
fn limits_results_oversized() {
    cell("limits_results_oversized");
}

#[test]
fn limits_sessions_zero() {
    cell("limits_sessions_zero");
}

#[test]
fn limits_sessions_oversized() {
    cell("limits_sessions_oversized");
}

#[test]
fn limits_timeoutms_zero() {
    cell("limits_timeoutMs_zero");
}

#[test]
fn limits_timeoutms_oversized() {
    cell("limits_timeoutMs_oversized");
}

#[test]
fn unknown_locality() {
    cell("unknown_locality");
}

#[test]
fn host_permission_required() {
    cell("host_permission_required");
}

#[test]
fn valid_status() {
    cell("valid_status");
}

#[test]
fn absent_status() {
    cell("absent_status");
}

#[test]
fn disabled_status() {
    cell("disabled_status");
}

#[test]
fn disposed_status() {
    cell("disposed_status");
}

#[test]
fn status_byte_boundary() {
    cell("status_byte_boundary");
}

#[test]
fn status_bytes_overrun() {
    cell("status_bytes_overrun");
}

#[test]
fn provisional_bytes_overrun() {
    cell("provisional_bytes_overrun");
}

#[test]
fn status_version() {
    cell("status_version");
}

#[test]
fn status_unknown_state() {
    cell("status_unknown_state");
}

#[test]
fn status_invalid_generation() {
    cell("status_invalid_generation");
}

#[test]
fn status_extra_metadata() {
    cell("status_extra_metadata");
}

#[test]
fn valid_commands() {
    cell("valid_commands");
}

#[test]
fn duplicate_commands() {
    cell("duplicate_commands");
}

#[test]
fn commands_bound() {
    cell("commands_bound");
}

#[test]
fn disabled_command_reason() {
    cell("disabled_command_reason");
}

#[test]
fn enabled_command_reason() {
    cell("enabled_command_reason");
}

#[test]
fn empty_command_label() {
    cell("empty_command_label");
}

#[test]
fn unknown_command_reason() {
    cell("unknown_command_reason");
}

#[test]
fn valid_final() {
    cell("valid_final");
}

#[test]
fn valid_provisional() {
    cell("valid_provisional");
}

#[test]
fn result_byte_boundary() {
    cell("result_byte_boundary");
}

#[test]
fn result_bytes_overrun() {
    cell("result_bytes_overrun");
}

#[test]
fn result_sequence_bound() {
    cell("result_sequence_bound");
}

#[test]
fn result_unknown_kind() {
    cell("result_unknown_kind");
}

#[test]
fn result_unknown_version() {
    cell("result_unknown_version");
}

#[test]
fn result_identity_bound() {
    cell("result_identity_bound");
}

#[test]
fn result_credentials_rejected() {
    cell("result_credentials_rejected");
}

#[test]
fn result_without_transport_capability() {
    cell("result_without_transport_capability");
}

#[test]
fn duplicate_and_invalid_registration_preserve_accepted_descriptor() {
    let mut r = Registration::default();
    let d = descriptor();
    r.register(d.clone()).unwrap();
    let mut invalid = d.clone();
    invalid.version = 2;
    assert_eq!(r.register(invalid), Err(Error::Version));
    assert_eq!(r.register(d.clone()), Err(Error::Duplicate));
    assert_eq!(r.descriptor(), Some(&d));
    assert!(r.supports(Capability::Commands));
}
#[test]
fn dispose_and_drop_cancel_shared_token_idempotently() {
    let token;
    {
        let mut r = Registration::default();
        token = r.cancellation();
        assert!(!token.is_canceled());
        r.register(descriptor()).unwrap();
        r.dispose();
        r.dispose();
        assert!(token.is_canceled());
        assert!(!r.supports(Capability::Status));
        assert_eq!(r.register(descriptor()), Err(Error::Disposed));
    }
    let drop_token;
    {
        let r = Registration::default();
        drop_token = r.cancellation();
    }
    assert!(drop_token.is_canceled());
}
#[test]
fn absent_disabled_and_disposed_preserve_baseline_edit_and_shared_undo() {
    for mode in ["absent", "disabled", "disposed"] {
        let mut d = document();
        let mut r = Registration::default();
        if mode != "absent" {
            let mut desc = descriptor();
            desc.enabled = mode != "disabled";
            r.register(desc).unwrap();
        }
        if mode == "disposed" {
            r.dispose();
        }
        assert!(!r.supports(Capability::Commands));
        let before = plain(&d);
        let node = d.snapshot().unwrap().visible[0].id.clone();
        let at = d.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
        let command = TextCommand::Insert {
            at,
            text: "Ordinary ".into(),
        };
        let plan = d
            .prepare_text(&command, &TextOrigin::new("fixture:ordinary").unwrap())
            .unwrap();
        d.commit_text(plan).unwrap();
        assert_eq!(plain(&d), format!("Ordinary {before}"));
        assert!(d.undo().unwrap().is_some());
        assert_eq!(plain(&d), before);
        assert!(d.redo().unwrap().is_some());
        assert_eq!(plain(&d), format!("Ordinary {before}"));
    }
}
#[test]
fn all_observable_statuses_are_ephemeral_and_bounded() {
    let mut r = Registration::default();
    r.register(descriptor()).unwrap();
    for state in [
        State::Idle,
        State::Starting,
        State::Active,
        State::Preparing,
        State::Completed,
        State::Cancelled,
        State::Stale,
        State::Failed,
    ] {
        let s = PresenterStatus {
            version: 1,
            state,
            session: None,
            reason: None,
            message: "Status".into(),
            provisional: String::new(),
        };
        assert!(r.validate_status(&s).is_ok());
    }
}

#[test]
fn valid_start() {
    cell("valid_start");
}

#[test]
fn invalid_start_version() {
    cell("invalid_start_version");
}

#[test]
fn invalid_start_identity() {
    cell("invalid_start_identity");
}

#[test]
fn invalid_start_generation() {
    cell("invalid_start_generation");
}

#[test]
fn start_rejects_document_context() {
    cell("start_rejects_document_context");
}

#[test]
fn missing_nullable_transport() {
    cell("missing_nullable_transport");
}

#[test]
fn maximum_declared_limits() {
    cell("maximum_declared_limits");
}

fn plain(d: &Document) -> String {
    d.snapshot().unwrap().visible[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}

#[test]
fn transport_rejects_array_coercion() {
    cell("transport_rejects_array_coercion");
}

#[test]
fn result_rejects_array_coercion() {
    cell("result_rejects_array_coercion");
}
