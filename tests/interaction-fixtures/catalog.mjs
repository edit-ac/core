import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const catalogs = ['tests/editor-interaction-cases.md', 'tests/desktop-editing-cases.md'];
// Table delimiters have surrounding whitespace; caret pipes inside code do not.
export function catalogRows(root) {
  return catalogs.flatMap(path => {
    let heading = '';
    return readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).flatMap(line => {
      if (line.startsWith('## ')) heading = line;
      if (!/^\| [A-Z][A-Z0-9]*-\d{2,} \|/.test(line)) return [];
      const cells = line.slice(2, -2).split(/\s+\|\s+/);
      assert.equal(cells.length, 4, `malformed catalog row: ${line}`);
      return [{ id: cells[0], priority: cells[1], action: cells[2], expected: cells[3],
        catalog: path, owners: heading.match(/\b[A-Z]+-\d+\.\d+\b/g) ?? [],
        sourceSha256: createHash('sha256').update(line).digest('hex') }];
    });
  });
}

export function assertIndex(index, rows) {
  assert.equal(index.schemaVersion, 1);
  const ids = index.cases.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate case ID');
  assert.deepEqual([...ids].sort(), rows.map(row => row.id).sort(), 'missing or unexpected case ID');
  for (const source of rows) {
    const row = index.cases.find(row => row.id === source.id);
    assert.equal(row.sourceSha256, source.sourceSha256, `${source.id}: stale expected contract`);
    assert.equal(row.action, source.action, `${source.id}: source action`);
    assert.equal(row.catalog, source.catalog, `${source.id}: catalog provenance`);
    assert.deepEqual(row.relatedOwners, source.owners, `${source.id}: related source owners`);
    assert.equal(row.expected.semantic, source.expected, `${source.id}: independent semantic contract`);
    assert.ok(source.owners.includes(row.owner), `${source.id}: source owner`);
    assert.equal(row.fixtureOwner, 'tests/browser/interaction-harness.ts');
    assert.equal(row.engineDriver, 'tests/editing/browser-driver.ts');
    assert.ok(row.expected.selection && row.expected.effects && row.profile);
    assert.deepEqual(row.evidence, { semantic: 'planned', browserReplay: 'planned', platform: 'unqualified' });
  }
  return index;
}
