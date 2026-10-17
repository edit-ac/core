// Shared native runtime / WASM compile candidate probe; never a production ingress API.
use docx_rs::{
    DocumentChild, Docx, Paragraph, ParagraphChild, Pic, ReadDocxOptions, Run, RunChild,
};
use std::io::{Cursor, Read};

pub const INPUT: &[u8] = include_bytes!("../../../../fixtures/formats/docx/probe/tiny.docx");
pub const PNG: &[u8] = include_bytes!("../../../../fixtures/formats/docx/probe/pixel.png");
pub const TEXT: &str = " A & B 🦀 e\u{301} ";

pub fn read() -> Docx {
    docx_rs::read_docx_with_options(INPUT, ReadDocxOptions::default().with_image_previews(false))
        .expect("trusted original package parses")
}

pub fn paragraphs(doc: &Docx) -> Vec<String> {
    doc.document
        .children
        .iter()
        .filter_map(|child| match child {
            DocumentChild::Paragraph(p) => Some(
                p.children
                    .iter()
                    .filter_map(|child| match child {
                        ParagraphChild::Run(r) => Some(
                            r.children
                                .iter()
                                .filter_map(|child| match child {
                                    RunChild::Text(t) => Some(t.text.as_str()),
                                    _ => None,
                                })
                                .collect::<String>(),
                        ),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .collect()
}

pub fn write() -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    Docx::new()
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text(TEXT).bold().italic()))
        .add_paragraph(Paragraph::new().add_run(Run::new().add_text("第二段")))
        .add_paragraph(
            Paragraph::new().add_run(Run::new().add_image(Pic::new_with_dimensions(
                PNG.to_vec(),
                1,
                1,
            ))),
        )
        .pack(&mut out)
        .expect("writer packs in memory without image decoder");
    out.into_inner()
}

pub fn part(bytes: &[u8], name: &str) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    archive
        .by_name(name)
        .unwrap()
        .read_to_end(&mut out)
        .unwrap();
    out
}

pub fn compile_probe() {
    let doc = read();
    assert_eq!(paragraphs(&doc), [TEXT, "第二段"]);
    assert_eq!(doc.images.len(), 1);
    assert_eq!(doc.images[0].2.0, PNG);
    assert!(doc.images[0].3.0.is_empty());
    let bytes = write();
    let xml = part(&bytes, "word/document.xml");
    let mut reader = quick_xml::Reader::from_reader(xml.as_slice());
    loop {
        match reader.read_event().unwrap() {
            quick_xml::events::Event::Eof => break,
            quick_xml::events::Event::DocType(_) => panic!("writer must not emit a DTD"),
            _ => {}
        }
    }
}
