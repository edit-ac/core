include!("support/jobs_harness.rs");
use editac_core::{
    commands::{format::Mark, lists::ContainerStyle},
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_formats::epub::export::{self as writer, OriginalAssetHost};
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
fn all_chapters(bytes: &[u8]) -> String {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut parts = Vec::new();
    for i in 0..z.len() {
        let n = z.by_index(i).unwrap().name().to_string();
        if n.starts_with("EPUB/chapter-") {
            parts.push(n)
        }
    }
    parts.sort();
    parts.into_iter().map(|n| part(bytes, &n)).collect()
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
                alt: "alt < 🙂\tline\nnext\rreturn".into(),
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
        FragmentBlock {
            attributes: Some(BlockAttributes::Heading(1)),
            ..blocks("Closing chapter").remove(0)
        },
    ]
}
fn save(name: &str, c: &writer::Completion) {
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("export-{name}.epub")), c.artifact.bytes()).unwrap();
        std::fs::write(dir.join(format!("export-{name}-report.json")),serde_json::to_vec_pretty(&serde_json::json!({"nodes":c.report.nodes,"assets":c.report.assets,"originalBytes":c.report.original_bytes,"outputBytes":c.artifact.bytes().len(),"diagnostics":c.report.diagnostics.iter().map(|d|serde_json::json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"mediaWork":{"pixels":c.report.media_work.pixels,"decodedBytes":c.report.media_work.decoded_bytes,"decodeCalls":c.report.media_work.decode_calls}})).unwrap()).unwrap();
    }
}
#[test]
fn supported_semantics_original_png_and_metadata() {
    let (mut o, _) = structured();
    insert(&mut o, &fixture());
    let before = checkpoint(&o);
    let mut j = begin(&o, "supported");
    expected("supported", &j);
    let mut host = Media::default();
    let c = writer::export(&mut j, None, false, &mut host, || 0).unwrap();
    assert_eq!(checkpoint(&o), before);
    assert_eq!(host.reads, 1);
    assert_eq!(c.report.assets, 1);
    assert_eq!(c.report.original_bytes, PIXEL.len());
    assert!(!c.report.diagnostics.iter().any(|d| d.lossy));
    let xml = all_chapters(c.artifact.bytes());
    assert!(xml.contains("<h2"));
    assert!(xml.contains("<ol start=\"7\""));
    assert!(xml.contains("<br/>"));
    assert!(xml.contains("&#13;"));
    let mut z = zip::ZipArchive::new(Cursor::new(c.artifact.bytes())).unwrap();
    assert_eq!(z.by_index(0).unwrap().name(), "mimetype");
    assert_eq!(
        z.by_index(0).unwrap().compression(),
        zip::CompressionMethod::Stored
    );
    let name = format!("EPUB/media/{:x}.png", Sha256::digest(PIXEL));
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
    assert!(!part(c.artifact.bytes(), "EPUB/chapter-0.xhtml").contains("LATER"));
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
    assert!(part(c.artifact.bytes(), "EPUB/chapter-0.xhtml").contains("language"));
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
            .filter(|i| z.by_index(*i).unwrap().name().starts_with("EPUB/media/"))
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

fn expected(name: &str, j: &PreparedJob<MemoryStore>) {
    fn rs(r: &[FragmentRun]) -> serde_json::Value {
        serde_json::json!(r.iter().map(|r|serde_json::json!({"text":r.text,"marks":r.marks.iter().map(|(m,v)|(format!("{m:?}"),v.clone())).collect::<Vec<_>>() })).collect::<Vec<_>>())
    }
    let projection=j.source().export_blocks().iter().map(|(_,b)|{
        let b=b.as_ref().unwrap();
        let lists=b.containers.iter().map(|(_,s)|match s {ContainerStyle::Ordered{start}=>serde_json::json!(["ol",start]),_=>serde_json::json!(["ul",1])}).collect::<Vec<_>>();
        match &b.attributes {
            Some(BlockAttributes::Unknown(t))=>match Content::from_tuple(t).unwrap().unwrap(){
                Content::Table{rows,alignments,..}=>serde_json::json!({"kind":"table","rows":rows.iter().map(|row|row.iter().map(|r|rs(r)).collect::<Vec<_>>()).collect::<Vec<_>>(),"alignments":alignments.iter().map(|a|match a {Alignment::Left=>"left",Alignment::Right=>"right",Alignment::Center=>"center",_=>"start"}).collect::<Vec<_>>() }),
                Content::Asset{descriptor}=>serde_json::json!({"kind":"image","alt":descriptor.metadata.alt,"caption":descriptor.metadata.caption,"hash":descriptor.metadata.sha256,"width":descriptor.metadata.width,"height":descriptor.metadata.height}),
                _=>panic!("unsupported expected fixture")
            },
            a=>serde_json::json!({"kind":match a {Some(BlockAttributes::Heading(n))=>format!("h{n}"),_=>"p".into()},"runs":rs(&b.runs),"lists":lists})
        }
    }).collect::<Vec<_>>();
    if let Some(dir) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("expected-{name}.json")),
            serde_json::to_vec_pretty(&projection).unwrap(),
        )
        .unwrap()
    }
}
#[test]
fn chapters_navigation_literal_injection_and_all_marks() {
    let (mut o, _) = structured();
    let mut first = blocks("Chapter <one> & 🦀").remove(0);
    first.attributes = Some(BlockAttributes::Heading(1));
    let mut input = vec![first];
    for mask in 0..32 {
        let mut b = blocks(&format!(
            "mask{mask}: </p><script src=\"https://evil.test/x\">& \t\n🙂 é"
        ))
        .remove(0);
        for (bit, mark) in [
            (1, Mark::Bold),
            (2, Mark::Italic),
            (4, Mark::Underline),
            (8, Mark::Strike),
            (16, Mark::Code),
        ] {
            if mask & bit != 0 {
                b.runs[0].marks.push((mark, None))
            }
        }
        input.push(b)
    }
    let mut nested = blocks("List heading stays here").remove(0);
    nested.attributes = Some(BlockAttributes::Heading(2));
    nested.containers = vec![("heading-list".into(), ContainerStyle::Ordered { start: 3 })];
    input.push(nested);
    let mut last = blocks("Second chapter العربية").remove(0);
    last.attributes = Some(BlockAttributes::Heading(2));
    input.push(last);
    insert(&mut o, &input);
    let before = checkpoint(&o);
    let mut j = begin(&o, "chapters");
    expected("chapters", &j);
    let c = writer::export(&mut j, None, false, &mut Media::default(), || 0).unwrap();
    assert_eq!(checkpoint(&o), before);
    let xml = all_chapters(c.artifact.bytes());
    assert!(!xml.contains("<script"));
    assert!(xml.contains("&lt;script"));
    let opf = part(c.artifact.bytes(), "EPUB/package.opf");
    assert!(!opf.contains("scripted"));
    assert!(opf.contains("reflowable"));
    save("chapters", &c);
}
#[test]
fn export_does_not_consume_history_and_reopens_exact_revision() {
    let (mut o, store) = structured();
    insert(&mut o, &fixture());
    let before = checkpoint(&o);
    let mut j = begin(&o, "history");
    let c = writer::export(&mut j, None, false, &mut Media::default(), || 0).unwrap();
    assert_eq!(checkpoint(&o), before);
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().undo(&r, 0).unwrap();
    assert_eq!(text(&o.service().read(0).unwrap().snapshot), "base");
    let r = o.service().read(0).unwrap().revision;
    o.service_mut().redo(&r, 0).unwrap();
    let mut p = HostPolicy::default();
    p.extensions = true;
    p.codecs.tables = true;
    p.codecs.callouts = true;
    let reopened = ConversionOwner::open(
        store,
        o.service().session().document().identity(),
        CachedPermission::LOCAL,
        p,
    )
    .unwrap();
    let d = writer::export(
        &mut begin(&reopened, "reopen"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .unwrap();
    assert_eq!(c.artifact.bytes(), d.artifact.bytes());
}
#[test]
fn cumulative_chapter_output_limit_is_not_a_per_chapter_limit() {
    let (mut o, _) = structured();
    let mut bs = vec![];
    for i in 0..40 {
        let mut b = blocks(&format!("heading{i} {}", "x".repeat(50))).remove(0);
        b.attributes = Some(BlockAttributes::Heading(1));
        bs.push(b)
    }
    insert(&mut o, &bs);
    let mut s = spec(&o, "total", Direction::Export);
    s.original = b"";
    s.profile = writer::PROFILE;
    s.limits.output_bytes = 4000;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let e = writer::export(&mut j, None, false, &mut Media::default(), || 0)
        .err()
        .unwrap();
    assert!(e.reason.contains("budget") || e.reason.contains("limit"));
}
#[cfg(feature = "epub-import")]
#[test]
fn imported_diagnostics_recovery_and_foreign_provenance_are_not_silently_dropped() {
    use editac_formats::{container::Budgets, epub::import as reader};
    use std::io::Write;
    impl reader::OriginalMediaHost for Media {
        fn identity(&self, h: &[u8; 32]) -> Result<AssetIdentity, PortError> {
            Ok(AssetIdentity {
                host: "local".into(),
                key: format!("{:x}", Sha256::digest(h)),
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
    let first = include_str!("../../../fixtures/formats/epub/first.xhtml")
        .replace("</body>", "<script>inert()</script></body>");
    let mut z = zip::ZipWriter::new(Cursor::new(vec![]));
    for (n, b) in [
        ("mimetype", b"application/epub+zip".as_slice()),
        (
            "META-INF/container.xml",
            include_bytes!("../../../fixtures/formats/epub/container.xml").as_slice(),
        ),
        (
            "EPUB/package.opf",
            include_bytes!("../../../fixtures/formats/epub/package.opf").as_slice(),
        ),
        (
            "EPUB/nav.xhtml",
            include_bytes!("../../../fixtures/formats/epub/nav.xhtml").as_slice(),
        ),
        ("EPUB/text/first.xhtml", first.as_bytes()),
        (
            "EPUB/text/second.xhtml",
            include_bytes!("../../../fixtures/formats/epub/second.xhtml").as_slice(),
        ),
        ("EPUB/images/pixel.png", PIXEL),
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
    let mut s = spec(&o, "read", Direction::Import);
    s.original = &bytes;
    s.profile = reader::PROFILE;
    s.memory_bytes = 32 * 1024 * 1024;
    let mut e = port().0;
    e.enforcement.hard_memory_bytes = s.memory_bytes;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), e, 0).unwrap();
    let p = reader::prepare(&mut j, Budgets::default(), &mut Media::default(), || 0).unwrap();
    let codes = p
        .report()
        .diagnostics
        .iter()
        .map(|d| d.code.to_string())
        .collect::<Vec<_>>();
    assert!(!codes.is_empty());
    let provenance = writer::Provenance::from_import(&p);
    p.commit(&mut j, &mut o, true, 0).unwrap();
    let before = checkpoint(&o);
    let mut s = spec(&o, "withsource", Direction::Export);
    s.profile = writer::PROFILE;
    s.original = &bytes;
    let mut j = PreparedJob::begin(&o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap();
    let c = writer::export(&mut j, Some(&provenance), true, &mut Media::default(), || 0).unwrap();
    assert_eq!(j.source().original(), bytes);
    assert_eq!(checkpoint(&o), before);
    for code in codes {
        assert!(
            c.report
                .diagnostics
                .iter()
                .any(|d| d.code == code && d.lossy)
        )
    }
    assert!(!all_chapters(c.artifact.bytes()).contains("<script"));
    save("provenance", &c);
    let e = writer::export(
        &mut begin(&o, "foreign"),
        Some(&provenance),
        true,
        &mut Media::default(),
        || 0,
    )
    .err()
    .unwrap();
    assert_eq!(e.reason, "foreign-provenance");
}

#[test]
fn empty_heading_uses_visible_chapter_label_without_changing_semantics() {
    let (mut o, _) = structured();
    let mut h = blocks("").remove(0);
    h.attributes = Some(BlockAttributes::Heading(1));
    // Keep the existing base suffix in a separate paragraph, so the captured
    // heading is genuinely empty at the shared insertion boundary.
    insert(&mut o, &[h, blocks("suffix").remove(0)]);
    let mut j = begin(&o, "emptytitle");
    assert!(
        j.source().export_blocks()[0]
            .1
            .as_ref()
            .unwrap()
            .runs
            .iter()
            .all(|r| r.text.is_empty())
    );
    expected("empty-title", &j);
    let c = writer::export(&mut j, None, false, &mut Media::default(), || 0).unwrap();
    assert!(part(c.artifact.bytes(), "EPUB/nav.xhtml").contains("Untitled chapter"));
    save("empty-title", &c);
}
#[test]
fn invalid_xml_control_fails_without_mutating_live_state() {
    let (mut o, _) = structured();
    insert(&mut o, &blocks("literal \u{0001} control"));
    let before = checkpoint(&o);
    let e = writer::export(
        &mut begin(&o, "control"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .err()
    .unwrap();
    assert_eq!(e.reason, "invalid-xml-text");
    assert_eq!(checkpoint(&o), before);
}
#[test]
fn chapter_title_is_bounded_before_xhtml_allocation() {
    let (mut o, _) = structured();
    let mut h = blocks(&"x".repeat(4097)).remove(0);
    h.attributes = Some(BlockAttributes::Heading(1));
    insert(&mut o, &[h]);
    let e = writer::export(
        &mut begin(&o, "titlelimit"),
        None,
        false,
        &mut Media::default(),
        || 0,
    )
    .err()
    .unwrap();
    assert_eq!(e.reason, "chapter-title-budget");
}
