import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/schema-rejection-vectors.json', 'utf8'));
const output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C7', layer: 'real packed-WASM fragment/format prepare ports', fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [], profile: { engine: 'v5', policy: 'reject incompatible code/marked paragraph crossing atomically', clock: 'no timed actions; history cleared before rejection', selection: 'real input tokens, both endpoints, direction and left/right bias' }, exclusions: ['No accepted cross-owner policy', 'No history bookmarks, journal/persistence or browser/device proof'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.cases.length, 12); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/schema-rejection.test.mjs', 'fixtures/editing-failures/schema-rejection-vectors.json', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'schema-rejection-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
const frozen = e => { const { changedNodes, touchedRanges, ...snapshot } = e.read(); return { snapshot, vector: [...e.stateVector()], checkpoint: [...e.checkpoint().bytes], history: e.history({ type: 'state' }) }; };
for (const [i, v] of vectors.cases.entries()) test(`native/WASM:${v.id}`, () => {
  const fact = { id: v.id, status: 'running', checkpoints: 0 }; facts.cases.push(fact);
  const serial = String(i + 1).padStart(12, '0');
  const engine = pack.runtime.createEngine({ profile: 'v5', documentId: `42600000-0000-4000-8000-${serial}`, epoch: `42600000-0000-4000-9000-${serial}`, nodes: [{ text: 'ab' }, { text: 'cd' }] });
  const tokens = []; let subscription; const events = [];
  try {
    const originals = engine.read().visible; const owners = originals.map(n => n.id);
    const setup = engine.prepare({ kind: 'editor', origin: 'local:rgs:schema-setup', commands: [{ type: 'setCode', owner: owners[0], language: '' }, { type: 'markAt', owner: owners[1], from: 0, to: 2, mark: 'bold', action: 'apply' }] });
    try { const result = engine.commit(setup); for (const t of [result.caret, result.selection?.anchor, result.selection?.focus].filter(Boolean)) engine.releaseAnchor(t); } finally { engine.releasePlan(setup); }
    engine.history({ type: 'clear' });
    tokens.push(...v.endpoints.map(index => engine.anchor(owners[index], 1, v.bias)));
    subscription = engine.subscribe({ type: 'updates' }, p => events.push(p.operation));
    const before = frozen(engine);
    const semantic = () => engine.read().visible.map(n => ({ owner: n.id, kind: n.blockAttributes[0], text: n.runs.map(r => r.text).join(''), marks: n.runs.map(r => r.attributes), spans: n.spans.map(s => ({ source: s.source, identity: s.identity })) }));
    const expectedSemantic = owners.map((owner, index) => ({ owner, kind: vectors.initial[index].kind, text: vectors.initial[index].text, marks: [index === 1 ? { bold: true } : {}], spans: originals[index].spans.map(s => ({ source: s.source, identity: s.identity })) }));
    const endpoints = () => tokens.map(t => engine.resolve(t));
    const expectedEndpoints = v.endpoints.map(index => ({ type: 'position', node: owners[index], offset: 1, source: originals[index].spans[0].source, sourceOffset: 1, bias: v.bias }));
    const observed = () => ({ semantic: semantic(), endpoints: endpoints(), frozen: frozen(engine), events: [...events] });
    const expected = { semantic: expectedSemantic, endpoints: expectedEndpoints, frozen: before, events: [] };
    assert.deepEqual(observed(), expected); fact.checkpoints++;
    const range = { anchor: tokens[0], focus: tokens[1] };
    const request = v.kind === 'format' ? { kind: 'format', origin: 'local:rgs:schema', marks: [{ range, mark: 'bold', action: 'apply' }], blocks: [] } : { kind: 'fragment', origin: 'local:rgs:schema', range, blocks: [{ attributes: null, runs: [{ text: v.kind === 'delete' ? '' : 'X', marks: [] }] }] };
    assert.equal(engine.can(request), false); assert.deepEqual(observed(), expected); fact.checkpoints++;
    assert.throws(() => engine.prepare(request)); assert.deepEqual(observed(), expected); fact.checkpoints++;
    for (const [name, corrupt] of [
      ['schema', e => e.semantic[0].kind = 'paragraph'], ['suffix', e => e.semantic[1].text = 'c'], ['bold', e => e.semantic[1].marks = [{}]],
      ['owner', e => e.semantic[1].owner = owners[0]], ['source', e => e.semantic[1].spans[0].source = originals[0].spans[0].source],
      ['identity', e => e.semantic[1].spans[0].identity = originals[0].spans[0].identity],
      ['anchor', e => e.endpoints[0].offset++], ['focus', e => e.endpoints[1].offset++],
      ['direction', e => e.endpoints.reverse()], ['bias', e => e.endpoints[0].bias = v.bias === 'left' ? 'right' : 'left'],
      ['source-offset', e => e.endpoints[1].sourceOffset++], ['revision', e => e.frozen.snapshot.revision++],
      ['vector', e => e.frozen.vector.push(255)], ['checkpoint', e => e.frozen.checkpoint.push(255)],
      ['history', e => e.frozen.history.undoGroups++], ['publication', e => e.events.push('Editor')],
    ]) { const wrong = structuredClone(expected); corrupt(wrong); assert.throws(() => assert.deepEqual(observed(), wrong), assert.AssertionError); facts.negativeControls.push(`${v.id}/${name}`); fact.checkpoints++; }
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { subscription?.dispose(); for (const t of tokens) engine.releaseAnchor(t); engine.dispose(); }
});
