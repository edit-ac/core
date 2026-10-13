import { createHandle, restoreHandle, type Checkpoint, type ReplayUpdate, type DocumentIdentity, type CreateOptions, type EngineHandle, type RawEngine } from "./engine.js";
export type { CreateOptions, EngineHandle, CommitResult, AnchorToken, PortableAnchor, PlanToken, Bias, StableRange, ContainerStyle, MoveTarget, EditorCommand, TextCommand, FormatAction, MarkCommand, BlockFormatCommand, PrepareRequest, Json, ProjectedNode, Snapshot, AnchorResolution, HistoryRequest, HistoryState, DocumentIdentity, Checkpoint, ReplayUpdate, PatchScope, Patch, PatchSubscription, ObserverError } from "./engine.js";
export type { FragmentBlock, FragmentRun, PreparedMarkdown, MarkdownDiagnostic, MarkdownExport, MarkdownExtension, MarkdownOptions } from "./engine.js";
export { EngineError } from "./engine.js";
export type { EngineErrorCode } from "./engine.js";

export interface EngineRuntime {
  createEngine(options: CreateOptions): EngineHandle;
  restoreEngine(expected: DocumentIdentity, checkpoint: Checkpoint, journal?: readonly ReplayUpdate[]): EngineHandle;
}

interface Bindings {
  default(options: { module_or_path: string }): Promise<unknown>;
  Engine: { new (input: string): RawEngine; restore(input: string, bytes: Uint8Array): RawEngine };
}

let loading: { assetUrl: string; promise: Promise<EngineRuntime> } | undefined;

/**
 * Load the compiled semantic engine production runtime explicitly. Import alone performs no I/O,
 * touches no browser globals and creates no document. One URL per module instance;
 * concurrent calls share initialization and failed initialization can be retried.
 */
export function init(assetUrl: string): Promise<EngineRuntime> {
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
    const bindings = await import("./wasm/editac_wasm.js" as string) as Bindings;
    await bindings.default({ module_or_path: assetUrl });
    return Object.freeze({
      createEngine: (options: CreateOptions) => createHandle(input => new bindings.Engine(input), options),
      restoreEngine: (expected: DocumentIdentity, checkpoint: Checkpoint, journal?: readonly ReplayUpdate[]) => restoreHandle((input, bytes) => bindings.Engine.restore(input, bytes), expected, checkpoint, journal),
    });
  })();
  loading = { assetUrl, promise };
  void promise.catch(() => { if (loading?.promise === promise) loading = undefined; });
  return promise;
}
