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
import { SyncSession } from '../packages/web/dist/sync/session.js';
import { UpdateJournal } from '../packages/web/dist/storage/journal.js';
import { UpdateOutbox } from '../packages/web/dist/storage/outbox.js';
import { CheckpointIndexedDB } from './helpers/checkpoint-storage.mjs';
import { preparedSocketPair } from './helpers/prepared-socket.mjs';
import { replica, roots, snapshot } from '../fixtures/schema-v5/mapping.mjs';

const explicitOutput = process.env.EDITAC_RECONNECT_OUTPUT;
const output = explicitOutput ?? await mkdtemp(join(tmpdir(), 'editac-reconnect-'));
await mkdir(output, { recursive: true });
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
const facts = { boundary: 'Real Rust WASM engine-v5, pinned same-schema JS peer, actual journal/outbox adapters; prepared IndexedDB transactions and copied socket frames; no network or credentials',
  wasmSha256: createHash('sha256').update(wasm).digest('hex'), cases: [], traces: [] };
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
after(async () => {
  await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
  if (!explicitOutput && facts.cases.every(c => c.passed)) await rm(output, { recursive: true, force: true });
  else if (!explicitOutput) console.log(`Preserved reconnect evidence: ${output}`);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const oracle = write => { const e = encoding.createEncoder(); write(e); return encoding.toUint8Array(e); };
let fixtureId = 0;
async function fixture(options = {}, portOptions = {}) {
  const engine = runtime.createEngine({ profile: 'v5', documentId: `${String(++fixtureId).padStart(8, '0')}-4567-4567-8567-45678901abcd`,
    epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀b e\u0301👩\u200d💻' }, { text: 'second' }] });
  const initial = engine.checkpoint(), peer = replica(404 + fixtureId), db = new CheckpointIndexedDB();
  Y.applyUpdate(peer, initial.bytes, 'restore');
  const journal = await UpdateJournal.open(db), outbox = await UpdateOutbox.open(db);
  let admissions = 0;
  const session = new SyncSession({ ...engine, applyUpdate(update) { admissions++; return engine.applyUpdate(update); } }, outbox, options), socket = preparedSocketPair(portOptions);
  const patches = [], local = [], transmitted = [], refused = [];
  const sub = engine.subscribe({ type: 'updates' }, p => { patches.push(p); if (p.update && p.origin.startsWith('editac:local:')) local.push(p); });
  let blocked = false, throws = false;
  const transport = { send(frame) {
    if (throws) throw new Error('Prepared disconnect');
    if (blocked) { refused.push(frame); return false; }
    try { socket.client.send(frame); } catch (error) { if (error instanceof RangeError) { refused.push(frame); return false; } throw error; }
    transmitted.push(frame); return true;
  } };
  async function persist(patch, origin = patch.origin) {
    const promise = journal.append({ identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin, bytes: patch.update.bytes });
    const tx = await db.nextWrite(); await tick(); tx.complete();
    const receipt = await promise; assert.equal(receipt.state, 'localCommitted'); session.localCommitted(origin); return receipt;
  }
  async function insert(word) {
    const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
    try { engine.commit(engine.prepare({ kind: 'text', origin: 'local:reconnect-fixture', command: { type: 'insert', at, text: word } })); }
    finally { engine.releaseAnchor(at); }
    await persist(local.at(-1));
  }
  function jsInsert(word) {
    const before = Y.encodeStateVector(peer), text = roots(peer)['registry-texts'].get(engine.read().visible[0].spans[0].source);
    peer.transact(() => { text.insert(3, word); text.format(3, word.length, { italic: true }); }, 'local:fixture');
    return oracle(e => sync.writeUpdate(e, Y.encodeStateAsUpdate(peer, before)));
  }
  function jsDrain(shuffle = false, duplicate = false) {
    while (socket.peer.pending) {
      const frame = socket.peer.receive(shuffle ? socket.peer.pending - 1 : 0);
      for (let n = 0; n < (duplicate ? 2 : 1); n++) {
        const decoder = decoding.createDecoder(frame), reply = encoding.createEncoder();
        sync.readSyncMessage(decoder, reply, peer, 'remote', e => { throw e; }); assert.equal(decoder.pos, frame.length);
        const bytes = encoding.toUint8Array(reply); if (bytes.length) socket.peer.send(bytes);
      }
    }
    while (socket.client.pending) session.receive(socket.client.receive(shuffle ? socket.client.pending - 1 : 0));
  }
  async function drain(start = 0, shuffle = false, duplicate = false) {
    for (let i = 0; i < 500; i++) {
      await session.pump(start + i * 1000); jsDrain(shuffle, duplicate);
      const s = session.state;
      assert.ok(s.incomingFrames <= (options.maxQueuedFrames ?? 32)); assert.ok(s.outgoingFrames <= (options.maxQueuedFrames ?? 32));
      assert.ok(s.incomingBytes <= (options.maxQueuedBytes ?? 32 * 1024 * 1024));
      assert.ok(s.outgoingBytes <= (options.maxQueuedBytes ?? 32 * 1024 * 1024));
      if (!s.replayPending && !s.incomingFrames && !s.outgoingFrames && !socket.peer.pending && !socket.client.pending) return;
    }
    assert.fail('Prepared session failed to quiesce within 500 bounded pumps');
  }
  function converged() {
    const mirror = replica(9000 + fixtureId);
    try { Y.applyUpdate(mirror, engine.encodeUpdate().bytes); assert.deepEqual(snapshot(mirror), snapshot(peer)); }
    finally { mirror.destroy(); }
    assert.deepEqual([...Y.decodeStateVector(engine.stateVector())].sort(), [...Y.decodeStateVector(Y.encodeStateVector(peer))].sort());
  }
  return { engine, initial, peer, db, journal, outbox, session, socket, patches, local, transmitted, refused, transport,
    insert, jsInsert, persist, drain, jsDrain, converged, admissions() { return admissions; }, block(value) { blocked = value; }, throwSend(value) { throws = value; },
    attach(authorized = true) { session.attach(transport, initial.identity, authorized); },
    close() { session.dispose(); sub.dispose(); socket.close(); peer.destroy(); journal.close(); outbox.close(); engine.dispose(); assert.equal(socket.closed, true); }
  };
}

check('detached and unauthorized local edits remain recoverable; attachment preserves stable anchors and history', async () => {
  const f = await fixture();
  try {
    await f.insert('OFF');
    const anchor = f.engine.anchor(f.engine.read().visible[0].id, 3, 'right');
    const history = f.engine.history({ type: 'state' }), position = f.engine.resolve(anchor), bytes = f.engine.checkpoint().bytes;
    f.attach(false); await f.session.pump(0);
    assert.equal(f.session.state.phase, 'unauthorized'); assert.equal(f.transmitted.length, 0);
    assert.throws(() => f.session.receive(new Uint8Array([0,1,0])), { code: 'unauthorized' });
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 1);
    f.attach(); assert.deepEqual(f.engine.checkpoint().bytes, bytes); assert.deepEqual(f.engine.resolve(anchor), position);
    assert.deepEqual(f.engine.history({ type: 'state' }), history); await f.drain(); f.converged();
    f.session.detach(); await f.insert('MORE'); assert.equal(f.session.state.phase, 'detached');
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 2); f.engine.releaseAnchor(anchor);
  } finally { f.close(); }
});

check('disconnect and authorized reconnect replay all local bytes through shuffled duplicate messages without echo', async () => {
  const f = await fixture();
  try {
    f.attach(); await f.drain(); await f.insert('R1'); await f.drain();
    f.session.detach(); f.socket.disconnect(); await f.insert('R2'); await f.insert('😀R3');
    const remote = f.jsInsert('J1'); f.jsInsert('J2');
    const history = f.engine.history({ type: 'state' });
    f.socket.reconnect(); f.attach(); f.socket.peer.send(remote); f.socket.peer.send(remote);
    await f.drain(100, true, true); f.converged();
    assert.equal(f.engine.history({ type: 'state' }).undoGroups, history.undoGroups);
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 3, 'socket/handshake cannot prune durable pending identities');
    const count = f.transmitted.length; for (let i = 0; i < 10; i++) await f.session.pump(900000 + i);
    assert.equal(f.transmitted.length, count, 'remote patches and replay do not trigger echo work');
    facts.traces.push({ scenario: 'disconnect/shuffle/duplicate', sent: count, remotePatches: f.patches.filter(p => p.origin === 'remote').length, pendingLocal: 3 });
  } finally { f.close(); }
});

check('saturated prepared socket pauses bounded send replay and drops no committed local updates', async () => {
  const f = await fixture({ maxQueuedFrames: 2, maxQueuedBytes: 2048, maxFrameBytes: 2048, maxWorkPerPump: 6 }, { maxQueuedFrames: 1 });
  try {
    for (let i = 0; i < 20; i++) await f.insert(`R${i}`);
    f.attach(); await f.session.pump(0); assert.ok(f.refused.length > 0);
    assert.equal(f.session.state.outgoingFrames, 1); assert.ok(f.session.state.retryAt > 0);
    for (let i = 0; i < 10; i++) await f.session.pump(0); assert.equal(f.refused.length, 1);
    await f.drain(100, true); f.converged();
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 20);
    assert.equal(f.transmitted.filter(frame => frame[0] === 2).length, 20);
    facts.traces.push({ scenario: 'backpressure', committed: 20, sentUpdates: 20, refusals: f.refused.length, queueBound: 2, byteBound: 2048 });
  } finally { f.close(); }
});

check('bounded exponential retry exhaustion detaches; explicit reconnect recovers without losing edits', async () => {
  const f = await fixture({ retryBaseMs: 10, retryMaxMs: 15, maxRetries: 2 });
  try {
    await f.insert('RETRY'); f.block(true); f.attach(); await f.session.pump(0);
    assert.equal(f.session.state.retryAt, 10); await f.session.pump(9); assert.equal(f.refused.length, 1);
    await f.session.pump(10); assert.equal(f.session.state.retryAt, 25);
    await assert.rejects(f.session.pump(25), { code: 'retry-exhausted' });
    assert.equal(f.session.state.phase, 'error'); assert.equal(f.session.state.outgoingFrames, 0);
    await f.insert('OFFLINE'); assert.equal((await f.outbox.pending(f.initial.identity)).length, 2);
    f.block(false); f.attach(); await f.drain(100); f.converged();
  } finally { f.close(); }
});

check('receive frame/count/byte bounds reject before mutation and require a recoverable reconnect', async () => {
  for (const kind of ['count', 'bytes', 'frame']) {
    const f = await fixture({ maxQueuedFrames: kind === 'bytes' ? 2 : 1, maxFrameBytes: 2048, maxQueuedBytes: 2048 });
    try {
      f.attach(); const before = f.engine.checkpoint().bytes;
      if (kind === 'count') f.session.receive(new Uint8Array([0,1,0]));
      if (kind === 'bytes') f.session.receive(new Uint8Array(2048));
      assert.throws(() => f.session.receive(new Uint8Array(kind === 'frame' ? 2049 : 3)), { code: 'queue-limit' });
      assert.equal(f.session.state.phase, 'error'); assert.equal(f.session.state.incomingBytes, 0);
      assert.deepEqual(f.engine.checkpoint().bytes, before); await f.insert('SAFE');
      f.attach(); await f.drain(); f.converged();
    } finally { f.close(); }
  }
});

check('remote, restore and replay journal origins never become outbound update messages', async () => {
  const f = await fixture();
  try {
    await f.insert('LOCAL'); f.attach(); await f.drain();
    const frame = f.jsInsert('REMOTE'); f.session.receive(frame); await f.session.pump(0);
    const remote = f.patches.findLast(p => p.origin === 'remote'); assert.ok(remote?.update);
    await f.persist(remote);
    await f.persist({ ...remote, sequence: remote.sequence + 1 }, 'restore');
    await f.persist({ ...remote, sequence: remote.sequence + 2 }, 'replay');
    const sent = f.transmitted.length; await f.session.pump(1); assert.equal(f.transmitted.length, sent);
    f.session.detach(); f.attach(); await f.drain(100); f.converged();
    assert.equal(f.transmitted.filter(frame => frame[0] === 2).length, 2, 'only the local entry is resent on reconnect');
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 4);
  } finally { f.close(); }
});

check('generation fence prevents a delayed old outbox read from sending on a replacement attachment', async () => {
  const f = await fixture(); let resolve;
  const delayed = new SyncSession(f.engine, { pendingPage: () => new Promise(r => { resolve = r; }) });
  try {
    await f.insert('ASYNC'); const entries = await f.outbox.pending(f.initial.identity);
    delayed.attach(f.transport, f.initial.identity, true); const old = delayed.pump(0);
    await tick(); assert.ok(resolve); const first = resolve;
    delayed.detach(); delayed.attach(f.transport, f.initial.identity, false);
    first({ entries, after: null, done: true }); await old; assert.equal(f.transmitted.length, 1, 'only old handshake was sent');
    assert.equal(delayed.state.phase, 'unauthorized'); assert.equal(delayed.state.outgoingFrames, 0);
    await delayed.pump(100); assert.equal(f.transmitted.length, 1);
  } finally { delayed.dispose(); f.close(); }
});

check('local commit during a replay read gets a second pass and concurrent pumps share bounded work', async () => {
  const f = await fixture(); let resolve, reads = 0, entered;
  const readStarted = new Promise(r => { entered = r; });
  const delayed = new SyncSession(f.engine, { pendingPage: async (...args) => { reads++; const page = await f.outbox.pendingPage(...args);
    if (reads === 1) await new Promise(r => { resolve = r; entered(); }); return page; } }, { maxWorkPerPump: 2 });
  try {
    await f.insert('OLD'); delayed.attach(f.transport, f.initial.identity, true);
    const first = delayed.pump(0); assert.equal(delayed.pump(0), first);
    // Checksum verification is asynchronous; one setImmediate is not its completion signal.
    let timeout;
    try { await Promise.race([readStarted, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Replay read did not reach prepared barrier')), 5000); })]); }
    finally { clearTimeout(timeout); }
    assert.ok(resolve);
    await f.insert('NEW'); delayed.localCommitted(f.local.at(-1).origin); resolve(); await first;
    for (let i = 0; i < 20 && (delayed.state.replayPending || delayed.state.outgoingFrames); i++) {
      assert.ok(i < 20); await delayed.pump(i + 1);
      while (f.socket.peer.pending) {
        const decoder = decoding.createDecoder(f.socket.peer.receive()), reply = encoding.createEncoder();
        sync.readSyncMessage(decoder, reply, f.peer, 'remote');
      }
    }
    f.converged(); assert.equal(reads, 2); assert.equal((await f.outbox.pending(f.initial.identity)).length, 2);
  } finally { delayed.dispose(); f.close(); }
});

check('transport failure and malformed frames expose errors while local recovery and history remain intact', async () => {
  const f = await fixture();
  try {
    await f.insert('KEEP'); const before = f.engine.checkpoint().bytes;
    f.attach(); f.throwSend(true); await assert.rejects(f.session.pump(0), /Prepared disconnect/);
    assert.equal(f.session.state.phase, 'error'); assert.deepEqual(f.engine.checkpoint().bytes, before);
    f.throwSend(false); f.attach(); f.session.receive(new Uint8Array([3,1,0]));
    await assert.rejects(f.session.pump(1), { code: 'invalid-frame' }); assert.deepEqual(f.engine.checkpoint().bytes, before);
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 1);
    f.attach(); await f.drain(100); f.converged();
    assert.throws(() => f.session.attach(f.transport, { ...f.initial.identity, epoch: f.initial.identity.documentId }, true), { code: 'wrong-epoch' });
    assert.equal(f.session.state.phase, 'attached');
  } finally { f.close(); }
});

check('offline undo and redo updates replay as local edits and preserve selective history across attachments', async () => {
  const f = await fixture();
  try {
    await f.insert('UNDO'); f.attach(); await f.drain(); f.converged(); f.session.detach();
    f.engine.history({ type: 'undo' }); const undo = f.patches.at(-1);
    assert.equal(undo.origin, 'history:undo'); await f.persist(undo);
    const history = f.engine.history({ type: 'state' }); f.attach(); await f.drain(100); f.converged();
    assert.equal(f.engine.history({ type: 'state' }).redoGroups, history.redoGroups);
    assert.equal(f.engine.read().visible[0].runs.map(r => r.text).join(''), 'a😀b e\u0301👩\u200d💻');
    f.session.detach(); f.engine.history({ type: 'redo' }); const redo = f.patches.at(-1);
    assert.equal(redo.origin, 'history:redo'); await f.persist(redo); f.attach(); await f.drain(200); f.converged();
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 3);
    assert.ok(f.transmitted.filter(frame => frame[0] === 2).length >= 6);
  } finally { f.close(); }
});

check('synchronous detach during a refusing send cannot schedule retries on the replacement session', async () => {
  const f = await fixture();
  try {
    await f.insert('RACE');
    f.session.attach({ send() { f.session.detach(); f.attach(false); return false; } }, f.initial.identity, true);
    await f.session.pump(0);
    assert.equal(f.session.state.phase, 'unauthorized'); assert.equal(f.session.state.retryAt, null);
    assert.equal(f.session.state.retries, 0); assert.equal(f.transmitted.length, 0);
    f.attach(); await f.drain(100); f.converged();
  } finally { f.close(); }
});

check('Rust receiver reconciles reverse causal deltas and duplicates across bounded pumps without idle retry or echo', async () => {
  const f = await fixture({ maxWorkPerPump: 1 });
  try {
    f.attach(); await f.drain(); await f.insert('LOCAL'); await f.drain();
    const first = f.jsInsert('FIRST'), second = f.jsInsert('SECOND'), third = f.jsInsert('THIRD');
    const before = f.engine.checkpoint().bytes, history = f.engine.history({ type: 'state' }), sent = f.transmitted.length;
    f.session.receive(third); await f.session.pump(0);
    assert.equal(f.session.state.phase, 'attached'); assert.equal(f.session.state.incompleteFrames, 1);
    assert.equal(f.session.state.incomingBytes, third.length); assert.deepEqual(f.engine.checkpoint().bytes, before);
    const attempts = f.admissions();
    for (let i = 0; i < 10; i++) await f.session.pump(i);
    assert.equal(f.admissions(), attempts, 'idle host pumps must not repeat rejected admission');
    assert.equal(f.session.state.retryAt, null); assert.equal(f.transmitted.length, sent);
    third.fill(255); // Admission owns a copy, including retained incomplete bytes.
    f.session.receive(oracle(e => sync.writeUpdate(e, Y.encodeStateAsUpdate(f.peer, Y.encodeStateVector(f.peer)))));
    await f.session.pump(11); assert.equal(f.admissions(), attempts + 1, 'empty duplicate cannot trigger retry');
    f.session.receive(second); f.session.receive(second); f.session.receive(first);
    await f.drain(20); f.converged();
    assert.equal(f.session.state.incompleteFrames, 0); assert.equal(f.session.state.incomingBytes, 0);
    assert.equal(f.engine.history({ type: 'state' }).undoGroups, history.undoGroups);
    assert.equal(f.transmitted.length, sent, 'reconciled remote updates must not echo');
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 1);
    facts.traces.push({ scenario: 'reverse-causal/duplicate', admissions: f.admissions(), maxWorkPerPump: 1, pendingLocal: 1 });
  } finally { f.close(); }
});

check('Rust incomplete deltas recover through a step2 handshake without duplicate revisions', async () => {
  const f = await fixture();
  try {
    f.attach(); await f.drain(); f.jsInsert('MISSING'); const dependent = f.jsInsert('LATER');
    f.session.receive(dependent); await f.session.pump(0);
    assert.equal(f.session.state.incompleteFrames, 1);
    const full = oracle(e => sync.writeSyncStep2(e, f.peer));
    f.session.receive(full); await f.drain(1); f.converged();
    assert.equal(f.session.state.incompleteFrames, 0);
    const revision = f.engine.read().revision;
    f.session.receive(full); f.session.receive(dependent); await f.drain(2);
    assert.equal(f.engine.read().revision, revision, 'already-covered deltas are idempotent');
  } finally { f.close(); }
});

check('retained incomplete deltas share receive count and byte budgets; overflow preserves offline edits', async () => {
  for (const kind of ['count', 'bytes']) {
    const f = await fixture({ maxQueuedFrames: kind === 'count' ? 1 : 32, maxQueuedBytes: 2048, maxFrameBytes: 2048 });
    try {
      f.attach(); await f.drain(); await f.insert('KEEP'); await f.drain();
      f.jsInsert('PREDECESSOR'); const dependent = f.jsInsert('DEPENDENT');
      f.session.receive(dependent); await f.session.pump(0);
      assert.equal(f.session.state.incompleteFrames, 1);
      const before = f.engine.checkpoint().bytes;
      assert.throws(() => f.session.receive(kind === 'count' ? dependent : new Uint8Array(2048)), { code: 'queue-limit' });
      assert.equal(f.session.state.phase, 'error'); assert.equal(f.session.state.incomingFrames, 0);
      assert.equal(f.session.state.incompleteFrames, 0); assert.equal(f.session.state.incomingBytes, 0);
      assert.deepEqual(f.engine.checkpoint().bytes, before);
      await f.insert('OFFLINE'); assert.equal((await f.outbox.pending(f.initial.identity)).length, 2);
      f.attach(); await f.drain(); f.converged();
    } finally { f.close(); }
  }
});

check('incomplete buffering never masks malformed binary or envelope failures', async () => {
  for (const malformed of [new Uint8Array([3, 1, 0]), oracle(e => sync.writeUpdate(e, new Uint8Array([255])))]) {
    const f = await fixture();
    try {
      f.attach(); await f.drain(); f.jsInsert('MISSING'); f.session.receive(f.jsInsert('PENDING'));
      await f.session.pump(0); assert.equal(f.session.state.incompleteFrames, 1);
      const before = f.engine.checkpoint().bytes;
      f.session.receive(malformed); await assert.rejects(f.session.pump(1), error => error.code === 'invalid-frame'
        || (error.code === 'EngineRejected' && error.message === 'InvalidUpdate'));
      assert.equal(f.session.state.phase, 'error'); assert.equal(f.session.state.incomingBytes, 0);
      assert.deepEqual(f.engine.checkpoint().bytes, before); await f.insert('SAFE');
      f.attach(); await f.drain(2); f.converged();
    } finally { f.close(); }
  }
});

check('detach releases incomplete receive buffers and authorized reconnect recovers missing remote and retained local edits', async () => {
  const f = await fixture();
  try {
    f.attach(); await f.drain(); f.jsInsert('MISSING'); f.session.receive(f.jsInsert('PENDING')); await f.session.pump(0);
    assert.equal(f.session.state.incompleteFrames, 1); f.session.detach();
    assert.equal(f.session.state.incomingBytes, 0); assert.equal(f.session.state.incompleteFrames, 0);
    await f.insert('OFFLINE'); f.attach(false); await f.session.pump(1);
    assert.equal(f.session.state.phase, 'unauthorized'); assert.equal((await f.outbox.pending(f.initial.identity)).length, 1);
    f.attach(); await f.drain(2); f.converged();
  } finally { f.close(); }
});

check('frozen SYN-1.7 browser delta corpus converges at the real Rust receiver after predecessor replay', async () => {
  const url = new URL('./fixtures/causal-replay/', import.meta.url);
  const spec = JSON.parse(await readFile(new URL('fixture.json', url), 'utf8'));
  const files = {};
  for (const [name, hash] of Object.entries(spec.hashes)) {
    files[name] = new Uint8Array(await readFile(new URL(name, url)));
    assert.equal(createHash('sha256').update(files[name]).digest('hex'), hash);
  }
  const baseline = replica(70000); Y.applyUpdate(baseline, files['initial.bin']);
  const [writerId] = Y.decodeStateVector(Y.encodeStateVector(baseline)).keys(); baseline.destroy();
  const engine = runtime.restoreEngine(spec.identity, { identity: spec.identity, initialized: true, writerId, bytes: files['initial.bin'] });
  const peer = replica(70001), frames = [], session = new SyncSession(engine, { pendingPage: async () => ({ entries: [], after: null, done: true }) });
  try {
    Y.applyUpdate(peer, files['initial.bin']);
    for (const name of ['frame-13.bin', 'frame-12.bin']) {
      const reply = encoding.createEncoder(); sync.readSyncMessage(decoding.createDecoder(files[name]), reply, peer, 'remote');
    }
    session.attach({ send(frame) { frames.push(frame); return true; } }, spec.identity, true);
    const before = engine.checkpoint().bytes;
    session.receive(files['frame-12.bin']); await session.pump(0);
    assert.equal(session.state.incompleteFrames, 1); assert.deepEqual(engine.checkpoint().bytes, before);
    session.receive(files['frame-13.bin']); session.receive(files['frame-12.bin']); await session.pump(1);
    assert.equal(session.state.incomingFrames, 0); assert.equal(session.state.phase, 'attached');
    const mirror = replica(70002);
    try { Y.applyUpdate(mirror, engine.encodeUpdate().bytes); assert.deepEqual(snapshot(mirror), snapshot(peer)); }
    finally { mirror.destroy(); }
    assert.deepEqual([...Y.decodeStateVector(engine.stateVector())].sort(), [...Y.decodeStateVector(Y.encodeStateVector(peer))].sort());
    assert.equal(frames.length, 1, 'only attachment step1 is outbound');
    facts.traces.push({ scenario: 'frozen-SYN-1.7-corpus', hashes: spec.hashes, browserWriter: 3685986909, expectedClock: 2 });
  } finally { session.dispose(); peer.destroy(); engine.dispose(); }
});

check('delete-before-insert reconciliation remains atomic and local revisions permit one bounded retry', async () => {
  const f = await fixture();
  try {
    f.attach(); await f.drain();
    const predecessor = f.jsInsert('ERASE'), vector = Y.encodeStateVector(f.peer);
    const text = roots(f.peer)['registry-texts'].get(f.engine.read().visible[0].spans[0].source);
    f.peer.transact(() => text.delete(3, 5), 'local:delete-fixture');
    const deletion = oracle(e => sync.writeUpdate(e, Y.encodeStateAsUpdate(f.peer, vector)));
    const before = f.engine.checkpoint().bytes;
    f.session.receive(deletion); await f.session.pump(0);
    assert.equal(f.session.state.incompleteFrames, 1); assert.deepEqual(f.engine.checkpoint().bytes, before);
    const attempts = f.admissions(); await f.insert('LOCAL'); await f.session.pump(1);
    assert.equal(f.admissions(), attempts + 1, 'local progress permits one retry against the changed replica');
    await f.session.pump(2); assert.equal(f.admissions(), attempts + 1, 'unchanged pending delete must not spin');
    f.session.receive(predecessor); await f.drain(3); f.converged();
    assert.equal(f.session.state.incompleteFrames, 0); assert.equal(f.session.state.incomingBytes, 0);
    assert.equal((await f.outbox.pending(f.initial.identity)).length, 1);
    assert.equal(f.transmitted.filter(frame => frame[0] === 2).length, 1, 'only the committed local update is sent');
  } finally { f.close(); }
});

check('remote patch observers can replace attachment during reconciliation without corrupting new queues', async () => {
  const f = await fixture(); let subscription;
  try {
    f.attach(); await f.drain(); const predecessor = f.jsInsert('FIRST'); f.session.receive(f.jsInsert('SECOND'));
    await f.session.pump(0); assert.equal(f.session.state.incompleteFrames, 1);
    let remotes = 0;
    subscription = f.engine.subscribe({ type: 'updates' }, patch => {
      if (patch.origin === 'remote' && ++remotes === 2) { f.session.detach(); f.attach(); }
    });
    f.session.receive(predecessor); await f.session.pump(1);
    assert.equal(remotes, 2, 'replacement occurs while the retained dependent delta is admitted');
    assert.equal(f.session.state.phase, 'attached'); assert.equal(f.session.state.incomingBytes, 0);
    assert.equal(f.session.state.incompleteFrames, 0); assert.equal(f.session.state.outgoingFrames, 1, 'replacement handshake survives');
    await f.drain(2); f.converged();
  } finally { subscription?.dispose(); f.close(); }
});
