//! Contract identity and actual current admission, without enabling pending profiles.
use editac_ffi::*;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
struct Fixture {
    path: PathBuf,
}
impl Fixture {
    fn session() -> (Self, std::sync::Arc<NativeSession>) {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!(
            "native-command-profiles-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        let s = NativeSession::create_local(
            NativeSessionOptions {
                path: path.join("session.sqlite").to_str().unwrap().into(),
                document_id: format!("ad300000-0000-4000-8000-{n:012x}"),
                epoch: "ad400000-0000-4000-8000-000000000001".into(),
                writable: true,
                permission_expires_at: None,
            },
            vec![NativeSessionSeed {
                kind: "block".into(),
                text: "A🦀B".into(),
            }],
        )
        .unwrap();
        (Self { path }, s)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
#[test]
fn catalog_reuses_all_portable_command_ids_and_exact_shared_identity() {
    let (_f, s) = Fixture::session();
    let c = s.command_catalog(0).unwrap();
    assert_eq!(c.revision, s.read(0).unwrap().revision);
    assert_eq!(c.schema, "editac.registry.editor.v5");
    assert_eq!(c.profile, "editac.yrs-yjs.editor.v5");
    let ts = include_str!("../../../packages/core/src/engine.ts");
    let union = ts
        .split("export type EditorCommand =")
        .nth(1)
        .unwrap()
        .split("/** Synchronous")
        .next()
        .unwrap();
    let mut ids = std::collections::BTreeSet::new();
    for line in union.lines().filter(|l| l.contains("type:")) {
        let types = line
            .split("type:")
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        for (i, part) in types.split('"').enumerate() {
            if i % 2 == 1 {
                ids.insert(part);
            }
        }
    }
    let actual = c
        .routes
        .iter()
        .map(|r| r.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(actual, ids);
    assert_eq!(c.routes.len(), actual.len());
    assert!(
        c.routes
            .iter()
            .filter(|r| !matches!(
                r.id.as_str(),
                "tableCell"
                    | "tableStructure"
                    | "atomicContent"
                    | "customMarkAt"
                    | "extensionSource"
            ))
            .all(|r| r.available && r.can_prepare && r.reason == "target-check-required")
    );
    s.dispose().unwrap();
}
#[test]
fn optional_module_unavailability_is_explicit_and_planner_enforced() {
    let (_f, s) = Fixture::session();
    let c = s.command_catalog(0).unwrap();
    let route = c.routes.iter().find(|r| r.id == "tableCell").unwrap();
    assert!(!route.available && !route.can_prepare);
    assert_eq!(route.reason, "unsupported-module");
    let read = s.read(0).unwrap();
    let error=s.check_commands(read.revision.unwrap(),json!([{ "type":"tableCell","owner":read.nodes[0].id,"expected":[],"row":0,"column":0,"text":"x" }]).to_string(),"table".into(),0).unwrap_err();
    assert!(matches!(error, NativeSessionError::UnsupportedModule));
    s.dispose().unwrap();
}
#[test]
fn profiles_preserve_first_party_ids_and_mark_host_and_pending_routes_unavailable() {
    let (_f, s) = Fixture::session();
    let c = s.command_catalog(0).unwrap();
    assert_eq!(
        c.profiles
            .iter()
            .filter(|p| p.available)
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        vec!["editac.core"]
    );
    for id in [
        "document-tools",
        "code-tools",
        "slash",
        "references",
        "reorder",
        "images",
        "tables",
        "math",
        "search",
        "code",
        "pairs",
    ] {
        let p = c
            .profiles
            .iter()
            .find(|p| p.id == format!("editac.{id}"))
            .unwrap();
        assert!(!p.available);
        assert!(!p.reason.is_empty());
    }
    for id in ["search", "code", "pairs"] {
        assert_eq!(
            c.profiles
                .iter()
                .find(|p| p.id == format!("editac.{id}"))
                .unwrap()
                .reason,
            "contract-fixture-only"
        );
    }
    s.dispose().unwrap();
}
#[test]
fn catalog_admission_tracks_permission_and_expiry_without_losing_owned_metadata() {
    let (_f, s) = Fixture::session();
    let old = s.command_catalog(0).unwrap();
    s.set_permission(false, None).unwrap();
    let ro = s.command_catalog(0).unwrap();
    assert!(ro.routes.iter().all(|r| !r.can_prepare));
    assert_eq!(
        old.routes.iter().filter(|r| r.available).count(),
        ro.routes.iter().filter(|r| r.available).count()
    );
    assert!(old.routes.iter().any(|r| r.can_prepare));
    s.set_permission(true, Some(10)).unwrap();
    assert!(
        s.command_catalog(9)
            .unwrap()
            .routes
            .iter()
            .any(|r| r.can_prepare)
    );
    assert!(
        s.command_catalog(10)
            .unwrap()
            .routes
            .iter()
            .all(|r| !r.can_prepare)
    );
    s.dispose().unwrap();
    assert!(!old.routes.is_empty());
    assert!(matches!(
        s.command_catalog(0),
        Err(NativeSessionError::Disposed)
    ));
}
