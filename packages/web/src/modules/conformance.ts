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
