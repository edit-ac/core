import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { loadSuite, assertRecipe, groupIds, capabilityBinding } from './fixture-loader.ts';
import { EditingDriver, FixedClock, assertCheckpoint, replay, capabilities, supportedActions, profile } from './driver.ts';

const suite = loadSuite();
const output = resolve(process.env.EDITAC_EDITING_OUTPUT ?? '../architecture/evidence/editing-regression-suite/rgs-1.1');
const pack = resolve(process.env.EDITAC_EDITING_PACK_TARBALL ?? '../architecture/evidence/browser-size-optimization/compound-order-2/default/edit-ac-core-0.0.0.tgz');
const facts = { layer: 'packed-engine-contract', corpusBinding: 'corpus-only', profile, fixtureHashes: suite.hashes,
  bindings: suite.recipes.map(r => capabilityBinding(r, capabilities, supportedActions)), recipes: [], checkpoints: [], negativeControls: [], catalogs: suite.catalogs, variantPolicies: suite.variantPolicies,
  exclusions: ['Full semantic/history recipe qualification belongs to RGS-1.2/1.3', 'Browser/native/device evidence is not executed here'] };
let runtime, temp, server;
before(async () => {
  assert.equal(process.version, 'v24.19.0', 'use the pinned Node runtime');
  await mkdir(output, { recursive: true });
  temp = await mkdtemp(join(tmpdir(), 'rgs-packed-'));
  const unpack = spawnSync('tar', ['-xzf', pack, '-C', temp], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  facts.pack = { path: pack, sha256: createHash('sha256').update(await readFile(pack)).digest('hex') };
  const packageRoot = join(temp, 'package');
  const bytes = await readFile(join(packageRoot, 'dist/wasm/editac_wasm_bg.wasm'));
  facts.wasmHash = createHash('sha256').update(bytes).digest('hex');
  // Public installed artifact loading, with one task-owned asset server and no workspace alias.
  server = createServer((req, res) => { if (req.url !== '/engine.wasm') { res.writeHead(404); res.end(); return; } res.setHeader('Content-Type', 'application/wasm'); res.end(bytes); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  facts.process = { pid: process.pid, port: server.address().port, workspace: resolve('.'), purpose: 'RGS-1.1 packed WASM asset', launcher: 'node --test tests/editing/fixture-loader.test.mjs' };
  const { init } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')));
  runtime = await init(`http://127.0.0.1:${server.address().port}/engine.wasm`);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  facts.serverClosed = !server?.listening;
  if (temp) await rm(temp, { recursive: true, force: true });
  facts.temporaryPackageRemoved = true;
  for (const path of ['tests/editing/driver.ts', 'tests/editing/fixture-loader.ts', 'tests/editing/fixture-loader.test.mjs'])
    (facts.driverHashes ??= {})[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'harness.json'), JSON.stringify(facts, null, 2));
});
const recipe = id => structuredClone(suite.recipes.find(r => r.id === id));

test('architecture corpus is the authority; catalogs and variants stay planned', () => {
  assert.equal(suite.recipes.length, 14); assert.equal(suite.manifest.guards.length, 14);
  assert.ok(suite.catalogs.length > 100);
  const desktop = suite.catalogs.filter(c => c.path === 'tests/desktop-editing-cases.md');
  assert.equal(desktop.length, suite.manifest.catalogs.find(c => c.path === 'tests/desktop-editing-cases.md').expectedCases);
  assert.ok(desktop.some(c => c.id === 'NAT-01' && c.variantRequirement.includes('UTF-16 and code-point variants')));
  assert.ok(desktop.some(c => c.id === 'FPX-04' && c.variantRequirement.includes('Named high-risk triads')));
  assert.deepEqual(desktop.find(c => c.id === 'NAT-01').declaredPlatforms, ['Android']);
  assert.ok(desktop.find(c => c.id === 'FPX-01').declaredProfileConstraints.length);
  assert.ok(desktop.find(c => c.id === 'SEL-01').variants.length > 1);
  assert.ok(desktop.every(c => c.variants.every(v => v.status === 'planned')));
  assert.ok(suite.variantPolicies['tests/desktop-editing-cases.md'].some(s => s.startsWith('Risk dimensions:')));
  assert.ok(suite.catalogs.every(c => c.status === 'planned' && c.owners.length && c.variantRequirement));
});
test('capabilities and action support are both mandatory; no catalog link confers a pass', () => {
  assert.equal(capabilityBinding(recipe('SEQ-01'), capabilities, supportedActions).status, 'implemented-unexecuted');
  assert.ok(capabilityBinding(recipe('SEQ-13'), capabilities, supportedActions).missingCapabilities.includes('semantic-history'));
  assert.ok(capabilityBinding(recipe('SEQ-10'), capabilities, supportedActions).missingActions.includes('nativeInsert'));
  assert.equal(capabilityBinding(recipe('SEQ-01'), new Set(), supportedActions).status, 'unsupported');
  assert.throws(() => groupIds('fabricated'), /Unknown/);
  assert.deepEqual(groupIds('fixtures'), ['SEQ-01', 'SEQ-02']);
});
test('loader retains invalid-input batch actions but rejects invalid expected ranges and unknown case IDs', () => {
  const invalidAction = recipe('SEQ-11'); assertRecipe(invalidAction, suite.catalogIds);
  assert.equal(invalidAction.steps[0].action.operations[1].block, 'missing');
  const range = recipe('SEQ-01'); range.steps[0].expect.state.selection.focus.offset = 99;
  assert.throws(() => assertRecipe(range, suite.catalogIds), /UTF-16 boundary/);
  const id = recipe('SEQ-01'); id.covers = ['FAKE-99'];
  assert.throws(() => assertRecipe(id, suite.catalogIds), /unknown/);
  const golden = recipe('SEQ-01'); golden.steps[0].expect.actualState = golden.steps[0].expect.state;
  assert.throws(() => assertRecipe(golden, suite.catalogIds), /forbidden|unknown field/);
});
for (const id of groupIds('fixtures')) test(`packed independent checkpoints: ${id}`, () => {
  const results = replay(runtime, recipe(id));
  assert.equal(results.length, 2); facts.recipes.push({ id, checkpoints: results.length, status: 'passed', scope: 'representative contract only' });
});
for (const id of ['SEQ-13', 'SEQ-14']) test(`selected replacement binding: ${id} first checkpoint`, () => {
  const r = recipe(id); const driver = new EditingDriver(runtime, r.initial);
  try {
    assertCheckpoint(driver.act(r.steps[0].action), r.steps[0].expect);
    assert.equal(driver.ids.get('p1'), driver.engine.read().visible[0].id);
    facts.checkpoints.push({ recipe: id, step: r.steps[0].id, status: 'passed', remaining: 'undo/redo/sentinel are unqualified' });
  } finally { driver.dispose(); }
});
test('independent snapshot assertions reject corrupted content, logical identity, caret, pending marks and effect counts', () => {
  const r = recipe('SEQ-01'); const driver = new EditingDriver(runtime, r.initial);
  try {
    const actual = driver.act(r.steps[0].action);
    for (const [name, corrupt] of [
      ['content', e => e.state.blocks[1].text = 'WRONG'],
      ['identity', e => e.state.blocks[1].id = 'wrong-id'],
      ['range', e => e.state.selection.focus.offset = 1],
      ['direction', e => e.state.selection.affinity = 'backward'],
      ['pending-marks', e => e.state.pendingMarks = []],
      ['effects', e => e.effects.localCommits = 2],
    ]) { const expected = structuredClone(r.steps[0].expect); corrupt(expected); assert.throws(() => assertCheckpoint(actual, expected), assert.AssertionError); facts.negativeControls.push(name); }
    assertCheckpoint(actual, r.steps[0].expect);
  } finally { driver.dispose(); }
});
test('aliases bind to command result identities and duplicate aliases reject before any commit', () => {
  const r = recipe('SEQ-01'); const driver = new EditingDriver(runtime, r.initial);
  try {
    const before = driver.engine.checkpoint();
    assert.throws(() => driver.act({ type: 'insertParagraph', newBlockId: 'p1' }), /duplicate/);
    assert.deepEqual(driver.engine.checkpoint().bytes, before.bytes);
    const firstId = driver.ids.get('p1'); driver.act(r.steps[0].action);
    assert.equal(driver.ids.get('p1'), firstId); assert.notEqual(driver.ids.get('p2'), firstId);
    const state = driver.snapshot(); state.blocks[0].text = 'mutated caller';
    assert.equal(driver.snapshot().blocks[0].text, 'ab');
  } finally { driver.dispose(); }
});
test('invalid runtime ranges and unsupported profiles fail explicitly with preserved engine state', () => {
  const r = recipe('SEQ-01'); const driver = new EditingDriver(runtime, r.initial);
  try {
    const before = driver.engine.checkpoint();
    assert.throws(() => driver.act({ type: 'setSelection', selection: { anchor: { block: 'p1', offset: 99 }, focus: { block: 'p1', offset: 99 }, affinity: 'forward' } }));
    assert.throws(() => driver.act({ type: 'setSelection', selection: { anchor: { block: 'missing', offset: 0 }, focus: { block: 'missing', offset: 0 }, affinity: 'forward' } }), /Unbound/);
    assert.throws(() => driver.act({ type: 'undo' }), /Unsupported/);
    assert.deepEqual(driver.engine.checkpoint().bytes, before.bytes);
    const marked = recipe('SEQ-01').initial; marked.pendingMarks = [];
    assert.throws(() => new EditingDriver(runtime, marked), /Unsupported initial profile/);
  } finally { driver.dispose(); }
});
test('deterministic clock never moves backwards and disposal is explicit', () => {
  const clock = new FixedClock(); clock.advance(50); assert.equal(clock.now, 50);
  assert.throws(() => clock.advance(49), /monotonic/); assert.throws(() => clock.advance(NaN), /monotonic/);
  const driver = new EditingDriver(runtime, recipe('SEQ-01').initial); driver.dispose(); driver.dispose();
  assert.throws(() => driver.act({ type: 'insertText', text: 'X' }), /Disposed/);
});

test('group command rejects unknown suites instead of zero-test success', async () => {
  for (const group of ['fabricated', 'unqualified-future']) {
    const result = spawnSync(process.execPath, ['scripts/test-editing.mjs', '--group', group], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Unknown|no qualified runtime suite/);
    await writeFile(join(output, `dispatcher-${group}.log`), result.stdout + result.stderr);
  }
});
