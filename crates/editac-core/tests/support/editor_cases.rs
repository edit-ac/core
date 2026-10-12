use super::{EXCHANGE_ENV, EXCHANGE_SCRIPT, identity, m};
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution, Selection},
    commands::{editor::*, format::*, structure::*, text::*},
    document::{
        BlockAttributes, CreationPermit, Document, DocumentError, DocumentIdentity, InitialNode,
        InitializedCheckpoint, ReplayUpdate,
    },
};
use std::{fs, path::PathBuf, process::Command};
use yrs::{Any, Map, ReadTxn, Transact, XmlTextPrelim};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const L: &str = "c:11:1";
const Q: &str = "c:11:2";
const K: &str = "c:11:3";
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn restore(bytes: &[u8]) -> Document {
    Document::restore(
        &identity(),
        &InitializedCheckpoint {
            identity: identity(),
            initialized: true,
            writer_id: 11,
            bytes: bytes.to_vec(),
        },
        &[],
    )
    .unwrap()
}
fn engine() -> Document {
    restore(&m::bytes(&m::seed()))
}
fn origin() -> TextOrigin {
    TextOrigin::new("editor:explicit").unwrap()
}
fn tuple(tag: &str) -> Any {
    m::arr(vec![Any::from(tag)])
}
fn block(id: &str, t: Any) -> EditorCommand {
    EditorCommand::Block {
        target: id.into(),
        tuple: t,
    }
}
fn code(id: &str, lang: &str) -> EditorCommand {
    block(id, m::arr(vec![Any::from("code"), Any::from(lang)]))
}
fn place(id: &str, parent: &str, before: Option<&str>) -> EditorCommand {
    EditorCommand::Place {
        target: id.into(),
        parent: parent.into(),
        before: before.map(String::from),
    }
}
fn batch(d: &mut Document, c: &[EditorCommand]) -> ReplayUpdate {
    let old = d.checkpoint().bytes;
    d.can_editor(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, old);
    let p = d.prepare_editor(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, old);
    d.commit_editor(p).unwrap().update
}
fn canonical(d: &Document) -> Any {
    d.snapshot().unwrap().retained_structure.unwrap()
}
fn value(d: &Document, id: &str) -> String {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}
fn insert(d: &mut Document, id: &str, at: u32, s: &str) -> ReplayUpdate {
    let p = d
        .prepare_text(
            &TextCommand::Insert {
                at: d.anchor(id, U(at), Bias::Right).unwrap(),
                text: s.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap().update.unwrap()
}
fn split(d: &mut Document, id: &str, at: u32) -> String {
    let c = StructureCommand::SplitOwner {
        owner: id.into(),
        at: d.anchor(id, U(at), Bias::Right).unwrap(),
    };
    let p = d.prepare_structure(&c, &origin()).unwrap();
    d.commit_structure(p).unwrap();
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id.starts_with(&format!("o:{}:", d.writer_id())) && n.id != id)
        .unwrap()
        .id
        .clone()
}
fn join(d: &mut Document, a: &str, b: &str) {
    let p = d
        .prepare_structure(
            &StructureCommand::JoinOwners {
                first: a.into(),
                second: b.into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_structure(p).unwrap();
}
fn stable(d: &Document, f: impl FnOnce() -> bool) {
    let b = d.checkpoint().bytes;
    let s = canonical(d);
    let r = d.revision();
    assert!(f());
    assert_eq!(d.checkpoint().bytes, b);
    assert_eq!(canonical(d), s);
    assert_eq!(d.revision(), r);
}
fn peer(d: &Document) -> yrs::Doc {
    let p = m::replica(1001);
    m::apply(&p, &d.checkpoint().bytes).unwrap();
    p
}
fn admit(d: &mut Document, p: &yrs::Doc) -> Result<(), DocumentError> {
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(p),
    })
}

#[test]
fn production_create_uses_exact_ten_roots_and_restored_empty_is_not_reseeded() {
    let id = super::profile_identity(
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21",
    )
    .unwrap();
    let d = Document::create(
        CreationPermit::authorize_new(id.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "😀".into(),
        }],
    )
    .unwrap();
    let p = peer(&d);
    assert_eq!(p.transact().root_refs().count(), 10);
    assert_eq!(m::project(&p).unwrap().sources.len(), 1);
    assert_eq!(canonical(&d), m::snapshot(&p).unwrap());
    let restored = Document::restore(&id, &d.checkpoint(), &[]).unwrap();
    assert_eq!(canonical(&restored), canonical(&d));
    assert_ne!(restored.writer_id(), d.writer_id());
    let empty_id = super::profile_identity(
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22",
    )
    .unwrap();
    let empty = Document::create(
        CreationPermit::authorize_new(empty_id.clone()).unwrap(),
        &[],
    )
    .unwrap();
    let restored = Document::restore(&empty_id, &empty.checkpoint(), &[]).unwrap();
    assert!(restored.snapshot().unwrap().visible.is_empty());
    assert!(matches!(
        CreationPermit::authorize_new(empty_id),
        Err(DocumentError::AlreadyInitialized)
    ));
}
#[test]
fn production_projection_matches_qualified_hierarchy_metadata_and_read_only_bytes() {
    let d = engine();
    let old = d.checkpoint().bytes;
    let s = d.snapshot().unwrap();
    assert_eq!(
        s.visible.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        [L, A, B, Q, K, C, D, "c:11:4"]
    );
    assert_eq!(s.visible.iter().find(|n| n.id == C).unwrap().parent, K);
    assert_eq!(s.visible.iter().find(|n| n.id == Q).unwrap().kind, "quote");
    assert_eq!(canonical(&d), m::snapshot(&m::seed()).unwrap());
    assert_eq!(d.checkpoint().bytes, old);
}
#[test]
fn prepared_nested_place_preserves_subtree_sources_marks_and_anchors() {
    let mut d = engine();
    let a = d.anchor(C, U(1), Bias::Right).unwrap();
    let before = peer(&d);
    let sources = m::project(&before).unwrap().sources;
    batch(&mut d, &[place(Q, L, Some(A)), place(B, K, Some(C))]);
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == Q)
            .unwrap()
            .parent,
        L
    );
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == C)
            .unwrap()
            .parent,
        K
    );
    assert_eq!(m::project(&peer(&d)).unwrap().sources, sources);
    assert!(
        matches!(d.resolve_anchor(&a).unwrap(),Resolution::Position(p) if p.node==C&&p.offset==U(1))
    );
}
#[test]
fn create_container_and_original_atomically_then_place_and_check() {
    let mut d = engine();
    let c = d.next_editor_id(true).unwrap();
    let n = d.next_editor_id(false).unwrap();
    batch(
        &mut d,
        &[
            EditorCommand::Create {
                id: c.clone(),
                kind: "list".into(),
                text: "".into(),
                tuple: tuple("checklist"),
            },
            place(&c, Q, None),
            EditorCommand::Create {
                id: n.clone(),
                kind: "block".into(),
                text: "new😀".into(),
                tuple: tuple("paragraph"),
            },
            place(&n, &c, None),
            EditorCommand::Check {
                target: n.clone(),
                checked: true,
            },
        ],
    );
    let v = m::project(&peer(&d)).unwrap();
    assert!(v.owners.iter().any(|o| o.id == n && o.parent == c));
    assert_eq!(value(&d, &n), "new😀");
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}
#[test]
fn nested_split_join_retains_checked_default_unicode_marks_and_original_identity() {
    let mut d = engine();
    let anchor = d.anchor(C, U(2), Bias::Left).unwrap();
    let sources = m::project(&peer(&d)).unwrap().sources;
    let right = split(&mut d, C, 2);
    let s = d.snapshot().unwrap();
    assert_eq!(s.visible.iter().find(|n| n.id == right).unwrap().parent, K);
    let p = peer(&d);
    assert_eq!(m::project(&p).unwrap().sources, sources);
    assert_eq!(
        p.transact()
            .get_map(m::ROOTS[8])
            .unwrap()
            .get(&p.transact(), &right),
        None
    );
    assert_eq!(value(&d, C), "é");
    assert_eq!(value(&d, &right), "Z");
    join(&mut d, C, &right);
    assert_eq!(value(&d, C), "éZ");
    assert!(matches!(
        d.resolve_anchor(&anchor).unwrap(),
        Resolution::Position(_)
    ));
}
#[test]
fn explicit_code_split_join_and_literal_newlines_preserve_dormant_marks() {
    let mut d = engine();
    batch(&mut d, &[code(A, "Rust+1.0")]);
    insert(&mut d, A, 1, "  \n\n ");
    assert_eq!(value(&d, A), "a  \n\n 😀b");
    let p = peer(&d);
    let rendered = m::policy::rendered_runs(&p, A).unwrap();
    assert!(
        matches!(rendered,Any::Array(a) if a.iter().all(|v|matches!(v,Any::Map(v) if v["attributes"]==m::obj(vec![]))))
    );
    let right = split(&mut d, A, 1);
    join(&mut d, A, &right);
    batch(&mut d, &[block(A, tuple("paragraph"))]);
    let s = d.snapshot().unwrap();
    let n = s.visible.iter().find(|n| n.id == A).unwrap();
    assert!(n.runs.iter().any(|r| r.attributes.contains_key("bold")));
    assert!(
        n.runs
            .iter()
            .filter(|r| r.text.contains('\n'))
            .all(|r| r.attributes.is_empty())
    );
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}
#[test]
fn separator_is_noneditable_and_last_editable_owner_reserves_adjacent_paragraph() {
    let id = super::profile_identity(
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23",
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "".into(),
        }],
    )
    .unwrap();
    let first = d.snapshot().unwrap().visible[0].id.clone();
    batch(&mut d, &[block(&first, tuple("separator"))]);
    let s = d.snapshot().unwrap();
    assert_eq!(s.visible.len(), 2);
    assert_eq!(s.visible[0].id, first);
    assert_eq!(
        s.visible[0].block_attributes,
        Some(BlockAttributes::Separator)
    );
    assert_eq!(
        s.visible[1].block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    let a = d.anchor(&first, U(0), Bias::Right).unwrap();
    stable(&d, || {
        d.prepare_text(
            &TextCommand::Insert {
                at: a.clone(),
                text: "X".into(),
            },
            &origin(),
        )
        .is_err()
    });
    stable(&d, || {
        matches!(
            d.prepare_structure(
                &StructureCommand::SplitOwner {
                    owner: first.clone(),
                    at: a.clone()
                },
                &origin()
            ),
            Err(StructureError::UnsupportedTarget)
        )
    });
    let adjacent = s.visible[1].id.clone();
    for (left, right) in [(&first, &adjacent), (&adjacent, &first)] {
        stable(&d, || {
            matches!(
                d.prepare_structure(
                    &StructureCommand::JoinOwners {
                        first: left.clone(),
                        second: right.clone()
                    },
                    &origin()
                ),
                Err(StructureError::UnsupportedTarget)
            )
        });
    }
}
#[test]
fn mixed_invalid_block_metadata_and_nonempty_separator_never_partially_write() {
    let d = engine();
    for bad in [
        m::arr(vec![Any::from("heading"), Any::from(7u32)]),
        m::arr(vec![Any::from("code"), Any::from("bad space")]),
        m::arr(vec![Any::from("code"), Any::from("x".repeat(65))]),
        tuple("separator"),
    ] {
        stable(&d, || {
            d.prepare_editor(&[code(D, ""), block(A, bad)], &origin())
                .is_err()
        });
    }
}
#[test]
fn cycles_illegal_parents_and_incompatible_joins_reject_before_commit() {
    let mut d = engine();
    for c in [
        place(Q, K, None),
        place(A, B, None),
        place(A, L, Some("absent")),
    ] {
        stable(&d, || {
            d.prepare_editor(&[code(D, "rust"), c], &origin()).is_err()
        });
    }
    batch(&mut d, &[code(C, "rust"), code(D, "js")]);
    stable(&d, || {
        d.prepare_structure(
            &StructureCommand::JoinOwners {
                first: C.into(),
                second: D.into(),
            },
            &origin(),
        )
        .is_err()
    });
    stable(&d, || {
        d.prepare_structure(
            &StructureCommand::JoinOwners {
                first: A.into(),
                second: C.into(),
            },
            &origin(),
        )
        .is_err()
    });
}
#[test]
fn rich_format_mixed_code_and_unknown_targets_reject_without_mark_changes() {
    let mut d = engine();
    batch(&mut d, &[code(C, "rust")]);
    let selection = Selection {
        anchor: d.anchor(B, U(0), Bias::Right).unwrap(),
        focus: d.anchor(C, U(1), Bias::Left).unwrap(),
    };
    stable(&d, || {
        d.prepare_format(
            &[FormatCommand {
                selection,
                mark: Mark::Bold,
                action: FormatAction::Apply,
                href: None,
            }],
            &origin(),
        )
        .is_err()
    });
    let p = peer(&d);
    m::set(&p, 4, A, m::arr(vec![Any::from("ext:opaque"), Any::Null]));
    admit(&mut d, &p).unwrap();
    stable(&d, || {
        d.prepare_text(
            &TextCommand::Insert {
                at: d.anchor(A, U(0), Bias::Right).unwrap(),
                text: "X".into(),
            },
            &origin(),
        )
        .is_err()
    });
}
#[test]
fn entity_controls_keep_immutable_rows_recovery_descendants_and_reactivate() {
    let mut d = engine();
    let a = d.anchor(C, U(1), Bias::Right).unwrap();
    let initial = peer(&d);
    let old = m::project(&initial).unwrap().sources;
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: K.into(),
            enabled: false,
        }],
    );
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == C)
            .unwrap()
            .parent,
        "@root"
    );
    assert!(matches!(
        d.resolve_anchor(&a).unwrap(),
        Resolution::Position(_)
    ));
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: C.into(),
            enabled: false,
        }],
    );
    assert!(matches!(
        d.resolve_anchor(&a).unwrap(),
        Resolution::Deleted { .. }
    ));
    assert_eq!(m::project(&peer(&d)).unwrap().sources, old);
    batch(
        &mut d,
        &[
            EditorCommand::Enable {
                target: C.into(),
                enabled: true,
            },
            EditorCommand::Enable {
                target: K.into(),
                enabled: true,
            },
        ],
    );
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == C)
            .unwrap()
            .parent,
        K
    );
}
#[test]
fn disabling_place_operation_replays_retained_intent_and_restores() {
    let mut d = engine();
    batch(&mut d, &[place(B, K, Some(C))]);
    let op = format!("o:{}:1", d.writer_id());
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: op.clone(),
            enabled: false,
        }],
    );
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == B)
            .unwrap()
            .parent,
        L
    );
    batch(
        &mut d,
        &[EditorCommand::Enable {
            target: op,
            enabled: true,
        }],
    );
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == B)
            .unwrap()
            .parent,
        K
    );
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}
#[test]
fn stale_and_cross_replica_plans_and_profile_epoch_fail_atomically() {
    let mut d = engine();
    let plan = d.prepare_editor(&[place(B, K, None)], &origin()).unwrap();
    insert(&mut d, A, 0, "X");
    let bytes = d.checkpoint().bytes;
    assert!(matches!(
        d.commit_editor(plan),
        Err(EditorError::Text(TextError::StalePlan))
    ));
    assert_eq!(bytes, d.checkpoint().bytes);
    let mut other = engine();
    let plan = d.prepare_editor(&[place(B, K, None)], &origin()).unwrap();
    assert!(matches!(
        other.commit_editor(plan),
        Err(EditorError::Text(TextError::WrongReplica))
    ));
    let old = other.checkpoint().bytes;
    let mut update = ReplayUpdate {
        identity: identity(),
        bytes: bytes.clone(),
    };
    update.identity.epoch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa24".into();
    assert_eq!(other.apply_replay(&update), Err(DocumentError::WrongEpoch));
    update.identity = DocumentIdentity::v3(identity().document_id, identity().epoch).unwrap();
    assert_eq!(
        other.apply_replay(&update),
        Err(DocumentError::UnsupportedProfile)
    );
    assert_eq!(other.checkpoint().bytes, old);
}
#[test]
fn malformed_immutable_root_source_tuple_and_resource_updates_are_atomic() {
    let mut d = engine();
    for root in [0, 2, 5, 6] {
        let p = peer(&d);
        if root == 5 {
            m::set(&p, root, "o:1001:1", m::arr(vec![Any::from("place")]));
        } else {
            m::set(&p, root, A, Any::from("corrupt"));
        }
        let b = d.checkpoint().bytes;
        assert!(admit(&mut d, &p).is_err());
        assert_eq!(d.checkpoint().bytes, b);
    }
    let p = peer(&d);
    m::set(
        &p,
        7,
        L,
        m::arr(vec![Any::from("ordered"), Any::from(0u32)]),
    );
    let b = d.checkpoint().bytes;
    assert!(admit(&mut d, &p).is_err());
    assert_eq!(d.checkpoint().bytes, b);
    let update = ReplayUpdate {
        identity: identity(),
        bytes: vec![0; 16 * 1024 * 1024 + 1],
    };
    assert_eq!(d.apply_replay(&update), Err(DocumentError::ResourceLimit));
    assert_eq!(d.checkpoint().bytes, b);
    stable(&d, || {
        matches!(
            d.prepare_editor(&vec![place(B, K, None); 4097], &origin()),
            Err(EditorError::ResourceLimit)
        )
    });
}
#[test]
fn real_production_three_replica_move_move_edit_six_orders_and_duplicate_restore() {
    let seed = engine().checkpoint().bytes;
    let mut one = restore(&seed);
    let mut two = restore(&seed);
    let mut three = restore(&seed);
    let updates = [
        batch(&mut one, &[place(B, K, Some(C))]),
        batch(&mut two, &[place(B, Q, Some(K))]),
        insert(&mut three, B, 1, "REMOTE😀"),
    ];
    let expected = {
        let mut d = restore(&seed);
        for u in &updates {
            d.apply_replay(u).unwrap();
        }
        canonical(&d)
    };
    for order in PERMS {
        let mut d = restore(&seed);
        for i in order {
            d.apply_replay(&updates[i]).unwrap();
            d.apply_replay(&updates[i]).unwrap();
        }
        assert_eq!(canonical(&d), expected);
        assert!(value(&d, B).contains("REMOTE😀"));
        assert_eq!(canonical(&restore(&d.checkpoint().bytes)), expected);
    }
}
#[test]
fn production_bidirectional_pinned_yjs_exchange_and_remote_unknown_recovery() {
    let dir = PathBuf::from(
        std::env::var_os(EXCHANGE_ENV).expect("isolated production exchange directory required"),
    );
    fs::create_dir_all(&dir).unwrap();
    let mut d = engine();
    fs::write(dir.join("rust-seed.bin"), d.checkpoint().bytes).unwrap();
    batch(
        &mut d,
        &[
            place(B, K, Some(C)),
            code(A, "rust"),
            EditorCommand::Container {
                target: L.into(),
                tuple: m::arr(vec![Any::from("ordered"), Any::from(12u32)]),
            },
        ],
    );
    insert(&mut d, A, 1, " \n\n ");
    let right = split(&mut d, A, 1);
    join(&mut d, A, &right);
    batch(
        &mut d,
        &[
            EditorCommand::Enable {
                target: Q.into(),
                enabled: false,
            },
            EditorCommand::Enable {
                target: Q.into(),
                enabled: true,
            },
        ],
    );
    fs::write(dir.join("rust-final.bin"), d.checkpoint().bytes).unwrap();
    fs::write(dir.join("rust-final.json"), m::json(&canonical(&d))).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .args(["--test", EXCHANGE_SCRIPT])
        .current_dir(root)
        .env(EXCHANGE_ENV, &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [output.stdout, output.stderr].concat(),
    )
    .unwrap();
    assert!(
        output.status.success(),
        "pinned production Yjs failed: {}",
        dir.join("node.log").display()
    );
    let bytes = fs::read(dir.join("yjs-final.bin")).unwrap();
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes,
    })
    .unwrap();
    let expected =
        Any::from_json(&fs::read_to_string(dir.join("yjs-final.json")).unwrap()).unwrap();
    assert_eq!(canonical(&d), expected);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), expected);
}

#[test]
fn shared_formatting_crosses_nested_containers_and_empty_block_tuples_are_atomic() {
    let mut d = engine();
    let selection = Selection {
        anchor: d.anchor(A, U(0), Bias::Right).unwrap(),
        focus: d.anchor(C, U(2), Bias::Left).unwrap(),
    };
    let p = d
        .prepare_format_batch(
            &[FormatCommand {
                selection,
                mark: Mark::Italic,
                action: FormatAction::Apply,
                href: None,
            }],
            &[BlockFormatCommand {
                targets: vec![D.into()],
                attributes: BlockAttributes::Heading(4),
                action: FormatAction::Apply,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_format(p).unwrap();
    let s = d.snapshot().unwrap();
    assert_eq!(
        s.visible
            .iter()
            .find(|n| n.id == D)
            .unwrap()
            .block_attributes,
        Some(BlockAttributes::Heading(4))
    );
    for id in [A, B, C] {
        assert!(
            s.visible
                .iter()
                .find(|n| n.id == id)
                .unwrap()
                .runs
                .iter()
                .any(|r| r.attributes.get("italic") == Some(&Any::Bool(true)))
        );
    }
    assert_eq!(s.visible.iter().find(|n| n.id == C).unwrap().parent, K);
}

#[test]
fn metadata_only_changes_rebuild_check_number_and_revision_and_stale_all_plans() {
    let mut d = engine();
    d.snapshot().unwrap();
    let text = d
        .prepare_text(
            &TextCommand::Insert {
                at: d.anchor(A, U(0), Bias::Right).unwrap(),
                text: "X".into(),
            },
            &origin(),
        )
        .unwrap();
    let structure = d
        .prepare_structure(
            &StructureCommand::SplitOwner {
                owner: A.into(),
                at: d.anchor(A, U(1), Bias::Right).unwrap(),
            },
            &origin(),
        )
        .unwrap();
    let selection = Selection {
        anchor: d.anchor(A, U(0), Bias::Right).unwrap(),
        focus: d.anchor(A, U(1), Bias::Left).unwrap(),
    };
    let format = d
        .prepare_format(
            &[FormatCommand {
                selection,
                mark: Mark::Italic,
                action: FormatAction::Apply,
                href: None,
            }],
            &origin(),
        )
        .unwrap();
    batch(
        &mut d,
        &[
            EditorCommand::Check {
                target: C.into(),
                checked: false,
            },
            EditorCommand::Container {
                target: L.into(),
                tuple: m::arr(vec![Any::from("ordered"), Any::from(21u32)]),
            },
        ],
    );
    let s = d.snapshot().unwrap();
    assert!(s.changed_nodes.contains(C));
    assert!(s.changed_nodes.contains(A));
    assert_eq!(
        s.visible
            .iter()
            .find(|n| n.id == C)
            .unwrap()
            .editor
            .as_ref()
            .unwrap()
            .checked,
        Some(false)
    );
    assert_eq!(
        s.visible
            .iter()
            .find(|n| n.id == A)
            .unwrap()
            .editor
            .as_ref()
            .unwrap()
            .number,
        Some(21)
    );
    let b = d.checkpoint().bytes;
    assert!(matches!(d.commit_text(text), Err(TextError::StalePlan)));
    assert!(matches!(
        d.commit_structure(structure),
        Err(StructureError::Text(TextError::StalePlan))
    ));
    assert!(matches!(
        d.commit_format(format),
        Err(FormatError::Text(TextError::StalePlan))
    ));
    assert_eq!(d.checkpoint().bytes, b);
}

#[test]
fn production_nested_endpoint_empty_and_repeated_split_after_multi_source_join() {
    for (id, at) in [(A, 0), (A, 4), (D, 0)] {
        let mut d = engine();
        let original = value(&d, id);
        let right = split(&mut d, id, at);
        join(&mut d, id, &right);
        assert_eq!(value(&d, id), original);
        assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
    }
    let mut d = engine();
    join(&mut d, C, D);
    let right = split(&mut d, C, 1);
    join(&mut d, C, &right);
    let second = split(&mut d, C, 2);
    join(&mut d, C, &second);
    assert_eq!(value(&d, C), "éZ");
    let v = m::project(&peer(&d)).unwrap();
    assert_eq!(v.sources.len(), 4);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}

#[test]
fn opaque_immutable_source_and_container_admit_read_only_and_keep_children() {
    let mut d = engine();
    let p = peer(&d);
    {
        let mut t = p.transact_mut_with("remote:opaque");
        for (id, kind, parent) in [
            ("c:1001:1", "ext:container", "@root"),
            ("n:1001:1", "item", "c:1001:1"),
        ] {
            t.get_map(m::ROOTS[0]).unwrap().insert(&mut t, id, kind);
            t.get_map(m::ROOTS[2]).unwrap().insert(
                &mut t,
                id,
                m::arr(vec![Any::from(parent), Any::from(30u32)]),
            );
        }
        t.get_map(m::ROOTS[7]).unwrap().insert(
            &mut t,
            "c:1001:1",
            m::arr(vec![Any::from("ext:container"), Any::Null]),
        );
        t.get_map(m::ROOTS[1]).unwrap().insert(
            &mut t,
            "n:1001:1",
            XmlTextPrelim::new("retained😀"),
        );
        t.get_map(m::ROOTS[6])
            .unwrap()
            .insert(&mut t, "n:1001:1", true);
    }
    admit(&mut d, &p).unwrap();
    assert_eq!(value(&d, "n:1001:1"), "retained😀");
    assert_eq!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == "n:1001:1")
            .unwrap()
            .parent,
        "@root"
    );
    stable(&d, || {
        d.prepare_text(
            &TextCommand::Insert {
                at: d.anchor("n:1001:1", U(0), Bias::Right).unwrap(),
                text: "X".into(),
            },
            &origin(),
        )
        .is_err()
    });
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}

#[test]
fn depth_128_text_is_editable_and_whole_subtree_depth_overflow_rejects_atomically() {
    let p = m::replica(42);
    {
        let mut t = p.transact_mut_with("fixture:depth");
        for i in 1..=128 {
            let id = format!("c:42:{i}");
            let parent = if i == 1 {
                "@root".into()
            } else {
                format!("c:42:{}", i - 1)
            };
            t.get_map(m::ROOTS[0])
                .unwrap()
                .insert(&mut t, id.clone(), "quote");
            t.get_map(m::ROOTS[2]).unwrap().insert(
                &mut t,
                id.clone(),
                m::arr(vec![Any::from(parent), Any::from(0u32)]),
            );
            t.get_map(m::ROOTS[7])
                .unwrap()
                .insert(&mut t, id, tuple("quote"));
        }
        t.get_map(m::ROOTS[0])
            .unwrap()
            .insert(&mut t, "n:42:1", "block");
        t.get_map(m::ROOTS[2]).unwrap().insert(
            &mut t,
            "n:42:1",
            m::arr(vec![Any::from("c:42:128"), Any::from(0u32)]),
        );
        t.get_map(m::ROOTS[1])
            .unwrap()
            .insert(&mut t, "n:42:1", XmlTextPrelim::new("deep"));
        t.get_map(m::ROOTS[6])
            .unwrap()
            .insert(&mut t, "n:42:1", true);
    }
    let mut d = restore(&m::bytes(&p));
    insert(&mut d, "n:42:1", 4, "😀");
    assert_eq!(value(&d, "n:42:1"), "deep😀");
    let new = d.next_editor_id(true).unwrap();
    stable(&d, || {
        matches!(
            d.prepare_editor(
                &[
                    EditorCommand::Create {
                        id: new.clone(),
                        kind: "quote".into(),
                        text: "".into(),
                        tuple: tuple("quote")
                    },
                    place("c:42:1", &new, None)
                ],
                &origin()
            ),
            Err(EditorError::ResourceLimit)
        )
    });
}

#[test]
fn inaccessible_separator_neighbor_identity_overflow_and_nonempty_creation_are_atomic() {
    let id = super::profile_identity(
        "99999999-9999-4999-8999-999999999999",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa25",
    )
    .unwrap();
    let d = Document::create(CreationPermit::authorize_new(id).unwrap(), &[]).unwrap();
    let n = format!("n:{}:{}", d.writer_id(), u32::MAX);
    stable(&d, || {
        matches!(
            d.prepare_editor(
                &[EditorCommand::Create {
                    id: n.clone(),
                    kind: "block".into(),
                    text: "".into(),
                    tuple: tuple("separator")
                }],
                &origin()
            ),
            Err(EditorError::ResourceLimit)
        )
    });
    stable(&d, || {
        d.prepare_editor(
            &[EditorCommand::Create {
                id: d.next_editor_id(false).unwrap(),
                kind: "block".into(),
                text: "must stay".into(),
                tuple: tuple("separator"),
            }],
            &origin(),
        )
        .is_err()
    });
}
