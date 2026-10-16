import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { inspectRenderTrace, startRenderTrace } from '../scripts/loading-render-attribution.mjs';
const raw = { samples: { firstFrameMs: 100 } };
const sample = () => ({ version: 'cdp-rendering-v1', windowMs: 100, events: [
  { name: 'Layout', startMs: 10, durationMs: 20 }, { name: 'Paint', startMs: 40, durationMs: 30 },
  { name: 'Layout', startMs: 80, durationMs: 5 },
] });
test('rendering summaries retain repeated layout count and inclusive cost by kind', () => {
  assert.deepEqual(inspectRenderTrace(sample(), raw).find(e => e.name === 'Layout'), { name: 'Layout', count: 2, durationMs: 25, maxMs: 20 });
});
for (const [name, change] of Object.entries({
  payload: t => t.text = 'private document', eventPayload: t => t.events[0].url = 'private title',
  unknown: t => t.events[0].name = 'FunctionCall', clock: t => t.events[0].startMs = NaN,
  duration: t => t.events[0].durationMs = -1, order: t => t.events.reverse(),
  window: t => t.windowMs++, outside: t => t.events[2].startMs = 100,
  overrun: t => t.events[2].durationMs = 50, missingPaint: t => t.events.splice(1, 1),
  empty: t => t.events = [], overflow: t => t.events = Array(4097).fill(t.events[0]),
})) test(`rendering attribution rejects ${name}`, () => { const trace = sample(); change(trace); assert.throws(() => inspectRenderTrace(trace, raw)); });
class CDP extends EventEmitter {
  constructor(events) { super(); this.events = events; }
  async send(name) {
    if (name === 'Performance.getMetrics') return { metrics: [{ name: 'NavigationStart', value: 1000 }] };
    if (name === 'Tracing.end') {
      this.emit('Tracing.dataCollected', { value: this.events });
      this.emit('Tracing.tracingComplete', {});
    }
    return {};
  }
}
const events = () => [
  { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
  ...sample().events.map(e => ({ ph: 'X', name: e.name, ts: 1e9 + e.startMs * 1000, dur: e.durationMs * 1000, pid: 1, tid: 2, args: { url: 'private', data: { text: 'seeded private document' } } })),
];
test('collector maps navigation clocks and drops all arguments, foreign threads and later editing work', async () => {
  const values = events(); values.push({ ...values[1], tid: 9 }, { ...values[1], ts: 1e9 + 120000 });
  const cdp = new CDP(values), finish = await startRenderTrace(cdp);
  assert.deepEqual(await finish(raw), sample());
  assert.equal(cdp.listenerCount('Tracing.dataCollected'), 0);
});
test('collector fails closed on missing navigation/main-thread evidence and releases listeners', async () => {
  const cdp = new CDP(events().slice(1)), finish = await startRenderTrace(cdp);
  await assert.rejects(finish(raw), /navigation\/thread clock/);
  assert.equal(cdp.listenerCount('Tracing.dataCollected'), 0);
});

test('opt-in collector links only timed main-thread roots and resolves them after tracing stops', async () => {
  const values = events();
  for (const e of values.filter(e => e.name === 'Layout')) e.args = { beginData: { dirtyObjects: 2, totalObjects: 4, partialLayout: false }, endData: { layoutRoots: [{ nodeId: 1 }] } };
  values.push({ ...values[1], tid: 9, args: { beginData: { dirtyObjects: 1, totalObjects: 4, partialLayout: true }, endData: { layoutRoots: [{ nodeId: 999 }] } } });
  class RootsCDP extends CDP {
    async send(name) {
      if (name === 'DOM.getDocument') { assert.equal(this.listenerCount('Tracing.tracingComplete'), 0); return { root: { backendNodeId: 1, nodeName: '#document', children: [{ backendNodeId: 2, nodeName: 'DIV', attributes: ['id', 'editor'], children: [{ backendNodeId: 3, nodeName: 'P' }] }] } }; }
      return super.send(name);
    }
  }
  const cdp = new RootsCDP(values), finish = await startRenderTrace(cdp, { layoutRoots: true }), observation = structuredClone(raw);
  assert.deepEqual(await finish(observation), sample());
  assert.equal(observation.layoutRoots.layouts.length, 2); assert.equal(observation.layoutRoots.roots.length, 1);
  assert.equal(observation.layoutRoots.roots[0].backendNodeId, 1); assert.equal(observation.layoutRoots.roots[0].containsEditor, true);
  assert.equal(cdp.listenerCount('Tracing.dataCollected'), 0);
});
test('opt-in collector rejects missing root metadata and releases tracing listeners', async () => {
  const cdp = new CDP(events()), finish = await startRenderTrace(cdp, { layoutRoots: true });
  await assert.rejects(finish(structuredClone(raw)), /missing\/overflow layout roots/);
  assert.equal(cdp.listenerCount('Tracing.dataCollected'), 0);
});
