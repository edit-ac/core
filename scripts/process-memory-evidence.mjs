import { processMemoryPolicy, summarizeProcessMemory } from './process-memory.mjs';
const require = (ok, message) => { if (!ok) throw Error(message); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const clock = value => Number.isFinite(value) && value >= 0;

export function inspectProcessMemoryMethod(profile, metadata) {
  require(JSON.stringify(profile.processMemory) === JSON.stringify(processMemoryPolicy), 'Unreviewed process-memory method/coverage drift');
  require(JSON.stringify(metadata?.policy) === JSON.stringify(profile.processMemory) && metadata.compiler && /^[a-f0-9]{64}$/.test(metadata.binaryHash), 'Missing process-memory method/build identity');
  const c = metadata.control;
  require(c?.allocatedBytes === 48 * 1024 * 1024 && positive(c.before?.pid) && c.before.pid === c.afterFree?.pid && c.before.startIdentity === c.afterFree.startIdentity, 'Missing actual allocation control');
  require([c.before, c.afterFree].every(p => positive(p.footprintBytes) && positive(p.lifetimePeakFootprintBytes) && p.lifetimePeakFootprintBytes >= p.footprintBytes), 'Invalid allocation accounting');
  require(c.afterFree.lifetimePeakFootprintBytes - c.before.lifetimePeakFootprintBytes >= c.allocatedBytes * .9 && c.afterFree.lifetimePeakFootprintBytes - c.afterFree.footprintBytes >= c.allocatedBytes * .9, 'OS peak detector missed freed allocation');
  const tree = metadata.treeControl;
  require(positive(tree?.childPid) && tree.allocatedBytes === c.allocatedBytes && tree.sample?.processes.length >= 2, 'Missing executable child-tree control');
  const child = tree.sample.processes.find(p => p.pid === tree.childPid);
  require(child?.footprintBytes >= tree.allocatedBytes * .9 && child.lifetimePeakFootprintBytes >= child.footprintBytes, 'Process enumeration missed live child allocation');
}

export function inspectProcessMemory(record) {
  require(record && record.exit?.code === 0 && record.exit.signal === null && record.stopped === 'requested', 'Incomplete process-memory collector');
  require(positive(record.browserPid) && positive(record.samplerPid) && record.browserPid !== record.samplerPid, 'Missing external collector ownership');
  require(Array.isArray(record.samples) && record.samples.length >= 3, 'Missing continuous process-memory series');
  const roleKeys = ['before', 'after'];
  for (const key of roleKeys) {
    const roles = record.roles?.[key];
    require(Array.isArray(roles) && roles.length > 0 && roles.every(p => positive(p.id) && typeof p.type === 'string') && new Set(roles.map(p => p.id)).size === roles.length, 'Missing process-role boundary');
    require(roles.some(p => p.id === record.browserPid && p.type === 'browser') && roles.some(p => p.type === 'renderer'), 'Missing browser/renderer identity');
  }
  const renderers = record.roles.before.filter(p => p.type === 'renderer' && record.roles.after.some(a => a.id === p.id && a.type === 'renderer'));
  require(renderers.length > 0, 'No stable target renderer coverage');
  const requiredPids = [record.browserPid, ...renderers.map(p => p.id)];
  let last = -1;
  const identities = new Map();
  for (const sample of record.samples) {
    require(clock(sample.atMs) && clock(sample.endMs) && sample.atMs > last && sample.endMs >= sample.atMs && sample.endMs - sample.atMs <= processMemoryPolicy.maximumGapMs, 'Invalid process-memory clock/window');
    if (last >= 0) require(sample.atMs - last <= processMemoryPolicy.maximumGapMs, 'Continuous process-memory coverage gap');
    last = sample.atMs;
    require(Array.isArray(sample.processes) && sample.processes.length > 0 && new Set(sample.processes.map(p => p.pid)).size === sample.processes.length, 'Missing/duplicate process sample');
    for (const pid of requiredPids) require(sample.processes.some(p => p.pid === pid), 'Missing browser/renderer sample');
    for (const p of sample.processes) {
      require(positive(p.pid) && p.pid !== record.samplerPid && p.error === undefined && typeof p.startIdentity === 'string' && /^[1-9][0-9]*$/.test(p.startIdentity), 'Unavailable process accounting/identity');
      require([p.residentBytes, p.footprintBytes, p.lifetimePeakFootprintBytes].every(positive) && p.lifetimePeakFootprintBytes >= p.footprintBytes, 'Missing/invalid process-memory bytes');
      const old = identities.get(p.pid);
      if (old) require(p.startIdentity === old.startIdentity && p.lifetimePeakFootprintBytes >= old.lifetimePeakFootprintBytes, 'Reused PID or decreasing OS peak');
      identities.set(p.pid, p);
    }
  }
  require(record.samples[0].processes.some(p => p.pid === record.browserPid), 'Collector starts after browser');
  const summary = summarizeProcessMemory(record.samples);
  require(clock(record.hostWorkMs) && record.hostWorkMs > 0 && summary.durationMs >= record.hostWorkMs, 'Process-memory series does not bracket actual cycle');
  require(JSON.stringify(record.summary) === JSON.stringify(summary), 'Incorrect process-memory high-water/peak summary');
  // These counters bound a single process over its entire lifetime. Never add
  // separate lifetime maxima and call that a simultaneous browser-tree peak.
  return summary;
}
