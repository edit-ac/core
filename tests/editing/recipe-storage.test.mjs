import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite, capabilityBinding } from './fixture-loader.ts';
import { assertCheckpoint } from './driver.ts';
import { semanticProfile, semanticCapabilities, semanticActions } from './semantic-adapter.ts';
import { assertRestoredReplica, stateVectorEntries } from './replica-state.mjs';
import { storageHarness, tick } from './storage-harness.mjs';

const ids = ['SEQ-01', 'SEQ-02', 'SEQ-04', 'SEQ-05', 'SEQ-06', 'SEQ-11', 'SEQ-12'];
const suite = loadSuite(), output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C16', guards: ['G02', 'G03', 'G04', 'G06'], layer: 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB', fixtureHashes: suite.hashes, profile: { ...semanticProfile, persistence: 'actual journal enqueue/local completion; prepared transaction delivery', clock: 'fixed 0; fresh restored profile and empty history', fixtureBinding: 'architecture JSON, seed before attachment; no setup journal commits' }, bindings: [], cases: [], negativeControls: [], exclusions: ['No native gesture/device evidence', 'History bookmarks, cross-owner paste, alignment/atom variants and full parent remain unqualified', 'SEQ-12 accepted observer probe is separately attributed from canonical no-op steps'] };
let pack;
before(async () => { assert.ok(output); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); pack.facts.process.launcher = 'node --test tests/editing/recipe-storage.test.mjs'; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/recipe-storage.test.mjs', 'tests/editing/semantic.test.mjs', 'tests/editing/replica-state.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/fixture-loader.ts', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'recipe-storage-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});

for (const id of ids) test(`packed/storage:canonical-${id}`, { timeout: 20000 }, async () => {
  const recipe = suite.recipes.find(r => r.id === id); assert.ok(recipe);
  facts.bindings.push({ id, ...capabilityBinding(recipe, semanticCapabilities, semanticActions) });
  const fact = { id, status: 'running', checkpoints: 0, controls: 0, steps: [] }; facts.cases.push(fact);
  const storage = await storageHarness(pack.runtime, recipe.initial);
  const { driver, engine, lifecycle, db, publications, completions } = storage;
  const entries = [], initialIds = new Map(driver.ids);
  const initialNodes = engine.read().visible;
  const check = (actual, expected) => { assert.deepEqual(actual, expected); fact.checkpoints++; };
  const control = (name, actual, expected, corrupt) => {
    const wrong = structuredClone(expected); corrupt(wrong);
    assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError);
    facts.negativeControls.push(`${id}/${name}`); fact.controls++; fact.checkpoints++;
  };
  const zero = { publications: 0, appends: 0, transactions: 0, records: 0, completions: 0, pending: 0, saved: false, localCommitted: null };
  async function replay() {
    const restored = pack.runtime.restoreEngine(storage.checkpoint.identity, storage.checkpoint, entries.map(e => ({ identity: e.identity, bytes: e.bytes })));
    try { assertRestoredReplica(restored, engine); fact.checkpoints++; }
    finally { restored.dispose(); }
    const vector = stateVectorEntries(engine.stateVector());
    control(`${entries.length}-replay-clock`, vector, vector, e => e[0].clock = String(BigInt(e[0].clock) + 1n));
    control(`${entries.length}-replay-client`, vector, vector, e => e[0].client = 'missing');
  }
  async function step(action, expected, name, probe = false) {
    const before = driver.frozen(), beforeEffects = storage.effects(), calls = storage.commitCalls;
    const results = storage.resolvedResults.length, carets = storage.resolvedCarets.length;
    const actual = driver.act(action);
    assertCheckpoint(actual, expected); fact.checkpoints++;
    for (const [label, corrupt] of [
      ['content', e => e.state.blocks[0].text += '?'], ['identity', e => e.state.blocks[0].id = 'missing'],
      ['selection-anchor', e => e.state.selection.anchor.offset++], ['selection-focus', e => e.state.selection.focus.offset++],
      ['affinity', e => e.state.selection.affinity = e.state.selection.affinity === 'forward' ? 'backward' : 'forward'],
      ['pending', e => e.state.pendingMarks = e.state.pendingMarks === null ? [] : null],
      ['publication', e => e.effects.localCommits++], ['outcome', e => e.outcome = 'corrupt'],
    ]) {
      const wrong = structuredClone(expected); corrupt(wrong);
      assert.throws(() => assertCheckpoint(actual, wrong), assert.AssertionError);
      facts.negativeControls.push(`${id}/${name}/${label}`); fact.controls++; fact.checkpoints++;
    }
    if (expected.state.blocks.some(b => b.marks.length)) control(`${name}/marks`, actual.state, expected.state, e => e.blocks.find(b => b.marks.length).marks[0].type = 'corrupt');
    for (const [alias, identity] of initialIds) {
      check(driver.ids.get(alias), identity);
      const node = engine.read().visible.find(n => n.id === identity);
      assert.ok(node, 'canonical recipes retain original owners'); fact.checkpoints++;
      check(node.spans[0].source, initialNodes.find(n => n.id === identity).spans[0].source);
    }
    if (action.newBlockId) {
      const identity = driver.ids.get(action.newBlockId); assert.ok(identity); fact.checkpoints++;
      check(storage.resolvedCarets.at(-1).node, identity);
      check(initialNodes.some(n => n.id === identity), false);
    }
    const committed = expected.effects.localCommits;
    check(expected.effects.remoteCommits, 0);
    const record = { id: name, probe, outcome: actual.outcome, expected, revision: actual.revision };
    if (!committed) {
      await tick(); await tick(); await lifecycle.flush({ target: 'local' });
      check(storage.effects(), beforeEffects); check(storage.commitCalls, calls);
      check(storage.resolvedResults.length, results); check(storage.resolvedCarets.length, carets);
      const after = driver.frozen();
      check(after.snapshot, before.snapshot); check(after.vector, before.vector); check(after.checkpoint, before.checkpoint); check(after.history, before.history);
      if (expected.outcome !== 'selection-only') check(after, before);
      check(lifecycle.recoveryExport().unsavedUpdates, []);
      check([...lifecycle.recoveryExport().checkpoint.bytes], [...before.checkpoint]);
      for (const key of ['publications', 'appends', 'transactions', 'records', 'completions', 'pending']) control(`${name}/zero-${key}`, storage.effects(), beforeEffects, e => e[key]++);
      control(`${name}/zero-recovery`, lifecycle.recoveryExport().unsavedUpdates, [], e => e.push({ bytes: [1] }));
      record.effects = storage.effects(); await replay(); fact.steps.push(record); return;
    }
    check(committed, 1); check(storage.commitCalls, calls + 1); check(actual.revision, before.snapshot.revision + 1);
    const selection = expected.state.selection;
    const points = [selection.anchor, selection.focus].map(p => ({ node: driver.ids.get(p.block), offset: p.offset, bias: selection.affinity === 'backward' ? 'left' : 'right' }));
    check(storage.resolvedResults.length, results + 1); check(storage.resolvedCarets.length, carets + 1);
    check(engine.history({ type: 'state' }).undoGroups, entries.length + 1);
    check(engine.history({ type: 'state' }).redoGroups, 0);
    const project = p => { check(p.type, 'position'); return { node: p.node, offset: p.offset, bias: p.bias }; };
    const resolved = storage.resolvedResults.at(-1);
    const returned = resolved.endpoints ? resolved.endpoints.map(project) : [project(storage.resolvedCarets.at(-1))];
    const expectedPoints = resolved.endpoints ? points : [points[1]];
    if (action.type === 'insertParagraph' || action.type === 'insertHardBreak') {
      check(project(storage.resolvedCarets.at(-1)), points[1]);
    } else check({ revision: resolved.revision, endpoints: returned }, { revision: actual.revision, endpoints: points });
    for (const [label, corrupt] of [['node', e => e[0].node = 'missing'], ['offset', e => e[0].offset++], ['bias', e => e[0].bias = 'left'], ['endpoint-count', e => e.pop()]]) control(`${name}/result-${label}`, returned, expectedPoints, corrupt);
    check(lifecycle.recoveryExport().unsavedUpdates.length, 1);
    check(lifecycle.recoveryExport().unsavedUpdates[0].bytes, publications.at(-1).update.bytes);
    const tx = await storage.nextTransaction();
    const staged = { ...beforeEffects, publications: beforeEffects.publications + 1, appends: beforeEffects.appends + 1, transactions: beforeEffects.transactions + 1, pending: 1, saved: false };
    check(storage.effects(), staged);
    const semantic = driver.frozen(); tx.lookupSuccess(); tx.writeSuccess(); await tick();
    check(storage.effects(), staged); check(driver.frozen(), semantic);
    let flushed = false;
    const barrier = lifecycle.flush({ target: 'local' }).then(() => { flushed = true; });
    await tick(); check(flushed, false);
    control(`${name}/premature-completion`, storage.effects(), staged, e => e.completions++);
    tx.complete(); await barrier; entries.push(tx.entry);
    const completed = { ...staged, records: entries.length, completions: entries.length, pending: 0, saved: true, localCommitted: { state: 'localCommitted', updateId: tx.entry.updateId, durability: 'strict' } };
    check(storage.effects(), completed); check(driver.frozen(), semantic);
    const patch = publications.at(-1);
    check(tx.entry.bytes, patch.update.bytes); check(tx.entry.checksum, sha256(tx.entry.bytes)); check(tx.entry.identity, storage.checkpoint.identity);
    check({ identity: tx.entry.identity, writerId: tx.entry.writerId, sequence: tx.entry.sequence, origin: tx.entry.origin }, { identity: patch.identity, writerId: patch.writerId, sequence: patch.sequence, origin: patch.origin });
    check(tx.entry.sequence, entries.length); check(lifecycle.state.strictDurability, 'supported');
    check(completions.at(-1).update.bytes, tx.entry.bytes); check(completions.at(-1).commit, completed.localCommitted);
    check([...db.records.values()], entries); check(lifecycle.recoveryExport().unsavedUpdates, []);
    check([...lifecycle.recoveryExport().checkpoint.bytes], [...engine.checkpoint().bytes]);
    for (const key of ['publications', 'appends', 'transactions', 'records', 'completions']) control(`${name}/completed-${key}`, storage.effects(), completed, e => e[key]++);
    for (const [label, corrupt] of [
      ['bytes', e => e.bytes[0] ^= 1], ['sequence', e => e.sequence++], ['origin', e => e.origin = 'corrupt'],
      ['checksum', e => e.checksum = 'corrupt'], ['identity', e => e.identity.documentId = 'missing'], ['writer', e => e.writerId = 'missing'],
    ]) control(`${name}/journal-${label}`, tx.entry, tx.entry, corrupt);
    record.effects = storage.effects(); record.result = storage.resolvedResults.at(-1); record.caret = storage.resolvedCarets.at(-1);
    await replay(); fact.steps.push(record);
  }
  try {
    check(storage.effects(), zero); check(driver.snapshot(), recipe.initial);
    check([...storage.bindingCheckpoint.bytes], [...storage.checkpoint.bytes]);
    check(engine.history({ type: 'state' }).undoGroups, 0); check(engine.history({ type: 'state' }).redoGroups, 0);
    control('fixture-setup-append', storage.effects(), zero, e => e.appends++);
    for (const item of recipe.steps) await step(item.action, item.expect, item.id);
    if (!entries.length) {
      assert.equal(id, 'SEQ-12'); fact.checkpoints++;
      // Same owner and real commit: prove the zero-effect observers were live.
      const state = structuredClone(recipe.initial); state.blocks[0].text = 'Xa';
      state.selection.anchor.offset = 1; state.selection.focus.offset = 1;
      await step({ type: 'insertText', text: 'X' }, { outcome: 'applied', state, effects: { localCommits: 1, remoteCommits: 0 } }, 'live-observer-probe', true);
    }
    fact.storageEffects = storage.effects(); fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
});
