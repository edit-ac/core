/** Disposable foundation fixture; callers must release its WASM allocation. */
export interface Fixture {
  text(): string;
  utf16_length(): number;
  update_v1(): Uint8Array;
  apply_v1(bytes: Uint8Array): void;
  free(): void;
}

export interface FixtureRuntime {
  createFixture(): Fixture;
  createdDocumentCount(): number;
}

interface Bindings {
  default(options: { module_or_path: string }): Promise<unknown>;
  Fixture: new () => Fixture;
  created_document_count(): number;
}

let loading: { assetUrl: string; promise: Promise<FixtureRuntime> } | undefined;

/**
 * Load the compiled fixture runtime explicitly. Import alone performs no I/O,
 * touches no browser globals and creates no document. One URL per module instance;
 * concurrent calls share initialization and failed initialization can be retried.
 */
export function init(assetUrl: string): Promise<FixtureRuntime> {
  if (typeof assetUrl !== "string" || assetUrl.trim() === "") {
    return Promise.reject(new TypeError("A nonempty WASM asset URL is required"));
  }
  if (loading) {
    if (loading.assetUrl !== assetUrl) {
      return Promise.reject(new Error("The runtime is already initializing or initialized with another asset URL"));
    }
    return loading.promise;
  }
  const gluePath = "./wasm/editac_wasm.js";
  const promise = (async () => {
    const bindings = await import(gluePath) as Bindings;
    await bindings.default({ module_or_path: assetUrl });
    return Object.freeze({
      createFixture: () => new bindings.Fixture(),
      createdDocumentCount: () => bindings.created_document_count(),
    });
  })();
  loading = { assetUrl, promise };
  void promise.catch(() => { if (loading?.promise === promise) loading = undefined; });
  return promise;
}
