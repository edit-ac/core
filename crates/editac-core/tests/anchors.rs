//! Fixed Unicode expectations and actual frozen-schema Yrs update replay.
use editac_core::{
    Utf16Offset as U,
    anchors::*,
    document::{Document, DocumentIdentity, InitializedCheckpoint, ROOTS, ReplayUpdate},
};
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    Any, Assoc, ClientID, Doc, GetString, IndexedSequence, Map, OffsetKind, Options, Out, ReadTxn,
    StateVector, Text, Transact, Update, XmlTextPrelim, XmlTextRef,
};

fn identity() -> DocumentIdentity {
    DocumentIdentity::v1(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    .unwrap()
}
fn replica(client: u64) -> Doc {
    let doc = Doc::with_options(Options {
        client_id: ClientID::new(client),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for root in ROOTS {
        doc.get_or_insert_map(root);
    }
    doc
}
fn seed(first: &str, second: &str) -> Doc {
    let doc = replica(11);
    {
        let mut txn = doc.transact_mut_with("fixture:seed");
        for (id, value, order) in [("block-1", first, 0), ("block-2", second, 1)] {
            txn.get_map(ROOTS[0]).unwrap().insert(&mut txn, id, "list");
            txn.get_map(ROOTS[1])
                .unwrap()
                .insert(&mut txn, id, XmlTextPrelim::new(value));
            txn.get_map(ROOTS[2]).unwrap().insert(
                &mut txn,
                id,
                Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
            );
        }
        txn.get_map(ROOTS[4]).unwrap().insert(
            &mut txn,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    doc
}
fn bytes(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
fn checkpoint(doc: &Doc) -> InitializedCheckpoint {
    InitializedCheckpoint {
        identity: identity(),
        initialized: true,
        writer_id: 11,
        bytes: bytes(doc),
    }
}
fn engine(doc: &Doc) -> Document {
    Document::restore(&identity(), &checkpoint(doc), &[]).unwrap()
}
fn text(doc: &Doc, id: &str) -> XmlTextRef {
    let txn = doc.transact();
    let Some(Out::YXmlText(t)) = txn.get_map(ROOTS[1]).unwrap().get(&txn, id) else {
        panic!("missing source")
    };
    t
}
fn position(
    doc: &Document,
    anchor: &Anchor,
    node: &str,
    offset: u32,
    source: &str,
    source_offset: u32,
) {
    assert_eq!(
        doc.resolve_anchor(anchor).unwrap(),
        Resolution::Position(Position {
            node: node.into(),
            offset: U(offset),
            source: source.into(),
            source_offset: U(source_offset),
            bias: anchor.bias(),
        })
    );
}
fn delete(doc: &Doc, id: &str) {
    let mut txn = doc.transact_mut_with("fixture:delete");
    txn.get_map(ROOTS[3]).unwrap().insert(&mut txn, id, true);
}
fn mode(doc: &Doc, mode: &str, cut: u32) {
    let mut txn = doc.transact_mut_with("fixture:ownership");
    let mut value = vec![Any::from(mode)];
    if mode == "split" {
        let t = text_from(&txn, "block-1");
        let anchor = t.sticky_index(&txn, cut, Assoc::Before).unwrap();
        value.push(Any::Buffer(anchor.encode_v1().into()));
    }
    txn.get_map(ROOTS[4])
        .unwrap()
        .insert(&mut txn, "pair", Any::Array(value.into()));
}
fn text_from<T: ReadTxn>(txn: &T, id: &str) -> XmlTextRef {
    let Some(Out::YXmlText(t)) = txn.get_map(ROOTS[1]).unwrap().get(txn, id) else {
        panic!("missing source")
    };
    t
}
fn unicode_case(original: &str, boundaries: &[u32], deleted: std::ops::Range<U>, expected: &str) {
    let raw = seed(original, "");
    let doc = engine(&raw);
    let before = bytes(&raw);
    for &offset in boundaries {
        let byte = utf16_to_byte(original, U(offset)).unwrap();
        assert_eq!(byte_to_utf16(original, byte).unwrap(), U(offset));
        for bias in [Bias::Left, Bias::Right] {
            let anchor = doc.anchor("block-1", U(offset), bias).unwrap();
            position(&doc, &anchor, "block-1", offset, "block-1", offset);
        }
    }
    let range = validate_range(original, deleted.clone()).unwrap();
    let mut result = original.to_string();
    result.replace_range(range, "");
    assert_eq!(result, expected);
    let anchor = doc.anchor("block-1", deleted.end, Bias::Right).unwrap();
    text(&raw, "block-1").remove_range(
        &mut raw.transact_mut_with("fixture:unicode-delete"),
        deleted.start.0,
        deleted.end.0 - deleted.start.0,
    );
    assert_eq!(text(&raw, "block-1").get_string(&raw.transact()), expected);
    position(
        &engine(&raw),
        &anchor,
        "block-1",
        deleted.start.0,
        "block-1",
        deleted.start.0,
    );
    assert_ne!(before, bytes(&raw));
}
#[test]
fn emoji_fixed_offsets_and_delete() {
    unicode_case("a😀b", &[0, 1, 3, 4], U(1)..U(3), "ab");
}
#[test]
fn zwj_fixed_offsets_and_delete() {
    unicode_case("a👩‍💻b", &[0, 1, 3, 4, 6, 7], U(1)..U(6), "ab");
}
#[test]
fn combining_fixed_offsets_and_delete() {
    unicode_case("ae\u{301}b", &[0, 1, 2, 3, 4], U(1)..U(3), "ab");
}
#[test]
fn rtl_fixed_logical_offsets_and_delete() {
    unicode_case("aאבb", &[0, 1, 2, 3, 4], U(1)..U(2), "aבb");
}
#[test]
fn flag_fixed_offsets_and_delete() {
    unicode_case("a🇭🇺b", &[0, 1, 3, 5, 6], U(1)..U(5), "ab");
}
#[test]
fn grapheme_movement_and_deletion_are_extended_and_logical() {
    for (original, boundaries) in [
        ("a😀b", vec![0, 1, 3, 4]),
        ("a👩‍💻b", vec![0, 1, 6, 7]),
        ("ae\u{301}b", vec![0, 1, 3, 4]),
        ("a🇭🇺b", vec![0, 1, 5, 6]),
        ("aאבb", vec![0, 1, 2, 3, 4]),
        ("a\r\nb", vec![0, 1, 3, 4]),
    ] {
        for pair in boundaries.windows(2) {
            assert_eq!(
                move_grapheme(original, U(pair[0]), Direction::Forward),
                Ok(Some(U(pair[1])))
            );
            assert_eq!(
                move_grapheme(original, U(pair[1]), Direction::Backward),
                Ok(Some(U(pair[0])))
            );
            assert_eq!(
                deletion_range(original, U(pair[0]), Direction::Forward),
                Ok(Some(U(pair[0])..U(pair[1])))
            );
            assert_eq!(
                deletion_range(original, U(pair[1]), Direction::Backward),
                Ok(Some(U(pair[0])..U(pair[1])))
            );
        }
        assert_eq!(move_grapheme(original, U(0), Direction::Backward), Ok(None));
        assert_eq!(
            deletion_range(original, U(*boundaries.last().unwrap()), Direction::Forward),
            Ok(None)
        );
    }
    assert_eq!(move_grapheme("", U(0), Direction::Forward), Ok(None));
    for (s, inside) in [("e\u{301}", 1), ("👩‍💻", 2), ("🇭🇺", 2)] {
        assert_eq!(
            deletion_range(s, U(inside), Direction::Backward),
            Err(BoundaryError::NotGraphemeBoundary)
        );
    }
}
#[test]
fn malformed_offsets_and_selection_leave_state_and_updates_unchanged() {
    let raw = seed("a😀b", "אב");
    let doc = engine(&raw);
    let before = doc.checkpoint().bytes;
    for offset in [2, 5, u32::MAX] {
        for bias in [Bias::Left, Bias::Right] {
            assert!(matches!(
                doc.anchor("block-1", U(offset), bias),
                Err(AnchorError::Boundary(_))
            ));
        }
        assert!(
            doc.selection(
                ("block-2", U(1), Bias::Left),
                ("block-1", U(offset), Bias::Right)
            )
            .is_err()
        );
    }
    assert_eq!(
        utf16_to_byte("😀", U(1)),
        Err(BoundaryError::SurrogateInterior)
    );
    assert_eq!(
        byte_to_utf16("😀", 1),
        Err(BoundaryError::InvalidByteBoundary)
    );
    assert_eq!(
        byte_to_utf16("😀", 5),
        Err(BoundaryError::InvalidByteBoundary)
    );
    assert_eq!(
        validate_range("abc", U(2)..U(1)),
        Err(BoundaryError::ReversedRange)
    );
    assert_eq!(doc.checkpoint().bytes, before);
}
#[test]
fn biased_positions_survive_insertion_at_start_middle_and_end() {
    for offset in [0, 2, 4] {
        let raw = seed("abcd", "");
        let doc = engine(&raw);
        let left = doc.anchor("block-1", U(offset), Bias::Left).unwrap();
        let right = doc.anchor("block-1", U(offset), Bias::Right).unwrap();
        text(&raw, "block-1").insert(&mut raw.transact_mut_with("remote:insert"), offset, "😀");
        let after = engine(&raw);
        position(&after, &left, "block-1", offset, "block-1", offset);
        position(&after, &right, "block-1", offset + 2, "block-1", offset + 2);
    }
}
#[test]
fn empty_source_endpoints_keep_bias_after_remote_insert() {
    let raw = seed("", "");
    let doc = engine(&raw);
    let left = doc.anchor("block-1", U(0), Bias::Left).unwrap();
    let right = doc.anchor("block-1", U(0), Bias::Right).unwrap();
    text(&raw, "block-1").insert(&mut raw.transact_mut_with("remote:insert"), 0, "😀");
    let after = engine(&raw);
    position(&after, &left, "block-1", 0, "block-1", 0);
    position(&after, &right, "block-1", 2, "block-1", 2);
}
#[test]
fn deleted_characters_collapse_to_surviving_boundary() {
    let raw = seed("abcd", "");
    let doc = engine(&raw);
    let left = doc.anchor("block-1", U(2), Bias::Left).unwrap();
    let right = doc.anchor("block-1", U(2), Bias::Right).unwrap();
    text(&raw, "block-1").remove_range(&mut raw.transact_mut_with("remote:delete"), 1, 2);
    let after = engine(&raw);
    position(&after, &left, "block-1", 1, "block-1", 1);
    position(&after, &right, "block-1", 1, "block-1", 1);
}
#[test]
fn fully_deleted_text_keeps_explicit_empty_position() {
    let raw = seed("😀", "");
    let doc = engine(&raw);
    let anchors = [
        doc.anchor("block-1", U(0), Bias::Right).unwrap(),
        doc.anchor("block-1", U(2), Bias::Left).unwrap(),
    ];
    text(&raw, "block-1").remove_range(&mut raw.transact_mut_with("remote:delete"), 0, 2);
    for anchor in anchors {
        position(&engine(&raw), &anchor, "block-1", 0, "block-1", 0);
    }
}
#[test]
fn backward_selection_keeps_independent_endpoint_bias() {
    let raw = seed("abcd", "");
    let doc = engine(&raw);
    let s = doc
        .selection(
            ("block-1", U(3), Bias::Right),
            ("block-1", U(1), Bias::Left),
        )
        .unwrap();
    {
        let t = text(&raw, "block-1");
        let mut txn = raw.transact_mut_with("remote:insert");
        t.insert(&mut txn, 3, "Y");
        t.insert(&mut txn, 1, "X");
    }
    let after = engine(&raw);
    position(&after, &s.anchor, "block-1", 5, "block-1", 5);
    position(&after, &s.focus, "block-1", 1, "block-1", 1);
    let resolved = after.resolve_selection(&s).unwrap();
    assert_eq!(resolved.anchor, after.resolve_anchor(&s.anchor).unwrap());
    assert_eq!(resolved.focus, after.resolve_anchor(&s.focus).unwrap());
}
#[test]
fn deleted_target_is_explicit_and_cannot_be_captured_again() {
    let raw = seed("abc", "tail");
    let doc = engine(&raw);
    let anchor = doc.anchor("block-1", U(2), Bias::Right).unwrap();
    delete(&raw, "block-1");
    let after = engine(&raw);
    assert_eq!(
        after.resolve_anchor(&anchor).unwrap(),
        Resolution::Deleted {
            source: "block-1".into(),
            owner: "block-1".into()
        }
    );
    assert!(matches!(
        after.anchor("block-1", U(2), Bias::Right),
        Err(AnchorError::DeletedTarget)
    ));
    assert!(matches!(
        after.anchor("absent", U(0), Bias::Left),
        Err(AnchorError::MissingTarget)
    ));
}
#[test]
fn split_cut_and_deleted_derived_owner_obey_bias() {
    let raw = seed("abcd", "tail");
    let doc = engine(&raw);
    let left = doc.anchor("block-1", U(2), Bias::Left).unwrap();
    let right = doc.anchor("block-1", U(2), Bias::Right).unwrap();
    mode(&raw, "split", 2);
    let after = engine(&raw);
    position(&after, &left, "block-1", 2, "block-1", 2);
    position(&after, &right, "block-split", 0, "block-1", 2);
    let derived = after.anchor("block-split", U(1), Bias::Right).unwrap();
    assert_eq!(derived.source(), "block-1");
    delete(&raw, "block-split");
    let deleted = engine(&raw);
    position(&deleted, &left, "block-1", 2, "block-1", 2);
    for anchor in [&right, &derived] {
        assert_eq!(
            deleted.resolve_anchor(anchor).unwrap(),
            Resolution::Deleted {
                source: "block-1".into(),
                owner: "block-split".into()
            }
        );
    }
}
#[test]
fn zero_and_end_split_keep_endpoint_owners() {
    for cut in [0, 4] {
        let raw = seed("abcd", "");
        let doc = engine(&raw);
        let left = doc.anchor("block-1", U(cut), Bias::Left).unwrap();
        let right = doc.anchor("block-1", U(cut), Bias::Right).unwrap();
        mode(&raw, "split", cut);
        let after = engine(&raw);
        position(&after, &left, "block-1", cut, "block-1", cut);
        position(&after, &right, "block-split", 0, "block-1", cut);
    }
}
#[test]
fn joined_sources_preserve_identity_and_boundary_affinity() {
    let raw = seed("ab", "😀c");
    let original = engine(&raw);
    let second = original.anchor("block-2", U(2), Bias::Right).unwrap();
    mode(&raw, "join", 0);
    let joined = engine(&raw);
    position(&joined, &second, "block-1", 4, "block-2", 2);
    let left = joined.anchor("block-1", U(2), Bias::Left).unwrap();
    let right = joined.anchor("block-1", U(2), Bias::Right).unwrap();
    assert_eq!(left.source(), "block-1");
    assert_eq!(right.source(), "block-2");
    text(&raw, "block-1").insert(&mut raw.transact_mut_with("remote:append"), 2, "X");
    text(&raw, "block-2").insert(&mut raw.transact_mut_with("remote:prepend"), 0, "Y");
    let after = engine(&raw);
    position(&after, &left, "block-1", 2, "block-1", 2);
    position(&after, &right, "block-1", 4, "block-2", 1);
    delete(&raw, "block-2");
    assert_eq!(
        engine(&raw).resolve_anchor(&second).unwrap(),
        Resolution::Deleted {
            source: "block-2".into(),
            owner: "block-1".into()
        }
    );
}
#[test]
fn placement_change_does_not_change_text_anchor() {
    let raw = seed("abc", "tail");
    let doc = engine(&raw);
    let a = doc.anchor("block-1", U(1), Bias::Right).unwrap();
    {
        let mut txn = raw.transact_mut_with("remote:placement");
        txn.get_map(ROOTS[2]).unwrap().insert(
            &mut txn,
            "block-1",
            Any::Array(vec![Any::from("block-2"), Any::from(7)].into()),
        );
    }
    position(&engine(&raw), &a, "block-1", 1, "block-1", 1);
}
#[test]
fn wrong_document_and_epoch_never_resolve() {
    let raw = seed("abc", "");
    let doc = engine(&raw);
    let a = doc.anchor("block-1", U(1), Bias::Right).unwrap();
    for epoch in [false, true] {
        let mut cp = checkpoint(&raw);
        if epoch {
            cp.identity.epoch = "33333333-3333-4333-8333-333333333333".into();
        } else {
            cp.identity.document_id = "44444444-4444-4444-8444-444444444444".into();
        }
        let other = Document::restore(&cp.identity, &cp, &[]).unwrap();
        assert_eq!(
            other.resolve_anchor(&a).unwrap(),
            Resolution::Unresolvable(Unresolvable::IdentityMismatch)
        );
    }
}
#[test]
fn replaced_shared_text_and_not_yet_received_position_are_unresolvable() {
    let raw = seed("abc", "");
    let old = engine(&raw);
    let a = old.anchor("block-1", U(1), Bias::Right).unwrap();
    text(&raw, "block-1").insert(&mut raw.transact_mut_with("remote:future"), 1, "XY");
    let future = engine(&raw);
    let newer = future.anchor("block-1", U(2), Bias::Right).unwrap();
    assert_eq!(
        old.resolve_anchor(&newer).unwrap(),
        Resolution::Unresolvable(Unresolvable::MissingPosition)
    );
    {
        let mut txn = raw.transact_mut_with("fixture:invalid-replacement");
        txn.get_map(ROOTS[1]).unwrap().insert(
            &mut txn,
            "block-1",
            XmlTextPrelim::new("replacement"),
        );
    }
    assert_eq!(
        engine(&raw).resolve_anchor(&a).unwrap(),
        Resolution::Unresolvable(Unresolvable::ReplacedSource)
    );
}
#[test]
fn three_replicas_reordered_duplicate_updates_preserve_anchors() {
    let raw = seed("a😀bc", "");
    let base = checkpoint(&raw);
    let doc = engine(&raw);
    let left = doc.anchor("block-1", U(3), Bias::Left).unwrap();
    let right = doc.anchor("block-1", U(3), Bias::Right).unwrap();
    let sv = raw.transact().state_vector();
    let mut updates = Vec::new();
    for client in [21, 22] {
        let peer = replica(client);
        peer.transact_mut_with("fixture:restore")
            .apply_update(Update::decode_v1(&base.bytes).unwrap())
            .unwrap();
        {
            let t = text(&peer, "block-1");
            let mut txn = peer.transact_mut_with("remote:edit");
            if client == 21 {
                t.insert(&mut txn, 3, "X");
            } else {
                t.remove_range(&mut txn, 1, 2);
            }
        }
        updates.push(peer.transact().encode_state_as_update_v1(&sv));
    }
    for schedule in [[0, 1, 0, 1], [1, 0, 1, 0]] {
        let journal: Vec<_> = schedule
            .iter()
            .map(|i| ReplayUpdate {
                identity: identity(),
                bytes: updates[*i].clone(),
            })
            .collect();
        let after = Document::restore(&identity(), &base, &journal).unwrap();
        let snapshot = after.snapshot().unwrap();
        let actual: String = snapshot.visible[0]
            .runs
            .iter()
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(actual, "aXbc");
        position(&after, &left, "block-1", 1, "block-1", 1);
        position(&after, &right, "block-1", 2, "block-1", 2);
    }
}

#[test]
fn hidden_join_span_never_redirects_and_visible_offsets_exclude_hidden_text() {
    let raw = seed("ab", "😀c");
    let original = engine(&raw);
    let first = original.anchor("block-1", U(1), Bias::Right).unwrap();
    let second = original.anchor("block-2", U(2), Bias::Right).unwrap();
    mode(&raw, "join", 0);
    delete(&raw, "block-1");
    // A deleted owner hides every span, including the joined second source.
    let hidden = engine(&raw);
    for (anchor, source) in [(&first, "block-1"), (&second, "block-2")] {
        assert_eq!(
            hidden.resolve_anchor(anchor).unwrap(),
            Resolution::Deleted {
                source: source.into(),
                owner: "block-1".into(),
            }
        );
    }
    let raw = seed("ab", "😀c");
    let original = engine(&raw);
    let first = original.anchor("block-1", U(1), Bias::Left).unwrap();
    mode(&raw, "join", 0);
    delete(&raw, "block-2");
    let partial = engine(&raw);
    position(&partial, &first, "block-1", 1, "block-1", 1);
    // Capturing the visible endpoint does not select the hidden joined source.
    let endpoint = partial.anchor("block-1", U(2), Bias::Right).unwrap();
    assert_eq!(endpoint.source(), "block-1");
    position(&partial, &endpoint, "block-1", 2, "block-1", 2);
}

#[test]
fn split_source_deletion_hides_both_owners_without_resurrection() {
    let raw = seed("abcd", "tail");
    mode(&raw, "split", 2);
    let doc = engine(&raw);
    let left = doc.anchor("block-1", U(1), Bias::Left).unwrap();
    let right = doc.anchor("block-split", U(1), Bias::Right).unwrap();
    delete(&raw, "block-1");
    text(&raw, "block-1").insert(&mut raw.transact_mut_with("remote:offline-edit"), 3, "X");
    let after = engine(&raw);
    for (anchor, owner) in [(&left, "block-1"), (&right, "block-split")] {
        assert_eq!(
            after.resolve_anchor(anchor).unwrap(),
            Resolution::Deleted {
                source: "block-1".into(),
                owner: owner.into(),
            }
        );
    }
    assert_eq!(
        after
            .snapshot()
            .unwrap()
            .visible
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        ["block-2"]
    );
}

#[test]
fn cross_node_selection_resolves_deleted_endpoint_independently() {
    let raw = seed("abc", "אב");
    let doc = engine(&raw);
    let selection = doc
        .selection(
            ("block-1", U(1), Bias::Right),
            ("block-2", U(1), Bias::Left),
        )
        .unwrap();
    delete(&raw, "block-1");
    let after = engine(&raw);
    let before = after.checkpoint().bytes;
    let resolved = after.resolve_selection(&selection).unwrap();
    assert_eq!(
        resolved.anchor,
        Resolution::Deleted {
            source: "block-1".into(),
            owner: "block-1".into()
        }
    );
    assert_eq!(
        resolved.focus,
        after.resolve_anchor(&selection.focus).unwrap()
    );
    position(&after, &selection.focus, "block-2", 1, "block-2", 1);
    assert_eq!(after.checkpoint().bytes, before);
}

#[test]
fn reserved_split_owner_remains_invalid_as_a_registered_source() {
    let raw = seed("abcd", "");
    {
        let mut txn = raw.transact_mut_with("fixture:invalid-source");
        txn.get_map(ROOTS[0])
            .unwrap()
            .insert(&mut txn, "block-split", "list");
        txn.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut txn, "block-split", XmlTextPrelim::new("bad"));
    }
    assert!(matches!(
        Document::restore(&identity(), &checkpoint(&raw), &[]),
        Err(editac_core::document::DocumentError::UnsupportedSchema)
    ));
}
