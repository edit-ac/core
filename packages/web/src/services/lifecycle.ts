/** Optional derived-work admission. This does not own semantic writes or durable receipts. */
export interface ServiceScope {
  document: string;
  session: string;
  revision: string;
  permission: string;
  authorized: boolean;
}
export type ServiceFailure = 'invalid' | 'resource-limit' | 'saturated' | 'cancelled' | 'disposed' | 'deadline' | 'stale-revision' | 'replaced-session' | 'permission-loss' | 'provider-failed';
export type ServiceResult<T> = { status: 'ready'; value: T; scope: Readonly<ServiceScope> } | { status: ServiceFailure };
export interface ServiceLimits { concurrency: number; queue: number; bytes: number; items: number; deadlineMs: number }
export interface ServiceRequest { scope: Readonly<ServiceScope>; bytes: number; items: number; deadline: number; signal: AbortSignal }
/** Injected by deterministic checks; production uses one timer per admitted operation. */
export interface ServiceClock { now(): number; schedule(callback: () => void, delay: number): () => void }
const clock: ServiceClock = { now: () => performance.now(), schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function validServiceScope(scope: Readonly<ServiceScope>): boolean {
  return !!scope && [scope.document, scope.session, scope.revision, scope.permission].every(identity) && typeof scope.authorized === 'boolean';
}
/** Same rejection precedence as the portable session companion. */
export function serviceScopeFailure(expected: Readonly<ServiceScope>, current: Readonly<ServiceScope>): ServiceFailure | undefined {
  if (!validServiceScope(expected) || !validServiceScope(current)) return 'invalid';
  if (current.document !== expected.document || current.session !== expected.session) return 'replaced-session';
  if (!expected.authorized || !current.authorized || current.permission !== expected.permission) return 'permission-loss';
  if (current.revision !== expected.revision) return 'stale-revision';
  return undefined;
}
interface Job {
  request: ServiceRequest;
  controller: AbortController;
  settled: boolean;
  cleanup(): void;
  settle(status: ServiceFailure): void;
  execute(): Promise<void>;
}
/** Bounded FIFO. Cancellation settles the caller, but an uncooperative provider
 * keeps its occupied slot until it actually finishes. No replacement stampede. */
export class ServiceLifecycle {
  private readonly queue: Job[] = [];
  private readonly active = new Set<Job>();
  private disposed = false;
  readonly limits: Readonly<ServiceLimits>;
  constructor(private readonly context: () => Readonly<ServiceScope>, limits: ServiceLimits, private readonly time: ServiceClock = clock) {
    if (![limits.concurrency, limits.queue, limits.bytes, limits.items, limits.deadlineMs].every(Number.isSafeInteger) || limits.concurrency < 1 || limits.concurrency > 64 || limits.queue < 0 || limits.queue > 4096 || limits.bytes < 1 || limits.items < 1 || limits.deadlineMs < 1 || limits.deadlineMs > 0x7fffffff) throw Error('Invalid service limits');
    this.limits = Object.freeze({ ...limits });
  }
  get state(): Readonly<{ active: number; queued: number; disposed: boolean }> { return { active: this.active.size, queued: this.queue.length, disposed: this.disposed }; }
  check(scope: Readonly<ServiceScope>): ServiceFailure | undefined {
    if (this.disposed) return 'disposed';
    try { const current = this.context(); return this.disposed ? 'disposed' : serviceScopeFailure(scope, current); } catch { return this.disposed ? 'disposed' : 'permission-loss'; }
  }
  private failure(request: ServiceRequest): ServiceFailure | undefined {
    if (request.signal.aborted) return 'cancelled';
    if (this.time.now() >= request.deadline) return 'deadline';
    return this.check(request.scope);
  }
  run<T>(request: ServiceRequest, provider: (signal: AbortSignal) => T | Promise<T>): Promise<ServiceResult<T>> {
    const now = this.time.now();
    if (!validServiceScope(request.scope) || !Number.isSafeInteger(request.bytes) || request.bytes < 0 || !Number.isSafeInteger(request.items) || request.items < 0 || !Number.isFinite(request.deadline) || request.deadline - now > this.limits.deadlineMs) return Promise.resolve({ status: 'invalid' });
    const rejected = this.failure(request);
    if (rejected) return Promise.resolve({ status: rejected });
    if (request.bytes > this.limits.bytes || request.items > this.limits.items) return Promise.resolve({ status: 'resource-limit' });
    if (this.active.size >= this.limits.concurrency && this.queue.length >= this.limits.queue) return Promise.resolve({ status: 'saturated' });
    // Own the scope before invoking host/provider callbacks.
    request = { ...request, scope: Object.freeze({ ...request.scope }) };
    return new Promise(resolve => {
      const controller = new AbortController();
      let removeTimer = () => {};
      const abort = () => { job.settle('cancelled'); this.drain(); };
      const job: Job = {
        request, controller, settled: false,
        cleanup: () => { request.signal.removeEventListener('abort', abort); removeTimer(); },
        settle: status => {
          if (job.settled) return;
          job.settled = true; job.cleanup();
          const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
          controller.abort(); resolve({ status });
        },
        execute: async () => {
          try {
            const value = await provider(controller.signal);
            if (job.settled) return;
            const status = this.failure(request);
            if (status) job.settle(status);
            else { job.settled = true; job.cleanup(); resolve({ status: 'ready', value, scope: request.scope }); }
          } catch { job.settle(this.failure(request) ?? 'provider-failed'); }
          finally { this.active.delete(job); this.drain(); }
        },
      };
      request.signal.addEventListener('abort', abort, { once: true });
      removeTimer = this.time.schedule(() => { job.settle('deadline'); this.drain(); }, Math.max(0, request.deadline - now));
      this.queue.push(job); this.drain();
    });
  }
  private drain(): void {
    while (!this.disposed && this.active.size < this.limits.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      const failure = this.failure(job.request);
      if (failure) { job.settle(failure); continue; }
      this.active.add(job); void job.execute();
    }
  }
  /** Host notification invalidates pending work; silent changes are rechecked at completion. */
  revalidate(): void {
    for (const job of [...this.active, ...this.queue]) { const failure = this.failure(job.request); if (failure) job.settle(failure); }
    this.drain();
  }
  cancel(): void { for (const job of [...this.active, ...this.queue]) job.settle('cancelled'); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const job of [...this.active, ...this.queue]) job.settle('disposed'); }
}
