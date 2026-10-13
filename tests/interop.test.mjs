import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { before, after } from 'node:test';
import * as Y from 'yjs';
import { check, read, replica, verifyRust, orders } from '../fixtures/interop/bridge.mjs';
import { preparedSocketPair } from './helpers/prepared-socket.mjs';

let dir;
before(() => {
  dir = process.env.EDITAC_INTEROP_OUTPUT ?? mkdtempSync(join(tmpdir(), 'editac-interop-node-'));
  mkdirSync(dir, { recursive: true });
  const result = spawnSync('cargo', ['test', '-p', 'editac-core', '--test', 'interop', '--locked', '--offline'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, EDITAC_INTEROP_OUTPUT: dir },
    encoding: 'utf8', timeout: 120_000,
  });
  writeFileSync(join(dir, 'rust.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.status, 0, `actual Rust/JS exchange failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 passed; 0 failed; 0 ignored/);
});
after(() => { if (dir && !process.env.EDITAC_INTEROP_OUTPUT) rmSync(dir, { recursive: true, force: true }); });

test('Rust XML updates preserve semantic text and attributes in all six shuffled duplicate schedules', () => {
  verifyRust(dir);
});
test('Rust delta against JS state vector completes the original JS writer', () => {
  const doc = replica(808);
  try {
    Y.applyUpdate(doc, read(dir, 'js-0.bin'));
    Y.applyUpdate(doc, read(dir, 'rust-for-js.bin'));
    Y.applyUpdate(doc, read(dir, 'rust-for-js.bin'));
    check(doc);
    assert.deepEqual(Y.encodeStateVector(doc), read(dir, 'js-sv-2.bin'));
  } finally { doc.destroy(); }
});
test('JS delta against Rust state vector retains both distinct writer identities and emoji marks', () => {
  const doc = replica(909);
  try {
    Y.applyUpdate(doc, read(dir, 'rust-0.bin'));
    Y.applyUpdate(doc, read(dir, 'js-for-rust.bin'));
    Y.applyUpdate(doc, read(dir, 'js-for-rust.bin'));
    const text = doc.getXmlFragment('interop').get(0).get(0);
    assert.deepEqual(text.toDelta(), [
      { insert: 'a' }, { insert: '😀', attributes: { bold: true } },
      { insert: '?', attributes: { underline: true } }, { insert: 'b e\u0301👩\u200d💻🇭🇺אב' },
    ]);
    assert.deepEqual([...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()].sort(), [202, 404]);
    assert.deepEqual(Y.encodeStateVector(doc), read(dir, 'js-for-rust-sv.bin'));
  } finally { doc.destroy(); }
});

test('prepared socket copies Rust update frames and delivers all shuffled duplicate schedules offline', () => {
  // The upstream XML oracle is deliberately distinct from the editor schema.
  for (const order of orders) {
    const socket = preparedSocketPair(), doc = replica(1001);
    try {
      for (const i of order) {
        const bytes = read(dir, `rust-${i}.bin`);
        socket.peer.send(bytes); socket.peer.send(bytes); bytes.fill(0);
      }
      socket.disconnect();
      assert.throws(() => socket.client.receive(), /disconnected/);
      assert.equal(socket.client.pending, 6);
      socket.reconnect();
      while (socket.client.pending) Y.applyUpdate(doc, socket.client.receive(), 'fixture:remote');
      check(doc);
      const before = Y.encodeStateVector(doc);
      for (const i of [...order].reverse()) socket.peer.send(read(dir, `rust-${i}.bin`));
      while (socket.client.pending) Y.applyUpdate(doc, socket.client.receive(), 'fixture:remote');
      check(doc); assert.deepEqual(Y.encodeStateVector(doc), before);
    } finally { doc.destroy(); socket.close(); }
    assert.equal(socket.closed, true);
    assert.equal(socket.client.pending, 0);
  }
});

test('prepared socket bounds, explicit reorder and teardown do not require an endpoint', () => {
  const socket = preparedSocketPair({ maxFrameBytes: 2, maxQueuedFrames: 2 });
  try {
    assert.throws(() => socket.client.send(new Uint8Array(3)), /Frame bound/);
    assert.throws(() => socket.client.send('secret'), /Binary frame/);
    socket.client.send(Uint8Array.of(1)); socket.client.send(Uint8Array.of(2));
    assert.throws(() => socket.client.send(Uint8Array.of(3)), /Queue bound/);
    assert.deepEqual(socket.peer.receive(1), Uint8Array.of(2));
    assert.deepEqual(socket.peer.receive(), Uint8Array.of(1));
    assert.throws(() => socket.peer.receive(), /No prepared frame/);
    socket.disconnect(); assert.throws(() => socket.client.send(Uint8Array.of(1)), /disconnected/);
  } finally { socket.close(); }
  assert.throws(() => socket.reconnect(), /closed/);
  assert.throws(() => socket.client.send(Uint8Array.of(1)), /closed/);
});
