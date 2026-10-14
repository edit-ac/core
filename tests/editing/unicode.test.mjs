import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { SemanticDriver, semanticProfile } from './semantic-adapter.ts';
import { assertUnicodeCell, unicodeInitial } from './unicode-harness.mjs';
const vectors = JSON.parse(await readFile('fixtures/editing-failures/semantic-vectors.json', 'utf8')).graphemes;
const suite = loadSuite(), output = process.env.EDITAC_EDITING_OUTPUT;
const facts = { parent: 'RGS-1.2', child: 'RGS-1.2-C9', guard: 'G06', layer: 'real packed-WASM prepared editor through shared SemanticDriver', fixtureHashes: suite.hashes, profile: { ...semanticProfile, clock: 'fixed 0; fresh cleared history', biases: ['left', 'right'] }, cases: [], negativeControls: [], exclusions: ['No journal/persistence attachment', 'No native gesture/device or whole-version Unicode conformance', 'No native editor-local pending state', 'Boundary and combining-interior are adapter dispositions without a prepared result'] };
let pack;
before(async () => { assert.ok(output); assert.equal(vectors.length, 10); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.sourceHashes = {};
  for (const path of ['tests/editing/unicode.test.mjs', 'tests/editing/unicode-harness.mjs', 'fixtures/editing-failures/semantic-vectors.json', 'tests/editing/semantic-adapter.ts', 'tests/editing/driver.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', 'crates/editac-core/tests/editing_regressions.rs', 'Cargo.lock']) facts.sourceHashes[path] = sha256(await readFile(path));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0 };
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'unicode-harness.json'), JSON.stringify(facts, null, 2) + '\n');
});
for (const v of vectors) for (const bias of ['left', 'right']) test(`native/WASM:G06-${v.id}/${bias}`, () => {
  const fact = { id: `G06-${v.id}/${bias}`, status: 'running', checkpoints: 0, controls: 0 }; facts.cases.push(fact);
  const initial = unicodeInitial(v, bias);
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
    subscription = engine.subscribe({ type: 'updates' }, event => publications.push(event.operation));
    assertUnicodeCell(driver, () => ({ commits, publications, results }), v, bias, fact, facts);
    fact.status = 'passed';
  } catch (error) { fact.status = 'failed'; fact.error = error.message; throw error; }
  finally { subscription?.dispose(); driver.dispose(); }
});
