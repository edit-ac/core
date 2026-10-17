import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { browserHarness } from '../browser-harness.ts';
import { InteractionHarness } from '../interaction-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../interaction-fixtures/harness.json', import.meta.url), 'utf8'));
const { probe, facts } = browserHarness('interaction-harness', 'fixtures/browser-input', {
  autoMount: false, testFile: 'tests/browser/interactions/harness.spec.ts',
  sourcePaths: [...browserInputSources, 'tests/browser/interaction-harness.ts',
    'tests/interaction-fixtures/harness.json', 'tests/interaction-fixtures/case-index.json',
    'tests/interaction-fixtures/catalog.mjs', 'scripts/test-interactions.mjs'],
});
facts.binding = { gate: 'INT-1.1', fixtureIds: fixtures.map(f => f.id),
  profile: 'RGS real mounted paragraph adapter, WASM engine, IndexedDB and native semantic history',
  provenance: 'prepared native DOM replay; no OS/AT qualification or feature-case completion' };

for (const fixture of fixtures) test(`INT-1.1 ${fixture.id}: independent semantic/selection/effect snapshot`, () => probe(fixture.id, async (page, fact) => {
  const harness = new InteractionHarness(page);
  await harness.mount(fixture.initial);
  const result = await harness.step(fixture.action, fixture.expected);
  fact.snapshots.push(result);
  await harness.checkpoint(fixture.expected, { local: 1, remote: 0, undo: 1 });
  fact.negativeControls = [];
  for (const [name, mutate] of [
    ['semantic', e => e.state.blocks[0].text += '?'],
    ['marks', e => e.state.blocks[0].marks.push({ from: 0, to: 1, type: 'bold' })],
    ['selection', e => e.state.selection.focus.offset++],
    ['direction', e => e.state.selection.affinity = 'backward'],
    ['pending-marks', e => e.state.pendingMarks = []],
    ['duplicate-commit', e => e.effects.localCommits++],
  ]) {
    const wrong = structuredClone(fixture.expected); mutate(wrong);
    await assert.rejects(harness.checkpoint(wrong, { local: 1, remote: 0, undo: 1 }), assert.AssertionError);
    fact.negativeControls.push(name);
  }
  await assert.rejects(harness.checkpoint(fixture.expected, { local: 1, remote: 0, undo: 2 }), /semantic history/);
  fact.negativeControls.push('history');
  await harness.select(fixture.navigation);
  const navigation = structuredClone(fixture.expected); navigation.state.selection = fixture.navigation;
  fact.snapshots.push(await harness.checkpoint(navigation, { local: 1, remote: 0, undo: 1 }));
  fact.provenance = 'real DOM input/observer replay plus mapped backward selection, actual persisted update and history';
}));

test('INT-1.1 absent real engine is a failure, never prepared success', () => probe('INT-harness-missing-engine', async (page, fact) => {
  const harness = new InteractionHarness(page);
  await harness.mount(fixtures[0].initial);
  await page.evaluate(() => { window.savedInteractionFixture = window.inputFixture; delete window.inputFixture; });
  try { await assert.rejects(harness.requireEngine(), /requires a mounted real engine/); }
  finally { await page.evaluate(() => { window.inputFixture = window.savedInteractionFixture; delete window.savedInteractionFixture; }); }
  fact.negativeControls = ['absent-real-engine'];
}));

test('INT-1.1 unsupported structural profiles reject before adapter mutation', () => probe('INT-harness-unsupported-profile', async (page, fact) => {
  const harness = new InteractionHarness(page);
  await harness.mount(fixtures[0].initial);
  const before = await harness.observe();
  for (const mutate of [
    s => s.blocks[0].kind = 'code',
    s => s.blocks[0].marks = [{ from: 0, to: 1, type: 'bold' }],
    s => s.blocks[0].hardBreaks = [1], s => s.pendingMarks = [],
    s => s.blocks.push({ ...s.blocks[0], id: 'p2' }),
  ]) {
    const unsupported = structuredClone(fixtures[0].initial); mutate(unsupported);
    await assert.rejects(harness.mount(unsupported), /Unsupported browser recipe profile/);
  }
  const after = await harness.observe();
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.observed.patches, before.observed.patches);
  assert.deepEqual(after.observed.history, before.observed.history);
  fact.snapshots.push(before, after); fact.negativeControls = ['code', 'marks', 'hard-break', 'pending-marks', 'multiple-blocks'];
}));
