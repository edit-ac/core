import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/selection-vectors.json', 'utf8')).cases;
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', guard: 'G03', layer: 'real packed-WASM public selection/update ports', fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [], profile: { engine: 'v5', clock: 'no time-dependent actions or history grouping assertions', selection: 'text endpoints with explicit left/right bias', remote: 'restored replica and real delta; duplicate idempotence belongs to G10' }, exclusions: ['History bookmarks unqualified', 'Cross-owner fragment policy unqualified', 'No browser/device/persistence evidence'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 8); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/selection-results.test.mjs', 'fixtures/editing-failures/selection-vectors.json', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'crates/editac-core/tests/editing_regressions.rs']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'selection-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
const clean = engine => { const { changedNodes, touchedRanges, ...snapshot } = engine.read(); return { snapshot, vector: Buffer.from(engine.stateVector()), checkpoint: Buffer.from(engine.checkpoint().bytes), history: engine.history({ type: 'state' }) }; };
function commit(engine, commands) {
  const before = clean(engine); const plan = engine.prepare({ kind: 'editor', origin: 'local:rgs:selection', commands });
  try { assert.deepEqual(clean(engine), before, 'preparation is isolated'); return engine.commit(plan); } finally { engine.releasePlan(plan); }
}
function release(engine, result) { for (const t of [result.caret, result.selection?.anchor, result.selection?.focus].filter(Boolean)) engine.releaseAnchor(t); }
const text = n => n.runs.map(r => r.text).join('');
function marks(node) { let offset = 0; const out = []; for (const run of node.runs) { for (const name of Object.keys(run.attributes)) out.push([offset, offset + run.text.length, name]); offset += run.text.length; } return out; }
for (const [i, v] of vectors.entries()) test(`native/WASM:${v.id}`, () => {
  const fact = { id: v.id, status: 'running', checkpoints: 0 }; facts.cases.push(fact);
  const serial = String(i + 1).padStart(12, '0');
  const engine = pack.runtime.createEngine({ profile: 'v5', documentId: `42500000-0000-4000-8000-${serial}`, epoch: `42500000-0000-4000-9000-${serial}`, nodes: [{ text: v.text }, { text: v.remoteText }] });
  let remote, result; let subscription; const events = [];
  try {
    const initial = engine.read(); const [original, neighbor] = initial.visible; const owner = original.id;
    engine.history({ type: 'clear' }); subscription = engine.subscribe({ type: 'updates' }, p => events.push(p.operation));
    const action = v.kind === 'replace' ? { type: 'replaceAt', owner, from: 1, to: 4, text: 'XY' } : { type: 'markAt', owner, from: 1, to: 4, mark: 'bold', action: 'apply' };
    result = commit(engine, [action, { type: 'selectionAt', anchor: { owner, offset: v.selection[0], bias: v.bias }, focus: { owner, offset: v.selection[1], bias: v.bias } }]);
    assert.ok(result.selection); assert.equal(result.revision, initial.revision + 1); assert.deepEqual(events, ['Editor']); fact.checkpoints++;
    function observed() { const nodes = engine.read().visible; return { text: text(nodes[0]), marks: marks(nodes[0]), remote: text(nodes[1]), selection: [result.selection.anchor, result.selection.focus].map(t => engine.resolve(t)), publications: [...events] }; }
    const expected = { text: v.expectedText, marks: v.expectedMarks, remote: v.remoteText, selection: v.selection.map(offset => ({ type: 'position', node: owner, offset, source: original.spans[0].source, sourceOffset: offset, bias: v.bias })), publications: ['Editor'] };
    assert.deepEqual(observed(), expected); fact.checkpoints++;
    const checkpoint = engine.checkpoint(); remote = pack.runtime.restoreEngine(checkpoint.identity, checkpoint);
    const vector = engine.stateVector(); const rr = commit(remote, [{ type: 'replaceAt', owner: neighbor.id, from: 6, to: 6, text: 'R' }]); release(remote, rr);
    const delta = remote.encodeUpdate(vector); engine.applyUpdate(delta);
    expected.remote = v.expectedRemote; expected.publications.push('Remote'); assert.deepEqual(observed(), expected); fact.checkpoints++;
    for (const [name, corrupt] of [
      ['anchor', e => e.selection[0].offset++], ['focus', e => e.selection[1].offset++],
      ['direction', e => e.selection.reverse()], ['affinity', e => e.selection[0].bias = v.bias === 'left' ? 'right' : 'left'],
      ['owner', e => e.selection[1].node = neighbor.id], ['remote', e => e.remote = 'remote'], ['publication', e => e.publications.push('Editor')],
    ]) { const wrong = structuredClone(expected); corrupt(wrong); assert.throws(() => assert.deepEqual(observed(), wrong), assert.AssertionError); facts.negativeControls.push(`${v.id}/${name}`); fact.checkpoints++; }
    const [a, f] = observed().selection; const from = Math.min(a.offset, f.offset), to = Math.max(a.offset, f.offset);
    const sentinel = commit(engine, [{ type: 'replaceAt', owner: a.node, from, to, text: '!' }, { type: 'markAt', owner: a.node, from, to: from + 1, mark: 'bold', action: 'remove' }, { type: 'selectionAt', anchor: { owner, offset: 2, bias: v.bias }, focus: { owner, offset: 2, bias: v.bias } }]);
    try { assert.deepEqual([sentinel.selection.anchor, sentinel.selection.focus].map(t => engine.resolve(t)), [0, 1].map(() => ({ type: 'position', node: owner, offset: 2, source: original.spans[0].source, sourceOffset: 2, bias: v.bias }))); } finally { release(engine, sentinel); }
    const nodes = engine.read().visible; assert.equal(text(nodes[0]), v.expectedSentinel); assert.deepEqual(marks(nodes[0]), []); assert.equal(text(nodes[1]), v.expectedRemote); assert.deepEqual(events, ['Editor', 'Remote', 'Editor']);
    for (const [node, old] of [[nodes[0], original], [nodes[1], neighbor]]) { assert.equal(node.id, old.id); assert.equal(node.spans[0].source, old.spans[0].source); assert.equal(node.spans[0].identity, old.spans[0].identity); }
    assert.deepEqual(engine.takeObserverErrors(), []); fact.checkpoints++; fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { subscription?.dispose(); if (result) release(engine, result); remote?.dispose(); engine.dispose(); }
});
