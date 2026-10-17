// Compile the same read/write/ZIP/XML/media surface for WASM; not a runtime claim.
#[path = "../tests/support/docx_probe.rs"]
mod probe;
fn main() {
    probe::compile_probe();
}
