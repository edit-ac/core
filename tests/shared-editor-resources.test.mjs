import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSharedAssets, auditSharedGraph, assertSharedMatrix, admitSharedReceipt, sharedCases } from '../scripts/shared-resource-contract.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const asset = (url, role, body = url) => ({ url, role, bytes: body.length, sha256: hash(body), build: 'prepared-contract-build' });
const assets = () => [asset('/v1/engine.wasm', 'core-wasm'), asset('/v1/glue.js', 'core-glue')];
// Deliberately prepared contract input, never written as actual runtime evidence.
function preparedMatrix() {
  return { version: 1, kind: 'editac.shared-resources', provenance: 'prepared-contract-fixture',
    browsers: ['chromium', 'firefox', 'webkit'].map(engine => ({ engine, version: 'prepared', playwright: '1.64.0', failed: 0, skipped: 0, cancelled: 0,
      cases: Object.entries(sharedCases).flatMap(([requirement, cases]) => cases.map(name => ({ requirement, name, passed: true, evidence: 'case.json', evidenceSha256: hash('prepared') }))) })),
    assets: assets(), defaultAssets: assets(), limits: { totalGzip: 524288, editorJsGzip: 32768 }, defaultGzip: { total: 500000, editorJs: 32000 },
    transfers: { cold: {}, warm: {}, cacheDisabled: {} }, graph: { enabled: 'enabled-graph.json', default: 'default-graph.json' }, packages: ['core', 'web', 'react', 'astro', 'markdown'].map(name => ({ name: `@edit-ac/${name}`, version: '0.0.0', file: `${name}.tgz`, sha256: hash(name) })),
  };
}
test('same-page candidate is not a complete SHR-01–08 receipt', () => {
  const receipt = preparedMatrix(); receipt.provenance = 'actual-packed-browser-runtime';
  receipt.browsers[0].cases = receipt.browsers[0].cases.filter(value => value.requirement !== 'SHR-06');
  assert.throws(() => assertSharedMatrix(receipt), /SHR-06/);
});
test('prepared evidence cannot manufacture qualification', () => assert.throws(() => assertSharedMatrix(preparedMatrix()), /Prepared fixtures/));
test('prerequisite scope preserves budget failures without claiming aggregate completion', () => {
  const receipt = preparedMatrix(); receipt.provenance = 'actual-packed-browser-runtime';
  Object.assign(receipt, { scope: 'packed-resource-prerequisite', complete: false, prerequisiteComplete: true,
    defaultGzip: { total: 599521, editorJs: 52215 } });
  assert.throws(() => assertSharedMatrix(receipt), /cannot establish aggregate/);
  assertSharedMatrix(receipt, { prerequisiteOnly: true });
  receipt.browsers[0].cases = receipt.browsers[0].cases.filter(value => value.name !== 'warm-full-navigation');
  assert.throws(() => assertSharedMatrix(receipt, { prerequisiteOnly: true }), /SHR-06/);
});
test('exact artifact inventory admits one compatible core owner', () => assert.equal(auditSharedAssets(assets()).coreBuild, 'prepared-contract-build'));
test('duplicate bytes at another URL are detected independently of transfer/cache', () => {
  const values = assets(); values.push({ ...values[0], url: '/second/engine.wasm' }); assert.throws(() => auditSharedAssets(values), /Duplicate emitted bytes/);
});
test('different binaries cannot become two compatible core owners', () => assert.throws(() => auditSharedAssets([...assets(), asset('/v2/engine.wasm', 'core-wasm')]), /one compatible core/));
test('stale glue cannot alias a new WASM build', () => { const values = assets(); values[1].build = 'stale'; assert.throws(() => auditSharedAssets(values), /Incompatible/); });
test('disabled-only graph rejects eager optional code', () => assert.throws(() => auditSharedAssets([...assets(), asset('/markdown.js', 'optional-markdown')], { defaultOnly: true }), /Eager optional/));
test('missing/empty inventories and cache-busting URLs cannot pass', () => {
  assert.throws(() => auditSharedAssets([]), /Missing/); const values = assets(); values[0].url += '?editor=123'; assert.throws(() => auditSharedAssets(values), /Stable/);
});
for (const field of ['failed', 'skipped', 'cancelled']) test(`nonzero ${field} cannot pass`, () => {
  const receipt = preparedMatrix(); receipt.provenance = 'actual-packed-browser-runtime'; receipt.browsers[0][field] = 1; assert.throws(() => assertSharedMatrix(receipt));
});
test('receipt admission checks current source/artifact identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'editac-shared-contract-'));
  try {
    const receipt = preparedMatrix(); receipt.provenance = 'actual-packed-browser-runtime'; receipt.sources = { 'source.js': hash('old') }; receipt.artifacts = { 'case.json': hash('prepared') };
    await writeFile(join(directory, 'shared-receipt.json'), JSON.stringify(receipt)); await writeFile(join(directory, 'source.js'), 'changed'); await writeFile(join(directory, 'case.json'), 'prepared');
    await assert.rejects(admitSharedReceipt(directory, directory), /Stale shared-resource source/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual optional Markdown loader coalesces delayed callers and retries one shared failure', async () => {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(new URL('../packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm', import.meta.url));
  const prior = globalThis.fetch; let attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { attempts++; await gate; return attempts === 1 ? new Response('', { status: 503 }) : new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }); };
  try {
    const { initMarkdown } = await import('../packages/markdown/dist/index.js?shared-resource-loader');
    const first = initMarkdown('/markdown.wasm'), second = initMarkdown('/markdown.wasm'); assert.equal(first, second);
    await assert.rejects(initMarkdown('/conflicting.wasm'), /another asset URL/); release();
    const rejected = await Promise.allSettled([first, second]); assert.deepEqual(rejected.map(value => value.status), ['rejected', 'rejected']); assert.equal(attempts, 1);
    const retry = initMarkdown('/markdown.wasm'); assert.equal(retry, initMarkdown('/markdown.wasm')); const codec = await retry;
    assert.equal(typeof codec.importMarkdown, 'function'); assert.equal(attempts, 2);
  } finally { globalThis.fetch = prior; }
});

const graph = () => ({ inputs: { 'node_modules/@edit-ac/core/dist/index.js': {}, 'node_modules/@edit-ac/web/dist/index.js': {} }, outputs: { 'public/task.js': {} } });
test('actual build graph contract requires one resolved core and web owner', () => assert.deepEqual(auditSharedGraph(graph()), { inputs: 2, outputs: 1 }));
test('duplicate resolved package cannot hide behind browser caching', () => { const value = graph(); value.inputs['node_modules/binding/node_modules/@edit-ac/core/dist/index.js'] = {}; assert.throws(() => auditSharedGraph(value), /Duplicate or missing resolved core/); });
test('an eager optional import cannot hide inside a common chunk', () => { const value = graph(); value.inputs['node_modules/@edit-ac/markdown/dist/index.js'] = {}; assert.throws(() => auditSharedGraph(value, { defaultOnly: true }), /Eager optional import/); });
test('zero production inputs/outputs cannot pass graph checks', () => assert.throws(() => auditSharedGraph({ inputs: {}, outputs: {} }), /Missing\/empty/));
