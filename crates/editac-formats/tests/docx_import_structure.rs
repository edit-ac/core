include!("support/jobs_harness.rs");
use editac_core::{
    commands::lists::ContainerStyle, document::BlockAttributes, modules::content::Content,
};
use editac_formats::{
    container::Budgets,
    docx::import::{self as docx, OriginalMediaHost},
};
use std::io::{Cursor, Write};
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SUPPORTED: &str = include_str!("../../../fixtures/formats/docx/structure/supported.xml");
const NUMBERING: &str = include_str!("../../../fixtures/formats/docx/structure/numbering.xml");
const PIXEL: &[u8] = include_bytes!("../../../fixtures/formats/docx/probe/pixel.png");
fn doc(body: &str) -> String {
    format!(
        r#"<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body}</w:body></w:document>"#
    )
}
fn package(
    document: &str,
    numbering: &str,
    relationships: &str,
    extras: &[(&str, &[u8])],
) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
    let ct = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    let root = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>"#
    );
    let rels = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="numbering" Type="{R}/numbering" Target="numbering.xml"/><Relationship Id="img" Type="{R}/image" Target="media/pixel.png"/><Relationship Id="web" Type="{R}/hyperlink" Target="https://example.test/" TargetMode="External"/>{relationships}</Relationships>"#
    );
    let mut parts = vec![
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/numbering.xml", numbering.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/media/pixel.png", PIXEL),
    ];
    parts.extend_from_slice(extras);
    for (name, bytes) in parts {
        writer
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir).join("structure-inputs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{:x}.docx", Sha256::digest(&bytes))),
            &bytes,
        )
        .unwrap();
    }
    bytes
}
fn input(body: &str) -> Vec<u8> {
    package(&doc(body), NUMBERING, "", &[])
}
fn list(level: u8, id: u32, text: &str) -> String {
    format!(
        r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{id}"/></w:numPr></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"#
    )
}
fn drawing(id: &str) -> String {
    format!(
        r#"<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="image" descr="alt 🙂" title="caption"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="{id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#
    )
}
#[derive(Default)]
struct MediaHost {
    inner: Host,
    originals: Vec<Vec<u8>>,
    fail_ingest: bool,
    collision: bool,
    cancel: Option<Cancellation>,
}
impl AssetHost for MediaHost {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        self.inner.authorize(r)
    }
    fn execute(&mut self, id: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        self.inner.execute(id, r)
    }
}
impl OriginalMediaHost for MediaHost {
    fn identity(&self, hash: &[u8; 32]) -> Result<AssetIdentity, PortError> {
        Ok(AssetIdentity {
            host: "local".into(),
            key: if self.collision {
                "collision".into()
            } else {
                hash.iter().map(|b| format!("{b:02x}")).collect()
            },
        })
    }
    fn ingest_original(
        &mut self,
        id: &str,
        r: &AssetRequest,
        bytes: &[u8],
    ) -> Result<HostOutcome, PortError> {
        assert_eq!(r.action, AssetAction::Ingest);
        assert_eq!(r.byte_limit, bytes.len() as u64);
        self.originals.push(bytes.to_vec());
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        if self.fail_ingest {
            return Err(PortError::Unavailable);
        }
        self.inner.execute(id, r)
    }
}
fn begin(o: &Owner, bytes: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Import);
    s.original = bytes;
    s.profile = docx::STRUCTURE_PROFILE;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut execution = port().0;
    execution.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), execution, 0).unwrap()
}
fn prepared(
    o: &Owner,
    bytes: &[u8],
    host: &mut MediaHost,
) -> (PreparedJob<MemoryStore>, docx::PreparedText) {
    let mut j = begin(o, bytes, "structure");
    let p = docx::prepare_structure(&mut j, Budgets::default(), host, || 0).unwrap();
    (j, p)
}
fn contents(p: &docx::PreparedText) -> Vec<Content> {
    p.blocks()
        .iter()
        .filter_map(|b| {
            if let Some(BlockAttributes::Unknown(t)) = &b.attributes {
                Content::from_tuple(t).unwrap()
            } else {
                None
            }
        })
        .collect()
}
fn has(p: &docx::PreparedText, code: &str) -> bool {
    p.report().diagnostics.iter().any(|d| d.code == code)
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
#[test]
fn explicit_numbering_nesting_starts_and_counter_continuation() {
    let (o, _) = structured_owner();
    let bytes = input(&format!(
        "{}{}{}<w:p><w:r><w:t>gap</w:t></w:r></w:p>{}{}",
        list(0, 7, "three"),
        list(1, 7, "child"),
        list(0, 7, "four"),
        list(0, 7, "five"),
        list(0, 8, "ten")
    ));
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert_eq!(
        p.blocks()[0].containers[0].1,
        ContainerStyle::Ordered { start: 3 }
    );
    assert_eq!(p.blocks()[1].containers.len(), 2);
    assert_eq!(p.blocks()[1].containers[1].1, ContainerStyle::Unordered);
    assert_eq!(p.blocks()[2].containers, p.blocks()[0].containers);
    assert_eq!(
        p.blocks()[4].containers[0].1,
        ContainerStyle::Ordered { start: 5 }
    );
    assert_ne!(p.blocks()[4].containers[0].0, p.blocks()[0].containers[0].0);
    assert_eq!(
        p.blocks()[5].containers[0].1,
        ContainerStyle::Ordered { start: 10 }
    );
    assert!(
        !p.report()
            .diagnostics
            .iter()
            .any(|d| d.code.contains("NUMBERING")),
        "{:?}",
        p.report()
    );
}
#[test]
fn table_exact_cells_marks_links_empty_and_unicode() {
    let (o, _) = structured_owner();
    let bytes = package(SUPPORTED, NUMBERING, "", &[]);
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    let cs = contents(&p);
    let Content::Table {
        rows, alignments, ..
    } = &cs[0]
    else {
        panic!()
    };
    assert_eq!(rows.len(), 2);
    assert_eq!(alignments.len(), 2);
    assert_eq!(rows[0][0][0].text, "A");
    assert_eq!(
        rows[0][0][0].marks[0].0,
        editac_core::commands::format::Mark::Bold
    );
    assert!(rows[0][1].is_empty());
    assert_eq!(rows[1][0][0].text, "e\u{301}🙂");
    assert_eq!(
        rows[1][1][0].marks[0].1.as_deref(),
        Some("https://example.test/")
    );
}
#[test]
fn images_retain_original_bytes_identity_alt_caption_and_hash() {
    let (o, _) = structured_owner();
    let bytes = package(SUPPORTED, NUMBERING, "", &[]);
    let mut h = MediaHost::default();
    let (j, p) = prepared(&o, &bytes, &mut h);
    let cs = contents(&p);
    let Content::Asset { descriptor: d } = &cs[1] else {
        panic!()
    };
    assert_eq!(h.originals, vec![PIXEL.to_vec()]);
    assert_eq!(
        d.identity,
        h.identity(&Sha256::digest(PIXEL).into()).unwrap()
    );
    assert_eq!(
        d.metadata.sha256,
        Some(format!("{:x}", Sha256::digest(PIXEL)))
    );
    assert_eq!(d.metadata.alt, "A & 🙂");
    assert_eq!(d.metadata.caption, "caption");
    assert_eq!(d.metadata.width, Some(1));
    assert_eq!(d.metadata.height, Some(1));
    assert_eq!(d.metadata.byte_length, Some(PIXEL.len() as u64));
    assert_eq!(j.source().original(), bytes);
}
#[test]
fn repeated_image_references_charge_work_but_share_one_staged_identity() {
    let (mut o, _) = structured_owner();
    let bytes = input(&format!("{}{}", drawing("img"), drawing("img")));
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    let cs = contents(&p);
    let (Content::Asset { descriptor: a }, Content::Asset { descriptor: b }) = (&cs[0], &cs[1])
    else {
        panic!()
    };
    assert_eq!(a.identity, b.identity);
    assert_eq!(h.originals.len(), 1);
    assert_eq!(p.report().package_work.media_attempts, 2);
    let c = p.commit(&mut j, &mut o, true, 0).unwrap().unwrap();
    assert_eq!(c.assets.len(), 1);
}
#[test]
fn one_real_commit_undo_redo_reopen_and_original_recovery() {
    let (mut o, store) = structured_owner();
    let bytes = package(SUPPORTED, NUMBERING, "", &[]);
    let before = checkpoint(&o);
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    assert_eq!(checkpoint(&o), before);
    assert!(
        !p.report().diagnostics.iter().any(|d| d.lossy),
        "{:?}",
        p.report()
    );
    let work = p.report().package_work;
    let completion = p.commit(&mut j, &mut o, false, 0).unwrap().unwrap();
    assert_eq!(completion.assets.len(), 1);
    assert_eq!(completion.local_commit.durability, Durability::Volatile);
    let snap = o.service().read(0).unwrap().snapshot;
    assert_eq!(
        snap.visible
            .iter()
            .filter(|n| matches!(&n.block_attributes, Some(BlockAttributes::Unknown(_))))
            .count(),
        2
    );
    assert!(snap.visible.iter().any(|n| n.kind == "list"));
    let imported = |label: &str| {
        snap.visible
            .iter()
            .find(|n| n.runs.iter().map(|r| r.text.as_str()).collect::<String>() == label)
            .unwrap()
    };
    let three = imported("Three");
    let child = imported("nested 🙂");
    let four = imported("Four");
    assert_eq!(three.parent, four.parent);
    assert_eq!(three.editor.as_ref().unwrap().number, Some(3));
    assert_eq!(four.editor.as_ref().unwrap().number, Some(4));
    let inner = snap.visible.iter().find(|n| n.id == child.parent).unwrap();
    assert_eq!(inner.parent, three.parent);
    let imported_content: Vec<_> = snap
        .visible
        .iter()
        .filter_map(|n| {
            if let Some(BlockAttributes::Unknown(tuple)) = &n.block_attributes {
                Content::from_tuple(tuple).unwrap()
            } else {
                None
            }
        })
        .collect();
    let Content::Table { rows, .. } = &imported_content[0] else {
        panic!()
    };
    assert_eq!(rows[1][0][0].text, "e\u{301}🙂");
    let Content::Asset { descriptor } = &imported_content[1] else {
        panic!()
    };
    assert_eq!(descriptor.metadata.alt, "A & 🙂");
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
        ConversionOwner::open(store, &id, CachedPermission::LOCAL, structure_policy()).unwrap();
    assert_eq!(current(&reopened), after);
    let reopened_read = reopened.service().read(0).unwrap();
    let expected: Vec<_> = snap
        .visible
        .iter()
        .filter_map(|n| {
            if matches!(&n.block_attributes, Some(BlockAttributes::Unknown(_))) {
                n.block_attributes.clone()
            } else {
                None
            }
        })
        .collect();
    let actual: Vec<_> = reopened_read
        .snapshot
        .visible
        .iter()
        .filter_map(|n| {
            if matches!(&n.block_attributes, Some(BlockAttributes::Unknown(_))) {
                n.block_attributes.clone()
            } else {
                None
            }
        })
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(j.source().original(), bytes);
    println!(
        "STRUCTURE_COMMIT commits=1 undo=1 redo=1 reopen=1 staged_originals={} bytes={} work={work:?} network_calls=0",
        h.originals.len(),
        bytes.len()
    );
}
#[test]
fn numbering_missing_ancestors_is_structured_failure_not_flattening() {
    let (o, _) = structured_owner();
    let bytes = input(&list(1, 7, "orphan"));
    let mut j = begin(&o, &bytes, "orphan");
    assert_eq!(
        docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
            .err()
            .unwrap()
            .location,
        "numbering-missing-ancestor"
    );
    assert_eq!(current(&o), "base");
}
#[test]
fn unsupported_numbering_formats_require_loss_approval() {
    let (mut o, _) = structured_owner();
    let bytes = package(
        &doc(&list(0, 7, "x")),
        &NUMBERING.replace("decimal", "upperRoman"),
        "",
        &[],
    );
    let (mut j, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_NUMBERING_LEVEL"));
    assert!(has(&p, "UNSUPPORTED_NUMBERING_REFERENCE"));
    assert!(p.commit(&mut j, &mut o, false, 0).is_err());
    assert_eq!(current(&o), "base");
}
#[test]
fn duplicate_numbering_level_and_number_id_fail_closed() {
    let (o, _) = structured_owner();
    for num in [
        NUMBERING.replace("</w:abstractNum>", "<w:lvl w:ilvl=\"0\"/></w:abstractNum>"),
        NUMBERING.replace(
            "</w:numbering>",
            "<w:num w:numId=\"7\"><w:abstractNumId w:val=\"0\"/></w:num></w:numbering>",
        ),
    ] {
        let bytes = package(&doc(&list(0, 7, "x")), &num, "", &[]);
        let mut j = begin(&o, &bytes, "duplicate");
        assert!(
            docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
                .is_err()
        );
        assert_eq!(current(&o), "base");
    }
}
#[test]
fn unknown_numbering_properties_and_restarts_are_reported() {
    let (o, _) = structured_owner();
    let num = NUMBERING.replace(
        "<w:start w:val=\"3\"/>",
        "<w:start w:val=\"3\"/><w:lvlRestart w:val=\"0\"/>",
    );
    let bytes = package(&doc(&list(0, 7, "x")), &num, "", &[]);
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_NUMBERING_PROPERTY"));
    assert!(has(&p, "UNSUPPORTED_NUMBERING_REFERENCE"));
}
#[test]
fn tables_reject_ragged_or_empty_geometry() {
    let (o, _) = structured_owner();
    for body in [
        "<w:tbl/>",
        "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr><w:tr/></w:tbl>",
    ] {
        let bytes = input(body);
        let mut j = begin(&o, &bytes, "ragged");
        assert!(
            docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
                .is_err()
        );
        assert_eq!(current(&o), "base");
    }
}
#[test]
fn merged_tables_and_floating_tables_have_named_diagnostics() {
    let (o, _) = structured_owner();
    for (inner, code) in [
        (
            "<w:tcPr><w:gridSpan w:val=\"2\"/></w:tcPr>",
            "UNSUPPORTED_TABLE_MERGE",
        ),
        ("<w:tcPr><w:vMerge/></w:tcPr>", "UNSUPPORTED_TABLE_MERGE"),
    ] {
        let bytes = input(&format!(
            "<w:p/><w:tbl><w:tr><w:tc>{inner}<w:p/></w:tc></w:tr></w:tbl>"
        ));
        let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
        assert!(has(&p, code));
        assert!(contents(&p).is_empty());
    }
    let bytes = input(
        "<w:p/><w:tbl><w:tblPr><w:tblpPr/></w:tblPr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>",
    );
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_FLOATING_TABLE"));
}
#[test]
fn cell_breaks_and_multiple_paragraphs_are_explicitly_unavailable() {
    let (o, _) = structured_owner();
    for inner in ["<w:p/><w:p/>", "<w:p><w:r><w:br/></w:r></w:p>"] {
        let bytes = input(&format!(
            "<w:p/><w:tbl><w:tr><w:tc>{inner}</w:tc></w:tr></w:tbl>"
        ));
        let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
        assert!(
            has(&p, "UNSUPPORTED_TABLE_CELL_CONTENT") || has(&p, "UNSUPPORTED_TABLE_CELL_BLOCK")
        );
        assert!(contents(&p).is_empty());
    }
}
#[test]
fn table_layout_and_cell_properties_require_diagnostics() {
    let (o, _) = structured_owner();
    let bytes = input(
        "<w:tbl><w:tblPr><w:tblW w:w=\"20\"/></w:tblPr><w:tr><w:tc><w:tcPr><w:shd/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>",
    );
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_TABLE_LAYOUT"));
    assert!(has(&p, "UNSUPPORTED_TABLE_CELL_PROPERTIES"));
}
#[test]
fn table_column_budget_is_enforced_during_mapping() {
    let (o, _) = structured_owner();
    let bytes = input(&format!(
        "<w:tbl><w:tr>{}</w:tr></w:tbl>",
        "<w:tc><w:p/></w:tc>".repeat(33)
    ));
    let mut j = begin(&o, &bytes, "columns");
    assert_eq!(
        docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
            .err()
            .unwrap()
            .location,
        "table-columns"
    );
}
#[test]
fn external_images_and_links_never_dispatch_ingestion() {
    let (o, _) = structured_owner();
    let rel = format!(
        r#"<Relationship Id="remote" Type="{R}/image" Target="https://example.test/private.png" TargetMode="External"/>"#
    );
    let bytes = package(
        &doc(&format!("<w:p/>{}", drawing("remote"))),
        NUMBERING,
        &rel,
        &[],
    );
    let mut h = MediaHost::default();
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert!(has(&p, "EXTERNAL_IMAGE_INERT"));
    assert!(h.originals.is_empty());
    assert!(h.inner.effects.is_empty());
}
#[test]
fn floating_and_inline_mixed_images_are_explicit_not_repositioned() {
    let (o, _) = structured_owner();
    for (drawing, code) in [
        (
            drawing("img").replace("wp:inline", "wp:anchor"),
            "UNSUPPORTED_FLOATING_IMAGE",
        ),
        (
            drawing("img").replace("<w:r><w:drawing>", "<w:r><w:t>prefix</w:t><w:drawing>"),
            "UNSUPPORTED_INLINE_IMAGE_PLACEMENT",
        ),
    ] {
        let bytes = input(&format!("<w:p/>{drawing}"));
        let mut h = MediaHost::default();
        let (_, p) = prepared(&o, &bytes, &mut h);
        assert!(has(&p, code));
        assert!(h.originals.is_empty());
    }
}
#[test]
fn image_cropping_rotation_and_display_geometry_report_loss() {
    let (o, _) = structured_owner();
    let b = drawing("img")
        .replace(
            "<pic:blipFill>",
            "<pic:spPr><a:xfrm rot=\"90\"/></pic:spPr><pic:blipFill><a:srcRect l=\"1\"/>",
        )
        .replace("<wp:inline>", "<wp:inline><wp:extent cx=\"1\" cy=\"1\"/>");
    let bytes = input(&b);
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_IMAGE_TRANSFORM_OR_PROPERTY"));
    assert!(
        contents(&p)
            .iter()
            .any(|c| matches!(c, Content::Asset { .. }))
    );
}
#[test]
fn headers_footnotes_unknown_objects_have_named_recoverable_diagnostics() {
    let (o, _) = structured_owner();
    let bytes = package(
        &doc("<w:p/><w:sectPr/><w:p><w:r><w:object/></w:r></w:p>"),
        NUMBERING,
        "",
        &[
            ("word/header1.xml", b"<header/>"),
            ("word/footnotes.xml", b"<footnotes/>"),
        ],
    );
    let (j, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_HEADER_FOOTER"));
    assert!(has(&p, "UNSUPPORTED_FOOTNOTES"));
    assert!(has(&p, "UNSUPPORTED_SECTION_HEADERS_FOOTERS"));
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.code.ends_with("}object"))
    );
    assert_eq!(j.source().original(), bytes);
}
#[test]
fn rejected_media_after_successful_stage_cannot_partially_commit() {
    let (mut o, store) = structured_owner();
    let rel = format!(r#"<Relationship Id="bad" Type="{R}/image" Target="media/bad.png"/>"#);
    let bytes = package(
        &doc(&format!("{}{}", drawing("img"), drawing("bad"))),
        NUMBERING,
        &rel,
        &[("word/media/bad.png", b"corrupt")],
    );
    let before = checkpoint(&o);
    let mut j = begin(&o, &bytes, "failed-media");
    let mut h = MediaHost::default();
    assert!(docx::prepare_structure(&mut j, Budgets::default(), &mut h, || 0).is_err());
    assert_eq!(h.originals.len(), 1);
    assert_eq!(checkpoint(&o), before);
    assert_eq!(j.source().original(), bytes);
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    clean(&store, &mut h.inner);
    assert_eq!(
        h.inner
            .effects
            .iter()
            .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        2
    );
    println!("STRUCTURE_ASSET_FAILURE live_commits=0 ingest=1 cleanup=2 original_recovery=1");
}
#[test]
fn media_host_denial_or_failed_write_preserves_session_and_cleanup() {
    let (o, store) = structured_owner();
    for deny in [true, false] {
        let bytes = input(&drawing("img"));
        let mut h = MediaHost {
            fail_ingest: !deny,
            ..Default::default()
        };
        h.inner.denied = deny;
        let mut j = begin(&o, &bytes, if deny { "denied" } else { "write-fail" });
        let before = checkpoint(&o);
        assert!(docx::prepare_structure(&mut j, Budgets::default(), &mut h, || 0).is_err());
        assert_eq!(checkpoint(&o), before);
        h.inner.denied = false;
        clean(&store, &mut h.inner);
        assert_eq!(j.source().original(), bytes);
    }
}
#[test]
fn loss_rejection_cleans_owned_media_and_preserves_sibling() {
    let (mut o, store) = structured_owner();
    let bytes = input(&format!("{}<w:sectPr/>", drawing("img")));
    let mut sibling = begin(&o, &bytes, "sibling");
    let mut h = MediaHost::default();
    sibling
        .stage_asset(asset(), AssetAction::Ingest, 4, &mut h, 0)
        .unwrap();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    assert!(p.commit(&mut j, &mut o, false, 0).is_err());
    clean(&store, &mut h.inner);
    assert_eq!(current(&o), "base");
    let cleanup: Vec<_> = h
        .inner
        .effects
        .iter()
        .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
        .collect();
    assert_eq!(cleanup.len(), 2);
    assert!(cleanup.iter().all(|(id, _)| id.starts_with("structure_")));
}
#[test]
fn stale_cancelled_and_expired_structure_jobs_preserve_later_edits() {
    let (mut o, store) = structured_owner();
    let bytes = package(SUPPORTED, NUMBERING, "", &[]);
    for mode in 0..3 {
        let mut h = MediaHost::default();
        let (mut j, p) = prepared(&o, &bytes, &mut h);
        if mode == 0 {
            edit(&mut o, "later")
        } else if mode == 1 {
            j.cancellation().cancel()
        };
        let before = checkpoint(&o);
        assert!(
            p.commit(&mut j, &mut o, false, if mode == 2 { 100 } else { 0 })
                .is_err()
        );
        assert_eq!(checkpoint(&o), before);
        clean(&store, &mut h.inner);
        assert_eq!(j.source().original(), bytes);
    }
}
#[test]
fn output_budget_failure_retires_staging_before_any_commit() {
    let (o, store) = structured_owner();
    let bytes = input(&drawing("img"));
    let mut s = spec(&o, "small-output", Direction::Import);
    s.original = &bytes;
    s.profile = docx::STRUCTURE_PROFILE;
    s.memory_bytes = 32 * 1024 * 1024;
    s.limits.output_bytes = 1;
    let mut execution = port().0;
    execution.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), execution, 0).unwrap();
    let mut h = MediaHost::default();
    assert!(docx::prepare_structure(&mut j, Budgets::default(), &mut h, || 0).is_err());
    assert_eq!(current(&o), "base");
    clean(&store, &mut h.inner);
}
#[test]
fn structure_profile_is_required_and_aggregate_direction_stays_unavailable() {
    let (o, _) = structured_owner();
    let bytes = input("<w:p/>");
    let mut s = spec(&o, "wrong-profile", Direction::Import);
    s.original = &bytes;
    s.profile = docx::TEXT_PROFILE;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    assert_eq!(
        docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
            .err()
            .unwrap()
            .code,
        docx::Code::Profile
    );
    assert!(
        !PROFILES
            .iter()
            .find(|p| p.format == "docx")
            .unwrap()
            .available
    );
}

#[test]
fn cancelled_during_ingest_retires_media_before_commit() {
    let (o, store) = structured_owner();
    let bytes = input(&drawing("img"));
    let mut j = begin(&o, &bytes, "cancel-during-ingest");
    let mut h = MediaHost {
        cancel: Some(j.cancellation()),
        ..Default::default()
    };
    assert!(docx::prepare_structure(&mut j, Budgets::default(), &mut h, || 0).is_err());
    assert_eq!(current(&o), "base");
    assert_eq!(h.originals.len(), 1);
    clean(&store, &mut h.inner);
    assert_eq!(
        h.inner
            .effects
            .iter()
            .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        2
    );
}
#[test]
fn repeated_binary_parts_deduplicate_ingest_and_keep_metadata_per_reference() {
    let (o, _) = structured_owner();
    let rel = format!(r#"<Relationship Id="alias" Type="{R}/image" Target="media/alias.png"/>"#);
    let bytes = package(
        &doc(&format!(
            "{}{}",
            drawing("img"),
            drawing("alias").replace("alt 🙂", "different alt")
        )),
        NUMBERING,
        &rel,
        &[("word/media/alias.png", PIXEL)],
    );
    let mut h = MediaHost::default();
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert_eq!(h.originals.len(), 1);
    let cs = contents(&p);
    let (Content::Asset { descriptor: a }, Content::Asset { descriptor: b }) = (&cs[0], &cs[1])
    else {
        panic!()
    };
    assert_eq!(a.identity, b.identity);
    assert_ne!(a.metadata.alt, b.metadata.alt);
}
#[test]
fn malformed_image_relationships_cannot_stage_or_commit() {
    let (o, _) = structured_owner();
    for body in [
        drawing("missing"),
        drawing("web"),
        drawing("img").replace("r:embed=\"img\"", "r:embed=\"img\" r:link=\"web\""),
    ] {
        let bytes = input(&format!("<w:p/>{body}"));
        let mut j = begin(&o, &bytes, "invalid-relationship");
        let mut h = MediaHost::default();
        let result = docx::prepare_structure(&mut j, Budgets::default(), &mut h, || 0);
        if let Ok(p) = result {
            assert!(has(&p, "EXTERNAL_IMAGE_INERT"));
        }
        assert!(h.originals.is_empty());
        assert_eq!(current(&o), "base");
    }
}

fn structure_policy() -> HostPolicy {
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p
}
fn structured_owner() -> (Owner, Arc<MemoryStore>) {
    let (mut o, s) = owner();
    o.service_mut().set_policy(structure_policy());
    (o, s)
}
#[test]
fn current_host_capability_revocation_rejects_complete_batch_and_retires_media() {
    let (mut o, store) = structured_owner();
    let bytes = package(SUPPORTED, NUMBERING, "", &[]);
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    o.service_mut().set_policy(HostPolicy::default());
    let before = checkpoint(&o);
    assert!(p.commit(&mut j, &mut o, false, 0).is_err());
    assert_eq!(checkpoint(&o), before);
    clean(&store, &mut h.inner);
    assert_eq!(
        h.inner
            .effects
            .iter()
            .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
            .count(),
        2
    );
}

#[test]
fn alternate_picture_alt_and_conflicting_alt_have_explicit_outcomes() {
    let (o, _) = structured_owner();
    for conflict in [false, true] {
        let body=drawing("img").replace("<pic:pic>","<pic:pic><pic:nvPicPr><pic:cNvPr id=\"2\" name=\"pic\" descr=\"picture alt\"/></pic:nvPicPr>");
        let body = if conflict {
            body
        } else {
            body.replace(" descr=\"alt 🙂\"", "")
        };
        let bytes = input(&body);
        let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
        let cs = contents(&p);
        let Content::Asset { descriptor: d } = &cs[0] else {
            panic!()
        };
        assert_eq!(
            d.metadata.alt,
            if conflict { "alt 🙂" } else { "picture alt" }
        );
        assert_eq!(has(&p, "UNSUPPORTED_CONFLICTING_ALT_TEXT"), conflict);
    }
}
#[test]
fn unknown_graphic_branch_and_nonzero_image_spacing_are_diagnosed() {
    let (o, _) = structured_owner();
    let bytes = input(&format!(
        "<w:p/>{}",
        drawing("img").replace(
            "uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"",
            "uri=\"urn:unqualified-object\""
        )
    ));
    let mut h = MediaHost::default();
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert!(has(&p, "UNSUPPORTED_IMAGE_OBJECT"));
    assert!(h.originals.is_empty());
    let bytes = input(&drawing("img").replace("<wp:inline>", "<wp:inline distT=\"1\">"));
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert!(has(&p, "UNSUPPORTED_IMAGE_SPACING"));
}

#[test]
fn duplicate_numpr_cannot_hide_second_numbering_semantics() {
    let (o, _) = structured_owner();
    let body = list(0, 7, "x").replace(
        "</w:pPr>",
        "<w:numPr><w:numId w:val=\"8\"/></w:numPr></w:pPr>",
    );
    let bytes = input(&body);
    let mut j = begin(&o, &bytes, "duplicate-numpr");
    assert!(
        docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
            .is_err()
    );
}
#[test]
fn scalar_numbering_fields_cannot_hide_nested_xml() {
    let (o, _) = structured_owner();
    let num = NUMBERING.replace(
        "<w:abstractNumId w:val=\"0\"/>",
        "<w:abstractNumId w:val=\"0\"><w:unsupported/></w:abstractNumId>",
    );
    let bytes = package(&doc(&list(0, 7, "x")), &num, "", &[]);
    let mut j = begin(&o, &bytes, "scalar-num");
    assert!(
        docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
            .is_err()
    );
}
#[test]
fn duplicate_cell_properties_cannot_hide_unsupported_layout() {
    let (o, _) = structured_owner();
    let bytes =
        input("<w:tbl><w:tr><w:tc><w:tcPr/><w:tcPr><w:shd/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>");
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(has(&p, "UNSUPPORTED_TABLE_CELL_PROPERTIES"));
}
