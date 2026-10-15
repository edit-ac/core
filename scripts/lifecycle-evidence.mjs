const require = (ok, message) => { if (!ok) throw Error(message); };
const finite = value => Number.isFinite(value) && value >= 0;
const pin = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bounds = { listeners: 0, observers: 0, workers: 0, timers: 0, frames: 0 };
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
      for (const m of [item.baseline, cycle.memory]) require(m && m.jsHeapUsedBytes > 0 && m.jsHeapTotalBytes >= m.jsHeapUsedBytes && m.nodes > 0 && m.documents > 0 && finite(m.jsEventListeners) && finite(m.at) && m.heap?.usedSize > 0 && finite(m.heap.backingStorageSize), 'Missing raw heap/DOM series');
    }
  }
  return { fixture: item.fixture, preset: item.preset, kind: observation.kind, status: observation.kind === 'memory-plateau' ? 'inconclusive' : 'observed' };
}
export function inspectLifecycles(profile, record) {
  require(profile?.version === 1 && profile.id === 'lifecycle-v1' && profile.cycles === 12 && profile.idleMs === 200 && profile.performanceLimits === null && JSON.stringify(profile.resourceBounds) === JSON.stringify(bounds), 'Unreviewed lifecycle policy drift');
  require(JSON.stringify(profile.fixtures) === '["Task","Long"]' && JSON.stringify(profile.presets) === '["baseline","task"]' && JSON.stringify(profile.requiredObservations) === '["disposal","canceled-transfer","unload","memory-plateau","resources","idle"]', 'Lifecycle matrix drift');
  require(profile.replay === 'positive-paste-undo/cancel-paste/unload-resolver/destroy/late-complete/reopen/destroy/delete-v1' && profile.memoryMethod === 'CDP HeapProfiler.collectGarbage then Performance.getMetrics, Runtime.getHeapUsage and Memory.getDOMCounters; post-disposal; no process/native peak claim', 'Replay/memory method drift');
  require(record?.version === 1 && record.qualification === 'unqualified' && record.metadata?.cpu && record.metadata.memoryBytes > 0 && record.metadata.browser && record.metadata.hostOS && record.metadata.provenance === 'headless-browser-on-host', 'Missing hardware/runtime provenance');
  require(Date.parse(record.metadata.startedAt) > Date.parse(profile.reviewedAt) && record.metadata.replay === profile.replay && record.metadata.memoryMethod === profile.memoryMethod, 'Missing preregistration/runtime method');
  require(record.counts?.executed === 24 && record.counts.passed === 24 && record.counts.failed === 0 && record.counts.skipped === 0 && record.cases?.length === 4 && record.errors?.length === 0, 'Incomplete lifecycle matrix');
  require(record.cleanup?.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved, 'Leaked harness process');
  const keys = new Set(), summaries = [];
  for (const item of record.cases) {
    const key = `${item.fixture}/${item.preset}`;
    require(profile.fixtures.includes(item.fixture) && profile.presets.includes(item.preset) && !keys.has(key), 'Unknown/duplicate fixture/preset'); keys.add(key);
    require(pin(item.fixtureHash) && pin(item.checkpointHash) && item.observations?.length === 6 && new Set(item.observations.map(o => o.kind)).size === 6, 'Missing identity/observation');
    for (const observation of item.observations) summaries.push(inspectLifecycle(profile, item, observation));
  }
  return { status: 'diagnostic', qualification: 'unqualified', summaries, gaps: ['Memory plateau limits unreviewed; GC-assisted JS heap/DOM only', 'Native/process/decoder peak memory and optional runtime not observed', 'Other PRF/accessibility/platform criteria remain open'] };
}
