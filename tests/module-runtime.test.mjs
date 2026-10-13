import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModuleRuntime } from '../packages/web/dist/index.js';
function harness(options) {
  let callback, active = true, disposed = 0;
  const engine = { read() { throw Error('runtime must not scan the document'); }, subscribe(scope, cb) {
    assert.deepEqual(scope, { type: 'all' }); callback = cb;
    return { get active() { return active; }, dispose() { active = false; disposed++; } };
  } };
  const runtime = new ModuleRuntime(engine, options);
  return { runtime, emit: overrides => callback({ operation: 'Text', changedSources: [], touchedRanges: [], nodes: [], selectionChanged: false, selection: null, update: null, ...overrides }), stopEngine: () => { active = false; }, disposed: () => disposed };
}
const delta = (source, start, oldEnd = start, newEnd = start + 1) => ({ source, start, newStart: start, oldEnd, newEnd });
const pos = (source, sourceOffset) => ({ type: 'position', node: 'n', offset: sourceOffset, source, sourceOffset, bias: 'right' });
const content = { type: 'demo.badge', version: 1, kind: 'inline-atom', text: 'label 😀', attributes: { label: 'label' } };
test('operation and source range indexes exclude unrelated updates without reading snapshots', () => {
  const h = harness(), calls = []; const scope = { kinds: ['Text'], range: { source: 's1', start: 4, end: 8 } };
  h.runtime.subscribe(scope, event => calls.push(event.patch.operation));
  scope.kinds[0] = 'Remote'; scope.range.source = 's2';
  h.emit({ touchedRanges: [delta('s2', 5)] }); h.emit({ touchedRanges: [delta('s1', 0)] });
  h.emit({ operation: 'Format', touchedRanges: [delta('s1', 5)] });
  assert.deepEqual(calls, []);
  h.emit({ touchedRanges: [delta('s1', 4)] }); h.emit({ touchedRanges: [delta('s1', 8)] });
  h.emit({ touchedRanges: [delta('s1', 0, 9, 0)] });
  assert.deepEqual(calls, ['Text', 'Text', 'Text']); h.runtime.dispose();
});
test('format/structure deltas and source removal notify only affected ranges once', () => {
  const h = harness(), calls = [];
  h.runtime.subscribe({ kinds: ['Format', 'Structure'], range: { source: 's', start: 4, end: 8 } }, e => calls.push(e.patch.operation));
  h.emit({ operation: 'Format', nodes: [{ type: 'visible', node: { spans: [{ source: 's', start: 0, end: 3 }] } }] });
  h.emit({ operation: 'Format', nodes: [{ type: 'visible', node: { spans: [{ source: 's', start: 4, end: 9 }] } }], touchedRanges: [delta('s', 5)] });
  h.emit({ operation: 'Structure', nodes: [{ type: 'removed', id: 'n' }], changedSources: ['s'] });
  assert.deepEqual(calls, ['Format', 'Structure']); h.runtime.dispose();
});
test('selection opt-in filters crossings, deduplicates captures and notifies departure', () => {
  const h = harness(); let all = 0, scoped = 0, text = 0;
  h.runtime.subscribe({ kinds: [], selection: true }, () => all++);
  h.runtime.subscribe({ kinds: [], selection: true, range: { source: 's', start: 4, end: 8 } }, () => scoped++);
  h.runtime.subscribe({ kinds: ['Text'] }, () => text++);
  const selected = { anchor: pos('s', 1), focus: pos('s', 10) };
  h.runtime.setSelection(selected); h.runtime.setSelection(selected);
  h.runtime.setSelection({ anchor: pos('other', 1), focus: pos('other', 1) }); h.runtime.setSelection(null);
  assert.deepEqual([all, scoped, text], [3, 2, 0]);
  h.emit({ operation: 'Selection', selectionChanged: true, selection: selected });
  assert.deepEqual([all, scoped, text], [4, 3, 0]); h.runtime.dispose();
});
test('callbacks and diagnostic failures are isolated with bounded errors', () => {
  const h = harness({ onError() { throw Error('reporter'); } }); let good = 0;
  h.runtime.subscribe({}, () => { throw { toString() { throw Error('conversion'); } }; });
  h.runtime.subscribe({}, () => good++);
  for (let i = 0; i < 80; i++) h.emit({});
  assert.equal(good, 80); const errors = h.runtime.takeErrors(); assert.equal(errors.length, 64);
  assert.ok(errors.every(e => e.phase === 'subscription' && e.message === 'Module callback failed'));
  assert.deepEqual(h.runtime.takeErrors(), []); h.runtime.dispose();
});
test('disposal during dispatch skips removed listeners and additions start next event', () => {
  const h = harness(); const calls = []; let later;
  h.runtime.subscribe({}, () => { calls.push('first'); later.dispose(); h.runtime.subscribe({}, () => calls.push('new')); });
  later = h.runtime.subscribe({}, () => calls.push('removed'));
  h.emit({}); assert.deepEqual(calls, ['first']); h.emit({}); assert.deepEqual(calls, ['first', 'first', 'new']);
  h.runtime.dispose(); h.emit({}); assert.deepEqual(calls, ['first', 'first', 'new']);
  assert.equal(later.active, false); assert.equal(h.disposed(), 1); h.runtime.dispose(); assert.equal(h.disposed(), 1);
  assert.throws(() => h.runtime.subscribe({}, () => {}));
});
test('invalid scopes reject before acquiring listener ownership', () => {
  const h = harness();
  for (const range of [{ source: '', start: 0, end: 1 }, { source: 's', start: -1, end: 2 }, { source: 's', start: 2, end: 1 }, { source: 's', start: 0.5, end: 2 }]) assert.throws(() => h.runtime.subscribe({ range }, () => {}));
  assert.throws(() => h.runtime.subscribe({}, null));
  assert.throws(() => h.runtime.subscribe({ kinds: ['unknown'] }, () => {})); h.runtime.dispose();
});
test('owned views receive immutable detached content and release resources once', () => {
  const calls = [], renderer = { mount(element, initial) {
    calls.push(['mount', initial.text]); assert.ok(Object.isFrozen(initial.attributes));
    return { update(next) { calls.push(['update', next.text]); assert.ok(Object.isFrozen(next)); }, dispose() { calls.push(['dispose']); } };
  } };
  const h = harness({ renderers: { 'demo.badge': renderer } }); renderer.mount = () => { throw Error('changed host registration'); };
  let removed = 0;
  const input = structuredClone(content); const view = h.runtime.mountView({ remove() { removed++; } }, input, () => assert.fail('fallback'));
  input.attributes.label = 'changed'; view.update({ ...content, text: 'next' });
  h.runtime.dispose(); view.dispose(); view.update(content);
  assert.deepEqual(calls, [['mount', 'label 😀'], ['update', 'next'], ['dispose']]); assert.equal(removed, 1);
});
test('failed view update removes decoration and disposes even when cleanup throws', () => {
  let clean = 0, fallback = 0;
  const h = harness({ renderers: { 'demo.badge': { mount() { return { update() { throw Error('update failed'); }, dispose() { clean++; throw Error('cleanup failed'); } }; } } } });
  const view = h.runtime.mountView({ remove() {} }, content, () => fallback++);
  view.update(content); view.update(content); h.runtime.dispose(); view.dispose();
  assert.deepEqual([clean, fallback], [1, 1]); assert.deepEqual(h.runtime.takeErrors().map(e => e.phase), ['update', 'dispose']);
});
test('missing and failing mounts preserve fallback and disposed engines suppress callbacks', () => {
  let fallback = 0;
  const h = harness({ renderers: { 'demo.badge': { mount() { throw Error('mount failed'); } } } });
  assert.equal(h.runtime.mountView({ remove() {} }, { ...content, type: 'unknown.type' }, () => fallback++), undefined);
  assert.equal(h.runtime.mountView({ remove() {} }, content, () => fallback++), undefined);
  assert.equal(fallback, 1); assert.equal(h.runtime.takeErrors()[0].phase, 'mount');
  const sub = h.runtime.subscribe({}, () => assert.fail('disposed engine')); h.stopEngine(); h.emit({});
  assert.equal(sub.active, false); h.runtime.dispose();
});

test('invalid asynchronous or incomplete view lifecycles reject as mount errors', () => {
  for (const result of [null, {}, { update() {} }, Promise.resolve({ update() {}, dispose() {} })]) {
    let fallback = 0;
    const h = harness({ renderers: { 'demo.badge': { mount() { return result; } } } });
    assert.equal(h.runtime.mountView({ remove() {} }, content, () => fallback++), undefined);
    assert.equal(fallback, 1); assert.equal(h.runtime.takeErrors()[0].phase, 'mount'); h.runtime.dispose();
  }
});

test('invalid pending mounts isolate rejection and dispose late resources after teardown', async () => {
  let resolve, disposed = 0, fallback = 0;
  const pending = new Promise(r => { resolve = r; });
  const h = harness({ renderers: { 'demo.badge': { mount() { return pending; } } } });
  assert.equal(h.runtime.mountView({ remove() {} }, content, () => fallback++), undefined); h.runtime.dispose();
  resolve({ update() {}, dispose() { disposed++; } }); await pending; await Promise.resolve();
  assert.deepEqual([fallback, disposed], [1, 1]);
  const rejected = harness({ renderers: { 'demo.badge': { mount() { return Promise.reject(Error('async rejection')); } } } });
  rejected.runtime.mountView({ remove() {} }, content, () => {}); await Promise.resolve();
  assert.deepEqual(rejected.runtime.takeErrors().map(e => e.phase), ['mount', 'mount']); rejected.runtime.dispose();
});
