import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { semanticProfile } from './semantic-adapter.ts';
import { mixedStorageHarness, tick } from './storage-harness.mjs';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/mixed-batch-vectors.json', 'utf8'));
const suite = loadSuite();
const recipe = suite.recipes.find(r => r.id === vectors.recipe);
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: vectors.parent, child: 'RGS-1.2-C12', layer: 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB transport', fixtureHashes: suite.hashes, cases: [], negativeControls: [], profile: { ...semanticProfile, persistence: 'production storage lifecycle; prepared IndexedDB transaction delivery', clock: 'fixed driver clock 0; fresh cleared history', batch: 'ordered staged UTF-16 operations; explicit range result; pending preserved across explicit batch', pending: 'editor-local null/empty/nonempty; not native engine state' }, exclusions: ['No real-browser/device storage evidence', 'No history bookmark, browser/device or full-parent qualification'] };
let pack;
before(async () => {
  assert.ok(output); assert.equal(vectors.cases.length, 4); assert.equal(vectors.pendingVariants.length, 3);
  assert.equal(vectors.invalidStagedUtf16Offset, 4);
  assert.deepEqual(vectors.cases.map(v => [v.direction, v.bias, v.selection]), [['forward', 'left', [1, 3]], ['forward', 'right', [1, 3]], ['backward', 'left', [3, 1]], ['backward', 'right', [3, 1]]]);
  assert.deepEqual(recipe.requires, ['compound-edit', 'atomic-rejection']);
  assert.equal(recipe.steps[0].action.operations.at(-1).block, vectors.invalidFinalOwner);
  assert.equal(recipe.steps[1].action.operations.at(-1).type, 'applyMark');
  pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL);
  pack.facts.process.launcher = 'node --test tests/editing/mixed-storage.test.mjs';
});
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/mixed-storage.test.mjs', 'tests/editing/storage-harness.mjs', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'fixtures/editing-failures/mixed-batch-vectors.json', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'mixed-storage-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const v of vectors.cases) for (const pending of vectors.pendingVariants) test(`packed/storage:${v.id}/pending-${pending.id}`, async () => {
  const fact = { id: `${v.id}/pending-${pending.id}`, nativeVector: v.id, status: 'running', checkpoints: 0 }; facts.cases.push(fact);
  const affinity = v.bias === 'left' ? 'backward' : 'forward';
  const initial = structuredClone(recipe.initial); initial.blocks[0].text = vectors.initialText; initial.selection.affinity = affinity; initial.pendingMarks = pending.marks;
  const storage = await mixedStorageHarness(pack.runtime, initial);
  const { driver, engine, lifecycle, db, publications, completions, resolvedResults } = storage;
  const events = () => publications.map(p => p.operation);
  const effects = storage.effects;
  const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const falsify = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    facts.negativeControls.push(`${fact.id}/${name}`); fact.checkpoints++;
  };
  try {
    const original = engine.read().visible[0], owner = original.id;
    const before = driver.frozen();
    check(effects(), zero);
    const observeRejection = () => ({ frozen: driver.frozen(), publications: events(), commitCalls: storage.commitCalls, results: [...resolvedResults] });
    const expectedRejection = { frozen: before, publications: [], commitCalls: 0, results: [] };
    const invalid = { type: 'applyBatch', operations: structuredClone(vectors.operations) }; invalid.operations.at(-1).block = vectors.invalidFinalOwner;
    // After replace/replace staging, 😀 occupies UTF-16 [3,5). Offset 4
    // is invalid even though it was a valid boundary in the entry document.
    const invalidMark = { type: 'applyBatch', operations: structuredClone(vectors.operations) };
    invalidMark.operations.at(-1).from = vectors.invalidStagedUtf16Offset;
    invalidMark.operations.at(-1).to = 5;
    const invalidSelection = { type: 'applyBatch', operations: structuredClone(vectors.operations), resultSelection: { anchor: { block: 'p1', offset: 1 }, focus: { block: 'p1', offset: vectors.invalidStagedUtf16Offset }, affinity } };
    fact.rejections = [];
    for (const [name, action] of [['missing-final-owner', invalid], ['staged-surrogate-mark', invalidMark], ['staged-surrogate-selection', invalidSelection]]) {
      const rejected = driver.act(action);
      assert.deepEqual(rejected, { outcome: recipe.steps[0].expect.outcome, state: initial, effects: recipe.steps[0].expect.effects, revision: before.snapshot.revision }); fact.checkpoints++;
      await tick(); check(effects(), zero);
      assert.deepEqual(observeRejection(), expectedRejection); fact.checkpoints++;
      fact.rejections.push(name);
    }
    for (const [name, corrupt] of [
      ['rejection-document', e => e.frozen.state.blocks[0].text = vectors.expectedText],
      ['rejection-pending', e => e.frozen.state.pendingMarks = pending.marks === null ? [] : null],
      ['rejection-revision', e => e.frozen.snapshot.revision++], ['rejection-vector', e => e.frozen.vector[0] ^= 1],
      ['rejection-checkpoint', e => e.frozen.checkpoint[0] ^= 1], ['rejection-history', e => e.frozen.history.undoGroups++],
      ['rejection-publication', e => e.publications.push('Editor')], ['rejection-commit', e => e.commitCalls++],
    ]) { const wrong = structuredClone(expectedRejection); corrupt(wrong); assert.throws(() => assert.deepEqual(observeRejection(), wrong), assert.AssertionError); facts.negativeControls.push(`${fact.id}/${name}`); fact.checkpoints++; }
    for (const key of ['appends', 'transactions', 'records', 'completions', 'pending']) falsify(`rejection-${key}`, effects(), zero, e => e[key]++);
    const resultSelection = { anchor: { block: 'p1', offset: v.selection[0] }, focus: { block: 'p1', offset: v.selection[1] }, affinity };
    const action = { type: 'applyBatch', operations: vectors.operations, resultSelection };
    const applied = driver.act(action);
    const expectedState = { blocks: [{ id: 'p1', kind: 'paragraph', text: vectors.expectedText, hardBreaks: [], marks: vectors.expectedMarks }], selection: resultSelection, pendingMarks: pending.marks };
    assert.deepEqual(applied, { outcome: recipe.steps[1].expect.outcome, state: expectedState, effects: recipe.steps[1].expect.effects, revision: before.snapshot.revision + 1 }); fact.checkpoints++;
    assert.notDeepEqual(Buffer.from(engine.stateVector()), before.vector); assert.notDeepEqual(Buffer.from(engine.checkpoint().bytes), before.checkpoint); fact.checkpoints++;
    const observeRetry = () => {
      const node = engine.read().visible[0];
      return { state: driver.snapshot(), runs: node.runs, owner: node.id, spans: node.spans.map(s => ({ source: s.source, identity: s.identity })), result: resolvedResults[0], commitCalls: storage.commitCalls, publications: events(), undoGroups: engine.history({ type: 'state' }).undoGroups, redoGroups: engine.history({ type: 'state' }).redoGroups };
    };
    const expectedRetry = { state: expectedState, runs: vectors.expectedRuns, owner, spans: original.spans.map(s => ({ source: s.source, identity: s.identity })), result: { revision: before.snapshot.revision + 1, endpoints: v.selection.map(offset => ({ type: 'position', node: owner, offset, source: original.spans[0].source, sourceOffset: offset, bias: v.bias })) }, commitCalls: 1, publications: ['Editor'], undoGroups: 1, redoGroups: 0 };
    assert.deepEqual(observeRetry(), expectedRetry); fact.checkpoints++;
    assert.equal(driver.snapshot().blocks[0].text.slice(3), vectors.suffix); fact.checkpoints++;
    for (const [name, corrupt] of [
      ['staged-text', e => e.state.blocks[0].text = 'aXY😀bc'], ['suffix', e => e.runs[2].text = '😀b'],
      ['inserted-mark', e => e.runs[1].attributes = {}], ['suffix-mark', e => e.runs[2].attributes = { bold: true }],
      ['owner', e => e.owner = 'missing'], ['source', e => e.spans[0].source = 'missing'], ['identity', e => e.spans[0].identity = 'missing'],
      ['anchor', e => e.result.endpoints[0].offset++], ['focus', e => e.result.endpoints[1].offset++],
      ['direction', e => e.result.endpoints.reverse()], ['bias', e => e.result.endpoints[1].bias = v.bias === 'left' ? 'right' : 'left'],
      ['source-offset', e => e.result.endpoints[1].sourceOffset++], ['pending', e => e.state.pendingMarks = pending.marks === null ? [] : null],
      ['retry-revision', e => e.result.revision++], ['retry-commit', e => e.commitCalls++],
      ['retry-publication', e => e.publications.push('Editor')], ['retry-history', e => e.undoGroups++],
    ]) { const wrong = structuredClone(expectedRetry); corrupt(wrong); assert.throws(() => assert.deepEqual(observeRetry(), wrong), assert.AssertionError); facts.negativeControls.push(`${fact.id}/${name}`); fact.checkpoints++; }
    check(lifecycle.recoveryExport().unsavedUpdates.length, 1);
    check(lifecycle.recoveryExport().unsavedUpdates[0].bytes, publications[0].update.bytes);
    const tx = await storage.nextTransaction();
    const staged = { ...zero, publications: 1, appends: 1, transactions: 1, pending: 1 };
    check(effects(), staged);
    tx.lookupSuccess(); tx.writeSuccess(); await tick();
    check(effects(), staged); check(observeRetry(), expectedRetry);
    check(lifecycle.state.strictDurability, 'unknown');
    let flushed = false;
    const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
    await tick(); check(flushed, false);
    for (const key of ['records', 'completions']) falsify(`staged-${key}`, effects(), staged, e => e[key]++);
    falsify('staged-saved', effects(), staged, e => e.saved = true);
    tx.complete(); await barrier;
    const committed = { ...zero, publications: 1, appends: 1, transactions: 1, records: 1, completions: 1, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
    check(effects(), committed); check(observeRetry(), expectedRetry);
    check(lifecycle.state.strictDurability, 'supported');
    check(tx.entry.checksum, sha256(publications[0].update.bytes));
    check({ identity: tx.entry.identity, writerId: tx.entry.writerId, sequence: tx.entry.sequence, origin: tx.entry.origin }, { identity: publications[0].identity, writerId: publications[0].writerId, sequence: publications[0].sequence, origin: publications[0].origin });
    check(completions[0].commit, committed.localCommitted);
    check(completions[0].update.bytes, publications[0].update.bytes);
    check(tx.entry.bytes, publications[0].update.bytes);
    check([...db.records.values()], [tx.entry]);
    check(lifecycle.recoveryExport().unsavedUpdates, []);
    const restored = pack.runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, [{ identity: tx.entry.identity, bytes: tx.entry.bytes }]);
    try { check(restored.read().visible, engine.read().visible); check(Buffer.from(restored.stateVector()), Buffer.from(engine.stateVector())); }
    finally { restored.dispose(); }
    for (const key of ['appends', 'transactions', 'records', 'completions', 'pending']) falsify(`complete-${key}`, effects(), committed, e => e[key]++);
    falsify('persisted-metadata', tx.entry, tx.entry, e => e.sequence++);
    falsify('persisted-bytes', tx.entry, tx.entry, e => e.bytes[0] ^= 1);
    fact.effects = { rejected: zero, staged, committed };
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
});
