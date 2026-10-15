const require = (ok, message) => { if (!ok) throw Error(message); };
const finite = x => Number.isFinite(x) && x >= 0;
const pin = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function inspectService(profile, item, o) {
  require(o && profile.requiredObservations.includes(o.kind), 'Unknown observation');
  if (o.kind === 'queue') {
    require(o.states?.length === profile.burst + 4 && o.outcomes?.length === profile.burst, 'Missing raw queue observations');
    require(o.states.every(s => finite(s.at) && s.active >= 0 && s.active <= profile.limits.concurrency && s.queued >= 0 && s.queued <= profile.limits.queue && s.timers <= 3), 'Unbounded service queue/timers');
    const phase = name => o.states.find(s => s.phase === name);
    require(phase('admit-2')?.active === 1 && phase('admit-2').queued === 2, 'Queue never saturated');
    require(phase('queued-cancel')?.queued === 1 && phase('active-cancel-retains-slot')?.active === 1 && phase('active-cancel-retains-slot').providerCalls === 1, 'Cancellation replaced noncooperative work');
    require(phase('drained')?.active === 0 && phase('drained').queued === 0 && phase('drained').timers === 0 && phase('drained').providerCalls === 2, 'Queue failed to drain');
    require(JSON.stringify(o.outcomes.map(r => r.status)) === JSON.stringify(['cancelled', 'cancelled', 'ready', ...Array(profile.burst - 3).fill('saturated')]), 'Dropped/reordered/incorrect terminal outcome');
    require(o.outcomes.every(r => finite(r.elapsedMs)) && JSON.stringify(o.aborts) === '[true,false]', 'Missing cancellation/timing observations');
  } else if (o.kind === 'resolver-storm') {
    require(o.outcomes?.length === profile.burst && o.outcomes.every(r => r.results === 0 && finite(r.elapsedMs)), 'Stale resolver result admitted');
    require(o.peak === profile.resolverLimits.concurrency && o.providerCalls === 2 && o.staleAdmitted === false && o.activeAfter === 0, 'Resolver replacement stampede/leak');
    require(o.stormOutcome === 'saturated' && o.recovered?.results === 1 && finite(o.recovered.elapsedMs), 'Resolver did not recover');
  } else if (o.kind === 'edit-invalidation') {
    require(o.localSamples?.length === profile.localEdits && o.localSamples.every(s => finite(s.elapsedMs)) && finite(o.unrelatedMs), 'Missing edit timings');
    require(o.afterUnrelated?.active === 1 && o.afterUnrelated.queued === 2, 'Unrelated edit invalidated selected-node work');
    require(o.afterSelected?.active === 1 && o.afterSelected.queued === 0 && o.afterSelected.timers === 0 && o.providerCallsDuringInvalidation === 0, 'Invalidation started queued work/lost occupied slot');
    require(o.outcomes?.length === 3 && o.outcomes.every(r => r.status === 'stale-revision' && finite(r.elapsedMs)), 'Stale service results admitted');
    require(o.selectedEvents === profile.localEdits && o.unrelatedPatches?.length === 1 && o.localPatches?.length === profile.localEdits, 'Missing/excess edit commits');
    for (const [patches, mutations, id] of [[o.unrelatedPatches, o.unrelatedMutations, item.unrelated], [o.localPatches, o.localMutations, item.selected]]) {
      require(patches.every(p => p.changedNodes.length === 1 && p.changedNodes[0] === id && p.origin === 'editac:local:prf03' && finite(p.at)), 'Unrelated semantic invalidation');
      require(mutations?.length === 1 && mutations[0] === id, 'Unrelated DOM invalidation');
    }
  } else if (o.kind === 'collaboration') {
    require(o.samples?.length === profile.remoteEdits && o.samples.every(s => finite(s.elapsedMs)) && o.frameBytes?.length === profile.remoteEdits && o.frameBytes.every(n => n > 0), 'Missing actual remote frame samples');
    require(o.queued?.incomingFrames === profile.remoteEdits && o.queued.incomingBytes > 0, 'Missing queued collaboration burst');
    require(o.pumps?.length >= 12 && o.pumps.every(p => finite(p.elapsedMs) && p.phase === 'attached' && p.incomingFrames <= 32 && p.outgoingFrames <= 32 && p.incomingBytes <= 32 * 1024 * 1024 && p.outgoingBytes <= 32 * 1024 * 1024), 'Unbounded/failed collaboration queue');
    const last = o.pumps.at(-1); require(last.incomingFrames === 0 && last.outgoingFrames === 0 && last.incomingBytes === 0 && last.outgoingBytes === 0, 'Collaboration did not drain');
    require(o.remotePatches?.length === profile.remoteEdits && o.remotePatches.every(p => p.changedNodes.length === 1 && p.changedNodes[0] === item.selected && p.origin === 'remote'), 'Remote burst lost edits or invalidated unrelated regions');
    require(o.mutations?.length === 1 && o.mutations[0] === item.selected && o.converged === true && o.staleOutcome?.results === 0, 'Remote burst convergence/stale-result/DOM failure');
  }
  return { kind: o.kind, fixture: item.fixture, preset: item.preset, status: 'diagnostic' };
}
export function inspectServices(profile, record) {
  require(profile?.version === 1 && profile.id === 'services-v1' && profile.editMethod === 'atomic-one-ASCII-unit-replacement; constant full-corpus size' && profile.performanceLimits === null, 'Unknown service diagnostic profile');
  require(JSON.stringify(profile.fixtures) === '["Task","Long"]' && JSON.stringify(profile.presets) === '["baseline","task"]' && profile.burst === 24 && profile.localEdits === 8 && profile.remoteEdits === 8 && JSON.stringify(profile.requiredObservations) === '["queue","resolver-storm","edit-invalidation","collaboration"]', 'Service matrix drift');
  require(JSON.stringify(profile.limits) === '{"concurrency":1,"queue":2,"bytes":512,"items":1,"deadlineMs":10000}' && profile.resolverLimits.concurrency === 2 && profile.resolverLimits.queue === 0, 'Unreviewed resource limits');
  require(record?.version === 1 && record.qualification === 'unqualified', 'Unsupported service qualification');
  require(record.metadata?.cpu && record.metadata.memoryBytes > 0 && record.metadata.browser && record.metadata.hostOS && record.metadata.provenance === 'headless-browser-on-host', 'Missing runtime/hardware provenance');
  require(Date.parse(record.metadata.startedAt) > Date.parse(profile.reviewedAt), 'Profile not fixed before measurement');
  require(record.counts?.executed === 16 && record.counts.passed === 16 && record.counts.failed === 0 && record.counts.skipped === 0 && record.cases?.length === 4, 'Incomplete service matrix');
  require(record.cleanup?.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved, 'Leaked service runtime');
  const keys = new Set(), summaries = [];
  for (const item of record.cases) {
    const key = `${item.fixture}/${item.preset}`;
    require(profile.fixtures.includes(item.fixture) && profile.presets.includes(item.preset) && !keys.has(key), 'Duplicate/unknown fixture/preset'); keys.add(key);
    require(pin(item.fixtureHash) && pin(item.checkpointHash) && pin(item.semanticHash) && item.chars > 0 && item.blocks > 1 && item.selected !== item.unrelated, 'Missing corpus identities');
    require(item.providers?.resolver === 'production-adapter/prepared-host' && item.providers.highlight === 'pending/prepared-envelope-only', 'Invented optional runtime');
    require(item.cleanup?.timers === 0 && item.cleanup.hostListeners === 0 && item.cleanup.service?.active === 0 && item.cleanup.service.queued === 0 && item.cleanup.service.disposed && item.cleanup.unsaved === false && item.cleanup.databaseDeleted, 'Editor/service cleanup incomplete');
    const selectedOffset = item.editOffsets?.[item.selected], unrelatedOffset = item.editOffsets?.[item.unrelated];
    require(Number.isSafeInteger(selectedOffset) && selectedOffset >= 0 && Number.isSafeInteger(unrelatedOffset) && unrelatedOffset >= 0, 'Missing safe edit offsets');
    const replacement = (text, offset, value) => text.slice(0, offset) + value + text.slice(offset + 1);
    require(item.finalText && /[A-Za-z]/.test(item.finalText.initialSelected[selectedOffset]) && /[A-Za-z]/.test(item.finalText.initialUnrelated[unrelatedOffset]) && item.finalText.selected === replacement(item.finalText.initialSelected, selectedOffset, String.fromCharCode(64 + profile.remoteEdits)) && item.finalText.unrelated === replacement(item.finalText.initialUnrelated, unrelatedOffset, 'u'), 'Semantic edit oracle mismatch');
    require(item.initialChars > 0 && item.finalChars === item.initialChars, 'Full-corpus size changed');
    require(item.observations?.length === 4 && new Set(item.observations.map(o => o.kind)).size === 4, 'Missing/duplicate observation');
    for (const o of item.observations) summaries.push(inspectService(profile, item, o));
  }
  return { status: 'diagnostic', qualification: 'unqualified', summaries, gaps: ['Performance thresholds/tails unreviewed', 'Highlight/asset/conversion runtimes pending', 'Other PRF/accessibility/target-platform criteria remain required'] };
}
