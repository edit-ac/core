// ENG-1.7 real pinned Yjs reads production Rust descriptors and emits raced edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { roots } from './mapping.mjs';
const directory = process.argv[2];
const plain = text => text.toDelta().map(run => run.insert).join('');
function restore(name, client) {
  const doc = new Y.Doc(); doc.clientID = client;
  const maps = roots(doc);
  const data = fs.readFileSync(path.join(directory, name));
  Y.applyUpdate(doc, data, 'fixture:restore');
  Y.applyUpdate(doc, data, 'fixture:duplicate');
  return { doc, maps, first: maps['registry-texts'].get('block-1'), second: maps['registry-texts'].get('block-2') };
}
const split = restore('rust-split.bin', 21);
const descriptor = split.maps['probe-split-join'].get('pair');
assert.equal(descriptor[0], 'split');
assert.ok(descriptor[1] instanceof Uint8Array);
const relative = Y.decodeRelativePosition(descriptor[1]);
assert.equal(relative.assoc, -1);
let position = Y.createAbsolutePositionFromRelativePosition(relative, split.doc);
assert.equal(position.type, split.first); assert.equal(position.index, 3);
assert.equal(plain(split.first), 'a😀b'); assert.equal(plain(split.second), 'cאבd');
assert.deepEqual(split.first.toDelta(), [{ insert: 'a😀b', attributes: { bold: true, 'ext:v1': { retained: true } } }]);
assert.deepEqual(split.second.toDelta(), [{ insert: 'cאבd', attributes: { code: true } }]);
assert.equal(split.maps['registry-texts'].has('block-split'), false);
split.doc.transact(() => {
  split.first.insert(3, 'R', { bold: true, 'ext:v1': { retained: true } });
  split.second.insert(4, 'S', { code: true });
}, 'fixture:race');
position = Y.createAbsolutePositionFromRelativePosition(relative, split.doc);
assert.equal(position.index, 3);
fs.writeFileSync(path.join(directory, 'js-split-edit.bin'), Y.encodeStateAsUpdate(split.doc));
split.doc.destroy();
const joined = restore('rust-join.bin', 22);
assert.deepEqual(joined.maps['probe-split-join'].get('pair'), ['join']);
assert.equal(plain(joined.first), 'a😀b'); assert.equal(plain(joined.second), 'cאבd');
joined.doc.destroy();
const original = restore('seed.bin', 23);
assert.deepEqual(original.maps['probe-split-join'].get('pair'), ['original']);
original.doc.transact(() => {
  original.maps['probe-split-join'].set('pair', ['join']);
  original.first.insert(1, 'J', { bold: true, 'ext:v1': { retained: true } });
  original.second.insert(1, 'K', { code: true });
}, 'fixture:js-join');
fs.writeFileSync(path.join(directory, 'js-join.bin'), Y.encodeStateAsUpdate(original.doc));
original.doc.destroy();
