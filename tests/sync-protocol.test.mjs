import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import { init } from '../packages/core/dist/index.js';
import { DirectSyncAdapter, SyncProtocolError } from '../packages/web/dist/sync/protocol.js';
import { replica, roots, snapshot } from '../fixtures/schema-v5/mapping.mjs';
import { preparedSocketPair } from './helpers/prepared-socket.mjs';

const explicitOutput = process.env.EDITAC_SYNC_PROTOCOL_OUTPUT;
const output = explicitOutput ?? await mkdtemp(join(tmpdir(), 'editac-sync-protocol-'));
await mkdir(output, { recursive: true });
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
const facts = { boundary: 'Actual Rust WASM engine-v5 / JS same-schema peer; in-memory copied socket; no credentials or application network',
  wasmSha256: createHash('sha256').update(wasm).digest('hex'), cases: [], frames: [] };
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
after(async () => {
  await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
  if (!explicitOutput && facts.cases.every(c => c.passed)) await rm(output, { recursive: true, force: true });
  else if (!explicitOutput) console.log(`Preserved sync evidence: ${output}`);
});
let fixtureNumber = 0;
function fixture() {
  const documentId = `${String(++fixtureNumber).padStart(8, '0')}-4567-4567-8567-45678901abcd`;
  const engine = runtime.createEngine({ profile: 'v5', documentId,
    epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀b e\u0301👩\u200d💻' }, { text: 'second' }] });
  const initial = engine.checkpoint(), peer = replica(404), socket = preparedSocketPair();
  Y.applyUpdate(peer, initial.bytes, 'restore');
  const adapter = new DirectSyncAdapter(engine, initial.identity);
  const text = () => roots(peer)['registry-texts'].get(engine.read().visible[0].spans[0].source);
  return { engine, initial, peer, adapter, socket, text,
    close() { socket.close(); peer.destroy(); engine.dispose(); assert.equal(socket.closed, true); } };
}
function oracle(write) { const e = encoding.createEncoder(); write(e); return encoding.toUint8Array(e); }
function jsReceive(peer, frame) {
  const response = encoding.createEncoder(), decoder = decoding.createDecoder(frame);
  sync.readSyncMessage(decoder, response, peer, 'remote', e => { throw e; });
  assert.equal(decoder.pos, frame.length); return encoding.toUint8Array(response);
}
async function capture(label, frame) {
  const name = `${facts.frames.length}-${label}.bin`; await writeFile(join(output, name), frame);
  facts.frames.push({ name, bytes: frame.length, sha256: createHash('sha256').update(frame).digest('hex') });
}
function insert(engine, text) {
  const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
  try { engine.commit(engine.prepare({ kind: 'text', origin: 'local:sync-fixture', command: { type: 'insert', at, text } })); }
  finally { engine.releaseAnchor(at); }
}
function assertConverged(f) {
  assert.deepEqual(f.engine.read().visible.map(n => n.runs.map(r => r.text).join('')),
    snapshot(f.peer).visible.map(n => n.runs.map(r => r.insert).join('')));
  assert.deepEqual(vectorEntries(f.engine.stateVector()), vectorEntries(Y.encodeStateVector(f.peer)));
  const left = replica(1001), right = replica(1002);
  try {
    Y.applyUpdate(left, f.engine.encodeUpdate().bytes); Y.applyUpdate(right, Y.encodeStateAsUpdate(f.peer));
    assert.deepEqual(snapshot(left), snapshot(right), 'all retained schema/marks/placements must converge');
  } finally { left.destroy(); right.destroy(); }
}
// Client-map serialization order is not normative across Yrs and Yjs.
function vectorEntries(bytes) { return [...Y.decodeStateVector(bytes)].sort((a,b) => a[0] - b[0]); }
function unchanged(engine, before) {
  assert.deepEqual(stableRead(engine), before.read); assert.deepEqual(engine.stateVector(), before.vector);
  assert.deepEqual(engine.history({ type: 'state' }), before.history); assert.deepEqual(engine.checkpoint().bytes, before.bytes);
}
function stableRead(engine) {
  // read() consumes incremental invalidation hints; all committed state is compared.
  const { changedNodes, touchedRanges, ...state } = engine.read(); return state;
}
function saved(engine) { return { read: stableRead(engine), vector: engine.stateVector(), history: engine.history({ type: 'state' }), bytes: engine.checkpoint().bytes }; }

check('both-direction step1 and step2 match the pinned oracle and exchange concurrent same-schema edits', async () => {
  const f = fixture();
  try {
    insert(f.engine, 'R'); f.peer.transact(() => { f.text().insert(3, 'J'); f.text().format(3, 1, { italic: true }); }, 'local:fixture');
    const step1Mirror = replica(902);
    try {
      Y.applyUpdate(step1Mirror, f.engine.encodeUpdate().bytes);
      const decoded = decoding.createDecoder(f.adapter.step1());
      assert.equal(decoding.readVarUint(decoded), sync.messageYjsSyncStep1);
      assert.deepEqual(vectorEntries(decoding.readVarUint8Array(decoded)), vectorEntries(Y.encodeStateVector(step1Mirror)));
      assert.equal(decoded.pos, f.adapter.step1().length);
    } finally { step1Mirror.destroy(); }
    const before = saved(f.engine), vector = Y.encodeStateVector(f.peer), step1 = oracle(e => sync.writeSyncStep1(e, f.peer));
    const response = f.adapter.receive(step1);
    assert.equal(response.type, 'step1'); unchanged(f.engine, before);
    const mirror = replica(901); try { Y.applyUpdate(mirror, f.engine.encodeUpdate().bytes);
      assert.deepEqual(response.reply, oracle(e => sync.writeSyncStep2(e, mirror, vector))); } finally { mirror.destroy(); }
    f.socket.peer.send(step1); f.socket.client.send(f.adapter.step1());
    const rustReply = f.adapter.receive(f.socket.client.receive()).reply;
    const jsReply = jsReceive(f.peer, f.socket.peer.receive());
    await capture('rust-step1', f.adapter.step1()); await capture('js-step1', step1);
    await capture('rust-step2', rustReply); await capture('js-step2', jsReply);
    f.socket.client.send(rustReply); f.socket.peer.send(jsReply);
    assert.equal(f.adapter.receive(f.socket.client.receive()).type, 'step2'); jsReceive(f.peer, f.socket.peer.receive());
    assertConverged(f);
    assert.equal(f.engine.history({ type: 'state' }).undoGroups, before.history.undoGroups);
  } finally { f.close(); }
});
check('update messages use actual Rust bytes; duplicate and shuffled independent updates converge without echo', async () => {
  const f = fixture(), received = [];
  const sub = f.engine.subscribe({ type: 'updates' }, p => received.push(p));
  try {
    const vector = Y.encodeStateVector(f.peer); insert(f.engine, 'R');
    const local = received.pop(); assert.equal(local.origin, 'editac:local:local:sync-fixture');
    const rust = f.adapter.update(local.update);
    assert.deepEqual(rust, oracle(e => sync.writeUpdate(e, local.update.bytes)));
    f.peer.transact(() => f.text().insert(3, 'J'), 'local:fixture');
    const js = oracle(e => sync.writeUpdate(e, Y.encodeStateAsUpdate(f.peer, vector)));
    await capture('rust-update', rust); await capture('js-update', js);
    const history = f.engine.history({ type: 'state' });
    f.socket.peer.send(js); f.socket.peer.send(js); f.socket.client.send(rust); f.socket.client.send(rust);
    assert.equal(f.adapter.receive(f.socket.client.receive(1)).reply, null);
    const revision = f.engine.read().revision;
    assert.equal(f.adapter.receive(f.socket.client.receive()).revision, revision);
    jsReceive(f.peer, f.socket.peer.receive(1)); jsReceive(f.peer, f.socket.peer.receive());
    assert.equal(received.length, 1); assert.equal(received[0].origin, 'remote');
    assert.equal(f.engine.history({ type: 'state' }).undoGroups, history.undoGroups);
    assertConverged(f);
  } finally { sub.dispose(); f.close(); }
});

check('deletion-only step2 exchange works when state vectors are equal and repeated messages are idempotent', () => {
  const f = fixture();
  try {
    f.peer.transact(() => f.text().delete(3, 1), 'local:fixture');
    assert.deepEqual(f.engine.stateVector(), Y.encodeStateVector(f.peer), 'delete sets are not state vectors');
    const reply = jsReceive(f.peer, f.adapter.step1());
    f.adapter.receive(reply); const before = saved(f.engine); f.adapter.receive(reply); unchanged(f.engine, before);
    assertConverged(f);
  } finally { f.close(); }
});

check('reject malformed frames and state vectors before any engine mutation', () => {
  const f = fixture();
  try {
    insert(f.engine, 'R'); const before = saved(f.engine);
    const invalid = [null, new Uint8Array(), Uint8Array.of(3,1,0), Uint8Array.of(128), Uint8Array.of(128,0,1,0),
      Uint8Array.of(0,129,0,0), Uint8Array.of(0,2,0), Uint8Array.of(0,1,0,1), Uint8Array.of(0,0),
      Uint8Array.of(0,1,1), Uint8Array.of(0,2,0,0), Uint8Array.of(0,5,2,1,0,1,0),
      Uint8Array.of(0,6,1,255,255,255,255,31), Uint8Array.of(0,3,129,32,0),
      Uint8Array.of(255,255,255,255,31), Uint8Array.of(0,255,255,255,255,15)];
    for (const frame of invalid) { assert.throws(() => f.adapter.receive(frame), SyncProtocolError); unchanged(f.engine, before); }
  } finally { f.close(); }
});

check('malformed or unsupported binary/schema updates are rejected by staged Rust admission without live changes', () => {
  const f = fixture();
  try {
    insert(f.engine, 'R'); const before = saved(f.engine), invalidDoc = new Y.Doc();
    try {
      invalidDoc.getText('unsupported-root').insert(0, 'bad');
      for (const bytes of [Uint8Array.of(255), Uint8Array.of(0), Y.encodeStateAsUpdate(invalidDoc),
        Uint8Array.from([...f.engine.encodeUpdate().bytes, 0])]) {
        for (const type of [1, 2]) {
          const frame = oracle(e => { encoding.writeVarUint(e, type); encoding.writeVarUint8Array(e, bytes); });
          assert.throws(() => f.adapter.receive(frame)); unchanged(f.engine, before);
        }
      }
    } finally { invalidDoc.destroy(); }
  } finally { f.close(); }
});

check('inbound and outbound byte bounds include headers; no input buffers are aliased', () => {
  const f = fixture();
  try {
    const bounded = new DirectSyncAdapter(f.engine, f.initial.identity, { maxFrameBytes: 16 });
    const before = saved(f.engine);
    assert.throws(() => bounded.receive(new Uint8Array(17)), e => e.code === 'resource-limit');
    assert.throws(() => bounded.update({ identity: f.initial.identity, bytes: new Uint8Array(15) }), e => e.code === 'resource-limit');
    assert.throws(() => bounded.receive(Uint8Array.of(0,1,0)), e => e.code === 'resource-limit', 'oversized generated reply is rejected');
    for (const maxFrameBytes of [0, 2, -1, NaN, 1.5, 16777217]) assert.throws(() => new DirectSyncAdapter(f.engine, f.initial.identity, { maxFrameBytes }));
    const bytes = new Uint8Array([0,0]), frame = f.adapter.update({ identity: f.initial.identity, bytes });
    bytes.fill(99); assert.deepEqual(frame, Uint8Array.of(2,2,0,0)); unchanged(f.engine, before);
  } finally { f.close(); }
});

check('metadata must match every immutable field before adapter construction or outbound update', () => {
  const f = fixture();
  try {
    const before = saved(f.engine);
    for (const [field, value] of [['documentId','12345678-1234-4234-8234-123456789abc'], ['epoch','12345678-1234-4234-8234-123456789abc'],
      ['profile','unknown'], ['schema','unknown'], ['protocolVersion',2], ['updateEncoding',2], ['offsets','utf8']]) {
      const wrong = { ...f.initial.identity, [field]: value };
      assert.throws(() => new DirectSyncAdapter(f.engine, wrong), SyncProtocolError);
      assert.throws(() => f.adapter.update({ identity: wrong, bytes: Uint8Array.of(0,0) }), SyncProtocolError);
      unchanged(f.engine, before);
    }
    for (const wrong of [null, {}, { ...f.initial.identity, extra: true }, { ...f.initial.identity, documentId: 'invalid' }]) {
      assert.throws(() => new DirectSyncAdapter(f.engine, wrong), SyncProtocolError); unchanged(f.engine, before);
    }
  } finally { f.close(); }
});
