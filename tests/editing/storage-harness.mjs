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

/** C11's owning setup, with the shared driver routed through the storage host. */
export async function mixedStorageHarness(runtime, initial) {
  const seed = new SemanticDriver(runtime, initial);
  let checkpoint;
  try { checkpoint = seed.engine.checkpoint(); } finally { seed.dispose(); }
  const locks = new Locks(), db = new PreparedIndexedDB();
  const writer = await StorageWriter.restore(runtime, locks, checkpoint.identity, checkpoint);
  let journal, lifecycle, subscription, stop;
  try {
    journal = await UpdateJournal.open(db);
    let appends = 0;
    const append = journal.append.bind(journal);
    journal.append = update => { appends++; return append(update); };
    lifecycle = new LocalStorageLifecycle(writer, journal);
    const engine = writer.engine, publications = [], completions = [], resolvedResults = [];
    let commitCalls = 0;
    const driver = new SemanticDriver({ ...runtime, createEngine: () => ({ ...engine, commit(plan) {
      const result = lifecycle.commitPrepared(plan); commitCalls++;
      resolvedResults.push({ revision: result.revision, endpoints: [result.selection.anchor, result.selection.focus].map(token => engine.resolve(token)) });
      return result;
    } }) }, initial);
    subscription = engine.subscribe({ type: 'updates' }, patch => publications.push(patch));
    stop = lifecycle.subscribeCommitted((update, commit) => completions.push({ update, commit }));
    return {
      driver, engine, lifecycle, db, checkpoint, publications, completions, resolvedResults,
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
