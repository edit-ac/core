import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { Engine } from '../packages/core/dist/wasm/editac_wasm.js';

await init({ module_or_path: await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url)) });
let serial = 0;
const creation = () => JSON.stringify({ profile: 'v5', documentId: `91000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, epoch: '92000000-0000-4000-8000-000000000001', nodes: [{ text: 'A😀B' }] });
function rejects(action, code, operation, detail) {
  assert.throws(action, thrown => {
    assert.equal(typeof thrown, 'string');
    const error = JSON.parse(thrown);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'operation']);
    assert.equal(error.code, code); assert.equal(error.operation, operation);
    assert.equal(typeof error.message, 'string'); assert.ok(error.message.length);
    if (detail) assert.match(error.message, detail);
    return true;
  });
}

test('compiled constructor and restore retain typed JSON diagnostics and byte limits', () => {
  const create = creation();
  rejects(() => new Engine('{'), 'InvalidInput', 'create', /EOF/);
  rejects(() => new Engine(create.replace('"profile":"v5"', '"profile":"v5","profile":"v5"')), 'InvalidInput', 'create', /duplicate field/);
  rejects(() => new Engine(create.replace('"profile":"v5"', '"extra":true,"profile":"v5"')), 'InvalidInput', 'create', /unknown field/);
  rejects(() => new Engine(create + '{}'), 'InvalidInput', 'create', /trailing characters/);
  rejects(() => new Engine(' '.repeat(2 * 1024 * 1024 + 1)), 'ResourceLimit', 'create', /request exceeds byte limit/);
  rejects(() => Engine.restore('{', new Uint8Array()), 'InvalidInput', 'restore', /EOF/);
});

test('compiled invalid requests preserve document bytes and error operations', () => {
  const engine = new Engine(creation());
  try {
    engine.read(); // Drain the initial projection delta before freezing the snapshot.
    const before = engine.read(), bytes = engine.checkpoint_bytes();
    rejects(() => engine.anchor('{'), 'InvalidInput', 'anchor', /EOF/);
    rejects(() => engine.prepare('{'), 'InvalidInput', 'prepare', /EOF/);
    rejects(() => engine.encode_update(new Uint8Array([255])), 'EngineRejected', 'encodeUpdate');
    rejects(() => engine.apply_update('{', new Uint8Array()), 'InvalidInput', 'applyUpdate', /EOF/);
    assert.equal(engine.read(), before); assert.deepEqual(engine.checkpoint_bytes(), bytes);
  } finally { engine.free(); }
});

test('compiled disposed methods use the same complete error envelope', () => {
  const engine = new Engine(creation());
  try {
    engine.dispose(); engine.dispose();
    for (const [action, operation] of [
      [() => engine.read(), 'read'], [() => engine.checkpoint_metadata(), 'checkpoint'],
      [() => engine.checkpoint_bytes(), 'checkpoint'], [() => engine.state_vector(), 'stateVector'],
      [() => engine.encode_update(new Uint8Array()), 'encodeUpdate'],
    ]) rejects(action, 'Disposed', operation, /engine has been disposed/);
  } finally { engine.free(); }
});
