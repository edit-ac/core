use editac_core::modules::assets::*;
use editac_formats::{
    epub::export::{OriginalAssetHost, export},
    job::PreparedJob,
};
use editac_session::{
    assets::{AssetHost, HostOutcome},
    ports::{PortError, memory::MemoryStore},
};
struct Unavailable;
impl AssetHost for Unavailable {
    fn authorize(&mut self, _: &AssetRequest) -> Result<AssetGrant, PortError> {
        Err(PortError::Unavailable)
    }
    fn execute(&mut self, _: &str, _: &AssetRequest) -> Result<HostOutcome, PortError> {
        Err(PortError::Unavailable)
    }
}
impl OriginalAssetHost for Unavailable {
    fn read_original(&mut self, _: &AssetRequest) -> Result<Vec<u8>, PortError> {
        Err(PortError::Unavailable)
    }
}
fn compile_map(job: &mut PreparedJob<MemoryStore>) {
    let _ = export(job, None, false, &mut Unavailable, || 0);
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>));
}
