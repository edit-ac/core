import { safeLink, type AnchorResolution, type Patch, type PrepareRequest, type ProjectedNode, type StableRange } from '@edit-ac/core';
import { ServiceLifecycle, type ServiceScope } from '../services/lifecycle.js';
import type { ExtensionContextV1 } from './authoring.js';

export interface PatternPermissionV1 {
  readonly principal: string; readonly tenant: string; readonly authority: string;
  /** Change on any capability/policy/catalog replacement. */
  readonly revision: string; readonly lookup: boolean; readonly apply: boolean;
}
export interface PatternWindowV1 { readonly text: string; readonly start: number; readonly changedStart: number; readonly changedEnd: number }
export interface PatternMatchV1 { readonly start: number; readonly end: number; readonly text: string }
export type PatternResolutionV1 = { readonly status: 'available'; readonly href: string } | { readonly status: 'replacement'; readonly replacement: string } | { readonly status: 'missing' | 'forbidden' | 'unavailable' };
export type PatternStatusV1 = 'pending' | 'applied' | 'missing' | 'forbidden' | 'unavailable' | 'invalid' | 'stale' | 'cancelled' | 'deadline' | 'saturated' | 'failed';
export interface PatternOptionsV1 {
  /** Trusted synchronous callback; relative UTF-16 coordinates in this bounded window. */
  readonly match: (window: Readonly<PatternWindowV1>) => readonly PatternMatchV1[];
  readonly permission: () => Readonly<PatternPermissionV1>;
  readonly resolve: (request: Readonly<{ text: string; requestId: number; signal: AbortSignal; principal: string; tenant: string; authority: string }>) => PatternResolutionV1 | Promise<PatternResolutionV1>;
  /** Explicit result family; link is the compatibility default. */
  readonly application?: 'link' | 'replacement';
  /** Prepared link application only. Replacement uses the shared formatting route. */
  readonly prepare?: (application: Readonly<{ range: StableRange; text: string; href: string }>) => PrepareRequest;
  readonly paste?: 'ignore' | 'match';
  /** Explicit literal bypass, including host-specific input origins. */
  readonly literal?: (patch: Readonly<Patch>) => boolean;
  readonly onStatus?: (status: PatternStatusV1) => void;
  readonly contextUtf16?: number; readonly maxMatches?: number; readonly concurrency?: number;
  readonly queue?: number; readonly timeoutMs?: number; readonly cacheEntries?: number; readonly cacheMs?: number;
}
export interface PatternControllerV1 { invalidate(): void; dispose(): void; readonly state: Readonly<{ pending: number; active: number; queued: number; cached: number; windows: number; examinedRuns: number; requests: number }> }
export interface PatternPorts {
  readonly identity: string; readonly session: string;
  generation(): number;
  available(): boolean;
  capture(owner: string, start: number, end: number): { range: StableRange; dispose(): void } | undefined;
  resolve(anchor: StableRange['anchor']): AnchorResolution;
  read(owner: string, start: number, end: number): string | undefined;
}
/** Read only a bounded committed projection. Oversized/ambiguous projections fail closed.
 * At most 128 runs are examined; no document read, DOM parsing or second source model. */
export function patternText(node: ProjectedNode, start: number, end: number, exclude = true): string | undefined {
  if (node.kind !== 'block' || node.runs.length > 128 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 4096) return;
  if (Array.isArray(node.blockAttributes) && node.blockAttributes[0] === 'code') return;
  if (node.blockAttributes && typeof node.blockAttributes === 'object' && !Array.isArray(node.blockAttributes) && node.blockAttributes.type === 'code') return;
  let offset = 0, text = '';
  for (const run of node.runs) {
    const next = offset + run.text.length;
    if (offset < end && next > start) {
      if (exclude) {
        if (run.attributes.code || run.attributes.link) return;
        let keys = 0; for (const key in run.attributes) if (++keys > 64 || key.startsWith('module:')) return;
      }
      text += run.text.slice(Math.max(0, start - offset), Math.min(run.text.length, end - offset));
    }
    offset = next;
  }
  return end <= offset ? text : undefined;
}
const integer = (value: number | undefined, fallback: number, min: number, max: number) => {
  const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('Invalid pattern resource limit'); return n;
};
let sequence = 0;
export function attachPatternMatching(options: PatternOptionsV1, context: ExtensionContextV1, ports: PatternPorts): PatternControllerV1 {
  if (!options || typeof options.match !== 'function' || typeof options.resolve !== 'function' || typeof options.permission !== 'function' || (options.paste !== undefined && !['ignore','match'].includes(options.paste))) throw Error('Invalid pattern hooks/paste policy');
  if (['prepare','literal','onStatus'].some(key => { const callback = options[key as 'prepare' | 'literal' | 'onStatus']; return callback !== undefined && typeof callback !== 'function'; })) throw Error('Invalid optional pattern hook');
  if ((options.application !== undefined && !['link','replacement'].includes(options.application)) || (options.application === 'replacement' && options.prepare)) throw Error('Invalid pattern application family');
  options = Object.freeze({ ...options });
  const radius = integer(options.contextUtf16, 128, 1, 1024), matches = integer(options.maxMatches, 8, 1, 32);
  const concurrency = integer(options.concurrency, 4, 1, 8), queue = integer(options.queue, 16, 0, 32);
  const timeout = integer(options.timeoutMs, 5000, 1, 30000), entries = integer(options.cacheEntries, 32, 0, 64), ttl = integer(options.cacheMs, 5000, 1, 300000);
  const pending = new Map<string, { abort: AbortController; text: string; permission: string; target: NonNullable<ReturnType<PatternPorts['capture']>> }>();
  const cache = new Map<string, { value: PatternResolutionV1; expires: number }>();
  let permissionSequence = 0, lastPermission = '';
  let disposed = false, epoch = 0, requestId = 0, ticket = 0, windows = 0, examinedRuns = 0, requests = 0, applying = false, cacheScope = '';
  const id = `pattern-${++sequence}`;
  const permission = () => {
    const p = options.permission();
    if (!p || ![p.principal,p.tenant,p.authority,p.revision].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(v)) || typeof p.lookup !== 'boolean' || typeof p.apply !== 'boolean') throw Error('Invalid pattern permission');
    return Object.freeze({ ...p });
  };
  const scope = (): ServiceScope => {
    const p = permission();
    const signature = JSON.stringify([p.principal,p.tenant,p.authority,p.revision,ports.generation()]);
    if (signature !== lastPermission) { lastPermission = signature; permissionSequence++; }
    return { document: ports.identity, session: ports.session, revision: `${id}:${epoch}`, permission: String(permissionSequence), authorized: !disposed && !context.signal.aborted && p.lookup && p.apply && ports.available() };
  };
  const service = new ServiceLifecycle(scope, { concurrency, queue, bytes: 8192, items: 1, deadlineMs: timeout });
  const status = (value: PatternStatusV1) => { if (!disposed && !context.signal.aborted) try { options.onStatus?.(value); } catch { /* transient host presentation cannot affect application */ } };
  const invalidate = () => {
    epoch++; cache.clear(); const jobs = [...pending.values()]; pending.clear();
    for (const job of jobs) { job.abort.abort(); job.target.dispose(); } service.cancel();
  };
  const current = (range: StableRange, text: string) => {
    const a = ports.resolve(range.anchor), b = ports.resolve(range.focus);
    return a.type === 'position' && b.type === 'position' && a.node === b.node && a.offset <= b.offset && ports.read(a.node, a.offset, b.offset) === text;
  };
  const resolve = async (owner: string, start: number, match: PatternMatchV1) => {
    let captured: ServiceScope, principal: PatternPermissionV1;
    try { principal = permission(); captured = scope(); } catch { status('forbidden'); return; }
    if (!captured.authorized) return;
    const scopeKey = captured.permission;
    if (cacheScope !== scopeKey) { cache.clear(); cacheScope = scopeKey; }
    // Deduplicate by current engine-owned positions, including after rebasing.
    for (const job of pending.values()) {
      if (job.abort.signal.aborted || job.permission !== scopeKey || job.text !== match.text) continue;
      const a = ports.resolve(job.target.range.anchor), b = ports.resolve(job.target.range.focus);
      if (a.type === 'position' && b.type === 'position' && a.node === owner && b.node === owner && a.offset === start && b.offset === start + match.text.length) return;
    }
    const key = String(++ticket);
    if (pending.size >= concurrency + queue) { status('saturated'); return; }
    const target = ports.capture(owner, start, start + match.text.length); if (!target) return;
    const abort = new AbortController(), job = { abort, target, text: match.text, permission: scopeKey }; pending.set(key, job);
    const cacheKey = JSON.stringify([scopeKey,match.text]);
    try {
      status('pending');
      if (service.check(captured) || abort.signal.aborted) return;
      const cached = cache.get(cacheKey);
      if (cached && cached.expires <= performance.now()) cache.delete(cacheKey);
      const result = await service.run({ scope: captured, bytes: match.text.length * 2, items: 1, signal: abort.signal, deadline: performance.now() + timeout }, signal => {
        if (cached && cached.expires > performance.now()) return cached.value;
        requests++; return options.resolve(Object.freeze({ text: match.text, requestId: ++requestId, signal, principal: principal.principal, tenant: principal.tenant, authority: principal.authority }));
      });
      if (result.status !== 'ready') { status(result.status === 'provider-failed' ? 'failed' : result.status === 'deadline' || result.status === 'saturated' ? result.status : 'cancelled'); return; }
      const raw = result.value;
      // Copy only bounded admitted fields. Never retain private descriptions/errors.
      let value: PatternResolutionV1;
      if (raw?.status === 'available') {
        if (options.application === 'replacement' || typeof raw.href !== 'string' || raw.href.length > 2048 || !safeLink(raw.href) || !/^https?:\/\//i.test(raw.href) || new URL(raw.href).username || new URL(raw.href).password) { status('invalid'); return; }
        value = Object.freeze({ status: 'available', href: safeLink(raw.href)! });
      } else if (raw?.status === 'replacement') {
        if (options.application !== 'replacement' || typeof raw.replacement !== 'string' || !raw.replacement.length || raw.replacement.length > 256 || /[\u0000-\u001f\u007f]/u.test(raw.replacement)) { status('invalid'); return; }
        value = Object.freeze({ status: 'replacement', replacement: raw.replacement });
      } else if (raw && ['missing','forbidden','unavailable'].includes(raw.status)) value = Object.freeze({ status: raw.status }) as PatternResolutionV1;
      else { status('invalid'); return; }
      if (service.check(captured) || abort.signal.aborted || !current(target.range, match.text)) { status('stale'); return; }
      if (entries) { cache.delete(cacheKey); cache.set(cacheKey, { value, expires: performance.now() + (value.status === 'available' ? ttl : Math.min(ttl,250)) }); while (cache.size > entries) cache.delete(cache.keys().next().value!); }
      if (value.status !== 'available' && value.status !== 'replacement') { status(value.status); return; }
      const request = value.status === 'replacement' ? context.replacement(target.range, value.replacement) : options.prepare ? options.prepare(Object.freeze({ range: Object.freeze({ ...target.range }), text: match.text, href: value.href })) :
        { kind: 'format' as const, origin: `extension:${id}`, marks: [{ range: target.range, mark: 'link' as const, action: 'apply' as const, href: value.href }], blocks: [] };
      // Host prepare may reenter permission, edits, invalidation or teardown.
      if (service.check(captured) || abort.signal.aborted || !current(target.range, match.text) || !context.can(request)) { status('stale'); return; }
      applying = true;
      try { context.commit(request); } finally { applying = false; }
      status('applied');
    } catch { status('failed'); }
    finally { if (pending.get(key) === job) pending.delete(key); abort.abort(); target.dispose(); }
  };
  const subscription = context.subscribe({ kinds: ['Text','Editor','Format','Structure','Remote','Undo','Redo'] }, event => {
    if (event.type !== 'patch' || disposed || applying) return;
    const patch = event.patch;
    if (patch.operation === 'Undo' || patch.operation === 'Redo') { invalidate(); return; }
    if (patch.touchedRanges.length > 8 || patch.nodes.length > 64) { invalidate(); return; }
    // Invalidate intersecting edits even if the source is restored before a promise settles.
    for (const job of pending.values()) {
      if (job.abort.signal.aborted) continue;
      const a = ports.resolve(job.target.range.anchor), b = ports.resolve(job.target.range.focus);
      if (a.type !== 'position' || b.type !== 'position' || a.node !== b.node || a.offset >= b.offset) { job.abort.abort(); continue; }
      const changed = patch.nodes.find(entry => entry.type === 'visible' && entry.node.id === a.node);
      // Use this patch's committed projection, not the renderer (which may still
      // be delivering this patch). Remote touched ranges can be conservative.
      if (changed?.type === 'visible') {
        if (patternText(changed.node,a.offset,b.offset) !== job.text) job.abort.abort();
      } else if (patch.nodes.some(entry => entry.type === 'removed' && entry.id === a.node) || patch.touchedRanges.some(r => r.source === a.source && r.start < b.sourceOffset && Math.max(r.newEnd,r.oldEnd) > a.sourceOffset)) job.abort.abort();
    }
    service.revalidate();
    if (!['Text','Editor'].includes(patch.operation) || patch.projectionError || patch.nodes.length > 64 || patch.touchedRanges.length > 8 || !scope().authorized) return;
    const origin = patch.origin.startsWith('editac:local:') ? patch.origin.slice('editac:local:'.length) : '';
    // Explicit literal paste must never start optional asynchronous enrichment.
    if (origin.startsWith('clipboard:literal:')) return;
    const paste = origin.startsWith('clipboard:');
    if (!(paste ? options.paste === 'match' : origin.startsWith('text-input:')) || options.literal?.(patch)) return;
    for (const change of patch.touchedRanges) {
      for (const entry of patch.nodes) {
        if (entry.type !== 'visible' || entry.node.spans.length > 128 || entry.node.runs.length > 128) continue;
        const node = entry.node;
        let base = 0;
        for (const span of node.spans) {
          const length = span.end - span.start;
          if (span.source === change.source && change.newStart >= span.start && change.newEnd <= span.end) {
            const from = base + change.newStart - span.start, to = base + change.newEnd - span.start;
            const start = Math.max(base, from - radius), end = Math.min(base + length,to + radius);
            if (end - start > radius * 2 + radius || end <= start) break;
            const text = patternText(node,start,end,false); examinedRuns += node.runs.length;
            if (text === undefined) break;
            windows++;
            const found = options.match(Object.freeze({ text, start, changedStart: from - start, changedEnd: to - start }));
            if (!Array.isArray(found) || found.length > matches) break;
            for (const match of found) {
              if (!match || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) || match.start < 0 || match.end <= match.start || match.end > text.length || typeof match.text !== 'string' || match.text !== text.slice(match.start,match.end) || match.end < from - start || match.start > to - start) continue;
              if (patternText(node,start + match.start,start + match.end) !== match.text) continue;
              void resolve(node.id,start + match.start,Object.freeze({ ...match }));
            }
            break;
          }
          base += length;
        }
      }
    }
  });
  const dispose = () => { if (disposed) return; disposed = true; invalidate(); subscription.dispose(); service.dispose(); };
  context.cleanup(dispose);
  return Object.freeze({ invalidate, dispose, get state() { return Object.freeze({ pending: pending.size, ...service.state, cached: cache.size, windows, examinedRuns, requests }); } });
}
