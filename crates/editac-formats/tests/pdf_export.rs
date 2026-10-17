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
#[test]
fn aggregate_pdf_remains_unavailable_and_rich_content_cannot_silently_flatten() {
    assert!(
        !PROFILES
            .iter()
            .find(|p| p.format == "pdf")
            .unwrap()
            .available
    );
    let (mut o, _) = owner();
    let mut rich = blocks("same plain text");
    rich[0].attributes = Some(editac_core::document::BlockAttributes::Heading(2));
    rich[0].runs[0].marks = vec![
        (editac_core::commands::format::Mark::Bold, None),
        (
            editac_core::commands::format::Mark::Link,
            Some("https://example.test".into()),
        ),
    ];
    let mut insert = job(&o, "pdf-author-rich", Direction::Import);
    insert.finish_import(&mut o, &rich, 0).unwrap();
    let mut j = begin(&o, "pdf-rich", pdf::PROFILE.limits);
    // Even approval cannot enable a structure that has no implemented renderer.
    let e = pdf::export(&mut j, [LATIN, ARABIC], true, || 1)
        .err()
        .unwrap();
    assert_eq!(e.reason, "SEMANTIC_RENDERING_UNIMPLEMENTED");
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "BLOCK_RENDERING_UNIMPLEMENTED")
    );
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code.ends_with(":Bold"))
    );
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code.ends_with(":Link"))
    );
    assert_eq!(j.work().bytes, 0);
}
#[test]
fn mark_loss_requires_explicit_approval_and_diagnostics_survive_completion() {
    let (mut o, _) = owner();
    let mut rich = blocks("bold text");
    rich[0].runs[0].marks = vec![(editac_core::commands::format::Mark::Bold, None)];
    let mut insert = job(&o, "pdf-author-mark", Direction::Import);
    insert.finish_import(&mut o, &rich, 0).unwrap();
    let mut refused = begin(&o, "pdf-mark-refuse", pdf::PROFILE.limits);
    assert_eq!(failure(&mut refused).reason, "LOSS_APPROVAL_REQUIRED");
    let mut approved = begin(&o, "pdf-mark-approve", pdf::PROFILE.limits);
    let c = pdf::export(&mut approved, [LATIN, ARABIC], true, || 1).unwrap();
    assert!(
        c.report
            .diagnostics
            .iter()
            .any(|d| d.lossy && d.code.ends_with(":Bold"))
    );
}
