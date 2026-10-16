export const startupNames = ['recovery.begin','recovery.runtime','recovery.checkpointOpen','recovery.journalOpen','checkpoint.read','checkpoint.entries','checkpoint.validated','writer.restored','writer.checkpoint','recovery.writerRestore','recovery.lifecycle','surface.begin','render.begin','render.snapshot','render.modules','render.domBegin','render.nodes','render.arranged','render.subscribed','surface.bound','surface.ready','editor.ready','frame.first','frame.second'];
// Reuse an observed metric's clock when bookkeeping happens after its boundary.
// Any delay remains in the following interval; navigation totals never shrink.
export function navigationPhases(clock = () => performance.now()) {
  const phases = [];
  let boundary = 0;
  return { phases, phase(name, endMs = clock()) {
    if (!Number.isFinite(endMs) || endMs < boundary) throw Error('Invalid navigation clock');
    phases.push({ name, startMs: boundary, endMs, durationMs: endMs - boundary });
    boundary = endMs;
  } };
}
export function inspectStartup(trace) {
  const check = (ok, reason) => { if (!ok) throw Error(`Invalid startup attribution: ${reason}`); };
  check(trace?.version === 'packed-startup-v1' && Object.keys(trace).sort().join() === 'elapsedMs,frameTiming,frames,marks,startMs,version', 'identity/payload');
  check(Number.isFinite(trace.startMs) && trace.startMs >= 0, 'start');
  check(['long-animation-frame','unavailable'].includes(trace.frameTiming) && Array.isArray(trace.frames) && trace.frames.length <= 32 && (trace.frameTiming !== 'unavailable' || trace.frames.length === 0), 'frame evidence');
  for (const frame of trace.frames) {
    check(Object.keys(frame).sort().join() === 'blockingDuration,duration,renderStart,startTime,styleAndLayoutStart', 'frame payload');
    check(Object.values(frame).every(v => Number.isFinite(v) && v >= 0) && frame.duration > 0 && frame.blockingDuration <= frame.duration, 'frame clocks');
    check(frame.startTime <= trace.startMs + trace.elapsedMs && frame.startTime + frame.duration >= trace.startMs, 'outside startup frame');
    check(frame.renderStart === 0 || frame.renderStart >= frame.startTime && frame.renderStart <= frame.startTime + frame.duration + 1, 'render clock');
    check(frame.styleAndLayoutStart === 0 || frame.styleAndLayoutStart >= frame.renderStart && frame.styleAndLayoutStart <= frame.startTime + frame.duration + 1, 'layout clock');
  }
  check(Number.isFinite(trace.elapsedMs) && trace.elapsedMs > 0, 'window');
  check(JSON.stringify(trace.marks?.map(m => m.name)) === JSON.stringify(startupNames), 'missing/duplicate/reordered boundary');
  let previous = 0;
  return trace.marks.map(m => {
    check(Object.keys(m).sort().join() === 'elapsedMs,name' && Number.isFinite(m.elapsedMs) && m.elapsedMs >= previous && m.elapsedMs <= trace.elapsedMs, 'clock/payload');
    const durationMs = m.elapsedMs - previous; previous = m.elapsedMs;
    return { name: m.name, durationMs };
  });
}
export function installStartupAttribution(sdk, clock = () => performance.now()) {
  if (!sdk.diagnosticEngine) return null;
  let start, marks, frames, observer, trace;
  const supported = globalThis.PerformanceObserver?.supportedEntryTypes.includes('long-animation-frame') ?? false;
  const collect = entries => {
    for (const entry of entries) {
      if (entry.startTime + entry.duration < start || trace && entry.startTime > trace.startMs + trace.elapsedMs) continue;
      if (frames.length === 32) throw Error('Startup frame overflow');
      frames.push(Object.fromEntries(['startTime','duration','renderStart','styleAndLayoutStart','blockingDuration'].map(key => [key, entry[key]])));
    }
  };
  globalThis.__editacStartupMark = name => {
    if (!marks) return;
    if (marks.length === startupNames.length) throw Error('Startup mark overflow');
    marks.push({ name, elapsedMs: clock() - start });
  };
  return {
    begin() { if (marks) throw Error('Nested startup window'); start = clock(); marks = []; frames = []; trace = undefined; if (supported) { observer = new PerformanceObserver(list => collect(list.getEntries())); observer.observe({ type: 'long-animation-frame' }); } },
    mark(name) { globalThis.__editacStartupMark(name); },
    end() {
      if (!marks) throw Error('Missing startup window');
      trace = { version: 'packed-startup-v1', startMs: start, elapsedMs: clock() - start, marks, frames, frameTiming: supported ? 'long-animation-frame' : 'unavailable' };
      marks = undefined; inspectStartup(trace); return trace;
    },
    // Frame entries can arrive after the second RAF callback. Drain at the
    // existing async flush boundary; no wait is inserted into startup metrics.
    finish() { if (observer) { collect(observer.takeRecords()); observer.disconnect(); observer = undefined; } inspectStartup(trace); },
    dispose() { observer?.disconnect(); observer = undefined; },
  };
}
