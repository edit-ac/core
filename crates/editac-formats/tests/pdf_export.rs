include!("support/jobs_harness.rs");
use editac_formats::pdf::export as pdf;
const LATIN: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Regular.ttf");
const ARABIC: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoNaskhArabic-Regular.ttf");
const FIXTURE: &str = include_str!("../../../fixtures/formats/pdf/export/text.json");
fn document(texts: &[String]) -> Owner {
    let id = identity();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let initial = texts
        .iter()
        .map(|text| InitialNode {
            kind: "block".into(),
            text: text.clone(),
        })
        .collect::<Vec<_>>();
    ConversionOwner::create(store, id, &initial, HostPolicy::default()).unwrap()
}
fn begin(o: &Owner, id: &str, limits: Limits) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Export);
    s.profile = pdf::PROFILE;
    s.original = b"";
    s.filename = "publication.pdf";
    s.media_type = "application/pdf";
    s.limits = limits;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap()
}
fn failure(job: &mut PreparedJob<MemoryStore>) -> pdf::Failure {
    match pdf::export(job, [LATIN, ARABIC], false, || 1) {
        Ok(_) => panic!("expected refusal"),
        Err(e) => e,
    }
}
#[test]
fn captured_session_multilingual_multipage_artifact_is_exact_and_bounded() {
    let texts: Vec<String> = serde_json::from_str(FIXTURE).unwrap();
    let mut o = document(&texts);
    let revision = o.service().read(0).unwrap().revision;
    let mut job = begin(&o, "pdf-captured", pdf::PROFILE.limits);
    edit(&mut o, " later revision");
    let c = pdf::export(&mut job, [LATIN, ARABIC], false, || 1).unwrap();
    assert_eq!(c.artifact.revision(), &revision);
    assert_ne!(
        o.service().read(0).unwrap().revision,
        *c.artifact.revision()
    );
    assert!(c.report.pages >= 4 && c.report.pages <= 8);
    assert!(c.report.shaped_bytes > texts.iter().map(String::len).sum());
    for (i, original) in texts.iter().enumerate() {
        assert_eq!(
            c.report
                .lines
                .iter()
                .filter(|l| l.block == i)
                .map(|l| l.text.as_str())
                .collect::<String>(),
            *original
        );
    }
    assert!(
        c.report
            .lines
            .iter()
            .all(|l| l.width <= 364.0 && l.y <= 332.0)
    );
    assert!(c.artifact.bytes().starts_with(b"%PDF"));
    assert_eq!(c.artifact.work().pages, c.report.pages);
    if let Some(path) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let root = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("text-publication.pdf"), c.artifact.bytes()).unwrap();
        let lines = c.report.lines.iter().map(|l| serde_json::json!({"block":l.block,"page":l.page,"y":l.y,"advance":l.width,"text":l.text,"rtl":l.rtl})).collect::<Vec<_>>();
        std::fs::write(root.join("text-layout.json"), serde_json::to_vec_pretty(&serde_json::json!({"pages":c.report.pages,"shapedBytes":c.report.shaped_bytes,"lines":lines,"bytes":c.artifact.bytes().len(),"revision":format!("{:?}",revision)})).unwrap()).unwrap();
    }
}
#[test]
fn single_script_arabic_ligatures_and_zero_advance_marks_are_selectable() {
    let o = document(&["لا لَا العربية".into()]);
    let mut j = begin(&o, "pdf-arabic", pdf::PROFILE.limits);
    let c = pdf::export(&mut j, [LATIN, ARABIC], false, || 1).unwrap();
    assert_eq!(c.report.lines.len(), 1);
    assert!(c.report.lines[0].rtl);
    assert_eq!(c.report.lines[0].text, "لا لَا العربية");
}
#[test]
fn newlines_combining_sequences_and_long_words_are_not_normalized_or_lost() {
    let original = format!("Cafe\u{301}\n\n{}\n", "longword".repeat(45));
    let o = document(&[original.clone()]);
    let mut j = begin(&o, "pdf-wrap", pdf::PROFILE.limits);
    let c = pdf::export(&mut j, [LATIN, ARABIC], false, || 1).unwrap();
    assert!(c.report.lines.len() > 5);
    assert_eq!(
        c.report
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<String>(),
        original
    );
    assert!(
        c.report
            .lines
            .iter()
            .all(|l| !l.text.starts_with('\u{301}'))
    );
}
#[test]
fn wrapping_prefers_word_boundaries_and_preserves_trailing_spaces() {
    let text = "word ".repeat(100);
    let o = document(&[text.clone()]);
    let mut j = begin(&o, "pdf-word-wrap", pdf::PROFILE.limits);
    let c = pdf::export(&mut j, [LATIN, ARABIC], false, || 1).unwrap();
    assert!(c.report.lines.iter().all(|l| l.text.ends_with(' ')));
    assert_eq!(
        c.report
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<String>(),
        text
    );
}
#[test]
fn fonts_are_exact_bytes_and_missing_or_substituted_fonts_refuse_output() {
    let o = document(&["text".into()]);
    for fonts in [[&b""[..], ARABIC], [LATIN, LATIN]] {
        let mut j = begin(&o, "pdf-font", pdf::PROFILE.limits);
        let e = pdf::export(&mut j, fonts, false, || 1).err().unwrap();
        assert_eq!(e.reason, "FONT_UNAVAILABLE");
        assert_eq!(j.work().bytes, 0);
    }
}
#[test]
fn unsupported_font_coverage_and_bidi_cannot_make_successful_empty_output() {
    for (text, reason) in [
        ("漢字", "FONT_COVERAGE_UNAVAILABLE"),
        ("Arabic العربية", "MIXED_BIDI_UNAVAILABLE"),
        ("العربية 123", "MIXED_BIDI_UNAVAILABLE"),
        ("RTL العربية Latin 123", "MIXED_BIDI_UNAVAILABLE"),
    ] {
        let o = document(&[text.into()]);
        let mut j = begin(&o, "pdf-coverage", pdf::PROFILE.limits);
        assert_eq!(failure(&mut j).reason, reason);
        assert_eq!(j.work().bytes, 0);
    }
}
#[test]
fn page_exhaustion_refuses_complete_artifact_without_mutating_session() {
    let o = document(
        &(0..20)
            .map(|n| format!("paragraph {n}"))
            .collect::<Vec<_>>(),
    );
    let before = o.service().read(0).unwrap().revision;
    let mut j = begin(
        &o,
        "pdf-pages",
        Limits {
            pages: 1,
            ..pdf::PROFILE.limits
        },
    );
    assert_eq!(failure(&mut j).reason, "PAGE_LIMIT");
    assert_eq!(j.work().bytes, 0);
    assert_eq!(o.service().read(0).unwrap().revision, before);
}
#[test]
fn output_limit_failure_and_cancelled_layout_release_only_job_resources() {
    let o = document(&["text".into()]);
    let mut j = begin(
        &o,
        "pdf-output",
        Limits {
            output_bytes: 32,
            ..pdf::PROFILE.limits
        },
    );
    assert!(failure(&mut j).reason.contains("ResourceLimit"));
    let mut sibling = begin(&o, "pdf-sibling", pdf::PROFILE.limits);
    let mut cancelled = begin(&o, "pdf-cancel", pdf::PROFILE.limits);
    let cancel = cancelled.cancellation();
    let mut calls = 0;
    let e = pdf::export(&mut cancelled, [LATIN, ARABIC], false, || {
        calls += 1;
        if calls == 4 {
            cancel.cancel();
        }
        1
    })
    .err()
    .unwrap();
    assert!(e.reason.contains("Cancelled"));
    assert_eq!(cancelled.work().bytes, 0);
    assert!(pdf::export(&mut sibling, [LATIN, ARABIC], false, || 1).is_ok());
}
#[test]
fn timeout_during_work_aborts_before_completion() {
    let o = document(&["a paragraph".into()]);
    let mut j = begin(&o, "pdf-timeout", pdf::PROFILE.limits);
    let mut calls = 0;
    let e = pdf::export(&mut j, [LATIN, ARABIC], false, || {
        calls += 1;
        if calls > 3 { 1000 } else { 1 }
    })
    .err()
    .unwrap();
    assert!(e.reason.contains("Timeout"));
    assert_eq!(j.work().bytes, 0);
}
#[test]
fn original_provenance_and_controls_are_actionable_refusals() {
    let o = document(&["with\ttab".into()]);
    let mut j = begin(&o, "pdf-control", pdf::PROFILE.limits);
    let e = failure(&mut j);
    assert_eq!(e.reason, "SEMANTIC_RENDERING_UNIMPLEMENTED");
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "CONTROL_LAYOUT_UNAVAILABLE")
    );
}
#[test]
fn unqualified_original_provenance_is_reported_and_recoverable_after_refusal() {
    let o = document(&["plain".into()]);
    let mut s = spec(&o, "pdf-original", Direction::Export);
    s.profile = pdf::PROFILE;
    s.limits = pdf::PROFILE.limits;
    let original = s.original.to_vec();
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    let e = failure(&mut j);
    assert_eq!(e.reason, "LOSS_APPROVAL_REQUIRED");
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "SOURCE_PROVENANCE_UNAVAILABLE")
    );
    assert_eq!(j.source().original(), original);
    assert_eq!(j.work().bytes, 0);
}
const BOLD: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Bold.ttf");
const ITALIC: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Italic.ttf");
const BOTH: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-BoldItalic.ttf");
const MONO: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSansMono-Regular.ttf");
fn rich_fonts() -> pdf::Fonts<'static> {
    pdf::Fonts {
        base: [LATIN, ARABIC],
        rich: Some([BOLD, ITALIC, BOTH, MONO]),
    }
}
fn rich_blocks() -> Vec<FragmentBlock> {
    use editac_core::{
        commands::{format::Mark, lists::ContainerStyle},
        document::BlockAttributes,
    };
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/formats/pdf/export/rich.json"
    ))
    .unwrap();
    fixture["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| FragmentBlock {
            runs: b["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| FragmentRun {
                    opaque_marks: vec![],
                    text: r["text"].as_str().unwrap().into(),
                    marks: r["marks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| match m.as_str().unwrap() {
                            "bold" => (Mark::Bold, None),
                            "italic" => (Mark::Italic, None),
                            "underline" => (Mark::Underline, None),
                            "strike" => (Mark::Strike, None),
                            "code" => (Mark::Code, None),
                            "link" => (Mark::Link, Some(r["href"].as_str().unwrap().into())),
                            _ => panic!(),
                        })
                        .collect(),
                })
                .collect(),
            attributes: b
                .get("heading")
                .map(|h| BlockAttributes::Heading(h.as_u64().unwrap() as u8)),
            containers: b.get("path").map_or(vec![], |p| {
                p.as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        (
                            c[0].as_str().unwrap().into(),
                            if c[1].is_null() {
                                ContainerStyle::Unordered
                            } else {
                                ContainerStyle::Ordered {
                                    start: c[1].as_u64().unwrap() as u32,
                                }
                            },
                        )
                    })
                    .collect()
            }),
            checked: None,
        })
        .collect()
}
fn insert(o: &mut Owner, content: &[FragmentBlock]) {
    let mut j = job(o, "pdf-author", Direction::Import);
    j.finish_import(o, content, 0).unwrap();
}
#[test]
fn captured_rich_marks_headings_lists_and_links_generate_qualified_artifact() {
    let (mut o, _) = owner();
    let content = rich_blocks();
    insert(&mut o, &content);
    let revision = o.service().read(0).unwrap().revision;
    let before = current(&o);
    let mut j = begin(&o, "pdf-rich-captured", pdf::PROFILE.limits);
    let captured = j
        .source()
        .export_blocks()
        .iter()
        .map(|(_, b)| {
            b.as_ref()
                .unwrap()
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let mut expected = content
        .iter()
        .map(|b| b.runs.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect::<Vec<_>>();
    expected.last_mut().unwrap().push_str("base");
    assert_eq!(captured, expected);
    edit(&mut o, "LATER ");
    let edited = current(&o);
    let c = pdf::export_with_fonts(&mut j, rich_fonts(), false, || 1).unwrap();
    assert_eq!(c.artifact.revision(), &revision);
    assert_ne!(before, edited);
    assert_eq!(current(&o), edited);
    assert!(!c.report.diagnostics.iter().any(|d| d.lossy));
    for (i, t) in expected.iter().enumerate() {
        assert_eq!(
            c.report
                .lines
                .iter()
                .filter(|l| l.block == i)
                .map(|l| l.text.as_str())
                .collect::<String>(),
            *t
        );
    }
    let labels = c
        .report
        .lines
        .iter()
        .filter_map(|l| l.marker.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(labels, ["3.", "•", "4.", "10."]);
    assert!(c.report.pages > 1);
    assert!(
        c.report
            .lines
            .iter()
            .all(|l| l.x >= 28.0 && l.x + l.width <= 392.1 && l.y <= 332.0)
    );
    let faces = c
        .report
        .lines
        .iter()
        .flat_map(|l| &l.runs)
        .map(|r| r.style.face)
        .collect::<BTreeSet<_>>();
    assert_eq!(faces, [0, 2, 3, 4, 5].into());
    if let Some(path) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let root = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("rich-publication.pdf"), c.artifact.bytes()).unwrap();
        let lines=c.report.lines.iter().map(|l|serde_json::json!({"block":l.block,"page":l.page,"x":l.x,"y":l.y,"size":l.size,"text":l.text,"marker":l.marker,"runs":l.runs.iter().map(|r|serde_json::json!({"text":r.text,"width":r.width,"face":r.style.face,"link":r.style.link,"underline":r.style.underline,"strike":r.style.strike})).collect::<Vec<_>>()})).collect::<Vec<_>>();
        std::fs::write(root.join("rich-layout.json"),serde_json::to_vec_pretty(&serde_json::json!({"pages":c.report.pages,"lines":lines,"shapedBytes":c.report.shaped_bytes,"bytes":c.artifact.bytes().len(),"revision":format!("{revision:?}")})).unwrap()).unwrap();
    }
}
#[test]
fn rich_fonts_are_explicit_pinned_and_never_replaced_by_host_fallback() {
    use editac_core::commands::format::Mark;
    let (mut o, _) = owner();
    let mut content = blocks("bold text");
    content[0].runs[0].marks = vec![(Mark::Bold, None)];
    insert(&mut o, &content);
    let mut j = begin(&o, "pdf-missing-rich", pdf::PROFILE.limits);
    assert_eq!(failure(&mut j).reason, "RICH_FONT_UNAVAILABLE");
    assert_eq!(j.work().bytes, 0);
    let mut fonts = rich_fonts();
    fonts.rich = Some([LATIN, ITALIC, BOTH, MONO]);
    let mut j = begin(&o, "pdf-substitute-rich", pdf::PROFILE.limits);
    assert_eq!(
        pdf::export_with_fonts(&mut j, fonts, true, || 1)
            .err()
            .unwrap()
            .reason,
        "RICH_FONT_UNAVAILABLE"
    );
    assert_eq!(j.work().bytes, 0);
}
#[test]
fn unsupported_structures_have_complete_diagnostics_even_with_approval() {
    use editac_core::{
        commands::{format::Mark, lists::ContainerStyle},
        document::BlockAttributes,
    };
    let (mut o, _) = owner();
    let mut content = blocks("code bold");
    content[0].runs[0].marks = vec![];
    content[0].attributes = Some(BlockAttributes::Code("rust".into()));
    content[0].containers = vec![("quote".into(), ContainerStyle::Quote)];
    insert(&mut o, &content);
    let before = o.service().read(0).unwrap().revision;
    let mut j = begin(&o, "pdf-rich-unsupported", pdf::PROFILE.limits);
    let e = pdf::export_with_fonts(&mut j, rich_fonts(), true, || 1)
        .err()
        .unwrap();
    assert_eq!(e.reason, "SEMANTIC_RENDERING_UNIMPLEMENTED");
    for code in ["BLOCK_RENDERING_UNIMPLEMENTED", "UNSUPPORTED_LIST_CONTEXT"] {
        assert!(
            e.report.diagnostics.iter().any(|d| d.code == code),
            "{code}"
        );
    }
    assert_eq!(j.work().bytes, 0);
    assert_eq!(before, o.service().read(0).unwrap().revision);
}
#[test]
fn unsupported_arabic_style_boundaries_refuse_instead_of_breaking_joining() {
    use editac_core::commands::format::Mark;
    let mut o = document(&[String::new()]);
    let mut content = blocks("لا");
    content[0].runs = vec![
        FragmentRun {
            opaque_marks: vec![],
            text: "ل".into(),
            marks: vec![],
        },
        FragmentRun {
            opaque_marks: vec![],
            text: "ا".into(),
            marks: vec![(Mark::Underline, None)],
        },
    ];
    insert(&mut o, &content);
    let mut j = begin(&o, "pdf-arabic-rich", pdf::PROFILE.limits);
    assert_eq!(
        pdf::export_with_fonts(&mut j, rich_fonts(), true, || 1)
            .err()
            .unwrap()
            .reason,
        "RTL_STYLE_BOUNDARY_UNAVAILABLE"
    );
    assert_eq!(j.work().bytes, 0);
}
#[test]
fn split_combining_cluster_marks_refuse_but_identical_style_runs_coalesce() {
    use editac_core::commands::format::Mark;
    let mut o = document(&[String::new()]);
    let mut content = blocks("e");
    content[0].runs = vec![
        FragmentRun {
            opaque_marks: vec![],
            text: "e".into(),
            marks: vec![],
        },
        FragmentRun {
            opaque_marks: vec![],
            text: "\u{301}".into(),
            marks: vec![(Mark::Bold, None)],
        },
    ];
    insert(&mut o, &content);
    let mut j = begin(&o, "pdf-cluster-mark", pdf::PROFILE.limits);
    assert_eq!(
        pdf::export_with_fonts(&mut j, rich_fonts(), false, || 1)
            .err()
            .unwrap()
            .reason,
        "MARK_CLUSTER_BOUNDARY_UNAVAILABLE"
    );
    let mut o = document(&[String::new()]);
    content[0].runs[0].marks = vec![(Mark::Bold, None)];
    insert(&mut o, &content);
    let mut j = begin(&o, "pdf-cluster-same", pdf::PROFILE.limits);
    let c = pdf::export_with_fonts(&mut j, rich_fonts(), false, || 1).unwrap();
    assert_eq!(c.report.lines[0].text, "e\u{301}");
}
#[test]
fn unsafe_link_schemes_are_rejected_by_shared_ingress_without_mutating_source() {
    use editac_core::commands::format::Mark;
    for url in [
        "javascript:alert(1)",
        "file:///private/secret",
        "https://user:password@example.test/",
        "https://example.test/%0a",
    ] {
        let (mut o, _) = owner();
        let before = o.service().read(0).unwrap().revision;
        let mut content = blocks("unsafe");
        content[0].runs[0].marks = vec![(Mark::Link, Some(url.into()))];
        let mut j = job(&o, "pdf-bad-link", Direction::Import);
        assert!(j.finish_import(&mut o, &content, 0).is_err());
        assert_eq!(before, o.service().read(0).unwrap().revision);
    }
}
#[test]
fn rich_export_cancel_timeout_page_and_output_failure_are_atomic_and_recoverable() {
    let (mut o, _) = owner();
    insert(&mut o, &rich_blocks());
    let before = o.service().read(0).unwrap().revision;
    for (id, limits) in [
        (
            "pdf-rich-pages",
            Limits {
                pages: 1,
                ..pdf::PROFILE.limits
            },
        ),
        (
            "pdf-rich-output",
            Limits {
                output_bytes: 32,
                ..pdf::PROFILE.limits
            },
        ),
    ] {
        let mut j = begin(&o, id, limits);
        assert!(pdf::export_with_fonts(&mut j, rich_fonts(), false, || 1).is_err());
        assert_eq!(j.work().bytes, 0);
        assert_eq!(before, o.service().read(0).unwrap().revision);
    }
    let mut j = begin(&o, "pdf-rich-cancel", pdf::PROFILE.limits);
    let cancel = j.cancellation();
    let mut calls = 0;
    let e = pdf::export_with_fonts(&mut j, rich_fonts(), false, || {
        calls += 1;
        if calls == 20 {
            cancel.cancel();
        }
        1
    })
    .err()
    .unwrap();
    assert!(e.reason.contains("Cancelled"));
    assert_eq!(j.work().bytes, 0);
    let mut sibling = begin(&o, "pdf-rich-recovery", pdf::PROFILE.limits);
    assert!(pdf::export_with_fonts(&mut sibling, rich_fonts(), false, || 1).is_ok());
    assert_eq!(before, o.service().read(0).unwrap().revision);
}
#[test]
fn aggregate_pdf_profile_stays_unavailable_until_tables_images_isolation_and_full_qualification() {
    assert!(
        !PROFILES
            .iter()
            .find(|p| p.format == "pdf")
            .unwrap()
            .available
    );
}
