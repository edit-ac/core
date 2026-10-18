//! Native EPUB 3.3 writer over caller-approved original capabilities.
use super::media::Media;
use super::*;
use editac_formats::epub::export as writer;
impl writer::OriginalAssetHost for Media {
    fn read_original(
        &mut self,
        r: &editac_core::modules::assets::AssetRequest,
    ) -> Result<Vec<u8>, editac_session::ports::PortError> {
        Media::read_original(self, r)
    }
}
fn report(r: &writer::Report) -> Value {
    json!({"diagnostics":r.diagnostics.iter().map(|d|json!({"code":d.code,"location":d.location,"lossy":d.lossy})).collect::<Vec<_>>(),"nodes":r.nodes,"assets":r.assets,"originalBytes":r.original_bytes,"mediaWork":{"pixels":r.media_work.pixels,"decodedBytes":r.media_work.decoded_bytes,"decodeCalls":r.media_work.decode_calls}})
}
pub fn write(
    job: &mut PreparedJob<MemoryStore>,
    request: &Value,
    host: &mut Media,
    now: impl FnMut() -> u64,
) -> Result<(ExportArtifact, Value), (String, Value)> {
    writer::export(
        job,
        None,
        request["approveLoss"].as_bool().unwrap_or(false),
        host,
        now,
    )
    .map(|c| (c.artifact, report(&c.report)))
    .map_err(|e| (e.reason, report(&e.report)))
}
