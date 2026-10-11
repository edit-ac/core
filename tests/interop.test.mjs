import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { before, after } from 'node:test';
import * as Y from 'yjs';
import { check, read, replica, verifyRust } from '../fixtures/interop/bridge.mjs';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'editac-interop-node-'));
  const result = spawnSync('cargo', ['test', '-p', 'editac-core', '--test', 'interop', '--locked', '--offline'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, EDITAC_INTEROP_OUTPUT: dir },
    encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, `actual Rust/JS exchange failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 passed; 0 failed; 0 ignored/);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

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
