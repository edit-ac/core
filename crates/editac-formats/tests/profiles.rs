use editac_formats::*;
use serde_json::Value;

fn wcf() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/formats/wcf05.json")).unwrap()
}

fn prepared() -> Profile {
    let fixture = wcf();
    let limits = &fixture["limits"];
    Profile {
        available: true,
        limits: Limits {
            input_bytes: limits["inputBytes"].as_u64().unwrap() as usize,
            output_bytes: limits["outputBytes"].as_u64().unwrap() as usize,
            nodes: limits["nodes"].as_u64().unwrap() as usize,
            pages: limits["pages"].as_u64().unwrap() as usize,
        },
        ..PROFILES[0]
    }
}

#[test]
fn versioned_direction_records_match_fixture_without_claiming_converters() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/formats/profiles.json")).unwrap();
    assert_eq!(fixture["schemaVersion"], 1);
    assert_eq!(
        fixture["profiles"].as_array().unwrap().len(),
        PROFILES.len()
    );
    for (p, f) in PROFILES.iter().zip(fixture["profiles"].as_array().unwrap()) {
        assert_eq!(f["id"], p.id);
        assert_eq!(f["format"], p.format);
        assert_eq!(f["version"], p.version);
        assert_eq!(
            f["directions"]["import"],
            if p.import {
                "planned-unavailable"
            } else {
                "export-only"
            }
        );
        assert_eq!(f["directions"]["export"], "planned-unavailable");
        assert!(p.export && !p.available);
        assert_eq!(f["fidelity"], p.fidelity);
        assert_eq!(f["dependencies"]["owner"], p.owner);
        assert_eq!(f["dependencies"]["status"], "unselected");
        assert!(f["dependencies"]["versions"].as_array().unwrap().is_empty());
        assert!(f["dependencies"]["assets"].as_array().unwrap().is_empty());
        assert_eq!(f["limits"]["inputBytes"], p.limits.input_bytes);
        assert_eq!(f["limits"]["outputBytes"], p.limits.output_bytes);
        assert_eq!(f["limits"]["nodes"], p.limits.nodes);
        assert_eq!(f["limits"]["pages"], p.limits.pages);
        assert_eq!(f["diagnosticSchema"], 1);
        assert_eq!(f["targets"]["native"], "contract-only");
        assert_eq!(f["targets"]["wasm32-unknown-unknown"], "contract-only");
    }
}

#[test]
fn baseline_formats_delegate_and_legacy_formats_are_excluded() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/formats/profiles.json")).unwrap();
    assert_eq!(fixture["baseline"]["policy"], "delegate-existing-adapters");
    assert_eq!(
        fixture["baseline"]["formats"],
        serde_json::json!(["markdown", "safe-html", "utf8-text", "semantic-json-v1"])
    );
    for f in ["doc", "ppt", "xls", "universal-fidelity"] {
        assert!(
            fixture["excluded"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(f))
        );
        assert!(profile(&format!("edit-ac-{f}-v1")).is_none());
    }
}

#[test]
fn pdf_hints_reject_before_profile_or_input_admission_and_retain_original() {
    let original = b"\0arbitrary source and edits";
    for (id, filename, media_type, bytes) in [
        ("edit-ac-pdf-v1", "file.txt", "text/plain", &original[..]),
        ("edit-ac-docx-v1", "file.PDF ", "text/plain", &original[..]),
        (
            "missing",
            "file.docx",
            " Application/PDF ; charset=binary",
            &original[..],
        ),
        (
            "edit-ac-docx-v1",
            "file.docx",
            "application/zip",
            &b"junk\n%PDF-1.7\n"[..],
        ),
    ] {
        let result = admit_import(&ImportRequest {
            profile_id: id,
            filename,
            media_type,
            original: bytes,
        })
        .unwrap_err();
        assert_eq!(result.diagnostic.code.as_str(), "FORMAT_EXPORT_ONLY");
        assert_eq!(result.original, bytes);
        assert!(!result.diagnostic.action.is_empty());
    }
    let mut oversized = vec![0; LIMITS.input_bytes + 1];
    oversized[100..105].copy_from_slice(b"%PDF-");
    assert_eq!(
        admit_import(&ImportRequest {
            profile_id: "missing",
            filename: "f.txt",
            media_type: "text/plain",
            original: &oversized
        })
        .unwrap_err()
        .diagnostic
        .code,
        Code::ExportOnly
    );
}

#[test]
fn signature_sniff_is_bounded_and_missing_adapter_is_actionable() {
    let mut source = vec![0; 1030];
    source[1024..1029].copy_from_slice(b"%PDF-");
    let result = admit_import(&ImportRequest {
        profile_id: "edit-ac-docx-v1",
        filename: "f.docx",
        media_type: "application/zip",
        original: &source,
    })
    .unwrap_err();
    assert_eq!(result.diagnostic.code, Code::AdapterUnavailable);
    assert_eq!(result.original, source);
    assert_eq!(result.diagnostic.schema_version, 1);
    assert!(result.diagnostic.action.contains("local adapter"));
}

#[test]
fn planned_profiles_do_not_advertise_runtime_support_or_symmetry() {
    for p in PROFILES {
        assert_eq!(
            admit_direction(p, Direction::Export, b"source")
                .unwrap_err()
                .diagnostic
                .code,
            Code::AdapterUnavailable
        );
        assert_eq!(
            admit_direction(p, Direction::Import, b"source")
                .unwrap_err()
                .diagnostic
                .code,
            if p.format == "pdf" {
                Code::ExportOnly
            } else {
                Code::AdapterUnavailable
            }
        );
    }
}

#[test]
fn unknown_profile_and_legacy_import_retain_source() {
    for id in [
        "unknown",
        "edit-ac-doc-v1",
        "edit-ac-ppt-v1",
        "edit-ac-xls-v1",
    ] {
        let f = admit_import(&ImportRequest {
            profile_id: id,
            filename: "f.bin",
            media_type: "application/octet-stream",
            original: b"source",
        })
        .unwrap_err();
        assert_eq!(f.diagnostic.code, Code::UnsupportedFormat);
        assert_eq!(f.original, b"source");
    }
}

#[test]
fn wcf05_import_only_export_never_starts_converter_or_host_write() {
    let fixture = wcf();
    let case = &fixture["cases"][0];
    let profile = Profile {
        export: fixture["profile"]["export"].as_bool().unwrap(),
        ..prepared()
    };
    let source = fixture["original"].as_str().unwrap().as_bytes();
    assert!(admit_direction(&profile, Direction::Import, source).is_ok());
    let mut converter_calls = 0;
    let mut writes = 0;
    let result = Output::begin(&profile, source, "revision-N")
        .and_then(|mut output| {
            converter_calls += 1;
            output.append(b"data", 1, 1)?;
            output.finish()
        })
        .map(|artifact| {
            writes += 1;
            artifact
        });
    let f = result.unwrap_err();
    assert_eq!(f.diagnostic.code, Code::DirectionUnavailable);
    assert!(f.diagnostic.action.contains("Save As"));
    assert_eq!(f.original, source);
    assert_eq!(converter_calls, case["converterCalls"].as_u64().unwrap());
    assert_eq!(writes, case["hostWrites"].as_u64().unwrap());
    assert_eq!(f.diagnostic.code.as_str(), case["code"].as_str().unwrap());
}

#[test]
fn wcf05_exhausted_bytes_nodes_pages_never_publish_prefix() {
    let fixture = wcf();
    for case in fixture["cases"].as_array().unwrap().iter().skip(1) {
        let suffix = case["suffix"].as_str().unwrap().as_bytes();
        let nodes = case["suffixNodes"].as_u64().unwrap() as usize;
        let pages = case["suffixPages"].as_u64().unwrap() as usize;
        let source = fixture["original"].as_str().unwrap().as_bytes();
        let mut out = Output::begin(
            &prepared(),
            source,
            fixture["capturedRevision"].as_str().unwrap(),
        )
        .unwrap();
        out.append(case["prefix"].as_str().unwrap().as_bytes(), 1, 1)
            .unwrap();
        let f = out.append(suffix, nodes, pages).unwrap_err();
        assert_eq!(f.diagnostic.code, Code::OutputLimit);
        assert_eq!(f.original, source);
        assert!(f.diagnostic.message.contains("incomplete"));
        // Ignoring the first error cannot turn a truncated prefix into success.
        assert!(out.append(b"", 0, 0).is_err());
        let mut writes = 0;
        let result = out.finish().map(|a| {
            writes += 1;
            a
        });
        assert_eq!(result.unwrap_err().diagnostic.code, Code::OutputLimit);
        assert_eq!(writes, case["hostWrites"].as_u64().unwrap());
        assert_eq!(f.diagnostic.code.as_str(), case["code"].as_str().unwrap());
    }
}

#[test]
fn complete_output_has_exact_bytes_work_and_captured_revision() {
    let mut out = Output::begin(&prepared(), b"input", "revision-N").unwrap();
    out.append(b"ab", 1, 1).unwrap();
    out.append(b"cd", 1, 0).unwrap();
    let artifact = out.finish().unwrap();
    assert_eq!(artifact.bytes(), b"abcd");
    assert_eq!(artifact.revision(), "revision-N");
    assert_eq!(
        artifact.work(),
        Work {
            bytes: 4,
            nodes: 2,
            pages: 1
        }
    );
}

#[test]
fn resource_arithmetic_overflow_fails_without_partial_artifact() {
    let p = Profile {
        limits: Limits {
            nodes: usize::MAX,
            ..prepared().limits
        },
        ..prepared()
    };
    let mut out = Output::begin(&p, b"input", "revision-N").unwrap();
    out.append(b"a", usize::MAX, 0).unwrap();
    assert_eq!(
        out.append(b"b", 1, 0).unwrap_err().diagnostic.code,
        Code::OutputLimit
    );
    assert!(out.finish().is_err());
}

#[test]
fn input_limit_blocks_output_before_allocation() {
    let input = [1; 65];
    assert!(matches!(
        Output::begin(&prepared(), &input, "revision-N"),
        Err(Failure {
            diagnostic: Diagnostic {
                code: Code::InputLimit,
                ..
            },
            ..
        })
    ));
}
