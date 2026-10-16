/** Explicit v5 creation; importing this module never allocates a replica. */
export interface CreateOptions {
  profile: "v5";
  documentId: string;
  epoch: string;
  nodes: readonly { text: string }[];
}
declare const anchorBrand: unique symbol;
declare const planBrand: unique symbol;
/** Scoped to one engine. Release when no longer needed. */
export type AnchorToken = string & { readonly [anchorBrand]: true };
/** Single-use plan; failed stale commits consume it too. */
export type PlanToken = string & { readonly [planBrand]: true };
export type Bias = "left" | "right";
/** Ephemeral Yrs/Yjs relative position; never a document update or durable token. */
export interface PortableAnchor { version: 1; identity: DocumentIdentity; source: string; sourceIdentity: string; position: Json }
export interface StableRange { anchor: AnchorToken; focus: AnchorToken }
export type ContainerStyle = { type: "unordered" | "checklist" | "quote" } | { type: "ordered"; start: number };
export interface MoveTarget { id: string; version: string }
export type EditorCommand =
  | { type: "customMarkAt"; owner: string; from: number; to: number; key: string; value: Json | null }
  | { type: "extensionSource"; owner: string; expected: Json; at: AnchorToken; source: string }
  | { type: "replaceAt"; owner: string; from: number; to: number; text: string }
  | { type: "markAt"; owner: string; from: number; to: number; mark: MarkCommand["mark"]; action: FormatAction; href?: string | null }
  | { type: "selectionAt" | "historySelectionAt"; anchor: EditorPosition; focus: EditorPosition }
  | { type: "atomicContent"; owner: string; expected: Json; at: AnchorToken; replacement: Json | null }
  | { type: "tableCell"; owner: string; expected: Json; row: number; column: number; text: string }
  /** Exact-descriptor, bounded simple-cell clear or literal matrix paste. Host policy supplies protected coordinates. */
  | { type: "tableRectangle"; owner: string; expected: Json; row: number; column: number; rows: number; columns: number; cells: readonly (readonly string[])[] | null; protected: readonly (readonly [number, number])[] }
  | { type: "tableStructure"; owner: string; expected: Json; action: "insertRow" | "deleteRow" | "insertColumn" | "deleteColumn"; index: number }
  | { type: "tableAttributes"; owner: string; expected: Json; row: number; column: number; rows: number; columns: number; alignment: "none" | "left" | "center" | "right" | null; header: boolean | null; protected: readonly (readonly [number, number])[] }
  | { type: "insert"; at: AnchorToken; text: string }
  | { type: "delete"; range: StableRange }
  | { type: "replace"; range: StableRange; text: string }
  | { type: "split" | "headingEnd" | "enter" | "backspace"; owner: string; at: AnchorToken }
  | { type: "join"; first: string; second: string }
  | { type: "wrap"; targets: readonly string[]; style: ContainerStyle }
  | { type: "setStyle"; container: string; style: ContainerStyle }
  | { type: "setChecked"; owner: string; checked: boolean }
  | { type: "indent" | "outdent" | "setParagraph" | "convertSeparator" | "deleteSeparator"; owner: string }
  | { type: "move"; target: MoveTarget; parent: MoveTarget; before?: MoveTarget | null }
  | { type: "setAlignment"; owner: string; alignment: "left" }
  | { type: "setCode"; owner: string; language: string }
  | { type: "hardBreak"; at: AnchorToken }
  | { type: "insertSeparator"; beside: string; side: "before" | "after" }
  | { type: "insertParagraph"; separator: string; side: "before" | "after"; text: string };
/** Synchronous UTF-16 coordinates in the batch state after preceding commands. */
export interface EditorPosition { owner: string; offset: number; bias: Bias }
export type TextCommand = Extract<EditorCommand, { type: "insert" | "delete" | "replace" }>;
export type FormatAction = "apply" | "remove" | "toggle";
export interface MarkCommand {
  range: StableRange;
  mark: "bold" | "italic" | "strike" | "underline" | "code" | "link";
  action: FormatAction;
  href?: string | null;
}
export interface BlockFormatCommand {
  targets: readonly string[];
  attributes: { type: "paragraph" } | { type: "heading"; level: number };
  action: FormatAction;
}
export type PrepareRequest =
  | { kind: "fragment"; origin: string; range: StableRange; blocks: readonly FragmentBlock[] }
  | { kind: "text"; origin: string; command: TextCommand }
  | { kind: "editor"; origin: string; commands: readonly EditorCommand[] }
  | { kind: "format"; origin: string; marks: readonly MarkCommand[]; blocks: readonly BlockFormatCommand[] };
export interface FragmentRun { text: string; marks: readonly { mark: MarkCommand["mark"]; href?: string | null }[] }
export interface FragmentBlock {
  runs: readonly FragmentRun[];
  attributes: null | { type: "paragraph" } | { type: "heading"; level: number } | { type: "code"; language: string } | { type: "separator" } | { type: "content"; tuple: Json };
  containers?: readonly { key: string; style: ContainerStyle }[];
  checked?: boolean | null;
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ProjectedNode {
  id: string; kind: string; parent: string; order: number;
  spans: { source: string; identity: string; start: number; end: number }[];
  runs: { text: string; attributes: Record<string, Json> }[];
  blockAttributes: Json;
  editor: null | { version: string; containerAttributes: Json; checked: boolean | null; number: number | null };
}
export interface Snapshot {
  revision: number;
  identity: { profile: string; schema: string; documentId: string; epoch: string; protocolVersion: number; updateEncoding: number; offsets: "utf16" };
  visible: ProjectedNode[]; recovery: ProjectedNode[]; retainedStructure: Json;
  changedNodes: string[];
  touchedRanges: { source: string; start: number; newStart: number; oldEnd: number; newEnd: number }[];
}
export type AnchorResolution =
  | { type: "position"; node: string; offset: number; source: string; sourceOffset: number; bias: Bias }
  | { type: "deleted"; source: string; owner: string }
  | { type: "unresolvable"; reason: string };
export type HistoryRequest =
  | { type: "state" | "undo" | "redo" | "clear" | "boundary" | "explicit" }
  | { type: "typing"; session: number; time_ms: number }
  | { type: "composition"; session: number };
export interface HistoryState { selection?: StableRange; revision: number; undoGroups: number; redoGroups: number; retainedUpdateBytes: number }
export type DocumentIdentity = Snapshot["identity"];
/** Persist the envelope atomically with these owned v1 bytes. Writer is provenance. */
export interface Checkpoint { identity: DocumentIdentity; initialized: true; writerId: number; bytes: Uint8Array }
export interface ReplayUpdate { identity: DocumentIdentity; bytes: Uint8Array }
export type PatchScope = { type: "all" | "updates" | "selection" } | { type: "nodes" | "sources"; ids: readonly string[] };
export interface Patch {
  version: number; sequence: number; revision: number; identity: DocumentIdentity; writerId: number;
  operation: "Text" | "Format" | "Structure" | "Editor" | "Remote" | "Undo" | "Redo" | "Selection";
  origin: string; changedNodes: string[]; changedSources: string[];
  nodes: ({ type: "visible" | "recovery"; node: ProjectedNode } | { type: "removed"; id: string })[];
  touchedRanges: Snapshot["touchedRanges"]; selectionChanged: boolean;
  selection: null | { anchor: AnchorResolution; focus: AnchorResolution } | { error: string };
  update: ReplayUpdate | null; projectionError: string | null;
}
/** Callback capture is released on disposal; active becomes false on engine disposal too. */
export interface PatchSubscription { readonly active: boolean; dispose(): void }
export interface ObserverError { subscriptionId: number; message: string }
export interface CommitResult { readonly revision: number; readonly caret?: AnchorToken; readonly selection?: StableRange }
/** Trusted pure hooks, called in declaration order after portable parsing. */
export interface MarkdownExtension {
  readonly name: string;
  prepare?(content: Readonly<PreparedMarkdown>): readonly FragmentBlock[] | undefined;
  serialize?(blocks: readonly FragmentBlock[]): string | undefined;
}
export interface MarkdownOptions { images?: boolean; tables?: boolean; callouts?: boolean; extensions?: readonly MarkdownExtension[] }
export interface MarkdownDiagnostic { code: string; range: readonly [number, number] }
export interface PreparedMarkdown { source: string; blocks: readonly FragmentBlock[]; ranges: readonly (readonly [number, number])[]; diagnostics: readonly MarkdownDiagnostic[] }
export interface MarkdownExport { markdown: string; diagnostics: readonly MarkdownDiagnostic[]; recovery: readonly FragmentBlock[] }
export interface MarkdownCodec {
  importMarkdown(source: string, options?: MarkdownOptions): PreparedMarkdown;
  exportMarkdown(blocks: readonly FragmentBlock[], options?: MarkdownOptions): MarkdownExport;
}
/** Inert HTML tokenizer data; shared Rust owns semantic admission. */
export type HTMLNode = { kind: "text"; text: string } | { kind: "inert" } | {
  kind: "element"; tag: string; attributes: readonly { name: string; value: string; namespaced: boolean }[]; children: readonly HTMLNode[];
};
export interface EngineHandle {
  readonly markdownAvailable: boolean;
  /** Explicit per-document opt-in; disposal removes only this registration. */
  registerMarkdown(codec: MarkdownCodec): PatchSubscription;
  importMarkdown(source: string, codecs?: MarkdownOptions): PreparedMarkdown;
  exportMarkdown(blocks: readonly FragmentBlock[], options?: MarkdownOptions): MarkdownExport;
  read(): Snapshot;
  /** Pure bounded clipboard shape check; semantic/target admission is separate. */
  validateFragment(raw: string): void;
  importHTML(tree: readonly HTMLNode[]): { blocks: readonly FragmentBlock[]; diagnostics: readonly string[] };
  anchor(node: string, offset: number, bias: Bias): AnchorToken;
  exportAnchor(anchor: AnchorToken): PortableAnchor;
  importAnchor(anchor: PortableAnchor): AnchorToken;
  resolve(anchor: AnchorToken): AnchorResolution;
  releaseAnchor(anchor: AnchorToken): void;
  prepare(request: PrepareRequest): PlanToken;
  can(request: PrepareRequest): boolean;
  commit(plan: PlanToken): CommitResult;
  releasePlan(plan: PlanToken): void;
  history(request: HistoryRequest): HistoryState;
  checkpoint(): Checkpoint;
  stateVector(): Uint8Array;
  /** Default vector encodes the entire state. A vector alone is not a content revision. */
  encodeUpdate(stateVector?: Uint8Array): ReplayUpdate;
  applyUpdate(update: ReplayUpdate): { revision: number };
  /** Runs after the WASM borrow/transaction returns. Nested batches dispatch FIFO. */
  subscribe(scope: PatchScope, callback: (patch: Patch) => void): PatchSubscription;
  takeObserverErrors(): ObserverError[];
  /** Drops replica and all anchors/plans/history. Safe to call repeatedly. */
  dispose(): void;
}
/** Current bridge errors. Preserve unknown future codes when handling a newer engine. */
export type EngineErrorCode = "InvalidInput" | "InvalidHandle" | "EngineRejected" | "ResourceLimit" | "Disposed" | (string & {});
export class EngineError extends Error {
  constructor(public readonly code: EngineErrorCode, public readonly operation: string, message: string) {
    super(message); this.name = "EngineError";
  }
}
/** Internal compiled boundary; application clients use EngineHandle. */
export interface RawEngine {
  validate_fragment(input: string): string;
  import_html(input: string): string;
  read(): string; anchor(input: string): string; resolve(token: string): string;
  export_anchor(token: string): string; import_anchor(input: string): string;
  prepare(input: string): string; can(input: string): string; commit(token: string): string; history(input: string): string;
  release_anchor(token: string): void; release_plan(token: string): void;
  checkpoint_metadata(): string; checkpoint_bytes(): Uint8Array; state_vector(): Uint8Array;
  encode_update(vector: Uint8Array): Uint8Array; apply_update(input: string, bytes: Uint8Array): string;
  take_patch(): string;
  dispose(): void; free(): void;
}
function invoke<T>(operation: string, action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof EngineError) throw error;
    if (typeof error === "string") {
      try {
        const e: { code?: unknown; operation?: unknown; message?: unknown } | null = JSON.parse(error);
        if (e && typeof e === "object" && typeof e.code === "string" && typeof e.operation === "string" && typeof e.message === "string") {
          throw new EngineError(e.code, e.operation, e.message);
        }
      } catch (parsed) { if (parsed instanceof EngineError) throw parsed; }
    }
    throw new EngineError("InvalidInput", operation, error instanceof Error ? error.message : String(error));
  }
}
/** Avoid JSON.stringify's coercion of NaN, bigint, undefined, custom toJSON and sparse arrays. */
function encode(value: unknown, operation: string, ownedByteArrays?: WeakSet<object>): string {
  let count = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++count > 100_000 || depth > 32) throw new EngineError("ResourceLimit", operation, "request exceeds structure limit");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isSafeInteger(v)) return;
    if (typeof v !== "object" || seen.has(v)) throw new EngineError("InvalidInput", operation, "request must contain plain JSON values");
    const proto = Object.getPrototypeOf(v);
    if ((Array.isArray(v) && proto !== Array.prototype) || (!Array.isArray(v) && proto !== Object.prototype && proto !== null)) throw new EngineError("InvalidInput", operation, "request must contain plain objects");
    // Replay bytes are copied and bounded before conversion. Their numeric
    // elements are payload, not caller-supplied JSON metadata structure.
    if (Array.isArray(v) && ownedByteArrays?.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 100_000 || Object.keys(v).length !== v.length) throw new EngineError("InvalidInput", operation, "sparse or decorated array");
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d)) throw new EngineError("InvalidInput", operation, "accessor input");
        visit(d.value, depth + 1);
      }
    } else {
      for (const key of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (typeof key !== "string" || !("value" in d) || !d.enumerable) throw new EngineError("InvalidInput", operation, "accessor or hidden input");
        visit(d.value, depth + 1);
      }
    }
    seen.delete(v);
  };
  visit(value, 0);
  return JSON.stringify(value);
}
function utf8Length(text: string): number { return new TextEncoder().encode(text).length; }
function token(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.length > 128) throw new EngineError("InvalidInput", operation, "invalid opaque token");
  return value;
}
const MAX_BYTES = 16 * 1024 * 1024;
function bytes(value: unknown, operation: string): Uint8Array {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new EngineError("InvalidInput", operation, "expected Uint8Array");
  const size = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!.call(value) as number;
  if (size > MAX_BYTES) throw new EngineError("ResourceLimit", operation, "byte limit exceeded");
  const owned = new Uint8Array(size);
  Uint8Array.prototype.set.call(owned, value);
  return owned;
}
function envelope(value: unknown, keys: string[], operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new EngineError("InvalidInput", operation, "expected plain envelope");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !descriptors[k] || !("value" in descriptors[k]!) || !descriptors[k]!.enumerable)) throw new EngineError("InvalidInput", operation, "invalid envelope fields");
  return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]));
}
export function createHandle(construct: (json: string) => RawEngine, options: CreateOptions): EngineHandle {
  return ownHandle(invoke("create", () => construct(encode(options, "create"))));
}
export function restoreHandle(construct: (json: string, bytes: Uint8Array) => RawEngine, expected: DocumentIdentity, checkpoint: Checkpoint, journal: readonly ReplayUpdate[] = []): EngineHandle {
  return invoke("restore", () => {
    const c = envelope(checkpoint, ["identity", "initialized", "writerId", "bytes"], "restore");
    const checkpointBytes = bytes(c.bytes, "restore");
    if (!Array.isArray(journal) || Object.getPrototypeOf(journal) !== Array.prototype || Reflect.ownKeys(journal).length !== journal.length + 1 || journal.length > 4096) throw new EngineError("ResourceLimit", "restore", "invalid journal bounds");
    // Inspect descriptors before reading any journal element.
    const descriptors = Object.getOwnPropertyDescriptors(journal);
    const ownedByteArrays = new WeakSet<object>();
    let journalBytes = 0;
    const entries = Array.from({length:journal.length}, (_, i) => {
      const d = descriptors[String(i)];
      if (!d || !("value" in d)) throw new EngineError("InvalidInput", "restore", "invalid journal entry");
      const u = envelope(d.value, ["identity", "bytes"], "restore");
      const copied = bytes(u.bytes, "restore");
      journalBytes += copied.byteLength;
      // The existing Rust request boundary is 2 MiB. Raw payload alone above
      // it cannot fit its JSON envelope; reject before expanding byte arrays.
      if (journalBytes > 2 * 1024 * 1024) throw new EngineError("ResourceLimit", "restore", "journal exceeds request byte limit");
      const payload = Array.from(copied);
      ownedByteArrays.add(payload);
      return {identity:u.identity, bytes:payload};
    });
    return ownHandle(construct(encode({expected, identity:c.identity, initialized:c.initialized, writerId:c.writerId, journal:entries}, "restore", ownedByteArrays), checkpointBytes));
  });
}
function ownHandle(allocation: RawEngine): EngineHandle {
  let raw: RawEngine | undefined = allocation;
  let markdown: MarkdownCodec | undefined;
  type RawPatch = Omit<Patch, "update"> & { update: null | {identity:DocumentIdentity; bytes:number[]} };
  type Listener = { scope: PatchScope; callback: (patch: Patch) => void };
  let nextId = 0, dispatching = false;
  const listeners = new Map<number, Listener>();
  const queue: { patch: RawPatch; listeners: [number, Listener][] }[] = [];
  const failures: ObserverError[] = [];
  const use = <T>(operation: string, action: (engine: RawEngine) => T): T => invoke(operation, () => {
    if (!raw) throw new EngineError("Disposed", operation, "engine has been disposed");
    return action(raw);
  });
  // Share JSON marshalling only; each public operation keeps its own diagnostic
  // name and validates inside the live-handle guard before entering WASM.
  const query = <T>(operation: string,
    method: "anchor" | "export_anchor" | "resolve", value: unknown, opaque = false): T =>
    use(operation, e => {
      const result = JSON.parse(e[method](opaque ? token(value, operation) : encode(value, operation)));
      return (method === "anchor" ? result.token : result) as T;
    });
  const matches = (scope: PatchScope, p: RawPatch): boolean => {
    switch (scope.type) {
      case "all": return true;
      case "updates": return p.update !== null;
      case "selection": return p.selectionChanged;
      case "nodes": return scope.ids.some(id => p.changedNodes.includes(id));
      case "sources": return scope.ids.some(id => p.changedSources.includes(id));
    }
  };
  const dispatch = (): void => {
    if (dispatching) return;
    dispatching = true;
    try {
      while (raw && queue.length) {
        const frame = queue.shift()!;
        for (const [id, listener] of frame.listeners) {
          if (!raw || listeners.get(id) !== listener || !matches(listener.scope, frame.patch)) continue;
          try {
            // Each observer owns its detached projection/envelope and byte buffer.
            const clone = JSON.parse(JSON.stringify(frame.patch)) as RawPatch;
            listener.callback({...clone, update:clone.update ? {identity:clone.update.identity, bytes:Uint8Array.from(clone.update.bytes)} : null});
          } catch (error) {
            if (failures.length === 64) failures.shift();
            // String conversion of a hostile thrown value must not escape dispatch.
            let message = "observer threw";
            try { message = error instanceof Error ? error.message : String(error); } catch {}
            failures.push({subscriptionId:id, message});
          }
        }
      }
    } finally { dispatching = false; }
  };
  const mutate = <T>(operation: string, action: (engine: RawEngine) => T): T => {
    const result = use(operation, action);
    const patch = use("patch", e => JSON.parse(e.take_patch()) as RawPatch | null);
    if (patch && listeners.size) queue.push({patch, listeners:[...listeners.entries()]});
    dispatch();
    return result;
  };
  const prepare = (request: PrepareRequest): PlanToken => {
    const input=encode(request,'prepare');
    return use('prepare',e=>JSON.parse(e.prepare(input)).token as PlanToken);
  };
  const releasePlan = (plan: PlanToken): void => use("releasePlan", e => e.release_plan(token(plan, "releasePlan")));
  const codec = (operation: string): MarkdownCodec => {
    if (!markdown) throw new EngineError("CapabilityUnavailable", operation, "markdown-codec-unavailable");
    return markdown;
  };
  const importMarkdown = (source: string, options: MarkdownOptions = {}): PreparedMarkdown => use("importMarkdown", () => codec("importMarkdown").importMarkdown(source, options));
  const exportMarkdown = (blocks: readonly FragmentBlock[], options: MarkdownOptions = {}): MarkdownExport => use("exportMarkdown", () => codec("exportMarkdown").exportMarkdown(blocks, options));
  return Object.freeze({
    read: () => use("read", e => JSON.parse(e.read()) as Snapshot),
    validateFragment: (input: string) => use("validateFragment", e => {
      if (typeof input !== "string") throw new EngineError("InvalidInput", "validateFragment", "expected fragment JSON");
      if (utf8Length(input) > 1048576) throw new EngineError("ResourceLimit", "validateFragment", "fragment-limit");
      e.validate_fragment(input);
    }),
    importHTML: (tree: readonly HTMLNode[]) => use("importHTML", e => {
      const input = JSON.stringify(tree);
      if (utf8Length(input) > 8 * 1048576) throw new EngineError("ResourceLimit", "importHTML", "html-limit");
      return JSON.parse(e.import_html(input)) as { blocks: readonly FragmentBlock[]; diagnostics: readonly string[] };
    }),
    importMarkdown, exportMarkdown,
    get markdownAvailable() { return !!raw && !!markdown; },
    registerMarkdown: (candidate: MarkdownCodec): PatchSubscription => use("registerMarkdown", () => {
      if (!candidate || typeof candidate.importMarkdown !== "function" || typeof candidate.exportMarkdown !== "function") throw new EngineError("InvalidInput", "registerMarkdown", "invalid Markdown codec");
      if (markdown) throw new EngineError("InvalidInput", "registerMarkdown", "Markdown already registered");
      markdown = candidate;
      let active = true;
      return Object.freeze({ get active() { return active && !!raw && markdown === candidate; }, dispose() { if (active && markdown === candidate) markdown = undefined; active = false; } });
    }),
    anchor: (node: string, offset: number, bias: Bias) => query<AnchorToken>("anchor", "anchor", { node, offset, bias }),
    exportAnchor: (anchor: AnchorToken) => query<PortableAnchor>("exportAnchor", "export_anchor", anchor, true),
    importAnchor: (anchor: PortableAnchor) => use("importAnchor", e => {
      const input = encode(anchor, "importAnchor");
      if (utf8Length(input) > 4096) throw new EngineError("ResourceLimit", "importAnchor", "presence anchor limit");
      return JSON.parse(e.import_anchor(input)).token as AnchorToken;
    }),
    resolve: (anchor: AnchorToken) => query<AnchorResolution>("resolve", "resolve", anchor, true),
    releaseAnchor: (anchor: AnchorToken) => use("releaseAnchor", e => e.release_anchor(token(anchor, "releaseAnchor"))),
    prepare,
    can: (request: PrepareRequest) => {
      try {
        const input=encode(request,'can');
        return use('can',e=>JSON.parse(e.can(input)) as boolean);
      }
      catch (e) { if (e instanceof EngineError && ["EngineRejected", "InvalidInput", "InvalidHandle", "ResourceLimit"].includes(e.code)) return false; throw e; }
    },
    commit: (plan: PlanToken) => mutate("commit", e => JSON.parse(e.commit(token(plan, "commit"))) as CommitResult),
    releasePlan,
    history: (request: HistoryRequest) => mutate("history", e => JSON.parse(e.history(encode(request, "history"))) as HistoryState),
    checkpoint: () => use("checkpoint", e => ({...JSON.parse(e.checkpoint_metadata()), bytes:bytes(e.checkpoint_bytes(), "checkpoint")} as Checkpoint)),
    stateVector: () => use("stateVector", e => bytes(e.state_vector(), "stateVector")),
    encodeUpdate: (vector: Uint8Array = Uint8Array.of(0)) => use("encodeUpdate", e => ({identity:JSON.parse(e.checkpoint_metadata()).identity as DocumentIdentity, bytes:bytes(e.encode_update(bytes(vector, "encodeUpdate")), "encodeUpdate")})),
    applyUpdate: (update: ReplayUpdate) => mutate("applyUpdate", e => {
      const u = envelope(update, ["identity", "bytes"], "applyUpdate");
      return JSON.parse(e.apply_update(encode(u.identity, "applyUpdate"), bytes(u.bytes, "applyUpdate"))) as { revision:number };
    }),
    subscribe: (scope: PatchScope, callback: (patch: Patch) => void): PatchSubscription => use("subscribe", () => {
      const detached = JSON.parse(encode(scope, "subscribe")) as PatchScope;
      const fields = Object.keys(detached);
      if (!detached || !["all", "updates", "selection", "nodes", "sources"].includes(detached.type) || typeof callback !== "function") throw new EngineError("InvalidInput", "subscribe", "invalid listener");
      if (detached.type === "nodes" || detached.type === "sources") {
        if (fields.length !== 2 || !Array.isArray(detached.ids) || detached.ids.length > 4096 || detached.ids.some(id => typeof id !== "string")) throw new EngineError("InvalidInput", "subscribe", "invalid scope");
      } else if (fields.length !== 1) throw new EngineError("InvalidInput", "subscribe", "invalid scope fields");
      if (listeners.size >= 1024 || nextId === Number.MAX_SAFE_INTEGER) throw new EngineError("ResourceLimit", "subscribe", "subscription limit");
      const id = ++nextId;
      listeners.set(id, {scope:detached, callback});
      return Object.freeze({get active() {return !!raw && listeners.has(id);}, dispose() {listeners.delete(id);} });
    }),
    takeObserverErrors: () => use("takeObserverErrors", () => failures.splice(0)),
    dispose: () => { if (raw) { const owned = raw; raw = undefined; markdown = undefined; listeners.clear(); queue.length = 0; failures.length = 0; try { owned.dispose(); } finally { owned.free(); } } },
  });
}
