import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { catalogRows } from './index.mjs';

// Acceptance registration only. The installed command/capability owners decide
// applicability; this registry cannot enable a command or qualify a mobile OS.
export function reconcileTouch(receipt) {
  const bytes = readFileSync(new URL('./touch-predicates.json', import.meta.url));
  const registry = JSON.parse(bytes);
  assert.equal(registry.gate, 'MTF-1.3');
  assert.equal(registry.platform, 'pending-original-MWX-1.8');
  const catalog = new Map(catalogRows().map(row => [row.id, row]));
  const expected = registry.predicates.flatMap(row => row.cases);
  assert.equal(new Set(expected).size, expected.length, 'duplicate registered cases');
  const cases = new Map(receipt.cases.map(row => [row.name, row]));
  assert.equal(cases.size, receipt.cases.length, 'duplicate executed cases');
  for (const name of cases.keys()) assert.ok(expected.includes(name), `unregistered case: ${name}`);
  const predicates = registry.predicates.map(row => {
    assert.ok(row.cases.length > 0, `empty predicate: ${row.id}`);
    const catalogPins = Object.fromEntries(row.catalogIds.map(id => {
      assert.ok(catalog.has(id), `unknown original catalog ID: ${id}`);
      return [id, catalog.get(id).sourceSha256];
    }));
    for (const name of row.cases) {
      const fact = cases.get(name);
      assert.ok(fact, `missing case: ${row.id}: ${name}`);
      assert.equal(fact.passed, true, `failed case: ${row.id}: ${name}`);
      assert.deepEqual(fact.errors, [], `browser errors: ${name}`);
    }
    return { ...row, catalogPins, state: 'passed-portable-mechanics' };
  });
  return { ...registry, predicates, executed: cases.size,
    registrySha256: createHash('sha256').update(bytes).digest('hex'),
    unqualified: ['mobile OS runtime and actual native paste menus', 'native selection handles, IME, dictation, voice control and screen readers', 'timing, cost/budget and release; original MWX-1.8/roadmap43 remain open'] };
}
