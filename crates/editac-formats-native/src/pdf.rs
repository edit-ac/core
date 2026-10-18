//! Optional native publication writer. Fonts are immutable, qualified OFL assets;
//! no filesystem font lookup, document-selected code, or network fallback exists.
use super::media::Media;
use super::*;
use editac_formats::pdf::export as writer;
impl writer::OriginalAssetHost for Media {
    fn read_original(
        &mut self,
        r: &editac_core::modules::assets::AssetRequest,
    ) -> Result<Vec<u8>, editac_session::ports::PortError> {
        Media::read_original(self, r)
    }
}
const LATIN: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Regular.ttf");
const ARABIC: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoNaskhArabic-Regular.ttf");
const BOLD: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Bold.ttf");
const ITALIC: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-Italic.ttf");
const BOTH: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSans-BoldItalic.ttf");
const MONO: &[u8] = include_bytes!("../../../fixtures/formats/fonts/NotoSansMono-Regular.ttf");
fn report(r: &writer::Report) -> Value {
    json!({"diagnostics":r.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),
        "nodes":r.nodes,"pages":r.pages,"shapedBytes":r.shaped_bytes,"lines":r.lines.len(),"cells":r.cells.len(),"images":r.images.len(),
        "originalBytes":r.original_bytes,"pixels":r.pixels,"pngScanBytes":r.png_scan_bytes,"pngScanCalls":r.png_scan_calls,
        "fontSet":"noto-pinned-v1","fontBytesEmbedded":([LATIN,ARABIC,BOLD,ITALIC,BOTH,MONO].iter().map(|b|b.len()).sum::<usize>())})
}
pub fn write(
    job: &mut PreparedJob<MemoryStore>,
    request: &Value,
    host: &mut Media,
    now: impl FnMut() -> u64,
) -> Result<(ExportArtifact, Value), (String, Value)> {
    if request["fontSet"].as_str() != Some("noto-pinned-v1") {
        let _ = job.abort();
        return Err((
            "FORMAT_FONT_SET_UNAVAILABLE".into(),
            report(&writer::Report::default()),
        ));
    }
    writer::export_with_assets(
        job,
        writer::Fonts {
            base: [LATIN, ARABIC],
            rich: Some([BOLD, ITALIC, BOTH, MONO]),
        },
        host,
        request["approveLoss"].as_bool().unwrap_or(false),
        now,
    )
    .map(|c| (c.artifact, report(&c.report)))
    .map_err(|e| (e.reason, report(&e.report)))
}
