//! Semantic engine handles and the preserved foundation fixture bridge.
mod bridge;
#[cfg(test)]
mod cases;
mod engine;
#[cfg(test)]
mod updates;
use std::{cell::Cell, collections::HashMap};
use wasm_bindgen::prelude::*;
use yrs::{
    Any, Doc, Out, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlElementPrelim,
    XmlFragment, XmlTextPrelim, XmlTextRef, updates::decoder::Decode,
};

thread_local! {
    static CREATED: Cell<u32> = const { Cell::new(0) };
}

/// Cumulative fixture creation count; loading a module never creates a replica.
#[wasm_bindgen]
pub fn created_document_count() -> u32 {
    CREATED.get()
}

/// Own one UTF-16 Yrs replica using the earlier disposable XML interop fixture.
#[wasm_bindgen]
pub struct Fixture {
    doc: Doc,
    text: XmlTextRef,
}

#[wasm_bindgen]
impl Fixture {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let doc = editac_core::new_document();
        let root = doc.get_or_insert_xml_fragment("interop");
        let text = {
            let mut txn = doc.transact_mut_with("fixture:init");
            let element = root.insert(&mut txn, 0, XmlElementPrelim::empty("p"));
            element.insert_attribute(&mut txn, "id", "fixture-block");
            let text = element.insert(
                &mut txn,
                0,
                XmlTextPrelim::new("a😀b e\u{301}👩\u{200d}💻🇭🇺אב"),
            );
            text.format(
                &mut txn,
                1,
                2,
                HashMap::from([("bold".into(), Any::Bool(true))]),
            );
            text
        };
        CREATED.set(CREATED.get() + 1);
        Self { doc, text }
    }

    pub fn text(&self) -> String {
        self.text
            .diff(&self.doc.transact(), |_| ())
            .into_iter()
            .map(|part| match part.insert {
                Out::Any(Any::String(text)) => text.to_string(),
                _ => String::new(),
            })
            .collect()
    }

    pub fn utf16_length(&self) -> u32 {
        self.text.len(&self.doc.transact())
    }

    pub fn update_v1(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// Decode before mutation; only trusted deterministic fixture updates are supported.
    pub fn apply_v1(&self, bytes: &[u8]) -> Result<(), JsValue> {
        let update = Update::decode_v1(bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.doc
            .transact_mut_with("fixture:remote")
            .apply_update(update)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}
