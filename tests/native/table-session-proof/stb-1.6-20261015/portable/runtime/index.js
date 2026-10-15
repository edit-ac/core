import { createHandle, restoreHandle } from "./engine.js";
export { EngineError } from "./engine.js";
let loading;
/**
 * Load the compiled semantic engine production runtime explicitly. Import alone performs no I/O,
 * touches no browser globals and creates no document. One URL per module instance;
 * concurrent calls share initialization and failed initialization can be retried.
 */
export function init(assetUrl) {
    if (typeof assetUrl !== "string" || assetUrl.trim() === "") {
        return Promise.reject(new TypeError("A nonempty WASM asset URL is required"));
    }
    if (loading) {
        if (loading.assetUrl !== assetUrl) {
            return Promise.reject(new Error("The runtime is already initializing or initialized with another asset URL"));
        }
        return loading.promise;
    }
    // Keep the generated dependency visible to bundlers. Its JS is packaged in
    // dist/wasm, outside the hand-maintained TypeScript source tree. A string type
    // avoids resolving that generated module during source-only typechecking.
    const promise = (async () => {
        const { default: initialize, Engine } = await import("./wasm/editac_runtime.js");
        await initialize(assetUrl);
        return Object.freeze({
            createEngine: (options) => createHandle(input => new Engine(input), options),
            restoreEngine: (expected, checkpoint, journal) => restoreHandle((input, bytes) => Engine.restore(input, bytes), expected, checkpoint, journal),
        });
    })();
    loading = { assetUrl, promise };
    void promise.catch(() => { if (loading?.promise === promise)
        loading = undefined; });
    return promise;
}
// Keep unbundled hosts with an existing root import map compatible.
export * from "./links/index.js";
