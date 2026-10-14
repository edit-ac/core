import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadSuite, groupIds, capabilityBinding } from './fixture-loader.ts';
import { assertCheckpoint } from './driver.ts';
import { SemanticDriver, semanticCapabilities, semanticActions, semanticProfile, MissingCapabilityError } from './semantic-adapter.ts';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { collapsedPreCases, collapsedPreInitial, pasteCollapsedPre, undoCollapsedPre } from './collapsed-pre-oracle.mjs';
import { qualifiedVectorIds, runAtomicVector } from './atomic-vector-oracle.mjs';
const suite = loadSuite();
const vectors = JSON.parse(await readFile(new URL('../../fixtures/editing-failures/semantic-vectors.json', import.meta.url)));
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { layer: 'real packed-WASM semantic prepared operations', profile: semanticProfile, fixtureHashes: suite.hashes, cases: [], recipes: [], negativeControls: [], bindings: suite.recipes.map(r => capabilityBinding(r, semanticCapabilities, semanticActions)), exclusions: ['No attached journal/persistence port', 'No native gesture or device claim', 'History selection and alignment remain missing capabilities'] };
let pack, runtime;
before(async () => { assert.ok(output, 'EDITAC_EDITING_OUTPUT must be a fresh evidence directory'); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); runtime = pack.runtime; });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/driver.ts', 'tests/editing/semantic-adapter.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/semantic.test.mjs', 'tests/editing/collapsed-pre-oracle.mjs', 'tests/editing/atomic-vector-oracle.mjs', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'fixtures/editing-failures/semantic-vectors.json', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
});
function caseTest(id, run) {
  test(id, () => {
    const fact = { id, status: 'running', checkpoints: 0 }; facts.cases.push(fact);
    try { run(fact); fact.status = 'passed'; } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  });
}
const select = (offset, focus = offset, affinity = 'forward', block = 'p1') => ({ anchor: { block, offset }, focus: { block, offset: focus }, affinity });
const block = (id, text, kind = 'paragraph', marks = []) => ({ id, text, kind, hardBreaks: kind === 'paragraph' ? [...text.matchAll(/\n/g)].map(m => m.index) : [], marks });
const state = (text = 'abc', offset = 1) => ({ blocks: [block('p1', text)], selection: select(offset), pendingMarks: null });
function driver(initial, run) { const d = new SemanticDriver(runtime, initial); try { return run(d); } finally { d.dispose(); } }
for (const id of groupIds('semantic')) {
  const recipe = suite.recipes.find(r => r.id === id);
  caseTest(id, fact => driver(recipe.initial, d => {
    const receipt = { id, checkpoints: [], status: 'running' }; facts.recipes.push(receipt);
    try {
      for (const step of recipe.steps) {
        const actual = d.act(step.action); assertCheckpoint(actual, step.expect);
        fact.checkpoints++; receipt.checkpoints.push({ id: step.id, outcome: actual.outcome, revision: actual.revision, effects: actual.effects });
      }
      receipt.status = 'passed';
    } catch (error) { receipt.status = error instanceof MissingCapabilityError ? 'blocked' : 'failed'; receipt.error = error.message; throw error; }
  }));
}
for (const v of vectors.atomic) caseTest(`native/WASM:${v.id}`, fact => driver(state(v.text, 0), d => {
  if (qualifiedVectorIds.includes(v.id)) return runAtomicVector(d, v, fact, facts);
  const engine = d.engine, owner = engine.read().visible[0].id, original = engine.read().visible[0];
  const commands = v.commands.map(c => c.type === 'insertSeparator' ? { type: c.type, beside: owner, side: c.side } : c.type === 'selectionAt'
    ? { type: c.type, anchor: { owner, offset: c.anchor, bias: 'left' }, focus: { owner, offset: c.focus, bias: 'right' } }
    : { ...c, owner: c.owner ?? owner, ...(c.type === 'markAt' ? { action: 'apply' } : {}) });
  const request = { kind: 'editor', origin: 'local:rgs:vector', commands };
  const before = d.frozen(); let events = 0; const subscription = engine.subscribe({ type: 'updates' }, () => events++);
  try {
    if (v.rejected) { assert.equal(engine.can(request), false); assert.throws(() => engine.prepare(request)); assert.deepEqual(d.frozen(), before); assert.equal(events, 0); fact.checkpoints++; return; }
    assert.equal(engine.can(request), true); const plan = engine.prepare(request);
    try {
      assert.deepEqual(d.frozen(), before); const result = engine.commit(plan);
      try {
        assert.equal(events, 1); assert.equal(result.revision, before.snapshot.revision + 1); assert.equal(engine.history({ type: 'state' }).undoGroups, 1);
        const node = engine.read().visible[0]; assert.equal(node.id, owner); assert.equal(node.spans[0].source, original.spans[0].source); assert.equal(node.spans[0].identity, original.spans[0].identity);
        assert.equal(node.runs.map(r => r.text).join(''), v.expectedText);
        if (v.visibleKinds) assert.deepEqual(engine.read().visible.map(n => n.blockAttributes[0]), v.visibleKinds);
        let offset = 0;
        for (const run of node.runs) {
          for (let unit = 0; unit < run.text.length; unit++, offset++) assert.deepEqual(run.attributes, Object.fromEntries(v.expectedMarks.filter(([from, to]) => from <= offset && offset < to).map(([, , type]) => [type, true])));
        }
        for (const [token, expected, bias] of [[result.selection.anchor, v.selection[0], 'left'], [result.selection.focus, v.selection[1], 'right']]) {
          const p = engine.resolve(token); assert.equal(p.type, 'position'); assert.equal(p.node, owner); assert.equal(p.offset, expected); assert.equal(p.bias, bias);
        }
        fact.checkpoints++;
      } finally { for (const token of [result.selection?.anchor, result.selection?.focus, result.caret].filter(Boolean)) engine.releaseAnchor(token); }
    } finally { engine.releasePlan(plan); }
  } finally { subscription.dispose(); }
}));
caseTest('G02/G03/G04/G06 independent checkpoint negative controls', fact => {
  const recipe = suite.recipes.find(r => r.id === 'SEQ-05');
  driver(recipe.initial, d => {
    const actual = d.act(recipe.steps[0].action);
    for (const [id, corrupt] of [
      ['G02-publication', e => e.effects.localCommits = 1],
      ['G03-affinity', e => e.state.selection.affinity = 'backward'],
      ['G04-null', e => e.state.pendingMarks = null],
      ['G04-empty', e => e.state.pendingMarks = []],
      ['G06-content', e => e.state.blocks[0].text = 'é'],
    ]) {
      const expected = structuredClone(recipe.steps[0].expect); corrupt(expected); assert.throws(() => assertCheckpoint(actual, expected), assert.AssertionError); facts.negativeControls.push(id); fact.checkpoints++;
    }
  });
  driver(state('abc', 1), d => {
    const actual = d.act({ type: 'applyBatch', operations: [{ type: 'insertText', block: 'p1', offset: 1, text: 'X' }], resultSelection: select(4, 1) });
    const expected = { outcome: 'applied', effects: { localCommits: 1, remoteCommits: 0 }, state: { blocks: [block('p1', 'aXbc')], selection: select(4, 1), pendingMarks: null } };
    assertCheckpoint(actual, expected); expected.state.selection = select(1, 4); assert.throws(() => assertCheckpoint(actual, expected), assert.AssertionError); facts.negativeControls.push('G03-direction'); fact.checkpoints++;
  });
});
// Complete G04 owning assertions live in pending.test.mjs, included by canonical dispatch.
caseTest('REG-06 schema crossing rejects without stripping bold suffix', fact => {
  const initial = { blocks: [block('p1', 'ab', 'code'), block('p2', 'cd', 'paragraph', [{ from: 0, to: 2, type: 'bold' }])], selection: { anchor: { block: 'p2', offset: 1 }, focus: { block: 'p1', offset: 1 }, affinity: 'forward' }, pendingMarks: null };
  driver(initial, d => {
    const before = d.frozen(); const actual = d.act({ type: 'deleteForward' }); assert.equal(actual.outcome, 'rejected', 'declared incompatible code suffix admission'); assert.deepEqual(d.frozen(), before); fact.checkpoints++;
    const tokens = [d.engine.anchor(d.ids.get('p2'), 1, 'right'), d.engine.anchor(d.ids.get('p1'), 1, 'right')];
    try {
      const request = { kind: 'format', origin: 'local:rgs:mixed', marks: [{ range: { anchor: tokens[0], focus: tokens[1] }, mark: 'bold', action: 'apply' }], blocks: [] };
      assert.equal(d.engine.can(request), false); assert.throws(() => d.engine.prepare(request)); assert.deepEqual(d.frozen(), before); fact.checkpoints++;
      const replace = d.act({ type: 'pasteFragment', blocks: [{ attributes: null, runs: [{ text: 'X', marks: [] }] }] }); assert.equal(replace.outcome, 'rejected'); assert.deepEqual(d.frozen(), before); fact.checkpoints++;
    } finally { tokens.forEach(t => d.engine.releaseAnchor(t)); }
  });
});
caseTest('REG-07 separated pre fragments retain literal whitespace in code and empty control', fact => {
  for (const v of collapsedPreCases) driver(collapsedPreInitial(v), d => {
    const paste = pasteCollapsedPre(d, v, fact, facts);
    undoCollapsedPre(d, v, fact, facts, paste);
  });
});
caseTest('RGS-1.2 outstanding original REG-05/07/13 contracts are explicit', () => {
  throw new MissingCapabilityError('REG-05 alignment/preceding-rule-or-atom variants, REG-07 selected text/code paste + undo selection remain unqualified; atomic primitive evidence does not close them');
});
