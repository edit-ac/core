import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256 } from './extension-bundles.mjs';

// Receipt integrity is separate from current runtime execution. Historical
// prerequisite receipts remain immutable and retain their original scope.
export async function validateHandoffPins(catalog, read = path => readFile(path)) {
  assert.equal(catalog.apiVersion, 1);
  assert.equal(catalog.gate, 'EXT-1.11');
  for (const path of [
    'fixtures/extensions/conformance.json',
    'fixtures/extensions/versions/conformance.json',
    'fixtures/extensions/presenters/conformance.json',
    'fixtures/extensions/clipboard/conformance.json',
    'fixtures/extensions/profiles/contracts.json',
    'fixtures/extensions/capabilities.json',
    '../architecture/specs/extension-library.md',
    '../architecture/specs/extension-presenters.md',
    '../architecture/specs/client-contracts.md',
  ]) assert.match(catalog.fixtureHashes[path] ?? '', /^[a-f0-9]{64}$/, path);
  for (const [path, hash] of Object.entries(catalog.fixtureHashes))
    assert.equal(sha256(await read(path)), hash, path);
  for (const gate of ['EXT-1.1','EXT-1.2','EXT-1.3','EXT-1.4','EXT-1.5','EXT-1.6','EXT-1.7','EXT-1.8','EXT-1.9','EXT-1.10','EXT-1.12','EXT-1.13']) {
    const receipt = catalog.prerequisites[gate];
    assert(receipt, gate);
    assert.equal(sha256(await read(receipt.path)), receipt.sha256, gate);
  }
}
