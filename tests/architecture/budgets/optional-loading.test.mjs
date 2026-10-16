import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitOptionalLoading, inspectOptionalLoading } from '../../../scripts/optional-loading-evidence.mjs';
import { digest } from '../../../scripts/architecture-budgets.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const index = JSON.parse(await readFile(resolve(root, 'benchmarks/profiles/optional-loading-evidence.json')));
const directory = resolve(root, index.directory);
const bytes = await readFile(resolve(directory, 'optional-loading.json'));
assert.equal(digest(bytes), index.receiptHash, 'Changed current optional loading receipt');
const record = JSON.parse(bytes), evidence = { version: 1, receiptHash: index.receiptHash, observations: null };
test('current optional loading admits exact current packages, disabled/enabled costs and all three runtime engines', async () => {
  evidence.observations = await admitOptionalLoading(root, directory, record);
  assert.deepEqual(evidence.observations, record.summary);
});
for (const [name, mutate] of [
  ['failed producer', r => r.errors.push('failure')],
  ['post-hoc policy', r => r.reviewedAt = r.startedAt],
  ['missing command', r => r.commands.pop()],
  ['failed measurement', r => r.commands[1].exit = 1],
  ['unretained command log', r => r.commands[0].sha256 = '0'.repeat(64)],
  ['skipped browser', r => r.commands[2].counts.skipped = 1],
  ['zero browser cases', r => r.commands[2].counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }],
  ['missing enabled profile', r => delete r.profiles.markdown],
  ['duplicate browser engine', r => r.profiles.default.runtime.cases[1].engine = 'chromium'],
  ['failed runtime', r => r.profiles.default.runtime.cases[0].passed = false],
  ['runtime error', r => r.profiles.default.runtime.cases[0].errors.push('failure')],
  ['leaked browser', r => r.profiles.default.runtime.cases[0].cleanup.browserExited = false],
  ['leaked server', r => r.profiles.markdown.runtime.cases[0].cleanup.serverClosed = false],
  ['different executed asset', r => r.profiles.default.runtime.artifacts[0].sha256 = '0'.repeat(64)],
  ['missing runtime request', r => r.profiles.default.runtime.cases[0].requests = []],
  ['disabled parser eager fetch', r => r.profiles.default.runtime.cases[0].requests.push('http://localhost/wasm/editac_markdown_wasm_bg.wasm')],
  ['enabled parser never fetched', r => r.profiles.markdown.runtime.cases[0].requests = r.profiles.markdown.runtime.cases[0].requests.filter(p => !p.includes('markdown'))],
  ['different base packages', r => r.profiles.markdown.measurement.packs.find(p => p.name === 'core').sha256 = '0'.repeat(64)],
]) test('current optional loading rejects ' + name, () => {
  const changed = structuredClone(record); mutate(changed); assert.throws(() => inspectOptionalLoading(changed));
});
for (const [name, mutate, pattern] of [
  ['incomplete source closure', r => delete r.sourceInputs['Cargo.lock'], /source closure/],
  ['stale current source', r => r.sourceInputs['Cargo.lock'] = '0'.repeat(64), /Changed/],
  ['stale retained asset', r => r.artifacts[Object.keys(r.artifacts).find(p => p.endsWith('/task.js'))] = '0'.repeat(64), /Changed/],
  ['changed retained policy', r => r.verificationSpecHash = '0'.repeat(64), /policy drift/],
]) test('current optional loading rejects ' + name, async () => {
  const changed = structuredClone(record); mutate(changed); await assert.rejects(admitOptionalLoading(root, directory, changed), pattern);
});
after(async () => {
  const output = process.env.EDITAC_ARCHITECTURE_OUTPUT; assert(output, 'Explicit canonical output required');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'optional-loading-inventory.json'), JSON.stringify(evidence, null, 2) + '\n');
});
