//! An allocation owns exactly one admitted semantic replica. Disposal drops its
//! history, projection observers, anchors and plans; later calls return Disposed.
use crate::bridge::{Bridge, Error};
use serde_json::Value;
use wasm_bindgen::prelude::*;
fn output(result: Result<Value, Error>) -> Result<String, JsValue> {
    result
        .map(|v| v.to_string())
        .map_err(|e| JsValue::from_str(&serde_json::to_string(&e).expect("error serialization")))
}
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
            .map_err(|e| {
                JsValue::from_str(&serde_json::to_string(&e).expect("error serialization"))
            })
    }
    /// Explicit initialized restore; never imports defaults or reuses a writer.
    pub fn restore(input: &str, bytes: &[u8]) -> Result<Engine, JsValue> {
        Bridge::restore(input, bytes)
            .map(|b| Self { inner: Some(b) })
            .map_err(|e| {
                JsValue::from_str(&serde_json::to_string(&e).expect("error serialization"))
            })
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
            .map_err(|e| {
                JsValue::from_str(&serde_json::to_string(&e).expect("error serialization"))
            })
    }
    pub fn state_vector(&self) -> Result<Vec<u8>, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| disposed("stateVector"))
            .map(Bridge::state_vector)
            .map_err(|e| {
                JsValue::from_str(&serde_json::to_string(&e).expect("error serialization"))
            })
    }
    pub fn encode_update(&self, vector: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| disposed("encodeUpdate"))
            .and_then(|b| b.update(vector))
            .map_err(|e| {
                JsValue::from_str(&serde_json::to_string(&e).expect("error serialization"))
            })
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
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("patch"))
                .map(Bridge::take_patch),
        )
    }
    pub fn read(&self) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("read"))
                .and_then(Bridge::read),
        )
    }
    pub fn markdown_equivalent(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("markdownEquivalent"))
                .and_then(|b| b.markdown_equivalent(input)),
        )
    }
    pub fn import_markdown(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("importMarkdown"))
                .and_then(|b| b.import_markdown(input)),
        )
    }
    pub fn export_markdown(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("exportMarkdown"))
                .and_then(|b| b.export_markdown(input)),
        )
    }
    pub fn anchor(&mut self, input: &str) -> Result<String, JsValue> {
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
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("resolve"))
                .and_then(|b| b.resolve(token)),
        )
    }
    pub fn prepare(&mut self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("prepare"))
                .and_then(|b| b.prepare(input)),
        )
    }
    pub fn commit(&mut self, token: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("commit"))
                .and_then(|b| b.commit(token)),
        )
    }
    pub fn can(&self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_ref()
                .ok_or_else(|| disposed("can"))
                .and_then(|b| b.can(input)),
        )
    }
    pub fn history(&mut self, input: &str) -> Result<String, JsValue> {
        output(
            self.inner
                .as_mut()
                .ok_or_else(|| disposed("history"))
                .and_then(|b| b.history(input)),
        )
    }
    pub fn release_anchor(&mut self, token: &str) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| {
                JsValue::from_str(&serde_json::to_string(&disposed("releaseAnchor")).unwrap())
            })?
            .release_anchor(token);
        Ok(())
    }
    pub fn release_plan(&mut self, token: &str) -> Result<(), JsValue> {
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
