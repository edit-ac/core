//! SEC-1.8 canonical integration: actual HistoryStore/projection, source-preserving
//! image descriptors/host cache, protected SQLite Session backups and host exports.
#[allow(dead_code)]
#[path = "../src/assets.rs"]
mod assets;
#[allow(dead_code)]
#[path = "../src/envelope.rs"]
mod envelope;
#[allow(dead_code)]
#[path = "../src/keys.rs"]
mod keys;
#[allow(dead_code)]
#[path = "support/protected_sync.rs"]
mod protected_sync;
#[allow(dead_code)]
#[path = "../src/store.rs"]
mod store;
#[allow(dead_code)]
#[path = "../src/store_native.rs"]
mod store_native;
#[allow(dead_code)]
mod support;
#[allow(dead_code)]
#[path = "../src/sync.rs"]
mod sync;

use assets::*;
use editac_core::modules::content::Content;
use editac_diff::{representation::*, semantic::capture_projection};
use editac_session::{
    history_store::*,
    ports::*,
    session::{CachedPermission, Session},
};
use keys::*;
use protected_sync::*;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use store::*;
use store_native::*;
use zeroize::Zeroizing;

const ASSET_SEED: &[u8] = b"SEC18_ATTACHMENT_CONTENT_PRIVATE_20261015";
const THUMB: &[u8] = b"SEC18_THUMBNAIL_PRIVATE_20261015";
const PREVIEW: &[u8] = b"SEC18_PREVIEW_PRIVATE_20261015";
const TITLE: &str = "SEC18_PRIVATE_TITLE_20261015";
const SOURCE: &str = "![SEC18_PRIVATE_ALT](https://private.invalid/SEC18_PRIVATE_NAME.png \"SEC18_PRIVATE_TITLE_20261015\")";

#[derive(Clone)]
struct AssetKeys {
    context: KeyContext,
    failure: Arc<Mutex<Option<KeyFailure>>>,
    count: Arc<Mutex<usize>>,
    value: u8,
}
impl AssetKeys {
    fn new(epoch: u64) -> Self {
        Self {
            context: old_context(epoch),
            failure: Arc::new(Mutex::new(None)),
            count: Arc::new(Mutex::new(0)),
            value: 0x72,
        }
    }
    fn fail(&self, failure: Option<KeyFailure>) {
        *self.failure.lock().unwrap() = failure;
    }
}
impl HostKeyProvider for AssetKeys {
    fn acquire(&mut self, c: KeyContext) -> Result<DecodedKey, KeyFailure> {
        *self.count.lock().unwrap() += 1;
        if c != self.context {
            return Err(KeyFailure::Unavailable);
        }
        if let Some(f) = *self.failure.lock().unwrap() {
            return Err(f);
        }
        Ok(DecodedKey::from_host(c, Zeroizing::new([self.value; 32])))
    }
    fn unlock(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn recover(&mut self, _: KeyContext) -> Result<(), KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn wrap(&mut self, _: KeyContext, _: &[u8; 32]) -> Result<WrappedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
    fn unwrap(&mut self, _: KeyContext, _: &WrappedKey) -> Result<DecodedKey, KeyFailure> {
        Err(KeyFailure::Provider)
    }
}
fn old_context(epoch: u64) -> KeyContext {
    KeyContext {
        key_epoch: epoch,
        purpose: KeyPurpose::History,
        ..key_context()
    }
}
fn binding(kind: AssetKind) -> AssetBinding {
    AssetBinding::new(&identity(), old_context(1), kind, [18; 16], 1).unwrap()
}
type Assets = ProtectedAssets<SqliteHost, AssetKeys>;
fn assets(path: &Path, kind: AssetKind, keys: AssetKeys) -> Assets {
    ProtectedAssets::new(binding(kind), SqliteHost::open(path, None).unwrap(), keys)
        .unwrap_or_else(|_| panic!("adapter"))
}
fn history() -> HistoryStore {
    HistoryStore::new(
        "sec18-history",
        RetentionPolicy {
            max_revisions: 8,
            max_total_bytes: MAX_PLAIN,
        },
    )
    .unwrap()
}
fn capture(h: &Harness, target: &mut HistoryStore) -> HistoryRequest {
    target
        .capture_session(
            &h.a,
            &h.a.observed_revision().unwrap(),
            TITLE,
            Some("old-key-profile"),
            |doc, scope| {
                capture_projection(
                    scope,
                    &doc.snapshot()
                        .map_err(|_| RepresentationError::InvalidSemantic)?,
                    RepresentationLimits::default(),
                )
            },
        )
        .unwrap()
}
fn entry<'a>(h: &'a HistoryStore, r: &HistoryRequest) -> &'a HistoricalRevision {
    match h.read(r, Some("old-key-profile")).unwrap() {
        HistoryAvailability::Available(v) => v,
        _ => panic!("history unavailable"),
    }
}
fn image() -> Content {
    // Exactly the descriptor admitted by the upstream module and passed inertly
    // to ContentOptions.imageUrl; no network or provider exists in this harness.
    let image = Content::Image {
        url: "https://private.invalid/SEC18_PRIVATE_NAME.png".into(),
        alt: "SEC18_PRIVATE_ALT".into(),
        title: TITLE.into(),
        source: SOURCE.into(),
    };
    Content::from_tuple(&image.tuple().unwrap())
        .unwrap()
        .unwrap()
}
fn blob(path: &Path) -> Blob {
    SqliteHost::open(path, None)
        .unwrap()
        .read(MAX_BLOB)
        .unwrap()
        .unwrap()
}
fn replace_cipher(path: &Path, bytes: &[u8]) {
    rusqlite::Connection::open(path)
        .unwrap()
        .execute(
            "UPDATE protected_blob SET ciphertext=?1 WHERE slot=1",
            [bytes],
        )
        .unwrap();
}
fn scan(path: &Path) {
    for file in fs::read_dir(path).unwrap() {
        let file = file.unwrap().path();
        if file.is_dir() {
            scan(&file);
            continue;
        }
        let bytes = fs::read(&file).unwrap();
        for seed in [
            SEED.as_bytes(),
            A.as_bytes(),
            B.as_bytes(),
            ASSET_SEED,
            THUMB,
            PREVIEW,
            TITLE.as_bytes(),
            SOURCE.as_bytes(),
            b"SEC18_PRIVATE_ALT",
            b"SEC18_PRIVATE_NAME",
            &[0x61; 32],
            &[0x72; 32],
        ] {
            assert!(
                !bytes.windows(seed.len()).any(|w| w == seed),
                "seed leaked: {}",
                file.display()
            );
        }
    }
}

#[test]
fn immutable_semantic_history_roundtrips_actual_protected_session_without_current_approximation() {
    let mut h = Harness::new("assets-history");
    let mut before = history();
    let old = capture(&h, &mut before);
    let expected = entry(&before, &old).revision().bytes().to_vec();
    let path = h.dir.join("history.sqlite");
    let keys = AssetKeys::new(1);
    assets(&path, AssetKind::History, keys.clone())
        .capture_history(&before, &old, Some("old-key-profile"))
        .unwrap();
    edit(&mut h.a, A);
    let current = h.a.observed_revision().unwrap();
    let mut target = history();
    let restored = match assets(&path, AssetKind::History, keys)
        .restore_history(&mut target)
        .unwrap()
    {
        HistoryAvailability::Available(r) => r,
        _ => panic!("unavailable"),
    };
    assert_eq!(restored.scope, old.scope);
    assert_eq!(restored.hash, old.hash);
    assert_eq!(restored.representation, old.representation);
    assert_eq!(entry(&target, &restored).revision().bytes(), expected);
    assert_eq!(entry(&target, &restored).name(), TITLE);
    assert_eq!(
        entry(&target, &restored).required_key_profile(),
        Some("old-key-profile")
    );
    assert_eq!(h.a.observed_revision().unwrap(), current);
    assert!(text(&h.a).contains(A));
    assert!(!expected.windows(A.len()).any(|w| w == A.as_bytes()));
    scan(&h.dir);
}

#[test]
fn exact_and_projected_history_preserve_bytes_serializer_dialect_and_scope() {
    let h = Harness::new("assets-source-provenance");
    let observed = h.a.observed_revision().unwrap();
    for (n, projected) in [false, true].into_iter().enumerate() {
        let mut source = history();
        let request = source
            .capture_session(&h.a, &observed, TITLE, None, |_, scope| {
                let input = if projected {
                    RevisionInput::ProjectedMarkdown {
                        bytes: SOURCE.as_bytes(),
                        serializer: "host-source-v3",
                        dialect: "fixture-image-v1",
                    }
                } else {
                    RevisionInput::ExactSource(SOURCE.as_bytes())
                };
                ImmutableRevision::capture(scope, input, RepresentationLimits::default())
            })
            .unwrap();
        let path = h.dir.join(format!("source-{n}.sqlite"));
        let mut adapter = assets(&path, AssetKind::History, AssetKeys::new(1));
        adapter.capture_history(&source, &request, None).unwrap();
        let mut restored = history();
        let HistoryAvailability::Available(r) = adapter.restore_history(&mut restored).unwrap()
        else {
            panic!("unavailable")
        };
        assert_eq!(r.scope, request.scope);
        assert_eq!(r.representation, request.representation);
        assert_eq!(r.hash, request.hash);
        let HistoryAvailability::Available(e) = restored.read(&r, None).unwrap() else {
            panic!("missing")
        };
        assert_eq!(e.revision().bytes(), SOURCE.as_bytes());
    }
    scan(&h.dir);
}

#[test]
fn missing_locked_revoked_old_keys_are_unavailable_history_without_fallback_or_target_mutation() {
    let mut h = Harness::new("assets-old-keys");
    let mut source = history();
    let request = capture(&h, &mut source);
    let keys = AssetKeys::new(1);
    let path = h.dir.join("old.sqlite");
    assets(&path, AssetKind::History, keys.clone())
        .capture_history(&source, &request, Some("old-key-profile"))
        .unwrap();
    edit(&mut h.a, A);
    for failure in [
        KeyFailure::Unavailable,
        KeyFailure::Locked,
        KeyFailure::Revoked,
        KeyFailure::RecoveryRequired,
    ] {
        keys.fail(Some(failure));
        let mut target = history();
        assert!(matches!(
            assets(&path, AssetKind::History, keys.clone())
                .restore_history(&mut target)
                .unwrap(),
            HistoryAvailability::Unavailable(UnavailableReason::KeyUnavailable)
        ));
        assert!(target.is_empty());
    }
    keys.fail(None);
    let mut target = history();
    assert!(matches!(
        assets(&path, AssetKind::History, keys)
            .restore_history(&mut target)
            .unwrap(),
        HistoryAvailability::Available(_)
    ));
    scan(&h.dir);
}

#[test]
fn new_epoch_key_does_not_approximate_or_unlock_old_history() {
    let h = Harness::new("assets-epoch-key");
    let mut source = history();
    let request = capture(&h, &mut source);
    let path = h.dir.join("old.sqlite");
    assets(&path, AssetKind::History, AssetKeys::new(1))
        .capture_history(&source, &request, Some("old-key-profile"))
        .unwrap();
    let mut target = history();
    assert!(matches!(
        assets(&path, AssetKind::History, AssetKeys::new(2))
            .restore_history(&mut target)
            .unwrap(),
        HistoryAvailability::Unavailable(UnavailableReason::KeyUnavailable)
    ));
    assert!(target.is_empty());
    scan(&h.dir);
}

#[test]
fn absent_history_remains_explicitly_missing_and_capture_requires_actual_history_authorization() {
    let h = Harness::new("assets-missing-history");
    let mut source = history();
    let request = capture(&h, &mut source);
    let path = h.dir.join("history.sqlite");
    let mut adapter = assets(&path, AssetKind::History, AssetKeys::new(1));
    assert!(matches!(
        adapter.restore_history(&mut history()).unwrap(),
        HistoryAvailability::Unavailable(UnavailableReason::Missing)
    ));
    assert_eq!(
        adapter.capture_history(&source, &request, None),
        Err(AssetError::Key(KeyFailure::Unavailable))
    );
    assert!(
        SqliteHost::open(&path, None)
            .unwrap()
            .read(MAX_BLOB)
            .unwrap()
            .is_none()
    );
    scan(&h.dir);
}

#[test]
fn attachment_cache_protects_actual_module_metadata_bytes_thumbnail_and_preview() {
    let dir = dir("assets-attachment");
    let path = dir.join("cache.sqlite");
    let mut adapter = assets(&path, AssetKind::Attachment, AssetKeys::new(1));
    adapter
        .cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let view = assets(&path, AssetKind::Attachment, AssetKeys::new(1))
        .read_attachment()
        .unwrap();
    let Content::Image {
        url,
        alt,
        title,
        source,
    } = view.descriptor
    else {
        panic!("image")
    };
    assert!(url.contains("SEC18_PRIVATE_NAME"));
    assert_eq!(alt, "SEC18_PRIVATE_ALT");
    assert_eq!(title, TITLE);
    assert_eq!(source, SOURCE);
    assert_eq!(&*view.bytes, ASSET_SEED);
    assert_eq!(&*view.thumbnail, THUMB);
    assert_eq!(&*view.preview, PREVIEW);
    scan(&dir);
}

#[test]
fn tampered_truncated_and_wrong_key_cache_never_return_plaintext() {
    let dir = dir("assets-tamper");
    let path = dir.join("cache.sqlite");
    assets(&path, AssetKind::Attachment, AssetKeys::new(1))
        .cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let original = blob(&path).ciphertext;
    let mut wrong = AssetKeys::new(1);
    wrong.value = 0x73;
    assert!(
        assets(&path, AssetKind::Attachment, wrong)
            .read_attachment()
            .is_err()
    );
    let mut changed = original.clone();
    let last = changed.len() - 1;
    changed[last] ^= 1;
    for bad in [
        &changed[..],
        &original[..original.len() - 1],
        &b"plaintext fallback"[..],
    ] {
        replace_cipher(&path, bad);
        assert!(
            assets(&path, AssetKind::Attachment, AssetKeys::new(1))
                .read_attachment()
                .is_err()
        );
    }
    scan(&dir);
}

#[test]
fn authenticated_binding_rejects_cross_document_epoch_schema_profile_kind_id_and_version() {
    let h = Harness::new("assets-bindings");
    let mut source = history();
    let request = capture(&h, &mut source);
    let path = h.dir.join("history.sqlite");
    assets(&path, AssetKind::History, AssetKeys::new(1))
        .capture_history(&source, &request, Some("old-key-profile"))
        .unwrap();
    let mut variants = Vec::new();
    for field in 0..7 {
        let mut i = identity();
        match field {
            0 => i.document_id = "34567890-3456-4456-8456-345678901234".into(),
            1 => i.epoch = "45678901-4567-4567-8567-456789012345".into(),
            2 => i.schema = "other".into(),
            3 => i.profile = "other".into(),
            4 => i.protocol_version += 1,
            5 => i.update_encoding += 1,
            _ => i.offsets = "other".into(),
        }
        variants
            .push(AssetBinding::new(&i, old_context(1), AssetKind::History, [18; 16], 1).unwrap());
    }
    variants.push(
        AssetBinding::new(&identity(), old_context(1), AssetKind::History, [19; 16], 1).unwrap(),
    );
    variants.push(
        AssetBinding::new(&identity(), old_context(1), AssetKind::History, [18; 16], 2).unwrap(),
    );
    let mut key_epoch = old_context(2);
    variants
        .push(AssetBinding::new(&identity(), key_epoch, AssetKind::History, [18; 16], 1).unwrap());
    key_epoch.document = [19; 16];
    variants
        .push(AssetBinding::new(&identity(), key_epoch, AssetKind::History, [18; 16], 1).unwrap());
    let mut c = old_context(1);
    c.document_epoch += 1;
    variants.push(AssetBinding::new(&identity(), c, AssetKind::History, [18; 16], 1).unwrap());
    for b in variants {
        let mut keys = AssetKeys::new(1);
        // Same bytes deliberately supplied at every requested context: ciphertext
        // binding must reject even if a buggy provider ignores context separation.
        keys.context = c_context(&b);
        let mut adapter =
            ProtectedAssets::new(b, SqliteHost::open(&path, None).unwrap(), keys).unwrap();
        let mut target = history();
        assert!(adapter.restore_history(&mut target).is_err());
        assert!(target.is_empty());
    }
    assert!(
        assets(&path, AssetKind::Attachment, AssetKeys::new(1))
            .read_attachment()
            .is_err()
    );
    scan(&h.dir);
}
fn c_context(b: &AssetBinding) -> KeyContext {
    // The serialized binding contains public routing context, never key material.
    let value = serde_json::to_value(b).unwrap();
    KeyContext {
        document: serde_json::from_value(value["document"].clone()).unwrap(),
        document_epoch: value["document_epoch"].as_u64().unwrap(),
        key_epoch: value["key_epoch"].as_u64().unwrap(),
        purpose: KeyPurpose::History,
    }
}

#[test]
fn immutable_asset_versions_and_context_purpose_are_enforced() {
    let dir = dir("assets-immutable");
    let path = dir.join("cache.sqlite");
    let mut a = assets(&path, AssetKind::Attachment, AssetKeys::new(1));
    a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let before = blob(&path).ciphertext;
    assert_eq!(
        a.cache_attachment(&image(), b"replacement", b"", b""),
        Err(AssetError::Store(PortError::Conflict))
    );
    assert_eq!(blob(&path).ciphertext, before);
    assert!(
        AssetBinding::new(
            &identity(),
            key_context(),
            AssetKind::Attachment,
            [18; 16],
            1
        )
        .is_err()
    );
    assert!(
        AssetBinding::new(
            &identity(),
            old_context(1),
            AssetKind::Attachment,
            [0; 16],
            1
        )
        .is_err()
    );
    assert!(
        AssetBinding::new(
            &identity(),
            old_context(1),
            AssetKind::Attachment,
            [18; 16],
            0
        )
        .is_err()
    );
    scan(&dir);
}

#[test]
fn key_absence_or_revocation_never_creates_plaintext_cache_and_is_rechecked_on_each_read() {
    let dir = dir("assets-key-check");
    let path = dir.join("cache.sqlite");
    let keys = AssetKeys::new(1);
    keys.fail(Some(KeyFailure::Locked));
    let mut a = assets(&path, AssetKind::Attachment, keys.clone());
    assert_eq!(
        a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW),
        Err(AssetError::Key(KeyFailure::Locked))
    );
    assert!(
        SqliteHost::open(&path, None)
            .unwrap()
            .read(MAX_BLOB)
            .unwrap()
            .is_none()
    );
    keys.fail(None);
    a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    assert!(a.read_attachment().is_ok());
    keys.fail(Some(KeyFailure::Revoked));
    assert!(matches!(
        a.read_attachment(),
        Err(AssetError::Key(KeyFailure::Revoked))
    ));
    scan(&dir);
}

#[test]
fn cache_transaction_failure_and_lost_ack_preserve_only_protected_content() {
    for boundary in [Boundary::BeforeCommit, Boundary::AfterCommit] {
        let dir = dir("assets-write-failure");
        let path = dir.join("cache.sqlite");
        let observer: Observer = Arc::new(move |b| {
            if b == boundary {
                Err(PortError::Quota)
            } else {
                Ok(())
            }
        });
        let mut a = ProtectedAssets::new(
            binding(AssetKind::Attachment),
            SqliteHost::open(&path, Some(observer)).unwrap(),
            AssetKeys::new(1),
        )
        .unwrap();
        assert!(
            a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
                .is_err()
        );
        let mut reopened = assets(&path, AssetKind::Attachment, AssetKeys::new(1));
        if boundary == Boundary::AfterCommit {
            assert_eq!(&*reopened.read_attachment().unwrap().bytes, ASSET_SEED);
        } else {
            assert!(matches!(
                reopened.read_attachment(),
                Err(AssetError::Missing)
            ));
        }
        scan(&dir);
    }
}

#[test]
fn bounded_inputs_reject_before_key_acquisition_or_publication() {
    let dir = dir("assets-bounds");
    let path = dir.join("cache.sqlite");
    let keys = AssetKeys::new(1);
    let mut a = assets(&path, AssetKind::Attachment, keys.clone());
    assert_eq!(
        a.cache_attachment(&image(), &vec![0; MAX_PLAIN / 4 + 1], b"", b""),
        Err(AssetError::Bounds)
    );
    let invalid = Content::Image {
        url: "file:///private".into(),
        alt: String::new(),
        title: String::new(),
        source: String::new(),
    };
    assert_eq!(
        a.cache_attachment(&invalid, ASSET_SEED, b"", b""),
        Err(AssetError::Binding)
    );
    assert_eq!(*keys.count.lock().unwrap(), 0);
    assert!(
        SqliteHost::open(&path, None)
            .unwrap()
            .read(MAX_BLOB)
            .unwrap()
            .is_none()
    );
    scan(&dir);
}

#[test]
fn ciphertext_backup_restores_real_session_journal_outbox_and_readonly_authorization() {
    let mut h = Harness::new("assets-backup");
    edit(&mut h.a, A);
    let pending = h.sa.pending(&identity()).unwrap();
    let expected = text(&h.a);
    let original = blob(&h.dir.join("a.sqlite"));
    let path = h.dir.join("backup.sqlite");
    let mut backup = assets(&path, AssetKind::Backup, AssetKeys::new(1));
    backup
        .backup(&SqliteHost::open(&h.dir.join("a.sqlite"), None).unwrap())
        .unwrap();
    let recovered = backup.protected_backup().unwrap();
    assert_eq!(recovered.revision, original.revision);
    assert_eq!(recovered.ciphertext, original.ciphertext);
    let restore_path = h.dir.join("restore.sqlite");
    let native = SqliteHost::open(&restore_path, None).unwrap();
    native.restore_protected_backup(recovered).unwrap();
    assert_eq!(
        native.restore_protected_backup(backup.protected_backup().unwrap()),
        Err(PortError::Conflict)
    );
    let protected = protected(&restore_path, None);
    let mut restored = Session::open(
        protected.clone(),
        &identity(),
        CachedPermission {
            writable: false,
            expires_at: None,
        },
    )
    .unwrap();
    assert_eq!(text(&restored), expected);
    assert_eq!(protected.pending(&identity()).unwrap(), pending);
    let before = restored.document().checkpoint().bytes;
    let block = restored
        .document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let at = restored
        .document()
        .anchor(
            &block,
            editac_core::Utf16Offset(0),
            editac_core::anchors::Bias::Right,
        )
        .unwrap();
    assert!(
        restored
            .edit_text(
                &editac_core::commands::text::TextCommand::Insert {
                    at,
                    text: "forbidden".into()
                },
                &editac_core::commands::text::TextOrigin::new("asset:restore").unwrap(),
                0
            )
            .is_err()
    );
    assert_eq!(restored.document().checkpoint().bytes, before);
    scan(&h.dir);
}

struct Exporter {
    allow: bool,
    writes: usize,
    authorized: usize,
    path: PathBuf,
    binding: AssetBinding,
}
impl ExportHost for Exporter {
    fn authorize(&mut self, intent: &ExportIntent<'_>) -> bool {
        self.authorized += 1;
        self.allow
            && intent.binding == &self.binding
            && intent.destination == "fixture-authorized-file"
            && intent.label == "PLAINTEXT RECOVERY EXPORT"
    }
    fn write_plaintext(
        &mut self,
        intent: &ExportIntent<'_>,
        bytes: &[u8],
    ) -> Result<(), AssetError> {
        assert_eq!(intent.label, "PLAINTEXT RECOVERY EXPORT");
        self.writes += 1;
        fs::write(&self.path, bytes).map_err(|_| AssetError::Host)
    }
}
fn exporter(path: PathBuf, kind: AssetKind) -> Exporter {
    Exporter {
        allow: false,
        writes: 0,
        authorized: 0,
        path,
        binding: binding(kind),
    }
}

#[test]
fn plaintext_export_requires_document_policy_fresh_host_action_and_named_destination() {
    let dir = dir("assets-export-policy");
    let path = dir.join("cache.sqlite");
    let keys = AssetKeys::new(1);
    let mut a = assets(&path, AssetKind::Attachment, keys.clone());
    a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let mut host = exporter(dir.join("explicit-plaintext.json"), AssetKind::Attachment);
    host.allow = true;
    let count = *keys.count.lock().unwrap();
    assert!(matches!(
        a.export(ExportPolicy::Deny, "fixture-authorized-file", &mut host),
        Err(AssetError::Policy)
    ));
    assert_eq!(host.authorized, 0);
    assert!(matches!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "wrong-destination",
            &mut host
        ),
        Err(AssetError::Policy)
    ));
    host.allow = false;
    assert!(matches!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut host
        ),
        Err(AssetError::Policy)
    ));
    assert_eq!(*keys.count.lock().unwrap(), count);
    assert_eq!(host.writes, 0);
    assert!(!host.path.exists());
    scan(&dir); // Until explicit disclosure, all persistent artifacts are scanned.
    host.allow = true;
    let receipt = a
        .export(
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut host,
        )
        .unwrap();
    assert_eq!(host.writes, 1);
    assert_eq!(receipt.label, "PLAINTEXT RECOVERY EXPORT");
    let bytes = fs::read(&host.path).unwrap();
    assert_eq!(receipt.bytes, bytes.len());
    use sha2::Digest;
    assert_eq!(receipt.hash, <[u8; 32]>::from(sha2::Sha256::digest(&bytes)));
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["record"]["payload"]["Attachment"]["title"], TITLE);
    // Explicit export remains plaintext; this path is retained separately and
    // excluded (with authorization reason) from unauthorized-sink scan receipts.
    host.allow = false;
    assert!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut host
        )
        .is_err()
    );
    assert_eq!(host.writes, 1);
}

#[test]
fn lost_export_key_and_host_failure_do_not_trigger_implicit_recovery_or_other_sink() {
    let dir = dir("assets-export-locked");
    let keys = AssetKeys::new(1);
    let mut a = assets(
        &dir.join("cache.sqlite"),
        AssetKind::Attachment,
        keys.clone(),
    );
    a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let mut host = exporter(dir.join("must-not-exist"), AssetKind::Attachment);
    host.allow = true;
    keys.fail(Some(KeyFailure::Unavailable));
    assert!(matches!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut host
        ),
        Err(AssetError::Key(KeyFailure::Unavailable))
    ));
    assert_eq!(host.writes, 0);
    assert!(!host.path.exists());
    scan(&dir);
}

#[test]
fn protected_actual_session_recovery_export_is_retained_then_explicitly_disclosed() {
    let mut h = Harness::new("assets-recovery");
    edit(&mut h.a, A);
    let pending = h.sa.pending(&identity()).unwrap();
    let mut a = assets(
        &h.dir.join("recovery.sqlite"),
        AssetKind::Recovery,
        AssetKeys::new(1),
    );
    a.retain_recovery(&h.a.recovery_export()).unwrap();
    let mut host = exporter(h.dir.join("explicit-recovery.json"), AssetKind::Recovery);
    assert!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut host
        )
        .is_err()
    );
    assert_eq!(host.writes, 0);
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    scan(&h.dir);
    host.allow = true;
    a.export(
        ExportPolicy::ExplicitPlaintext,
        "fixture-authorized-file",
        &mut host,
    )
    .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&fs::read(&host.path).unwrap()).unwrap();
    assert_eq!(
        parsed["record"]["payload"]["Recovery"]["locally_committed"],
        true
    );
    let checkpoint: Vec<u8> =
        serde_json::from_value(parsed["record"]["payload"]["Recovery"]["checkpoint"].clone())
            .unwrap();
    assert_eq!(checkpoint, h.a.recovery_export().checkpoint.bytes);
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
}

#[test]
fn oversized_ciphertext_is_rejected_without_decryption_or_unbounded_read() {
    let dir = dir("assets-cipher-bounds");
    let path = dir.join("cache.sqlite");
    let keys = AssetKeys::new(1);
    assets(&path, AssetKind::Attachment, keys.clone())
        .cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE protected_blob SET ciphertext=zeroblob(?1)",
            [(MAX_BLOB + 1) as i64],
        )
        .unwrap();
    let before = *keys.count.lock().unwrap();
    assert!(matches!(
        assets(&path, AssetKind::Attachment, keys.clone()).read_attachment(),
        Err(AssetError::Store(PortError::ResourceLimit))
    ));
    assert_eq!(*keys.count.lock().unwrap(), before);
    scan(&dir);
}

#[test]
fn authenticated_but_invalid_history_provenance_cannot_materialize_or_mutate_target() {
    let h = Harness::new("assets-history-provenance-reject");
    let mut source = history();
    let request = capture(&h, &mut source);
    let path = h.dir.join("history.sqlite");
    assets(&path, AssetKind::History, AssetKeys::new(1))
        .capture_history(&source, &request, Some("old-key-profile"))
        .unwrap();
    let original = blob(&path).ciphertext;
    let plain = store::open(&[0x72; 32], &original).unwrap();
    for change in 0..4 {
        let mut record: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        match change {
            0 => record["payload"]["History"]["representation"] = serde_json::json!(99),
            1 => record["payload"]["History"]["hash"] = serde_json::json!(vec![0; 32]),
            2 => record["payload"]["History"]["observed"] = serde_json::json!([0]),
            _ => {
                record["payload"]["History"]["bytes"] = serde_json::json!(b"not semantic".to_vec())
            }
        }
        replace_cipher(
            &path,
            &store::seal(&[0x72; 32], &serde_json::to_vec(&record).unwrap()).unwrap(),
        );
        let mut target = history();
        assert!(
            assets(&path, AssetKind::History, AssetKeys::new(1))
                .restore_history(&mut target)
                .is_err()
        );
        assert!(target.is_empty());
    }
    scan(&h.dir);
}

#[test]
fn forged_history_request_is_rejected_by_upstream_adapter_before_any_protected_write() {
    let h = Harness::new("assets-forged-history");
    let mut source = history();
    let mut request = capture(&h, &mut source);
    request.hash = ContentHash([0; 32]);
    let path = h.dir.join("history.sqlite");
    let keys = AssetKeys::new(1);
    assert_eq!(
        assets(&path, AssetKind::History, keys.clone()).capture_history(
            &source,
            &request,
            Some("old-key-profile")
        ),
        Err(AssetError::Integrity)
    );
    assert_eq!(*keys.count.lock().unwrap(), 0);
    scan(&h.dir);
}

#[test]
fn backup_scope_mismatch_cannot_restore_plaintext_into_another_document() {
    let mut h = Harness::new("assets-backup-wrong-document");
    edit(&mut h.a, A);
    let mut wrong = identity();
    wrong.document_id = "34567890-3456-4456-8456-345678901234".into();
    let b = AssetBinding::new(&wrong, old_context(1), AssetKind::Backup, [18; 16], 1).unwrap();
    let mut a = ProtectedAssets::new(
        b,
        SqliteHost::open(&h.dir.join("backup.sqlite"), None).unwrap(),
        AssetKeys::new(1),
    )
    .unwrap();
    a.backup(&SqliteHost::open(&h.dir.join("a.sqlite"), None).unwrap())
        .unwrap();
    let path = h.dir.join("wrong-restore.sqlite");
    SqliteHost::open(&path, None)
        .unwrap()
        .restore_protected_backup(a.protected_backup().unwrap())
        .unwrap();
    let target = ProtectedStore::new(
        wrong.clone(),
        key_context(),
        StoreLimits::default(),
        SqliteHost::open(&path, None).unwrap(),
        Keys,
    )
    .unwrap_or_else(|_| panic!("adapter"));
    assert!(Session::open(Arc::new(target), &wrong, CachedPermission::LOCAL).is_err());
    scan(&h.dir);
}

#[test]
fn backup_restore_abort_or_lost_ack_preserves_exact_ciphertext_and_source_pending() {
    let mut h = Harness::new("assets-backup-commit");
    edit(&mut h.a, A);
    let pending = h.sa.pending(&identity()).unwrap();
    let mut a = assets(
        &h.dir.join("backup.sqlite"),
        AssetKind::Backup,
        AssetKeys::new(1),
    );
    a.backup(&SqliteHost::open(&h.dir.join("a.sqlite"), None).unwrap())
        .unwrap();
    let expected = a.protected_backup().unwrap().ciphertext;
    for (i, boundary) in [Boundary::BeforeCommit, Boundary::AfterCommit]
        .into_iter()
        .enumerate()
    {
        let path = h.dir.join(format!("restored-{i}.sqlite"));
        let observer: Observer = Arc::new(move |b| {
            if b == boundary {
                Err(PortError::Quota)
            } else {
                Ok(())
            }
        });
        assert!(
            SqliteHost::open(&path, Some(observer))
                .unwrap()
                .restore_protected_backup(a.protected_backup().unwrap())
                .is_err()
        );
        let read = SqliteHost::open(&path, None)
            .unwrap()
            .read(MAX_BLOB)
            .unwrap();
        if boundary == Boundary::BeforeCommit {
            assert!(read.is_none());
        } else {
            assert_eq!(read.unwrap().ciphertext, expected);
            let reopened =
                Session::open(protected(&path, None), &identity(), CachedPermission::LOCAL)
                    .unwrap();
            assert_eq!(text(&reopened), text(&h.a));
        }
    }
    assert_eq!(h.sa.pending(&identity()).unwrap(), pending);
    scan(&h.dir);
}

#[test]
fn rotated_pending_recovery_requires_separate_export_authority_and_never_reinserts() {
    let mut h = Harness::new("assets-rotated-pending");
    edit(&mut h.b, B);
    let pending = h.sb.pending(&identity()).unwrap();
    h.cb.prepare_update([81; 16], &pending[0]).unwrap();
    let plan = envelope::membership::Rotation {
        from: context(),
        next_epoch: 2,
        remove: [support::signer(2).to_public_vec()].into(),
    };
    let commit = h.ca.rotate_membership(&plan, &*h.sa).unwrap();
    assert_eq!(
        h.cb.receive_membership(&plan, &commit, &*h.sb).unwrap(),
        envelope::membership::MembershipState::Revoked
    );
    let mut a = assets(
        &h.dir.join("old-recovery.sqlite"),
        AssetKind::Recovery,
        AssetKeys::new(1),
    );
    a.retain_recovery(&h.b.recovery_export()).unwrap();
    let mut host = exporter(
        h.dir.join("explicit-old-recovery.json"),
        AssetKind::Recovery,
    );
    assert!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "fixture-authorized-file",
            &mut host
        )
        .is_err()
    );
    assert!(h.cb.send(&h.relay, [81; 16]).is_err());
    assert_eq!(h.sb.pending(&identity()).unwrap(), pending);
    scan(&h.dir);
    host.allow = true;
    a.export(
        ExportPolicy::ExplicitPlaintext,
        "fixture-authorized-file",
        &mut host,
    )
    .unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&fs::read(&host.path).unwrap()).unwrap();
    assert_eq!(doc["disclosure"], "PLAINTEXT RECOVERY EXPORT");
    assert_eq!(doc["destination"], "fixture-authorized-file");
    assert_eq!(h.sb.pending(&identity()).unwrap(), pending);
    assert!(!text(&h.a).contains(B));
    assert!(h.cb.prepare_update([82; 16], &pending[0]).is_err());
}

#[test]
fn unjournaled_session_failure_is_retained_protected_without_claiming_commit() {
    let fixture = Harness::new("assets-unjournaled");
    let dir = fixture.dir.clone();
    let path = dir.join("a.sqlite");
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let trigger = fail.clone();
    let observer: Observer = Arc::new(move |b| {
        if b == Boundary::BeforeWrite && trigger.load(std::sync::atomic::Ordering::SeqCst) {
            Err(PortError::Quota)
        } else {
            Ok(())
        }
    });
    let protected = protected(&path, Some(observer));
    let mut session =
        Session::open(protected.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    fail.store(true, std::sync::atomic::Ordering::SeqCst);
    let block = session
        .document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let at = session
        .document()
        .anchor(
            &block,
            editac_core::Utf16Offset(0),
            editac_core::anchors::Bias::Right,
        )
        .unwrap();
    assert!(
        session
            .edit_text(
                &editac_core::commands::text::TextCommand::Insert { at, text: A.into() },
                &editac_core::commands::text::TextOrigin::new("asset:failure").unwrap(),
                0
            )
            .is_err()
    );
    let recovery = session.recovery_export();
    assert!(!recovery.locally_committed);
    assert!(recovery.unjournaled.is_some());
    let mut a = assets(
        &dir.join("recovery.sqlite"),
        AssetKind::Recovery,
        AssetKeys::new(1),
    );
    a.retain_recovery(&recovery).unwrap();
    scan(&dir);
    let mut host = exporter(dir.join("explicit-unjournaled.json"), AssetKind::Recovery);
    host.allow = true;
    a.export(
        ExportPolicy::ExplicitPlaintext,
        "fixture-authorized-file",
        &mut host,
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&host.path).unwrap()).unwrap();
    let r = &value["record"]["payload"]["Recovery"];
    assert_eq!(r["locally_committed"], false);
    let bytes: Vec<u8> = serde_json::from_value(r["unjournaled"]["bytes"].clone()).unwrap();
    assert_eq!(bytes, recovery.unjournaled.as_ref().unwrap().bytes());
    assert!(protected.pending(&identity()).unwrap().is_empty());
}

#[test]
fn failed_export_sink_reports_host_failure_without_fallback_or_second_write() {
    struct Fail(usize);
    impl ExportHost for Fail {
        fn authorize(&mut self, _: &ExportIntent<'_>) -> bool {
            true
        }
        fn write_plaintext(&mut self, _: &ExportIntent<'_>, _: &[u8]) -> Result<(), AssetError> {
            self.0 += 1;
            Err(AssetError::Host)
        }
    }
    let dir = dir("assets-export-host-failure");
    let mut a = assets(
        &dir.join("cache.sqlite"),
        AssetKind::Attachment,
        AssetKeys::new(1),
    );
    a.cache_attachment(&image(), ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let mut host = Fail(0);
    assert!(matches!(
        a.export(
            ExportPolicy::ExplicitPlaintext,
            "named-destination",
            &mut host
        ),
        Err(AssetError::Host)
    ));
    assert_eq!(host.0, 1);
    scan(&dir);
}

#[test]
fn committed_source_preserving_image_flows_through_real_session_history_and_host_asset_cache() {
    use editac_core::commands::{editor::EditorCommand, text::TextOrigin};
    use editac_session::edit_service::{EditService, HostPolicy};
    let h = Harness::new("assets-committed-image");
    let dir = h.dir.clone();
    let store = h.sa.clone();
    let mut policy = HostPolicy::default();
    policy.codecs.images = true;
    let mut service = EditService::new(h.a, policy);
    let target = service
        .session()
        .document()
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    let prepared = service
        .prepare_commands(
            &service.read(0).unwrap().revision,
            &[EditorCommand::Content {
                target: target.clone(),
                content: image(),
            }],
            &TextOrigin::new("asset:image").unwrap(),
            0,
        )
        .unwrap();
    service.apply(prepared, 0).unwrap().unwrap();
    let projection = service.session().document().snapshot().unwrap();
    let node = projection.visible.iter().find(|n| n.id == target).unwrap();
    let descriptor = Content::from_tuple(&node.block_attributes.as_ref().unwrap().tuple())
        .unwrap()
        .unwrap();
    let mut cache = assets(
        &dir.join("image.sqlite"),
        AssetKind::Attachment,
        AssetKeys::new(1),
    );
    cache
        .cache_attachment(&descriptor, ASSET_SEED, THUMB, PREVIEW)
        .unwrap();
    let mut snapshots = history();
    let request = snapshots
        .capture_session(
            service.session(),
            &service.read(0).unwrap().revision,
            TITLE,
            Some("old-key-profile"),
            |doc, scope| {
                capture_projection(
                    scope,
                    &doc.snapshot()
                        .map_err(|_| RepresentationError::InvalidSemantic)?,
                    RepresentationLimits::default(),
                )
            },
        )
        .unwrap();
    let mut archive = assets(
        &dir.join("image-history.sqlite"),
        AssetKind::History,
        AssetKeys::new(1),
    );
    archive
        .capture_history(&snapshots, &request, Some("old-key-profile"))
        .unwrap();
    let mut restored = history();
    let HistoryAvailability::Available(restored_request) =
        archive.restore_history(&mut restored).unwrap()
    else {
        panic!("history")
    };
    assert_eq!(restored_request.hash, request.hash);
    assert_eq!(
        entry(&restored, &restored_request).revision().bytes(),
        entry(&snapshots, &request).revision().bytes()
    );
    let reopened = Session::open(store, &identity(), CachedPermission::LOCAL).unwrap();
    let stored = reopened
        .document()
        .snapshot()
        .unwrap()
        .visible
        .into_iter()
        .find(|n| n.id == target)
        .unwrap();
    assert_eq!(
        stored.block_attributes.as_ref().unwrap().tuple(),
        cache.read_attachment().unwrap().descriptor.tuple().unwrap()
    );
    scan(&dir);
}
