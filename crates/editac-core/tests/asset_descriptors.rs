//! RCH-1.11 canonical portable proof: real Document preparation/history/replay,
//! inert source/export, shared host states and scoped prepared host records.
use editac_core::{
    Utf16Offset,
    anchors::Bias,
    commands::{
        editor::{EditorCommand, FragmentBlock, FragmentRun},
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    history::HistoryConfig,
    modules::{
        assets::*,
        content::{Content, ContentError},
    },
};
use serde_json::{Value, json};
use yrs::Any;
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/rich-content/asset-descriptors.json"
    ))
    .unwrap()
}
fn descriptor() -> AssetDescriptor {
    serde_json::from_value(corpus()["descriptors"][0].clone()).unwrap()
}
fn content(d: AssetDescriptor) -> Content {
    Content::Asset { descriptor: d }
}
fn any(v: &Value) -> Any {
    Any::from_json(&v.to_string()).unwrap()
}
fn tuple(d: &AssetDescriptor) -> Any {
    content(d.clone()).tuple().unwrap()
}
fn origin() -> TextOrigin {
    TextOrigin::new("asset-descriptors").unwrap()
}
fn blank() -> Document {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = DocumentIdentity::v5(
        format!("93000000-0000-4000-8000-{next:012}"),
        format!("94000000-0000-4000-8000-{next:012}"),
    )
    .unwrap();
    let mut d = Document::create(
        CreationPermit::authorize_new(id).unwrap(),
        &[InitialNode {
            kind: "block".into(),
            text: String::new(),
        }],
    )
    .unwrap();
    d.enable_history(HistoryConfig::default()).unwrap();
    d
}
fn block(d: &AssetDescriptor) -> FragmentBlock {
    FragmentBlock {
        attributes: Some(BlockAttributes::Unknown(tuple(d))),
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: d.fallback.clone(),
            marks: vec![],
        }],
        containers: vec![],
        checked: None,
    }
}
fn insert(d: &mut Document, descriptor: &AssetDescriptor) {
    let node = d.snapshot().unwrap().visible[0].id.clone();
    let a = d.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    let before = d.checkpoint().bytes;
    let p = d
        .prepare_fragment(
            &editac_core::anchors::Selection {
                anchor: a.clone(),
                focus: a,
            },
            &[block(descriptor)],
            &origin(),
        )
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before, "prepare is pure");
    d.commit_editor(p).unwrap();
}
fn engine() -> Document {
    let mut d = blank();
    insert(&mut d, &descriptor());
    Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap()
}
fn asset_id(d: &Document) -> String {
    d.snapshot().unwrap().visible.into_iter().find(|n| {
        matches!(&n.block_attributes, Some(BlockAttributes::Unknown(t)) if matches!(Content::from_tuple(t), Ok(Some(Content::Asset {..}))))
    }).expect("inserted asset owner").id.clone()
}
fn attrs(d: &Document) -> Any {
    d.snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == asset_id(d))
        .unwrap()
        .block_attributes
        .as_ref()
        .unwrap()
        .tuple()
}
fn grant(id: &AssetIdentity, actions: Vec<AssetAction>) -> AssetGrant {
    AssetGrant {
        identity: id.clone(),
        actions,
    }
}
fn request(action: AssetAction) -> AssetRequest {
    AssetRequest {
        version: 1,
        operation_id: "op-123".into(),
        identity: descriptor().identity,
        action,
        byte_limit: 1024,
    }
}

#[test]
fn file_image_media_shared_fixture_roundtrips_through_real_document() {
    for value in corpus()["descriptors"].as_array().unwrap() {
        let asset: AssetDescriptor = serde_json::from_value(value.clone()).unwrap();
        let mut d = blank();
        insert(&mut d, &asset);
        assert_eq!(attrs(&d), tuple(&asset));
        assert_eq!(
            d.fragment_for_node(&asset_id(&d)).unwrap().runs[0].text,
            asset.fallback
        );
        assert_eq!(
            Content::from_tuple(&attrs(&d))
                .unwrap()
                .unwrap()
                .tuple()
                .unwrap(),
            tuple(&asset)
        );
        assert_eq!(d.history_state().undo_groups, 1);
        d.undo().unwrap().unwrap();
        assert!(d.snapshot().unwrap().visible[0].runs.is_empty());
        d.redo().unwrap().unwrap();
        assert_eq!(attrs(&d), tuple(&asset));
    }
}
#[test]
fn all_seven_states_are_host_observations_without_document_effects() {
    let d = engine();
    let before = d.checkpoint().bytes;
    let asset = descriptor();
    let observations: Vec<AssetObservation> =
        serde_json::from_value(corpus()["observations"].clone()).unwrap();
    assert_eq!(observations.len(), 7);
    for o in observations {
        assert_eq!(asset.state(Some(&o)).unwrap(), o.state);
        assert_eq!(d.checkpoint().bytes, before);
    }
}
#[test]
fn replica_without_bytes_is_missing_and_wrong_identity_observations_reject() {
    let a = descriptor();
    assert_eq!(a.state(None), Ok(AssetState::Missing));
    let mut o = AssetObservation {
        identity: a.identity.clone(),
        state: AssetState::Available,
    };
    o.identity.key = "other".into();
    assert_eq!(a.state(Some(&o)), Err(ContentError::InvalidShape));
    let d = engine();
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    let Content::Asset { descriptor: b } = Content::from_tuple(&attrs(&restored)).unwrap().unwrap()
    else {
        panic!()
    };
    assert_eq!(b.state(None), Ok(AssetState::Missing));
}
#[test]
fn unknown_source_and_display_strings_retain_exact_bytes_in_checkpoint_and_export_recovery() {
    let mut a = descriptor();
    a.metadata.filename = "עברית 😀.pdf".into();
    a.metadata.alt = "unknown\nalt".into();
    let mut d = blank();
    insert(&mut d, &a);
    let restored = Document::restore(d.identity(), &d.checkpoint(), &[]).unwrap();
    assert_eq!(attrs(&restored), tuple(&a));
    let f = d.fragment_for_node(&asset_id(&d)).unwrap();
    let exported = editac_markdown::export::export(&[f]);
    assert!(
        exported
            .diagnostics
            .iter()
            .any(|d| d.code == "asset-binary-unavailable")
    );
    assert!(!exported.markdown.contains("<script>"));
    assert!(!exported.markdown.contains("![asset]"));
    assert_eq!(
        exported.recovery[0].attributes.as_ref().unwrap().tuple(),
        tuple(&a)
    );
    let imported = editac_markdown::import::import(&exported.markdown).unwrap();
    assert!(
        imported
            .blocks
            .iter()
            .all(|b| !matches!(b.attributes, Some(BlockAttributes::Unknown(_))))
    );
}
#[test]
fn url_and_credential_shaped_identities_reject() {
    for bad in [
        "blob:local/id",
        "https://host/key?sig=secret",
        "http://user:pass@host",
        "data:secret",
        "bearer secret",
        "../key",
        "key?token=secret",
        "id%2fkey",
        "id\n",
        "id😀",
    ] {
        for host in [true, false] {
            let mut a = descriptor();
            if host {
                a.identity.host = bad.into()
            } else {
                a.identity.key = bad.into()
            };
            assert!(a.validate().is_err(), "{bad}");
        }
    }
}
#[test]
fn metadata_shapes_versions_unknown_fields_and_private_access_fields_reject() {
    let mutations: Vec<fn(&mut Value)> = vec![
        |v| v[1] = json!(2),
        |v| v[2]["identity"]["url"] = json!("blob:x"),
        |v| v[2]["identity"]["credentials"] = json!("secret"),
        |v| v[2]["downloadUrl"] = json!("https://host?sig=x"),
        |v| v[2]["metadata"]["byteLength"] = json!(-1),
        |v| v[2]["metadata"]["byteLength"] = json!(1.5),
        |v| v[2]["metadata"]["width"] = json!(100),
        |v| v[2]["kind"] = json!("future"),
        |v| v[2]["metadata"]["filename"] = json!("../file"),
        |v| v[2]["metadata"]["filename"] = json!("a\u{0}.pdf"),
        |v| v[2]["metadata"]["mediaType"] = json!("image/png;token=x"),
        |v| v[2]["metadata"]["sha256"] = json!("bad"),
        |v| v[2]["fallback"] = json!(""),
        |v| v[2]["source"] = json!(false),
        |v| v[2]["metadata"]["unknown"] = json!(0),
        |v| v[2]["state"] = json!("available"),
    ];
    for mutate in mutations {
        let mut v = json!(["module:editac.asset", 1, descriptor()]);
        mutate(&mut v);
        assert!(Content::from_tuple(&any(&v)).is_err(), "{v}");
    }
}
#[test]
fn bounds_and_cross_kind_policies_apply_to_typed_and_tuple_entry() {
    let mutations: Vec<fn(&mut AssetDescriptor)> = vec![
        |a| a.identity.host = "x".repeat(65),
        |a| a.identity.key = "x".repeat(257),
        |a| a.metadata.filename = "x".repeat(1025),
        |a| a.metadata.media_type = "x".repeat(128),
        |a| a.metadata.byte_length = Some(MAX_ASSET_BYTES + 1),
        |a| a.metadata.alt = "x".repeat(8193),
        |a| a.metadata.caption = "x".repeat(8193),
        |a| a.fallback = "😀".repeat(4097),
        |a| a.source = "x".repeat(MAX_SOURCE_BYTES + 1),
        |a| a.metadata.duration_ms = Some(1),
        |a| {
            a.metadata.width = Some(1);
            a.metadata.height = Some(1)
        },
        |a| {
            a.kind = AssetKind::Image;
            a.metadata.media_type = "image/png".into();
            a.metadata.width = Some(0);
            a.metadata.height = Some(1)
        },
        |a| {
            a.kind = AssetKind::Image;
            a.metadata.media_type = "image/png".into();
            a.metadata.width = Some(1_000_001);
            a.metadata.height = Some(1)
        },
        |a| a.kind = AssetKind::Image,
        |a| a.kind = AssetKind::Media,
    ];
    for mutate in mutations {
        let mut a = descriptor();
        mutate(&mut a);
        assert!(a.validate().is_err());
        assert!(Content::from_tuple(&any(&json!(["module:editac.asset", 1, a]))).is_err());
    }
    let mut a = descriptor();
    a.identity.host = "a".repeat(64);
    a.identity.key = "a".repeat(256);
    a.metadata.filename = "a".repeat(1024);
    a.metadata.byte_length = Some(MAX_ASSET_BYTES);
    a.metadata.alt = "a".repeat(8192);
    a.metadata.caption = "a".repeat(8192);
    a.fallback = "😀".repeat(4096);
    a.source = "a".repeat(MAX_SOURCE_BYTES);
    assert!(a.validate().is_ok());
    assert!(Content::from_tuple(&tuple(&a)).is_ok());
}
#[test]
fn deeply_nested_and_non_json_asset_data_reject_before_conversion() {
    let mut v = json!(null);
    for _ in 0..20 {
        v = json!([v]);
    }
    let mut t = json!(["module:editac.asset", 1, descriptor()]);
    t[2]["source"] = v;
    assert!(Content::from_tuple(&any(&t)).is_err());
    let t = Any::Array(
        vec![
            Any::from("module:editac.asset"),
            Any::from(1u32),
            Any::Map(std::sync::Arc::new(std::collections::HashMap::from([(
                "bad".into(),
                Any::Buffer(vec![1u8].into()),
            )]))),
        ]
        .into(),
    );
    assert!(Content::from_tuple(&t).is_err());
}
fn atomic(d: &Document, asset: AssetDescriptor) -> EditorCommand {
    let id = asset_id(d);
    EditorCommand::AtomicContent {
        target: id.clone(),
        expected: attrs(d),
        at: d.anchor(&id, Utf16Offset(0), Bias::Right).unwrap(),
        replacement: Some(content(asset)),
    }
}
#[test]
fn replacement_is_one_history_group_preserving_owner_and_exact_source_with_real_replay() {
    let mut d = engine();
    d.enable_history(HistoryConfig::default()).unwrap();
    let before = d.checkpoint();
    let mut peer = Document::restore(d.identity(), &before, &[]).unwrap();
    let id = asset_id(&d);
    let mut a = descriptor();
    a.metadata.filename = "new.pdf".into();
    a.fallback = "new fallback 😀".into();
    let p = d
        .prepare_editor(&[atomic(&d, a.clone())], &origin())
        .unwrap();
    assert_eq!(d.checkpoint().bytes, before.bytes);
    let update = d.commit_editor(p).unwrap().update;
    peer.apply_replay(&update).unwrap();
    assert_eq!(attrs(&peer), tuple(&a));
    assert_eq!(
        peer.snapshot().unwrap().visible,
        d.snapshot().unwrap().visible
    );
    assert_eq!(d.history_state().undo_groups, 1);
    assert!(d.snapshot().unwrap().visible.iter().any(|n| n.id == id));
    d.undo().unwrap().unwrap();
    assert_eq!(attrs(&d), tuple(&descriptor()));
    d.redo().unwrap().unwrap();
    assert_eq!(attrs(&d), tuple(&a));
}
#[test]
fn invalid_late_command_and_stale_expected_tuple_have_zero_effects() {
    let mut d = engine();
    d.enable_history(HistoryConfig::default()).unwrap();
    let before = d.checkpoint().bytes;
    let mut good = descriptor();
    good.fallback = "valid".into();
    let c = atomic(&d, good.clone());
    let mut bad = good;
    bad.identity.key = "blob:temp".into();
    let mut second = atomic(&d, bad);
    if let EditorCommand::AtomicContent { expected, .. } = &mut second {
        *expected = if let EditorCommand::AtomicContent {
            replacement: Some(a),
            ..
        } = &c
        {
            a.tuple().unwrap()
        } else {
            panic!()
        };
    }
    assert!(d.prepare_editor(&[c, second], &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, before);
    assert_eq!(d.history_state().undo_groups, 0);
    let mut stale = atomic(&d, descriptor());
    if let EditorCommand::AtomicContent { expected, .. } = &mut stale {
        *expected = Any::Null;
    }
    assert!(d.prepare_editor(&[stale], &origin()).is_err());
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn direct_conversion_and_fragment_fallback_mismatch_reject_atomically() {
    let d = blank();
    let before = d.checkpoint().bytes;
    let id = d.snapshot().unwrap().visible[0].id.clone();
    assert!(
        d.prepare_editor(
            &[EditorCommand::Content {
                target: id.clone(),
                content: content(descriptor())
            }],
            &origin()
        )
        .is_err()
    );
    let mut b = block(&descriptor());
    b.runs[0].text = "wrong".into();
    let a = d.anchor(&id, Utf16Offset(0), Bias::Right).unwrap();
    assert!(
        d.prepare_fragment(
            &editac_core::anchors::Selection {
                anchor: a.clone(),
                focus: a
            },
            &[b],
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
}
#[test]
fn all_host_actions_require_explicit_identity_scoped_grants() {
    for action in [
        AssetAction::Authorize,
        AssetAction::Ingest,
        AssetAction::Read,
        AssetAction::Cache,
        AssetAction::Publish,
        AssetAction::ResolveUrl,
        AssetAction::Cancel,
        AssetAction::ReleaseReference,
        AssetAction::Open,
        AssetAction::Download,
    ] {
        let r = request(action);
        assert!(r.validate(&grant(&r.identity, vec![action])).is_ok());
        assert!(r.validate(&grant(&r.identity, vec![])).is_err());
        let mut g = grant(&r.identity, vec![action]);
        g.identity.key = "other".into();
        assert!(r.validate(&g).is_err());
        assert!(
            r.validate(&grant(&r.identity, vec![action, action]))
                .is_err()
        );
        assert_eq!(
            serde_json::from_str::<AssetRequest>(&serde_json::to_string(&r).unwrap()).unwrap(),
            r
        );
    }
}
#[test]
fn malformed_host_requests_and_publication_receipts_reject() {
    let r = request(AssetAction::Publish);
    let g = grant(&r.identity, vec![r.action]);
    let mut receipt = AssetCommitReceipt {
        operation_id: r.operation_id.clone(),
        identity: r.identity.clone(),
    };
    assert!(receipt.validate_for(&r, &g).is_ok());
    receipt.operation_id = "stale".into();
    assert!(receipt.validate_for(&r, &g).is_err());
    receipt.operation_id = r.operation_id.clone();
    receipt.identity.key = "other".into();
    assert!(receipt.validate_for(&r, &g).is_err());
    for mutate in [
        |r: &mut AssetRequest| r.version = 2,
        |r: &mut AssetRequest| r.byte_limit = 0,
        |r: &mut AssetRequest| r.operation_id = "https://token".into(),
        |r: &mut AssetRequest| r.byte_limit = MAX_ASSET_BYTES + 1,
    ] {
        let mut bad = r.clone();
        mutate(&mut bad);
        assert!(bad.validate(&g).is_err());
    }
}
#[test]
fn temporary_urls_are_only_ephemeral_scoped_host_results() {
    let r = request(AssetAction::ResolveUrl);
    let g = grant(&r.identity, vec![r.action]);
    let mut result = ResolvedAssetUrl {
        operation_id: r.operation_id.clone(),
        identity: r.identity.clone(),
        url: "https://host.invalid/object?signature=prepared".into(),
    };
    assert!(result.validate_for(&r, &g).is_ok());
    for url in [
        "blob:https://host.invalid/uuid",
        "https://host.invalid/object?expires=1",
    ] {
        result.url = url.into();
        assert!(result.validate_for(&r, &g).is_ok());
    }
    for url in [
        "javascript:alert(1)",
        "data:text/html,unsafe",
        "https://user:pass@host.invalid/object",
        "http://host.invalid/object",
    ] {
        result.url = url.into();
        assert!(result.validate_for(&r, &g).is_err());
    }
    result.url = "https://host.invalid/object".into();
    result.operation_id = "stale".into();
    assert!(result.validate_for(&r, &g).is_err());
}

#[test]
fn existing_portable_fragment_interchange_admits_assets_and_rejects_fallback_spoofing() {
    let b = block(&descriptor());
    let wire = editac_core::interchange::transfer_value(&b);
    let envelope = json!({"version":1,"schema":"asset-fixture-v1","blocks":[wire.clone()]});
    assert_eq!(
        editac_core::clipboard::validate(&envelope.to_string(), "asset-fixture-v1"),
        Ok(())
    );
    let parsed: Vec<editac_core::interchange::TransferBlock> =
        serde_json::from_value(json!([wire])).unwrap();
    let blocks = editac_core::interchange::transfer_blocks(parsed).unwrap();
    assert_eq!(
        blocks[0].attributes.as_ref().unwrap().tuple(),
        tuple(&descriptor())
    );
    let d = blank();
    let id = d.snapshot().unwrap().visible[0].id.clone();
    let a = d.anchor(&id, Utf16Offset(0), Bias::Right).unwrap();
    let mut blocks = blocks;
    blocks[0].runs[0].text = "spoof".into();
    let before = d.checkpoint().bytes;
    assert!(
        d.prepare_fragment(
            &editac_core::anchors::Selection {
                anchor: a.clone(),
                focus: a
            },
            &blocks,
            &origin()
        )
        .is_err()
    );
    assert_eq!(d.checkpoint().bytes, before);
}
