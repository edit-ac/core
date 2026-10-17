use editac_formats::{container::Budgets, docx::import::prepare_text, job::PreparedJob};
use editac_session::ports::memory::MemoryStore;
fn compile_map(job: &mut PreparedJob<MemoryStore>) {
    let _ = prepare_text(job, Budgets::default(), || 0);
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>));
}
