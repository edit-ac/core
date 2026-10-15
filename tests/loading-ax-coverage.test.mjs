import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAXOwners, captureAXOwners } from '../scripts/loading-ax-coverage.mjs';
const owners = [{ id: 'a' }, { id: 'b' }];
const dom = { backendNodeId: 1, children: owners.map((o, i) => ({ backendNodeId: 10 + i, attributes: ['data-node-id', o.id], children: [{ backendNodeId: 20 + i }] })) };
const text = (i, value) => ({ nodeId: String(i), backendDOMNodeId: 20 + i, role: { value: 'StaticText' }, name: { value } });
const root = childIds => ({ nodeId: 'root', childIds, role: { value: 'textbox' }, properties: [{ name: 'editable', value: { value: 'richtext' } }] });
test('logical owner coverage follows child edges regardless of inventory order', () => {
  const result = inspectAXOwners([text(1, 'SECRET'), root(['0', '1']), text(0, 'abc')], dom, owners);
  assert.deepEqual(result.missingIndices, []); assert.equal(result.logicalBlocks, 2);
  assert.deepEqual(result.blocks.map(b => b.logicalUnits), [3, 6]);
  assert(!JSON.stringify(result).includes('SECRET'));
});
test('disconnected text remains visible as inventory-only owner coverage', () => {
  const result = inspectAXOwners([root(['0']), text(0, 'abc'), text(1, 'def')], dom, owners);
  assert.deepEqual(result.missingIndices, [1]);
  assert.deepEqual(result.blocks[1], { index: 1, owner: 'b', logicalUnits: 0, inventoryUnits: 3 });
});
test('absent text is distinguished from disconnected text', () => {
  const result = inspectAXOwners([root(['0']), text(0, 'abc')], dom, owners);
  assert.equal(result.blocks[1].inventoryUnits, 0);
});
test('broken logical edges and absent editable root fail closed', () => {
  assert.throws(() => inspectAXOwners([root(['missing'])], dom, owners), /Incomplete/);
  assert.throws(() => inspectAXOwners([root(['root'])], dom, owners), /Cyclic/);
  assert.throws(() => inspectAXOwners([], dom, owners), /No editable/);
});

test('intermediate AX inspection is opt-in so diagnostics cannot conceal the final failure', async () => {
  const { installLayoutProbe } = await import('../scripts/loading-layout-probe.mjs');
  const previous = globalThis.window;
  try {
    let calls = 0;
    globalThis.window = { __loadingLayoutAction: async () => { calls++; return { missingIndices: [0] }; } };
    const editor = { read: () => ({ visible: [{ kind: 'block', id: 'a' }] }) };
    installLayoutProbe({ enabled: true });
    await window.__loadingAXStage(editor, 'before-first-edit');
    assert.equal(calls, 0); assert.deepEqual(window.__loadingAXStages, []);
    installLayoutProbe({ enabled: true, stages: true });
    await window.__loadingAXStage(editor, 'before-first-edit');
    assert.equal(calls, 1); assert.deepEqual(window.__loadingAXStages, [{ stage: 'before-first-edit', missingIndices: [0] }]);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('owner mapping reuses the original AX inventory without a second refreshing query', async () => {
  const calls = [];
  const cdp = { send: async (method, params) => { calls.push({ method, params }); return { root: dom }; } };
  const result = await captureAXOwners(cdp, owners, [root(['0']), text(0, 'abc')]);
  assert.deepEqual(result.missingIndices, [1]);
  assert.deepEqual(calls, [{ method: 'DOM.getDocument', params: { depth: -1 } }]);
});
