import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectRenderTrace } from '../../../scripts/loading-render-attribution.mjs';
import { inspectLoadings, loadingInputs } from '../../../scripts/loading-evidence.mjs';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
const root = resolve(import.meta.dirname, '../../..');
const read = path => readFile(resolve(root, path));
const index = JSON.parse(await read('benchmarks/profiles/loading-render-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/);
assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const profileBytes = await read('benchmarks/profiles/loading-v1.json'), profile = JSON.parse(profileBytes);
test('rendering evidence binds all packed fixed-corpus pairs, current sources and numeric main-thread events', async () => {
  assert.equal(record.metadata.renderAttribution, 'cdp-rendering-v1');
  assert.equal(record.metadata.commandAttribution, 'packed-observer-exports-v1');
  assert.equal(record.profileHash, digest(profileBytes)); assert.equal(index.resultsHash, digest(bytes));
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), [...loadingInputs].sort());
  await verifyPins(root, record.sourceInputs);
  await verifyPins(resolve(root, index.directory), record.artifacts);
  const seed = await read(`${record.seedEvidence.directory}/results.json`);
  assert.equal(digest(seed), record.seedEvidence.resultsHash);
  assert.equal(inspectLoadings(profile, record).length, 24);
  let windows = 0;
  for (const item of record.cases) {
    assert.equal(record.artifacts[`raw/${item.fixture}-${item.preset}.json`], digest(JSON.stringify(item)));
    for (const pair of item.pairs) for (const mode of ['cold', 'warm']) {
      assert.equal(pair[mode].initialHash, pair[mode].finalHash);
      assert.equal(inspectRenderTrace(pair[mode].renderTrace, pair[mode]).length, 5); windows++;
    }
  }
  assert.equal(windows, 96);
});
for (const [name, change] of Object.entries({
  absent: r => delete r.cases[0].pairs[0].cold.renderTrace,
  mislabeled: r => r.metadata.renderAttribution = 'none',
  unknown: r => r.metadata.renderAttribution = 'invented',
  payload: r => r.cases[0].pairs[0].cold.renderTrace.events[0].text = 'private document',
  missingPaint: r => r.cases[0].pairs[0].cold.renderTrace.events = r.cases[0].pairs[0].cold.renderTrace.events.filter(e => e.name !== 'Paint'),
})) test(`owning rendering admission rejects ${name}`, () => {
  const candidate = structuredClone(record); change(candidate); assert.throws(() => inspectLoadings(profile, candidate));
});
