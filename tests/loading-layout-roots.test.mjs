import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutEventData, resolveLayoutRoots } from '../scripts/loading-layout-roots.mjs';
const dom = () => ({ backendNodeId: 1, nodeName: '#document', children: [{ backendNodeId: 2, nodeName: 'BODY', children: [{ backendNodeId: 3, nodeName: 'DIV', attributes: ['id', 'editor', 'title', 'seeded private'], children: [
  { backendNodeId: 4, nodeName: 'P', children: [{ backendNodeId: 5, nodeName: '#text', nodeValue: 'private text' }] },
  { backendNodeId: 6, nodeName: 'H2' }, { backendNodeId: 7, nodeName: 'UL', children: [{ backendNodeId: 8, nodeName: 'LI', children: [{ backendNodeId: 9, nodeName: 'PRE' }] }] },
] }] }] });
const args = () => ({ beginData: { dirtyObjects: 5, totalObjects: 20, partialLayout: false, frame: 'private' }, endData: { layoutRoots: [{ nodeId: 2, quads: [1, 2, 3] }] }, stack: 'private' });
const event = () => ({ startMs: 10, durationMs: 20, ...layoutEventData(args()) });
test('layout diagnostic binds backend roots to nested owner families without content or invented descendant costs', () => {
  const result = resolveLayoutRoots(dom(), [event()], 100);
  assert.deepEqual(result.editorFamilies, { paragraph: 1, heading: 1, list: 1, 'list-item': 1, code: 1 });
  assert.equal(result.roots[0].tag, 'body'); assert.equal(result.roots[0].containsEditor, true); assert.equal(result.roots[0].insideEditor, false);
  assert.deepEqual(result.roots[0].families, result.editorFamilies);
  assert.deepEqual(result.roots[0].ancestors, [{ backendNodeId: 2, tag: 'body' }, { backendNodeId: 1, tag: '#document' }]);
  assert(!/private|nodeValue|quads|stack|title/.test(JSON.stringify(result)));
});
for (const [name, change] of Object.entries({ missing: a => delete a.endData, zero: a => a.endData.layoutRoots = [], invalidId: a => a.endData.layoutRoots[0].nodeId = 0, counters: a => a.beginData.dirtyObjects = 21, partial: a => a.beginData.partialLayout = 1 })) test(`layout arguments reject ${name}`, () => { const a = args(); change(a); assert.throws(() => layoutEventData(a)); });
for (const [name, change] of Object.entries({ unresolved: e => e.backendNodeIds = [999], missing: e => e.backendNodeIds = [], invalid: e => e.backendNodeIds = [-1], clock: e => e.startMs = 101, duration: e => e.durationMs = 100, counter: e => e.totalObjects = 0 })) test(`layout resolution rejects ${name}`, () => { const e = event(); change(e); assert.throws(() => resolveLayoutRoots(dom(), [e], 100)); });
test('layout diagnostic distinguishes an internal root from its containing editor', () => { const e = event(); e.backendNodeIds = [8]; const r = resolveLayoutRoots(dom(), [e], 100).roots[0]; assert.equal(r.insideEditor, true); assert.equal(r.containsEditor, false); assert.deepEqual(r.families, { 'list-item': 1, code: 1 }); });
test('layout diagnostic rejects duplicate DOM and missing editor', () => { let d = dom(); d.children.push(d.children[0]); assert.throws(() => resolveLayoutRoots(d, [event()], 100)); d = dom(); d.children[0].children[0].attributes = []; assert.throws(() => resolveLayoutRoots(d, [event()], 100)); });
