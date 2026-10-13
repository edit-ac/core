use editac_core::{
    document::{
        BLOCK_ATTRIBUTES, BlockAttributes, Document, DocumentIdentity, InitializedCheckpoint, ROOTS,
    },
    projection::Snapshot,
};
use editac_diff::{representation::*, semantic::*};
use serde_json::{Value, json};
use std::collections::HashMap;
use yrs::{Any, Map, Out, ReadTxn, StateVector, Text, Transact, XmlTextPrelim};

fn scope() -> RevisionScope {
    RevisionScope {
        document: "fixture".into(),
        epoch: "epoch".into(),
        schema: "v2".into(),
        module_profile: "task".into(),
        observed_token: [1; 65],
    }
}
fn fixture(name: &str) -> SemanticSnapshot {
    serde_json::from_str(match name {
        "before" => include_str!("../../../fixtures/diff/semantic-before.json"),
        "format" => include_str!("../../../fixtures/diff/semantic-format.json"),
        "move" => include_str!("../../../fixtures/diff/semantic-move.json"),
        "delete" => include_str!("../../../fixtures/diff/semantic-delete.json"),
        _ => panic!("fixture"),
    })
    .unwrap()
}
fn capture(s: &SemanticSnapshot) -> ImmutableRevision {
    ImmutableRevision::capture(
        scope(),
        RevisionInput::Semantic(s),
        RepresentationLimits::default(),
    )
    .unwrap()
}
fn diff(a: &SemanticSnapshot, b: &SemanticSnapshot) -> SemanticDiff {
    compare(&capture(a), &capture(b), SemanticLimits::default()).unwrap()
}
fn change<'a>(d: &'a SemanticDiff, id: &str) -> &'a NodeChange {
    d.changes.iter().find(|n| n.id == id).unwrap()
}
fn real_doc() -> yrs::Doc {
    let d = editac_core::new_document();
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
fn real_projection_move_keeps_simultaneous_text_link_and_opaque_mark_changes() {
    let d = real_doc();
    let before = real_capture(&d);
    {
        let mut t = d.transact_mut();
        t.get_map(ROOTS[2]).unwrap().insert(
            &mut t,
            "block-1",
            Any::Array(vec![Any::from("@root"), Any::from(2)].into()),
        );
        let Some(Out::YXmlText(text)) = t.get_map(ROOTS[1]).unwrap().get(&t, "block-1") else {
            panic!("text")
        };
        text.insert(&mut t, 0, "new ");
        text.format(
            &mut t,
            0,
            3,
            HashMap::from([
                ("link".into(), Any::from("https://example.org/new")),
                (
                    "ext:opaque".into(),
                    Any::from_json(r#"{"color":"blue"}"#).unwrap(),
                ),
            ]),
        );
    }
    let after = real_capture(&d);
    let model = compare(&before, &after, SemanticLimits::default()).unwrap();
    let node = change(&model, "block-1");
    for facet in [
        Facet::Placement,
        Facet::Text,
        Facet::Formatting,
        Facet::References,
        Facet::Sources,
    ] {
        assert!(node.facets.contains(&facet), "{facet:?}");
    }
    assert_eq!(
        node.before.as_ref().unwrap().id,
        node.after.as_ref().unwrap().id
    );
    assert_eq!(model.attribution, "unknown");
    assert_eq!(model.before_hash, before.hash().hex());
}
#[test]
fn real_projection_retains_unknown_block_tuple_and_container_independently() {
    let d = real_doc();
    let a = real_capture(&d);
    // Set an inert module tuple through a real Yrs update.
    {
        let mut t = d.transact_mut();
        t.get_map(BLOCK_ATTRIBUTES).unwrap().insert(
            &mut t,
            "block-1",
            Any::from_json(r#"["module:future.widget",7,{"retained":"yes"}]"#).unwrap(),
        );
    }
    let b = real_capture(&d);
    let m = compare(&a, &b, SemanticLimits::default()).unwrap();
    let n = change(&m, "block-1");
    assert!(n.facets.contains(&Facet::Attributes));
    assert!(n.facets.contains(&Facet::UnknownModule));
    assert_eq!(
        n.after.as_ref().unwrap().attributes,
        json!(["module:future.widget",7.0,{"retained":"yes"}])
    );
}
#[test]
fn literal_format_only_is_not_text() {
    let d = diff(&fixture("before"), &fixture("format"));
    assert!(
        d.changes
            .iter()
            .any(|c| c.facets.contains(&Facet::Formatting))
    );
    assert!(!d.changes.iter().any(|c| c.facets.contains(&Facet::Text)));
}
#[test]
fn literal_move_is_not_delete_insert() {
    let d = diff(&fixture("before"), &fixture("move"));
    assert!(
        d.changes
            .iter()
            .any(|c| c.facets.contains(&Facet::Placement))
    );
    assert!(
        !d.changes
            .iter()
            .any(|c| c.facets.contains(&Facet::Insert) || c.facets.contains(&Facet::Delete))
    );
}
#[test]
fn literal_deletion_retains_before_payload() {
    let d = diff(&fixture("before"), &fixture("delete"));
    let c = d
        .changes
        .iter()
        .find(|c| c.facets == [Facet::Delete])
        .unwrap();
    assert!(c.before.is_some());
    assert!(c.after.is_none());
}
#[test]
fn insertion_retains_after_payload() {
    let a = fixture("delete");
    let b = fixture("before");
    let d = diff(&a, &b);
    assert!(
        d.changes
            .iter()
            .any(|c| c.facets == [Facet::Insert] && c.after.is_some() && c.before.is_none())
    );
}
#[test]
fn link_target_only_has_reference_facet() {
    let mut a = fixture("before");
    a.visible[0].runs[0].marks = json!({"link":"https://example.org/a"});
    let mut b = a.clone();
    b.visible[0].runs[0].marks = json!({"link":"https://example.org/b"});
    assert_eq!(change(&diff(&a, &b), "a").facets, [Facet::References]);
}
#[test]
fn unknown_mark_only_has_formatting_facet() {
    let a = fixture("before");
    let mut b = a.clone();
    b.visible[0].runs[0].marks = json!({"future:mark":{"x":[1,2]}});
    assert_eq!(change(&diff(&a, &b), "a").facets, [Facet::Formatting]);
}
#[test]
fn run_segmentation_is_not_a_formatting_change() {
    let mut a = fixture("before");
    a.visible[0].runs = vec![SemanticRun {
        text: "😀ab".into(),
        marks: json!({"bold":true,"link":"https://example.org"}),
    }];
    let mut b = a.clone();
    b.visible[0].runs = vec![
        SemanticRun {
            text: "😀".into(),
            marks: a.visible[0].runs[0].marks.clone(),
        },
        SemanticRun {
            text: "ab".into(),
            marks: a.visible[0].runs[0].marks.clone(),
        },
    ];
    assert!(diff(&a, &b).changes.is_empty());
}
#[test]
fn mark_range_changes_use_utf16_and_remain_visible() {
    let mut a = fixture("before");
    a.visible[0].runs = vec![
        SemanticRun {
            text: "😀".into(),
            marks: json!({"bold":true}),
        },
        SemanticRun {
            text: "a".into(),
            marks: json!({}),
        },
    ];
    let mut b = a.clone();
    b.visible[0].runs[0].marks = json!({});
    b.visible[0].runs[1].marks = json!({"bold":true});
    assert_eq!(change(&diff(&a, &b), "a").facets, [Facet::Formatting]);
}
#[test]
fn reference_module_target_only_is_separate() {
    let mut a = fixture("before");
    a.visible[0].attributes = json!(["module:editac.reference",1,{"targetId":"a","label":"same"}]);
    let mut b = a.clone();
    b.visible[0].attributes[2]["targetId"] = json!("b");
    assert_eq!(
        change(&diff(&a, &b), "a").facets,
        [Facet::References, Facet::Attributes]
    );
}
#[test]
fn table_structure_and_cell_content_are_separate() {
    let mut a = fixture("before");
    a.visible[0].attributes = json!(["module:editac.table",1,{"rows":[[[["cell",[]]]]],"alignments":["none"],"source":""}]);
    let mut b = a.clone();
    b.visible[0].attributes[2]["rows"] = json!([[[["changed", []]]], [[["new row", []]]]]);
    assert_eq!(
        change(&diff(&a, &b), "a").facets,
        [Facet::Text, Facet::Table, Facet::Attributes]
    );
}
#[test]
fn opaque_node_payload_cannot_be_normalized_away() {
    let a = fixture("before");
    let mut b = a.clone();
    b.visible[0].opaque = json!(["future",{"spell":"exact"}]);
    assert_eq!(change(&diff(&a, &b), "a").facets, [Facet::UnknownModule]);
}
#[test]
fn recovery_visibility_keeps_same_identity() {
    let a = fixture("before");
    let mut b = a.clone();
    let n = b.visible.remove(0);
    b.recovery.push(n);
    assert_eq!(change(&diff(&a, &b), "a").facets, [Facet::Visibility]);
}
#[test]
fn retained_structure_changes_without_visible_edits_are_explicit() {
    let a = fixture("before");
    let mut b = a.clone();
    b.retained_structure = json!({"unknown":["tombstone",1]});
    let d = diff(&a, &b);
    assert!(d.changes.is_empty());
    assert_eq!(
        d.retained_structure,
        Some((a.retained_structure, b.retained_structure))
    );
}
#[test]
fn kind_and_editor_metadata_are_independent() {
    let a = fixture("before");
    let mut b = a.clone();
    b.visible[0].kind = "future-kind".into();
    b.visible[0].editor = json!({"checked":true});
    assert_eq!(
        change(&diff(&a, &b), "a").facets,
        [Facet::Kind, Facet::Formatting]
    );
}
#[test]
fn source_identity_changes_do_not_claim_an_author() {
    let a = fixture("before");
    let mut b = a.clone();
    b.visible[0].spans[0].identity = "new-shared-type".into();
    let d = diff(&a, &b);
    assert_eq!(change(&d, "a").facets, [Facet::Sources]);
    assert_eq!(d.attribution, "unknown");
}
#[test]
fn output_is_deterministic_sorted_and_versioned() {
    let a = fixture("before");
    let mut b = a.clone();
    for n in &mut b.visible {
        n.parent = "other".into();
        n.runs[0].text.push('!');
    }
    let d = diff(&a, &b);
    let bytes = serde_json::to_vec(&d).unwrap();
    assert_eq!(bytes, serde_json::to_vec(&diff(&a, &b)).unwrap());
    let restored: SemanticDiff = serde_json::from_slice(&bytes).unwrap();
    assert!(restored == d);
    assert_eq!(d.version, MODEL_VERSION);
    assert!(d.changes.windows(2).all(|w| w[0].id < w[1].id));
}
#[test]
fn incompatible_scopes_reject_even_when_bytes_match() {
    let a = capture(&fixture("before"));
    for field in 0..4 {
        let mut s = scope();
        match field {
            0 => s.document.push('x'),
            1 => s.epoch.push('x'),
            2 => s.schema.push('x'),
            _ => s.module_profile.push('x'),
        };
        let b = ImmutableRevision::capture(
            s,
            RevisionInput::Semantic(&fixture("before")),
            RepresentationLimits::default(),
        )
        .unwrap();
        assert!(matches!(
            compare(&a, &b, SemanticLimits::default()),
            Err(RepresentationError::IncompatibleScope)
        ));
    }
}
#[test]
fn source_or_transport_never_becomes_semantic_diff() {
    let a = ImmutableRevision::capture(
        scope(),
        RevisionInput::ExactSource(b"source"),
        RepresentationLimits::default(),
    )
    .unwrap();
    assert!(matches!(
        compare(&a, &a, SemanticLimits::default()),
        Err(RepresentationError::IncompatibleRepresentation)
    ));
}
#[test]
fn tighter_node_byte_depth_and_output_limits_reject_atomically() {
    let a = capture(&fixture("before"));
    let b = capture(&fixture("format"));
    for mode in 0..5 {
        let mut l = SemanticLimits::default();
        match mode {
            0 => l.input.max_nodes = 0,
            1 => l.input.max_bytes = 16,
            2 => l.input.max_depth = 0,
            3 => l.max_changes = 0,
            _ => l.max_output_bytes = 16,
        };
        assert!(matches!(
            compare(&a, &b, l),
            Err(RepresentationError::ResourceLimit)
        ));
    }
    assert!(compare(&a, &b, SemanticLimits::default()).is_ok());
}
#[test]
fn projection_capture_bounds_before_clone_and_rejects_non_json_values() {
    let d = real_doc();
    let mut p = engine_snapshot(&d);
    let mut l = RepresentationLimits::default();
    l.max_nodes = 0;
    assert!(matches!(
        capture_projection(scope(), &p, l),
        Err(RepresentationError::ResourceLimit)
    ));
    let node = std::sync::Arc::make_mut(&mut p.visible[0]);
    node.runs[0].attributes.insert("bad".into(), Any::Undefined);
    assert!(matches!(
        capture_projection(scope(), &p, RepresentationLimits::default()),
        Err(RepresentationError::InvalidSemantic)
    ));
}
#[test]
fn duplicate_ids_reject_at_capture() {
    let mut s = fixture("before");
    s.recovery.push(s.visible[0].clone());
    assert!(matches!(
        ImmutableRevision::capture(
            scope(),
            RevisionInput::Semantic(&s),
            RepresentationLimits::default()
        ),
        Err(RepresentationError::InvalidSemantic)
    ));
}
#[test]
fn changed_observation_token_is_compatible_not_a_causal_order() {
    let s = fixture("before");
    let a = capture(&s);
    let mut scope = scope();
    scope.observed_token[64] = 2;
    let b = ImmutableRevision::capture(
        scope,
        RevisionInput::Semantic(&s),
        RepresentationLimits::default(),
    )
    .unwrap();
    assert!(
        compare(&a, &b, SemanticLimits::default())
            .unwrap()
            .changes
            .is_empty()
    );
}
#[test]
fn empty_revisions_have_no_changes() {
    let s = SemanticSnapshot {
        visible: vec![],
        recovery: vec![],
        retained_structure: Value::Null,
    };
    assert!(diff(&s, &s).changes.is_empty());
}
#[test]
fn table_cell_mark_and_link_changes_have_separate_facets() {
    let mut a = fixture("before");
    a.visible[0].attributes = json!(["module:editac.table",1,{"rows":[[[["cell",[["bold"],["link","https://example.org/a"]]]]]],"alignments":["none"],"source":""}]);
    let mut b = a.clone();
    b.visible[0].attributes[2]["rows"] =
        json!([[[["cell", [["italic"], ["link", "https://example.org/b"]]]]]]);
    assert_eq!(
        change(&diff(&a, &b), "a").facets,
        [
            Facet::Formatting,
            Facet::References,
            Facet::Table,
            Facet::Attributes
        ]
    );
}
#[test]
fn real_reference_and_table_tuples_survive_projection_and_changes() {
    let d = real_doc();
    let set = |id: &str, value: &str| {
        let mut t = d.transact_mut();
        t.get_map(BLOCK_ATTRIBUTES)
            .unwrap()
            .insert(&mut t, id, Any::from_json(value).unwrap());
    };
    set(
        "block-1",
        r#"["module:editac.reference",1,{"targetId":"old","label":"same"}]"#,
    );
    set(
        "block-2",
        r#"["module:editac.table",1,{"alignments":["none"],"rows":[[[["cell",[]]]]],"source":""}]"#,
    );
    let before = real_capture(&d);
    set(
        "block-1",
        r#"["module:editac.reference",1,{"targetId":"new","label":"same"}]"#,
    );
    set(
        "block-2",
        r#"["module:editac.table",1,{"alignments":["none"],"rows":[[[["cell",[["bold"],["link","https://example.org"]]]]]],"source":""}]"#,
    );
    let model = compare(&before, &real_capture(&d), SemanticLimits::default()).unwrap();
    assert_eq!(
        change(&model, "block-1").facets,
        [Facet::References, Facet::Attributes]
    );
    assert_eq!(
        change(&model, "block-2").facets,
        [
            Facet::Formatting,
            Facet::References,
            Facet::Table,
            Facet::Attributes
        ]
    );
}
#[test]
fn bounded_large_projection_is_deterministic() {
    let mut s = fixture("before");
    let template = s.visible[0].clone();
    s.visible.clear();
    for i in 0..2000 {
        let mut n = template.clone();
        n.id = format!("block-{i:04}");
        n.order = i;
        s.visible.push(n);
    }
    let mut changed = s.clone();
    changed.visible[1000].order = 1999;
    changed.visible[1000].runs[0].text = "changed".into();
    let model = diff(&s, &changed);
    assert_eq!(model.changes.len(), 1);
    assert!(model.changes[0].facets.contains(&Facet::Placement));
    assert!(model.changes[0].facets.contains(&Facet::Text));
    assert_eq!(
        serde_json::to_vec(&model).unwrap(),
        serde_json::to_vec(&diff(&s, &changed)).unwrap()
    );
}
