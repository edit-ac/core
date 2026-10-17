import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const catalogPath = '../architecture/tests/mobile-web-cases.md';
const families = { MBT: [2, 'touch'], MBI: [3, 'input'], MBV: [4, 'viewport'], MBF: [5, 'focus'], MBC: [6, 'lifecycle'], MBA: [7, 'capabilities'], MBX: [8, 'modules'], MBP: [9, 'performance'], MBQ: [11, 'device'] };
export function catalogRows(text = readFileSync(new URL('../../../architecture/tests/mobile-web-cases.md', import.meta.url), 'utf8')) {
  return text.split(/\r?\n/).filter(line => /^\| MB[A-Z]-\d{2} \|/.test(line)).map(line => {
    const [id, priority, action, expected] = line.slice(2, -2).split(/\s+\|\s+/);
    const [parent, group] = families[id.split('-')[0]] ?? [];
    assert.ok(parent && expected, `Malformed mobile catalog row: ${id}`);
    return { id, priority, action, expected, group, originalParent: `MWB-1.${parent}`,
      projectedParent: parent <= 8 ? `MWF-1.${parent}` : null,
      receiptTypes: ['mechanics', 'device'],
      provenance: { mechanics: 'not-executed', device: 'deferred-original-MWB-1.11',
        ...(parent === 9 ? { performance: 'deferred-original-MWB-1.9' } : {}) },
      sourceSha256: createHash('sha256').update(line).digest('hex') };
  });
}
export function assertIndex(index, rows = catalogRows()) {
  assert.equal(index.schemaVersion, 1);
  assert.equal(rows.length, 64, 'reviewed mobile catalog has 64 cases');
  assert.equal(new Set(index.cases.map(row => row.id)).size, index.cases.length, 'duplicate case ID');
  assert.deepEqual(index.cases, rows, 'missing, unexpected, stale or misowned mobile case');
  return index;
}
export const implementedGroups = Object.freeze({ harness: ['tests/mobile-web/catalog.test.mjs', 'tests/mobile-web/harness.spec.ts'] });
export function selectGroup(args, groups = implementedGroups) {
  assert.ok(args.length === 2 && args[0] === '--group' && Object.hasOwn(groups, args[1]),
    'Unknown or unimplemented mobile group; expected --group harness');
  const files = groups[args[1]];
  assert.ok(Array.isArray(files) && files.length > 0, 'Empty mobile group');
  return files;
}
export function assertCounts(counts) {
  assert.ok(counts.executed > 0, 'Zero mobile execution');
  assert.equal(counts.passed, counts.executed, 'Every required mobile check must pass');
  for (const key of ['failed', 'skipped', 'cancelled']) assert.equal(counts[key] ?? 0, 0, `Required mobile ${key}`);
}
