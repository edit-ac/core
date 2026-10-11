import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awareness from 'y-protocols/awareness';

test('lockfile keeps exact protocol fixture pins dev-only', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  for (const [name, version] of [['yjs', '13.6.33'], ['y-protocols', '1.0.7']]) {
    assert.equal(lock.packages[''].devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(lock.packages[`node_modules/${name}`].dev, true);
  }
});

test('Yjs fixture import provides UTF-16 text offsets', () => {
  const doc = new Y.Doc();
  try {
    const text = doc.getText('toolchain-fixture');
    text.insert(0, 'a😀b');
    text.insert(3, '!');
    assert.equal(text.toString(), 'a😀!b');
    assert.equal(text.length, 5);
  } finally {
    doc.destroy();
  }
});

test('protocol fixture subpath imports resolve', () => {
  assert.equal(typeof sync.writeSyncStep1, 'function');
  assert.equal(typeof sync.readSyncMessage, 'function');
  assert.equal(typeof awareness.Awareness, 'function');
});
