/** Opt-in support export. Never serialize provider results, scope, errors or requests.
 * Recovery actions are host guidance, not automatic retries or semantic mutations. */
import type { ServiceLifecycle, ServiceRequest, ServiceResult } from './lifecycle.js';
export type DiagnosticSource = 'resolver' | 'converter' | 'host';
export type RecoveryAction = 'none' | 'reduce-input' | 'wait-capacity' | 'stop' | 'retry-bounded' | 'refresh-derived' | 'reopen-session' | 'reauthorize';
export interface DiagnosticFailure { readonly code: string; readonly recovery: RecoveryAction }
/** Return owned literal strings even when an untyped host supplies an arbitrary value. */
export function serviceDiagnostic(status: unknown): DiagnosticFailure {
  switch (status) {
    case 'ready': return { code: 'none', recovery: 'none' };
    case 'invalid': return { code: 'invalid', recovery: 'reduce-input' };
    case 'resource-limit': return { code: 'resource-limit', recovery: 'reduce-input' };
    case 'saturated': return { code: 'saturated', recovery: 'wait-capacity' };
    case 'cancelled': return { code: 'cancelled', recovery: 'stop' };
    case 'disposed': return { code: 'disposed', recovery: 'stop' };
    case 'deadline': return { code: 'deadline', recovery: 'retry-bounded' };
    case 'stale-revision': return { code: 'stale-revision', recovery: 'refresh-derived' };
    case 'replaced-session': return { code: 'replaced-session', recovery: 'reopen-session' };
    case 'permission-loss': return { code: 'permission-loss', recovery: 'reauthorize' };
    default: return { code: 'provider-failed', recovery: 'retry-bounded' };
  }
}
export const DIAGNOSTIC_LIMITS = Object.freeze({ events: 64, elapsedMs: 86_400_000, count: 4096 });
const bounded = (value: unknown, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
interface Event { operation: number; source: DiagnosticSource; error: string; recovery: RecoveryAction; elapsedMs: number; active: number; queued: number; disposed: boolean }
export class SupportDiagnostics {
  private readonly events: Event[] = [];
  private next = 0;
  private dropped = 0;
  record(source: DiagnosticSource, status: unknown, elapsedMs = 0, state: Readonly<{ active: number; queued: number; disposed: boolean }> = { active: 0, queued: 0, disposed: false }): number {
    const failure = serviceDiagnostic(status);
    this.next = Math.min(Number.MAX_SAFE_INTEGER, this.next + 1);
    if (this.events.length === DIAGNOSTIC_LIMITS.events) { this.events.shift(); this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1); }
    this.events.push({ operation: this.next, source: source === 'resolver' ? 'resolver' : source === 'converter' ? 'converter' : 'host', error: failure.code, recovery: failure.recovery, elapsedMs: bounded(elapsedMs, DIAGNOSTIC_LIMITS.elapsedMs), active: bounded(state.active, DIAGNOSTIC_LIMITS.count), queued: bounded(state.queued, DIAGNOSTIC_LIMITS.count), disposed: state.disposed === true });
    return this.next;
  }
  export(): string { return JSON.stringify({ version: 1, dropped: this.dropped, events: this.events }); }
}
/** Actual lifecycle admission/cancellation/revalidation remains authoritative. The wrapper
 * returns the exact derived result to its caller; only allowlisted metadata enters support. */
export async function runWithDiagnostics<T>(log: SupportDiagnostics, source: DiagnosticSource, service: ServiceLifecycle, request: ServiceRequest, provider: (signal: AbortSignal) => T | Promise<T>, now: () => number = () => performance.now()): Promise<ServiceResult<T>> {
  const start = now();
  const result = await service.run(request, provider);
  log.record(source, result.status, now() - start, service.state);
  return result;
}
