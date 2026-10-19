import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { checkCoverage } from '../../scripts/check-revision-review-product.mjs';

const root = new URL('../../', import.meta.url);
const evidence = new URL('../architecture/evidence/revision-review-product-20261019/rvp-3.1/', root);
const manifest = JSON.parse(await readFile(new URL('fixtures/product-scenarios/revision-review/manifest.json', root)));
const keyboard = JSON.parse(await readFile(new URL('keyboard-6/receipt.json', evidence)));
const reopen = JSON.parse(await readFile(new URL('reopen-guard-final/receipt.json', evidence)));
const copy = value => structuredClone(value);
await test('Accept authentic complete three-engine keyboard coverage', () => {
  checkCoverage(keyboard, manifest.scenarios.keyboard, 'keyboard');
});
await test('Reject authentic passing reopen prefix: original retry is missing', () => {
  assert.throws(() => checkCoverage(reopen, manifest.scenarios.reopen, 'reopen'), /incomplete original case coverage/);
});
for (const [name, mutate] of [
  ['forged summary over an omitted original case', r => { r.cases.pop(); }],
  ['duplicate case with unchanged passing total', r => { r.cases[1] = copy(r.cases[0]); }],
  ['missing engine relabeled as three-engine evidence', r => { r.cases = r.cases.filter(c => c.engine !== 'webkit'); }],
  ['skipped original case', r => { r.cases[0].status = 'skipped'; }],
  ['failed original case with success exit', r => { r.cases[0].status = 'failed'; }],
  ['zero or forged executed count', r => { r.counts.executed = 0; }],
  ['nonzero setup failure', r => { r.commands.push({ exit: 1 }); }],
  ['browser teardown failure', r => { r.browsers[0].closed = false; }],
  ['unhandled browser error', r => { r.browsers[0].errors.push('uncaught'); }],
  ['missing independent observations', r => { r.browsers[0].oracles = {}; }],
  ['orphan listener', r => { r.listenerStopped = false; }],
  ['partial selection hidden behind full results', r => { r.selection.notSelected.push(r.selection.selectedCases[0]); }],
  ['failed overall exit despite passing cases', r => { r.exit = 1; }],
  ['wrong named group', r => { r.group = 'integrated'; }],
]) await test(`Reject ${name}`, () => {
  const receipt = copy(keyboard); mutate(receipt);
  assert.throws(() => checkCoverage(receipt, manifest.scenarios.keyboard, 'keyboard'));
});
await test('Accept authentic complete integrated journey coverage', async () => {
  const receipt = JSON.parse(await readFile(new URL('../rvp-3.2/final-integrated-1/receipt.json', evidence)));
  checkCoverage(receipt, manifest.scenarios.integrated, 'integrated');
  // Coverage alone deliberately says nothing about final-main applicability.
});
