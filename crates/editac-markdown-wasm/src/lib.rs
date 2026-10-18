//! Optional codec. Checkpoint snapshots are read-only; live mutation/history stay in Engine.
use editac_core::interchange::{
    Result, TransferBlock, kernel, parse, transfer_blocks, transfer_value,
};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
fn output(result: Result<Value>) -> std::result::Result<String, JsValue> {
    result
        .map(|v| v.to_string())
        .map_err(|e| JsValue::from_str(&serde_json::to_string(&e).expect("error serialization")))
}
#[wasm_bindgen]
pub fn import_markdown(input: &str) -> std::result::Result<String, JsValue> {
    output(import_value(input))
}
#[wasm_bindgen]
pub fn export_markdown(input: &str) -> std::result::Result<String, JsValue> {
    output(export_value(input))
}
#[wasm_bindgen]
pub fn markdown_equivalent(input: &str) -> std::result::Result<String, JsValue> {
    output(equivalent_value(input))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkdownInput {
    source: String,
    #[serde(default)]
    callouts: bool,
    #[serde(default)]
    images: bool,
    #[serde(default)]
    tables: bool,
}

pub fn equivalent_value(input: &str) -> Result<Value> {
    let [a, b]: [Vec<TransferBlock>; 2] = parse(input, "markdownEquivalent")?;
    Ok(json!(editac_markdown::export::equivalent(
        &transfer_blocks(a)?,
        &transfer_blocks(b)?
    )))
}
pub fn import_value(input: &str) -> Result<Value> {
    let r: MarkdownInput = parse(input, "importMarkdown")?;
    let p = editac_markdown::optional::import_with_codecs(
        &r.source,
        editac_markdown::optional::Codecs {
            callouts: r.callouts,
            images: r.images,
            tables: r.tables,
        },
    )
    .map_err(|e| kernel("importMarkdown", e))?;
    Ok(
        json!({"source":p.source,"blocks":p.blocks.iter().map(transfer_value).collect::<Vec<_>>(),"ranges":p.ranges.iter().map(|r|json!([r.start,r.end])).collect::<Vec<_>>(),"diagnostics":p.diagnostics.iter().map(|d|json!({"code":d.code,"range":[d.range.start,d.range.end]})).collect::<Vec<_>>()}),
    )
}
pub fn export_value(input: &str) -> Result<Value> {
    let r: Vec<TransferBlock> = parse(input, "exportMarkdown")?;
    let blocks = transfer_blocks(r)?;
    let e = editac_markdown::export::export(&blocks);
    Ok(
        json!({"markdown":e.markdown,"diagnostics":e.diagnostics.iter().map(|d|json!({"code":d.code,"range":[d.range.start,d.range.end]})).collect::<Vec<_>>(),"recovery":e.recovery.iter().map(transfer_value).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qualified_unicode_grammar_roundtrip() {
        let p = import_value(r##"{"source":"# **😀**\n\n[late][r]\n\n[r]: https://例え.テスト"}"##)
            .unwrap();
        let exported = export_value(&p["blocks"].to_string()).unwrap();
        assert!(exported["markdown"].as_str().unwrap().contains("😀"));
        let again = import_value(&json!({"source":exported["markdown"]}).to_string()).unwrap();
        assert_eq!(
            equivalent_value(&json!([p["blocks"], again["blocks"]]).to_string()).unwrap(),
            json!(true)
        );
    }
    #[test]
    fn reject_unknown_and_unbounded_input() {
        assert_eq!(
            import_value(r#"{"source":"x","unknown":true}"#)
                .unwrap_err()
                .code,
            "InvalidInput"
        );
        assert_eq!(
            import_value(&json!({"source":"x".repeat(1_048_577)}).to_string())
                .unwrap_err()
                .code,
            "EngineRejected"
        );
    }
    #[test]
    fn optional_content_preserved_without_document() {
        let p = import_value(r#"{"source":"![a](https://example.com/i)","images":true}"#).unwrap();
        assert_eq!(p["blocks"][0]["attributes"]["type"], "content");
        assert!(export_value(&p["blocks"].to_string()).is_ok());
    }
    #[test]
    fn shared_fragment_admission_rejects_unsafe_link() {
        let blocks = json!([{"attributes":{"type":"paragraph"},"runs":[{"text":"unsafe","marks":[{"mark":"link","href":"javascript:alert(1)"}]}]}]);
        assert_eq!(
            export_value(&blocks.to_string()).unwrap_err().code,
            "EngineRejected"
        );
    }
}

// Stateless source adapter: restore bounded snapshots only for the existing codec
// checks. Never commit either snapshot or allocate a second live writable owner.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SnapshotIdentity {
    profile: String,
    schema: String,
    protocol_version: u32,
    update_encoding: u32,
    offsets: String,
    document_id: String,
    epoch: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SnapshotInput {
    identity: SnapshotIdentity,
    initialized: bool,
    writer_id: u32,
}
impl SnapshotInput {
    fn restore(self, bytes: &[u8]) -> Result<editac_core::document::Document> {
        use editac_core::document::{
            Document, DocumentIdentity, InitializedCheckpoint, MAX_RESTORE_BYTES,
        };
        if bytes.len() > MAX_RESTORE_BYTES {
            return Err(editac_core::interchange::err(
                "ResourceLimit",
                "tableSource",
                "checkpoint limit",
            ));
        }
        let i = self.identity;
        let expected =
            DocumentIdentity::v5(&i.document_id, &i.epoch).map_err(|e| kernel("tableSource", e))?;
        let identity = DocumentIdentity {
            profile: i.profile,
            schema: i.schema,
            protocol_version: i.protocol_version,
            update_encoding: i.update_encoding,
            offsets: i.offsets,
            document_id: i.document_id,
            epoch: i.epoch,
        };
        let checkpoint = InitializedCheckpoint {
            identity,
            initialized: self.initialized,
            writer_id: self.writer_id,
            bytes: bytes.to_vec(),
        };
        Document::restore(&expected, &checkpoint, &[]).map_err(|e| kernel("tableSource", e))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TableSourceInput {
    baseline: SnapshotInput,
    current: SnapshotInput,
    source: String,
    owners: Vec<String>,
    action: String,
    owner: String,
    origin: String,
    #[serde(default)]
    images: bool,
    #[serde(default)]
    tables: bool,
    #[serde(default)]
    callouts: bool,
}
#[wasm_bindgen]
pub fn table_source(
    input: &str,
    baseline: &[u8],
    current: &[u8],
) -> std::result::Result<String, JsValue> {
    output(table_source_value(input, baseline, current))
}
pub fn table_source_value(input: &str, baseline: &[u8], current: &[u8]) -> Result<Value> {
    use editac_markdown::{
        optional::Codecs,
        reconcile::{SourceBaseline, SourceMode},
    };
    let r: TableSourceInput = parse(input, "tableSource")?;
    let opening = r.baseline.restore(baseline)?;
    let live = r.current.restore(current)?;
    let base = SourceBaseline::capture(
        &opening,
        &r.source,
        SourceMode::Markdown(Codecs {
            images: r.images,
            tables: r.tables,
            callouts: r.callouts,
        }),
        &r.owners,
    )
    .map_err(|e| kernel("tableSource", e))?;
    match r.action.as_str() {
        "capture" => Ok(json!({"source":base.source()})),
        "recover" => Ok(
            json!({"source":base.source_with_current_table(&live,&r.owner).map_err(|e|kernel("tableSource",e))?}),
        ),
        "prepare" => {
            let origin = editac_core::commands::text::TextOrigin::new(&r.origin)
                .map_err(|e| kernel("tableSource", e))?;
            // Re-encoding two restored Yrs replicas need not produce identical
            // update ordering. Guard the original supplied bytes, then use the
            // same read-only opening replica for the native strict prepare.
            if baseline != current || live.identity() != opening.identity() {
                return Err(editac_core::interchange::err(
                    "EngineRejected",
                    "tableSource",
                    "StalePlan",
                ));
            }
            let plan = base
                .prepare_table_format(&opening, &r.owner, &origin)
                .map_err(|e| kernel("tableSource", e))?;
            let block = opening
                .fragment_for_node(&r.owner)
                .map_err(|e| kernel("tableSource", e))?;
            Ok(
                json!({"source":plan.source(),"changed":plan.changed(),"replacement":plan.replacement_source(),"expected":editac_core::interchange::value(&block.attributes.expect("qualified table attributes").tuple())}),
            )
        }
        _ => Err(editac_core::interchange::err(
            "InvalidInput",
            "tableSource",
            "unknown source operation",
        )),
    }
}
