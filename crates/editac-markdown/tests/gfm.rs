use editac_core::commands::{format::Mark, lists::ContainerStyle};
use editac_markdown::import::import;
use pulldown_cmark::{Event, Tag};

#[test]
fn nested_checklist_states_and_strike_map_to_portable_contracts() {
    let p = import("- [x] ~~done~~\n  - [ ] child\n- [ ] later\n").unwrap();
    assert_eq!(p.blocks.len(), 3);
    assert_eq!(
        p.blocks.iter().map(|b| b.checked).collect::<Vec<_>>(),
        [Some(true), Some(false), Some(false)]
    );
    assert!(
        p.blocks
            .iter()
            .all(|b| b.containers.last().unwrap().1 == ContainerStyle::Checklist)
    );
    assert_eq!(p.blocks[1].containers.len(), 2);
    assert!(
        p.blocks[0]
            .runs
            .iter()
            .any(|r| r.text == "done" && r.marks == [(Mark::Strike, None)])
    );
}

#[test]
fn literal_autolink_destinations_and_punctuation_are_not_guessed() {
    let p = import("www.example.com/a(b)). https://example.com/path! a+b@example.com\n").unwrap();
    let urls: Vec<_> = p.blocks[0]
        .runs
        .iter()
        .flat_map(|r| &r.marks)
        .filter_map(|(m, v)| (*m == Mark::Link).then_some(v.clone().unwrap()))
        .collect();
    assert_eq!(
        urls,
        [
            "http://www.example.com/a(b)",
            "https://example.com/path",
            "mailto:a+b@example.com"
        ]
    );
    assert!(p.diagnostics.is_empty());
}

#[test]
fn syntax_inside_code_or_escaped_marks_remains_literal() {
    let p = import("`~~no~~ www.example.com` \\~\\~escaped\\~\\~\n\n```\n- [x] no\n```\n").unwrap();
    assert!(p.blocks[0].runs.iter().all(|r| {
        !r.marks
            .iter()
            .any(|(m, _)| matches!(m, Mark::Link | Mark::Strike))
    }));
    assert_eq!(p.blocks[1].checked, None);
    assert!(p.blocks[1].runs.iter().all(|r| r.marks.is_empty()));
}

#[test]
fn all_required_extension_sources_are_prepared_with_explicit_optional_fallbacks() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/markdown/gfm-required.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let source = case["markdown"].as_str().unwrap();
        let p = import(source).unwrap();
        assert_eq!(p.source, source);
        if case["section"] == "## Tables (extension)"
            && editac_markdown::profile::events(source)
                .iter()
                .any(|(e, _)| matches!(e, Event::Start(Tag::Table(_))))
        {
            assert!(
                p.diagnostics
                    .iter()
                    .any(|d| d.code == "table-codec-disabled")
            );
        }
    }
}

#[test]
fn grammar_recognition_does_not_admit_unsafe_or_unavailable_url_schemes() {
    let p = import("ftp://foo.bar.baz [unsafe](javascript:alert(1))\n").unwrap();
    assert_eq!(
        p.diagnostics
            .iter()
            .filter(|d| d.code == "unadmitted-link")
            .count(),
        2
    );
    assert!(p.blocks[0].runs.iter().all(|r| r.marks.is_empty()));
    assert_eq!(
        p.source,
        "ftp://foo.bar.baz [unsafe](javascript:alert(1))\n"
    );
}
