import { build } from 'esbuild';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, verifyPins, validateFitnessProfile } from '../../../scripts/architecture-budgets.mjs';
import { inspectLifecycles, validateLifecyclePolicy } from '../../../scripts/lifecycle-evidence.mjs';
import { admitOptionalLoading } from '../../../scripts/optional-loading-evidence.mjs';
import { fixture } from '../../../benchmarks/fixtures.mjs';
import { presets } from '../../../benchmarks/presets.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url)), read = path => readFile(resolve(root, path));
const profileBytes = await read('benchmarks/profiles/lifecycle-v1.json'), profile = JSON.parse(profileBytes);
const fitnessPolicy = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
const index = JSON.parse(await read('benchmarks/profiles/lifecycle-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const evidence = { version: 1, parent: 'FIT-1.8', scope: 'PRF-05 actual browser lifecycle diagnostics; memory inconclusive', artifacts: {}, observations: null };
test('actual editor disposal/canceled-transfer/unload matrix pins full source, runtime, corpus and raw resource/heap/idle series', async () => {
  validateFitnessProfile(fitnessPolicy, await read('benchmarks/config.json'), await read('../architecture/specs/verification.md'));
  validateLifecyclePolicy(fitnessPolicy, record);
  assert.equal(record.status, 'diagnostic'); assert.equal(index.resultsHash, digest(bytes)); assert.equal(record.profileHash, digest(profileBytes));
  const tracked = spawnSync('git', ['ls-files', 'crates', 'packages', 'fixtures/schema-v5', 'Cargo.lock', 'Cargo.toml', 'package-lock.json', 'package.json', 'scripts/build-wasm.mjs'], { cwd: root, encoding: 'utf8' }); assert.equal(tracked.status, 0);
  const inputs = [...new Set([...tracked.stdout.trim().split('\n'), 'benchmarks/profiles/lifecycle-v1.json', 'benchmarks/profiles/fitness-v1.json', 'benchmarks/config.json', 'scripts/architecture-budgets.mjs', 'contracts/services.json', 'benchmarks/lifecycle-client.mjs', 'benchmarks/fixtures.mjs', 'benchmarks/presets.mjs', 'benchmarks/resource-probe.mjs', 'scripts/lifecycle-evidence.mjs', 'scripts/bench-lifecycle.mjs', 'scripts/process-memory.c', 'scripts/process-memory.mjs', 'scripts/process-memory-evidence.mjs'])];
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), inputs.sort()); await verifyPins(root, record.sourceInputs); await verifyPins(resolve(root, index.directory), record.artifacts);
  const optionalIndex = JSON.parse(await read('benchmarks/profiles/optional-loading-evidence.json'));
  const optionalBytes = await read(`${optionalIndex.directory}/optional-loading.json`), optional = JSON.parse(optionalBytes);
  assert.equal(digest(optionalBytes), optionalIndex.receiptHash);
  await admitOptionalLoading(root, resolve(root, optionalIndex.directory), optional);
  assert.deepEqual(record.metadata.optionalLoading, { ...optionalIndex, profiles: Object.fromEntries(profile.optionalProfiles.map(name => [name, {
    packs: optional.profiles[name].measurement.packs, assets: optional.profiles[name].measurement.assets, bytes: optional.profiles[name].measurement.result,
  }])) });
  assert.equal(record.artifacts['inputs/optional-loading.json'], optionalIndex.receiptHash);
  const rebuilt = await build({ stdin: { contents: 'export {ReferenceLookupSession} from "@edit-ac/web/modules";', resolveDir: root },
    write: false, bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  assert.equal(digest(rebuilt.outputFiles[0].contents), record.artifacts['harness/resolver.js'], 'Changed resolver executable');
  const services = JSON.parse(await read('contracts/services.json'));
  assert.equal(services.families.find(f => f.id === 'resolver').registration, 'implemented');
  assert.equal(services.families.find(f => f.id === 'highlight').registration, 'pending');
  for (const item of record.cases) { assert.equal(item.fixtureHash, digest(JSON.stringify(fixture(item.fixture)))); assert.deepEqual(item.features, [...presets[item.preset].featureSet, ...(item.optional === 'markdown' ? ['markdown'] : [])]); assert.equal(item.checkpointHash, record.artifacts[`fixtures/${item.fixture}.checkpoint.json`]); }
  for (const name of profile.fixtures) { const pair = record.cases.filter(c => c.fixture === name); assert.equal(pair.length, 4); assert(pair.every(item => item.checkpointHash === pair[0].checkpointHash)); }
  evidence.observations = inspectLifecycles(profile, record); evidence.artifacts[`${index.directory}/results.json`] = index.resultsHash;
});
test('every external process stream matches its retained raw artifact', async () => {
  for (const item of record.cases) for (const cycle of item.cycles) {
    const path = `process-memory/${item.fixture}-${item.preset}-${item.optional}-${cycle.index}.json`;
    assert.equal(digest(JSON.stringify(cycle.processMemory)), record.artifacts[path]);
    assert.equal(digest(await read(`${index.directory}/${path}`)), record.artifacts[path]);
  }
});
for (const [name, change] of [
  ['missing enabled profile', r => r.cases.splice(1, 1)],
  ['unknown optional profile', r => r.cases[0].optional = 'prepared'],
  ['disabled parser request', r => r.cases[0].requests.push('/fixture/default/wasm/editac_markdown_wasm_bg.wasm')],
  ['wrong feature set', r => r.cases[1].features.pop()],
  ['missing parser execution', r => delete r.cases[1].cycles[0].markdown],
  ['literal parser bypass', r => r.cases[1].cycles[0].markdown.bold = false],
  ['unrestored parser edit', r => r.cases[1].cycles[0].markdown.restored = false],
  ['unexecuted measured asset', r => r.cases[1].requests = []],
  ['missing optional receipt', r => delete r.metadata.optionalLoading],
  ['stale pack', r => r.metadata.optionalLoading.profiles.markdown.packs[0].sha256 = '0'.repeat(64)],
  ['stale runtime asset', r => r.metadata.optionalLoading.profiles.markdown.assets[0].sha256 = '0'.repeat(64)],
  ['prepared initialization', r => r.cases[1].probeControl.initialization.enabled = false],
  ['GC-tainted initialization', r => r.cases[1].probeControl.initialization.before.collected = true],
  ['blind worker probe', r => r.cases[0].probeControl.active.workers = 0], ['blind idle probe', r => r.cases[0].probeControl.polling.callbacks = 0], ['missing backing sample', r => delete r.cases[0].cycles[0].memory.heap.backingStorageSize],
  ['missing cycle', r => r.cases[0].cycles.pop()], ['reordered cycle', r => r.cases[0].cycles[0].index++],
  ['skipped observation', r => r.counts.skipped++], ['failed observation', r => r.counts.failed++], ['zero observations', r => r.counts.executed = 0],
  ['duplicate fixture', r => Object.assign(r.cases[1], { preset: r.cases[0].preset, optional: r.cases[0].optional })], ['missing browser', r => delete r.metadata.browser],
  ['unreviewed memory pass', r => r.cases[0].memoryStatus = 'passed'], ['fake qualification', r => r.qualification = 'qualified'],
  ['missing heap sample', r => delete r.cases[0].cycles[0].memory.jsHeapUsedBytes], ['missing DOM sample', r => delete r.cases[0].cycles[0].memory.nodes],
  ['missing live sample', r => r.cases[0].cycles[0].liveMemory.splice(1, 1)],
  ['reordered live sample', r => r.cases[0].cycles[0].liveMemory.reverse()],
  ['collected live sample', r => r.cases[0].cycles[0].liveMemory[1].collected = true],
  ['missing live heap', r => delete r.cases[0].cycles[0].liveMemory[1].heap],
  ['missing live backing sample', r => delete r.cases[0].cycles[0].liveMemory[1].heap.backingStorageSize],
  ['reversed live clock', r => r.cases[0].cycles[0].liveMemory[1].at = 0],
  ['unobserved mounted DOM', r => r.cases[0].cycles[0].liveMemory[1].nodes = r.cases[0].cycles[0].liveMemory[0].nodes],
  ['uncollected retained sample', r => r.cases[0].cycles[0].memory.collected = false],
  ['post-cycle clock overlap', r => r.cases[0].cycles[0].memory.at = 0],
  ['missing high-water summary', r => delete r.cases[0].cycles[0].sampledHighWater],
  ['underreported heap high-water', r => r.cases[0].cycles[0].sampledHighWater.jsHeapUsedBytes--],
  ['overreported backing high-water', r => r.cases[0].cycles[0].sampledHighWater.backingStorageBytes++],
  ['missing live method', r => delete r.metadata.liveMemoryMethod],
  ['missing process-memory policy', r => delete r.metadata.processMemory],
  ['false OS peak detector', r => r.metadata.processMemory.control.afterFree.lifetimePeakFootprintBytes = r.metadata.processMemory.control.before.lifetimePeakFootprintBytes],
  ['missing collector binary identity', r => delete r.metadata.processMemory.binaryHash],
  ['mismatched collector binary', r => r.metadata.processMemory.binaryHash = '0'.repeat(64)],
  ['blind child-tree detector', r => r.metadata.processMemory.treeControl.sample.processes = []],
  ['missing actual sampler scheduling', r => delete r.cases[0].cycles[0].processMemory.samples[1].scheduling],
  ['missing scheduling control', r => delete r.metadata.processMemory.treeControl.sample.scheduling],
  ['missing process samples', r => delete r.cases[0].cycles[0].processMemory],
  ['phase-only process sampling', r => r.cases[0].cycles[0].processMemory.samples.splice(1, 100000)],
  ['truncated process stream', r => r.cases[0].cycles[0].processMemory.stopped = 'timeout'],
  ['failed process helper', r => r.cases[0].cycles[0].processMemory.exit.code = 3],
  ['missing renderer roles', r => r.cases[0].cycles[0].processMemory.roles.before = r.cases[0].cycles[0].processMemory.roles.before.filter(p => p.type !== 'renderer')],
  ['missing process accounting', r => delete r.cases[0].cycles[0].processMemory.samples[1].processes[0].footprintBytes],
  ['unavailable process accounting', r => r.cases[0].cycles[0].processMemory.samples[1].processes[0].error = 3],
  ['missing browser process', r => r.cases[0].cycles[0].processMemory.samples[1].processes = []],
  ['reused process ID', r => r.cases[0].cycles[0].processMemory.samples[1].processes[0].startIdentity += '1'],
  ['unmeasured OS peak', r => r.cases[0].cycles[0].processMemory.samples[1].processes[0].lifetimePeakFootprintBytes = 0],
  ['missing confirming OS read', r => delete r.cases[0].cycles[0].processMemory.samples[1].processes[0].confirmedLifetimePeakFootprintBytes],
  ['confirmation PID reuse', r => r.cases[0].cycles[0].processMemory.samples[1].processes[0].confirmationStartIdentity += '1'],
  ['unconfirmed footprint peak', r => r.cases[0].cycles[0].processMemory.samples[1].processes[0].confirmedLifetimePeakFootprintBytes = 1],
  ['coverage gap', r => r.cases[0].cycles[0].processMemory.samples[1].atMs += 1000],
  ['reordered process clock', r => r.cases[0].cycles[0].processMemory.samples.reverse()],
  ['late process collector', r => r.cases[0].cycles[0].processMemory.hostWorkMs = 1e9],
  ['underreported process high-water', r => r.cases[0].cycles[0].processMemory.summary.sampledTreeHighWaterBytes--],
  ['overreported OS peak', r => r.cases[0].cycles[0].processMemory.summary.perProcess[0].lifetimePeakFootprintBytes++],
  ['lost acknowledged source', r => r.cases[0].cycles[0].reopenedPreserved = false], ['late DOM mutation', r => r.cases[0].cycles[0].noLateDOMMutation = false],
  ['lost canceled source', r => r.cases[0].cycles[0].cancellation.source = false], ['missing recovery', r => r.cases[0].cycles[0].destroyRecovery = false],
  ['fake paste target', r => r.cases[0].cycles[0].cancellation.control = 'rejected'], ['late resolver result', r => r.cases[0].cycles[0].cancellation.results++],
  ['unaborted request', r => r.cases[0].cycles[0].cancellation.aborted = false], ['missing active evidence', r => r.cases[0].cycles[0].phases[0].listeners = 0],
  ['polling', r => r.cases[0].cycles[0].idle.after.schedules++], ['idle callback', r => r.cases[0].cycles[0].idle.after.callbacks++],
  ['short idle observation', r => r.cases[0].cycles[0].idle.durationMs--], ['unsaved disposal', r => r.cases[0].cycles[0].unsaved = true],
  ['harness browser leak', r => r.cleanup.browserExited = false], ['runtime error', r => r.cases[0].errors.push('late failure')],
  ...['listeners', 'workers', 'observers', 'timers', 'frames'].map(key => [`leaked ${key}`, r => r.cases[0].cycles[0].memory.resources[key]++]),
]) test(`lifecycle admission rejects ${name}`, () => { const mutated = structuredClone(record); change(mutated); assert.throws(() => inspectLifecycles(profile, mutated)); });
test('profile changes cannot shrink replay or invent memory/resource limits', () => {
  for (const change of [p => p.optionalProfiles.pop(), p => p.optionalReviewedAt = '2099-01-01', p => p.cycles--, p => p.fixtures.pop(), p => p.idleMs--, p => p.resourceBounds.listeners++, p => p.performanceLimits = { memory: 999 }, p => p.memoryMethod = 'prepared', p => p.liveMemoryPhases.pop(), p => p.liveMemoryMethod = 'peak', p => p.processMemory.intervalMs++, p => p.processMemory.maximumGapMs++, p => p.processMemory.method = 'phase-snapshots', p => p.processMemoryReviewedAt = '2099-01-01']) { const p = structuredClone(profile); change(p); assert.throws(() => inspectLifecycles(p, record)); }
});
test('mutated source and retained artifact pins fail canonical admission', async () => {
  await assert.rejects(verifyPins(root, { 'benchmarks/resource-probe.mjs': '0'.repeat(64) }));
  await assert.rejects(verifyPins(resolve(root, index.directory), { 'harness/default/lifecycle-client.mjs': '0'.repeat(64) }));
});
after(async () => { assert(process.env.EDITAC_ARCHITECTURE_OUTPUT); await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'lifecycle-inventory.json'), JSON.stringify(evidence, null, 2) + '\n'); });

for (const [name, mutate] of [
  ['missing policy', r => delete r.metadata.verificationPolicy],
  ['stale policy', r => r.metadata.verificationPolicy.sha256 = '0'.repeat(64)],
  ['wrong policy source', r => r.metadata.verificationPolicy.source = 'prepared'],
  ['missing retained policy', r => delete r.artifacts['policy/verification.md']],
  ['changed retained policy', r => r.artifacts['policy/verification.md'] = '0'.repeat(64)],
  ['stale policy review', r => r.metadata.verificationPolicy.reviewedAt = '2000-01-01T00:00:00.000Z'],
  ['measurement before review', r => r.metadata.startedAt = fitnessPolicy.reviewedAt],
]) test(`lifecycle policy rejects ${name}`, () => {
  const changed = structuredClone(record); mutate(changed);
  assert.throws(() => validateLifecyclePolicy(fitnessPolicy, changed));
});
