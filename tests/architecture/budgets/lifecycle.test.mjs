import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
import { inspectLifecycles } from '../../../scripts/lifecycle-evidence.mjs';
import { fixture } from '../../../benchmarks/fixtures.mjs';
import { presets } from '../../../benchmarks/presets.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url)), read = path => readFile(resolve(root, path));
const profileBytes = await read('benchmarks/profiles/lifecycle-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/lifecycle-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const evidence = { version: 1, parent: 'FIT-1.8', scope: 'PRF-05 actual browser lifecycle diagnostics; memory inconclusive', artifacts: {}, observations: null };
test('actual editor disposal/canceled-transfer/unload matrix pins full source, runtime, corpus and raw resource/heap/idle series', async () => {
  assert.equal(record.status, 'diagnostic'); assert.equal(index.resultsHash, digest(bytes)); assert.equal(record.profileHash, digest(profileBytes));
  const tracked = spawnSync('git', ['ls-files', 'crates', 'packages', 'fixtures/schema-v5', 'Cargo.lock', 'Cargo.toml', 'package-lock.json', 'package.json', 'scripts/build-wasm.mjs'], { cwd: root, encoding: 'utf8' }); assert.equal(tracked.status, 0);
  const inputs = [...new Set([...tracked.stdout.trim().split('\n'), 'benchmarks/profiles/lifecycle-v1.json', 'contracts/services.json', 'benchmarks/lifecycle-client.mjs', 'benchmarks/fixtures.mjs', 'benchmarks/presets.mjs', 'benchmarks/resource-probe.mjs', 'scripts/lifecycle-evidence.mjs', 'scripts/bench-lifecycle.mjs'])];
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), inputs.sort()); await verifyPins(root, record.sourceInputs); await verifyPins(resolve(root, index.directory), record.artifacts);
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) assert.equal(digest(await read(`packages/core/dist/wasm/${file}`)), record.artifacts[`harness/wasm/${file}`]);
  const services = JSON.parse(await read('contracts/services.json'));
  assert.equal(services.families.find(f => f.id === 'resolver').registration, 'implemented');
  assert.equal(services.families.find(f => f.id === 'highlight').registration, 'pending');
  for (const item of record.cases) { assert.equal(item.fixtureHash, digest(JSON.stringify(fixture(item.fixture)))); assert.deepEqual(item.features, presets[item.preset].featureSet); assert.equal(item.checkpointHash, record.artifacts[`fixtures/${item.fixture}.checkpoint.json`]); }
  for (const name of profile.fixtures) { const pair = record.cases.filter(c => c.fixture === name); assert.equal(pair.length, 2); assert.equal(pair[0].checkpointHash, pair[1].checkpointHash); }
  evidence.observations = inspectLifecycles(profile, record); evidence.artifacts[`${index.directory}/results.json`] = index.resultsHash;
});
for (const [name, change] of [
  ['blind worker probe', r => r.cases[0].probeControl.active.workers = 0], ['blind idle probe', r => r.cases[0].probeControl.polling.callbacks = 0], ['missing backing sample', r => delete r.cases[0].cycles[0].memory.heap.backingStorageSize],
  ['missing cycle', r => r.cases[0].cycles.pop()], ['reordered cycle', r => r.cases[0].cycles[0].index++],
  ['skipped observation', r => r.counts.skipped++], ['failed observation', r => r.counts.failed++], ['zero observations', r => r.counts.executed = 0],
  ['duplicate fixture', r => r.cases[1].preset = r.cases[0].preset], ['missing browser', r => delete r.metadata.browser],
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
  for (const change of [p => p.cycles--, p => p.fixtures.pop(), p => p.idleMs--, p => p.resourceBounds.listeners++, p => p.performanceLimits = { memory: 999 }, p => p.memoryMethod = 'prepared', p => p.liveMemoryPhases.pop(), p => p.liveMemoryMethod = 'peak']) { const p = structuredClone(profile); change(p); assert.throws(() => inspectLifecycles(p, record)); }
});
test('mutated source and retained artifact pins fail canonical admission', async () => {
  await assert.rejects(verifyPins(root, { 'benchmarks/resource-probe.mjs': '0'.repeat(64) }));
  await assert.rejects(verifyPins(resolve(root, index.directory), { 'harness/lifecycle-client.mjs': '0'.repeat(64) }));
});
after(async () => { assert(process.env.EDITAC_ARCHITECTURE_OUTPUT); await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'lifecycle-inventory.json'), JSON.stringify(evidence, null, 2) + '\n'); });
