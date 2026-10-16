import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

const evidence = process.env.EDITAC_HIGHLIGHT_EVIDENCE;
assert.ok(evidence, 'explicit worktree-owned evidence directory required');
const start = performance.now();
const { ProbeBackend } = createRequire(import.meta.url)(join(evidence, 'wasm/editac_highlighting.js'));
const moduleMs = performance.now() - start;
const corpus = JSON.parse(readFileSync(new URL('../fixtures/highlighting/corpus.json', import.meta.url)));
const samples = { moduleMs, cases: [] };
for (const fixture of corpus.cases) {
  test(`WASM ${fixture.id}: native parity, source, scopes and 100 warm probes`, () => {
    const initStart = performance.now();
    const backend = new ProbeBackend();
    const initMs = performance.now() - initStart;
    try {
      const coldStart = performance.now();
      const result = JSON.parse(backend.highlight(fixture.language, fixture.source, true));
      const coldMs = performance.now() - coldStart;
      assert.equal(result.status, 'highlighted');
      assert.equal(result.source, fixture.source);
      assert.equal(result.backend, corpus.backend);
      assert.deepEqual(result, JSON.parse(readFileSync(join(evidence, `native-${fixture.language}.json`))));
      const warmMs = [];
      for (let i = 0; i < 100; i++) {
        const at = performance.now();
        const warm = JSON.parse(backend.highlight(fixture.language, fixture.source, true));
        warmMs.push(performance.now() - at);
        assert.deepEqual(warm, result);
      }
      samples.cases.push({ id: fixture.id, initMs, coldMs, warmMs, sourceBytes: Buffer.byteLength(fixture.source), spans: result.spans.length });
    } finally { backend.free(); }
  });
}

test('WASM source-preserving disabled, unknown-language, malformed and empty results', () => {
  const backend = new ProbeBackend();
  try {
    for (const [language, source, enabled, status] of [
      ['rust', '🦀\0\r\n', false, 'disabled'],
      ['unknown-LANG', '<script>🦀\r\n', true, 'unknown-language'],
      ['json', '{"x": 🦀', true, 'highlighted'],
      ['json', '', true, 'highlighted'],
    ]) {
      const result = JSON.parse(backend.highlight(language, source, enabled));
      assert.equal(result.source, source); assert.equal(result.language, language); assert.equal(result.status, status);
      if (status !== 'highlighted') assert.deepEqual(result.spans, []);
    }
  } finally { backend.free(); }
});
test('WASM byte, line and line-count caps return no partial tokens', () => {
  const backend = new ProbeBackend();
  try {
    for (const source of ['x'.repeat(102401), 'x'.repeat(16385), '\n'.repeat(4097)]) {
      const result = JSON.parse(backend.highlight('json', source, true));
      assert.equal(result.status, 'over-budget'); assert.equal(result.source, source); assert.deepEqual(result.spans, []);
    }
  } finally { backend.free(); }
});
test('WASM timing artifact has all three runtime cases', () => {
  assert.equal(samples.cases.length, 3);
  writeFileSync(join(evidence, 'wasm-timings.json'), JSON.stringify(samples, null, 2) + '\n');
});
