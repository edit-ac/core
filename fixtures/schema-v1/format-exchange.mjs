// ENG-1.6 deterministic pinned Yrs/Yjs character-attribute exchange.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { roots } from './mapping.mjs';
const directory = process.argv[2];
const doc = new Y.Doc();
doc.clientID = 21;
const maps = roots(doc);
const input = fs.readFileSync(path.join(directory, 'rust.bin'));
Y.applyUpdate(doc, input, 'fixture:restore');
Y.applyUpdate(doc, input, 'fixture:duplicate');
const first = maps['registry-texts'].get('block-1');
const second = maps['registry-texts'].get('block-2');
assert.deepEqual(first.toDelta(), [
  { insert: 'a', attributes: { 'ext:v1': true } },
  { insert: 'bc', attributes: { 'ext:v1': true, bold: true, italic: true, strike: true, underline: true, link: 'https://example.com/' } },
  { insert: 'd', attributes: { 'ext:v1': true } },
]);
assert.deepEqual(second.toDelta(), [{ insert: 'efgh', attributes: { code: true } }]);
assert.deepEqual(maps['probe-split-join'].get('pair'), ['original']);
assert.equal(maps['registry-parents'].get('block-1'), 'list');
doc.transact(() => {
  first.format(0, 1, { underline: true });
  second.format(0, 4, { code: null, strike: true });
}, 'fixture:js-format');
fs.writeFileSync(path.join(directory, 'js.bin'), Y.encodeStateAsUpdate(doc));
doc.destroy();
