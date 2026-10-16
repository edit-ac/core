use editac_highlighting::{
    BACKEND_ID, Backend, MAX_LINE_BYTES, MAX_LINES, MAX_SOURCE_BYTES, Status,
};
use serde_json::Value;
use std::time::Instant;

fn corpus() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/highlighting/corpus.json")).unwrap()
}
fn verify(language: &str) {
    let c = corpus();
    let case = c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["language"] == language)
        .unwrap();
    let source = case["source"].as_str().unwrap();
    let start = Instant::now();
    let backend = Backend::new();
    println!("INIT {language} {}", start.elapsed().as_nanos());
    let start = Instant::now();
    let result = backend.highlight(language, source, true);
    println!("COLD {language} {}", start.elapsed().as_nanos());
    assert_eq!(result.status, Status::Highlighted);
    assert_eq!(result.backend, c["backend"]);
    assert_eq!(result.source, source);
    if let Some(dir) = std::env::var_os("EDITAC_HIGHLIGHT_EVIDENCE") {
        let path = std::path::PathBuf::from(dir).join(format!("native-{language}.json"));
        std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    }
    let utf16: Vec<u16> = source.encode_utf16().collect();
    let mut previous = 0;
    for span in &result.spans {
        assert_eq!(span.start, previous);
        assert!(span.end > span.start);
        assert!(String::from_utf16(&utf16[span.start as usize..span.end as usize]).is_ok());
        previous = span.end;
    }
    assert_eq!(previous as usize, utf16.len());
    for expected in case["expected"].as_array().unwrap() {
        let needle = expected["text"].as_str().unwrap();
        let at = source.find(needle).unwrap();
        let start = source[..at].encode_utf16().count() as u32;
        let end = start + needle.encode_utf16().count() as u32;
        let matching: Vec<_> = result
            .spans
            .iter()
            .filter(|s| s.start < end && s.end > start)
            .collect();
        assert!(!matching.is_empty());
        assert!(
            matching.iter().all(|s| s
                .scopes
                .iter()
                .any(|scope| scope.contains(expected["scope"].as_str().unwrap()))),
            "{language}: {needle}: {matching:?}"
        );
    }
    for i in 0..100 {
        let start = Instant::now();
        let warm = backend.highlight(language, source, true);
        let ns = start.elapsed().as_nanos();
        assert_eq!(warm.status, Status::Highlighted);
        assert_eq!(warm.spans, result.spans);
        println!("WARM {language} {i} {ns}");
    }
}
#[test]
fn rust_scopes_unicode_multiline() {
    verify("rust");
}
#[test]
fn typescript_scopes_unicode_multiline() {
    verify("typescript");
}
#[test]
fn json_scopes_unicode_crlf() {
    verify("json");
}
#[test]
fn fallback_preserves_source_and_label() {
    let backend = Backend::new();
    let source = "<script>🦀\r\n\0unknown";
    for (language, enabled, status) in [
        ("rust", false, Status::Disabled),
        ("unknown-LANG", true, Status::UnknownLanguage),
    ] {
        let result = backend.highlight(language, source, enabled);
        assert_eq!(result.status, status);
        assert_eq!(result.source, source);
        assert_eq!(result.language, language);
        assert!(result.spans.is_empty());
    }
}
#[test]
fn limits_fall_back_atomically() {
    let backend = Backend::new();
    for source in [
        "x".repeat(MAX_SOURCE_BYTES + 1),
        "x".repeat(MAX_LINE_BYTES + 1),
        "\n".repeat(MAX_LINES + 1),
        ": ".repeat(16_384),
    ] {
        let result = backend.highlight("json", &source, true);
        assert_eq!(result.status, Status::OverBudget);
        assert_eq!(result.source, source);
        assert!(result.spans.is_empty());
    }
}
#[test]
fn malformed_and_empty_source_remain_literal() {
    let backend = Backend::new();
    for source in ["", "{\"unclosed\": 🦀", "\0\r\n"] {
        let result = backend.highlight("json", source, true);
        assert_eq!(result.status, Status::Highlighted);
        assert_eq!(result.source, source);
    }
    assert_eq!(BACKEND_ID, corpus()["backend"]);
}
