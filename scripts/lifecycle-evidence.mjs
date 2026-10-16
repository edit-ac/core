import { presets } from '../benchmarks/presets.mjs';
import { validateBaselinePolicy } from './architecture-budgets.mjs';
import { inspectProcessMemoryMethod, inspectProcessMemory } from './process-memory-evidence.mjs';
const require = (ok, message) => { if (!ok) throw Error(message); };
const finite = value => Number.isFinite(value) && value >= 0;
const pin = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Lifecycle records retain the shared policy in the same shape as gesture evidence.
export function validateLifecyclePolicy(profile, record) {
  validateBaselinePolicy(profile, {
    metadata: { ...record.metadata, timestamp: record.metadata?.startedAt },
    artifactInputs: record.artifacts,
  });
}
const bounds = { listeners: 0, observers: 0, workers: 0, timers: 0, frames: 0 };
const livePhases = ['before-mount', 'mounted', 'active-transfer', 'feature-unloaded', 'disposed', 'reopened', 'drained'];
const liveMethod = 'CDP phase snapshots without explicit GC; sampled JS heap/backing-storage/DOM high-water only, not process/native or true peak';
function heapSample(m) {
  require(m && ['jsHeapUsedBytes', 'jsHeapTotalBytes', 'nodes', 'documents', 'jsEventListeners', 'at'].every(key => finite(m[key])) && m.jsHeapUsedBytes > 0 && m.jsHeapTotalBytes >= m.jsHeapUsedBytes && m.nodes > 0 && m.documents > 0 && finite(m.heap?.usedSize) && m.heap.usedSize > 0 && finite(m.heap.backingStorageSize), 'Missing raw heap/DOM series');
}
function liveMemory(cycle) {
  require(JSON.stringify(cycle.liveMemory?.map(m => m.phase)) === JSON.stringify(livePhases), 'Missing/reordered live memory phases');
  let previous = -1;
  for (const m of cycle.liveMemory) {
    heapSample(m);
    require(m.collected === false && m.at > previous, 'GC-tainted/reordered live memory clocks'); previous = m.at;
  }
  require(cycle.memory.at > previous && cycle.memory.collected === true, 'Missing post-cycle collected boundary');
  require(cycle.liveMemory[1].nodes > cycle.liveMemory[0].nodes, 'Never observed mounted DOM memory');
  const keys = ['jsHeapUsedBytes', 'nodes', 'documents', 'jsEventListeners', 'backingStorageBytes'];
  require(JSON.stringify(Object.keys(cycle.sampledHighWater ?? {}).sort()) === JSON.stringify([...keys].sort()), 'Missing sampled high-water summary');
  for (const key of keys) require(cycle.sampledHighWater[key] === Math.max(...cycle.liveMemory.map(m => key === 'backingStorageBytes' ? m.heap.backingStorageSize : m[key])), 'Incorrect sampled high-water summary');
}
function resources(value) { require(value && Object.keys(bounds).every(key => value[key] === bounds[key]), 'Leaked live resource'); }
export function inspectLifecycle(profile, item, observation) {
  require(profile.requiredObservations.includes(observation?.kind), 'Unknown lifecycle observation');
  require(item.cycles?.length === profile.cycles && item.cycles.every((cycle, i) => cycle.index === i), 'Missing/reordered lifecycle cycles');
  require(item.errors?.length === 0, 'Browser runtime errors');
  const control = item.probeControl;
  resources(control?.before); resources(control?.drained);
  require(Object.keys(bounds).every(key => control.active?.[key] === 1) && control.polling?.callbacks > control.before.callbacks && control.polling.schedules > control.before.schedules, 'Probe failed executable leak/polling controls');
  for (const cycle of item.cycles) {
    if (observation.kind === 'disposal') {
      require(cycle.initialPreserved && cycle.reopenedPreserved && cycle.databaseDeleted && cycle.unsaved === false && finite(cycle.samples?.mountMs) && finite(cycle.samples.disposeMs), 'Incomplete disposal/storage preservation');
    } else if (observation.kind === 'canceled-transfer') {
      const c = cycle.cancellation;
      require(c?.control === 'committed' && c.state === 'canceled' && c.disposition === 'rejected' && c.reason === 'clipboard-canceled' && c.source && c.recovery && cycle.destroyRecovery && cycle.noLateDOMMutation && cycle.reopenedPreserved && finite(cycle.samples.cancelMs), 'Canceled transfer lost source or mutated document');
    } else if (observation.kind === 'unload') {
      require(cycle.cancellation?.results === 0 && cycle.cancellation.aborted && cycle.phases?.find(p => p.phase === 'feature-unloaded')?.hostListeners === 0, 'Unloaded resolver admitted late result/leaked host subscription');
    } else if (observation.kind === 'resources') {
      require(cycle.phases?.length === 4 && JSON.stringify(cycle.phases.map(p => p.phase)) === '["active-transfer","feature-unloaded","disposed","drained"]', 'Missing raw resource phases');
      require(cycle.phases.every(p => finite(p.at) && Object.keys(bounds).every(k => finite(p[k]))), 'Missing resource samples');
      const active = cycle.phases[0]; require(active.listeners > 0 && active.hostListeners === 1 && active.timers > 0, 'Never observed active lifecycle resources');
      resources(cycle.memory?.resources); require(cycle.phases.at(-1).hostListeners === 0, 'Leaked request subscription');
    } else if (observation.kind === 'idle') {
      require(cycle.idle?.durationMs === profile.idleMs, 'Idle observation window drift');
      resources(cycle.idle.before); resources(cycle.idle.after);
      require(cycle.idle.before.callbacks === cycle.idle.after.callbacks && cycle.idle.before.schedules === cycle.idle.after.schedules, 'Scheduling/callbacks after disposal');
    } else if (observation.kind === 'memory-plateau') {
      require(item.memoryStatus === 'inconclusive', 'Unreviewed memory qualified');
      for (const m of [item.baseline, cycle.memory]) { heapSample(m); require(m.collected === true, 'Missing collected memory boundary'); }
      liveMemory(cycle);
      inspectProcessMemory(cycle.processMemory);
    }
  }
  return { fixture: item.fixture, preset: item.preset, optional: item.optional, kind: observation.kind, status: observation.kind === 'memory-plateau' ? 'inconclusive' : 'observed' };
}
export function inspectLifecycles(profile, record) {
  require(profile?.version === 1 && profile.id === 'lifecycle-v1' && profile.cycles === 12 && profile.idleMs === 200 && profile.performanceLimits === null && JSON.stringify(profile.resourceBounds) === JSON.stringify(bounds), 'Unreviewed lifecycle policy drift');
  require(JSON.stringify(profile.fixtures) === '["Task","Long"]' && JSON.stringify(profile.presets) === '["baseline","task"]' && JSON.stringify(profile.requiredObservations) === '["disposal","canceled-transfer","unload","memory-plateau","resources","idle"]', 'Lifecycle matrix drift');
  require(profile.replay === 'positive-paste-undo/cancel-paste/unload-resolver/destroy/late-complete/reopen/destroy/delete-v1' && profile.memoryMethod === 'CDP HeapProfiler.collectGarbage then Performance.getMetrics, Runtime.getHeapUsage and Memory.getDOMCounters; post-disposal; no process/native peak claim', 'Replay/memory method drift');
  require(profile.liveMemoryMethod === liveMethod && JSON.stringify(profile.liveMemoryPhases) === JSON.stringify(livePhases), 'Live memory method/phase drift');
  require(record?.version === 1 && record.qualification === 'unqualified' && record.metadata?.cpu && record.metadata.memoryBytes > 0 && record.metadata.browser && record.metadata.hostOS && record.metadata.provenance === 'headless-browser-on-host', 'Missing hardware/runtime provenance');
  require(Date.parse(record.metadata.startedAt) > Date.parse(profile.reviewedAt) && record.metadata.replay === profile.replay && record.metadata.memoryMethod === profile.memoryMethod, 'Missing preregistration/runtime method');
  require(record.metadata.liveMemoryMethod === profile.liveMemoryMethod, 'Missing live memory method');
  inspectProcessMemoryMethod(profile, record.metadata.processMemory);
  require(record.artifacts?.['harness/process-memory'] === record.metadata.processMemory.binaryHash, 'Process-memory collector binary mismatch');
  require(Date.parse(record.metadata.startedAt) > Date.parse(profile.processMemoryReviewedAt), 'Process-memory coverage policy not preregistered');
  require(JSON.stringify(profile.optionalProfiles) === '["default","markdown"]' && Date.parse(record.metadata.startedAt) > Date.parse(profile.optionalReviewedAt), 'Optional lifecycle policy not preregistered');
  const optional = record.metadata.optionalLoading;
  require(pin(optional?.receiptHash) && record.artifacts['inputs/optional-loading.json'] === optional.receiptHash, 'Missing optional packed receipt');
  require(record.counts?.executed === 48 && record.counts.passed === 48 && record.counts.failed === 0 && record.counts.skipped === 0 && record.cases?.length === 8 && record.errors?.length === 0, 'Incomplete lifecycle matrix');
  require(record.cleanup?.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved, 'Leaked harness process');
  const keys = new Set(), summaries = [];
  for (const item of record.cases) {
    const key = `${item.fixture}/${item.preset}/${item.optional}`;
    require(profile.fixtures.includes(item.fixture) && profile.presets.includes(item.preset) && profile.optionalProfiles.includes(item.optional) && !keys.has(key), 'Unknown/duplicate fixture/preset/optional profile'); keys.add(key);
    require(pin(item.fixtureHash) && pin(item.checkpointHash) && item.observations?.length === 6 && new Set(item.observations.map(o => o.kind)).size === 6, 'Missing identity/observation');
    require(JSON.stringify(item.features) === JSON.stringify([...presets[item.preset].featureSet, ...(item.optional === 'markdown' ? ['markdown'] : [])]), 'Incorrect enabled feature identity');
    const enabled = item.optional === 'markdown', initialization = item.probeControl?.initialization;
    require(initialization?.optional === item.optional && initialization.enabled === enabled, 'Optional runtime not initialized');
    for (const m of [initialization.before, initialization.after]) { heapSample(m); require(m.collected === false, 'Missing non-GC initialization samples'); }
    require(initialization.after.at > initialization.before.at, 'Reordered initialization samples');
    const packed = optional.profiles?.[item.optional];
    require(packed?.packs?.length === (enabled ? 3 : 2) && packed.assets?.length === (enabled ? 4 : 3), 'Missing exact optional asset/package identities');
    for (const pack of packed.packs) require(pin(pack.sha256) && record.artifacts[`packs/${pack.filename}`] === pack.sha256, 'Packed runtime identity mismatch');
    for (const asset of packed.assets) {
      require(pin(asset.sha256) && record.artifacts[`harness/${item.optional}/${asset.name}`] === asset.sha256, 'Measured runtime asset mismatch');
      require(item.requests?.includes(`/fixture/${item.optional}/${asset.name}`), 'Measured runtime asset never requested');
    }
    require(item.requests.every(path => !path.includes('/wasm/editac_markdown') || enabled), 'Disabled Markdown loaded parser');
    for (const cycle of item.cycles) require(enabled
      ? cycle.markdown?.committed === true && cycle.markdown.bold === true && cycle.markdown.restored === true && typeof cycle.markdown.export === 'string' && cycle.markdown.export.trim() === '**PRF05 😀**'
      : cycle.markdown === undefined, 'Missing/incorrect enabled Markdown parser, clipboard or restoration proof');
    for (const observation of item.observations) summaries.push(inspectLifecycle(profile, item, observation));
  }
  return { status: 'diagnostic', qualification: 'unqualified', summaries, gaps: ['Memory plateau limits unreviewed; no retained-memory qualification', 'Continuous browser-tree samples and OS per-process lifetime footprint maxima are not a simultaneous tree/cycle/JS-allocation peak; optional decoders and native editor runtime not observed', 'Other PRF/accessibility/platform criteria remain open'] };
}
