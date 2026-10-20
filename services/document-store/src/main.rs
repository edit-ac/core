use editac_document_store::SqliteBackend;
use std::path::Path;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 || args[0] != "--store" {
        eprintln!("usage: editac-document-store --store /absolute/local/host.sqlite");
        std::process::exit(2);
    }
    match SqliteBackend::open(Path::new(&args[1])) {
        Ok(backend) => println!("{:?}", backend.capabilities()),
        Err(error) => {
            eprintln!("host bootstrap: {error}");
            std::process::exit(1);
        }
    }
}
