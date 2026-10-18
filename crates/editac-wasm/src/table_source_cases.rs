//! Real optional codec -> production Engine bridge, no mocked semantic owners.
use super::*;
use editac_core::interchange::transfer_blocks;
const SOURCE: &str = "Before  😀\n\n| a | bb |\n| :- | -: |\n| `x\\|y` | é |\n\nAfter  exact";
fn fixture() -> (Bridge, Value, Vec<u8>, Vec<String>, String) {
    static BASE: std::sync::OnceLock<(Value, Vec<u8>)> = std::sync::OnceLock::new();
    let (metadata, bytes) = BASE.get_or_init(|| {
        let b = Bridge::create(r#"{"profile":"v5","documentId":"98777777-7777-4777-8777-777777777777","epoch":"98888888-8888-4888-8888-888888888888","nodes":[{"text":""}]}"#).unwrap();
        let mut metadata = b.checkpoint_metadata(); metadata["expected"] = metadata["identity"].clone(); metadata["journal"] = json!([]);
        (metadata, b.checkpoint_bytes())
    });
    let mut b = Bridge::restore(&metadata.to_string(), bytes).unwrap();
    let node = b.doc.snapshot().unwrap().visible[0].id.clone();
    let at = b.doc.anchor(&node, Utf16Offset(0), Bias::Right).unwrap();
    let selection = Selection {
        anchor: at.clone(),
        focus: at,
    };
    let imported =
        editac_markdown_wasm::import_value(&json!({"source":SOURCE,"tables":true}).to_string())
            .unwrap();
    let blocks = serde_json::from_value(imported["blocks"].clone()).unwrap();
    let plan = b
        .doc
        .prepare_fragment(
            &selection,
            &transfer_blocks(blocks).unwrap(),
            &TextOrigin::new("fixture").unwrap(),
        )
        .unwrap();
    b.doc.commit_editor(plan).unwrap();
    b.doc.clear_history();
    let owners: Vec<_> = b
        .doc
        .snapshot()
        .unwrap()
        .visible
        .iter()
        .filter(|n| n.kind == "block")
        .map(|n| n.id.clone())
        .collect();
    let owner = owners[1].clone();
    let input = json!({"baseline":b.checkpoint_metadata(),"current":b.checkpoint_metadata(),"source":SOURCE,"owners":owners,"owner":owner,"origin":"local:table-source","action":"prepare","tables":true});
    let checkpoint = b.checkpoint_bytes();
    (b, input, checkpoint, owners, owner)
}
fn proposal(input: &Value, opening: &[u8], current: &[u8]) -> Value {
    editac_markdown_wasm::table_source_value(&input.to_string(), opening, current).unwrap()
}
fn prepare(b: &mut Bridge, p: &Value, owner: &str, checkpoint: &[u8]) -> String {
    b.prepare_table_source(&json!({"owner":owner,"origin":"local:table-source","expected":p["expected"],"source":p["replacement"]}).to_string(),checkpoint).unwrap()["token"].as_str().unwrap().into()
}
#[test]
fn source_table_codec_engine_history_recovery_and_targeted_invalidation() {
    let (mut b, mut input, opening, owners, owner) = fixture();
    let before = b.doc.snapshot().unwrap();
    let p = proposal(&input, &opening, &opening);
    assert_eq!(b.checkpoint_bytes(), opening);
    assert_eq!(p["changed"], true);
    let token = prepare(&mut b, &p, &owner, &opening);
    b.commit(&token).unwrap();
    let patch = b.doc.last_patch().unwrap();
    assert_eq!(
        patch.changed_nodes.iter().cloned().collect::<Vec<_>>(),
        vec![owner.clone()]
    );
    assert!(patch.touched_ranges.is_empty());
    let selected_sources: std::collections::BTreeSet<_> = before
        .visible
        .iter()
        .find(|n| n.id == owner)
        .unwrap()
        .spans
        .iter()
        .map(|s| s.source.clone())
        .collect();
    assert_eq!(patch.changed_sources, selected_sources);
    let after = b.doc.snapshot().unwrap();
    assert_eq!(after.source_reads, 0);
    assert!(!after.structure_rebuilt);
    let current = b.doc.checkpoint();
    let canonical = Document::restore(b.doc.identity(), &current, &[])
        .unwrap()
        .snapshot()
        .unwrap();
    assert_eq!(after.visible, canonical.visible);
    assert_eq!(
        after.retained_structure, canonical.retained_structure,
        "source cache equals fresh canonical replay"
    );
    for (a, z) in before.visible.iter().zip(&after.visible) {
        if a.id != owner {
            assert_eq!(a, z);
        } else {
            assert_eq!(a.spans, z.spans);
            assert_eq!(a.runs, z.runs);
        }
    }
    assert_eq!(b.doc.history_state().undo_groups, 1);
    input["action"] = json!("recover");
    input["current"] = b.checkpoint_metadata();
    assert_eq!(
        proposal(&input, &opening, &b.checkpoint_bytes())["source"],
        p["source"]
    );
    b.history(r#"{"type":"undo"}"#).unwrap();
    input["current"] = b.checkpoint_metadata();
    assert_eq!(
        proposal(&input, &opening, &b.checkpoint_bytes())["source"],
        SOURCE
    );
    b.history(r#"{"type":"redo"}"#).unwrap();
    input["current"] = b.checkpoint_metadata();
    assert_eq!(
        proposal(&input, &opening, &b.checkpoint_bytes())["source"],
        p["source"]
    );
    let restored=Bridge::restore(&json!({"expected":b.checkpoint_metadata()["identity"],"identity":b.checkpoint_metadata()["identity"],"initialized":true,"writerId":b.doc.writer_id(),"journal":[]}).to_string(),&b.checkpoint_bytes()).unwrap();
    assert_eq!(
        proposal(&input, &opening, &restored.checkpoint_bytes())["source"],
        p["source"]
    );
    assert_eq!(owners.len(), 3);
}
#[test]
fn source_table_stale_prepare_and_single_use_commit_have_zero_effects() {
    let (mut b, input, opening, _, owner) = fixture();
    let p = proposal(&input, &opening, &opening);
    let token = prepare(&mut b, &p, &owner, &opening);
    b.commit(&token).unwrap();
    let changed = b.checkpoint_bytes();
    assert!(b.prepare_table_source(&json!({"owner":owner,"origin":"local:table-source","expected":p["expected"],"source":p["replacement"]}).to_string(),&opening).is_err());
    assert!(
        editac_markdown_wasm::table_source_value(&input.to_string(), &opening, &changed).is_err()
    );
    assert_eq!(b.commit(&token).unwrap_err().code, "InvalidHandle");
    assert_eq!(b.checkpoint_bytes(), changed);
}
#[test]
fn source_table_noop_guard_and_invalid_target_reject_without_mutation() {
    let (mut b, mut input, opening, _, owner) = fixture();
    let p = proposal(&input, &opening, &opening);
    let token = prepare(&mut b, &p, &owner, &opening);
    b.commit(&token).unwrap();
    let current = b.checkpoint_bytes();
    input["baseline"] = b.checkpoint_metadata();
    input["current"] = b.checkpoint_metadata();
    input["source"] = p["source"].clone();
    let noop = proposal(&input, &current, &current);
    assert_eq!(noop["changed"], false);
    let token = prepare(&mut b, &noop, &owner, &current);
    b.commit(&token).unwrap();
    assert_eq!(b.checkpoint_bytes(), current);
    assert_eq!(b.doc.history_state().undo_groups, 1);
    let delayed = prepare(&mut b, &noop, &owner, &current);
    b.history(r#"{"type":"undo"}"#).unwrap();
    let before = b.checkpoint_bytes();
    assert!(
        b.commit(&delayed)
            .unwrap_err()
            .message
            .contains("StalePlan")
    );
    assert_eq!(b.checkpoint_bytes(), before);
    input["owner"] = json!("missing");
    assert!(
        editac_markdown_wasm::table_source_value(&input.to_string(), &current, &current).is_err()
    );
}
