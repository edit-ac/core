/** Optional derived appearance only: no document, persistence or input handles. */
export const HIGHLIGHT_BACKEND = 'syntect-5.3.0/fancy/two-face-0.5.2+bat-0.26.1/newlines';
export interface HighlightInput {
  readonly block: string; readonly revision: number; readonly source: string;
  readonly language: string; readonly grammar: string; readonly query: string;
  readonly theme: string; readonly enabled: boolean;
}
export interface HighlightSpan { readonly start: number; readonly end: number; readonly scopes: readonly string[] }
export interface HighlightTiming { startup: number; transfer: number; work: number; application: number }
export interface HighlightResult {
  readonly input: HighlightInput; readonly status: string; readonly spans: readonly HighlightSpan[];
  readonly timing: HighlightTiming;
}
export interface HighlightWorkerPort {
  postMessage(value: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export interface HighlightClock {
  now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void;
}
export interface HighlightSchedulerOptions {
  createWorker: () => HighlightWorkerPort;
  maxPending?: number; timeoutMs?: number; clock?: HighlightClock;
  /** Called only for an admitted current projection/fallback. Never for obsolete work. */
  apply?: (result: HighlightResult) => void;
}
interface Request {
  id: number; input: HighlightInput; resolve: (value: HighlightResult) => void;
  settled: boolean; sent: number;
}
const clock: HighlightClock = {
  now: () => performance.now(), setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};
const encoder = new TextEncoder();
const statuses = new Set(['highlighted', 'disabled', 'unknown-language', 'over-budget', 'backend-error', 'cancelled', 'unsupported-grammar']);
export function validHighlightInput(input: HighlightInput): boolean {
  return typeof input.source === 'string' && encoder.encode(input.source).length <= 102400
    && Number.isSafeInteger(input.revision) && input.revision >= 0 && typeof input.enabled === 'boolean'
    && [input.block, input.language, input.grammar, input.query, input.theme].every(x => typeof x === 'string' && x.length > 0 && encoder.encode(x).length <= 256);
}
export function sameHighlightInput(a: HighlightInput, b: unknown): boolean {
  return !!b && typeof b === 'object' && (['block', 'revision', 'source', 'language', 'grammar', 'query', 'theme', 'enabled'] as const)
    .every(key => a[key] === (b as HighlightInput)[key]);
}
function boundary(source: string, offset: number): boolean {
  return Number.isInteger(offset) && offset >= 0 && offset <= source.length
    && !(offset > 0 && offset < source.length && /[\uD800-\uDBFF]/u.test(source[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(source[offset]!));
}
/** Validate even worker output; a bad/foreign result must never reach presentation. */
export function validHighlightProjection(input: HighlightInput, value: unknown): value is { status: string; spans: HighlightSpan[] } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { status: string; spans: HighlightSpan[] };
  if (!statuses.has(v.status) || !Array.isArray(v.spans) || v.spans.length > 16384 || (v.status !== 'highlighted' && v.spans.length !== 0)) return false;
  let end = 0, bytes = 0;
  for (const span of v.spans) {
    if (!span || !boundary(input.source, span.start) || !boundary(input.source, span.end) || span.start < end || span.end <= span.start
      || !Array.isArray(span.scopes) || span.scopes.length > 64) return false;
    for (const scope of span.scopes) {
      if (typeof scope !== 'string' || scope.length > 256) return false;
      bytes += encoder.encode(scope).length;
      if (bytes > 2 * 1024 * 1024) return false;
    }
    end = span.end;
  }
  return true;
}

/** One active worker job + a bounded, latest-per-block queue. Timeout also kills
 * a worker stuck inside a non-preemptible regex; late messages cannot revive it. */
export class HighlightScheduler {
  private readonly options: HighlightSchedulerOptions;
  private readonly clock: HighlightClock;
  private readonly cap: number;
  private readonly timeout: number;
  private worker: HighlightWorkerPort | undefined;
  private timer: unknown;
  private bootStarted = 0;
  private bootMs = 0;
  private awaitingReady = false;
  private active: Request | undefined;
  private readonly pending = new Map<string, Request>();
  private serial = 0;
  private disposed = false;
  constructor(options: HighlightSchedulerOptions) {
    this.options = options; this.clock = options.clock ?? clock;
    this.cap = options.maxPending ?? 16; this.timeout = options.timeoutMs ?? 2000;
    if (!Number.isInteger(this.cap) || this.cap < 1 || this.cap > 16 || !Number.isFinite(this.timeout) || this.timeout < 1 || this.timeout > 30000) throw new RangeError('highlight scheduler limits');
  }
  request(value: HighlightInput): Promise<HighlightResult> {
    // Copy only the portable record; callers cannot transfer extra host handles.
    const input = Object.freeze({ block: value.block, revision: value.revision, source: value.source,
      language: value.language, grammar: value.grammar, query: value.query, theme: value.theme, enabled: value.enabled });
    return new Promise(resolve => {
      const request: Request = { id: ++this.serial, input, resolve, settled: false, sent: 0 };
      if (this.disposed) { this.finish(request, 'disposed'); return; }
      // Any new state for a block invalidates its older projection, even when disabled/invalid.
      this.cancel(input.block);
      if (!validHighlightInput(input)) { this.finish(request, 'over-budget', true); return; }
      if (!input.enabled) { this.finish(request, 'disabled', true); return; }
      if (this.pending.size === this.cap) {
        const oldest = this.pending.values().next().value!;
        this.pending.delete(oldest.input.block); this.finish(oldest, 'queue-full', true);
      }
      this.pending.set(input.block, request); this.pump();
    });
  }
  cancel(block: string): void {
    const queued = this.pending.get(block);
    if (queued) { this.pending.delete(block); this.finish(queued, 'superseded'); }
    if (this.active?.input.block === block) this.finish(this.active, 'superseded');
  }
  get state(): { pending: number; active: number; workers: number; disposed: boolean } {
    return { pending: this.pending.size, active: this.active ? 1 : 0, workers: this.worker ? 1 : 0, disposed: this.disposed };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.finish(this.active, 'disposed');
    for (const request of this.pending.values()) this.finish(request, 'disposed');
    this.pending.clear(); this.resetWorker(); this.active = undefined;
  }
  private finish(request: Request, status: string, apply = false, spans: readonly HighlightSpan[] = [], timing: HighlightTiming = { startup: 0, transfer: 0, work: 0, application: 0 }): void {
    if (request.settled) return;
    request.settled = true;
    const result = { input: request.input, status, spans, timing };
    const start = this.clock.now();
    try { if (apply && !this.disposed) this.options.apply?.(result); }
    catch { /* A host presentation error cannot strand owned queue state. */ }
    finally { timing.application = Math.max(0, this.clock.now() - start); request.resolve(result); }
  }
  private resetWorker(): void {
    this.clock.clearTimeout(this.timer); this.timer = undefined;
    this.bootMs = 0; this.awaitingReady = false;
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); this.worker = undefined; }
  }
  private pump(): void {
    if (this.disposed || this.active || !this.pending.size) return;
    const request = this.pending.values().next().value!;
    this.pending.delete(request.input.block); this.active = request;
    request.sent = this.clock.now();
    try {
      if (!this.worker) {
        this.bootStarted = this.clock.now(); this.awaitingReady = true;
        const worker = this.options.createWorker(); this.worker = worker;
        worker.onmessage = event => { if (this.worker === worker) this.receive(event.data); };
        worker.onerror = () => { if (this.worker === worker) this.fail('backend-error'); };
      }
      this.timer = this.clock.setTimeout(() => this.fail('timeout'), this.timeout);
      this.worker.postMessage({ type: 'highlight', id: request.id, input: request.input });
    } catch { this.fail('backend-error'); }
  }
  private fail(status: string): void {
    const request = this.active;
    this.active = undefined; this.resetWorker();
    if (request) this.finish(request, status, true);
    this.pump();
  }
  private receive(value: unknown): void {
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'ready') {
      if (this.awaitingReady) { this.bootMs = Math.max(0, this.clock.now() - this.bootStarted); this.awaitingReady = false; }
      return;
    }
    const request = this.active;
    if (!request || !value || typeof value !== 'object') return;
    const v = value as { id: number; input: HighlightInput; projection: unknown; timing: HighlightTiming };
    if (v.id !== request.id) return; // late/foreign/duplicate
    if (!sameHighlightInput(request.input, v.input) || !validHighlightProjection(request.input, v.projection)
      || !v.timing || ![v.timing.startup, v.timing.work].every(n => Number.isFinite(n) && n >= 0)) { this.fail('backend-error'); return; }
    this.clock.clearTimeout(this.timer); this.timer = undefined; this.active = undefined;
    const startup = this.bootMs + v.timing.startup; this.bootMs = 0;
    const timing = { startup, work: v.timing.work,
      transfer: Math.max(0, this.clock.now() - request.sent - startup - v.timing.work), application: 0 };
    try { this.finish(request, v.projection.status, true, v.projection.spans, timing); }
    finally { this.pump(); }
  }
}
