import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { auditLedger, runtimeFacts, WEB_FEATURE_FAMILIES } from '../scripts/check-web-feature-ledger.mjs';
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
