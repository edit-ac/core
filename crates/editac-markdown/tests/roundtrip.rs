use editac_core::{commands::format::Mark, document::BlockAttributes};
use editac_markdown::{FragmentBlock, FragmentRun, export::export, import::import};
fn semantic(blocks: &[FragmentBlock]) -> serde_json::Value {
    serde_json::Value::Array(blocks.iter().map(|b|serde_json::json!({"attributes":format!("{:?}",b.attributes),"checked":b.checked,"containers":b.containers.iter().map(|(_,s)|format!("{s:?}")).collect::<Vec<_>>(),"runs":b.runs.iter().map(|r|serde_json::json!([r.text,format!("{:?}",r.marks)])).collect::<Vec<_>>()})).collect())
}
fn roundtrip(source: &str) {
    let a = import(source).unwrap();
    let output = export(&a.blocks);
    assert!(
        output.diagnostics.is_empty(),
        "{source:?}: {:?}",
        output.diagnostics
    );
    let b = import(&output.markdown).unwrap();
    assert_eq!(
        semantic(&a.blocks),
        semantic(&b.blocks),
        "output: {:?}",
        output.markdown
    );
    assert_eq!(export(&b.blocks).markdown, output.markdown);
}

#[test]
fn headings_marks_links_and_escaping() {
    roundtrip(
        "# heading\n\n**bold** *italic* ~~strike~~ [link](https://example.com/a) \\*literal\\*\n",
    );
}
#[test]
fn code_delimiters_spaces_and_nested_fences() {
    roundtrip("`` a`b `` and `  `\n\n````rust\n  😀\t\n```\n````\n");
}
#[test]
fn nested_lists_quotes_and_check_states() {
    roundtrip("3. outer\n   - child\n4. last\n\n> quote\n\n- [x] done\n- [ ] later\n");
}
#[test]
fn unicode_breaks_empty_documents_and_separators() {
    roundtrip("😀 é אבג\nline\\\nnext\n\n---\n");
    roundtrip("");
}
#[test]
fn source_spelling_is_normalized_only_on_export() {
    let p = import("__bold__\r\n").unwrap();
    assert_eq!(p.source, "__bold__\r\n");
    assert_eq!(export(&p.blocks).markdown, "**bold**\n");
}
#[test]
fn underline_unknown_content_and_unrepresentable_code_retain_data() {
    for (attributes, marks, code) in [
        (
            BlockAttributes::Paragraph,
            vec![(Mark::Underline, None)],
            "underline-unrepresentable",
        ),
        (
            BlockAttributes::Code(String::new()),
            vec![],
            "code-terminal-newline",
        ),
    ] {
        let blocks = vec![FragmentBlock {
            attributes: Some(attributes),
            runs: vec![FragmentRun {
                text: "retained".into(),
                marks,
            }],
            containers: vec![],
            checked: None,
        }];
        let out = export(&blocks);
        assert!(out.diagnostics.iter().any(|d| d.code == code));
        assert_eq!(out.recovery.len(), 1);
        assert_eq!(out.recovery[0].runs[0].text, "retained");
    }
}

#[test]
fn adjacent_ambiguous_marks_never_report_a_lossless_export() {
    let blocks = vec![FragmentBlock {
        attributes: Some(BlockAttributes::Paragraph),
        runs: vec![
            FragmentRun {
                text: "a".into(),
                marks: vec![(Mark::Bold, None)],
            },
            FragmentRun {
                text: "b".into(),
                marks: vec![(Mark::Bold, None), (Mark::Italic, None)],
            },
            FragmentRun {
                text: "c".into(),
                marks: vec![(Mark::Italic, None)],
            },
        ],
        containers: vec![],
        checked: None,
    }];
    let output = export(&blocks);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|d| d.code == "markdown-unrepresentable")
    );
    assert_eq!(output.recovery.len(), 1);
    assert_eq!(
        output.recovery[0].runs[1].marks,
        [(Mark::Bold, None), (Mark::Italic, None)]
    );
}
