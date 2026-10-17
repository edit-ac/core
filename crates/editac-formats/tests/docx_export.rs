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
    let rels = if document.contains("r:embed=\"img\"") {
        rels
    } else {
        rels.replace(
            &format!(r#"<Relationship Id="img" Type="{R}/image" Target="media/pixel.png"/>"#),
            "",
        )
    };
    let mut parts = vec![
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/numbering.xml", numbering.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/media/pixel.png", PIXEL),
    ];
    if !document.contains("r:embed=\"img\"") {
        parts.retain(|(name, _)| *name != "word/media/pixel.png");
    }
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
    read_bytes: Option<Vec<u8>>,
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
use editac_formats::docx::export::{self as writer, OriginalAssetHost, Provenance};
impl OriginalAssetHost for MediaHost {
    fn read_original(&mut self, r: &AssetRequest) -> Result<Vec<u8>, PortError> {
        if self.fail_ingest {
            return Err(PortError::Unavailable);
        }
        if let Some(c) = &self.cancel {
            c.cancel();
        }
        self.inner.effects.push((r.operation_id.clone(), r.action));
        Ok(self.read_bytes.clone().unwrap_or_else(|| PIXEL.to_vec()))
    }
}
fn export_job(o: &Owner, original: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Export);
    s.profile = writer::PROFILE;
    s.original = original;
    s.target = None;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut p = port().0;
    p.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), p, 0).unwrap()
}
fn imported(body: &str) -> (Owner, Arc<MemoryStore>, Vec<u8>, Provenance, MediaHost) {
    let (mut o, store) = structured_owner();
    let bytes = input(body);
    let mut host = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut host);
    let provenance = Provenance::from_import(&p);
    p.commit(&mut j, &mut o, true, 0).unwrap();
    (o, store, bytes, provenance, host)
}
fn export_body(body: &str, name: &str) -> writer::Completion {
    let started = std::time::Instant::now();
    let (o, _store, bytes, p, mut h) = imported(body);
    let mut j = export_job(&o, &bytes, name);
    let c = writer::export(&mut j, Some(&p), true, &mut h, || 0).unwrap();
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::write(dir.join(format!("{name}.docx")), c.artifact.bytes()).unwrap();
        std::fs::write(dir.join(format!("{name}-report.json")),serde_json::to_vec_pretty(&serde_json::json!({"nodes":c.report.nodes,"assets":c.report.assets,"originalBytes":c.report.original_bytes,"captureReadDecodePackMicros":started.elapsed().as_micros(),"outputBytes":c.artifact.bytes().len(),"assetReadEffects":h.inner.effects.iter().filter(|(_,a)| *a==AssetAction::Read).count(),"mediaWork":{"pixels":c.report.media_work.pixels,"decodedBytes":c.report.media_work.decoded_bytes,"decodeCalls":c.report.media_work.decode_calls,"scanned":c.report.media_work.scanned},"diagnostics":c.report.diagnostics.iter().map(|d|serde_json::json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>()})).unwrap()).unwrap();
    }
    c
}
fn part(bytes: &[u8], name: &str) -> String {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}
#[test]
fn captured_revision_does_not_mix_later_edits() {
    let (mut o, _) = structured_owner();
    let mut j = export_job(&o, b"", "fixed");
    let revision = j.contract().revision.clone();
    edit(&mut o, "LATER");
    let before = checkpoint(&o);
    let c = writer::export(&mut j, None, false, &mut MediaHost::default(), || 0).unwrap();
    assert_eq!(c.artifact.revision(), &revision);
    assert!(!part(c.artifact.bytes(), "word/document.xml").contains("LATER"));
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn semantic_text_marks_links_lists_tables_and_original_asset() {
    let body = SUPPORTED
        .split("<w:body>")
        .nth(1)
        .unwrap()
        .split("</w:body>")
        .next()
        .unwrap();
    let c = export_body(body, "supported");
    assert!(c.report.nodes > 10);
    assert_eq!(c.report.assets, 1);
    assert_eq!(c.report.original_bytes, PIXEL.len());
    let xml = part(c.artifact.bytes(), "word/document.xml");
    assert!(xml.contains("<w:tbl>"));
    assert!(xml.contains("w:numPr"));
    assert!(
        part(c.artifact.bytes(), "word/_rels/document.xml.rels").contains("https://example.test/")
    );
}
#[test]
fn unicode_tabs_breaks_headings_and_escaping() {
    let c = export_body(
        r#"<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:strike/></w:rPr><w:t xml:space="preserve"> A &amp; B 🦀 é العربية </w:t><w:tab/><w:br/><w:t>tail</w:t></w:r></w:p>"#,
        "unicode",
    );
    let xml = part(c.artifact.bytes(), "word/document.xml");
    assert!(xml.contains(" A &amp; B 🦀 é العربية "));
    assert!(xml.contains("<w:tab"));
    assert!(xml.contains("<w:br"));
    assert!(xml.contains("Heading2"));
}
#[test]
fn adjacent_list_types_and_non_one_start_survive() {
    export_body(
        &format!(
            "{}{}{}{}",
            list(0, 7, "number-first"),
            list(0, 7, "number-second"),
            list(0, 8, "ten-first"),
            list(1, 8, "bullet-nested")
        ),
        "lists",
    );
}
#[test]
fn wcf10_content_control_and_toc_reports_survive_equal_text() {
    let variants = [
        ("plain", "<w:p><w:r><w:t>Same</w:t></w:r></w:p>"),
        (
            "rich-wrapper",
            "<w:p><w:r><w:t>Same</w:t></w:r></w:p><w:sdt><w:sdtContent><w:p><w:r><w:t>Same</w:t></w:r></w:p></w:sdtContent></w:sdt>",
        ),
        (
            "toc-wrapper",
            "<w:p><w:r><w:t>Same</w:t></w:r></w:p><w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val=\"Table of Contents\"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:fldSimple w:instr=\"TOC\"><w:r><w:t>Same</w:t></w:r></w:fldSimple></w:p></w:sdtContent></w:sdt>",
        ),
    ];
    let mut reports = vec![];
    for (name, body) in variants {
        let c = export_body(body, name);
        reports.push(
            c.report
                .diagnostics
                .iter()
                .filter(|d| d.lossy)
                .map(|d| d.code.clone())
                .collect::<Vec<_>>(),
        );
    }
    assert!(reports[0].is_empty());
    assert!(!reports[1].is_empty());
    assert!(reports[2].len() > reports[1].len());
}
#[test]
fn unapproved_loss_refuses_before_reads_with_complete_report() {
    let (o, store, bytes, p, mut h) = imported(&drawing("img"));
    let mut j = export_job(&o, &bytes, "loss");
    let before = checkpoint(&o);
    let effects = h.inner.effects.len();
    let e = writer::export(&mut j, Some(&p), false, &mut h, || 0)
        .err()
        .unwrap();
    assert_eq!(e.reason, "loss-approval-required");
    assert!(e.report.diagnostics.iter().any(|d| d.code == "IMAGE_ALT"));
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "IMAGE_CAPTION")
    );
    assert_eq!(effects, h.inner.effects.len());
    assert_eq!(checkpoint(&o), before);
    clean(&store, &mut h.inner);
}
#[test]
fn approved_asset_uses_authorized_read_and_scoped_cleanup() {
    let (o, store, bytes, p, mut h) = imported(&drawing("img"));
    let mut j = export_job(&o, &bytes, "asset");
    writer::export(&mut j, Some(&p), true, &mut h, || 0).unwrap();
    assert!(h.inner.effects.iter().any(|(_, a)| *a == AssetAction::Read));
    clean(&store, &mut h.inner);
    assert!(
        h.inner
            .effects
            .iter()
            .any(|(_, a)| *a == AssetAction::ReleaseReference)
    );
}
#[test]
fn denied_asset_is_not_read_and_live_state_is_unchanged() {
    let (o, store, bytes, p, mut h) = imported(&drawing("img"));
    let mut j = export_job(&o, &bytes, "denied");
    h.inner.denied = true;
    let before = checkpoint(&o);
    let e = writer::export(&mut j, Some(&p), true, &mut h, || 0)
        .err()
        .unwrap();
    assert!(e.reason.contains("Permission"));
    assert_eq!(checkpoint(&o), before);
    h.inner.denied = false;
    clean(&store, &mut h.inner);
}
#[test]
fn cancellation_during_read_cannot_publish_artifact() {
    let (o, store, bytes, p, mut h) = imported(&drawing("img"));
    let mut j = export_job(&o, &bytes, "cancelread");
    h.cancel = Some(j.cancellation());
    let before = checkpoint(&o);
    let e = writer::export(&mut j, Some(&p), true, &mut h, || 0)
        .err()
        .unwrap();
    assert!(e.reason.contains("Cancelled"));
    assert_eq!(checkpoint(&o), before);
    clean(&store, &mut h.inner);
}
#[test]
fn missing_provenance_requires_visible_loss_approval() {
    let (o, _) = structured_owner();
    let mut j = export_job(&o, b"original retained", "missing");
    let e = writer::export(&mut j, None, false, &mut MediaHost::default(), || 0)
        .err()
        .unwrap();
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "SOURCE_PROVENANCE_UNAVAILABLE")
    );
    assert_eq!(j.source().original(), b"original retained");
}
#[test]
fn foreign_provenance_is_rejected() {
    let (o, _, _, p, mut h) = imported("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
    let mut j = export_job(&o, b"other", "foreign");
    assert_eq!(
        writer::export(&mut j, Some(&p), true, &mut h, || 0)
            .err()
            .unwrap()
            .reason,
        "foreign-provenance"
    );
}
#[test]
fn exhausted_output_never_completes_or_mutates_session() {
    let (o, _) = structured_owner();
    let mut s = spec(&o, "small", Direction::Export);
    s.original = b"";
    s.target = None;
    s.profile = writer::PROFILE;
    s.limits.output_bytes = 32;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    let before = checkpoint(&o);
    let e = writer::export(&mut j, None, false, &mut MediaHost::default(), || 0)
        .err()
        .unwrap();
    assert!(e.reason.contains("writer"));
    assert_eq!(checkpoint(&o), before);
    assert!(j.finish_export(0).is_err());
}
#[test]
fn cancelled_and_expired_jobs_stop_before_mapping() {
    for cancel in [true, false] {
        let (o, _) = structured_owner();
        let mut j = export_job(&o, b"", "stop");
        if cancel {
            j.cancellation().cancel();
        }
        assert!(
            writer::export(&mut j, None, false, &mut MediaHost::default(), || {
                if cancel { 0 } else { u64::MAX }
            })
            .is_err()
        );
    }
}
#[test]
fn generated_subset_reimports_through_guarded_mapper_with_list_start_and_cells() {
    let c = export_body(
        &format!("{}{}", list(0, 7, "Three"), list(1, 7, "Nested")),
        "reimport",
    );
    let (o, _) = structured_owner();
    let mut h = MediaHost::default();
    let (_j, p) = prepared(&o, c.artifact.bytes(), &mut h);
    assert!(p.blocks().iter().any(|b| {
        b.containers
            .iter()
            .any(|(_, s)| *s == ContainerStyle::Ordered { start: 3 })
    }));
    assert!(p.blocks().iter().any(|b| b.containers.len() == 2));
}
#[test]
fn wcf11_localized_empty_and_missing_defaults_and_metadata_are_accounted_for() {
    let styles = [
        (
            "localized",
            r#"<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="NormalLocale" w:default="1"><w:name w:val="Normál"/><w:rPr><w:b/></w:rPr></w:style></w:styles>"#,
        ),
        (
            "empty-defaults",
            r#"<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:pPrDefault/><w:rPrDefault/></w:docDefaults></w:styles>"#,
        ),
        (
            "omitted-defaults",
            r#"<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>"#,
        ),
    ];
    for (name, style) in styles {
        let (mut o, _) = structured_owner();
        let mut h = MediaHost::default();
        let extra = format!(
            r#"<Relationship Id="styles" Type="{R}/styles" Target="styles.xml"/><Relationship Id="metadata" Type="{R}/customXml" Target="custom.xml"/>"#
        );
        let original = package(
            &doc("<w:p><w:r><w:t>Same defaults</w:t></w:r></w:p>"),
            NUMBERING,
            &extra,
            &[
                ("word/styles.xml", style.as_bytes()),
                ("word/custom.xml", b"<custom>opaque</custom>"),
            ],
        );
        let (mut j, p) = prepared(&o, &original, &mut h);
        let provenance = Provenance::from_import(&p);
        assert!(!p.report().diagnostics.is_empty());
        p.commit(&mut j, &mut o, true, 0).unwrap();
        let mut j = export_job(&o, &original, name);
        let c = writer::export(&mut j, Some(&provenance), true, &mut h, || 0).unwrap();
        assert!(c.report.diagnostics.iter().any(|d| d.lossy));
        if name == "localized" {
            assert!(part(c.artifact.bytes(), "word/document.xml").contains("<w:b"));
        }
        if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
            std::fs::write(
                std::path::PathBuf::from(dir).join(format!("{name}.docx")),
                c.artifact.bytes(),
            )
            .unwrap();
        }
    }
}

fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
#[test]
fn wcf10_wrapped_only_input_refuses_with_complete_nested_diagnostics_and_original() {
    let (o, _) = structured_owner();
    let original = input(
        r#"<w:sdt><w:sdtPr><w:docPartObj/></w:sdtPr><w:sdtContent><w:p><w:fldSimple w:instr="TOC"><w:r><w:t>Same</w:t></w:r></w:fldSimple></w:p></w:sdtContent></w:sdt>"#,
    );
    let mut j = begin(&o, &original, "wrapped-only");
    let before = checkpoint(&o);
    let e = docx::prepare_structure(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
        .err()
        .unwrap();
    for name in ["sdt", "docPartObj", "fldSimple"] {
        assert!(
            e.diagnostics.iter().any(|d| d.code.ends_with(name)),
            "missing {name}"
        );
    }
    assert_eq!(j.source().original(), original);
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn nested_lists_keep_one_root_numbering_identity_across_children_and_resume() {
    let c = export_body(
        &format!(
            "{}{}{}",
            list(0, 7, "Three"),
            list(1, 7, "child"),
            list(0, 7, "Four")
        ),
        "continuation",
    );
    let (o, _) = structured_owner();
    let mut h = MediaHost::default();
    let (_j, p) = prepared(&o, c.artifact.bytes(), &mut h);
    let roots = p
        .blocks()
        .iter()
        .filter_map(|b| b.containers.first().map(|c| c.0.clone()))
        .collect::<Vec<_>>();
    assert_eq!(roots.len(), 3);
    assert!(roots.iter().all(|r| *r == roots[0]));
}
#[test]
fn authorized_but_malformed_original_png_is_rejected_by_guarded_decoder() {
    use editac_core::modules::assets::{AssetDescriptor, AssetKind, AssetMetadata};
    let (mut o, store) = structured_owner();
    let mut bytes = PIXEL.to_vec();
    let n = bytes.len();
    bytes[n - 1] ^= 1;
    let descriptor = AssetDescriptor {
        identity: asset(),
        kind: AssetKind::Image,
        metadata: AssetMetadata {
            filename: "pixel.png".into(),
            media_type: "image/png".into(),
            byte_length: Some(bytes.len() as u64),
            sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
            width: Some(1),
            height: Some(1),
            duration_ms: None,
            alt: String::new(),
            caption: String::new(),
        },
        fallback: "image".into(),
        source: String::new(),
    };
    let b = FragmentBlock {
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: "image".into(),
            marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(
            Content::Asset { descriptor }.tuple().unwrap(),
        )),
        containers: vec![],
        checked: None,
    };
    let mut insert = job(&o, "authorasset", Direction::Import);
    insert.finish_import(&mut o, &[b], 0).unwrap();
    let mut j = export_job(&o, b"", "badpng");
    let before = checkpoint(&o);
    let mut h = MediaHost {
        read_bytes: Some(bytes),
        ..Default::default()
    };
    let e = writer::export(&mut j, None, true, &mut h, || 0)
        .err()
        .unwrap();
    assert!(e.reason.contains("asset-media"));
    assert_eq!(checkpoint(&o), before);
    clean(&store, &mut h.inner);
}
#[test]
fn full_generated_structure_reimports_once_with_history_reopen_and_original_image() {
    let body = SUPPORTED
        .split("<w:body>")
        .nth(1)
        .unwrap()
        .split("</w:body>")
        .next()
        .unwrap();
    let c = export_body(body, "full-reimport");
    let (mut o, store) = structured_owner();
    let mut host = MediaHost::default();
    let (mut j, p) = prepared(&o, c.artifact.bytes(), &mut host);
    assert!(
        !p.report()
            .diagnostics
            .iter()
            .any(|d| d.code == "UNIMPORTED_EMBEDDED_MEDIA"
                || d.code == "UNSUPPORTED_INLINE_IMAGE_PLACEMENT")
    );
    assert!(p.blocks().iter().any(|b|matches!(&b.attributes,Some(BlockAttributes::Unknown(t)) if matches!(Content::from_tuple(t),Ok(Some(Content::Asset{..}))))));
    let complete = p.commit(&mut j, &mut o, true, 0).unwrap().unwrap();
    assert_eq!(complete.assets.len(), 1);
    assert_eq!(host.originals, [PIXEL.to_vec()]);
    let snapshot = o.service().read(0).unwrap().snapshot;
    let block = |label: &str| {
        snapshot
            .visible
            .iter()
            .find(|n| n.runs.iter().map(|r| r.text.as_str()).collect::<String>() == label)
            .unwrap()
    };
    assert_eq!(block("Three").editor.as_ref().unwrap().number, Some(3));
    assert_eq!(block("Four").editor.as_ref().unwrap().number, Some(4));
    let contents = snapshot
        .visible
        .iter()
        .filter_map(|n| {
            if let Some(BlockAttributes::Unknown(t)) = &n.block_attributes {
                Content::from_tuple(t).unwrap()
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(contents.len(), 2);
    let Content::Table { rows, .. } = &contents[0] else {
        panic!()
    };
    assert_eq!(
        rows[0][0][0].marks[0].0,
        editac_core::commands::format::Mark::Bold
    );
    assert_eq!(rows[1][0][0].text, "é🙂");
    let Content::Asset { descriptor } = &contents[1] else {
        panic!()
    };
    assert_eq!(
        descriptor.metadata.sha256,
        Some(format!("{:x}", Sha256::digest(PIXEL)))
    );
    let after = current(&o);
    let revision = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&revision, 0).unwrap();
    assert_eq!(current(&o), "base");
    let revision = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&revision, 0).unwrap();
    assert_eq!(current(&o), after);
    let id = o.service().session().document().identity().clone();
    drop(o);
    let reopened =
        ConversionOwner::open(store, &id, CachedPermission::LOCAL, structure_policy()).unwrap();
    assert_eq!(current(&reopened), after);
}
#[test]
fn multiple_original_images_have_unique_generated_drawing_ids() {
    let c = export_body(
        &format!("{}{}", drawing("img"), drawing("img")),
        "multiple-images",
    );
    assert_eq!(c.report.assets, 2);
    assert_eq!(c.report.media_work.decode_calls, 2);
    assert_eq!(c.report.original_bytes, PIXEL.len() * 2);
}
#[test]
fn literal_link_query_text_is_escaped_once_without_fetching() {
    let (mut o, _) = structured_owner();
    let mut host = MediaHost::default();
    let body = r#"<w:p><w:hyperlink r:id="query"><w:r><w:t>&lt;literal&gt; &amp; link</w:t></w:r></w:hyperlink></w:p>"#;
    let relationship = format!(
        r#"<Relationship Id="query" Type="{R}/hyperlink" Target="https://example.test/?a=1&amp;b=two#x" TargetMode="External"/>"#
    );
    let original = package(&doc(body), NUMBERING, &relationship, &[]);
    let (mut j, p) = prepared(&o, &original, &mut host);
    let provenance = Provenance::from_import(&p);
    p.commit(&mut j, &mut o, true, 0).unwrap();
    let mut j = export_job(&o, &original, "literal-link");
    let c = writer::export(&mut j, Some(&provenance), true, &mut host, || 0).unwrap();
    let xml = part(c.artifact.bytes(), "word/document.xml");
    assert!(xml.contains("&lt;literal&gt; &amp; link"));
    let rels = part(c.artifact.bytes(), "word/_rels/document.xml.rels");
    assert!(rels.contains("?a=1&amp;b=two#x"));
    assert!(!rels.contains("&amp;amp;"));
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        std::fs::write(
            std::path::PathBuf::from(dir).join("literal-link.docx"),
            c.artifact.bytes(),
        )
        .unwrap();
    }
}
