import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { inspectStartup, installStartupAttribution, startupNames } from '../benchmarks/loading-startup-attribution.mjs';
import { instrumentStartupSource } from '../scripts/startup-instrumentation.mjs';
const sample = () => ({ version: 'packed-startup-v1', startMs: 1, elapsedMs: 100, frames: [], frameTiming: 'unavailable', marks: startupNames.map((name, i) => ({ name, elapsedMs: i + 1 })) });
test('valid browser frame retains numeric render/layout timing only', () => { const trace = sample(); trace.frameTiming = 'long-animation-frame'; trace.frames = [{ startTime: 1, duration: 80, blockingDuration: 30, renderStart: 40, styleAndLayoutStart: 50 }]; assert.equal(inspectStartup(trace).length, startupNames.length); });
test('startup observer partitions packed recovery/render/readiness and two frame waits without payloads', () => {
  let now = 0;
  assert.equal(installStartupAttribution({}), null);
  const observer = installStartupAttribution({ diagnosticEngine: {} }, () => ++now);
  observer.begin();
  for (const name of startupNames) observer.mark(name);
  const trace = observer.end(); observer.finish(); observer.dispose();
  assert.equal(inspectStartup(trace).length, startupNames.length);
  assert.equal(inspectStartup(trace).reduce((n, s) => n + s.durationMs, 0), trace.marks.at(-1).elapsedMs);
  assert.throws(() => observer.end());
  observer.begin(); assert.throws(() => observer.begin());
  for (const name of startupNames) observer.mark(name); observer.end();
  delete globalThis.__editacStartupMark;
});
for (const [name, change] of Object.entries({
  missing: t => t.marks.pop(), duplicate: t => t.marks[1] = t.marks[0],
  reordered: t => t.marks.reverse(), unknown: t => t.marks[0].name = 'private',
  payload: t => t.marks[0].text = 'seeded private document',
  nonfiniteStart: t => t.startMs = Infinity,
  unknownFrameApi: t => t.frameTiming = 'invented',
  frameOverflow: t => { t.frameTiming = 'long-animation-frame'; t.frames = Array(33).fill({}); },
  frameOutside: t => { t.frameTiming = 'long-animation-frame'; t.frames = [{ startTime: 102, duration: 80, blockingDuration: 30, renderStart: 140, styleAndLayoutStart: 150 }]; },
  frameBackwards: t => { t.frameTiming = 'long-animation-frame'; t.frames = [{ startTime: 1, duration: 80, blockingDuration: 30, renderStart: 40, styleAndLayoutStart: 30 }]; },
  framePayload: t => { t.frameTiming = 'long-animation-frame'; t.frames = [{ startTime: 1, duration: 80, blockingDuration: 30, renderStart: 40, styleAndLayoutStart: 50, scripts: ['private URL'] }]; },
  topPayload: t => t.content = 'private', negative: t => t.marks[0].elapsedMs = -1,
  nonfinite: t => t.marks[0].elapsedMs = Infinity, outside: t => t.marks.at(-1).elapsedMs = 101,
  backwards: t => t.marks[2].elapsedMs = 0, version: t => t.version = 'other',
})) test(`startup admission rejects ${name}`, () => { const trace = sample(); change(trace); assert.throws(() => inspectStartup(trace)); });
for (const kind of ['entry','editor','render','writer','checkpoint']) test(`startup transform fails closed for installed ${kind} boundaries`, async () => {
  const path = kind === 'render' ? 'dom/render' : ['writer','checkpoint'].includes(kind) ? `storage/${kind}` : kind;
  const source = await readFile(`packages/web/dist/${path}.js`, 'utf8');
  const result = instrumentStartupSource(kind, source);
  assert(result.includes('__editacStartupMark'));
  assert.throws(() => instrumentStartupSource(kind, source.replace(kind === 'render' ? 'const snapshot = engine.read();' : kind === 'entry' ? 'const identity = { ...options.identity };' : kind === 'writer' ? 'writerId = engine.checkpoint().writerId;' : kind === 'checkpoint' ? 'const raw = await this.#readRaw(expected);' : 'this.#session = session;', m => m + m)));
  assert.throws(() => instrumentStartupSource(kind, ''));
});
test('late browser frame delivery is retained without waiting and later command frames are discarded', () => {
  const previous = globalThis.PerformanceObserver;
  let callback, instance, now = 0, disconnected = false;
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ['long-animation-frame'];
    constructor(cb) { callback = cb; instance = this; }
    observe() {}
    takeRecords() { return [{ startTime: 200, duration: 80, blockingDuration: 30, renderStart: 210, styleAndLayoutStart: 220 }]; }
    disconnect() { disconnected = true; }
  };
  try {
    const observer = installStartupAttribution({ diagnosticEngine: {} }, () => ++now);
    observer.begin(); for (const name of startupNames) observer.mark(name);
    const trace = observer.end();
    assert.equal(disconnected, false);
    callback({ getEntries: () => [{ startTime: 1, duration: 80, blockingDuration: 30, renderStart: 40, styleAndLayoutStart: 50, scripts: ['private URL'] }] });
    observer.finish();
    assert(disconnected); assert(instance); assert.equal(trace.frames.length, 1);
    assert.equal(Object.hasOwn(trace.frames[0], 'scripts'), false);
    assert.equal(inspectStartup(trace).length, startupNames.length);
  } finally { globalThis.PerformanceObserver = previous; delete globalThis.__editacStartupMark; }
});
