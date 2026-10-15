import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFitnessProfile, digest, rawSummary, comparable, evaluateFitnessEvidence, inspectBaseline, verifyPins, verifyMeasuredFixtures } from '../../../scripts/architecture-budgets.mjs';
import { options } from '../../../benchmarks/options.mjs';
import { budgets, evaluateBudget, assertBudget } from '../../../scripts/browser-size-contract.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFile(resolve(root, file));
const profileBytes = await read('benchmarks/profiles/fitness-v1.json');
const profile = JSON.parse(profileBytes);
const config = await read('benchmarks/config.json');
const spec = await readFile(resolve(root, '../architecture/specs/verification.md'));
const clone = value => structuredClone(value);
const evidence = { version: 1, scope: 'FIT-1.8 profile and actual baseline diagnostics only; not platform qualification', profileHash: digest(profileBytes), artifacts: {}, sources: {}, observations: null };
const output = process.env.EDITAC_ARCHITECTURE_OUTPUT;
assert(output, 'Canonical dispatcher output required');

test('reviewed profile preserves exact benchmark limits and verification policy', () => {
  const result = validateFitnessProfile(profile, config, spec);
  assert.deepEqual(result.hardGzipCaps, budgets);
  assert.equal(budgets.total.hard, 524288); assert.equal(budgets.js.hard, 32768);
  assert.deepEqual(options(['--fitness', '--quick', '--fixtures', 'small,medium']).fixtures, ['small', 'medium']);
});
for (const [name, mutate] of [
  ['unknown replay', p => p.inputReplay = 'growth'], ['native command claim for prepared seed', p => p.seedPreparation = 'optimized-public-native-abi; outside measurement; shared exact bytes restored by browser WASM'], ['unknown version', p => p.version++], ['no preregistration', p => delete p.reviewedAt],
  ['budget drift', p => p.benchmarkConfigHash = '0'.repeat(64)], ['policy drift', p => p.verificationSpecHash = '0'.repeat(64)],
  ['undersampled tails', p => p.minimumTailSamples = 5], ['size substitution', p => p.requiredSizes = ['small', 'medium']],
  ['missing PRF', p => delete p.requiredCases['PRF-07']], ['missing accessibility', p => p.requiredAccessibility.pop()],
  ['raised latency', p => p.limits.desktop['input-visible'] = 100], ['raised warm activation', p => p.limits.desktop['Task-warm'] = 100], ['missing presets', p => p.presets = ['baseline']], ['wrong owning command', p => p.owningCommands = ['unknown']], ['hidden resource gaps', p => p.unreviewedLimits = []],
]) test(`profile rejects ${name}`, () => { const p = clone(profile); mutate(p); assert.throws(() => validateFitnessProfile(p, config, spec)); });

test('raw tails are inconclusive for a small sample set', () => {
  assert.deepEqual(rawSummary([3, 1, 2]), { count: 3, p50: 2, p95: null, p99: null, max: 3, status: 'inconclusive' });
  const summary = rawSummary(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(summary.p95, 95); assert.equal(summary.p99, 99);
  for (const invalid of [[], [NaN], [-1], [Infinity], ['1']]) assert.throws(() => rawSummary(invalid));
});
const comparison = { implementationHash: '1'.repeat(64), hardware: { cpu: 'fixture', memory: 1 }, runtime: 'fixture',
  fixtureHash: '2'.repeat(64), featureSet: ['minimal'], size: 'Task', toolchain: 'fixture', warmups: 2, sampleMethod: 'fixture' };
test('comparison requires controlled inputs but permits distinct source identities', () => {
  assert.equal(comparable(comparison, { ...comparison, implementationHash: '3'.repeat(64) }), true);
  assert.throws(() => comparable(comparison, { ...comparison, implementationHash: null }));
});
for (const key of ['hardware', 'runtime', 'fixtureHash', 'featureSet', 'size', 'toolchain', 'warmups', 'sampleMethod']) test(`comparison rejects incomparable ${key}`, () => {
  const b = clone(comparison); b[key] = 'different'; assert.equal(comparable(comparison, b), false);
});
const prepared = { version: 1, kind: 'prepared', profileHash: digest(JSON.stringify(profile)), implementationHash: '1'.repeat(64),
  startedAt: '2026-10-14T20:00:00Z', featureSet: ['minimal'], sizes: ['Task', 'Long'], cases: {}, accessibility: {} };
test('prepared/missing evidence cannot admit a supported performance profile', () => {
  const result = evaluateFitnessEvidence(profile, prepared);
  assert.equal(result.status, 'unqualified');
  assert(result.gaps.some(g => g.includes('Prepared')));
  for (const id of Object.keys(profile.requiredCases)) assert(result.gaps.includes(`${id}: missing`));
  for (const mode of profile.requiredAccessibility) assert(result.gaps.some(g => g.includes(`accessibility/${mode}`)));
});
test('green status cannot hide failed/skipped cases, missing artifacts, post-hoc limits or small samples', () => {
  const record = clone(prepared); record.kind = 'target-runtime'; record.reviewedLimits = { 'input-visible': 999 };
  record.runtime = { class: 'desktop', platform: 'fixture', version: 'fixture', input: 'fixture', accessibility: 'fixture', thermal: 'fixture' };
  record.cases['PRF-01'] = { status: 'passed', executed: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0, provenance: 'target-runtime', runtime: 'fixture',
    artifact: 'fixture.log', artifactHash: '2'.repeat(64), observations: { 'input-visible': { status: 'passed', scope: 'target-runtime', fixtureHash: '3'.repeat(64), size: 'Task', samples: [1, 2, 3] } } };
  const result = evaluateFitnessEvidence(profile, record);
  assert.equal(result.status, 'unqualified');
  for (const reason of ['counts', 'artifact', 'insufficient tail', 'inconclusive']) assert(result.gaps.some(g => g.includes(reason)), reason);
  record.cases['PRF-01'].observations['input-visible'].samples = Array(100).fill(20);
  assert(evaluateFitnessEvidence(profile, record).gaps.includes('PRF-01/input-visible: limit exceeded or inconclusive'));
});
test('missing or malformed source/artifact pins reject', async () => {
  for (const pins of [null, {}, { '../escape': '0'.repeat(64) }, { '/absolute': '0'.repeat(64) }, { 'package.json': 'invalid' }, { 'package.json': '0'.repeat(64) }]) await assert.rejects(verifyPins(root, pins));
});

const index = JSON.parse(await read('benchmarks/profiles/baseline-evidence.json'));
const measurementRoot = resolve(root, index.directory);
const resultBytes = await readFile(resolve(measurementRoot, 'results.json'));
assert.equal(digest(resultBytes), index.resultsHash, 'Changed measured result');
const result = JSON.parse(resultBytes);
test('actual Rust/WASM/IndexedDB baseline retains exact source, profile and executed artifacts', async () => {
  assert.equal(result.profileInputs['benchmarks/profiles/fitness-v1.json'], digest(profileBytes));
  for (const name of ['baseline', 'gesture', 'service', 'workload', 'lifecycle']) {
    assert(!Object.hasOwn(result.sourceInputs, `benchmarks/profiles/${name}-evidence.json`), 'Generated evidence index cannot be an executable source input');
  }
  evidence.sources.profile = await verifyPins(root, result.profileInputs);
  evidence.sources.production = await verifyPins(root, result.sourceInputs);
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) assert.equal(digest(await read(`packages/core/dist/wasm/${file}`)), result.artifactInputs[`bundles/wasm/${file}`], 'Current browser WASM differs from retained measurement');
  evidence.sources.artifacts = await verifyPins(measurementRoot, result.artifactInputs);
  await verifyMeasuredFixtures(root, measurementRoot, result);
  evidence.sources.fixtures = await verifyPins(measurementRoot, Object.fromEntries(result.fixtures.map(item => [`fixtures/${item.name}.json`, item.sha256])));
  evidence.artifacts[index.directory + '/results.json'] = index.resultsHash;
  evidence.observations = inspectBaseline(profile, result);
  assert.equal(evidence.observations.status, 'diagnostic'); assert.equal(evidence.observations.qualification, 'unqualified');
  assert.equal(evidence.observations.observations.length, 4);
  assert.equal(evidence.observations.featureCosts.length, 2);
  assert(evidence.observations.featureCosts.every(c => c.status === 'inconclusive' && c.pairedRuns.length === result.plan.runs));
  assert(evidence.observations.observations.every(o => o.input.status === 'inconclusive' && o.disposal.length > 1));
});
for (const [name, mutate] of [
  ['wrong replay signature', r => r.signature.replay = 'growth'], ['wrong trace replay', r => r.cases.find(c => c.measured).fitness.replay = 'growth'], ['benchmark failure', r => r.counts.failed++], ['benchmark skip', r => r.counts.skipped++],
  ['missing measured fixture', r => r.cases = r.cases.filter(c => !c.measured)],
  ['missing hardware', r => delete r.metadata.cpu], ['preregistration violation', r => r.metadata.timestamp = profile.reviewedAt],
  ['leaked browser', r => r.cleanup.browserExited = false], ['legacy endpoint', r => r.signature.endpoint = 'old'],
  ['wrong feature set', r => r.cases.find(c => c.measured).fitness.preset = 'official'],
  ['missing Task preset', r => r.signature.presets.pop()],
  ['preset options drift', r => r.signature.presets[1].options.typingShortcuts = false],
  ['different initial CRDT', r => r.cases.find(c => c.measured).fixtureIdentity.crdtHash = '0'.repeat(64)],
  ['text bytes relabeled as CRDT', r => r.fixtures[0].crdt.sha256 = r.fixtures[0].textHash],
  ['semantic snapshot drift', r => r.fixtures[0].semanticHash = '0'.repeat(64)],
  ['feature set drift', r => r.cases.find(c => c.measured).fitness.featureSet = ['invented']],
  ['duplicate fixture', r => r.cases.find(c => c.measured && c.fixture === 'Long').fixture = 'Task'],
  ['duplicate raw input', r => r.cases.find(c => c.measured).fitness.input[1] = r.cases.find(c => c.measured).fitness.input[0]],
  ['missing raw input', r => r.cases.find(c => c.measured).fitness.input.pop()],
  ['missing Rust stage', r => r.cases.find(c => c.measured).fitness.input[0].stages.spans = []],
  ['overflowed stage trace', r => r.cases.find(c => c.measured).fitness.input[0].stages.dropped = 1],
  ['missing composition', r => r.cases.find(c => c.measured).fitness.composition.pop()],
  ['provisional composition commit', r => r.cases.find(c => c.measured).fitness.composition[0].provisionalCommits = 1],
  ['composition restoration failure', r => r.cases.find(c => c.measured).fitness.composition[0].restored = false],
  ['negative attribution', r => r.cases.find(c => c.measured).fitness.input[0].layoutMs = -1],
  ['fake frame attribution', r => r.cases.find(c => c.measured).fitness.input[0].secondFrameMs = 0],
  ['missing changed region', r => r.cases.find(c => c.measured).fitness.changedRegion[0].touched = []],
  ['retained editor', r => r.cases.find(c => c.measured).fitness.disposal[1].childNodes = 1],
  ['missing memory', r => delete r.cases.find(c => c.measured).fitness.disposal[1].heap],
  ['truncated size', r => r.cases.find(c => c.measured).chars--],
]) test(`actual-baseline admission rejects ${name}`, () => { const r = clone(result); mutate(r); assert.throws(() => inspectBaseline(profile, r)); });

test('optional loading consumes the existing pinned artifact/cap proof without a new measurement harness', async () => {
  const loadingRoot = resolve(root, index.optionalLoading.directory);
  await verifyPins(loadingRoot, index.optionalLoading.pins);
  const receipt = JSON.parse(await readFile(resolve(loadingRoot, 'receipt.json')));
  assert.equal(receipt.exit, 0); assert.equal(receipt.counts.tests, receipt.counts.pass);
  for (const key of ['fail', 'skipped', 'cancelled', 'todo']) assert.equal(receipt.counts[key], 0);
  assert(receipt.counts.tests > 0);
  const inventory = JSON.parse(await readFile(resolve(loadingRoot, 'consumers-loading-inventory.json')));
  evidence.sources.optionalLoadingArtifacts = await verifyPins(loadingRoot, inventory.artifacts);
  const evaluate = key => { const assets = inventory.profiles[key].assets; return evaluateBudget(assets, assets.map(({ name, kind }) => ({ name, kind }))); };
  const baseline = evaluate('default'), enabled = evaluate('markdown');
  assertBudget(baseline);
  assert.deepEqual(baseline, inventory.profiles.default.result);
  const incremental = { total: enabled.total.bytes - baseline.total.bytes, js: enabled.js.bytes - baseline.js.bytes };
  assert.equal(incremental.total, inventory.profiles.markdown.result.total.incrementalBytes);
  assert.equal(incremental.js, inventory.profiles.markdown.result.js.incrementalBytes);
  assert.equal(baseline.total.preferredPass, false); assert.equal(baseline.js.preferredPass, false);
  evidence.optionalLoading = { scope: index.optionalLoading.scope, baseline, enabled, incremental,
    remaining: 'Cold/warm packed startup and official presets remain unmeasured for PRF-06' };
});

after(async () => { await mkdir(output, { recursive: true }); await writeFile(resolve(output, 'budgets-inventory.json'), JSON.stringify(evidence, null, 2) + '\n'); });
