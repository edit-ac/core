import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// An evidence index, never a second runtime capability registry. Capability and
// permission answers continue to come from the production FIT/extension ports.
export function catalogRows() {
  const text = readFileSync(new URL('../../../../architecture/tests/mobile-extension-cases.md', import.meta.url), 'utf8');
  const groups = ['capabilities', 'menus', 'content-controls', 'gestures', 'assets', 'formats', 'assistance', 'device'];
  return text.split(/\r?\n/).filter(line => /^\| MWX-C\d{2} \|/.test(line)).map(line => {
    const [id, priority, action, expected] = line.slice(2, -2).split(/\s+\|\s+/);
    const parent = Math.ceil(Number(id.slice(-2)) / 4);
    return { id, originalParent: `MWX-1.${parent}`, projectedParent: parent === 8 ? null : `MEX-1.${parent}`,
      group: groups[parent - 1], priority, action, expected,
      mechanics: 'not-executed', platform: 'pending-original-MWX-1.8',
      sourceSha256: createHash('sha256').update(line).digest('hex') };
  });
}
export function assertIndex(index) {
  assert.equal(index.schemaVersion, 1);
  const rows = catalogRows();
  assert.equal(rows.length, 32);
  assert.deepEqual(index.cases, rows, 'catalog IDs, ownership, requirements and hashes must match');
}
export function selectGroup(args) {
  assert.deepEqual(args, ['--group', 'capabilities'], 'Unknown or unimplemented mobile-extension group');
  return ['tests/browser/mobile-extensions/catalog.test.mjs', 'tests/browser/mobile-extensions/capabilities.spec.ts'];
}
