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
        Self::with_unmerged_v2(false)
    }
    fn with_unmerged_v2(unmerged: bool) -> Self {
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
        let mut corpus: Value = serde_json::from_str(include_str!(
            "../../../native/macos/tests/TablesFixture/corpus.json"
        ))
        .unwrap();
        if unmerged {
            let cell = json!({"paragraphs":[{"style":["heading",2],"runs":[["rich 😀",[["bold"]]]]}],"rowSpan":1,"columnSpan":1,"header":true});
            corpus[2]["attributes"]["tuple"][2]["rows"] =
                json!([[cell, cell, cell], [cell, cell, cell]]);
        }
        let corpus: Vec<TransferBlock> = serde_json::from_value(corpus).unwrap();
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
    for id in ["tableCell", "tableStructure"] {
        let route = catalog.routes.iter().find(|r| r.id == id).unwrap();
        assert_eq!(
            (route.available, route.can_prepare),
            (available, available && admitted)
        );
    }
    let profile = catalog
        .profiles
        .iter()
        .find(|r| r.id == "editac.tables")
        .unwrap();
    assert_eq!(profile.available, available);
    if available {
        assert_eq!(
            profile.reason,
            "bounded-v1-v2-cell-unmerged-structure-target-check-required"
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
    // V2 covered positions remain unsupported cell targets.
    let mut c = valid.clone();
    c[0]["owner"] = before[2]["id"].clone();
    c[0]["column"] = json!(2);
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

#[test]
fn portable_cell_and_structure_both_versions_commit_history_reopen_and_reject_stale_captures() {
    for table_index in [1, 2] {
        let f = Fixture::with_unmerged_v2(true);
        let s = f.open();
        s.set_table_policy(true).unwrap();
        let original = visible(&s);
        let table = &original[table_index];
        let owner = table["id"].clone();
        let captured = json!([{"type":"tableCell","owner":owner,"expected":table["blockAttributes"],"row":0,"column":0,"text":"rich X😀"}]);
        let p = prepare(&s, &captured);
        s.commit_commands(p.token, 0).unwrap().unwrap();
        let edited = visible(&s);
        assert_ne!(edited, original);
        let mut receipts = 1;
        for action in ["insertRow", "insertColumn", "deleteRow", "deleteColumn"] {
            let before = visible(&s);
            let t = &before[table_index];
            let c = json!([{"type":"tableStructure","owner":owner,"expected":t["blockAttributes"],"action":action,"index":1}]);
            let p = prepare(&s, &c);
            assert_eq!(visible(&s), before);
            let receipt = s.commit_commands(p.token, 0).unwrap().unwrap();
            receipts += 1;
            assert_eq!(receipt.sequence, receipts);
            assert_eq!(visible(&s)[table_index]["id"], owner);
        }
        assert_eq!(visible(&s), edited);
        assert_eq!(s.history_state(0).unwrap().undo_groups, 5);
        assert!(
            s.check_commands(revision(&s), captured.to_string(), "stale".into(), 0)
                .is_err()
        );
        for _ in 0..5 {
            s.undo(revision(&s), 0).unwrap().unwrap();
        }
        assert_eq!(visible(&s), original);
        for _ in 0..5 {
            s.redo(revision(&s), 0).unwrap().unwrap();
        }
        assert_eq!(visible(&s), edited);
        let c = json!([{"type":"tableStructure","owner":owner,"expected":edited[table_index]["blockAttributes"],"action":"insertRow","index":0}]);
        let p = prepare(&s, &c);
        s.set_table_policy(false).unwrap();
        assert!(matches!(
            s.commit_commands(p.token, 0),
            Err(NativeSessionError::UnsupportedModule)
        ));
        assert_eq!(visible(&s), edited);
        s.dispose().unwrap();
        let reopened = f.open();
        assert_eq!(visible(&reopened), edited);
        assert_table_catalog(&reopened, false, true, 0);
        reopened.dispose().unwrap();
    }
}

// STB-1.3: separate SQLite stores, one existing Session/engine in each native worker.
fn remote_peer(f: &Fixture) -> (Arc<NativeStore>, Arc<NativeSession>) {
    let store = Arc::new(
        NativeStore::create_new(
            f.directory.join("peer.sqlite"),
            f.id.clone(),
            StoreLimits::default(),
        )
        .unwrap(),
    );
    store
        .publish(0, f.store.recover(&f.id).unwrap().checkpoint)
        .unwrap();
    let other = store.clone();
    let id = f.id.clone();
    let peer = NativeSession::start(move || {
        State::new(Session::open(other, &id, CachedPermission::LOCAL)?)
    })
    .unwrap();
    peer.set_table_policy(true).unwrap();
    (store, peer)
}
fn remote_edit(
    peer: &NativeSession,
    table_index: usize,
    structural: bool,
) -> NativeSessionPeerUpdate {
    let nodes = visible(peer);
    let t = &nodes[table_index];
    let c = if structural {
        json!([{"type":"tableStructure","owner":t["id"],"expected":t["blockAttributes"],"action":"insertColumn","index":1}])
    } else {
        json!([{"type":"tableCell","owner":t["id"],"expected":t["blockAttributes"],"row":0,"column":0,"text":format!("remote 🦀אב {}",peer.pending_updates().unwrap().len())}])
    };
    let p = prepare(peer, &c);
    let commit = peer.commit_commands(p.token, 0).unwrap().unwrap();
    peer.pending_updates()
        .unwrap()
        .into_iter()
        .find(|e| e.writer == commit.writer && e.sequence == commit.sequence)
        .unwrap()
}
#[test]
fn remote_native_distinct_sqlite_v1_v2_cell_structure_stale_projection_anchor_and_history() {
    for table_index in [1, 2] {
        for structural in [false, true] {
            let f = Fixture::with_unmerged_v2(true);
            let local = f.open();
            local.set_table_policy(true).unwrap();
            let (peer_store, peer) = remote_peer(&f);
            assert_ne!(peer_store.path(), f.store.path());
            let nodes = visible(&local);
            let paragraph = nodes[0]["id"].as_str().unwrap().to_owned();
            let text = local
                .prepare_edits(
                    revision(&local),
                    vec![NativeSessionEdit {
                        node: paragraph.clone(),
                        from_utf16: 0,
                        to_utf16: 0,
                        text: "LOCAL ".into(),
                    }],
                    "local-typing".into(),
                    0,
                )
                .unwrap();
            local.commit_edits(text, 0).unwrap().unwrap();
            let captured = prepare(&local, &command(&local, "stale"));
            let old = revision(&local);
            let anchor = local
                .capture_anchors(
                    old.clone(),
                    vec![crate::AnchorInput {
                        node: paragraph.clone(),
                        offset_utf16: 1,
                        bias: crate::AnchorBias::Right,
                    }],
                )
                .unwrap()
                .remove(0);
            let table_anchor = local
                .capture_anchors(
                    old.clone(),
                    vec![crate::AnchorInput {
                        node: nodes[table_index]["id"].as_str().unwrap().into(),
                        offset_utf16: 0,
                        bias: crate::AnchorBias::Right,
                    }],
                )
                .unwrap()
                .remove(0);
            let cancelled = prepare(&local, &command(&local, "cancelled"));
            let projection = local.rich_snapshot().unwrap();
            let entry = remote_edit(&peer, table_index, structural);
            local.reserve_peer_writer(entry.writer).unwrap();
            let receipt = local.receive_peer(entry.clone()).unwrap();
            assert_eq!(receipt.checksum, entry.checksum);
            assert_eq!(receipt.durability, NativeSessionDurability::ProcessCrash);
            let patches = local.take_rich_patches(projection.sequence).unwrap();
            assert!(!patches.patches_json.is_empty());
            assert_ne!(patches.revision, old);
            let selection = local.resolve_anchor(table_anchor.token).unwrap();
            assert_eq!(selection.revision, patches.revision);
            assert!(
                matches!(selection.resolution, NativeAnchorResolution::Position {ref node, ..} if node == nodes[table_index]["id"].as_str().unwrap())
            );
            local.cancel_commands(cancelled.token.clone()).unwrap();
            assert!(matches!(
                local.commit_commands(cancelled.token, 0),
                Err(NativeSessionError::InvalidPlan)
            ));
            assert_eq!(
                local.resolve_anchor(anchor.token.clone()).unwrap().revision,
                patches.revision
            );
            assert!(matches!(
                local.commit_commands(captured.token, 0),
                Err(NativeSessionError::Revision {
                    reason: NativeRevisionFailure::Stale,
                    ..
                })
            ));
            let after = visible(&local);
            assert_eq!(after[table_index], visible(&peer)[table_index]);
            assert!(after[0]["runs"].to_string().contains("LOCAL"));
            let history = local.history_state(0).unwrap();
            assert_eq!(history.undo_groups, 1);
            local.undo(revision(&local), 0).unwrap().unwrap();
            let undone = visible(&local);
            assert_eq!(undone[table_index], after[table_index]);
            assert!(!undone[0]["runs"].to_string().contains("LOCAL"));
            local.redo(revision(&local), 0).unwrap().unwrap();
            assert_eq!(visible(&local), after);
            let before_duplicate = revision(&local);
            local.receive_peer(entry).unwrap();
            assert_eq!(revision(&local), before_duplicate);
            local.dispose().unwrap();
            let reopened = f.open();
            assert_eq!(visible(&reopened), after);
            assert!(matches!(
                reopened.resolve_anchor(anchor.token),
                Err(NativeSessionError::InvalidAnchor)
            ));
            reopened.dispose().unwrap();
            peer.dispose().unwrap();
        }
    }
}
#[test]
fn remote_native_scope_digest_malformed_limits_and_reservation_reject_without_mutation() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let entry = remote_edit(&peer, 1, false);
    let baseline = visible(&local);
    let before = revision(&local);
    let mut bad = entry.clone();
    bad.identity_json = "{}".into();
    assert!(matches!(
        local.receive_peer(bad),
        Err(NativeSessionError::Incompatible)
    ));
    for (field, value) in [
        ("documentId", json!("foreign")),
        ("epoch", json!("foreign")),
        ("schema", json!("future")),
        ("profile", json!("future")),
        ("protocolVersion", json!(999)),
        ("updateEncoding", json!(999)),
        ("offsets", json!("bytes")),
    ] {
        let mut bad = entry.clone();
        let mut id: Value = serde_json::from_str(&bad.identity_json).unwrap();
        id[field] = value;
        bad.identity_json = id.to_string();
        assert!(matches!(
            local.receive_peer(bad),
            Err(NativeSessionError::Incompatible)
        ));
    }
    let other = Fixture::new();
    let (_, foreign) = remote_peer(&other);
    let mut foreign_entry = remote_edit(&foreign, 1, false);
    foreign_entry.identity_json = entry.identity_json.clone();
    assert!(local.receive_peer(foreign_entry).is_err());
    foreign.dispose().unwrap();
    let mut bad = entry.clone();
    bad.checksum[0] ^= 1;
    assert!(matches!(
        local.receive_peer(bad),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Integrity
        })
    ));
    let mut bad = entry.clone();
    bad.identity_json = "{".into();
    assert!(local.receive_peer(bad).is_err());
    let mut bad = entry.clone();
    bad.checksum.clear();
    assert!(local.receive_peer(bad).is_err());
    let mut bad = entry.clone();
    bad.bytes = vec![0; StoreLimits::default().max_record_bytes + 1];
    assert!(matches!(
        local.receive_peer(bad),
        Err(NativeSessionError::ResourceLimit)
    ));
    let mut bad = entry.clone();
    bad.sequence = 0;
    assert!(local.receive_peer(bad).is_err());
    // Well-digested but malformed engine bytes still stage before any store mutation.
    let malformed = editac_session::ports::JournalEntry::new(
        f.id.clone(),
        entry.writer,
        1,
        "remote".into(),
        vec![255; 16],
    )
    .unwrap();
    assert!(local.receive_peer((&malformed).into()).is_err());
    assert_eq!(visible(&local), baseline);
    assert_eq!(revision(&local), before);
    assert!(f.store.recover(&f.id).unwrap().journal.is_empty());
    assert!(matches!(
        local.reserve_peer_writer(0),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::InvalidRecord
        })
    ));
    assert!(matches!(
        local.receive_peer(entry.clone()),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Permission
        })
    ));
    assert!(local.read(0).unwrap().recovery_required);
    local.recover().unwrap();
    local.reserve_peer_writer(entry.writer).unwrap();
    assert!(matches!(
        local.reserve_peer_writer(entry.writer),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Conflict
        })
    ));
    // Local write permission is distinct from host-admitted inbound work.
    local.set_permission(false, Some(0)).unwrap();
    local.receive_peer(entry.clone()).unwrap();
    assert_eq!(visible(&local)[1], visible(&peer)[1]);
    assert!(!local.read(1).unwrap().can_apply);
    local.dispose().unwrap();
    assert!(matches!(
        local.receive_peer(entry),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        local.pending_updates(),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        local.reserve_peer_writer(123),
        Err(NativeSessionError::Disposed)
    ));
}
#[test]
fn remote_native_order_conflict_and_store_failure_recover_exactly() {
    for (boundary, error) in [
        (FaultBoundary::BeforeCommit, PortError::Quota),
        (FaultBoundary::AfterCommit, PortError::CommitUnknown),
    ] {
        let f = Fixture::new();
        let local = f.open();
        let (_, peer) = remote_peer(&f);
        let first = remote_edit(&peer, 1, false);
        local.reserve_peer_writer(first.writer).unwrap();
        let before = visible(&local);
        f.store
            .inject_once(InjectedFault { boundary, error })
            .unwrap();
        assert!(matches!(
            local.receive_peer(first.clone()),
            Err(NativeSessionError::Store { .. })
        ));
        assert_eq!(visible_recovery(&local), before);
        assert!(local.read(0).unwrap().recovery_required);
        assert!(matches!(
            local.pending_updates(),
            Err(NativeSessionError::RecoveryRequired)
        ));
        assert!(local.receive_peer(first.clone()).is_err());
        assert_eq!(
            f.store.recover(&f.id).unwrap().journal.len(),
            usize::from(boundary == FaultBoundary::AfterCommit)
        );
        local.recover().unwrap();
        local.receive_peer(first.clone()).unwrap();
        assert_eq!(visible(&local)[1], visible(&peer)[1]);
        assert_eq!(f.store.recover(&f.id).unwrap().journal.len(), 1);
        let second = remote_edit(&peer, 1, false); // second same text: still a valid next real transaction
        let mut gap = second.clone();
        gap.sequence += 1;
        assert!(matches!(
            local.receive_peer(gap),
            Err(NativeSessionError::Store {
                reason: NativeStoreFailure::Sequence
            })
        ));
        local.recover().unwrap();
        local.receive_peer(second).unwrap();
        let mut conflict = first.clone();
        conflict.origin = "different".into();
        assert!(matches!(
            local.receive_peer(conflict),
            Err(NativeSessionError::Store {
                reason: NativeStoreFailure::Integrity
            })
        ));
        local.recover().unwrap();
        assert_eq!(visible(&local)[1], visible(&peer)[1]);
        local.dispose().unwrap();
        assert_eq!(visible(&f.open())[1], visible(&peer)[1]);
    }
}
fn visible_recovery(s: &NativeSession) -> Value {
    s.call(|state| {
        Ok(
            editac_core::interchange::projection_snapshot(state.service.session().document())
                .unwrap()["visible"]
                .clone(),
        )
    })
    .unwrap()
}

#[test]
fn remote_native_accepted_ingress_finishes_before_dispose_and_cannot_be_cancelled_back() {
    use editac_session::store::TransactionBoundary;
    use std::sync::atomic::AtomicBool;
    let f = Fixture::new();
    let (_, peer) = remote_peer(&f);
    let entry = remote_edit(&peer, 1, false);
    let armed = Arc::new(AtomicBool::new(false));
    let flag = armed.clone();
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let observed = Arc::new(
        NativeStore::open_existing_observed(
            f.store.path(),
            f.id.clone(),
            StoreLimits::default(),
            Some(Arc::new(move |boundary| {
                if boundary == TransactionBoundary::BeforeCommit
                    && flag.swap(false, Ordering::SeqCst)
                {
                    entered_tx.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
            })),
        )
        .unwrap(),
    );
    let id = f.id.clone();
    let local = NativeSession::start(move || {
        State::new(Session::open(observed, &id, CachedPermission::LOCAL)?)
    })
    .unwrap();
    local.set_table_policy(true).unwrap();
    local.reserve_peer_writer(entry.writer).unwrap();
    let cancel = prepare(&local, &command(&local, "cancelled"));
    local.cancel_commands(cancel.token.clone()).unwrap();
    armed.store(true, Ordering::SeqCst);
    let ingress_owner = local.clone();
    let ingress = thread::spawn(move || ingress_owner.receive_peer(entry));
    entered_rx.recv().unwrap();
    assert!(local.worker.try_lock().is_err());
    let disposal_owner = local.clone();
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let disposal = thread::spawn(move || {
        disposal_owner.dispose().unwrap();
        done_tx.send(()).unwrap();
    });
    assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    release_tx.send(()).unwrap();
    assert_eq!(
        ingress.join().unwrap().unwrap().durability,
        NativeSessionDurability::ProcessCrash
    );
    disposal.join().unwrap();
    assert!(matches!(
        local.commit_commands(cancel.token, 0),
        Err(NativeSessionError::Disposed)
    ));
    let reopened = f.open();
    assert_eq!(visible(&reopened)[1], visible(&peer)[1]);
    assert_eq!(f.store.recover(&f.id).unwrap().journal.len(), 1);
    reopened.dispose().unwrap();
    peer.dispose().unwrap();
}
