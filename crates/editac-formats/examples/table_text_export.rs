use editac_formats::{job::PreparedJob, table_text::export::*};
use editac_session::ports::memory::MemoryStore;
fn compile_map(job: &mut PreparedJob<MemoryStore>) {
    let _ = export(
        job,
        Some("selected"),
        Dialect {
            newline: Newline::CrLf,
        },
        false,
        || 0,
    );
}
fn main() {
    std::hint::black_box(compile_map as fn(&mut PreparedJob<MemoryStore>));
}
