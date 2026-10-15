import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditSiteGraph, routeTransfers, siteCosts } from '../scripts/shared-site-receipt.mjs';

const profile = 'isolated-persistent-http-profile';
function routes() {
  return ['cold', 'warm', 'cache-disabled'].map(mode => ({ name: `SHR-06-${mode}-full-navigation`, passed: true, cacheProfile: profile,
    persistentCleanup: { closed: true }, snapshots: [{ observations: ['task', 'document', 'task'].map((route, i) => {
      const cached = mode === 'warm' || mode === 'cold' && i > 0;
      return { route, runtime: { realm: `${mode}-${i}`, streaming: route === 'document' ? 2 : 1, buffered: 0 }, evaluations: 1,
        state: { live: [], roots: 0, reports: [{ unsaved: false }] },
        requests: [{ url: '/fixture/engine/editac_wasm_bg.hash.wasm', status: cached ? 304 : 200, bodyBytes: cached ? 0 : 123, ifNoneMatch: cached ? '"exact-body"' : null, cacheControl: 'public, max-age=0, must-revalidate' }] };
    }) }] }));
}
test('prepared route accounting separates saved bodies from fresh realm initialization', () => {
  const result = routeTransfers(routes(), profile);
  assert.deepEqual(result.cold.routes.map(value => value.bodyBytes), [123, 0, 0]);
  assert.deepEqual(result.warm.routes.map(value => value.bodyBytes), [0, 0, 0]);
  assert.deepEqual(result.cacheDisabled.routes.map(value => value.bodyBytes), [123, 123, 123]);
});
for (const [name, change] of [
  ['warm body download', cases => { cases[1].snapshots[0].observations[0].requests[0].status = 200; }],
  ['cached body counted as delivered', cases => { cases[1].snapshots[0].observations[0].requests[0].bodyBytes = 123; }],
  ['same realm disguised as navigation', cases => { const values = cases[1].snapshots[0].observations; values[2].runtime.realm = values[0].runtime.realm; }],
  ['missing optional initialization', cases => { cases[1].snapshots[0].observations[1].runtime.streaming = 1; }],
  ['duplicate engine request', cases => { const requests = cases[0].snapshots[0].observations[0].requests; requests.push({ ...requests[0] }); }],
  ['unsaved teardown', cases => { cases[1].snapshots[0].observations[0].state.reports[0].unsaved = true; }],
  ['unclosed persistent profile', cases => { cases[1].persistentCleanup.closed = false; }],
]) test(`route evidence rejects ${name}`, () => { const cases = routes(); change(cases); assert.throws(() => routeTransfers(cases, profile)); });

function graph() {
  return { inputs: { 'node_modules/@edit-ac/core/dist/index.js': {}, 'node_modules/@edit-ac/web/dist/index.js': {} }, outputs: {
    'common.js': { inputs: ['node_modules/@edit-ac/core/dist/index.js', 'node_modules/@edit-ac/web/dist/index.js'], imports: [] },
  } };
}
test('one emitted graph assigns common SDK modules to a single output', () => assert.deepEqual(auditSiteGraph(graph()), { inputs: 2, outputs: 1 }));
test('different wrapper bytes cannot hide duplicated common modules', () => {
  const value = graph(); value.outputs['other.js'] = { inputs: ['node_modules/@edit-ac/core/dist/index.js'], imports: [] };
  assert.throws(() => auditSiteGraph(value), /multiple chunks/);
});
test('missing emitted membership cannot manufacture common ownership', () => {
  const value = graph(); delete value.outputs['common.js'].inputs;
  assert.throws(() => auditSiteGraph(value), /Missing emitted/);
});
function costs() {
  const inventory = [
    { url: '/fixture/core.wasm', role: 'core-wasm', kind: 'wasm', gzip: 100 },
    { url: '/fixture/common.js', role: 'site-chunk', kind: 'js', gzip: 10 },
    { url: '/fixture/parser.wasm', role: 'optional-markdown-wasm', kind: 'wasm', gzip: 50 },
    { url: '/fixture/react.js', role: 'site-chunk', kind: 'js', gzip: 20 },
  ];
  const transfers = names => names.map(name => ({ url: 'http://fixture' + name }));
  const task = transfers(inventory.slice(0, 2).map(value => value.url)), document = transfers(inventory.slice(0, 3).map(value => value.url));
  return { production: { inventory }, cases: [
    { name: 'SHR-05-client-task-document-back', passed: true, snapshots: [{ first: { transfers: task }, second: { runtime: { realm: 'one' } }, third: { runtime: { realm: 'one' }, transfers: [...document, ...task] } }] },
    { name: 'SHR-04-mixed-bindings', snapshots: [{ before: { transfers: [...task, ...transfers(['/fixture/react.js'])] } }] },
  ] };
}
test('shared gzip union counts common bytes once without dividing by mount count', () => {
  const { production, cases } = costs(), value = siteCosts(production, cases);
  assert.equal(value.task.total, 110); assert.equal(value.documentUnion.total, 160);
  assert.equal(value.documentIncrement.total, 50); assert.equal(value.mixedFeatureUnion.total, 180);
  assert.equal(value.mixedFeatureUnion.editorJs, 30);
});
test('uninventoried required lazy bytes reject shared cost accounting', () => {
  const { production, cases } = costs(); cases[0].snapshots[0].third.transfers.push({ url: 'http://fixture/hidden.js' });
  assert.throws(() => siteCosts(production, cases), /Uncounted delivered resource/);
});
