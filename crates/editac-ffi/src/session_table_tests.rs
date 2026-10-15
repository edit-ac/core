//! Actual Session/SQLite table admission. Corpus is prepared baseline data only;
//! all qualifying cell changes use the public native command boundary.
use super::*;
use editac_core::{
    anchors::Selection,
    document::{CreationPermit, Document},
    interchange::{TransferBlock, transfer_blocks},
};
use editac_session::ports::{
    CheckpointRecord, LocalStore,
    memory::{FaultBoundary, InjectedFault},
};
use serde_json::{Value, json};
use std::path::PathBuf;

struct Fixture {
    directory: PathBuf,
    id: DocumentIdentity,
    store: Arc<NativeStore>,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("native-table-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let id = DocumentIdentity::v5(
            &format!("ac110000-0000-4000-8000-{n:012x}"),
            "ac110000-0000-4000-8000-000000000001",
        )
        .unwrap();
        let mut doc = Document::create(
            CreationPermit::authorize_new(id.clone()).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap();
        let owner = doc.snapshot().unwrap().visible[0].id.clone();
        let at = doc.anchor(&owner, Utf16Offset(0), Bias::Right).unwrap();
        let corpus: Vec<TransferBlock> = serde_json::from_str(include_str!(
            "../../../native/macos/tests/TablesFixture/corpus.json"
        ))
        .unwrap();
        let blocks = transfer_blocks(corpus).unwrap();
        let plan = doc
            .prepare_fragment(
                &Selection {
                    anchor: at.clone(),
                    focus: at,
                },
                &blocks,
                &TextOrigin::new("prepared-table-baseline").unwrap(),
            )
            .unwrap();
        doc.commit_editor(plan).unwrap();
        let store = Arc::new(
            NativeStore::create_new(
                directory.join("store.sqlite"),
                id.clone(),
                StoreLimits::default(),
            )
            .unwrap(),
        );
        store
            .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
            .unwrap();
        Self {
            directory,
            id,
            store,
        }
    }
    fn open(&self) -> Arc<NativeSession> {
        let store = self.store.clone();
        let id = self.id.clone();
        NativeSession::start(move || {
            State::new(Session::open(
                store,
                &id,
                CachedPermission {
                    writable: true,
                    expires_at: None,
                },
            )?)
        })
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
fn revision(s: &NativeSession) -> Vec<u8> {
    s.read(0).unwrap().revision.unwrap()
}
fn visible(s: &NativeSession) -> Value {
    serde_json::from_str::<Value>(&s.rich_snapshot().unwrap().snapshot_json).unwrap()["visible"]
        .clone()
}
fn command(s: &NativeSession, text: &str) -> Value {
    let nodes = visible(s);
    let table = &nodes[1];
    json!([{"type":"tableCell","owner":table["id"],"expected":table["blockAttributes"],
        "row":0,"column":0,"text":text}])
}
fn prepare(s: &NativeSession, command: &Value) -> NativePreparedCommands {
    s.prepare_commands(revision(s), command.to_string(), "native-table".into(), 0)
        .unwrap()
}
fn assert_table_catalog(s: &NativeSession, available: bool, admitted: bool, now: u64) {
    let catalog = s.command_catalog(now).unwrap();
    let route = catalog.routes.iter().find(|r| r.id == "tableCell").unwrap();
    assert_eq!(
        (route.available, route.can_prepare),
        (available, available && admitted)
    );
    let profile = catalog
        .profiles
        .iter()
        .find(|r| r.id == "editac.tables")
        .unwrap();
    assert_eq!(profile.available, available);
    if available {
        assert_eq!(
            profile.reason,
            "bounded-v1-cell-command-target-check-required"
        );
    }
}
#[test]
fn default_off_activation_cancel_cell_history_and_durable_reopen() {
    let f = Fixture::new();
    let s = f.open();
    let before = visible(&s);
    let rev = revision(&s);
    let c = command(&s, "Header 🦀אב!");
    assert_table_catalog(&s, false, true, 0);
    assert!(matches!(
        s.check_commands(rev.clone(), c.to_string(), "check".into(), 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    s.set_table_policy(true).unwrap();
    assert_table_catalog(&s, true, true, 0);
    s.check_commands(rev.clone(), c.to_string(), "check".into(), 0)
        .unwrap();
    let p = prepare(&s, &c);
    assert_eq!(visible(&s), before);
    assert_eq!(revision(&s), rev);
    s.cancel_commands(p.token.clone()).unwrap();
    s.cancel_commands(p.token.clone()).unwrap();
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert_eq!(s.read(0).unwrap().pending_upload, 0);
    let p = prepare(&s, &c);
    let receipt = s.commit_commands(p.token, 0).unwrap().unwrap();
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.checksum.len(), 32);
    let after = visible(&s);
    assert_ne!(after, before);
    assert_eq!(after[1]["id"], before[1]["id"]);
    assert_eq!(
        after[1]["blockAttributes"][2]["rows"][0][0][0][0],
        "Header 🦀אב!"
    );
    assert_eq!(
        after[1]["blockAttributes"][2]["rows"][1],
        before[1]["blockAttributes"][2]["rows"][1]
    );
    assert_eq!(after[2], before[2]);
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    s.undo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(visible(&s), before);
    s.redo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(visible(&s), after);
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(visible(&reopened), after);
    assert_table_catalog(&reopened, false, true, 0);
    assert_eq!(reopened.history_state(0).unwrap().undo_groups, 0);
    // Default-off table policy does not affect ordinary paragraph commands.
    let owner = after[0]["id"].as_str().unwrap();
    let p = prepare(
        &reopened,
        &json!([{"type":"replaceAt","owner":owner,"from":0,"to":6,"text":"paragraph"}]),
    );
    reopened.commit_commands(p.token, 0).unwrap().unwrap();
    assert_eq!(visible(&reopened)[0]["runs"][0]["text"], "paragraph");
    reopened.dispose().unwrap();
    assert!(matches!(
        reopened.set_table_policy(true),
        Err(NativeSessionError::Disposed)
    ));
}
#[test]
fn disabling_after_prepare_rechecks_policy_and_history_without_mutation() {
    let f = Fixture::new();
    let s = f.open();
    s.set_table_policy(true).unwrap();
    let before = visible(&s);
    let rev = revision(&s);
    let p = prepare(&s, &command(&s, "changed"));
    s.set_table_policy(false).unwrap();
    assert_table_catalog(&s, false, true, 0);
    assert!(matches!(
        s.commit_commands(p.token.clone(), 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert_eq!(visible(&s), before);
    assert_eq!(revision(&s), rev);
    assert_eq!(s.read(0).unwrap().pending_upload, 0);
    s.set_table_policy(true).unwrap();
    let p = prepare(&s, &command(&s, "changed"));
    s.commit_commands(p.token, 0).unwrap();
    let after = visible(&s);
    let rev = revision(&s);
    s.set_table_policy(false).unwrap();
    assert!(!s.history_state(0).unwrap().can_undo);
    assert!(matches!(
        s.undo(rev.clone(), 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    assert_eq!(visible(&s), after);
    assert_eq!(revision(&s), rev);
    s.set_table_policy(true).unwrap();
    s.undo(rev, 0).unwrap();
    assert_eq!(visible(&s), before);
}
#[test]
fn policy_does_not_grant_permission_and_expiry_rechecks_retained_plan() {
    let f = Fixture::new();
    let s = f.open();
    s.set_permission(false, None).unwrap();
    s.set_table_policy(true).unwrap();
    assert_table_catalog(&s, true, false, 0);
    let before = visible(&s);
    let rev = revision(&s);
    let c = command(&s, "denied");
    assert!(
        s.prepare_commands(rev.clone(), c.to_string(), "denied".into(), 0)
            .is_err()
    );
    s.set_permission(true, Some(10)).unwrap();
    let p = prepare(&s, &c);
    assert!(s.commit_commands(p.token, 10).is_err());
    assert_eq!(visible(&s), before);
    assert_eq!(revision(&s), rev);
    assert_eq!(s.read(0).unwrap().pending_upload, 0);
    s.set_permission(true, None).unwrap();
    let p = prepare(&s, &c);
    s.set_permission(false, None).unwrap();
    assert!(s.commit_commands(p.token, 0).is_err());
    assert_eq!(visible(&s), before);
    assert_eq!(revision(&s), rev);
}
#[test]
fn invalid_table_targets_tuples_indices_unicode_and_limits_are_zero_mutation() {
    let f = Fixture::new();
    let s = f.open();
    s.set_table_policy(true).unwrap();
    let before = visible(&s);
    let rev = revision(&s);
    let valid = command(&s, "valid");
    let mut cases = Vec::new();
    for (key, value) in [
        ("owner", json!("foreign")),
        ("row", json!(128)),
        ("column", json!(32)),
        ("row", json!(-1)),
        ("text", json!("line\nbreak")),
        ("expected", json!(["module:editac.table", 99, {}])),
    ] {
        let mut c = valid.clone();
        c[0][key] = value;
        cases.push(c.to_string());
    }
    let mut c = valid.clone();
    c[0]["owner"] = before[0]["id"].clone();
    cases.push(c.to_string());
    let mut c = valid.clone();
    c[0]["text"] = json!("x".repeat(1_048_577));
    cases.push(c.to_string());
    cases.push(valid.to_string().replace("valid", "\\ud800"));
    // A valid v2 tuple is still not a supported v1 cell target.
    let mut c = valid.clone();
    c[0]["owner"] = before[2]["id"].clone();
    c[0]["expected"] = before[2]["blockAttributes"].clone();
    cases.push(c.to_string());
    for c in cases {
        assert!(
            s.check_commands(rev.clone(), c.clone(), "invalid".into(), 0)
                .is_err()
        );
        assert!(
            s.prepare_commands(rev.clone(), c, "invalid".into(), 0)
                .is_err()
        );
        assert_eq!(visible(&s), before);
        assert_eq!(revision(&s), rev);
        assert_eq!(s.history_state(0).unwrap().undo_groups, 0);
        assert_eq!(s.read(0).unwrap().pending_upload, 0);
    }
}
#[test]
fn stale_revision_and_tuple_reject_without_second_commit() {
    let f = Fixture::new();
    let s = f.open();
    s.set_table_policy(true).unwrap();
    let stale = command(&s, "stale");
    let p = prepare(&s, &stale);
    let next = prepare(&s, &command(&s, "new"));
    s.commit_commands(next.token, 0).unwrap();
    let after = visible(&s);
    let rev = revision(&s);
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::Revision { .. })
    ));
    assert!(
        s.prepare_commands(rev.clone(), stale.to_string(), "stale-tuple".into(), 0)
            .is_err()
    );
    assert_eq!(visible(&s), after);
    assert_eq!(revision(&s), rev);
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    assert_eq!(s.read(0).unwrap().pending_upload, 1);
}
#[test]
fn toggling_tables_preserves_other_host_policy_limits() {
    let f = Fixture::new();
    let s = f.open();
    s.call(|state| {
        state.service.set_policy(HostPolicy {
            max_commands: 0,
            writable: false,
            ..HostPolicy::default()
        });
        Ok(())
    })
    .unwrap();
    s.set_table_policy(true).unwrap();
    s.set_table_policy(false).unwrap();
    s.call(|state| {
        let p = state.service.capabilities(0).policy;
        assert!(!p.writable);
        assert_eq!(p.max_commands, 0);
        Ok(())
    })
    .unwrap();
}
fn fault_recovery(error: PortError, boundary: FaultBoundary) {
    let f = Fixture::new();
    let s = f.open();
    s.set_table_policy(true).unwrap();
    let before = visible(&s);
    let c = command(&s, "retained 🦀אב");
    let p = prepare(&s, &c);
    f.store
        .inject_once(InjectedFault { boundary, error })
        .unwrap();
    assert!(matches!(
        s.commit_commands(p.token.clone(), 0),
        Err(NativeSessionError::Store { .. })
    ));
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    let r = s.read(0).unwrap();
    assert!(r.recovery_required && !r.locally_committed && r.revision.is_none());
    assert!(!r.can_apply && !r.can_history);
    let export = s.recovery_export().unwrap();
    assert!(!export.locally_committed);
    assert!(export.unjournaled_update.is_some());
    assert!(s.rich_snapshot().is_err());
    assert!(s.undo(vec![], 0).is_err());
    s.set_table_policy(false).unwrap();
    s.set_table_policy(true).unwrap();
    assert!(!s.read(0).unwrap().can_apply);
    s.recover().unwrap();
    s.recover().unwrap();
    let after = visible(&s);
    assert_ne!(after, before);
    assert_eq!(
        after[1]["blockAttributes"][2]["rows"][0][0][0][0],
        "retained 🦀אב"
    );
    let r = s.read(0).unwrap();
    assert!(r.locally_committed && !r.recovery_required);
    assert_eq!(r.pending_upload, 1);
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(visible(&reopened), after);
    reopened.dispose().unwrap();
}
#[test]
fn table_append_quota_preserves_accepted_update_and_recovers_once() {
    fault_recovery(PortError::Quota, FaultBoundary::BeforeCommit);
}
#[test]
fn table_lost_append_ack_recovers_without_duplicate_journal() {
    fault_recovery(PortError::CommitUnknown, FaultBoundary::AfterCommit);
}
