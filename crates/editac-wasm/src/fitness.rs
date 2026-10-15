//! Opt-in benchmark clock. Never compiled into the default SDK artifact.
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = globalThis, js_name = __editacFitnessNow)]
    fn now() -> f64;
    #[wasm_bindgen(js_namespace = globalThis, js_name = __editacFitnessStage)]
    fn record(operation: &str, start: f64, end: f64);
}

pub(crate) fn observe_core() -> editac_core::fitness::ObserverGuard {
    editac_core::fitness::observe(|operation, start| {
        let end = now();
        if let Some(start) = start {
            record(operation, start, end);
        }
        end
    })
}

pub(crate) struct Span(&'static str, f64);
impl Span {
    pub(crate) fn new(operation: &'static str) -> Self {
        Self(operation, now())
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        record(self.0, self.1, now());
    }
}
