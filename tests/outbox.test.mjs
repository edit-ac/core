import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { init } from '../packages/core/dist/index.js';
import { UpdateJournal } from '../packages/web/dist/storage/journal.js';
import { CheckpointStorage } from '../packages/web/dist/storage/checkpoint.js';
import { UpdateOutbox, durableReceiptProtocol } from '../packages/web/dist/storage/outbox.js';
import { CheckpointIndexedDB } from './helpers/checkpoint-storage.mjs';
import { preparedSocketPair } from './helpers/prepared-socket.mjs';
import * as sync from 'y-protocols/sync';

const output = process.env.EDITAC_OUTBOX_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-outbox-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [] };
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
const tick = () => new Promise(resolve => setImmediate(resolve));
const runtime = await init('data:application/wasm;base64,' + (await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url))).toString('base64'));
const options = { profile: 'v5', documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀b' }] };
const engine = runtime.createEngine(options), initial = engine.checkpoint(), updates = [];
const sub = engine.subscribe({ type: 'updates' }, p => { if (p.update) updates.push({ identity: p.identity, writerId: p.writerId, sequence: p.sequence, origin: p.origin, bytes: p.update.bytes }); });
for (const word of ['B','C']) { const a = engine.anchor(engine.read().visible[0].id, 3, 'right'); engine.commit(engine.prepare({ kind: 'text', origin: 'outbox:test', command: { type: 'insert', at: a, text: word } })); engine.releaseAnchor(a); }
const latest = engine.checkpoint(); sub.dispose(); engine.dispose();
const receipt = entry => ({ protocol: durableReceiptProtocol, state: 'durable', identity: { ...entry.identity }, writerId: entry.writerId, sequence: entry.sequence, checksum: entry.checksum, updateId: entry.updateId });
async function commit(db, operation) { const p = operation(); const tx = await db.nextWrite(); await tick(); tx.complete(); return p; }
async function setup(capability = durableReceiptProtocol) {
  const db = new CheckpointIndexedDB(), journal = await UpdateJournal.open(db), points = await CheckpointStorage.open(db), outbox = await UpdateOutbox.open(db, 'test', capability);
  await commit(db, () => points.publish(initial, []));
  for (const update of updates) await commit(db, () => journal.append(update));
  const entries = await journal.read(initial.identity);
  return { db, journal, points, outbox, entries };
}
function restore(state) { const e = runtime.restoreEngine(initial.identity, state.checkpoint, state.tail.map(u => ({ identity: u.identity, bytes: u.bytes }))); try { return e.read().visible[0].runs.map(r => r.text).join(''); } finally { e.dispose(); } }

check('deterministic synchronization entry fixes separate update, sync, awareness and receipt profiles', async () => {
  const profile = JSON.parse(await readFile(new URL('./fixtures/synchronization-entry.json', import.meta.url)));
  assert.deepEqual(profile.update, { profile: 'editac.yrs-yjs.v1', schema: 'editac.registry.v1', protocolVersion: 1, updateEncoding: 1, offsets: 'utf16' });
  assert.deepEqual([profile.sync.step1, profile.sync.step2, profile.sync.update], [sync.messageYjsSyncStep1, sync.messageYjsSyncStep2, sync.messageYjsUpdate]);
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  assert.deepEqual(profile.dependencies, { yrs: '0.28.0', yjs: '13.6.33' });
  assert.equal(profile.sync.version, '1.0.7');
  assert.equal(lock.packages['node_modules/yjs'].version, profile.dependencies.yjs);
  assert.equal(lock.packages['node_modules/y-protocols'].version, profile.sync.version);
  assert.equal(profile.awareness.version, profile.sync.version); assert.equal(profile.awareness.durable, false);
  const cargo = await readFile(new URL('../Cargo.lock', import.meta.url), 'utf8');
  assert.ok(cargo.includes(`name = "yrs"\nversion = "${profile.dependencies.yrs}"`));
  assert.equal(profile.receipt.protocol, durableReceiptProtocol);
  assert.equal(profile.receipt.state, 'durable');
  assert.equal(profile.receipt.requiresNegotiatedCapability, true);
  assert.equal(profile.receipt.requiresServiceStorageCommit, true);
  assert.deepEqual(profile.receipt.identityFields, Object.keys(initial.identity).sort((a, b) => profile.receipt.identityFields.indexOf(a) - profile.receipt.identityFields.indexOf(b)));
  for (const [field, value] of Object.entries(profile.outboxEngineFixture)) assert.equal(initial.identity[field], value);
  const { entries } = await setup();
  assert.deepEqual(Object.keys(receipt(entries[0])).sort(), ['protocol', 'state', 'identity', ...profile.receipt.updateFields].sort());
  facts.entryProfile = profile;
});

check('deterministic prepared socket delivery preserves outbox until matching application receipts commit', async () => {
  const { db, outbox, entries, journal, points } = await setup();
  const socket = preparedSocketPair(), encoder = new TextEncoder(), decoder = new TextDecoder();
  const send = value => socket.peer.send(encoder.encode(JSON.stringify(value)));
  const receive = () => JSON.parse(decoder.decode(socket.client.receive()));
  try {
    for (const entry of entries) socket.client.send(entry.bytes);
    assert.deepEqual(socket.peer.receive(1), entries[1].bytes);
    assert.deepEqual(socket.peer.receive(), entries[0].bytes);
    assert.deepEqual(await outbox.pending(initial.identity), entries);
    send({ state: 'synced' });
    await assert.rejects(outbox.accept(receive()), { name: 'JournalIntegrityError' });
    send({ ...receipt(entries[0]), identity: { ...entries[0].identity, epoch: options.documentId } });
    assert.equal((await commit(db, () => outbox.accept(receive()))).state, 'ignored');
    send(receipt(entries[1])); send(receipt(entries[1])); send(receipt(entries[0]));
    socket.disconnect(); assert.throws(receive, /disconnected/);
    assert.deepEqual(await outbox.pending(initial.identity), entries);
    socket.reconnect();
    while (socket.client.pending) assert.equal((await commit(db, () => outbox.accept(receive()))).state, 'remoteCommitted');
    assert.deepEqual(await outbox.pending(initial.identity), []);
    assert.equal((await journal.read(initial.identity)).length, 2);
    facts.preparedSocket = { endpoint: null, networkRequests: 0, credentialReads: 0, serviceCommit: 'prepared only', deliveredUpdates: 2, matchedReceipts: 3 };
  } finally { socket.close(); outbox.close(); journal.close(); points.close(); }
  assert.equal(socket.closed, true);
});
facts.fixtures = { initial: { ...initial, bytes: Array.from(initial.bytes) }, latest: { ...latest, bytes: Array.from(latest.bytes) }, updates: updates.map(u => ({ ...u, bytes: Array.from(u.bytes) })) };

check('deterministic checkpoint coverage retains every pending identity and retransmittable real update', async () => {
  const { db, points, outbox, entries } = await setup();
  await commit(db, () => points.publish(latest, entries.map(e => e.updateId)));
  assert.deepEqual(await outbox.pending(initial.identity), entries);
  assert.equal((await points.restore(initial.identity, restore)).value, 'a😀CBb');
  assert.equal(db.stores.receipts.size, 0);
});
check('deterministic sync events, socket delivery and state vectors cannot acknowledge updates', async () => {
  const { outbox, entries, db } = await setup();
  for (const event of [{ state: 'synced' }, { state: 'delivered' }, { stateVector: [1] }, { ...receipt(entries[0]), state: 'synced' }, { ...receipt(entries[0]), protocol: 'yjs-sync' }]) await assert.rejects(outbox.accept(event), { name: 'JournalIntegrityError' });
  assert.deepEqual(await outbox.pending(initial.identity), entries); assert.equal(db.stores.receipts.size, 0);
});
check('deterministic absent negotiated receipt capability reports unknown durability and retains updates', async () => {
  const { db, outbox, entries } = await setup(null);
  assert.equal(outbox.receiptProtocol, null);
  assert.equal((await outbox.accept(receipt(entries[0]))).reason, 'capability-unavailable');
  assert.deepEqual(await outbox.pending(initial.identity), entries); assert.equal(db.stores.receipts.size, 0);
});
for (const field of ['documentId','epoch','schema','profile','writerId','sequence','checksum','updateId']) check(`deterministic wrong receipt ${field} cannot prune pending updates`, async () => {
  const { db, outbox, entries } = await setup(); const r = receipt(entries[0]);
  if (field in r.identity) r.identity[field] = 'other'; else if (field === 'writerId' || field === 'sequence') r[field]++; else r[field] = field === 'checksum' ? '0'.repeat(64) : 'other';
  assert.equal((await commit(db, () => outbox.accept(r))).state, 'ignored');
  assert.deepEqual(await outbox.pending(initial.identity), entries); assert.equal(db.stores.receipts.size, 0);
});
check('deterministic receipt acknowledgment and pruning wait for completion, not request success', async () => {
  const { db, outbox, entries } = await setup(); const input = receipt(entries[0]);
  let settled = false; const p = outbox.accept(input).then(v => { settled = true; return v; }); input.identity.epoch = 'mutated'; input.updateId = 'mutated';
  const tx = await db.nextWrite(); await tick(); tx.requestSuccess();
  assert.equal(settled, false); assert.deepEqual(await outbox.pending(initial.identity), entries);
  tx.complete(); assert.deepEqual(await p, { state: 'remoteCommitted', updateId: entries[0].updateId });
  assert.deepEqual(await outbox.pending(initial.identity), [entries[1]]); assert.equal(db.stores.updates.size, 2);
});
for (const boundary of ['before-lookup','after-write-success']) check(`deterministic receipt abort ${boundary} retains outbox and permits retry`, async () => {
  const { db, outbox, entries } = await setup(); const p = outbox.accept(receipt(entries[0])); const rejection = assert.rejects(p, { name: 'AbortError' });
  const tx = await db.nextWrite(); if (boundary === 'after-write-success') { await tick(); tx.requestSuccess(); } tx.abort(); await rejection;
  assert.deepEqual(await outbox.pending(initial.identity), entries);
  assert.equal((await commit(db, () => outbox.accept(receipt(entries[0])))).state, 'remoteCommitted');
  assert.deepEqual(await outbox.pending(initial.identity), [entries[1]]);
});
check('deterministic quota, permission and receipt write failures propagate without pruning', async () => {
  const { db, outbox, entries } = await setup();
  for (const error of [new DOMException('quota', 'QuotaExceededError'), new DOMException('permission', 'SecurityError')]) {
    db.writeCreationError = error; await assert.rejects(outbox.accept(receipt(entries[0])), e => e === error); db.writeCreationError = null;
    db.putError = error; await assert.rejects(outbox.accept(receipt(entries[0])), e => e === error); db.putError = null; await db.nextWrite();
    assert.deepEqual(await outbox.pending(initial.identity), entries);
  }
});
check('deterministic duplicate/reordered durable receipts survive reopen and duplicate append', async () => {
  const { db, outbox, journal, points, entries } = await setup();
  for (const i of [1,1,0,1,0]) assert.equal((await commit(db, () => outbox.accept(receipt(entries[i])))).state, 'remoteCommitted');
  assert.deepEqual(await outbox.pending(initial.identity), []); assert.equal(db.stores.receipts.size, 2);
  await commit(db, () => journal.append(updates[0])); await commit(db, () => points.publish(latest, entries.map(e => e.updateId)));
  outbox.close(); const reopened = await UpdateOutbox.open(db, 'test', durableReceiptProtocol);
  assert.deepEqual(await reopened.pending(initial.identity), []); assert.equal((await points.restore(initial.identity, restore)).value, 'a😀CBb');
  assert.equal(db.stores.updates.size, 2);
});
check('deterministic unknown receipt cannot pre-acknowledge a future journal append', async () => {
  const reference = await setup();
  const db = new CheckpointIndexedDB(), journal = await UpdateJournal.open(db), outbox = await UpdateOutbox.open(db, 'future', durableReceiptProtocol);
  await commit(db, () => journal.append(updates[0]));
  assert.equal((await commit(db, () => outbox.accept(receipt(reference.entries[1])))).reason, 'unknown-update');
  assert.equal(db.stores.receipts.size, 0);
  await commit(db, () => journal.append(updates[1]));
  assert.deepEqual(await outbox.pending(initial.identity), reference.entries);
});
check('deterministic corrupt receipt or journal fails explicitly instead of hiding pending work', async () => {
  const { db, outbox, entries } = await setup(); await commit(db, () => outbox.accept(receipt(entries[0])));
  const marker = [...db.stores.receipts.values()][0]; marker.sequence++;
  await assert.rejects(outbox.pending(initial.identity), { name: 'JournalIntegrityError' }); marker.sequence--;
  [...db.stores.updates.values()][0].bytes[0] ^= 1;
  await assert.rejects(outbox.pending(initial.identity), { name: 'JournalIntegrityError' });
});
check('deterministic detached pending bytes and unsupported strict durability preserve identity', async () => {
  const { db, outbox, entries } = await setup(); const pending = await outbox.pending(initial.identity); pending[0].bytes.fill(0); pending[0].identity.epoch = 'mutated';
  assert.deepEqual(await outbox.pending(initial.identity), entries); db.strictSupported = false;
  assert.equal((await commit(db, () => outbox.accept(receipt(entries[0])))).state, 'remoteCommitted');
  assert.deepEqual(await outbox.pending(initial.identity), [entries[1]]);
});

let controller, browser;
check('deterministic bounded outbox pages preserve cursor identity, byte limits and receipt filtering', async () => {
  const { db, outbox, entries } = await setup();
  const budget = Math.max(...entries.map(e => e.bytes.length));
  const first = await outbox.pendingPage(initial.identity, null, 1, budget);
  assert.deepEqual(first.entries, [entries[0]]); assert.equal(first.done, false);
  const second = await outbox.pendingPage(initial.identity, first.after, 1, budget);
  assert.deepEqual(second.entries, [entries[1]]); assert.equal(second.done, true);
  const byBytes = await outbox.pendingPage(initial.identity, null, 10, budget);
  assert.equal(byBytes.entries.length, 1); assert.equal(byBytes.done, false);
  await commit(db, () => outbox.accept(receipt(entries[0])));
  const acknowledged = await outbox.pendingPage(initial.identity, null, 1, budget);
  assert.deepEqual(acknowledged.entries, []); assert.deepEqual(acknowledged.after, first.after); assert.equal(acknowledged.done, false);
  assert.deepEqual((await outbox.pendingPage(initial.identity, acknowledged.after, 1, budget)).entries, [entries[1]]);
  await assert.rejects(outbox.pendingPage(initial.identity, null, 1, 1), { name: 'JournalIntegrityError' });
  const marker = [...db.stores.receipts.values()][0]; marker.checksum = '0'.repeat(64);
  await assert.rejects(outbox.pendingPage(initial.identity, null, 1, budget), { name: 'JournalIntegrityError' });
  assert.equal(db.stores.updates.size, 2);
});
check('actual Chromium v2 upgrade, receipt abort boundaries, checkpoint retention and restart preserve real Rust updates', async () => {
  controller = await chromium.launchServer({ headless: true }); const child = controller.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(), purpose: 'outbox IndexedDB integration', port: Number(new URL(controller.wsEndpoint()).port), log: 'full.log' });
  browser = await chromium.connect(controller.wsEndpoint()); facts.browser = { version: browser.version(), playwright: JSON.parse(await readFile(new URL('../node_modules/playwright/package.json', import.meta.url))).version };
  const context = await browser.newContext();
  try {
    let unexpectedRequests = 0, preparedRequests = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== 'https://outbox.test') { unexpectedRequests++; return route.abort(); }
      preparedRequests++;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Outbox qualification</title>' });
      if (path.includes('..') || !/^\/(core|web)\//.test(path)) return route.abort();
      const prefix = path.startsWith('/core/') ? '../packages/core/dist/' : '../packages/web/dist/';
      await route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: await readFile(new URL(prefix + path.replace(/^\/(core|web)\//, ''), import.meta.url)) });
    });
    const page = await context.newPage(); await page.goto('https://outbox.test/');
    const result = await page.evaluate(async ({ options }) => {
      const { init } = await import('/core/index.js'), { UpdateJournal } = await import('/web/storage/journal.js'), { CheckpointStorage } = await import('/web/storage/checkpoint.js'), { UpdateOutbox, durableReceiptProtocol } = await import('/web/storage/outbox.js');
      const rt = await init('/core/wasm/editac_wasm_bg.wasm'), engine = rt.createEngine(options), initial = engine.checkpoint(), updates = [];
      const sub = engine.subscribe({ type: 'updates' }, p => { if (p.update) updates.push({ identity: p.identity, writerId: p.writerId, sequence: p.sequence, origin: p.origin, bytes: p.update.bytes }); });
      let journal, points, outbox;
      const nativePut = IDBObjectStore.prototype.put, nativeTransaction = IDBDatabase.prototype.transaction;
      let boundary = '', completed = 0; const errors = [], observed = [];
      const r = e => ({ protocol: durableReceiptProtocol, state: 'durable', identity: e.identity, writerId: e.writerId, sequence: e.sequence, checksum: e.checksum, updateId: e.updateId });
      try {
        // Seed the actual old v2 schema with an immutable update, then exercise production upgrade.
        for (const word of ['B','C']) { const a = engine.anchor(engine.read().visible[0].id, 3, 'right'); engine.commit(engine.prepare({ kind: 'text', origin: 'outbox:browser', command: { type: 'insert', at: a, text: word } })); engine.releaseAnchor(a); }
        const old = await new Promise((resolve, reject) => { const q = indexedDB.open('outbox-integration', 2); q.onupgradeneeded = () => { const s = q.result.createObjectStore('updates', { keyPath: ['identity.documentId','identity.epoch','identity.schema','writerId','sequence'] }); s.createIndex('documentEpochSchema', ['identity.documentId','identity.epoch','identity.schema']); q.result.createObjectStore('checkpoints'); }; q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        try {
          const u = updates[0], hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u.bytes)), b => b.toString(16).padStart(2,'0')).join('');
          const identityKey = JSON.stringify(['profile','schema','documentId','epoch','protocolVersion','updateEncoding','offsets'].map(f => u.identity[f]));
          const entry = { ...u, checksum: hash, updateId: JSON.stringify([identityKey,u.writerId,u.sequence,hash]) };
          await new Promise((resolve, reject) => { const tx = old.transaction('updates','readwrite'); tx.objectStore('updates').add(entry); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        } finally { old.close(); }
        journal = await UpdateJournal.open(indexedDB, 'outbox-integration'); points = await CheckpointStorage.open(indexedDB, 'outbox-integration'); outbox = await UpdateOutbox.open(indexedDB, 'outbox-integration', durableReceiptProtocol);
        observed.push((await outbox.pending(initial.identity)).length);
        await journal.append(updates[1]); const entries = await journal.read(initial.identity);
        const page1 = await outbox.pendingPage(initial.identity, null, 1, 2048);
        const page2 = await outbox.pendingPage(initial.identity, page1.after, 1, 2048);
        if (page1.done || !page2.done || page1.entries.length !== 1 || page2.entries.length !== 1
          || page1.entries[0].updateId !== entries[0].updateId || page2.entries[0].updateId !== entries[1].updateId) throw Error('Real IndexedDB page cursor dropped/repeated an update');
        await points.publish(initial, []); await points.publish(engine.checkpoint(), entries.map(e => e.updateId));
        observed.push((await outbox.pending(initial.identity)).length);
        const unknown = await UpdateOutbox.open(indexedDB, 'outbox-integration'); const absent = await unknown.accept(r(entries[0])); unknown.close();
        const wrong = await outbox.accept({ ...r(entries[0]), identity: { ...initial.identity, epoch: 'wrong' } });
        let syncRejected = false; try { await outbox.accept({ state: 'synced' }); } catch { syncRejected = true; }
        IDBDatabase.prototype.transaction = function(...args) { const tx = nativeTransaction.apply(this,args); if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('receipts')) tx.addEventListener('complete', () => completed++); return tx; };
        IDBObjectStore.prototype.put = function(...args) { const q = nativePut.apply(this,args); if (this.name === 'receipts' && boundary === 'before-success') this.transaction.abort(); if (this.name === 'receipts' && boundary === 'after-success') q.addEventListener('success', () => this.transaction.abort()); return q; };
        for (const phase of ['before-success','after-success']) { boundary = phase; try { await outbox.accept(r(entries[0])); } catch (e) { errors.push(e.name); } boundary = ''; observed.push((await outbox.pending(initial.identity)).length); }
        for (const i of [1,1,0,0]) { const before = completed; if ((await outbox.accept(r(entries[i]))).state !== 'remoteCommitted' || completed !== before + 1) throw Error('Receipt acknowledgment preceded completion'); }
        const acknowledgedPage = await outbox.pendingPage(initial.identity, null, 1, 2048);
        const acknowledgedTail = await outbox.pendingPage(initial.identity, acknowledgedPage.after, 1, 2048);
        if (acknowledgedPage.entries.length || acknowledgedTail.entries.length || acknowledgedPage.done || !acknowledgedTail.done) throw Error('Real IndexedDB pages ignored receipt markers');
        outbox.close(); outbox = await UpdateOutbox.open(indexedDB, 'outbox-integration', durableReceiptProtocol); await journal.append(updates[0]);
        observed.push((await outbox.pending(initial.identity)).length);
        const restored = await points.restore(initial.identity, state => { const e = rt.restoreEngine(initial.identity, state.checkpoint, state.tail.map(u => ({ identity:u.identity,bytes:u.bytes }))); try { return e.read().visible[0].runs.map(r => r.text).join(''); } finally { e.dispose(); } });
        return { observed, errors, completed, absent: absent.reason, wrong: wrong.state, syncRejected, content: restored.value, journalCount: (await journal.read(initial.identity)).length, entries: entries.map(e => ({ ...e, bytes: Array.from(e.bytes) })) };
      } finally { IDBObjectStore.prototype.put = nativePut; IDBDatabase.prototype.transaction = nativeTransaction; sub.dispose(); engine.dispose(); outbox?.close(); points?.close(); journal?.close(); }
    }, { options });
    assert.deepEqual(result.observed, [1,2,2,2,0]); assert.deepEqual(result.errors, ['AbortError','AbortError']); assert.equal(result.completed,4); assert.equal(result.absent,'capability-unavailable'); assert.equal(result.wrong,'ignored'); assert.equal(result.syncRejected,true); assert.equal(result.content,'a😀CBb'); assert.equal(result.journalCount,2); facts.integration = result;
    assert.equal(unexpectedRequests, 0);
    facts.network = { applicationNetworkRequests: 0, unexpectedRequests, preparedRequests, routing: 'all application requests fulfilled from local build files', browserControl: 'loopback Playwright only' };
  } finally { await context.close(); }
});
after(async () => { try { await browser?.close(); } finally { await controller?.close(); facts.teardown = { browserClosed: !browser?.isConnected(), browserProcessExited: !controller || controller.process().exitCode !== null, fixtureServersStarted: 0 }; await writeFile(join(output,'harness.json'), JSON.stringify(facts,null,2)); if (!process.env.EDITAC_OUTBOX_OUTPUT && facts.cases.every(c => c.passed)) await rm(output,{recursive:true}); } });
