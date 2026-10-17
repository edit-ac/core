//! Native candidate fixture plus isolated-process enforcement probes. Not a
//! production converter. Never interpret input content as code or a template.
#[path = "../tests/support/pdf_probe.rs"]
mod probe;
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let result = run(&args[1..]);
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(2)
    }
}
fn run(args: &[String]) -> Result<(), String> {
    let mode = args.first().map(String::as_str).unwrap_or("");
    match mode {
        "generate" => {
            let root = std::path::Path::new(args.get(1).ok_or("PDF_ARGUMENT")?);
            let latin = std::fs::read(root.join("NotoSans-Regular.ttf"))
                .map_err(|_| "PDF_FONT_UNAVAILABLE")?;
            let arabic = std::fs::read(root.join("NotoNaskhArabic-Regular.ttf"))
                .map_err(|_| "PDF_FONT_UNAVAILABLE")?;
            let pdf = probe::render(&latin, &arabic)?;
            std::fs::write(args.get(2).ok_or("PDF_ARGUMENT")?, pdf)
                .map_err(|_| "PDF_WRITE_FAILED")?;
        }
        "read" => {
            std::fs::read(args.get(1).ok_or("PDF_ARGUMENT")?).map_err(|_| "PDF_READ_DENIED")?;
        }
        "write" => {
            std::fs::write(args.get(1).ok_or("PDF_ARGUMENT")?, b"no")
                .map_err(|_| "PDF_WRITE_DENIED")?;
        }
        "network" => {
            std::net::TcpStream::connect("127.0.0.1:9")
                .map_err(|e| format!("PDF_NETWORK_DENIED:{:?}", e.kind()))?;
        }
        "child" => {
            let r = std::process::Command::new("/usr/bin/true")
                .status()
                .map_err(|_| "PDF_CHILD_DENIED")?;
            if !r.success() {
                return Err("PDF_CHILD_DENIED".into());
            }
        }
        "spin" => loop {
            std::hint::black_box(1 + 1);
        },
        "allocate" => {
            let mut v = Vec::new();
            loop {
                v.push(vec![1u8; 1024 * 1024]);
                std::hint::black_box(&v);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        "output" => {
            use std::io::Write;
            let mut f = std::fs::File::create(args.get(1).ok_or("PDF_ARGUMENT")?)
                .map_err(|_| "PDF_WRITE_FAILED")?;
            loop {
                f.write_all(&[1; 65536]).map_err(|_| "PDF_OUTPUT_LIMIT")?;
            }
        }
        _ => return Err("PDF_PROFILE_UNAVAILABLE".into()),
    }
    Ok(())
}
