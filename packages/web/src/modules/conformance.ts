import { ModuleContractError, ModuleRegistry, type ModuleDefinition } from '@edit-ac/core/extensions';
import type { Json, ProjectedNode } from '@edit-ac/core';

/** Fixed, inert inputs. A conformance fixture never invokes a presenter or codec. */
export interface DescriptorFixture {
  id: string;
  category: 'descriptor' | 'run' | 'block';
  definition?: ModuleDefinition;
  run?: { text: string; attributes: Record<string, Json> };
  blockAttributes?: Json;
  text?: string;
  disabled?: boolean;
  presenter?: boolean;
}
export interface DescriptorResult { id: string; outcome: string; payload?: Json; fallback?: string }

/** Canonical semantic JSON, independent of map insertion order and CRDT bytes.
 * Reject accessors, callbacks, prototypes and cycles without evaluating them. */
export function canonicalSemanticJson(value: unknown): string {
  const ancestors = new Set<object>();
  function copy(v: unknown): Json {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object' || ancestors.has(v)) throw new TypeError('Non-data semantic projection');
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) throw new TypeError('Non-data semantic projection');
    ancestors.add(v);
    const out: Json[] | Record<string, Json> = Array.isArray(v) ? [] : Object.create(null) as Record<string, Json>;
    const ownKeys = Reflect.ownKeys(v);
    if (Array.isArray(v) && ownKeys.some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))) throw new TypeError('Non-data semantic projection');
    const names = Array.isArray(v) ? Array.from({ length: v.length }, (_, i) => String(i)) : Reflect.ownKeys(v).sort((a,b)=>String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    if (Array.isArray(v) && Object.keys(v).length !== v.length) throw new TypeError('Non-data semantic projection');
    for (const key of names) {
      if (typeof key !== 'string') throw new TypeError('Non-data semantic projection');
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !d.enumerable || !('value' in d)) throw new TypeError('Non-data semantic projection');
      if (Array.isArray(out)) out.push(copy(d.value)); else out[key] = copy(d.value);
    }
    ancestors.delete(v); return out;
  }
  return JSON.stringify(copy(value));
}

/** Reuse the public registry; errors are observations, never successful admission. */
export function runDescriptorFixture(definitions: readonly ModuleDefinition[], fixture: DescriptorFixture): DescriptorResult {
  const result: DescriptorResult = { id: fixture.id, outcome: 'registered' };
  const registry = new ModuleRegistry();
  try {
    if (fixture.category === 'descriptor') {
      registry.register(fixture.definition!);
    } else if (fixture.category === 'run') {
      const run = fixture.run!;
      result.payload = run.attributes; result.fallback = run.text;
      if (!fixture.disabled) for (const d of definitions) registry.register(d, fixture.presenter === false ? undefined : { tag: 'mark' });
      registry.freeze();
      result.outcome = 'opaque';
      for (const [key, value] of Object.entries(run.attributes)) {
        if (registry.resolve(key, value, run.text)) result.outcome = 'known';
      }
    } else {
      // Built-in block tuples retain their owning codecs/commands. This fixture
      // proves lossless disabled-presenter preservation, not renderer parity.
      result.outcome = 'preserved'; result.payload = fixture.blockAttributes!; result.fallback = fixture.text!;
    }
  } catch (error) {
    if (!(error instanceof ModuleContractError)) throw error;
    result.outcome = error.code;
  }
  return result;
}

/** Project a real engine snapshot after validating registered attributed data. */
export function projectExtensionNodes(registry: ModuleRegistry, nodes: readonly ProjectedNode[]): Json {
  registry.validate(nodes);
  return JSON.parse(canonicalSemanticJson(nodes.map(n => ({ id: n.id, blockAttributes: n.blockAttributes, runs: n.runs })))) as Json;
}

/** Exercise the owning codec or literal input boundary without a live document.
 * Literal input never calls host codecs and retains exact source/ranges. */
export function prepareExtensionSource(
  codec: import('@edit-ac/core').MarkdownCodec, source: string,
  options: import('@edit-ac/core').MarkdownOptions = {}, literal = false,
): import('@edit-ac/core').PreparedMarkdown {
  if (typeof source !== 'string') throw new TypeError('Expected source text');
  const length = new TextEncoder().encode(source).length;
  if (length > 1_048_576) throw new RangeError('Extension source resource limit');
  if (!literal) return codec.importMarkdown(source, options);
  return { source, blocks: [{attributes:{type:'paragraph'},runs:[{text:source,marks:[]}],containers:[],checked:null}], ranges:[[0,length]],diagnostics:[] };
}

/** The host's existing shared command boundary (for example BrowserEditor).
 * revision must identify the current document/epoch and observed content, including
 * deletes. can/commit recheck current permissions; plans confer no authority.
 * The host owns atomic commit, journaling and one-intent history grouping. */
export interface ExtensionCommandHost {
  readonly active: boolean;
  revision(): string;
  can(request: import('@edit-ac/core').PrepareRequest): boolean;
  commit(request: import('@edit-ac/core').PrepareRequest): import('@edit-ac/core').CommitResult;
}
export type ExtensionCommandResult =
  | { status: 'committed'; result: import('@edit-ac/core').CommitResult }
  | { status: 'cancelled' | 'stale' | 'unavailable' | 'failed' };

/** One pending trusted-host preparation; no document mutation or observer bus.
 * Superseding, cancellation and disposal abort the signal and reject late results.
 * Use from host actions/ModuleRuntime callbacks, after engine transactions return.
 * This isolates exceptions, not unbounded or hostile in-process execution. */
export class ExtensionCommandSession {
  #pending: AbortController | undefined;
  #disposed = false;
  constructor(private readonly host: ExtensionCommandHost) {}
  get active(): boolean { return !this.#disposed && this.host.active; }
  cancel(): void { this.#pending?.abort(); this.#pending = undefined; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.cancel(); }
  async run(prepare: (signal: AbortSignal) => import('@edit-ac/core').PrepareRequest | undefined |
    Promise<import('@edit-ac/core').PrepareRequest | undefined>): Promise<ExtensionCommandResult> {
    this.cancel();
    if (!this.active) return { status: 'cancelled' };
    const controller = new AbortController(); this.#pending = controller;
    try {
      const revision = this.host.revision();
      const request = await prepare(controller.signal);
      if (controller.signal.aborted || !this.active || this.#pending !== controller) return { status: 'cancelled' };
      if (this.host.revision() !== revision) return { status: 'stale' };
      if (!request || !this.host.can(request)) return { status: 'unavailable' };
      // Capability callbacks may re-enter the host. Recheck after applicability.
      if (controller.signal.aborted || !this.active || this.#pending !== controller) return { status: 'cancelled' };
      if (this.host.revision() !== revision) return { status: 'stale' };
      return { status: 'committed', result: this.host.commit(request) };
    } catch {
      return { status: controller.signal.aborted || !this.active ? 'cancelled' : 'failed' };
    } finally { if (this.#pending === controller) this.#pending = undefined; }
  }
}
