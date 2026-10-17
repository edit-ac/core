include!("support/jobs_harness.rs");
use editac_core::{
    commands::{format::Mark, lists::ContainerStyle},
    document::BlockAttributes,
    modules::content::Content,
};
use editac_formats::{
    container::Budgets,
    epub::import::{self as epub, OriginalMediaHost},
};
use std::io::{Cursor, Write};
const CONTAINER: &str = include_str!("../../../fixtures/formats/epub/container.xml");
const OPF: &str = include_str!("../../../fixtures/formats/epub/package.opf");
const NAV: &str = include_str!("../../../fixtures/formats/epub/nav.xhtml");
const FIRST: &str = include_str!("../../../fixtures/formats/epub/first.xhtml");
const SECOND: &str = include_str!("../../../fixtures/formats/epub/second.xhtml");
const PIXEL: &[u8] = include_bytes!("../../../fixtures/formats/docx/probe/pixel.png");
const MIME: &str = "application/epub+zip";
fn zip(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(vec![]));
    for (name, bytes) in parts {
        w.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap().into_inner()
}
fn package_parts(
    container: &str,
    opf: &str,
    nav: &str,
    first: &str,
    second: &str,
    extra: &[(&str, &[u8])],
) -> Vec<u8> {
    let mut parts = vec![
        ("mimetype", MIME.as_bytes()),
        ("META-INF/container.xml", container.as_bytes()),
        ("EPUB/package.opf", opf.as_bytes()),
        ("EPUB/nav.xhtml", nav.as_bytes()),
        ("EPUB/text/first.xhtml", first.as_bytes()),
        ("EPUB/text/second.xhtml", second.as_bytes()),
        ("EPUB/images/pixel.png", PIXEL),
    ];
    parts.extend_from_slice(extra);
    zip(&parts)
}
fn package() -> Vec<u8> {
    package_parts(CONTAINER, OPF, NAV, FIRST, SECOND, &[])
}
fn modified(first: &str) -> Vec<u8> {
    package_parts(CONTAINER, OPF, NAV, first, SECOND, &[])
}
fn policy() -> HostPolicy {
    let mut p = HostPolicy::default();
    p.extensions = true;
    p
}
fn structured_owner() -> (Owner, Arc<MemoryStore>) {
    let (mut o, s) = owner();
    o.service_mut().set_policy(policy());
    (o, s)
}
fn begin(o: &Owner, bytes: &[u8], id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Import);
    s.original = bytes;
    s.profile = epub::PROFILE;
    s.filename = "fixture.epub";
    s.media_type = MIME;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut e = port().0;
    e.enforcement.hard_memory_bytes = s.memory_bytes;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), e, 0).unwrap()
}
fn prepared(
    o: &Owner,
    bytes: &[u8],
    h: &mut MediaHost,
) -> (PreparedJob<MemoryStore>, epub::Prepared) {
    let mut j = begin(o, bytes, "epub");
    let p = epub::prepare(&mut j, Budgets::default(), h, || 0).unwrap();
    (j, p)
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
fn label(b: &FragmentBlock) -> String {
    b.runs.iter().map(|r| r.text.as_str()).collect()
}
fn rejected(bytes: &[u8], expected: &str) {
    let (mut o, s) = structured_owner();
    let before = checkpoint(&o);
    let mut j = begin(&o, bytes, "bad");
    let mut h = MediaHost::default();
    let e = match epub::prepare(&mut j, Budgets::default(), &mut h, || 0) {
        Ok(_) => panic!("expected {expected}"),
        Err(e) => e,
    };
    assert_eq!(e.code, expected, "{e:?}");
    assert_eq!(checkpoint(&o), before);
    assert_eq!(j.source().original(), bytes);
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    clean(&s, &mut h.inner);
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
#[test]
fn spine_navigation_provenance_unicode_marks_lists_and_original_png() {
    let (o, _) = structured_owner();
    let bytes = package();
    let mut h = MediaHost::default();
    let (j, p) = prepared(&o, &bytes, &mut h);
    assert!(p.report().diagnostics.is_empty(), "{:?}", p.report());
    assert_eq!(
        p.report()
            .chapters
            .iter()
            .map(|c| c.part.as_str())
            .collect::<Vec<_>>(),
        ["EPUB/text/first.xhtml", "EPUB/text/second.xhtml"]
    );
    assert_eq!(
        p.report()
            .navigation
            .iter()
            .map(|n| n.part.as_str())
            .collect::<Vec<_>>(),
        ["EPUB/text/second.xhtml", "EPUB/text/first.xhtml"]
    );
    assert_eq!(p.report().navigation[0].fragment.as_deref(), Some("second"));
    assert_eq!(p.report().metadata["title"], "Local publication");
    assert_eq!(p.blocks().len(), 9);
    assert_eq!(p.report().chapters[0].block_count, 6);
    assert_eq!(p.report().chapters[1].first_block, 6);
    assert_eq!(p.blocks()[0].attributes, Some(BlockAttributes::Heading(1)));
    assert_eq!(label(&p.blocks()[1]), "ABC🙂D & Ω\nend");
    assert_eq!(p.blocks()[1].runs[2].text, "C🙂");
    assert!(p.blocks()[1].runs[2].marks.contains(&(Mark::Bold, None)));
    assert!(p.blocks()[1].runs[2].marks.contains(&(Mark::Italic, None)));
    assert_eq!(
        p.blocks()[2].containers[0].1,
        ContainerStyle::Ordered { start: 3 }
    );
    assert_eq!(p.blocks()[2].containers, p.blocks()[3].containers);
    assert_ne!(p.blocks()[2].containers[0].0, p.blocks()[8].containers[0].0);
    assert_eq!(label(&p.blocks()[7]), "Exact é and 😀");
    let Some(BlockAttributes::Unknown(t)) = &p.blocks()[5].attributes else {
        panic!()
    };
    let Some(Content::Asset { descriptor }) = Content::from_tuple(t).unwrap() else {
        panic!()
    };
    assert_eq!(descriptor.metadata.alt, "alt 🙂");
    assert_eq!(descriptor.metadata.caption, "caption");
    assert_eq!(descriptor.metadata.width, Some(1));
    assert_eq!(
        descriptor.metadata.sha256,
        Some(format!("{:x}", Sha256::digest(PIXEL)))
    );
    assert_eq!(h.originals, vec![PIXEL.to_vec()]);
    assert_eq!(p.report().staged_bytes, PIXEL.len());
    assert_eq!(j.source().original(), bytes);
    assert_eq!(p.original_sha256, <[u8; 32]>::from(Sha256::digest(&bytes)));
    assert_eq!(
        p.report().chapters[0].source_sha256,
        <[u8; 32]>::from(Sha256::digest(FIRST.as_bytes()))
    );
    assert!(p.report().work.scanned > bytes.len());
    assert_eq!(p.report().work.media_attempts, 1);
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::write(dir.join("supported.epub"), &bytes).unwrap();
        let projection = serde_json::json!({"blocks":p.blocks().iter().map(label).collect::<Vec<_>>(),"chapters":p.report().chapters.iter().map(|c|serde_json::json!({"part":c.part,"first":c.first_block,"count":c.block_count})).collect::<Vec<_>>(),"navigation":p.report().navigation.iter().map(|n|serde_json::json!({"label":n.label,"part":n.part,"fragment":n.fragment})).collect::<Vec<_>>()});
        std::fs::write(
            dir.join("projection.json"),
            serde_json::to_vec_pretty(&projection).unwrap(),
        )
        .unwrap();
    }
}
#[test]
fn one_prepared_session_commit_undo_redo_reopen_and_original_recovery() {
    let (mut o, store) = structured_owner();
    let bytes = package();
    let before = checkpoint(&o);
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    assert_eq!(checkpoint(&o), before);
    let c = p.commit(&mut j, &mut o, false, 0).unwrap().unwrap();
    assert_eq!(c.assets.len(), 1);
    assert_eq!(c.local_commit.durability, Durability::Volatile);
    let after = current(&o);
    assert!(after.contains("First 🙂"));
    assert!(after.contains("Second"));
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    assert_eq!(current(&o), after);
    let reopened = ConversionOwner::open(
        store.clone(),
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        policy(),
    )
    .unwrap();
    assert_eq!(current(&reopened), after);
    assert_eq!(
        reopened
            .service()
            .read(0)
            .unwrap()
            .snapshot
            .visible
            .iter()
            .filter_map(|n| n.block_attributes.clone())
            .collect::<Vec<_>>(),
        o.service()
            .read(0)
            .unwrap()
            .snapshot
            .visible
            .iter()
            .filter_map(|n| n.block_attributes.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(j.source().original(), bytes);
    println!(
        "EPUB_COMMIT commits=1 assets=1 undo=1 redo=1 reopen=1 original_bytes={} network_calls=0",
        bytes.len()
    );
}
#[test]
fn exact_spine_order_is_independent_of_manifest_and_toc_order() {
    let (o, _) = structured_owner();
    let bytes = package_parts(
        CONTAINER,
        &OPF.replace(
            "<itemref idref=\"first\"/><itemref idref=\"second\"/>",
            "<itemref idref=\"second\"/><itemref idref=\"first\"/>",
        ),
        NAV,
        FIRST,
        SECOND,
        &[],
    );
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert_eq!(label(&p.blocks()[0]), "Second");
    assert_eq!(p.report().navigation[0].label, "Second chapter");
}
#[test]
fn mimetype_must_be_first_stored_exact_and_without_extra() {
    let bytes = zip(&[
        ("junk", b"x"),
        ("mimetype", MIME.as_bytes()),
        ("META-INF/container.xml", CONTAINER.as_bytes()),
    ]);
    rejected(&bytes, "EPUB_MIMETYPE");
    let bytes = package();
    let mut b = bytes.clone();
    b[38] = b'X';
    rejected(&b, "INGRESS_Archive");
}
#[test]
fn multiple_renditions_are_explicitly_unsupported() {
    rejected(&package_parts(&CONTAINER.replace("</rootfiles>","<rootfile full-path=\"other.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles>"),OPF,NAV,FIRST,SECOND,&[]),"EPUB_MULTIPLE_RENDITIONS");
}
#[test]
fn missing_spine_id_and_duplicate_manifest_id_fail() {
    for opf in [
        OPF.replace("idref=\"first\"", "idref=\"missing\""),
        OPF.replace("id=\"first\"", "id=\"second\""),
    ] {
        let expected = if opf.contains("missing") {
            "EPUB_IDREF"
        } else {
            "EPUB_DUPLICATE_ID"
        };
        rejected(
            &package_parts(CONTAINER, &opf, NAV, FIRST, SECOND, &[]),
            expected,
        );
    }
}
#[test]
fn manifest_alias_and_spine_repetition_fail() {
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace("text/second.xhtml", "text/./first.xhtml"),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_MANIFEST_ALIAS",
    );
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace("idref=\"second\"", "idref=\"first\""),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_REPEATED_SPINE",
    );
}
#[test]
fn archive_parent_traversal_and_missing_parts_fail() {
    rejected(
        &package_parts(CONTAINER, OPF, NAV, FIRST, SECOND, &[("../escape", b"x")]),
        "INGRESS_Path",
    );
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace("text/first.xhtml", "text/missing.xhtml"),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "MISSING_PART",
    );
}
#[test]
fn encrypted_drm_and_fixed_layout_are_typed_recoverable_failures() {
    for name in ["META-INF/encryption.xml", "META-INF/rights.xml"] {
        rejected(
            &package_parts(CONTAINER, OPF, NAV, FIRST, SECOND, &[(name, b"<rights/>")]),
            "EPUB_DRM_OR_ENCRYPTION_UNSUPPORTED",
        );
    }
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace(
                "</metadata>",
                "<meta property=\"rendition:layout\">pre-paginated</meta></metadata>",
            ),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_FIXED_LAYOUT_UNSUPPORTED",
    );
}
#[test]
fn remote_spine_is_unavailable_without_fetch() {
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace("text/first.xhtml", "https://example.invalid/chapter.xhtml"),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_UNSUPPORTED_SPINE_RESOURCE",
    );
}
#[test]
fn dtd_entities_malformed_encoding_and_unsafe_xml_fail() {
    for (x, code) in [
        (
            FIRST.replace(
                "<html ",
                "<!DOCTYPE html [<!ENTITY x SYSTEM 'file:///tmp/private'>]><html ",
            ),
            "INGRESS_Dtd",
        ),
        (FIRST.replace("First 🙂", "&#0;"), "INGRESS_Xml"),
        (FIRST.replace("First 🙂", "&unknown;"), "INGRESS_Xml"),
        (
            FIRST.replace(
                "<html ",
                "<?xml version=\"1.0\" encoding=\"UTF-16\"?><html ",
            ),
            "INGRESS_Encoding",
        ),
        (FIRST.replace("</html>", "</html>tail"), "INGRESS_Xml"),
    ] {
        rejected(&modified(&x), code);
    }
}
#[test]
fn namespaces_and_wrong_versions_do_not_masquerade_as_epub() {
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace("version=\"3.0\"", "version=\"2.0\""),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_VERSION",
    );
    rejected(
        &modified(&FIRST.replace("http://www.w3.org/1999/xhtml", "urn:wrong")),
        "EPUB_XHTML",
    );
}
#[test]
fn scripts_forms_remote_media_and_css_are_inert_and_require_approval() {
    let first=FIRST.replace("</body>","<script src=\"https://example.invalid/a.js\">secret</script><form action=\"https://example.invalid/\"><input value=\"secret\"/><p>hidden form</p></form><img src=\"https://example.invalid/p.png\"/><p style=\"position:fixed\" onclick=\"run()\">visible</p></body>");
    let bytes = modified(&first);
    let (mut o, s) = structured_owner();
    let before = checkpoint(&o);
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    assert!(
        !p.blocks()
            .iter()
            .any(|b| label(b).contains("secret") || label(b).contains("hidden form"))
    );
    assert_eq!(h.originals.len(), 1);
    let locations = p
        .report()
        .diagnostics
        .iter()
        .map(|d| d.location.clone())
        .collect::<Vec<_>>()
        .join(" ");
    for needle in ["src", "action", "value", "onclick"] {
        assert!(locations.contains(needle), "{locations}");
    }
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.code == "REMOTE_OR_UNSUPPORTED_IMAGE_INERT")
    );
    assert_eq!(
        p.commit(&mut j, &mut o, false, 0).err().unwrap().code,
        "LOSS_APPROVAL"
    );
    assert_eq!(checkpoint(&o), before);
    clean(&s, &mut h.inner);
    assert_eq!(j.source().original(), bytes);
}
#[test]
fn approved_loss_is_explicit_and_preserves_original() {
    let bytes = modified(&FIRST.replace("</body>", "<script>never execute</script></body>"));
    let (mut o, _) = structured_owner();
    let (mut j, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(p.commit(&mut j, &mut o, true, 0).unwrap().is_some());
    assert!(!current(&o).contains("never execute"));
    assert_eq!(j.source().original(), bytes);
}
#[test]
fn unsupported_tables_inline_images_wrappers_and_metadata_are_reported() {
    let bytes=package_parts(CONTAINER,&OPF.replace("</metadata>","<dc:creator>Writer</dc:creator></metadata>"),NAV,&FIRST.replace("</body>","<section><p>x<img src=\"../images/pixel.png\"/></p></section><table><tr><td>cell</td></tr></table></body>"),SECOND,&[]);
    let (o, _) = structured_owner();
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    let d = p
        .report()
        .diagnostics
        .iter()
        .map(|d| format!("{} {}", d.code, d.location))
        .collect::<Vec<_>>()
        .join(" ");
    for s in [
        "creator",
        "table",
        "img",
        "UNSUPPORTED_XHTML_WRAPPER_REDUCED",
    ] {
        assert!(d.contains(s), "{d}");
    }
}
#[test]
fn non_linear_and_unused_resources_are_diagnosed() {
    let opf = OPF.replace(
        "<itemref idref=\"second\"/>",
        "<itemref idref=\"second\" linear=\"no\"/>",
    );
    let bytes = package_parts(
        CONTAINER,
        &opf,
        NAV,
        FIRST,
        SECOND,
        &[("extra.bin", b"not executed")],
    );
    let (o, _) = structured_owner();
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    for code in [
        "UNSUPPORTED_NONLINEAR_CHAPTER",
        "UNIMPORTED_PUBLICATION_RESOURCE",
        "UNDECLARED_PACKAGE_PART",
        "UNSUPPORTED_NAVIGATION_TARGET",
    ] {
        assert!(
            p.report().diagnostics.iter().any(|d| d.code == code),
            "{code}"
        );
    }
}
#[test]
fn missing_toc_and_multiple_tocs_fail() {
    rejected(
        &package_parts(
            CONTAINER,
            OPF,
            &NAV.replace("epub:type=\"toc\"", "epub:type=\"landmarks\""),
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_TOC",
    );
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace("properties=\"nav\"", ""),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_MISSING_NAV",
    );
}
#[test]
fn unexpected_navigation_content_is_diagnosed() {
    let nav=NAV.replace("</body>","<script src=\"https://example.invalid/nav.js\">inactive</script><nav epub:type=\"landmarks\"><a href=\"text/first.xhtml\">landmark</a></nav></body>");
    let (o, _) = structured_owner();
    let (_, p) = prepared(
        &o,
        &package_parts(CONTAINER, OPF, &nav, FIRST, SECOND, &[]),
        &mut MediaHost::default(),
    );
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.location.contains("script"))
    );
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.location.contains("landmarks") == false && d.location.contains("type"))
    );
}
#[test]
fn repeated_image_references_charge_work_but_stage_original_once() {
    let bytes = modified(&FIRST.replace(
        "</body>",
        "<p><img src=\"../images/pixel.png\" alt=\"again\"/></p></body>",
    ));
    let (o, _) = structured_owner();
    let mut h = MediaHost::default();
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert_eq!(h.originals.len(), 1);
    assert_eq!(p.report().work.references, 2);
    assert_eq!(p.report().work.media_attempts, 2);
}
#[test]
fn failed_media_stage_and_post_ingest_cancellation_are_atomic() {
    for cancel in [false, true] {
        let (o, s) = structured_owner();
        let bytes = package();
        let mut j = begin(&o, &bytes, "media-fail");
        let mut h = MediaHost::default();
        if cancel {
            h.cancel = Some(j.cancellation());
        } else {
            h.fail_ingest = true;
        }
        let before = checkpoint(&o);
        assert!(epub::prepare(&mut j, Budgets::default(), &mut h, || 0).is_err());
        assert_eq!(checkpoint(&o), before);
        clean(&s, &mut h.inner);
    }
}
#[test]
fn late_chapter_failure_retires_only_job_owned_staging() {
    let (mut o, s) = structured_owner();
    let bytes = package_parts(
        CONTAINER,
        OPF,
        NAV,
        FIRST,
        &SECOND.replace("</html>", "<broken>"),
        &[],
    );
    let mut sibling = begin(&o, &package(), "sibling");
    let mut h = MediaHost::default();
    sibling
        .stage_asset(asset(), AssetAction::Ingest, 12, &mut h, 0)
        .unwrap();
    let mut j = begin(&o, &bytes, "late-failure");
    let before = checkpoint(&o);
    assert!(epub::prepare(&mut j, Budgets::default(), &mut h, || 0).is_err());
    assert_eq!(checkpoint(&o), before);
    assert!(h.originals.len() == 1);
    clean(&s, &mut h.inner);
    assert!(
        sibling
            .finish_import(&mut o, &blocks("sibling"), 0)
            .unwrap()
            .is_some()
    );
    clean(&s, &mut h.inner);
}
#[test]
fn cancellation_deadline_and_stale_revision_at_commit_preserve_recoverable_state() {
    for case in 0..3 {
        let (mut o, s) = structured_owner();
        let bytes = package();
        let mut h = MediaHost::default();
        let (mut j, p) = prepared(&o, &bytes, &mut h);
        match case {
            0 => j.cancellation().cancel(),
            1 => {}
            _ => edit(&mut o, "human"),
        };
        let before = checkpoint(&o);
        assert!(
            p.commit(&mut j, &mut o, false, if case == 1 { 100 } else { 0 })
                .is_err()
        );
        assert_eq!(checkpoint(&o), before);
        assert_eq!(j.source().original(), bytes);
        clean(&s, &mut h.inner);
    }
}
#[test]
fn lowered_xml_node_text_depth_work_and_output_limits_are_enforced() {
    for case in 0..6 {
        let (o, s) = structured_owner();
        let bytes = package();
        let mut j = begin(&o, &bytes, "budget");
        let mut limits = Budgets::default();
        match case {
            0 => limits.nodes = 10,
            1 => limits.depth = 2,
            2 => limits.text = 20,
            3 => limits.work = 100,
            4 => limits.attributes = 1,
            _ => limits.pixels = 0,
        };
        let mut h = MediaHost::default();
        let before = checkpoint(&o);
        assert!(
            epub::prepare(&mut j, limits, &mut h, || 0).is_err(),
            "case {case}"
        );
        assert_eq!(checkpoint(&o), before);
        clean(&s, &mut h.inner);
    }
}
#[test]
fn output_limit_does_not_return_a_truncated_prepared_artifact() {
    let (o, s) = structured_owner();
    let bytes = package();
    let mut sp = spec(&o, "out-limit", Direction::Import);
    sp.profile = epub::PROFILE;
    sp.original = &bytes;
    sp.memory_bytes = 32 * 1024 * 1024;
    sp.limits.output_bytes = 64;
    let mut e = port().0;
    e.enforcement.hard_memory_bytes = sp.memory_bytes;
    let mut j = PreparedJob::begin(&o, sp, &JobPool::new(2).unwrap(), e, 0).unwrap();
    let mut h = MediaHost::default();
    let before = checkpoint(&o);
    assert!(epub::prepare(&mut j, Budgets::default(), &mut h, || 0).is_err());
    assert_eq!(checkpoint(&o), before);
    clean(&s, &mut h.inner);
}
#[test]
fn token_binding_and_capability_revocation_prevent_partial_commits() {
    let (mut o, s) = structured_owner();
    let bytes = package();
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    let mut other = begin(&o, &bytes, "foreign");
    assert_eq!(
        p.commit(&mut other, &mut o, false, 0).err().unwrap().code,
        "FOREIGN_JOB"
    );
    j.abort().unwrap();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    o.service_mut().set_policy(HostPolicy::default());
    let before = checkpoint(&o);
    assert!(p.commit(&mut j, &mut o, false, 0).is_err());
    assert_eq!(checkpoint(&o), before);
    clean(&s, &mut h.inner);
}
#[test]
fn duplicate_metadata_and_dangling_navigation_fragments_are_rejected() {
    rejected(
        &package_parts(
            CONTAINER,
            &OPF.replace(
                "</metadata>",
                "<meta property=\"dcterms:modified\">2026-10-18T00:00:00Z</meta></metadata>",
            ),
            NAV,
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_AMBIGUOUS_METADATA",
    );
    rejected(
        &package_parts(
            CONTAINER,
            OPF,
            &NAV.replace("#first", "#missing"),
            FIRST,
            SECOND,
            &[],
        ),
        "EPUB_NAVIGATION_FRAGMENT",
    );
    rejected(
        &modified(&FIRST.replace("<p>A", "<p id=\"first\">A")),
        "EPUB_DUPLICATE_XHTML_ID",
    );
}
#[test]
fn navigation_scalar_and_nested_metadata_are_explicitly_diagnosed() {
    let nav = NAV.replace("<li>", "<li>unsupported scalar");
    let opf = OPF.replace(
        "2026-10-17T00:00:00Z</meta>",
        "2026-10-17T00:00:00Z<hidden>metadata</hidden></meta>",
    );
    let first = FIRST.replace(
        "<title>First</title>",
        "<title>First<span>nested title</span></title>",
    );
    let bytes = package_parts(CONTAINER, &opf, &nav, &first, SECOND, &[]);
    let (o, _) = structured_owner();
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(p.report().diagnostics.iter().any(
        |d| d.code == "UNSUPPORTED_STRUCTURAL_TEXT" && d.location.starts_with("EPUB/nav.xhtml")
    ));
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_ELEMENT" && d.location.contains("hidden"))
    );
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_ELEMENT" && d.location.contains("span"))
    );
}
