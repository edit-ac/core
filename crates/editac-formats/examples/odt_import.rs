use editac_core::modules::assets::*;
use editac_formats::{
    container::Budgets,
    job::PreparedJob,
    odt::import::{OriginalMediaHost, prepare},
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
    let _ = prepare(job, Budgets::default(), &mut Unavailable, || 0);
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>));
}
