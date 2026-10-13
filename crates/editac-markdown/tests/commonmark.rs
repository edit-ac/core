use editac_core::{commands::format::Mark, document::BlockAttributes};
use editac_markdown::import::{ImportError, import};
fn text(block: &editac_markdown::FragmentBlock) -> String {
    block.runs.iter().map(|r| r.text.as_str()).collect()
}

#[test]
fn headings_paragraph_marks_breaks_and_separators() {
    let p = import("# Title\n\n**bold** *italic* `a  b`\nnext\\\nline\n\n---\n").unwrap();
    assert_eq!(p.blocks.len(), 3);
    assert_eq!(p.blocks[0].attributes, Some(BlockAttributes::Heading(1)));
    assert_eq!(text(&p.blocks[1]), "bold italic a  b\nnext\nline");
    assert!(
        p.blocks[1]
            .runs
            .iter()
            .any(|r| r.text == "bold" && r.marks == [(Mark::Bold, None)])
    );
    assert!(
        p.blocks[1]
            .runs
            .iter()
            .any(|r| r.text == "a  b" && r.marks == [(Mark::Code, None)])
    );
    assert_eq!(p.blocks[2].attributes, Some(BlockAttributes::Separator));
    assert!(p.diagnostics.is_empty());
}

#[test]
fn whole_document_reference_links_are_resolved() {
    let p = import("[alpha][ref]\n\n[ref]: https://example.com/path\n").unwrap();
    assert_eq!(p.blocks.len(), 1);
    assert_eq!(text(&p.blocks[0]), "alpha");
    assert_eq!(
        p.blocks[0].runs[0].marks,
        [(Mark::Link, Some("https://example.com/path".into()))]
    );
}

#[test]
fn nested_fences_unicode_and_code_whitespace_are_literal() {
    let source = "> ````rust\n> \t😀  \n> ```\n> ````\n";
    let p = import(source).unwrap();
    assert_eq!(
        p.blocks[0].attributes,
        Some(BlockAttributes::Code("rust".into()))
    );
    assert_eq!(text(&p.blocks[0]), "\t😀  \n```\n");
    assert!(p.blocks[0].runs.iter().all(|r| r.marks.is_empty()));
    assert_eq!(p.blocks[0].containers.len(), 1);
    assert_eq!(p.source, source);
}

#[test]
fn nested_lists_keep_container_identity_and_order() {
    let p = import("3. outer\n   - child\n4. second\n").unwrap();
    assert_eq!(
        p.blocks.iter().map(text).collect::<Vec<_>>(),
        ["outer", "child", "second"]
    );
    assert_eq!(p.blocks[0].containers.len(), 1);
    assert_eq!(p.blocks[1].containers.len(), 2);
    assert_eq!(p.blocks[0].containers[0], p.blocks[2].containers[0]);
    assert!(p.diagnostics.is_empty());
}

#[test]
fn unsafe_or_unrepresentable_content_has_recoverable_source_and_ranges() {
    let source = "[x](javascript:alert(1))\n\n<script>unsafe()</script>\n\n![alt](https://example.com/a.png)\n";
    let p = import(source).unwrap();
    assert_eq!(p.source, source);
    for code in ["unadmitted-link", "raw-html-inert", "image-codec-disabled"] {
        assert!(p.diagnostics.iter().any(|d| d.code == code), "{code}");
    }
    assert!(
        p.blocks
            .iter()
            .flat_map(|b| &b.runs)
            .all(|r| !r.marks.iter().any(|(m, _)| *m == Mark::Link))
    );
    assert!(
        p.diagnostics
            .iter()
            .all(|d| d.range.start <= d.range.end && d.range.end <= source.len())
    );
    assert!(
        p.blocks
            .iter()
            .map(text)
            .collect::<String>()
            .contains("<script>")
    );
}

#[test]
fn all_official_examples_prepare_without_live_mutation_or_source_loss() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/markdown/commonmark-0.31.2.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let source = case["markdown"].as_str().unwrap();
        let p = import(source)
            .unwrap_or_else(|e| panic!("official example {}: {e:?}", case["example"]));
        assert_eq!(p.source, source);
        assert!(!p.blocks.is_empty());
        assert_eq!(p.blocks.len(), p.ranges.len());
    }
}

#[test]
fn source_node_run_and_nesting_limits_reject_before_commit() {
    assert_eq!(
        import(&"x".repeat(1_048_577)).unwrap_err(),
        ImportError::ResourceLimit
    );
    assert_eq!(
        import(&"x\n\n".repeat(129)).unwrap_err(),
        ImportError::ResourceLimit
    );
    assert_eq!(
        import(&format!("{}x\n", "> ".repeat(17))).unwrap_err(),
        ImportError::ResourceLimit
    );
}
