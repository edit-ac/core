import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { catalogRows } from './index.mjs';

// Evidence registration only; capabilities remain owned by the installed runtime.
export function reconcileFormats(receipt) {
  const bytes = readFileSync(new URL('./format-predicates.json', import.meta.url));
  const registry = JSON.parse(bytes);
  const catalog = catalogRows().filter(row => row.group === 'formats');
  assert.deepEqual([...new Set(registry.predicates.map(row => row.catalogId))], catalog.map(row => row.id));
  assert.equal(registry.platform, 'pending-original-MWX-1.8');
  const cases = new Map(receipt.cases.map(row => [row.name, row]));
  assert.equal(cases.size, receipt.cases.length, 'duplicate executed case names');
  const predicates = registry.predicates.map(row => {
    assert.ok(row.cases.length > 0, `empty predicate: ${row.id}`);
    for (const name of row.cases) {
      const fact = cases.get(name);
      assert.ok(fact, `missing case: ${row.id}: ${name}`);
      assert.equal(fact.passed, true, `failed case: ${row.id}: ${name}`);
      assert.deepEqual(fact.errors, [], `browser errors: ${name}`);
    }
    return { ...row, state: 'passed-portable-mechanics', catalogSha256: catalog.find(item => item.id === row.catalogId).sourceSha256 };
  });
  return { ...registry, predicates, registrySha256: createHash('sha256').update(bytes).digest('hex'),
    unqualified: ['actual device/OS file, share and clipboard delivery', 'native selection handles, dictation, voice control and screen readers', 'timing, cost/budget qualification and release'],
    costs: 'Raw package bytes, source hashes, served-body hashes and resource counters remain in the bound browser receipt; no performance qualification.' };
}
