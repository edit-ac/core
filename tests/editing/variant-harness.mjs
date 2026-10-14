import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSuite } from './fixture-loader.ts';
import { assertCheckpoint } from './driver.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { variantStorage } from './variant-storage-harness.mjs';

export function registerVariantTests({ withStorage = false } = {}) {

const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { child: withStorage ? 'RGS-1.2-C18' : 'RGS-1.2-C1', parent: 'RGS-1.2', layer: withStorage ? 'real packed-WASM + production LocalStorageLifecycle/StorageWriter/UpdateJournal + prepared IndexedDB' : 'real packed-WASM semantic regression variants', profile: withStorage ? { ...semanticProfile, persistence: 'actual journal enqueue/local completion; prepared IndexedDB delivery', clock: 'fixed driver clock 0; isolated default history groups' } : semanticProfile, fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [], exclusions: ['Mixed code/text cross-owner paste is rejected: unqualified REG-07 boundary', 'History selection bookmark/result remains unbound', 'Cross-owner C2 cases retain original failed evidence and are not selected for C18', 'No alignment or atom profile binding', ...(withStorage ? [] : ['Journal/persistence unattached']), 'No browser/native gesture/device qualification'] };
let pack, runtime;
before(async () => {
  assert.ok(output, 'EDITAC_EDITING_OUTPUT must identify a fresh evidence directory');
  pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); runtime = pack.runtime; pack.facts.process.launcher = `node --test tests/editing/${withStorage ? 'variant-storage' : 'semantic-variants'}.test.mjs`;
});
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/semantic-variants.test.mjs', 'tests/editing/variant-harness.mjs', 'tests/editing/variant-storage.test.mjs', 'tests/editing/variant-storage-harness.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/replica-state.mjs', 'tests/helpers/journal-storage.mjs', ...['index', 'writer', 'journal', 'transaction'].flatMap(n => [`packages/web/src/storage/${n}.ts`, `packages/web/dist/storage/${n}.js`]), 'scripts/editing-suites.mjs', 'Cargo.lock', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'crates/editac-core/tests/editing_regressions.rs']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, withStorage ? 'variant-storage-harness.json' : 'semantic-variants-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
function caseTest(id, initial, run) {
  test(id, { timeout: 20000 }, async () => {
    const fact = { id, status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
    let d, storage;
    try {
      storage = withStorage ? await variantStorage(runtime, initial, fact, facts) : undefined;
      d = storage?.driver ?? new SemanticDriver(runtime, initial);
      fact.storage = storage;
      await run(d, fact);
      assert.ok(fact.checkpoints > 0);
      if (storage) {
        const prePaste = id.startsWith('REG-07');
        const trigger = id.includes('preceding-trigger');
        assert.equal(fact.storageSteps.length, prePaste ? 4 : trigger ? 2 : 6);
        assert.equal(storage.publications.length, prePaste ? 4 : trigger ? 2 : 1);
        assert.equal(storage.commitCalls, prePaste ? 2 : trigger ? 2 : 1);
        fact.storageEffects = storage.effects(); fact.preparedCommits = storage.commitCalls;
      }
      fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
    finally {
      delete fact.storage;
      if (storage) { fact.teardown = await storage.close(); if (fact.status === 'passed') assert.equal(fact.teardown.unsaved, false); }
      else d?.dispose();
    }
  });
}
const select = (anchor, focus = anchor, block = 'p1') => ({ anchor: { block, offset: anchor }, focus: { block, offset: focus }, affinity: 'forward' });
const block = (id, text, kind = 'paragraph', marks = []) => ({ id, text, kind, hardBreaks: kind === 'paragraph' ? [...text.matchAll(/\n/g)].map(m => m.index) : [], marks });
const state = (blocks, selection, pendingMarks = null) => ({ blocks, selection, pendingMarks });
const expected = (state, outcome = 'applied', commits = 1) => ({ outcome, state, effects: { localCommits: commits, remoteCommits: 0 } });
async function checkpoint(fact, actual, wanted) {
  assertCheckpoint(actual, wanted); fact.checkpoints++;
  if (fact.storage) await fact.storage.verifyStep(`action-${fact.storageSteps.length + 1}`, wanted.effects.localCommits);
}
function unchangedDocument(before, after) {
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.vector, before.vector);
  assert.deepEqual(after.checkpoint, before.checkpoint); assert.deepEqual(after.history, before.history);
}
const pre = () => [
  { attributes: { type: 'code', language: '' }, runs: [{ text: 'A', marks: [] }] },
  { attributes: { type: 'paragraph' }, runs: [{ text: '\n', marks: [] }] },
  { attributes: { type: 'code', language: '' }, runs: [{ text: 'B', marks: [] }] },
];

for (const pending of [[], ['bold']]) {
  const initial = state([block('p1', '#a', 'paragraph', [{ from: 1, to: 2, type: 'bold' }])], select(1), pending);
  caseTest(`REG-05 preceding-trigger deletion/pending-${pending.length ? 'bold' : 'empty'}`, initial, async (d, fact) => {
    const identity = d.engine.read().visible[0];
    await checkpoint(fact, d.act({ type: 'backspace' }), expected(state([block('p1', 'a', 'paragraph', [{ from: 0, to: 1, type: 'bold' }])], select(0), pending)));
    const typed = d.act({ type: 'insertText', text: 'X' });
    await checkpoint(fact, typed, expected(state([block('p1', 'Xa', 'paragraph', [{ from: pending.length ? 0 : 1, to: 2, type: 'bold' }])], select(1), pending)));
    const node = d.engine.read().visible[0]; assert.equal(node.id, identity.id); assert.equal(node.spans[0].source, identity.spans[0].source); fact.checkpoints++;
    for (const [id, corrupt] of [
      ['G04-deletion-pending', e => e.state.pendingMarks = null],
      ['G04-inherited-suffix', e => e.state.blocks[0].marks = []],
      ['G02-deletion-publication', e => e.effects.localCommits = 2],
    ]) {
      const wrong = expected(structuredClone(typed.state)); corrupt(wrong); assert.throws(() => assertCheckpoint(typed, wrong), assert.AssertionError); facts.negativeControls.push(`${id}/${pending.length}`); fact.checkpoints++;
    }
  });
}
const empty = state([block('p1', 'a', 'paragraph', [{ from: 0, to: 1, type: 'bold' }]), block('p2', '')], select(1));
caseTest('REG-05 empty destination recomputes null and rejects unsupported pending mark', empty, async (d, fact) => {
  const frozen = d.frozen();
  await checkpoint(fact, d.act({ type: 'toggleMark', mark: 'bold' }), expected(state(empty.blocks, select(1), []), 'selection-only', 0));
  unchangedDocument(frozen, d.frozen());
  await checkpoint(fact, d.act({ type: 'setSelection', selection: select(0, 0, 'p2') }), expected(state(empty.blocks, select(0, 0, 'p2')), 'selection-only', 0));
  await checkpoint(fact, d.act({ type: 'setSelection', selection: select(1) }), expected(empty, 'selection-only', 0));
  await checkpoint(fact, d.act({ type: 'setSelection', selection: select(0, 0, 'p2') }), expected(state(empty.blocks, select(0, 0, 'p2')), 'selection-only', 0));
  const before = d.frozen();
  await checkpoint(fact, d.act({ type: 'toggleMark', mark: 'link' }), expected(before.state, 'rejected', 0)); assert.deepEqual(d.frozen(), before);
  const typed = d.act({ type: 'insertText', text: 'X' });
  await checkpoint(fact, typed, expected(state([empty.blocks[0], block('p2', 'X')], select(1, 1, 'p2'))));
  const wrong = expected(structuredClone(typed.state)); wrong.state.pendingMarks = ['bold'];
  assert.throws(() => assertCheckpoint(typed, wrong), assert.AssertionError);
  facts.negativeControls.push('G04-empty-destination/null-versus-override'); fact.checkpoints++;
});

// Selection direction is independently authored. These checks prove content undo,
// never the missing history selection boundary. Each direction gets a fresh engine.
for (const kind of ['code', 'paragraph']) for (const backward of [false, true]) {
  const initial = state([block('p1', 'xyz', kind)], select(backward ? 2 : 1, backward ? 1 : 2));
  caseTest(`REG-07 selected-${kind}/${backward ? 'backward' : 'forward'}/pre-content-undo`, initial, async (d, fact) => {
    const original = d.engine.read().visible[0]; const before = d.frozen(); let events = 0;
    const subscription = d.engine.subscribe({ type: 'updates' }, () => events++);
    try {
      const actual = d.act({ type: 'pasteFragment', blocks: pre(), newBlockIds: ['p2', 'p3'] });
      const wanted = expected(state([block('p1', 'xA', 'code'), block('p2', '\n'), block('p3', 'Bz', 'code')], select(1, 1, 'p3')));
      await checkpoint(fact, actual, wanted);
      assert.equal(actual.revision, before.snapshot.revision + 1); assert.equal(events, 1); assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1);
      const nodes = d.engine.read().visible; assert.equal(nodes[0].id, original.id); assert.equal(nodes[0].spans[0].source, original.spans[0].source);
      // Undo before a sentinel: no conflated history group can hide a dropped range.
      d.engine.history({ type: 'undo' }); const restored = d.engine.read().visible;
      assert.equal(events, 2); assert.equal(restored.length, 1); assert.equal(restored[0].id, original.id); assert.deepEqual(restored[0].runs, original.runs); assert.deepEqual(restored[0].blockAttributes, original.blockAttributes); fact.checkpoints++;
      if (fact.storage) await fact.storage.verifyStep('undo', 1, 'Undo');
      d.engine.history({ type: 'redo' }); assert.equal(events, 3); assert.deepEqual(d.snapshot(), wanted.state); fact.checkpoints++;
      if (fact.storage) await fact.storage.verifyStep('redo', 1, 'Redo');
      await checkpoint(fact, d.act({ type: 'insertText', text: '!' }), expected(state([wanted.state.blocks[0], wanted.state.blocks[1], block('p3', 'B!z', 'code')], select(2, 2, 'p3'))));
      const wrong = structuredClone(wanted); wrong.state.blocks[1].text = ''; wrong.state.blocks[1].hardBreaks = [];
      assert.throws(() => assertCheckpoint(actual, wrong), assert.AssertionError); facts.negativeControls.push(`G02-pre-intermediate-range/${kind}/${backward}`); fact.checkpoints++;
    } finally { subscription.dispose(); }
  });
}
if (!withStorage) for (const backward of [false, true]) {
  const points = [{ block: 'p1', offset: 1 }, { block: 'p2', offset: 1 }];
  const initial = state([block('p1', 'xy', 'code'), block('p2', 'wz')], { anchor: points[backward ? 1 : 0], focus: points[backward ? 0 : 1], affinity: 'forward' });
  caseTest(`REG-07 selected-text-code-boundary/${backward ? 'backward' : 'forward'}/pre-content-undo`, initial, async (d, fact) => {
    const originals = d.engine.read().visible;
    await checkpoint(fact, d.act({ type: 'pasteFragment', blocks: pre(), newBlockIds: ['p3', 'p4'] }), expected(state([block('p1', 'xA', 'code'), block('p3', '\n'), block('p4', 'Bz', 'code')], select(1, 1, 'p4'))));
    assert.equal(d.engine.history({ type: 'state' }).undoGroups, 1);
    d.engine.history({ type: 'undo' }); const restored = d.engine.read().visible;
    assert.equal(restored.length, 2);
    restored.forEach((node, i) => { assert.equal(node.id, originals[i].id); assert.deepEqual(node.runs, originals[i].runs); assert.deepEqual(node.blockAttributes, originals[i].blockAttributes); }); fact.checkpoints++;
  });
}

}
