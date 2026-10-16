//! Emits the pinned bundle's identities and complete syntax acknowledgements.
fn main() {
    let set = two_face::syntax::extra_newlines();
    let syntax = ["Rust", "TypeScript", "JSON"].map(|name| {
        let s = set.find_syntax_by_name(name).expect("required bundled grammar");
        serde_json::json!({"name":s.name,"scope":s.scope.to_string(),"extensions":s.file_extensions})
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "backend":editac_highlighting::BACKEND_ID,
            "grammarBundle":"two-face-0.5.2+bat-0.26.1",
            "grammars":syntax,
            "syntaxLicenses":two_face::acknowledgement::listing().for_syntaxes(),
            "upstreamAcknowledgements":two_face::acknowledgement::url()
        }))
        .unwrap()
    );
}
