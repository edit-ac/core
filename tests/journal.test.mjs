import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { UpdateJournal, JournalIntegrityError } from '../packages/web/dist/storage/journal.js';
import { PreparedIndexedDB } from './helpers/journal-storage.mjs';

const identity = Object.freeze({ profile: 'v5', schema: 'editac/5', documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', protocolVersion: 1, updateEncoding: 1, offsets: 'utf16' });
const fixture = (overrides = {}) => ({ identity: { ...identity }, writerId: 11, sequence: 1, origin: 'local:test', bytes: Uint8Array.of(1, 2, 3), ...overrides });
const evidence = process.env.EDITAC_JOURNAL_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-journal-'));
await mkdir(evidence, { recursive: true });
const facts = { cases: [], processes: [], fixture: { identity, writerId: 11, sequence: 1, bytes: [1, 2, 3] } };
let controller, browser;
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
function track(promise) { const state = { settled: false }; promise.then(value => Object.assign(state, { settled: true, value }), error => Object.assign(state, { settled: true, error })); return state; }
async function setup() { const database = new PreparedIndexedDB(); return { database, journal: await UpdateJournal.open(database) }; }
async function commit(journal, database, update = fixture()) {
  const promise = journal.append(update); const tx = await database.nextTransaction();
  tx.lookupSuccess(); if (tx.write) tx.writeSuccess(); tx.complete(); return promise;
}
async function read(journal, database, scope = identity) {
  const promise = journal.read(scope); const tx = await database.nextTransaction(); tx.lookupSuccess(); tx.complete(); return promise;
}

check('deterministic acknowledgment waits for completion, not enqueue or request success', async () => {
  const { journal, database } = await setup();
  const promise = journal.append(fixture()); const state = track(promise);
  assert.equal(state.settled, false);
  const tx = await database.nextTransaction(); tx.lookupSuccess(); tx.writeSuccess();
  await Promise.resolve(); assert.equal(state.settled, false); assert.equal(database.records.size, 0);
  tx.complete(); const result = await promise;
  assert.equal(result.state, 'localCommitted'); assert.equal(result.durability, 'strict'); assert.equal(database.records.size, 1);
});

check('deterministic duplicate identity is idempotent and independently waits for completion', async () => {
  const { journal, database } = await setup(); const first = await commit(journal, database);
  const promise = journal.append(fixture()); const state = track(promise); const tx = await database.nextTransaction();
  tx.lookupSuccess(); assert.equal(tx.write, null); await Promise.resolve(); assert.equal(state.settled, false);
  tx.complete(); assert.deepEqual(await promise, first); assert.equal(database.records.size, 1);
});

check('deterministic journal takes immutable ownership before asynchronous hashing', async () => {
  const { journal, database } = await setup(); const update = fixture(); const promise = journal.append(update);
  update.bytes.fill(9); update.identity.documentId = 'changed'; update.sequence = 99;
  const tx = await database.nextTransaction(); tx.lookupSuccess(); tx.writeSuccess(); tx.complete(); await promise;
  const entries = await read(journal, database); assert.deepEqual([...entries[0].bytes], [1, 2, 3]);
  entries[0].bytes.fill(8); entries[0].identity.epoch = 'changed';
  assert.deepEqual([...((await read(journal, database))[0].bytes)], [1, 2, 3]);
});

for (const field of ['bytes', 'origin', 'profile']) check(`deterministic ${field} collision aborts without overwriting`, async () => {
  const { journal, database } = await setup(); await commit(journal, database);
  const update = fixture(field === 'bytes' ? { bytes: Uint8Array.of(4) } : field === 'origin' ? { origin: 'different' } : { identity: { ...identity, profile: 'v1' } });
  const promise = journal.append(update); const rejection = assert.rejects(promise, JournalIntegrityError); const tx = await database.nextTransaction(); tx.lookupSuccess();
  await rejection; assert.equal(tx.aborted, true); assert.equal(database.records.size, 1);
  assert.deepEqual([...((await read(journal, database))[0].bytes)], [1, 2, 3]);
});

for (const boundary of ['lookup', 'write', 'after-request']) check(`deterministic quota/abort failure at ${boundary} rejects and rolls back`, async () => {
  const { journal, database } = await setup(); const promise = journal.append(fixture());
  const error = new DOMException('prepared failure', boundary === 'after-request' ? 'AbortError' : 'QuotaExceededError');
  const rejection = assert.rejects(promise, e => e === error); const tx = await database.nextTransaction();
  if (boundary === 'lookup') tx.requestFailure(error, false);
  else { tx.lookupSuccess(); if (boundary === 'write') tx.requestFailure(error); else { tx.writeSuccess(); tx.error = error; tx.abort(); } }
  await rejection; assert.equal(database.records.size, 0);
  await commit(journal, database); assert.equal(database.records.size, 1);
});

check('deterministic explicit abort without an error still rejects', async () => {
  const { journal, database } = await setup(); const promise = journal.append(fixture());
  const rejection = assert.rejects(promise, { name: 'AbortError' }); const tx = await database.nextTransaction(); tx.abort(); await rejection;
});

check('deterministic unsupported strict option falls back and reports observed capability', async () => {
  const { journal, database } = await setup(); database.strictSupported = false;
  assert.equal((await commit(journal, database)).durability, 'default');
  database.strictSupported = true; database.durability = 'relaxed';
  assert.equal((await commit(journal, database, fixture({ sequence: 2 }))).durability, 'relaxed');
});

check('deterministic transaction creation quota/permission/closed errors are not retried', async () => {
  const { journal, database } = await setup();
  for (const name of ['QuotaExceededError', 'SecurityError', 'InvalidStateError']) {
    const error = new DOMException('prepared failure', name); database.creationError = error;
    await assert.rejects(journal.append(fixture()), e => e === error); assert.equal(database.transactions.length, 0);
  }
});

check('deterministic document/epoch/schema/writer/sequence keys are isolated', async () => {
  const { journal, database } = await setup();
  const updates = [fixture(), fixture({ writerId: 12 }), fixture({ sequence: 2 }), ...['documentId', 'epoch', 'schema'].map(field => fixture({ identity: { ...identity, [field]: 'different' } }))];
  for (const update of updates) await commit(journal, database, update);
  assert.equal(database.records.size, 6); assert.equal((await read(journal, database)).length, 3);
  for (const update of updates.slice(3)) assert.equal((await read(journal, database, update.identity)).length, 1);
});

check('deterministic invalid identity/sequence/bytes fail before creating a transaction', async () => {
  const { journal, database } = await setup();
  for (const update of [fixture({ identity: { ...identity, documentId: '' } }), fixture({ identity: { ...identity, protocolVersion: 2 } }), fixture({ sequence: 0 }), fixture({ sequence: Number.MAX_SAFE_INTEGER + 1 }), fixture({ bytes: new Uint8Array() })]) {
    await assert.rejects(journal.append(update), JournalIntegrityError);
  }
  assert.equal(database.transactions.length, 0);
});

check('deterministic read rejects corrupt bytes/checksum/receipt/schema instead of returning replay', async () => {
  for (const mutation of [e => e.bytes.fill(9), e => e.checksum = 'bad', e => e.updateId = 'bad', e => e.identity.protocolVersion = 2]) {
    const { journal, database } = await setup(); await commit(journal, database);
    mutation([...database.records.values()][0]); await assert.rejects(read(journal, database), JournalIntegrityError);
  }
});

check('actual Chromium journal persists production engine patches and admits duplicate/concurrent writers', async () => {
  controller = await chromium.launchServer({ headless: true }); const child = controller.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(), purpose: 'journal IndexedDB qualification', log: 'journal.log' });
  browser = await chromium.connect(controller.wsEndpoint()); facts.browser = { version: browser.version(), playwright: JSON.parse(await readFile(new URL('../node_modules/playwright/package.json', import.meta.url))).version };
  const context = await browser.newContext();
  try {
    await context.route('https://journal.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Journal qualification</title>' });
      const prefix = path.startsWith('/core/') ? '../packages/core/dist/' : '../packages/web/dist/';
      const relative = path.replace(/^\/(core|web)\//, '');
      if (relative.includes('..') || !/^\/(core|web)\//.test(path)) return route.abort();
      await route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: await readFile(new URL(prefix + relative, import.meta.url)) });
    });
    const page = await context.newPage(); await page.goto('https://journal.test/');
    const result = await page.evaluate(async () => {
      const { UpdateJournal } = await import('/web/storage/journal.js'); const { init } = await import('/core/index.js');
      const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
      const engine = runtime.createEngine({ profile: 'v5', documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀b' }] });
      const checkpoint = engine.checkpoint(); const updates = []; const subscription = engine.subscribe({ type: 'updates' }, patch => { if (patch.update) updates.push({ identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin: patch.origin, bytes: patch.update.bytes }); });
      const anchor = engine.anchor(engine.read().visible[0].id, 3, 'right'); engine.commit(engine.prepare({ kind: 'text', origin: 'journal:edit', command: { type: 'insert', at: anchor, text: 'B' } })); engine.releaseAnchor(anchor);
      const expected = engine.read().visible[0].runs.map(r => r.text).join(''); subscription.dispose(); engine.dispose();
      let journal = await UpdateJournal.open(indexedDB, 'real-journal'); let second, restored;
      const nativeTransaction = IDBDatabase.prototype.transaction;
      const nativeAdd = IDBObjectStore.prototype.add;
      let completed = 0, abortAfterWrite = false, abortName = '';
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = nativeTransaction.apply(this, args);
        if (args[1] === 'readwrite') tx.addEventListener('complete', () => completed++);
        return tx;
      };
      IDBObjectStore.prototype.add = function (...args) {
        const request = nativeAdd.apply(this, args);
        if (abortAfterWrite) request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
      try {
        second = await UpdateJournal.open(indexedDB, 'real-journal');
        const concurrent = await Promise.all([journal.append(updates[0]), second.append(updates[0])]);
        if (completed !== 2) throw Error('Acknowledgment preceded native transaction completion');
        const writer = { ...updates[0], writerId: updates[0].writerId + 1 };
        const results = await Promise.all([journal.append(writer), second.append({ ...writer, sequence: writer.sequence + 1 })]);
        let collision = ''; try { await journal.append({ ...updates[0], bytes: Uint8Array.of(0) }); } catch (e) { collision = e.name; }
        abortAfterWrite = true;
        try { await journal.append({ ...writer, sequence: writer.sequence + 2 }); } catch (e) { abortName = e.name; }
        abortAfterWrite = false;
        journal.close(); second.close(); journal = await UpdateJournal.open(indexedDB, 'real-journal');
        const entries = await journal.read(checkpoint.identity); restored = runtime.restoreEngine(checkpoint.identity, checkpoint, entries.map(e => ({ identity: e.identity, bytes: e.bytes })));
        return { expected, actual: restored.read().visible[0].runs.map(r => r.text).join(''), count: entries.length, duplicate: concurrent[0].updateId === concurrent[1].updateId, states: [...concurrent, ...results].map(r => r.state), durability: concurrent[0].durability, collision, abortName, completed, bytes: entries[0].bytes.length,
          fixtures: { checkpoint: { ...checkpoint, bytes: Array.from(checkpoint.bytes) }, entries: entries.map(e => ({ ...e, bytes: Array.from(e.bytes) })) } };
      } finally { IDBDatabase.prototype.transaction = nativeTransaction; IDBObjectStore.prototype.add = nativeAdd; journal.close(); second?.close(); restored?.dispose(); }
    });
    assert.equal(result.expected, 'a😀Bb'); assert.equal(result.actual, result.expected); assert.equal(result.count, 3); assert.equal(result.duplicate, true); assert.ok(result.bytes > 0);
    assert.ok(result.states.every(s => s === 'localCommitted')); assert.equal(result.collision, 'JournalIntegrityError'); assert.equal(result.abortName, 'AbortError'); assert.equal(result.completed, 4); assert.equal(result.durability, 'strict'); facts.integration = result;
  } finally { await context.close(); }
});

after(async () => {
  try { await browser?.close(); } finally {
    await controller?.close();
    facts.teardown = { browserClosed: !browser?.isConnected(), browserProcessExited: !controller || controller.process().exitCode !== null, fixtureServersStarted: 0 };
    await writeFile(join(evidence, 'harness.json'), JSON.stringify(facts, null, 2));
    if (!process.env.EDITAC_JOURNAL_OUTPUT && facts.cases.every(c => c.passed)) await rm(evidence, { recursive: true });
  }
});
