import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { init } from '../packages/core/dist/index.js';
import { UpdateJournal } from '../packages/web/dist/storage/journal.js';
import { StorageWriter } from '../packages/web/dist/storage/writer.js';
import { LocalStorageLifecycle } from '../packages/web/dist/storage/index.js';
import { PreparedIndexedDB } from './helpers/journal-storage.mjs';

const output = process.env.EDITAC_LIFECYCLE_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-lifecycle-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [], fixtures: [] };
function check(name, fn) {
  test(name, async () => { const result = { name, passed: false }; facts.cases.push(result); await fn(); result.passed = true; });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const runtime = await init('data:application/wasm;base64,' + (await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url))).toString('base64'));
const seed = runtime.createEngine({ profile: 'v5', documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀b' }] });
const initial = seed.checkpoint(); seed.dispose();
const serial = point => ({ ...point, bytes: Array.from(point.bytes) });
await writeFile(join(output, 'initial.json'), JSON.stringify(serial(initial)));
class Locks {
  held = new Set();
  async request(name, options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
const text = engine => engine.read().visible[0].runs.map(run => run.text).join('');
function recoveryText(recovery) {
  const engine = runtime.restoreEngine(initial.identity, recovery.checkpoint);
  try { return text(engine); } finally { engine.dispose(); }
}
async function setup(policy) {
  const db = new PreparedIndexedDB(), locks = new Locks();
  const writer = await StorageWriter.restore(runtime, locks, initial.identity, initial);
  const journal = await UpdateJournal.open(db);
  const lifecycle = new LocalStorageLifecycle(writer, journal, policy);
  return { db, locks, writer, journal, lifecycle };
}
function edit(f, word) {
  const engine = f.writer.engine;
  const at = engine.anchor(engine.read().visible[0].id, 3, 'right');
  try { return f.lifecycle.commit({ kind: 'text', origin: 'lifecycle:test', command: { type: 'insert', at, text: word } }); }
  finally { engine.releaseAnchor(at); }
}
async function staged(f) {
  const tx = await f.db.nextTransaction();
  tx.lookupSuccess(); tx.writeSuccess();
  await tick();
  facts.fixtures.push({ ...tx.entry, bytes: Array.from(tx.entry.bytes) });
  return tx;
}
async function dispose(f) {
  await f.lifecycle.destroy({ policy: 'report' });
  await tick(); assert.equal(f.locks.held.size, 0);
}

check('deterministic captured flush waits for completion, excludes later edits and clears saved on enqueue', async () => {
  const f = await setup();
  try {
    assert.equal(f.lifecycle.state.saved, false);
    assert.equal(f.lifecycle.state.strictDurability, 'unknown');
    await f.lifecycle.flush({ target: 'local' });
    edit(f, 'A');
    let flushed = false;
    const barrier = f.lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
    const first = await staged(f);
    assert.equal(flushed, false); assert.equal(f.lifecycle.state.pending, 1);
    assert.equal(f.lifecycle.state.localCommitted, null); assert.equal(f.lifecycle.state.saved, false);
    edit(f, 'B'); const second = await staged(f);
    first.complete(); await barrier;
    assert.equal(flushed, true); assert.equal(f.lifecycle.state.pending, 1); assert.equal(f.lifecycle.state.saved, false);
    assert.equal(f.lifecycle.state.localCommitted.updateId, first.entry.updateId);
    let allDone = false;
    const all = f.lifecycle.flush({ target: 'local' }).then(() => { allDone = true; });
    await tick(); assert.equal(allDone, false);
    second.complete(); await all;
    assert.equal(f.lifecycle.state.saved, true); assert.equal(f.lifecycle.state.phase, 'localCommitted');
    assert.equal(f.lifecycle.state.pending, 0); assert.equal(f.lifecycle.state.strictDurability, 'supported');
    const state = f.lifecycle.state; state.localCommitted.updateId = 'tampered';
    assert.equal(f.lifecycle.state.localCommitted.updateId, second.entry.updateId);
    edit(f, 'C'); assert.equal(f.lifecycle.state.saved, false);
    const third = await staged(f); third.complete(); await f.lifecycle.flush({ target: 'local' });
  } finally { await dispose(f); }
});

for (const name of ['AbortError', 'QuotaExceededError', 'NotAllowedError']) {
  check(`deterministic ${name} rejects barriers, clears saved and retains edits/export under default continue policy`, async () => {
    const f = await setup();
    try {
      edit(f, 'A'); (await staged(f)).complete(); await f.lifecycle.flush({ target: 'local' });
      assert.equal(f.lifecycle.state.saved, true);
      edit(f, 'B'); const barrier = f.lifecycle.flush({ target: 'local' });
      const error = new DOMException('prepared storage failure', name);
      const rejected = assert.rejects(barrier, e => e === error);
      if (name === 'NotAllowedError') { f.db.creationError = error; }
      else {
        const tx = await staged(f);
        if (name === 'AbortError') { tx.error = error; tx.abort(); }
        else tx.requestFailure(error);
      }
      await rejected;
      assert.equal(f.lifecycle.state.phase, 'error'); assert.equal(f.lifecycle.state.error, error);
      assert.equal(f.lifecycle.state.saved, false); assert.equal(f.lifecycle.state.pending, 0);
      const before = f.lifecycle.recoveryExport(); assert.equal(recoveryText(before), 'a😀BAb');
      assert.equal(before.unsavedUpdates.length, 1);
      before.unsavedUpdates[0].bytes.fill(0); before.checkpoint.bytes.fill(0);
      assert.equal(recoveryText(f.lifecycle.recoveryExport()), 'a😀BAb');
      f.db.creationError = null;
      edit(f, 'C'); (await staged(f)).complete(); await tick();
      assert.equal(text(f.writer.engine), 'a😀CBAb');
      assert.equal(f.lifecycle.state.saved, false); assert.equal(f.lifecycle.state.error, error);
      await assert.rejects(f.lifecycle.flush({ target: 'local' }), e => e === error);
      assert.equal(recoveryText(f.lifecycle.recoveryExport()), 'a😀CBAb');
    } finally { await dispose(f); }
  });
}

for (const policy of ['continue', 'reject']) {
  check(`deterministic explicit retry under ${policy} policy retains identity, shares attempts and captures only original work`, async () => {
    const f = await setup({ afterStorageFailure: policy });
    try {
      const committed = []; f.lifecycle.subscribeCommitted((update, receipt) => committed.push({ update, receipt }));
      edit(f, 'A'); const original = await staged(f);
      const error = new DOMException('denied until repaired', 'NotAllowedError');
      const rejected = assert.rejects(f.lifecycle.flush({ target: 'local' }), e => e === error);
      original.error = error; original.abort(); await rejected;
      const recovery = f.lifecycle.recoveryExport(), engine = f.writer.engine;
      const semantic = () => { const { changedNodes, touchedRanges, ...state } = engine.read(); return state; };
      const state = semantic(), history = engine.history({ type: 'state' });
      const checkpoint = engine.checkpoint();
      assert.equal(committed.length, 0);
      if (policy === 'reject') assert.throws(() => edit(f, 'B'), /Host policy rejects/);
      await assert.rejects(f.lifecycle.flush({ target: 'local' }), e => e === error);
      const count = f.db.transactions.length; await tick(); assert.equal(f.db.transactions.length, count);
      // A host may join a retry from a pending-state observer. Joining must
      // not recursively emit another unchanged state or create more attempts.
      let joined, notifications = 0;
      const unsubscribe = f.lifecycle.subscribe(state => {
        notifications++;
        if (state.phase === 'pending') joined = f.lifecycle.flush({ target: 'local', retryFailed: true });
      });
      const retry = f.lifecycle.flush({ target: 'local', retryFailed: true });
      assert.equal(notifications, 1); unsubscribe();
      const shared = f.lifecycle.flush({ target: 'local', retryFailed: true });
      const retried = await staged(f);
      assert.equal(f.db.transactions.length, count + 1);
      assert.deepEqual(retried.entry, original.entry);
      assert.equal(f.writer.engine, engine); assert.deepEqual(semantic(), state);
      assert.deepEqual(engine.history({ type: 'state' }), history); assert.deepEqual(engine.checkpoint(), checkpoint);
      assert.deepEqual(f.lifecycle.recoveryExport(), recovery);
      assert.equal(f.lifecycle.state.saved, false); assert.equal(f.lifecycle.state.pending, 1);
      if (policy === 'reject') assert.throws(() => edit(f, 'B'), /Host policy rejects/);
      let later;
      if (policy === 'continue') { edit(f, 'B'); later = await staged(f); }
      retried.complete(); await Promise.all([retry, shared, joined]);
      assert.equal(committed.length, 1);
      assert.deepEqual(committed[0].update, recovery.unsavedUpdates[0]);
      assert.equal(committed[0].receipt.updateId, original.entry.updateId);
      if (later) { assert.equal(f.lifecycle.state.pending, 1); assert.equal(f.lifecycle.state.saved, false); later.complete(); await f.lifecycle.flush({ target: 'local' }); }
      assert.equal(f.lifecycle.state.saved, true); assert.equal(f.lifecycle.state.error, null);
      assert.equal(f.lifecycle.recoveryExport().unsavedUpdates.length, 0);
      edit(f, 'C'); (await staged(f)).complete(); await f.lifecycle.flush({ target: 'local' });
    } finally { await dispose(f); }
  });
}

check('deterministic denied retry rejects again without losing recovery or scheduling more attempts', async () => {
  const f = await setup();
  try {
    edit(f, 'A'); const tx = await staged(f);
    const first = assert.rejects(f.lifecycle.flush({ target: 'local' }), { name: 'AbortError' }); tx.abort(); await first;
    const recovery = f.lifecycle.recoveryExport();
    const retry = assert.rejects(f.lifecycle.flush({ target: 'local', retryFailed: true }), { name: 'QuotaExceededError' });
    const next = await staged(f); next.requestFailure(new DOMException('still denied', 'QuotaExceededError')); await retry;
    assert.deepEqual(f.lifecycle.recoveryExport(), recovery); assert.equal(f.lifecycle.state.saved, false);
    assert.equal(f.lifecycle.state.phase, 'error'); assert.equal(f.lifecycle.state.error.name, 'QuotaExceededError');
    const count = f.db.transactions.length; await tick(); await tick(); assert.equal(f.db.transactions.length, count);
    await assert.rejects(f.lifecycle.flush({ target: 'local' }), { name: 'QuotaExceededError' });
  } finally { await dispose(f); }
});

check('deterministic later transaction failure cannot reject an earlier captured set, and no-op work adds no storage', async () => {
  const f = await setup();
  try {
    const at = f.writer.engine.anchor(f.writer.engine.read().visible[0].id, 3, 'right');
    try {
      f.lifecycle.commit({ kind: 'text', origin: 'lifecycle:noop', command: { type: 'insert', at, text: '' } });
    } finally { f.writer.engine.releaseAnchor(at); }
    assert.equal(f.lifecycle.state.pending, 0);
    assert.equal(f.db.transactions.length, 0);
    edit(f, 'A'); const firstBarrier = f.lifecycle.flush({ target: 'local' });
    const first = await staged(f);
    edit(f, 'B'); const second = await staged(f);
    second.abort(); await tick();
    assert.equal(f.lifecycle.state.phase, 'error');
    first.complete(); await firstBarrier;
    assert.equal(f.lifecycle.state.saved, false);
    await assert.rejects(f.lifecycle.flush({ target: 'local' }), { name: 'AbortError' });
    assert.equal(recoveryText(f.lifecycle.recoveryExport()), 'a😀BAb');
  } finally { await dispose(f); }
});

check('deterministic explicit reject policy prevents Rust mutation after failure; policy is captured by value', async () => {
  const policy = { afterStorageFailure: 'reject' }, f = await setup(policy);
  policy.afterStorageFailure = 'continue';
  try {
    edit(f, 'A'); const tx = await staged(f); tx.abort();
    await assert.rejects(f.lifecycle.flush({ target: 'local' }), { name: 'AbortError' });
    const before = f.writer.engine.read(), checkpoint = f.writer.engine.checkpoint();
    assert.throws(() => edit(f, 'B'), /Host policy rejects edits/);
    const at = f.writer.engine.anchor(before.visible[0].id, 0, 'right');
    const prepared = f.writer.engine.prepare({ kind: 'text', origin: 'history-restore', command: { type: 'insert', at, text: 'forbidden' } });
    try { assert.throws(() => f.lifecycle.commitPrepared(prepared), /Host policy rejects edits/); }
    finally { f.writer.engine.releasePlan(prepared); f.writer.engine.releaseAnchor(at); }
    const after = f.writer.engine.read();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.visible, before.visible);
    assert.deepEqual(f.writer.engine.checkpoint(), checkpoint);
    assert.equal(recoveryText(f.lifecycle.recoveryExport()), 'a😀Ab');
  } finally { await dispose(f); }
});

for (const durability of ['default', 'unknown']) {
  check(`deterministic reports actual ${durability} durability without claiming strict capability`, async () => {
    const f = await setup();
    try {
      if (durability === 'default') f.db.strictSupported = false;
      else f.db.durability = undefined;
      edit(f, 'A'); (await staged(f)).complete(); await f.lifecycle.flush({ target: 'local' });
      assert.equal(f.lifecycle.state.localCommitted.durability, durability);
      assert.equal(f.lifecycle.state.strictDurability, durability === 'unknown' ? 'unknown' : 'unavailable');
      assert.equal(f.lifecycle.state.saved, true);
      f.db.strictSupported = true; f.db.durability = 'strict';
      edit(f, 'B'); (await staged(f)).complete(); await f.lifecycle.flush({ target: 'local' });
      assert.equal(f.lifecycle.state.strictDurability, durability === 'unknown' ? 'unknown' : 'unavailable');
    } finally { await dispose(f); }
  });
}

check('deterministic destroy flush blocks edits until completion and releases lease/subscription/database', async () => {
  const f = await setup(); edit(f, 'A'); const tx = await staged(f);
  let destroyed = false;
  const done = f.lifecycle.destroy({ policy: 'flush' }).then(report => { destroyed = true; return report; });
  await tick(); assert.equal(destroyed, false); assert.equal(f.db.closed, false);
  assert.throws(() => edit(f, 'B'), /closing/);
  tx.complete(); const report = await done; await tick();
  assert.equal(report.unsaved, false); assert.equal(recoveryText(report.recovery), 'a😀Ab');
  assert.equal(f.db.closed, true); assert.equal(f.locks.held.size, 0);
  assert.throws(() => f.lifecycle.recoveryExport(), /destroyed/);
});

check('deterministic failed destroy flush preserves live edits and explicit report exports unsaved state', async () => {
  const f = await setup(); edit(f, 'A'); const tx = await staged(f);
  const rejected = assert.rejects(f.lifecycle.destroy({ policy: 'flush' }), { name: 'AbortError' });
  tx.abort(); await rejected;
  assert.equal(f.db.closed, false); assert.equal(f.locks.held.size, 1);
  assert.equal(recoveryText(f.lifecycle.recoveryExport()), 'a😀Ab');
  const report = await f.lifecycle.destroy({ policy: 'report' }); await tick();
  assert.equal(report.unsaved, true); assert.equal(report.recovery.unsavedUpdates.length, 1);
  assert.equal(recoveryText(report.recovery), 'a😀Ab'); assert.equal(f.locks.held.size, 0);
});

check('deterministic report destruction never claims pending data saved; missing policy/unsupported target fail explicitly', async () => {
  const f = await setup();
  await assert.rejects(f.lifecycle.destroy({}), /Explicit destroy policy/);
  await assert.rejects(f.lifecycle.flush({ target: 'remote' }), /Unsupported flush target/);
  edit(f, 'A'); const tx = await staged(f);
  const report = await f.lifecycle.destroy({ policy: 'report' });
  assert.equal(report.unsaved, true); assert.equal(recoveryText(report.recovery), 'a😀Ab');
  assert.equal(f.lifecycle.state.saved, false); tx.abort(); await tick();
  assert.equal(f.locks.held.size, 0); assert.equal(f.db.closed, true);
});

let controller, browser;
check('actual Chromium lifecycle uses leased Rust writer and IndexedDB completion, recovers committed bytes and retains aborted edits', async () => {
  controller = await chromium.launchServer({ headless: true });
  const child = controller.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(), port: null, purpose: 'LOC-1.6 lifecycle integration', log: 'full.log' });
  browser = await chromium.connect(controller.wsEndpoint());
  facts.browser = { version: browser.version() };
  const context = await browser.newContext();
  try {
    await context.route('https://lifecycle.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Lifecycle fixture</title>' });
      if (path.includes('..') || !/^\/(core|web)\//.test(path)) return route.abort();
      const prefix = path.startsWith('/core/') ? '../packages/core/dist/' : '../packages/web/dist/';
      await route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: await readFile(new URL(prefix + path.replace(/^\/(core|web)\//, ''), import.meta.url)) });
    });
    const page = await context.newPage(); await page.goto('https://lifecycle.test/');
    facts.integration = await page.evaluate(async point => {
      const { init } = await import('/core/index.js');
      const { StorageWriter } = await import('/web/storage/writer.js');
      const { UpdateJournal } = await import('/web/storage/journal.js');
      const { LocalStorageLifecycle } = await import('/web/storage/index.js');
      const runtime = await init('/core/wasm/editac_wasm_bg.wasm'); point.bytes = new Uint8Array(point.bytes);
      const writer = await StorageWriter.restore(runtime, navigator.locks, point.identity, point);
      const journal = await UpdateJournal.open(indexedDB, 'lifecycle');
      const lifecycle = new LocalStorageLifecycle(writer, journal);
      const native = IDBDatabase.prototype.transaction;
      const completions = [], waiters = [];
      let abortNext = false;
      IDBDatabase.prototype.transaction = function(...args) {
        const tx = native.apply(this, args);
        if (args[0] === 'updates' && args[1] === 'readwrite') {
          if (abortNext) { abortNext = false; queueMicrotask(() => tx.abort()); }
          else Object.defineProperty(tx, 'oncomplete', { set(fn) {
            tx.addEventListener('complete', () => { const release = () => fn(); completions.push({ release, durability: tx.durability }); waiters.shift()?.(); });
          } });
        }
        return tx;
      };
      const completed = async () => { if (!completions.length) await new Promise(resolve => waiters.push(resolve)); return completions.shift(); };
      const edit = word => {
        const at = writer.engine.anchor(writer.engine.read().visible[0].id, 3, 'right');
        try { lifecycle.commit({ kind: 'text', origin: 'lifecycle:browser', command: { type: 'insert', at, text: word } }); }
        finally { writer.engine.releaseAnchor(at); }
      };
      const states = [];
      const verify = (condition, message) => { if (!condition) throw Error(message); };
      try {
        edit('A'); states.push(lifecycle.state);
        let firstDone = false;
        const barrier = lifecycle.flush({ target: 'local' }).then(() => { firstDone = true; });
        const first = await completed();
        verify(!firstDone && !lifecycle.state.saved, 'enqueue/request success acknowledged before completion callback');
        edit('B'); const second = await completed();
        first.release(); await barrier;
        verify(firstDone && lifecycle.state.pending === 1 && !lifecycle.state.saved, 'later edit extended captured barrier or falsely saved');
        second.release(); await lifecycle.flush({ target: 'local' }); states.push(lifecycle.state);
        verify(lifecycle.state.saved, 'completed set not saved');
        verify(lifecycle.state.strictDurability === (first.durability === 'strict' && second.durability === 'strict' ? 'supported' : 'unavailable'), 'capability does not reflect actual transactions');
        const entries = await journal.read(point.identity);
        const restored = runtime.restoreEngine(point.identity, point, entries.map(e => ({ identity: e.identity, bytes: e.bytes })));
        let persisted; try { persisted = restored.read().visible[0].runs.map(r => r.text).join(''); } finally { restored.dispose(); }
        verify(persisted === 'a😀BAb', 'real committed bytes did not restore');
        abortNext = true; edit('C');
        let error; try { await lifecycle.flush({ target: 'local' }); } catch (e) { error = e; }
        verify(error?.name === 'AbortError' && !lifecycle.state.saved && lifecycle.state.phase === 'error', 'abort did not reject/clear saved');
        states.push({ ...lifecycle.state, error: error.name });
        const recovery = lifecycle.recoveryExport();
        const recovered = runtime.restoreEngine(point.identity, recovery.checkpoint);
        let inMemory; try { inMemory = recovered.read().visible[0].runs.map(r => r.text).join(''); } finally { recovered.dispose(); }
        verify(inMemory === 'a😀CBAb' && recovery.unsavedUpdates.length === 1, 'aborted edit missing from recovery');
        const report = await lifecycle.destroy({ policy: 'report' });
        verify(report.unsaved, 'report falsely claimed aborted edit saved');
        // LockManager releases after the lease callback settles and browser IPC completes.
        const deadline = performance.now() + 3000;
        while ((await navigator.locks.query()).held.length !== 0) {
          verify(performance.now() < deadline, 'live writer lease not released within teardown bound');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return { persisted, inMemory, states, entries: entries.map(e => ({ ...e, bytes: Array.from(e.bytes) })), unsaved: report.unsaved, recovery: { checkpoint: { ...recovery.checkpoint, bytes: Array.from(recovery.checkpoint.bytes) }, unsavedUpdates: recovery.unsavedUpdates.map(e => ({ ...e, bytes: Array.from(e.bytes) })) } };
      } finally { IDBDatabase.prototype.transaction = native; }
    }, serial(initial));
  } finally { await context.close(); }
});
check('actual IndexedDB recovery replays acknowledged journal bytes beyond the JSON request limit without compaction', async () => {
  const owned = await chromium.launchServer({ headless: true });
  const child = owned.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(), port: null,
    purpose: 'NPR-1.1 binary journal recovery integration', log: 'full.log' });
  let connected;
  try {
    connected = await chromium.connect(owned.wsEndpoint());
    const context = await connected.newContext();
    await context.route('https://large-journal.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="importmap">{"imports":{"@edit-ac/core":"/core/index.js"}}</script>' });
      if (path.includes('..') || !/^\/(core|web)\//.test(path)) return route.abort();
      const prefix = path.startsWith('/core/') ? '../packages/core/dist/' : '../packages/web/dist/';
      await route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        body: await readFile(new URL(prefix + path.replace(/^\/(core|web)\//, ''), import.meta.url)) });
    });
    const page = await context.newPage(); await page.goto('https://large-journal.test/');
    const result = await page.evaluate(async () => {
      const { init } = await import('/core/index.js');
      const { recoverLocalDocument } = await import('/web/entry.js');
      const { CheckpointStorage } = await import('/web/storage/checkpoint.js');
      const { UpdateJournal } = await import('/web/storage/journal.js');
      const assetUrl = '/core/wasm/editac_wasm_bg.wasm', databaseName = 'full-binary-journal';
      const runtime = await init(assetUrl);
      const initial = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: Array.from({ length: 5 }, () => ({ text: 'base' })) });
      const point = initial.checkpoint(), identity = point.identity; initial.dispose();
      const checkpoints = await CheckpointStorage.open(indexedDB, databaseName);
      try { await checkpoints.publish(point, []); } finally { checkpoints.close(); }
      const options = { assetUrl, databaseName, identity, indexedDB, locks: navigator.locks };
      let session = await recoverLocalDocument(options);
      try {
        const engine = session.writer.engine, blockIds = engine.read().visible.map(node => node.id);
        for (const id of blockIds) {
          const at = engine.anchor(id, 4, 'right');
          try {
            const committed = session.storage.commit({ kind: 'text', origin: 'regression:large-journal', command: { type: 'insert', at, text: 'x'.repeat(120000) } });
            if (committed.caret) engine.releaseAnchor(committed.caret);
          } finally { engine.releaseAnchor(at); }
        }
        await session.storage.flush({ target: 'local' });
        const before = JSON.stringify(engine.read().visible), vector = JSON.stringify([...engine.stateVector()]);
        const journal = await UpdateJournal.open(indexedDB, databaseName);
        let entries;
        try { entries = await journal.read(identity); } finally { journal.close(); }
        const ids = entries.map(entry => entry.updateId), rawBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
        const legacyJSONBytes = new TextEncoder().encode(JSON.stringify(entries.map(entry => ({ identity: entry.identity, bytes: [...entry.bytes] })))).length;
        await session.storage.destroy({ policy: 'flush' }); session = undefined;
        session = await recoverLocalDocument(options);
        const restored = session.writer.engine;
        const retainedJournal = await UpdateJournal.open(indexedDB, databaseName);
        let retained;
        try { retained = await retainedJournal.read(identity); } finally { retainedJournal.close(); }
        return { rawBytes, legacyJSONBytes, entries: entries.length, exactText: JSON.stringify(restored.read().visible) === before,
          exactVector: JSON.stringify([...restored.stateVector()]) === vector, acknowledged: JSON.stringify(retained.map(entry => entry.updateId)) === JSON.stringify(ids) };
      } finally { if (session) await session.storage.destroy({ policy: 'flush' }); }
    });
    facts.largeJournalRecovery = result;
    assert.ok(result.legacyJSONBytes > 2 * 1024 * 1024);
    assert.ok(result.rawBytes < 2 * 1024 * 1024);
    assert.equal(result.entries, 5); assert.equal(result.exactText, true);
    assert.equal(result.exactVector, true); assert.equal(result.acknowledged, true);
    await context.close();
  } finally {
    await connected?.close(); await owned.close();
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  }
});

after(async () => {
  try { await browser?.close(); }
  finally {
    await controller?.close();
    facts.teardown = { browserClosed: !browser?.isConnected(), browserProcessExited: !controller || controller.process().exitCode !== null, fixtureServersStarted: 0 };
    await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
    if (!process.env.EDITAC_LIFECYCLE_OUTPUT && facts.cases.every(c => c.passed)) await rm(output, { recursive: true });
  }
});
