//! Real SQLite Session transfer; deterministic owned flavors, no OS clipboard/provider.
use editac_ffi::*;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
struct Fixture {
    directory: PathBuf,
    options: NativeSessionOptions,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::var_os("EDITAC_NATIVE_SESSION_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("native-transfer-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        Self {
            options: NativeSessionOptions {
                path: directory.join("session.sqlite").to_str().unwrap().into(),
                document_id: format!("af100000-0000-4000-8000-{n:012x}"),
                epoch: "af200000-0000-4000-8000-000000000001".into(),
                writable: true,
                permission_expires_at: None,
            },
            directory,
        }
    }
    fn create(&self, text: &str) -> Arc<NativeSession> {
        NativeSession::create_local(
            self.options.clone(),
            vec![NativeSessionSeed {
                kind: "block".into(),
                text: text.into(),
            }],
        )
        .unwrap()
    }
    fn open(&self) -> Arc<NativeSession> {
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
fn revision(s: &NativeSession) -> Vec<u8> {
    s.read(0).unwrap().revision.unwrap()
}
fn range(s: &NativeSession, from: u32, to: u32) -> NativeTransferRange {
    let read = s.read(0).unwrap();
    let node = read
        .nodes
        .iter()
        .find(|n| n.kind == "block")
        .unwrap()
        .id
        .clone();
    node_range(s, &node, from, &node, to)
}
fn node_range(s: &NativeSession, a: &str, from: u32, b: &str, to: u32) -> NativeTransferRange {
    let anchors = s
        .capture_anchors(
            revision(s),
            vec![
                AnchorInput {
                    node: a.into(),
                    offset_utf16: from,
                    bias: AnchorBias::Left,
                },
                AnchorInput {
                    node: b.into(),
                    offset_utf16: to,
                    bias: AnchorBias::Right,
                },
            ],
        )
        .unwrap();
    NativeTransferRange {
        anchor: anchors[0].token.clone(),
        focus: anchors[1].token.clone(),
    }
}
fn plain(text: &str) -> NativeTransferInput {
    NativeTransferInput {
        fragment_json: None,
        markdown: None,
        html: None,
        plain_text: Some(text.into()),
        literal: false,
    }
}
fn exported_input(e: &NativeTransferExport) -> NativeTransferInput {
    NativeTransferInput {
        fragment_json: Some(e.fragment_json.clone()),
        markdown: Some(e.markdown.clone()),
        html: None,
        plain_text: Some(e.plain_text.clone()),
        literal: false,
    }
}
fn paste(
    s: &NativeSession,
    range: NativeTransferRange,
    input: NativeTransferInput,
) -> NativeTransferCommit {
    let p = s.prepare_paste(revision(s), range, input, None, 0).unwrap();
    s.commit_transfer(p.token, false, None, 0).unwrap()
}
fn text(s: &NativeSession) -> String {
    s.read(0)
        .unwrap()
        .nodes
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
}
fn schema(s: &NativeSession) -> String {
    s.command_catalog(0).unwrap().schema
}
fn envelope(s: &NativeSession, blocks: Value) -> NativeTransferInput {
    NativeTransferInput {
        fragment_json: Some(json!({"version":1,"schema":schema(s),"blocks":blocks}).to_string()),
        ..plain("fallback")
    }
}
fn all(s: &NativeSession) -> NativeTransferRange {
    let nodes = s
        .read(0)
        .unwrap()
        .nodes
        .into_iter()
        .filter(|n| n.kind == "block")
        .collect::<Vec<_>>();
    let a = nodes.first().unwrap();
    let b = nodes.last().unwrap();
    node_range(s, &a.id, 0, &b.id, b.text.encode_utf16().count() as u32)
}
#[test]
fn owned_utf16_range_and_reverse_are_read_only() {
    let f = Fixture::new();
    let s = f.create("A🦀אבB");
    let before = s.read(0).unwrap();
    let history = s.history_state(0).unwrap();
    let a = s.export_transfer(revision(&s), range(&s, 1, 5), 0).unwrap();
    let b = s.export_transfer(revision(&s), range(&s, 5, 1), 0).unwrap();
    assert_eq!(a.plain_text, "🦀אב");
    assert_eq!(a.fragment_json, b.fragment_json);
    assert_eq!(s.read(0).unwrap().revision, before.revision);
    assert_eq!(s.read(0).unwrap().pending_upload, before.pending_upload);
    assert_eq!(s.history_state(0).unwrap(), history);
    assert_eq!(
        serde_json::from_str::<Value>(&a.fragment_json).unwrap()["schema"],
        schema(&s)
    );
}
#[test]
fn paste_commits_once_undo_redo_and_reopens_from_sqlite() {
    let f = Fixture::new();
    let s = f.create("A🦀B");
    let before = s.read(0).unwrap();
    let p = s
        .prepare_paste(revision(&s), range(&s, 1, 3), plain("hello"), None, 0)
        .unwrap();
    assert_eq!(text(&s), "A🦀B");
    let c = s
        .commit_transfer(p.token.clone(), false, None, 0)
        .unwrap()
        .commit
        .unwrap();
    assert_eq!(c.durability, NativeSessionDurability::ProcessCrash);
    assert_eq!(text(&s), "AhelloB");
    assert_eq!(s.read(0).unwrap().pending_upload, before.pending_upload + 1);
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    assert!(matches!(
        s.commit_transfer(p.token, false, None, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    s.undo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "A🦀B");
    s.redo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "AhelloB");
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(text(&reopened), "AhelloB");
}
#[test]
fn malformed_fragment_falls_back_with_owned_source_and_precedence() {
    let f = Fixture::new();
    let s = f.create("");
    let input = NativeTransferInput {
        fragment_json: Some("{bad".into()),
        markdown: Some("**bold**".into()),
        html: Some("<script>bad</script>".into()),
        plain_text: Some("plain".into()),
        literal: false,
    };
    let p = s
        .prepare_paste(revision(&s), range(&s, 0, 0), input, None, 0)
        .unwrap();
    assert_eq!(p.diagnostics, ["internal-fragment-rejected"]);
    assert_eq!(
        p.source.unwrap().html.as_deref(),
        Some("<script>bad</script>")
    );
    s.commit_transfer(p.token, false, None, 0).unwrap();
    let e = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    assert_eq!(e.plain_text, "bold");
    assert!(e.fragment_json.contains("bold"));
    assert!(e.fragment_json.contains("\"mark\":\"bold\""));
}
#[test]
fn unsupported_html_preserves_source_and_uses_explicit_plain_fallback() {
    let f = Fixture::new();
    let s = f.create("");
    let input = NativeTransferInput {
        html: Some("<img src='https://attack.invalid/x'>".into()),
        ..plain("safe")
    };
    let p = s
        .prepare_paste(revision(&s), range(&s, 0, 0), input, None, 0)
        .unwrap();
    assert_eq!(p.diagnostics, ["html-img-requires-extension-codec"]);
    assert_eq!(
        p.source.unwrap().html.as_deref(),
        Some("<img src='https://attack.invalid/x'>")
    );
    s.commit_transfer(p.token, false, None, 0).unwrap();
    assert_eq!(text(&s), "safe");
    let before = revision(&s);
    assert!(
        s.prepare_paste(
            before.clone(),
            range(&s, 0, 0),
            NativeTransferInput {
                plain_text: None,
                html: Some("<table><tr><td>x</td></tr></table>".into()),
                ..plain("")
            },
            None,
            0
        )
        .is_err()
    );
    assert_eq!(revision(&s), before);
}
#[test]
fn literal_paste_bypasses_rich_flavors() {
    let f = Fixture::new();
    let s = f.create("");
    paste(
        &s,
        range(&s, 0, 0),
        NativeTransferInput {
            markdown: Some("**rich**".into()),
            literal: true,
            ..plain("**literal**")
        },
    );
    assert_eq!(text(&s), "**literal**");
}
#[test]
fn code_context_keeps_newlines_literal_and_never_parses_markdown() {
    let f = Fixture::new();
    let s = f.create("");
    paste(
        &s,
        range(&s, 0, 0),
        envelope(
            &s,
            json!([{"attributes":{"type":"code","language":"rust"},"runs":[{"text":"code","marks":[]}]}]),
        ),
    );
    paste(
        &s,
        range(&s, 4, 4),
        NativeTransferInput {
            markdown: Some("**rich**".into()),
            ..plain("**raw**\nline")
        },
    );
    assert_eq!(text(&s), "code**raw**\nline");
    let e = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    let v: Value = serde_json::from_str(&e.fragment_json).unwrap();
    assert_eq!(v["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(v["blocks"][0]["attributes"]["type"], "code");
}
#[test]
fn cut_requires_ack_and_generic_commit_cannot_bypass_it() {
    let f = Fixture::new();
    let s = f.create("hello");
    let p = s.prepare_cut(revision(&s), range(&s, 1, 4), 0).unwrap();
    assert_eq!(p.exported.unwrap().plain_text, "ell");
    assert!(matches!(
        s.commit_edits(p.token.clone(), 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    assert!(s.commit_transfer(p.token.clone(), false, None, 0).is_err());
    assert_eq!(text(&s), "hello");
    assert!(matches!(
        s.commit_transfer(p.token, true, None, 0),
        Err(NativeSessionError::InvalidPlan)
    ));
    let p = s.prepare_cut(revision(&s), range(&s, 1, 4), 0).unwrap();
    s.commit_transfer(p.token, true, None, 0).unwrap();
    assert_eq!(text(&s), "ho");
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    s.undo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "hello");
}
#[test]
fn cancellation_foreign_tokens_and_disposal_never_mutate() {
    let f = Fixture::new();
    let s = f.create("hello");
    let g = Fixture::new();
    let other = g.create("other");
    let p = s.prepare_cut(revision(&s), range(&s, 0, 5), 0).unwrap();
    assert!(
        other
            .commit_transfer(p.token.clone(), true, None, 0)
            .is_err()
    );
    s.cancel_transfer(p.token.clone()).unwrap();
    s.cancel_transfer(p.token.clone()).unwrap();
    assert!(s.commit_transfer(p.token, true, None, 0).is_err());
    assert_eq!(text(&s), "hello");
    let p = s
        .prepare_paste(revision(&s), range(&s, 0, 0), plain("x"), None, 0)
        .unwrap();
    s.dispose().unwrap();
    assert!(matches!(
        s.commit_transfer(p.token, false, None, 0),
        Err(NativeSessionError::Disposed)
    ));
    assert_eq!(text(&f.open()), "hello");
}
#[test]
fn stale_permission_and_expiry_are_rechecked_and_consume_plans() {
    let f = Fixture::new();
    let s = f.create("hello");
    let p = s.prepare_cut(revision(&s), range(&s, 0, 5), 0).unwrap();
    paste(&s, range(&s, 5, 5), plain("!"));
    assert!(s.commit_transfer(p.token, true, None, 0).is_err());
    assert_eq!(text(&s), "hello!");
    let p = s.prepare_cut(revision(&s), range(&s, 0, 5), 0).unwrap();
    s.set_permission(false, None).unwrap();
    assert!(s.commit_transfer(p.token.clone(), true, None, 0).is_err());
    s.set_permission(true, None).unwrap();
    assert!(s.commit_transfer(p.token, true, None, 0).is_err());
    let p = s.prepare_cut(revision(&s), range(&s, 0, 5), 0).unwrap();
    s.set_permission(true, Some(2)).unwrap();
    assert!(s.commit_transfer(p.token, true, None, 2).is_err());
    assert_eq!(text(&s), "hello!");
}
#[test]
fn same_session_range_move_is_one_atomic_history_and_durable_receipt() {
    let f = Fixture::new();
    let s = f.create("abcdef");
    let before = s.read(0).unwrap();
    let p = s
        .prepare_transfer_move(revision(&s), range(&s, 1, 3), range(&s, 6, 6), 0)
        .unwrap();
    assert_eq!(text(&s), "abcdef");
    s.commit_transfer(p.token, false, None, 0).unwrap();
    assert_eq!(text(&s), "adefbc");
    assert_eq!(s.read(0).unwrap().pending_upload, before.pending_upload + 1);
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    s.undo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "abcdef");
    s.redo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "adefbc");
    s.dispose().unwrap();
    assert_eq!(text(&f.open()), "adefbc");
}
#[test]
fn overlap_and_noncollapsed_move_destination_reject_without_mutation() {
    let f = Fixture::new();
    let s = f.create("abcdef");
    let before = revision(&s);
    assert!(
        s.prepare_transfer_move(before.clone(), range(&s, 1, 4), range(&s, 2, 2), 0)
            .is_err()
    );
    assert!(
        s.prepare_transfer_move(before.clone(), range(&s, 1, 4), range(&s, 5, 6), 0)
            .is_err()
    );
    assert_eq!(revision(&s), before);
    assert_eq!(text(&s), "abcdef");
}
#[test]
fn cross_document_copy_is_default_and_qualified_receipt_allows_explicit_delete() {
    let f = Fixture::new();
    let source = f.create("source");
    let g = Fixture::new();
    let destination = g.create("");
    let p = source
        .prepare_cut(revision(&source), all(&source), 0)
        .unwrap();
    let exported = p.exported.unwrap();
    let pasted = destination
        .prepare_paste(
            revision(&destination),
            all(&destination),
            exported_input(&exported),
            Some(exported.source),
            0,
        )
        .unwrap();
    let receipt = destination
        .commit_transfer(pasted.token, false, None, 0)
        .unwrap()
        .destination_receipt
        .unwrap();
    assert_eq!(text(&source), "source");
    assert_eq!(text(&destination), "source");
    source
        .commit_transfer(p.token, false, Some(receipt), 0)
        .unwrap();
    assert_eq!(text(&source), "");
    assert_eq!(source.history_state(0).unwrap().undo_groups, 1);
    source.dispose().unwrap();
    destination.dispose().unwrap();
    assert_eq!(text(&f.open()), "");
    assert_eq!(text(&g.open()), "source");
}
#[test]
fn destination_receipt_is_bound_to_exact_source_intent_and_revision() {
    let f = Fixture::new();
    let source = f.create("source");
    let g = Fixture::new();
    let destination = g.create("");
    let p = source
        .prepare_cut(revision(&source), all(&source), 0)
        .unwrap();
    let e = p.exported.unwrap();
    let copied = destination
        .prepare_paste(
            revision(&destination),
            all(&destination),
            exported_input(&e),
            Some(e.source),
            0,
        )
        .unwrap();
    let receipt = destination
        .commit_transfer(copied.token, false, None, 0)
        .unwrap()
        .destination_receipt
        .unwrap();
    let another = source
        .prepare_cut(revision(&source), all(&source), 0)
        .unwrap();
    assert!(
        source
            .commit_transfer(another.token, false, Some(receipt.clone()), 0)
            .is_err()
    );
    assert_eq!(text(&source), "source");
    paste(&source, range(&source, 6, 6), plain("!"));
    assert!(
        source
            .commit_transfer(p.token, false, Some(receipt), 0)
            .is_err()
    );
    assert_eq!(text(&source), "source!");
}
#[test]
fn transformed_or_mismatched_payload_never_qualifies_destination_receipt() {
    let f = Fixture::new();
    let s = f.create("source");
    let e = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    let g = Fixture::new();
    let d = g.create("");
    let p = d
        .prepare_paste(
            revision(&d),
            all(&d),
            plain("source"),
            Some(e.source.clone()),
            0,
        )
        .unwrap();
    assert!(
        d.commit_transfer(p.token, false, None, 0)
            .unwrap()
            .destination_receipt
            .is_none()
    );
    let mut input = exported_input(&e);
    input.fragment_json = Some(input.fragment_json.unwrap().replace("source", "changed"));
    assert!(
        d.prepare_paste(revision(&d), all(&d), input, Some(e.source), 0)
            .is_err()
    );
    assert_eq!(text(&s), "source");
    assert_eq!(text(&d), "source");
}
#[test]
fn bounded_inputs_and_unsafe_internal_links_reject_or_fall_back_before_mutation() {
    let f = Fixture::new();
    let s = f.create("");
    let before = revision(&s);
    assert!(matches!(
        s.prepare_paste(
            before.clone(),
            all(&s),
            plain(&"x".repeat(1_048_577)),
            None,
            0
        ),
        Err(NativeSessionError::ResourceLimit)
    ));
    let input = envelope(
        &s,
        json!([{"attributes":{"type":"paragraph"},"runs":[{"text":"unsafe","marks":[{"mark":"link","href":"javascript:alert(1)"}]}]}]),
    );
    let p = s.prepare_paste(before, all(&s), input, None, 0).unwrap();
    assert_eq!(p.diagnostics, ["internal-fragment-rejected"]);
    s.commit_transfer(p.token, false, None, 0).unwrap();
    assert_eq!(text(&s), "fallback");
}
#[test]
fn whole_typed_tables_images_references_and_extensions_roundtrip_through_sessions() {
    let f = Fixture::new();
    let s = f.create("");
    s.set_table_policy(true).unwrap();
    s.set_atomic_content_policy(true, true).unwrap();
    let mut blocks: Vec<Value> = serde_json::from_str(include_str!(
        "../../../native/macos/tests/TablesFixture/corpus.json"
    ))
    .unwrap();
    let attachments: Vec<Value> = serde_json::from_str(include_str!(
        "../../../native/macos/tests/AttachmentsFixture/corpus.json"
    ))
    .unwrap();
    blocks.extend(attachments);
    // Existing inert extension carrier keeps full versioned data and fallback source.
    let content=editac_core::modules::content::Content::InertExtension { data:yrs::Any::from_json(&json!({"version":1,"type":"example.test","dataVersion":1,"source":"opaque","payload":{"value":"kept"}}).to_string()).unwrap() };
    let tuple = editac_core::interchange::value(&content.tuple().unwrap());
    blocks.push(json!({"attributes":{"type":"content","tuple":tuple},"runs":[{"text":"opaque","marks":[]}]}));
    blocks.push(json!({"attributes":{"type":"paragraph"},"runs":[{"text":"tail","marks":[]}]}));
    paste(&s, all(&s), envelope(&s, json!(blocks)));
    let e = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    assert!(e.fragment_json.contains("module:editac.table"));
    assert!(e.fragment_json.contains("module:editac.image"));
    assert!(e.fragment_json.contains("module:editac.reference"));
    assert!(e.fragment_json.contains("module:editac.inert-extension"));
    let g = Fixture::new();
    let d = g.create("");
    d.set_table_policy(true).unwrap();
    d.set_atomic_content_policy(true, true).unwrap();
    paste(&d, all(&d), exported_input(&e));
    let roundtrip = d.export_transfer(revision(&d), all(&d), 0).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&e.fragment_json).unwrap(),
        serde_json::from_str::<Value>(&roundtrip.fragment_json).unwrap()
    );
}
#[test]
fn revoked_typed_content_policy_rejects_retained_paste() {
    let f = Fixture::new();
    let s = f.create("");
    s.set_table_policy(true).unwrap();
    let blocks: Value = serde_json::from_str(include_str!(
        "../../../native/macos/tests/TablesFixture/corpus.json"
    ))
    .unwrap();
    let p = s
        .prepare_paste(revision(&s), all(&s), envelope(&s, blocks), None, 0)
        .unwrap();
    s.set_table_policy(false).unwrap();
    assert!(matches!(
        s.commit_transfer(p.token, false, None, 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    assert_eq!(text(&s), "");
    assert_eq!(s.history_state(0).unwrap().undo_groups, 0);
}

#[test]
fn same_document_receipt_from_another_handle_cannot_qualify_source_deletion() {
    let f = Fixture::new();
    let source = f.create("source");
    let destination = f.open();
    let p = source
        .prepare_cut(revision(&source), all(&source), 0)
        .unwrap();
    let e = p.exported.unwrap();
    let paste = destination
        .prepare_paste(
            revision(&destination),
            all(&destination),
            exported_input(&e),
            Some(e.source),
            0,
        )
        .unwrap();
    let receipt = destination
        .commit_transfer(paste.token, false, None, 0)
        .unwrap()
        .destination_receipt
        .unwrap();
    assert!(
        source
            .commit_transfer(p.token, false, Some(receipt), 0)
            .is_err()
    );
    assert_eq!(text(&source), "source");
}
#[test]
fn cross_owner_move_keeps_typed_content_and_one_history_unit() {
    let f = Fixture::new();
    let s = f.create("");
    s.set_table_policy(true).unwrap();
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../native/macos/tests/TablesFixture/corpus.json"
    ))
    .unwrap();
    paste(&s, all(&s), envelope(&s, corpus));
    let nodes = s
        .read(0)
        .unwrap()
        .nodes
        .into_iter()
        .filter(|n| n.kind == "block")
        .collect::<Vec<_>>();
    let source = node_range(
        &s,
        &nodes[0].id,
        0,
        &nodes[2].id,
        nodes[2].text.encode_utf16().count() as u32,
    );
    let last = nodes.last().unwrap();
    let destination = node_range(
        &s,
        &last.id,
        last.text.encode_utf16().count() as u32,
        &last.id,
        last.text.encode_utf16().count() as u32,
    );
    let before = s.export_transfer(revision(&s), source.clone(), 0).unwrap();
    let groups = s.history_state(0).unwrap().undo_groups;
    let pending = s.read(0).unwrap().pending_upload;
    let p = s
        .prepare_transfer_move(revision(&s), source, destination, 0)
        .unwrap();
    s.commit_transfer(p.token, false, None, 0).unwrap();
    assert_eq!(s.history_state(0).unwrap().undo_groups, groups + 1);
    assert_eq!(s.read(0).unwrap().pending_upload, pending + 1);
    let moved = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    assert!(moved.fragment_json.contains("module:editac.table"));
    s.undo(revision(&s), 0).unwrap();
    let restored = s
        .read(0)
        .unwrap()
        .nodes
        .into_iter()
        .filter(|n| n.kind == "block")
        .collect::<Vec<_>>();
    let exported = s
        .export_transfer(
            revision(&s),
            node_range(
                &s,
                &restored[0].id,
                0,
                &restored[2].id,
                restored[2].text.encode_utf16().count() as u32,
            ),
            0,
        )
        .unwrap();
    assert_eq!(before.fragment_json, exported.fragment_json);
}
#[test]
fn callout_policy_and_partial_atom_export_are_explicit() {
    let f = Fixture::new();
    let s = f.create("");
    s.set_callout_policy(true).unwrap();
    let content = editac_core::modules::content::Content::Callout {
        kind: "NOTE".into(),
        body: "body".into(),
        source: "source".into(),
    };
    let blocks = json!([{"attributes":{"type":"paragraph"},"runs":[{"text":"before","marks":[]}]},{"attributes":{"type":"content","tuple":editac_core::interchange::value(&content.tuple().unwrap())},"runs":[{"text":"body","marks":[]}]},{"attributes":{"type":"paragraph"},"runs":[{"text":"after","marks":[]}]}]);
    paste(&s, all(&s), envelope(&s, blocks));
    let nodes = s
        .read(0)
        .unwrap()
        .nodes
        .into_iter()
        .filter(|n| n.kind == "block")
        .collect::<Vec<_>>();
    let atom = &nodes[1];
    assert!(
        s.export_transfer(revision(&s), node_range(&s, &atom.id, 1, &atom.id, 2), 0)
            .is_err()
    );
    let full = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    assert!(full.fragment_json.contains("module:editac.callout"));
    let g = Fixture::new();
    let d = g.create("");
    assert!(matches!(
        d.prepare_paste(revision(&d), all(&d), exported_input(&full), None, 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
}

#[test]
fn cutting_or_replacing_existing_typed_content_cannot_bypass_revoked_policy() {
    let f = Fixture::new();
    let s = f.create("");
    s.set_table_policy(true).unwrap();
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../native/macos/tests/TablesFixture/corpus.json"
    ))
    .unwrap();
    paste(&s, all(&s), envelope(&s, corpus));
    let before = revision(&s);
    let cut = s.prepare_cut(before.clone(), all(&s), 0).unwrap();
    s.set_table_policy(false).unwrap();
    assert!(matches!(
        s.commit_transfer(cut.token, true, None, 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    assert!(matches!(
        s.prepare_cut(before.clone(), all(&s), 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    assert!(matches!(
        s.prepare_paste(before.clone(), all(&s), plain("replacement"), None, 0),
        Err(NativeSessionError::UnsupportedModule)
    ));
    assert_eq!(revision(&s), before);
}

#[test]
fn shared_html_rich_paste_is_prepared_durable_and_one_history_unit() {
    let f = Fixture::new();
    let s = f.create("");
    let initial_pending = s.read(0).unwrap().pending_upload;
    let raw = "<h2><b>é😀</b></h2><ol start='3'><li><i>one</i></li></ol><pre> x\n y</pre>";
    let p = s
        .prepare_paste(
            revision(&s),
            range(&s, 0, 0),
            NativeTransferInput {
                html: Some(raw.into()),
                ..plain("wrong fallback")
            },
            None,
            0,
        )
        .unwrap();
    assert!(p.diagnostics.is_empty());
    assert_eq!(text(&s), "");
    assert_eq!(p.source.unwrap().html.as_deref(), Some(raw));
    let committed = s
        .commit_transfer(p.token.clone(), false, None, 0)
        .unwrap()
        .commit
        .unwrap();
    assert_eq!(committed.durability, NativeSessionDurability::ProcessCrash);
    assert_eq!(s.read(0).unwrap().pending_upload, initial_pending + 1);
    assert!(s.commit_transfer(p.token, false, None, 0).is_err());
    assert!(text(&s).contains("é😀"));
    assert!(!text(&s).contains("wrong"));
    assert_eq!(s.history_state(0).unwrap().undo_groups, 1);
    let saved = s
        .export_transfer(revision(&s), all(&s), 0)
        .unwrap()
        .fragment_json;
    s.undo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "");
    s.redo(revision(&s), 0).unwrap();
    s.dispose().unwrap();
    let reopened = f.open();
    assert_eq!(
        reopened
            .export_transfer(revision(&reopened), all(&reopened), 0)
            .unwrap()
            .fragment_json,
        saved
    );
    // Reopen restores content; history is process-local.
    assert_eq!(reopened.history_state(0).unwrap().undo_groups, 0);
}
#[test]
fn shared_html_sanitizes_and_retains_exact_source() {
    let f = Fixture::new();
    let s = f.create("");
    let raw = "<script>bad</script><p onclick='bad'><a href='java&#115;cript:bad'>safe</a></p>";
    let p = s
        .prepare_paste(
            revision(&s),
            range(&s, 0, 0),
            NativeTransferInput {
                html: Some(raw.into()),
                ..plain("wrong")
            },
            None,
            0,
        )
        .unwrap();
    assert!(p.diagnostics.contains(&"html-url-dropped".into()));
    assert!(p.diagnostics.contains(&"html-executable-dropped".into()));
    assert_eq!(p.source.unwrap().html.unwrap(), raw);
    s.commit_transfer(p.token, false, None, 0).unwrap();
    assert_eq!(text(&s), "safe");
    assert!(
        !s.export_transfer(revision(&s), all(&s), 0)
            .unwrap()
            .fragment_json
            .contains("\"mark\":\"link\"")
    );
}
#[test]
fn shared_html_rejection_limits_leave_sqlite_and_history_unchanged() {
    let f = Fixture::new();
    let s = f.create("keep");
    let admission = s.read(0).unwrap();
    let before = s
        .export_transfer(revision(&s), all(&s), 0)
        .unwrap()
        .fragment_json;
    for raw in [
        "<svg><script>bad</script></svg>".into(),
        format!("{}x{}", "<div>".repeat(34), "</div>".repeat(34)),
        format!("<p title='{}'>x</p>", "x".repeat(4097)),
        "<p>x</p>".repeat(129),
    ] {
        assert!(
            s.prepare_paste(
                revision(&s),
                all(&s),
                NativeTransferInput {
                    html: Some(raw),
                    plain_text: None,
                    ..plain("")
                },
                None,
                0
            )
            .is_err()
        );
    }
    assert_eq!(
        s.export_transfer(revision(&s), all(&s), 0)
            .unwrap()
            .fragment_json,
        before
    );
    assert_eq!(s.history_state(0).unwrap().undo_groups, 0);
    let after = s.read(0).unwrap();
    assert_eq!(after.revision, admission.revision);
    assert_eq!(after.pending_upload, admission.pending_upload);
    s.dispose().unwrap();
    assert_eq!(
        {
            let reopened = f.open();
            reopened
                .export_transfer(revision(&reopened), all(&reopened), 0)
                .unwrap()
                .fragment_json
        },
        before
    );
}
#[test]
fn shared_html_precedence_literal_and_stale_permission_guards() {
    let f = Fixture::new();
    let s = f.create("");
    paste(
        &s,
        range(&s, 0, 0),
        NativeTransferInput {
            markdown: Some("**markdown**".into()),
            html: Some("<b>html</b>".into()),
            ..plain("plain")
        },
    );
    assert_eq!(text(&s), "markdown");
    paste(
        &s,
        all(&s),
        NativeTransferInput {
            literal: true,
            html: Some("<b>html</b>".into()),
            ..plain("<b>literal</b>")
        },
    );
    assert_eq!(text(&s), "<b>literal</b>");
    let p = s
        .prepare_paste(
            revision(&s),
            all(&s),
            NativeTransferInput {
                html: Some("<p>later</p>".into()),
                ..plain("")
            },
            None,
            0,
        )
        .unwrap();
    s.set_permission(false, None).unwrap();
    assert!(s.commit_transfer(p.token, false, None, 0).is_err());
    assert_eq!(text(&s), "<b>literal</b>");
}

#[test]
fn opaque_mixed_marks_transfer_cut_ack_history_and_sqlite_reopen() {
    let f = Fixture::new();
    let s = f.create("original");
    let descriptor = json!({"type":"vendor.note","version":7,"payload":{"color":"purple","nested":[false,42,"😀"]}});
    paste(
        &s,
        all(&s),
        envelope(
            &s,
            json!([{"attributes":{"type":"paragraph"},"runs":[
                {"text":"A😀","marks":[{"mark":"bold"}],"opaqueMarks":[{"key":"vendor-note","value":descriptor}]},
                {"text":"B","marks":[{"mark":"italic"}],"opaqueMarks":[{"key":"vendor-note","value":false}]}
            ]}]),
        ),
    );
    assert_eq!(text(&s), "A😀B");
    let metadata: Value =
        serde_json::from_str(&s.recovery_export().unwrap().checkpoint.metadata_json).unwrap();
    let identity = metadata["identity"].clone();
    let exported = s.export_transfer(revision(&s), all(&s), 0).unwrap();
    assert!(
        exported
            .diagnostics
            .iter()
            .any(|d| d == "opaque-marks-internal-only")
    );
    let wire: Value = serde_json::from_str(&exported.fragment_json).unwrap();
    assert_eq!(
        wire["blocks"][0]["runs"][0]["opaqueMarks"][0]["value"],
        descriptor
    );
    assert_eq!(
        wire["blocks"][0]["runs"][1]["opaqueMarks"][0]["value"],
        false
    );
    s.undo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "original");
    s.redo(revision(&s), 0).unwrap();
    assert_eq!(text(&s), "A😀B");
    let p = s.prepare_cut(revision(&s), all(&s), 0).unwrap();
    assert!(s.commit_transfer(p.token, false, None, 0).is_err());
    assert_eq!(text(&s), "A😀B");
    let p = s.prepare_cut(revision(&s), all(&s), 0).unwrap();
    s.commit_transfer(p.token, true, None, 0).unwrap();
    assert_eq!(text(&s), "");
    s.undo(revision(&s), 0).unwrap();
    assert_eq!(
        s.export_transfer(revision(&s), all(&s), 0)
            .unwrap()
            .fragment_json,
        exported.fragment_json
    );
    s.dispose().unwrap();
    let reopened = f.open();
    let metadata: Value =
        serde_json::from_str(&reopened.recovery_export().unwrap().checkpoint.metadata_json)
            .unwrap();
    assert_eq!(metadata["identity"], identity);
    assert_eq!(
        reopened
            .export_transfer(revision(&reopened), all(&reopened), 0)
            .unwrap()
            .fragment_json,
        exported.fragment_json
    );
    let f2 = Fixture::new();
    let dest = f2.create("destination");
    paste(&dest, all(&dest), exported_input(&exported));
    let copied: Value = serde_json::from_str(
        &dest
            .export_transfer(revision(&dest), all(&dest), 0)
            .unwrap()
            .fragment_json,
    )
    .unwrap();
    assert_eq!(copied["blocks"], wire["blocks"]);
    dest.dispose().unwrap();
    assert_eq!(text(&f2.open()), "A😀B");
}

#[test]
fn opaque_invalid_cancelled_stale_and_scalar_split_leave_session_unchanged() {
    let f = Fixture::new();
    let s = f.create("😀safe");
    let fragment = |marks: Value| {
        envelope(
            &s,
            json!([{"attributes":{"type":"paragraph"},"runs":[{"text":"x","marks":[],"opaqueMarks":marks}]}]),
        )
    };
    let before = s.read(0).unwrap();
    let history = s.history_state(0).unwrap();
    for marks in [
        json!([{"key":"bold","value":true}]),
        json!([{"key":"x","value":null}]),
        json!([{"key":"x","value":true},{"key":"x","value":false}]),
    ] {
        let mut input = fragment(marks);
        input.plain_text = None;
        assert!(
            s.prepare_paste(revision(&s), all(&s), input, None, 0)
                .is_err()
        );
        assert_eq!(revision(&s), before.revision.clone().unwrap());
        assert_eq!(s.read(0).unwrap().pending_upload, before.pending_upload);
        assert_eq!(s.history_state(0).unwrap(), history);
    }
    let input = fragment(json!([{"key":"vendor-note","value":{"version":1}}]));
    let p = s
        .prepare_paste(revision(&s), all(&s), input.clone(), None, 0)
        .unwrap();
    s.cancel_transfer(p.token.clone()).unwrap();
    assert!(s.commit_transfer(p.token, false, None, 0).is_err());
    assert_eq!(text(&s), "😀safe");
    let p = s
        .prepare_paste(revision(&s), all(&s), input, None, 0)
        .unwrap();
    paste(&s, range(&s, 6, 6), plain("!"));
    let changed = revision(&s);
    assert!(s.commit_transfer(p.token, false, None, 0).is_err());
    assert_eq!(revision(&s), changed);
    let node = s.read(0).unwrap().nodes[0].id.clone();
    assert!(
        s.capture_anchors(
            revision(&s),
            vec![AnchorInput {
                node,
                offset_utf16: 1,
                bias: AnchorBias::Left
            }]
        )
        .is_err()
    );
}
