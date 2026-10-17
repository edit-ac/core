use editac_core::modules::assets::*;
use editac_formats::{
    container::Budgets,
    docx::import::{OriginalMediaHost, prepare_structure},
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
impl OriginalMediaHost for Unavailable {
    fn identity(&self, _: &[u8; 32]) -> Result<AssetIdentity, PortError> {
        Err(PortError::Unavailable)
    }
    fn ingest_original(
        &mut self,
        _: &str,
        _: &AssetRequest,
        _: &[u8],
    ) -> Result<HostOutcome, PortError> {
        Err(PortError::Unavailable)
    }
}
fn compile_map(job: &mut PreparedJob<MemoryStore>) {
    let _ = prepare_structure(job, Budgets::default(), &mut Unavailable, || 0);
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>));
}
