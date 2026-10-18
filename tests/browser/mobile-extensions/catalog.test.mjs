import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertIndex, selectGroup } from './index.mjs';

test('MWX-C04 index pins all 32 original IDs, owners, criteria and evidence scope', () => {
  const index = JSON.parse(readFileSync(new URL('./case-index.json', import.meta.url)));
  assertIndex(index);
  const stale = structuredClone(index); stale.cases[0].sourceSha256 = 'stale';
  assert.throws(() => assertIndex(stale));
  const missing = structuredClone(index); missing.cases.pop();
  assert.throws(() => assertIndex(missing));
  assert.throws(() => selectGroup(['--group', 'device']));
  assert.throws(() => selectGroup([]));
});


test('MWX-C21–C24 registration requires every named executed case and rejects missing, failed, duplicate or errored evidence', async () => {
  const { reconcileFormats } = await import('./format-contract.mjs');
  const registry = JSON.parse(readFileSync(new URL('./format-predicates.json', import.meta.url)));
  const cases = [...new Set(registry.predicates.flatMap(row => row.cases))].map(name => ({name, passed:true, errors:[]}));
  const prepared = {cases};
  const result = reconcileFormats(prepared);
  assert.equal(result.predicates.length, 18);
  assert.ok(result.predicates.every(row => row.state === 'passed-portable-mechanics'));
  assert.throws(() => reconcileFormats({cases:cases.slice(1)}), /missing case/);
  assert.throws(() => reconcileFormats({cases:[...cases, cases[0]]}), /duplicate/);
  assert.throws(() => reconcileFormats({cases:cases.map((row,i)=>i ? row : {...row,passed:false})}), /failed case/);
  assert.throws(() => reconcileFormats({cases:cases.map((row,i)=>i ? row : {...row,errors:['error']})}), /browser errors/);
});

test('MEX-1.9 touch registration rejects incomplete or unsuccessful portable evidence', async () => {
  const { reconcileTouch } = await import('./touch-contract.mjs');
  const registry = JSON.parse(readFileSync(new URL('./touch-predicates.json', import.meta.url)));
  const cases = registry.predicates.flatMap(row => row.cases).map(name => ({ name, passed: true, errors: [] }));
  const result = reconcileTouch({ cases });
  assert.equal(result.executed, 172);
  assert.equal(result.predicates.length, 10);
  assert.deepEqual([...new Set(result.predicates.flatMap(row => row.catalogIds))], ['MWX-C05', 'MWX-C10', 'MWX-C24']);
  assert.throws(() => reconcileTouch({ cases: cases.slice(1) }), /missing case/);
  assert.throws(() => reconcileTouch({ cases: [...cases, cases[0]] }), /duplicate executed/);
  assert.throws(() => reconcileTouch({ cases: [...cases, { name: 'unregistered', passed: true, errors: [] }] }), /unregistered case/);
  assert.throws(() => reconcileTouch({ cases: cases.map((row, i) => i ? row : { ...row, passed: false }) }), /failed case/);
  assert.throws(() => reconcileTouch({ cases: cases.map((row, i) => i ? row : { ...row, errors: ['uncaught'] }) }), /browser errors/);
  assert.equal(result.platform, 'pending-original-MWX-1.8');
});
