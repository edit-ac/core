import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { constructSeed, roots, seed, admit, applyAdmitted } from '../fixtures/schema-v1/mapping.mjs';
import { project, mutate, orders } from '../fixtures/schema-v1/exchange.mjs';

test('maximum-order local split rejects before mutation', () => {
  const doc = constructSeed();
  try {
    doc.getMap('registry-placements').set('block-1', ['@root', 4294967295]);
    const before = Y.encodeStateAsUpdate(doc);
    assert.throws(() => mutate(doc, 'split-edit', 'rust'), /derived order out of range/);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});

test('concurrent split and maximum-order move preserves explicit recovery through replay and restore', () => {
  const initializer = constructSeed();
  const base = Y.encodeStateAsUpdate(initializer);
  const vector = Y.encodeStateVector(initializer);
  initializer.destroy();
  const updates = [base];
  for (const split of [true, false]) {
    const writer = new Y.Doc();
    try {
      Y.applyUpdate(writer, base);
      if (split) mutate(writer, 'split-edit', 'rust');
      else writer.getMap('registry-placements').set('block-1', ['@root', 4294967295]);
      updates.push(Y.encodeStateAsUpdate(writer, vector));
    } finally { writer.destroy(); }
  }
  for (const order of orders) {
    const doc = new Y.Doc();
    const restored = new Y.Doc();
    try {
      for (const i of [...order, ...order, ...order.toReversed()]) Y.applyUpdate(doc, updates[i]);
      const before = Y.encodeStateAsUpdate(doc);
      const check = replica => assert.throws(() => project(replica), error => {
        assert.equal(error.message, 'derived order out of range');
        assert.deepEqual(error.recoveryUpdate, Y.encodeStateAsUpdate(replica));
        assert.deepEqual(replica.getMap('registry-texts').get('block-1').toDelta(), [
          { insert: 'a' }, { insert: '😀', attributes: { bold: true } }, { insert: 'b' },
        ]);
        return true;
      });
      check(doc);
      assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
      Y.applyUpdate(restored, before, 'restore');
      check(restored);
    } finally { doc.destroy(); restored.destroy(); }
  }
});

test('frozen JS roots, nested types, atomic values and UTF-16 marks match the recipe', () => {
  const doc = constructSeed();
  try {
    assert.deepEqual([...doc.share.keys()].sort(), Object.keys(seed.roots).sort());
    const maps = roots(doc);
    for (const node of seed.nodes) {
      assert.equal(maps['registry-parents'].get(node.id), node.kind);
      assert.deepEqual(maps['registry-placements'].get(node.id), node.placement);
      const text = maps['registry-texts'].get(node.id);
      assert.ok(text instanceof Y.XmlText);
      assert.equal(text.length, 4);
      assert.deepEqual(text.toDelta(), [
        { insert: node.text.slice(0, 1) },
        { insert: node.text.slice(1, 3), attributes: node.format.attributes },
        { insert: node.text.slice(3) },
      ]);
    }
    assert.deepEqual(maps['probe-split-join'].get('pair'), ['original']);
    assert.equal(maps['delete-probe-tombstones'].size, 0);
  } finally { doc.destroy(); }
});

test('every unsupported profile field and wrong identity rejects before byte application', () => {
  const doc = constructSeed();
  try {
    const before = Y.encodeStateAsUpdate(doc);
    const vector = Y.encodeStateVector(doc);
    let updates = 0;
    doc.on('update', () => updates++);
    for (const [key, value, result] of [
      ['profile', 'future', 'unsupported-profile'], ['schema', 'future', 'unsupported-profile'],
      ['protocolVersion', 2, 'unsupported-profile'], ['updateEncoding', 2, 'unsupported-profile'],
      ['offsets', 'utf8', 'unsupported-profile'],
      ['documentId', '00000000-0000-4000-8000-000000000003', 'wrong-document'],
      ['epoch', '00000000-0000-4000-8000-000000000003', 'wrong-epoch'],
    ]) {
      // Deliberately invalid bytes prove rejection happens before decoding/mutation.
      assert.equal(applyAdmitted(doc, seed.metadata, { ...seed.metadata, [key]: value }, Uint8Array.of(255)), result);
      assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
      assert.deepEqual(Y.encodeStateVector(doc), vector);
    }
    for (const value of [null, {}, { ...seed.metadata, epoch: 'bad' }, { ...seed.metadata, protocolVersion: '1' }]) {
      assert.equal(admit(seed.metadata, value), 'invalid-metadata');
    }
    assert.equal(admit({ ...seed.metadata, schema: 'future' }, seed.metadata), 'unsupported-profile');
    assert.equal(updates, 0);
  } finally { doc.destroy(); }
});

test('restore replays one initializer idempotently with restore origin and no reseeding', () => {
  const initializer = constructSeed();
  const restored = new Y.Doc();
  try {
    roots(restored);
    const origins = [];
    restored.on('update', (_bytes, origin) => origins.push(origin));
    const bytes = Y.encodeStateAsUpdate(initializer);
    assert.equal(applyAdmitted(restored, seed.metadata, seed.metadata, bytes, 'restore'), 'accepted');
    assert.equal(applyAdmitted(restored, seed.metadata, seed.metadata, bytes, 'restore'), 'accepted');
    assert.deepEqual(origins, ['restore']);
    assert.deepEqual(roots(restored)['registry-texts'].get('block-1').toDelta(), roots(initializer)['registry-texts'].get('block-1').toDelta());
    assert.deepEqual(Y.encodeStateVector(restored), Y.encodeStateVector(initializer));
    const empty = new Y.Doc();
    try {
      roots(empty);
      assert.equal(admit(seed.metadata, seed.metadata), 'accepted');
      assert.equal(roots(empty)['registry-texts'].size, 0, 'existing empty metadata never implies seed content');
    } finally { empty.destroy(); }
  } finally { initializer.destroy(); restored.destroy(); }
});

test('opaque kinds and marks survive checkpoint replay without extension execution', () => {
  const doc = constructSeed();
  const restored = new Y.Doc();
  try {
    const maps = roots(doc);
    doc.transact(() => {
      maps['registry-parents'].set('block-2', 'unknown-widget');
      maps['registry-texts'].get('block-2').format(1, 2, { 'unknown-mark': { payload: ['retained', 7] } });
    }, 'local:fixture');
    roots(restored);
    applyAdmitted(restored, seed.metadata, seed.metadata, Y.encodeStateAsUpdate(doc), 'restore');
    assert.equal(roots(restored)['registry-parents'].get('block-2'), 'unknown-widget');
    assert.deepEqual(roots(restored)['registry-texts'].get('block-2').toDelta()[1].attributes,
      { code: true, 'unknown-mark': { payload: ['retained', 7] } });
  } finally { doc.destroy(); restored.destroy(); }
});
