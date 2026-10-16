import { admitOptionalLoading } from '../../../scripts/optional-loading-evidence.mjs';
import { build } from 'esbuild';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, verifyPins, validateFitnessProfile } from '../../../scripts/architecture-budgets.mjs';
import { workload, canonicalWorkload, projectedWorkload } from '../../../benchmarks/workloads.mjs';
import { init } from '../../../packages/core/dist/index.js';
import { inspectWorkloads, validateWorkloadPolicy, workloadInputs, workloadBuildProof, inspectWorkloadBuild } from '../../../scripts/workload-evidence.mjs';
import { inspectTableInputSamples, inspectTableAccessibility } from '../../../scripts/table-workload-accessibility.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFile(resolve(root, file));
const profileBytes = await read('benchmarks/profiles/table-accessibility-v1.json'), profile = JSON.parse(profileBytes);
const fitnessPolicy = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
const index = JSON.parse(await read('benchmarks/profiles/table-accessibility-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const tables = record.cases.filter(c => c.kind === 'table-selection');
const rows = item => workload(profile, item.scale, item.kind).blocks[0].attributes.tuple[2].rows;
const evidence = { version: 1, parent: 'FIT-1.8', child: 'FIT-1.8-I1-B7', qualification: 'unqualified',
  owningStatus: record.status, owningCounts: record.counts, inputOnly: [], gaps: [], artifacts: {} };

test('table observations retain exact producer, full corpus, runtime, raw evidence and cleanup identities', async () => {
  validateFitnessProfile(fitnessPolicy, await read('benchmarks/config.json'), await read('../architecture/specs/verification.md'));
  validateWorkloadPolicy(fitnessPolicy, record);
  assert.equal(digest(bytes), index.resultsHash); assert.equal(record.profileHash, digest(profileBytes));
  const inputs = workloadInputs(root, 'benchmarks/profiles/table-accessibility-v1.json');
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), inputs.sort());
  await verifyPins(root, record.sourceInputs); await verifyPins(resolve(root, index.directory), record.artifacts);
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm', 'editac_runtime.js']) assert.equal(digest(await read(`packages/core/dist/wasm/${file}`)), record.artifacts[`harness/wasm/${file}`]);
  const optionalBytes = await read(`${record.metadata.optionalLoading.directory}/optional-loading.json`);
  assert.equal(digest(optionalBytes), record.metadata.optionalLoading.receiptHash);
  const optional = JSON.parse(optionalBytes);
  await admitOptionalLoading(root, record.metadata.optionalLoading.directory, optional);
  assert.deepEqual(JSON.parse(await read(`${index.directory}/inputs/optional-loading.json`)), optional);
  inspectWorkloadBuild(record, optional);
  const rebuilt = await build({ stdin: { contents: 'export {createEditor,taskPreset,CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core"; export {contentModules} from "@edit-ac/web";', resolveDir: root },
    write: false, bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  assert.equal(digest(rebuilt.outputFiles[0].contents), record.artifacts['harness/sdk.js']);
  assert.equal(record.cases.length, 16); assert.equal(record.counts.executed, 16); assert.equal(record.counts.skipped, 0);
  assert.equal(tables.length, 4); assert(record.metadata.cpu && record.metadata.browser && record.metadata.hostOS);
  assert(record.cleanup.browserExited && record.cleanup.serverClosed && record.cleanup.temporaryRemoved);
  evidence.artifacts[`${index.directory}/results.json`] = index.resultsHash;
});

for (const item of tables) test(`${item.scale}/${item.preset} trusted table input is independently admitted or explicitly incomplete`, () => {
  const complete = item.tableAccessibility?.samples?.length === profile.samples && item.tableAccessibility.samples.every(s => !s.failure);
  if (complete) evidence.inputOnly.push({ scale: item.scale, preset: item.preset, ...inspectTableInputSamples(profile, item, rows(item)) });
  else {
    assert.throws(() => inspectTableInputSamples(profile, item, rows(item)));
    assert(item.failure, 'Missing durable failure for incomplete table input');
    evidence.gaps.push(`${item.scale}/${item.preset}: trusted input incomplete; see owning raw failure`);
  }
  // A valid input-only observation never substitutes for persisted reopening.
  if (!item.tableAccessibility?.reopened) {
    assert.throws(() => inspectTableAccessibility(profile, item, rows(item)), /reopen/);
    evidence.gaps.push(`${item.scale}/${item.preset}: persisted reopen unqualified`);
  }
});

for (const item of tables) test(`${item.scale}/${item.preset} retained acknowledged journal replays from the original persisted checkpoint`, async () => {
  const frozen = JSON.parse(await read(`${index.directory}/fixtures/${item.scale}-table-selection.checkpoint.json`));
  const proof = item.tableAccessibility.persistedJournal;
  assert(proof, 'Actual persisted journal proof missing');
  assert.equal(proof.checkpointBytes, frozen.checkpoint.bytes.length);
  const journal = [];
  for (const entry of proof.entries) {
    const bytes = await read(`${index.directory}/${entry.file}`);
    assert.equal(bytes.length, entry.byteLength); assert.equal(digest(bytes), entry.checksum);
    assert.equal(record.artifacts[entry.file], entry.checksum);
    journal.push({identity:entry.identity, bytes:new Uint8Array(bytes)});
  }
  assert.equal(journal.length, profile.samples * 4);
  const runtime = await init('data:application/wasm;base64,' + (await read('packages/core/dist/wasm/editac_wasm_bg.wasm')).toString('base64'));
  const engine = runtime.restoreEngine(frozen.identity, {...frozen.checkpoint, bytes:Uint8Array.from(frozen.checkpoint.bytes)}, journal);
  try { assert.equal(digest(canonicalWorkload(projectedWorkload(engine.read()))), item.expectedSemanticHash); }
  finally { engine.dispose(); }
});

test('full table matrix admission rejects failed or incomplete owning evidence', () => {
  if (record.status === 'diagnostic') inspectWorkloads(profile, record);
  else { assert(record.errors.length > 0 && record.counts.failed > 0); assert.throws(() => inspectWorkloads(profile, record)); }
});

test('all four fixed table configurations complete twelve trusted input replays and full AX coverage', () => {
  for (const item of tables) {
    const result = inspectTableInputSamples(profile, item, rows(item));
    assert.equal(result.samples, 12); assert.equal(result.axStages, 2);
  }
});

test('owning full table input and persisted reopen matrix passes without missing or failed cases', () => {
  inspectWorkloads(profile, record);
});

const seed = tables.find(c => c.scale === 'Task' && c.tableAccessibility.samples.length === profile.samples);
assert(seed, 'Need actual complete Task input observations for detector controls');
for (const [name, change] of [
  ['missing proof', r => delete r.tableAccessibility],
  ['missing replay', r => r.tableAccessibility.samples.pop()],
  ['synthetic event', r => r.tableAccessibility.samples[0].events[0].trusted = false],
  ['missing mouse', r => r.tableAccessibility.samples[0].events = r.tableAccessibility.samples[0].events.filter(e => e.pointerType !== 'mouse')],
  ['missing touch', r => r.tableAccessibility.samples[0].events = r.tableAccessibility.samples[0].events.filter(e => e.pointerType !== 'touch')],
  ['wrong keyboard focus', r => r.tableAccessibility.samples[0].tabFocus.column = 7],
  ['missing semantic edit', r => r.tableAccessibility.samples[0].committedValue = r.tableAccessibility.samples[0].original],
  ['unrestored semantics', r => r.tableAccessibility.samples[0].semanticRestored = false],
  ['missing AX cell', r => r.tableAccessibility.samples[0].initialAX.pop()],
  ['duplicate AX cell', r => r.tableAccessibility.samples[0].initialAX[1] = r.tableAccessibility.samples[0].initialAX[0]],
  ['wrong AX value', r => r.tableAccessibility.samples[0].initialAX[0].value = 'wrong'],
  ['ignored AX cell', r => r.tableAccessibility.samples[0].initialAX[0].ignored = true],
  ['missing final AX', r => delete r.tableAccessibility.samples.at(-1).finalAX],
  ['reordered input clock', r => r.tableAccessibility.samples[1].start = 0],
  ['invented qualification', r => r.tableAccessibility.scope = 'screen-reader qualified'],
]) test(`table input admission rejects ${name}`, () => {
  const item = structuredClone(seed); change(item);
  assert.throws(() => inspectTableInputSamples(profile, item, rows(seed)));
});

for (const [name, change] of [
  ['missing journal', r => delete r.tableAccessibility.persistedJournal],
  ['missing acknowledged update', r => r.tableAccessibility.persistedJournal.entries.pop()],
  ['checkpoint-only substitution', r => r.tableAccessibility.persistedJournal.checkpointSameAsSeed = false],
  ['duplicate acknowledged identity', r => r.tableAccessibility.persistedJournal.entries[1].updateId = r.tableAccessibility.persistedJournal.entries[0].updateId],
  ['journal sequence gap', r => r.tableAccessibility.persistedJournal.entries[1].sequence++],
  ['missing retained payload', r => delete r.tableAccessibility.persistedJournal.entries[0].file],
  ['missing retained hash', r => r.tableAccessibility.persistedJournal.entries[0].checksum = 'unknown'],
]) test(`full table admission rejects ${name}`, () => {
  const item = structuredClone(seed); change(item);
  assert.throws(() => inspectTableAccessibility(profile, item, rows(seed)));
});

for (const [name, change] of [
  ['missing policy', r => delete r.metadata.verificationPolicy],
  ['stale policy', r => r.metadata.verificationPolicy.sha256 = '0'.repeat(64)],
  ['wrong policy source', r => r.metadata.verificationPolicy.source = 'prepared'],
  ['missing retained policy', r => delete r.artifacts['policy/verification.md']],
  ['changed retained policy', r => r.artifacts['policy/verification.md'] = '0'.repeat(64)],
  ['unreviewed policy', r => r.metadata.verificationPolicy.reviewedAt = r.metadata.startedAt],
  ['measurement before review', r => r.metadata.startedAt = fitnessPolicy.reviewedAt],
]) test(`workload policy rejects ${name}`, () => {
  const changed = structuredClone(record); change(changed);
  assert.throws(() => validateWorkloadPolicy(fitnessPolicy, changed));
});
after(async () => {
  assert(process.env.EDITAC_ARCHITECTURE_OUTPUT);
  await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'table-accessibility-inventory.json'), JSON.stringify(evidence, null, 2) + '\n');
});

const changedRecord = change => { const r = structuredClone(record); change(r); return r; };
for (const [name, change] of [
  ['missing build', r => delete r.buildProvenance],
  ['stale receipt', r => r.buildProvenance.receiptHash = '0'.repeat(64)],
  ['missing receipt', r => delete r.artifacts['inputs/optional-loading.json']],
  ['future build', r => r.buildProvenance.startedAt = r.metadata.startedAt],
  ['missing output', r => delete r.buildProvenance.outputs['packages/core/dist/wasm/editac_runtime.js']],
  ['unretained output', r => delete r.artifacts['source-build/packages/core/dist/wasm/editac_wasm_bg.wasm']],
  ['different executed WASM', r => r.artifacts['harness/wasm/editac_wasm_bg.wasm'] = '0'.repeat(64)],
  ['different executed glue', r => r.artifacts['harness/wasm/editac_runtime.js'] = '0'.repeat(64)],
  ['missing command', r => r.buildProvenance.commands.pop()],
  ['failed source build', r => r.buildProvenance.commands[0].exit = 1],
  ['wrong source build', r => r.buildProvenance.commands[0].command.push('--markdown')],
  ['unretained log', r => delete r.artifacts[`source-build/${r.buildProvenance.commands[0].log}`]],
]) test(`workload source build rejects ${name}`, () => assert.throws(() => inspectWorkloadBuild(changedRecord(change))));
test('workload source build rejects changed upstream inputs and command identities', async () => {
  const optional = JSON.parse(await read(`${record.metadata.optionalLoading.directory}/optional-loading.json`));
  const stale = structuredClone(optional); stale.sourceInputs['Cargo.lock'] = '0'.repeat(64);
  assert.throws(() => inspectWorkloadBuild(record, stale), /source mismatch/);
  const wrong = structuredClone(optional); wrong.commands[0].label = 'prepared';
  assert.throws(() => inspectWorkloadBuild(record, wrong), /build mismatch/);
  assert.deepEqual(record.buildProvenance, workloadBuildProof(optional, record.metadata.optionalLoading.receiptHash));
});
