import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { semanticProfile } from './semantic-adapter.ts';
import { assertUnicodeCell, unicodeInitial } from './unicode-harness.mjs';
import { assertRestoredReplica, stateVectorEntries } from './replica-state.mjs';
import { storageHarness, tick } from './storage-harness.mjs';

const vectors = JSON.parse(await readFile('fixtures/editing-failures/semantic-vectors.json', 'utf8')).graphemes;
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C15', guards: ['G06', 'G02'], layer: 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB', fixtureHashes: loadSuite().hashes, profile: { ...semanticProfile, persistence: 'actual journal enqueue/local completion; prepared transaction delivery', clock: 'fixed 0; fresh restored profile and cleared history', biases: ['left', 'right'], fixtureBinding: 'seed before attachment; no setup commits' }, cases: [], negativeControls: [], exclusions: ['No native gesture/device or whole-version Unicode conformance', 'No history bookmarks or native editor-local pending state', 'Combining-interior and boundary are adapter dispositions without a prepared result', 'Accepted wiring probes are separately attributed from rejected/no-op Unicode actions'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 10); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); pack.facts.process.launcher = 'node --test tests/editing/unicode-storage.test.mjs'; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/unicode-storage.test.mjs', 'tests/editing/unicode-harness.mjs', 'tests/editing/unicode.test.mjs', 'tests/editing/replica-state.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'fixtures/editing-failures/semantic-vectors.json', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'unicode-storage-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});

for (const v of vectors) for (const bias of ['left', 'right']) test(`packed/storage:G06-${v.id}/${bias}`, { timeout: 20000 }, async () => {
  const fact = { id: `G06-${v.id}/${bias}`, status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
  const initial = unicodeInitial(v, bias), storage = await storageHarness(pack.runtime, initial);
  const { driver, engine, lifecycle, db, publications, completions } = storage;
  const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const control = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    facts.negativeControls.push(`${fact.id}/${name}`); fact.controls++; fact.checkpoints++;
  };
  const results = () => storage.resolvedResults.map(r => ({ revision: r.revision, endpoints: r.endpoints?.map(p => { assert.equal(p.type, 'position'); return { node: p.node, offset: p.offset, bias: p.bias }; }) ?? null }));
  try {
    check([...engine.checkpoint().bytes], [...storage.bindingCheckpoint.bytes]);
    check(driver.snapshot(), initial); check(storage.effects(), zero);
    control('fixture-setup-append', storage.effects(), zero, e => e.appends++);
    const { applied, old } = assertUnicodeCell(driver, () => ({ commits: storage.commitCalls, publications: publications.map(p => p.operation), results: results() }), v, bias, fact, facts);
    fact.unicodeOutcome = applied ? 'applied' : v.rejected ? 'rejected' : 'no-op';
    if (!applied) {
      await tick(); await tick();
      check(storage.effects(), zero); check(storage.commitCalls, 0); check(storage.resolvedResults, []);
      check(lifecycle.recoveryExport().unsavedUpdates, []);
      check([...lifecycle.recoveryExport().checkpoint.bytes], [...old.checkpoint]);
      await lifecycle.flush({ target: 'local' }); await tick();
      check(storage.effects(), zero); check(driver.frozen(), old);
      for (const key of ['publications', 'appends', 'transactions', 'records', 'completions', 'pending']) control(`zero-${key}`, storage.effects(), zero, e => e[key]++);
      control('zero-local-completion', storage.effects(), zero, e => e.localCommitted = { state: 'localCommitted' });
      control('zero-recovery', lifecycle.recoveryExport().unsavedUpdates, [], e => e.push({ bytes: [1] }));
      fact.noncommittingEffects = storage.effects();
      const unchanged = pack.runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, []);
      try { check(unchanged.read().visible, engine.read().visible); assertRestoredReplica(unchanged, engine); fact.checkpoints++; }
      finally { unchanged.dispose(); }
      // Independently authored insertion at a valid UTF-16 boundary proves that
      // every zero-effect cell has a live journal/completion/recovery observer.
      driver.act({ type: 'setSelection', selection: { ...initial.selection, anchor: { block: 'p1', offset: 0 }, focus: { block: 'p1', offset: 0 } } });
      const probe = driver.act({ type: 'insertText', text: 'X' });
      check(probe.outcome, 'applied');
      const expected = structuredClone(initial); expected.blocks[0].text = 'X' + v.text;
      expected.selection.anchor.offset = 1; expected.selection.focus.offset = 1;
      check(driver.snapshot(), expected);
      check(results(), [{ revision: old.snapshot.revision + 1, endpoints: [0, 1].map(() => ({ node: engine.read().visible[0].id, offset: 1, bias })) }]);
      fact.wiringProbe = 'same-owner insert X at UTF-16 offset 0, result offset 1';
    }
    check(storage.commitCalls, 1); check(publications.map(p => p.operation), ['Editor']);
    check(lifecycle.recoveryExport().unsavedUpdates.length, 1);
    check(lifecycle.recoveryExport().unsavedUpdates[0].bytes, publications[0].update.bytes);
    const tx = await storage.nextTransaction();
    const staged = { ...zero, publications: 1, appends: 1, transactions: 1, pending: 1 };
    check(storage.effects(), staged);
    const semantic = driver.frozen();
    tx.lookupSuccess(); tx.writeSuccess(); await tick();
    check(storage.effects(), staged); check(driver.frozen(), semantic);
    let flushed = false;
    const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
    await tick(); check(flushed, false);
    control('premature-completion', storage.effects(), staged, e => e.completions++);
    tx.complete(); await barrier;
    const completed = { ...zero, publications: 1, appends: 1, transactions: 1, records: 1, completions: 1, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
    check(storage.effects(), completed); check(driver.frozen(), semantic);
    check(tx.entry.bytes, publications[0].update.bytes); check(tx.entry.checksum, sha256(tx.entry.bytes));
    check(tx.entry.identity, storage.checkpoint.identity);
    const patch = publications[0];
    check({ identity: tx.entry.identity, writerId: tx.entry.writerId, sequence: tx.entry.sequence, origin: tx.entry.origin }, { identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin: patch.origin });
    check(lifecycle.state.strictDurability, 'supported');
    check(completions[0].update.bytes, tx.entry.bytes); check(completions[0].commit, completed.localCommitted);
    check([...db.records.values()], [tx.entry]); check(lifecycle.recoveryExport().unsavedUpdates, []);
    check([...lifecycle.recoveryExport().checkpoint.bytes], [...engine.checkpoint().bytes]);
    const restored = pack.runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, [{ identity: tx.entry.identity, bytes: tx.entry.bytes }]);
    try { check(restored.read().visible, engine.read().visible); assertRestoredReplica(restored, engine); fact.checkpoints++; }
    finally { restored.dispose(); }
    const vector = stateVectorEntries(engine.stateVector());
    control('replay-client', vector, vector, e => e[0].client = 'missing');
    control('replay-clock', vector, vector, e => e[0].clock = String(BigInt(e[0].clock) + 1n));
    for (const key of ['appends', 'transactions', 'records', 'completions']) control(`completed-${key}`, storage.effects(), completed, e => e[key]++);
    for (const [name, corrupt] of [
      ['bytes', e => e.bytes[0] ^= 1], ['sequence', e => e.sequence++], ['origin', e => e.origin = 'invalid'],
      ['checksum', e => e.checksum = 'invalid'], ['identity', e => e.identity.documentId = 'missing'], ['writer', e => e.writerId = 'missing'],
    ]) control(`journal-${name}`, tx.entry, tx.entry, corrupt);
    fact.storageEffects = storage.effects(); fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
});
