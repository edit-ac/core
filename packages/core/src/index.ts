import { createHandle, restoreHandle, type Checkpoint, type ReplayUpdate, type DocumentIdentity, type CreateOptions, type EngineHandle, type RawEngine } from "./engine.js";
export type { CreateOptions, EngineHandle, AnchorToken, PlanToken, Bias, StableRange, ContainerStyle, MoveTarget, EditorCommand, TextCommand, FormatAction, MarkCommand, BlockFormatCommand, PrepareRequest, Json, ProjectedNode, Snapshot, AnchorResolution, HistoryRequest, HistoryState, DocumentIdentity, Checkpoint, ReplayUpdate, PatchScope, Patch, PatchSubscription, ObserverError } from "./engine.js";
export { EngineError } from "./engine.js";

/** Disposable foundation fixture; callers must release its WASM allocation. */
export interface Fixture {
  text(): string;
  utf16_length(): number;
  update_v1(): Uint8Array;
  apply_v1(bytes: Uint8Array): void;
  free(): void;
}

export interface EngineRuntime {
  createEngine(options: CreateOptions): EngineHandle;
  restoreEngine(expected: DocumentIdentity, checkpoint: Checkpoint, journal?: readonly ReplayUpdate[]): EngineHandle;
}

export interface FixtureRuntime extends EngineRuntime {
  createFixture(): Fixture;
  createdDocumentCount(): number;
}

interface Bindings {
  default(options: { module_or_path: string }): Promise<unknown>;
  Fixture: new () => Fixture;
  Engine: { new (input: string): RawEngine; restore(input: string, bytes: Uint8Array): RawEngine };
  created_document_count(): number;
}

let loading: { assetUrl: string; promise: Promise<FixtureRuntime> } | undefined;

/**
 * Load the compiled semantic engine and preserved fixture runtime explicitly. Import alone performs no I/O,
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
      createEngine: (options: CreateOptions) => createHandle(input => new bindings.Engine(input), options),
      restoreEngine: (expected: DocumentIdentity, checkpoint: Checkpoint, journal?: readonly ReplayUpdate[]) => restoreHandle((input, bytes) => bindings.Engine.restore(input, bytes), expected, checkpoint, journal),
      createFixture: () => new bindings.Fixture(),
      createdDocumentCount: () => bindings.created_document_count(),
    });
  })();
  loading = { assetUrl, promise };
  void promise.catch(() => { if (loading?.promise === promise) loading = undefined; });
  return promise;
}
