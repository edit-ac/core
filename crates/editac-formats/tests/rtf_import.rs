include!("support/jobs_harness.rs");
use editac_core::{commands::format::Mark, document::BlockAttributes, modules::content::Content};
use editac_formats::rtf::import::{self as rtf, Budgets};
const SUPPORTED: &[u8] = include_bytes!("../../../fixtures/formats/rtf/supported.rtf");
fn policy() -> HostPolicy {
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p
}
fn setup() -> (Owner, Arc<MemoryStore>) {
    let (mut o, s) = owner();
    o.service_mut().set_policy(policy());
    (o, s)
}
fn begin(o: &Owner, bytes: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Import);
    s.profile = rtf::PROFILE;
    s.original = bytes;
    s.filename = "fixture.rtf";
    s.media_type = "application/rtf";
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap()
}
fn prepare(o: &Owner, bytes: &[u8]) -> (PreparedJob<MemoryStore>, rtf::Prepared) {
    let mut j = begin(o, bytes, "rtf");
    let p = rtf::prepare(&mut j, Budgets::default(), || 0).unwrap();
    (j, p)
}
fn projection(p: &rtf::Prepared) -> Vec<String> {
    p.blocks()
        .iter()
        .map(|b| b.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
fn table(p: &rtf::Prepared) -> Content {
    p.blocks()
        .iter()
        .find_map(|b| {
            if let Some(BlockAttributes::Unknown(t)) = &b.attributes {
                Content::from_tuple(t).unwrap()
            } else {
                None
            }
        })
        .unwrap()
}
fn failure(bytes: &[u8], code: &str) {
    let (o, _) = setup();
    let before = checkpoint(&o);
    let mut j = begin(&o, bytes, "failure");
    let e = rtf::prepare(&mut j, Budgets::default(), || 0)
        .err()
        .unwrap();
    assert_eq!(e.code, code, "offset={} report={:?}", e.offset, e.report);
    assert_eq!(checkpoint(&o), before);
    assert_eq!(j.source().original(), bytes);
    assert!(matches!(
        j.finish_import(&mut setup().0, &blocks("bad"), 0),
        Err(JobError::Finished)
    ));
}
#[test]
fn supported_text_marks_unicode_and_table_semantics() {
    let (o, _) = setup();
    let (_, p) = prepare(&o, SUPPORTED);
    assert_eq!(
        projection(&p),
        [
            "Hello bold both bold plain € é 🙂 {literal} \\ end",
            "Second\ttab\nbreak",
            "A\tB\né\t=1+1",
            "Tail"
        ]
    );
    assert!(p.report().diagnostics.is_empty());
    let runs = &p.blocks()[0].runs;
    assert_eq!(
        runs.iter().find(|r| r.text == "both").unwrap().marks,
        vec![(Mark::Bold, None), (Mark::Italic, None)]
    );
    if let Content::Table { rows, .. } = table(&p) {
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0][0].marks, vec![(Mark::Bold, None)]);
        assert_eq!(rows[1][1][0].text, "=1+1");
    } else {
        panic!()
    }
    assert_eq!(p.report().scanned_bytes, SUPPORTED.len());
    assert!(p.report().tokens > 80);
    println!("RTF_WORK {:?}", p.report());
}
#[test]
fn one_prepared_session_commit_undo_redo_reopen_and_original_recovery() {
    let (mut o, store) = setup();
    let before = checkpoint(&o);
    let (mut j, p) = prepare(&o, SUPPORTED);
    assert_eq!(checkpoint(&o), before);
    assert_eq!(
        p.original_sha256,
        <[u8; 32]>::from(Sha256::digest(SUPPORTED))
    );
    assert_eq!(j.source().original(), SUPPORTED);
    let c = p.commit(&mut j, &mut o, false, 0).unwrap().unwrap();
    assert!(c.assets.is_empty());
    let after = o.service().read(0).unwrap().snapshot;
    assert!(current(&o).contains("Hello bold both"));
    assert!(
        after
            .visible
            .iter()
            .any(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
    );
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    let reopened = ConversionOwner::open(
        store,
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        policy(),
    )
    .unwrap();
    assert_eq!(current(&reopened), current(&o));
    let recovered = reopened.service().read(0).unwrap().snapshot;
    assert_eq!(
        after
            .visible
            .iter()
            .map(|n| &n.block_attributes)
            .collect::<Vec<_>>(),
        recovered
            .visible
            .iter()
            .map(|n| &n.block_attributes)
            .collect::<Vec<_>>()
    );
    println!(
        "RTF_SESSION commits=1 assets=0 undo=1 redo=1 reopen=1 original_bytes={} network_calls=0",
        SUPPORTED.len()
    );
}
#[test]
fn scoped_uc_fallback_hex_symbols_words_and_binary() {
    let (o, _) = setup();
    let (_, p) = prepare(
        &o,
        br"{\rtf1\uc1\u233?{\uc2\u945ab}\u946\'3f\u947\~\u948\tab\u949\bin3 }{x\uc0\u950}",
    );
    assert_eq!(projection(&p), ["éαβγδεζ"]);
    assert_eq!(p.report().binary_bytes, 3);
    assert!(p.report().diagnostics.is_empty());
}
#[test]
fn brace_ends_unicode_fallback_and_uc_restores() {
    let (o, _) = setup();
    let (_, p) = prepare(&o, br"{\rtf1\uc2\u233{\uc0\u945}ok}");
    assert_eq!(projection(&p), ["éαok"]);
}
#[test]
fn raw_cp1252_and_no_normalization() {
    let (o, _) = setup();
    let (_, p) = prepare(&o, b"{\\rtf1 \'\xe9\x80 \\uc0\\u101\\u769}");
    assert_eq!(projection(&p), ["'é€ e\u{301}"]);
}
#[test]
fn mark_resets_and_empty_paragraphs() {
    let (o, _) = setup();
    let (_, p) = prepare(
        &o,
        br"{\rtf1\b A{\i B}\b0 C\ul D\ulnone E\strike F\plain G\par\par}",
    );
    assert_eq!(projection(&p), ["ABCDEFG", ""]);
    assert_eq!(p.blocks()[0].runs.last().unwrap().marks, vec![]);
}
#[test]
fn inert_destinations_complete_loss_report_and_recovery() {
    let (mut o, _) = setup();
    let bytes=br"{\rtf1 before{\*\future secret{\b nested}}{\object{\objdata 010203}}{\field{\fldinst INCLUDEPICTURE https://invalid/}{\fldrslt hidden}}\mystery7 after}";
    let before = checkpoint(&o);
    let (mut j, p) = prepare(&o, bytes);
    assert_eq!(projection(&p), ["beforeafter"]);
    assert_eq!(
        p.report()
            .diagnostics
            .iter()
            .map(|d| d.control.as_str())
            .collect::<Vec<_>>(),
        ["future", "object", "field", "mystery"]
    );
    let e = p.commit(&mut j, &mut o, false, 0).err().unwrap();
    assert_eq!(e.code, "LOSS_APPROVAL");
    assert_eq!(e.report.diagnostics.len(), 4);
    assert_eq!(j.source().original(), bytes);
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn explicit_loss_approval_commits_supported_projection_once() {
    let (mut o, _) = setup();
    let (mut j, p) = prepare(&o, br"{\rtf1 kept{\pict 010203}tail}");
    assert_eq!(p.report().diagnostics.len(), 1);
    p.commit(&mut j, &mut o, true, 0).unwrap().unwrap();
    assert!(current(&o).contains("kepttail"));
}
#[test]
fn unknown_unstarred_destination_omits_whole_group() {
    let (o, _) = setup();
    let (_, p) = prepare(&o, br"{\rtf1 A{\future text{nested}}B}");
    assert_eq!(projection(&p), ["AB"]);
    assert_eq!(p.report().diagnostics[0].offset, 9);
}
#[test]
fn binary_payload_never_interpreted_as_groups_or_controls() {
    let (o, _) = setup();
    let (_, p) = prepare(&o, b"{\\rtf1 A{\\object\\bin5 }{\\\\x}B}");
    assert_eq!(projection(&p), ["AB"]);
    assert_eq!(p.report().binary_bytes, 5);
}
macro_rules! bad {
    ($name:ident,$input:expr,$code:literal) => {
        #[test]
        fn $name() {
            failure($input, $code)
        }
    };
}
bad!(reject_unclosed_group, br"{\rtf1 a", "GROUP_BALANCE");
bad!(
    reject_trailing_root,
    br"{\rtf1 a}{\rtf1 b}",
    "TRAILING_DATA"
);
bad!(reject_wrong_signature, br"{\rtf2 a}", "RTF_SIGNATURE");
bad!(reject_negative_binary, br"{\rtf1\bin-1 x}", "BINARY_LENGTH");
bad!(
    reject_truncated_binary,
    br"{\rtf1\bin90 x}",
    "BINARY_LENGTH"
);
bad!(
    reject_large_numeric,
    br"{\rtf1\foo999999999999999999999 x}",
    "PARAMETER_RANGE"
);
bad!(reject_invalid_hex, br"{\rtf1\'xz}", "HEX_ESCAPE");
bad!(
    reject_missing_unicode_parameter,
    br"{\rtf1\u x}",
    "MISSING_PARAMETER"
);
bad!(reject_unicode_range, br"{\rtf1\u65535?}", "UNICODE_RANGE");
bad!(
    reject_lone_high_surrogate,
    br"{\rtf1\u-10179?}",
    "UNICODE_SURROGATE"
);
bad!(
    reject_lone_low_surrogate,
    br"{\rtf1\u-8638?}",
    "UNICODE_SURROGATE"
);
bad!(
    reject_surrogate_mark_boundary,
    br"{\rtf1\u-10179?\b\u-8638?}",
    "UNICODE_MARK_BOUNDARY"
);
bad!(
    reject_fallback_count,
    br"{\rtf1\uc17 x}",
    "UNICODE_FALLBACK_COUNT"
);
bad!(
    reject_unsupported_codepage,
    br"{\rtf1\ansicpg932 x}",
    "UNSUPPORTED_CODEPAGE"
);
bad!(
    reject_font_encoding_guess,
    br"{\rtf1{\fonttbl{\f0\fcharset128 Font;}}text}",
    "UNSUPPORTED_FONT_OR_CODEPAGE"
);
bad!(reject_undefined_cp1252, b"{\\rtf1 \x81}", "CODEPAGE_BYTE");
bad!(
    reject_cell_break,
    br"{\rtf1\trowd\cellx100\intbl a\line b\cell\row}",
    "UNSUPPORTED_CELL_STRUCTURE"
);
bad!(
    reject_cell_paragraph,
    br"{\rtf1\trowd\cellx100\intbl a\par b\cell\row}",
    "UNSUPPORTED_CELL_PARAGRAPHS"
);
bad!(
    reject_merged_cell,
    br"{\rtf1\trowd\clmgf\cellx100\intbl a\cell\row}",
    "UNSUPPORTED_TABLE_STRUCTURE"
);
bad!(
    reject_nested_table,
    br"{\rtf1\trowd\cellx100\intbl a\trowd}",
    "UNSUPPORTED_NESTED_TABLE"
);
bad!(
    reject_nonincreasing_edges,
    br"{\rtf1\trowd\cellx100\cellx99}",
    "TABLE_BOUNDARY"
);
bad!(
    reject_incomplete_row,
    br"{\rtf1\trowd\cellx100\intbl a\cell}",
    "TABLE_INCOMPLETE"
);
bad!(
    reject_missing_cell,
    br"{\rtf1\trowd\cellx100\intbl a\row}",
    "TABLE_RECTANGLE"
);
bad!(
    reject_ragged_rows,
    br"{\rtf1\trowd\cellx100\intbl a\cell\row\trowd\cellx100\cellx200\intbl b\cell c\cell\row}",
    "TABLE_RECTANGLE"
);
#[test]
fn all_resource_budgets_fail_during_preparation() {
    let (o, _) = setup();
    for (budgets, bytes, code) in [
        (
            Budgets {
                depth: 2,
                ..Budgets::default()
            },
            br"{\rtf1{{x}}}".as_slice(),
            "DEPTH_BUDGET",
        ),
        (
            Budgets {
                tokens: 3,
                ..Budgets::default()
            },
            br"{\rtf1 lots of text}".as_slice(),
            "WORK_BUDGET",
        ),
        (
            Budgets {
                binary_bytes: 2,
                ..Budgets::default()
            },
            br"{\rtf1{\object\bin3 abc}}".as_slice(),
            "BINARY_BUDGET",
        ),
        (
            Budgets {
                diagnostics: 1,
                ..Budgets::default()
            },
            br"{\rtf1\foo\bar x}".as_slice(),
            "DIAGNOSTIC_BUDGET",
        ),
        (
            Budgets {
                utf16_units: 1,
                ..Budgets::default()
            },
            br"{\rtf1 ab}".as_slice(),
            "TEXT_BUDGET",
        ),
        (
            Budgets {
                columns: 1,
                ..Budgets::default()
            },
            br"{\rtf1\trowd\cellx1\cellx2}".as_slice(),
            "COLUMN_BUDGET",
        ),
        (
            Budgets {
                rows: 0,
                ..Budgets::default()
            },
            br"{\rtf1\trowd\cellx1\intbl a\cell\row}".as_slice(),
            "ROW_BUDGET",
        ),
    ] {
        let mut j = begin(&o, bytes, "budget");
        assert_eq!(
            rtf::prepare(&mut j, budgets, || 0).err().unwrap().code,
            code
        );
    }
}
#[test]
fn skipped_destinations_still_charge_depth_work_and_binary() {
    let bytes = format!(
        "{{\\rtf1{{\\object {}x{}}}}}",
        "{".repeat(70),
        "}".repeat(70)
    );
    failure(bytes.as_bytes(), "DEPTH_BUDGET");
    let bytes = format!(
        "{{\\rtf1{{\\object\\bin40000 {}}}{{\\pict\\bin40000 {}}}}}",
        "a".repeat(40000),
        "b".repeat(40000)
    );
    failure(bytes.as_bytes(), "BINARY_BUDGET");
}
#[test]
fn caller_cannot_enlarge_hard_ceilings() {
    let (o, _) = setup();
    let mut j = begin(&o, br"{\rtf1 ok}", "budget");
    assert_eq!(
        rtf::prepare(
            &mut j,
            Budgets {
                depth: 65,
                ..Budgets::default()
            },
            || 0
        )
        .err()
        .unwrap()
        .code,
        "INVALID_BUDGET"
    );
}
#[test]
fn job_output_and_nodes_enforced_in_preparation() {
    let (o, _) = setup();
    for (nodes, output, code) in [(1, 4096, "NODE_BUDGET"), (4096, 1, "OUTPUT_BUDGET")] {
        let mut s = spec(&o, "budget", Direction::Import);
        s.profile = rtf::PROFILE;
        s.original = br"{\rtf1 a}";
        s.filename = "a.rtf";
        s.limits.nodes = nodes;
        s.limits.output_bytes = output;
        let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
        assert_eq!(
            rtf::prepare(&mut j, Budgets::default(), || 0)
                .err()
                .unwrap()
                .code,
            code
        );
    }
}
#[test]
fn cancel_and_timeout_leave_live_state_and_original_unchanged() {
    let (o, _) = setup();
    for cancel in [true, false] {
        let before = checkpoint(&o);
        let mut j = begin(&o, SUPPORTED, "control");
        if cancel {
            j.cancellation().cancel();
        }
        let e = rtf::prepare(&mut j, Budgets::default(), || if cancel { 0 } else { 101 })
            .err()
            .unwrap();
        assert_eq!(e.code, if cancel { "CANCELLED" } else { "TIMEOUT" });
        assert_eq!(checkpoint(&o), before);
        assert_eq!(j.source().original(), SUPPORTED);
    }
}
#[test]
fn cancellation_during_scan_is_observed() {
    let (o, _) = setup();
    let mut j = begin(&o, SUPPORTED, "control");
    let cancel = j.cancellation();
    let mut calls = 0;
    let e = rtf::prepare(&mut j, Budgets::default(), || {
        calls += 1;
        if calls == 40 {
            cancel.cancel();
        }
        0
    })
    .err()
    .unwrap();
    assert_eq!(e.code, "CANCELLED");
    assert!(e.report.scanned_bytes < SUPPORTED.len());
}
#[test]
fn stale_revision_and_disabled_table_codec_are_atomic() {
    for disabled in [true, false] {
        let (mut o, _) = setup();
        if disabled {
            o.service_mut().set_policy(HostPolicy::default());
        }
        let (mut j, p) = prepare(&o, SUPPORTED);
        if !disabled {
            edit(&mut o, "later");
        }
        let before = checkpoint(&o);
        assert!(p.commit(&mut j, &mut o, false, 0).is_err());
        assert_eq!(checkpoint(&o), before);
    }
}
#[test]
fn foreign_prepared_cannot_consume_another_job() {
    let (mut o, _) = setup();
    let (mut own, p) = prepare(&o, br"{\rtf1 A}");
    let mut other = begin(&o, br"{\rtf1 B}", "other");
    assert_eq!(
        p.commit(&mut other, &mut o, false, 0).err().unwrap().code,
        "FOREIGN_JOB"
    );
    assert!(other.finish_import(&mut o, &blocks("B"), 0).is_ok());
    own.abort().unwrap();
}
#[test]
fn empty_document_is_explicit_empty_paragraph() {
    let (o, _) = setup();
    let (_, p) = prepare(&o, br"{\rtf1}");
    assert_eq!(projection(&p), [""]);
}

#[test]
fn malformed_star_destination_cannot_render_hidden_payload() {
    failure(br"{\rtf1 A{\* hidden}B}", "DESTINATION_CONTROL_REQUIRED");
}
#[test]
fn bounded_deterministic_mutated_inputs_never_panic_or_mutate_live_state() {
    let (o, _) = setup();
    let before = checkpoint(&o);
    for byte in 0u8..=255 {
        let mut source = br"{\rtf1 safe{\b text}\u233?}".to_vec();
        source[15] = byte;
        let mut j = begin(&o, &source, "mutation");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            rtf::prepare(&mut j, Budgets::default(), || 0)
        }));
        assert!(result.is_ok(), "byte={byte}");
        assert_eq!(checkpoint(&o), before);
        assert_eq!(j.source().original(), source);
    }
}
