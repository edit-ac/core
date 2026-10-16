import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, verifyPins, validateFitnessProfile } from '../../../scripts/architecture-budgets.mjs';
import { validateLoadingPolicy, inspectLoadings, loadingInputs, summarizeLoading } from '../../../scripts/loading-evidence.mjs';
import { fixture } from '../../../benchmarks/fixtures.mjs';
import { admitMeasuredConsumer } from '../../../scripts/consumers-loading.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = p => readFile(resolve(root, p));
const profileBytes = await read('benchmarks/profiles/loading-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/loading-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const evidence = { version: 1, parent: 'FIT-1.8', scope: 'PRF-06 actual external packed cold/warm diagnostic', artifacts: {}, observations: null };
const fitnessPolicy = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
test('packed real WASM cold/warm matrix admits exact profile/source/runtime/artifacts and cache/evaluation traces', async () => {
  validateFitnessProfile(fitnessPolicy, await read('benchmarks/config.json'), await read('../architecture/specs/verification.md'));
  validateLoadingPolicy(fitnessPolicy, record);
  assert.equal(record.metadata.commandAttribution, 'none', 'Observer derivative cannot replace production evidence');
  assert.equal(digest(bytes), index.resultsHash); assert.equal(record.profileHash, digest(profileBytes));
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), [...loadingInputs].sort());
  evidence.sources = { runtime: await verifyPins(root, record.sourceInputs), artifacts: await verifyPins(resolve(root, index.directory), record.artifacts) };
  assert.match(record.seedEvidence.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!record.seedEvidence.directory.includes('..'));
  const seedBytes = await read(`${record.seedEvidence.directory}/results.json`); assert.equal(digest(seedBytes), record.seedEvidence.resultsHash);
  const seed = JSON.parse(seedBytes);
  for (const name of profile.fixtures) assert.equal(seed.artifacts[`fixtures/${name}.checkpoint.json`], record.artifacts[`fixtures/${name}.checkpoint.json`]);
  assert.deepEqual(JSON.parse(await read(`${index.directory}/summary.json`)), summarizeLoading(profile, record));
  for (const name of ['fixtures.mjs','loading-client.mjs','loading-command-attribution.mjs','loading-startup-attribution.mjs']) assert.equal(digest(await read(`benchmarks/${name}`)), record.artifacts[`harness/${name}`]);
  for (const [path, hash] of Object.entries(record.consumer.inputHashes)) if (path !== 'task.mjs') assert.equal(digest(await read(path.replace('node_modules/@edit-ac/', 'packages/'))), hash, `Current packed build differs: ${path}`);
  assert.equal(digest(await read('packages/core/dist/wasm/editac_wasm_bg.wasm')), record.consumer.assets.find(a => a.name === 'wasm/editac_wasm_bg.wasm').sha256);
  assert.deepEqual(record.consumer, await admitMeasuredConsumer(resolve(root, index.directory, 'packed')));
  for (const item of record.cases) {
    assert.equal(item.fixtureHash, digest(JSON.stringify(fixture(item.fixture))));
    assert.equal(item.checkpointHash, record.artifacts[`fixtures/${item.fixture}.checkpoint.json`]);
    assert.equal(digest(JSON.stringify(item)), record.artifacts[`raw/${item.fixture}-${item.preset}.json`]);
  }
  evidence.observations = inspectLoadings(profile, record); evidence.artifacts[index.directory + '/results.json'] = index.resultsHash;
});
const negatives = {
  'missing hardware': r => delete r.metadata.cpu,
  'invented feature set': r => r.cases[0].features.push('cloud'),
  'wrong fixture size': r => r.cases[0].textBytes--,
  'missing matrix': r => r.cases.pop(),
  'duplicate matrix': r => r.cases[1] = structuredClone(r.cases[0]),
  'skipped cases': r => r.counts.skipped++,
  'invented qualification': r => r.qualification = 'qualified',
  'leaked process': r => r.cleanup.browserExited = false,
  'missing cold sample': r => r.cases[0].pairs[0].cold.samples.readyMs = null,
  'production command hook contamination': r => r.cases[0].pairs[0].cold.commands.push({name:'edit'}),
  'missing phase identity': r => delete r.cases[0].pairs[0].cold.phaseAttribution,
  'missing phase': r => r.cases[0].pairs[0].cold.phases.pop(),
  'missing oracle phase': r => { const p = r.cases[0].pairs[0].warm.phases; p.splice(p.findIndex(v => v.name === 'initialRead'), 1); },
  'phase gap': r => r.cases[0].pairs[0].cold.phases[1].startMs++,
  'invented phase duration': r => r.cases[0].pairs[0].warm.phases[2].durationMs++,
  'phase metric mismatch': r => r.cases[0].pairs[0].warm.samples.acceptedEditMs += 5,
  'negative phase': r => r.cases[0].pairs[0].warm.phases[0].durationMs = -1,
  'changed source': r => r.cases[0].pairs[0].warm.finalHash = '0'.repeat(64),
  'lost warm persistence': r => r.cases[0].pairs[0].warm.initialHash = '0'.repeat(64),
  'optional evaluation': r => r.cases[0].pairs[0].cold.scripts.push({url:'/cloud.js',hash:'abc'}),
  'missing evaluation': r => r.cases[0].pairs[0].cold.coverage = [],
  'missing cache proof': r => r.cases[0].pairs[0].warm.resourceTimings = [],
  'missing raw pairs': r => r.cases[0].pairs.pop(),
  'leaked storage': r => r.cases[0].pairs[0].databaseDeleted = false,
  'overrun gzip': r => r.consumer.assets[0].gzip = 524289
};
for (const [name, mutate] of Object.entries(negatives)) test(`loading admission rejects ${name}`, () => { const r = structuredClone(record); mutate(r); assert.throws(() => inspectLoadings(profile, r)); });
test('loading admission rejects reduced matrix and relaxed premeasurement limits', () => { for (const mutate of [p => p.warmLimitsMs.Long++, p => p.fixtures.pop(), p => p.presets.pop(), p => p.requiredObservations.pop(), p => p.samplePairs--]) { const p = structuredClone(profile); mutate(p); assert.throws(() => inspectLoadings(p, record)); } });
test('changed source and missing or mutated owning artifacts fail admission', async () => {
  await assert.rejects(verifyPins(root, { 'benchmarks/loading-client.mjs': '0'.repeat(64) }));
  await assert.rejects(verifyPins(resolve(root, index.directory), { 'summary.json': '0'.repeat(64) }));
  await assert.rejects(verifyPins(resolve(root, index.directory), { 'missing.json': '0'.repeat(64) }));
});
after(async () => { if (process.env.EDITAC_ARCHITECTURE_OUTPUT) await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'loading-inventory.json'), JSON.stringify(evidence, null, 2)); });

for (const [name, mutate] of Object.entries({
  'absent policy': r => delete r.metadata.verificationPolicy,
  'changed policy': r => r.metadata.verificationPolicy.sha256 = '0'.repeat(64),
  'missing retained policy': r => delete r.artifacts['policy/verification.md'],
  'measurement before review': r => r.metadata.startedAt = r.metadata.verificationPolicy.reviewedAt,
  'changed review': r => r.metadata.verificationPolicy.reviewedAt = '2020-01-01T00:00:00Z',
})) test(`loading policy admission rejects ${name}`, () => {
  const candidate = structuredClone(record); mutate(candidate);
  assert.throws(() => validateLoadingPolicy(fitnessPolicy, candidate), /policy|review/i);
});
