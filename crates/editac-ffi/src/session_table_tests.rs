//! Actual Session/SQLite table admission and shared collaboration lifecycle.
//! Corpus is prepared baseline data only;
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
        Self::with_corpus(unmerged, false)
    }
    fn attachments() -> Self {
        Self::with_corpus(false, true)
    }
    fn with_corpus(unmerged: bool, attachments: bool) -> Self {
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
        let mut corpus: Value = serde_json::from_str(if attachments {
            include_str!("../../../native/macos/tests/AttachmentsFixture/corpus.json")
        } else {
            include_str!("../../../native/macos/tests/TablesFixture/corpus.json")
        })
        .unwrap();
        if attachments {
            corpus[0]["runs"][0]["marks"] = json!([{"mark":"bold"}]);
            corpus[3]["runs"][0]["marks"] = json!([{"mark":"italic"}]);
        }
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

fn host_options(s: &NativeSession) -> NativeHostTransportOptions {
    let identity_json = s
        .call(|state| {
            Ok(
                editac_core::interchange::identity(state.service.session().document().identity())
                    .to_string(),
            )
        })
        .unwrap();
    NativeHostTransportOptions {
        identity_json,
        expires_at: 100,
        durable_receipts: true,
        max_frame_bytes: 1024 * 1024,
        max_queue_bytes: 2 * 1024 * 1024,
        max_queue_frames: 32,
    }
}
fn host_attach(s: &NativeSession) -> String {
    s.attach_host_transport(host_options(s), 0).unwrap()
}
fn host_receipt(update: &NativeSessionPeerUpdate) -> NativeHostReceipt {
    NativeHostReceipt {
        identity_json: update.identity_json.clone(),
        writer: update.writer,
        sequence: update.sequence,
        checksum: update.checksum.clone(),
    }
}

#[test]
fn host_transport_distinct_sqlite_table_frames_converge_receipt_reconnect_and_reopen() {
    for (table, structural) in [(1, false), (2, false), (1, true), (2, true)] {
        let f = Fixture::with_unmerged_v2(true);
        let local = f.open();
        let (_, peer) = remote_peer(&f);
        let left = host_attach(&local);
        let right = host_attach(&peer);
        let update = remote_edit(&peer, table, structural);
        local.reserve_peer_writer(update.writer).unwrap();
        assert_eq!(peer.flush_host_transport(right.clone(), 0).unwrap(), 1);
        let frames = peer.take_host_frames(right.clone(), 32, 0).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].identity_json, update.identity_json);
        assert_eq!(frames[0].bytes[0], 2); // Existing y-protocols update frame.
        assert!(frames[0].bytes.ends_with(&update.bytes));
        assert_eq!(peer.pending_updates().unwrap().len(), 1); // send is not durability
        let commit = local
            .receive_host_peer(left.clone(), update.clone(), 0)
            .unwrap();
        assert_eq!(
            (commit.writer, commit.sequence, commit.checksum),
            (update.writer, update.sequence, update.checksum.clone())
        );
        assert_eq!(visible(&local)[table], visible(&peer)[table]);
        // Reconnect without an ack replays the same durable entry; no new edit/history.
        peer.detach_host_transport(right.clone()).unwrap();
        let replacement = host_attach(&peer);
        assert_ne!(right, replacement);
        assert!(peer.flush_host_transport(right, 0).is_err());
        assert_eq!(
            peer.flush_host_transport(replacement.clone(), 0).unwrap(),
            1
        );
        local.receive_host_peer(left, update.clone(), 0).unwrap();
        assert_eq!(f.store.recover(&f.id).unwrap().journal.len(), 1);
        assert_eq!(
            peer.accept_host_receipt(replacement.clone(), host_receipt(&update), 0)
                .unwrap(),
            NativeHostReceiptResult::RemoteCommitted
        );
        assert!(peer.pending_updates().unwrap().is_empty());
        assert_eq!(
            peer.accept_host_receipt(replacement.clone(), host_receipt(&update), 0)
                .unwrap(),
            NativeHostReceiptResult::RemoteCommitted
        );
        assert_eq!(peer.flush_host_transport(replacement, 0).unwrap(), 0);
        local.dispose().unwrap();
        let reopened = f.open();
        assert_eq!(visible(&reopened)[table], visible(&peer)[table]);
        assert_eq!(reopened.history_state(0).unwrap().undo_groups, 0);
    }
}

#[test]
fn host_transport_invalid_attach_preserves_connection_and_old_tokens_never_affect_new_lease() {
    let f = Fixture::new();
    let local = f.open();
    let token = host_attach(&local);
    let before = visible(&local);
    for invalid in 0..8 {
        let mut options = host_options(&local);
        match invalid {
            0 => options.identity_json = "{}".into(),
            1 => options.identity_json = "[".into(),
            2 => options.expires_at = 0,
            3 => options.max_frame_bytes = 0,
            4 => options.max_queue_bytes = 33 * 1024 * 1024,
            5 => options.max_queue_frames = 33,
            6 => options.max_frame_bytes = 17 * 1024 * 1024,
            _ => options.max_queue_bytes = 1,
        }
        assert!(local.attach_host_transport(options, 0).is_err());
        assert_eq!(local.flush_host_transport(token.clone(), 0).unwrap(), 0);
    }
    let new = host_attach(&local);
    assert!(local.detach_host_transport(token.clone()).is_err());
    assert!(local.take_host_frames(token, 32, 0).is_err());
    assert_eq!(local.flush_host_transport(new.clone(), 0).unwrap(), 0);
    let other = f.open();
    assert!(other.flush_host_transport(new, 0).is_err());
    assert_eq!(visible(&local), before);
    assert!(f.store.recover(&f.id).unwrap().journal.is_empty());
}

#[test]
fn host_transport_exclusive_expiry_revocation_rejoin_and_local_permission_are_independent() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let token = host_attach(&local);
    let update = remote_edit(&peer, 1, false);
    local.reserve_peer_writer(update.writer).unwrap();
    assert!(local.flush_host_transport(token.clone(), 99).is_ok());
    assert!(matches!(
        local.flush_host_transport(token.clone(), 100),
        Err(NativeSessionError::Unauthorized)
    ));
    assert!(local.take_host_frames(token.clone(), 1, 100).is_err());
    assert!(
        local
            .receive_host_peer(token.clone(), update.clone(), 100)
            .is_err()
    );
    assert!(
        local
            .accept_host_receipt(token.clone(), host_receipt(&update), 100)
            .is_err()
    );
    local.detach_host_transport(token.clone()).unwrap(); // expired lease can be revoked
    assert!(local.receive_host_peer(token, update.clone(), 0).is_err());
    let mut options = host_options(&local);
    options.expires_at = 200;
    let new = local.attach_host_transport(options, 100).unwrap();
    local.set_permission(false, None).unwrap();
    local
        .receive_host_peer(new.clone(), update.clone(), 100)
        .unwrap();
    assert_eq!(visible(&local)[1], visible(&peer)[1]);
    assert!(!local.read(100).unwrap().can_apply);
    local.set_permission(true, Some(100)).unwrap();
    local.receive_host_peer(new.clone(), update, 101).unwrap();
    assert!(!local.read(101).unwrap().can_apply);
    local.dispose().unwrap();
    assert!(matches!(
        local.flush_host_transport(new, 0),
        Err(NativeSessionError::Disposed)
    ));
}

#[test]
fn host_transport_backpressure_keeps_prefix_and_durable_outbox_and_receipts_are_exact() {
    let f = Fixture::new();
    let s = f.open();
    s.set_table_policy(true).unwrap();
    let first = remote_edit(&s, 1, false);
    let _second = remote_edit(&s, 2, false);
    let mut options = host_options(&s);
    options.max_queue_frames = 1;
    options.durable_receipts = false;
    let token = s.attach_host_transport(options, 0).unwrap();
    assert!(matches!(
        s.flush_host_transport(token.clone(), 0),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Backpressure
        })
    ));
    assert_eq!(s.pending_updates().unwrap().len(), 2);
    assert!(s.take_host_frames(token.clone(), 0, 0).is_err());
    assert!(s.take_host_frames(token.clone(), 33, 0).is_err());
    assert_eq!(s.take_host_frames(token.clone(), 32, 0).unwrap().len(), 1);
    assert!(s.take_host_frames(token.clone(), 1, 0).unwrap().is_empty());
    assert_eq!(
        s.accept_host_receipt(token.clone(), host_receipt(&first), 0)
            .unwrap(),
        NativeHostReceiptResult::CapabilityUnavailable
    );
    let new = host_attach(&s);
    let mut wrong = host_receipt(&first);
    wrong.sequence += 999;
    assert_eq!(
        s.accept_host_receipt(new.clone(), wrong, 0).unwrap(),
        NativeHostReceiptResult::UnknownUpdate
    );
    let mut wrong = host_receipt(&first);
    wrong.checksum[0] ^= 1;
    assert_eq!(
        s.accept_host_receipt(new.clone(), wrong, 0).unwrap(),
        NativeHostReceiptResult::UnknownUpdate
    );
    let mut wrong = host_receipt(&first);
    wrong.identity_json = "{}".into();
    assert!(s.accept_host_receipt(new.clone(), wrong, 0).is_err());
    assert_eq!(s.pending_updates().unwrap().len(), 2);
    assert_eq!(
        s.accept_host_receipt(new, host_receipt(&first), 0).unwrap(),
        NativeHostReceiptResult::RemoteCommitted
    );
    assert_eq!(s.pending_updates().unwrap().len(), 1);
}

#[test]
fn host_transport_frame_and_scope_guards_reject_before_mutation() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let update = remote_edit(&peer, 1, false);
    local.reserve_peer_writer(update.writer).unwrap();
    let mut options = host_options(&local);
    options.max_frame_bytes = 1;
    let token = local.attach_host_transport(options, 0).unwrap();
    let before = visible(&local);
    assert!(matches!(
        local.receive_host_peer(token.clone(), update.clone(), 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    assert_eq!(visible(&local), before);
    let token = host_attach(&local);
    for invalid in 0..3 {
        let mut changed = update.clone();
        match invalid {
            0 => changed.identity_json = "{}".into(),
            1 => changed.checksum[0] ^= 1,
            _ => changed.bytes = vec![255],
        }
        assert!(local.receive_host_peer(token.clone(), changed, 0).is_err());
    }
    assert_eq!(visible(&local), before);
    assert!(f.store.recover(&f.id).unwrap().journal.is_empty());
    let right = host_attach(&peer);
    let mut options = host_options(&peer);
    options.max_frame_bytes = 1;
    let small = peer.attach_host_transport(options, 0).unwrap();
    assert!(peer.flush_host_transport(small.clone(), 0).is_err());
    assert!(peer.take_host_frames(small, 32, 0).unwrap().is_empty());
    assert!(peer.take_host_frames(right, 32, 0).is_err());
    assert_eq!(peer.pending_updates().unwrap().len(), 1);
}

#[test]
fn host_transport_remote_append_failure_freezes_all_ports_and_recovers_idempotently() {
    for (boundary, error) in [
        (FaultBoundary::BeforeCommit, PortError::Quota),
        (FaultBoundary::AfterCommit, PortError::CommitUnknown),
    ] {
        let f = Fixture::new();
        let local = f.open();
        let (_, peer) = remote_peer(&f);
        let token = host_attach(&local);
        let update = remote_edit(&peer, 1, false);
        local.reserve_peer_writer(update.writer).unwrap();
        f.store
            .inject_once(InjectedFault { boundary, error })
            .unwrap();
        assert!(
            local
                .receive_host_peer(token.clone(), update.clone(), 0)
                .is_err()
        );
        assert!(local.read(0).unwrap().recovery_required);
        assert!(local.take_host_frames(token.clone(), 32, 0).is_err());
        assert!(local.flush_host_transport(token.clone(), 0).is_err());
        assert!(
            local
                .accept_host_receipt(token.clone(), host_receipt(&update), 0)
                .is_err()
        );
        assert!(
            local
                .attach_host_transport(host_options(&local), 0)
                .is_err()
        );
        assert_eq!(
            f.store.recover(&f.id).unwrap().journal.len(),
            usize::from(boundary == FaultBoundary::AfterCommit)
        );
        local.recover().unwrap();
        local
            .receive_host_peer(token.clone(), update.clone(), 0)
            .unwrap();
        local.receive_host_peer(token, update, 0).unwrap();
        assert_eq!(f.store.recover(&f.id).unwrap().journal.len(), 1);
        assert_eq!(visible(&local)[1], visible(&peer)[1]);
    }
}

#[test]
fn host_transport_receipt_transaction_failure_freezes_and_preserves_exact_ack_on_recovery() {
    for (boundary, error) in [
        (FaultBoundary::BeforeCommit, PortError::Quota),
        (FaultBoundary::AfterCommit, PortError::CommitUnknown),
    ] {
        let f = Fixture::new();
        let s = f.open();
        s.set_table_policy(true).unwrap();
        let update = remote_edit(&s, 1, false);
        let token = host_attach(&s);
        f.store
            .inject_once(InjectedFault { boundary, error })
            .unwrap();
        assert!(
            s.accept_host_receipt(token.clone(), host_receipt(&update), 0)
                .is_err()
        );
        assert!(s.read(0).unwrap().recovery_required);
        assert!(s.take_host_frames(token.clone(), 32, 0).is_err());
        s.recover().unwrap();
        assert_eq!(
            s.pending_updates().unwrap().len(),
            usize::from(boundary == FaultBoundary::BeforeCommit)
        );
        assert_eq!(
            s.accept_host_receipt(token, host_receipt(&update), 0)
                .unwrap(),
            NativeHostReceiptResult::RemoteCommitted
        );
        assert!(s.pending_updates().unwrap().is_empty());
    }
}

#[test]
fn host_transport_pages_progress_without_receipts_and_reject_stale_or_foreign_cursors() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let mut options = host_options(&peer);
    options.max_queue_frames = 1;
    options.durable_receipts = false;
    let right = peer.attach_host_transport(options, 0).unwrap();
    let entries: Vec<_> = (0..3).map(|_| remote_edit(&peer, 1, false)).collect();
    local.reserve_peer_writer(entries[0].writer).unwrap();
    let mut cursor = None;
    for entry in &entries {
        assert_eq!(
            peer.flush_host_transport_page(right.clone(), cursor, 1, 0)
                .unwrap(),
            1
        );
        let frames = peer.take_host_frames(right.clone(), 1, 0).unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].bytes.ends_with(&entry.bytes));
        local
            .receive_host_peer(left.clone(), entry.clone(), 0)
            .unwrap();
        cursor = Some(host_receipt(entry));
    }
    assert_eq!(
        peer.flush_host_transport_page(right.clone(), cursor, 1, 0)
            .unwrap(),
        0
    );
    assert_eq!(peer.pending_updates().unwrap().len(), 3);
    assert_eq!(visible(&local)[1], visible(&peer)[1]);
    assert_eq!(f.store.recover(&f.id).unwrap().journal.len(), 3);
    for limit in [0, 33] {
        assert!(
            peer.flush_host_transport_page(right.clone(), None, limit, 0)
                .is_err()
        );
    }
    let mut wrong = host_receipt(&entries[0]);
    wrong.checksum[0] ^= 1;
    assert!(matches!(
        peer.flush_host_transport_page(right.clone(), Some(wrong), 1, 0),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::Conflict
        })
    ));
    let mut wrong = host_receipt(&entries[0]);
    wrong.identity_json = "{}".into();
    assert!(
        peer.flush_host_transport_page(right.clone(), Some(wrong), 1, 0)
            .is_err()
    );
    let mut wrong = host_receipt(&entries[0]);
    wrong.checksum.clear();
    assert!(
        peer.flush_host_transport_page(right.clone(), Some(wrong), 1, 0)
            .is_err()
    );
    assert!(
        peer.take_host_frames(right.clone(), 1, 0)
            .unwrap()
            .is_empty()
    );
    // A receipt may remove an old cursor. Never silently skip some new pending item.
    peer.detach_host_transport(right).unwrap();
    let new = host_attach(&peer);
    peer.accept_host_receipt(new.clone(), host_receipt(&entries[0]), 0)
        .unwrap();
    assert!(
        peer.flush_host_transport_page(new.clone(), Some(host_receipt(&entries[0])), 1, 0)
            .is_err()
    );
    assert_eq!(
        peer.flush_host_transport_page(new.clone(), None, 1, 0)
            .unwrap(),
        1
    );
    assert!(
        peer.take_host_frames(new, 1, 0).unwrap()[0]
            .bytes
            .ends_with(&entries[1].bytes)
    );
}

fn presence_range(s: &NativeSession, index: usize) -> Vec<NativeSessionAnchor> {
    let owner = visible(s)[index]["id"].as_str().unwrap().to_owned();
    s.capture_anchors(
        revision(s),
        vec![
            crate::AnchorInput {
                node: owner.clone(),
                offset_utf16: 0,
                bias: crate::AnchorBias::Left,
            },
            crate::AnchorInput {
                node: owner,
                offset_utf16: 0,
                bias: crate::AnchorBias::Right,
            },
        ],
    )
    .unwrap()
}
fn announce(
    s: &NativeSession,
    token: &str,
    range: &[NativeSessionAnchor],
    now: u64,
) -> NativeHostFrame {
    s.set_host_presence(
        token.into(),
        Some(range[0].token.clone()),
        Some(range[1].token.clone()),
        true,
        now,
    )
    .unwrap();
    assert!(s.flush_host_presence(token.into(), now).unwrap());
    s.take_host_presence_frames(token.into(), 1, now)
        .unwrap()
        .remove(0)
}
#[test]
fn presence_distinct_sqlite_remote_selection_is_ephemeral_and_tracks_actual_remote_commits() {
    let f = Fixture::with_unmerged_v2(true);
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let before = revision(&local);
    let anchors = presence_range(&peer, 2);
    let frame = announce(&peer, &right, &anchors, 0);
    local.receive_host_presence(left.clone(), frame, 0).unwrap();
    let peers = local.host_presence(left.clone(), 0).unwrap();
    assert_eq!(peers.len(), 1);
    assert!(
        matches!(&peers[0].selection.as_ref().unwrap().anchor,NativeAnchorResolution::Position{node,..} if node==visible(&local)[2]["id"].as_str().unwrap())
    );
    assert_eq!(revision(&local), before);
    assert!(local.pending_updates().unwrap().is_empty());
    assert!(peer.take_host_frames(right, 32, 0).unwrap().is_empty());
    let update = remote_edit(&peer, 2, true);
    local.reserve_peer_writer(update.writer).unwrap();
    local.receive_host_peer(left.clone(), update, 0).unwrap();
    assert_eq!(visible(&local)[2], visible(&peer)[2]);
    assert!(
        local.host_presence(left.clone(), 1).unwrap()[0]
            .selection
            .is_some()
    );
    local.detach_host_transport(left).unwrap();
    assert!(
        local
            .host_presence(host_attach(&local), 0)
            .unwrap()
            .is_empty()
    );
    local.dispose().unwrap();
    peer.dispose().unwrap();
}
#[test]
fn presence_expiry_leave_tombstones_and_duplicate_frames_cannot_resurrect() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let mut options = host_options(&local);
    options.expires_at = 100000;
    let left = local.attach_host_transport(options, 0).unwrap();
    let mut options = host_options(&peer);
    options.expires_at = 100000;
    let right = peer.attach_host_transport(options, 0).unwrap();
    let anchors = presence_range(&peer, 0);
    let frame = announce(&peer, &right, &anchors, 0);
    local
        .receive_host_presence(left.clone(), frame.clone(), 0)
        .unwrap();
    assert_eq!(local.host_presence(left.clone(), 29999).unwrap().len(), 1);
    assert!(local.host_presence(left.clone(), 30000).unwrap().is_empty());
    local
        .receive_host_presence(left.clone(), frame, 30000)
        .unwrap();
    assert!(local.host_presence(left.clone(), 30000).unwrap().is_empty());
    assert!(peer.flush_host_presence(right.clone(), 30000).unwrap()); // renewal
    let renewed = peer
        .take_host_presence_frames(right.clone(), 1, 30000)
        .unwrap()
        .remove(0);
    local
        .receive_host_presence(left.clone(), renewed.clone(), 30001)
        .unwrap();
    assert_eq!(local.host_presence(left.clone(), 30001).unwrap().len(), 1);
    peer.set_host_presence(right.clone(), None, None, false, 30050)
        .unwrap();
    assert!(peer.flush_host_presence(right.clone(), 30050).unwrap());
    let leave = peer
        .take_host_presence_frames(right, 1, 30050)
        .unwrap()
        .remove(0);
    local
        .receive_host_presence(left.clone(), leave, 30050)
        .unwrap();
    local
        .receive_host_presence(left.clone(), renewed, 30051)
        .unwrap();
    assert!(local.host_presence(left, 30051).unwrap().is_empty());
}
#[test]
fn presence_coalesces_throttles_retries_bounded_queue_and_never_drains_sync() {
    let f = Fixture::new();
    let s = f.open();
    let mut options = host_options(&s);
    options.max_queue_frames = 1;
    options.expires_at = 1000;
    let token = s.attach_host_transport(options, 0).unwrap();
    let a = presence_range(&s, 0);
    s.set_host_presence(
        token.clone(),
        Some(a[0].token.clone()),
        Some(a[1].token.clone()),
        true,
        0,
    )
    .unwrap();
    assert!(s.flush_host_presence(token.clone(), 0).unwrap());
    s.set_host_presence(token.clone(), None, None, true, 1)
        .unwrap();
    assert!(!s.flush_host_presence(token.clone(), 1).unwrap());
    assert!(!s.flush_host_presence(token.clone(), 50).unwrap()); // full
    assert_eq!(
        s.take_host_presence_frames(token.clone(), 1, 50)
            .unwrap()
            .len(),
        1
    );
    assert!(!s.flush_host_presence(token.clone(), 51).unwrap());
    assert!(s.flush_host_presence(token.clone(), 100).unwrap()); // retry retains latest state
    assert_eq!(
        s.take_host_presence_frames(token.clone(), 1, 100)
            .unwrap()
            .len(),
        1
    );
    s.detach_host_transport(token).unwrap();
    let new = host_attach(&s);
    assert!(
        s.take_host_presence_frames(new.clone(), 1, 0)
            .unwrap()
            .is_empty()
    );
    assert!(s.take_host_frames(new, 1, 0).unwrap().is_empty());
}
#[test]
fn presence_bad_frame_cursor_scope_time_and_foreign_tokens_are_zero_mutation() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let anchors = presence_range(&peer, 0);
    let frame = announce(&peer, &right, &anchors, 0);
    let before = revision(&local);
    local
        .receive_host_presence(left.clone(), frame.clone(), 0)
        .unwrap();
    for bytes in [
        vec![],
        vec![0, 0],
        vec![255; 65537],
        vec![255, 255, 255, 255, 15],
        vec![129, 0, 1, 1, 4, b'n', b'u', b'l', b'l'],
    ] {
        let mut invalid = frame.clone();
        invalid.bytes = bytes;
        assert!(
            local
                .receive_host_presence(left.clone(), invalid, 1)
                .is_err()
        );
        assert_eq!(local.host_presence(left.clone(), 1).unwrap().len(), 1);
    }
    let mut wrong = frame;
    wrong.identity_json = "{}".into();
    assert!(local.receive_host_presence(left.clone(), wrong, 1).is_err());
    assert!(
        local
            .set_host_presence(
                left.clone(),
                Some(anchors[0].token.clone()),
                Some(anchors[1].token.clone()),
                true,
                1
            )
            .is_err()
    );
    assert!(
        local
            .set_host_presence(left.clone(), None, Some(anchors[1].token.clone()), true, 1)
            .is_err()
    );
    assert!(local.host_presence(left.clone(), 0).is_err());
    assert_eq!(revision(&local), before);
    assert!(local.pending_updates().unwrap().is_empty());
    assert!(local.take_host_presence_frames(left, 0, 1).is_err());
}
#[test]
fn presence_revocation_rejoin_wrong_document_late_events_and_disposal_are_scoped() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let frame = announce(&peer, &right, &presence_range(&peer, 0), 0);
    local
        .receive_host_presence(left.clone(), frame.clone(), 0)
        .unwrap();
    local.set_permission(false, Some(0)).unwrap(); // presence is separately authorized
    assert_eq!(local.host_presence(left.clone(), 1).unwrap().len(), 1);
    local.detach_host_transport(left.clone()).unwrap();
    let new = host_attach(&local);
    assert!(
        local
            .receive_host_presence(left.clone(), frame.clone(), 1)
            .is_err()
    );
    assert!(local.detach_host_transport(left).is_err());
    assert!(local.host_presence(new.clone(), 1).unwrap().is_empty());
    let other = Fixture::new().open();
    let ot = host_attach(&other);
    assert!(other.receive_host_presence(ot, frame.clone(), 1).is_err());
    assert!(other.host_presence(new.clone(), 1).is_err());
    local.receive_host_presence(new.clone(), frame, 2).unwrap();
    local.dispose().unwrap();
    assert!(matches!(
        local.host_presence(new, 2),
        Err(NativeSessionError::Disposed)
    ));
}

#[test]
fn presence_all_entries_are_admitted_atomically_and_tombstones_bound_capacity() {
    use yrs::{
        ClientID,
        sync::awareness::{AwarenessUpdate, AwarenessUpdateEntry},
        updates::{decoder::Decode, encoder::Encode},
    };
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let frame = announce(&peer, &right, &presence_range(&peer, 0), 0);
    let mut update = AwarenessUpdate::decode_v1(&frame.bytes).unwrap();
    let entry = update.clients.values().next().unwrap().clone();
    let bad = ClientID::new(123);
    let mut value: Value = serde_json::from_str(&entry.json).unwrap();
    value["selection"]["anchor"]["sourceIdentity"] = json!("wrong-owner");
    update.clients.insert(
        bad,
        AwarenessUpdateEntry {
            clock: 1,
            json: Arc::from(value.to_string()),
        },
    );
    let mut invalid = frame.clone();
    invalid.bytes = update.encode_v1();
    assert!(
        local
            .receive_host_presence(left.clone(), invalid, 0)
            .is_err()
    );
    assert!(local.host_presence(left.clone(), 0).unwrap().is_empty());
    // No current cursor is required for leave; all tombstones consume capacity.
    let clients = (1..=64)
        .map(|n| {
            (
                ClientID::new(n),
                AwarenessUpdateEntry {
                    clock: 1,
                    json: Arc::from("null"),
                },
            )
        })
        .collect();
    let mut tombstones = frame.clone();
    tombstones.bytes = AwarenessUpdate { clients }.encode_v1();
    local
        .receive_host_presence(left.clone(), tombstones, 0)
        .unwrap();
    let clients = [(
        ClientID::new(1000),
        AwarenessUpdateEntry {
            clock: 1,
            json: Arc::from("null"),
        },
    )]
    .into_iter()
    .collect();
    let mut excess = frame;
    excess.bytes = AwarenessUpdate { clients }.encode_v1();
    assert!(matches!(
        local.receive_host_presence(left.clone(), excess, 0),
        Err(NativeSessionError::ResourceLimit)
    ));
    assert!(local.host_presence(left, 0).unwrap().is_empty());
}
#[test]
fn presence_retained_update_recovery_freezes_publication_without_journaling_presence() {
    for (boundary, error) in [
        (FaultBoundary::BeforeCommit, PortError::Quota),
        (FaultBoundary::AfterCommit, PortError::CommitUnknown),
    ] {
        let f = Fixture::new();
        let local = f.open();
        let (_, peer) = remote_peer(&f);
        let left = host_attach(&local);
        let right = host_attach(&peer);
        let frame = announce(&peer, &right, &presence_range(&peer, 0), 0);
        local
            .receive_host_presence(left.clone(), frame.clone(), 0)
            .unwrap();
        let update = remote_edit(&peer, 1, false);
        local.reserve_peer_writer(update.writer).unwrap();
        f.store
            .inject_once(InjectedFault { boundary, error })
            .unwrap();
        assert!(
            local
                .receive_host_peer(left.clone(), update.clone(), 0)
                .is_err()
        );
        assert!(local.host_presence(left.clone(), 0).is_err());
        assert!(local.receive_host_presence(left.clone(), frame, 0).is_err());
        assert!(
            local
                .set_host_presence(left.clone(), None, None, true, 0)
                .is_err()
        );
        assert!(local.flush_host_presence(left.clone(), 0).is_err());
        assert!(local.take_host_presence_frames(left.clone(), 1, 0).is_err());
        local.recover().unwrap();
        local
            .receive_host_peer(left.clone(), update.clone(), 0)
            .unwrap();
        local.receive_host_peer(left.clone(), update, 0).unwrap();
        assert_eq!(local.host_presence(left, 0).unwrap().len(), 1);
        assert_eq!(f.store.recover(&f.id).unwrap().journal.len(), 1);
    }
}

#[test]
fn presence_pinned_node_awareness_roundtrip_uses_current_native_relative_selection() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let frame = announce(&peer, &right, &presence_range(&peer, 0), 0);
    let client = local
        .call(|state| Ok(state.service.session().document().writer_id()))
        .unwrap()
        .wrapping_add(1);
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/native/table-session-proof/presence-oracle.mjs");
    let input = json!({"bytes":frame.bytes,"client":client,"documentId":f.id.document_id});
    let mut child = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    std::fs::write(f.directory.join("node-oracle-stdout.json"), &output.stdout).unwrap();
    std::fs::write(f.directory.join("node-oracle-stderr.log"), &output.stderr).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let bytes: Vec<u8> = serde_json::from_value(value["bytes"].clone()).unwrap();
    local
        .receive_host_presence(
            left.clone(),
            NativeHostFrame {
                identity_json: frame.identity_json,
                bytes,
            },
            0,
        )
        .unwrap();
    let remote = local.host_presence(left, 0).unwrap();
    assert_eq!(remote.len(), 1);
    assert_eq!(remote[0].client_id, client);
    assert!(remote[0].selection.is_some());
}
#[test]
fn presence_pending_local_input_stays_staged_and_cancellation_does_not_publish_composition() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let before = revision(&local);
    let paragraph = visible(&local)[0]["id"].as_str().unwrap().to_owned();
    let plan = local
        .prepare_edits(
            before.clone(),
            vec![NativeSessionEdit {
                node: paragraph,
                from_utf16: 0,
                to_utf16: 0,
                text: "temporary IME 😀".into(),
            }],
            "prepared-input".into(),
            0,
        )
        .unwrap();
    let frame = announce(&peer, &right, &presence_range(&peer, 0), 0);
    local.receive_host_presence(left.clone(), frame, 0).unwrap();
    assert_eq!(revision(&local), before);
    local.cancel_edits(plan).unwrap();
    assert_eq!(revision(&local), before);
    assert!(local.pending_updates().unwrap().is_empty());
    assert_eq!(local.host_presence(left, 0).unwrap().len(), 1);
}

#[test]
fn presence_configured_frame_limit_is_precise_and_never_queues_or_mutates() {
    let f = Fixture::new();
    let s = f.open();
    let mut options = host_options(&s);
    options.max_frame_bytes = 1;
    let token = s.attach_host_transport(options, 0).unwrap();
    let before = revision(&s);
    s.set_host_presence(token.clone(), None, None, true, 0)
        .unwrap();
    assert!(matches!(
        s.flush_host_presence(token.clone(), 0),
        Err(NativeSessionError::Store {
            reason: NativeStoreFailure::ResourceLimit
        })
    ));
    assert!(s.take_host_presence_frames(token, 1, 0).unwrap().is_empty());
    assert_eq!(revision(&s), before);
}
#[test]
fn presence_invalid_local_client_payload_is_not_a_shape_validation_bypass() {
    use yrs::{
        ClientID,
        sync::awareness::{AwarenessUpdate, AwarenessUpdateEntry},
        updates::encoder::Encode,
    };
    let f = Fixture::new();
    let s = f.open();
    let token = host_attach(&s);
    let writer = s
        .call(|state| Ok(state.service.session().document().writer_id()))
        .unwrap();
    let clients = [(
        ClientID::new(writer as u64),
        AwarenessUpdateEntry {
            clock: 1,
            json: Arc::from("true"),
        },
    )]
    .into_iter()
    .collect();
    let frame = NativeHostFrame {
        identity_json: host_options(&s).identity_json,
        bytes: AwarenessUpdate { clients }.encode_v1(),
    };
    assert!(s.receive_host_presence(token.clone(), frame, 0).is_err());
    assert!(s.host_presence(token, 0).unwrap().is_empty());
}
#[test]
fn presence_deleted_remote_owner_renders_no_selection_and_undo_restores_same_anchor() {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let left = host_attach(&local);
    let right = host_attach(&peer);
    let owner = visible(&peer)[0]["id"].as_str().unwrap().to_owned();
    let frame = announce(&peer, &right, &presence_range(&peer, 0), 0);
    local.receive_host_presence(left.clone(), frame, 0).unwrap();
    assert!(
        local.host_presence(left.clone(), 0).unwrap()[0]
            .selection
            .is_some()
    );
    // Use the existing owning Session command (also used by the canonical
    // deleted-owner regression), rather than assuming a split alias is deleted.
    peer.call(move |state| {
        let rev = state.service.session().observed_revision()?;
        let plan = state.service.prepare_commands(
            &rev,
            &[EditorCommand::Enable {
                target: owner,
                enabled: false,
            }],
            &TextOrigin::new("presence-delete-owner").unwrap(),
            0,
        )?;
        state.service.apply(plan, 0)?;
        Ok(())
    })
    .unwrap();
    let deletion = peer.pending_updates().unwrap().remove(0);
    local.reserve_peer_writer(deletion.writer).unwrap();
    local.receive_host_peer(left.clone(), deletion, 0).unwrap();
    assert!(
        local.host_presence(left.clone(), 0).unwrap()[0]
            .selection
            .is_none()
    );
    let undo = peer.undo(revision(&peer), 0).unwrap().unwrap();
    let entry = peer
        .pending_updates()
        .unwrap()
        .into_iter()
        .find(|e| e.sequence == undo.sequence && e.writer == undo.writer)
        .unwrap();
    local.receive_host_peer(left.clone(), entry, 0).unwrap();
    assert!(local.host_presence(left, 0).unwrap()[0].selection.is_some());
}

#[test]
fn lifecycle_remote_overlapping_staged_input_rejects_stale_then_rebases_and_undo_preserves_remote()
{
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let token = host_attach(&local);
    let paragraph = visible(&local)[0]["id"].as_str().unwrap().to_owned();
    let input = |s: &NativeSession, text: &str| {
        s.prepare_edits(
            revision(s),
            vec![NativeSessionEdit {
                node: paragraph.clone(),
                from_utf16: 0,
                to_utf16: 0,
                text: text.into(),
            }],
            "composition".into(),
            0,
        )
        .unwrap()
    };
    let staged = input(&local, "LOCAL 😀");
    let pending = input(&peer, "REMOTE ");
    peer.commit_edits(pending, 0).unwrap().unwrap();
    let update = peer.pending_updates().unwrap().remove(0);
    local.reserve_peer_writer(update.writer).unwrap();
    local.receive_host_peer(token, update.clone(), 0).unwrap();
    let remote = visible(&local);
    assert!(matches!(
        local.commit_edits(staged.clone(), 0),
        Err(NativeSessionError::Revision {
            reason: NativeRevisionFailure::Stale,
            ..
        })
    ));
    local.cancel_edits(staged).unwrap();
    assert_eq!(visible(&local), remote);
    let forwarded = local.pending_updates().unwrap();
    assert_eq!(forwarded.len(), 1);
    assert_eq!(forwarded[0].checksum, update.checksum);
    let rebased = input(&local, "LOCAL 😀");
    local.commit_edits(rebased, 0).unwrap().unwrap();
    let committed = visible(&local);
    assert_ne!(committed, remote);
    local.undo(revision(&local), 0).unwrap().unwrap();
    assert_eq!(visible(&local), remote);
    local.redo(revision(&local), 0).unwrap().unwrap();
    assert_eq!(visible(&local), committed);
}

#[test]
fn lifecycle_switch_disposes_old_model_and_rejects_all_old_tokens_without_new_document_mutation() {
    let f = Fixture::new();
    let old = f.open();
    let token = host_attach(&old);
    old.set_table_policy(true).unwrap();
    let plan = prepare(&old, &command(&old, "cancelled before switch"));
    old.cancel_commands(plan.token.clone()).unwrap();
    old.detach_host_transport(token.clone()).unwrap();
    old.dispose().unwrap();
    let new_fixture = Fixture::new();
    let new = new_fixture.open();
    let next = host_attach(&new);
    let before = revision(&new);
    assert_ne!(f.id, new_fixture.id);
    assert!(matches!(
        old.commit_commands(plan.token, 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        old.take_host_frames(token.clone(), 1, 0),
        Err(NativeSessionError::Disposed)
    ));
    assert!(matches!(
        new.detach_host_transport(token.clone()),
        Err(NativeSessionError::Unauthorized)
    ));
    assert!(matches!(
        new.take_host_frames(token, 1, 0),
        Err(NativeSessionError::Unauthorized)
    ));
    assert_eq!(revision(&new), before);
    assert!(new.pending_updates().unwrap().is_empty());
    assert!(new.host_presence(next, 0).unwrap().is_empty());
}

#[test]
fn lifecycle_host_completion_can_read_revoke_rejoin_and_replay_without_callback_reentry_or_duplicate_history()
 {
    let f = Fixture::new();
    let local = f.open();
    let (_, peer) = remote_peer(&f);
    let token = host_attach(&local);
    let update = remote_edit(&peer, 1, true);
    local.reserve_peer_writer(update.writer).unwrap();
    let receipt = local
        .receive_host_peer(token.clone(), update.clone(), 0)
        .unwrap();
    assert_eq!(receipt.checksum, update.checksum);
    let committed = revision(&local);
    // The native worker installs no foreign callbacks. A transport completion
    // can synchronously read/reconfigure only after actual admission returns.
    let on_completed = || {
        assert_eq!(revision(&local), committed);
        local.detach_host_transport(token.clone()).unwrap();
        host_attach(&local)
    };
    let next = on_completed();
    assert!(matches!(
        local.receive_host_peer(token, update.clone(), 0),
        Err(NativeSessionError::Unauthorized)
    ));
    local.receive_host_peer(next, update, 0).unwrap();
    assert_eq!(revision(&local), committed);
    assert_eq!(local.history_state(0).unwrap().undo_groups, 0);
}

fn atomic_command(s: &NativeSession, index: usize, replacement: Value) -> Value {
    let node = visible(s)[index].clone();
    let anchor = s
        .capture_anchors(
            revision(s),
            vec![crate::AnchorInput {
                node: node["id"].as_str().unwrap().into(),
                offset_utf16: 0,
                bias: crate::AnchorBias::Right,
            }],
        )
        .unwrap()
        .remove(0);
    json!([{"type":"atomicContent","owner":node["id"],"expected":node["blockAttributes"],
        "at":anchor.token,"replacement":replacement}])
}
fn replacement(index: usize) -> Value {
    if index == 1 {
        json!(["module:editac.image",1,{"url":"https://assets.example.invalid/new.png",
        "alt":"New 😀","title":"Replacement","source":"![New 😀](https://assets.example.invalid/new.png)"}])
    } else {
        json!(["module:editac.reference",1,{"targetId":"document-new","label":"New reference 😀"}])
    }
}
#[test]
fn atomic_content_success_history_reopen_and_surrounding_retention() {
    for index in [1, 2] {
        let f = Fixture::attachments();
        let s = f.open();
        s.set_atomic_content_policy(true, true).unwrap();
        let before = visible(&s);
        let command = atomic_command(&s, index, replacement(index));
        let p = prepare(&s, &command);
        assert_eq!(visible(&s), before);
        let commit = s.commit_commands(p.token, 0).unwrap().unwrap();
        assert_eq!(commit.durability, NativeSessionDurability::ProcessCrash);
        let after = visible(&s);
        assert_eq!(after[index]["blockAttributes"], replacement(index));
        assert_eq!(after[index]["id"], before[index]["id"]);
        for i in 0..before.as_array().unwrap().len() {
            if i != index {
                assert_eq!(after[i], before[i]);
            }
        }
        s.undo(revision(&s), 0).unwrap().unwrap();
        assert_eq!(visible(&s), before);
        s.redo(revision(&s), 0).unwrap().unwrap();
        assert_eq!(visible(&s), after);
        let p = prepare(&s, &atomic_command(&s, index, Value::Null));
        s.commit_commands(p.token, 0).unwrap().unwrap();
        let removed = visible(&s);
        assert_eq!(removed[index]["blockAttributes"], json!(["paragraph"]));
        assert_eq!(removed[index]["id"], before[index]["id"]);
        assert!(
            removed[index]["runs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["text"] == "")
        );
        s.undo(revision(&s), 0).unwrap().unwrap();
        assert_eq!(visible(&s), after);
        s.redo(revision(&s), 0).unwrap().unwrap();
        assert_eq!(visible(&s), removed);
        s.dispose().unwrap();
        let reopened = f.open();
        assert_eq!(visible(&reopened), removed);
        assert!(
            !reopened
                .command_catalog(0)
                .unwrap()
                .routes
                .iter()
                .find(|r| r.id == "atomicContent")
                .unwrap()
                .available
        );
        reopened.dispose().unwrap();
    }
}
#[test]
fn atomic_content_default_policy_transitions_permissions_cancel_and_disposal() {
    let f = Fixture::attachments();
    let s = f.open();
    let c = atomic_command(&s, 1, replacement(1));
    let before = visible(&s);
    assert!(matches!(
        s.check_commands(revision(&s), c.to_string(), "asset".into(), 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    s.set_atomic_content_policy(false, true).unwrap();
    assert!(
        s.check_commands(revision(&s), c.to_string(), "asset".into(), 0)
            .is_err()
    );
    s.set_atomic_content_policy(true, false).unwrap();
    let p = prepare(&s, &c);
    s.set_atomic_content_policy(false, false).unwrap();
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    s.set_atomic_content_policy(true, true).unwrap();
    let p = prepare(&s, &c);
    s.cancel_commands(p.token.clone()).unwrap();
    assert!(matches!(
        s.commit_commands(p.token, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    for (writable, expiry, now) in [(false, None, 0), (true, Some(5), 5)] {
        s.set_permission(true, None).unwrap();
        let p = prepare(&s, &c);
        s.set_permission(writable, expiry).unwrap();
        assert!(s.commit_commands(p.token, now).is_err());
        assert_eq!(visible(&s), before);
    }
    s.dispose().unwrap();
    assert!(matches!(
        s.set_atomic_content_policy(true, true),
        Err(NativeSessionError::Disposed)
    ));
}
#[test]
fn atomic_content_descriptor_anchor_version_bounds_and_payload_rejections_are_silent() {
    let f = Fixture::attachments();
    let s = f.open();
    s.set_atomic_content_policy(true, true).unwrap();
    let before = visible(&s);
    let rev = revision(&s);
    let good = atomic_command(&s, 1, replacement(1));
    let other = atomic_command(&s, 2, replacement(2));
    let mut cases = vec![];
    let mut c = good.clone();
    c[0]["expected"][2]["alt"] = json!("wrong");
    cases.push(c);
    let mut c = good.clone();
    c[0]["owner"] = before[2]["id"].clone();
    cases.push(c);
    let mut c = good.clone();
    c[0]["at"] = other[0]["at"].clone();
    cases.push(c);
    let mut c = good.clone();
    c[0]["replacement"][1] = json!(2);
    cases.push(c);
    let mut c = good.clone();
    c[0]["replacement"][2]["url"] = json!("javascript:alert(1)");
    cases.push(c);
    let mut c = good.clone();
    c[0]["replacement"][2]["alt"] = json!("x".repeat(8193));
    cases.push(c);
    let mut c = good.clone();
    c[0]["replacement"] = replacement(2);
    cases.push(c);
    let mut c = other.clone();
    c[0]["replacement"][2]["targetId"] = json!("bad\nidentity");
    cases.push(c);
    let mut c = other.clone();
    c[0]["replacement"][2]["label"] = json!("x".repeat(513));
    cases.push(c);
    for c in cases {
        assert!(
            s.check_commands(rev.clone(), c.to_string(), "invalid".into(), 0)
                .is_err(),
            "{c}"
        );
        assert_eq!(visible(&s), before);
        assert_eq!(revision(&s), rev);
    }
    let p = prepare(&s, &good);
    let q = prepare(&s, &other);
    s.commit_commands(q.token, 0).unwrap();
    let after = visible(&s);
    assert!(s.commit_commands(p.token, 0).is_err());
    assert_eq!(visible(&s), after);
    s.dispose().unwrap();
}
#[test]
fn atomic_content_append_failure_retains_update_freezes_and_recovers_exactly_once() {
    for (index, remove) in [(1, false), (1, true), (2, false), (2, true)] {
        for boundary in [FaultBoundary::BeforeCommit, FaultBoundary::AfterCommit] {
            let f = Fixture::attachments();
            let s = f.open();
            s.set_atomic_content_policy(true, true).unwrap();
            let before = visible(&s);
            let p = prepare(
                &s,
                &atomic_command(
                    &s,
                    index,
                    if remove {
                        Value::Null
                    } else {
                        replacement(index)
                    },
                ),
            );
            f.store
                .inject_once(InjectedFault {
                    boundary,
                    error: PortError::Quota,
                })
                .unwrap();
            assert!(s.commit_commands(p.token, 0).is_err());
            let r = s.read(0).unwrap();
            assert!(r.revision.is_none());
            assert!(s.recovery_export().unwrap().unjournaled_update.is_some());
            assert!(
                s.prepare_commands(vec![], "[]".into(), "blocked".into(), 0)
                    .is_err()
            );
            s.recover().unwrap();
            let after = visible(&s);
            assert_ne!(after, before);
            assert_eq!(
                after[index]["blockAttributes"],
                if remove {
                    json!(["paragraph"])
                } else {
                    replacement(index)
                }
            );
            let rev = revision(&s);
            s.recover().unwrap();
            assert_eq!(revision(&s), rev);
            assert_eq!(visible(&s), after);
            s.undo(revision(&s), 0).unwrap().unwrap();
            assert_eq!(visible(&s), before);
            s.dispose().unwrap();
        }
    }
}

#[test]
fn atomic_content_actual_distinct_sqlite_remote_stale_and_local_history_preserves_remote() {
    let f = Fixture::attachments();
    let s = f.open();
    let (_, peer) = remote_peer(&f);
    s.set_atomic_content_policy(true, true).unwrap();
    peer.set_atomic_content_policy(true, true).unwrap();
    let stale = prepare(&s, &atomic_command(&s, 1, replacement(1)));
    let q = prepare(&peer, &atomic_command(&peer, 2, replacement(2)));
    let commit = peer.commit_commands(q.token, 0).unwrap().unwrap();
    let entry = peer
        .pending_updates()
        .unwrap()
        .into_iter()
        .find(|e| e.writer == commit.writer && e.sequence == commit.sequence)
        .unwrap();
    s.reserve_peer_writer(entry.writer).unwrap();
    s.receive_peer(entry.clone()).unwrap();
    assert_eq!(visible(&s), visible(&peer));
    let remote = visible(&s);
    assert!(s.commit_commands(stale.token, 0).is_err());
    assert_eq!(visible(&s), remote);
    let p = prepare(&s, &atomic_command(&s, 1, Value::Null));
    s.commit_commands(p.token, 0).unwrap();
    s.undo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(visible(&s), remote);
    s.redo(revision(&s), 0).unwrap().unwrap();
    assert_eq!(visible(&s)[2], remote[2]);
    s.receive_peer(entry).unwrap();
    assert_eq!(visible(&s)[2], remote[2]);
    s.dispose().unwrap();
    peer.dispose().unwrap();
}

#[test]
fn atomic_content_foreign_released_and_nonzero_anchor_never_retargets_host_completion() {
    let f = Fixture::attachments();
    let s = f.open();
    let (_, peer) = remote_peer(&f);
    s.set_atomic_content_policy(true, true).unwrap();
    peer.set_atomic_content_policy(true, true).unwrap();
    let before = visible(&s);
    let good = atomic_command(&s, 2, replacement(2));
    let foreign = atomic_command(&peer, 2, replacement(2));
    let mut wrong = good.clone();
    wrong[0]["at"] = foreign[0]["at"].clone();
    assert!(
        s.check_commands(revision(&s), wrong.to_string(), "foreign".into(), 0)
            .is_err()
    );
    let owner = before[2]["id"].as_str().unwrap().to_owned();
    let a = s
        .capture_anchors(
            revision(&s),
            vec![crate::AnchorInput {
                node: owner,
                offset_utf16: 1,
                bias: crate::AnchorBias::Right,
            }],
        )
        .unwrap()
        .remove(0);
    wrong[0]["at"] = json!(a.token);
    assert!(
        s.check_commands(revision(&s), wrong.to_string(), "partial".into(), 0)
            .is_err()
    );
    s.release_anchor(good[0]["at"].as_str().unwrap().into())
        .unwrap();
    assert!(
        s.check_commands(revision(&s), good.to_string(), "released".into(), 0)
            .is_err()
    );
    assert_eq!(visible(&s), before);
    s.dispose().unwrap();
    peer.dispose().unwrap();
}

#[test]
fn atomic_content_both_families_all_actions_recheck_admission_and_cancellation() {
    for (index, remove) in [(1, false), (1, true), (2, false), (2, true)] {
        let f = Fixture::attachments();
        let s = f.open();
        let before = visible(&s);
        let command = atomic_command(
            &s,
            index,
            if remove {
                Value::Null
            } else {
                replacement(index)
            },
        );
        assert!(matches!(
            s.check_commands(revision(&s), command.to_string(), "policy".into(), 0),
            Err(NativeSessionError::UnsupportedModule)
        ));
        s.set_atomic_content_policy(index != 1, index != 2).unwrap();
        assert!(matches!(
            s.check_commands(revision(&s), command.to_string(), "policy".into(), 0),
            Err(NativeSessionError::UnsupportedModule)
        ));
        s.set_atomic_content_policy(true, true).unwrap();
        let p = prepare(&s, &command);
        s.set_atomic_content_policy(index != 1, index != 2).unwrap();
        assert!(matches!(
            s.commit_commands(p.token, 0),
            Err(NativeSessionError::UnsupportedModule)
        ));
        s.set_atomic_content_policy(true, true).unwrap();
        let p = prepare(&s, &command);
        s.cancel_commands(p.token.clone()).unwrap();
        assert!(matches!(
            s.commit_commands(p.token, 0),
            Err(NativeSessionError::InvalidPlan)
        ));
        for (writable, expiry, now) in [(false, None, 0), (true, Some(7), 7)] {
            s.set_permission(true, None).unwrap();
            let p = prepare(&s, &command);
            s.set_permission(writable, expiry).unwrap();
            assert!(s.commit_commands(p.token, now).is_err());
            assert_eq!(visible(&s), before);
        }
        s.dispose().unwrap();
    }
}

#[test]
fn transfer_append_failure_never_qualifies_source_deletion_and_recovers_once() {
    use super::session_transfer::{NativeTransferInput, NativeTransferRange};
    let range = |session: &NativeSession, from, to| {
        let node = session
            .read(0)
            .unwrap()
            .nodes
            .into_iter()
            .find(|n| n.kind == "block")
            .unwrap()
            .id;
        let anchors = session
            .capture_anchors(
                revision(session),
                vec![
                    crate::AnchorInput {
                        node: node.clone(),
                        offset_utf16: from,
                        bias: crate::AnchorBias::Left,
                    },
                    crate::AnchorInput {
                        node,
                        offset_utf16: to,
                        bias: crate::AnchorBias::Right,
                    },
                ],
            )
            .unwrap();
        NativeTransferRange {
            anchor: anchors[0].token.clone(),
            focus: anchors[1].token.clone(),
        }
    };
    for boundary in [FaultBoundary::BeforeCommit, FaultBoundary::AfterCommit] {
        let source_fixture = Fixture::new();
        let source = source_fixture.open();
        let destination_fixture = Fixture::new();
        let destination = destination_fixture.open();
        let source_before = visible(&source);
        let cut = source
            .prepare_cut(revision(&source), range(&source, 0, 1), 0)
            .unwrap();
        let exported = cut.exported.unwrap();
        let input = NativeTransferInput {
            fragment_json: Some(exported.fragment_json),
            markdown: None,
            html: None,
            plain_text: None,
            literal: false,
        };
        let paste = destination
            .prepare_paste(
                revision(&destination),
                range(&destination, 6, 6),
                input,
                Some(exported.source),
                0,
            )
            .unwrap();
        let pending = destination.read(0).unwrap().pending_upload;
        destination_fixture
            .store
            .inject_once(InjectedFault {
                boundary,
                error: PortError::Quota,
            })
            .unwrap();
        assert!(
            destination
                .commit_transfer(paste.token.clone(), false, None, 0)
                .is_err()
        );
        assert!(destination.read(0).unwrap().recovery_required);
        assert!(
            destination
                .recovery_export()
                .unwrap()
                .unjournaled_update
                .is_some()
        );
        assert_eq!(visible(&source), source_before);
        assert!(matches!(
            destination.commit_transfer(paste.token, false, None, 0),
            Err(NativeSessionError::InvalidPlan)
        ));
        destination.recover().unwrap();
        assert_eq!(destination.read(0).unwrap().pending_upload, pending + 1);
        assert_eq!(destination.history_state(0).unwrap().undo_groups, 1);
        let recovered = visible(&destination);
        destination.recover().unwrap();
        assert_eq!(visible(&destination), recovered);
        assert_eq!(destination.read(0).unwrap().pending_upload, pending + 1);
        assert_eq!(visible(&source), source_before);
        source.cancel_transfer(cut.token).unwrap();
        source.dispose().unwrap();
        destination.dispose().unwrap();
        let reopened = destination_fixture.open();
        assert_eq!(visible(&reopened), recovered);
        reopened.dispose().unwrap();
    }
}
