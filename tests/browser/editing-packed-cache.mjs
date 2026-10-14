import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
// An all-group run builds and packs once. Every browser still unpacks a fresh
// consumer and executes the actual published-layout bytes, not a source alias.
export async function editingPackedCache(name, destination) {
  if (!process.env.EDITAC_EDITING_PACKS) return undefined;
  const catalog = JSON.parse(await readFile(process.env.EDITAC_EDITING_PACKS, 'utf8'));
  const pack = catalog[name]; assert.ok(pack, `Missing immutable ${name} package`);
  assert.equal(pack.manifest.filename,basename(pack.manifest.filename));
  assert.equal(pack.manifest.name, `@edit-ac/${name}`);
  const bytes = await readFile(pack.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pack.sha256,'Stale/fabricated shared package');
  await writeFile(join(destination,pack.manifest.filename),bytes,{flag:'wx'});
  return pack.manifest;
}
