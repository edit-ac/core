import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/pending-vectors.json', 'utf8')).sequences;
const suite = loadSuite(), output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C10', guard: 'G04', layer: 'real packed-WASM via shared SemanticDriver', fixtureHashes: suite.hashes, profile: { ...semanticProfile, clock: 'driver fixed 0; default isolated history groups; fresh cleared history' }, cases: [], negativeControls: [], exclusions: ['No journal/persistence attachment', 'No native editor-local pending state', 'History bookmarks and alignment/atom profiles remain unqualified', 'No device/gesture evidence'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 2); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/pending.test.mjs', 'fixtures/editing-failures/pending-vectors.json', 'tests/editing/semantic.test.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'pending-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const v of vectors) test(`native/WASM:G04-${v.id}`, () => {
  const fact = { id: v.id, status: 'running', checkpoints: 0, controls: 0, steps: [] }; facts.cases.push(fact);
  const committed = [];
  const runtime = { ...pack.runtime, createEngine(options) {
    const actual = pack.runtime.createEngine(options);
    return { ...actual, commit(plan) {
      const result = actual.commit(plan);
      const resolve = token => { const p = actual.resolve(token); assert.equal(p.type, 'position'); return { node: p.node, offset: p.offset, bias: p.bias }; };
      committed.push({ revision: result.revision, endpoints: result.selection ? [result.selection.anchor, result.selection.focus].map(resolve) : null, caret: result.caret ? resolve(result.caret) : null });
      return result;
    } };
  } };
  const d = new SemanticDriver(runtime, v.initial), engine = d.engine;
  let sub; const publications = [];
  try {
    committed.length = 0; // Fixture creation is outside the action observation window.
    const initial = d.frozen(), identities = new Map();
    const capture = alias => {
      const node = engine.read().visible.find(n => n.id === d.ids.get(alias)); assert.ok(node);
      return { owner: node.id, spans: node.spans.map(s => ({ source: s.source, identity: s.identity })) };
    };
    for (const b of v.initial.blocks) identities.set(b.id, capture(b.id));
    sub = engine.subscribe({ type: 'updates' }, event => publications.push(event.operation));
    let count = 0;
    for (const step of v.steps) {
      const before = d.frozen(), priorCount = count, priorResultCount = committed.length;
      const actual = d.act(step.action), delta = step.expect.effects.localCommits; count += delta;
      const expected = { ...step.expect, revision: initial.snapshot.revision + count };
      assert.deepEqual(actual, expected); fact.checkpoints++;
      if (step.action.type === 'insertParagraph') {
        const last = committed.at(-1); assert.ok(last.caret); assert.equal(last.caret.node, d.ids.get(step.action.newBlockId));
        assert.ok(![...identities.values()].some(i => i.owner === last.caret.node));
        const retained = identities.get(step.action.newBlockId === 'p2' ? 'p1' : 'missing');
        const splitOwner = capture('p1');
        assert.equal(splitOwner.owner, retained.owner);
        assert.equal(splitOwner.spans.length, retained.spans.length + 2, 'paragraph split retains source plus two structural spans');
        assert.deepEqual(splitOwner.spans.slice(0, retained.spans.length), retained.spans);
        assert.equal(new Set(splitOwner.spans.map(s => s.identity)).size, splitOwner.spans.length);
        identities.set('p1', splitOwner); // Bind new structural identities at their creating operation.
        identities.set(step.action.newBlockId, capture(step.action.newBlockId)); fact.checkpoints++;
      }
      const observation = () => ({
        identities: expected.state.blocks.map(b => capture(b.id)),
        revision: engine.read().revision, commits: committed.length, publications: [...publications],
        undo: engine.history({ type: 'state' }).undoGroups, redo: engine.history({ type: 'state' }).redoGroups,
      });
      const expectedObservation = { identities: expected.state.blocks.map(b => identities.get(b.id)), revision: expected.revision, commits: count, publications: Array(count).fill('Editor'), undo: count, redo: 0 };
      assert.deepEqual(observation(), expectedObservation); fact.checkpoints++;
      if (!delta) {
        const frozen = d.frozen();
        // Only the adapter's selection/pending fields can differ.
        assert.deepEqual({ ...frozen, state: before.state }, before); fact.checkpoints++;
        assert.equal(committed.length, priorResultCount); assert.equal(publications.length, priorCount);
      } else {
        assert.notDeepEqual(Buffer.from(engine.stateVector()), before.vector);
        assert.notDeepEqual(Buffer.from(engine.checkpoint().bytes), before.checkpoint); fact.checkpoints++;
        const result = committed.at(-1), s = expected.state.selection;
        const points = [s.anchor, s.focus].map(p => ({ node: d.ids.get(p.block), offset: p.offset, bias: s.affinity === 'backward' ? 'left' : 'right' }));
        if (step.native.type === 'split') {
          assert.deepEqual(result.caret, points[0]); assert.deepEqual(s.anchor, s.focus);
          assert.equal(result.endpoints, null); // Fragment contract returns a caret, not a range.
        } else assert.deepEqual(result.endpoints, points);
        fact.checkpoints++;
      }
      const falsify = (name, value, observe, corrupt) => {
        const wrong = structuredClone(value); corrupt(wrong);
        assert.throws(() => assert.deepEqual(observe(), wrong), assert.AssertionError);
        facts.negativeControls.push(`${v.id}/${step.id}/${name}`); fact.controls++; fact.checkpoints++;
      };
      for (const [name, corrupt] of [
        ['content', e => e.state.blocks[0].text += '!'], ['marks', e => e.state.blocks[0].marks = [{ from: 0, to: 1, type: 'italic' }]],
        ['pending', e => e.state.pendingMarks = e.state.pendingMarks === null ? [] : null],
        ['anchor', e => e.state.selection.anchor.offset++], ['focus', e => e.state.selection.focus.offset++],
        ['affinity', e => e.state.selection.affinity = e.state.selection.affinity === 'forward' ? 'backward' : 'forward'],
        ['effects', e => e.effects.localCommits++], ['revision', e => e.revision++],
      ]) falsify(name, expected, () => actual, corrupt);
      for (const [name, corrupt] of [
        ['owner', e => e.identities[0].owner = 'missing'], ['source', e => e.identities[0].spans[0].source = 'missing'],
        ['identity', e => e.identities[0].spans[0].identity = 'missing'], ['commit', e => e.commits++],
        ['publication', e => e.publications.push('Editor')], ['undo', e => e.undo++], ['redo', e => e.redo++],
      ]) falsify(name, expectedObservation, observation, corrupt);
      if (!delta) for (const [name, corrupt] of [['vector', e => e.vector[0] ^= 1], ['checkpoint', e => e.checkpoint[0] ^= 1], ['history', e => e.history.undoGroups++]]) {
        const frozen = d.frozen(); falsify(`zero-${name}`, frozen, () => d.frozen(), corrupt);
      }
      else {
        const result = committed.at(-1);
        falsify('prepared-offset', result, () => committed.at(-1), e => (e.endpoints?.[1] ?? e.caret).offset++);
        falsify('prepared-bias', result, () => committed.at(-1), e => { const p = e.endpoints?.[0] ?? e.caret; p.bias = p.bias === 'left' ? 'right' : 'left'; });
      }
      fact.steps.push({ id: step.id, outcome: actual.outcome, revision: actual.revision, effects: actual.effects, native: step.native ? step.native.type === 'split' ? 'fragment split caret' : 'ordered replace/mark + final selectionAt' : 'editor-local only; no native pending claim' });
    }
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { sub?.dispose(); d.dispose(); }
});
