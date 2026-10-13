use editac_diff::{representation::*, text::*};

fn revision(bytes: &[u8]) -> ImmutableRevision {
    let mut token = [0; 65];
    token[0] = 1;
    ImmutableRevision::capture(
        RevisionScope {
            document: "source-fixture".into(),
            epoch: "1".into(),
            schema: "v5".into(),
            module_profile: "task-v1".into(),
            observed_token: token,
        },
        RevisionInput::ExactSource(bytes),
        RepresentationLimits::default(),
    )
    .unwrap()
}
fn patch(a: &[u8], b: &[u8]) -> TextPatch {
    TextPatch::between(&revision(a), &revision(b), PatchLimits::default()).unwrap()
}
fn round_trip(a: &[u8], b: &[u8]) -> TextPatch {
    let p = patch(a, b);
    let l = PatchLimits::default();
    let wire = p.encode(l).unwrap();
    let decoded = TextPatch::decode(wire.as_bytes(), l).unwrap();
    assert_eq!(p, decoded);
    let output = decoded.apply(a, l).unwrap();
    assert_eq!(output, b);
    assert_eq!(ContentHash::of(&output).hex(), p.metadata.after_hash);
    assert_eq!(ContentHash::of(a).hex(), p.metadata.before_hash);
    p
}
fn rejection(p: &TextPatch, a: &[u8], error: PatchError) {
    let original = a.to_vec();
    assert_eq!(p.apply(a, PatchLimits::default()), Err(error));
    assert_eq!(a, original);
}
#[test]
fn exact_fixture_bytes_and_hashes_round_trip() {
    for (a, b) in [
        (
            &include_bytes!("../../../fixtures/diff/format-before.md")[..],
            &include_bytes!("../../../fixtures/diff/format-after.md")[..],
        ),
        (
            &include_bytes!("../../../fixtures/diff/delete-before.md")[..],
            &include_bytes!("../../../fixtures/diff/delete-after.md")[..],
        ),
        (
            &include_bytes!("../../../fixtures/diff/crlf.md")[..],
            &include_bytes!("../../../fixtures/diff/lf.md")[..],
        ),
        (
            &include_bytes!("../../../fixtures/diff/unicode.md")[..],
            &include_bytes!("../../../fixtures/diff/no-final-newline.md")[..],
        ),
    ] {
        round_trip(a, b);
    }
}
#[test]
fn insert_delete_empty_and_identity() {
    for (a, b) in [
        (b"".as_slice(), b"a\nb\n".as_slice()),
        (b"a\nb\n", b""),
        (b"", b""),
        (b"a", b"a"),
        (b"a\n", b"a\nx"),
        (b"a\nb\n", b"a\n"),
    ] {
        round_trip(a, b);
    }
    assert!(patch(b"same", b"same").hunks.is_empty());
}
#[test]
fn final_newline_metadata_and_markers_are_exact() {
    for (a, b) in [
        (b"a".as_slice(), b"a\n".as_slice()),
        (b"a\n", b"a"),
        (b"a\nb", b"a\nc"),
        (b"a\r", b"a\r\n"),
    ] {
        let p = round_trip(a, b);
        assert_eq!(p.metadata.before_final_newline, a.ends_with(b"\n"));
        assert_eq!(p.metadata.after_final_newline, b.ends_with(b"\n"));
        assert!(
            p.encode(PatchLimits::default())
                .unwrap()
                .contains("\\ No newline at end of file")
        );
    }
}
#[test]
fn crlf_mixed_endings_and_literal_marker_are_preserved() {
    round_trip(b"a\r\nb\nc\r\n", b"a\r\nB\nc\r\n");
    round_trip(
        b"",
        b"@@ -1,1 +1,1 @@\n\\ No newline at end of file\n--- before\n+++ after\n",
    );
}
#[test]
fn unicode_combining_emoji_and_rtl_are_bytes() {
    round_trip("e\u{301} 👩‍💻 שלום\n".as_bytes(), "é 👨‍👩‍👧‍👦 مرحبا\r\n".as_bytes());
}
#[test]
fn repeated_lines_use_pinned_delete_first_tie_break() {
    let p = round_trip(b"a\nb\na\n", b"b\na\nb\n");
    assert_eq!(p.metadata.line_algorithm, LINE_ALGORITHM);
    assert_eq!(p.metadata.word_algorithm, WORD_ALGORITHM);
    assert_eq!(
        p.hunks[0].lines.iter().map(|l| l.kind).collect::<Vec<_>>(),
        [
            LineKind::Delete,
            LineKind::Context,
            LineKind::Context,
            LineKind::Insert
        ]
    );
    for _ in 0..20 {
        assert_eq!(patch(b"a\nb\na\n", b"b\na\nb\n"), p);
    }
}
#[test]
fn multiple_hunks_have_correct_unified_ranges_and_context() {
    let a = (0..24).map(|i| format!("line{i}\n")).collect::<String>();
    let b = a
        .replace("line2\n", "two\n")
        .replace("line20\n", "twenty\n");
    let p = round_trip(a.as_bytes(), b.as_bytes());
    assert_eq!(p.hunks.len(), 2);
    assert_eq!((p.hunks[0].old_start, p.hunks[0].old_count), (1, 6));
    assert_eq!((p.hunks[1].old_start, p.hunks[1].old_count), (18, 7));
    let wire = p.encode(PatchLimits::default()).unwrap();
    assert!(wire.contains("@@ -1,6 +1,6 @@\n"));
}
#[test]
fn nearby_changes_share_a_hunk() {
    let p = round_trip(b"a\nb\nc\nd\ne\nf\ng\nh\n", b"A\nb\nc\nd\ne\nf\ng\nH\n");
    assert_eq!(p.hunks.len(), 1);
}
#[test]
fn wrong_baseline_rejects_atomically() {
    rejection(
        &patch(b"old\n", b"new\n"),
        b"bad\n",
        PatchError::WrongBaseline,
    );
}
#[test]
fn wrong_after_hash_rejects_late_without_mutation() {
    let mut p = patch(b"old\n", b"new\n");
    p.metadata.after_hash = ContentHash::of(b"bad\n").hex();
    rejection(&p, b"old\n", PatchError::WrongOutput);
}
#[test]
fn malformed_lengths_and_zero_one_based_ranges_reject() {
    let base = patch(b"old\n", b"new\n");
    let mut p = base.clone();
    p.hunks[0].old_count += 1;
    rejection(&p, b"old\n", PatchError::MalformedRange);
    let mut p = base.clone();
    p.hunks[0].old_start = 0;
    rejection(&p, b"old\n", PatchError::MalformedRange);
    let mut p = base.clone();
    p.hunks[0].new_start = 2;
    rejection(&p, b"old\n", PatchError::MalformedRange);
    let mut p = base;
    p.hunks[0].old_start = usize::MAX;
    rejection(&p, b"old\n", PatchError::ResourceLimit);
}
#[test]
fn duplicate_overlapping_and_out_of_order_hunks_reject() {
    let mut p = patch(b"old\n", b"new\n");
    p.hunks.push(p.hunks[0].clone());
    rejection(&p, b"old\n", PatchError::OverlappingHunks);
    let a = (0..24).map(|i| format!("{i}\n")).collect::<String>();
    let b = a.replace("2\n", "x\n").replace("20\n", "y\n");
    let mut p = patch(a.as_bytes(), b.as_bytes());
    p.hunks.reverse();
    rejection(&p, a.as_bytes(), PatchError::OverlappingHunks);
    let mut p = patch(b"", b"new\n");
    p.hunks.push(p.hunks[0].clone());
    rejection(&p, b"", PatchError::OverlappingHunks);
}
#[test]
fn tampered_context_and_deletions_reject() {
    let mut p = patch(b"a\nb\nc\n", b"a\nB\nc\n");
    p.hunks[0].lines[0].text = "wrong\n".into();
    rejection(&p, b"a\nb\nc\n", PatchError::MissingContext);
    let mut p = patch(b"a\n", b"");
    p.hunks[0].lines[0].text = "wrong\n".into();
    rejection(&p, b"a\n", PatchError::MissingContext);
}
#[test]
fn malformed_wire_and_duplicate_newline_markers_reject() {
    let l = PatchLimits::default();
    let p = patch(b"a", b"b");
    let wire = p.encode(l).unwrap();
    for bad in [
        wire.replace("@@ -1,1", "@@ -0,1"),
        wire.replace("--- before", "--- other"),
        wire.replace(
            "\\ No newline at end of file\n",
            "\\ No newline at end of file\n\\ No newline at end of file\n",
        ),
        wire.replace("@@ -1,1", "@@ -1,+1"),
        wire.trim_end().into(),
        wire.replace("-a\n", "?a\n"),
    ] {
        assert!(TextPatch::decode(bad.as_bytes(), l).is_err());
    }
}
#[test]
fn unknown_profile_algorithm_and_metadata_reject() {
    let l = PatchLimits::default();
    let mut p = patch(b"a", b"b");
    p.metadata.representation = "projected-markdown".into();
    rejection(&p, b"a", PatchError::InvalidMetadata);
    let mut p = patch(b"a", b"b");
    p.metadata.line_algorithm = "git-default".into();
    assert_eq!(p.encode(l), Err(PatchError::InvalidMetadata));
    let wire = patch(b"a", b"b")
        .encode(l)
        .unwrap()
        .replacen("{", "{\"unknown\":1,", 1);
    assert_eq!(
        TextPatch::decode(wire.as_bytes(), l),
        Err(PatchError::InvalidMetadata)
    );
}
#[test]
fn host_limits_cannot_be_raised_by_wire_metadata() {
    let p = patch(b"a\n", b"long output\n");
    let l = PatchLimits {
        max_output_bytes: 2,
        ..PatchLimits::default()
    };
    assert_eq!(p.apply(b"a\n", l), Err(PatchError::ResourceLimit));
    assert_eq!(
        TextPatch::decode(p.encode(PatchLimits::default()).unwrap().as_bytes(), l),
        Err(PatchError::ResourceLimit)
    );
    let l = PatchLimits {
        max_wire_bytes: 10,
        ..PatchLimits::default()
    };
    assert_eq!(p.encode(l), Err(PatchError::ResourceLimit));
    assert_eq!(
        TextPatch::decode(b"12345678901", l),
        Err(PatchError::ResourceLimit)
    );
}
#[test]
fn line_hunk_input_and_work_budgets_reject_explicitly() {
    for l in [
        PatchLimits {
            max_source_bytes: 1,
            ..PatchLimits::default()
        },
        PatchLimits {
            max_lines: 1,
            ..PatchLimits::default()
        },
        PatchLimits {
            max_hunks: 0,
            ..PatchLimits::default()
        },
        PatchLimits {
            max_comparison_cells: 1,
            ..PatchLimits::default()
        },
    ] {
        assert_eq!(
            TextPatch::between(&revision(b"a\nb\n"), &revision(b"c\nd\n"), l),
            Err(PatchError::ResourceLimit)
        );
    }
}
#[test]
fn large_local_edit_trims_common_ends_before_comparison() {
    let a = "same\n".repeat(10_000);
    let mut b = a.clone();
    b.replace_range(25_000..25_005, "new!\n");
    let l = PatchLimits {
        max_comparison_cells: 4,
        ..PatchLimits::default()
    };
    let p = TextPatch::between(&revision(a.as_bytes()), &revision(b.as_bytes()), l).unwrap();
    assert_eq!(p.apply(a.as_bytes(), l).unwrap(), b.as_bytes());
    assert_eq!(p.hunks.len(), 1);
}
#[test]
fn large_replacement_is_bounded_not_fabricated() {
    let a = "old\n".repeat(3000);
    let b = "new\n".repeat(3000);
    assert_eq!(
        TextPatch::between(
            &revision(a.as_bytes()),
            &revision(b.as_bytes()),
            PatchLimits::default()
        ),
        Err(PatchError::ResourceLimit)
    );
}
#[test]
fn unterminated_interior_line_and_embedded_lf_reject() {
    let mut p = patch(b"a\nb\n", b"A\nb\n");
    p.hunks[0]
        .lines
        .iter_mut()
        .find(|l| l.kind == LineKind::Insert)
        .unwrap()
        .text = "A".into();
    rejection(&p, b"a\nb\n", PatchError::MalformedEncoding);
    let mut p = patch(b"a\n", b"b\n");
    p.hunks[0].lines[0].text = "a\nextra\n".into();
    rejection(&p, b"a\n", PatchError::MalformedEncoding);
}
#[test]
fn words_preserve_unicode_and_whitespace_without_normalizing() {
    let a = "é \t👩‍💻\r\n";
    let b = "é  👩‍💻\n";
    let detail = word_changes(a, b, PatchLimits::default()).unwrap();
    let old = detail
        .iter()
        .filter(|l| l.kind != LineKind::Insert)
        .map(|l| l.text.as_str())
        .collect::<String>();
    let new = detail
        .iter()
        .filter(|l| l.kind != LineKind::Delete)
        .map(|l| l.text.as_str())
        .collect::<String>();
    assert_eq!(old, a);
    assert_eq!(new, b);
    assert_eq!(detail, word_changes(a, b, PatchLimits::default()).unwrap());
    assert_eq!(
        word_changes(
            "a b",
            "c d",
            PatchLimits {
                max_comparison_cells: 1,
                ..PatchLimits::default()
            }
        ),
        Err(PatchError::ResourceLimit)
    );
}
#[test]
fn projected_or_incompatible_source_cannot_be_mislabeled() {
    let a = revision(b"a");
    let b = ImmutableRevision::capture(
        a.scope().clone(),
        RevisionInput::ProjectedMarkdown {
            bytes: b"b",
            serializer: "v1",
            dialect: "commonmark",
        },
        RepresentationLimits::default(),
    )
    .unwrap();
    assert_eq!(
        TextPatch::between(&a, &b, PatchLimits::default()),
        Err(PatchError::IncompatibleRepresentation)
    );
    let mut scope = a.scope().clone();
    scope.epoch = "other".into();
    let b = ImmutableRevision::capture(
        scope,
        RevisionInput::ExactSource(b"b"),
        RepresentationLimits::default(),
    )
    .unwrap();
    assert_eq!(
        TextPatch::between(&a, &b, PatchLimits::default()),
        Err(PatchError::IncompatibleScope)
    );
}
#[test]
fn binary_invalid_utf8_and_redacted_debug() {
    let p = patch(b"confidential old\n", b"confidential new\n");
    assert!(!format!("{p:?}").contains("confidential"));
    assert_eq!(
        p.apply(&[0xff], PatchLimits::default()),
        Err(PatchError::InvalidUtf8)
    );
    assert_eq!(
        p.apply(b"\0", PatchLimits::default()),
        Err(PatchError::BinarySource)
    );
    assert_eq!(
        TextPatch::decode(&[0xff], PatchLimits::default()),
        Err(PatchError::InvalidUtf8)
    );
}
#[test]
fn small_exhaustive_repeated_line_corpus_round_trips() {
    let mut corpus = vec![String::new()];
    for len in 1..=4 {
        for mask in 0..(1 << len) {
            let s = (0..len)
                .map(|i| if mask & (1 << i) == 0 { "a\n" } else { "b\n" })
                .collect::<String>();
            corpus.push(s.clone());
            corpus.push(s.trim_end_matches('\n').into());
        }
    }
    for a in &corpus {
        for b in &corpus {
            round_trip(a.as_bytes(), b.as_bytes());
        }
    }
}

#[test]
fn fixed_unified_golden_pins_wire_bytes() {
    let p = patch(
        include_bytes!("../../../fixtures/diff/repeated-before.md"),
        include_bytes!("../../../fixtures/diff/repeated-after.md"),
    );
    assert_eq!(
        p.encode(PatchLimits::default()).unwrap().as_bytes(),
        include_bytes!("../../../fixtures/diff/repeated.patch")
    );
}
#[test]
fn actual_output_growth_is_capped_even_with_forged_lengths() {
    let mut p = patch(b"a\n", b"long output\n");
    p.metadata.after_bytes = 2;
    assert_eq!(
        p.apply(
            b"a\n",
            PatchLimits {
                max_output_bytes: 2,
                ..PatchLimits::default()
            }
        ),
        Err(PatchError::ResourceLimit)
    );
}
#[test]
fn decoded_hunk_line_and_metadata_allocations_are_bounded() {
    let p = patch(b"a\n", b"b\n");
    let wire = p.encode(PatchLimits::default()).unwrap();
    assert_eq!(
        TextPatch::decode(
            wire.as_bytes(),
            PatchLimits {
                max_hunks: 0,
                ..PatchLimits::default()
            }
        ),
        Err(PatchError::ResourceLimit)
    );
    assert_eq!(
        TextPatch::decode(
            wire.as_bytes(),
            PatchLimits {
                max_lines: 0,
                ..PatchLimits::default()
            }
        ),
        Err(PatchError::ResourceLimit)
    );
    let oversized = format!(
        "# editac-exact-patch-v1 {}\n--- before\n+++ after\n",
        " ".repeat(2049)
    );
    assert_eq!(
        TextPatch::decode(oversized.as_bytes(), PatchLimits::default()),
        Err(PatchError::ResourceLimit)
    );
}
#[test]
fn adjacency_is_valid_but_duplicate_insertions_overlap() {
    let mut p = patch(b"a\nb\n", b"A\nB\n");
    p.hunks = vec![
        UnifiedHunk {
            old_start: 1,
            old_count: 1,
            new_start: 1,
            new_count: 1,
            lines: vec![
                PatchLine {
                    kind: LineKind::Delete,
                    text: "a\n".into(),
                },
                PatchLine {
                    kind: LineKind::Insert,
                    text: "A\n".into(),
                },
            ],
        },
        UnifiedHunk {
            old_start: 2,
            old_count: 1,
            new_start: 2,
            new_count: 1,
            lines: vec![
                PatchLine {
                    kind: LineKind::Delete,
                    text: "b\n".into(),
                },
                PatchLine {
                    kind: LineKind::Insert,
                    text: "B\n".into(),
                },
            ],
        },
    ];
    assert_eq!(
        p.apply(b"a\nb\n", PatchLimits::default()).unwrap(),
        b"A\nB\n"
    );
}

#[test]
fn bounded_large_replacement_and_source_block_move_round_trip() {
    let a = (0..400).map(|i| format!("old-{i}\n")).collect::<String>();
    let b = (0..400).map(|i| format!("new-{i}\n")).collect::<String>();
    round_trip(a.as_bytes(), b.as_bytes());
    round_trip(
        b"# A\nalpha\n\n# B\nbeta\n",
        b"# B\nbeta changed\n\n# A\nalpha\n",
    );
    assert_eq!(
        TextPatch::between(
            &revision(b"a"),
            &revision(b"too long"),
            PatchLimits {
                max_output_bytes: 1,
                ..PatchLimits::default()
            }
        ),
        Err(PatchError::ResourceLimit)
    );
}
#[test]
fn malformed_new_counts_and_final_newline_claims_reject() {
    let mut p = patch(b"old\n", b"new\n");
    p.hunks[0].new_count += 1;
    rejection(&p, b"old\n", PatchError::MalformedRange);
    let mut p = patch(b"old\n", b"new\n");
    p.metadata.before_final_newline = false;
    rejection(&p, b"old\n", PatchError::WrongBaseline);
    let mut p = patch(b"old\n", b"new\n");
    p.metadata.after_final_newline = false;
    rejection(&p, b"old\n", PatchError::WrongOutput);
}
