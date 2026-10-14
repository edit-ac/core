import assert from 'node:assert/strict';
import { assertRestoredReplica, stateVectorEntries } from './replica-state.mjs';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { semanticProfile } from './semantic-adapter.ts';
import { assertPendingSequence } from './pending-harness.mjs';
import { storageHarness, tick } from './storage-harness.mjs';

const vectors = JSON.parse(await readFile('fixtures/editing-failures/pending-vectors.json', 'utf8')).sequences;
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C14', guards: ['G02', 'G04'], layer: 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB', fixtureHashes: loadSuite().hashes, profile: { ...semanticProfile, persistence: 'actual journal enqueue/local completion; prepared transaction delivery', clock: 'driver fixed 0; default isolated history groups; fresh restored profile', fixtureBinding: 'seed profile before attachment; bind without setup commits', pending: 'editor-local; null/empty/nonempty independent checkpoints' }, cases: [], negativeControls: [], exclusions: ['No native editor-local pending state', 'No history bookmarks or alignment/atom support', 'No real-browser/device storage or gesture evidence'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 2); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); pack.facts.process.launcher = 'node --test tests/editing/pending-storage.test.mjs'; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/pending-storage.test.mjs', 'tests/editing/replica-state.mjs', 'tests/editing/pending.test.mjs', 'tests/editing/pending-harness.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'fixtures/editing-failures/pending-vectors.json', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'pending-storage-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});

for (const v of vectors) test(`packed/storage:G02-G04-${v.id}`, { timeout: 20000 }, async () => {
  const fact = { id: v.id, status: 'running', checkpoints: 0, controls: 0, steps: [], storageSteps: [] }; facts.cases.push(fact);
  const storage = await storageHarness(pack.runtime, v.initial);
  const { driver, engine, lifecycle, db, publications, completions } = storage;
  const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const control = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    facts.negativeControls.push(`${v.id}/${name}`); fact.controls++; fact.checkpoints++;
  };
  const point = p => p ? { node: p.node, offset: p.offset, bias: p.bias } : null;
  const committed = () => storage.resolvedResults.map((r, i) => ({ revision: r.revision, endpoints: r.endpoints?.map(point) ?? null, caret: point(storage.resolvedCarets[i]) }));
  const eventNames = () => publications.map(p => p.operation);
  let settled = zero;
  try {
    // Binding must not change the restored profile, even for initial code/marks.
    check([...engine.checkpoint().bytes], [...storage.bindingCheckpoint.bytes]);
    control('binding-checkpoint', [...engine.checkpoint().bytes], [...storage.bindingCheckpoint.bytes], e => e[0] ^= 1);
    check(driver.snapshot(), v.initial); check(storage.effects(), zero);
    check(storage.commitCalls, 0); check(committed(), []);
    check(lifecycle.recoveryExport().unsavedUpdates, []);
    control('fixture-setup-append', storage.effects(), zero, e => e.appends++);
    await assertPendingSequence(driver, committed, eventNames, v, fact, facts, async ({ step, count }) => {
      const delta = step.expect.effects.localCommits;
      if (!delta) {
        await tick(); await tick();
        check(storage.effects(), settled); check(storage.commitCalls, count);
        check(lifecycle.recoveryExport().unsavedUpdates, []);
        const beforeFlush = driver.frozen();
        await lifecycle.flush({ target: 'local' }); await tick();
        check(storage.effects(), settled); check(driver.frozen(), beforeFlush);
        for (const key of ['appends', 'transactions', 'records', 'completions', 'pending']) control(`${step.id}/zero-${key}`, storage.effects(), settled, e => e[key]++);
        control(`${step.id}/zero-recovery`, lifecycle.recoveryExport().unsavedUpdates, [], e => e.push({ bytes: [1] }));
        fact.storageSteps.push({ id: step.id, storage: 'zero new journal/completion/recovery effects', effects: storage.effects() });
        return;
      }
      check(storage.commitCalls, count);
      check(lifecycle.recoveryExport().unsavedUpdates.length, 1);
      check(lifecycle.recoveryExport().unsavedUpdates[0].bytes, publications[count - 1].update.bytes);
      const tx = await storage.nextTransaction();
      const staged = { ...settled, publications: count, appends: count, transactions: count, pending: 1, saved: false };
      check(storage.effects(), staged);
      const semantic = driver.frozen();
      tx.lookupSuccess(); tx.writeSuccess(); await tick();
      check(storage.effects(), staged); check(driver.frozen(), semantic);
      let flushed = false;
      const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
      await tick(); check(flushed, false);
      control(`${step.id}/premature-completion`, storage.effects(), staged, e => e.completions++);
      tx.complete(); await barrier;
      settled = { ...zero, publications: count, appends: count, transactions: count, records: count, completions: count, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
      check(storage.effects(), settled); check(driver.frozen(), semantic);
      check(tx.entry.bytes, publications[count - 1].update.bytes); check(tx.entry.checksum, sha256(tx.entry.bytes));
      check(tx.entry.identity, storage.checkpoint.identity);
      const patch = publications[count - 1];
      check({ identity: tx.entry.identity, writerId: tx.entry.writerId, sequence: tx.entry.sequence, origin: tx.entry.origin }, { identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin: patch.origin });
      check(lifecycle.state.strictDurability, 'supported');
      check(completions[count - 1].update.bytes, tx.entry.bytes); check(completions[count - 1].commit, settled.localCommitted);
      check(db.records.size, count); check([...db.records.values()].at(-1), tx.entry);
      check(lifecycle.recoveryExport().unsavedUpdates, []);
      check([...lifecycle.recoveryExport().checkpoint.bytes], [...engine.checkpoint().bytes]);
      // Replay the seed plus every actually persisted update, never expected text.
      const updates = [...db.records.values()].map(entry => ({ identity: entry.identity, bytes: entry.bytes }));
      const restored = pack.runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, updates);
      try { check(restored.read().visible, engine.read().visible); assertRestoredReplica(restored, engine); fact.checkpoints++; }
      finally { restored.dispose(); }
      const vector = stateVectorEntries(engine.stateVector());
      control(`${step.id}/replay-client`, vector, vector, e => e[0].client = 'missing');
      control(`${step.id}/replay-clock`, vector, vector, e => e[0].clock = String(BigInt(e[0].clock) + 1n));
      for (const key of ['appends', 'transactions', 'records', 'completions']) control(`${step.id}/completed-${key}`, storage.effects(), settled, e => e[key]++);
      control(`${step.id}/journal-bytes`, tx.entry, tx.entry, e => e.bytes[0] ^= 1);
      control(`${step.id}/journal-sequence`, tx.entry, tx.entry, e => e.sequence++);
      control(`${step.id}/journal-origin`, tx.entry, tx.entry, e => e.origin = 'invalid');
      control(`${step.id}/journal-checksum`, tx.entry, tx.entry, e => e.checksum = 'invalid');
      control(`${step.id}/journal-identity`, tx.entry, tx.entry, e => e.identity.documentId = 'missing');
      fact.storageSteps.push({ id: step.id, storage: 'one journal append/local completion; cumulative replay', effects: storage.effects() });
    });
    check(fact.steps.length, v.id === 'context-disable-reject-revisit' ? 6 : 10);
    check(storage.commitCalls, v.id === 'context-disable-reject-revisit' ? 2 : 4);
    fact.committedOperations = storage.commitCalls;
    fact.storageEffects = storage.effects(); fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
});
