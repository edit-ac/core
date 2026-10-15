//! Export the very same real Document/NativeStore fixture as the Rust projection proof.
#[path = "../tests/support/rich_fixture.rs"]
mod rich_fixture;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--disable") {
        use editac_core::{
            commands::{editor::EditorCommand, text::TextOrigin},
            document::DocumentIdentity,
        };
        use editac_session::{
            edit_service::{EditService, HostPolicy},
            ports::StoreLimits,
            session::{CachedPermission, Session},
            store::NativeStore,
        };
        let id = DocumentIdentity::v5(&args[3], &args[4]).unwrap();
        let store =
            NativeStore::open_existing(&args[2], id.clone(), StoreLimits::default()).unwrap();
        let session = Session::open(
            store,
            &id,
            CachedPermission {
                writable: true,
                expires_at: None,
            },
        )
        .unwrap();
        let mut service = EditService::new(session, HostPolicy::default());
        let revision = service.session().observed_revision().unwrap();
        let prepared = service
            .prepare_commands(
                &revision,
                &[EditorCommand::Enable {
                    target: args[5].clone(),
                    enabled: false,
                }],
                &TextOrigin::new("fixture-remote-delete").unwrap(),
                0,
            )
            .unwrap();
        service.apply(prepared, 0).unwrap();
        return;
    }
    let f = rich_fixture::Fixture::new();
    let session = f.open();
    let snapshot = session.rich_snapshot().unwrap();
    session.dispose().unwrap();
    let manifest = serde_json::json!({
        "path": f.options.path, "documentId": f.options.document_id,
        "epoch": f.options.epoch, "expected": f.expected,
        "sessionSnapshot": serde_json::from_str::<serde_json::Value>(&snapshot.snapshot_json).unwrap(),
        "factory": "tests/support/rich_fixture.rs:Fixture::new",
        "providerCalls": 0
    });
    std::fs::write(
        f.directory.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    println!("{}", f.directory.join("manifest.json").display());
}
