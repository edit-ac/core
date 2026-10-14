import assert from 'node:assert/strict';
import { storageHarness, tick } from './storage-harness.mjs';
import { assertRestoredReplica, stateVectorEntries } from './replica-state.mjs';
import { sha256 } from './packed-runtime.mjs';

// Share the existing independently authored G03 oracle. Bind a real checkpoint
// after fixture setup, then observe each local/remote update independently.
export async function selectionStorage(runtime, seed, fact, facts) {
  const storage = await storageHarness(runtime, undefined, { attachDriver: false, checkpoint: seed.checkpoint() });
  const { engine, lifecycle, db, publications, completions } = storage;
  const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const control = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    fact.checkpoints++; fact.controls = (fact.controls ?? 0) + 1; facts.negativeControls.push(`${fact.id}/storage/${name}`);
  };
  // read() drains observer ranges; compare persistent semantic state, as the
  // shared G03 preparation oracle does, while publications stay separate.
  const frozen = () => {
    const { changedNodes, touchedRanges, ...snapshot } = engine.read();
    return { snapshot, vector: [...engine.stateVector()], checkpoint: [...engine.checkpoint().bytes], history: engine.history({ type: 'state' }) };
  };
  let settled = zero;
  fact.storageSteps = [];
  try {
    check([...engine.checkpoint().bytes], [...storage.bindingCheckpoint.bytes]);
    check(engine.read().visible, seed.read().visible); check(storage.effects(), zero);
    check(lifecycle.recoveryExport().unsavedUpdates, []); check(storage.commitCalls, 0);
    control('setup-append', storage.effects(), zero, e => e.appends++);
  } catch (error) { await storage.close(); throw error; }
  storage.settle = async (id, count, operations) => {
    check(publications.map(p => p.operation), operations);
    check(storage.commitCalls, id === 'sentinel' ? 2 : 1);
    check(lifecycle.recoveryExport().unsavedUpdates.length, 1);
    check(lifecycle.recoveryExport().unsavedUpdates[0].bytes, publications[count - 1].update.bytes);
    const tx = await storage.nextTransaction();
    const staged = { ...settled, publications: count, appends: count, transactions: count, pending: 1, saved: false };
    check(storage.effects(), staged);
    const before = frozen(); tx.lookupSuccess(); tx.writeSuccess(); await tick();
    check(storage.effects(), staged); check(frozen(), before);
    let flushed = false;
    const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
    await tick(); check(flushed, false);
    control(`${id}/premature-completion`, storage.effects(), staged, e => e.completions++);
    tx.complete(); await barrier;
    settled = { ...zero, publications: count, appends: count, transactions: count, records: count, completions: count, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
    check(storage.effects(), settled); check(frozen(), before);
    check(tx.entry.bytes, publications[count - 1].update.bytes); check(tx.entry.checksum, sha256(tx.entry.bytes));
    const patch = publications[count - 1];
    check({ identity: tx.entry.identity, writerId: tx.entry.writerId, sequence: tx.entry.sequence, origin: tx.entry.origin }, { identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin: patch.origin });
    check(tx.entry.identity, storage.checkpoint.identity); check(lifecycle.state.strictDurability, 'supported');
    check(completions[count - 1].update.bytes, tx.entry.bytes); check(completions[count - 1].commit, settled.localCommitted);
    check([...db.records.values()].at(-1), tx.entry); check(lifecycle.recoveryExport().unsavedUpdates, []);
    check([...lifecycle.recoveryExport().checkpoint.bytes], [...engine.checkpoint().bytes]);
    const entries = [...db.records.values()];
    const restored = runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, entries.map(e => ({ identity: e.identity, bytes: e.bytes })));
    try { check(restored.read().visible, engine.read().visible); assertRestoredReplica(restored, engine); fact.checkpoints++; }
    finally { restored.dispose(); }
    const vector = stateVectorEntries(engine.stateVector());
    control(`${id}/replay-client`, vector, vector, e => e[0].client = 'missing');
    control(`${id}/replay-clock`, vector, vector, e => e[0].clock = String(BigInt(e[0].clock) + 1n));
    for (const key of ['publications', 'appends', 'transactions', 'records', 'completions', 'pending']) control(`${id}/${key}`, storage.effects(), settled, e => e[key]++);
    for (const [name, corrupt] of [
      ['bytes', e => e.bytes[0] ^= 1], ['sequence', e => e.sequence++], ['origin', e => e.origin = 'invalid'],
      ['checksum', e => e.checksum = 'invalid'], ['identity', e => e.identity.documentId = 'missing'], ['writer', e => e.writerId = 'missing'],
    ]) control(`${id}/journal-${name}`, tx.entry, tx.entry, corrupt);
    fact.storageSteps.push({ id, operation: patch.operation, localCommits: storage.commitCalls, effects: storage.effects() });
  };
  return storage;
}
