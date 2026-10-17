//! Deterministic semantic-document qualification executable. Not a host adapter.
//! Reuses the same Session, prepared job and asset journal fixture constructors.
//! The parent launcher supplies real outer process isolation; the internal test
//! port remains prepared and does not establish an allocation-time memory cap.
#![allow(dead_code, unused_imports)]
include!("../tests/pdf_structure.rs");
fn rich_blocks() -> Vec<FragmentBlock> {
    use editac_core::{
        commands::{format::Mark, lists::ContainerStyle},
        document::BlockAttributes,
    };
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/formats/pdf/export/rich.json"
    ))
    .unwrap();
    fixture["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| FragmentBlock {
            runs: b["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| FragmentRun {
                    opaque_marks: vec![],
                    text: r["text"].as_str().unwrap().into(),
                    marks: r["marks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| match m.as_str().unwrap() {
                            "bold" => (Mark::Bold, None),
                            "italic" => (Mark::Italic, None),
                            "underline" => (Mark::Underline, None),
                            "strike" => (Mark::Strike, None),
                            "code" => (Mark::Code, None),
                            "link" => (Mark::Link, Some(r["href"].as_str().unwrap().into())),
                            _ => panic!(),
                        })
                        .collect(),
                })
                .collect(),
            attributes: b
                .get("heading")
                .map(|h| BlockAttributes::Heading(h.as_u64().unwrap() as u8)),
            containers: b.get("path").map_or(vec![], |p| {
                p.as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        (
                            c[0].as_str().unwrap().into(),
                            if c[1].is_null() {
                                ContainerStyle::Unordered
                            } else {
                                ContainerStyle::Ordered {
                                    start: c[1].as_u64().unwrap() as u32,
                                }
                            },
                        )
                    })
                    .collect()
            }),
            checked: None,
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args
        .get(1)
        .is_some_and(|s| s == "read" || s == "write" || s == "network" || s == "child")
    {
        let attempt = match args[1].as_str() {
            "read" => std::fs::read(&args[2]).map(|_| ()),
            "write" => std::fs::write(&args[2], b"denied"),
            "network" => std::net::TcpStream::connect("127.0.0.1:9").map(|_| ()),
            "child" => std::process::Command::new("/usr/bin/true")
                .status()
                .map(|_| ()),
            _ => unreachable!(),
        };
        match attempt {
            Ok(()) => return,
            Err(e) => {
                eprintln!("PDF_AUTHORITY_DENIED:{:?}", e.kind());
                std::process::exit(2)
            }
        }
    }
    assert_eq!(args.len(), 3);
    let kind = args[1].as_str();
    let start = std::time::Instant::now();
    let (mut o, store) = match kind {
        "text" => {
            let texts: Vec<String> = serde_json::from_str(include_str!(
                "../../../fixtures/formats/pdf/export/text.json"
            ))
            .unwrap();
            let id = identity();
            let store = Arc::new(MemoryStore::new(id.clone(), StoreLimits::default()).unwrap());
            let nodes = texts
                .iter()
                .map(|text| InitialNode {
                    kind: "block".into(),
                    text: text.clone(),
                })
                .collect::<Vec<_>>();
            (
                ConversionOwner::create(store.clone(), id, &nodes, HostPolicy::default()).unwrap(),
                store,
            )
        }
        "rich" => {
            let (mut o, store) = owner();
            let mut j = job(&o, "rich-author", Direction::Import);
            j.finish_import(&mut o, &rich_blocks(), 0).unwrap();
            (o, store)
        }
        "structure" => authored(&content()),
        _ => panic!("PDF_PROFILE_UNAVAILABLE"),
    };
    let mapping_ms = start.elapsed().as_secs_f64() * 1000.0;
    let revision = o.service().read(0).unwrap().revision;
    let mut spec = spec(&o, "isolated-captured-document", Direction::Export);
    spec.profile = pdf::PROFILE;
    spec.limits = pdf::PROFILE.limits;
    spec.original = b"";
    spec.filename = "publication.pdf";
    spec.media_type = "application/pdf";
    spec.timeout = 5000;
    let mut j = PreparedJob::begin(&o, spec, &JobPool::new(1).unwrap(), port().0, 0).unwrap();
    edit(&mut o, "LATER REVISION ");
    let edited = current(&o);
    let mut host = MediaHost::default();
    let render_start = std::time::Instant::now();
    let c = pdf::export_with_assets(&mut j, fonts(), &mut host, false, || {
        start.elapsed().as_millis() as u64
    })
    .unwrap();
    let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(c.artifact.revision(), &revision);
    assert_ne!(o.service().read(0).unwrap().revision, revision);
    assert_eq!(current(&o), edited);
    assert!(!c.report.diagnostics.iter().any(|d| d.lossy));
    clean(&store, &mut host.inner);
    std::fs::write(&args[2], c.artifact.bytes()).unwrap();
    println!(
        "{}",
        serde_json::json!({
            "kind":kind,"pages":c.report.pages,"lines":c.report.lines.len(),
            "cells":c.report.cells.len(),"images":c.report.images.len(),
            "originalReads":host.reads,"originalBytes":c.report.original_bytes,
            "pixels":c.report.pixels,"pngScanBytes":c.report.png_scan_bytes,
            "pngScanCalls":c.report.png_scan_calls,"shapedBytes":c.report.shaped_bytes,
            "outputBytes":c.artifact.bytes().len(),"mappingMs":mapping_ms,"renderMs":render_ms,
            "totalMs":start.elapsed().as_secs_f64()*1000.0,
            "fontBytesEmbedded":LATIN.len()+ARABIC.len()+BOLD.len()+ITALIC.len()+BOTH.len()+MONO.len(),
            "fontTransferBytes":0,"imageTransferBytes":0,
            "transport":"hand-authored fonts/image/semantic fixtures embedded in exact pinned executable; no ambient resource lookup",
            "executionPort":"prepared internal port; actual outer sandbox/CPU/file/wall/RSS watchdog measured by launcher",
            "capturedRevision":format!("{:?}",revision),"laterEditUnchanged":true,"ownedAssetCleanup":true
        })
    );
}
