// ENG-1.6 production mixed-command interoperability using the qualified v2 mapping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as Y from 'yjs';
import { roots, ownerTuple } from './mapping.mjs';
const dir = process.env.EDITAC_FORMAT_BLOCK_EXCHANGE;
const read = name => new Uint8Array(fs.readFileSync(path.join(dir, name)));
function restore(client) {
  const d = new Y.Doc(); d.clientID = client;
  roots(d);
  Y.applyUpdate(d, read('base.bin'), 'restore');
  Y.applyUpdate(d, read('rust-update.bin'), 'remote');
  return d;
}
test('exact pinned runtime and Yjs dependency', () => {
  assert.equal(process.version, 'v24.19.0');
  const require = createRequire(import.meta.url);
  assert.equal(require('yjs/package.json').version, '13.6.33');
  assert.equal(require('y-protocols/package.json').version, '1.0.7');
});
test('Yjs reads real Rust mixed command and returns one atomic mark/block update', () => {
  const d = restore(81); const m = roots(d);
  assert.deepEqual(ownerTuple(m, 'block-1'), ['heading', 2]);
  assert.deepEqual(ownerTuple(m, 'block-2'), ['heading', 6]);
  const a = m['registry-texts'].get('block-1');
  const b = m['registry-texts'].get('block-2');
  assert.deepEqual(a.toDelta(), [
    { insert: 'a', attributes: { 'ext:v1': true } },
    { insert: 'bc', attributes: { 'ext:v1': true, bold: true } },
    { insert: 'd', attributes: { 'ext:v1': true } },
  ]);
  assert.deepEqual(b.toDelta(), [{ insert: 'efgh', attributes: { code: true } }]);
  const vector = Y.encodeStateVector(d); let events = 0;
  d.on('update', (_bytes, origin) => { assert.equal(origin, 'fixture:mixed'); events++; });
  d.transact(() => {
    m['registry-block-attributes'].set('block-1', ['paragraph']);
    m['registry-block-attributes'].set('block-2', ['heading', 1]);
    a.format(0, 1, { underline: true });
    b.format(0, 4, { code: null, strike: true });
  }, 'fixture:mixed');
  assert.equal(events, 1);
  fs.writeFileSync(path.join(dir, 'js-update.bin'), Y.encodeStateAsUpdate(d, vector));
  fs.writeFileSync(path.join(dir, 'js.bin'), Y.encodeStateAsUpdate(d));
  d.destroy();
});
test('reordered duplicate Rust base/update delivery reconstructs identical mixed semantics', () => {
  for (const schedule of [['rust-update.bin', 'base.bin', 'rust-update.bin'], ['base.bin', 'rust-update.bin', 'base.bin']]) {
    const d = new Y.Doc(); d.clientID = 82; const m = roots(d);
    for (const name of schedule) Y.applyUpdate(d, read(name), 'remote');
    assert.deepEqual(ownerTuple(m, 'block-1'), ['heading', 2]);
    assert.deepEqual(ownerTuple(m, 'block-2'), ['heading', 6]);
    assert.equal(m['registry-texts'].get('block-1').toDelta()[1].attributes.bold, true);
    assert.equal(m['registry-texts'].get('block-2').toDelta()[0].attributes.code, true);
    d.destroy();
  }
});
