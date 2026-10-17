import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { catalogRows, assertIndex } from './catalog.mjs';
const index = JSON.parse(readFileSync(new URL('./case-index.json', import.meta.url)));
const rows = catalogRows('../architecture');
test('INT-1.1: every interaction/desktop ID has a source-owned expected contract and real-engine fixture owner', () => {
  assertIndex(index, rows);
  assert.equal(rows.length, 164, 'review additions/removals explicitly');
  for (const row of index.cases) {
    assert.ok(existsSync(row.fixtureOwner)); assert.ok(existsSync(row.engineDriver));
    assert.equal(row.profile.supportedByHarness, false, 'index is not feature execution');
  }
});
test('INT-1.1: duplicate, missing, unexpected and stale case bindings fail closed', () => {
  for (const mutate of [
    x => x.cases.push(x.cases[0]), x => x.cases.pop(),
    x => x.cases[0].id = 'FABRICATED-01', x => x.cases[0].sourceSha256 = 'stale',
    x => x.cases[0].owner = 'INT-1.99', x => x.cases[0].expected.semantic = 'wrong',
    x => x.cases[0].action = 'fabricated action', x => x.cases[0].evidence.platform = 'qualified',
  ]) {
    const wrong = structuredClone(index); mutate(wrong);
    assert.throws(() => assertIndex(wrong, rows), assert.AssertionError);
  }
});
test('INT-1.1: unknown/unimplemented groups never report zero-test success', () => {
  for (const group of ['absent', 'breaks', 'all']) {
    const result = spawnSync(process.execPath, ['scripts/test-interactions.mjs', '--group', group], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Unknown or unimplemented/);
  }
});
