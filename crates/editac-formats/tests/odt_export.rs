include!("support/jobs_harness.rs");
use editac_core::{
    commands::{format::Mark, lists::ContainerStyle},
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_formats::odt::export::{self as writer, OriginalAssetHost};
use std::io::{Cursor, Read};
const PIXEL: &[u8] = include_bytes!("../../../fixtures/formats/docx/probe/pixel.png");
#[derive(Default)]
struct Media {
    inner: Host,
    bytes: Option<Vec<u8>>,
    cancellation: Option<Cancellation>,
    reads: usize,
}
impl AssetHost for Media {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        self.inner.authorize(r)
    }
    fn execute(&mut self, id: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        self.inner.execute(id, r)
    }
}
impl OriginalAssetHost for Media {
    fn read_original(&mut self, _: &AssetRequest) -> Result<Vec<u8>, PortError> {
        self.reads += 1;
        if let Some(c) = &self.cancellation {
            c.cancel()
        }
        if self.inner.fail {
            return Err(PortError::Unavailable);
        }
        Ok(self.bytes.clone().unwrap_or_else(|| PIXEL.to_vec()))
    }
}
fn structured() -> (Owner, Arc<MemoryStore>) {
    let (mut o, s) = owner();
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p.codecs.callouts = true;
    o.service_mut().set_policy(p);
    (o, s)
}
fn insert(o: &mut Owner, bs: &[FragmentBlock]) {
    let mut j = job(o, "insert", Direction::Import);
    j.finish_import(o, bs, 0).unwrap();
}
fn begin(o: &Owner, id: &str) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Export);
    s.original = b"";
    s.profile = writer::PROFILE;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut p = port().0;
    p.enforcement.hard_memory_bytes = s.memory_bytes;
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), p, 0).unwrap()
}
fn part(bytes: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}
fn checkpoint(o: &Owner) -> Vec<u8> {
    o.service().session().document().checkpoint().bytes
}
fn atom(c: Content) -> FragmentBlock {
    FragmentBlock {
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: match &c {
                Content::Table { source, .. } => source.clone(),
                _ => c
                    .asset_fallback()
                    .or_else(|| c.inert_source())
                    .unwrap_or("")
                    .to_string(),
            },
            marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(c.tuple().unwrap())),
        containers: vec![],
        checked: None,
    }
}
fn image(bytes: &[u8], key: &str) -> FragmentBlock {
    atom(Content::Asset {
        descriptor: AssetDescriptor {
            identity: AssetIdentity {
                host: "local".into(),
                key: key.into(),
            },
            kind: AssetKind::Image,
            metadata: AssetMetadata {
                filename: "pixel.png".into(),
                media_type: "image/png".into(),
                byte_length: Some(bytes.len() as u64),
                sha256: Some(format!("{:x}", Sha256::digest(bytes))),
                width: Some(1),
                height: Some(1),
                duration_ms: None,
                alt: "alt < 🙂".into(),
                caption: "caption & title".into(),
            },
            fallback: "image".into(),
            source: String::new(),
        },
    })
}
fn fixture() -> Vec<FragmentBlock> {
    let mut h = blocks(" A & <B> \"quoted\" 🦀 é العربية  \tline\nlast\rreturn ").remove(0);
    h.attributes = Some(BlockAttributes::Heading(2));
    h.runs[0].marks = vec![
        (Mark::Bold, None),
        (Mark::Italic, None),
        (Mark::Underline, None),
        (Mark::Strike, None),
    ];
    let mut link = blocks("safe link").remove(0);
    link.runs[0].marks = vec![(Mark::Link, Some("https://example.test/a?x=1&y=2".into()))];
    let mut a = blocks("number-first").remove(0);
    a.containers = vec![("ordered".into(), ContainerStyle::Ordered { start: 7 })];
    let mut nested = blocks("nested-bullet").remove(0);
    nested.containers = vec![
        ("ordered".into(), ContainerStyle::Ordered { start: 7 }),
        ("nested".into(), ContainerStyle::Unordered),
    ];
    let mut b = blocks("number-second").remove(0);
    b.containers = a.containers.clone();
    let mut u = blocks("adjacent-bullet").remove(0);
    u.containers = vec![("bullet".into(), ContainerStyle::Unordered)];
    let mut code = blocks("code literal").remove(0);
    code.runs[0].marks = vec![(Mark::Code, None)];
    let table = atom(Content::Table {
        alignments: vec![Alignment::Left, Alignment::Right],
        rows: vec![
            vec![
                vec![FragmentRun {
                    opaque_marks: vec![],
                    text: "cell A".into(),
                    marks: vec![(Mark::Bold, None)],
                }],
                vec![FragmentRun {
                    opaque_marks: vec![],
                    text: "cell B 🙂".into(),
                    marks: vec![],
                }],
            ],
            vec![
                vec![],
                vec![FragmentRun {
                    opaque_marks: vec![],
                    text: "0".into(),
                    marks: vec![(Mark::Italic, None)],
                }],
            ],
        ],
        source: String::new(),
    });
    vec![
        h,
        link,
        a,
        nested,
        b,
        u,
        table,
        image(PIXEL, "one"),
        code,
        blocks("").remove(0),
    ]
}
fn save(name: &str, c: &writer::Completion) {
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("export-{name}.odt")), c.artifact.bytes()).unwrap();
        std::fs::write(dir.join(format!("export-{name}-report.json")),serde_json::to_vec_pretty(&serde_json::json!({"nodes":c.report.nodes,"assets":c.report.assets,"originalBytes":c.report.original_bytes,"outputBytes":c.artifact.bytes().len(),"diagnostics":c.report.diagnostics.iter().map(|d|serde_json::json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"mediaWork":{"pixels":c.report.media_work.pixels,"decodedBytes":c.report.media_work.decoded_bytes,"decodeCalls":c.report.media_work.decode_calls}})).unwrap()).unwrap();
    }
}
#[test]
fn supported_semantics_original_png_and_metadata() {
    let (mut o, _) = structured();
    insert(&mut o, &fixture());
    let before = checkpoint(&o);
    let mut j = begin(&o, "supported");
    let mut host = Media::default();
    let c = writer::export(&mut j, None, false, &mut host, || 0).unwrap();
    assert_eq!(checkpoint(&o), before);
    assert_eq!(host.reads, 1);
    assert_eq!(c.report.assets, 1);
    assert_eq!(c.report.original_bytes, PIXEL.len());
    assert!(!c.report.diagnostics.iter().any(|d| d.lossy));
    let xml = part(c.artifact.bytes(), "content.xml");
    assert!(xml.contains("text:outline-level=\"2\""));
    assert!(xml.contains("text:start-value=\"7\""));
    assert!(xml.contains("text:line-break"));
    assert!(xml.contains("&#13;"));
    let mut z = zip::ZipArchive::new(Cursor::new(c.artifact.bytes())).unwrap();
    assert_eq!(z.by_index(0).unwrap().name(), "mimetype");
    assert_eq!(
        z.by_index(0).unwrap().compression(),
        zip::CompressionMethod::Stored
    );
    let name = format!("Pictures/{:x}.png", Sha256::digest(PIXEL));
    let mut b = vec![];
    z.by_name(&name).unwrap().read_to_end(&mut b).unwrap();
    assert_eq!(b, PIXEL);
    save("supported", &c);
}
#[test]
fn captured_revision_never_mixes_later_edits() {
    let (mut o, _) = structured();
    let mut j = begin(&o, "fixed");
    let rev = j.contract().revision.clone();
    edit(&mut o, "LATER");
    let before = checkpoint(&o);
    let c = writer::export(&mut j, None, false, &mut Media::default(), || 0).unwrap();
    assert_eq!(c.artifact.revision(), &rev);
    assert!(!part(c.artifact.bytes(), "content.xml").contains("LATER"));
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn deterministic_package_despite_job_identity() {
    let (mut o, _) = structured();
    insert(&mut o, &fixture());
    let a = writer::export(
        &mut begin(&o, "a"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .unwrap();
    let b = writer::export(
        &mut begin(&o, "b"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .unwrap();
    assert_eq!(a.artifact.bytes(), b.artifact.bytes());
}
#[test]
fn loss_requires_explicit_approval_and_is_retained() {
    let (mut o, _) = structured();
    let mut b = blocks("language code").remove(0);
    b.attributes = Some(BlockAttributes::Code("rust".into()));
    insert(&mut o, &[b]);
    let before = checkpoint(&o);
    let e = writer::export(
        &mut begin(&o, "deny"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .err()
    .unwrap();
    assert_eq!(e.reason, "loss-approval-required");
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_BLOCK_STYLE" && d.lossy)
    );
    let c = writer::export(
        &mut begin(&o, "allow"),
        None,
        true,
        &mut Media::default(),
        || 0,
    )
    .unwrap();
    assert!(part(c.artifact.bytes(), "content.xml").contains("language"));
    assert_eq!(checkpoint(&o), before);
    save("lossy", &c);
}
#[test]
fn source_without_provenance_requires_loss_approval() {
    let (o, _) = structured();
    let mut s = spec(&o, "unknown", Direction::Export);
    s.profile = writer::PROFILE;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let e = writer::export(&mut j, None, false, &mut Media::default(), || 0)
        .err()
        .unwrap();
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "SOURCE_PROVENANCE_UNAVAILABLE")
    );
}
#[test]
fn unapproved_content_atom_reports_loss() {
    let (mut o, _) = structured();
    insert(
        &mut o,
        &[atom(Content::Callout {
            kind: "NOTE".into(),
            body: "body".into(),
            source: "source".into(),
        })],
    );
    let e = writer::export(
        &mut begin(&o, "unknownatom"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .err()
    .unwrap();
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_CONTENT")
    );
}
#[test]
fn cancelled_before_work_has_no_effects() {
    let (o, _) = structured();
    let mut j = begin(&o, "cancel");
    j.cancellation().cancel();
    let before = checkpoint(&o);
    let mut h = Media::default();
    assert!(writer::export(&mut j, None, false, &mut h, || 0).is_err());
    assert_eq!(h.reads, 0);
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn deadline_during_serialization_produces_no_artifact() {
    let (mut o, _) = structured();
    insert(&mut o, &fixture());
    let mut ticks = 0;
    let e = writer::export(
        &mut begin(&o, "deadline"),
        None,
        false,
        &mut Media::default(),
        || {
            ticks += 1;
            if ticks > 2 { 1000 } else { 0 }
        },
    )
    .err()
    .unwrap();
    assert!(e.reason.contains("job:"));
}
#[test]
fn asset_authorization_failure_preserves_document() {
    let (mut o, _) = structured();
    insert(&mut o, &[image(PIXEL, "one")]);
    let before = checkpoint(&o);
    let mut h = Media::default();
    h.inner.denied = true;
    let e = writer::export(&mut begin(&o, "denied"), None, false, &mut h, || 0)
        .err()
        .unwrap();
    assert!(e.reason.starts_with("asset-read:"));
    assert_eq!(h.reads, 0);
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn asset_read_failure_preserves_document() {
    let (mut o, _) = structured();
    insert(&mut o, &[image(PIXEL, "one")]);
    let before = checkpoint(&o);
    let mut h = Media::default();
    h.inner.fail = true;
    assert!(writer::export(&mut begin(&o, "readfail"), None, false, &mut h, || 0).is_err());
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn changed_asset_bytes_fail_identity() {
    let (mut o, _) = structured();
    insert(&mut o, &[image(PIXEL, "one")]);
    let mut h = Media {
        bytes: Some(vec![0; PIXEL.len()]),
        ..Default::default()
    };
    let e = writer::export(&mut begin(&o, "changed"), None, false, &mut h, || 0)
        .err()
        .unwrap();
    assert_eq!(e.reason, "asset-identity-mismatch");
}
#[test]
fn corrupt_png_with_matching_hash_fails_decoder() {
    let (mut o, _) = structured();
    let mut bytes = PIXEL.to_vec();
    let n = bytes.len();
    bytes[n - 1] ^= 1;
    insert(&mut o, &[image(&bytes, "bad")]);
    let mut h = Media {
        bytes: Some(bytes),
        ..Default::default()
    };
    let e = writer::export(&mut begin(&o, "corrupt"), None, false, &mut h, || 0)
        .err()
        .unwrap();
    assert!(e.reason.starts_with("asset-media:"));
}
#[test]
fn cancellation_during_asset_read_has_no_artifact() {
    let (mut o, _) = structured();
    insert(&mut o, &[image(PIXEL, "one")]);
    let mut j = begin(&o, "assetcancel");
    let mut h = Media {
        cancellation: Some(j.cancellation()),
        ..Default::default()
    };
    assert!(writer::export(&mut j, None, false, &mut h, || 0).is_err());
}
#[test]
fn bounded_output_never_succeeds_truncated() {
    let (o, _) = structured();
    let mut s = spec(&o, "limit", Direction::Export);
    s.profile = writer::PROFILE;
    s.original = b"";
    s.limits.output_bytes = 128;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    assert!(
        writer::export(&mut j, None, false, &mut Media::default(), || 0)
            .err()
            .unwrap()
            .reason
            .contains("budget")
    );
}
#[test]
fn wrong_direction_profile_fails_before_asset_read() {
    let (o, _) = structured();
    let mut h = Media::default();
    assert_eq!(
        writer::export(
            &mut job(&o, "wrong", Direction::Import),
            None,
            false,
            &mut h,
            || 0
        )
        .err()
        .unwrap()
        .reason,
        "export-profile-required"
    );
    assert_eq!(h.reads, 0);
}
#[test]
fn nested_lists_close_when_returning_to_parent_and_plain_text() {
    let (mut o, _) = structured();
    insert(&mut o, &fixture()[2..6]);
    let c = writer::export(
        &mut begin(&o, "list"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .unwrap();
    save("lists", &c);
}
#[test]
fn equal_media_content_under_distinct_identities_is_authorized_per_reference() {
    let (mut o, _) = structured();
    insert(&mut o, &[image(PIXEL, "one"), image(PIXEL, "two")]);
    let mut h = Media::default();
    let c = writer::export(&mut begin(&o, "duplicates"), None, false, &mut h, || 0).unwrap();
    assert_eq!(h.reads, 2);
    assert_eq!(c.report.media_work.decode_calls, 2);
    let mut z = zip::ZipArchive::new(Cursor::new(c.artifact.bytes())).unwrap();
    assert_eq!(
        (0..z.len())
            .filter(|i| z.by_index(*i).unwrap().name().starts_with("Pictures/"))
            .count(),
        1
    );
}
#[test]
fn output_node_budget_rejects_before_assets() {
    let (mut o, _) = structured();
    insert(&mut o, &fixture());
    let mut s = spec(&o, "nodes", Direction::Export);
    s.profile = writer::PROFILE;
    s.original = b"";
    s.limits.nodes = 1;
    let before = checkpoint(&o);
    assert!(matches!(
        PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0),
        Err(JobError::ResourceLimit)
    ));
    assert_eq!(checkpoint(&o), before);
}
#[cfg(feature = "odt-import")]
#[test]
fn imported_loss_and_original_provenance_survive_export_and_foreign_source_is_rejected() {
    use editac_formats::{container::Budgets, odt::import as reader};
    use std::io::Write;
    impl reader::OriginalMediaHost for Media {
        fn identity(&self, hash: &[u8; 32]) -> Result<AssetIdentity, PortError> {
            Ok(AssetIdentity {
                host: "local".into(),
                key: format!("{:x}", Sha256::digest(hash)),
            })
        }
        fn ingest_original(
            &mut self,
            _: &str,
            _: &AssetRequest,
            _: &[u8],
        ) -> Result<HostOutcome, PortError> {
            Ok(HostOutcome::Complete)
        }
    }
    let content = r#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><text:p>Known <text:date>field</text:date></text:p></office:text></office:body></office:document-content>"#;
    let manifest = r#"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>"#;
    let mut z = zip::ZipWriter::new(Cursor::new(vec![]));
    for (n, b) in [
        (
            "mimetype",
            b"application/vnd.oasis.opendocument.text".as_slice(),
        ),
        ("content.xml", content.as_bytes()),
        ("META-INF/manifest.xml", manifest.as_bytes()),
    ] {
        z.start_file(
            n,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        z.write_all(b).unwrap();
    }
    let bytes = z.finish().unwrap().into_inner();
    let (mut o, _) = structured();
    let mut s = spec(&o, "original", Direction::Import);
    s.profile = reader::PROFILE;
    s.original = &bytes;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut execution = port().0;
    execution.enforcement.hard_memory_bytes = 32 * 1024 * 1024;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), execution, 0).unwrap();
    let p = reader::prepare(&mut j, Budgets::default(), &mut Media::default(), || 0).unwrap();
    assert!(!p.report().diagnostics.is_empty());
    let expected = p
        .report()
        .diagnostics
        .iter()
        .map(|d| d.code.to_string())
        .collect::<Vec<_>>();
    let provenance = writer::Provenance::from_import(&p);
    p.commit(&mut j, &mut o, true, 0).unwrap();
    let mut s = spec(&o, "exportsource", Direction::Export);
    s.profile = writer::PROFILE;
    s.original = &bytes;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let c = writer::export(&mut j, Some(&provenance), true, &mut Media::default(), || 0).unwrap();
    for code in expected {
        assert!(
            c.report
                .diagnostics
                .iter()
                .any(|d| d.code == code && d.lossy)
        );
    }
    assert!(!part(c.artifact.bytes(), "content.xml").contains("text:date"));
    assert_eq!(
        writer::export(
            &mut begin(&o, "foreign"),
            Some(&provenance),
            true,
            &mut Media::default(),
            || 0
        )
        .err()
        .unwrap()
        .reason,
        "foreign-provenance"
    );
    assert_eq!(j.source().original(), bytes);
}
