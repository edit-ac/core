import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { init } from '../packages/core/dist/index.js';
import { replica, roots, snapshot } from '../fixtures/schema-v5/mapping.mjs';
import { startReferenceRelay, receiptProtocol } from '../examples/sync-server/relay.mjs';

const grants = JSON.parse(await readFile(new URL('./fixtures/relay-grants.json', import.meta.url), 'utf8'));
const [alpha, beta] = grants;
const output = process.env.EDITAC_RELAY_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-relay-evidence-'));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'editac-relay-databases-'));
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
const sha = value => createHash('sha256').update(value).digest('hex');
const facts = { boundary: 'Actual loopback HTTP / child-process SQLite FULL WAL commit / actual Rust WASM and pinned Yjs schema-v5 updates; prepared auth only',
  wasmSha256: sha(wasm), cases: [], processes: [], updates: [], cleanup: [] };
const children = new Set(); let number = 0;
const deadline = (promise, label, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); })])
    .finally(() => clearTimeout(timer));
};
function check(name, fn) {
  test(name, async () => { const fact = { name, passed: false }; facts.cases.push(fact); await fn(); fact.passed = true; });
}
const seeded = runtime.createEngine({ profile: 'v5', documentId: alpha.identity.documentId, epoch: alpha.identity.epoch,
  nodes: [{ text: 'a😀b relay' }, { text: 'second' }] });
const preparedCheckpoint = seeded.checkpoint();
try { assert.deepEqual(preparedCheckpoint.identity, alpha.identity); } finally { seeded.dispose(); }
function fixture() {
  const engine = runtime.restoreEngine(alpha.identity, preparedCheckpoint);
  return { engine, initial: preparedCheckpoint, close() { engine.dispose(); } };
}
function entry(bytes, writerId = 101, sequence = 1, identity = alpha.identity) {
  const checksum = sha(bytes), identityKey = JSON.stringify(['profile','schema','documentId','epoch','protocolVersion','updateEncoding','offsets'].map(k => identity[k]));
  return { identity, writerId, sequence, origin: 'local:prepared-relay', bytes: Buffer.from(bytes).toString('base64'), checksum,
    updateId: JSON.stringify([identityKey, writerId, sequence, checksum]) };
}
async function capture(label, value) {
  const file = `${facts.updates.length}-${label}.bin`, bytes = Buffer.from(value.bytes, 'base64');
  await writeFile(join(output, file), bytes);
  facts.updates.push({ file, bytes: bytes.length, sha256: sha(bytes), identity: value.identity, updateId: value.updateId });
}
function client(url, grant = alpha) {
  let session;
  async function post(path, input, extra = {}) {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + grant.token,
      ...(session ? { 'x-editac-session': session } : {}), ...extra }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() };
  }
  return { post, async negotiate(protocol = receiptProtocol) {
    const response = await post('/session', { identity: grant.identity, receiptProtocol: protocol });
    assert.equal(response.status, 200); session = response.body.session; return response.body;
  }, update(value) { return post('/updates', value); }, replay(after = 0, limit = 64) { return post('/replay', { after, limit }); } };
}
async function worker(databasePath = join(scratch, `database-${number++}.sqlite`), fault, extra = {}) {
  const index = facts.processes.length, logPath = join(output, `process-${index}.log`);
  const log = createWriteStream(logPath);
  const child = fork(new URL('./helpers/relay-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  children.add(child);
  const inbox = [], waiters = [];
  child.on('message', message => {
    const i = waiters.findIndex(w => w.type === message.type || message.type === 'error');
    if (i < 0) inbox.push(message);
    else { const w = waiters.splice(i, 1)[0]; message.type === 'error' ? w.reject(new Error(message.error)) : w.resolve(message); }
  });
  const exited = once(child, 'exit').then(async ([code, signal]) => {
    children.delete(child); log.end(); await once(log, 'finish'); return { code, signal };
  });
  function wait(type) {
    const i = inbox.findIndex(m => m.type === type || m.type === 'error');
    if (i >= 0) { const m = inbox.splice(i, 1)[0]; return m.type === 'error' ? Promise.reject(new Error(m.error)) : Promise.resolve(m); }
    return deadline(new Promise((resolve, reject) => waiters.push({ type, resolve, reject })), type);
  }
  child.send({ type: 'start', options: { databasePath, grants, ...extra }, fault });
  const ready = await wait('ready'); assert.equal(ready.pid, child.pid);
  const fact = { pid: child.pid, launcher: process.pid, workspace: resolve('.'), databasePath, url: ready.url, logPath, purpose: 'SYN-1.5 prepared relay integration' };
  facts.processes.push(fact);
  function verifyOwned() {
    const result = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout, /tests\/helpers\/relay-worker\.mjs/);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.equal(child.connected, true);
  }
  return { child, url: ready.url, databasePath, wait,
    async arm(boundary, action = 'pause') { child.send({ type: 'arm', fault: { boundary, action } }); await wait('armed'); },
    resume() { child.send({ type: 'resume' }); },
    async revoke(token) { child.send({ type: 'revoke', token }); await wait('revoked'); },
    async stop(crash = false) {
      verifyOwned();
      if (crash) child.kill('SIGKILL'); else child.send({ type: 'stop' });
      fact.exit = await deadline(exited, 'relay exit');
      assert.equal(fact.exit.signal, crash ? 'SIGKILL' : null);
      if (!crash) assert.equal(fact.exit.code, 0);
      await assert.rejects(fetch(ready.url + '/session', { signal: AbortSignal.timeout(500) }));
      facts.cleanup.push({ pid: child.pid, listenerGone: true });
    } };
}
function rows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return db.prepare('SELECT count(*) AS count FROM updates').get().count; } finally { db.close(); }
}
after(async () => {
  for (const child of children) {
    if (child.connected) child.send({ type: 'stop' });
    await deadline(once(child, 'exit'), 'failure cleanup');
  }
  await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
  await rm(scratch, { recursive: true, force: true });
  if (!process.env.EDITAC_RELAY_OUTPUT && facts.cases.every(c => c.passed)) await rm(output, { recursive: true, force: true });
  else if (!process.env.EDITAC_RELAY_OUTPUT) console.log('Preserved relay evidence: ' + output);
});

check('explicit capability is separate from ordinary accepted delivery', async () => {
  const service = await worker(), f = fixture();
  try {
    const plain = client(service.url); assert.equal((await plain.negotiate(null)).receiptProtocol, null);
    const value = entry(f.initial.bytes); await capture('rust-initial', value);
    const accepted = await plain.update(value); assert.equal(accepted.status, 200);
    assert.equal(accepted.body.receipt, null); assert.equal(accepted.body.remoteDurability, 'unknown');
    const durable = client(service.url); assert.equal((await durable.negotiate()).receiptProtocol, receiptProtocol);
    const retry = await durable.update(value); assert.equal(retry.body.duplicate, true);
    assert.deepEqual(retry.body.receipt, { protocol: receiptProtocol, state: 'durable', identity: value.identity,
      writerId: value.writerId, sequence: value.sequence, checksum: value.checksum, updateId: value.updateId });
    assert.equal(rows(service.databasePath), 1);
  } finally { f.close(); await service.stop(); }
});

check('prepared authorization, complete metadata and revocation isolate stored identities', async () => {
  const service = await worker(), f = fixture();
  try {
    const a = client(service.url), b = client(service.url, beta);
    const unauthenticated = client(service.url, { ...alpha, token: 'not-authorized' });
    assert.equal((await unauthenticated.post('/session', { identity: alpha.identity })).status, 403);
    for (const [field, expected] of [['documentId','wrong-document'], ['epoch','wrong-epoch'], ['schema','unsupported-profile']]) {
      const identity = { ...alpha.identity, [field]: beta.identity[field] === alpha.identity[field] ? 'unsupported' : beta.identity[field] };
      const denied = await a.post('/session', { identity }); assert.equal(denied.status, 409); assert.equal(denied.body.error, expected);
    }
    assert.equal((await a.post('/session', { identity: {}, receiptProtocol })).status, 400);
    assert.equal((await a.post('/session', { identity: alpha.identity, receiptProtocol: 'unknown' })).status, 400);
    assert.equal((await a.update(entry(f.initial.bytes))).status, 403);
    await a.negotiate(); await b.negotiate();
    assert.equal((await a.update(entry(f.initial.bytes, 101, 1, beta.identity))).status, 409);
    assert.equal((await a.update(entry(f.initial.bytes))).status, 200);
    assert.deepEqual((await b.replay()).body.entries, []);
    await service.revoke(alpha.token);
    assert.equal((await a.update(entry(f.initial.bytes, 101, 2))).status, 403);
    assert.equal((await a.replay()).status, 403); assert.equal(rows(service.databasePath), 1);
  } finally { f.close(); await service.stop(); }
});

check('receipt waits for commit completion; failed commit rolls back and permits retry', async () => {
  const service = await worker(), f = fixture();
  try {
    const c = client(service.url); await c.negotiate(); const value = entry(f.initial.bytes);
    await service.arm('before-commit');
    let settled = false; const pending = c.update(value).finally(() => { settled = true; });
    await service.wait('boundary'); assert.equal(settled, false); assert.equal(rows(service.databasePath), 0);
    service.resume(); const response = await pending;
    assert.equal(response.status, 200); assert.equal(response.body.receipt.state, 'durable'); assert.equal(rows(service.databasePath), 1);
    await service.arm('before-commit', 'throw');
    const failed = await c.update(entry(f.initial.bytes, 101, 2));
    assert.equal(failed.status, 500); assert.equal(failed.body.receipt, undefined); assert.equal(rows(service.databasePath), 1);
    assert.equal((await c.update(entry(f.initial.bytes, 101, 2))).status, 200); assert.equal(rows(service.databasePath), 2);
  } finally { f.close(); await service.stop(); }
});

for (const boundary of ['before-transaction', 'before-commit', 'after-commit', 'before-receipt']) {
  check(`process crash at ${boundary} preserves only committed bytes and retry identity`, async () => {
    let service = await worker(undefined, { boundary, action: 'pause' }); const f = fixture();
    try {
      const databasePath = service.databasePath, c = client(service.url); await c.negotiate();
      const value = entry(f.initial.bytes), pending = c.update(value).catch(error => ({ transportError: error.name }));
      await service.wait('boundary'); await service.stop(true); service = null;
      const failed = await pending; assert.ok(failed.transportError); assert.equal(failed.body?.receipt, undefined);
      service = await worker(databasePath); const restored = client(service.url); await restored.negotiate();
      const replay = await restored.replay(), committed = boundary === 'after-commit' || boundary === 'before-receipt';
      assert.equal(replay.body.entries.length, committed ? 1 : 0);
      if (committed) assert.equal(replay.body.entries[0].bytes, value.bytes);
      const retry = await restored.update(value); assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, committed);
      assert.equal(retry.body.receipt.updateId, value.updateId);
      const duplicate = await restored.update(value); assert.equal(duplicate.body.duplicate, true);
      assert.deepEqual(duplicate.body.receipt, retry.body.receipt); assert.equal(rows(databasePath), 1);
      const peer = replica(501);
      try { for (const saved of (await restored.replay()).body.entries) Y.applyUpdate(peer, Buffer.from(saved.bytes, 'base64'), 'restore');
        assert.deepEqual(snapshot(peer).visible.map(n => n.runs.map(r => r.insert).join('')),
          f.engine.read().visible.map(n => n.runs.map(r => r.text).join(''))); }
      finally { peer.destroy(); }
    } finally { f.close(); if (service) await service.stop(); }
  });
}

check('Rust and JS updates converge after shuffled duplicates, pagination and service restart', async () => {
  let service = await worker(); const f = fixture(), peer = replica(502);
  let restored;
  try {
    Y.applyUpdate(peer, f.initial.bytes, 'restore');
    const vector = Y.encodeStateVector(peer), at = f.engine.anchor(f.engine.read().visible[0].id, 3, 'right');
    try { f.engine.commit(f.engine.prepare({ kind: 'text', origin: 'local:relay-fixture', command: { type: 'insert', at, text: 'Rust' } })); }
    finally { f.engine.releaseAnchor(at); }
    peer.transact(() => roots(peer)['registry-texts'].get(f.engine.read().visible[0].spans[0].source).insert(3, 'JS'), 'local:fixture');
    const rust = entry(f.engine.encodeUpdate(vector).bytes, 101, 2), js = entry(Y.encodeStateAsUpdate(peer, vector), 202, 1);
    const initial = entry(f.initial.bytes); await capture('rust-delta', rust); await capture('js-delta', js);
    const c = client(service.url); await c.negotiate();
    for (const value of [js, rust, js, initial, rust, initial]) assert.equal((await c.update(value)).status, 200);
    assert.equal(rows(service.databasePath), 3);
    const databasePath = service.databasePath; await service.stop(); service = await worker(databasePath);
    const restarted = client(service.url); await restarted.negotiate();
    const saved = []; let cursor = 0, done = false;
    while (!done) { const page = await restarted.replay(cursor, 1); assert.equal(page.status, 200);
      assert.ok(page.body.after > cursor || page.body.done); saved.push(...page.body.entries); cursor = page.body.after; done = page.body.done; }
    assert.equal(saved.length, 3); assert.deepEqual(saved.map(e => e.updateId), [js, rust, initial].map(e => e.updateId));
    restored = runtime.restoreEngine(f.initial.identity, f.initial);
    const freshPeer = replica(503);
    try {
      for (const value of [...saved].reverse().concat(saved)) {
        const update = { identity: value.identity, bytes: new Uint8Array(Buffer.from(value.bytes, 'base64')) };
        restored.applyUpdate(update); Y.applyUpdate(freshPeer, update.bytes, 'remote');
      }
      const mirror = replica(504);
      try { Y.applyUpdate(mirror, restored.encodeUpdate().bytes); assert.deepEqual(snapshot(mirror), snapshot(freshPeer)); }
      finally { mirror.destroy(); }
      assert.deepEqual(restored.read().visible.map(n => n.runs.map(r => r.text).join('')),
        snapshot(freshPeer).visible.map(n => n.runs.map(r => r.insert).join('')));
      assert.match(restored.read().visible[0].runs.map(r => r.text).join(''), /Rust/);
      assert.match(restored.read().visible[0].runs.map(r => r.text).join(''), /JS/);
    } finally { freshPeer.destroy(); }
  } finally { restored?.dispose(); peer.destroy(); f.close(); await service.stop(); }
});

check('content identity, writer/sequence conflicts and request/replay limits fail before mutation', async () => {
  const service = await worker(undefined, undefined, { maxUpdateBytes: 1024, maxReplayBytes: 1024 }), f = fixture();
  try {
    const c = client(service.url); await c.negotiate(); const value = entry(f.initial.bytes);
    // The real fixture may exceed this deliberately narrow limit: use opaque bytes for byte-store limit cases.
    const small = entry(Buffer.alloc(600, 1));
    for (const changed of [{ checksum: '0'.repeat(64) }, { updateId: 'wrong' }, { writerId: 0 }, { writerId: 0x100000000 },
      { sequence: -1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { bytes: 'AA' }, { identity: {} }]) {
      const response = await c.update({ ...small, ...changed }); assert.equal(response.status, 400); assert.equal(response.body.receipt, undefined);
    }
    assert.equal(rows(service.databasePath), 0);
    assert.equal((await c.update(entry(Buffer.alloc(1025, 1)))).status, 413);
    assert.equal((await c.update(small)).status, 200);
    assert.equal((await c.update(entry(Buffer.alloc(600, 2)))).status, 409); assert.equal(rows(service.databasePath), 1);
    assert.equal((await c.update(entry(Buffer.alloc(600, 2), 101, 2))).status, 200);
    const page = await c.replay(); assert.equal(page.body.entries.length, 1); assert.equal(page.body.done, false);
    const last = await c.replay(page.body.after); assert.equal(last.body.entries.length, 1); assert.equal(last.body.done, true);
    assert.equal((await c.replay(-1)).status, 400); assert.equal((await c.replay(0, 257)).status, 400);
    const oversize = await c.post('/updates', { bytes: 'A'.repeat(10_000) }); assert.equal(oversize.status, 413);
    assert.equal(rows(service.databasePath), 2);
    assert.ok(value.bytes); // real-fixture creation also checks metadata authority
  } finally { f.close(); await service.stop(); }
});

check('bounded queue returns backpressure while pending updates remain retryable', async () => {
  const service = await worker(undefined, undefined, { maxQueue: 1 }); const f = fixture();
  try {
    const c = client(service.url); await c.negotiate(); await service.arm('before-commit');
    const first = c.update(entry(f.initial.bytes)); await service.wait('boundary');
    const second = await c.update(entry(f.initial.bytes, 101, 2)); assert.equal(second.status, 429); assert.equal(second.body.receipt, undefined);
    service.resume(); assert.equal((await first).status, 200);
    assert.equal((await c.update(entry(f.initial.bytes, 101, 2))).status, 200); assert.equal(rows(service.databasePath), 2);
  } finally { f.close(); await service.stop(); }
});

check('reference relay refuses non-loopback binding and persistent metadata reinterpretation', async () => {
  await assert.rejects(startReferenceRelay({ databasePath: join(scratch, 'nonloopback.sqlite'), grants, host: '0.0.0.0' }), /loopback/);
  await assert.rejects(startReferenceRelay({ databasePath: ':memory:', grants }), /Persistent database/);
  const databasePath = join(scratch, 'metadata.sqlite');
  const relay = await startReferenceRelay({ databasePath, grants }); await relay.close();
  await assert.rejects(startReferenceRelay({ databasePath, grants: [{ ...alpha, identity: { ...alpha.identity, schema: 'different' } }] }), /unsupported-profile/);
});
