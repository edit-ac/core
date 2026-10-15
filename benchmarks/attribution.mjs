// Benchmark-only, bounded numeric trace. No document/provider payload is accepted.
export const attributionVersion = 'wasm-bridge-render-v1';
const limit = 512;
export const rawOperations = ['prepare', 'commit', 'read', 'take_patch', 'anchor', 'resolve', 'can', 'history', 'release_anchor', 'release_plan'];
const operations = new Set(['render.patch', 'render.resume', ...rawOperations.map(k => `engine.${k === 'take_patch' ? 'patch' : k}`),
  ...rawOperations.map(k => `ffi.${k}`),
  ...['prepare', 'commit', 'read', 'patch', 'anchor', 'resolve', 'can', 'releaseAnchor', 'releasePlan', 'history'].map(k => `sdk.${k}`)]);

export function createAttribution(clock = () => performance.now()) {
  let active;
  const record = (operation, start, end) => {
    if (!active || !operations.has(operation)) return;
    if (active.spans.length === limit) { active.dropped++; return; }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < active.start || end < start) throw Error('Invalid stage clock');
    active.spans.push({ operation, startMs: start - active.start, durationMs: end - start });
  };
  return {
    clock, record,
    measure(operation, action) {
      if (!active) return action();
      const start = clock();
      try { return action(); } finally { record(operation, start, clock()); }
    },
    begin() {
      if (active) throw Error('Nested attribution window');
      active = { start: clock(), spans: [], dropped: 0 };
    },
    end() {
      if (!active) throw Error('Missing attribution window');
      const trace = { version: attributionVersion, limit, dropped: active.dropped,
        elapsedMs: clock() - active.start, spans: active.spans };
      active = undefined;
      return trace;
    },
  };
}

export function installAttribution(host = globalThis) {
  const collector = createAttribution();
  host.__editacFitnessNow = collector.clock;
  host.__editacFitnessStage = collector.record;
  host.__editacFitnessMeasure = collector.measure;
  return collector;
}
