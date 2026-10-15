//! SEC-1.9 canonical integration: actual MLS/opaque relay, protected SQLite,
//! Session/EditService admission, immutable semantic diff and explicit exports.
#[allow(dead_code)]
#[path = "../src/assets.rs"]
mod assets;
#[allow(dead_code)]
#[path = "../src/capabilities.rs"]
mod capabilities;
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

use assets::*;
use capabilities::*;
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::DocumentIdentity,
};
use editac_session::{
    edit_service::{EditService, HostPolicy, PreparedEdit},
    operations::{HostActor, HostOperation, OperationOrigin},
    ports::*,
    session::{CachedPermission, Session},
};
use keys::*;
use protected_sync::*;
use std::{cell::Cell, fs, path::PathBuf, rc::Rc, sync::Arc};
use store::*;
use store_native::*;
use support::*;
use sync::*;
use zeroize::Zeroizing;

type Router<'a> = Endpoint<'a, Arc<Protected>, FixtureProvider>;
struct Policy {
    enabled: bool,
    denied: Option<Action>,
    calls: Cell<usize>,
}
impl Policy {
    fn allow() -> Self {
        Self {
            enabled: true,
            denied: None,
            calls: Cell::new(0),
        }
    }
}
impl PlaintextHost for Policy {
    fn allows(&self, scope: &Scope, id: &DocumentIdentity, action: Action) -> bool {
        self.calls.set(self.calls.get() + 1);
        self.enabled
            && self.denied != Some(action)
            && *scope == Scope::prepared(id, &context())
            && *id == identity()
    }
}
struct Fixture {
    dir: PathBuf,
    relay: OpaqueRelay<SqliteHost>,
    ca: Client,
    cb: Client,
    sa: Arc<Protected>,
    a: EditService<Arc<Protected>>,
    b: Session<Arc<Protected>>,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let Harness {
            dir,
            relay,
            ca,
            cb,
            sa,
            a,
            b,
            ..
        } = Harness::new(name);
        Self {
            dir,
            relay,
            ca,
            cb,
            sa,
            a: EditService::new(a, HostPolicy::default()),
            b,
        }
    }
    fn endpoint(&mut self) -> Router<'_> {
        Endpoint::local(&mut self.ca, &mut self.a)
    }
    fn command(&self, text: &str) -> EditorCommand {
        let block = self
            .a
            .session()
            .document()
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.kind == "block")
            .unwrap()
            .id
            .clone();
        let at = self
            .a
            .session()
            .document()
            .anchor(&block, Utf16Offset(0), Bias::Right)
            .unwrap();
        EditorCommand::Text(TextCommand::Insert {
            at,
            text: text.into(),
        })
    }
    fn prepare(&mut self, p: &Policy, text: &str) -> Result<PreparedEdit, CapabilityError> {
        let scope = self.ca.scope().clone();
        let command = self.command(text);
        let expected = self.a.session().observed_revision().unwrap();
        self.endpoint().prepare(
            &scope,
            p,
            &expected,
            &[command],
            &TextOrigin::new("security:capability").unwrap(),
            0,
        )
    }
    fn unchanged(&self, before: &[u8]) {
        assert_eq!(self.a.session().document().checkpoint().bytes, before);
        assert!(self.sa.pending(&identity()).unwrap().is_empty());
        no_plaintext(&self.dir);
    }
    fn checkpoint(&self) -> Vec<u8> {
        self.a.session().document().checkpoint().bytes
    }
    fn sync(&mut self) {
        for (i, entry) in self.sa.pending(&identity()).unwrap().iter().enumerate() {
            let mut op = [19; 16];
            op[15] = (i + 2) as u8;
            self.ca.prepare_update(op, entry).unwrap();
            self.ca.send(&self.relay, op).unwrap();
        }
        for packet in self.relay.fetch(self.cb.scope()).unwrap().iter().skip(1) {
            self.cb.receive_update(packet, &mut self.b).unwrap();
        }
        assert_eq!(text(self.a.session()), text(&self.b));
        no_plaintext(&self.dir);
    }
}
fn operation(origin: OperationOrigin, n: usize) -> HostOperation {
    HostOperation {
        actor: Some(HostActor::authenticated_by_host("fixture-host-subject").unwrap()),
        origin,
        request_id: format!("sec19-{n}"),
    }
}
fn changed_scope(scope: &Scope, field: &str, value: serde_json::Value) -> Scope {
    let mut encoded = serde_json::to_value(scope).unwrap();
    encoded[field] = value;
    serde_json::from_value(encoded).unwrap()
}
fn every_denied(c: Capabilities) {
    for action in Action::ALL {
        assert!(!c.permits(action));
    }
}

// SEC-F-opaque-agent: the actual relay has persistent authenticated ciphertext,
// but the plaintext dispatch has no local endpoint or host authorization callback.
#[test]
fn sec_f_opaque_agent_refuses_every_plaintext_action_before_host_or_keys() {
    let mut f = Fixture::new("opaque-agent");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let plan = f.prepare(&p, "OPAQUE_EDIT_MUST_NOT_APPLY").unwrap();
    let before = f.checkpoint();
    let mut asset = recovery(&f, identity(), key_context());
    let key_reads = asset.1.get();
    let mut sink = Sink::new(false, None);
    let local_before = f.endpoint().capture(&scope, &p, 0).unwrap();
    let calls = p.calls.get();
    let mut relay: Router<'_> = Endpoint::opaque(&f.relay);
    every_denied(relay.capabilities(&scope, &p, 0).unwrap());
    for action in [Action::Decrypt, Action::Mcp, Action::Preview] {
        assert!(matches!(
            relay.read(&scope, &p, action, 0),
            Err(CapabilityError::Opaque)
        ));
    }
    assert!(matches!(
        relay.search(&scope, &p, SEED, 0),
        Err(CapabilityError::Opaque)
    ));
    assert!(matches!(
        relay.diff(&scope, &p, &local_before, 0),
        Err(CapabilityError::Opaque)
    ));
    assert!(matches!(
        relay.prepare(
            &scope,
            &p,
            &f.a.session().observed_revision().unwrap(),
            &[f.command("no")],
            &TextOrigin::new("agent").unwrap(),
            0
        ),
        Err(CapabilityError::Opaque)
    ));
    assert!(matches!(
        relay.apply(&scope, &p, plan, operation(OperationOrigin::Agent, 0), 0),
        Err(CapabilityError::Opaque)
    ));
    assert!(matches!(
        relay.export(
            &scope,
            &p,
            &mut asset.0,
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut sink,
            0
        ),
        Err(CapabilityError::Opaque)
    ));
    assert_eq!(p.calls.get(), calls);
    assert_eq!(asset.1.get(), key_reads);
    assert_eq!(sink.calls, 0);
    assert!(sink.bytes.is_empty());
    f.unchanged(&before);
    assert_eq!(f.relay.fetch(&scope).unwrap().len(), 1);
}
#[test]
fn incompatible_profile_version_document_epoch_schema_and_engine_never_downgrade() {
    let mut f = Fixture::new("no-downgrade");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let mut engine = serde_json::to_value(&scope).unwrap()["engine"].clone();
    engine[0] = "other-document".into();
    let cases = [
        ("profile", "baseline".into()),
        ("version", 2.into()),
        ("document_epoch", 12.into()),
        ("schema", 4.into()),
        ("key_epoch", 2.into()),
        ("document", serde_json::to_value([8; 16]).unwrap()),
        ("engine", engine),
    ];
    let before = f.checkpoint();
    let calls = p.calls.get();
    for (field, value) in cases {
        let wrong = changed_scope(&scope, field, value);
        let router = f.endpoint();
        assert!(matches!(
            router.capabilities(&wrong, &p, 0),
            Err(CapabilityError::Incompatible)
        ));
        assert!(matches!(
            router.read(&wrong, &p, Action::Mcp, 0),
            Err(CapabilityError::Incompatible)
        ));
        let relay: Router<'_> = Endpoint::opaque(&f.relay);
        assert!(matches!(
            relay.read(&wrong, &p, Action::Preview, 0),
            Err(CapabilityError::Incompatible)
        ));
    }
    assert_eq!(p.calls.get(), calls);
    assert!(*f.ca.scope() == scope);
    f.unchanged(&before);
}
#[test]
fn host_credentials_without_explicit_plaintext_authority_grant_nothing() {
    let mut f = Fixture::new("host-auth-no-grant");
    let scope = f.ca.scope().clone();
    let mut p = Policy::allow();
    p.enabled = false;
    let before = f.checkpoint();
    every_denied(f.endpoint().capabilities(&scope, &p, 0).unwrap());
    for action in [Action::Decrypt, Action::Mcp, Action::Preview] {
        assert!(matches!(
            f.endpoint().read(&scope, &p, action, 0),
            Err(CapabilityError::Denied)
        ));
    }
    assert!(matches!(f.prepare(&p, "no"), Err(CapabilityError::Denied)));
    f.unchanged(&before);
}
#[test]
fn each_plaintext_action_has_independent_current_host_authority() {
    let mut f = Fixture::new("separate-actions");
    let scope = f.ca.scope().clone();
    for denied in Action::ALL {
        let p = Policy {
            denied: Some(denied),
            ..Policy::allow()
        };
        let caps = f.endpoint().capabilities(&scope, &p, 0).unwrap();
        for action in Action::ALL {
            assert_eq!(caps.permits(action), action != denied);
        }
        if denied != Action::Mcp {
            let read = f.endpoint().read(&scope, &p, Action::Mcp, 0).unwrap();
            assert_eq!(read.capabilities.can_prepare, denied != Action::Edit);
            assert_eq!(read.capabilities.can_apply, denied != Action::Edit);
            assert_eq!(read.capabilities.policy.writable, denied != Action::Edit);
        }
    }
    no_plaintext(&f.dir);
}
// SEC-F-local-agent-readonly: this Session was bootstrapped through the real MLS
// relay. The local read/diff tools share EditService's ordinary write admission.
#[test]
fn sec_f_local_agent_readonly_reads_searches_previews_and_diffs_but_cannot_edit() {
    let mut f = Fixture::new("local-agent-readonly");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    f.a.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    let before = f.checkpoint();
    let router = f.endpoint();
    let caps = router.capabilities(&scope, &p, 0).unwrap();
    assert!(caps.decrypt && caps.export && caps.diff && caps.mcp && caps.search && caps.preview);
    assert!(!caps.edit);
    for action in [Action::Decrypt, Action::Mcp, Action::Preview] {
        let read = router.read(&scope, &p, action, 0).unwrap();
        assert!(
            read.snapshot
                .visible
                .iter()
                .flat_map(|n| &n.runs)
                .any(|r| r.text == SEED)
        );
        assert!(!read.capabilities.can_apply);
    }
    assert_eq!(
        router.search(&scope, &p, "CONFIDENTIAL", 0).unwrap().len(),
        1
    );
    let old = router.capture(&scope, &p, 0).unwrap();
    assert!(router.diff(&scope, &p, &old, 0).unwrap().changes.is_empty());
    assert!(matches!(
        f.prepare(&p, "reader write"),
        Err(CapabilityError::Denied)
    ));
    f.unchanged(&before);
}
#[test]
fn human_and_agent_edits_use_same_admission_and_converge_via_encrypted_relay() {
    let mut f = Fixture::new("authorized-edit");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let before = f.endpoint().capture(&scope, &p, 0).unwrap();
    for (n, origin) in [
        OperationOrigin::Human,
        OperationOrigin::Agent,
        OperationOrigin::Unattributed,
    ]
    .into_iter()
    .enumerate()
    {
        let plan = f.prepare(&p, A).unwrap();
        assert!(!plan.preview().visible.is_empty());
        assert!(
            f.endpoint()
                .apply(&scope, &p, plan, operation(origin, n), 0)
                .unwrap()
                .is_some()
        );
        assert_eq!(f.a.operations().back().unwrap().origin, origin);
    }
    let diff = f.endpoint().diff(&scope, &p, &before, 0).unwrap();
    assert!(!diff.changes.is_empty());
    assert_eq!(f.sa.pending(&identity()).unwrap().len(), 3);
    f.sync();
    assert_eq!(text(&f.b), format!("{A}{A}{A}{SEED}"));
}
#[test]
fn readonly_change_between_prepare_and_apply_rejects_without_mutation() {
    let mut f = Fixture::new("permission-change");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let plan = f.prepare(&p, "no").unwrap();
    let before = f.checkpoint();
    f.a.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    assert!(matches!(
        f.endpoint()
            .apply(&scope, &p, plan, operation(OperationOrigin::Agent, 0), 0),
        Err(CapabilityError::Denied)
    ));
    f.unchanged(&before);
}
#[test]
fn host_policy_and_historical_view_block_agent_and_human_equally() {
    let mut f = Fixture::new("policy-change");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let before = f.checkpoint();
    for policy in [
        HostPolicy {
            writable: false,
            ..HostPolicy::default()
        },
        HostPolicy {
            history_view: true,
            ..HostPolicy::default()
        },
    ] {
        let plan = f.prepare(&p, "no").unwrap();
        f.a.set_policy(policy);
        assert!(!f.endpoint().capabilities(&scope, &p, 0).unwrap().edit);
        assert!(matches!(f.prepare(&p, "no"), Err(CapabilityError::Denied)));
        assert!(matches!(
            f.endpoint()
                .apply(&scope, &p, plan, operation(OperationOrigin::Human, 0), 0),
            Err(CapabilityError::Denied)
        ));
        f.a.set_policy(HostPolicy::default());
    }
    f.unchanged(&before);
}
#[test]
fn expiring_permission_cannot_use_prepared_plan_or_cached_capabilities() {
    let mut f = Fixture::new("expiry");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    f.a.set_permission(CachedPermission {
        writable: true,
        expires_at: Some(1),
    });
    let plan = f.prepare(&p, "no").unwrap();
    let before = f.checkpoint();
    assert!(f.endpoint().capabilities(&scope, &p, 0).unwrap().edit);
    every_denied(f.endpoint().capabilities(&scope, &p, 1).unwrap());
    assert!(matches!(
        f.endpoint().read(&scope, &p, Action::Mcp, 1),
        Err(CapabilityError::Denied)
    ));
    assert!(matches!(
        f.endpoint()
            .apply(&scope, &p, plan, operation(OperationOrigin::Agent, 0), 1),
        Err(CapabilityError::Denied)
    ));
    f.unchanged(&before);
}
#[test]
fn revoked_host_action_rechecks_at_apply() {
    let mut f = Fixture::new("host-revoke");
    let mut p = Policy::allow();
    let scope = f.ca.scope().clone();
    let plan = f.prepare(&p, "no").unwrap();
    let before = f.checkpoint();
    p.enabled = false;
    assert!(matches!(
        f.endpoint()
            .apply(&scope, &p, plan, operation(OperationOrigin::Agent, 0), 0),
        Err(CapabilityError::Denied)
    ));
    f.unchanged(&before);
}
#[test]
fn retired_client_cannot_route_previously_decrypted_content_or_prepared_edits() {
    let mut f = Fixture::new("retired-local");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let plan = f.prepare(&p, "no").unwrap();
    let before = f.checkpoint();
    let mut router = f.endpoint();
    router.retire();
    every_denied(router.capabilities(&scope, &p, 0).unwrap());
    assert!(matches!(
        router.read(&scope, &p, Action::Preview, 0),
        Err(CapabilityError::Unavailable)
    ));
    assert!(matches!(
        router.apply(&scope, &p, plan, operation(OperationOrigin::Agent, 0), 0),
        Err(CapabilityError::Unavailable)
    ));
    f.unchanged(&before);
}
#[test]
fn mismatched_engine_identity_cannot_pair_with_key_holding_client() {
    let mut f = Fixture::new("wrong-local-doc");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let mut wrong = identity();
    wrong.epoch = "34567890-3456-4345-8345-34567890abcd".into();
    let (provider, group) = prepared(1);
    let admission = envelope::Admission::fresh_prepared_membership(
        provider,
        group,
        context(),
        [signer(1).to_public_vec(), signer(2).to_public_vec()].into(),
        signer(1).to_public_vec(),
    )
    .ok()
    .unwrap();
    let mut other = EncryptedClient::fresh_prepared(admission, signer(1), wrong, context())
        .ok()
        .unwrap();
    // Even manually asking for the original scope cannot bypass exact routing.
    let other_scope = other.scope().clone();
    let router = Router::local(&mut other, &mut f.a);
    every_denied(router.capabilities(&other_scope, &p, 0).unwrap());
    assert!(matches!(
        router.read(&other_scope, &p, Action::Mcp, 0),
        Err(CapabilityError::Unavailable)
    ));
    assert!(matches!(
        router.read(&scope, &p, Action::Mcp, 0),
        Err(CapabilityError::Incompatible)
    ));
    no_plaintext(&f.dir);
}
#[test]
fn ordinary_stale_revision_rejection_remains_authoritative() {
    let mut f = Fixture::new("stale-plan");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let first = f.prepare(&p, A).unwrap();
    let stale = f.prepare(&p, B).unwrap();
    f.endpoint()
        .apply(&scope, &p, first, operation(OperationOrigin::Human, 0), 0)
        .unwrap();
    let before = f.checkpoint();
    assert!(matches!(
        f.endpoint()
            .apply(&scope, &p, stale, operation(OperationOrigin::Agent, 1), 0),
        Err(CapabilityError::Service)
    ));
    assert_eq!(f.checkpoint(), before);
    assert_eq!(f.sa.pending(&identity()).unwrap().len(), 1);
    f.sync();
}
#[test]
fn bounded_local_search_and_read_dispatch_do_not_bypass_action_checks() {
    let mut f = Fixture::new("bounded-tools");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let router = f.endpoint();
    for query in ["".to_string(), "x".repeat(257)] {
        assert!(matches!(
            router.search(&scope, &p, &query, 0),
            Err(CapabilityError::ResourceLimit)
        ));
    }
    assert!(router.search(&scope, &p, "absent", 0).unwrap().is_empty());
    for action in [Action::Edit, Action::Export, Action::Search, Action::Diff] {
        assert!(matches!(
            router.read(&scope, &p, action, 0),
            Err(CapabilityError::InvalidAction)
        ));
    }
    no_plaintext(&f.dir);
}

#[derive(Clone)]
struct ExportKeys {
    context: KeyContext,
    reads: Rc<Cell<usize>>,
}
impl HostKeyProvider for ExportKeys {
    fn acquire(&mut self, c: KeyContext) -> Result<DecodedKey, KeyFailure> {
        self.reads.set(self.reads.get() + 1);
        if c != self.context {
            return Err(KeyFailure::Context);
        }
        Ok(DecodedKey::from_host(c, Zeroizing::new([0x72; 32])))
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        panic!("implicit unlock")
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        panic!("implicit recovery")
    }
    fn wrap(&mut self, _: KeyContext, _: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        panic!("key delegation")
    }
    fn unwrap(&mut self, _: KeyContext, _: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        panic!("implicit unwrap")
    }
}
type ExportAssets = ProtectedAssets<SqliteHost, ExportKeys>;
fn recovery(
    f: &Fixture,
    id: DocumentIdentity,
    mut context: KeyContext,
) -> (ExportAssets, Rc<Cell<usize>>) {
    context.purpose = KeyPurpose::History;
    let reads = Rc::new(Cell::new(0));
    let binding = AssetBinding::new(&id, context, AssetKind::Recovery, [19; 16], 1).unwrap();
    let mut assets = ProtectedAssets::new(
        binding,
        SqliteHost::open(
            &f.dir.join(format!("export-{}.sqlite", context.key_epoch)),
            None,
        )
        .unwrap(),
        ExportKeys {
            context,
            reads: reads.clone(),
        },
    )
    .ok()
    .unwrap();
    if id == identity() {
        assets
            .retain_recovery(&f.a.session().recovery_export())
            .unwrap();
    }
    (assets, reads)
}
struct Sink {
    allowed: bool,
    calls: usize,
    bytes: Vec<u8>,
    path: Option<PathBuf>,
}
impl Sink {
    fn new(allowed: bool, path: Option<PathBuf>) -> Self {
        Self {
            allowed,
            calls: 0,
            bytes: vec![],
            path,
        }
    }
}
impl ExportHost for Sink {
    fn authorize(&mut self, intent: &ExportIntent<'_>) -> bool {
        self.calls += 1;
        self.allowed
            && intent.destination == "fixture-authorized-file"
            && intent.label == "PLAINTEXT RECOVERY EXPORT"
    }
    fn write_plaintext(
        &mut self,
        intent: &ExportIntent<'_>,
        bytes: &[u8],
    ) -> Result<(), AssetError> {
        assert!(self.allowed);
        assert_eq!(intent.label, "PLAINTEXT RECOVERY EXPORT");
        self.bytes = bytes.to_vec();
        if let Some(path) = &self.path {
            fs::write(path, bytes).unwrap();
        }
        Ok(())
    }
}
#[test]
fn capability_discovery_never_acquires_or_delegates_export_keys() {
    let mut f = Fixture::new("discover-no-keys");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let (mut assets, reads) = recovery(&f, identity(), key_context());
    let before = reads.get();
    for _ in 0..5 {
        assert!(f.endpoint().capabilities(&scope, &p, 0).unwrap().export);
    }
    assert_eq!(reads.get(), before);
    let mut sink = Sink::new(true, None);
    assert!(matches!(
        f.endpoint().export(
            &scope,
            &p,
            &mut assets,
            ExportPolicy::Deny,
            "fixture-authorized-file",
            &mut sink,
            0
        ),
        Err(CapabilityError::Asset)
    ));
    assert_eq!(reads.get(), before);
    assert_eq!(sink.calls, 0);
    no_plaintext(&f.dir);
}
#[test]
fn explicit_export_requires_fresh_destination_authority_even_for_readonly_agent() {
    let mut f = Fixture::new("explicit-export");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let (mut assets, reads) = recovery(&f, identity(), key_context());
    let initial_reads = reads.get();
    f.a.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    let before = f.checkpoint();
    let path = f.dir.join("explicit-recovery.json");
    let mut sink = Sink::new(false, Some(path.clone()));
    assert!(f.endpoint().capabilities(&scope, &p, 0).unwrap().export);
    assert!(matches!(
        f.endpoint().export(
            &scope,
            &p,
            &mut assets,
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut sink,
            0
        ),
        Err(CapabilityError::Asset)
    ));
    assert_eq!(reads.get(), initial_reads);
    assert!(!path.exists());
    sink.allowed = true;
    assert!(matches!(
        f.endpoint().export(
            &scope,
            &p,
            &mut assets,
            ExportPolicy::ExplicitPlaintext,
            "unauthorized-destination",
            &mut sink,
            0
        ),
        Err(CapabilityError::Asset)
    ));
    assert_eq!(reads.get(), initial_reads);
    assert!(!path.exists());
    let receipt = f
        .endpoint()
        .export(
            &scope,
            &p,
            &mut assets,
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut sink,
            0,
        )
        .unwrap();
    assert_eq!(receipt.label, "PLAINTEXT RECOVERY EXPORT");
    assert_eq!(receipt.bytes, sink.bytes.len());
    assert_eq!(sink.calls, 3);
    let json: serde_json::Value = serde_json::from_slice(&sink.bytes).unwrap();
    assert_eq!(json["disclosure"], receipt.label);
    assert_eq!(json["destination"], "fixture-authorized-file");
    // Recovery carries exact checkpoint bytes, not a lossy rendered approximation.
    assert_eq!(
        json["record"]["payload"]["Recovery"]["checkpoint"],
        serde_json::to_value(&before).unwrap()
    );
    assert_eq!(f.checkpoint(), before);
    assert!(f.sa.pending(&identity()).unwrap().is_empty());
    assert!(!sink.bytes.windows(32).any(|w| w == [0x72; 32]));
    assert!(path.exists());
    no_plaintext(&f.dir);
}
#[test]
fn host_export_denial_precedes_sink_authorization_and_old_key_acquisition() {
    let mut f = Fixture::new("export-host-denied");
    let mut p = Policy::allow();
    let scope = f.ca.scope().clone();
    let (mut assets, reads) = recovery(&f, identity(), key_context());
    let initial = reads.get();
    let mut sink = Sink::new(true, None);
    p.denied = Some(Action::Export);
    assert!(matches!(
        f.endpoint().export(
            &scope,
            &p,
            &mut assets,
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut sink,
            0
        ),
        Err(CapabilityError::Denied)
    ));
    assert_eq!(reads.get(), initial);
    assert_eq!(sink.calls, 0);
    assert!(sink.bytes.is_empty());
    no_plaintext(&f.dir);
}
#[test]
fn cross_document_crypto_epoch_or_engine_asset_cannot_cross_export_route() {
    for variant in 0..3 {
        let mut f = Fixture::new("cross-export");
        let p = Policy::allow();
        let scope = f.ca.scope().clone();
        let mut id = identity();
        let mut c = key_context();
        match variant {
            0 => id.epoch = "34567890-3456-4345-8345-34567890abcd".into(),
            1 => c.document = [8; 16],
            _ => c.document_epoch += 1,
        }
        let (mut assets, reads) = recovery(&f, id, c);
        let initial = reads.get();
        let mut sink = Sink::new(true, None);
        assert!(matches!(
            f.endpoint().export(
                &scope,
                &p,
                &mut assets,
                ExportPolicy::ExplicitPlaintext,
                "fixture-authorized-file",
                &mut sink,
                0
            ),
            Err(CapabilityError::Incompatible)
        ));
        assert_eq!(reads.get(), initial);
        assert_eq!(sink.calls, 0);
        no_plaintext(&f.dir);
    }
}

#[test]
fn foreign_immutable_revision_is_rejected_by_real_semantic_diff() {
    use editac_diff::representation::*;
    let mut f = Fixture::new("foreign-diff");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let current = f.endpoint().capture(&scope, &p, 0).unwrap();
    let mut foreign_scope = current.scope().clone();
    foreign_scope.epoch = "other-epoch".into();
    let foreign = ImmutableRevision::capture(
        foreign_scope,
        RevisionInput::ExactSource(b"FOREIGN_PRIVATE_SOURCE"),
        RepresentationLimits::default(),
    )
    .unwrap();
    assert!(matches!(
        f.endpoint().diff(&scope, &p, &foreign, 0),
        Err(CapabilityError::Representation)
    ));
    no_plaintext(&f.dir);
}
#[test]
fn locked_endpoint_export_never_acquires_keys_or_invokes_destination_host() {
    let mut f = Fixture::new("locked-export");
    let p = Policy::allow();
    let scope = f.ca.scope().clone();
    let (mut assets, reads) = recovery(&f, identity(), key_context());
    let initial = reads.get();
    let mut sink = Sink::new(true, None);
    let mut router = f.endpoint();
    router.retire();
    assert!(matches!(
        router.export(
            &scope,
            &p,
            &mut assets,
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut sink,
            0
        ),
        Err(CapabilityError::Unavailable)
    ));
    assert_eq!(reads.get(), initial);
    assert_eq!(sink.calls, 0);
    no_plaintext(&f.dir);
}

#[test]
fn actual_mls_reader_cannot_inherit_a_hosts_writable_setting() {
    let mut f = Fixture::new("mls-reader-host-writable");
    let p = Policy::allow();
    let writer_plan = f.prepare(&p, "must not cross reader boundary").unwrap();
    let mut reader = client(3);
    let scope = reader.scope().clone();
    let store = protected(&f.dir.join("reader.sqlite"), None);
    let packet = f.relay.fetch(&scope).unwrap().remove(0);
    reader.bootstrap(&packet, &*store).unwrap();
    // Deliberately writable cached host state: protocol writer authority is
    // still required, independent of having a decrypting leaf/host token.
    let session = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_eq!(text(&session), SEED);
    let mut service = EditService::new(session, HostPolicy::default());
    assert!(service.capabilities(0).can_apply);
    let expected = service.session().observed_revision().unwrap();
    let mut router = Router::local(&mut reader, &mut service);
    let caps = router.capabilities(&scope, &p, 0).unwrap();
    assert!(caps.decrypt && caps.mcp && caps.diff && caps.preview);
    assert!(!caps.edit);
    for action in [Action::Decrypt, Action::Mcp, Action::Preview] {
        let read = router.read(&scope, &p, action, 0).unwrap();
        assert!(!read.capabilities.can_prepare);
        assert!(!read.capabilities.can_apply);
        assert!(!read.capabilities.can_history);
        assert!(!read.capabilities.policy.writable);
    }
    assert!(matches!(
        router.prepare(
            &scope,
            &p,
            &expected,
            &[f.command("must not commit")],
            &TextOrigin::new("agent").unwrap(),
            0
        ),
        Err(CapabilityError::Denied)
    ));
    let before = router.capture(&scope, &p, 0).unwrap();
    assert!(matches!(
        router.apply(
            &scope,
            &p,
            writer_plan,
            operation(OperationOrigin::Agent, 19),
            0
        ),
        Err(CapabilityError::Denied)
    ));
    assert!(
        router
            .diff(&scope, &p, &before, 0)
            .unwrap()
            .changes
            .is_empty()
    );
    router.retire();
    assert!(store.pending(&identity()).unwrap().is_empty());
    no_plaintext(&f.dir);
}
