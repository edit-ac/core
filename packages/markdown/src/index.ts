import { EngineError, type FragmentBlock, type PreparedMarkdown, type MarkdownExport, type MarkdownOptions, type MarkdownExtension } from '@edit-ac/core';
export type { MarkdownOptions, PreparedMarkdown, MarkdownExport, MarkdownDiagnostic, MarkdownExtension } from '@edit-ac/core';

export type { MarkdownCodec } from '@edit-ac/core';
import type { MarkdownCodec } from '@edit-ac/core';
interface Bindings {
  default(options: { module_or_path: string }): Promise<unknown>;
  import_markdown(input: string): string;
  export_markdown(input: string): string;
  markdown_equivalent(input: string): string;
  table_source(input: string, baseline: Uint8Array, current: Uint8Array): string;
}
function use<T>(operation: string, action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof EngineError) throw error;
    if (typeof error === "string") {
      try {
        const e: unknown = JSON.parse(error);
        if (e && typeof e === "object" && "code" in e && "operation" in e && "message" in e && typeof e.code === "string" && typeof e.operation === "string" && typeof e.message === "string") {
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
function utf8Length(text: string): number {
  let size = 0; for (const char of text) { const code = char.codePointAt(0)!; size += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; } return size;
}
function createCodec(bindings: Bindings): MarkdownCodec {
  const extensions = (options: MarkdownOptions): readonly MarkdownExtension[] => {
    const list = options.extensions ?? [], names = new Set<string>();
    if (list.length > 32) throw new EngineError("ResourceLimit", "markdown", "too many extensions");
    for (const e of list) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(e.name) || names.has(e.name)) throw new EngineError("InvalidInput", "markdown", "invalid or duplicate extension name"); names.add(e.name); }
    return list;
  };
  const importMarkdown = (source: string, options: MarkdownOptions = {}): PreparedMarkdown => use("importMarkdown", () => {
    const hooks = extensions(options);
    let p = JSON.parse(bindings.import_markdown(encode({ source, images: options.images ?? false, tables: options.tables ?? false, callouts: options.callouts ?? false }, "importMarkdown"))) as PreparedMarkdown;
    for (const extension of hooks) {
      const blocks = extension.prepare?.(JSON.parse(JSON.stringify(p)) as PreparedMarkdown); if (blocks === undefined) continue;
      const serialized = encode(blocks, "importMarkdown");
      // Native bounded transfer admission, without any live transaction.
      bindings.export_markdown(serialized);
      const owned = JSON.parse(serialized) as FragmentBlock[];
      p = { ...p, blocks: owned, ranges: owned.map(() => [0, utf8Length(source)] as const) };
    }
    return p;
  });
  const exportMarkdown = (blocks: readonly FragmentBlock[], options: MarkdownOptions = {}): MarkdownExport => use("exportMarkdown", () => {
    const encoded = encode(blocks, "exportMarkdown"), fallback = JSON.parse(bindings.export_markdown(encoded)) as MarkdownExport;
    for (const extension of extensions(options)) {
      const markdown = extension.serialize?.(JSON.parse(encoded)); if (markdown === undefined) continue;
      if (typeof markdown !== "string" || utf8Length(markdown) > 1048576) throw new EngineError("ResourceLimit", "exportMarkdown", "extension output exceeds limit");
      const parsed = importMarkdown(markdown, options);
      const lossless = JSON.parse(bindings.markdown_equivalent(encode([JSON.parse(encoded), parsed.blocks], "markdownEquivalent"))) as boolean;
      return { markdown, diagnostics: lossless ? [] : [{code:"extension-unrepresentable",range:[0,0]}], recovery: lossless ? [] : JSON.parse(encoded) };
    }
    return fallback;
  });
  const tableSource: NonNullable<MarkdownCodec["tableSource"]> = request => use("tableSource", () => {
    const {baseline,current,options,...metadata} = request;
    const snapshot = (checkpoint: typeof baseline) => ({identity:checkpoint.identity,initialized:checkpoint.initialized,writerId:checkpoint.writerId});
    const input = encode({...metadata,baseline:snapshot(baseline),current:snapshot(current),images:options.images ?? false,tables:options.tables ?? false,callouts:options.callouts ?? false},"tableSource");
    return JSON.parse(bindings.table_source(input,baseline.bytes,current.bytes));
  });
  return Object.freeze({ importMarkdown, exportMarkdown, tableSource });
}
let loading: {assetUrl:string; promise:Promise<MarkdownCodec>} | undefined;
/** Explicit async opt-in. Importing the package never fetches or instantiates WASM. */
export function initMarkdown(assetUrl: string): Promise<MarkdownCodec> {
  if (typeof assetUrl !== 'string' || !assetUrl.trim()) return Promise.reject(new TypeError('A nonempty Markdown WASM asset URL is required'));
  if (loading) return loading.assetUrl === assetUrl ? loading.promise : Promise.reject(new Error('Markdown already initialized with another asset URL'));
  const promise = (async () => {
    const bindings = await import('./wasm/editac_markdown_wasm.js' as string) as Bindings;
    await bindings.default({module_or_path:assetUrl});
    return createCodec(bindings);
  })();
  loading = {assetUrl, promise};
  void promise.catch(() => {if (loading?.promise === promise) loading = undefined;});
  return promise;
}
