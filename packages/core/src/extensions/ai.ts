import type { DocumentIdentity, StableRange } from '../engine.js';
import { copyModuleData } from './registry.js';

export const AI_VERSION = 1 as const;
export const AI_PROFILE = 'editac-ai-text-v1';
export const AI_CAPABILITIES = Object.freeze(['ask', 'fill', 'continue', 'rewrite', 'completion'] as const);
export type AiOperation = typeof AI_CAPABILITIES[number];
export type AiScope = 'selection' | 'passage' | 'document';
export interface AiLimits { requests: number; instructionBytes: number; contextBytes: number; outputBytes: number; timeoutMs: number }
export interface AiDescriptor { version: 1; enabled: boolean; capabilities: readonly AiOperation[]; limits?: AiLimits }
/** Local capture only; never sent to a backend. Its owner releases existing anchors. */
export interface AiTarget { identity: DocumentIdentity; revision: number; range: StableRange }
export interface AiRequest { version: 1; requestId: string; operation: AiOperation; scope: AiScope; instruction: string; context: string; format: 'plain-text'; outputBytes: number }
export type AiErrorCode = 'unavailable' | 'version' | 'limits' | 'capability' | 'forbidden' | 'format' | 'invalid-request' | 'quota' | 'canceled' | 'timeout' | 'transport' | 'invalid-response';
export type AiStatus = 'unavailable' | 'ready' | 'pending' | 'streaming' | 'complete' | 'canceled' | 'failed';
export interface AiUsage { inputTokens: number | null; outputTokens: number | null }
export type AiResponse = { version: 1; requestId: string; sequence: number } & (
  { type: 'delta'; text: string } | { type: 'finish'; usage: AiUsage | null } | { type: 'error'; code: AiErrorCode });
export interface AiPolicy { allowRemote: boolean; protectedDocument: boolean }
/** Host/backend owns credentials, provider selection and propagation of this signal. */
export interface AiTransport { send(request: Readonly<AiRequest>, signal: AbortSignal): AsyncIterable<AiResponse> }
export class AiError extends Error {
  constructor(readonly code: AiErrorCode) { super(`AI service: ${code}`); this.name = 'AiError'; }
}
const fail = (code: AiErrorCode): never => { throw new AiError(code); };
const bytes = (s: string) => new TextEncoder().encode(s).length;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
const integer = (n: unknown, max: number, min = 1): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const errors: readonly string[] = ['unavailable','version','limits','capability','forbidden','format','invalid-request','quota','canceled','timeout','transport','invalid-response'];
function data(v: unknown, code: AiErrorCode): Record<string, unknown> {
  try { const d = copyModuleData(v); if (record(d)) return d; } catch { /* fail closed without invoking getters */ }
  return fail(code);
}
function descriptor(value: unknown): AiDescriptor {
  const d = data(value, 'limits');
  if (d.version !== AI_VERSION) return fail('version');
  if (typeof d.enabled !== 'boolean' || !keys(d, d.limits === undefined ? ['version','enabled','capabilities'] : ['version','enabled','capabilities','limits'])) return fail('limits');
  if (!Array.isArray(d.capabilities) || !d.capabilities.length || d.capabilities.length > AI_CAPABILITIES.length || new Set(d.capabilities).size !== d.capabilities.length || d.capabilities.some(c => !AI_CAPABILITIES.includes(c as AiOperation))) return fail('capability');
  if (d.limits !== undefined) {
    const l = d.limits;
    if (!record(l) || !keys(l, ['requests','instructionBytes','contextBytes','outputBytes','timeoutMs']) || !integer(l.requests, 10000) || !integer(l.instructionBytes, 16384) || !integer(l.contextBytes, 32768) || !integer(l.outputBytes, 16384) || !integer(l.timeoutMs, 120000)) return fail('limits');
    Object.freeze(l);
  }
  Object.freeze(d.capabilities); return Object.freeze(d) as unknown as AiDescriptor;
}
function request(value: unknown, d: AiDescriptor): Readonly<AiRequest> {
  const r = data(value, 'invalid-request'), l = d.limits!;
  if (r.version !== AI_VERSION) return fail('version');
  if (r.format !== 'plain-text') return fail('format');
  if (!d.capabilities.includes(r.operation as AiOperation)) return fail('capability');
  if (!keys(r, ['version','requestId','operation','scope','instruction','context','format','outputBytes']) || typeof r.requestId !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(r.requestId) || !['selection','passage','document'].includes(String(r.scope)) || typeof r.instruction !== 'string' || !r.instruction.length || bytes(r.instruction) > l.instructionBytes || typeof r.context !== 'string' || bytes(r.context) > l.contextBytes || !integer(r.outputBytes, l.outputBytes)) return fail('invalid-request');
  return Object.freeze(r) as unknown as AiRequest;
}
function response(value: unknown, r: AiRequest, sequence: number): AiResponse {
  const e = data(value, 'invalid-response');
  if (e.version !== AI_VERSION || e.requestId !== r.requestId || e.sequence !== sequence) return fail('invalid-response');
  const base = ['version','requestId','sequence','type'];
  if (e.type === 'delta' && keys(e, [...base, 'text']) && typeof e.text === 'string' && e.text.length) return e as unknown as AiResponse;
  if (e.type === 'error' && keys(e, [...base, 'code']) && errors.includes(String(e.code))) return e as unknown as AiResponse;
  if (e.type === 'finish' && keys(e, [...base, 'usage']) && (e.usage === null || (record(e.usage) && keys(e.usage, ['inputTokens','outputTokens']) && Object.values(e.usage).every(n => n === null || integer(n, Number.MAX_SAFE_INTEGER, 0))))) return e as unknown as AiResponse;
  return fail('invalid-response');
}
/** Optional per-editor admission/transport adapter; has no document or commit port.
 * A host quota reservation is mandatory. Retries/regeneration consume new slots.
 */
export class AiHost {
  readonly #descriptor: AiDescriptor | undefined;
  #used = 0;
  get used(): number { return this.#used; }
  constructor(value: AiDescriptor | undefined, readonly transport?: AiTransport,
    readonly policy: () => AiPolicy = () => ({ allowRemote: false, protectedDocument: true }),
    readonly reserve?: (request: Readonly<AiRequest>) => boolean) {
    this.#descriptor = value === undefined ? undefined : descriptor(value);
  }
  get availability(): 'ready' | 'unavailable' {
    return this.#descriptor?.enabled && this.#descriptor.limits && this.transport && this.reserve ? 'ready' : 'unavailable';
  }
  async *send(value: AiRequest, signal: AbortSignal): AsyncGenerator<AiResponse> {
    const d = this.#descriptor;
    if (!d?.enabled || !this.transport) return fail('unavailable');
    if (!d.limits) return fail('limits');
    if (!this.reserve) return fail('quota');
    const r = request(value, d), p = this.policy();
    if (!p.allowRemote || p.protectedDocument) return fail('forbidden');
    if (signal.aborted) return fail('canceled');
    if (this.#used >= d.limits.requests) return fail('quota');
    // Count attempts before calling host code: reentrant/failed reservations cannot bypass caps.
    this.#used++;
    if (!this.reserve(r)) return fail('quota');
    if (signal.aborted) return fail('canceled');
    const controller = new AbortController();
    let rejectAbort!: (error: AiError) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = (code: AiErrorCode) => { controller.abort(); rejectAbort(new AiError(code)); };
    const onAbort = () => abort('canceled');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => abort('timeout'), d.limits.timeoutMs);
    let iterator: AsyncIterator<AiResponse> | undefined;
    try {
      iterator = this.transport.send(r, controller.signal)[Symbol.asyncIterator]();
      let total = 0, sequence = 0;
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (signal.aborted) return fail('canceled');
        if (controller.signal.aborted) return fail('timeout');
        if (next.done) return fail('invalid-response'); // terminal envelope required
        const e = response(next.value, r, sequence++);
        if (e.type === 'delta') { total += bytes(e.text); if (total > r.outputBytes) return fail('invalid-response'); }
        yield Object.freeze(e);
        if (e.type !== 'delta') return;
      }
    } catch (error) { if (error instanceof AiError) throw error; return fail('transport'); }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort();
      // A misbehaving host iterator cannot delay local teardown.
      if (iterator?.return) { try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* host cleanup fault */ } }
    }
  }
}
