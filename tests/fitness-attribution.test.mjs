import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttribution } from '../benchmarks/attribution.mjs';
import { stageSummary } from '../benchmarks/stage-summary.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { instrumentSource, fitnessInstrumentation } from '../scripts/fitness-instrumentation.mjs';

function sample() {
  let clock = 0;
  const c = createAttribution(() => clock++);
  c.begin();
  for (const [sdk, ffi, engine] of [['prepare', 'prepare', 'prepare'], ['commit', 'commit', 'commit'], ['patch', 'take_patch', 'patch']]) {
    c.measure(`sdk.${sdk}`, () => c.measure(`ffi.${ffi}`, () => c.measure(`engine.${engine}`, () => {})));
  }
  c.measure('render.patch', () => {});
  return c.end();
}
test('exclusive attribution partitions overlapping actual stage intervals once', () => {
  const trace = sample(), summary = stageSummary(trace);
  assert.equal(Object.values(summary.exclusiveMs).reduce((a, b) => a + b), trace.elapsedMs);
  for (const group of ['engine', 'ffi', 'sdk', 'render']) assert(summary.exclusiveMs[group] > 0);
  assert.equal(summary.spanCount, 10);
});
test('missing stages, forged payload, clock errors, overflow and orphan engine spans reject', () => {
  for (const change of [t => t.spans.pop(), t => t.spans[0].text = 'private', t => t.spans[0].durationMs = -1,
    t => t.dropped++, t => t.spans[0].startMs = t.elapsedMs, t => t.spans[1].operation = 'ffi.read',
    t => t.version = 'unknown']) {
    const trace = sample(); change(trace); assert.throws(() => stageSummary(trace));
  }
});
test('collector is bounded, inactive outside windows and ignores arbitrary labels', () => {
  let time = 0; const c = createAttribution(() => time++);
  c.measure('sdk.read', () => {});
  assert.throws(() => c.end());
  c.begin(); assert.throws(() => c.begin());
  c.measure('private document title', () => {});
  for (let i = 0; i < 600; i++) c.measure('sdk.read', () => {});
  const trace = c.end(); assert.equal(trace.spans.length, 512); assert.equal(trace.dropped, 88);
  assert(!JSON.stringify(trace).includes('private'));
});
test('tracing preserves return values and thrown errors, including finally completion', () => {
  let time = 0; const c = createAttribution(() => time++), error = Error('prepared');
  c.begin(); assert.equal(c.measure('sdk.read', () => 42), 42);
  assert.throws(() => c.measure('sdk.read', () => { throw error; }), e => e === error);
  assert.equal(c.end().spans.length, 2);
});
test('benchmark-only source transforms fail closed if production boundaries drift', () => {
  assert.match(instrumentSource('sdk', 'return action(raw);'), /sdk\./);
  assert.match(instrumentSource('render', 'patch => this.#apply(patch)'), /render.patch/);
  assert.throws(() => instrumentSource('sdk', 'changed boundary'));
  assert.throws(() => instrumentSource('sdk', 'return action(raw); return action(raw);'));
});

test('actual built renderer in a core-named checkout selects renderer instrumentation', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({ entryPoints: [new URL('../packages/web/dist/dom/render.js', import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', plugins: [fitnessInstrumentation(root)] });
  assert.match(result.outputFiles[0].text, /__editacFitnessMeasure\("render.patch"/);
});

test('production WASM and generated glue exclude the benchmark clock imports', async () => {
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) {
    const bytes = await readFile(new URL(`../packages/core/dist/wasm/${file}`, import.meta.url));
    assert(!bytes.includes(Buffer.from('__editacFitness')), `${file} contains instrumentation`);
  }
});
