#[path = "support/docx_probe.rs"]
mod probe;
use docx_rs::{DocumentChild, ParagraphChild, ReadDocxOptions};
use std::io::{Cursor, Read};

#[test]
fn original_minimal_package_preserves_unicode_space_and_marks() {
    let doc = probe::read();
    assert_eq!(probe::paragraphs(&doc), [probe::TEXT, "第二段"]);
    let DocumentChild::Paragraph(p) = &doc.document.children[0] else {
        panic!("paragraph")
    };
    let ParagraphChild::Run(r) = &p.children[0] else {
        panic!("run")
    };
    assert!(r.run_property.bold.is_some());
    assert!(r.run_property.italic.is_some());
}

#[test]
fn original_admitted_png_bytes_are_accessible_without_previews() {
    let doc = probe::read();
    assert_eq!(doc.images.len(), 1);
    let (id, path, original, preview) = &doc.images[0];
    assert_eq!(id, "rMedia");
    assert_eq!(path, "word/media/pixel.png");
    assert_eq!(original.0, probe::PNG);
    assert!(preview.0.is_empty());
}

#[test]
fn writer_emits_parseable_package_and_exact_original_png() {
    let bytes = probe::write();
    let mut zip = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
    let names: Vec<_> = zip.file_names().map(str::to_owned).collect();
    assert!(names.iter().any(|n| n == "[Content_Types].xml"));
    assert!(names.iter().any(|n| n == "_rels/.rels"));
    let media: Vec<_> = names
        .iter()
        .filter(|n| n.starts_with("word/media/") && !n.ends_with('/'))
        .collect();
    assert_eq!(media.len(), 1);
    let mut png = Vec::new();
    zip.by_name(media[0])
        .unwrap()
        .read_to_end(&mut png)
        .unwrap();
    assert_eq!(png, probe::PNG);
    let doc = docx_rs::read_docx_with_options(
        &bytes,
        ReadDocxOptions::default().with_image_previews(false),
    )
    .unwrap();
    assert_eq!(&probe::paragraphs(&doc)[..2], [probe::TEXT, "第二段"]);
    assert_eq!(doc.images[0].2.0, probe::PNG);
    assert!(doc.images[0].3.0.is_empty());
    if let Ok(dir) = std::env::var("EDITAC_FORMATS_OUTPUT") {
        std::fs::write(std::path::Path::new(&dir).join("writer.docx"), &bytes).unwrap();
    }
}

#[test]
fn writer_escapes_literal_xml_and_emits_declared_marks() {
    let bytes = probe::write();
    let xml = String::from_utf8(probe::part(&bytes, "word/document.xml")).unwrap();
    assert!(xml.contains(" A &amp; B 🦀 e\u{301} "));
    assert!(xml.contains("<w:b"));
    assert!(xml.contains("<w:i"));
    assert!(!xml.contains("<!DOCTYPE"));
    assert!(!xml.contains("<script"));
}

#[test]
fn shared_native_runtime_and_wasm_compile_surface() {
    probe::compile_probe();
}

#[test]
fn invalid_container_is_a_candidate_error_not_success() {
    assert!(
        docx_rs::read_docx_with_options(
            b"not a ZIP",
            ReadDocxOptions::default().with_image_previews(false)
        )
        .is_err()
    );
}
