import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { assertPendingSequence } from './pending-harness.mjs';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/pending-vectors.json', 'utf8')).sequences;
const suite = loadSuite(), output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C10', guard: 'G04', layer: 'real packed-WASM via shared SemanticDriver', fixtureHashes: suite.hashes, profile: { ...semanticProfile, clock: 'driver fixed 0; default isolated history groups; fresh cleared history' }, cases: [], negativeControls: [], exclusions: ['No journal/persistence attachment', 'No native editor-local pending state', 'History bookmarks and alignment/atom profiles remain unqualified', 'No device/gesture evidence'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 2); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/pending.test.mjs', 'tests/editing/pending-harness.mjs', 'fixtures/editing-failures/pending-vectors.json', 'tests/editing/semantic.test.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'pending-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const v of vectors) test(`native/WASM:G04-${v.id}`, async () => {
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
    sub = engine.subscribe({ type: 'updates' }, event => publications.push(event.operation));
    await assertPendingSequence(d, () => committed, () => publications, v, fact, facts);
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { sub?.dispose(); d.dispose(); }
});
