//! Same guarded boundary compiled for WASM; runtime proof is the native suite.
fn main() {
    let mut package = editac_formats::container::inspect(
        include_bytes!("../../../fixtures/formats/docx/probe/tiny.docx"),
        editac_formats::container::Budgets::default(),
        || Ok(()),
    )
    .unwrap();
    assert!(package.part("word/document.xml").is_some());
    assert_eq!(
        package
            .media("word/media/pixel.png", &mut || Ok(()))
            .unwrap(),
        (1, 1)
    );
}
