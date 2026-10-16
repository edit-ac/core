import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { init } from '../packages/core/dist/index.js';
import { Engine } from '../packages/core/dist/wasm/editac_wasm.js';
import { createHandle, restoreHandle, EngineError } from '../packages/core/dist/engine.js';

let server, runtime;
test('constructor errors preserve typed engine failures and normalize untyped failures', () => {
  const original = new EngineError('ResourceLimit', 'restore', 'bounded payload');
  for (const [thrown, code, operation, message] of [
    [original, 'ResourceLimit', 'restore', 'bounded payload'],
    [JSON.stringify({code:'EngineRejected', operation:'create', message:'invalid identity'}), 'EngineRejected', 'create', 'invalid identity'],
    ['not JSON', 'InvalidInput', 'create', 'not JSON'],
    ['null', 'InvalidInput', 'create', 'null'],
    ['{"code":7}', 'InvalidInput', 'create', '{"code":7}'],
    [new Error('constructor failed'), 'InvalidInput', 'create', 'constructor failed'],
  ]) {
    assert.throws(() => createHandle(() => { throw thrown; }, {}), error => {
      assert.ok(error instanceof EngineError);
      assert.deepEqual([error.code, error.operation, error.message], [code, operation, message]);
      if (thrown === original) assert.equal(error, original);
      return true;
    });
  }
});
before(async () => {
  const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
  server = createServer((_, response) => { response.writeHead(200, { 'Content-Type': 'application/wasm' }); response.end(wasm); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  runtime = await init(`http://127.0.0.1:${server.address().port}/engine.wasm`);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('a real update larger than 100k bytes restores from the checkpoint journal', () => {
  const engine = runtime.createEngine({ profile: 'v5', documentId: randomUUID(), epoch: randomUUID(), nodes: [{ text: 'base' }] });
  let restored;
  try {
    const identity = engine.read().identity, checkpoint = engine.checkpoint(), vector = engine.stateVector();
    const id = engine.read().visible.find(node => node.kind === 'block').id;
    const at = engine.anchor(id, 4, 'right');
    try {
      const plan = engine.prepare({ kind: 'text', origin: 'regression:large-journal', command: { type: 'insert', at, text: 'x'.repeat(120000) } });
      try { const committed = engine.commit(plan); if (committed.caret) engine.releaseAnchor(committed.caret); }
      finally { engine.releasePlan(plan); }
    } finally { engine.releaseAnchor(at); }
    const update = engine.encodeUpdate(vector);
    assert.ok(update.bytes.length > 100000, 'The regression must exercise a large binary payload');
    restored = runtime.restoreEngine(identity, checkpoint, [update]);
    assert.deepEqual(restored.read().visible, engine.read().visible);
    assert.deepEqual(restored.stateVector(), engine.stateVector());
  } finally { restored?.dispose(); engine.dispose(); }
});

test('untrusted metadata arrays retain the existing structure bound', () => {
  let allocations = 0;
  const construct = () => { allocations++; throw Error("unexpected engine allocation"); };
  assert.throws(() => runtime.createEngine({ profile: 'v5', documentId: randomUUID(), epoch: randomUUID(), nodes: Array(100001).fill({ text: '' }) }),
    error => error.code === 'InvalidInput' && /array/.test(error.message));
  assert.throws(() => createHandle(construct, { profile: 'v5', documentId: randomUUID(), epoch: randomUUID(), nodes: Array(100001).fill({ text: '' }) }), error => error.code === 'InvalidInput');
  assert.equal(allocations, 0, 'Rejected input cannot reach the WASM engine constructor');
});

test('multiple bounded updates can exceed 100k payload bytes in aggregate during replay', () => {
  const engine = runtime.createEngine({ profile: 'v5', documentId: randomUUID(), epoch: randomUUID(), nodes: [{ text: 'base' }] });
  let restored;
  try {
    const identity = engine.read().identity, checkpoint = engine.checkpoint(), updates = [];
    const id = engine.read().visible.find(node => node.kind === 'block').id;
    for (let index = 0; index < 4; index++) {
      const vector = engine.stateVector(), at = engine.anchor(id, 4 + index * 30000, 'right');
      try {
        const plan = engine.prepare({ kind: 'text', origin: 'regression:journal-series', command: { type: 'insert', at, text: 'y'.repeat(30000) } });
        try { const result = engine.commit(plan); if (result.caret) engine.releaseAnchor(result.caret); }
        finally { engine.releasePlan(plan); }
      } finally { engine.releaseAnchor(at); }
      updates.push(engine.encodeUpdate(vector));
    }
    assert.ok(updates.every(update => update.bytes.length < 100000));
    assert.ok(updates.reduce((sum, update) => sum + update.bytes.length, 0) > 100000);
    restored = runtime.restoreEngine(identity, checkpoint, updates);
    assert.deepEqual(restored.read().visible, engine.read().visible);
    assert.deepEqual(restored.stateVector(), engine.stateVector());
  } finally { restored?.dispose(); engine.dispose(); }
});

test('oversized journal payload still rejects before replay or document allocation', () => {
  const engine = runtime.createEngine({ profile: 'v5', documentId: randomUUID(), epoch: randomUUID(), nodes: [{ text: 'base' }] });
  try {
    const identity = engine.read().identity, checkpoint = engine.checkpoint();
    let allocations = 0;
    assert.throws(() => runtime.restoreEngine(identity, checkpoint, [{ identity, bytes: new Uint8Array(16 * 1024 * 1024 - checkpoint.bytes.length + 1) }]),
      error => error.code === 'ResourceLimit');
    assert.throws(() => restoreHandle(() => { allocations++; throw Error('unexpected engine allocation'); }, identity, checkpoint, [{ identity, bytes: new Uint8Array(16 * 1024 * 1024 - checkpoint.bytes.length + 1) }]), error => error.code === 'ResourceLimit');
    assert.equal(allocations, 0);
    assert.equal(engine.read().visible.find(node => node.kind === 'block').runs[0].text, 'base');
  } finally { engine.dispose(); }
});


test('binary restore validates exact partitioning, identities and encoding before publication', () => {
  const engine = runtime.createEngine({ profile:'v5', documentId:randomUUID(), epoch:randomUUID(), nodes:[{text:'base'}] });
  try {
    const checkpoint = engine.checkpoint(), identity = checkpoint.identity;
    const update = engine.encodeUpdate();
    const payload = new Uint8Array(checkpoint.bytes.length + update.bytes.length);
    payload.set(checkpoint.bytes); payload.set(update.bytes, checkpoint.bytes.length);
    const metadata = {expected:identity, identity, initialized:true, writerId:checkpoint.writerId,
      journal:[], checkpointBytes:checkpoint.bytes.length, binaryJournal:[{identity, byteLength:update.bytes.length}]};
    const raw = Engine.restore(JSON.stringify(metadata), payload); raw.dispose(); raw.free();
    // Historical JSON journals remain admitted with the original request limit.
    const legacy = {...metadata, journal:[{identity, bytes:[...update.bytes]}]};
    delete legacy.checkpointBytes; delete legacy.binaryJournal;
    const old = Engine.restore(JSON.stringify(legacy), checkpoint.bytes); old.dispose(); old.free();
    for (const change of [
      m => m.checkpointBytes++, m => m.checkpointBytes--,
      m => m.binaryJournal[0].byteLength++, m => m.binaryJournal[0].byteLength--,
      m => m.binaryJournal[0].byteLength = Number.MAX_SAFE_INTEGER,
      m => m.binaryJournal[0].identity = {...m.binaryJournal[0].identity, epoch:randomUUID()},
      m => m.binaryJournal = Array(4097).fill(m.binaryJournal[0]),
      m => m.journal = [{identity, bytes:[...update.bytes]}],
      m => delete m.checkpointBytes, m => delete m.binaryJournal,
    ]) {
      const invalid = structuredClone(metadata); change(invalid);
      assert.throws(() => Engine.restore(JSON.stringify(invalid), payload));
    }
    assert.equal(engine.read().visible[0].runs[0].text, 'base');
  } finally {engine.dispose();}
});
