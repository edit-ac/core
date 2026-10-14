import type { DocumentIdentity, EngineHandle, FragmentBlock, Json, PrepareRequest, StableRange } from '../engine.js';

export const EXTENSION_TRANSFER_VERSION = 1 as const;
export const EXTENSION_TRANSFER_MIME = 'application/x-edit-ac-extension+json';
const LIMIT = 1_048_576;
export type TransferMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';
/** Data declaration; this does not admit new document schema or editing semantics. */
export interface ExtensionTransferDescriptor {
  readonly type: string;
  readonly versions: readonly number[];
  readonly inline: readonly TransferMark[];
  readonly blocks: readonly ('paragraph' | 'heading' | 'code' | 'content')[];
  readonly tableMetadata: readonly ('rows' | 'columns' | 'alignment' | 'header' | 'spans' | 'cell-paragraph-style')[];
  readonly fallback: 'inert-source-with-recovery';
}
export interface ExtensionTransferEnvelope {
  readonly version: 1;
  readonly type: string;
  readonly dataVersion: number;
  readonly source: string;
  readonly payload: Json;
}
/** Trusted host code, separate from the serialized descriptor and document. */
export interface ExtensionTransferCodec {
  prepare(envelope: ExtensionTransferEnvelope): readonly FragmentBlock[];
}
export interface PreparedExtensionTransfer {
  readonly version: 1;
  readonly identity: DocumentIdentity;
  readonly revision: number;
  readonly mode: 'formatted' | 'literal' | 'fallback';
  readonly blocks: readonly FragmentBlock[];
  readonly recovery: ExtensionTransferEnvelope;
  readonly diagnostics: readonly string[];
}
export class ExtensionTransferError extends Error {
  constructor(readonly code: 'invalid-data' | 'resource-limit' | 'invalid-descriptor' | 'duplicate' | 'codec-failed' | 'undeclared-formatting' | 'stale-target') {
    super(`Extension transfer: ${code}`); this.name = 'ExtensionTransferError';
  }
}
/** Bounded copy rejects executable values/accessors before reading them. */
function inert<T>(value: T): T {
  let cells = 0, bytes = 0;
  const ancestors = new Set<object>();
  const fail = (code: 'invalid-data' | 'resource-limit'): never => { throw new ExtensionTransferError(code); };
  function copy(v: unknown, depth: number): Json {
    if (++cells > 65536 || depth > 16) return fail('resource-limit');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { bytes += new TextEncoder().encode(v).length; if (bytes > LIMIT) return fail('resource-limit'); return v; }
    if (!v || typeof v !== 'object' || ancestors.has(v)) return fail('invalid-data');
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) return fail('invalid-data');
    ancestors.add(v);
    const array = Array.isArray(v), out: Json[] | Record<string, Json> = array ? [] : Object.create(null);
    const names = Reflect.ownKeys(v).filter(k => !(array && k === 'length'));
    if (array && (names.length !== v.length || names.some((k,i) => k !== String(i)))) return fail('invalid-data');
    for (const k of names) {
      if (typeof k !== 'string' || ['__proto__','constructor','prototype'].includes(k)) return fail('invalid-data');
      bytes += new TextEncoder().encode(k).length;
      if (bytes > LIMIT) return fail('resource-limit');
      const d = Object.getOwnPropertyDescriptor(v,k);
      if (!d || !d.enumerable || !('value' in d)) return fail('invalid-data');
      if (Array.isArray(out)) out.push(copy(d.value,depth+1)); else out[k] = copy(d.value,depth+1);
    }
    ancestors.delete(v); Object.freeze(out); return out;
  }
  const out = copy(value,0);
  if (new TextEncoder().encode(JSON.stringify(out)).length > LIMIT) return fail('resource-limit');
  return out as T;
}
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(v) && v.length <= 128;
const version = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 0xffffffff;
const keys = (v: unknown, expected: string[]): boolean => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === expected.sort().join(',');
function envelope(value: unknown): ExtensionTransferEnvelope {
  const e = inert(value) as ExtensionTransferEnvelope;
  if (!e || typeof e !== 'object' || !keys(e,['version','type','dataVersion','source','payload']) || e.version !== 1 || !name(e.type) || !version(e.dataVersion) || typeof e.source !== 'string') throw new ExtensionTransferError('invalid-data');
  return e;
}
export function exportExtensionTransfer(value: ExtensionTransferEnvelope): string { return JSON.stringify(envelope(value)); }
export function importExtensionTransfer(raw: string): ExtensionTransferEnvelope {
  if (typeof raw !== 'string') throw new ExtensionTransferError('invalid-data');
  if (new TextEncoder().encode(raw).length > LIMIT) throw new ExtensionTransferError('resource-limit');
  try { return envelope(JSON.parse(raw)); } catch (error) { if (error instanceof ExtensionTransferError) throw error; throw new ExtensionTransferError('invalid-data'); }
}
function choices(value: unknown, admitted: readonly unknown[]): boolean {
  return Array.isArray(value) && value.length <= admitted.length && new Set(value).size === value.length && value.every(v => admitted.includes(v));
}
const targets = new WeakMap<PreparedExtensionTransfer, EngineHandle>();
export class ExtensionTransferRegistry {
  readonly #entries = new Map<string, { descriptor: ExtensionTransferDescriptor; codec?: ExtensionTransferCodec }>();
  /** Validate the whole set before activation; caller declarations remain mutable. */
  constructor(entries: readonly { descriptor: ExtensionTransferDescriptor; codec?: ExtensionTransferCodec }[]) {
    if (!Array.isArray(entries) || entries.length > 64) throw new ExtensionTransferError('resource-limit');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new ExtensionTransferError('invalid-descriptor');
      const d: ExtensionTransferDescriptor = inert(entry.descriptor);
      const codec = entry.codec, prepare = codec?.prepare;
      if (!keys(d,['type','versions','inline','blocks','tableMetadata','fallback']) || !name(d.type) || !Array.isArray(d.versions) || !d.versions.length || d.versions.length > 32 || d.versions.some((v: number)=>!version(v)) || new Set(d.versions).size !== d.versions.length ||
        !choices(d.inline,['bold','italic','underline','strike','code','link']) || !choices(d.blocks,['paragraph','heading','code','content']) || !choices(d.tableMetadata,['rows','columns','alignment','header','spans','cell-paragraph-style']) || d.fallback !== 'inert-source-with-recovery' || (codec && typeof prepare !== 'function')) throw new ExtensionTransferError('invalid-descriptor');
      if (this.#entries.has(d.type)) throw new ExtensionTransferError('duplicate');
      // Capture the callback once; replacement of the caller's codec cannot alter admission.
      this.#entries.set(d.type,{descriptor:d,...(codec ? {codec:{prepare:prepare!.bind(codec)}} : {})});
    }
  }
  descriptors(): readonly ExtensionTransferDescriptor[] { return Object.freeze([...this.#entries.values()].map(e=>e.descriptor)); }
  prepare(engine: EngineHandle, input: ExtensionTransferEnvelope, literal = false): PreparedExtensionTransfer {
    const e = envelope(input), snapshot = engine.read(), entry = this.#entries.get(e.type);
    const diagnostics: string[] = [];
    let mode: PreparedExtensionTransfer['mode'] = literal ? 'literal' : 'formatted';
    let blocks: readonly FragmentBlock[];
    if (literal || !entry?.codec || !entry.descriptor.versions.includes(e.dataVersion)) {
      if (!literal) { mode = 'fallback'; diagnostics.push(!entry ? 'unknown-extension' : !entry.descriptor.versions.includes(e.dataVersion) ? 'unsupported-version' : 'unavailable-codec'); }
      // Preserve exact bounded source and the entire typed envelope. No interpretation.
      blocks = [{attributes:null,runs:[{text:e.source,marks:[]}]}];
    } else {
      try { blocks = inert(entry.codec.prepare(e)); }
      catch (error) { if (error instanceof ExtensionTransferError) throw error; throw new ExtensionTransferError('codec-failed'); }
      if (!Array.isArray(blocks) || !blocks.length) throw new ExtensionTransferError('invalid-data');
      for (const block of blocks) {
        if (!block || typeof block !== 'object' || !Array.isArray(block.runs) || block.runs.some((r: FragmentBlock['runs'][number]) => !r || typeof r !== 'object' || !Array.isArray(r.marks) || r.marks.some((m: unknown) => !m || typeof m !== 'object'))) throw new ExtensionTransferError('invalid-data');
        const type = block.attributes?.type ?? 'paragraph';
        const tuple = block.attributes?.type === 'content' ? block.attributes.tuple : null;
        if (Array.isArray(tuple) && tuple[0] === 'module:editac.table') {
          const data = tuple[2] as Record<string, Json>;
          if (!data || typeof data !== 'object' || !keys(data,['alignments','rows','source']) ||
            !['rows','columns','alignment','header'].every(k => entry.descriptor.tableMetadata.includes(k as ExtensionTransferDescriptor['tableMetadata'][number]))) throw new ExtensionTransferError('undeclared-formatting');
          if (Array.isArray(data.rows)) for (const row of data.rows) {
            if (!Array.isArray(row)) throw new ExtensionTransferError('invalid-data');
            for (const cell of row) {
              if (!Array.isArray(cell)) throw new ExtensionTransferError('invalid-data');
              for (const run of cell) {
                const marks = Array.isArray(run) ? run[1] : null;
                if (!Array.isArray(marks) || marks.some(m => !Array.isArray(m) || !entry.descriptor.inline.includes(m[0] as TransferMark))) throw new ExtensionTransferError('undeclared-formatting');
              }
            }
          }
        }
        if (!entry.descriptor.blocks.includes(type as ExtensionTransferDescriptor['blocks'][number]) || !Array.isArray(block.runs) || block.runs.some((r: FragmentBlock['runs'][number]) => !Array.isArray(r.marks) || r.marks.some((m: FragmentBlock['runs'][number]['marks'][number]) => !entry.descriptor.inline.includes(m.mark)))) throw new ExtensionTransferError('undeclared-formatting');
      }
    }
    // Clipboard validation requires a concrete portable style; null on the actual
    // prepared literal request retains the destination's existing formatting.
    blocks = inert(blocks);
    engine.validateFragment(JSON.stringify({version:1,schema:snapshot.identity.schema,blocks:blocks.map(b=>({...b,attributes:b.attributes??{type:'paragraph'}}))}));
    if (engine.read().revision !== snapshot.revision) throw new ExtensionTransferError('stale-target');
    const prepared: PreparedExtensionTransfer = inert({version:1,identity:snapshot.identity,revision:snapshot.revision,mode,blocks,recovery:e,diagnostics});
    targets.set(prepared,engine); return prepared;
  }
}
/** Shared host capability/commit boundary remains responsible for atomic admission,
 * history, storage and permission. Stable range tokens remain caller-owned. */
export function extensionTransferRequest(prepared: PreparedExtensionTransfer, engine: EngineHandle, range: StableRange, origin: string, cut = false): PrepareRequest {
  if (targets.get(prepared) !== engine) throw new ExtensionTransferError('stale-target');
  const value = prepared, current = engine.read();
  if (value.version !== 1 || JSON.stringify(value.identity) !== JSON.stringify(current.identity) || value.revision !== current.revision) throw new ExtensionTransferError('stale-target');
  return {kind:'fragment',origin,range:{anchor:range.anchor,focus:range.focus},blocks:cut ? [{attributes:null,runs:[{text:'',marks:[]}]}] : value.blocks};
}
