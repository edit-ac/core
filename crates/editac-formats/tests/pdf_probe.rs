use editac_formats::{Direction, pdf::*};
#[path = "support/pdf_probe.rs"]
mod probe;

fn caps() -> Capabilities {
    Capabilities {
        native_macos_arm64: true,
        filesystem_allowlist: true,
        network_denied: true,
        child_processes_denied: true,
        deadline: true,
        output_limit: true,
        rss_watchdog: true,
    }
}
fn admit(c: Capabilities, l: ProbeLimits) -> Result<(), Unavailable> {
    admit_probe(Direction::Export, c, l, ENGINE_VERSION, &FONT_HASHES, true)
}
#[test]
fn native_probe_requires_all_enforcement_capabilities() {
    assert_eq!(admit(caps(), PROBE_LIMITS), Ok(()));
    for i in 0..8 {
        let mut c = caps();
        match i {
            0 => c.native_macos_arm64 = false,
            1 => c.filesystem_allowlist = false,
            2 => c.network_denied = false,
            3 => c.child_processes_denied = false,
            4 => c.deadline = false,
            5 => c.output_limit = false,
            6 => c.rss_watchdog = false,
            _ => c.native_macos_arm64 = false,
        }
        assert!(admit(c, PROBE_LIMITS).is_err());
    }
}
#[test]
fn pdf_import_rejects_before_font_engine_or_host_checks() {
    assert_eq!(
        admit_probe(Direction::Import, caps(), PROBE_LIMITS, "", &[], false),
        Err(Unavailable::ExportOnly)
    );
}
#[test]
fn fonts_missing_substituted_or_reordered_are_unavailable() {
    for f in [
        vec![],
        vec![FONT_HASHES[0]],
        vec![FONT_HASHES[1], FONT_HASHES[0]],
        vec!["host-font", FONT_HASHES[1]],
    ] {
        assert_eq!(
            admit_probe(
                Direction::Export,
                caps(),
                PROBE_LIMITS,
                ENGINE_VERSION,
                &f,
                true
            ),
            Err(Unavailable::Font)
        );
    }
}
#[test]
fn missing_coverage_has_no_implicit_fallback() {
    assert_eq!(
        admit_probe(
            Direction::Export,
            caps(),
            PROBE_LIMITS,
            ENGINE_VERSION,
            &FONT_HASHES,
            false
        ),
        Err(Unavailable::Coverage)
    );
    assert!(probe::shape("漢字", probe::LATIN, false).is_err());
}
#[test]
fn engine_version_is_exact() {
    assert_eq!(
        admit_probe(
            Direction::Export,
            caps(),
            PROBE_LIMITS,
            "0.5.1",
            &FONT_HASHES,
            true
        ),
        Err(Unavailable::Engine)
    );
}
#[test]
fn resource_limits_cannot_expand_the_qualified_envelope() {
    for i in 0..10 {
        let mut l = PROBE_LIMITS;
        match i {
            0 => l.input_bytes = 0,
            1 => l.input_bytes += 1,
            2 => l.output_bytes = 0,
            3 => l.output_bytes += 1,
            4 => l.deadline_ms = 0,
            5 => l.deadline_ms += 1,
            6 => l.rss_bytes = 0,
            7 => l.rss_bytes += 1,
            8 => l.pages = 0,
            _ => l.pages += 1,
        }
        assert_eq!(admit(caps(), l), Err(Unavailable::ResourceLimit));
    }
}
#[test]
fn arabic_ligature_and_zero_advance_mark_are_shaped_not_replaced() {
    let lam_alef = probe::shape("لا", probe::ARABIC, true).unwrap();
    // Noto Naskh uses a zero-advance component for this joined ligature. A
    // one-glyph assertion would incorrectly require another font's strategy.
    let mut separate = probe::shape("ا", probe::ARABIC, true).unwrap();
    separate.extend(probe::shape("ل", probe::ARABIC, true).unwrap());
    assert_ne!(lam_alef, separate);
    assert!(lam_alef.iter().any(|x| x.1 == 0));
    let marks = probe::shape("لَا", probe::ARABIC, true).unwrap();
    assert!(marks.iter().any(|x| x.1 == 0));
    assert!(marks.iter().all(|x| x.0 != 0));
}
#[test]
fn latin_combining_text_and_literal_template_characters_are_content() {
    let text = "Cafe\u{301} #read(\"/private/secret\") {literal}";
    assert!(!probe::shape(text, probe::LATIN, false).unwrap().is_empty());
}
#[test]
fn bounded_probe_writes_tagged_two_page_pdf_without_a_reader() {
    let bytes = probe::render(probe::LATIN, probe::ARABIC).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(bytes.len() < PROBE_LIMITS.output_bytes);
    assert!(bytes.windows(15).any(|b| b == b"/StructTreeRoot"));
}
#[test]
fn malformed_font_fails_before_output() {
    assert!(probe::render(b"not a font", probe::ARABIC).is_err());
}
