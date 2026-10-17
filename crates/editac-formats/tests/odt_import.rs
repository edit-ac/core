include!("support/jobs_harness.rs");
use editac_core::{
    commands::{format::Mark, lists::ContainerStyle},
    document::BlockAttributes,
    modules::content::Content,
};
use editac_formats::{
    container::Budgets,
    odt::import::{self as odt, OriginalMediaHost},
};
use std::io::{Cursor, Write};
const SUPPORTED: &str = include_str!("../../../fixtures/formats/odt/supported.xml");
const PIXEL: &[u8] = include_bytes!("../../../fixtures/formats/docx/probe/pixel.png");
const M: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const MIME: &str = "application/vnd.oasis.opendocument.text";
fn doc(body: &str) -> String {
    let start = SUPPORTED.split("<office:body>").next().unwrap();
    format!(
        "{start}<office:body><office:text>{body}</office:text></office:body></office:document-content>"
    )
}
fn zip(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(vec![]));
    for (name, bytes) in parts {
        w.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        w.write_all(bytes).unwrap()
    }
    w.finish().unwrap().into_inner()
}
fn manifest(extras: &str) -> String {
    format!(
        r#"<manifest:manifest xmlns:manifest="{M}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="{MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/pixel.png" manifest:media-type="image/png"/>{extras}</manifest:manifest>"#
    )
}
fn package(content: &str) -> Vec<u8> {
    package_extra(content, &manifest(""), &[])
}
fn package_extra(content: &str, m: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut parts = vec![
        ("mimetype", MIME.as_bytes()),
        ("META-INF/manifest.xml", m.as_bytes()),
        ("content.xml", content.as_bytes()),
        ("Pictures/pixel.png", PIXEL),
    ];
    parts.extend_from_slice(extra);
    let bytes = zip(&parts);
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir).join("odt-inputs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{:x}.odt", Sha256::digest(&bytes))),
            &bytes,
        )
        .unwrap()
    }
    bytes
}
fn policy() -> HostPolicy {
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
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
    s.profile = odt::PROFILE;
    s.filename = "fixture.odt";
    s.media_type = MIME;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut execution = port().0;
    execution.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), execution, 0).unwrap()
}
fn prepared(
    o: &Owner,
    bytes: &[u8],
    host: &mut MediaHost,
) -> (PreparedJob<MemoryStore>, odt::Prepared) {
    let mut j = begin(o, bytes, "odt");
    let p = odt::prepare(&mut j, Budgets::default(), host, || 0).unwrap();
    (j, p)
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
fn label(b: &FragmentBlock) -> String {
    b.runs.iter().map(|r| r.text.as_str()).collect()
}
fn contents(p: &odt::Prepared) -> Vec<Content> {
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
fn supported_unicode_nested_marks_ordered_text_links_lists_tables_and_original_png() {
    let (o, _) = structured_owner();
    let bytes = package(SUPPORTED);
    let mut h = MediaHost::default();
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert!(p.report().diagnostics.is_empty(), "{:?}", p.report());
    assert_eq!(p.blocks().len(), 8);
    assert_eq!(p.blocks()[0].attributes, Some(BlockAttributes::Heading(2)));
    assert_eq!(label(&p.blocks()[1]), "ABC🙂DE & Ω  \tx\nend");
    let runs = &p.blocks()[1].runs;
    assert_eq!(runs[0].text, "A");
    assert_eq!(runs[1].text, "B");
    assert_eq!(runs[1].marks, vec![(Mark::Bold, None)]);
    assert_eq!(runs[2].text, "C🙂");
    assert_eq!(
        runs[2].marks,
        vec![(Mark::Bold, None), (Mark::Italic, None)]
    );
    assert_eq!(runs[3].text, "D");
    assert_eq!(
        p.blocks()[2].runs[0].marks,
        vec![(Mark::Link, Some("https://example.test/?a=1&b=2".into()))]
    );
    assert_eq!(
        p.blocks()[3].containers[0].1,
        ContainerStyle::Ordered { start: 3 }
    );
    assert_eq!(p.blocks()[4].containers.len(), 2);
    assert_eq!(p.blocks()[4].containers[1].1, ContainerStyle::Unordered);
    assert_eq!(p.blocks()[3].containers, p.blocks()[5].containers);
    let c = contents(&p);
    assert_eq!(c.len(), 2);
    if let Content::Table { rows, .. } = &c[0] {
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].len(), 2);
        assert_eq!(rows[0][0][0].marks, vec![(Mark::Bold, None)]);
        assert_eq!(rows[1][1][0].text, "=1+1");
    } else {
        panic!()
    }
    if let Content::Asset { descriptor } = &c[1] {
        assert_eq!(descriptor.metadata.alt, "alt 🙂");
        assert_eq!(descriptor.metadata.caption, "caption");
        assert_eq!(descriptor.metadata.byte_length, Some(PIXEL.len() as u64));
        assert_eq!(descriptor.metadata.width, Some(1));
    } else {
        panic!()
    }
    assert_eq!(h.originals, vec![PIXEL.to_vec()]);
    assert_eq!(p.report().staged_bytes, PIXEL.len());
    assert!(p.report().work.references > 0);
    assert_eq!(p.report().work.media_attempts, 1);
    println!(
        "ODT_SEMANTICS blocks={} utf16={} staged={} work={:?} network_calls=0",
        p.blocks().len(),
        p.report().utf16_units,
        p.report().staged_bytes,
        p.report().work
    );
}
#[test]
fn one_prepared_session_commit_undo_redo_reopen_and_original_recovery() {
    let (mut o, store) = structured_owner();
    let bytes = package(SUPPORTED);
    let before = checkpoint(&o);
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    assert_eq!(checkpoint(&o), before);
    assert_eq!(j.source().original(), bytes);
    assert_eq!(p.original_sha256, <[u8; 32]>::from(Sha256::digest(&bytes)));
    let c = p.commit(&mut j, &mut o, false, 0).unwrap().unwrap();
    assert_eq!(c.assets.len(), 1);
    assert_eq!(c.local_commit.durability, Durability::Volatile);
    let after = o.service().read(0).unwrap();
    let snap = &after.snapshot;
    assert!(snap.visible.iter().any(|n| n.kind == "list"));
    let get = |s: &str| {
        snap.visible
            .iter()
            .find(|n| n.runs.iter().map(|r| r.text.as_str()).collect::<String>() == s)
            .unwrap()
    };
    let a = get("Three");
    let b = get("Four");
    assert_eq!(a.parent, b.parent);
    assert_eq!(a.editor.as_ref().unwrap().number, Some(3));
    assert_eq!(b.editor.as_ref().unwrap().number, Some(4));
    assert_eq!(
        snap.visible
            .iter()
            .filter(|n| matches!(n.block_attributes, Some(BlockAttributes::Unknown(_))))
            .count(),
        2
    );
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(current(&o), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    assert!(current(&o).contains("Three"));
    let reopened = ConversionOwner::open(
        store.clone(),
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        policy(),
    )
    .unwrap();
    assert_eq!(current(&reopened), current(&o));
    let recovered = reopened.service().read(0).unwrap().snapshot;
    assert_eq!(
        recovered
            .visible
            .iter()
            .filter_map(|n| n.block_attributes.clone())
            .collect::<Vec<_>>(),
        snap.visible
            .iter()
            .filter_map(|n| n.block_attributes.clone())
            .collect::<Vec<_>>()
    );
    println!(
        "ODT_COMMIT commits=1 assets=1 undo=1 redo=1 reopen=1 original_bytes={} journal_durability_not_claimed=1",
        bytes.len()
    );
}
#[test]
fn whitespace_entities_cdata_and_mixed_spans_preserve_order() {
    let (o, _) = structured_owner();
    let bytes = package(&doc(
        "<text:p>  A \n B<text:span text:style-name=\"strong\">C</text:span>D<![CDATA[<E>]]>&#x1F642; &amp; Z  </text:p>",
    ));
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert_eq!(label(&p.blocks()[0]), "A BCD<E>🙂 & Z");
}
#[test]
fn explicit_normal_style_removes_inherited_mark() {
    let (o, _) = structured_owner();
    let d=doc("<text:p><text:span text:style-name=\"strong\">B<text:span text:style-name=\"normal\">N</text:span>B</text:span></text:p>").replace("</office:automatic-styles>","<style:style style:name=\"normal\" style:family=\"text\"><style:text-properties fo:font-weight=\"normal\"/></style:style></office:automatic-styles>");
    let (_, p) = prepared(&o, &package(&d), &mut MediaHost::default());
    assert_eq!(p.blocks()[0].runs[1].text, "N");
    assert!(p.blocks()[0].runs[1].marks.is_empty());
}
fn rejected(bytes: &[u8], expected: &str) {
    let (mut o, store) = structured_owner();
    let before = checkpoint(&o);
    let mut j = begin(&o, bytes, "rejected");
    let mut h = MediaHost::default();
    let e = match odt::prepare(&mut j, Budgets::default(), &mut h, || 0) {
        Ok(_) => panic!("expected {expected}"),
        Err(e) => e,
    };
    assert_eq!(e.code, expected, "{e:?}");
    assert_eq!(checkpoint(&o), before);
    assert_eq!(j.source().original(), bytes);
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    clean(&store, &mut h.inner);
    assert!(h.originals.is_empty());
}
#[test]
fn encrypted_package_is_explicit_before_ciphertext_xml_parse() {
    let m = manifest("").replace(
        "manifest:media-type=\"text/xml\"/>",
        "manifest:media-type=\"text/xml\"><manifest:encryption-data/></manifest:file-entry>",
    );
    rejected(
        &package_extra("not XML ciphertext", &m, &[]),
        "ODF_ENCRYPTED",
    );
}
#[test]
fn duplicate_manifest_entries_fail() {
    let m = manifest(
        "<manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/>",
    );
    rejected(&package_extra(SUPPORTED, &m, &[]), "ODF_DUPLICATE_MANIFEST");
}
#[test]
fn unmanifested_part_fails() {
    rejected(
        &package_extra(SUPPORTED, &manifest(""), &[("hidden.bin", b"secret")]),
        "ODF_UNMANIFESTED",
    );
}
#[test]
fn missing_required_manifest_part_fails() {
    let m = manifest(
        "<manifest:file-entry manifest:full-path=\"missing.xml\" manifest:media-type=\"text/xml\"/>",
    );
    rejected(
        &package_extra(SUPPORTED, &m, &[]),
        "ODF_MISSING_MANIFEST_PART",
    );
}
#[test]
fn wrong_mimetype_fails() {
    let b = zip(&[
        ("mimetype", b"application/zip"),
        ("META-INF/manifest.xml", manifest("").as_bytes()),
        ("content.xml", SUPPORTED.as_bytes()),
    ]);
    rejected(&b, "ODF_MIMETYPE");
}
#[test]
fn wrong_version_and_namespace_fail() {
    rejected(
        &package(&SUPPORTED.replace("office:version=\"1.3\"", "office:version=\"1.2\"")),
        "ODF_VERSION",
    );
    rejected(
        &package(&SUPPORTED.replace(
            "xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\"",
            "xmlns:office=\"urn:foreign\"",
        )),
        "ODF_VERSION",
    );
}
#[test]
fn traversal_part_and_remote_manifest_fail() {
    rejected(
        &package_extra(SUPPORTED, &manifest(""), &[("../outside", b"no")]),
        "INGRESS_Path",
    );
    let m = manifest(
        "<manifest:file-entry manifest:full-path=\"https://example.test/a\" manifest:media-type=\"text/xml\"/>",
    );
    rejected(&package_extra(SUPPORTED, &m, &[]), "INGRESS_Path");
}
#[test]
fn dtd_external_entity_malformed_encoding_and_nested_packages_fail() {
    rejected(
        &package("<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///etc/passwd'>]><x/>"),
        "INGRESS_Dtd",
    );
    rejected(
        &package("<?xml version='1.0' encoding='UTF-16'?><x/>"),
        "INGRESS_Encoding",
    );
    rejected(
        &package_extra(
            SUPPORTED,
            &manifest(""),
            &[("object.bin", b"PK\x03\x04payload")],
        ),
        "INGRESS_NestedPackage",
    );
}
#[test]
fn named_style_cycle_fails_safely() {
    let d = doc("<text:p><text:span text:style-name=\"strong\">x</text:span></text:p>").replace(
        "style:name=\"strong\" style:family=\"text\"",
        "style:name=\"strong\" style:family=\"text\" style:parent-style-name=\"emphasis\"",
    );
    rejected(&package(&d), "ODF_STYLE_CYCLE");
}
#[test]
fn output_expansion_and_table_rectangle_fail() {
    rejected(
        &package(&doc("<text:p><text:s text:c=\"999999999\"/></text:p>")),
        "BUDGET",
    );
    let d = doc(
        "<table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>",
    );
    rejected(&package(&d), "ODF_TABLE_RECTANGLE");
}
#[test]
fn unsupported_layout_fields_active_objects_remote_images_have_recoverable_complete_diagnostics() {
    let (o, _) = structured_owner();
    let d = doc(
        "<text:p>before<text:page-number>42</text:page-number><text:span text:style-name=\"strong\" text:unknown=\"x\">bold</text:span>after</text:p><office:scripts><office:script xlink:href=\"https://example.test/code\"/></office:scripts><draw:object xlink:href=\"file:///private\"/><text:p><draw:frame text:anchor-type=\"as-char\"><draw:image xlink:href=\"https://example.test/a.png\"/></draw:frame></text:p>",
    );
    let mut j = begin(&o, &package(&d), "loss");
    let p = odt::prepare(&mut j, Budgets::default(), &mut MediaHost::default(), || 0).unwrap();
    let ds = &p.report().diagnostics;
    for name in ["page-number", "scripts", "script", "object", "unknown"] {
        assert!(
            ds.iter().any(|d| d.location.contains(name)),
            "missing {name}: {ds:?}"
        )
    }
    assert!(
        ds.iter()
            .any(|d| d.code == "EXTERNAL_OR_UNSUPPORTED_IMAGE_INERT")
    );
    assert_eq!(label(&p.blocks()[0]), "beforeboldafter");
    assert_eq!(j.source().original(), package(&d));
}
#[test]
fn rejected_loss_aborts_only_owned_staging_and_preserves_history() {
    let (mut o, store) = structured_owner();
    let bytes = package(&SUPPORTED.replace(
        "Heading 🙂",
        "Heading 🙂<text:page-number>42</text:page-number>",
    ));
    let mut h = MediaHost::default();
    let mut sibling = begin(&o, &package(SUPPORTED), "sibling");
    sibling
        .stage_asset(asset(), AssetAction::Ingest, 12, &mut h.inner, 0)
        .unwrap();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    let before = checkpoint(&o);
    let e = p.commit(&mut j, &mut o, false, 0).err().unwrap();
    assert_eq!(e.code, "LOSS_APPROVAL");
    assert!(!e.diagnostics.is_empty());
    assert_eq!(checkpoint(&o), before);
    clean(&store, &mut h.inner);
    let cleanup = h
        .inner
        .effects
        .iter()
        .filter(|(_, a)| matches!(a, AssetAction::Cancel | AssetAction::ReleaseReference))
        .collect::<Vec<_>>();
    assert_eq!(cleanup.len(), 2);
    assert!(cleanup.iter().all(|(id, _)| id.starts_with("odt_")));
}
#[test]
fn explicit_loss_approval_commits_only_supported_projection() {
    let (mut o, _) = structured_owner();
    let bytes = package(&doc(
        "<text:p>visible<text:page-number>42</text:page-number></text:p>",
    ));
    let (mut j, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(p.commit(&mut j, &mut o, true, 0).unwrap().is_some());
    assert!(current(&o).contains("visible"));
    assert!(!current(&o).contains("42"));
    assert_eq!(j.source().original(), bytes);
}
#[test]
fn failed_media_stage_rolls_back_all_semantics() {
    let (mut o, store) = structured_owner();
    let bytes = package(SUPPORTED);
    let mut j = begin(&o, &bytes, "failure");
    let mut h = MediaHost {
        fail_ingest: true,
        ..Default::default()
    };
    let before = checkpoint(&o);
    assert!(odt::prepare(&mut j, Budgets::default(), &mut h, || 0).is_err());
    assert_eq!(checkpoint(&o), before);
    assert!(j.finish_import(&mut o, &blocks("never"), 0).is_err());
    clean(&store, &mut h.inner);
}
#[test]
fn cancellation_after_original_ingest_and_timeout_before_mapping_are_atomic() {
    let (o, store) = structured_owner();
    for timeout in [false, true] {
        let bytes = package(SUPPORTED);
        let mut j = begin(&o, &bytes, "cancel");
        let mut h = MediaHost::default();
        if !timeout {
            h.cancel = Some(j.cancellation())
        }
        let before = checkpoint(&o);
        assert!(
            odt::prepare(&mut j, Budgets::default(), &mut h, || if timeout {
                101
            } else {
                0
            })
            .is_err()
        );
        assert_eq!(checkpoint(&o), before);
        clean(&store, &mut h.inner);
    }
}
#[test]
fn host_capability_revocation_blocks_shared_batch_and_retires_assets() {
    let (mut o, store) = structured_owner();
    let bytes = package(SUPPORTED);
    let mut h = MediaHost::default();
    let (mut j, p) = prepared(&o, &bytes, &mut h);
    o.service_mut().set_policy(HostPolicy::default());
    let before = checkpoint(&o);
    assert!(p.commit(&mut j, &mut o, false, 0).is_err());
    assert_eq!(checkpoint(&o), before);
    clean(&store, &mut h.inner);
}
#[test]
fn foreign_job_prepared_batch_cannot_cross_job_identity() {
    let (mut o, _) = structured_owner();
    let bytes = package(SUPPORTED);
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    let mut j = begin(&o, &bytes, "other");
    assert_eq!(
        p.commit(&mut j, &mut o, false, 0).err().unwrap().code,
        "FOREIGN_JOB"
    );
}
#[test]
fn repeated_container_preparation_is_rejected() {
    let (o, _) = structured_owner();
    let bytes = package(SUPPORTED);
    let mut j = begin(&o, &bytes, "repeat");
    let _ = odt::prepare(&mut j, Budgets::default(), &mut MediaHost::default(), || 0).unwrap();
    let e = odt::prepare(&mut j, Budgets::default(), &mut MediaHost::default(), || 0)
        .err()
        .unwrap();
    assert_eq!(e.code, "INGRESS_Budget");
}
#[test]
fn repeated_images_keep_original_identity_and_charge_references() {
    let (o, _) = structured_owner();
    let frame = "<text:p><draw:frame text:anchor-type=\"as-char\"><draw:image xlink:href=\"Pictures/pixel.png\"/></draw:frame></text:p>";
    let bytes = package(&doc(&frame.repeat(3)));
    let mut h = MediaHost::default();
    let (_, p) = prepared(&o, &bytes, &mut h);
    assert_eq!(h.originals.len(), 1);
    assert_eq!(p.report().work.references, 3);
    assert_eq!(p.report().work.media_attempts, 3);
    let cs = contents(&p);
    assert_eq!(cs[0].tuple().unwrap(), cs[1].tuple().unwrap());
    assert_eq!(cs[1].tuple().unwrap(), cs[2].tuple().unwrap());
}
#[test]
fn independent_package_inspection_fixture_is_saved() {
    let (o, _) = structured_owner();
    let bytes = package(SUPPORTED);
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::write(dir.join("supported.odt"), bytes).unwrap();
        std::fs::write(
            dir.join("supported-projection.txt"),
            p.blocks().iter().map(label).collect::<Vec<_>>().join("\n"),
        )
        .unwrap();
    }
    assert_eq!(p.blocks().len(), 8);
}
#[test]
fn cancellation_deadline_and_stale_revision_at_commit_preserve_recoverable_state() {
    for case in 0..3 {
        let (mut o, store) = structured_owner();
        let bytes = package(SUPPORTED);
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
        clean(&store, &mut h.inner);
    }
}
#[test]
fn structural_scalar_text_is_reported_instead_of_disappearing() {
    let (o, _) = structured_owner();
    let d = doc("<text:p>okay<text:s>hidden</text:s></text:p>");
    let (_, p) = prepared(&o, &package(&d), &mut MediaHost::default());
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_STRUCTURAL_TEXT")
    );
}
#[test]
fn unsupported_cell_merges_and_row_repeats_are_explicit_failures() {
    for attr in [
        "table:number-columns-spanned=\"2\"",
        "table:number-rows-spanned=\"2\"",
        "table:number-columns-repeated=\"2\"",
    ] {
        let d = doc(&format!(
            "<table:table><table:table-row><table:table-cell {attr}><text:p>x</text:p></table:table-cell></table:table-row></table:table>"
        ));
        rejected(&package(&d), "UNSUPPORTED_TABLE_STRUCTURE");
    }
    let d = doc(
        "<table:table><table:table-row table:number-rows-repeated=\"2\"><table:table-cell><text:p>x</text:p></table:table-cell></table:table-row></table:table>",
    );
    rejected(&package(&d), "UNSUPPORTED_TABLE_REPEAT");
}
#[test]
fn inherited_namespace_amplification_is_bounded_before_node_allocation() {
    let big = "x".repeat(257);
    let content = doc("<text:p>x</text:p>").replace(
        "<office:body>",
        &format!("<office:body xmlns:evil=\"{big}\"><evil:element/>"),
    );
    rejected(&package(&content), "BUDGET");
}
#[test]
fn omitted_table_reports_all_nested_unknown_constructs() {
    let (o, _) = structured_owner();
    let bytes = package(&doc(
        "<text:p>kept</text:p><table:table><table:table-row><table:covered-table-cell/><table:table-cell><text:p><text:page-number>7</text:page-number></text:p><office:script/></table:table-cell></table:table-row></table:table>",
    ));
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert_eq!(p.blocks().len(), 1);
    for name in ["covered-table-cell", "page-number", "script"] {
        assert!(
            p.report()
                .diagnostics
                .iter()
                .any(|d| d.location.contains(name)),
            "missing {name}"
        )
    }
}
#[test]
fn collapsed_space_keeps_its_source_mark_boundary() {
    let (o, _) = structured_owner();
    let bytes = package(&doc(
        "<text:p>A <text:span text:style-name=\"strong\">B </text:span>C</text:p>",
    ));
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert_eq!(p.blocks()[0].runs[0].text, "A ");
    assert_eq!(p.blocks()[0].runs[1].text, "B ");
    assert_eq!(p.blocks()[0].runs[1].marks, vec![(Mark::Bold, None)]);
    assert_eq!(p.blocks()[0].runs[2].text, "C");
}
#[test]
fn supported_default_and_derived_underline_strike_and_resets_preserve_marks() {
    let (o, _) = structured_owner();
    let content=doc("<text:p>A<text:span text:style-name=\"both\">B</text:span>C</text:p>").replace("</office:automatic-styles>","<style:default-style style:family=\"paragraph\"><style:text-properties fo:font-weight=\"bold\"/></style:default-style><style:style style:name=\"both\" style:family=\"text\"><style:text-properties fo:font-weight=\"normal\" style:text-underline-style=\"solid\" style:text-line-through-style=\"solid\"/></style:style></office:automatic-styles>");
    let (_, p) = prepared(&o, &package(&content), &mut MediaHost::default());
    assert_eq!(p.blocks()[0].runs[0].marks, vec![(Mark::Bold, None)]);
    assert_eq!(
        p.blocks()[0].runs[1].marks,
        vec![(Mark::Underline, None), (Mark::Strike, None)]
    );
    assert_eq!(p.blocks()[0].runs[2].marks, vec![(Mark::Bold, None)]);
}
#[test]
fn nested_table_output_nodes_are_charged_and_irrelevant_paragraph_attributes_are_reported() {
    let (o, _) = structured_owner();
    let bytes = package(&SUPPORTED.replace("<text:p>A", "<text:p text:outline-level=\"6\">A"));
    let (_, p) = prepared(&o, &bytes, &mut MediaHost::default());
    assert!(
        p.report()
            .diagnostics
            .iter()
            .any(|d| d.location.contains("outline-level"))
    );
    assert!(p.report().work.nodes > 0);
    let nodes = p.report().work.nodes;
    let mut j = begin(&o, &bytes, "node-budget");
    let mut budget = Budgets::default();
    budget.nodes = nodes - 1;
    let e = odt::prepare(&mut j, budget, &mut MediaHost::default(), || 0)
        .err()
        .unwrap();
    assert_eq!(e.code, "INGRESS_Budget");
    assert!(
        e.work.nodes > 0 && e.work.nodes <= budget.nodes,
        "denied work must not be charged as executed: {e:?}"
    );
}
