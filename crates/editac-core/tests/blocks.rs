//! ENG-1.9 production block policy, real replay/admission and pinned exchange.
#[path = "../../../fixtures/schema-v4/mapping.rs"]
#[allow(dead_code)]
mod legacy;
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Resolution, Selection},
    commands::{blocks::*, editor::*, format::*, text::*},
    document::{BlockAttributes, Document, DocumentIdentity, InitializedCheckpoint, ReplayUpdate},
};
use std::{fs, path::PathBuf, process::Command};
use yrs::{Any, Map, ReadTxn, Transact};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
const PERMS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn identity() -> DocumentIdentity {
    DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap()
}
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
    TextOrigin::new("blocks:explicit").unwrap()
}
fn code(owner: &str, language: &str) -> BlockCommand {
    BlockCommand::SetCode {
        owner: owner.into(),
        language: language.into(),
    }
}
fn paragraph(owner: &str) -> BlockCommand {
    BlockCommand::SetParagraph {
        owner: owner.into(),
    }
}
fn text(d: &Document, id: &str, at: u32, value: &str) -> BlockCommand {
    BlockCommand::Text(TextCommand::Insert {
        at: d.anchor(id, U(at), Bias::Right).unwrap(),
        text: value.into(),
    })
}
fn batch(d: &mut Document, c: &[BlockCommand]) -> ReplayUpdate {
    let bytes = d.checkpoint().bytes;
    let revision = d.revision();
    d.can_blocks(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), revision);
    let p = d.prepare_blocks(c, &origin()).unwrap();
    assert_eq!(d.checkpoint().bytes, bytes);
    let commit = d.commit_blocks(p).unwrap();
    assert_eq!(commit.origin, origin());
    assert_eq!(commit.revision, revision + 1);
    commit.update
}
fn node(d: &Document, id: &str) -> editac_core::projection::ProjectedNode {
    d.snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == id)
        .unwrap()
        .as_ref()
        .clone()
}
fn value(d: &Document, id: &str) -> String {
    node(d, id).runs.iter().map(|r| r.text.as_str()).collect()
}
fn canonical(d: &Document) -> Any {
    d.snapshot().unwrap().retained_structure.unwrap()
}
fn reject(d: &Document, c: &[BlockCommand]) {
    let bytes = d.checkpoint().bytes;
    let v = d.revision();
    assert!(d.prepare_blocks(c, &origin()).is_err());
    assert!(d.can_blocks(c, &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, bytes);
    assert_eq!(d.revision(), v);
}
fn lone() -> Document {
    let seed = m::seed();
    for id in [A, B, C] {
        m::set(
            &seed,
            9,
            id,
            m::arr(vec![Any::from("enabled"), Any::Bool(false)]),
        );
    }
    restore(&m::bytes(&seed))
}
#[test]
fn code_literal_whitespace_blank_lines_dormant_marks_and_empty_restore() {
    let mut d = engine();
    let original = node(&d, A);
    let anchor = d.anchor(A, U(3), Bias::Left).unwrap();
    let insertion = text(&d, A, 1, " \t\n\n ");
    batch(
        &mut d,
        &[
            code(A, "future.lang+v_1-2"),
            insertion,
            BlockCommand::HardBreak { at: anchor },
        ],
    );
    assert_eq!(value(&d, A), "a \t\n\n 😀\nb");
    assert!(
        node(&d, A)
            .runs
            .iter()
            .filter(|r| r.text.contains('\n') || r.text.contains('\t'))
            .all(|r| r.attributes.is_empty())
    );
    batch(&mut d, &[paragraph(A)]);
    let n = node(&d, A);
    assert_eq!(n.spans[0].identity, original.spans[0].identity);
    assert!(
        n.runs
            .iter()
            .filter(|r| r.text.contains('a') || r.text.contains('b'))
            .all(|r| r.attributes.get("bold") == Some(&Any::Bool(true))
                && r.attributes.contains_key("ext:future"))
    );
    batch(&mut d, &[code(D, "")]);
    assert_eq!(value(&restore(&d.checkpoint().bytes), D), "");
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}
#[test]
fn code_language_bounds_and_mixed_invalid_batches_are_atomic() {
    let d = engine();
    for bad in ["x y", "é", "x\n", "x/rs", &"x".repeat(65)] {
        reject(&d, &[code(B, "rust"), code(A, bad)]);
    }
    let mut d = d;
    batch(&mut d, &[code(A, &"x".repeat(64))]);
    assert_eq!(
        node(&d, A).block_attributes,
        Some(BlockAttributes::Code("x".repeat(64)))
    );
    reject(
        &d,
        &[
            paragraph(A),
            BlockCommand::ConvertSeparator { owner: B.into() },
        ],
    );
    reject(&d, &[text(&d, A, 0, "ack"), code(B, "invalid language")]);
    assert!(!value(&d, A).contains("ack"));
}
#[test]
fn code_split_endpoints_and_matching_join_preserve_original_sources() {
    for at in [0, 1, 3, 4] {
        let mut d = engine();
        batch(&mut d, &[code(A, "rust")]);
        let before = node(&d, A);
        let a = d.anchor(A, U(at), Bias::Right).unwrap();
        batch(
            &mut d,
            &[BlockCommand::Split {
                owner: A.into(),
                at: a,
            }],
        );
        let s = d.snapshot().unwrap();
        let right = s.visible.iter().find(|n| n.id.starts_with("o:")).unwrap();
        let id = right.id.clone();
        assert_eq!(
            right.block_attributes,
            Some(BlockAttributes::Code("rust".into()))
        );
        assert_eq!(format!("{}{}", value(&d, A), value(&d, &id)), "a😀b");
        batch(
            &mut d,
            &[BlockCommand::Join {
                first: A.into(),
                second: id.clone(),
            }],
        );
        assert_eq!(value(&d, A), "a😀b");
        assert!(
            node(&d, A)
                .spans
                .iter()
                .all(|s| s.identity == before.spans[0].identity)
        );
        assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
    }
    let mut d = engine();
    batch(&mut d, &[code(D, "")]);
    let a = d.anchor(D, U(0), Bias::Right).unwrap();
    batch(
        &mut d,
        &[BlockCommand::Split {
            owner: D.into(),
            at: a,
        }],
    );
    let right = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id.starts_with("o:"))
        .unwrap()
        .id
        .clone();
    batch(
        &mut d,
        &[BlockCommand::Join {
            first: D.into(),
            second: right,
        }],
    );
    assert_eq!(value(&d, D), "");
}
#[test]
fn incompatible_join_and_rich_format_on_code_reject_without_mutation() {
    let mut d = engine();
    batch(&mut d, &[code(A, "rust"), code(B, "js")]);
    reject(
        &d,
        &[BlockCommand::Join {
            first: A.into(),
            second: B.into(),
        }],
    );
    let selection = Selection {
        anchor: d.anchor(A, U(0), Bias::Right).unwrap(),
        focus: d.anchor(B, U(1), Bias::Left).unwrap(),
    };
    let bytes = d.checkpoint().bytes;
    assert!(
        d.prepare_format_batch(
            &[FormatCommand {
                selection,
                mark: Mark::Italic,
                action: FormatAction::Apply,
                href: None
            }],
            &[],
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, bytes);
    batch(&mut d, &[paragraph(A)]);
    reject(
        &d,
        &[BlockCommand::Join {
            first: A.into(),
            second: B.into(),
        }],
    );
}
#[test]
fn hard_break_in_rich_text_keeps_owner_and_newline_is_not_a_split() {
    let mut d = engine();
    let a = d.anchor(A, U(1), Bias::Right).unwrap();
    let spans = node(&d, A).spans;
    batch(&mut d, &[BlockCommand::HardBreak { at: a }]);
    assert_eq!(value(&d, A), "a\n😀b");
    assert_eq!(node(&d, A).spans[0].identity, spans[0].identity);
    assert!(
        !d.snapshot()
            .unwrap()
            .visible
            .iter()
            .any(|n| n.id.starts_with("o:"))
    );
}
#[test]
fn separators_insert_both_sides_preserve_nested_identity_and_navigate() {
    for side in [Side::Before, Side::After] {
        let mut d = engine();
        let original = node(&d, A);
        let id = d.next_editor_id(false).unwrap();
        batch(
            &mut d,
            &[BlockCommand::InsertSeparator {
                beside: A.into(),
                side,
            }],
        );
        let sep = node(&d, &id);
        assert_eq!(sep.parent, original.parent);
        assert_eq!(value(&d, A), "a😀b");
        assert_eq!(node(&d, A).spans, original.spans);
        assert_eq!(sep.block_attributes, Some(BlockAttributes::Separator));
        let s = d.snapshot().unwrap();
        let ai = s.visible.iter().position(|n| n.id == A).unwrap();
        let si = s.visible.iter().position(|n| n.id == id).unwrap();
        assert_eq!(si < ai, side == Side::Before);
        for dir in [Side::Before, Side::After] {
            assert!(matches!(
                d.resolve_anchor(&d.navigate_separator(&id, dir).unwrap())
                    .unwrap(),
                Resolution::Position(_)
            ));
        }
        let p = d.next_editor_id(false).unwrap();
        batch(
            &mut d,
            &[BlockCommand::InsertParagraph {
                separator: id.clone(),
                side: Side::After,
                text: "typing😀".into(),
            }],
        );
        assert_eq!(value(&d, &p), "typing😀");
        assert_eq!(node(&d, &p).parent, sep.parent);
        batch(
            &mut d,
            &[BlockCommand::DeleteSeparator { owner: id.clone() }],
        );
        assert!(!d.snapshot().unwrap().visible.iter().any(|n| n.id == id));
        assert_eq!(value(&d, &p), "typing😀");
    }
}
#[test]
fn separator_conversion_reserves_accessible_empty_paragraph_atomically() {
    let mut d = lone();
    let source = node(&d, D).spans;
    let fresh = d.next_editor_id(false).unwrap();
    batch(
        &mut d,
        &[BlockCommand::ConvertSeparator { owner: D.into() }],
    );
    assert_eq!(node(&d, D).spans, source);
    assert_eq!(
        node(&d, &fresh).block_attributes,
        Some(BlockAttributes::Paragraph)
    );
    assert_eq!(node(&d, &fresh).parent, node(&d, D).parent);
    assert_eq!(value(&d, &fresh), "");
    for side in [Side::Before, Side::After] {
        assert!(
            matches!(d.resolve_anchor(&d.navigate_separator(D,side).unwrap()).unwrap(),Resolution::Position(p) if p.node==fresh && p.offset==U(0))
        );
    }
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}
#[test]
fn separator_rejects_text_split_join_nonempty_and_wrong_navigation_targets() {
    let mut d = engine();
    let a = d.anchor(D, U(0), Bias::Right).unwrap();
    batch(
        &mut d,
        &[BlockCommand::ConvertSeparator { owner: D.into() }],
    );
    reject(
        &d,
        &[code(A, "rust"), BlockCommand::HardBreak { at: a.clone() }],
    );
    reject(
        &d,
        &[BlockCommand::Split {
            owner: D.into(),
            at: a.clone(),
        }],
    );
    reject(
        &d,
        &[BlockCommand::Join {
            first: C.into(),
            second: D.into(),
        }],
    );
    reject(&d, &[BlockCommand::ConvertSeparator { owner: A.into() }]);
    assert!(d.navigate_separator(A, Side::After).is_err());
    reject(&d, &[BlockCommand::DeleteSeparator { owner: A.into() }]);
    reject(
        &d,
        &[BlockCommand::InsertParagraph {
            separator: A.into(),
            side: Side::After,
            text: String::new(),
        }],
    );
}
#[test]
fn deleting_only_separator_prepares_neighbor_and_retains_recovery_identity() {
    let mut d = lone();
    batch(
        &mut d,
        &[BlockCommand::ConvertSeparator { owner: D.into() }],
    );
    let fresh = d.next_editor_id(false).unwrap();
    let edit = d
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.block_attributes == Some(BlockAttributes::Paragraph))
        .unwrap()
        .id
        .clone();
    let p = d
        .prepare_editor(
            &[EditorCommand::Enable {
                target: edit,
                enabled: false,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    batch(&mut d, &[BlockCommand::DeleteSeparator { owner: D.into() }]);
    assert_eq!(value(&d, &fresh), "");
    assert!(d.snapshot().unwrap().recovery.iter().any(|n| n.id == D));
}
#[test]
fn stale_wrong_replica_deleted_anchor_and_resource_rejection_are_atomic() {
    let mut d = engine();
    let p = d.prepare_blocks(&[code(A, "rust")], &origin()).unwrap();
    let c = text(&d, B, 0, "remote");
    batch(&mut d, &[c]);
    let bytes = d.checkpoint().bytes;
    assert!(matches!(
        d.commit_blocks(p),
        Err(EditorError::Text(TextError::StalePlan))
    ));
    assert_eq!(d.checkpoint().bytes, bytes);
    let p = d.prepare_blocks(&[code(A, "rust")], &origin()).unwrap();
    let mut other = restore(&bytes);
    let original = other.checkpoint().bytes;
    assert!(matches!(
        other.commit_blocks(p),
        Err(EditorError::Text(TextError::WrongReplica))
    ));
    assert_eq!(other.checkpoint().bytes, original);
    let a = d.anchor(A, U(0), Bias::Right).unwrap();
    let p = d
        .prepare_editor(
            &[EditorCommand::Enable {
                target: A.into(),
                enabled: false,
            }],
            &origin(),
        )
        .unwrap();
    d.commit_editor(p).unwrap();
    reject(&d, &[BlockCommand::HardBreak { at: a }]);
    reject(&d, &vec![code(B, "rs"); 4097]);
    reject(&d, &[text(&d, B, 0, &"x".repeat(MAX_EDIT_BYTES + 1))]);
}
#[test]
fn last_editable_separator_reservation_resource_failure_leaves_live_state_exact() {
    let seed = m::seed();
    for id in [A, B, C] {
        m::set(
            &seed,
            9,
            id,
            m::arr(vec![Any::from("enabled"), Any::Bool(false)]),
        );
    }
    // Fill retained registration ceiling with empty separators. Admission is valid;
    // converting the sole editable owner needs one extra identity and must fail.
    for counter in 5..4093 {
        let id = format!("n:11:{counter}");
        let mut t = seed.transact_mut();
        t.get_map(m::ROOTS[0])
            .unwrap()
            .insert(&mut t, id.as_str(), "block");
        t.get_map(m::ROOTS[1])
            .unwrap()
            .insert(&mut t, id.as_str(), yrs::XmlTextPrelim::new(""));
        t.get_map(m::ROOTS[2]).unwrap().insert(
            &mut t,
            id.as_str(),
            m::arr(vec![Any::from("@root"), Any::from(counter as u32)]),
        );
        t.get_map(m::ROOTS[4]).unwrap().insert(
            &mut t,
            id.as_str(),
            m::arr(vec![Any::from("separator")]),
        );
        t.get_map(m::ROOTS[6])
            .unwrap()
            .insert(&mut t, id.as_str(), true);
    }
    let d = restore(&m::bytes(&seed));
    reject(&d, &[BlockCommand::ConvertSeparator { owner: D.into() }]);
}
#[test]
fn three_writer_code_metadata_literal_edit_and_separator_races_replay_restore() {
    for family in 0..3 {
        let mut seed = engine();
        batch(&mut seed, &[code(A, "rust")]);
        let bytes = seed.checkpoint().bytes;
        let mut writers = [restore(&bytes), restore(&bytes), restore(&bytes)];
        let changes = match family {
            0 => [
                code(A, "js"),
                text(&seed, A, 1, "ONE"),
                text(&seed, A, 3, "TWO"),
            ],
            1 => [
                paragraph(A),
                text(&seed, A, 1, "ONE"),
                code(A, "unknown.lang"),
            ],
            _ => [
                BlockCommand::ConvertSeparator { owner: D.into() },
                BlockCommand::InsertSeparator {
                    beside: A.into(),
                    side: Side::After,
                },
                text(&seed, A, 1, "ONE"),
            ],
        };
        let updates: Vec<_> = writers
            .iter_mut()
            .zip(changes)
            .map(|(d, c)| batch(d, &[c]))
            .collect();
        let mut expected = None;
        for perm in PERMS {
            let mut receiver = restore(&bytes);
            for i in perm {
                receiver.apply_replay(&updates[i]).unwrap();
                receiver.apply_replay(&updates[i]).unwrap();
            }
            let v = value(&receiver, A);
            assert!(v.contains("ONE"));
            if family == 0 {
                assert!(v.contains("TWO"));
                assert_eq!(v, "aONE😀TWOb");
            } else {
                assert_eq!(v, "aONE😀b");
            }
            assert_eq!(
                node(&receiver, A).spans[0].identity,
                node(&seed, A).spans[0].identity
            );
            let view = canonical(&receiver);
            assert_eq!(canonical(&restore(&receiver.checkpoint().bytes)), view);
            if let Some(e) = &expected {
                assert_eq!(e, &view);
            } else {
                expected = Some(view);
            }
        }
    }
}
#[test]
fn production_blocks_bidirectional_pinned_yjs_exchange_and_restore() {
    let dir = PathBuf::from(
        std::env::var_os("EDITAC_BLOCK_COMMAND_EXCHANGE")
            .expect("isolated exchange directory required"),
    );
    fs::create_dir_all(&dir).unwrap();
    let mut d = engine();
    fs::write(dir.join("rust-seed.bin"), d.checkpoint().bytes).unwrap();
    let insertion = text(&d, A, 1, " \t\n\n ");
    batch(
        &mut d,
        &[
            code(A, "unknown.lang+v_1"),
            insertion,
            BlockCommand::ConvertSeparator { owner: D.into() },
        ],
    );
    fs::write(dir.join("rust-final.bin"), d.checkpoint().bytes).unwrap();
    fs::write(dir.join("rust-final.json"), m::json(&canonical(&d))).unwrap();
    let output = Command::new("node")
        .args(["--test", "fixtures/schema-v5/blocks-exchange.mjs"])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("EDITAC_BLOCK_COMMAND_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [output.stdout, output.stderr].concat(),
    )
    .unwrap();
    assert!(
        output.status.success(),
        "pinned exchange failed; see node.log"
    );
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: fs::read(dir.join("yjs-final.bin")).unwrap(),
    })
    .unwrap();
    let expected =
        Any::from_json(&fs::read_to_string(dir.join("yjs-final.json")).unwrap()).unwrap();
    assert_eq!(canonical(&d), expected);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), expected);
    assert_eq!(value(&d, A), "a \t\n\n 😀bYJS\n\n");
}

#[test]
fn joined_original_code_replacement_and_deletion_preserve_literal_policy_and_anchors() {
    let mut d = engine();
    batch(
        &mut d,
        &[
            code(A, "rs"),
            code(B, "rs"),
            BlockCommand::Join {
                first: A.into(),
                second: B.into(),
            },
        ],
    );
    let spans = node(&d, A).spans;
    let retained = d.anchor(A, U(7), Bias::Right).unwrap();
    let selection = Selection {
        anchor: d.anchor(A, U(3), Bias::Right).unwrap(),
        focus: d.anchor(A, U(6), Bias::Left).unwrap(),
    };
    batch(
        &mut d,
        &[BlockCommand::Text(TextCommand::Replace {
            selection,
            text: "\n\n".into(),
        })],
    );
    assert_eq!(value(&d, A), "a😀\n\nבd");
    assert!(
        node(&d, A)
            .runs
            .iter()
            .filter(|r| r.text.contains('\n'))
            .all(|r| r.attributes.is_empty())
    );
    assert!(
        matches!(d.resolve_anchor(&retained).unwrap(),Resolution::Position(p) if p.node==A && p.offset==U(6))
    );
    let selection = Selection {
        anchor: d.anchor(A, U(3), Bias::Right).unwrap(),
        focus: d.anchor(A, U(5), Bias::Left).unwrap(),
    };
    batch(
        &mut d,
        &[
            BlockCommand::Text(TextCommand::Delete { selection }),
            paragraph(A),
        ],
    );
    assert_eq!(value(&d, A), "a😀בd");
    assert!(
        node(&d, A)
            .spans
            .iter()
            .zip(spans)
            .all(|(a, b)| a.identity == b.identity)
    );
}
#[test]
fn v3_profile_and_wrong_epoch_anchors_do_not_acquire_v4_roots_or_mutate() {
    let mut d = engine();
    let other_identity = DocumentIdentity::v5(
        "77777777-7777-4777-8777-777777777777",
        "99999999-9999-4999-8999-999999999999",
    )
    .unwrap();
    let other = Document::restore(
        &other_identity,
        &InitializedCheckpoint {
            identity: other_identity.clone(),
            initialized: true,
            writer_id: 11,
            bytes: d.checkpoint().bytes,
        },
        &[],
    )
    .unwrap();
    let anchor = other.anchor(A, U(0), Bias::Right).unwrap();
    reject(&d, &[code(B, "rs"), BlockCommand::HardBreak { at: anchor }]);
    let v3 = DocumentIdentity::v3(
        "12121212-1212-4212-8212-121212121212",
        "34343434-3434-4343-8343-343434343434",
    )
    .unwrap();
    let legacy = Document::create(
        editac_core::document::CreationPermit::authorize_new(v3).unwrap(),
        &[],
    )
    .unwrap();
    let bytes = legacy.checkpoint().bytes;
    assert!(matches!(
        legacy.prepare_blocks(&[], &origin()),
        Err(EditorError::UnsupportedProfile)
    ));
    assert_eq!(legacy.checkpoint().bytes, bytes);
    batch(&mut d, &[code(A, "rs")]);
}

#[test]
fn legacy_v4_presentation_changes_that_invalidate_retained_joins_reject_whole_local_batch() {
    let id = DocumentIdentity::v4(identity().document_id, identity().epoch).unwrap();
    let mut d = Document::restore(
        &id,
        &InitializedCheckpoint {
            identity: id.clone(),
            initialized: true,
            writer_id: 11,
            bytes: legacy::bytes(&legacy::seed()),
        },
        &[],
    )
    .unwrap();
    batch(
        &mut d,
        &[
            code(A, "rs"),
            code(B, "rs"),
            BlockCommand::Join {
                first: A.into(),
                second: B.into(),
            },
        ],
    );
    let bytes = d.checkpoint().bytes;
    for c in [paragraph(A), code(A, "js")] {
        let mixed = [text(&d, A, 0, "must-not-commit"), c];
        assert!(matches!(
            d.prepare_blocks(&mixed, &origin()),
            Err(EditorError::PresentationConflict)
        ));
        assert_eq!(d.checkpoint().bytes, bytes);
    }
    batch(&mut d, &[code(A, "rs")]);
    assert_eq!(value(&d, A), "a😀bcאבd");
}

fn joined_code() -> Document {
    let mut d = engine();
    batch(
        &mut d,
        &[
            code(A, "rs"),
            code(B, "rs"),
            BlockCommand::Join {
                first: A.into(),
                second: B.into(),
            },
        ],
    );
    d
}
fn ownership(d: &Document, id: &str) -> (String, String, Vec<(String, String)>) {
    let n = node(d, id);
    // Public canonical state supplies the structural version; spans carry stable identities.
    let raw = m::replica(2002);
    m::apply(&raw, &d.checkpoint().bytes).unwrap();
    let v = m::project(&raw).unwrap();
    let o = v.owners.iter().find(|o| o.id == id).unwrap();
    (
        o.version.clone(),
        n.parent.clone(),
        n.spans
            .into_iter()
            .map(|s| (s.source, s.identity))
            .collect(),
    )
}
#[test]
fn v5_joined_language_paragraph_heading_and_opaque_changes_keep_witnesses_ownership_marks_and_anchors()
 {
    let mut d = joined_code();
    let before = ownership(&d, A);
    let anchor = d.anchor(A, U(6), Bias::Right).unwrap();
    let initial = d.checkpoint().bytes;
    let raw = m::replica(2003);
    m::apply(&raw, &initial).unwrap();
    let ops = operation_rows(&raw);
    for tuple in [
        m::arr(vec![Any::from("code"), Any::from("js")]),
        m::arr(vec![Any::from("paragraph")]),
        m::arr(vec![Any::from("heading"), Any::from(6u32)]),
        m::arr(vec![
            Any::from("ext:future"),
            m::obj(vec![("retained", Any::Bool(true))]),
        ]),
    ] {
        let rev = d.revision();
        if matches!(&tuple, Any::Array(v) if v[0] == Any::from("ext:future")) {
            // Opaque presentation arrives through admission and remains read-only.
            assert!(matches!(
                d.prepare_editor(
                    &[EditorCommand::Block {
                        target: A.into(),
                        tuple: tuple.clone()
                    }],
                    &origin()
                ),
                Err(EditorError::UnsupportedTarget)
            ));
            let raw = m::replica(2007);
            m::apply(&raw, &d.checkpoint().bytes).unwrap();
            m::set(&raw, 4, A, tuple);
            d.apply_replay(&ReplayUpdate {
                identity: identity(),
                bytes: m::bytes(&raw),
            })
            .unwrap();
        } else {
            let p = d
                .prepare_editor(
                    &[EditorCommand::Block {
                        target: A.into(),
                        tuple,
                    }],
                    &origin(),
                )
                .unwrap();
            d.commit_editor(p).unwrap();
        }
        assert_eq!(d.revision(), rev + 1);
        assert_eq!(ownership(&d, A), before);
        assert!(!d.snapshot().unwrap().visible.iter().any(|n| n.id == B));
        assert!(
            matches!(d.resolve_anchor(&anchor).unwrap(),Resolution::Position(p) if p.node==A && p.offset==U(6))
        );
        let raw = m::replica(2004);
        m::apply(&raw, &d.checkpoint().bytes).unwrap();
        assert_eq!(operation_rows(&raw), ops);
        assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
    }
    let raw = m::replica(2008);
    m::apply(&raw, &d.checkpoint().bytes).unwrap();
    m::set(&raw, 4, A, m::arr(vec![Any::from("paragraph")]));
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(&raw),
    })
    .unwrap();

    assert!(
        node(&d, A)
            .runs
            .iter()
            .filter(|r| !r.text.is_empty())
            .all(|r| r.attributes.get("bold") == Some(&Any::Bool(true)))
    );
}
#[test]
fn v5_concurrent_join_presentation_and_text_preserve_absorbed_owner_in_all_six_duplicate_orders() {
    let mut seed = engine();
    batch(&mut seed, &[code(A, "rs"), code(B, "rs")]);
    let bytes = seed.checkpoint().bytes;
    let mut join = restore(&bytes);
    let mut presentation = restore(&bytes);
    let mut edit = restore(&bytes);
    let updates = [
        batch(
            &mut join,
            &[BlockCommand::Join {
                first: A.into(),
                second: B.into(),
            }],
        ),
        batch(&mut presentation, &[code(A, "js"), paragraph(B)]),
        {
            let c = text(&edit, B, 1, "REMOTE");
            batch(&mut edit, &[c])
        },
    ];
    let mut expected = None;
    for order in PERMS {
        let mut d = restore(&bytes);
        for i in order {
            d.apply_replay(&updates[i]).unwrap();
            d.apply_replay(&updates[i]).unwrap();
        }
        assert_eq!(value(&d, A), "a😀bcREMOTEאבd");
        assert!(!d.snapshot().unwrap().visible.iter().any(|n| n.id == B));
        assert_eq!(
            node(&d, A).block_attributes,
            Some(BlockAttributes::Code("js".into()))
        );
        let snapshot = canonical(&d);
        if let Some(e) = &expected {
            assert_eq!(&snapshot, e)
        } else {
            expected = Some(snapshot.clone())
        }
        assert_eq!(canonical(&restore(&d.checkpoint().bytes)), snapshot);
    }
}
#[test]
fn v5_public_structural_witnesses_survive_split_presentation_and_reject_fresh_invalid_batches() {
    use editac_core::commands::structure::*;
    let mut d = engine();
    let at = d.anchor(A, U(3), Bias::Left).unwrap();
    let p = d
        .prepare_structure(
            &StructureCommand::SplitOwner {
                owner: A.into(),
                at,
            },
            &origin(),
        )
        .unwrap();
    d.commit_structure(p).unwrap();
    let right = d
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id.starts_with("o:"))
        .unwrap()
        .id
        .clone();
    let before = ownership(&d, &right);
    batch(&mut d, &[code(A, "rs"), code(&right, "js")]);
    assert_eq!(ownership(&d, &right), before);
    reject(
        &d,
        &[BlockCommand::Join {
            first: A.into(),
            second: right.clone(),
        }],
    );
    assert!(
        d.prepare_structure(
            &StructureCommand::JoinOwners {
                first: A.into(),
                second: right.clone()
            },
            &origin()
        )
        .is_err()
    );
    let bytes = d.checkpoint().bytes;
    assert!(
        d.prepare_editor(
            &[
                EditorCommand::Block {
                    target: A.into(),
                    tuple: m::arr(vec![Any::from("heading"), Any::from(0u32)])
                },
                EditorCommand::Block {
                    target: right.clone(),
                    tuple: m::arr(vec![Any::from("paragraph")])
                }
            ],
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, bytes);
    batch(&mut d, &[paragraph(A), paragraph(&right)]);
    let p = d
        .prepare_structure(
            &StructureCommand::JoinOwners {
                first: A.into(),
                second: right,
            },
            &origin(),
        )
        .unwrap();
    d.commit_structure(p).unwrap();
    assert_eq!(value(&d, A), "a😀b");
    batch(&mut d, &[code(A, "ts")]);
    assert_eq!(value(&d, A), "a😀b");
}
#[test]
fn v5_profile_and_malformed_witness_admission_reject_before_live_mutation() {
    let mut d = engine();
    let before = d.checkpoint().bytes;
    let v4 = DocumentIdentity::v4(identity().document_id, identity().epoch).unwrap();
    assert_eq!(
        d.apply_replay(&ReplayUpdate {
            identity: v4.clone(),
            bytes: before.clone()
        }),
        Err(editac_core::document::DocumentError::UnsupportedProfile)
    );
    let mut legacy = Document::restore(
        &v4,
        &InitializedCheckpoint {
            identity: v4.clone(),
            initialized: true,
            writer_id: 11,
            bytes: before.clone(),
        },
        &[],
    )
    .unwrap();
    let mut joined = joined_code();
    let change = batch(&mut joined, &[code(A, "js")]);
    assert_eq!(
        legacy.apply_replay(&change),
        Err(editac_core::document::DocumentError::UnsupportedProfile)
    );
    for witnesses in [
        vec![],
        vec![
            m::arr(vec![Any::from("separator")]),
            m::arr(vec![Any::from("paragraph")]),
        ],
        vec![
            m::arr(vec![Any::from("code"), Any::from("rs")]),
            m::arr(vec![Any::from("code"), Any::from("js")]),
        ],
    ] {
        let raw = m::replica(2005);
        m::apply(&raw, &before).unwrap();
        let mut tuple = vec![
            Any::from("join"),
            Any::from(A),
            Any::from("base"),
            Any::from(B),
            Any::from("base"),
        ];
        tuple.extend(witnesses);
        m::set(&raw, 5, "o:2005:1", m::arr(tuple));
        assert!(
            d.apply_replay(&ReplayUpdate {
                identity: identity(),
                bytes: m::bytes(&raw)
            })
            .is_err()
        );
        assert_eq!(d.checkpoint().bytes, before);
    }
}
#[test]
fn v5_list_move_format_control_and_anchor_commands_consume_witnessed_ownership() {
    use editac_core::commands::lists::*;
    let mut d = joined_code();
    batch(&mut d, &[paragraph(A)]);
    let retained = d.anchor(A, U(6), Bias::Right).unwrap();
    let original = ownership(&d, A).2;
    let p = d
        .prepare_lists(
            &[
                ListCommand::SetStyle {
                    container: "c:11:1".into(),
                    style: ContainerStyle::Checklist,
                },
                ListCommand::SetChecked {
                    owner: A.into(),
                    checked: true,
                },
            ],
            &origin(),
        )
        .unwrap();
    d.commit_lists(p).unwrap();
    let command = d.move_command(A, "@root", None).unwrap();
    let p = d.prepare_move(&command, &origin(), None).unwrap();
    d.commit_move(p).unwrap();
    assert_eq!(ownership(&d, A).2, original);
    let selection = Selection {
        anchor: d.anchor(A, U(0), Bias::Right).unwrap(),
        focus: d.anchor(A, U(8), Bias::Left).unwrap(),
    };
    let p = d
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
    d.commit_format(p).unwrap();
    assert!(matches!(d.resolve_anchor(&retained).unwrap(),Resolution::Position(p) if p.node==A));
    let raw = m::replica(2006);
    m::apply(&raw, &d.checkpoint().bytes).unwrap();
    let rows = operation_rows(&raw);
    let join = rows
        .iter()
        .find(|(_, v)| matches!(v,Any::Array(a) if a[0]==Any::from("join")))
        .unwrap()
        .0
        .clone();
    for enabled in [false, true] {
        let p = d
            .prepare_editor(
                &[EditorCommand::Enable {
                    target: join.clone(),
                    enabled,
                }],
                &origin(),
            )
            .unwrap();
        d.commit_editor(p).unwrap();
    }
    assert!(!d.snapshot().unwrap().visible.iter().any(|n| n.id == B));
    assert_eq!(ownership(&d, A).2, original);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), canonical(&d));
}

#[test]
fn production_v5_joined_presentation_bidirectional_pinned_yjs_checkpoints() {
    let dir = PathBuf::from(
        std::env::var_os("EDITAC_STABLE_JOIN_EXCHANGE")
            .expect("isolated joined exchange directory required"),
    );
    fs::create_dir_all(&dir).unwrap();
    let mut d = joined_code();
    let base = d.checkpoint().bytes;
    fs::write(dir.join("joined.bin"), &base).unwrap();
    fs::write(dir.join("joined.json"), m::json(&canonical(&d))).unwrap();
    let mut language = restore(&base);
    batch(&mut language, &[code(A, "js")]);
    fs::write(dir.join("language.bin"), language.checkpoint().bytes).unwrap();
    fs::write(dir.join("language.json"), m::json(&canonical(&language))).unwrap();
    let p = d.prepare_blocks(&[paragraph(A)], &origin()).unwrap();
    d.commit_blocks(p).unwrap();
    fs::write(dir.join("paragraph.bin"), d.checkpoint().bytes).unwrap();
    fs::write(dir.join("paragraph.json"), m::json(&canonical(&d))).unwrap();
    let output = Command::new("node")
        .args(["--test", "fixtures/schema-v5/joined-exchange.mjs"])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("EDITAC_STABLE_JOIN_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [output.stdout, output.stderr].concat(),
    )
    .unwrap();
    assert!(
        output.status.success(),
        "pinned joined exchange failed; see node.log"
    );
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: fs::read(dir.join("yjs-final.bin")).unwrap(),
    })
    .unwrap();
    let expected =
        Any::from_json(&fs::read_to_string(dir.join("yjs-final.json")).unwrap()).unwrap();
    assert_eq!(canonical(&d), expected);
    assert_eq!(canonical(&restore(&d.checkpoint().bytes)), expected);
    assert_eq!(value(&d, A), "a😀bcאבdYJS\n\n");
    assert!(!d.snapshot().unwrap().visible.iter().any(|n| n.id == B));
}

fn operation_rows(d: &yrs::Doc) -> std::collections::BTreeMap<String, Any> {
    let t = d.transact();
    t.get_map(m::ROOTS[5])
        .unwrap()
        .iter(&t)
        .map(|(id, v)| {
            let yrs::Out::Any(v) = v else {
                panic!("operation shape")
            };
            (id.to_string(), v)
        })
        .collect()
}
