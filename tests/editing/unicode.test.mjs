import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/semantic-vectors.json', 'utf8')).graphemes;
const suite = loadSuite(), output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C9', guard: 'G06', layer: 'real packed-WASM prepared editor through shared SemanticDriver', fixtureHashes: suite.hashes, profile: { ...semanticProfile, clock: 'fixed 0; fresh cleared history', biases: ['left', 'right'] }, cases: [], negativeControls: [], exclusions: ['No journal/persistence attachment', 'No native gesture/device or whole-version Unicode conformance', 'No native editor-local pending state', 'Boundary and combining-interior are adapter dispositions without a prepared result'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 10); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/unicode.test.mjs', 'fixtures/editing-failures/semantic-vectors.json', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'unicode-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const v of vectors) for (const bias of ['left', 'right']) test(`native/WASM:G06-${v.id}/${bias}`, () => {
  const fact = { id: `G06-${v.id}/${bias}`, status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
  const affinity = bias === 'left' ? 'backward' : 'forward';
  const selection = offset => ({ anchor: { block: 'p1', offset }, focus: { block: 'p1', offset }, affinity });
  const block = text => ({ id: 'p1', kind: 'paragraph', text, hardBreaks: [], marks: [] });
  const initial = { blocks: [block(v.text)], selection: selection(v.initialOffset), pendingMarks: null };
  let commits = 0; const results = [];
  const runtime = { ...pack.runtime, createEngine(options) {
    const actual = pack.runtime.createEngine(options);
    return { ...actual, commit(plan) {
      const result = actual.commit(plan); commits++;
      results.push({ revision: result.revision, endpoints: result.selection ? [result.selection.anchor, result.selection.focus].map(token => {
        const p = actual.resolve(token); assert.equal(p.type, 'position');
        return { node: p.node, offset: p.offset, bias: p.bias };
      }) : null });
      return result;
    } };
  } };
  const driver = new SemanticDriver(runtime, initial), engine = driver.engine;
  let subscription; const publications = [];
  try {
    const original = engine.read().visible[0], owner = original.id, old = driver.frozen();
    subscription = engine.subscribe({ type: 'updates' }, event => publications.push(event.operation));
    const applied = !v.rejected && v.range !== null, delta = applied ? 1 : 0;
    const action = v.id === 'surrogate-interior' ? { type: 'applyBatch', operations: [{ type: 'replaceText', block: 'p1', from: v.offset, to: v.offset + 1, text: '' }] } : { type: 'backspace' };
    const actual = driver.act(action);
    const expected = { outcome: v.rejected ? 'rejected' : applied ? 'applied' : 'no-op', state: { blocks: [block(v.expectedText)], selection: selection(v.selection[0]), pendingMarks: null }, effects: { localCommits: delta, remoteCommits: 0 }, revision: old.snapshot.revision + delta };
    // Both endpoints are independent fixture fields, even for collapsed results.
    expected.state.selection.focus.offset = v.selection[1];
    const observe = () => {
      const node = engine.read().visible[0], history = engine.history({ type: 'state' });
      return { actual, visibleCount: engine.read().visible.length, owner: node.id, kind: node.kind, attributes: node.blockAttributes, runs: node.runs, spans: node.spans.map(s => ({ source: s.source, identity: s.identity })), commits, publications: [...publications], results: [...results], undoGroups: history.undoGroups, redoGroups: history.redoGroups };
    };
    const expectedObservation = { actual: expected, visibleCount: 1, owner, kind: original.kind, attributes: original.blockAttributes, runs: [{ text: v.expectedText, attributes: {} }], spans: original.spans.map(s => ({ source: s.source, identity: s.identity })), commits: delta, publications: applied ? ['Editor'] : [], results: applied ? [{ revision: expected.revision, endpoints: v.selection.map(offset => ({ node: owner, offset, bias })) }] : [], undoGroups: delta, redoGroups: 0 };
    assert.deepEqual(observe(), expectedObservation); fact.checkpoints++;
    const falsify = (name, expectedValue, observeValue, corrupt) => {
      const wrong = structuredClone(expectedValue); corrupt(wrong);
      assert.throws(() => assert.deepEqual(observeValue(), wrong), assert.AssertionError);
      facts.negativeControls.push(`${fact.id}/${name}`); fact.controls++; fact.checkpoints++;
    };
    for (const [name, corrupt] of [
      ['content', e => e.actual.state.blocks[0].text += 'X'], ['marks', e => e.actual.state.blocks[0].marks.push({ from: 0, to: 1, type: 'bold' })],
      ['anchor', e => e.actual.state.selection.anchor.offset++], ['focus', e => e.actual.state.selection.focus.offset++], ['affinity', e => e.actual.state.selection.affinity = affinity === 'forward' ? 'backward' : 'forward'],
      ['pending', e => e.actual.state.pendingMarks = []], ['owner', e => e.owner = 'missing'], ['source', e => e.spans[0].source = 'missing'], ['identity', e => e.spans[0].identity = 'missing'],
      ['runs', e => e.runs[0].attributes = { bold: true }], ['kind', e => e.attributes = ['code']], ['visible-count', e => e.visibleCount++],
      ['revision', e => e.actual.revision++], ['local-effect', e => e.actual.effects.localCommits++], ['remote-effect', e => e.actual.effects.remoteCommits++],
      ['commit', e => e.commits++], ['publication', e => e.publications.push('Editor')], ['undo', e => e.undoGroups++], ['redo', e => e.redoGroups++],
    ]) falsify(name, expectedObservation, observe, corrupt);
    if (applied) {
      // Deletion adds a delete set, not an insertion clock.
      assert.deepEqual(Buffer.from(engine.stateVector()), old.vector); assert.notDeepEqual(Buffer.from(engine.checkpoint().bytes), old.checkpoint); fact.checkpoints++;
      for (const [name, corrupt] of [
        ['prepared-anchor', e => e.results[0].endpoints[0].offset++], ['prepared-focus', e => e.results[0].endpoints[1].offset++],
        ['prepared-bias', e => e.results[0].endpoints[1].bias = bias === 'left' ? 'right' : 'left'], ['prepared-owner', e => e.results[0].endpoints[0].node = 'missing'],
      ]) falsify(name, expectedObservation, observe, corrupt);
    } else {
      assert.deepEqual(driver.frozen(), old); fact.checkpoints++;
      for (const [name, corrupt] of [
        ['frozen-vector', e => e.vector[0] ^= 1], ['frozen-checkpoint', e => e.checkpoint[0] ^= 1], ['frozen-revision', e => e.snapshot.revision++], ['frozen-history', e => e.history.undoGroups++],
      ]) falsify(name, old, () => driver.frozen(), corrupt);
    }
    fact.disposition = applied ? 'engine prepared result' : v.id === 'surrogate-interior' ? 'engine prepare rejected' : 'adapter boundary disposition';
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { subscription?.dispose(); driver.dispose(); }
});
