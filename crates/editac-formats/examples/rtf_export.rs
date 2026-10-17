use editac_formats::{job::PreparedJob, rtf::export::export};
use editac_session::ports::memory::MemoryStore;
fn compile_map(job: &mut PreparedJob<MemoryStore>) {
    let _ = export(job, None, false, || 0);
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>));
}
