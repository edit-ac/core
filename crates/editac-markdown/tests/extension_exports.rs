use editac_markdown::v1::{
    Codecs, EXTENSION_API_VERSION, Extension, FragmentBlock, ImportError, PreparedContent, export,
    export_with_extensions, import_with_codecs, import_with_extensions,
};
struct Passive;
impl Extension for Passive {
    fn name(&self) -> &str {
        "demo.passive"
    }
}
#[test]
fn public_codec_facade_uses_qualified_prepare_and_export() {
    assert_eq!(EXTENSION_API_VERSION, 1);
    let prepared: PreparedContent = import_with_codecs("**portable**", Codecs::default()).unwrap();
    let blocks: Vec<FragmentBlock> = prepared.blocks;
    assert!(export(&blocks).markdown.contains("**portable**"));
    let hook: &dyn Extension = &Passive;
    let candidate = import_with_extensions("**portable**", Codecs::default(), &[hook]).unwrap();
    assert!(
        export_with_extensions(&candidate.blocks, &[hook])
            .unwrap()
            .markdown
            .contains("**portable**")
    );
    let _: Option<ImportError> = None;
}
