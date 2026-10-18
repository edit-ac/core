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
