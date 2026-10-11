// Disposable FND-1.3 XML fixture; not the editor's frozen schema or persistence.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

export const input = 'a😀b e\u0301👩\u200d💻🇭🇺אב';
export const expected = [
  { insert: 'a' }, { insert: '😀', attributes: { bold: true } },
  { insert: '!', attributes: { italic: true } }, { insert: input.slice(4) },
];
export const orders = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
export function replica(id) { const doc = new Y.Doc(); doc.clientID = id; return doc; }
export function check(doc) {
  const root = doc.getXmlFragment('interop');
  assert.equal(root.length, 1);
  const element = root.get(0);
  assert.equal(element.nodeName, 'p');
  assert.deepEqual(element.getAttributes(), { id: 'fixture-block', stage: 'edited' });
  assert.equal(element.length, 1);
  assert.deepEqual(element.get(0).toDelta(), expected);
  assert.equal(element.get(0).length, expected.map(x => x.insert).join('').length);
}
export function read(dir, file) { return new Uint8Array(readFileSync(join(dir, file))); }
function save(dir, file, bytes) { writeFileSync(join(dir, file), bytes); }
export function verifyRust(dir) {
  for (const order of orders) {
    const doc = replica(303);
    try {
      for (const i of order) {
        const update = read(dir, `rust-${i}.bin`);
        Y.applyUpdate(doc, update); Y.applyUpdate(doc, update);
      }
      check(doc);
      const before = Y.encodeStateVector(doc);
      for (const i of [...order].reverse()) Y.applyUpdate(doc, read(dir, `rust-${i}.bin`));
      check(doc); assert.deepEqual(Y.encodeStateVector(doc), before);
    } finally { doc.destroy(); }
  }
}
function generate(dir) {
  const doc = replica(101);
  try {
    const root = doc.getXmlFragment('interop');
    const element = new Y.XmlElement('p'); const text = new Y.XmlText();
    const edits = [
      () => { root.insert(0, [element]); element.setAttribute('id', 'fixture-block');
        element.insert(0, [text]); text.insert(0, input); text.format(1, 2, { bold: true }); },
      () => text.insert(3, '!', { italic: true }), // after emoji: UTF-16 offset 3
      () => { text.delete(4, 1); element.setAttribute('stage', 'edited'); },
    ];
    edits.forEach((edit, i) => { const vector = Y.encodeStateVector(doc);
      doc.transact(edit); save(dir, `js-${i}.bin`, Y.encodeStateAsUpdate(doc, vector));
      save(dir, `js-sv-${i}.bin`, Y.encodeStateVector(doc)); });
    check(doc);
    save(dir, 'js-full.bin', Y.encodeStateAsUpdate(doc));
  } finally { doc.destroy(); }
}
function deltaForRust(dir) {
  const doc = replica(404);
  try {
    Y.applyUpdate(doc, read(dir, 'rust-0.bin'));
    assert.deepEqual(Y.encodeStateVector(doc), read(dir, 'rust-sv-0.bin'));
    doc.getXmlFragment('interop').get(0).get(0).insert(3, '?', { underline: true });
    save(dir, 'js-for-rust.bin', Y.encodeStateAsUpdate(doc, read(dir, 'rust-sv-0.bin')));
    save(dir, 'js-for-rust-sv.bin', Y.encodeStateVector(doc));
  } finally { doc.destroy(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [mode, dir] = process.argv.slice(2);
  if (mode === 'generate-js') generate(dir);
  else if (mode === 'verify-rust') verifyRust(dir);
  else if (mode === 'delta-for-rust') deltaForRust(dir);
  else throw new Error(`Unknown mode ${mode}`);
}
