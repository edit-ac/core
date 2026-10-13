import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as wire from 'y-protocols/sync';
import { init } from '../../packages/core/dist/index.js';
import { replica, roots, snapshot } from '../../fixtures/schema-v5/mapping.mjs';
import { startFixtureServer } from './fixture-server.mjs';
import { processHarness, deadline } from '../helpers/offline-processes.mjs';

const output = process.env.EDITAC_OFFLINE_COLLABORATION_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-offline-evidence-'));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'editac-offline-scratch-'));
const grants = JSON.parse(await readFile(new URL('../fixtures/relay-grants.json', import.meta.url), 'utf8'));
const grant = grants[0], sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wasm = await readFile(new URL('../../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
const seed = runtime.createEngine({ profile: 'v5', documentId: grant.identity.documentId,
  epoch: grant.identity.epoch, nodes: [{ text: 'a😀b' }, { text: 'independent' }] });
const checkpoint = seed.checkpoint(); seed.dispose();
assert.deepEqual(checkpoint.identity, grant.identity);
const initial = { ...checkpoint, bytes: Array.from(checkpoint.bytes) };
const facts = { gate: 'SYN-1.7', fixture: { text: ['a😀b', 'independent'], insertUTF16: 3,
  commands: ['A', 'B', 'X', 'Y', 'J'], checkpointSha256: sha(checkpoint.bytes), wasmSha256: sha(wasm) },
  boundary: 'Two headless Chromium OS processes / actual Rust WASM and IndexedDB / pinned Yjs baseline messages; separate child-process loopback HTTP SQLite receipts with prepared grants',
  cases: [], processes: [], frames: [], cleanup: {}, artifacts: [] };
let harness, server, frameNumber = 0, now = 0;
before(async () => {
  facts.revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  for (const path of ['tests/browser/offline-collaboration.spec.ts', 'tests/helpers/offline-processes.mjs',
    'tests/browser/fixtures/offline-collaboration/index.html', 'tests/browser/fixtures/offline-collaboration/session.mjs',
    'scripts/test-browser.mjs', 'fixtures/schema-v5/mapping.mjs', 'fixtures/schema-v5/profile.json',
    'tests/fixtures/relay-grants.json', 'tests/helpers/relay-worker.mjs', 'examples/sync-server/relay.mjs',
    'packages/web/src/sync/protocol.ts', 'packages/web/src/sync/session.ts', 'packages/web/src/sync/receipts.ts',
    'packages/web/src/storage/journal.ts', 'packages/web/src/storage/outbox.ts',
    'packages/core/dist/index.js', 'packages/core/dist/engine.js', 'packages/core/dist/wasm/editac_wasm.js',
    'packages/core/dist/wasm/editac_wasm_bg.wasm', 'packages/web/dist/sync/protocol.js',
    'packages/web/dist/sync/session.js', 'packages/web/dist/sync/receipts.js',
    'packages/web/dist/storage/journal.js', 'packages/web/dist/storage/outbox.js']) {
    const bytes = await readFile(path), file = 'artifacts/' + path;
    await mkdir(join(output, file, '..'), { recursive: true }); await writeFile(join(output, file), bytes);
    facts.artifacts.push({ path, file, bytes: bytes.length, sha256: sha(bytes) });
  }
  await writeFile(join(output, 'initial.bin'), checkpoint.bytes);
  harness = await processHarness(output, facts);
  server = await startFixtureServer({ fixtureDirectory: 'tests/browser/fixtures/offline-collaboration' });
  facts.server = { pid: server.pid, port: server.port, workspace: server.workspace,
    launcher: 'node --test tests/browser/offline-collaboration.spec.ts', purpose: 'SYN-1.7 fixture modules', log: 'feature.log' };
});
after(async () => {
  try { await harness?.close(); } finally {
    if (server) { await server.close(); await assert.rejects(fetch(server.url)); facts.server.listenerRemoved = true; }
    facts.cleanup.allOwnedProcessesExited = facts.processes.every(p => p.exited);
    facts.cleanup.scratchRemoved = false;
    // Evidence and failed logs stay durable; only disposable profiles/databases go.
    await rm(scratch, { recursive: true, force: true }); facts.cleanup.scratchRemoved = true;
    await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
  }
});
function check(name, fn) {
  test(name, { timeout: 120000 }, async () => {
    const fact = { name, passed: false }; facts.cases.push(fact);
    try { await fn(fact); fact.passed = true; }
    catch (error) { fact.failure = error.stack; throw error; }
    finally { await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2)); }
  });
}
async function browser(label, profile = join(scratch, label), service = null) {
  const process = await harness.browser(profile, label);
  let relaySession;
  await process.context.exposeBinding('relayCall', async (_source, path, body) => {
    assert.ok(service?.current, 'No prepared relay attached');
    assert.ok(['/session', '/updates', '/replay'].includes(path));
    const response = await fetch(service.current.url + path, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + grant.token,
        ...(relaySession ? { 'x-editac-session': relaySession } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    if (path === '/session' && response.ok) relaySession = value.session;
    return { status: response.status, body: value };
  });
  await process.context.route('**/*', route => {
    assert.equal(new URL(route.request().url()).origin, server.url, 'No external browser requests');
    return route.continue();
  });
  const page = await process.context.newPage();
  await page.goto(server.url); await page.waitForFunction(() => !!window.start);
  const restored = await page.evaluate(initial => window.start(initial), initial);
  return { ...process, page, profile, restored, async state() { return page.evaluate(() => window.h.state()); } };
}
async function capture(frame, source) {
  const bytes = Uint8Array.from(frame), file = `frame-${frameNumber++}.bin`;
  await writeFile(join(output, file), bytes);
  facts.frames.push({ file, source, bytes: bytes.length, sha256: sha(bytes), type: bytes[0] });
}
async function exchange(a, b, js, fact, attach = true) {
  if (attach) await Promise.all([a, b].map(p => p.page.evaluate(() => window.h.attach())));
  let deliveries = 0;
  for (let round = 0; round < 32; round++) {
    const batches = await Promise.all([a, b].map(p => p.page.evaluate(now => window.h.drain(now), now += 100)));
    if (batches.every(frames => !frames.length)) {
      fact.quiescence = { rounds: round + 1, deliveries }; return;
    }
    for (const [i, frames] of batches.entries()) for (const frame of frames.reverse()) {
      await capture(frame, i ? 'browser-B' : 'browser-A');
      const peer = i ? a : b, source = i ? b : a;
      await peer.page.evaluate(frame => { window.h.receive(frame); window.h.receive(frame); }, frame);
      const reply = encoding.createEncoder(), decoder = decoding.createDecoder(Uint8Array.from(frame));
      wire.readSyncMessage(decoder, reply, js, 'remote:browser', error => { throw error; });
      assert.equal(decoder.pos, frame.length);
      const response = encoding.toUint8Array(reply);
      if (response.length) { await capture(response, 'Yjs-reply'); await source.page.evaluate(frame => window.h.receive(frame), Array.from(response)); }
      deliveries += 2;
    }
  }
  throw Error('Prepared frame routing failed to quiesce (possible echo loop)');
}
const projected = bytes => { const doc = replica(90001); try { Y.applyUpdate(doc, Uint8Array.from(bytes)); return snapshot(doc); } finally { doc.destroy(); } };
const vectors = bytes => [...Y.decodeStateVector(Uint8Array.from(bytes))].sort((a,b) => a[0] - b[0]);

check('two browser processes recover acknowledged offline edits and converge with reordered duplicate Yjs messages', async fact => {
  let a = await browser('writer-A'), b = await browser('writer-B');
  const js = replica(404); Y.applyUpdate(js, checkpoint.bytes);
  try {
    assert.notEqual(facts.processes.at(-1).pid, facts.processes.at(-2).pid);
    await exchange(a, b, js, fact);
    await Promise.all([a, b].map(p => p.page.evaluate(() => window.h.detach())));
    const [ackA, ackB] = await Promise.all([a.page.evaluate(() => window.h.edit('A')), b.page.evaluate(() => window.h.edit('B'))]);
    assert.equal(ackA.state, 'localCommitted'); assert.equal(ackB.state, 'localCommitted');
    const saved = await a.state(), other = await b.state();
    assert.notEqual(saved.pending[0].writerId, other.pending[0].writerId);
    assert.deepEqual(saved.text, ['a😀Ab', 'independent']); assert.deepEqual(other.text, ['a😀Bb', 'independent']);
    assert.equal(saved.receipt.remoteDurability, 'unknown');
    const crash = await a.stop(true); assert.equal(crash.signal, 'SIGKILL');
    a = await browser('writer-A-restored', a.profile);
    assert.deepEqual(a.restored.text, saved.text);
    assert.deepEqual(a.restored.pending.map(e => e.updateId), saved.pending.map(e => e.updateId));
    assert.deepEqual(a.restored.journal, saved.journal);
    assert.equal(a.restored.receipt.remoteDurability, 'unknown');
    await Promise.all([a.page.evaluate(() => window.h.edit('X')), b.page.evaluate(() => window.h.edit('Y'))]);
    const after = await a.state();
    assert.notEqual(after.pending[1].writerId, saved.pending[0].writerId, 'restore must allocate a fresh live writer');
    const source = roots(js)['registry-texts'].get(snapshot(js).visible[0].spans[0][0]);
    const before = Y.encodeStateVector(js); source.insert(3, 'J');
    const encoder = encoding.createEncoder(); wire.writeUpdate(encoder, Y.encodeStateAsUpdate(js, before));
    const frame = encoding.toUint8Array(encoder);
    await exchange(a, b, js, fact);
    await Promise.all([a,b].map(p => p.page.evaluate(frame => window.h.receive(frame), Array.from(frame))));
    // Pump existing attachments; reconnect replays all durable local bytes too.
    await exchange(a, b, js, fact, false);
    const [left, right] = await Promise.all([a.state(), b.state()]);
    assert.deepEqual(left.semantic, right.semantic);
    assert.deepEqual(projected(left.bytes), snapshot(js)); assert.deepEqual(projected(right.bytes), snapshot(js));
    assert.deepEqual(vectors(left.vector), vectors(Y.encodeStateVector(js)));
    assert.deepEqual(vectors(right.vector), vectors(Y.encodeStateVector(js)));
    for (const value of [left, right]) {
      assert.match(value.text[0], /^a😀[ABXYJ]{5}b$/);
      for (const marker of ['A','B','X','Y','J']) assert.equal(value.text[0].split(marker).length - 1, 1);
      assert.equal(value.text[1], 'independent'); assert.equal(value.receipt.remoteDurability, 'unknown');
      assert.equal(value.sync.incomingFrames, 0); assert.equal(value.sync.outgoingFrames, 0);
      assert.equal(value.pending.filter(e => e.origin.startsWith('local:')).length, 2);
    }
    const noEcho = await Promise.all([a,b].map(p => p.page.evaluate(now => window.h.drain(now), now += 100)));
    assert.deepEqual(noEcho, [[], []]);
    fact.localCrash = { exit: crash, savedUpdateIds: saved.pending.map(e => e.updateId), restoredUpdateIds: a.restored.pending.map(e => e.updateId) };
    fact.convergence = { left, right, js: snapshot(js) };
  } finally { js.destroy(); await a.stop(false); await b.stop(false); }
});

for (const boundary of ['before-commit', 'after-commit', 'before-receipt']) {
  check(`${boundary}: lost relay response retains browser outbox, restart replay and duplicate receipt preserve local recovery`, async fact => {
    const database = join(scratch, boundary + '.sqlite'), service = { current: await harness.relay(database, grants, boundary) };
    let a = await browser(boundary + '-client', undefined, service), b;
    try {
      await a.page.evaluate(() => window.h.edit('A'));
      const saved = await a.state(); assert.equal(saved.pending.length, 1);
      await a.page.evaluate(() => window.h.attach(true));
      await service.current.arm(boundary);
      await a.page.evaluate(() => window.h.upload(0));
      assert.equal((await service.current.wait('boundary')).boundary, boundary);
      const paused = await a.state();
      assert.equal(paused.receipt.remoteDurability, 'unknown'); assert.equal(paused.pending.length, 1);
      await service.current.stop(true);
      await a.page.waitForFunction(() => window.uploadDone); await a.page.evaluate(() => window.uploadPromise);
      const failed = await a.state(); assert.ok(failed.receiptFailure);
      assert.equal(failed.pending.length, 1); assert.equal(failed.receipt.remoteDurability, 'unknown');
      const db = new DatabaseSync(database, { readOnly: true });
      let count; try { count = db.prepare('SELECT count(*) AS n FROM updates').get().n; } finally { db.close(); }
      assert.equal(count, boundary === 'before-commit' ? 0 : 1);
      await a.stop(true);
      service.current = await harness.relay(database, grants, boundary + '-restarted');
      a = await browser(boundary + '-restored', a.profile, service);
      assert.deepEqual(a.restored.text, saved.text);
      assert.deepEqual(a.restored.pending.map(e => e.updateId), saved.pending.map(e => e.updateId));
      b = await browser(boundary + '-observer', undefined, service);
      await b.page.evaluate(() => window.h.attach(true));
      const replayBefore = await b.page.evaluate(() => window.h.replay());
      assert.equal(replayBefore.entries.length, count);
      assert.deepEqual((await b.state()).text, [count ? 'a😀Ab' : 'a😀b', 'independent']);
      await a.page.evaluate(() => window.h.attach(true));
      await a.page.evaluate(() => { window.h.upload(100); return window.uploadPromise; });
      const acked = await a.state();
      assert.equal(acked.receipt.remoteDurability, 'durable'); assert.equal(acked.pending.length, 0);
      assert.equal(acked.receipt.remoteCommitted, saved.pending[0].updateId);
      assert.deepEqual(acked.journal, saved.journal, 'durable receipt does not delete local recovery bytes');
      const replayAfter = await b.page.evaluate(() => window.h.replay());
      assert.equal(replayAfter.entries.length, 1, 'retry must not duplicate durable service rows');
      assert.equal(replayAfter.entries[0].updateId, saved.pending[0].updateId);
      assert.deepEqual((await b.state()).semantic, acked.semantic);
      assert.equal((await b.state()).receipt.remoteDurability, 'unknown', 'replay is not a receipt for the observer');
      await a.stop(true); a = await browser(boundary + '-acknowledged-restored', a.profile, service);
      assert.deepEqual(a.restored.text, saved.text); assert.equal(a.restored.pending.length, 0);
      assert.deepEqual(a.restored.journal, saved.journal);
      fact.commitFault = { boundary, committedRowsBeforeRetry: count, replayBefore, replayAfter,
        failedReceipt: failed.receipt, ackedReceipt: acked.receipt, localUpdateIds: saved.journal.map(e => e.updateId), recoveryText: a.restored.text };
    } finally { await a.stop(false); await b?.stop(false); await service.current.stop(false); }
  });
}
