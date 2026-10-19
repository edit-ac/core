import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserHarness } from './browser-harness.ts';

const { probe } = browserHarness('prepared-admission', 'fixtures/browser-prepared-admission', {
  autoMount: false, assertSourcesUnchanged: true, serverOptions: { recordRequests: true },
  sourcePaths: ['fixtures/browser-prepared-admission/index.html', 'fixtures/browser-prepared-admission/session.mjs',
    'packages/web/src/storage/owner.ts', 'packages/web/src/storage/index.ts', 'packages/web/src/review/history.ts',
    'packages/web/src/entry.ts', 'crates/editac-core/src/history.rs'],
  async prepareConsumer(consumer, { facts, run }) {
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const archives = facts.packs.map(pack => join(consumer, pack.name, pack.file));
    await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--no-save', '--prefix', consumer, ...archives], 'install-offline.log');
    const installed = [];
    for (const pack of facts.packs) {
      const directory = join(consumer, 'node_modules', '@edit-ac', pack.name);
      const bytes = await readFile(join(directory, 'package.json')), metadata = JSON.parse(bytes);
      assert.equal(metadata.name, `@edit-ac/${pack.name}`); assert.equal(metadata.version, '0.0.0');
      await rm(join(consumer, pack.name, 'package'), { recursive: true });
      await symlink(directory, join(consumer, pack.name, 'package'), 'dir');
      installed.push({ name: metadata.name, version: metadata.version, manifestSha256: createHash('sha256').update(bytes).digest('hex') });
    }
    facts.installation = { method: 'npm install --offline --ignore-scripts from the two pinned local archives', installed,
      served: 'Actual installed node_modules package directories; public root import-map entrypoints, no workspace/source alias' };
    return 'fixtures/browser-prepared-admission';
  },
});
async function mount(page) {
  await page.waitForFunction(() => !!window.restoreFixture);
  await page.evaluate(() => window.restoreFixture.mount());
}
const oracle = page => page.evaluate(() => window.restoreFixture.oracle());
const updates = value => value.patches.filter(p => p.update);

test('installed public restore captures previews cancels and confirms one durable identity-preserving edit with isolated undo redo and reopen', () => probe('public-restore-lifecycle', async (page, fact) => {
  await mount(page); await page.evaluate(() => window.restoreFixture.edit());
  const before = await oracle(page);
  await page.evaluate(() => { const f = window.restoreFixture; f.restorer.preview(f.old); }); // cancel: discard the detached preview
  assert.deepEqual(await oracle(page), before);
  const preview = await page.evaluate(() => { const f = window.restoreFixture; window.preview = f.restorer.preview(f.old); return window.preview; });
  assert.equal(preview.changes.length, 1); assert.equal(preview.changes[0].before, 'current β'); assert.equal(preview.changes[0].after, 'before 😀');
  assert.deepEqual(await oracle(page), before);
  const result = await page.evaluate(() => window.restoreFixture.restorer.apply(window.preview));
  assert.equal(result.kind, 'applied'); const restored = await oracle(page);
  assert.deepEqual(restored.texts, ['before 😀', 'neighbor']); assert.equal(restored.sameReplica, true);
  assert.deepEqual(restored.snapshot.identity, before.snapshot.identity);
  assert.deepEqual(restored.snapshot.visible.map(n => n.id), before.snapshot.visible.map(n => n.id));
  assert.equal(restored.releases, 1); assert.ok(restored.snapshot.revision > before.snapshot.revision);
  assert.equal(updates(before).length, 1); assert.equal(updates(restored).length, 2);
  assert.equal(restored.disk.checkpoints.length, 1); assert.equal(restored.disk.updates.length, 2);
  assert.equal(restored.disk.updates[1].origin, 'editac:local:history-restore');
  assert.deepEqual(restored.disk.updates[1].bytes, updates(restored)[1].update.bytes);
  assert.equal(updates(restored)[1].origin, 'editac:local:history-restore');
  assert.equal(restored.history.undoGroups, before.history.undoGroups + 1);
  assert.notDeepEqual(restored.vector, before.vector); assert.notDeepEqual(restored.update, before.update);
  const replay = await page.evaluate(() => window.restoreFixture.restorer.apply(window.preview));
  assert.equal(replay.reason, 'stale'); assert.deepEqual(await oracle(page), restored);
  await page.evaluate(() => window.restoreFixture.engine.history({ type: 'undo' })); const undone = await oracle(page);
  assert.deepEqual(undone.texts, ['current β', 'neighbor']);
  await page.evaluate(() => window.restoreFixture.engine.history({ type: 'redo' })); const redone = await oracle(page);
  assert.deepEqual(redone.texts, restored.texts); assert.equal(redone.sameReplica, true);
  const reopened = await page.evaluate(() => window.restoreFixture.reopen());
  assert.deepEqual(reopened.texts, restored.texts); assert.deepEqual(reopened.snapshot.identity, before.snapshot.identity);
  assert.deepEqual(reopened.snapshot.visible, redone.snapshot.visible);
  fact.snapshots.push({ before, preview, result, restored, undone, redone, reopened });
}));

test('stale and forged detached previews do not change real document history or IndexedDB', () => probe('stale-preview', async (page, fact) => {
  await mount(page); await page.evaluate(() => window.restoreFixture.edit());
  await page.evaluate(() => { const f = window.restoreFixture; window.preview = f.restorer.preview(f.old); });
  await page.evaluate(() => window.restoreFixture.edit('intervening'));
  const before = await oracle(page);
  const results = await page.evaluate(() => { const f = window.restoreFixture; return [f.restorer.apply(structuredClone(window.preview)), f.restorer.apply(window.preview)]; });
  assert.deepEqual(results.map(r => r.reason), ['stale', 'stale']); const after = await oracle(page);
  assert.deepEqual(after, before); fact.snapshots.push({ before, after, results });
}));

test('actual stale foreign released and replayed Rust capabilities cannot mutate the public owner', () => probe('prepared-token-fences', async (page, fact) => {
  await mount(page); const result = await page.evaluate(() => window.restoreFixture.rejectTokens());
  assert.deepEqual(result.rejected, result.before); assert.deepEqual(result.replayAfter, result.replayBefore);
  assert.deepEqual(result.errors.map(([label]) => label), ['stale', 'foreign', 'released', 'replay']);
  for (const [, error] of result.errors) assert.notEqual(error, 'unexpected-success');
  assert.deepEqual(result.replayBefore.texts, ['accepted', 'neighbor']);
  assert.equal(result.replayBefore.disk.updates.length, result.before.disk.updates.length + 1);
  fact.snapshots.push(result);
}));

for (const policy of ['readonly', 'recovery']) test(`host ${policy} denial between preview and confirmation leaves every oracle unchanged`, () => probe(`denied-${policy}`, async (page, fact) => {
  await mount(page); await page.evaluate(() => window.restoreFixture.edit());
  await page.evaluate(() => { const f = window.restoreFixture; window.preview = f.restorer.preview(f.old); });
  const before = await oracle(page); await page.evaluate(policy => window.restoreFixture.deny(policy), policy);
  const results = await page.evaluate(() => { const f = window.restoreFixture; return [f.restorer.apply(window.preview), f.restorer.preview(f.old)]; });
  assert.deepEqual(results.map(r => r.reason), ['readonly', 'readonly']); const after = await oracle(page);
  assert.deepEqual(after, before); fact.snapshots.push({ before, after, results });
}));

for (const kind of ['marks', 'structure', 'opaque']) test(`unsupported ${kind} remain visible and are rejected without normalization`, () => probe(`unsupported-${kind}`, async (page, fact) => {
  await mount(page); await page.evaluate(kind => window.restoreFixture.unsupported(kind), kind);
  const before = await oracle(page), result = await page.evaluate(() => { const f = window.restoreFixture; return f.restorer.preview(f.old); });
  assert.equal(result.reason, 'unsupported'); const after = await oracle(page); assert.deepEqual(after, before);
  if (kind === 'marks') assert.ok(before.snapshot.visible[0].runs.some(r => r.attributes.bold));
  if (kind === 'structure') assert.equal(before.snapshot.visible[0].blockAttributes[0], 'code');
  if (kind === 'opaque') assert.ok(JSON.stringify(before.snapshot.retainedStructure).includes('module:vendor-style'));
  fact.snapshots.push({ before, after, result });
}));

test('disposed owner keeps a captured public bridge fenced and cannot add durable writes', () => probe('disposed-owner', async (page, fact) => {
  await mount(page); const result = await page.evaluate(() => window.restoreFixture.disposedAdmission());
  assert.match(result.error, /destroyed/); assert.deepEqual(result.after, result.before); fact.snapshots.push(result);
}));
