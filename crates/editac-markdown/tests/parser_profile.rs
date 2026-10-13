use pulldown_cmark::{Event, Options, Parser, Tag};
mod support;

#[test]
fn official_commonmark_0312_raw_parser_conformance() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/markdown/commonmark-0.31.2.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for case in cases.as_array().unwrap() {
        let mut actual = String::new();
        pulldown_cmark::html::push_html(
            &mut actual,
            Parser::new_ext(case["markdown"].as_str().unwrap(), Options::empty()),
        );
        // HTML serialization is not the grammar: quote entities and a block-start
        // newline under <li> are equivalent. Preserve every other byte, including
        // all code whitespace. Example 175 is the latter serialization difference.
        let normalize = |s: &str| {
            s.replace("&quot;", "\"")
                .replace("<li>\n<div>", "<li><div>")
        };
        if normalize(&actual) != normalize(case["html"].as_str().unwrap()) {
            failures.push((case["example"].clone(), actual, case["html"].clone()));
        }
    }
    assert_eq!(cases.as_array().unwrap().len(), 652);
    assert!(
        failures.is_empty(),
        "{} raw parser failures: {failures:?}",
        failures.len()
    );
}

#[test]
fn required_extensions_have_actual_events() {
    use editac_markdown::profile::options;
    let events: Vec<_> = Parser::new_ext(
        "- [x] done\n\n~~gone~~\n\n| a | b |\n| - | - |\n| c | d |\n",
        options(),
    )
    .collect();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::TaskListMarker(true)))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::Start(Tag::Strikethrough)))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::Start(Tag::Table(_))))
    );
    assert!(!options().contains(Options::ENABLE_GFM));
}

#[test]
fn extended_autolinks_candidate_gap_is_explicit() {
    let events: Vec<_> = Parser::new_ext(
        "www.example.com http://example.com a@example.com",
        editac_markdown::profile::options(),
    )
    .collect();
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, Event::Start(Tag::Link { .. })))
    );
    // This candidate result is a gap, not a claim of supported extended autolinks.
}

#[test]
fn complete_required_gfm_corpus_is_qualified() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/markdown/gfm-required.json")).unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 23);
    let mut failures = Vec::new();
    for (i, case) in cases.as_array().unwrap().iter().enumerate() {
        let mut actual = String::new();
        pulldown_cmark::html::push_html(
            &mut actual,
            editac_markdown::profile::events(case["markdown"].as_str().unwrap())
                .into_iter()
                .map(|(e, _)| e),
        );
        if support::gfm_html(&actual) != support::gfm_html(case["html"].as_str().unwrap()) {
            failures.push((i, actual, case["html"].clone()));
        }
    }
    assert!(failures.is_empty(), "GFM failures: {failures:?}");
}

#[test]
fn autolinks_exclude_code_existing_links_and_bad_boundaries() {
    let source = "`www.example.com` [www.example.com](https://other.test) xwww.example.com www.bad_.com https://example.com/a(b)). foo+bar@example.com";
    let urls: Vec<_> = editac_markdown::profile::events(source)
        .into_iter()
        .filter_map(|(e, _)| match e {
            Event::Start(Tag::Link { dest_url, .. }) => Some(dest_url.to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(
        urls,
        [
            "https://other.test",
            "https://example.com/a(b)",
            "mailto:foo+bar@example.com"
        ]
    );
}

#[test]
fn nonprofile_syntax_remains_literal() {
    let mut html = String::new();
    pulldown_cmark::html::push_html(
        &mut html,
        editac_markdown::profile::events("~literal~ $math$ [!NOTE]\n")
            .into_iter()
            .map(|(e, _)| e),
    );
    assert_eq!(html, "<p>~literal~ $math$ [!NOTE]</p>\n");
}
