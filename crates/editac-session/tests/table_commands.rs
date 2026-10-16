//! STB-1.2: shared planner through actual Session/SQLite, not patch-only replay.
#![cfg(feature = "native-store")]
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{
        editor::EditorCommand,
        text::{TextCommand, TextOrigin},
    },
    document::{CreationPermit, Document, DocumentIdentity, InitialNode},
};
use editac_markdown::optional::Codecs;
use editac_session::{edit_service::*, ports::*, session::*, store::NativeStore};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
struct Fixture {
    directory: PathBuf,
    id: DocumentIdentity,
    base: CheckpointRecord,
    table: String,
    paragraph: String,
}
impl Fixture {
    fn new(v2: bool) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::var_os("EDITAC_TABLE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("table-session-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let id = DocumentIdentity::v5(
            &format!("ac120000-0000-4000-8000-{n:012x}"),
            "ac120000-0000-4000-8000-000000000001",
        )
        .unwrap();
        let mut doc = Document::create(
            CreationPermit::authorize_new(id.clone()).unwrap(),
            &[
                InitialNode {
                    kind: "block".into(),
                    text: "table".into(),
                },
                InitialNode {
                    kind: "block".into(),
                    text: "surrounding".into(),
                },
            ],
        )
        .unwrap();
        let nodes = doc.snapshot().unwrap().visible;
        let table = nodes[0].id.clone();
        let paragraph = nodes[1].id.clone();
        let runs = json!([["ab😀", [["bold"]]]]);
        let cell = if v2 {
            json!({"paragraphs":[{"style":["heading",2],"runs":runs}],"rowSpan":1,"columnSpan":1,"header":true})
        } else {
            runs
        };
        let t = json!(["module:editac.table",if v2{2}else{1},{"alignments":["left","right"],"rows":[[cell,cell],[cell,cell]],"source":"exact source"}]);
        let blocks: Vec<editac_core::interchange::TransferBlock> =
            serde_json::from_value(json!([{"runs":[],"attributes":{"type":"content","tuple":t}}]))
                .unwrap();
        let block = editac_core::interchange::transfer_blocks(blocks)
            .unwrap()
            .remove(0);
        let content =
            editac_core::modules::content::Content::from_tuple(&block.attributes.unwrap().tuple())
                .unwrap()
                .unwrap();
        let p = doc
            .prepare_editor(
                &[EditorCommand::Content {
                    target: table.clone(),
                    content,
                }],
                &origin(),
            )
            .unwrap();
        doc.commit_editor(p).unwrap();
        Self {
            directory,
            id,
            base: CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap(),
            table,
            paragraph,
        }
    }
    fn service(&self, name: &str) -> (Arc<NativeStore>, EditService<Arc<NativeStore>>) {
        let store = Arc::new(
            NativeStore::create_new(
                self.directory.join(format!("{name}.sqlite")),
                self.id.clone(),
                StoreLimits::default(),
            )
            .unwrap(),
        );
        store.publish(0, self.base.clone()).unwrap();
        let s = EditService::new(
            Session::open(store.clone(), &self.id, CachedPermission::LOCAL).unwrap(),
            policy(),
        );
        (store, s)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_TABLE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
fn policy() -> HostPolicy {
    HostPolicy {
        codecs: Codecs {
            tables: true,
            ..Codecs::default()
        },
        ..HostPolicy::default()
    }
}

#[test]
fn attributes_recheck_authority_and_codec_then_persist_one_group_with_exact_recovery() {
    use editac_core::{commands::table::CellRectangle, modules::content::Alignment};
    for v2 in [false, true] {
        let f = Fixture::new(v2);
        let (store, mut service) = f.service("attributes");
        let original = tuple(&service, &f.table);
        let commands = [EditorCommand::TableAttributes {
            target: f.table.clone(),
            expected: service
                .session()
                .document()
                .fragment_for_node(&f.table)
                .unwrap()
                .attributes
                .unwrap()
                .tuple(),
            rectangle: CellRectangle {
                row: 0,
                column: 0,
                rows: 1,
                columns: 2,
            },
            alignment: Some(Alignment::Center),
            header: Some(false),
            protected: vec![],
        }];
        let revision = service.read(0).unwrap().revision;
        let prepared = service
            .prepare_commands(&revision, &commands, &origin(), 0)
            .unwrap();
        let before = service.session().document().checkpoint().bytes;
        service.set_policy(HostPolicy {
            writable: false,
            ..policy()
        });
        assert!(matches!(
            service.apply(prepared, 0),
            Err(ServiceError::ReadOnly)
        ));
        assert!(matches!(
            service.prepare_commands(&revision, &commands, &origin(), 0),
            Err(ServiceError::ReadOnly)
        ));
        service.set_policy(HostPolicy::default());
        let rectangle = [EditorCommand::TableRectangle {
            target: f.table.clone(),
            expected: service
                .session()
                .document()
                .fragment_for_node(&f.table)
                .unwrap()
                .attributes
                .unwrap()
                .tuple(),
            rectangle: CellRectangle {
                row: 0,
                column: 0,
                rows: 1,
                columns: 1,
            },
            cells: None,
            protected: vec![],
        }];
        assert!(matches!(
            service.prepare_commands(&revision, &rectangle, &origin(), 0),
            Err(ServiceError::UnsupportedModule)
        ));
        assert!(matches!(
            service.prepare_commands(&revision, &commands, &origin(), 0),
            Err(ServiceError::UnsupportedModule)
        ));
        assert_eq!(service.session().document().checkpoint().bytes, before);
        assert_eq!(store.pending(&f.id).unwrap().len(), 0);
        assert_eq!(service.session().document().history_state().undo_groups, 0);
        service.set_policy(policy());
        let prepared = service
            .prepare_commands(&revision, &commands, &origin(), 0)
            .unwrap();
        service.set_policy(HostPolicy::default());
        assert!(matches!(
            service.apply(prepared, 0),
            Err(ServiceError::UnsupportedModule)
        ));
        assert_eq!(store.pending(&f.id).unwrap().len(), 0);
        service.set_policy(policy());
        let prepared = service
            .prepare_commands(&revision, &commands, &origin(), 0)
            .unwrap();
        let receipt = service.apply(prepared, 0).unwrap().unwrap();
        assert_eq!(
            service.local_receipt(&receipt.update).unwrap(),
            Some(receipt)
        );
        assert_eq!(store.pending(&f.id).unwrap().len(), 1);
        assert_eq!(service.session().document().history_state().undo_groups, 1);
        let edited = tuple(&service, &f.table);
        assert_eq!(edited[2]["alignments"], json!(["center", "center"]));
        assert_eq!(edited[2]["rows"][0][0]["header"], false);
        let revision = service.read(0).unwrap().revision;
        service.undo(&revision, 0).unwrap().unwrap();
        assert_eq!(tuple(&service, &f.table), original);
        let revision = service.read(0).unwrap().revision;
        service.redo(&revision, 0).unwrap().unwrap();
        assert_eq!(tuple(&service, &f.table), edited);
        let reopened = EditService::new(
            Session::open(store.clone(), &f.id, CachedPermission::LOCAL).unwrap(),
            policy(),
        );
        assert_eq!(tuple(&reopened, &f.table), edited);
    }
}
fn origin() -> TextOrigin {
    TextOrigin::new("table-session").unwrap()
}

#[test]
fn rectangle_uses_one_durable_receipt_and_rechecks_readonly_before_any_write() {
    use editac_core::commands::table::{CellRectangle, RectangleEdit, rectangle_commands};
    for v2 in [false, true] {
        let f = Fixture::new(v2);
        let (store, mut service) = f.service("rectangle");
        let original = tuple(&service, &f.table);
        let expected = service
            .session()
            .document()
            .snapshot()
            .unwrap()
            .visible
            .into_iter()
            .find(|node| node.id == f.table)
            .unwrap()
            .block_attributes
            .as_ref()
            .unwrap()
            .tuple();
        let cells = vec![
            vec!["one".into(), "two😀".into()],
            vec!["three".into(), "four".into()],
        ];
        let commands = rectangle_commands(
            &f.table,
            &expected,
            CellRectangle {
                row: 0,
                column: 0,
                rows: 2,
                columns: 2,
            },
            RectangleEdit::Paste(&cells),
            &[],
        )
        .unwrap();
        let before = service.session().document().checkpoint().bytes;
        let revision = service.read(0).unwrap().revision;
        let plan = service
            .prepare_commands(&revision, &commands, &origin(), 0)
            .unwrap();
        assert_eq!(service.session().document().checkpoint().bytes, before);
        service.set_policy(HostPolicy {
            writable: false,
            ..policy()
        });
        assert!(matches!(
            service.apply(plan, 0),
            Err(ServiceError::ReadOnly)
        ));
        assert!(matches!(
            service.prepare_commands(&revision, &commands, &origin(), 0),
            Err(ServiceError::ReadOnly)
        ));
        assert_eq!(service.session().document().checkpoint().bytes, before);
        assert_eq!(store.pending(&f.id).unwrap().len(), 0);
        assert_eq!(service.session().document().history_state().undo_groups, 0);
        service.set_policy(policy());
        let plan = service
            .prepare_commands(&revision, &commands, &origin(), 0)
            .unwrap();
        let receipt = service.apply(plan, 0).unwrap().unwrap();
        assert_eq!(
            service.local_receipt(&receipt.update).unwrap(),
            Some(receipt)
        );
        assert_eq!(store.pending(&f.id).unwrap().len(), 1);
        assert_eq!(service.session().document().history_state().undo_groups, 1);
        let pasted = tuple(&service, &f.table);
        assert_ne!(pasted, original);
        let revision = service.read(0).unwrap().revision;
        service.undo(&revision, 0).unwrap().unwrap();
        assert_eq!(tuple(&service, &f.table), original);
        let revision = service.read(0).unwrap().revision;
        service.redo(&revision, 0).unwrap().unwrap();
        assert_eq!(tuple(&service, &f.table), pasted);
        let reopened = EditService::new(
            Session::open(store.clone(), &f.id, CachedPermission::LOCAL).unwrap(),
            policy(),
        );
        assert_eq!(tuple(&reopened, &f.table), pasted);
    }
}
fn tuple<S: SessionStore>(s: &EditService<Arc<S>>, owner: &str) -> Value {
    let n = s
        .session()
        .document()
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == owner)
        .unwrap();
    {
        let mut json = String::new();
        n.block_attributes
            .as_ref()
            .unwrap()
            .tuple()
            .to_json(&mut json);
        serde_json::from_str(&json).unwrap()
    }
}
fn structure<S: SessionStore>(
    s: &EditService<Arc<S>>,
    owner: &str,
    action: &str,
    index: usize,
) -> EditorCommand {
    let c:editac_core::interchange::Command=serde_json::from_value(json!({"type":"tableStructure","owner":owner,"expected":tuple(s,owner),"action":action,"index":index})).unwrap();
    c.translate(|_| unreachable!()).unwrap()
}
fn cell<S: SessionStore>(s: &EditService<Arc<S>>, owner: &str, text: &str) -> EditorCommand {
    let c:editac_core::interchange::Command=serde_json::from_value(json!({"type":"tableCell","owner":owner,"expected":tuple(s,owner),"row":0,"column":0,"text":text})).unwrap();
    c.translate(|_| unreachable!()).unwrap()
}
fn apply<S: SessionStore>(s: &mut EditService<Arc<S>>, c: EditorCommand) -> LocalCommit {
    let before = s.session().document().checkpoint().bytes;
    let p = s
        .prepare_commands(&s.read(0).unwrap().revision, &[c], &origin(), 0)
        .unwrap();
    assert_eq!(s.session().document().checkpoint().bytes, before);
    let receipt = s.apply(p, 0).unwrap().unwrap();
    assert_eq!(
        s.local_receipt(&receipt.update).unwrap(),
        Some(receipt.clone())
    );
    receipt
}
#[test]
fn sqlite_both_versions_cell_structure_history_durable_reopen_and_commit_guards() {
    for v2 in [false, true] {
        let f = Fixture::new(v2);
        let (store, mut s) = f.service("local");
        let before = tuple(&s, &f.table);
        let c = cell(&s, &f.table, "abX😀");
        apply(&mut s, c);
        let edited = tuple(&s, &f.table);
        assert_ne!(edited, before);
        for action in ["insertRow", "insertColumn", "deleteRow", "deleteColumn"] {
            let c = structure(&s, &f.table, action, 1);
            apply(&mut s, c);
        }
        assert_eq!(tuple(&s, &f.table), edited);
        assert_eq!(s.session().document().history_state().undo_groups, 5);
        for _ in 0..5 {
            let r = s.read(0).unwrap().revision;
            s.undo(&r, 0).unwrap().unwrap();
        }
        assert_eq!(tuple(&s, &f.table), before);
        for _ in 0..5 {
            let r = s.read(0).unwrap().revision;
            s.redo(&r, 0).unwrap().unwrap();
        }
        assert_eq!(tuple(&s, &f.table), edited);
        let c = structure(&s, &f.table, "insertRow", 0);
        let r = s.read(0).unwrap().revision;
        let p = s.prepare_commands(&r, &[c.clone()], &origin(), 0).unwrap();
        let bytes = s.session().document().checkpoint().bytes;
        let count = store.pending(&f.id).unwrap().len();
        s.set_policy(HostPolicy::default());
        assert!(matches!(
            s.apply(p, 0),
            Err(ServiceError::UnsupportedModule)
        ));
        assert_eq!(s.session().document().checkpoint().bytes, bytes);
        assert_eq!(store.pending(&f.id).unwrap().len(), count);
        s.set_policy(policy());
        let p = s.prepare_commands(&r, &[c], &origin(), 0).unwrap();
        s.set_permission(CachedPermission {
            writable: true,
            expires_at: Some(1),
        });
        assert!(s.apply(p, 1).is_err());
        assert_eq!(s.session().document().checkpoint().bytes, bytes);
        let reopened = EditService::new(
            Session::open(store.clone(), &f.id, CachedPermission::LOCAL).unwrap(),
            policy(),
        );
        assert_eq!(tuple(&reopened, &f.table), edited);
        assert_eq!(reopened.session().document().history_state().undo_groups, 0);
    }
}
#[test]
fn actual_two_peer_table_cell_and_structure_invalidate_capture_and_preserve_remote_on_local_undo() {
    for v2 in [false, true] {
        for remote_structure in [false, true] {
            let f = Fixture::new(v2);
            let (local_store, local) = f.service("local");
            // Two independently opened actual Session replicas with durably
            // reserved writers on the existing shared SQLite store. Cross-store
            // remote writer admission belongs to STB-1.3; never fake it by
            // claiming a foreign writer or bypassing NativeStore::append.
            let peer_store = local_store.clone();
            let peer = EditService::new(
                Session::open(peer_store.clone(), &f.id, CachedPermission::LOCAL).unwrap(),
                policy(),
            );
            peer_case(&f, remote_structure, local_store, local, peer_store, peer);
        }
    }
}

fn peer_case<S: SessionStore>(
    f: &Fixture,
    remote_structure: bool,
    local_store: Arc<S>,
    mut local: EditService<Arc<S>>,
    peer_store: Arc<S>,
    mut peer: EditService<Arc<S>>,
) {
    let captured = cell(&local, &f.table, "stale target");
    let revision = local.read(0).unwrap().revision;
    let pending = local
        .prepare_commands(&revision, &[captured.clone()], &origin(), 0)
        .unwrap();
    let at = local
        .session()
        .document()
        .anchor(&f.paragraph, Utf16Offset(0), Bias::Right)
        .unwrap();
    apply(
        &mut local,
        EditorCommand::Text(TextCommand::Insert {
            at,
            text: "local-".into(),
        }),
    );
    let peer_command = if remote_structure {
        structure(&peer, &f.table, "insertColumn", 1)
    } else {
        cell(&peer, &f.table, "remote 😀")
    };
    let receipt = apply(&mut peer, peer_command);
    let entry = peer_store
        .pending(&f.id)
        .unwrap()
        .into_iter()
        .find(|e| e.id() == &receipt.update)
        .unwrap();
    local.receive_peer(entry.clone()).unwrap();
    let remote = tuple(&local, &f.table);
    assert_eq!(remote, tuple(&peer, &f.table));
    // Actual receive stores the envelope, changes observed revision and projection,
    // and consumes a previously prepared captured command without applying it.
    assert!(local.apply(pending, 0).is_err());
    assert!(
        local
            .prepare_commands(&revision, &[captured.clone()], &origin(), 0)
            .is_err()
    );
    assert!(
        local
            .prepare_commands(&local.read(0).unwrap().revision, &[captured], &origin(), 0)
            .is_err()
    );
    let r = local.read(0).unwrap().revision;
    local.undo(&r, 0).unwrap().unwrap();
    assert_eq!(tuple(&local, &f.table), remote);
    let paragraph = local
        .session()
        .document()
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == f.paragraph)
        .unwrap();
    assert_eq!(
        paragraph
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "surrounding"
    );
    let r = local.read(0).unwrap().revision;
    local.redo(&r, 0).unwrap().unwrap();
    assert_eq!(tuple(&local, &f.table), remote);
    let count = local_store.pending(&f.id).unwrap().len();
    local.receive_peer(entry).unwrap();
    assert_eq!(local_store.pending(&f.id).unwrap().len(), count);
    let reopened = EditService::new(
        Session::open(local_store.clone(), &f.id, CachedPermission::LOCAL).unwrap(),
        policy(),
    );
    assert_eq!(tuple(&reopened, &f.table), remote);
}
#[test]
fn independent_store_two_peer_envelopes_use_actual_session_receive_and_history() {
    use editac_session::ports::memory::MemoryStore;
    for v2 in [false, true] {
        for remote_structure in [false, true] {
            let f = Fixture::new(v2);
            let stores: Vec<_> = (0..2)
                .map(|_| {
                    let store =
                        Arc::new(MemoryStore::new(f.id.clone(), StoreLimits::default()).unwrap());
                    store.publish(0, f.base.clone()).unwrap();
                    store
                })
                .collect();
            let local = EditService::new(
                Session::open(stores[0].clone(), &f.id, CachedPermission::LOCAL).unwrap(),
                policy(),
            );
            let peer = EditService::new(
                Session::open(stores[1].clone(), &f.id, CachedPermission::LOCAL).unwrap(),
                policy(),
            );
            peer_case(
                &f,
                remote_structure,
                stores[0].clone(),
                local,
                stores[1].clone(),
                peer,
            );
        }
    }
}
