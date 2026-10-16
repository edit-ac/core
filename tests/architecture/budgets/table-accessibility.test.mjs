import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
import { workload } from '../../../benchmarks/workloads.mjs';
import { inspectWorkloads } from '../../../scripts/workload-evidence.mjs';
import { inspectTableInputSamples, inspectTableAccessibility } from '../../../scripts/table-workload-accessibility.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = file => readFile(resolve(root, file));
const profileBytes = await read('benchmarks/profiles/table-accessibility-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/table-accessibility-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const tables = record.cases.filter(c => c.kind === 'table-selection');
const rows = item => workload(profile, item.scale, item.kind).blocks[0].attributes.tuple[2].rows;
const evidence = { version: 1, parent: 'FIT-1.8', child: 'FIT-1.8-I1-B7', qualification: 'unqualified',
  owningStatus: record.status, owningCounts: record.counts, inputOnly: [], gaps: [], artifacts: {} };

test('table observations retain exact producer, full corpus, runtime, raw evidence and cleanup identities', async () => {
  assert.equal(digest(bytes), index.resultsHash); assert.equal(record.profileHash, digest(profileBytes));
  await verifyPins(root, record.sourceInputs); await verifyPins(resolve(root, index.directory), record.artifacts);
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

after(async () => {
  assert(process.env.EDITAC_ARCHITECTURE_OUTPUT);
  await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'table-accessibility-inventory.json'), JSON.stringify(evidence, null, 2) + '\n');
});
