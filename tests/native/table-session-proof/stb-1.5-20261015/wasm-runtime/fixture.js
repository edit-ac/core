import { createHandle, restoreHandle } from "./engine.js";
export { EngineError } from "./engine.js";
let loading;
/**
 * Load the compiled semantic engine and preserved fixture runtime explicitly. Import alone performs no I/O,
 * touches no browser globals and creates no document. One URL per module instance;
 * concurrent calls share initialization and failed initialization can be retried.
 */
export function initFixture(assetUrl) {
    if (typeof assetUrl !== "string" || assetUrl.trim() === "") {
        return Promise.reject(new TypeError("A nonempty WASM asset URL is required"));
    }
    if (loading) {
        if (loading.assetUrl !== assetUrl) {
            return Promise.reject(new Error("The runtime is already initializing or initialized with another asset URL"));
        }
        return loading.promise;
    }
    // A static URL lets bundlers emit the generated glue asset while native ESM
    // resolves it next to this module. Keep initialization asynchronous.
    const gluePath = new URL("./wasm-fixture/editac_wasm.js", import.meta.url).href;
    const promise = (async () => {
        const bindings = await import(gluePath);
        const exports = await bindings.default({ module_or_path: assetUrl });
        if (typeof exports.fixture_new !== "function" || typeof exports.created_document_count !== "function") {
            throw new Error("Foundation fixture bindings are required; use the explicit fixture qualification build");
        }
        return Object.freeze({
            createEngine: (options) => createHandle(input => new bindings.Engine(input), options),
            restoreEngine: (expected, checkpoint, journal) => restoreHandle((input, bytes) => bindings.Engine.restore(input, bytes), expected, checkpoint, journal),
            createFixture: () => new bindings.Fixture(),
            createdDocumentCount: () => bindings.created_document_count(),
        });
    })();
    loading = { assetUrl, promise };
    void promise.catch(() => { if (loading?.promise === promise)
        loading = undefined; });
    return promise;
}
