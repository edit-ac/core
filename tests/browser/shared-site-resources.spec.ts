import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
import { prepareSharedSite } from '../consumers/shared-resources/production.mjs';
import { auditSharedAssets, auditSharedGraph } from '../../scripts/shared-resource-contract.mjs';
const sources = ['tests/consumers/shared-resources/site.mjs', 'tests/consumers/shared-resources/production.mjs',
  'tests/browser/shared-site-resources.spec.ts', 'packages/core/src/index.ts', 'packages/markdown/src/index.ts',
  'packages/web/src/editor.ts', 'packages/react/src/index.ts', 'packages/astro/src/index.ts',
  'packages/astro/src/Editor.astro', 'tests/browser/fixture-server.mjs', 'scripts/shared-resource-contract.mjs'];
const { probe, facts } = browserHarness('shared-site-resources', 'tests/consumers/shared-resources', {
  usePersistentContext: name => name.startsWith('SHR-06-'),
  markdown: true, packages: ['core', 'web', 'react', 'astro', 'markdown'], autoMount: false,
  prepareConsumer: prepareSharedSite, testFile: 'tests/browser/shared-site-resources.spec.ts',
  assertSourcesUnchanged: true, sourcePaths: sources, serverOptions: { recordRequests: true, cacheAssets: true },
  beforeNavigate: page => page.addInitScript(() => {
    window.runtimeObservations = { streaming: 0, buffered: 0, wasmFetches: [], realm: crypto.randomUUID() };
    const stream = WebAssembly.instantiateStreaming, buffer = WebAssembly.instantiate, fetch = window.fetch;
    WebAssembly.instantiateStreaming = function (...args) { window.runtimeObservations.streaming++; return stream.apply(this, args); };
    WebAssembly.instantiate = function (...args) { window.runtimeObservations.buffered++; return buffer.apply(this, args); };
    window.fetch = function (input, ...args) { const url = String(input instanceof Request ? input.url : input); if (url.includes('.wasm')) window.runtimeObservations.wasmFetches.push(url); return fetch.call(this, input, ...args); };
  }), cleanup: page => page.evaluate(() => window.site?.cleanup()),
});
async function fresh(page) {
  await page.waitForFunction(() => !!window.site); await page.evaluate(() => window.site.seed());
  await page.reload(); await page.waitForFunction(() => !!window.site);
}
async function snapshot(page) {
  return page.evaluate(() => ({ runtime: window.runtimeObservations, state: window.site.state(), evaluations: window.siteEvaluations,
    transfers: performance.getEntriesByType('resource').map(r => ({ url: r.name, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize, deliveryType: r.deliveryType ?? null })) }));
}
function oneRuntime(value, optional = false) {
  assert.equal(value.runtime.wasmFetches.filter(url => /editac_wasm_bg[.-].*\.wasm$/.test(url)).length, 1);
  assert.equal(value.runtime.streaming, optional ? 2 : 1); assert.equal(value.runtime.buffered, 0);
  assert.equal(value.evaluations, 1);
}
for (const binding of ['plain', 'react', 'astro', 'mixed-bindings']) test(`SHR-04 installed production ${binding} resolves one runtime`, () => probe(`SHR-04-${binding}`, async (page, fact) => {
  fact.requirement = 'SHR-04'; await fresh(page);
  const bindings = binding === 'mixed-bindings' ? ['plain', 'react', 'astro'] : [binding];
  const keys = await page.evaluate(async bindings => { const keys = []; for (let i = 0; i < bindings.length; i++) keys.push(await window.site.mount(bindings[i], ['description', 'comment', 'document'][i])); return keys; }, bindings);
  const before = await snapshot(page); oneRuntime(before);
  assert.equal(new Set(before.state.identities.map(id => id.documentId)).size, bindings.length);
  await page.evaluate(key => window.site.append(key, ' edited'), keys[0]);
  assert.equal(await page.evaluate(key => window.site.text(key), keys[0]), 'description edited');
  for (const [i, key] of keys.entries()) if (i) assert.equal(await page.evaluate(key => window.site.text(key), key), ['description', 'comment', 'document'][i]);
  await page.evaluate(() => window.site.cleanup()); const after = await snapshot(page);
  assert.equal(after.state.live.length, 0); assert.equal(after.state.roots, 0); assert(after.state.reports.every(r => r && !r.unsaved));
  assert(!fact.requests.some(url => /markdown\.wasm|editac_markdown|katex/.test(url)), 'Disabled production page must not request optional runtime');
  fact.snapshots.push({ before, after, build: facts.production.build });
}));
test('SHR-04 installed SSR imports and render perform no browser work', () => probe('SHR-04-ssr', async (page, fact) => {
  fact.requirement = 'SHR-04'; assert(facts.production.ssr.passed); await page.waitForFunction(() => !!window.site);
  const value = await snapshot(page); assert.equal(value.runtime.streaming, 0); assert.deepEqual(value.runtime.wasmFetches, []);
  assert.equal(await page.locator('#astro-template').evaluate(node => node.content.querySelectorAll('edit-ac-editor [data-editor-surface]').length), 1);
  fact.snapshots.push({ ssr: facts.production.ssr, commands: facts.production.commands, value });
}));
test('SHR-05 client task document back adds only optional resources', () => probe('SHR-05-client-task-document-back', async (page, fact) => {
  fact.requirement = 'SHR-05'; await fresh(page); const start = facts.serverRequests.length;
  const task = await page.evaluate(() => window.site.route('task'));
  await page.evaluate(key => window.site.append(key, ' saved'), task); const first = await snapshot(page); oneRuntime(first);
  const document = await page.evaluate(() => window.site.route('document')); const second = await snapshot(page); oneRuntime(second, true);
  assert.equal(await page.evaluate(key => window.site.text(key), document), 'document');
  const back = await page.evaluate(() => window.site.route('task')); const third = await snapshot(page); oneRuntime(third, true);
  assert.equal(await page.evaluate(key => window.site.text(key), back), 'description saved');
  assert.equal(first.runtime.realm, third.runtime.realm); assert.equal(third.state.live.length, 1);
  const requests = facts.serverRequests.slice(start); assert.equal(requests.filter(r => /editac_wasm_bg[.-].*\.wasm$/.test(r.url)).length, 1); assert.equal(requests.filter(r => /editac_markdown_wasm_bg[.-].*\.wasm$/.test(r.url)).length, 1);
  fact.snapshots.push({ first, second, third, requests });
}));
for (const mode of ['cold', 'warm', 'cache-disabled']) test(`SHR-06 ${mode} full navigation separates realms from cache`, () => probe(`SHR-06-${mode}-full-navigation`, async (page, fact) => {
  fact.requirement = 'SHR-06';
  if (mode !== 'warm') await page.route('**/*', route => route.continue());
  // A cold journey starts before any core fetch. Seed its real documents in
  // the first measured Task realm; pre-seeding and reloading warms HTTP cache.
  if (mode !== 'cold') await fresh(page);
  if (mode === 'cold') await page.unroute('**/*');
  const observations = [];
  for (const route of ['task', 'document', 'task']) {
    const start = facts.serverRequests.length;
    await page.goto(fact.origin + '/fixture/' + route + '/index.html'); await page.waitForFunction(() => !!window.site);
    if (mode === 'cold' && observations.length === 0) await page.evaluate(() => window.site.seed());
    const key = await page.evaluate(route => window.site.mount('plain', route === 'document' ? 'document' : 'description', route === 'document'), route);
    await page.evaluate(key => window.site.append(key, ' route'), key); await page.evaluate(() => window.site.cleanup());
    const value = await snapshot(page); oneRuntime(value, route === 'document');
    observations.push({ route, ...value, requests: facts.serverRequests.slice(start) });
  }
  assert.equal(new Set(observations.map(value => value.runtime.realm)).size, 3);
  const engines = observations.map(value => value.requests.find(r => /editac_wasm_bg[.-].*\.wasm$/.test(r.url)));
  assert(engines.every(Boolean));
  if (mode === 'warm') { assert(engines.every(r => r.status === 304 && r.bodyBytes === 0)); assert(engines.every(r => r.ifNoneMatch)); }
  else if (mode === 'cache-disabled') assert(engines.every(r => r.status === 200 && r.bodyBytes > 0));
  else { assert.equal(engines[0].status, 200); assert(engines[0].bodyBytes > 0); assert(engines.slice(1).every(r => r.status === 304 && r.bodyBytes === 0)); }
  fact.snapshots.push({ mode, observations });
}));
test('SHR-07 eager optional imports in emitted default bundle trigger graph sensitivity', () => probe('SHR-07-eager-detector', async (page, fact) => {
  fact.requirement = 'SHR-07'; assert.throws(() => auditSharedGraph(facts.production.eagerGraph, { defaultOnly: true }), /Eager optional/);
  fact.snapshots.push({ emittedGraph: 'negative/eager-graph.json', detected: true });
}));
test('SHR-07 incompatible emitted binary cannot pass the current host manifest', () => probe('SHR-07-incompatible-build', async (page, fact) => {
  fact.requirement = 'SHR-07'; await page.waitForFunction(() => !!window.site);
  await assert.rejects(page.evaluate(candidate => window.site.admitRelease(candidate), facts.production.incompatible), /Incompatible deployed build/);
  const value = await snapshot(page); assert.equal(value.runtime.streaming, 0); assert.equal(value.state.live.length, 0);
  fact.snapshots.push({ rejected: facts.production.incompatible, value });
}));
test('SHR-07 stale release and URL rollover reject without mixing or poisoning the admitted owner', () => probe('SHR-07-version-rollover', async (page, fact) => {
  fact.requirement = 'SHR-07';
  const rejectedPage = page.waitForEvent('pageerror');
  await page.goto(fact.origin + '/fixture/rollover/index.html');
  assert.match((await rejectedPage).message, /Incompatible deployed page\/glue build/);
  assert.equal(await page.evaluate(() => !!window.site), false);
  assert.deepEqual(fact.errors.splice(0), ['Incompatible deployed page/glue build']);
  const stale = await page.evaluate(() => window.runtimeObservations);
  assert.equal(stale.streaming, 0); assert.deepEqual(stale.wasmFetches, []);
  fact.snapshots.push({ stalePage: facts.production.rollover, rejectedBeforeInitialization: stale });
  await page.goto(fact.origin); await fresh(page);
  await assert.rejects(page.evaluate(() => window.site.admitRelease({ ...window.site.release, build: 'stale-' + window.site.release.build })), /Incompatible deployed build/);
  await assert.rejects(page.evaluate(() => window.site.admitRelease({ ...window.site.release, assetUrl: window.site.assetUrl.replace(/[^/]+$/, 'duplicate.wasm') })), /Conflicting deployed asset URL/);
  await page.evaluate(() => window.site.admitRelease(window.site.release)); const key = await page.evaluate(() => window.site.mount());
  await page.evaluate(key => window.site.append(key, ' current'), key); const value = await snapshot(page); oneRuntime(value);
  assert.equal(await page.evaluate(key => window.site.text(key), key), 'description current');
  fact.snapshots.push({ scope: 'host manifest rejects incompatible rollout; no different SDK version qualification', value });
}));
test('SHR-07 actual emitted duplicate bytes trigger inventory sensitivity', () => probe('SHR-07-duplicate-detector', async (page, fact) => {
  fact.requirement = 'SHR-07'; const inventory = facts.production.inventory, duplicate = facts.production.duplicate;
  assert.throws(() => auditSharedAssets([...inventory, duplicate]), /Duplicate emitted bytes/);
  const delivered = await page.evaluate(async url => { const response = await fetch(url); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }, duplicate.url);
  assert.equal(delivered.status, 200); assert.equal(delivered.bytes, duplicate.bytes); fact.snapshots.push({ duplicate, delivered, detected: true });
}));
