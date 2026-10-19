// BPA-1.1: public owner + real Rust/WASM + deterministic transaction boundary.
// Packed public-only, real IndexedDB three-browser qualification belongs to BPA-1.2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { init } from '../packages/core/dist/index.js';
import { openEditorStorage, CheckpointStorage, WebHistoryStore, HistoryRestorer } from '../packages/web/dist/index.js';
import { CheckpointIndexedDB } from './helpers/checkpoint-storage.mjs';
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const assetUrl = `data:application/wasm;base64,${wasm.toString('base64')}`;
const runtime = await init(assetUrl);
const tick = () => new Promise(resolve => setImmediate(resolve));
class Locks {
  held = new Set();
  async request(name, options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
let serial = 0;
// changedNodes/touchedRanges describe the last projection delta, not document state;
// prepare may refresh them without changing bytes, revision or semantic content.
const snapshot = e => { const { changedNodes, touchedRanges, ...document } = e.read(); return document; };
const texts = e => e.read().visible.map(n => n.runs.map(r => r.text).join(''));
const request = (e, text) => ({ kind: 'editor', origin: 'prepared-owner-test', commands: [
  { type: 'replaceAt', owner: e.read().visible[0].id, from: 0, to: texts(e)[0].length, text },
] });
async function complete(db, operation) {
  const pending = operation();
  const tx = await db.nextWrite();
  await tick(); tx.complete(); await pending;
}
async function setup() {
  const suffix = String(++serial).padStart(12, '0');
  const seed = runtime.createEngine({ profile: 'v5', documentId: `97000000-0000-4000-8000-${suffix}`,
    epoch: `98000000-0000-4000-8000-${suffix}`, nodes: [{ text: 'before 😀' }, { text: 'neighbor' }] });
  const checkpoint = seed.checkpoint(); seed.dispose();
  const db = new CheckpointIndexedDB(), locks = new Locks(), databaseName = `prepared-owner-${serial}`;
  const disk = await CheckpointStorage.open(db, databaseName);
  await complete(db, () => disk.publish(checkpoint, [])); disk.close();
  const options = { assetUrl, databaseName, identity: checkpoint.identity, indexedDB: db, locks };
  const owner = await openEditorStorage(options), e = owner.engine;
  e.history({ type: 'clear' });
  const store = new WebHistoryStore(), access = () => ({ scope: { identity: e.read().identity, moduleProfile: 'builtin-v5' } });
  const permission = { readonly: false, recoveryRequired: false }; let releases = 0;
  const patches = [], sub = e.subscribe({ type: 'all' }, p => patches.push(p));
  const restorer = new HistoryRestorer(store, {
    engine: { ...e, releasePlan: plan => { releases++; e.releasePlan(plan); } },
    commit: owner.commitPrepared, writable: () => !permission.readonly && !permission.recoveryRequired,
  }, access);
  return { db, locks, options, owner, e, store, access, restorer, patches,
    get releases() { return releases; }, deny(policy) { if (policy === 'recovery') permission.recoveryRequired = true; else permission.readonly = true; },
    async close() { sub.dispose(); await owner.destroy({ policy: 'report' }); await tick(); assert.equal(locks.held.size, 0); } };
}
function oracle(f) {
  return { snapshot: snapshot(f.e), checkpoint: f.e.checkpoint(), vector: f.e.stateVector(),
    update: f.e.encodeUpdate(), history: f.e.history({ type: 'state' }),
    patches: structuredClone(f.patches), journal: structuredClone([...f.db.stores.updates.values()]),
    transactions: f.db.transactions.length };
}
async function edited(f) {
  const old = await f.store.capture(f.e, f.access(), 'Before');
  await complete(f.db, () => { f.owner.commit(request(f.e, 'current β')); return f.owner.flush({ target: 'local' }); });
  return old;
}
test('public prepared restore is one journaled edit on the same replica, with isolated undo/redo and reopen', async () => {
  const f = await setup(); let destroyed = false;
  try {
    const live = f.e, old = await edited(f), before = oracle(f), identity = f.e.read().identity;
    // Discarding a preview is cancellation; it neither admits nor retains a plan.
    f.restorer.preview(old); assert.deepEqual(oracle(f), before); assert.equal(f.releases, 0);
    const preview = f.restorer.preview(old); assert.ok(preview.changes); assert.deepEqual(oracle(f), before);
    const result = f.restorer.apply(preview); assert.equal(result.kind, 'applied'); assert.equal(f.releases, 1);
    assert.equal(f.owner.engine, live); assert.deepEqual(f.e.read().identity, identity);
    assert.deepEqual(f.e.read().visible.map(n => n.id), before.snapshot.visible.map(n => n.id));
    assert.deepEqual(texts(f.e), ['before 😀', 'neighbor']); assert.ok(f.e.read().revision > before.snapshot.revision);
    const updates = f.patches.filter(p => p.update); assert.equal(updates.length, 2);
    assert.equal(updates[1].origin, 'editac:local:history-restore');
    await complete(f.db, () => f.owner.flush({ target: 'local' }));
    const journal = [...f.db.stores.updates.values()]; assert.equal(journal.length, 2);
    assert.equal(journal[1].origin, 'editac:local:history-restore');
    assert.deepEqual(journal[1].bytes, updates[1].update.bytes);
    const accepted = oracle(f);
    assert.equal(f.restorer.apply(preview).reason, 'stale'); assert.deepEqual(oracle(f), accepted);
    await complete(f.db, () => { f.e.history({ type: 'undo' }); return f.owner.flush({ target: 'local' }); });
    assert.deepEqual(texts(f.e), ['current β', 'neighbor']);
    await complete(f.db, () => { f.e.history({ type: 'redo' }); return f.owner.flush({ target: 'local' }); });
    assert.deepEqual(texts(f.e), ['before 😀', 'neighbor']);
    await f.close(); destroyed = true;
    const reopened = await openEditorStorage(f.options);
    try { assert.deepEqual(texts(reopened.engine), ['before 😀', 'neighbor']); assert.deepEqual(reopened.engine.read().identity, identity); }
    finally { await reopened.destroy({ policy: 'flush' }); }
  } finally { if (!destroyed) await f.close(); }
});

test('bound public prepared admission rejects stale, foreign, replayed and released tokens without document/history/journal changes', async () => {
  const f = await setup(), other = await setup();
  try {
    const stale = f.e.prepare(request(f.e, 'stale'));
    await complete(f.db, () => { f.owner.commit(request(f.e, 'newer')); return f.owner.flush({ target: 'local' }); });
    let before = oracle(f);
    try { assert.throws(() => f.owner.commitPrepared(stale)); assert.deepEqual(oracle(f), before); }
    finally { f.e.releasePlan(stale); }
    const foreign = other.e.prepare(request(other.e, 'foreign'));
    try { assert.throws(() => f.owner.commitPrepared(foreign)); assert.deepEqual(oracle(f), before); }
    finally { other.e.releasePlan(foreign); }
    const plan = f.e.prepare(request(f.e, 'accepted'));
    // Detached binding must still use the original owner/lifecycle.
    const admit = f.owner.commitPrepared;
    try {
      assert.equal(admit(plan).revision, f.e.read().revision);
      await complete(f.db, () => f.owner.flush({ target: 'local' })); before = oracle(f);
      assert.throws(() => admit(plan)); assert.deepEqual(oracle(f), before);
    } finally { f.e.releasePlan(plan); }
    const released = f.e.prepare(request(f.e, 'released')); f.e.releasePlan(released);
    assert.throws(() => admit(released)); assert.deepEqual(oracle(f), before);
  } finally { await f.close(); await other.close(); }
});

for (const policy of ['readonly', 'recovery']) test(`host ${policy} denial between preview and apply preserves all oracles`, async () => {
  const f = await setup();
  try {
    const old = await edited(f), preview = f.restorer.preview(old), before = oracle(f); f.deny(policy);
    assert.equal(f.restorer.apply(preview).reason, 'readonly'); assert.equal(f.releases, 0);
    assert.deepEqual(oracle(f), before); assert.equal(f.restorer.preview(old).reason, 'readonly');
    assert.deepEqual(oracle(f), before);
  } finally { await f.close(); }
});

test('stale preview and host admission rejection release only caller-owned plans, preserving content/journal', async () => {
  const f = await setup();
  try {
    const old = await edited(f), preview = f.restorer.preview(old);
    await complete(f.db, () => { f.owner.commit(request(f.e, 'intervening')); return f.owner.flush({ target: 'local' }); });
    const before = oracle(f); assert.equal(f.restorer.apply(preview).reason, 'stale'); assert.deepEqual(oracle(f), before);
    assert.equal(f.releases, 0);
    let releases = 0;
    const denied = new HistoryRestorer(f.store, { engine: { ...f.e, releasePlan: p => { releases++; f.e.releasePlan(p); } },
      writable: () => true, commit: () => { throw Error('host recovery gate'); } }, f.access);
    const result = denied.apply(denied.preview(old)); assert.equal(result.reason, 'rejected'); assert.equal(releases, 1);
    assert.deepEqual(snapshot(f.e), before.snapshot); assert.deepEqual(f.e.checkpoint(), before.checkpoint);
    assert.deepEqual([...f.db.stores.updates.values()], before.journal);
    assert.equal(f.patches.filter(p => p.update).length, before.patches.filter(p => p.update).length);
  } finally { await f.close(); }
});

test('closing and destroyed owner reject prepared admission without adding journal writes', async () => {
  const f = await setup();
  const plan = f.e.prepare(request(f.e, 'forbidden'));
  // A pending accepted edit holds destroy(flush) in the closing state.
  f.owner.commit(request(f.e, 'pending'));
  const before = snapshot(f.e), closing = f.owner.destroy({ policy: 'flush' });
  assert.throws(() => f.owner.commitPrepared(plan), /closing/); assert.deepEqual(snapshot(f.e), before);
  f.e.releasePlan(plan);
  const tx = await f.db.nextWrite(); await tick(); tx.complete(); await closing; await tick();
  const journal = structuredClone([...f.db.stores.updates.values()]), count = f.db.transactions.length;
  assert.throws(() => f.owner.commitPrepared(plan), /destroyed/);
  assert.deepEqual([...f.db.stores.updates.values()], journal); assert.equal(f.db.transactions.length, count); assert.equal(f.locks.held.size, 0);
});

test('public declarations compile the supported owner/restorer recipe and keep request/token types distinct', async () => {
  const directory = await mkdtemp(new URL('../.bpa-types-', import.meta.url));
  try {
    await writeFile(`${directory}/consumer.mts`, `
      import {openEditorStorage, WebHistoryStore, HistoryRestorer} from '@edit-ac/web';
      import type {PlanToken, PrepareRequest, CommitResult} from '@edit-ac/core';
      declare const options: Parameters<typeof openEditorStorage>[0], hostWritable:boolean, moduleProfile:string;
      const owner=await openEditorStorage(options), engine=owner.engine;
      const access=()=>({scope:{identity:engine.read().identity,moduleProfile}});
      const store=new WebHistoryStore();
      const restorer=new HistoryRestorer(store,{engine,writable:()=>hostWritable,commit:owner.commitPrepared},access);
      declare const request:PrepareRequest, plan:PlanToken;
      const result:CommitResult=owner.commit(request);
      try { const prepared:CommitResult=owner.commitPrepared(plan); } finally {engine.releasePlan(plan);}
      // @ts-expect-error request commit must not accept opaque plans
      owner.commit(plan);
      // @ts-expect-error prepared admission must not accept requests
      owner.commitPrepared(request);
      await owner.flush({target:'local'});
      await owner.flush({target:'local',retryFailed:true});
    `);
    const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--lib', 'ES2022,DOM', `${directory}/consumer.mts`], { encoding: 'utf8' });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public recovery failure refuses an owner without rewriting corrupt checkpoints or journal', async () => {
  const f = await setup(); await f.close();
  const publication = [...f.db.stores.checkpoints.values()][0];
  publication.latest.checkpoint.bytes[0] ^= 1;
  const before = structuredClone({ checkpoints: [...f.db.stores.checkpoints], updates: [...f.db.stores.updates] });
  const writes = f.db.transactions.filter(t => t.mode === 'readwrite').length;
  await assert.rejects(openEditorStorage(f.options), /checkpoint|recovery/i);
  assert.deepEqual({ checkpoints: [...f.db.stores.checkpoints], updates: [...f.db.stores.updates] }, before);
  assert.equal(f.db.transactions.filter(t => t.mode === 'readwrite').length, writes);
  assert.equal(f.locks.held.size, 0);
});
