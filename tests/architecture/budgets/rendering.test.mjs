import { fixture } from '../../../benchmarks/fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { admitMeasuredConsumer } from '../../../scripts/consumers-loading.mjs';
import { inspectRenderTrace } from '../../../scripts/loading-render-attribution.mjs';
import { validateLoadingPolicy, inspectLoadings, loadingInputs } from '../../../scripts/loading-evidence.mjs';
import { digest, verifyPins, validateFitnessProfile } from '../../../scripts/architecture-budgets.mjs';
const root = resolve(import.meta.dirname, '../../..');
const read = path => readFile(resolve(root, path));
const index = JSON.parse(await read('benchmarks/profiles/loading-render-evidence.json'));
assert.match(index.directory, /^architecture-results\/fit-1\.8-[a-z0-9/-]+$/);
assert(!index.directory.includes('..'));
const bytes = await read(`${index.directory}/results.json`), record = JSON.parse(bytes);
const profileBytes = await read('benchmarks/profiles/loading-v1.json'), profile = JSON.parse(profileBytes);
const fitnessPolicy = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
test('rendering evidence binds all packed fixed-corpus pairs, current sources and numeric main-thread events', async () => {
  validateFitnessProfile(fitnessPolicy, await read('benchmarks/config.json'), await read('../architecture/specs/verification.md'));
  validateLoadingPolicy(fitnessPolicy, record);
  assert.equal(record.metadata.renderAttribution, 'cdp-rendering-v1');
  assert.equal(record.metadata.commandAttribution, 'packed-observer-exports-v1');
  assert.equal(record.profileHash, digest(profileBytes)); assert.equal(index.resultsHash, digest(bytes));
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), [...loadingInputs].sort());
  await verifyPins(root, record.sourceInputs);
  await verifyPins(resolve(root, index.directory), record.artifacts);
  assert.deepEqual(record.consumer, await admitMeasuredConsumer(resolve(root, index.directory, 'packed')));
  for (const [path, hash] of Object.entries(record.consumer.inputHashes)) if (path !== 'task.mjs') {
    assert.equal(digest(await read(path.replace('node_modules/@edit-ac/', 'packages/'))), hash, `Current rendering packed input differs: ${path}`);
  }
  assert.equal(digest(await read('packages/core/dist/wasm/editac_wasm_bg.wasm')), record.consumer.assets.find(a => a.name === 'wasm/editac_wasm_bg.wasm').sha256);

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

// Backend IDs are local to each navigation. The retained roots describe the
// timed layout's scope, not separate per-family costs or a production speedup.
function inspectRoots(raw) {
  const value = raw.layoutRoots;
  assert.equal(value?.version, 'cdp-layout-roots-v1');
  assert.deepEqual(Object.keys(value).sort(), ['domNodes', 'editorFamilies', 'layouts', 'roots', 'scope', 'version', 'windowMs']);
  assert.equal(value.windowMs, raw.samples.firstFrameMs);
  const events = raw.renderTrace.events.filter(e => e.name === 'Layout');
  assert.deepEqual(value.layouts.map(e => ({ name: 'Layout', startMs: e.startMs, durationMs: e.durationMs })), events);
  assert(value.domNodes > 0 && value.roots.length > 0);
  const byId = new Map(value.roots.map(r => [r.backendNodeId, r]));
  assert.equal(byId.size, value.roots.length);
  for (const event of value.layouts) {
    assert.deepEqual(Object.keys(event).sort(), ['backendNodeIds', 'dirtyObjects', 'durationMs', 'partialLayout', 'startMs', 'totalObjects']);
    assert(event.dirtyObjects >= 0 && event.totalObjects >= event.dirtyObjects);
    assert.equal(typeof event.partialLayout, 'boolean'); assert(event.backendNodeIds.length > 0);
    for (const id of event.backendNodeIds) assert(byId.has(id), 'Unresolved timed layout root');
  }
  for (const root of value.roots) {
    assert.deepEqual(Object.keys(root).sort(), ['ancestors', 'backendNodeId', 'containsEditor', 'families', 'family', 'insideEditor', 'tag']);
    for (const ancestor of root.ancestors) assert.deepEqual(Object.keys(ancestor).sort(), ['backendNodeId', 'tag']);
    for (const [family, count] of Object.entries(root.families)) { assert(['paragraph', 'heading', 'code', 'list', 'list-item', 'quote'].includes(family)); assert(Number.isSafeInteger(count) && count > 0); }
    assert(Number.isSafeInteger(root.backendNodeId) && root.backendNodeId > 0);
    assert.equal(root.ancestors[0].backendNodeId, root.backendNodeId);
    assert.equal(root.ancestors[0].tag, root.tag);
    if (root.containsEditor) assert.deepEqual(root.families, value.editorFamilies);
  }
  return value;
}
test('layout-root attribution covers every exact packed cold/warm corpus and resolves timed backend IDs', () => {
  assert.equal(record.metadata.layoutRootAttribution, 'cdp-layout-roots-v1');
  let windows = 0;
  for (const item of record.cases) {
    const data = fixture(item.fixture);
    const expected = {
      paragraph: data.blocks.filter(b => b.attributes.type === 'paragraph').length,
      heading: data.blocks.filter(b => b.attributes.type === 'heading').length,
      code: data.blocks.filter(b => b.attributes.type === 'code').length,
      list: new Set(data.blocks.flatMap(b => (b.containers ?? []).map(c => c.key))).size,
      'list-item': data.blocks.filter(b => b.containers?.length).length,
    };
    for (const pair of item.pairs) for (const mode of ['cold', 'warm']) {
      assert.deepEqual(inspectRoots(pair[mode]).editorFamilies, expected); windows++;
    }
  }
  assert.equal(windows, 96);
});
for (const [name, mutate] of Object.entries({
  missing: r => delete r.layoutRoots,
  clock: r => r.layoutRoots.windowMs++,
  'missing timed root': r => r.layoutRoots.layouts[0].backendNodeIds = [],
  unresolved: r => r.layoutRoots.layouts[0].backendNodeIds = [2147483647],
  'wrong event': r => r.layoutRoots.layouts[0].durationMs++,
  'wrong families': r => r.layoutRoots.roots[0].families.paragraph++,
  duplicate: r => r.layoutRoots.roots.push(r.layoutRoots.roots[0]),
  payload: r => r.layoutRoots.roots[0].text = 'private',
  'trace payload': r => r.layoutRoots.layouts[0].url = 'private',
})) test(`layout-root attribution rejects ${name}`, () => { const raw = structuredClone(record.cases[0].pairs[0].cold); mutate(raw); assert.throws(() => inspectRoots(raw)); });
