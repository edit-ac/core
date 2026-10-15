import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installCommandAttribution, summarizeCommand } from '../benchmarks/loading-command-attribution.mjs';

const sample = () => ({ version: 'packed-command-v1', elapsedMs: 100, dropped: 0, spans: [
  ['storage.command', 1, 98], ['ffi.prepare', 2, 10], ['storage.commitPrepared', 13, 85],
  ['ffi.commit', 14, 20], ['ffi.take_patch', 35, 5], ['render.patch', 41, 50],
].map(([operation, startMs, durationMs]) => ({ operation, startMs, durationMs })) });
test('packed command partition attributes actual prepare/commit/patch and renderer only once', () => {
  const result = summarizeCommand(sample());
  assert.deepEqual(result.exclusiveMs, { 'storage.command': 3, 'storage.commitPrepared': 10, 'ffi.prepare': 10,
    'ffi.commit': 20, 'ffi.take_patch': 5, 'render.patch': 50, other: 2 });
  assert.equal(Object.values(result.exclusiveMs).reduce((a,b) => a+b), 100);
  assert.equal(installCommandAttribution({}), null);
});
for (const [name, change] of Object.entries({
  'missing renderer': t => t.spans.pop(),
  'duplicated boundary': t => t.spans.push(t.spans[1]),
  'forged payload': t => t.spans[1].text = 'private',
  'top-level payload': t => t.text = 'private',
  'unbounded window': t => t.elapsedMs = Infinity,
  'overflow': t => t.dropped++,
  'negative interval': t => t.spans[1].startMs = -1,
  'outside window': t => t.spans[1].durationMs = 101,
  'orphan renderer': t => t.spans.at(-1).startMs = 0,
  'overlapping prepare and commit': t => t.spans[1].durationMs = 20,
  'overlapping commit and renderer': t => t.spans.at(-1).startMs = 30,
  'unknown version': t => t.version = 'other',
})) test(`packed command admission rejects ${name}`, () => { const t = sample(); change(t); assert.throws(() => summarizeCommand(t)); });
