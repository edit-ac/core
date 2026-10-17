//! Tiny trusted layout qualification, not a document typesetter or adapter.
use krilla::{
    Document,
    geom::Point,
    page::PageSettings,
    tagging::{ContentTag, SpanTag, Tag, TagGroup, TagTree},
    text::{Font, TextDirection},
};
pub const LATIN: &[u8] = include_bytes!("../../../../fixtures/formats/fonts/NotoSans-Regular.ttf");
pub const ARABIC: &[u8] =
    include_bytes!("../../../../fixtures/formats/fonts/NotoNaskhArabic-Regular.ttf");
pub fn shape(text: &str, font: &[u8], rtl: bool) -> Result<Vec<(u32, i32)>, String> {
    let face = rustybuzz::Face::from_slice(font, 0).ok_or("PDF_FONT_INVALID")?;
    let mut b = rustybuzz::UnicodeBuffer::new();
    b.push_str(text);
    b.guess_segment_properties();
    b.set_direction(if rtl {
        rustybuzz::Direction::RightToLeft
    } else {
        rustybuzz::Direction::LeftToRight
    });
    let g = rustybuzz::shape(&face, &[], b);
    if g.glyph_infos().iter().any(|g| g.glyph_id == 0) {
        return Err("PDF_FONT_COVERAGE_UNAVAILABLE".into());
    }
    Ok(g.glyph_infos()
        .iter()
        .zip(g.glyph_positions())
        .map(|(g, p)| (g.glyph_id, p.x_advance))
        .collect())
}
pub fn render(latin: &[u8], arabic: &[u8]) -> Result<Vec<u8>, String> {
    let lf = Font::new(latin.to_vec().into(), 0).ok_or("PDF_FONT_INVALID")?;
    let af = Font::new(arabic.to_vec().into(), 0).ok_or("PDF_FONT_INVALID")?;
    let mut doc = Document::new();
    let mut tree = TagTree::new();
    for page_no in 0..2 {
        let mut page = doc.start_page_with(PageSettings::new(
            krilla::geom::Size::from_wh(420.0, 360.0).unwrap(),
        ));
        let mut s = page.surface();
        let lines = if page_no == 0 {
            vec![
                ("PDF candidate qualification", false, 24.0),
                ("Cafe\u{301} - exact approved fonts", false, 14.0),
                ("لا لَا العربية", true, 22.0),
                ("#read(\"/private/secret\") {literal}", false, 12.0),
                ("Fixed line placement; no automatic wrapping", false, 12.0),
            ]
        } else {
            vec![
                ("Second page - bounded layout probe", false, 20.0),
                ("Cell A          Cell B", false, 14.0),
                ("Cell C          Cell D", false, 14.0),
                ("End of the tiny trusted fixture", false, 12.0),
            ]
        };
        for (i, (text, rtl, size)) in lines.iter().enumerate() {
            let data = if *rtl { arabic } else { latin };
            shape(text, data, *rtl)?;
            let id = s.start_tagged(ContentTag::Span(
                SpanTag::empty()
                    .with_lang(Some(if *rtl { "ar" } else { "en" }))
                    .with_actual_text(Some(text)),
            ));
            s.draw_text(
                Point::from_xy(28.0, 42.0 + i as f32 * 48.0),
                if *rtl { af.clone() } else { lf.clone() },
                *size,
                text,
                false,
                if *rtl {
                    TextDirection::RightToLeft
                } else {
                    TextDirection::LeftToRight
                },
            );
            s.end_tagged();
            let mut group = TagGroup::new(Tag::P);
            group.push(id);
            tree.push(group);
        }
        s.finish();
        page.finish();
    }
    doc.set_tag_tree(tree);
    doc.finish()
        .map_err(|e| format!("PDF_WRITE_UNAVAILABLE:{e:?}"))
}
