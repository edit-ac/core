// Observation only: the derivative retains packed SDK/storage/renderer classes.
// Internal attribution swaps only the declared opt-in fitness WASM/glue.
// The existing callback probe observes renderer work in the derivative only.
// No fixture runtime, production hooks or payload capture.
const phases = ['baseline', 'stage', 'projection', 'planning', 'validation', 'size', 'encoding'].map(p => `engine.editor.${p}`);
const internal = ['engine.prepare', ...phases, 'engine.editor.textSize'];
const operations = ['storage.command', 'storage.commitPrepared', 'ffi.prepare', 'ffi.commit', 'ffi.take_patch', 'render.patch'];
export function installCommandAttribution(sdk, clock = () => performance.now()) {
  if (!sdk.diagnosticEngine) return null;
  let active;
  const record = (operation, start, end) => {
    if (!active) return;
    if (active.spans.length === 64) { active.dropped++; return; }
    active.spans.push({ operation, startMs: start - active.start, durationMs: end - start });
  };
  globalThis.__editacFitnessNow = clock;
  globalThis.__editacFitnessStage = (operation, start, end) => {
    if (operation === 'engine.prepare' || operation.startsWith('engine.editor.')) record(operation, start, end);
  };
  const wrap = (prototype, method, operation) => {
    const original = prototype[method];
    if (typeof original !== 'function') throw Error(`Missing packed boundary: ${operation}`);
    prototype[method] = function(...args) {
      if (!active) return original.apply(this, args);
      const start = clock();
      try { return original.apply(this, args); } finally { record(operation, start, clock()); }
    };
  };
  for (const method of ['prepare', 'commit', 'take_patch']) wrap(sdk.diagnosticEngine.prototype, method, `ffi.${method}`);
  wrap(sdk.diagnosticStorage.prototype, 'commit', 'storage.command');
  wrap(sdk.diagnosticStorage.prototype, 'commitPrepared', 'storage.commitPrepared');
  globalThis.__editacFitnessMeasure = (operation, action) => {
    if (!active || operation !== 'render.patch') return action();
    const start = clock();
    try { return action(); } finally { record(operation, start, clock()); }
  };
  return {
    begin() { if (active) throw Error('Nested command window'); active = { start: clock(), spans: [], dropped: 0 }; },
    end() {
      if (!active) throw Error('Missing command window');
      const trace = { version: 'packed-command-v1', elapsedMs: clock() - active.start, dropped: active.dropped, spans: active.spans };
      active = undefined; summarizeCommand(trace); return trace;
    },
  };
}

export function summarizeCommand(trace) {
  const check = (ok, reason) => { if (!ok) throw Error(`Invalid packed command: ${reason}`); };
  check(trace?.version === 'packed-command-v1' && Object.keys(trace).sort().join() === 'dropped,elapsedMs,spans,version' && trace.dropped === 0 && Number.isFinite(trace.elapsedMs) && trace.elapsedMs > 0 && Array.isArray(trace.spans) && trace.spans.length <= 64, 'identity/window/bounds');
  for (const op of operations) check(trace.spans.filter(s => s.operation === op).length === 1, `missing/duplicate ${op}`);
  const engine = trace.spans.some(s => s.operation === 'engine.prepare');
  if (engine) {
    for (const op of ['engine.prepare', ...phases]) check(trace.spans.filter(s => s.operation === op).length === 1, `missing/duplicate ${op}`);
    for (let i = 1; i < phases.length; i++) {
      const a = trace.spans.find(s => s.operation === phases[i-1]), b = trace.spans.find(s => s.operation === phases[i]);
      check(a.startMs + a.durationMs <= b.startMs + .001, 'overlapping engine phases');
    }
  }
  for (const s of trace.spans) {
    check((operations.includes(s.operation) || engine && internal.includes(s.operation)) && Object.keys(s).sort().join() === 'durationMs,operation,startMs', 'operation/payload');
    check(Number.isFinite(s.startMs) && s.startMs >= 0 && Number.isFinite(s.durationMs) && s.durationMs >= 0 && s.startMs + s.durationMs <= trace.elapsedMs + .001, 'clock');
    const parent = s.operation === 'engine.prepare' ? 'ffi.prepare' : phases.includes(s.operation) ? 'engine.prepare' : s.operation === 'engine.editor.textSize' ? 'engine.editor.planning' : s.operation === 'storage.command' ? null : s.operation === 'ffi.prepare' || s.operation === 'storage.commitPrepared' ? 'storage.command' : 'storage.commitPrepared';
    if (parent) check(trace.spans.some(p => p.operation === parent && p.startMs <= s.startMs + .001 && p.startMs + p.durationMs + .001 >= s.startMs + s.durationMs), 'orphan boundary');
  }
  const textSizes = trace.spans.filter(s => s.operation === 'engine.editor.textSize').sort((a,b) => a.startMs-b.startMs);
  for (let i = 1; i < textSizes.length; i++)
    check(textSizes[i-1].startMs + textSizes[i-1].durationMs <= textSizes[i].startMs + .001, 'overlapping text-size observations');
  for (const sequence of [['ffi.prepare', 'storage.commitPrepared'], ['ffi.commit', 'ffi.take_patch', 'render.patch']]) {
    for (let i = 1; i < sequence.length; i++) {
      const a = trace.spans.find(s => s.operation === sequence[i-1]), b = trace.spans.find(s => s.operation === sequence[i]);
      check(a.startMs + a.durationMs <= b.startMs + .001, 'overlapping/reordered synchronous boundaries');
    }
  }
  const exclusiveMs = Object.fromEntries([...operations, ...(engine ? internal : []), 'other'].map(op => [op, 0]));
  const points = [...new Set([0, trace.elapsedMs, ...trace.spans.flatMap(s => [s.startMs, s.startMs + s.durationMs])])].sort((a,b) => a-b);
  const priority = [...(engine ? ['engine.editor.textSize', ...phases, 'engine.prepare'] : []), 'render.patch', 'ffi.prepare', 'ffi.commit', 'ffi.take_patch', 'storage.commitPrepared', 'storage.command'];
  for (let i = 1; i < points.length; i++) {
    const middle = (points[i-1] + points[i]) / 2;
    const op = priority.find(op => trace.spans.some(s => s.operation === op && s.startMs <= middle && s.startMs + s.durationMs > middle)) ?? 'other';
    exclusiveMs[op] += points[i] - points[i-1];
  }
  return { elapsedMs: trace.elapsedMs, exclusiveMs, scope: 'instrumented packed derivative; optional internal fitness spans include clock/observation overhead; FFI residual includes generated marshalling and Rust bridge; engine phases retain their nested work; storage residual includes SDK JSON/observers; no overhead subtraction or compositor claim' };
}
