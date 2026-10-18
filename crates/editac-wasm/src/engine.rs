//! An allocation owns exactly one admitted semantic replica. Disposal drops its
//! history, projection observers, anchors and plans; later calls return Disposed.
use crate::bridge::Bridge;
use editac_core::interchange::Error;
use serde_json::Value;
use wasm_bindgen::prelude::*;
// Keep one retained serializer for errors from every exported engine method.
#[inline(never)]
fn error_value(error: Error) -> JsValue {
    JsValue::from_str(&serde_json::to_string(&error).expect("error serialization"))
}
#[inline(never)]
fn output(result: Result<Value, Error>) -> Result<String, JsValue> {
    result.map(|v| v.to_string()).map_err(error_value)
}
#[inline(never)]
fn disposed(operation: &'static str) -> Error {
    Error {
        code: "Disposed",
        operation,
        message: "engine has been disposed".into(),
    }
}
#[wasm_bindgen]
pub struct Engine {
    inner: Option<Bridge>,
}
#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(input: &str) -> Result<Engine, JsValue> {
        Bridge::create(input)
            .map(|b| Self { inner: Some(b) })
            .map_err(error_value)
    }
    /// Explicit initialized restore; never imports defaults or reuses a writer.
    pub fn restore(input: &str, bytes: &[u8]) -> Result<Engine, JsValue> {
        Bridge::restore(input, bytes)
            .map(|b| Self { inner: Some(b) })
            .map_err(error_value)
    }
    pub fn asset_work(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("assetWork"))
                .and_then(|b| b.asset_work(input)),
        )
    }
    pub fn prepare_asset_commit(&self, token: &str, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("prepareAssetCommit"))
                .and_then(|b| b.prepare_asset_commit(token, input)),
        )
    }
    pub fn checkpoint_metadata(&self) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("checkpoint"))
                .map(Bridge::checkpoint_metadata),
        )
    }
    pub fn checkpoint_bytes(&self) -> Result<Vec<u8>, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| disposed("checkpoint"))
            .map(Bridge::checkpoint_bytes)
            .map_err(error_value)
    }
    pub fn state_vector(&self) -> Result<Vec<u8>, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| disposed("stateVector"))
            .map(Bridge::state_vector)
            .map_err(error_value)
    }
    pub fn encode_update(&self, vector: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| disposed("encodeUpdate"))
            .and_then(|b| b.update(vector))
            .map_err(error_value)
    }
    pub fn apply_update(&mut self, input: &str, bytes: &[u8]) -> Result<String, JsValue> {
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("applyUpdate"))
                .and_then(|b| b.apply(input, bytes)),
        )
    }
    /// Pull the detached batch only after the semantic call has returned.
    pub fn take_patch(&mut self) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.patch");
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("patch"))
                .map(Bridge::take_patch),
        )
    }
    pub fn read(&self) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.read");
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("read"))
                .and_then(Bridge::read),
        )
    }
    pub fn import_html(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("importHTML"))
                .and_then(|_| {
                    editac_html::import_tree_json(input)
                        .map(|v| v.wire())
                        .map_err(|reason| {
                            editac_core::interchange::err("InvalidInput", "importHTML", reason)
                        })
                }),
        )
    }
    pub fn validate_fragment(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("validateFragment"))
                .and_then(|bridge| {
                    let metadata = bridge.checkpoint_metadata();
                    editac_core::clipboard::validate(
                        input,
                        metadata["identity"]["schema"].as_str().unwrap(),
                    )
                    .map(|()| Value::Null)
                    .map_err(|reason| {
                        editac_core::interchange::err("InvalidInput", "validateFragment", reason)
                    })
                }),
        )
    }
    pub fn anchor(&mut self, input: &str) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.anchor");
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("anchor"))
                .and_then(|b| b.capture(input)),
        )
    }
    pub fn export_anchor(&self, token: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("exportAnchor"))
                .and_then(|b| b.export_anchor(token)),
        )
    }
    pub fn import_anchor(&mut self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("importAnchor"))
                .and_then(|b| b.import_anchor(input)),
        )
    }
    pub fn resolve(&self, token: &str) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.resolve");
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("resolve"))
                .and_then(|b| b.resolve(token)),
        )
    }
    pub fn prepare_table_source(
        &mut self,
        input: &str,
        checkpoint: &[u8],
    ) -> Result<String, JsValue> {
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("prepareTableSource"))
                .and_then(|b| b.prepare_table_source(input, checkpoint)),
        )
    }
    pub fn prepare(&mut self, input: &str) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.prepare");
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("prepare"))
                .and_then(|b| b.prepare(input)),
        )
    }
    pub fn commit(&mut self, token: &str) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.commit");
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("commit"))
                .and_then(|b| b.commit(token)),
        )
    }
    pub fn can(&self, input: &str) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.can");
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("can"))
                .and_then(|b| b.can(input)),
        )
    }
    pub fn history(&mut self, input: &str) -> Result<String, JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.history");
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("history"))
                .and_then(|b| b.history(input)),
        )
    }
    pub fn release_anchor(&mut self, token: &str) -> Result<(), JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.release_anchor");
        self.inner
            .as_mut()
            .ok_or_else(|| {
                JsValue::from_str(&serde_json::to_string(&disposed("releaseAnchor")).unwrap())
            })?
            .release_anchor(token);
        Ok(())
    }
    pub fn release_plan(&mut self, token: &str) -> Result<(), JsValue> {
        #[cfg(feature = "fitness-trace")]
        let _span = crate::fitness::Span::new("engine.release_plan");
        self.inner
            .as_mut()
            .ok_or_else(|| {
                JsValue::from_str(&serde_json::to_string(&disposed("releasePlan")).unwrap())
            })?
            .release_plan(token);
        Ok(())
    }
    pub fn dispose(&mut self) {
        self.inner.take();
    }
}
