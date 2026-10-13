use editac_diff::representation::*;
use serde_json::{Value, json};

const GOLDENS: &str = include_str!("../../../fixtures/diff/goldens.json");
fn scope() -> RevisionScope {
    let mut token = [0; 65];
    token[0] = 1;
    RevisionScope {
        document: "doc-1".into(),
        epoch: "epoch-1".into(),
        schema: "editac-v5".into(),
        module_profile: "task-v1".into(),
        observed_token: token,
    }
}
fn capture(input: RevisionInput<'_>) -> ImmutableRevision {
    ImmutableRevision::capture(scope(), input, RepresentationLimits::default()).unwrap()
}
fn semantic(name: &str) -> SemanticSnapshot {
    serde_json::from_str(match name {
        "before" => include_str!("../../../fixtures/diff/semantic-before.json"),
        "format" => include_str!("../../../fixtures/diff/semantic-format.json"),
        "move" => include_str!("../../../fixtures/diff/semantic-move.json"),
        "delete" => include_str!("../../../fixtures/diff/semantic-delete.json"),
        _ => panic!("unknown fixture"),
    })
    .unwrap()
}
fn golden(name: &str, revision: &ImmutableRevision) {
    let expected: Value = serde_json::from_str(GOLDENS).unwrap();
    assert_eq!(
        revision.hash().hex(),
        expected[name]["sha256"].as_str().unwrap()
    );
    assert_eq!(
        revision.bytes().len() as u64,
        expected[name]["bytes"].as_u64().unwrap()
    );
}
#[test]
fn literal_source_round_trips_all_newlines_unicode_and_hashes() {
    for (name, bytes) in [
        (
            "format-before.md",
            &include_bytes!("../../../fixtures/diff/format-before.md")[..],
        ),
        (
            "format-after.md",
            &include_bytes!("../../../fixtures/diff/format-after.md")[..],
        ),
        (
            "delete-before.md",
            &include_bytes!("../../../fixtures/diff/delete-before.md")[..],
        ),
        (
            "delete-after.md",
            &include_bytes!("../../../fixtures/diff/delete-after.md")[..],
        ),
        (
            "crlf.md",
            &include_bytes!("../../../fixtures/diff/crlf.md")[..],
        ),
        ("lf.md", &include_bytes!("../../../fixtures/diff/lf.md")[..]),
        (
            "no-final-newline.md",
            &include_bytes!("../../../fixtures/diff/no-final-newline.md")[..],
        ),
        (
            "unicode.md",
            &include_bytes!("../../../fixtures/diff/unicode.md")[..],
        ),
    ] {
        let revision = capture(RevisionInput::ExactSource(bytes));
        assert_eq!(revision.bytes(), bytes);
        golden(name, &revision);
        assert_eq!(revision.representation(), &Representation::ExactSourceUtf8);
    }
}
#[test]
fn source_spelling_is_distinct_from_normalized_markdown() {
    let before = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/format-before.md"
    )));
    let after = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/format-after.md"
    )));
    assert_eq!(before.content_changed(&after), Ok(true));
    let projected = capture(RevisionInput::ProjectedMarkdown {
        bytes: b"**bold**\n",
        serializer: "editac-markdown-v1",
        dialect: "commonmark-v1",
    });
    assert_eq!(projected.hash(), before.hash());
    assert_eq!(
        projected.content_changed(&before),
        Err(RepresentationError::IncompatibleRepresentation)
    );
    assert!(projected.representation().label().contains("normalized"));
    assert_eq!(projected.content_changed(&projected), Ok(false));
}
#[test]
fn format_only_semantic_edits_retain_content_and_change_hash() {
    let before = semantic("before");
    let after = semantic("format");
    assert_eq!(
        before.visible[0].runs[0].text,
        after.visible[0].runs[0].text
    );
    assert_ne!(
        before.visible[0].runs[0].marks,
        after.visible[0].runs[0].marks
    );
    let a = capture(RevisionInput::Semantic(&before));
    let b = capture(RevisionInput::Semantic(&after));
    golden("semantic-before.json", &a);
    golden("semantic-format.json", &b);
    assert_eq!(a.content_changed(&b), Ok(true));
}
#[test]
fn structural_moves_keep_stable_ids_and_content() {
    let before = semantic("before");
    let after = semantic("move");
    for old in &before.visible {
        let moved = after.visible.iter().find(|n| n.id == old.id).unwrap();
        assert_eq!(old.runs, moved.runs);
        assert_ne!(old.order, moved.order);
    }
    let a = capture(RevisionInput::Semantic(&before));
    let b = capture(RevisionInput::Semantic(&after));
    golden("semantic-move.json", &b);
    assert_eq!(a.content_changed(&b), Ok(true));
}
#[test]
fn deletion_only_changes_affect_source_and_semantic_hashes() {
    let before = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/delete-before.md"
    )));
    let after = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/delete-after.md"
    )));
    assert_eq!(before.content_changed(&after), Ok(true));
    let a = capture(RevisionInput::Semantic(&semantic("before")));
    let b = capture(RevisionInput::Semantic(&semantic("delete")));
    golden("semantic-delete.json", &b);
    assert_eq!(a.content_changed(&b), Ok(true));
}
#[test]
fn crlf_and_final_newline_are_not_normalized() {
    let crlf = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/crlf.md"
    )));
    let lf = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/lf.md"
    )));
    let no_final = capture(RevisionInput::ExactSource(include_bytes!(
        "../../../fixtures/diff/no-final-newline.md"
    )));
    assert_eq!(crlf.content_changed(&lf), Ok(true));
    assert_eq!(lf.content_changed(&no_final), Ok(true));
}
#[test]
fn transport_is_never_labeled_source_even_when_valid_utf8() {
    for bytes in [&b"\0\0"[..], &b"valid utf8 transport"[..]] {
        assert_eq!(
            ImmutableRevision::capture(
                scope(),
                RevisionInput::CrdtUpdate(bytes),
                RepresentationLimits::default()
            )
            .unwrap_err(),
            RepresentationError::InternalTransport
        );
    }
}
#[test]
fn invalid_utf8_binary_and_decode_limits_are_diagnostics() {
    for (bytes, expected) in [
        (&b"\xff"[..], RepresentationError::InvalidUtf8),
        (&b"a\0b"[..], RepresentationError::BinarySource),
    ] {
        assert_eq!(
            ImmutableRevision::capture(
                scope(),
                RevisionInput::ExactSource(bytes),
                RepresentationLimits::default()
            )
            .unwrap_err(),
            expected
        );
    }
    let limits = RepresentationLimits {
        max_bytes: 2,
        ..Default::default()
    };
    assert_eq!(
        ImmutableRevision::capture(scope(), RevisionInput::ExactSource(b"abc"), limits)
            .unwrap_err(),
        RepresentationError::ResourceLimit
    );
    assert!(ImmutableRevision::capture(scope(), RevisionInput::ExactSource(b"ab"), limits).is_ok());
}
#[test]
fn revision_scope_and_serializer_profile_are_checked() {
    let a = capture(RevisionInput::ExactSource(b"same"));
    for field in ["document", "epoch", "schema", "profile"] {
        let mut changed = scope();
        match field {
            "document" => changed.document.push('2'),
            "epoch" => changed.epoch.push('2'),
            "schema" => changed.schema.push('2'),
            _ => changed.module_profile.push('2'),
        }
        let b = ImmutableRevision::capture(
            changed,
            RevisionInput::ExactSource(b"same"),
            Default::default(),
        )
        .unwrap();
        assert_eq!(
            a.content_changed(&b),
            Err(RepresentationError::IncompatibleScope)
        );
    }
    let mut changed = scope();
    changed.observed_token[33] = 1;
    let b = ImmutableRevision::capture(
        changed,
        RevisionInput::ExactSource(b"same"),
        Default::default(),
    )
    .unwrap();
    assert_ne!(a.scope(), b.scope());
    assert_eq!(a.content_changed(&b), Ok(false));
    let a = capture(RevisionInput::ProjectedMarkdown {
        bytes: b"same",
        serializer: "v1",
        dialect: "d1",
    });
    for (serializer, dialect) in [("v2", "d1"), ("v1", "d2")] {
        let b = capture(RevisionInput::ProjectedMarkdown {
            bytes: b"same",
            serializer,
            dialect,
        });
        assert_eq!(
            a.content_changed(&b),
            Err(RepresentationError::IncompatibleRepresentation)
        );
    }
    assert_eq!(
        ImmutableRevision::capture(
            scope(),
            RevisionInput::ProjectedMarkdown {
                bytes: b"",
                serializer: "",
                dialect: "d1"
            },
            Default::default()
        )
        .unwrap_err(),
        RepresentationError::InvalidProfile
    );
    let mut bad = scope();
    bad.observed_token[0] = 2;
    assert_eq!(
        ImmutableRevision::capture(bad, RevisionInput::ExactSource(b""), Default::default())
            .unwrap_err(),
        RepresentationError::InvalidScope
    );
}
#[test]
fn opaque_attributes_link_targets_and_recovery_content_remain_visible() {
    let before = semantic("before");
    let base = capture(RevisionInput::Semantic(&before));
    for field in [
        "opaque",
        "link",
        "attributes",
        "editor",
        "span",
        "recovery",
        "retained",
    ] {
        let mut changed = before.clone();
        match field {
            "opaque" => {
                changed.visible[0].opaque = json!(["unknown-module-v1", {"secret-attribute": 3}])
            }
            "link" => changed.visible[0].runs[0].marks = json!({"link":"https://example.test/new"}),
            "attributes" => changed.visible[0].attributes = json!(["heading", 2]),
            "editor" => changed.visible[0].editor = json!({"version":"v4", "checked": true}),
            "span" => changed.visible[0].spans[0].identity = "other-integrated-type".into(),
            "recovery" => {
                let mut n = changed.visible[0].clone();
                n.id = "recovery".into();
                changed.recovery.push(n);
            }
            _ => changed.retained_structure = json!({"intention": "deleted"}),
        }
        let revision = capture(RevisionInput::Semantic(&changed));
        assert_eq!(base.content_changed(&revision), Ok(true), "{field}");
    }
}
#[test]
fn semantic_object_order_is_canonical_but_arrays_are_significant() {
    let mut a = semantic("before");
    let mut b = a.clone();
    a.visible[0].opaque = serde_json::from_str(r#"{"z":{"b":2,"a":1},"a":0}"#).unwrap();
    b.visible[0].opaque = serde_json::from_str(r#"{"a":0,"z":{"a":1,"b":2}}"#).unwrap();
    assert_eq!(
        capture(RevisionInput::Semantic(&a)).hash(),
        capture(RevisionInput::Semantic(&b)).hash()
    );
    a.visible[0].opaque = json!([1, 2]);
    b.visible[0].opaque = json!([2, 1]);
    assert_ne!(
        capture(RevisionInput::Semantic(&a)).hash(),
        capture(RevisionInput::Semantic(&b)).hash()
    );
}
#[test]
fn semantic_limits_and_duplicate_id_reject_before_capture() {
    let mut data = semantic("before");
    for limits in [
        RepresentationLimits {
            max_nodes: 1,
            ..Default::default()
        },
        RepresentationLimits {
            max_bytes: 2,
            ..Default::default()
        },
    ] {
        assert_eq!(
            ImmutableRevision::capture(scope(), RevisionInput::Semantic(&data), limits)
                .unwrap_err(),
            RepresentationError::ResourceLimit
        );
    }
    data.visible[0].opaque = json!([[[1]]]);
    assert_eq!(
        ImmutableRevision::capture(
            scope(),
            RevisionInput::Semantic(&data),
            RepresentationLimits {
                max_depth: 1,
                ..Default::default()
            }
        )
        .unwrap_err(),
        RepresentationError::ResourceLimit
    );
    data.visible[1].id = data.visible[0].id.clone();
    assert_eq!(
        ImmutableRevision::capture(scope(), RevisionInput::Semantic(&data), Default::default())
            .unwrap_err(),
        RepresentationError::InvalidSemantic
    );
}
#[test]
fn immutable_capture_owns_data_and_debug_omits_source() {
    let mut bytes = b"confidential-content".to_vec();
    let revision = capture(RevisionInput::ExactSource(&bytes));
    bytes.fill(b'x');
    assert_eq!(revision.bytes(), b"confidential-content");
    assert!(!format!("{revision:?}").contains("confidential"));
    let mut data = semantic("before");
    let revision = capture(RevisionInput::Semantic(&data));
    let hash = revision.hash();
    data.visible.clear();
    assert_eq!(revision.hash(), hash);
}
#[test]
fn unavailable_history_has_no_current_state_fallback_and_policy_is_bounded() {
    for reason in [
        UnavailableReason::Missing,
        UnavailableReason::Pruned,
        UnavailableReason::KeyUnavailable,
        UnavailableReason::IncompatibleSchema,
    ] {
        let unavailable: HistoryAvailability<ImmutableRevision> =
            HistoryAvailability::Unavailable(reason);
        assert!(matches!(unavailable, HistoryAvailability::Unavailable(r) if r == reason));
    }
    let policy = RetentionPolicy {
        max_revisions: 2,
        max_total_bytes: 16,
    };
    assert!(policy.permits(2, 16));
    assert!(!policy.permits(3, 16));
    assert!(!policy.permits(2, 17));
    assert!(
        !RetentionPolicy {
            max_revisions: 0,
            max_total_bytes: 0
        }
        .permits(1, 1)
    );
}

#[test]
fn semantic_serialized_output_budget_includes_json_escaping() {
    let mut data = semantic("before");
    data.visible[0].runs[0].text = "\u{0001}".repeat(100);
    let full = capture(RevisionInput::Semantic(&data));
    let limits = RepresentationLimits {
        max_bytes: full.bytes().len(),
        ..Default::default()
    };
    assert!(ImmutableRevision::capture(scope(), RevisionInput::Semantic(&data), limits).is_ok());
    assert_eq!(
        ImmutableRevision::capture(
            scope(),
            RevisionInput::Semantic(&data),
            RepresentationLimits {
                max_bytes: limits.max_bytes - 1,
                ..limits
            }
        )
        .unwrap_err(),
        RepresentationError::ResourceLimit
    );
    data.visible[0].spans[0].start = 10;
    assert_eq!(
        ImmutableRevision::capture(scope(), RevisionInput::Semantic(&data), Default::default())
            .unwrap_err(),
        RepresentationError::InvalidSemantic
    );
}
