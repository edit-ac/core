import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  workspace, MODULES, HOSTS, CAPABILITIES, PLATFORM_OWNERS,
  loadMatrix, validateCapabilities, validateSchema, renderCapabilities, digest,
} from '../scripts/check-extension-capabilities.mjs';

const matrix = loadMatrix();
const manifest = JSON.parse(readFileSync(resolve(workspace, 'core/fixtures/extensions/presenters/conformance.json')));
const schema = JSON.parse(readFileSync(resolve(workspace, 'core/fixtures/extensions/capabilities.schema.json')));
const cell = (m, id = 'CAP-tables-swift-ios-edit') => m.cells.find(c => c.id === id);
const clone = () => structuredClone(matrix);

// This is the complete canonical handoff, consuming actual retained qualification
// receipts. It does not execute OS renderers or qualify device parity.
test('complete canonical matrix qualifies all 210 required cells and pinned receipts', () => {
  const result = validateCapabilities(matrix);
  // Current full reference receipts supersede three historical failed aggregates.
  // Their original evidence must remain, rather than becoming false passes.
  assert.equal(result.retainedPriorFailures.length, 3);
  for (const engine of ["chromium", "firefox", "webkit"]) {
    const old = JSON.parse(readFileSync(resolve(workspace, `architecture/evidence/modules-references/browser-pre-clipboard-repair/${engine}/receipt.json`)));
    assert.equal(old.counts.failed, 1);
  }
  assert.equal(result.retainedPriorFailures.reduce((n, r) => n + r.failed, 0), 3);
  assert.deepEqual({ ...result, retainedPriorFailures: undefined }, {
    retainedPriorFailures: undefined,
    cells: 210, modules: 6, hosts: 5, capabilities: 7,
    evidenceReferences: Object.keys(matrix.evidence).length,
    linkedEvidence: new Set(matrix.cells.flatMap(c => [...c.evidence, ...c.presenterFixtures])).size,
    actualPlatformEvidence: 'pending-downstream',
  });
});

for (const module of MODULES) for (const host of HOSTS) for (const capability of CAPABILITIES) {
  const id = `CAP-${module}-${host}-${capability}`;
  test(id, () => {
    const c = matrix.cells.find(c => c.id === id);
    assert(c, `required cell absent: ${id}`);
    assert.equal(c.owner.roadmap, PLATFORM_OWNERS[host]);
    assert(c.requirement.trim().length > 10);
    assert(c.owner.gates.length > 0);
    assert.equal(c.fallback.preservesUnknown, true);
    assert.equal(c.fallback.richParity, false);
    for (const fixture of c.presenterFixtures) {
      assert(manifest.hosts.find(h => h.id === host).fixtures.includes(fixture));
      assert.equal(matrix.evidence[fixture].host, host);
    }
    const mod = matrix.modules.find(m => m.id === module);
    assert(mod.keyboardFocus.length > 30);
    assert(c.limitation.includes('pending'));
    if (host !== 'browser' && ['view', 'rendering', 'accessibility'].includes(capability)) {
      assert.equal(c.status, 'pending-platform');
      assert.deepEqual(c.evidence, []);
    }
  });
}

const negatives = [
  ['missing module', m => m.modules.pop(), /minItems|missing required modules/],
  ['duplicate module', m => { m.modules[1] = structuredClone(m.modules[0]); }, /duplicate array item|missing required modules/],
  ['missing host', m => m.hosts.pop(), /minItems|missing required hosts/],
  ['duplicate host with different metadata', m => { m.hosts[1].id = 'browser'; }, /missing required hosts/],
  ['missing capability', m => m.capabilities.pop(), /minItems|missing required capabilities/],
  ['missing cell', m => m.cells.pop(), /minItems|missing required module\/host cells/],
  ['duplicate cell with different metadata', m => { m.cells[1] = { ...m.cells[0], requirement: 'different claim' }; }, /duplicate or invalid cell/],
  ['invalid fixture cell ID', m => { cell(m).id = 'CAP-invented'; }, /duplicate or invalid cell/],
  ['extra undeclared cell', m => { m.cells.push({ ...m.cells[0], id: 'extra' }); }, /duplicate or invalid cell/],
  ['unknown schema field', m => { cell(m).implicitFetch = true; }, /unexpected implicitFetch/],
  ['empty keyboard obligations', m => { m.modules[0].keyboardFocus = ' '; }, /empty string/],
  ['empty requirement', m => { cell(m).requirement = ''; }, /empty string/],
  ['unsupported matrix version', m => { m.schemaVersion = 2; }, /const/],
  ['unknown payload loss', m => { cell(m).fallback.preservesUnknown = false; }, /const/],
  ['fallback claimed as rich parity', m => { cell(m).fallback.richParity = true; }, /const/],
  ['fallback text contradicts owning module', m => { cell(m).fallback.behavior = 'flatten source'; }, /contradictory fallback/],
  ['weakened rich parity requirement', m => { cell(m).required = 'fallback'; cell(m).status = 'fallback-only'; }, /weakened parity requirement/],
  ['unrelated host owner', m => { m.hosts.find(h => h.id === 'swift-ios').roadmap = '17-android-sdk.md'; }, /unsupported host owner/],
  ['wrong cell owner', m => { cell(m).owner.roadmap = '17-android-sdk.md'; }, /wrong platform owner/],
  ['unrelated existing owner gate', m => { cell(m).owner.gates = ['IOS-1.1']; }, /unsupported owner gates/],
  ['missing owner gate', m => { cell(m).owner.gates = []; }, /minItems/],
  ['absent presenter obligation', m => { cell(m).presenterFixtures.pop(); }, /missing presenter obligation/],
  ['wrong host fixture', m => { cell(m).presenterFixtures[0] = 'PRES-browser-focus'; }, /missing presenter obligation/],
  ['missing presenter evidence', m => { delete m.evidence['PRES-swift-ios-focus']; }, /missing presenter fixture/],
  ['headless promoted to native rich parity', m => { cell(m).status = 'browser-mechanics-qualified'; cell(m).evidence = ['PRES-swift-ios-focus']; }, /unsupported browser claim/],
  ['native actual evidence claimed', m => { m.hosts[0].actualPlatformEvidence = 'qualified'; }, /const/],
  ['missing evidence reference', m => { cell(m).evidence = ['invented']; }, /unsupported evidence reference/],
  ['unsafe path', m => { m.evidence['preserve-slash'].path = 'architecture/../core/package.json'; }, /unsupported evidence path/],
  ['absolute path', m => { m.evidence['preserve-slash'].path = resolve(workspace, 'core/package.json'); }, /unsupported evidence path/],
  ['stale receipt hash', m => { m.evidence['preserve-slash'].sha256 = '0'.repeat(64); }, /evidence hash drift/],
  ['stale source hash', m => { m.inputs['core/packages/web/src/modules/slash.ts'] = '0'.repeat(64); }, /input hash drift/],
  ['missing required source input', m => { delete m.inputs['core/fixtures/extensions/conformance.json']; }, /missing required input/],
  ['missing owner revision pin', m => { delete m.inputs['architecture/roadmaps/16-ios-sdk.md']; }, /missing required input/],
  ['invented browser fixture', m => { Object.values(m.evidence).find(e => e.kind === 'browser-proof').fixtureId = 'not-executed'; }, /unsupported browser evidence/],
  ['invented portable fixture', m => { m.evidence['preserve-slash'].fixtureId = 'not-executed'; }, /unsupported fixture/],
  ['receipt from unrelated gate', m => { m.evidence['preserve-slash'].path = 'architecture/evidence/extension-presenters/receipt.json'; m.evidence['preserve-slash'].sha256 = digest(readFileSync(resolve(workspace, m.evidence['preserve-slash'].path))); }, /unsupported receipt/],
  ['headless fixture not executed', m => { m.evidence['PRES-swift-ios-focus'].fixtureId = 'PRES-swift-ios-not-executed'; }, /unsupported fixture/],
  ['lost unknown preservation proof', m => { cell(m, 'CAP-images-browser-preservation').evidence = ['preserve-builtin-images']; }, /missing unknown preservation/],
  ['lost built-in preservation proof', m => { cell(m, 'CAP-images-browser-preservation').evidence = ['preserve-images']; }, /missing built-in preservation/],
  ['cross-module browser evidence', m => { cell(m, 'CAP-tables-browser-view').evidence = cell(m, 'CAP-references-browser-view').evidence; }, /unsupported browser claim/],
  ['missing required browser engine', m => { const c = cell(m, 'CAP-tables-browser-view'); c.evidence = c.evidence.filter(id => m.evidence[id].engine !== 'webkit'); }, /missing browser engines/],
  ['AT parity inferred from headless fixtures', m => { cell(m, 'CAP-tables-browser-accessibility').status = 'browser-mechanics-qualified'; cell(m, 'CAP-tables-browser-accessibility').evidence = ['PRES-browser-accessibility']; }, /unsupported browser claim/],
  ['future renderer accepted with protocol proof', m => { cell(m).evidence = ['PRES-swift-ios-focus']; }, /unqualified status with evidence/],
];
for (const [name, mutate, error] of negatives) test(`reject ${name}`, () => {
  const m = clone(); mutate(m); assert.throws(() => validateCapabilities(m), error);
});

test('changed module source requires a separate qualified return', () => {
  const m = clone(); delete m.sourceReturns['packages/web/src/modules/slash.ts'];
  assert.throws(() => validateCapabilities(m), /missing qualified source: slash/);
});
for (const [name, mutate, error] of [
  ['failed cases', r => { r.counts.failed = 1; }, /current source return counts/],
  ['skipped cases', r => { r.counts.skipped = 1; }, /current source return counts/],
  ['wrong source', r => { r.sources['packages/web/src/modules/slash.ts'] = '0'.repeat(64); }, /current source return pin/],
  ['missing selected case', r => { r.cases[0].name = 'missing'; }, /current source return cases/],
]) test('reject repinned current source return: '+name, () => {
  const m = clone(), proof = m.sourceReturns['packages/web/src/modules/slash.ts'].proofs[0];
  const artifact = JSON.parse(readFileSync(resolve(workspace, proof.path)));
  // Select the first executed case so removing it exercises selected coverage.
  proof.cases = [artifact.cases[0].name]; mutate(artifact);
  const bytes = Buffer.from(JSON.stringify(artifact)); proof.sha256 = digest(bytes);
  const read = (p, encoding) => p === resolve(workspace, proof.path) ? (encoding ? bytes.toString(encoding) : bytes) : readFileSync(p, encoding);
  assert.throws(() => validateCapabilities(m, {read}), error);
});

// Repin edited receipts to test semantic admission rather than just hash detection.
function alteredReceipt(path, mutate) {
  const m = clone(), receipt = JSON.parse(readFileSync(resolve(workspace, path)));
  mutate(receipt);
  const bytes = Buffer.from(JSON.stringify(receipt));
  for (const e of Object.values(m.evidence)) if (e.path === path) e.sha256 = digest(bytes);
  const read = (p, encoding) => p === resolve(workspace, path) ? (encoding ? bytes.toString(encoding) : bytes) : readFileSync(p, encoding);
  return () => validateCapabilities(m, { read });
}
for (const [name, mutate] of [
  ['failed check', r => { r.checks.find(c => c.executed).failed = 1; }],
  ['skipped check', r => { r.checks.find(c => c.executed).skipped = 1; }],
  ['zero executed', r => { r.checks.find(c => c.executed).executed = 0; }],
  ['inconsistent passed count', r => { r.checks.find(c => c.executed).passed--; }],
  ['invalid implementation revision', r => { r.implementationRevision = 'mutable-main'; }],
  ['unverified state', r => { r.state = 'planned'; }],
]) test(`reject repinned portable receipt: ${name}`, () => {
  assert.throws(alteredReceipt('architecture/evidence/extension-contract/receipt.json', mutate), /missing executed qualification|unqualified receipt/);
});
test('reject repinned headless receipt without required fixture coverage', () => {
  assert.throws(alteredReceipt('architecture/evidence/extension-presenters/receipt.json', r => { r.coverage = []; }), /headless coverage/);
});
test('reject repinned portable receipt without built-in execution', () => {
  assert.throws(alteredReceipt('architecture/evidence/extension-contract/receipt.json', r => { r.cellIds = r.cellIds.filter(id => id !== 'builtin-image'); }), /missing preservation coverage/);
});
test('schema fails closed on unsupported vocabulary', () => {
  assert.throws(() => validateSchema(matrix, { ...schema, oneOf: [] }), /unsupported schema keyword/);
});
test('document is generated from canonical matrix with every row and owner', () => {
  const doc = readFileSync(resolve(workspace, 'core/docs/extensions/capabilities.md'), 'utf8');
  assert.equal(doc, renderCapabilities(matrix));
  for (const module of MODULES) for (const host of HOSTS) assert(doc.includes(`| ${module} | ${host} |`));
  for (const owner of Object.values(PLATFORM_OWNERS)) assert(doc.includes(owner));
  assert(doc.includes('Physical FMT-1.15 remains release-open'));
});
test('handoff remains data-only with no embedded executable renderer or network credential', () => {
  const encoded = JSON.stringify(matrix);
  assert(!/bearer\s+[a-z0-9]|api[_-]?key|<script|function\s*\(/iu.test(encoded));
  assert.equal(matrix.parent, 'EXT-1.7');
});

function alteredBrowserReceipt(mutate) {
  const m = clone();
  const evidence = Object.values(m.evidence).find(e => e.kind === 'browser-proof' && e.module === 'slash');
  const path = evidence.path;
  const receipt = JSON.parse(readFileSync(resolve(workspace, path)));
  mutate(receipt, evidence.fixtureId);
  const bytes = Buffer.from(JSON.stringify(receipt));
  const sha256 = digest(bytes);
  for (const e of Object.values(m.evidence)) if (e.path === path) e.sha256 = sha256;
  const baselinePath = 'architecture/evidence/modules-matrix/capabilities.json';
  const baseline = JSON.parse(readFileSync(resolve(workspace, baselinePath)));
  for (const module of baseline.modules) for (const proof of module.proofs) {
    if ('architecture/evidence/' + proof.artifact === path) proof.sha256 = sha256;
  }
  const baselineBytes = Buffer.from(JSON.stringify(baseline));
  m.inputs[baselinePath] = digest(baselineBytes);
  const replacements = new Map([[resolve(workspace, path), bytes], [resolve(workspace, baselinePath), baselineBytes]]);
  const read = (p, encoding) => replacements.has(p) ? (encoding ? replacements.get(p).toString(encoding) : replacements.get(p)) : readFileSync(p, encoding);
  return () => validateCapabilities(m, { read });
}
for (const [name, mutate, expected] of [
  ['selected failed case', (r, id) => { r.cases.find(c => c.name === id).passed = false; r.counts.failed++; r.counts.passed--; }, /missing browser case/],
  ['missing executed case', (r, id) => { r.cases = r.cases.filter(c => c.name !== id); r.counts.executed--; r.counts.passed--; }, /missing browser case/],
  ['selected case with errors', (r, id) => { r.cases.find(c => c.name === id).errors = ['fixture error']; }, /missing browser case/],
  ['wrong engine', r => { r.engine = 'invented'; }, /browser revision\/engine/],
  ['mutable revision', r => { r.revision = 'main'; }, /browser revision\/engine/],
  ['zero executed', r => { r.counts.executed = 0; }, /inconsistent browser receipt counts/],
  ['inconsistent counts', r => { r.counts.passed--; }, /inconsistent browser receipt counts/],
  ['wrong source hash', r => { r.sources['packages/web/src/modules/slash.ts'] = '0'.repeat(64); }, /browser source drift/],
]) test(`reject repinned browser receipt: ${name}`, () => {
  assert.throws(alteredBrowserReceipt(mutate), expected);
});
