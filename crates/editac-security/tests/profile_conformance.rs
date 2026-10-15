//! SEC-1.10 cross-boundary mechanics. This is prepared native execution, not
//! production encryption, platform keystore qualification or security review.
#[allow(dead_code)]
#[path = "../src/envelope.rs"]
mod envelope;
#[allow(dead_code)]
#[path = "../src/keys.rs"]
mod keys;
#[allow(dead_code)]
#[path = "support/protected_sync.rs"]
mod protected_sync;
#[allow(dead_code)]
#[path = "../src/store.rs"]
mod store;
#[allow(dead_code)]
#[path = "../src/store_native.rs"]
mod store_native;
#[allow(dead_code)]
mod support;
#[allow(dead_code)]
#[path = "../src/sync.rs"]
mod sync;

use editac_session::{
    ports::*,
    session::{CachedPermission, RemoteState, Session},
};
use envelope::Rejection;
use protected_sync::*;
use sync::CiphertextTransport;

#[test]
fn rejected_profile_cannot_publish_then_authorized_sync_preserves_protected_state() {
    let mut h = Harness::new("conformance-negotiation");
    edit(&mut h.a, A);
    let pending = h.sa.pending(&identity()).unwrap();
    let before = text(&h.b);
    let count = h.relay.fetch(h.ca.scope()).unwrap().len();
    for profile in ["baseline", "local-at-rest", "", "unknown"] {
        let mut wire = serde_json::to_value(h.ca.scope()).unwrap();
        wire["profile"] = serde_json::json!(profile);
        let incompatible = serde_json::from_value(wire).unwrap();
        assert_eq!(
            h.relay.negotiate(&incompatible),
            Err(PortError::Incompatible)
        );
        assert!(h.relay.fetch(&incompatible).is_err());
        assert_eq!(h.relay.fetch(h.ca.scope()).unwrap().len(), count);
        assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
        assert_eq!(text(&h.b), before);
    }
    let packet = h.upload_a();
    h.cb.receive_update(&packet, &mut h.b).unwrap();
    assert_eq!(text(&h.a), text(&h.b));
    assert_eq!(h.a.state(0).remote, RemoteState::Unknown);
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    let reopened = Session::open(h.sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(text(&reopened), text(&h.a));
    no_plaintext(&h.dir);
}

#[test]
fn durable_tampered_ciphertext_receipt_never_acknowledges_plaintext_application() {
    let mut h = Harness::new("conformance-opaque-receipt");
    edit(&mut h.a, A);
    let packet = h.upload_a();
    let before = text(&h.b);
    let pending = h.sa.pending(&identity()).unwrap();
    let mut bad = packet.clone();
    *bad.ciphertext.last_mut().unwrap() ^= 1;
    let receipt = h.relay.put(bad.clone()).unwrap();
    assert_eq!(h.ca.accept(&receipt), Err(PortError::Integrity));
    assert!(h.cb.receive_update(&bad, &mut h.b).is_err());
    // An authentication failure retires the endpoint even for a later good packet.
    assert_eq!(
        h.cb.receive_update(&packet, &mut h.b),
        Err(PortError::Permission)
    );
    assert_eq!(text(&h.b), before);
    assert!(h.sb.pending(&identity()).unwrap().is_empty());
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    assert_eq!(h.a.state(0).remote, RemoteState::Unknown);
    let reopened = Session::open(h.sb.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(text(&reopened), before);
    assert_eq!(
        relay(&h.dir.join("relay.sqlite"), None)
            .fetch(h.ca.scope())
            .unwrap()
            .len(),
        3
    );
    no_plaintext(&h.dir);
}

#[test]
fn protected_recovery_preserves_work_but_never_resumes_restored_mls_sender() {
    let mut h = Harness::new("conformance-recovery");
    edit(&mut h.a, A);
    let pending = h.sa.pending(&identity()).unwrap();
    h.ca.prepare_update([2; 16], &pending[0]).unwrap();
    let before = text(&h.a);
    h.ca.retire_after_restore();
    let recovered = Session::open(h.sa.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(text(&recovered), before);
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    assert_eq!(
        h.ca.prepare_update([3; 16], &pending[0]),
        Err(Rejection::Locked)
    );
    assert!(matches!(
        h.ca.send(&h.relay, [2; 16]),
        Err(PortError::Permission)
    ));
    assert_eq!(h.relay.fetch(h.cb.scope()).unwrap().len(), 1);
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    assert_eq!(recovered.state(0).remote, RemoteState::Unknown);
    no_plaintext(&h.dir);
}

#[test]
fn public_routing_metadata_and_unqualified_production_status_are_explicit() {
    assert!(!editac_security::PRODUCTION_ENCRYPTION_QUALIFIED);
    let h = Harness::new("conformance-metadata");
    let packet = h.relay.fetch(h.ca.scope()).unwrap().remove(0);
    let metadata = serde_json::to_value(&packet.scope).unwrap();
    let fields = metadata.as_object().unwrap();
    for exposed in [
        "profile",
        "version",
        "document",
        "document_epoch",
        "schema",
        "key_epoch",
        "engine",
    ] {
        assert!(
            fields.contains_key(exposed),
            "undeclared metadata change: {exposed}"
        );
    }
    assert_eq!(fields.len(), 7);
    assert!(!packet.ciphertext.is_empty()); // size/traffic/availability remain observable
    let wire = serde_json::to_vec(&packet).unwrap();
    assert!(!wire.windows(SEED.len()).any(|w| w == SEED.as_bytes()));
    no_plaintext(&h.dir);
}
