use editac_diff::portable::*;
use serde_json::{Value, json};
fn inputs() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/browser-review/model.json")).unwrap()
}
#[test]
fn source_projected_and_semantic_exports_round_trip_and_keep_provenance() {
    let mut exported = serde_json::Map::new();
    for (id, input) in inputs().as_object().unwrap() {
        let input: ChangeInput = serde_json::from_value(input.clone()).unwrap();
        let model = ChangeModel::new(input).unwrap();
        let bytes = model.encode(MAX_BYTES).unwrap();
        let decoded = ChangeModel::decode(&bytes, MAX_BYTES).unwrap();
        assert!(decoded == model, "{id}");
        if let ChangeInput::Semantic { model } = &decoded.input {
            assert_eq!(model.attribution, "unknown");
            assert!(!model.changes.is_empty());
        }
        exported.insert(id.clone(), serde_json::from_slice::<Value>(&bytes).unwrap());
    }
    assert_eq!(
        exported["projected"]["input"]["serializer"],
        "editac-markdown-v1"
    );
    assert_eq!(exported["projected"]["input"]["dialect"], "commonmark");
    if let Ok(path) = std::env::var("EDITAC_DIFF_PORTABLE_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&exported).unwrap()).unwrap();
    }
}
#[test]
fn unsupported_version_forged_attribution_and_malformed_inputs_reject() {
    let base = json!({"version":VERSION,"input":inputs()["semantic"]});
    for modified in [
        {
            let mut v = base.clone();
            v["version"] = json!("v2");
            v
        },
        {
            let mut v = base.clone();
            v["input"]["model"]["attribution"] = json!("Alice typed every character");
            v
        },
        {
            let mut v = base.clone();
            v["input"]["model"]["before_hash"] = json!("unverified");
            v
        },
        {
            let mut v = base.clone();
            v["input"]["model"]["changes"][0]["after"]["id"] = json!("forged");
            v
        },
        {
            let mut v = base.clone();
            v["author"] = json!("Alice");
            v
        },
        {
            let mut v = base.clone();
            v["input"]["model"]["author"] = json!("Alice");
            v
        },
        {
            let mut v = base.clone();
            v["input"]["model"]["changes"][0]["author"] = json!("Alice");
            v
        },
        {
            let mut v = base.clone();
            v["input"]["model"]["changes"][0]["facets"] = json!(["Text", "Text"]);
            v
        },
    ] {
        assert!(ChangeModel::decode(&serde_json::to_vec(&modified).unwrap(), MAX_BYTES).is_err());
    }
    assert!(ChangeModel::decode(br#"{"version":"editac-change-model-v1","input":{"representation":"exact-source","wire":"bad"}}"#,MAX_BYTES).is_err());
}
#[test]
fn byte_limits_are_explicit_and_do_not_emit_truncated_models() {
    let model =
        ChangeModel::new(serde_json::from_value(inputs()["source"].clone()).unwrap()).unwrap();
    let bytes = model.encode(MAX_BYTES).unwrap();
    assert_eq!(model.encode(bytes.len() - 1), Err(ExportError::Limit));
    assert!(matches!(
        ChangeModel::decode(&bytes, bytes.len() - 1),
        Err(ExportError::Limit)
    ));
    assert!(matches!(
        ChangeModel::decode(&bytes, MAX_BYTES + 1),
        Err(ExportError::Limit)
    ));
    assert_eq!(model.encode(bytes.len()).unwrap(), bytes);
}

use editac_core::{
    document::{
        BLOCK_ATTRIBUTES, BlockAttributes, Document, DocumentIdentity, InitializedCheckpoint, ROOTS,
    },
    projection::Snapshot,
};
use editac_diff::{representation::*, semantic::*};
use yrs::{
    Any, Map, Out, ReadTxn, StateVector, Text, Transact, XmlTextPrelim, updates::decoder::Decode,
};
fn scope() -> RevisionScope {
    RevisionScope {
        document: "fixture".into(),
        epoch: "epoch".into(),
        schema: "v2".into(),
        module_profile: "task".into(),
        observed_token: [1; 65],
    }
}
fn real_doc() -> yrs::Doc {
    let d = yrs::Doc::with_options(yrs::Options {
        client_id: yrs::block::ClientID::new(11),
        offset_kind: yrs::OffsetKind::Utf16,
        ..yrs::Options::default()
    });
    for root in ROOTS.into_iter().chain([BLOCK_ATTRIBUTES]) {
        d.get_or_insert_map(root);
    }
    let mut t = d.transact_mut();
    for (id, order, text) in [("block-1", 0, "hello 😀"), ("block-2", 1, "second")] {
        t.get_map(ROOTS[0]).unwrap().insert(&mut t, id, "block");
        t.get_map(ROOTS[1])
            .unwrap()
            .insert(&mut t, id, XmlTextPrelim::new(text));
        t.get_map(ROOTS[2]).unwrap().insert(
            &mut t,
            id,
            Any::Array(vec![Any::from("@root"), Any::from(order)].into()),
        );
        t.get_map(BLOCK_ATTRIBUTES)
            .unwrap()
            .insert(&mut t, id, BlockAttributes::Paragraph.tuple());
    }
    drop(t);
    d
}
fn engine_snapshot(d: &yrs::Doc) -> Snapshot {
    let identity = DocumentIdentity::v2(
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
    )
    .unwrap();
    let checkpoint = InitializedCheckpoint {
        identity: identity.clone(),
        initialized: true,
        writer_id: 11,
        bytes: d
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    };
    Document::restore(&identity, &checkpoint, &[])
        .unwrap()
        .snapshot()
        .unwrap()
}
fn real_capture(d: &yrs::Doc) -> ImmutableRevision {
    let bytes = d
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let revision = capture_projection(
        scope(),
        &engine_snapshot(d),
        RepresentationLimits::default(),
    )
    .unwrap();
    assert_eq!(
        d.transact()
            .encode_state_as_update_v1(&StateVector::default()),
        bytes,
        "historical capture mutated replica"
    );
    revision
}

#[test]
fn real_concurrent_peer_export_keeps_move_text_marks_and_opaque_facets() {
    let a = real_doc();
    let peer = yrs::Doc::with_options(yrs::Options {
        client_id: yrs::block::ClientID::new(12),
        offset_kind: yrs::OffsetKind::Utf16,
        ..yrs::Options::default()
    });
    peer.transact_mut()
        .apply_update(
            yrs::Update::decode_v1(
                &a.transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
            .unwrap(),
        )
        .unwrap();
    let before = real_capture(&a);
    {
        let mut t = a.transact_mut();
        let map = t.get_map(ROOTS[1]).unwrap();
        let Out::YXmlText(text) = map.get(&t, "block-1").unwrap() else {
            panic!()
        };
        text.insert(&mut t, 0, "local 🙂 ");
    }
    {
        let mut t = peer.transact_mut();
        let map = t.get_map(ROOTS[1]).unwrap();
        let Out::YXmlText(text) = map.get(&t, "block-1").unwrap() else {
            panic!()
        };
        text.format(
            &mut t,
            0,
            5,
            [
                ("link".into(), Any::from("https://example.test/peer")),
                ("future-mark".into(), Any::from("opaque")),
            ]
            .into_iter()
            .collect(),
        );
        t.get_map(ROOTS[2]).unwrap().insert(
            &mut t,
            "block-1",
            Any::Array(vec![Any::from("@root"), Any::from(2)].into()),
        );
    }
    let ua = a
        .transact()
        .encode_state_as_update_v1(&peer.transact().state_vector());
    let ub = peer
        .transact()
        .encode_state_as_update_v1(&a.transact().state_vector());
    a.transact_mut()
        .apply_update(yrs::Update::decode_v1(&ub).unwrap())
        .unwrap();
    peer.transact_mut()
        .apply_update(yrs::Update::decode_v1(&ua).unwrap())
        .unwrap();
    let after = real_capture(&a);
    let peer_revision = real_capture(&peer);
    assert_eq!(after.hash(), peer_revision.hash());
    let model = compare(&before, &after, SemanticLimits::default()).unwrap();
    let change = model.changes.iter().find(|n| n.id == "block-1").unwrap();
    for facet in [
        Facet::Text,
        Facet::Placement,
        Facet::Formatting,
        Facet::References,
    ] {
        assert!(change.facets.contains(&facet));
    }
    assert_eq!(model.attribution, "unknown");
    assert!(
        serde_json::to_string(&model)
            .unwrap()
            .contains("future-mark")
    );
    let portable = ChangeModel::new(ChangeInput::Semantic { model }).unwrap();
    let bytes = portable.encode(MAX_BYTES).unwrap();
    let committed: Value = serde_json::from_str(include_str!(
        "../../../fixtures/browser-review-concurrent/concurrent.json"
    ))
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        committed,
        "Pinned real-peer export must match the browser input exactly"
    );
    assert!(ChangeModel::decode(&bytes, MAX_BYTES).unwrap() == portable);
    if let Ok(path) = std::env::var("EDITAC_DIFF_CONCURRENT_OUTPUT") {
        std::fs::write(path, bytes).unwrap();
    }
}
