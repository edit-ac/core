import type { DocumentIdentity, StableRange } from '../engine.js';
import { copyModuleData } from './registry.js';

export const ASSISTIVE_VERSION = 1 as const;
export const ASSISTIVE_PROFILE = 'editac-assistive-input-v1';
export const ASSISTIVE_CAPABILITIES = Object.freeze(['commands', 'status', 'host-transport'] as const);
export type AssistiveCapability = typeof ASSISTIVE_CAPABILITIES[number];
export interface AssistiveLimits { textBytes: number; statusBytes: number; commands: number; results: number; sessions: number; timeoutMs: number }
export interface AssistiveTransportCapabilities {
  input: 'audio' | 'transcript'; locality: 'on-device' | 'remote' | 'unknown'; permissionOwner: 'host';
  retention: 'none' | 'session' | 'host-policy' | 'unknown'; cancellation: 'abort' | 'best-effort'; canStop: boolean;
}
export interface AssistiveDescriptor {
  version: 1; enabled: boolean; capabilities: readonly AssistiveCapability[];
  limits: Readonly<AssistiveLimits>; transport: Readonly<AssistiveTransportCapabilities> | null;
}
export type AssistiveErrorCode = 'version' | 'limits' | 'capability' | 'duplicate' | 'unavailable' | 'disposed' | 'invalid-envelope';
export type AssistiveOutcome = 'unsupported' | 'permission-denied' | 'unavailable' | 'read-only' | 'composing' | 'canceled' | 'stale' | 'malformed' | 'oversized' | 'timeout' | 'disconnected';
export type AssistiveState = 'idle' | 'starting' | 'active' | 'preparing' | 'completed' | 'cancelled' | 'stale' | 'failed';
export interface AssistiveSessionIdentity { sessionId: string; generation: number }
/** Local capture only. Host owns existing engine anchors and releases both on termination.
 * Never send this target or document context to the injected transport. */
export interface AssistiveTarget { identity: DocumentIdentity; range: StableRange }
export interface AssistiveCommandApplicability {
  /** Existing semantic command identity; this service never dispatches editing. */
  commandId: string; label: string; enabled: boolean; reason: AssistiveOutcome | null;
}
export interface AssistivePresenterStatus {
  version: 1; state: AssistiveState; session: AssistiveSessionIdentity | null; reason: AssistiveOutcome | null;
  /** Status announcements contain no transcript by default. */
  message: string;
  /** Disposable presenter state; never document metadata, logs or telemetry. */
  provisional: string;
}
export interface AssistiveResult {
  version: 1; session: AssistiveSessionIdentity; sequence: number; kind: 'provisional' | 'final'; text: string;
}
export interface AssistiveStartRequest { version: 1; session: AssistiveSessionIdentity }
export type AssistiveTransportEvent = { type: 'result'; result: AssistiveResult } | { type: 'error'; session: AssistiveSessionIdentity; reason: AssistiveOutcome };
/** Host owns permission, timers, processing, callback/stream cleanup and credentials.
 * Stop requests a final result; cancel/dispose reject late results before releasing resources.
 * AIN session consumers bind generation, deduplicate results and commit via existing engine ports. */
export interface AssistiveTransportSession { stop(): void; cancel(): void; dispose(): void }
export interface AssistiveTransport {
  start(request: Readonly<AssistiveStartRequest>, signal: AbortSignal, emit: (event: AssistiveTransportEvent) => void): AssistiveTransportSession;
}
export class AssistiveError extends Error {
  constructor(readonly code: AssistiveErrorCode) { super(`Assistive input: ${code}`); this.name = 'AssistiveError'; }
}
const fail = (code: AssistiveErrorCode): never => { throw new AssistiveError(code); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, names: string[]) => Object.keys(v).sort().join(',') === names.sort().join(',');
const integer = (v: unknown, max: number, min = 1): v is number => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_:-]{1,128}$/.test(v);
const outcomes: readonly unknown[] = ['unsupported','permission-denied','unavailable','read-only','composing','canceled','stale','malformed','oversized','timeout','disconnected'];
const states: readonly unknown[] = ['idle','starting','active','preparing','completed','cancelled','stale','failed'];
const reason = (v: unknown) => v === null || outcomes.includes(v);
function data(value: unknown, error: AssistiveErrorCode): Record<string, unknown> {
  try { const d = copyModuleData(value); if (record(d)) return d; } catch { /* no executable accessors */ }
  return fail(error);
}
function session(v: unknown): boolean {
  return record(v) && keys(v, ['sessionId','generation']) && identifier(v.sessionId) && integer(v.generation, 0xffff_ffff);
}
function version(v: unknown): void { if (v !== ASSISTIVE_VERSION) fail('version'); }
function descriptor(value: unknown): Readonly<AssistiveDescriptor> {
  const d = data(value, 'invalid-envelope'); version(d.version);
  if (!keys(d, ['version','enabled','capabilities','limits','transport']) || typeof d.enabled !== 'boolean') fail('invalid-envelope');
  if (!Array.isArray(d.capabilities) || !d.capabilities.length || d.capabilities.length > 3 || new Set(d.capabilities).size !== d.capabilities.length || d.capabilities.some(c => !ASSISTIVE_CAPABILITIES.includes(c))) fail('capability');
  const l = d.limits;
  if (!record(l) || !keys(l, ['textBytes','statusBytes','commands','results','sessions','timeoutMs']) || !integer(l.textBytes,16384) || !integer(l.statusBytes,512) || !integer(l.commands,64) || !integer(l.results,1024) || !integer(l.sessions,8) || !integer(l.timeoutMs,120000)) fail('limits');
  const t = d.transport;
  if ((d.capabilities as string[]).includes('host-transport') !== (t !== null)) fail('capability');
  if (t !== null) {
    if (!record(t) || !keys(t,['input','locality','permissionOwner','retention','cancellation','canStop']) || (typeof t.input !== 'string' || !['audio','transcript'].includes(t.input)) || (typeof t.locality !== 'string' || !['on-device','remote','unknown'].includes(t.locality)) || t.permissionOwner !== 'host' || (typeof t.retention !== 'string' || !['none','session','host-policy','unknown'].includes(t.retention)) || (typeof t.cancellation !== 'string' || !['abort','best-effort'].includes(t.cancellation)) || typeof t.canStop !== 'boolean') fail('capability');
    Object.freeze(t);
  }
  Object.freeze(l); Object.freeze(d.capabilities); return Object.freeze(d) as unknown as Readonly<AssistiveDescriptor>;
}
/** Existing optional host-service boundary. No engine/document handle, listeners,
 * input hooks or transport construction. Invalid registration is atomic. */
export class AssistiveRegistration {
  #descriptor: Readonly<AssistiveDescriptor> | undefined;
  #disposed = false;
  #controller = new AbortController();
  get descriptor(): Readonly<AssistiveDescriptor> | undefined { return this.#descriptor; }
  get signal(): AbortSignal { return this.#controller.signal; }
  register(value: unknown): void {
    if (this.#disposed) fail('disposed');
    const d = descriptor(value);
    if (this.#descriptor) fail('duplicate');
    this.#descriptor = d;
  }
  supports(capability: string): boolean {
    return !this.#disposed && !!this.#descriptor?.enabled && this.#descriptor.capabilities.includes(capability as AssistiveCapability);
  }
  #require(capability: AssistiveCapability): Readonly<AssistiveLimits> {
    if (this.#disposed) return fail('disposed');
    if (!this.supports(capability)) return fail('unavailable');
    return this.#descriptor!.limits;
  }
  validateCommands(value: unknown): readonly Readonly<AssistiveCommandApplicability>[] {
    const l = this.#require('commands');
    let values: unknown; try { values = copyModuleData(value); } catch { return fail('invalid-envelope'); }
    if (!Array.isArray(values)) return fail('invalid-envelope');
    if (values.length > l.commands) return fail('limits');
    const ids = new Set<string>();
    for (const c of values) {
      if (!record(c) || !keys(c,['commandId','label','enabled','reason']) || !identifier(c.commandId) || ids.has(c.commandId) || typeof c.label !== 'string' || !c.label.trim() || bytes(c.label) > l.statusBytes || typeof c.enabled !== 'boolean' || !reason(c.reason) || c.enabled === (c.reason !== null)) return fail('invalid-envelope');
      ids.add(c.commandId); Object.freeze(c);
    }
    return Object.freeze(values) as readonly Readonly<AssistiveCommandApplicability>[];
  }
  validateStatus(value: unknown): Readonly<AssistivePresenterStatus> {
    const l = this.#require('status'), s = data(value, 'invalid-envelope'); version(s.version);
    if (!keys(s,['version','state','session','reason','message','provisional']) || !states.includes(s.state) || !(s.session === null || session(s.session)) || !reason(s.reason) || typeof s.message !== 'string' || typeof s.provisional !== 'string') return fail('invalid-envelope');
    if (bytes(s.message) > l.statusBytes || bytes(s.provisional) > l.textBytes) return fail('limits');
    if (s.session) Object.freeze(s.session);
    return Object.freeze(s) as unknown as Readonly<AssistivePresenterStatus>;
  }
  validateResult(value: unknown): Readonly<AssistiveResult> {
    const l = this.#require('host-transport'), r = data(value, 'invalid-envelope'); version(r.version);
    if (!keys(r,['version','session','sequence','kind','text']) || !session(r.session) || !integer(r.sequence, 0xffff_ffff,0) || (typeof r.kind !== 'string' || !['provisional','final'].includes(r.kind)) || typeof r.text !== 'string') return fail('invalid-envelope');
    if (r.sequence >= l.results || bytes(r.text) > l.textBytes) return fail('limits');
    Object.freeze(r.session); return Object.freeze(r) as unknown as Readonly<AssistiveResult>;
  }
  validateStart(value: unknown): Readonly<AssistiveStartRequest> {
    this.#require('host-transport');
    const r = data(value, 'invalid-envelope'); version(r.version);
    if (!keys(r,['version','session']) || !session(r.session)) return fail('invalid-envelope');
    Object.freeze(r.session); return Object.freeze(r) as unknown as Readonly<AssistiveStartRequest>;
  }
  dispose(): void { this.#disposed = true; this.#descriptor = undefined; this.#controller.abort(); }
}
