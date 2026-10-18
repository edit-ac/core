use editac_formats::{job::PreparedJob, table_text::import::*};
use editac_session::ports::memory::MemoryStore;
fn compile_map(job: &mut PreparedJob<MemoryStore>, dialect: Dialect) {
    let _ = prepare(job, dialect, Budgets::default(), || 0);
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>, Dialect));
}
