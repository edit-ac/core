import { validateBaselinePolicy } from './architecture-budgets.mjs';
import { gestureVersion } from '../benchmarks/gesture-trace.mjs';
const require = (ok, message) => { if (!ok) throw Error(message); };
const finite = x => Number.isFinite(x) && x >= 0;
const pin = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
// Reuse the reviewed fitness policy contract with this producer's record shape.
export function validateGesturePolicy(profile, record) {
  validateBaselinePolicy(profile, {
    metadata: { ...record.metadata, timestamp: record.metadata?.startedAt },
    artifactInputs: record.artifacts,
  });
}
export function inspectGestures(profile, record) {
  require(profile?.version === 1 && profile.id === 'prf-02-diagnostics-v2' && profile.performanceLimits === null, 'Unknown gesture diagnostic profile');
  require(JSON.stringify(profile.fixtures) === '["Task","Long"]' && JSON.stringify(profile.presets) === '["baseline","task"]'
    && JSON.stringify(profile.gestures) === '["selection","drag","autoscroll","autoscroll-code"]' && profile.pointerSteps === 120
    && profile.traceCapacity === 2048 && profile.settleFrames === 24 && profile.autoscrollSetup === 'full-corpus-end-boundary-320px-v1'
    && JSON.stringify(profile.autoscrollModifiers) === '[]' && profile.endpointMethod === 'integral-exact-caret-v1', 'Gesture matrix/method drift');
  require(record?.version === gestureVersion && record.qualification === 'unqualified', 'Unsupported gesture scope');
  require(record.metadata?.cpu && record.metadata.memoryBytes > 0 && record.metadata.browser && record.metadata.hostOS
    && record.metadata.provenance === 'headless-browser-on-host', 'Missing runtime/hardware provenance');
  require(Date.parse(record.metadata.startedAt) > Date.parse(profile.reviewedAt), 'Profile not fixed before measurement');
  require(record.counts?.executed === 16 && record.counts.passed === 16 && record.counts.failed === 0 && record.counts.skipped === 0, 'Incomplete gesture matrix');
  require(record.cleanup?.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved, 'Leaked gesture runtime');
  require(record.cases?.length === 4, 'Missing fixture/preset matrix');
  const keys = new Set(), summaries = [];
  for (const item of record.cases) {
    const key = `${item.fixture}/${item.preset}`;
    require(profile.fixtures.includes(item.fixture) && profile.presets.includes(item.preset) && !keys.has(key), 'Unknown/duplicate fixture/preset'); keys.add(key);
    require(pin(item.checkpointHash) && pin(item.fixtureHash) && pin(item.semanticHash) && item.chars > 0 && item.blocks > 0, 'Missing fixture identities');
    require(item.refreshTimestamps?.length === 32 && item.refreshTimestamps.every((n, i, a) => finite(n) && (!i || n > a[i - 1])), 'Missing actual refresh observations');
    require(item.teardown?.editable === 'false' && item.teardown.traceActive === false, 'Editor teardown incomplete');
    require(item.gestures?.length === 4, 'Missing gesture');
    const kinds = new Set();
    for (const trace of item.gestures) {
      require(profile.gestures.includes(trace.kind) && !kinds.has(trace.kind), 'Duplicate/unknown gesture'); kinds.add(trace.kind);
      summaries.push(inspectGesture(profile, item, trace));
    }
  }
  return { status: 'diagnostic', qualification: 'unqualified', summaries,
    gaps: ['Gesture-specific performance thresholds unreviewed', 'Browser-internal hit-test work/compositor presentation unobserved', 'Other PRF-01–07/accessibility and target-platform evidence remains required'] };
}

export function inspectGesture(profile, item, trace) {
      require(trace.version === gestureVersion && trace.observer === 'supported' && trace.dropped === 0, 'Missing/overflowed observer');
      require(trace.frames?.length >= profile.pointerSteps && trace.frames.length <= profile.traceCapacity, 'Missing frame trace');
      require(trace.start < trace.end && trace.frames.every((f, i, a) => finite(f.timestamp) && finite(f.callbackTime) && f.callbackTime >= trace.start && f.callbackTime <= trace.end && f.timestamp <= trace.end
        && (!i || f.timestamp > a[i - 1].timestamp) && ['geometry', 'mapping', 'positions', 'visitedPositions', 'fullScan'].every(k => Number.isSafeInteger(f[k]) && f[k] >= 0)
        && finite(f.scroll?.inner) && finite(f.scroll?.outer)), 'Invalid frame/work samples');
      require(trace.trailingWork && Object.values(trace.trailingWork).every(finite), 'Missing trailing work');
      require(Array.isArray(trace.longTasks) && trace.longTasks.every(e => finite(e.start) && e.duration >= 50), 'Invalid/missing long-task evidence');
      require(trace.events?.length > 0 && trace.events.every(e => e.trusted === true && finite(e.timestamp)), 'Synthetic/missing gesture input');
      for (const type of ['pointerdown', 'pointermove']) require(trace.events.some(e => e.type === type), `Missing trusted ${type}`);
      require((trace.kind === 'drag' || trace.events.some(e => e.type === 'keydown')) && trace.cancel?.escape && trace.cancel?.mouseReleased, 'Missing cancellation');
      require(trace.unchanged === true && trace.collectorActive === false && trace.pendingCollectorFrames === 0, 'Mutation or collector leak');
      require(JSON.stringify(trace.settled) === JSON.stringify(trace.afterCancel), 'Cancellation did not settle selection/scroll');
      if (trace.kind !== 'drag') require(trace.frames.some(f => f.mapping > 0), 'Gesture missed application selection mapping');
      require(trace.endpointDropped === 0 && trace.nativeEndpoints?.length > 0 && trace.nativeEndpoints.length <= profile.traceCapacity && trace.nativeEndpoints.every(e => e.trusted && Number.isInteger(e.x) && Number.isInteger(e.y)), 'Missing dispatched native endpoint evidence');
      const down = trace.nativeEndpoints.find(e => e.type === 'mousedown');
      require(down && down.x === trace.setup.start.x && down.y === trace.setup.start.y
        && JSON.stringify(down.hit) === JSON.stringify(trace.setup.start.endpoint), 'Dispatched caret differs from independent setup oracle');
      if (trace.kind !== 'drag') require(trace.afterDown?.anchorMatches && trace.endpointOracle?.anchorMatches, 'Native pointer anchor mismatch');
      if (trace.kind === 'selection') require(trace.endpointOracle.focusMatches && trace.endpointOracle.expectedLength === trace.endState.selection.length, 'Native range differs from independent DOM Range oracle');
      if (trace.kind === 'selection') require(trace.endState.selection.inside && !trace.endState.selection.collapsed && trace.endState.selection.length > 0, 'No continuous selection');
      if (trace.kind === 'drag') require(trace.events.some(e => e.type === 'dragstart') && trace.events.some(e => e.type === 'dragend' && e.dropEffect === 'none') && !trace.events.some(e => e.type === 'drop'), 'No canceled native text drag');
      if (trace.kind.startsWith('autoscroll')) require(trace.setup?.initialScroll && trace.endState.scroll.inner > trace.setup.initialScroll.inner
        && trace.endState.scroll.outer > trace.setup.initialScroll.outer && trace.events.some(e => e.type === 'scroll'), 'No nested native autoscroll');
      const total = metric => trace.frames.reduce((n, f) => n + f[metric], trace.trailingWork[metric]);
      require(total('fullScan') === 0, 'Full-document mapping fallback during pointer gesture');
      return { fixture: item.fixture, preset: item.preset, kind: trace.kind, frames: trace.frames.length,
        longTasks: trace.longTasks.length, maxGeometryCalls: Math.max(...trace.frames.map(f => f.geometry)),
        maxPositionsReturned: Math.max(...trace.frames.map(f => f.visitedPositions)), mappings: total('mapping'), fullScans: total('fullScan'),
        scroll: trace.endState.scroll };
}
