import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGestureTrace } from '../../../benchmarks/gesture-trace.mjs';
function clock() {
  let next = 0; const scheduled = new Map();
  class Observer { constructor(fn) { this.fn = fn; } observe() {} disconnect() { this.disconnected = true; } takeRecords() { return []; } }
  const host = { performance: { now: () => next }, PerformanceObserver: Observer,
    requestAnimationFrame: fn => { scheduled.set(++next, fn); return next; }, cancelAnimationFrame: id => scheduled.delete(id),
    tick() { const [id, fn] = scheduled.entries().next().value; scheduled.delete(id); fn(++next); }, scheduled };
  return host;
}
test('collector records separate application work per real callback and cancellation clears its request', () => {
  const host = clock(), trace = createGestureTrace(host);
  trace.begin('selection'); trace.note('mapping', 2); trace.note('fullScan'); host.tick(); host.tick();
  const result = trace.end(); assert.equal(result.frames[0].mapping, 2); assert.equal(result.frames[0].fullScan, 1);
  assert.equal(result.frames[1].mapping, 0); assert.equal(host.scheduled.size, 0); assert.equal(trace.active, false);
  trace.note('fullScan'); assert.equal(result.trailingWork.fullScan, 0);
});
test('overflow cannot silently discard events or frame samples', () => {
  const host = clock(), trace = createGestureTrace(host, 1); trace.begin('drag');
  host.tick(); host.tick(); trace.event({ type: 'dragstart', isTrusted: true }); trace.event({ type: 'dragend', isTrusted: true });
  const result = trace.end(); assert.equal(result.dropped, 2); assert.equal(result.frames.length, 1); assert.equal(result.events.length, 1);
});
test('nested or missing measurement windows reject', () => {
  const trace = createGestureTrace(clock()); assert.throws(() => trace.end()); trace.begin('autoscroll'); assert.throws(() => trace.begin('selection')); trace.end();
});
