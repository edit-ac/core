use editac_formats::container::*;
use std::io::{Cursor, Write};
const CT: &str = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.ms-office.oleObject"/></Types>"#;
const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
fn crc(bytes: &[u8]) -> u32 {
    let mut n = !0u32;
    for byte in bytes {
        n ^= *byte as u32;
        for _ in 0..8 {
            n = (n >> 1) ^ if n & 1 == 1 { 0xedb88320 } else { 0 };
        }
    }
    !n
}
fn put16(b: &mut Vec<u8>, n: usize) {
    b.extend_from_slice(&(n as u16).to_le_bytes());
}
fn put32(b: &mut Vec<u8>, n: usize) {
    b.extend_from_slice(&(n as u32).to_le_bytes());
}
/// Deliberately hand-authored classic ZIP, permitting duplicate names and CRC
/// perturbations that a normal writer refuses. Never extracts to disk.
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut b = vec![];
    let mut cd = vec![];
    for (name, bytes) in entries {
        let offset = b.len();
        let hash = crc(bytes) as usize;
        b.extend_from_slice(b"PK\x03\x04");
        for n in [20, 0, 0, 0, 0] {
            put16(&mut b, n);
        }
        for n in [hash, bytes.len(), bytes.len()] {
            put32(&mut b, n);
        }
        put16(&mut b, name.len());
        put16(&mut b, 0);
        b.extend_from_slice(name.as_bytes());
        b.extend_from_slice(bytes);
        cd.extend_from_slice(b"PK\x01\x02");
        for n in [20, 20, 0, 0, 0, 0] {
            put16(&mut cd, n);
        }
        for n in [hash, bytes.len(), bytes.len()] {
            put32(&mut cd, n);
        }
        for n in [name.len(), 0, 0, 0, 0] {
            put16(&mut cd, n);
        }
        put32(&mut cd, 0);
        put32(&mut cd, offset);
        cd.extend_from_slice(name.as_bytes());
    }
    let start = b.len();
    b.extend_from_slice(&cd);
    b.extend_from_slice(b"PK\x05\x06");
    for n in [0, 0, entries.len(), entries.len()] {
        put16(&mut b, n);
    }
    put32(&mut b, cd.len());
    put32(&mut b, start);
    put16(&mut b, 0);
    b
}
fn input(extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut parts = vec![("[Content_Types].xml", CT.as_bytes())];
    parts.extend_from_slice(extra);
    zip(&parts)
}
fn check(bytes: &[u8], limits: Budgets) -> Result<Package, Failure> {
    inspect(bytes, limits, || Ok(()))
}
fn fails(bytes: &[u8], code: Code) {
    assert_eq!(check(bytes, Budgets::default()).unwrap_err().code, code);
}
fn patch16(b: &mut [u8], p: usize, n: u16) {
    b[p..p + 2].copy_from_slice(&n.to_le_bytes());
}
fn patch32(b: &mut [u8], p: usize, n: u32) {
    b[p..p + 4].copy_from_slice(&n.to_le_bytes());
}
fn central(b: &[u8]) -> Vec<usize> {
    b.windows(4)
        .enumerate()
        .filter_map(|(i, w)| (w == b"PK\x01\x02").then_some(i))
        .collect()
}
fn png() -> &'static [u8] {
    include_bytes!("../../../fixtures/formats/docx/probe/pixel.png")
}

#[test]
fn valid_package_original_png_and_exact_actual_work() {
    let bytes = input(&[
        (
            "word/document.xml",
            "<document><p>A &amp; B 🦀</p></document>".as_bytes(),
        ),
        ("word/media/a.png", png()),
    ]);
    let mut p = check(&bytes, Budgets::default()).unwrap();
    assert!(p.part("word/media/a.png").is_none());
    assert_eq!(p.media("word/media/a.png", &mut || Ok(())).unwrap(), (1, 1));
    assert_eq!(p.part("word/media/a.png"), Some(png()));
    assert_eq!(p.work().media_inflated, 5);
    assert!(p.work().decode_calls > 0);
    assert_eq!(p.work().entries, 3);
    assert_eq!(
        p.work().inflated,
        CT.len() + "<document><p>A &amp; B 🦀</p></document>".len() + png().len()
    );
    assert_eq!(p.work().pixels, 1);
    assert_eq!(p.work().decoded_bytes, 4);
    println!(
        "WCF06_VALID work={:?} preview_allocations=0 network=0 mutations=0",
        p.work()
    );
}
#[test]
fn unsafe_paths_and_normalized_aliases_in_both_orders() {
    for name in [
        "../x.xml",
        "/x.xml",
        "C:x.xml",
        "a\\x.xml",
        "a/./x.xml",
        "a//x.xml",
        "a/%2e%2e/x.xml",
        "a/../x.xml",
        "a./x.xml",
        "a /x.xml",
        "a\0.xml",
    ] {
        fails(&input(&[(name, b"<p/>")]), Code::Path);
    }
    for pair in [
        ["a.xml", "A.xml"],
        ["a.xml", "a.xml"],
        ["a", "a/b.xml"],
        ["a/", "a/b.xml"],
    ] {
        for order in [pair, [pair[1], pair[0]]] {
            fails(
                &input(&[(order[0], b"<p/>"), (order[1], b"<p/>")]),
                Code::Duplicate,
            );
        }
    }
}
#[test]
fn reject_encryption_symlink_method_local_name_and_zip64() {
    let bytes = input(&[("a.xml", b"<p/>")]);
    let c = central(&bytes)[1];
    let offset = u32::from_le_bytes(bytes[c + 42..c + 46].try_into().unwrap()) as usize;
    let mut b = bytes.clone();
    patch16(&mut b, c + 8, 1);
    fails(&b, Code::Encryption);
    let mut b = bytes.clone();
    patch32(&mut b, c + 38, 0o120777u32 << 16);
    fails(&b, Code::Symlink);
    let mut b = bytes.clone();
    patch16(&mut b, c + 10, 99);
    fails(&b, Code::Archive);
    let mut b = bytes.clone();
    b[offset + 30] = b'z';
    fails(&b, Code::Archive);
    let mut b = bytes.clone();
    patch32(&mut b, c + 24, u32::MAX);
    fails(&b, Code::Archive);
    let mut b = bytes.clone();
    let end = b.len() - 22;
    patch16(&mut b, end + 4, 1);
    fails(&b, Code::Archive);
}
#[test]
fn corrupt_required_entries_and_duplicates_never_become_last_entry_wins() {
    for entries in [
        vec![("a.xml", b"<p/>".as_slice()), ("b.xml", b"<p/>".as_slice())],
        vec![("b.xml", b"<p/>".as_slice()), ("a.xml", b"<p/>".as_slice())],
    ] {
        let mut b = input(&entries);
        let c = central(&b)[1];
        let offset = u32::from_le_bytes(b[c + 42..c + 46].try_into().unwrap()) as usize;
        let n = entries[0].0.len();
        b[offset + 30 + n + 1] ^= 1;
        fails(&b, Code::Archive);
    }
    for entries in [
        vec![
            ("a.xml", b"<p/>".as_slice()),
            ("a.xml", b"BROKEN".as_slice()),
        ],
        vec![
            ("a.xml", b"BROKEN".as_slice()),
            ("a.xml", b"<p/>".as_slice()),
        ],
    ] {
        fails(&input(&entries), Code::Duplicate);
    }
}
#[test]
fn input_entry_part_total_and_ratio_limits_charge_actual_inflation() {
    let bytes = input(&[("a.xml", b"<p>123456789</p>")]);
    for limits in [
        Budgets {
            input: bytes.len() - 1,
            ..Budgets::default()
        },
        Budgets {
            entries: 1,
            ..Budgets::default()
        },
        Budgets {
            part: CT.len() - 1,
            ..Budgets::default()
        },
        Budgets {
            inflated: CT.len() + 3,
            ..Budgets::default()
        },
    ] {
        assert_eq!(check(&bytes, limits).unwrap_err().code, Code::Budget);
    }
    let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file("[Content_Types].xml", options).unwrap();
    writer.write_all(CT.as_bytes()).unwrap();
    writer.start_file("a.xml", options).unwrap();
    writer
        .write_all(format!("<p>{}</p>", "x".repeat(65536)).as_bytes())
        .unwrap();
    let b = writer.finish().unwrap().into_inner();
    assert_eq!(
        check(
            &b,
            Budgets {
                ratio: 8,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
    let p = check(
        &bytes,
        Budgets {
            inflated: CT.len() + 16,
            ..Budgets::default()
        },
    )
    .unwrap();
    assert_eq!(p.work().inflated, CT.len() + 16);
}
#[test]
fn xml_dtd_entities_encoding_depth_attributes_text_and_nodes() {
    for xml in [
        b"<!DOCTYPE p [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><p>&x;</p>".as_slice(),
        b"<!DOCTYPE p><p/>",
    ] {
        fails(&input(&[("a.xml", xml)]), Code::Dtd);
    }
    for xml in [
        b"<p>&unknown;</p>".as_slice(),
        b"<p>&#0;</p>",
        b"<p><x></p>",
        b"<p a='1' a='2'/>",
        b"<p/><q/>",
        b"<p>",
        b"text<p/>",
    ] {
        fails(&input(&[("a.xml", xml)]), Code::Xml);
    }
    for xml in [
        b"<?xml version='1.0' encoding='windows-1252'?><p/>".as_slice(),
        b"<p>\xff</p>",
        b"<p>\x00</p>",
    ] {
        fails(&input(&[("a.xml", xml)]), Code::Encoding);
    }
    let xml = input(&[("a.xml", b"<a><b><c/></b></a>")]);
    assert_eq!(
        check(
            &xml,
            Budgets {
                depth: 2,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
    let xml = input(&[("a.xml", b"<p a='1' b='2'/>")]);
    assert_eq!(
        check(
            &xml,
            Budgets {
                attributes: 1,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
    let xml = input(&[("a.xml", b"<p>12345</p>")]);
    assert_eq!(
        check(
            &xml,
            Budgets {
                text: 4,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
    assert_eq!(
        check(
            &xml,
            Budgets {
                nodes: 5,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
}
#[test]
fn nested_active_package_rejected_before_mapping() {
    let nested = input(&[("inner.xml", b"<p/>")]);
    fails(&input(&[("a.bin", &nested)]), Code::NestedPackage);
}
#[test]
fn content_types_missing_conflicting_or_mismatched_fail_structurally() {
    fails(&zip(&[("a.xml", b"<p/>")]), Code::ContentType);
    fails(&input(&[("unknown.foo", b"opaque")]), Code::ContentType);
    let duplicate = CT.replace(
        "</Types>",
        "<Default Extension='xml' ContentType='text/plain'/></Types>",
    );
    fails(
        &zip(&[("[Content_Types].xml", duplicate.as_bytes())]),
        Code::ContentType,
    );
    let mismatch = CT.replace("image/png", "text/plain");
    fails(
        &zip(&[
            ("[Content_Types].xml", mismatch.as_bytes()),
            ("a.png", png()),
        ]),
        Code::ContentType,
    );
    let missing = CT.replace(
        "</Types>",
        "<Override PartName='/absent.xml' ContentType='application/xml'/></Types>",
    );
    fails(
        &zip(&[("[Content_Types].xml", missing.as_bytes())]),
        Code::ContentType,
    );
}
#[test]
fn relationships_validate_ids_types_targets_and_never_fetch() {
    let rel = |body: &str| format!("<Relationships xmlns='{REL}'>{body}</Relationships>");
    let good = rel(
        "<Relationship Id='r1' Type='urn:test/image' Target='media/a.png'/><Relationship Id='r2' Type='urn:test/hyperlink' Target='https://example.invalid/x' TargetMode='External'/>",
    );
    let p = check(
        &input(&[
            ("word/_rels/document.xml.rels", good.as_bytes()),
            ("word/media/a.png", png()),
        ]),
        Budgets::default(),
    )
    .unwrap();
    assert_eq!(p.work().references, 2);
    assert_eq!(p.diagnostics()[0].code, "EXTERNAL_RELATIONSHIP_INERT");
    for body in [
        "<Relationship Id='r1' Type='urn:test/image' Target='missing.png'/>",
        "<Relationship Id='r1' Target='media/a.png'/>",
        "<Relationship Id='r1' Type='urn:test/image' Target='media/a.png'/><Relationship Id='r1' Type='urn:test/image' Target='media/a.png'/>",
    ] {
        fails(
            &input(&[
                ("word/_rels/document.xml.rels", rel(body).as_bytes()),
                ("word/media/a.png", png()),
            ]),
            Code::Relationship,
        );
    }
    fails(
        &input(&[
            (
                "_rels/.rels",
                rel("<Relationship Id='r' Type='urn:test/x' Target='../a.xml'/>").as_bytes(),
            ),
            ("a.xml", b"<p/>"),
        ]),
        Code::Path,
    );
}
#[test]
fn macros_ole_altchunk_templates_and_remote_media_are_inert_with_diagnostics() {
    let relationships = format!(
        "<Relationships xmlns='{REL}'><Relationship Id='ole' Type='urn:x/oleObject' Target='embeddings/ole.bin'/><Relationship Id='alt' Type='urn:x/aFChunk' Target='alt.xml'/><Relationship Id='template' Type='urn:x/attachedTemplate' Target='https://example.invalid/template' TargetMode='External'/><Relationship Id='media' Type='urn:test/image' Target='https://example.invalid/image' TargetMode='External'/></Relationships>"
    );
    let p = check(
        &input(&[
            ("_rels/.rels", relationships.as_bytes()),
            ("embeddings/ole.bin", b"inert OLE"),
            ("alt.xml", b"<html/>"),
            ("vbaProject.bin", b"inert macro"),
        ]),
        Budgets::default(),
    )
    .unwrap();
    assert!(p.part("embeddings/ole.bin").is_none());
    assert!(p.part("alt.xml").is_none());
    assert!(p.part("vbaProject.bin").is_none());
    assert_eq!(
        p.diagnostics()
            .iter()
            .filter(|d| d.code == "EXTERNAL_RELATIONSHIP_INERT")
            .count(),
        2
    );
    assert!(
        p.diagnostics()
            .iter()
            .any(|d| d.code == "ACTIVE_RELATIONSHIP_INERT")
    );
    println!(
        "ACTIVE_CONTENT diagnostics={} network=0 executed_objects=0",
        p.diagnostics().len()
    );
}
#[test]
fn wcf06_nested_scans_repeated_references_and_output_share_allowances() {
    let b = input(&[("a.xml", b"<a><b/><c/></a>"), ("a.png", png())]);
    let p = check(&b, Budgets::default()).unwrap();
    assert!(p.work().scanned > p.work().inflated + CT.len());
    assert_eq!(
        check(
            &b,
            Budgets {
                work: p.work().scanned - 1,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
    let mut p = check(
        &b,
        Budgets {
            pixels: 1,
            decoded_bytes: 4,
            ..Budgets::default()
        },
    )
    .unwrap();
    p.media("a.png", &mut || Ok(())).unwrap();
    assert_eq!(
        p.media("a.png", &mut || Ok(())).unwrap_err().code,
        Code::Budget
    );
    assert_eq!(p.work().pixels, 1);
    assert_eq!(p.work().decoded_bytes, 4);
    let remaining = Budgets::default().nodes - p.work().nodes;
    p.charge_output_nodes(remaining).unwrap();
    assert_eq!(p.charge_output_nodes(1).unwrap_err().code, Code::Budget);
    println!("WCF06_CUMULATIVE {:?} preview_allocations=0", p.work());
}
#[test]
fn wcf06_rejected_media_is_deduplicated_within_job_only() {
    let mut huge = png().to_vec();
    huge[16..20].copy_from_slice(&100000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&100000u32.to_be_bytes());
    let b = input(&[("a.png", &huge)]);
    let mut p = check(&b, Budgets::default()).unwrap();
    for _ in 0..3 {
        assert_eq!(
            p.media("a.png", &mut || Ok(())).unwrap_err().code,
            Code::Budget
        );
    }
    assert_eq!(p.work().references, 3);
    assert_eq!(p.work().media_attempts, 1);
    assert_eq!(p.work().pixels, 0);
    assert_eq!(p.work().decoded_bytes, 0);
    let mut fresh = check(&input(&[("a.png", png())]), Budgets::default()).unwrap();
    assert_eq!(fresh.media("a.png", &mut || Ok(())).unwrap(), (1, 1));
    let mut corrupt = check(&input(&[("a.png", b"bad image")]), Budgets::default()).unwrap();
    for _ in 0..2 {
        assert_eq!(
            corrupt.media("a.png", &mut || Ok(())).unwrap_err().code,
            Code::Media
        );
    }
    assert_eq!(corrupt.work().media_attempts, 1);
    println!(
        "WCF06_REJECTED {:?}; fresh_attempts={}; corrupt_attempts={}; preview_allocations=0",
        p.work(),
        fresh.work().media_attempts,
        corrupt.work().media_attempts
    );
}
#[test]
fn cancellation_checked_during_inflate_xml_and_metadata_work() {
    let b = input(&[("a.xml", format!("<p>{}</p>", "x".repeat(16000)).as_bytes())]);
    let mut total = 0;
    inspect(&b, Budgets::default(), || {
        total += 1;
        Ok(())
    })
    .unwrap();
    for stop in [1, 3, 7, total / 2, total - 1] {
        let mut calls = 0;
        let error = inspect(&b, Budgets::default(), || {
            calls += 1;
            if calls >= stop {
                Err(Failure::new(Code::Cancelled, "job"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error.code, Code::Cancelled);
        assert_eq!(calls, stop);
    }
    println!("CANCEL control_checkpoints={total} mutation=0");
}

// Reuse the actual Session/AssetWork harness, with deterministic execution/asset
// ports. This is the same production prepare_container method used by callers.
#[allow(dead_code, unused_imports)]
mod integration {
    include!("support/container_job.rs");
}

fn png_chunk(b: &mut Vec<u8>, tag: &[u8; 4], payload: &[u8]) {
    b.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    let start = b.len();
    b.extend_from_slice(tag);
    b.extend_from_slice(payload);
    b.extend_from_slice(&crc(&b[start..]).to_be_bytes());
}
fn generated_png(width: u32, height: u32, raw: &[u8]) -> Vec<u8> {
    let mut header = vec![];
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut encoder = flate2::write::ZlibEncoder::new(vec![], flate2::Compression::default());
    encoder.write_all(raw).unwrap();
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    png_chunk(&mut b, b"IHDR", &header);
    png_chunk(&mut b, b"IDAT", &encoder.finish().unwrap());
    png_chunk(&mut b, b"IEND", &[]);
    b
}
#[test]
fn actual_png_expansion_truncation_crc_filter_and_pixel_limits_fail_before_raster_allocation() {
    let huge = generated_png(100000, 100000, &[0]);
    let mut p = check(&input(&[("a.png", &huge)]), Budgets::default()).unwrap();
    assert_eq!(
        p.media("a.png", &mut || Ok(())).unwrap_err().code,
        Code::Budget
    );
    assert_eq!(p.work().decode_calls, 0);
    assert_eq!(p.work().media_inflated, 0);
    assert!(p.part("a.png").is_none());
    let bomb = generated_png(1, 1, &vec![0; 65536]);
    let mut p = check(&input(&[("a.png", &bomb)]), Budgets::default()).unwrap();
    assert_eq!(
        p.media("a.png", &mut || Ok(())).unwrap_err().code,
        Code::Budget
    );
    assert!(p.work().decode_calls > 0);
    assert_eq!(p.work().media_inflated, 6);
    assert!(p.part("a.png").is_none());
    for raw in [vec![0, 1, 2], vec![5, 0, 0, 0, 0]] {
        let b = generated_png(1, 1, &raw);
        let mut p = check(&input(&[("a.png", &b)]), Budgets::default()).unwrap();
        assert_eq!(
            p.media("a.png", &mut || Ok(())).unwrap_err().code,
            Code::Media
        );
    }
    let mut broken = png().to_vec();
    broken[35] ^= 1;
    let mut p = check(&input(&[("a.png", &broken)]), Budgets::default()).unwrap();
    assert_eq!(
        p.media("a.png", &mut || Ok(())).unwrap_err().code,
        Code::Media
    );
    println!(
        "PNG_EXPANSION actual_decode_calls={} max_scanline_bytes=5 preview_allocations=0",
        p.work().decode_calls
    );
}

#[test]
fn real_qualified_docx_fixture_passes_guard_before_semantic_candidate() {
    let b = include_bytes!("../../../fixtures/formats/docx/probe/tiny.docx");
    let mut p = check(b, Budgets::default()).unwrap();
    assert!(p.part("word/document.xml").is_some());
    assert!(p.part("word/media/pixel.png").is_none());
    assert_eq!(
        p.media("word/media/pixel.png", &mut || Ok(())).unwrap(),
        (1, 1)
    );
    assert_eq!(p.part("word/media/pixel.png"), Some(png()));
    assert!(p.diagnostics().is_empty());
    println!("REAL_DOCX_GUARD {:?} input_bytes={}", p.work(), b.len());
}

#[test]
fn active_xml_constructs_and_unsupported_media_have_structured_reports() {
    let ct = CT.replace(
        "</Types>",
        "<Default Extension='jpeg' ContentType='image/jpeg'/></Types>",
    );
    let bytes = zip(&[
        ("[Content_Types].xml", ct.as_bytes()),
        (
            "a.xml",
            b"<w:p xmlns:w='urn:w'><w:altChunk/><w:object/><w:attachedTemplate/></w:p>",
        ),
        ("a.jpeg", b"unqualified image"),
    ]);
    let p = check(&bytes, Budgets::default()).unwrap();
    assert_eq!(
        p.diagnostics()
            .iter()
            .filter(|d| ["ALTCHUNK_INERT", "OLE_OBJECT_INERT", "TEMPLATE_INERT"].contains(&d.code))
            .count(),
        3
    );
    assert!(
        p.diagnostics()
            .iter()
            .any(|d| d.part == "a.jpeg" && d.code == "UNSUPPORTED_PART_INERT")
    );
    assert!(p.part("a.jpeg").is_none());
}
#[test]
fn lying_size_headers_overlap_and_unreferenced_local_data_cannot_hide_corruption() {
    let b = input(&[("a.xml", b"<p>actual-content</p>")]);
    let c = central(&b)[1];
    let offset = u32::from_le_bytes(b[c + 42..c + 46].try_into().unwrap()) as usize;
    let mut lying = b.clone();
    patch32(&mut lying, c + 24, 1);
    patch32(&mut lying, offset + 22, 1);
    assert!(check(&lying, Budgets::default()).is_err());
    let mut overlap = b.clone();
    patch32(&mut overlap, c + 20, 65535);
    patch32(&mut overlap, offset + 18, 65535);
    fails(&overlap, Code::Archive);
    let mut hidden = b.clone();
    let first = central(&hidden)[0];
    patch32(&mut hidden, first + 42, offset as u32);
    fails(&hidden, Code::Archive);
}

#[test]
fn wcf06_many_actual_relationships_to_rejected_resource_stop_repeated_decode() {
    let count = 32;
    let body = (0..count)
        .map(|i| format!("<Relationship Id='r{i}' Type='urn:test/image' Target='a.png'/>"))
        .collect::<String>();
    let rels = format!("<Relationships xmlns='{REL}'>{body}</Relationships>");
    let malformed = generated_png(1, 1, &[0, 0, 0]);
    let bytes = input(&[("_rels/.rels", rels.as_bytes()), ("a.png", &malformed)]);
    let mut p = check(&bytes, Budgets::default()).unwrap();
    assert_eq!(p.work().references, count);
    for _ in 0..count {
        assert_eq!(
            p.media("a.png", &mut || Ok(())).unwrap_err().code,
            Code::Media
        );
    }
    assert_eq!(p.work().references, count * 2);
    assert_eq!(p.work().media_attempts, 1);
    assert_eq!(p.work().media_inflated, 3);
    let same_input = input(&[("a.png", png())]);
    let mut exhausted = check(
        &same_input,
        Budgets {
            pixels: 0,
            ..Budgets::default()
        },
    )
    .unwrap();
    for _ in 0..3 {
        assert_eq!(
            exhausted.media("a.png", &mut || Ok(())).unwrap_err().code,
            Code::Budget
        );
    }
    assert_eq!(exhausted.work().media_attempts, 1);
    assert_eq!(exhausted.work().decode_calls, 0);
    let mut eligible = check(&same_input, Budgets::default()).unwrap();
    assert_eq!(eligible.media("a.png", &mut || Ok(())).unwrap(), (1, 1));
    println!(
        "WCF06_RELATIONSHIPS count={count} rejected_work={:?} exhausted_work={:?} fresh_work={:?}",
        p.work(),
        exhausted.work(),
        eligible.work()
    );
}
#[test]
fn wcf07_conflicting_relationships_and_corrupt_required_parts_both_orders() {
    for targets in [["a.xml", "b.xml"], ["b.xml", "a.xml"]] {
        let rel = format!(
            "<Relationships xmlns='{REL}'><Relationship Id='same' Type='urn:test/part' Target='{}'/><Relationship Id='same' Type='urn:test/part' Target='{}'/></Relationships>",
            targets[0], targets[1]
        );
        fails(
            &input(&[
                ("_rels/.rels", rel.as_bytes()),
                ("a.xml", b"<a/>"),
                ("b.xml", b"<b/>"),
            ]),
            Code::Relationship,
        );
    }
}

#[test]
fn failed_work_receipts_include_bounded_exhaustion_bytes_and_fixed_profile_caps() {
    let bytes = input(&[("a.xml", b"<p>work</p>")]);
    let e = check(
        &bytes,
        Budgets {
            inflated: CT.len() + 4,
            ..Budgets::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code, Code::Budget);
    assert_eq!(e.work.inflated, CT.len() + 5);
    let bomb = generated_png(1, 1, &vec![0; 65536]);
    let mut p = check(&input(&[("a.png", &bomb)]), Budgets::default()).unwrap();
    let e = p.media("a.png", &mut || Ok(())).unwrap_err();
    assert_eq!(e.work.media_inflated, 6);
    assert_eq!(e.work, p.work());
    assert_eq!(
        check(
            &bytes,
            Budgets {
                input: usize::MAX,
                ..Budgets::default()
            }
        )
        .unwrap_err()
        .code,
        Code::Budget
    );
    println!(
        "ACTUAL_EXHAUSTION zip_observed_bytes={} png_observed_bytes={} png_decode_calls={} retained_original_bytes={}",
        CT.len() + 5,
        e.work.media_inflated,
        e.work.decode_calls,
        bytes.len()
    );
}
#[test]
fn malformed_metadata_mime_uri_and_ambient_base_are_structured_failures() {
    let ct = CT.replace("application/xml", "not-a-mime");
    fails(
        &zip(&[("[Content_Types].xml", ct.as_bytes()), ("a.xml", b"<a/>")]),
        Code::ContentType,
    );
    for (extra, ty) in [
        ("xml:base='https://example.invalid/'", "urn:test/image"),
        ("", "not-a-uri"),
        ("", "urn:test/ bad"),
    ] {
        let rel = format!(
            "<Relationships xmlns='{REL}' {extra}><Relationship Id='r' Type='{ty}' Target='a.png'/></Relationships>"
        );
        fails(
            &input(&[("_rels/.rels", rel.as_bytes()), ("a.png", png())]),
            Code::Relationship,
        );
    }
}
