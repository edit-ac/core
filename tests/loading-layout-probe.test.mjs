import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutProbeCss, runLayoutAction } from '../scripts/loading-layout-probe.mjs';
import { inspectLoadings } from '../scripts/loading-evidence.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';
test('unknown CSS experiment fails before launching a browser', () => {
  assert.throws(() => layoutProbeCss('hidden'), /Unknown/);
  assert.equal(layoutProbeCss('control'), '');
  assert.match(layoutProbeCss('auto'), /content-visibility:auto/);
});
for (const mode of ['control', 'auto']) test(`experimental ${mode} cannot enter canonical loading admission`, () => {
  assert.throws(() => inspectLoadings({}, { metadata: { layoutProbe: `experimental-${mode}-v1` } }), /Experimental layout/);
});
test('removing metadata cannot launder experimental behavior into admission', () => {
  assert.throws(() => inspectLoadings({}, { cases: [{ pairs: [{ warm: { layoutProbe: {} } }] }] }), /Experimental layout/);
});
const nodes = () => fixture('Task').blocks.map(b => ({ nodeId: String(b.runs[0].text), ignored: false, role: { value: 'StaticText' }, name: { value: b.runs[0].text } }));
const editable = { nodeId: 'root', childIds: nodes().map(n => n.nodeId), role: { value: 'textbox' }, backendDOMNodeId: 7, ignored: false, properties: [{ name: 'editable', value: { value: 'richtext' } }] };
const fake = entries => ({ send: async command => command === 'Accessibility.getFullAXTree' ? { nodes: entries } : {} });
const page = { keyboard: { press: async () => {} }, evaluate: async () => true };
test('AX oracle rejects a missing offscreen block even with an editable node', async () => {
  await assert.rejects(runLayoutAction(page, fake([...nodes().slice(0, -1), editable]), 'accessibility', { name: 'Task' }), /Incomplete accessibility tree/);
});
test('AX oracle rejects reversed same-count content', async () => {
  await assert.rejects(runLayoutAction(page, fake([...nodes(), { ...editable, childIds: [...editable.childIds].reverse() }]), 'accessibility', { name: 'Task' }), /coverage differs/);
});
test('AX oracle rejects full text without an actionable editable node', async () => {
  await assert.rejects(runLayoutAction(page, fake(nodes()), 'accessibility', { name: 'Task' }), /coverage differs/);
});
test('AX oracle rejects failed focus and keyboard action', async () => {
  await assert.rejects(runLayoutAction({ ...page, evaluate: async () => false }, fake([...nodes(), editable]), 'accessibility', { name: 'Task' }), /action failed/);
});
test('AX observation returns bounded counts, not content or qualified screen-reader claims', async () => {
  assert.deepEqual(await runLayoutAction(page, fake([...nodes(), editable]), 'accessibility', { name: 'Task' }), { textNodes: 20, expectedBlocks: 20, exactText: true, focusAndKeyboard: true, screenReaderQualified: false });
});

test('AX oracle excludes unrelated status/control text outside the editor subtree', async () => {
  const outside = { nodeId: 'status', ignored: false, role: { value: 'StaticText' }, name: { value: 'Private outside content' } };
  const observation = await runLayoutAction(page, fake([...nodes(), outside, editable]), 'accessibility', { name: 'Task' });
  assert.equal(observation.textNodes, 20);
  assert(!JSON.stringify(observation).includes('Private'));
});

test('retained CSS experiment artifacts prevent metadata/behavior laundering', () => {
  for (const path of ['experiment.css', 'layout-probe-source.mjs', 'ax-coverage-source.mjs'])
    assert.throws(() => inspectLoadings({}, { artifacts: { [path]: 'hash' } }), /Experimental layout/);
});

test('AX oracle follows logical child order rather than protocol inventory order', async () => {
  const observation = await runLayoutAction(page, fake([...nodes().reverse(), editable]), 'accessibility', { name: 'Task' });
  assert.equal(observation.exactText, true);
});

test('staged AX metadata cannot enter canonical admission after removing the layout label', () => {
  assert.throws(() => inspectLoadings({}, { metadata: { axStageProbes: true } }), /Experimental layout/);
});
