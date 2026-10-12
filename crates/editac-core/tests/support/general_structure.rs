//! Production ENG-1.18 tests. Qualified helpers supply inputs and remote peers;
//! every local text/format/split/join executes Document preparation and commit.
#[path = "../../../../fixtures/schema-v3/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::{
    Utf16Offset as U,
    anchors::{AnchorError, Bias, BoundaryError, Resolution, Selection},
    commands::{format::*, structure::*, text::*},
    document::{
        BlockAttributes, CreationPermit, Document, DocumentError, DocumentIdentity, InitialNode,
        InitializedCheckpoint, ReplayUpdate,
    },
    projection::Snapshot,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use yrs::{Any, Map, ReadTxn, Text, Transact};
const A: &str = "n:11:1";
const B: &str = "n:11:2";
const C: &str = "n:11:3";
const D: &str = "n:11:4";
fn identity() -> DocumentIdentity {
    DocumentIdentity::v3(
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
    )
    .unwrap()
}
fn engine(seed: &yrs::Doc) -> Document {
    restore(&m::bytes(seed))
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
fn origin() -> TextOrigin {
    TextOrigin::new("general:explicit").unwrap()
}
fn split(d: &mut Document, id: &str, offset: u32) -> String {
    let before = d.checkpoint().bytes;
    let command = StructureCommand::SplitOwner {
        owner: id.into(),
        at: d.anchor(id, U(offset), Bias::Right).unwrap(),
    };
    d.can_structure(&command, &origin()).unwrap();
    let plan = d.prepare_structure(&command, &origin()).unwrap();
    assert_eq!(before, d.checkpoint().bytes);
    d.commit_structure(plan).unwrap();
    let s = d.snapshot().unwrap();
    let i = s.visible.iter().position(|n| n.id == id).unwrap();
    s.visible[i + 1].id.clone()
}
fn join(d: &mut Document, left: &str, right: &str) {
    let command = StructureCommand::JoinOwners {
        first: left.into(),
        second: right.into(),
    };
    let plan = d.prepare_structure(&command, &origin()).unwrap();
    d.commit_structure(plan).unwrap();
}
fn content(d: &Document) -> Vec<(String, String)> {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .map(|n| {
            (
                n.id.clone(),
                n.runs.iter().map(|r| r.text.as_str()).collect(),
            )
        })
        .collect()
}
fn value(d: &Document, id: &str) -> String {
    content(d).into_iter().find(|(n, _)| n == id).unwrap().1
}
fn attrs(d: &Document, id: &str) -> BlockAttributes {
    d.snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.id == id)
        .unwrap()
        .block_attributes
        .clone()
        .unwrap()
}
fn source_ids(s: &Snapshot) -> std::collections::BTreeMap<String, String> {
    s.visible
        .iter()
        .chain(&s.recovery)
        .flat_map(|n| &n.spans)
        .map(|s| (s.source.clone(), s.identity.clone()))
        .collect()
}
fn block(d: &mut Document, id: &str, attributes: BlockAttributes) {
    let c = BlockFormatCommand {
        targets: vec![id.into()],
        attributes,
        action: FormatAction::Apply,
    };
    let p = d.prepare_format_batch(&[], &[c], &origin()).unwrap();
    d.commit_format(p).unwrap();
}
fn insert(d: &mut Document, id: &str, offset: u32, value: &str) -> ReplayUpdate {
    let c = TextCommand::Insert {
        at: d.anchor(id, U(offset), Bias::Right).unwrap(),
        text: value.into(),
    };
    let p = d.prepare_text(&c, &origin()).unwrap();
    d.commit_text(p).unwrap().update.unwrap()
}
fn offer(d: &mut Document, peer: &yrs::Doc) -> Result<(), DocumentError> {
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: m::bytes(peer),
    })
}
#[test]
fn v3_production_creation_exact_roots_and_restore_never_reseeds() {
    let id = DocumentIdentity::v3(
        "77777777-7777-4777-8777-000000001801",
        "88888888-8888-4888-8888-000000001801",
    )
    .unwrap();
    let d = Document::create(
        CreationPermit::authorize_new(id.clone()).unwrap(),
        &[
            InitialNode {
                kind: "block".into(),
                text: "".into(),
            },
            InitialNode {
                kind: "block".into(),
                text: "😀".into(),
            },
        ],
    )
    .unwrap();
    let checkpoint = d.checkpoint();
    let r = Document::restore(&id, &checkpoint, &[]).unwrap();
    assert_eq!(d.checkpoint().bytes, r.checkpoint().bytes);
    assert_ne!(d.writer_id(), r.writer_id());
    let raw = m::replica(191);
    m::apply(&raw, &checkpoint.bytes).unwrap();
    assert_eq!(raw.transact().root_refs().count(), 7);
    assert!(raw.transact().get_map("probe-split-join").is_none());
    assert!(content(&d).iter().all(|(n, _)| n.starts_with("n:")));
    assert_eq!(content(&d), content(&r));
}
#[test]
fn v3_production_beginning_middle_end_empty_splits_repeat_without_reseeding() {
    for offset in [0, 1, 3, 4] {
        let mut d = engine(&m::seed());
        let sources = source_ids(&d.snapshot().unwrap());
        let right = split(&mut d, A, offset);
        let text = "a😀b";
        let byte = editac_core::anchors::utf16_to_byte(text, U(offset)).unwrap();
        assert_eq!(value(&d, A), &text[..byte]);
        assert_eq!(value(&d, &right), &text[byte..]);
        assert_eq!(attrs(&d, &right), BlockAttributes::Heading(1));
        join(&mut d, A, &right);
        assert_eq!(value(&d, A), text);
        let second = split(&mut d, A, offset);
        assert_ne!(right, second);
        join(&mut d, A, &second);
        assert_eq!(source_ids(&d.snapshot().unwrap()), sources);
    }
    let mut d = engine(&m::seed());
    let right = split(&mut d, D, 0);
    assert_eq!(value(&d, D), "");
    assert_eq!(value(&d, &right), "");
    join(&mut d, D, &right);
    let again = split(&mut d, D, 0);
    assert_ne!(right, again);
}
#[test]
fn v3_production_join_beginning_end_empty_and_two_disjoint_pairs() {
    let mut d = engine(&m::seed());
    let identities = source_ids(&d.snapshot().unwrap());
    join(&mut d, A, B);
    join(&mut d, C, D);
    assert_eq!(
        content(&d),
        vec![(A.into(), "a😀bcאבd".into()), (C.into(), "éZ".into())]
    );
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
    assert_eq!(attrs(&d, A), BlockAttributes::Heading(1));
    assert_eq!(attrs(&d, C), BlockAttributes::Heading(6));
    for offset in [0, 4, 8] {
        let right = split(&mut d, A, offset);
        join(&mut d, A, &right);
        assert_eq!(value(&d, A), "a😀bcאבd");
    }
}
#[test]
fn v3_production_split_after_join_across_original_sources_and_stable_anchors() {
    let mut d = engine(&m::seed());
    let anchor = d.anchor(B, U(3), Bias::Right).unwrap();
    let identities = source_ids(&d.snapshot().unwrap());
    let right = split(&mut d, A, 3);
    join(&mut d, A, &right);
    join(&mut d, A, B);
    let next = split(&mut d, A, 5);
    assert_eq!(value(&d, A), "a😀bc");
    assert_eq!(value(&d, &next), "אבd");
    assert!(
        matches!(d.resolve_anchor(&anchor).unwrap(),Resolution::Position(p) if p.node==next && p.offset==U(2) && p.source==B)
    );
    insert(&mut d, &next, 2, "!");
    assert_eq!(value(&d, &next), "אב!d");
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
}
#[test]
fn v3_production_utf16_zwj_combining_rtl_and_surrogate_rejection() {
    let seed = m::seed();
    let raw = m::text(&seed, A);
    raw.insert(&mut seed.transact_mut(), 0, "👩‍💻éאב");
    let mut d = engine(&seed);
    for offset in [0, 5, 7, 9] {
        let right = split(&mut d, A, offset);
        join(&mut d, A, &right);
    }
    let bytes = d.checkpoint().bytes;
    assert_eq!(
        d.anchor(A, U(1), Bias::Left).unwrap_err(),
        AnchorError::Boundary(BoundaryError::SurrogateInterior)
    );
    assert_eq!(d.checkpoint().bytes, bytes);
}
#[test]
fn v3_production_mark_retention_and_mixed_block_batch_atomic_rejection() {
    let mut d = engine(&m::seed());
    let right = split(&mut d, A, 3);
    let selection = Selection {
        anchor: d.anchor(&right, U(0), Bias::Right).unwrap(),
        focus: d.anchor(&right, U(1), Bias::Left).unwrap(),
    };
    let mark = FormatCommand {
        selection: selection.clone(),
        mark: Mark::Italic,
        action: FormatAction::Apply,
        href: None,
    };
    let heading = BlockFormatCommand {
        targets: vec![right.clone(), D.into()],
        attributes: BlockAttributes::Heading(5),
        action: FormatAction::Apply,
    };
    let bad = BlockFormatCommand {
        targets: vec![A.into()],
        attributes: BlockAttributes::Heading(0),
        action: FormatAction::Apply,
    };
    let before = d.checkpoint().bytes;
    assert!(
        d.prepare_format_batch(&[mark.clone()], &[heading.clone(), bad], &origin())
            .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
    let p = d
        .prepare_format_batch(&[mark], &[heading], &origin())
        .unwrap();
    d.commit_format(p).unwrap();
    assert_eq!(attrs(&d, &right), BlockAttributes::Heading(5));
    assert_eq!(attrs(&d, D), BlockAttributes::Heading(5));
    assert!(
        d.snapshot()
            .unwrap()
            .visible
            .iter()
            .find(|n| n.id == right)
            .unwrap()
            .runs
            .iter()
            .all(|r| r.attributes.get("italic") == Some(&Any::Bool(true)))
    );
    join(&mut d, A, &right);
    let again = split(&mut d, A, 3);
    assert_eq!(attrs(&d, &again), BlockAttributes::Heading(1));
    let s = d.snapshot().unwrap();
    assert!(s.retained_structure.is_some());
    assert!(
        s.visible
            .iter()
            .flat_map(|n| &n.runs)
            .any(|r| r.attributes.contains_key("italic"))
    );
}
#[test]
fn v3_production_heading_inheritance_override_toggle_and_parent_batch_order() {
    let mut d = engine(&m::seed());
    let right = split(&mut d, A, 1);
    block(&mut d, A, BlockAttributes::Heading(4));
    assert_eq!(attrs(&d, &right), BlockAttributes::Heading(4));
    let p = d
        .prepare_format_batch(
            &[],
            &[
                BlockFormatCommand {
                    targets: vec![A.into()],
                    attributes: BlockAttributes::Heading(2),
                    action: FormatAction::Apply,
                },
                BlockFormatCommand {
                    targets: vec![right.clone()],
                    attributes: BlockAttributes::Heading(2),
                    action: FormatAction::Toggle,
                },
            ],
            &origin(),
        )
        .unwrap();
    d.commit_format(p).unwrap();
    assert_eq!(attrs(&d, A), BlockAttributes::Heading(2));
    assert_eq!(attrs(&d, &right), BlockAttributes::Paragraph);
    block(&mut d, A, BlockAttributes::Heading(6));
    assert_eq!(attrs(&d, &right), BlockAttributes::Paragraph);
    let next = split(&mut d, &right, 0);
    assert_eq!(attrs(&d, &next), BlockAttributes::Paragraph);
    block(&mut d, &next, BlockAttributes::Heading(3));
    assert_eq!(attrs(&d, &right), BlockAttributes::Paragraph);
}
#[test]
fn v3_production_multispan_same_source_replace_preserves_offsets_and_identity() {
    let mut d = engine(&m::seed());
    let identities = source_ids(&d.snapshot().unwrap());
    let right = split(&mut d, A, 1);
    join(&mut d, A, &right);
    join(&mut d, A, B);
    let selection = Selection {
        anchor: d.anchor(A, U(0), Bias::Right).unwrap(),
        focus: d.anchor(A, U(7), Bias::Left).unwrap(),
    };
    let p = d
        .prepare_text(
            &TextCommand::Replace {
                selection,
                text: "Q".into(),
            },
            &origin(),
        )
        .unwrap();
    d.commit_text(p).unwrap();
    assert_eq!(value(&d, A), "Qd");
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
}
#[test]
fn v3_production_remote_insert_at_and_both_sides_of_cut_converges() {
    for offset in [0, 1, 3, 4] {
        let seed = m::seed();
        let mut d = engine(&seed);
        let right = split(&mut d, A, offset);
        let update = d.checkpoint().bytes;
        let remote = m::fork(&seed, 201);
        let x = m::text(&remote, A);
        x.insert(&mut remote.transact_mut(), offset, "R");
        offer(&mut d, &remote).unwrap();
        let all = value(&d, A) + &value(&d, &right);
        let base = "a😀b";
        let byte = editac_core::anchors::utf16_to_byte(base, U(offset)).unwrap();
        assert_eq!(all, format!("{}R{}", &base[..byte], &base[byte..]));
        assert!(value(&d, &right).starts_with('R'));
        m::apply(&remote, &update).unwrap();
        assert_eq!(
            d.snapshot().unwrap().retained_structure.as_ref(),
            Some(&m::snapshot(&remote).unwrap())
        );
    }
    let seed = m::seed();
    let mut d = engine(&seed);
    let right = split(&mut d, A, 3);
    let remote = m::fork(&seed, 202);
    let x = m::text(&remote, A);
    x.insert(&mut remote.transact_mut(), 0, "L");
    x.insert(&mut remote.transact_mut(), 5, "R");
    offer(&mut d, &remote).unwrap();
    assert_eq!(value(&d, A), "La😀");
    assert_eq!(value(&d, &right), "bR");
}
#[test]
fn v3_production_join_remote_insert_race_and_duplicate_reordered_updates() {
    let seed = m::seed();
    let mut d = engine(&seed);
    join(&mut d, A, B);
    let remote = m::fork(&seed, 203);
    m::text(&remote, B).insert(&mut remote.transact_mut(), 0, "R");
    offer(&mut d, &remote).unwrap();
    assert_eq!(value(&d, A), "a😀bRcאבd");
    let b = d.checkpoint().bytes;
    offer(&mut d, &remote).unwrap();
    assert_eq!(b, d.checkpoint().bytes);
}
#[test]
fn v3_production_concurrent_overlap_descendants_disjoint_pairs_all_permutations() {
    let seed = m::seed();
    let mut a = engine(&seed);
    let mut b = engine(&seed);
    let mut c = engine(&seed);
    let r = split(&mut a, A, 3);
    split(&mut a, &r, 0);
    join(&mut b, A, B);
    split(&mut b, A, 5);
    join(&mut c, C, D);
    let updates = [
        a.checkpoint().bytes,
        b.checkpoint().bytes,
        c.checkpoint().bytes,
    ];
    let mut expected = None;
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let mut d = engine(&seed);
        for i in order {
            for _ in 0..2 {
                d.apply_replay(&ReplayUpdate {
                    identity: identity(),
                    bytes: updates[i].clone(),
                })
                .unwrap();
            }
        }
        let s = d.snapshot().unwrap();
        let retained = s.retained_structure.clone().unwrap();
        if let Some(e) = &expected {
            assert_eq!(&retained, e)
        } else {
            expected = Some(retained.clone())
        }
        assert!(m::json(&retained).contains("losing"));
        assert_eq!(value(&d, C), "éZ");
        assert_eq!(
            source_ids(&s),
            source_ids(&engine(&seed).snapshot().unwrap())
        );
    }
}
#[test]
fn v3_production_deleted_original_and_derived_targets_keep_recovery() {
    for derived in [false, true] {
        let mut d = engine(&m::seed());
        let right = split(&mut d, A, 3);
        let target = if derived { right.as_str() } else { A };
        let anchor = d.anchor(target, U(0), Bias::Right).unwrap();
        let plan = d
            .prepare_structure(&StructureCommand::Split { at: anchor.clone() }, &origin())
            .unwrap();
        let raw = m::replica(204);
        m::apply(&raw, &d.checkpoint().bytes).unwrap();
        m::set(&raw, 3, target, Any::Bool(true));
        offer(&mut d, &raw).unwrap();
        assert!(matches!(
            d.resolve_anchor(&anchor).unwrap(),
            Resolution::Deleted { .. }
        ));
        let bytes = d.checkpoint().bytes;
        assert!(
            d.prepare_structure(&StructureCommand::Split { at: anchor }, &origin())
                .is_err()
        );
        assert_eq!(
            d.commit_structure(plan).unwrap_err(),
            StructureError::Text(TextError::StalePlan)
        );
        assert_eq!(bytes, d.checkpoint().bytes);
        let s = d.snapshot().unwrap();
        assert!(!s.recovery.is_empty());
        assert_eq!(source_ids(&s).len(), 4);
        assert!(s.retained_structure.is_some());
    }
}
#[test]
fn v3_production_invalid_order_stale_replica_epoch_and_profile_are_atomic() {
    let seed = m::seed();
    let mut d = engine(&seed);
    let before = d.checkpoint().bytes;
    let bad = StructureCommand::Join {
        first: d.anchor(A, U(0), Bias::Right).unwrap(),
        second: d.anchor(C, U(0), Bias::Right).unwrap(),
    };
    assert_eq!(
        d.prepare_structure(&bad, &origin()).unwrap_err(),
        StructureError::ConflictingTarget
    );
    assert_eq!(before, d.checkpoint().bytes);
    let c = StructureCommand::Split {
        at: d.anchor(A, U(1), Bias::Right).unwrap(),
    };
    let p = d.prepare_structure(&c, &origin()).unwrap();
    insert(&mut d, B, 0, "X");
    let changed = d.checkpoint().bytes;
    assert_eq!(
        d.commit_structure(p).unwrap_err(),
        StructureError::Text(TextError::StalePlan)
    );
    assert_eq!(changed, d.checkpoint().bytes);
    let p = d.prepare_structure(&c, &origin()).unwrap();
    let mut other = engine(&seed);
    assert_eq!(
        other.commit_structure(p).unwrap_err(),
        StructureError::Text(TextError::WrongReplica)
    );
    for profile in [false, true] {
        let mut offered = identity();
        if profile {
            offered = DocumentIdentity::v2(offered.document_id, offered.epoch).unwrap()
        } else {
            offered.epoch = "99999999-9999-4999-8999-999999999999".into()
        };
        assert_eq!(
            d.apply_replay(&ReplayUpdate {
                identity: offered,
                bytes: m::bytes(&seed)
            }),
            Err(if profile {
                DocumentError::UnsupportedProfile
            } else {
                DocumentError::WrongEpoch
            })
        );
        assert_eq!(changed, d.checkpoint().bytes);
    }
}
#[test]
fn v3_production_immutable_operation_text_origin_and_tombstone_rejection() {
    let seed = m::seed();
    let mut d = engine(&seed);
    let right = split(&mut d, A, 1);
    let base = d.checkpoint().bytes;
    for case in 0..5 {
        let raw = m::replica(210 + case);
        m::apply(&raw, &base).unwrap();
        {
            let mut t = raw.transact_mut();
            match case {
                0 => {
                    t.get_map(m::ROOTS[5]).unwrap().insert(
                        &mut t,
                        right.as_str(),
                        m::arr(vec![
                            Any::from("join"),
                            Any::from(A),
                            Any::from("base"),
                            Any::from(B),
                            Any::from("base"),
                        ]),
                    );
                }
                1 => {
                    t.get_map(m::ROOTS[6]).unwrap().remove(&mut t, A);
                }
                2 => {
                    t.get_map(m::ROOTS[0])
                        .unwrap()
                        .insert(&mut t, A, "ext:replacement");
                }
                3 => {
                    t.get_map(m::ROOTS[1]).unwrap().insert(
                        &mut t,
                        A,
                        yrs::XmlTextPrelim::new("replacement"),
                    );
                }
                _ => {
                    t.get_map(m::ROOTS[5]).unwrap().remove(&mut t, &right);
                }
            }
        }
        assert!(offer(&mut d, &raw).is_err());
        assert_eq!(d.checkpoint().bytes, base);
    }
    let raw = m::replica(216);
    m::apply(&raw, &base).unwrap();
    m::set(&raw, 3, &right, Any::Bool(true));
    offer(&mut d, &raw).unwrap();
    let checkpoint = d.checkpoint();
    let peer = m::fork(&raw, 217);
    {
        let mut t = peer.transact_mut();
        t.get_map(m::ROOTS[3]).unwrap().remove(&mut t, &right);
    }
    assert!(offer(&mut d, &peer).is_err());
    assert_eq!(checkpoint.bytes, d.checkpoint().bytes);
}
#[test]
fn v3_production_missing_dependencies_and_losing_overrides_remain_recoverable() {
    let seed = m::seed();
    let mut d = engine(&seed);
    let peer = m::fork(&seed, 218);
    m::set(
        &peer,
        5,
        "o:218:1",
        m::arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:219:1"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    offer(&mut d, &peer).unwrap();
    assert!(
        m::json(d.snapshot().unwrap().retained_structure.as_ref().unwrap()).contains("dormant")
    );
    assert_eq!(value(&d, A), "a😀b");
}
#[test]
fn v3_production_resource_and_malformed_graph_rejection_leave_state_unchanged() {
    let seed = m::seed();
    let mut d = engine(&seed);
    let before = d.checkpoint().bytes;
    let raw = m::fork(&seed, 220);
    m::set(
        &raw,
        5,
        "o:220:1",
        m::arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:220:2"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    m::set(
        &raw,
        5,
        "o:220:2",
        m::arr(vec![
            Any::from("join"),
            Any::from(A),
            Any::from("o:220:1"),
            Any::from(B),
            Any::from("base"),
        ]),
    );
    assert!(offer(&mut d, &raw).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    let raw = m::fork(&seed, 221);
    m::text(&raw, A).insert(&mut raw.transact_mut(), 0, &"x".repeat(262145));
    assert_eq!(offer(&mut d, &raw), Err(DocumentError::ResourceLimit));
    assert_eq!(d.checkpoint().bytes, before);
    assert!(
        d.prepare_text(
            &TextCommand::Insert {
                at: d.anchor(A, U(0), Bias::Right).unwrap(),
                text: "x".repeat(262145)
            },
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn v3_production_unknown_tuple_and_marks_retained_without_local_extension_execution() {
    let seed = m::seed();
    m::set(
        &seed,
        4,
        A,
        m::arr(vec![Any::from("ext:future"), Any::Bool(true)]),
    );
    let mut d = engine(&seed);
    let right = split(&mut d, A, 1);
    assert!(matches!(attrs(&d, &right), BlockAttributes::Unknown(_)));
    let before = d.checkpoint().bytes;
    assert!(
        d.prepare_format_batch(
            &[],
            &[BlockFormatCommand {
                targets: vec![right],
                attributes: BlockAttributes::Heading(1),
                action: FormatAction::Apply
            }],
            &origin()
        )
        .is_err()
    );
    assert_eq!(before, d.checkpoint().bytes);
}
#[test]
fn v3_production_binary_dependencies_atomic_rejection_then_restore_reordered_journal() {
    let seed = m::seed();
    let mut peer = engine(&seed);
    let baseline = peer.checkpoint();
    let first = insert(&mut peer, A, 0, "X");
    let second = insert(&mut peer, A, 1, "Y");
    let mut d = engine(&seed);
    let before = d.checkpoint().bytes;
    assert_eq!(
        d.apply_replay(&second),
        Err(DocumentError::IncompleteRestore)
    );
    assert_eq!(d.checkpoint().bytes, before);
    let restored = Document::restore(
        &identity(),
        &baseline,
        &[second.clone(), first.clone(), second],
    )
    .unwrap();
    assert_eq!(value(&restored, A), "XYa😀b");
    d.apply_replay(&first).unwrap();
}
fn exchange_dir() -> PathBuf {
    std::env::var_os("EDITAC_GENERAL_EXCHANGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../architecture/evidence/engine-general-structure/exchange")
        })
}
#[test]
fn v3_production_real_pinned_yjs_exchange_both_directions_and_checkpoint() {
    let mut d = engine(&m::seed());
    let identities = source_ids(&d.snapshot().unwrap());
    let right = split(&mut d, A, 3);
    join(&mut d, A, &right);
    join(&mut d, A, B);
    let right = split(&mut d, A, 5);
    block(&mut d, &right, BlockAttributes::Heading(5));
    join(&mut d, C, D);
    split(&mut d, C, 0);
    let dir = exchange_dir();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("rust-production.bin"), d.checkpoint().bytes).unwrap();
    fs::write(
        dir.join("rust-production.json"),
        m::json(d.snapshot().unwrap().retained_structure.as_ref().unwrap()),
    )
    .unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/schema-v3/production-exchange.mjs");
    let result = Command::new("node")
        .arg("--test")
        .arg(script)
        .env("EDITAC_GENERAL_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "production Yjs exchange: inspect node.log"
    );
    let returned = fs::read(dir.join("js-production.bin")).unwrap();
    d.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: returned.clone(),
    })
    .unwrap();
    let restored = restore(&returned);
    assert_eq!(content(&d), content(&restored));
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
    assert_eq!(
        d.snapshot().unwrap().retained_structure.unwrap(),
        Any::from_json(&fs::read_to_string(dir.join("js-production.json")).unwrap()).unwrap()
    );
    let gap = restore(&fs::read(dir.join("js-deleted-gap.bin")).unwrap());
    assert_eq!(
        gap.snapshot().unwrap().retained_structure.unwrap(),
        Any::from_json(&fs::read_to_string(dir.join("js-deleted-gap.json")).unwrap()).unwrap()
    );
    let owner = content(&d)[0].0.clone();
    split(&mut d, &owner, 0);
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
}
#[test]
fn v3_production_empty_boundary_ties_and_explicit_targets_preserve_cursor_policy() {
    let mut d = engine(&m::seed());
    let left = d.anchor(A, U(0), Bias::Left).unwrap();
    let right = d.anchor(A, U(0), Bias::Right).unwrap();
    let r = split(&mut d, A, 0);
    assert!(matches!(d.resolve_anchor(&left).unwrap(),Resolution::Position(p) if p.node==A));
    assert!(matches!(d.resolve_anchor(&right).unwrap(),Resolution::Position(p) if p.node==r));
    let next = split(&mut d, A, 0);
    let again = split(&mut d, &next, 0);
    join(&mut d, &next, &again);
    join(&mut d, A, &next);
    join(&mut d, A, &r);
    assert_eq!(value(&d, A), "a😀b");
}
#[test]
fn v3_production_operation_capacity_caps_preparation_before_any_live_write() {
    let raw = m::seed();
    for n in 1..=4096 {
        m::set(
            &raw,
            5,
            &format!("o:230:{n}"),
            m::arr(vec![
                Any::from("join"),
                Any::from(A),
                Any::from("o:231:1"),
                Any::from(B),
                Any::from("base"),
            ]),
        );
    }
    let d = engine(&raw);
    let before = d.checkpoint().bytes;
    let c = StructureCommand::SplitOwner {
        owner: A.into(),
        at: d.anchor(A, U(1), Bias::Right).unwrap(),
    };
    assert_eq!(
        d.prepare_structure(&c, &origin()).unwrap_err(),
        StructureError::Text(TextError::ResourceLimit)
    );
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn v3_production_block_only_change_stales_all_prepared_commands_and_preserves_metadata() {
    let mut d = engine(&m::seed());
    let c = StructureCommand::Split {
        at: d.anchor(A, U(1), Bias::Right).unwrap(),
    };
    let structure = d.prepare_structure(&c, &origin()).unwrap();
    let text = d
        .prepare_text(
            &TextCommand::Insert {
                at: d.anchor(A, U(0), Bias::Right).unwrap(),
                text: "X".into(),
            },
            &origin(),
        )
        .unwrap();
    let format = d
        .prepare_format_batch(
            &[],
            &[BlockFormatCommand {
                targets: vec![B.into()],
                attributes: BlockAttributes::Heading(3),
                action: FormatAction::Apply,
            }],
            &origin(),
        )
        .unwrap();
    block(&mut d, A, BlockAttributes::Heading(2));
    let before = d.checkpoint().bytes;
    assert_eq!(
        d.commit_structure(structure).unwrap_err(),
        StructureError::Text(TextError::StalePlan)
    );
    assert_eq!(d.commit_text(text).unwrap_err(), TextError::StalePlan);
    assert_eq!(
        d.commit_format(format).unwrap_err(),
        FormatError::Text(TextError::StalePlan)
    );
    assert_eq!(before, d.checkpoint().bytes);
}
#[test]
fn v3_production_invalid_creation_empty_restore_and_legacy_root_admission_are_typed() {
    let id = DocumentIdentity::v3(
        "77777777-7777-4777-8777-000000001802",
        "88888888-8888-4888-8888-000000001802",
    )
    .unwrap();
    let permit = CreationPermit::authorize_new(id.clone()).unwrap();
    assert_eq!(
        Document::create(
            permit,
            &[InitialNode {
                kind: "list".into(),
                text: "".into()
            }]
        )
        .unwrap_err(),
        DocumentError::InvalidInitialContent
    );
    let permit = CreationPermit::authorize_new(id.clone()).unwrap();
    assert_eq!(
        Document::create(
            permit,
            &[InitialNode {
                kind: "block".into(),
                text: "x".repeat(262145)
            }]
        )
        .unwrap_err(),
        DocumentError::ResourceLimit
    );
    let d = Document::create(CreationPermit::authorize_new(id.clone()).unwrap(), &[]).unwrap();
    let r = Document::restore(&id, &d.checkpoint(), &[]).unwrap();
    assert!(r.snapshot().unwrap().visible.is_empty());
    let raw = m::seed();
    raw.get_or_insert_map("probe-split-join").insert(
        &mut raw.transact_mut(),
        "pair",
        m::arr(vec![Any::from("original")]),
    );
    let mut target = engine(&m::seed());
    let before = target.checkpoint().bytes;
    assert_eq!(
        offer(&mut target, &raw),
        Err(DocumentError::UnsupportedSchema)
    );
    assert_eq!(before, target.checkpoint().bytes);
}
#[test]
fn v3_production_join_across_deleted_owner_keeps_every_recovery_span() {
    let seed = m::seed();
    let mut d = engine(&seed);
    let b_anchor = d.anchor(B, U(1), Bias::Right).unwrap();
    let remote = m::fork(&seed, 241);
    m::set(&remote, 3, B, Any::Bool(true));
    offer(&mut d, &remote).unwrap();
    let identities = source_ids(&d.snapshot().unwrap());
    join(&mut d, A, C);
    assert_eq!(value(&d, A), "a😀béZ");
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
    assert!(
        matches!(d.resolve_anchor(&b_anchor).unwrap(),Resolution::Deleted{owner,..} if owner==B)
    );
    let s = d.snapshot().unwrap();
    assert_eq!(
        s.recovery
            .iter()
            .find(|n| n.id == B)
            .unwrap()
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect::<String>(),
        "cאבd"
    );
    m::apply(&remote, &d.checkpoint().bytes).unwrap();
    assert_eq!(s.retained_structure.unwrap(), m::snapshot(&remote).unwrap());
    let restored = restore(&d.checkpoint().bytes);
    assert_eq!(content(&d), content(&restored));
    let right = split(&mut d, A, 5);
    assert_eq!(value(&d, &right), "́Z");
    assert_eq!(source_ids(&d.snapshot().unwrap()), identities);
}
