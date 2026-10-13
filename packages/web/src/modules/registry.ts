import type { Json, ProjectedNode } from '@edit-ac/core';

/** Portable data, separate from host rendering. Inline atoms retain label text in
 * the existing rich-text profile; no embeds or executable values enter documents. */
export interface ModuleDefinition {
  type: string;
  version: number;
  kind: 'mark' | 'inline-atom';
  attributes: Record<string, { type: 'string' | 'boolean' | 'number'; required: boolean; maxUtf16?: number }>;
  content: { type: 'text'; maxUtf16: number };
  fallback: { type: 'text'; source: 'content' };
}
export interface ModulePresentation { tag: 'span' | 'mark' | 'code' }
export class ModuleContractError extends Error {
  constructor(readonly code: 'invalid-definition' | 'duplicate' | 'incompatible' | 'frozen' | 'invalid-content' | 'resource-limit') {
    super(`Module contract: ${code}`); this.name = 'ModuleContractError';
  }
}
const fail = (code: ModuleContractError['code']): never => { throw new ModuleContractError(code); };
const name = (s: unknown): s is string => typeof s === 'string' && s.length <= 128 && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(s);
const field = (s: string) => s.length <= 64 && /^[a-z][a-zA-Z0-9]*$/.test(s) && !['constructor', 'prototype', '__proto__'].includes(s);
const bound = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 8192;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === [...expected].sort().join(',');
/** Reject getters, cycles, prototypes and callbacks without invoking them. */
function data(value: unknown): Json {
  let budget = 65536;
  const ancestors = new Set<object>();
  function copy(v: unknown, depth: number): Json {
    if (--budget < 0 || depth > 16) return fail('resource-limit');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { budget -= v.length; if (budget < 0) return fail('resource-limit'); return v; }
    if (!v || typeof v !== 'object' || ancestors.has(v)) return fail('invalid-definition');
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) return fail('invalid-definition');
    ancestors.add(v);
    let result: Json;
    if (Array.isArray(v)) {
      if (v.length > 8192) return fail('resource-limit');
      result = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d)) return fail('invalid-definition');
        result.push(copy(d.value, depth + 1));
      }
      if (Object.keys(v).length !== v.length) return fail('invalid-definition');
    } else {
      result = Object.create(null) as Record<string, Json>;
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== 'string') return fail('invalid-definition');
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (!d.enumerable || !('value' in d)) return fail('invalid-definition');
        budget -= k.length; result[k] = copy(d.value, depth + 1);
      }
    }
    ancestors.delete(v); return result;
  }
  return copy(value, 0);
}
function definition(value: unknown): ModuleDefinition {
  const v = data(value);
  if (!record(v) || !keys(v, ['type', 'version', 'kind', 'attributes', 'content', 'fallback']) || !name(v.type) ||
      !Number.isSafeInteger(v.version) || Number(v.version) < 1 || Number(v.version) > 0xffffffff ||
      !['mark', 'inline-atom'].includes(String(v.kind)) || !record(v.attributes) || Object.keys(v.attributes).length > 32 ||
      !record(v.content) || !keys(v.content, ['type', 'maxUtf16']) || v.content.type !== 'text' || !bound(v.content.maxUtf16) ||
      !record(v.fallback) || !keys(v.fallback, ['type', 'source']) || v.fallback.type !== 'text' || v.fallback.source !== 'content') return fail('invalid-definition');
  for (const [k, a] of Object.entries(v.attributes)) {
    if (!field(k) || !record(a) || !keys(a, a.type === 'string' ? ['type', 'required', 'maxUtf16'] : ['type', 'required']) ||
        !['string', 'boolean', 'number'].includes(String(a.type)) || typeof a.required !== 'boolean' ||
        (a.type === 'string' && !bound(a.maxUtf16))) return fail('invalid-definition');
  }
  return v as unknown as ModuleDefinition;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  if (record(value)) return JSON.stringify(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return JSON.stringify(value);
}
export class ModuleRegistry {
  #definitions = new Map<string, ModuleDefinition>();
  #presentations = new Map<string, Readonly<ModulePresentation>>();
  #frozen = false;
  register(value: ModuleDefinition, presentation?: ModulePresentation): this {
    if (this.#frozen) return fail('frozen');
    const d = definition(value), previous = this.#definitions.get(d.type);
    if (previous) return fail(canonical(previous) === canonical(d) ? 'duplicate' : 'incompatible');
    if (this.#definitions.size >= 256) return fail('resource-limit');
    let p: ModulePresentation | undefined;
    if (presentation !== undefined) {
      const raw = data(presentation);
      if (!record(raw) || !keys(raw, ['tag']) || !['span', 'mark', 'code'].includes(String(raw.tag))) return fail('invalid-definition');
      p = raw as unknown as ModulePresentation;
    }
    this.#definitions.set(d.type, freeze(d));
    if (p) this.#presentations.set(d.type, freeze(p));
    return this;
  }
  freeze(): this { this.#frozen = true; return this; }
  get frozen(): boolean { return this.#frozen; }
  get size(): number { return this.#definitions.size; }
  /** Missing types and future versions are opaque, even when their data shape differs. */
  resolve(key: string, envelope: Json, text: string): { definition: Readonly<ModuleDefinition>; presentation?: Readonly<ModulePresentation> } | undefined {
    const d = this.#definitions.get(key.slice('module:'.length));
    if (!key.startsWith('module:') || !d || !Array.isArray(envelope) || envelope[0] !== d.version) return undefined;
    if (envelope.length !== 2 || !record(envelope[1]) || text.length > d.content.maxUtf16) return fail('invalid-content');
    const attrs = envelope[1];
    for (const k of Object.keys(attrs)) if (!Object.hasOwn(d.attributes, k)) return fail('invalid-content');
    for (const [k, shape] of Object.entries(d.attributes)) {
      const v = attrs[k];
      if (v === undefined) { if (shape.required) return fail('invalid-content'); continue; }
      if (typeof v !== shape.type || (typeof v === 'number' && !Number.isFinite(v)) ||
          (typeof v === 'string' && v.length > shape.maxUtf16!)) return fail('invalid-content');
    }
    const p = this.#presentations.get(d.type);
    return { definition: d, ...(p ? { presentation: p } : {}) };
  }
  validate(nodes: readonly ProjectedNode[]): void {
    if (!this.#frozen) return fail('frozen');
    for (const node of nodes) for (const run of node.runs) for (const [key, value] of Object.entries(run.attributes))
      if (key.startsWith('module:')) this.resolve(key, value, run.text);
  }
}
