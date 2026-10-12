//! ENG-1.16 profile qualification. These are real Yrs updates, not prepared outputs.
use editac_core::Utf16Offset;
use editac_core::anchors::Bias;
use editac_core::document::{
    BLOCK_ATTRIBUTES as A, BlockAttributes as B, CreationPermit, Document, DocumentError as E,
    DocumentIdentity, InitialNode, InitializedCheckpoint, ROOTS, ReplayUpdate,
};
use std::collections::HashMap;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    Any, Assoc, ClientID, Doc, IndexedSequence, Map, OffsetKind, Options, Out, ReadTxn,
    StateVector, StickyIndex, Text, Transact, Update, XmlTextPrelim, XmlTextRef,
};
fn identity() -> DocumentIdentity {
    DocumentIdentity::v2(
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
    )
    .unwrap()
}
fn replica(client: u64) -> Doc {
    let d = Doc::with_options(Options {
        client_id: ClientID::new(client),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    for name in ROOTS.into_iter().chain([A]) {
        d.get_or_insert_map(name);
    }
    d
}
fn bytes(d: &Doc) -> Vec<u8> {
    d.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
fn checkpoint(d: &Doc) -> InitializedCheckpoint {
    InitializedCheckpoint {
        identity: identity(),
        initialized: true,
        writer_id: 11,
        bytes: bytes(d),
    }
}
fn engine(d: &Doc) -> Document {
    Document::restore(&identity(), &checkpoint(d), &[]).unwrap()
}
fn restore(cp: &InitializedCheckpoint, updates: &[Vec<u8>]) -> Result<Document, E> {
    Document::restore(
        &identity(),
        cp,
        &updates
            .iter()
            .map(|bytes| ReplayUpdate {
                identity: identity(),
                bytes: bytes.clone(),
            })
            .collect::<Vec<_>>(),
    )
}
fn text(d: &Doc, id: &str) -> XmlTextRef {
    let t = d.transact();
    let Some(Out::YXmlText(x)) = t.get_map(ROOTS[1]).unwrap().get(&t, id) else {
        panic!("text")
    };
    x
}
fn set(d: &Doc, id: &str, value: Any) {
    let mut t = d.transact_mut_with("fixture:metadata");
    t.get_map(A).unwrap().insert(&mut t, id, value);
}
fn tuple(d: &Doc, id: &str) -> Option<Any> {
    let t = d.transact();
    match t.get_map(A).unwrap().get(&t, id) {
        Some(Out::Any(v)) => Some(v),
        None => None,
        _ => panic!("tuple"),
    }
}
fn seed(first: &str, second: &str) -> Doc {
    let d = replica(11);
    {
        let mut t = d.transact_mut_with("initialize");
        for (id, value, order, attrs) in [
            ("block-1", first, 0, B::Heading(1)),
            ("block-2", second, 1, B::Paragraph),
        ] {
            t.get_map(ROOTS[0]).unwrap().insert(&mut t, id, "block");
            let x = t
                .get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, id, XmlTextPrelim::new(value));
            if !value.is_empty() {
                x.format(
                    &mut t,
                    0,
                    value.encode_utf16().count() as u32,
                    HashMap::from([
                        ("bold".into(), Any::Bool(true)),
                        (
                            "ext:v1".into(),
                            Any::Map(HashMap::from([("retained".into(), Any::Bool(true))]).into()),
                        ),
                    ]),
                );
            }
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                id,
                Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
            );
            t.get_map(A).unwrap().insert(&mut t, id, attrs.tuple());
        }
        t.get_map(ROOTS[4]).unwrap().insert(
            &mut t,
            "pair",
            Any::Array(vec![Any::from("original")].into()),
        );
    }
    d
}
fn fork(d: &Doc, client: u64) -> Doc {
    let x = replica(client);
    x.transact_mut_with("restore")
        .apply_update(Update::decode_v1(&bytes(d)).unwrap())
        .unwrap();
    x
}
fn delta(d: &Doc, baseline: &StateVector) -> Vec<u8> {
    d.transact().encode_state_as_update_v1(baseline)
}
fn split(d: &Doc, offset: u32) {
    let x = text(d, "block-1");
    let mut t = d.transact_mut_with("fixture:split");
    let anchor = x.sticky_index(&t, offset, Assoc::Before).unwrap();
    t.get_map(ROOTS[4]).unwrap().insert(
        &mut t,
        "pair",
        Any::Array(vec![Any::from("split"), Any::Buffer(anchor.encode_v1().into())].into()),
    );
}
fn join(d: &Doc) {
    let mut t = d.transact_mut_with("fixture:join");
    t.get_map(ROOTS[4])
        .unwrap()
        .insert(&mut t, "pair", Any::Array(vec![Any::from("join")].into()));
}
fn attrs(d: &Document, id: &str) -> B {
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
fn unchanged(d: &mut Document, u: ReplayUpdate, e: E) {
    let before = d.checkpoint();
    let rev = d.revision();
    let visible = d.snapshot().unwrap().visible;
    assert_eq!(d.apply_replay(&u), Err(e));
    assert_eq!(d.checkpoint().bytes, before.bytes);
    assert_eq!(d.revision(), rev);
    assert_eq!(d.snapshot().unwrap().visible, visible);
}

#[test]
fn v2_creation_empty_restore_once_and_fresh_writers() {
    let id = DocumentIdentity::v2(
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
    )
    .unwrap();
    let d = Document::create(
        CreationPermit::authorize_new(id.clone()).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: "".into(),
        }],
    )
    .unwrap();
    let cp = d.checkpoint();
    let restored = Document::restore(&id, &cp, &[]).unwrap();
    let s = restored.snapshot().unwrap();
    assert_eq!(s.visible.len(), 1);
    assert!(s.visible[0].runs.is_empty());
    assert_eq!(s.visible[0].block_attributes, Some(B::Paragraph));
    assert_eq!(restored.checkpoint().bytes, cp.bytes);
    assert_ne!(restored.writer_id(), d.writer_id());
    assert!(matches!(
        CreationPermit::authorize_new(id),
        Err(E::AlreadyInitialized)
    ));
}
#[test]
fn v2_empty_document_restore_never_seeds() {
    let d = replica(11);
    let e = engine(&d);
    assert!(e.snapshot().unwrap().visible.is_empty());
    assert_eq!(e.checkpoint().bytes, bytes(&d));
}
#[test]
fn heading_levels_one_through_six_and_paragraph_switching() {
    let d = seed("", "");
    let mut e = engine(&d);
    for level in 1..=6 {
        set(&d, "block-1", B::Heading(level).tuple());
        e.apply_replay(&ReplayUpdate {
            identity: identity(),
            bytes: bytes(&d),
        })
        .unwrap();
        assert_eq!(attrs(&e, "block-1"), B::Heading(level));
    }
    set(&d, "block-1", B::Paragraph.tuple());
    e.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: bytes(&d),
    })
    .unwrap();
    assert_eq!(attrs(&e, "block-1"), B::Paragraph);
    assert_eq!(
        Document::restore(&identity(), &e.checkpoint(), &[])
            .unwrap()
            .snapshot()
            .unwrap()
            .visible,
        e.snapshot().unwrap().visible
    );
}
#[test]
fn absent_tuple_defaults_without_repair_writes() {
    let d = seed("", "");
    {
        let mut t = d.transact_mut();
        t.get_map(A).unwrap().remove(&mut t, "block-1");
    }
    let e = engine(&d);
    let before = e.checkpoint().bytes;
    assert_eq!(attrs(&e, "block-1"), B::Paragraph);
    assert_eq!(e.checkpoint().bytes, before);
    assert_eq!(tuple(&d, "block-1"), None);
}
#[test]
fn invalid_tuple_matrix_rejects_without_partial_content_or_vector_change() {
    let values = vec![
        Any::Null,
        Any::from("paragraph"),
        Any::Array(vec![].into()),
        Any::Array(vec![Any::from("paragraph"), Any::from(1)].into()),
        Any::Array(vec![Any::from("heading")].into()),
        Any::Array(vec![Any::from("heading"), Any::from("1")].into()),
        Any::Array(vec![Any::from("heading"), Any::from(1), Any::Null].into()),
    ];
    let mut all = values;
    for n in [0.0, 7.0, 1.5, f64::NAN, f64::INFINITY] {
        all.push(Any::Array(vec![Any::from("heading"), Any::from(n)].into()));
    }
    for value in all {
        let d = seed("a😀b", "");
        let mut e = engine(&d);
        set(&d, "block-1", value);
        {
            let x = text(&d, "block-1");
            let mut t = d.transact_mut();
            x.insert(&mut t, 0, "must not leak");
            x.format(
                &mut t,
                0,
                4,
                HashMap::from([("italic".into(), Any::Bool(true))]),
            );
            t.get_map(A)
                .unwrap()
                .insert(&mut t, "block-2", B::Heading(6).tuple());
        }
        unchanged(
            &mut e,
            ReplayUpdate {
                identity: identity(),
                bytes: bytes(&d),
            },
            E::UnsupportedSchema,
        );
        assert!(matches!(
            Document::restore(&identity(), &checkpoint(&d), &[]),
            Err(E::UnsupportedSchema)
        ));
    }
}
#[test]
fn exact_profile_schema_epoch_document_and_encoding_rejection() {
    let d = seed("a😀b", "");
    let mut e = engine(&d);
    let mut profiles = vec![];
    let mut v1 = identity();
    v1.profile = "editac.yrs-yjs.v1".into();
    v1.schema = "editac.registry.v1".into();
    profiles.push((v1, E::UnsupportedProfile));
    for (field, value, error) in [
        ("profile", "unknown", E::UnsupportedProfile),
        ("schema", "editac.registry.v1", E::UnsupportedProfile),
        (
            "epoch",
            "77777777-7777-4777-8777-777777777777",
            E::WrongEpoch,
        ),
        (
            "document",
            "77777777-7777-4777-8777-777777777777",
            E::WrongDocument,
        ),
        ("offsets", "utf8", E::UnsupportedProfile),
    ] {
        let mut id = identity();
        match field {
            "profile" => id.profile = value.into(),
            "schema" => id.schema = value.into(),
            "epoch" => id.epoch = value.into(),
            "document" => id.document_id = value.into(),
            _ => id.offsets = value.into(),
        };
        profiles.push((id, error));
    }
    let mut encoding = identity();
    encoding.update_encoding = 2;
    profiles.push((encoding, E::UnsupportedProfile));
    let mut protocol = identity();
    protocol.protocol_version = 2;
    profiles.push((protocol, E::UnsupportedProfile));
    for (id, error) in profiles {
        unchanged(
            &mut e,
            ReplayUpdate {
                identity: id,
                bytes: bytes(&d),
            },
            error,
        );
    }
    let legacy = DocumentIdentity::v1(identity().document_id, identity().epoch).unwrap();
    assert!(matches!(
        Document::restore(&legacy, &checkpoint(&d), &[]),
        Err(E::UnsupportedProfile)
    ));
}
#[test]
fn unknown_json_tuple_and_marks_retained_with_safe_opaque_projection() {
    let d = seed("a😀b", "");
    let value = Any::Array(
        vec![
            Any::from("ext:future"),
            Any::Map(
                HashMap::from([(
                    "data".into(),
                    Any::Array(vec![Any::Null, Any::from(6.0)].into()),
                )])
                .into(),
            ),
        ]
        .into(),
    );
    set(&d, "block-1", value.clone());
    let e = engine(&d);
    assert_eq!(attrs(&e, "block-1"), B::Unknown(value.clone()));
    let s = e.snapshot().unwrap();
    assert_eq!(s.visible[0].kind, "block");
    assert!(s.visible[0].runs[0].attributes.contains_key("ext:v1"));
    assert_eq!(attrs(&e, "block-1").presentation(), B::Paragraph);
    let cp = e.checkpoint();
    let restored = Document::restore(&identity(), &cp, &[]).unwrap();
    assert_eq!(attrs(&restored, "block-1"), B::Unknown(value));
    assert_eq!(cp.bytes, restored.checkpoint().bytes);
}
#[test]
fn unsupported_tuple_shared_types_and_targets_rejected() {
    for id in ["not-registered", "block-2"] {
        let d = seed("", "");
        if id == "block-2" {
            let mut t = d.transact_mut();
            t.get_map(ROOTS[0]).unwrap().insert(&mut t, id, "item");
        }
        set(&d, id, B::Heading(1).tuple());
        assert!(matches!(
            Document::restore(&identity(), &checkpoint(&d), &[]),
            Err(E::UnsupportedSchema)
        ));
    }
    let d = seed("", "");
    {
        let mut t = d.transact_mut();
        t.get_map(A)
            .unwrap()
            .insert(&mut t, "block-1", yrs::ArrayPrelim::from(["paragraph"]));
    }
    assert!(matches!(
        Document::restore(&identity(), &checkpoint(&d), &[]),
        Err(E::UnsupportedSchema)
    ));
    let d = seed("", "");
    d.get_or_insert_text("extra-root")
        .insert(&mut d.transact_mut(), 0, "x");
    assert!(matches!(
        Document::restore(&identity(), &checkpoint(&d), &[]),
        Err(E::UnsupportedSchema)
    ));
}
#[test]
fn unknown_non_json_or_excessively_deep_tuples_rejected() {
    let mut deep = Any::Null;
    for _ in 0..34 {
        deep = Any::Array(vec![deep].into());
    }
    for value in [Any::Buffer(vec![1].into()), Any::Undefined, deep] {
        let d = seed("", "");
        set(
            &d,
            "block-1",
            Any::Array(vec![Any::from("future"), value].into()),
        );
        assert!(matches!(
            Document::restore(&identity(), &checkpoint(&d), &[]),
            Err(E::UnsupportedSchema)
        ));
    }
}
#[test]
fn live_split_inheritance_override_and_empty_sides() {
    for offset in [0, 1, 3, 4] {
        let d = seed("a😀b", "");
        split(&d, offset);
        let e = engine(&d);
        assert_eq!(attrs(&e, "block-split"), B::Heading(1));
        let before = e.snapshot().unwrap().visible;
        set(&d, "block-1", B::Heading(6).tuple());
        let e = engine(&d);
        assert_eq!(attrs(&e, "block-split"), B::Heading(6));
        assert_eq!(e.snapshot().unwrap().visible[1].spans, before[1].spans);
        set(&d, "block-split", B::Paragraph.tuple());
        set(&d, "block-1", B::Heading(2).tuple());
        let e = engine(&d);
        assert_eq!(attrs(&e, "block-1"), B::Heading(2));
        assert_eq!(attrs(&e, "block-split"), B::Paragraph);
    }
    let empty = seed("", "");
    split(&empty, 0);
    let e = engine(&empty);
    assert_eq!(attrs(&e, "block-1"), B::Heading(1));
    assert_eq!(attrs(&e, "block-split"), B::Heading(1));
    let s = e.snapshot().unwrap();
    assert_eq!(s.visible.len(), 3);
    assert!(s.visible.iter().all(|n| n.runs.is_empty()));
    assert_eq!(
        Document::restore(&identity(), &e.checkpoint(), &[])
            .unwrap()
            .snapshot()
            .unwrap()
            .visible,
        s.visible
    );
}
#[test]
fn dormant_override_and_losing_join_branch_do_not_synthesize_owners() {
    let d = seed("a😀b", "");
    set(&d, "block-split", B::Heading(6).tuple());
    let e = engine(&d);
    assert!(
        !e.snapshot()
            .unwrap()
            .visible
            .iter()
            .any(|n| n.id == "block-split")
    );
    let cp = checkpoint(&d);
    let baseline = d.transact().state_vector();
    let split_doc = fork(&d, 21);
    let join_doc = fork(&d, 22);
    split(&split_doc, 1);
    join(&join_doc);
    assert_eq!(attrs(&engine(&split_doc), "block-split"), B::Heading(6));
    let x = delta(&split_doc, &baseline);
    let y = delta(&join_doc, &baseline);
    for updates in [
        vec![x.clone(), y.clone()],
        vec![y.clone(), x.clone()],
        vec![x.clone(), y.clone(), x.clone()],
    ] {
        let e = restore(&cp, &updates).unwrap();
        assert!(
            !e.snapshot()
                .unwrap()
                .visible
                .iter()
                .any(|n| n.id == "block-split")
        );
        let raw = replica(30);
        raw.transact_mut()
            .apply_update(Update::decode_v1(&e.checkpoint().bytes).unwrap())
            .unwrap();
        assert_eq!(tuple(&raw, "block-split"), Some(B::Heading(6).tuple()));
    }
}
#[test]
fn absorbed_and_deleted_metadata_retained_without_resurrection() {
    let d = seed("a😀b", "tail");
    set(&d, "block-2", B::Heading(6).tuple());
    join(&d);
    let e = engine(&d);
    let s = e.snapshot().unwrap();
    assert_eq!(s.visible.len(), 1);
    assert_eq!(attrs(&e, "block-1"), B::Heading(1));
    assert_eq!(tuple(&d, "block-2"), Some(B::Heading(6).tuple()));
    assert_eq!(s.visible[0].spans.len(), 2);
    {
        let mut t = d.transact_mut();
        t.get_map(ROOTS[3]).unwrap().insert(&mut t, "block-1", true);
        t.get_map(ROOTS[3]).unwrap().insert(&mut t, "block-2", true);
    }
    let e = engine(&d);
    assert!(e.snapshot().unwrap().visible.is_empty());
    assert_eq!(
        e.snapshot().unwrap().recovery[0].block_attributes,
        Some(B::Heading(1))
    );
    assert_eq!(
        Document::restore(&identity(), &e.checkpoint(), &[])
            .unwrap()
            .snapshot()
            .unwrap()
            .recovery,
        e.snapshot().unwrap().recovery
    );
}
#[test]
fn concurrent_whole_tuple_conflicts_and_independent_writes_converge() {
    let d = seed("a😀b", "");
    let cp = checkpoint(&d);
    let base = d.transact().state_vector();
    let a = fork(&d, 21);
    let b = fork(&d, 22);
    set(&a, "block-1", B::Heading(6).tuple());
    set(&b, "block-1", B::Paragraph.tuple());
    set(&a, "block-2", B::Heading(3).tuple());
    let x = delta(&a, &base);
    let y = delta(&b, &base);
    let mut expected = None;
    for updates in [
        vec![x.clone(), y.clone()],
        vec![y.clone(), x.clone()],
        vec![x.clone(), y.clone(), x.clone()],
        vec![y.clone(), x.clone(), y.clone()],
    ] {
        let e = restore(&cp, &updates).unwrap();
        assert_eq!(attrs(&e, "block-1"), B::Paragraph);
        assert_eq!(attrs(&e, "block-2"), B::Heading(3));
        let s = e.snapshot().unwrap().visible;
        if let Some(old) = &expected {
            assert_eq!(&s, old);
        } else {
            expected = Some(s);
        }
    }
}
#[test]
fn causal_override_split_reorder_duplicates_restore_and_stable_anchors() {
    let d = seed("a😀b", "");
    let cp = checkpoint(&d);
    let base = d.transact().state_vector();
    let owner = fork(&d, 21);
    let override_doc = fork(&d, 22);
    let initial = engine(&d);
    let anchor = initial
        .anchor("block-1", Utf16Offset(3), Bias::Left)
        .unwrap();
    split(&owner, 1);
    set(&override_doc, "block-split", B::Heading(6).tuple());
    let x = delta(&owner, &base);
    let y = delta(&override_doc, &base);
    let mut expected = None;
    for updates in [
        vec![x.clone(), y.clone()],
        vec![y.clone(), x.clone()],
        vec![y.clone(), x.clone(), y.clone(), x.clone()],
    ] {
        let e = restore(&cp, &updates).unwrap();
        assert_eq!(attrs(&e, "block-split"), B::Heading(6));
        assert_eq!(
            e.resolve_anchor(&anchor),
            restore(&cp, &[x.clone(), y.clone()])
                .unwrap()
                .resolve_anchor(&anchor)
        );
        let s = e.snapshot().unwrap().visible;
        if let Some(old) = &expected {
            assert_eq!(&s, old);
        } else {
            expected = Some(s);
        }
        assert_eq!(
            Document::restore(&identity(), &e.checkpoint(), &[])
                .unwrap()
                .snapshot()
                .unwrap()
                .visible,
            e.snapshot().unwrap().visible
        );
    }
    // Causally dependent tuple update can precede its predecessor on replay.
    let prior = owner.transact().state_vector();
    set(&owner, "block-1", B::Heading(4).tuple());
    let z = delta(&owner, &prior);
    assert_eq!(
        attrs(&restore(&cp, &[z, x]).unwrap(), "block-1"),
        B::Heading(4)
    );
}
#[test]
fn metadata_only_changes_are_observable_without_text_reads_or_identity_changes() {
    let d = seed("", "");
    let mut e = engine(&d);
    let before = e.snapshot().unwrap();
    set(&d, "block-1", B::Heading(6).tuple());
    e.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: bytes(&d),
    })
    .unwrap();
    let after = e.snapshot().unwrap();
    assert_eq!(after.source_reads, 0);
    assert!(after.changed_nodes.contains("block-1"));
    assert_eq!(after.visible[0].spans, before.visible[0].spans);
    assert!(after.visible[0].runs.is_empty());
    assert_eq!(after.visible[0].block_attributes, Some(B::Heading(6)));
}
#[test]
fn bounded_admission_invalid_bytes_and_missing_dependencies_preserve_live_state() {
    let d = seed("", "");
    let mut e = engine(&d);
    unchanged(
        &mut e,
        ReplayUpdate {
            identity: identity(),
            bytes: vec![255],
        },
        E::InvalidUpdate,
    );
    unchanged(
        &mut e,
        ReplayUpdate {
            identity: identity(),
            bytes: vec![0; editac_core::document::MAX_RESTORE_BYTES + 1],
        },
        E::ResourceLimit,
    );
    let base = d.transact().state_vector();
    set(&d, "block-1", B::Heading(6).tuple());
    let prior = d.transact().state_vector();
    set(&d, "block-1", B::Heading(3).tuple());
    let update = delta(&d, &prior);
    unchanged(
        &mut e,
        ReplayUpdate {
            identity: identity(),
            bytes: update.clone(),
        },
        E::IncompleteRestore,
    );
    assert_eq!(
        attrs(
            &restore(&checkpoint(&seed("", "")), &[update, delta(&d, &base)]).unwrap(),
            "block-1"
        ),
        B::Heading(3)
    );
}
#[test]
fn pinned_yjs_exchange_both_directions_with_atomic_conflicts_and_replay() {
    use std::{fs, path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::var_os("EDITAC_BLOCK_EXCHANGE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("../architecture/evidence/engine-block-profile/exchange"));
    fs::create_dir_all(&dir).unwrap();
    let d = seed("a😀b", "");
    fs::write(dir.join("rust-seed.bin"), bytes(&d)).unwrap();
    let anchor = text(&d, "block-1")
        .sticky_index(&d.transact(), 3, Assoc::Before)
        .unwrap();
    fs::write(dir.join("rust-anchor.bin"), anchor.encode_v1()).unwrap();
    split(&d, 3);
    set(&d, "block-split", B::Heading(6).tuple());
    fs::write(dir.join("rust-split.bin"), bytes(&d)).unwrap();
    let result = Command::new("node")
        .arg("--test")
        .arg(root.join("fixtures/schema-v2/exchange.mjs"))
        .env("EDITAC_BLOCK_EXCHANGE", &dir)
        .output()
        .unwrap();
    fs::write(
        dir.join("node.log"),
        [result.stdout, result.stderr].concat(),
    )
    .unwrap();
    assert!(
        result.status.success(),
        "pinned Node exchange failed; inspect exchange/node.log"
    );
    let js = fs::read(dir.join("js-seed.bin")).unwrap();
    let cp = InitializedCheckpoint {
        identity: identity(),
        initialized: true,
        writer_id: 31,
        bytes: js,
    };
    let e = Document::restore(&identity(), &cp, &[]).unwrap();
    assert_eq!(attrs(&e, "block-1"), B::Heading(1));
    let rust = engine(&seed("a😀b", "")).snapshot().unwrap();
    let js_snapshot = e.snapshot().unwrap();
    for (js, rust) in js_snapshot.visible.iter().zip(&rust.visible) {
        assert_eq!(js.runs, rust.runs);
        assert_eq!(js.kind, rust.kind);
        assert_eq!(js.block_attributes, rust.block_attributes);
    }
    let js_split = fs::read(dir.join("js-split.bin")).unwrap();
    let js_join = fs::read(dir.join("js-join.bin")).unwrap();
    for (name, update) in [("split", js_split), ("join", js_join)] {
        let e = restore(&cp, &[update.clone(), update]).unwrap();
        let s = e.snapshot().unwrap();
        if name == "split" {
            assert_eq!(attrs(&e, "block-split"), B::Heading(6));
            assert_eq!(s.visible[0].spans[0].end, 3);
            assert_eq!(
                s.visible
                    .iter()
                    .find(|n| n.id == "block-split")
                    .unwrap()
                    .spans[0]
                    .start,
                3
            );
        } else {
            assert_eq!(s.visible.len(), 1);
            assert_eq!(s.visible[0].spans.len(), 2);
        }
        assert_eq!(
            s.visible[0].spans[0].identity,
            js_snapshot.visible[0].spans[0].identity
        );
        assert_eq!(
            Document::restore(&identity(), &e.checkpoint(), &[])
                .unwrap()
                .snapshot()
                .unwrap()
                .visible,
            s.visible
        );
    }
    let x = fs::read(dir.join("js-conflict-a.bin")).unwrap();
    let y = fs::read(dir.join("js-conflict-b.bin")).unwrap();
    for updates in [
        vec![x.clone(), y.clone()],
        vec![y.clone(), x.clone()],
        vec![x.clone(), y.clone(), x.clone()],
    ] {
        let e = restore(&cp, &updates).unwrap();
        assert_eq!(attrs(&e, "block-1"), B::Paragraph);
        assert_eq!(attrs(&e, "block-2"), B::Heading(6));
    }
    let a = StickyIndex::decode_v1(&fs::read(dir.join("js-anchor.bin")).unwrap()).unwrap();
    let doc = replica(41);
    doc.transact_mut()
        .apply_update(Update::decode_v1(&cp.bytes).unwrap())
        .unwrap();
    let t = doc.transact();
    let position = a.get_offset(&t).unwrap();
    assert_eq!(position.index, 3);
    assert_eq!(
        position.branch.id(),
        AsRef::<yrs::branch::Branch>::as_ref(&text(&doc, "block-1")).id()
    );
    for name in [
        "js-invalid-shared-tuple.bin",
        "js-invalid-tuple.bin",
        "js-invalid-root.bin",
    ] {
        let mut live = Document::restore(&identity(), &cp, &[]).unwrap();
        unchanged(
            &mut live,
            ReplayUpdate {
                identity: identity(),
                bytes: fs::read(dir.join(name)).unwrap(),
            },
            E::UnsupportedSchema,
        );
    }
}

#[test]
fn concurrent_deleted_split_owner_retains_metadata_and_stable_deleted_anchor() {
    let d = seed("a😀b", "tail");
    let cp = checkpoint(&d);
    let baseline = d.transact().state_vector();
    let a = fork(&d, 21);
    let b = fork(&d, 22);
    let c = fork(&d, 23);
    split(&a, 1);
    set(&b, "block-split", B::Heading(6).tuple());
    let changed_text = text(&c, "block-1");
    {
        let mut t = c.transact_mut_with("fixture:delete");
        t.get_map(ROOTS[3])
            .unwrap()
            .insert(&mut t, "block-split", true);
        changed_text.insert(&mut t, 4, "R");
    }
    let x = delta(&a, &baseline);
    let y = delta(&b, &baseline);
    let z = delta(&c, &baseline);
    let mut expected = None;
    for updates in [
        vec![x.clone(), y.clone(), z.clone()],
        vec![x.clone(), z.clone(), y.clone()],
        vec![y.clone(), x.clone(), z.clone()],
        vec![y.clone(), z.clone(), x.clone()],
        vec![z.clone(), x.clone(), y.clone()],
        vec![z.clone(), y.clone(), x.clone()],
        vec![z.clone(), y.clone(), x.clone(), z.clone(), y.clone()],
    ] {
        let e = restore(&cp, &updates).unwrap();
        let s = e.snapshot().unwrap();
        assert!(!s.visible.iter().any(|n| n.id == "block-split"));
        let hidden = s.recovery.iter().find(|n| n.id == "block-split").unwrap();
        assert_eq!(hidden.block_attributes, Some(B::Heading(6)));
        assert_eq!(
            hidden
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>(),
            "😀bR"
        );
        let semantics = (s.visible.clone(), s.recovery.clone());
        if let Some(old) = &expected {
            assert_eq!(&semantics, old);
        } else {
            expected = Some(semantics);
        }
        let restored = Document::restore(&identity(), &e.checkpoint(), &[]).unwrap();
        assert_eq!(restored.snapshot().unwrap().recovery, s.recovery);
    }
}

#[test]
fn block_profile_does_not_reinterpret_list_and_item_kinds() {
    let d = replica(11);
    {
        let mut t = d.transact_mut();
        for (id, kind, parent, order) in [
            ("list-1", "list", "@root", 0),
            ("item-1", "item", "list-1", 0),
        ] {
            t.get_map(ROOTS[0]).unwrap().insert(&mut t, id, kind);
            t.get_map(ROOTS[1])
                .unwrap()
                .insert(&mut t, id, XmlTextPrelim::new(""));
            t.get_map(ROOTS[2]).unwrap().insert(
                &mut t,
                id,
                Any::Array(vec![Any::from(parent), Any::from(order)].into()),
            );
        }
    }
    let e = engine(&d);
    let s = e.snapshot().unwrap();
    assert_eq!(s.visible.len(), 2);
    assert!(s.visible.iter().all(|n| n.block_attributes.is_none()));
    assert_eq!(s.visible[1].kind, "item");
    assert_eq!(s.visible[1].parent, "list-1");
}

#[test]
fn malformed_binary_ownership_or_surrogate_cut_rejected_atomically() {
    for offset in [None, Some(2)] {
        let d = seed("a😀b", "");
        let mut e = engine(&d);
        if let Some(offset) = offset {
            split(&d, offset);
        } else {
            let mut t = d.transact_mut();
            t.get_map(ROOTS[4]).unwrap().insert(
                &mut t,
                "pair",
                Any::Array(vec![Any::from("split"), Any::Buffer(vec![255].into())].into()),
            );
        }
        unchanged(
            &mut e,
            ReplayUpdate {
                identity: identity(),
                bytes: bytes(&d),
            },
            E::UnsupportedSchema,
        );
    }
}
#[test]
fn identical_replay_does_not_mutate_revision_projection_or_checkpoint() {
    let d = seed("a😀b", "");
    let mut e = engine(&d);
    let before = e.snapshot().unwrap().visible;
    let cp = e.checkpoint();
    let rev = e.revision();
    e.apply_replay(&ReplayUpdate {
        identity: identity(),
        bytes: cp.bytes.clone(),
    })
    .unwrap();
    assert_eq!(e.revision(), rev);
    assert_eq!(e.checkpoint().bytes, cp.bytes);
    let after = e.snapshot().unwrap();
    assert_eq!(after.visible, before);
    assert!(after.changed_nodes.is_empty());
}
