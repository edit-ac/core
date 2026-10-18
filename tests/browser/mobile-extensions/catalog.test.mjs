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
