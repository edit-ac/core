use editac_core::{commands::format::Mark, document::BlockAttributes, modules::content::Content};
use editac_markdown::{
    FragmentBlock, FragmentRun,
    extensions::{self, Extension},
    import::{ImportError, PreparedContent},
    optional::Codecs,
};
struct Badge;
impl Extension for Badge {
    fn name(&self) -> &str {
        "badge"
    }
    fn import(&self, p: &PreparedContent) -> Result<Option<Vec<FragmentBlock>>, ImportError> {
        Ok(p.source.strip_prefix("[badge] ").map(|text| {
            vec![FragmentBlock {
                attributes: Some(BlockAttributes::Heading(2)),
                runs: vec![FragmentRun {
                    text: text.into(),
                    marks: vec![(Mark::Bold, None)],
                }],
                containers: vec![],
                checked: None,
            }]
        }))
    }
    fn export(&self, b: &[FragmentBlock]) -> Option<String> {
        if b.len() == 1 && b[0].attributes == Some(BlockAttributes::Heading(2)) {
            Some(format!(
                "[badge] {}",
                b[0].runs
                    .iter()
                    .map(|r| r.text.as_str())
                    .collect::<String>()
            ))
        } else {
            None
        }
    }
}
#[test]
fn custom_import_export_is_portable_and_source_exact() {
    let p = extensions::import("[badge] é😀", Codecs::default(), &[&Badge]).unwrap();
    assert_eq!(p.source, "[badge] é😀");
    assert_eq!(p.blocks[0].attributes, Some(BlockAttributes::Heading(2)));
    let e = extensions::export(&p.blocks, &[&Badge]).unwrap();
    assert_eq!(e.markdown, p.source);
    assert!(e.diagnostics.is_empty());
}
#[test]
fn five_github_callout_types_preserve_body_and_round_trip() {
    for kind in ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] {
        let raw = format!("> [!{kind}]\n> **rich** é😀\n>\n> - list\n");
        let p = extensions::import(
            &raw,
            Codecs {
                callouts: true,
                ..Codecs::default()
            },
            &[],
        )
        .unwrap();
        assert_eq!(p.blocks.len(), 1);
        let Some(BlockAttributes::Unknown(t)) = &p.blocks[0].attributes else {
            panic!("callout descriptor")
        };
        let Some(Content::Callout {
            kind: k,
            body,
            source,
        }) = Content::from_tuple(t).unwrap()
        else {
            panic!()
        };
        assert_eq!(k, kind);
        assert_eq!(source, raw);
        assert!(body.contains("**rich**"));
        let e = extensions::export(&p.blocks, &[]).unwrap();
        assert!(e.diagnostics.is_empty(), "{e:?}");
        assert_eq!(e.markdown, raw);
    }
}
#[test]
fn disabled_callout_and_unknown_kind_keep_source_and_quote_semantics() {
    let raw = "> [!NOTE]\n> body\n";
    let p = extensions::import(raw, Codecs::default(), &[]).unwrap();
    assert_eq!(p.source, raw);
    assert!(
        p.diagnostics
            .iter()
            .any(|d| d.code == "callout-codec-disabled")
    );
    let p = extensions::import(
        "> [!ALIEN]\n> body",
        Codecs {
            callouts: true,
            ..Codecs::default()
        },
        &[],
    )
    .unwrap();
    assert_eq!(p.blocks[0].attributes, Some(BlockAttributes::Paragraph));
}
#[test]
fn duplicate_names_and_oversized_outputs_rejected() {
    assert!(extensions::import("x", Codecs::default(), &[&Badge, &Badge]).is_err());
    struct Huge;
    impl Extension for Huge {
        fn name(&self) -> &str {
            "huge"
        }
        fn import(&self, _: &PreparedContent) -> Result<Option<Vec<FragmentBlock>>, ImportError> {
            Ok(Some(vec![FragmentBlock {
                runs: vec![FragmentRun {
                    text: "x".repeat(1_048_577),
                    marks: vec![],
                }],
                attributes: Some(BlockAttributes::Paragraph),
                containers: vec![],
                checked: None,
            }]))
        }
    }
    assert_eq!(
        extensions::import("x", Codecs::default(), &[&Huge]).unwrap_err(),
        ImportError::ResourceLimit
    );
}
#[test]
fn unsafe_marks_and_false_lossless_export_never_qualify() {
    let mut p = extensions::import("[badge] safe", Codecs::default(), &[&Badge]).unwrap();
    p.blocks[0].runs[0].marks = vec![(Mark::Link, Some("javascript:alert(1)".into()))];
    assert!(extensions::export(&p.blocks, &[]).is_err());
    struct Wrong;
    impl Extension for Wrong {
        fn name(&self) -> &str {
            "wrong"
        }
        fn export(&self, _: &[FragmentBlock]) -> Option<String> {
            Some("lost".into())
        }
    }
    let p = extensions::import("**safe**", Codecs::default(), &[]).unwrap();
    let e = extensions::export(&p.blocks, &[&Wrong]).unwrap();
    assert_eq!(e.diagnostics[0].code, "extension-unrepresentable");
    assert!(!e.recovery.is_empty());
}
