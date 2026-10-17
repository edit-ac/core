include!("support/jobs_harness.rs");
use editac_core::{
    commands::format::Mark,
    document::BlockAttributes,
    modules::content::{Alignment, Content},
};
use editac_formats::pdf::export as pdf;
const PNG: &[u8] = include_bytes!("../../../fixtures/formats/pdf/export/panels.png");
const EXCESS: &[u8] = include_bytes!("../../../fixtures/formats/pdf/export/excess-inflate.png");
const FIXTURE: &str = include_str!("../../../fixtures/formats/pdf/export/structure.json");
const LATIN: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Regular.ttf");
const ARABIC: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoNaskhArabic-Regular.ttf");
const BOLD: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Bold.ttf");
const ITALIC: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Italic.ttf");
const BOTH: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-BoldItalic.ttf");
const MONO: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSansMono-Regular.ttf");
fn fonts() -> pdf::Fonts<'static> {
    pdf::Fonts {
        base: [LATIN, ARABIC],
        rich: Some([BOLD, ITALIC, BOTH, MONO]),
    }
}
fn image(bytes: &[u8]) -> AssetDescriptor {
    AssetDescriptor {
        identity: asset(),
        kind: AssetKind::Image,
        metadata: AssetMetadata {
            filename: "panels.png".into(),
            media_type: "image/png".into(),
            byte_length: Some(bytes.len() as u64),
            sha256: Some(format!("{:x}", Sha256::digest(bytes))),
            width: Some(120),
            height: Some(60),
            duration_ms: None,
            alt: "Red, green and blue vertical panels".into(),
            caption: "Original authorized color panels".into(),
        },
        fallback: "[original color panels]".into(),
        source: "inert original image source".into(),
    }
}
fn atom(c: Content) -> FragmentBlock {
    let text = c.asset_fallback().unwrap_or("").to_string();
    FragmentBlock {
        runs: vec![FragmentRun {
            text,
            marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(c.tuple().unwrap())),
        containers: vec![],
        checked: None,
    }
}
fn table(rows: Vec<Vec<Vec<FragmentRun>>>, alignments: Vec<Alignment>) -> FragmentBlock {
    atom(Content::Table {
        rows,
        alignments,
        source: "inert table source".into(),
    })
}
fn content() -> Vec<FragmentBlock> {
    let f: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    let rows = f["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            row.as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    vec![FragmentRun {
                        text: c["text"].as_str().unwrap().into(),
                        marks: if c["marks"].as_array().unwrap().is_empty() {
                            vec![]
                        } else {
                            vec![(Mark::Bold, None)]
                        },
                    }]
                })
                .collect()
        })
        .collect();
    vec![
        blocks("Before table").remove(0),
        table(rows, vec![Alignment::Left, Alignment::Center]),
        atom(Content::Asset {
            descriptor: image(PNG),
        }),
        blocks("After original image").remove(0),
    ]
}
fn authored(content: &[FragmentBlock]) -> (Owner, Arc<MemoryStore>) {
    let id = identity();
    let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
    let mut o = ConversionOwner::create(
        store.clone(),
        id,
        &[InitialNode {
            kind: "block".into(),
            text: String::new(),
        }],
        HostPolicy::default(),
    )
    .unwrap();
    let mut policy = HostPolicy::default();
    policy.extensions = true;
    policy.codecs.tables = true;
    policy.codecs.images = true;
    o.service_mut().set_policy(policy);
    let mut j = job(&o, "structure-author", Direction::Import);
    j.finish_import(&mut o, content, 0).unwrap();
    (o, store)
}
fn begin(o: &Owner, id: &str, limits: Limits) -> PreparedJob<MemoryStore> {
    let mut s = spec(o, id, Direction::Export);
    s.profile = pdf::PROFILE;
    s.limits = limits;
    s.original = b"";
    s.filename = "publication.pdf";
    s.media_type = "application/pdf";
    PreparedJob::begin(o, s, &JobPool::new(2).unwrap(), port().0, 0).unwrap()
}
#[derive(Default)]
struct MediaHost {
    inner: Host,
    bytes: Option<Vec<u8>>,
    reads: usize,
    cancel: Option<Cancellation>,
    read_fail: bool,
    wrong_grant: bool,
}
impl AssetHost for MediaHost {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        let mut g = self.inner.authorize(r)?;
        if self.wrong_grant {
            g.identity.key = "another_asset".into();
        }
        Ok(g)
    }
    fn execute(&mut self, id: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        self.inner.execute(id, r)
    }
}
impl pdf::OriginalAssetHost for MediaHost {
    fn read_original(&mut self, r: &AssetRequest) -> Result<Vec<u8>, PortError> {
        assert_eq!(r.action, AssetAction::Read);
        assert_eq!(r.identity, asset());
        self.reads += 1;
        if let Some(c) = &self.cancel {
            c.cancel();
        }
        if self.read_fail {
            return Err(PortError::Unavailable);
        }
        let bytes = self.bytes.clone().unwrap_or_else(|| PNG.to_vec());
        if bytes.len() as u64 > r.byte_limit {
            return Err(PortError::Quota);
        }
        Ok(bytes)
    }
}
#[test]
fn captured_rectangular_table_and_original_image_generate_paginated_tagged_artifact() {
    let (mut o, store) = authored(&content());
    let revision = o.service().read(0).unwrap().revision;
    let mut j = begin(&o, "pdf-structure", pdf::PROFILE.limits);
    edit(&mut o, " later edit");
    let before = current(&o);
    let mut host = MediaHost::default();
    let c = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1).unwrap();
    assert_eq!(c.artifact.revision(), &revision);
    assert_eq!(current(&o), before);
    assert_eq!(host.reads, 1);
    assert_eq!(c.report.cells.len(), 18);
    assert_eq!(c.report.images.len(), 1);
    assert!(c.report.pages >= 3);
    assert_eq!(c.report.pixels, 7200);
    assert_eq!(c.report.original_bytes, PNG.len());
    for cell in &c.report.cells {
        assert!(cell.y + cell.height <= 332.0);
        for line in c.report.lines.iter().filter(|l| l.block == cell.block) {
            assert_eq!(line.page, cell.page);
            assert!(line.x >= cell.x + 5.99);
            assert!(line.x + line.width <= cell.x + cell.width - 5.99);
        }
    }
    clean(&store, &mut host.inner);
    assert!(
        host.inner
            .effects
            .iter()
            .any(|(_, a)| *a == AssetAction::ReleaseReference)
    );
    if let Some(path) = std::env::var_os("EDITAC_FORMATS_OUTPUT") {
        let root = std::path::PathBuf::from(path);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("structure-publication.pdf"), c.artifact.bytes()).unwrap();
        let lines=c.report.lines.iter().map(|l|serde_json::json!({"block":l.block,"page":l.page,"text":l.text,"x":l.x,"y":l.y,"width":l.width})).collect::<Vec<_>>();
        let cells=c.report.cells.iter().map(|b|serde_json::json!({"block":b.block,"page":b.page,"x":b.x,"y":b.y,"width":b.width,"height":b.height})).collect::<Vec<_>>();
        let images=c.report.images.iter().map(|b|serde_json::json!({"block":b.block,"page":b.page,"x":b.x,"y":b.y,"width":b.width,"height":b.height})).collect::<Vec<_>>();
        std::fs::write(root.join("structure-layout.json"),serde_json::to_vec_pretty(&serde_json::json!({"pages":c.report.pages,"lines":lines,"cells":cells,"images":images,"pixels":c.report.pixels,"pngScanBytes":c.report.png_scan_bytes,"pngScanCalls":c.report.png_scan_calls,"shapedBytes":c.report.shaped_bytes,"originalBytes":c.report.original_bytes,"bytes":c.artifact.bytes().len()})).unwrap()).unwrap();
    }
}
#[test]
fn denied_and_mismatched_authority_never_read_original_or_mutate_session() {
    let (o, store) = authored(&content());
    let before = current(&o);
    for mismatch in [false, true] {
        let mut j = begin(&o, "pdf-denied", pdf::PROFILE.limits);
        let mut host = MediaHost {
            wrong_grant: mismatch,
            ..Default::default()
        };
        host.inner.denied = !mismatch;
        let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
            .err()
            .unwrap();
        assert!(e.reason.contains("ASSET_READ"));
        assert_eq!(host.reads, 0);
        assert_eq!(j.work().bytes, 0);
        assert_eq!(before, current(&o));
        clean(&store, &mut host.inner);
    }
}
#[test]
fn short_corrupt_and_failed_original_reads_are_atomic_and_recoverable() {
    let (o, store) = authored(&content());
    let before = current(&o);
    for case in 0..3 {
        let mut j = begin(&o, "pdf-bad-read", pdf::PROFILE.limits);
        let mut b = PNG.to_vec();
        if case == 0 {
            b.pop();
        } else {
            b[40] ^= 1;
        }
        let mut host = MediaHost {
            bytes: Some(b),
            read_fail: case == 2,
            ..Default::default()
        };
        let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
            .err()
            .unwrap();
        assert!(e.reason.contains(if case == 2 {
            "ASSET_READ"
        } else {
            "ASSET_IDENTITY_MISMATCH"
        }));
        assert_eq!(j.work().bytes, 0);
        assert_eq!(before, current(&o));
        assert!(!j.source().snapshot().visible.is_empty());
        clean(&store, &mut host.inner);
    }
}
#[test]
fn cancellation_during_original_read_releases_only_owned_resources() {
    let (o, store) = authored(&content());
    let before = current(&o);
    let mut sibling = begin(&o, "pdf-sibling", pdf::PROFILE.limits);
    let mut j = begin(&o, "pdf-cancel-read", pdf::PROFILE.limits);
    let mut host = MediaHost {
        cancel: Some(j.cancellation()),
        ..Default::default()
    };
    let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
        .err()
        .unwrap();
    assert!(e.reason.contains("Cancelled"));
    assert_eq!(j.work().bytes, 0);
    assert_eq!(current(&o), before);
    clean(&store, &mut host.inner);
    assert!(
        pdf::export_with_assets(
            &mut sibling,
            fonts(),
            &mut MediaHost::default(),
            false,
            || 1
        )
        .is_ok()
    );
}
#[test]
fn table_page_output_and_deadline_failures_never_return_partial_artifacts() {
    let (o, store) = authored(&content());
    let before = current(&o);
    for case in 0..3 {
        let mut limits = pdf::PROFILE.limits;
        if case == 0 {
            limits.pages = 1;
        }
        if case == 1 {
            limits.output_bytes = 64;
        }
        let mut j = begin(&o, "pdf-structure-limit", limits);
        let mut host = MediaHost::default();
        let mut calls = 0;
        let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || {
            calls += 1;
            if case == 2 && calls > 10 { 1000 } else { 1 }
        })
        .err()
        .unwrap();
        assert!(
            e.reason
                .contains(["PAGE_LIMIT", "ResourceLimit", "Timeout"][case]),
            "{}",
            e.reason
        );
        assert_eq!(j.work().bytes, 0);
        assert_eq!(current(&o), before);
        clean(&store, &mut host.inner);
    }
}
#[test]
fn oversized_rows_and_cell_counts_refuse_instead_of_clipping_or_truncating() {
    for rows in [
        vec![vec![vec![FragmentRun {
            text: "very long cell ".repeat(400),
            marks: vec![],
        }]]],
        vec![vec![vec![], vec![]]; 65],
    ] {
        let columns = rows[0].len();
        let (o, _) = authored(&[table(rows, vec![Alignment::None; columns])]);
        let mut j = begin(&o, "pdf-large-table", pdf::PROFILE.limits);
        let e = pdf::export_with_fonts(&mut j, fonts(), false, || 1)
            .err()
            .unwrap();
        assert!(
            e.reason == "TABLE_ROW_TOO_TALL"
                || e.report
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "TABLE_CELL_LIMIT"),
            "{}",
            e.reason
        );
        assert_eq!(j.work().bytes, 0);
    }
}
#[test]
fn empty_unicode_long_word_and_aligned_cells_preserve_exact_text() {
    let texts = [
        "".to_string(),
        "Cafe\u{301} literal line".into(),
        "longword".repeat(12),
    ];
    let rows = vec![
        texts
            .iter()
            .map(|t| {
                vec![FragmentRun {
                    text: t.clone(),
                    marks: vec![],
                }]
            })
            .collect(),
    ];
    let (o, _) = authored(&[table(
        rows,
        vec![Alignment::Left, Alignment::Center, Alignment::Right],
    )]);
    let mut j = begin(&o, "pdf-cell-wrap", pdf::PROFILE.limits);
    let c = pdf::export_with_fonts(&mut j, fonts(), false, || 1).unwrap();
    assert_eq!(c.report.cells.len(), 3);
    for (i, t) in texts.iter().enumerate() {
        let b = c.report.cells[i].block;
        assert_eq!(
            &c.report
                .lines
                .iter()
                .filter(|l| l.block == b)
                .map(|l| l.text.as_str())
                .collect::<String>(),
            t
        );
    }
}
#[test]
fn remote_image_and_unqualified_png_metadata_refuse_without_fetch_or_decode() {
    let remote = atom(Content::Image {
        url: "https://example.test/private.png".into(),
        alt: "remote".into(),
        title: "".into(),
        source: "remote source".into(),
    });
    let (o, _) = authored(&[remote]);
    let mut j = begin(&o, "pdf-remote-image", pdf::PROFILE.limits);
    let mut host = MediaHost::default();
    let e = pdf::export_with_assets(&mut j, fonts(), &mut host, true, || 1)
        .err()
        .unwrap();
    assert!(
        e.report
            .diagnostics
            .iter()
            .any(|d| d.code == "UNSUPPORTED_ATOMIC_CONTENT")
    );
    assert_eq!(host.reads, 0);
    let mut bytes = PNG.to_vec();
    bytes[25] = 3;
    let d = image(&bytes);
    let (o, _) = authored(&[atom(Content::Asset { descriptor: d })]);
    let mut j = begin(&o, "pdf-png-profile", pdf::PROFILE.limits);
    host.bytes = Some(bytes);
    assert_eq!(
        pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
            .err()
            .unwrap()
            .reason,
        "ASSET_PNG_PROFILE"
    );
}
#[test]
fn image_dimensions_and_expansion_budget_are_checked_before_decoder_allocation() {
    for huge in [false, true] {
        let mut bytes = PNG.to_vec();
        let mut d = image(&bytes);
        if huge {
            bytes[16..20].copy_from_slice(&2000u32.to_be_bytes());
            bytes[20..24].copy_from_slice(&2000u32.to_be_bytes());
            d.metadata.width = Some(2000);
            d.metadata.height = Some(2000);
        } else {
            d.metadata.width = Some(121);
        }
        d.metadata.sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
        let (o, _) = authored(&[atom(Content::Asset { descriptor: d })]);
        let mut j = begin(&o, "pdf-expansion", pdf::PROFILE.limits);
        let mut host = MediaHost {
            bytes: Some(bytes),
            ..Default::default()
        };
        let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
            .err()
            .unwrap();
        assert_eq!(
            e.reason,
            if huge {
                "IMAGE_PIXEL_LIMIT"
            } else {
                "ASSET_DIMENSIONS"
            }
        );
        assert_eq!(e.report.pixels, 0);
        assert_eq!(j.work().bytes, 0);
    }
}
#[test]
fn image_requires_explicit_host_and_literal_caption_cannot_execute_templates() {
    let mut d = image(PNG);
    d.metadata.caption = "Literal {script()} \\ file:///secret".into();
    let (o, _) = authored(&[atom(Content::Asset { descriptor: d })]);
    let mut j = begin(&o, "pdf-no-host", pdf::PROFILE.limits);
    assert!(
        pdf::export_with_fonts(&mut j, fonts(), true, || 1)
            .err()
            .unwrap()
            .reason
            .contains("ASSET_READ")
    );
    let mut j = begin(&o, "pdf-caption", pdf::PROFILE.limits);
    let c =
        pdf::export_with_assets(&mut j, fonts(), &mut MediaHost::default(), false, || 1).unwrap();
    assert_eq!(
        c.report
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<String>(),
        "Literal {script()} \\ file:///secret"
    );
}

#[test]
fn repeated_originals_are_deduplicated_but_conflicting_identity_refuses_before_reads() {
    for conflict in [false, true] {
        let d = image(PNG);
        let mut second = d.clone();
        if conflict {
            second.metadata.sha256 = Some("a".repeat(64));
        }
        let (o, _) = authored(&[
            atom(Content::Asset { descriptor: d }),
            atom(Content::Asset { descriptor: second }),
        ]);
        let mut j = begin(&o, "pdf-repeat", pdf::PROFILE.limits);
        let mut host = MediaHost::default();
        let result = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1);
        if conflict {
            assert_eq!(result.err().unwrap().reason, "ASSET_IDENTITY_CONFLICT");
            assert_eq!(host.reads, 0);
        } else {
            let c = result.unwrap();
            assert_eq!(host.reads, 1);
            assert_eq!(c.report.images.len(), 2);
            assert_eq!(c.report.original_bytes, PNG.len());
            assert_eq!(c.report.pixels, 7200);
        }
    }
}

#[test]
fn matching_digest_cannot_make_malformed_original_png_a_successful_artifact() {
    let mut b = PNG.to_vec();
    b[44] ^= 127;
    let (o, store) = authored(&[atom(Content::Asset {
        descriptor: image(&b),
    })]);
    let before = current(&o);
    let mut j = begin(&o, "pdf-malformed-png", pdf::PROFILE.limits);
    let mut host = MediaHost {
        bytes: Some(b),
        ..Default::default()
    };
    let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
        .err()
        .unwrap();
    assert!(e.reason.contains("ASSET_PNG_SCAN"), "{}", e.reason);
    assert_eq!(j.work().bytes, 0);
    assert_eq!(current(&o), before);
    clean(&store, &mut host.inner);
}

#[test]
fn matching_digest_does_not_admit_excess_inflate_or_bad_final_crc() {
    let mut crc = PNG.to_vec();
    *crc.last_mut().unwrap() ^= 1;
    for bytes in [EXCESS.to_vec(), crc] {
        let (o, store) = authored(&[atom(Content::Asset {
            descriptor: image(&bytes),
        })]);
        let mut j = begin(&o, "pdf-raw-png-scan", pdf::PROFILE.limits);
        let mut host = MediaHost {
            bytes: Some(bytes),
            ..Default::default()
        };
        let e = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || 1)
            .err()
            .unwrap();
        assert!(e.reason.starts_with("ASSET_PNG_SCAN:"));
        assert!(e.report.png_scan_bytes <= 21661);
        assert_eq!(e.report.original_bytes, 0);
        assert_eq!(j.work().bytes, 0);
        clean(&store, &mut host.inner);
    }
}

#[test]
fn explicit_left_and_right_arabic_cell_alignment_is_preserved() {
    let runs = vec![FragmentRun {
        text: "العربية".into(),
        marks: vec![],
    }];
    let (o, _) = authored(&[table(
        vec![vec![runs.clone(), runs]],
        vec![Alignment::Left, Alignment::Right],
    )]);
    let mut j = begin(&o, "pdf-arabic-alignment", pdf::PROFILE.limits);
    let c = pdf::export_with_fonts(&mut j, fonts(), false, || 1).unwrap();
    for (index, cell) in c.report.cells.iter().enumerate() {
        let line = c
            .report
            .lines
            .iter()
            .find(|l| l.block == cell.block)
            .unwrap();
        if index == 0 {
            assert!((line.x - cell.x - 6.0).abs() < 0.01);
        } else {
            assert!((line.x + line.width - (cell.x + cell.width - 6.0)).abs() < 0.01);
        }
    }
}
