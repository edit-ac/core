import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as awareness from 'y-protocols/awareness';
import { init } from '../packages/core/dist/index.js';
import { AwarenessAdapter, AwarenessError } from '../packages/web/dist/sync/awareness.js';
import { DirectSyncAdapter } from '../packages/web/dist/sync/protocol.js';
import { UpdateJournal } from '../packages/web/dist/storage/journal.js';
import { UpdateOutbox } from '../packages/web/dist/storage/outbox.js';
import { CheckpointIndexedDB } from './helpers/checkpoint-storage.mjs';
import { preparedSocketPair } from './helpers/prepared-socket.mjs';
import { replica, roots } from '../fixtures/schema-v5/mapping.mjs';

const explicitOutput = process.env.EDITAC_AWARENESS_OUTPUT;
const output = explicitOutput ?? await mkdtemp(join(tmpdir(), 'editac-awareness-'));
await mkdir(output, { recursive: true });
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
const facts = { boundary: 'Actual Rust engine-v5 WASM, pinned JS awareness/relative-position oracle, real journal/outbox adapters with prepared IndexedDB transactions and copied socket frames; no credentials/network',
  wasmSha256: createHash('sha256').update(wasm).digest('hex'), cases: [], frames: [] };
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
after(async () => {
  await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
  if (!explicitOutput && facts.cases.every(c => c.passed)) await rm(output, { recursive: true, force: true });
  else if (!explicitOutput) console.log(`Preserved awareness evidence: ${output}`);
});
let serial = 0;
function fixture(options = {}) {
  const engine = runtime.createEngine({ profile: 'v5', documentId: `${String(++serial).padStart(8, '0')}-4567-4567-8567-45678901abcd`,
    epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀bc' }, { text: 'second' }] });
  const peer = replica(404), checkpoint = engine.checkpoint(); Y.applyUpdate(peer, checkpoint.bytes, 'restore');
  const js = new awareness.Awareness(peer), adapter = new AwarenessAdapter(engine, checkpoint.writerId, options), socket = preparedSocketPair();
  const text = () => roots(peer)['registry-texts'].get(engine.read().visible[0].spans[0].source);
  const node = () => engine.read().visible[0].id;
  function selection(a = 1, f = 3) {
    const anchor = engine.anchor(node(), a, 'left'), focus = engine.anchor(node(), f, 'right');
    try { return { anchor: engine.exportAnchor(anchor), focus: engine.exportAnchor(focus) }; }
    finally { engine.releaseAnchor(anchor); engine.releaseAnchor(focus); }
  }
  function jsSelection(a = 1, f = 3) {
    const base = selection();
    base.anchor.position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text(), a, -1));
    base.focus.position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text(), f, 0));
    return base;
  }
  function inbound(state = { selection: jsSelection() }, now = 0) {
    js.setLocalState(state); const bytes = awareness.encodeAwarenessUpdate(js, [peer.clientID]);
    socket.peer.send(bytes); adapter.receive(socket.client.receive(), now); return bytes;
  }
  function setLocal(a = 1, f = 3) {
    const anchor = engine.anchor(node(), a, 'left'), focus = engine.anchor(node(), f, 'right');
    try { adapter.setLocal({ anchor, focus }); } finally { engine.releaseAnchor(anchor); engine.releaseAnchor(focus); }
  }
  function send(now) { return adapter.flush(bytes => { socket.client.send(bytes); return true; }, now); }
  return { engine, peer, js, adapter, socket, text, node, selection, jsSelection, inbound, setLocal, send,
    close() { adapter.dispose(); js.destroy(); socket.close(); peer.destroy(); engine.dispose(); assert.equal(socket.closed, true); } };
}
function pack(entries) {
  const e = encoding.createEncoder(); encoding.writeVarUint(e, entries.length);
  for (const [id, clock, state] of entries) { encoding.writeVarUint(e, id); encoding.writeVarUint(e, clock); encoding.writeVarString(e, JSON.stringify(state)); }
  return encoding.toUint8Array(e);
}
function unpack(bytes) {
  const d = decoding.createDecoder(bytes), entries = [];
  for (let n = decoding.readVarUint(d); n; n--) entries.push([decoding.readVarUint(d), decoding.readVarUint(d), JSON.parse(decoding.readVarString(d))]);
  assert.equal(d.pos, bytes.length); return entries;
}
function invalid(fn, code = 'invalid-cursor') { assert.throws(fn, e => e instanceof AwarenessError && e.code === code); }

check('Rust portable anchors roundtrip through JS relative-position oracle and awareness in both directions', async () => {
  const f = fixture();
  try {
    f.setLocal(3, 1); assert.equal(f.send(0), true);
    const bytes = f.socket.peer.receive(); awareness.applyAwarenessUpdate(f.js, bytes, 'prepared:rust');
    const value = f.js.getStates().get(f.adapter.clientId).selection;
    assert.equal(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.anchor.position), f.peer).index, 3);
    assert.equal(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.focus.position), f.peer).index, 1);
    const inbound = f.inbound({ selection: f.jsSelection(3, 1) });
    const [p] = f.adapter.peers(0); assert.equal(p.clientId, 404); assert.equal(p.selection.anchor.offset, 3); assert.equal(p.selection.focus.offset, 1);
    for (const [name, frame] of [['rust-awareness', bytes], ['js-awareness', inbound]]) {
      await writeFile(join(output, `${name}.bin`), frame); facts.frames.push({ name, bytes: frame.length, sha256: createHash('sha256').update(frame).digest('hex') });
    }
  } finally { f.close(); }
});
check('relative selections move under remote inserts and fail safely after semantic target deletion', () => {
  const f = fixture();
  try {
    f.inbound(); const adapter = new DirectSyncAdapter(f.engine, f.engine.read().identity);
    const before = Y.encodeStateVector(f.peer); f.peer.transact(() => f.text().insert(0, 'xx'), 'local:fixture');
    adapter.receive(packSync(Y.encodeStateAsUpdate(f.peer, before)));
    assert.equal(f.adapter.peers(1)[0].selection.anchor.offset, 3); assert.equal(f.adapter.peers(1)[0].selection.focus.offset, 5);
    const n = f.node(), vector = Y.encodeStateVector(f.peer);
    f.peer.transact(() => roots(f.peer)['delete-probe-tombstones'].set(n, true), 'local:delete-presence-target');
    adapter.receive(packSync(Y.encodeStateAsUpdate(f.peer, vector)));
    assert.equal(f.adapter.peers(2)[0].selection, null);
  } finally { f.close(); }
});
function packSync(update) { const e = encoding.createEncoder(); encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, update); return encoding.toUint8Array(e); }
check('stale peers expire exactly at deadline; duplicate/reordered clocks cannot resurrect or extend lifetime', () => {
  const f = fixture({ expiryMs: 200, throttleMs: 10 });
  try {
    const first = f.inbound(undefined, 0); f.adapter.receive(first, 100);
    assert.equal(f.adapter.peers(199).length, 1); assert.equal(f.adapter.expire(200), 1); assert.equal(f.adapter.peers(200).length, 0);
    f.adapter.receive(first, 201); assert.equal(f.adapter.peers(201).length, 0);
    f.inbound({ selection: null }, 202); assert.equal(f.adapter.peers(202).length, 1);
    f.adapter.receive(first, 203); assert.equal(f.adapter.peers(203)[0].selection, null);
    f.inbound(null, 204); assert.equal(f.adapter.peers(204).length, 0);
  } finally { f.close(); }
});
check('unknown zero-clock state is ignored and same-clock null removes a known peer as in the pinned oracle', () => {
  const f = fixture();
  try {
    const zero = pack([[405, 0, { selection: null }]]);
    f.adapter.receive(zero, 0); awareness.applyAwarenessUpdate(f.js, zero, 'prepared');
    assert.equal(f.adapter.peers(0).length, 0); assert.equal(f.js.getStates().has(405), false);
    const online = pack([[405, 1, { selection: null }]]), offline = pack([[405, 1, null]]);
    for (const bytes of [online, offline, online]) { f.adapter.receive(bytes, 1); awareness.applyAwarenessUpdate(f.js, bytes, 'prepared'); }
    assert.equal(f.adapter.peers(1).length, 0); assert.equal(f.js.getStates().has(405), false);
  } finally { f.close(); }
});
check('burst coalescing, backpressure and thrown sends retain one bounded pending state', () => {
  const f = fixture();
  try {
    let attempts = 0; for (let i = 0; i < 2000; i++) f.setLocal(i % 2 ? 3 : 1, 4);
    assert.equal(f.adapter.flush(() => { attempts++; return false; }, 0), false);
    for (let t = 1; t < 50; t++) assert.equal(f.adapter.flush(() => { attempts++; return true; }, t), false);
    assert.equal(attempts, 1); assert.throws(() => f.adapter.flush(() => { attempts++; throw Error('prepared failure'); }, 50), /prepared failure/);
    assert.equal(f.send(99), false); assert.equal(f.send(100), true);
    const [[, clock, state]] = unpack(f.socket.peer.receive()); assert.equal(clock, 2000); assert.equal(state.selection.anchor.position.assoc, -1);
    assert.equal(f.send(150), false); assert.equal(attempts, 2);
  } finally { f.close(); }
});
check('host-driven renewal and clear presence use compatible clocks without idle traffic', () => {
  const f = fixture({ expiryMs: 200, throttleMs: 10 });
  try {
    assert.equal(f.send(0), false); f.adapter.setLocal(null); assert.equal(f.send(1), true);
    assert.equal(unpack(f.socket.peer.receive())[0][2].selection, null);
    assert.equal(f.send(100), false); assert.equal(f.send(101), true); assert.equal(unpack(f.socket.peer.receive())[0][1], 2);
    f.adapter.clearLocal(); assert.equal(f.send(111), true); assert.equal(unpack(f.socket.peer.receive())[0][2], null); assert.equal(f.send(1000), false);
  } finally { f.close(); }
});
check('invalid, surrogate-interior, wrong-lineage and wrong-source cursors fail atomically', () => {
  const f = fixture();
  try {
    f.inbound(); const before = f.adapter.peers(0);
    const cases = [f.jsSelection(2), ...['epoch', 'documentId', 'schema'].map(key => {
      const s = f.jsSelection(); s.anchor.identity[key] = key === 'schema' ? 'wrong' : '00000000-0000-4000-8000-000000000000'; return s;
    }), ...['source', 'sourceIdentity'].map(key => { const s = f.jsSelection(); s.focus[key] = 'missing'; return s; }),
    (() => { const s = f.jsSelection(); s.focus.position = { item: { client: 888, clock: 999 }, assoc: 0 }; return s; })(),
    (() => { const s = f.jsSelection(); s.focus.position.assoc = 7; return s; })(),
    (() => { const s = f.jsSelection(); s.focus.position.extra = true; return s; })()];
    for (const selection of cases) {
      invalid(() => f.adapter.receive(pack([[405, 1, { selection: f.jsSelection() }], [404, 999, { selection }]]), 1));
      assert.deepEqual(f.adapter.peers(1), before);
    }
    invalid(() => f.adapter.receive(pack([[404, 999, { selection: 'offset' }]]), 1));
  } finally { f.close(); }
});
check('malformed UTF-8/JSON, oversized, truncated, noncanonical and duplicate frames do not change peers', () => {
  const f = fixture({ maxFrameBytes: 8192 });
  try {
    f.inbound(); const before = f.adapter.peers(0), valid = pack([[405, 1, { selection: null }]]);
    const malformed = [new Uint8Array(), Uint8Array.of(128, 0), Uint8Array.of(255, 255, 255, 255, 255, 1),
      valid.slice(0, -1), Uint8Array.from([...valid, 0]), pack([[405, 1, null], [405, 2, null]]),
      Uint8Array.of(1, 10, 1, 1, 255), Uint8Array.of(1, 10, 1, 1, 123)];
    for (const bytes of malformed) { invalid(() => f.adapter.receive(bytes, 1), 'invalid-frame'); assert.deepEqual(f.adapter.peers(1), before); }
    invalid(() => f.adapter.receive(new Uint8Array(8193), 1), 'resource-limit');
    invalid(() => f.adapter.receive(Uint8Array.of(65), 1), 'resource-limit');
  } finally { f.close(); }
});
check('capacity includes expired tombstones; untrusted remote frames cannot remove local presence', () => {
  const f = fixture({ maxPeers: 1, expiryMs: 200, throttleMs: 10 });
  try {
    f.inbound(); f.setLocal(); f.adapter.receive(pack([[f.adapter.clientId, 0xffffffff, null]]), 0); assert.equal(f.send(0), true);
    f.adapter.expire(200); invalid(() => f.adapter.receive(pack([[405, 1, { selection: null }]]), 201), 'resource-limit');
    assert.equal(f.adapter.peers(201).length, 0); f.inbound({ selection: null }, 202); assert.equal(f.adapter.peers(202).length, 1);
  } finally { f.close(); }
});
check('replacement, expiry, invalid batch and disposal release every imported anchor', () => {
  const f = fixture({ expiryMs: 200, throttleMs: 10 }); let imported = 0, released = 0;
  const port = { exportAnchor: a => f.engine.exportAnchor(a), resolve: a => f.engine.resolve(a),
    importAnchor: a => { const token = f.engine.importAnchor(a); imported++; return token; },
    releaseAnchor: a => { released++; f.engine.releaseAnchor(a); } };
  const adapter = new AwarenessAdapter(port, 999, { expiryMs: 200, throttleMs: 10 });
  try {
    adapter.receive(pack([[404, 1, { selection: f.jsSelection() }]]), 0);
    adapter.receive(pack([[404, 2, { selection: f.jsSelection() }]]), 1); assert.equal(released, 2);
    const bad = f.jsSelection(); bad.focus.source = 'missing';
    invalid(() => adapter.receive(pack([[405, 1, { selection: bad }]]), 2)); assert.equal(imported - released, 2);
    adapter.expire(201); assert.equal(imported, released);
    adapter.receive(pack([[404, 3, { selection: f.jsSelection() }]]), 202); adapter.dispose(); adapter.dispose(); assert.equal(imported, released);
    invalid(() => adapter.peers(202), 'disposed');
  } finally { adapter.dispose(); f.close(); }
});
check('reentrant send cannot erase a newer queued state or undo disposal', () => {
  const f = fixture();
  try {
    f.setLocal(); assert.equal(f.adapter.flush(() => { f.adapter.clearLocal(); return true; }, 0), true);
    assert.equal(f.send(50), true); assert.equal(unpack(f.socket.peer.receive())[0][2], null);
    f.setLocal(); assert.equal(f.adapter.flush(() => { f.adapter.dispose(); return true; }, 100), true);
    invalid(() => f.send(150), 'disposed');
  } finally { f.close(); }
});
check('awareness traffic never changes actual Rust state/history/update stream or durable journal/outbox', async () => {
  const f = fixture(), db = new CheckpointIndexedDB(), journal = await UpdateJournal.open(db), outbox = await UpdateOutbox.open(db);
  const patches = [], sub = f.engine.subscribe({ type: 'updates' }, p => patches.push(p));
  try {
    const at = f.engine.anchor(f.node(), 3, 'right');
    f.engine.commit(f.engine.prepare({ kind: 'text', origin: 'local:presence-fixture', command: { type: 'insert', at, text: 'X' } })); f.engine.releaseAnchor(at);
    const patch = patches.at(-1), pending = journal.append({ identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin: patch.origin, bytes: patch.update.bytes });
    const tx = await db.nextWrite(); await new Promise(resolve => setImmediate(resolve)); tx.complete(); await pending;
    Y.applyUpdate(f.peer, patch.update.bytes, 'remote');
    f.engine.read(); // Drain the prior local command's one-shot changed-node/range hints.
    const before = { checkpoint: f.engine.checkpoint().bytes, read: f.engine.read(), vector: f.engine.stateVector(), history: f.engine.history({ type: 'state' }),
      updates: patches.length, stored: structuredClone([...db.stores.updates]), pending: await outbox.pending(patch.identity), writes: db.transactions.length };
    for (let i = 0; i < 100; i++) { f.setLocal(); f.send(i * 50); while (f.socket.peer.pending) awareness.applyAwarenessUpdate(f.js, f.socket.peer.receive(), 'prepared'); f.inbound(undefined, i * 50); }
    f.inbound(null, 5000); f.adapter.expire(40_000); f.adapter.dispose();
    assert.deepEqual(f.engine.checkpoint().bytes, before.checkpoint); assert.deepEqual(f.engine.read(), before.read); assert.deepEqual(f.engine.stateVector(), before.vector); assert.deepEqual(f.engine.history({ type: 'state' }), before.history);
    assert.equal(patches.length, before.updates); assert.deepEqual([...db.stores.updates], before.stored);
    assert.equal(db.transactions.length, before.writes); assert.deepEqual(await outbox.pending(patch.identity), before.pending);
  } finally { sub.dispose(); journal.close(); outbox.close(); f.close(); }
});
check('invalid options/time and oversize local presence fail without discarding valid state', () => {
  const f = fixture();
  try {
    for (const options of [{ maxPeers: 0 }, { maxFrameBytes: 100000 }, { throttleMs: 0 }, { expiryMs: 1 }]) invalid(() => new AwarenessAdapter(f.engine, 1, options), 'resource-limit');
    invalid(() => new AwarenessAdapter(f.engine, -1), 'resource-limit');
    f.send(5); invalid(() => f.send(4), 'invalid-frame'); invalid(() => f.send(NaN), 'invalid-frame');
    const tiny = new AwarenessAdapter(f.engine, 777, { maxFrameBytes: 16 });
    const a = f.engine.anchor(f.node(), 1, 'left');
    try { invalid(() => tiny.setLocal({ anchor: a, focus: a }), 'resource-limit'); assert.equal(tiny.flush(() => true, 0), false); }
    finally { f.engine.releaseAnchor(a); tiny.dispose(); }
  } finally { f.close(); }
});
