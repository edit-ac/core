//! Deterministic subprocess crash at the actual SQLite/host-effect boundary.
use editac_core::{document::DocumentIdentity, modules::assets::*};
use editac_session::{
    assets::*,
    ports::*,
    store::{NativeStore, TransactionBoundary},
};
use std::{path::PathBuf, sync::Arc};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let path = PathBuf::from(&args[1]);
    let mode = args[2].clone();
    let boundary = match mode.as_str() {
        "before" => Some(TransactionBoundary::BeforeCommit),
        "after" => Some(TransactionBoundary::AfterCommit),
        _ => None,
    };
    let id = DocumentIdentity::v5(
        "ac120000-0000-4000-8000-000000000012",
        "ac120000-0000-4000-8000-000000000001",
    )
    .unwrap();
    let observer = Arc::new(move |b| {
        if Some(b) == boundary {
            std::process::exit(73)
        }
    });
    let s = NativeStore::open_existing_observed(&path, id, StoreLimits::default(), Some(observer))
        .unwrap();
    let r = AssetRequest {
        version: 1,
        operation_id: "crash_op".into(),
        identity: AssetIdentity {
            host: "prepared".into(),
            key: "shared_binary".into(),
        },
        action: AssetAction::Publish,
        byte_limit: 1024,
    };
    let grant = AssetGrant {
        identity: r.identity.clone(),
        actions: vec![r.action],
    };
    AssetWork::new(&s).enqueue("node_ref", r, &grant).unwrap();
    if mode == "effect" || mode == "resume" {
        struct Host {
            path: PathBuf,
            crash: bool,
        }
        impl AssetHost for Host {
            fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
                Ok(AssetGrant {
                    identity: r.identity.clone(),
                    actions: vec![r.action],
                })
            }
            fn execute(
                &mut self,
                _reference: &str,
                r: &AssetRequest,
            ) -> Result<HostOutcome, PortError> {
                assert_eq!(
                    std::fs::read(self.path.with_extension("local-bytes")).unwrap(),
                    b"hello asset!"
                );
                // A prepared host's durable idempotency table, separate from document store.
                match std::fs::read_to_string(&self.path) {
                    Ok(old) => assert_eq!(old, r.operation_id),
                    Err(_) => {
                        let f = std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&self.path)
                            .unwrap();
                        use std::io::Write;
                        let mut f = f;
                        f.write_all(r.operation_id.as_bytes()).unwrap();
                        f.sync_all().unwrap();
                    }
                }
                if self.crash {
                    std::process::exit(74)
                }
                Ok(HostOutcome::Published(AssetCommitReceipt {
                    operation_id: r.operation_id.clone(),
                    identity: r.identity.clone(),
                }))
            }
        }
        AssetWork::new(&s)
            .run_one(
                "crash_op",
                true,
                &mut Host {
                    path: path.with_extension("host-effect"),
                    crash: mode == "effect",
                },
            )
            .unwrap();
    }
}
