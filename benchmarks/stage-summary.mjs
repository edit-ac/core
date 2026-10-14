import { attributionVersion, rawOperations } from './attribution.mjs';

const expected = ['engine.prepare', 'engine.commit', 'engine.patch', 'ffi.prepare', 'ffi.commit', 'ffi.take_patch',
  'sdk.prepare', 'sdk.commit', 'sdk.patch', 'render.patch'];
const allowed = new Set(['render.patch', 'render.resume', ...rawOperations.map(k => `engine.${k === 'take_patch' ? 'patch' : k}`),
  ...rawOperations.map(k => `ffi.${k}`), ...['prepare', 'commit', 'read', 'patch', 'anchor', 'resolve', 'can', 'releaseAnchor', 'releasePlan', 'history'].map(k => `sdk.${k}`)]);
const parent = operation => operation.startsWith('engine.') ? `ffi.${operation === 'engine.patch' ? 'take_patch' : operation.slice(7)}`
  : operation.startsWith('ffi.') ? `sdk.${({ take_patch: 'patch', release_anchor: 'releaseAnchor', release_plan: 'releasePlan' })[operation.slice(4)] ?? operation.slice(4)}` : null;

export function stageSummary(trace) {
  const valid = (condition, message) => { if (!condition) throw Error(`Invalid stage attribution: ${message}`); };
  valid(trace?.version === attributionVersion && trace.limit === 512 && trace.dropped === 0, 'version/bounds/overflow');
  valid(Number.isFinite(trace.elapsedMs) && trace.elapsedMs > 0 && Array.isArray(trace.spans) && trace.spans.length <= trace.limit, 'window');
  for (const op of expected) valid(trace.spans.some(s => s.operation === op), `missing ${op}`);
  for (const s of trace.spans) {
    valid(allowed.has(s.operation) && Object.keys(s).sort().join() === 'durationMs,operation,startMs', 'unknown operation/payload');
    valid(Number.isFinite(s.startMs) && Number.isFinite(s.durationMs) && s.startMs >= 0 && s.durationMs >= 0
      && s.startMs + s.durationMs <= trace.elapsedMs + 0.001, 'clock');
    const enclosing = parent(s.operation);
    if (enclosing) valid(trace.spans.some(p => p.operation === enclosing && p.startMs <= s.startMs + 0.001
      && p.startMs + p.durationMs + 0.001 >= s.startMs + s.durationMs), `uncontained ${s.operation}`);
  }
  // Assign each interval once; inclusive spans deliberately overlap. Engine
  // includes Rust bridge/JSON work. FFI residual includes generated marshaling;
  // SDK residual includes JS decoding. These are instrumented diagnostic costs.
  const exclusiveMs = { engine: 0, ffi: 0, sdk: 0, render: 0, unattributed: 0 };
  const points = [...new Set([0, trace.elapsedMs, ...trace.spans.flatMap(s => [s.startMs, s.startMs + s.durationMs])])].sort((a, b) => a - b);
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1], right = points[i], midpoint = (left + right) / 2;
    const groups = new Set(trace.spans.filter(s => s.startMs <= midpoint && s.startMs + s.durationMs > midpoint).map(s => s.operation.split('.')[0]));
    const group = ['engine', 'ffi', 'sdk', 'render'].find(g => groups.has(g)) ?? 'unattributed';
    exclusiveMs[group] += right - left;
  }
  valid(exclusiveMs.engine > 0, 'no measured engine duration');
  return { exclusiveMs, elapsedMs: trace.elapsedMs, spanCount: trace.spans.length,
    method: 'exclusive timeline partition; engine includes Rust bridge JSON; no clock/hook overhead subtraction' };
}
