//! Actual SQLite-backed NativeSession rich projection, never a NativeEngine DTO.
use editac_core::{
    Utf16Offset as U,
    anchors::{Bias, Selection},
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::Mark,
        text::TextOrigin,
    },
    document::{BlockAttributes, CreationPermit, Document, DocumentIdentity, InitialNode},
    interchange::projection_snapshot,
    modules::content::Content,
};
use editac_ffi::*;
use editac_session::{
    ports::{CheckpointRecord, LocalStore, StoreLimits},
    store::NativeStore,
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

pub struct Fixture {
    pub directory: PathBuf,
    pub options: NativeSessionOptions,
    pub expected: Value,
}
impl Fixture {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!("rich-session-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let options = NativeSessionOptions {
            path: directory.join("store.sqlite").to_str().unwrap().into(),
            document_id: format!("ab100000-0000-4000-8000-{n:012x}"),
            epoch: "ab200000-0000-4000-8000-000000000001".into(),
            writable: true,
            permission_expires_at: None,
        };
        let identity = DocumentIdentity::v5(&options.document_id, &options.epoch).unwrap();
        let mut doc = Document::create(
            CreationPermit::authorize_new(identity.clone()).unwrap(),
            &[InitialNode {
                kind: "block".into(),
                text: String::new(),
            }],
        )
        .unwrap();
        let id = doc.snapshot().unwrap().visible[0].id.clone();
        let anchor = doc.anchor(&id, U(0), Bias::Right).unwrap();
        let block = |text: &str, marks| FragmentBlock {
            runs: vec![FragmentRun {
                opaque_marks: vec![],
                text: text.into(),
                marks,
            }],
            attributes: None,
            containers: vec![],
            checked: None,
        };
        let image = Content::Image {
            url: "https://example.invalid/fixture.png".into(),
            alt: "אב 🦀".into(),
            title: "deterministic attachment".into(),
            source: "![אב 🦀](https://example.invalid/fixture.png)".into(),
        };
        let mut atom = block("", vec![]);
        atom.attributes = Some(BlockAttributes::Unknown(image.tuple().unwrap()));
        let prepared = doc
            .prepare_fragment(
                &Selection {
                    anchor: anchor.clone(),
                    focus: anchor,
                },
                &[
                    block(
                        "A🦀אב",
                        vec![
                            (Mark::Bold, None),
                            (Mark::Link, Some("https://example.invalid/link".into())),
                        ],
                    ),
                    atom,
                    block("tail e\u{301} שלום", vec![(Mark::Italic, None)]),
                ],
                &TextOrigin::new("rich-native-fixture").unwrap(),
            )
            .unwrap();
        doc.commit_editor(prepared).unwrap();
        let expected = projection_snapshot(&doc).unwrap();
        let store =
            NativeStore::create_new(&options.path, identity, StoreLimits::default()).unwrap();
        store
            .publish(0, CheckpointRecord::new(doc.checkpoint(), vec![]).unwrap())
            .unwrap();
        Self {
            directory,
            options,
            expected,
        }
    }
    pub fn open(&self) -> Arc<NativeSession> {
        NativeSession::open(self.options.clone()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE").is_none() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
