import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { auditLedger, runtimeFacts, tapFacts, WEB_FEATURE_FAMILIES } from '../scripts/check-web-feature-ledger.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const raw = () => ({ counts: { executed: 1, passed: 1, failed: 0, skipped: 0 }, cases: [{ name: 'semantic-oracle', passed: true }], packs: [{ file: 'sdk.tgz', sha256: sha('packed fixture bytes') }], sources: { 'owner.ts': sha('export const owner = 1;') }, engine: 'chromium' });

for (const [name, mutate] of [
  ['zero execution', r => { r.counts.executed = r.counts.passed = 0; r.cases = []; }],
  ['failed evidence', r => { r.counts.failed = 1; }],
  ['skipped evidence', r => { r.counts.skipped = 1; }],
  ['cancelled evidence', r => { r.counts.cancelled = 1; }],
  ['missing required cases', r => { r.counts.required = 2; }],
  ['forged successful aggregate', r => { r.counts.reused = 1; r.cases.push({ name: 'unexecuted', passed: true }); }],
  ['contradictory case outcome', r => { r.cases[0].status = 'failed'; }],
  ['source mutation during execution', r => { r.sourcesUnchanged = false; }],
]) test(`Reject ${name}`, () => { const receipt = raw(); mutate(receipt); assert.throws(() => runtimeFacts(receipt)); });

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'editac-web-ledger-'));
  try {
    const source = 'export const owner = 1;';
    const sources = JSON.stringify({ 'owner.ts': sha(source) });
    const receipt = JSON.stringify(raw());
    for (const [name, value] of Object.entries({ 'owner.ts': source, 'sources.json': sources, 'receipt.json': receipt, 'sdk.tgz': 'packed fixture bytes' })) await writeFile(join(root, name), value);
    const ledger = { version: 1, parent: 'WFE-3.1', requiredFamilies: [...WEB_FEATURE_FAMILIES],
      proofs: [{ id: 'owner', owner: 'fixture only', command: 'prepared evidence fixture', sourceManifests: [{ path: 'sources.json', sha256: sha(sources) }], receipts: [{ path: 'receipt.json', sha256: sha(receipt) }] }],
      features: WEB_FEATURE_FAMILIES.map((family, i) => ({ id: `fixture-${i}`, parent: 'WFE-3.1', family, requirement: 'fixture only', oracles: 'fixed expected semantic value', nextAction: 'fixture only', apis: [{ package: 'fixture', path: 'owner.ts', symbol: 'owner' }], proofs: [{ id: 'owner', engines: ['chromium'], cases: ['semantic-oracle'] }] })) };
    await run(root, ledger);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Authenticate exact source, raw executed cases and installed package bytes', () => fixture(async (root, ledger) => {
  const report = await auditLedger(ledger, root);
  assert.equal(report.allIndexedEvidenceApplicable, true);
  assert.deepEqual(report.counts, { features: 8, sourceCompatible: 8, unresolved: 0, receiptsAuthenticated: 1 });
}));

test('Source drift is actionable evidence and never closes a feature', () => fixture(async (root, ledger) => {
  await writeFile(join(root, 'owner.ts'), 'export const owner = 2;');
  const report = await auditLedger(ledger, root);
  assert.equal(report.allIndexedEvidenceApplicable, false);
  assert.equal(report.proofs[0].sourceChecks[0].drift[0].path, 'owner.ts');
  assert.equal(report.counts.sourceCompatible, 0);
}));

for (const path of ['receipt.json', 'sources.json', 'sdk.tgz']) test(`Reject replaced ${path}`, () => fixture(async (root, ledger) => {
  await writeFile(join(root, path), 'replaced bytes');
  const report = await auditLedger(ledger, root);
  assert.equal(report.allIndexedEvidenceApplicable, false);
  assert.ok(report.proofs[0].errors.length);
}));

test('Missing case/engine, incomplete coverage and missing original family remain unresolved', () => fixture(async (root, ledger) => {
  ledger.features[0].proofs[0].cases = ['never-executed'];
  ledger.features[1].proofs[0].engines = ['firefox'];
  ledger.features[2].gap = 'Original independent format-reader proof still missing';
  const report = await auditLedger(ledger, root);
  assert.equal(report.counts.unresolved, 3);
  ledger.features.pop();
  await assert.rejects(auditLedger(ledger, root), /Missing family/);
}));

test('Duplicate source pins cannot conceal a changed dependency', () => fixture(async (root, ledger) => {
  const source = JSON.stringify([{ path: 'owner.ts', sha256: sha('old source') }, { path: 'owner.ts', sha256: sha('export const owner = 1;') }]);
  await writeFile(join(root, 'sources.json'), source);
  ledger.proofs[0].sourceManifests[0].sha256 = sha(source);
  const report = await auditLedger(ledger, root);
  assert.equal(report.allIndexedEvidenceApplicable, false);
  assert.match(report.proofs[0].errors[0], /Duplicate source pin/);
}));

const tap = `TAP version 13
# Subtest: independent artifact oracle
ok 1 - independent artifact oracle
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
test('Read actual assertion outcomes from flat Node TAP rather than runtime callbacks', () => {
  assert.deepEqual(tapFacts(tap).cases, [{ id: '1:independent artifact oracle', passed: true }]);
});
for (const [name, change] of [
  ['missing summary', t => t.replace('# tests 1', '')],
  ['duplicate summary', t => t + '# pass 1\n'],
  ['wrong plan', t => t.replace('1..1', '1..2')],
  ['wrong pass count', t => t.replace('# pass 1', '# pass 2')],
  ['failed assertion', t => t.replace('ok 1 -', 'not ok 1 -').replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1')],
  ['skipped assertion', t => t.replace('artifact oracle\n1..', 'artifact oracle # SKIP unavailable\n1..')],
  ['todo assertion', t => t.replace('artifact oracle\n1..', 'artifact oracle # TODO unavailable\n1..')],
  ['cancelled run', t => t.replace('# cancelled 0', '# cancelled 1')],
  ['noncontiguous case', t => t.replace('ok 1 -', 'ok 2 -')],
  ['bailout', t => t + 'Bail out! interrupted\n'],
  ['nested TAP', t => t + '    ok 1 - nested\n'],
]) test(`Reject TAP ${name}`, () => assert.throws(() => tapFacts(change(tap))));

test('Select original passing assertions without laundering an adjacent retained failure', () => {
  const mixed = tap.replace('1..1', 'not ok 2 - failed boundary\n1..2').replace('# tests 1', '# tests 2').replace('# fail 0', '# fail 1');
  const selected = tapFacts(mixed, ['1:independent artifact oracle']);
  assert.equal(selected.counts.executed, 1);
  assert.equal(selected.originalCounts.failed, 1);
  assert.deepEqual(selected.retainedFailures, ['2:failed boundary']);
  assert.throws(() => tapFacts(mixed));
  assert.throws(() => tapFacts(mixed, ['2:failed boundary']));
  assert.throws(() => tapFacts(mixed, []));
  assert.throws(() => tapFacts(mixed, ['1:independent artifact oracle', '1:independent artifact oracle']));
});
async function tapFixture(run) {
  return fixture(async (root, ledger) => {
    const pin = async (path, value) => { await writeFile(join(root, path), value); return { path, sha256: sha(value) }; };
    const sources = ledger.proofs[0].sourceManifests[0];
    const packages = await pin('packages.json', JSON.stringify({ archives: [{ path: '/historical/sdk.tgz', sha256: sha('packed fixture bytes') }] }));
    const execution = await pin('execution.json', JSON.stringify({ program: 'node', args: ['--test', 'contract.mjs'], exit: 0, signal: null, log: 'raw.tap' }));
    const raw = { ...await pin('raw.tap', tap), kind: 'node-tap', sources, packages, execution, engine: 'chromium' };
    ledger.proofs[0].receipts = [raw];
    for (const f of ledger.features) f.proofs[0].cases = ['1:independent artifact oracle'];
    const definition = `import 'oracle';\ntest('independent artifact oracle', () => check(bytes));\n`;
    await pin('contract.mjs', definition);
    const prior = await pin('prior-contract.mjs', definition);
    await pin('current.bin', 'exact artifact'); await pin('prior.bin', 'exact artifact');
    const command = await pin('reader-command.json', JSON.stringify({ program: 'python', args: ['oracle.py', 'prior.bin'], exit: 0, signal: null }));
    raw.selectedCases = ['1:independent artifact oracle'];
    raw.artifactReuse = await pin('reuse.json', JSON.stringify({ artifacts: [{ current: 'current.bin', prior: 'prior.bin', sha256: sha('exact artifact') }], commands: [command], definition: { current: 'contract.mjs', prior } }));
    await run(root, ledger);
  });
}
test('Authenticate exact reader input bytes, original TAP, helpers, assertions and command exits', () => tapFixture(async (root, ledger) => {
  const report = await auditLedger(ledger, root);
  assert.equal(report.allIndexedEvidenceApplicable, true);
  assert.equal(report.proofs[0].receipts[0].evidenceMode, 'exact-artifact-reader-reuse');
  assert.equal(report.proofs[0].receipts[0].originalCounts.executed, 1);
}));
for (const [path, bytes] of [
  ['current.bin', 'changed current artifact'], ['prior.bin', 'changed historical artifact'],
  ['prior-contract.mjs', 'changed prior definition'],
  ['contract.mjs', `import 'changed helper';\ntest('independent artifact oracle', () => check(bytes));\n`],
  ['contract.mjs', `import 'oracle';\ntest('independent artifact oracle', () => skip(bytes));\n`],
  ['reader-command.json', '{"exit":1}'], ['raw.tap', tap.replace('# pass 1', '# pass 2')],
  ['sdk.tgz', 'replaced package'], ['owner.ts', 'changed dependency'],
]) test(`Refuse reader reuse after ${path} changes`, () => tapFixture(async (root, ledger) => {
  await writeFile(join(root, path), bytes);
  const report = await auditLedger(ledger, root);
  assert.equal(report.allIndexedEvidenceApplicable, false);
}));
