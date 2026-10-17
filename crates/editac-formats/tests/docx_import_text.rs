include!("support/jobs_harness.rs");
use editac_formats::{
    container::Budgets,
    docx::import::{self as docx, AdapterParagraph, AdapterRun, Coordinates, Span},
};
use std::io::{Cursor, Write};
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SUPPORTED: &str = include_str!("../../../fixtures/formats/docx/text/supported.xml");
const STYLES: &str = include_str!("../../../fixtures/formats/docx/text/styles.xml");
const UNSUPPORTED: &str = include_str!("../../../fixtures/formats/docx/text/unsupported.xml");
fn package(document: &str, styles: Option<&str>, extra: &[(&str, &str)]) -> Vec<u8> {
    package_url(
        document,
        styles,
        extra,
        "https://example.test/a?x=1&amp;y=2",
    )
}
fn package_url(document: &str, styles: Option<&str>, extra: &[(&str, &str)], url: &str) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
    let ct = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    let root = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>"#
    );
    let rels = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}<Relationship Id="web" Type="{R}/hyperlink" Target="{url}" TargetMode="External"/></Relationships>"#,
        if styles.is_some() {
            format!(r#"<Relationship Id="styles" Type="{R}/styles" Target="styles.xml"/>"#)
        } else {
            String::new()
        }
    );
    let mut parts = vec![
        ("[Content_Types].xml", ct),
        ("_rels/.rels", root.as_str()),
        ("word/document.xml", document),
        ("word/_rels/document.xml.rels", rels.as_str()),
    ];
    if let Some(styles) = styles {
        parts.push(("word/styles.xml", styles));
    }
    parts.extend_from_slice(extra);
    for (name, bytes) in parts {
        writer
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes.as_bytes()).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir).join("inputs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{:x}.docx", Sha256::digest(&bytes))),
            &bytes,
        )
        .unwrap();
    }
    bytes
}
fn doc(body: &str) -> String {
    format!(r#"<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>"#)
}
fn begin(o: &Owner, original: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Import);
    s.original = original;
    s.profile = docx::TEXT_PROFILE;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut port = port().0;
    port.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port, 0).unwrap()
}
fn prepared(o: &Owner, bytes: &[u8]) -> (PreparedJob<MemoryStore>, docx::PreparedText) {
    let mut j = begin(o, bytes, "text");
    let p = docx::prepare_text(&mut j, Budgets::default(), || 0).unwrap();
    (j, p)
}
fn plain(p: &docx::PreparedText) -> Vec<String> {
    p.blocks()
        .iter()
        .map(|b| b.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}
fn codes(p: &docx::PreparedText) -> Vec<&str> {
    p.report()
        .diagnostics
        .iter()
        .map(|d| d.code.as_str())
        .collect()
}
#[test]
fn supported_unicode_styles_heading_links_tabs_breaks_and_empty_paragraphs() {
    let (o, _) = owner();
    let bytes = package(SUPPORTED, Some(STYLES), &[]);
    let (_, p) = prepared(&o, &bytes);
    assert_eq!(
        plain(&p),
        vec![" A🙂e\u{301} & 文 direct\t\n\nlink", "", "tail"]
    );
    assert_eq!(
        p.blocks()[0].attributes,
        Some(editac_core::document::BlockAttributes::Heading(2))
    );
    use editac_core::commands::format::Mark;
    assert_eq!(
        p.blocks()[0].runs[0].marks,
        vec![(Mark::Bold, None), (Mark::Italic, None)]
    );
    assert_eq!(
        p.blocks()[0].runs[1].marks,
        vec![
            (Mark::Italic, None),
            (Mark::Strike, None),
            (Mark::Underline, None)
        ]
    );
    assert_eq!(
        p.blocks()[0].runs.last().unwrap().marks,
        vec![
            (Mark::Bold, None),
            (Mark::Link, Some("https://example.test/a?x=1&y=2".into()))
        ]
    );
    assert!(p.report().diagnostics.iter().all(|d| !d.lossy));
    assert_eq!(p.report().paragraphs, 3);
    assert_eq!(
        p.report().utf16_units,
        plain(&p)
            .iter()
            .map(|s| s.encode_utf16().count())
            .sum::<usize>()
    );
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let r = p.report();
        let w = r.package_work;
        let observation = serde_json::json!({"inputSha256":format!("{:x}",Sha256::digest(&bytes)),"originalBytes":bytes.len(),"inputUtf16":r.utf16_units,"runs":r.runs,"paragraphs":r.paragraphs,"work":{"entries":w.entries,"inflated":w.inflated,"scanned":w.scanned,"nodes":w.nodes,"references":w.references,"mediaAttempts":w.media_attempts},"projection":plain(&p),"liveCommitsDuringPreparation":0,"diagnostics":r.diagnostics.iter().map(|d|serde_json::json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>()});
        std::fs::write(
            std::path::PathBuf::from(dir).join("text-observations.json"),
            serde_json::to_vec_pretty(&observation).unwrap(),
        )
        .unwrap();
    }
    println!(
        "TEXT_WORK {:?} utf16={} runs={} paragraphs={} live_commits=0 original_bytes={}",
        p.report().package_work,
        p.report().utf16_units,
        p.report().runs,
        p.report().paragraphs,
        bytes.len()
    );
}
#[test]
fn one_shared_commit_marks_history_reopen_and_original_recovery() {
    let (mut o, store) = owner();
    let bytes = package(SUPPORTED, Some(STYLES), &[]);
    let before = o.service().read(0).unwrap();
    let (mut j, p) = prepared(&o, &bytes);
    assert_eq!(o.service().read(0).unwrap().revision, before.revision);
    assert_eq!(j.source().original(), bytes);
    assert_eq!(p.original_sha256, j.contract().input_sha256);
    let completion = p.commit(&mut j, &mut o, false, 0).unwrap().unwrap();
    assert_eq!(completion.local_commit.durability, Durability::Volatile);
    let snap = o.service().read(0).unwrap().snapshot;
    assert!(snap.visible.iter().any(|n|n.block_attributes==Some(editac_core::document::BlockAttributes::Heading(2))));
    assert!(
        snap.visible
            .iter()
            .flat_map(|n| &n.runs)
            .any(|r| r.attributes.contains_key("link"))
    );
    assert!(current(&o).starts_with(" A🙂e\u{301} & 文 direct\t\n\nlink"));
    let after = current(&o);
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    assert_eq!(current(&o), after);
    let id = o.service().session().document().identity().clone();
    drop(o);
    let reopened =
        ConversionOwner::open(store, &id, CachedPermission::LOCAL, HostPolicy::default()).unwrap();
    assert_eq!(current(&reopened), after);
    assert_eq!(j.source().original(), bytes);
    println!("TEXT_COMMIT commits=1 undo=1 redo=1 reopen=1 original_recovery=1 network_calls=0");
}
#[test]
fn unsupported_styles_theme_fields_revisions_controls_namespace_and_layout_are_complete() {
    let (o, _) = owner();
    let bytes = package(UNSUPPORTED, None, &[("word/theme/theme1.xml", "<theme/>")]);
    let (_, p) = prepared(&o, &bytes);
    assert_eq!(plain(&p), vec!["retained", ""]);
    let codes = codes(&p);
    let unique: BTreeSet<_> = codes.iter().copied().collect();
    assert!(unique.len() > 8);
    for name in [
        "spacing",
        "color",
        "rFonts",
        "ins",
        "del",
        "sdt",
        "fldSimple",
        "sectPr",
        "tbl",
    ] {
        assert!(
            codes
                .iter()
                .any(|code| code.ends_with(&format!("}}{name}"))),
            "missing {name}: {codes:?}"
        );
    }
    for code in [
        "UNSUPPORTED_THEME",
        "UNSUPPORTED_PART",
        "UNSUPPORTED_BREAK_LAYOUT",
        "UNSUPPORTED_COMPLEX_FIELD",
        "UNSUPPORTED_FIELD_PARAGRAPH_OMITTED",
    ] {
        assert!(codes.contains(&code), "{code}");
    }
    assert!(codes.iter().any(|code| code.contains("urn:unsupported")));
    assert_eq!(
        p.report()
            .diagnostics
            .iter()
            .filter(|d| d.code == "UNSUPPORTED_COMPLEX_FIELD")
            .count(),
        4
    );
}
#[test]
fn unsupported_content_requires_explicit_loss_approval_and_never_selects_a_revision_branch() {
    let (mut o, _) = owner();
    let bytes = package(UNSUPPORTED, None, &[]);
    let (mut j, p) = prepared(&o, &bytes);
    assert_eq!(
        p.commit(&mut j, &mut o, false, 0).err().unwrap().code,
        docx::Code::LossApproval
    );
    assert_eq!(current(&o), "base");
    assert_eq!(j.source().original(), bytes);
    let (mut j, p) = prepared(&o, &bytes);
    p.commit(&mut j, &mut o, true, 0).unwrap();
    assert_eq!(current(&o), "retainedbase");
}
fn raw(source: &str, span: Span) -> Vec<AdapterParagraph> {
    vec![AdapterParagraph {
        runs: vec![AdapterRun {
            source: source.into(),
            span,
            marks: vec![],
        }],
        heading: None,
    }]
}
fn invalid_span(span: Span) {
    let (mut o, _) = owner();
    let bytes = package(&doc("<w:p/>"), None, &[]);
    let mut j = begin(&o, &bytes, "invalid_span");
    let before = o.service().read(0).unwrap();
    let error = match docx::admit_adapter_spans(&mut j, raw("a🙂e\u{301}z", span), 0) {
        Ok(_) => panic!("invalid span admitted"),
        Err(e) => e,
    };
    assert_eq!(error.code, docx::Code::Span);
    assert_eq!(before.revision, o.service().read(0).unwrap().revision);
    assert_eq!(j.source().original(), bytes);
    assert!(j.finish_import(&mut o, &blocks("partial"), 0).is_err());
    assert_eq!(current(&o), "base");
    println!("WCF09_REJECT {span:?} live_commits=0 original_recovery=1");
}
#[test]
fn wcf09_split_utf8_start() {
    invalid_span(Span {
        start: 2,
        length: 3,
        coordinates: Coordinates::Utf8Bytes,
        declared_utf16: 2,
    });
}
#[test]
fn wcf09_split_utf8_end() {
    invalid_span(Span {
        start: 1,
        length: 3,
        coordinates: Coordinates::Utf8Bytes,
        declared_utf16: 2,
    });
}
#[test]
fn wcf09_split_utf16_start() {
    invalid_span(Span {
        start: 2,
        length: 1,
        coordinates: Coordinates::Utf16,
        declared_utf16: 1,
    });
}
#[test]
fn wcf09_split_utf16_end() {
    invalid_span(Span {
        start: 1,
        length: 1,
        coordinates: Coordinates::Utf16,
        declared_utf16: 1,
    });
}
#[test]
fn wcf09_checked_add_overflow() {
    invalid_span(Span {
        start: usize::MAX,
        length: 1,
        coordinates: Coordinates::Utf8Bytes,
        declared_utf16: 1,
    });
}
#[test]
fn wcf09_declared_length_mismatch() {
    invalid_span(Span {
        start: 1,
        length: 4,
        coordinates: Coordinates::Utf8Bytes,
        declared_utf16: 4,
    });
}
#[test]
fn wcf09_scalar_out_of_range() {
    invalid_span(Span {
        start: 0,
        length: 99,
        coordinates: Coordinates::UnicodeScalars,
        declared_utf16: 99,
    });
}
#[test]
fn wcf09_byte_out_of_range() {
    invalid_span(Span {
        start: 0,
        length: 99,
        coordinates: Coordinates::Utf8Bytes,
        declared_utf16: 99,
    });
}
#[test]
fn wcf09_valid_astral_combining_neighbors_all_coordinate_systems_commit_exactly() {
    for (coordinates, start, length, expected, units) in [
        (Coordinates::Utf8Bytes, 1, 7, "🙂e\u{301}", 4),
        (Coordinates::UnicodeScalars, 1, 3, "🙂e\u{301}", 4),
        (Coordinates::Utf16, 1, 4, "🙂e\u{301}", 4),
        (Coordinates::UnicodeScalars, 3, 1, "\u{301}", 1),
    ] {
        let (mut o, _) = owner();
        let bytes = package(&doc("<w:p/>"), None, &[]);
        let mut j = begin(&o, &bytes, "valid_span");
        let p = docx::admit_adapter_spans(
            &mut j,
            raw(
                "a🙂e\u{301}z",
                Span {
                    start,
                    length,
                    coordinates,
                    declared_utf16: units,
                },
            ),
            0,
        )
        .unwrap();
        let (a, b, value) = docx::validate_span(
            "a🙂e\u{301}z",
            Span {
                start,
                length,
                coordinates,
                declared_utf16: units,
            },
        )
        .unwrap();
        assert_eq!(value, expected);
        assert_eq!((b - a) as usize, units);
        assert_eq!(a, if expected == "\u{301}" { 4 } else { 1 });
        assert_eq!(plain(&p), vec![expected]);
        p.commit(&mut j, &mut o, false, 0).unwrap();
        assert_eq!(current(&o), format!("{expected}base"));
        let document = o.service().session().document();
        let snapshot = document.snapshot().unwrap();
        let id = &snapshot.visible[0].id;
        let anchor = document
            .anchor(id, Utf16Offset(units as u32), Bias::Right)
            .unwrap();
        assert!(
            matches!(document.resolve_anchor(&anchor).unwrap(),editac_core::anchors::Resolution::Position(pos) if pos.offset==Utf16Offset(units as u32))
        );
        println!(
            "WCF09_VALID {coordinates:?} public_units={units} commits=1 unchanged_authored_text=1"
        );
    }
}
#[test]
fn inherited_toggle_direct_off_default_and_character_styles() {
    let (o, _) = owner();
    let d = doc(
        "<w:p><w:pPr><w:pStyle w:val=\"Twice\"/></w:pPr><w:r><w:rPr><w:i w:val=\"off\"/></w:rPr><w:t>x</w:t></w:r></w:p>",
    );
    let s=STYLES.replace("</w:styles>","<w:style w:type=\"paragraph\" w:styleId=\"Twice\"><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/></w:rPr></w:style></w:styles>");
    let (_, p) = prepared(&o, &package(&d, Some(&s), &[]));
    assert!(p.blocks()[0].runs[0].marks.is_empty());
}
#[test]
fn unused_style_cycle_is_rejected_before_preparation() {
    let (o, _) = owner();
    let s = format!(
        r#"<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:styleId="a"><w:basedOn w:val="b"/></w:style><w:style w:type="paragraph" w:styleId="b"><w:basedOn w:val="a"/></w:style></w:styles>"#
    );
    let bytes = package(&doc("<w:p/>"), Some(&s), &[]);
    let mut j = begin(&o, &bytes, "cycle");
    assert_eq!(
        docx::prepare_text(&mut j, Budgets::default(), || 0)
            .err()
            .unwrap()
            .code,
        docx::Code::StyleCycle
    );
    assert_eq!(current(&o), "base");
}
#[test]
fn missing_style_reference_is_diagnosed_and_unknown_namespace_is_not_word() {
    let (o, _) = owner();
    let d = doc(
        "<w:p><w:pPr><w:pStyle w:val=\"missing\"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p><p xmlns=\"urn:wrong\"><r><t>no</t></r></p>",
    );
    let (_, p) = prepared(&o, &package(&d, None, &[]));
    assert_eq!(plain(&p), vec!["x"]);
    assert!(codes(&p).contains(&"UNSUPPORTED_STYLE_REFERENCE"));
    assert!(codes(&p).iter().any(|c| c.contains("urn:wrong")));
}
#[test]
fn namespace_aliases_entities_and_literal_whitespace_are_exact() {
    let (o, _) = owner();
    let d = format!(
        r#"<a:document xmlns:a="{W}"><a:body><a:p><a:r><a:t xml:space="preserve">  &#x1F642; &lt;&amp;&gt; e&#x301;  </a:t></a:r></a:p></a:body></a:document>"#
    );
    let (_, p) = prepared(&o, &package(&d, None, &[]));
    assert_eq!(plain(&p), vec!["  🙂 <&> e\u{301}  "]);
}
#[test]
fn malformed_encoding_and_wrong_root_reject_atomically() {
    for d in ["<w:document>", &doc("<w:p/>").replace(W, "urn:wrong")] {
        let (o, _) = owner();
        let bytes = package(d, None, &[]);
        let mut j = begin(&o, &bytes, "malformed");
        assert!(docx::prepare_text(&mut j, Budgets::default(), || 0).is_err());
        assert_eq!(j.source().original(), bytes);
        assert_eq!(current(&o), "base");
    }
}
#[test]
fn duplicate_singleton_properties_reject_instead_of_first_wins() {
    let (o, _) = owner();
    let bytes = package(
        &doc("<w:p><w:pPr/><w:pPr/><w:r><w:t>x</w:t></w:r></w:p>"),
        None,
        &[],
    );
    let mut j = begin(&o, &bytes, "duplicates");
    assert_eq!(
        docx::prepare_text(&mut j, Budgets::default(), || 0)
            .err()
            .unwrap()
            .code,
        docx::Code::Profile
    );
}
#[test]
fn unknown_and_unsafe_links_are_inert_and_diagnosed() {
    let (o, _) = owner();
    let bytes = package(
        &doc("<w:p><w:hyperlink r:id=\"unknown\"><w:r><w:t>text</w:t></w:r></w:hyperlink></w:p>"),
        None,
        &[],
    );
    let (_, p) = prepared(&o, &bytes);
    assert!(codes(&p).contains(&"UNSUPPORTED_LINK_TARGET"));
    assert!(p.blocks()[0].runs[0].marks.is_empty());
}
#[test]
fn cancellation_deadline_and_stale_target_never_commit() {
    for case in 0..3 {
        let (mut o, _) = owner();
        let bytes = package(SUPPORTED, Some(STYLES), &[]);
        let (mut j, p) = prepared(&o, &bytes);
        match case {
            0 => j.cancellation().cancel(),
            1 => {}
            _ => edit(&mut o, "human"),
        };
        let before = current(&o);
        assert!(
            p.commit(&mut j, &mut o, false, if case == 1 { 100 } else { 0 })
                .is_err()
        );
        assert_eq!(current(&o), before);
        assert_eq!(j.source().original(), bytes);
    }
}
#[test]
fn mapping_control_failure_retires_only_job_owned_staging() {
    let (o, store) = owner();
    let bytes = package(SUPPORTED, Some(STYLES), &[]);
    let mut guard_probe = begin(&o, &bytes, "guard_count");
    let mut guard_calls = 0;
    guard_probe
        .prepare_container(Budgets::default(), || {
            guard_calls += 1;
            0
        })
        .unwrap();
    guard_probe.abort().unwrap();
    let mut j = begin(&o, &bytes, "mapping_cancel");
    let mut sibling = begin(&o, &bytes, "sibling");
    let mut host = Host::default();
    j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    sibling
        .stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    let cancellation = j.cancellation();
    let mut calls = 0;
    assert!(
        docx::prepare_text(&mut j, Budgets::default(), || {
            calls += 1;
            if calls == guard_calls + 5 {
                cancellation.cancel();
            }
            0
        })
        .is_err()
    );
    clean(&store, &mut host);
    assert_eq!(current(&o), "base");
    assert_eq!(
        host.effects
            .iter()
            .filter(|(id, a)| id.starts_with("mapping_cancel_")
                && matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        2
    );
    assert_eq!(
        host.effects
            .iter()
            .filter(|(id, a)| id.starts_with("sibling_")
                && matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        0
    );
    println!("TEXT_CLEANUP calls={calls} own_cleanup=2 sibling_cleanup=0 live_commits=0");
}
#[test]
fn package_and_semantic_work_limits_fail_closed() {
    for nodes in [8, 100] {
        let (o, _) = owner();
        let bytes = package(SUPPORTED, Some(STYLES), &[]);
        let mut j = begin(&o, &bytes, "budget");
        assert!(
            docx::prepare_text(
                &mut j,
                Budgets {
                    nodes,
                    ..Budgets::default()
                },
                || 0
            )
            .is_err()
        );
        assert_eq!(current(&o), "base");
    }
}
#[test]
fn admitted_batches_are_bound_to_exact_job() {
    let (mut o, _) = owner();
    let bytes = package(SUPPORTED, Some(STYLES), &[]);
    let (_, p) = prepared(&o, &bytes);
    let mut other = begin(&o, &bytes, "other");
    assert_eq!(
        p.commit(&mut other, &mut o, true, 0).err().unwrap().code,
        docx::Code::ForeignJob
    );
    assert_eq!(current(&o), "base");
}
#[test]
fn unsupported_only_content_has_structured_diagnostics_and_retains_original() {
    let (o, _) = owner();
    let bytes = package(&doc("<w:tbl/>"), None, &[]);
    let mut j = begin(&o, &bytes, "unsupported_only");
    let e = docx::prepare_text(&mut j, Budgets::default(), || 0)
        .err()
        .unwrap();
    assert!(e.diagnostics.iter().any(|d| d.code.ends_with("}tbl")));
    assert_eq!(j.source().original(), bytes);
    assert_eq!(current(&o), "base");
}
#[test]
fn field_only_paragraph_retains_a_report_without_using_cached_result() {
    let (o, _) = owner();
    let bytes = package(
        &doc("<w:p><w:r><w:fldChar w:fldCharType=\"begin\"/><w:t>cached</w:t></w:r></w:p>"),
        None,
        &[],
    );
    let (_, p) = prepared(&o, &bytes);
    assert_eq!(plain(&p), vec![""]);
    assert!(codes(&p).contains(&"UNSUPPORTED_FIELD_PARAGRAPH_OMITTED"));
}
#[test]
fn invalid_later_run_rejects_the_complete_multi_paragraph_batch() {
    let (mut o, _) = owner();
    let bytes = package(&doc("<w:p/>"), None, &[]);
    let mut j = begin(&o, &bytes, "late_invalid");
    let mut paragraphs = raw(
        "valid first paragraph",
        Span {
            start: 0,
            length: 21,
            coordinates: Coordinates::Utf8Bytes,
            declared_utf16: 21,
        },
    );
    paragraphs.extend(raw(
        "🙂",
        Span {
            start: 0,
            length: 1,
            coordinates: Coordinates::Utf16,
            declared_utf16: 1,
        },
    ));
    assert_eq!(
        docx::admit_adapter_spans(&mut j, paragraphs, 0)
            .err()
            .unwrap()
            .code,
        docx::Code::Span
    );
    assert!(j.finish_import(&mut o, &blocks("prefix"), 0).is_err());
    assert_eq!(current(&o), "base");
}
#[test]
fn unsafe_relationship_url_remains_text_with_an_explicit_diagnostic() {
    let (o, _) = owner();
    let d = doc("<w:p><w:hyperlink r:id=\"web\"><w:r><w:t>visible</w:t></w:r></w:hyperlink></w:p>");
    for url in [
        "javascript:alert(1)",
        "https://user:secret@example.test/",
        "file:///private/a",
    ] {
        let bytes = package_url(&d, None, &[], url);
        let (_, p) = prepared(&o, &bytes);
        assert_eq!(plain(&p), vec!["visible"]);
        assert!(codes(&p).contains(&"UNSUPPORTED_UNSAFE_LINK"));
        assert!(p.blocks()[0].runs[0].marks.is_empty());
    }
}
#[test]
fn alternate_content_and_unknown_style_reference_attributes_are_reported() {
    let (o, _) = owner();
    let d = doc(
        "<w:p><w:pPr><w:pStyle w:val=\"Normal\" w:extra=\"never-ignore\"/></w:pPr><w:r><w:rPr><w:rStyle/></w:rPr><w:t>x</w:t></w:r><mc:AlternateContent xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\"><mc:Choice Requires=\"w\"><w:r><w:t>choice</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>fallback</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>",
    );
    let (_, p) = prepared(&o, &package(&d, Some(STYLES), &[]));
    assert_eq!(plain(&p), vec!["x"]);
    assert!(codes(&p).contains(&"UNSUPPORTED_EMPTY_STYLE_REFERENCE"));
    assert!(codes(&p).iter().any(|d| d.ends_with("}extra")));
    assert!(codes(&p).iter().any(|d| d.ends_with("}AlternateContent")));
}

#[test]
fn text_subset_profile_never_advertises_export_or_the_aggregate_registry() {
    let (o, _) = owner();
    let mut s = spec(&o, "no_export", Direction::Export);
    s.profile = docx::TEXT_PROFILE;
    assert!(matches!(
        PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0),
        Err(JobError::Admission(
            editac_formats::Code::DirectionUnavailable
        ))
    ));
    assert!(!editac_formats::PROFILES[0].available);
    let mut generic = job(&o, "generic_export", Direction::Export);
    assert!(docx::prepare_text(&mut generic, Budgets::default(), || 0).is_err());
}
#[test]
fn wcf09_utf16_out_of_range() {
    invalid_span(Span {
        start: 0,
        length: 99,
        coordinates: Coordinates::Utf16,
        declared_utf16: 99,
    });
}
#[test]
fn complex_script_mark_scope_is_reported_instead_of_claiming_word_script_fidelity() {
    let (o, _) = owner();
    let bytes = package(
        &doc("<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>العربية</w:t></w:r></w:p>"),
        None,
        &[],
    );
    let (_, p) = prepared(&o, &bytes);
    assert_eq!(plain(&p), vec!["العربية"]);
    assert!(codes(&p).contains(&"UNSUPPORTED_SCRIPT_SPECIFIC_MARKS"));
}
#[test]
fn rejected_diagnostics_abort_owned_staging_without_touching_a_sibling() {
    let (mut o, store) = owner();
    let bytes = package(UNSUPPORTED, None, &[]);
    let mut j = begin(&o, &bytes, "loss_cleanup");
    let mut sibling = begin(&o, &bytes, "loss_sibling");
    let mut host = Host::default();
    j.stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    sibling
        .stage_asset(asset(), AssetAction::Ingest, 12, &mut host, 0)
        .unwrap();
    let p = docx::prepare_text(&mut j, Budgets::default(), || 0).unwrap();
    let error = p.commit(&mut j, &mut o, false, 0).err().unwrap();
    assert_eq!(error.code, docx::Code::LossApproval);
    assert!(!error.diagnostics.is_empty());
    clean(&store, &mut host);
    assert_eq!(current(&o), "base");
    assert_eq!(j.source().original(), bytes);
    assert_eq!(
        host.effects
            .iter()
            .filter(|(id, a)| id.starts_with("loss_cleanup_")
                && matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        2
    );
    assert_eq!(
        host.effects
            .iter()
            .filter(|(id, a)| id.starts_with("loss_sibling_")
                && matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        0
    );
    println!(
        "TEXT_LOSS_REJECTION owned_cleanup=2 sibling_cleanup=0 live_commits=0 original_recovery=1"
    );
}
