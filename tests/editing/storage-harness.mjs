import assert from 'node:assert/strict';
import { LocalStorageLifecycle } from '../../packages/web/dist/storage/index.js';
import { StorageWriter } from '../../packages/web/dist/storage/writer.js';
import { UpdateJournal } from '../../packages/web/dist/storage/journal.js';
import { PreparedIndexedDB } from '../helpers/journal-storage.mjs';
import { SemanticDriver } from './semantic-adapter.ts';

export const tick = () => new Promise(resolve => setImmediate(resolve));
class Locks {
  held = new Set();
  async request(name, options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}

/** Seed the declared semantic profile before attaching production storage.
 * Raw-port cases bind their own real tokens; driver cases route commits through
 * the same lifecycle. No fixture setup commit is admitted to the journal.
 */
export async function storageHarness(runtime, initial, { attachDriver = true, checkpoint: suppliedCheckpoint } = {}) {
  let checkpoint = suppliedCheckpoint;
  if (!checkpoint) {
    const seed = new SemanticDriver(runtime, initial);
    try { checkpoint = seed.engine.checkpoint(); } finally { seed.dispose(); }
  }
  assert.ok(!attachDriver || initial, "driver binding requires an authored initial state");
  const locks = new Locks(), db = new PreparedIndexedDB();
  const writer = await StorageWriter.restore(runtime, locks, checkpoint.identity, checkpoint);
  let journal, lifecycle, subscription, stop;
  try {
    journal = await UpdateJournal.open(db);
    let appends = 0;
    const append = journal.append.bind(journal);
    journal.append = update => { appends++; return append(update); };
    lifecycle = new LocalStorageLifecycle(writer, journal);
    const engine = writer.engine, publications = [], completions = [], resolvedResults = [], resolvedCarets = [];
    let commitCalls = 0;
    const commit = plan => {
      const result = lifecycle.commitPrepared(plan); commitCalls++;
      resolvedResults.push({ revision: result.revision, endpoints: result.selection ? [result.selection.anchor, result.selection.focus].map(token => engine.resolve(token)) : null });
      resolvedCarets.push(result.caret ? engine.resolve(result.caret) : null);
      return result;
    };
    const bindingCheckpoint = engine.checkpoint();
    const driver = attachDriver ? new SemanticDriver({ ...runtime, createEngine: () => ({ ...engine, commit }) }, initial, { restored: true }) : undefined;
    subscription = engine.subscribe({ type: 'updates' }, patch => publications.push(patch));
    stop = lifecycle.subscribeCommitted((update, commit) => completions.push({ update, commit }));
    return {
      driver, engine, lifecycle, db, checkpoint, bindingCheckpoint, publications, completions, resolvedResults, resolvedCarets, commit,
      get commitCalls() { return commitCalls; },
      effects: () => ({ publications: publications.length, appends, transactions: db.transactions.length, records: db.records.size, completions: completions.length, pending: lifecycle.state.pending, saved: lifecycle.state.saved, localCommitted: lifecycle.state.localCommitted }),
      async nextTransaction() {
        let deadline;
        return Promise.race([db.nextTransaction(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('journal transaction deadline')), 5000); })]).finally(() => clearTimeout(deadline));
      },
      async close() {
        stop(); subscription.dispose();
        const teardown = await lifecycle.destroy({ policy: 'report' }); await tick();
        assert.equal(locks.held.size, 0); assert.equal(db.closed, true);
        assert.equal(db.waiters.length, 0); assert.equal(lifecycle.observerErrors.length, 0);
        return { unsaved: teardown.unsaved, locks: locks.held.size, journalClosed: db.closed, waiters: db.waiters.length, observerErrors: lifecycle.observerErrors.length };
      },
    };
  } catch (error) {
    stop?.(); subscription?.dispose();
    if (lifecycle) await lifecycle.destroy({ policy: 'report' });
    else { journal?.close(); writer.dispose(); }
    throw error;
  }
}

// Preserve the existing mixed-vector caller contract.
export const mixedStorageHarness = storageHarness;
