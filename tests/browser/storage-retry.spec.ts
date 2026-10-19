import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserHarness } from './browser-harness.ts';

const { probe } = browserHarness('storage-retry', 'fixtures/browser-storage-retry', {
  autoMount: false, assertSourcesUnchanged: true, serverOptions: { recordRequests: true },
  sourcePaths: ['fixtures/browser-storage-retry/index.html', 'fixtures/browser-storage-retry/session.mjs',
    'packages/web/src/storage/owner.ts', 'packages/web/src/storage/index.ts', 'packages/web/src/storage/journal.ts',
    'packages/web/src/storage/transaction.ts', 'packages/web/src/entry.ts', 'packages/web/src/storage/writer.ts',
    'packages/web/src/storage/checkpoint.ts', 'crates/editac-core/src/history.rs'],
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
    facts.installation = { method: 'offline npm install of pinned local archives', installed,
      served: 'Actual installed node_modules, public root entrypoints; no source/private imports' };
    return 'fixtures/browser-storage-retry';
  },
});
async function mount(page) {
  await page.waitForFunction(() => !!window.retryFixture);
  await page.evaluate(() => window.retryFixture.mount());
}
const oracle = page => page.evaluate(() => window.retryFixture.oracle());
const stable = ({ attempts, disk, recovery, ...state }) => state;
const sha = bytes => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');

// One canonical public-owner recovery boundary per engine. All semantic/durable
// assertions execute against the installed SDK and real browser IndexedDB.
test('51 retained public owner updates survive repeated denial then shared retry and exact durable reopen without history mutation', () => probe('retained-journal-retry-reopen', async (page, fact) => {
  await mount(page);
  try {
    const initial = await oracle(page);
    await page.evaluate(() => {
      const f = window.retryFixture; f.deny(true);
      for (let i = 0; i < 51; i++) f.edit(`retained ${i} 😀`);
    });
    const denial = await page.evaluate(() => window.retryFixture.flush());
    assert.equal(denial.ok, false); assert.equal(denial.name, 'NotAllowedError');
    const before = await oracle(page);
    assert.equal(before.recovery.unsavedUpdates.length, 51); assert.equal(before.attempts, 51);
    assert.equal(before.sameReplica, true); assert.deepEqual(before.texts, ['retained 50 😀', 'neighbor']);
    assert.deepEqual(before.disk, initial.disk); assert.equal(before.patches.length, 51);
    const deniedRetry = await page.evaluate(() => window.retryFixture.flush(true, true));
    assert.equal(deniedRetry.ok, false); assert.equal(deniedRetry.name, 'NotAllowedError');
    const again = await oracle(page);
    assert.equal(again.attempts, 102); assert.deepEqual(stable(again), stable(before));
    assert.deepEqual(again.recovery, before.recovery); assert.deepEqual(again.disk, initial.disk);
    await page.evaluate(() => window.retryFixture.deny(false));
    const ordinary = await page.evaluate(() => window.retryFixture.flush());
    assert.equal(ordinary.ok, false); assert.equal((await oracle(page)).attempts, 102);
    const result = await page.evaluate(() => window.retryFixture.flush(true, true));
    assert.deepEqual(result, { ok: true }); const after = await oracle(page);
    assert.equal(after.attempts, 153); assert.deepEqual(stable(after), stable(before));
    assert.equal(after.recovery.unsavedUpdates.length, 0);
    assert.deepEqual(after.recovery.checkpoint, before.recovery.checkpoint);
    assert.deepEqual(after.disk.checkpoints, initial.disk.checkpoints);
    assert.equal(after.disk.updates.length, 51);
    const updates = before.recovery.unsavedUpdates;
    for (const expected of updates) {
      const entry = after.disk.updates.find(e => e.writerId === expected.writerId && e.sequence === expected.sequence);
      assert.ok(entry); const { checksum, updateId, ...update } = entry;
      assert.deepEqual(update, expected); assert.equal(checksum, sha(expected.bytes));
      const i = expected.identity;
      const identityKey = JSON.stringify([i.profile, i.schema, i.documentId, i.epoch, i.protocolVersion, i.updateEncoding, i.offsets]);
      assert.equal(updateId, JSON.stringify([identityKey, expected.writerId, expected.sequence, checksum]));
    }
    assert.equal(new Set(after.disk.updates.map(e => e.updateId)).size, 51);
    // Retry itself introduced no history/update. Ordinary undo/redo still uses
    // the same writer and journal, and reopens through checkpoint + exact tail.
    await page.evaluate(() => window.retryFixture.history('undo'));
    assert.deepEqual(await page.evaluate(() => window.retryFixture.flush()), { ok: true });
    const undone = await oracle(page); assert.notDeepEqual(undone.texts, after.texts);
    await page.evaluate(() => window.retryFixture.history('redo'));
    assert.deepEqual(await page.evaluate(() => window.retryFixture.flush()), { ok: true });
    const redone = await oracle(page); assert.deepEqual(redone.texts, after.texts);
    assert.equal(redone.sameReplica, true);
    const reopened = await page.evaluate(() => window.retryFixture.reopen());
    assert.deepEqual(reopened.snapshot.identity, before.snapshot.identity);
    assert.deepEqual(reopened.snapshot.visible, redone.snapshot.visible);
    assert.deepEqual(reopened.texts, redone.texts); assert.deepEqual(reopened.disk, redone.disk);
    assert.equal(reopened.recovery.unsavedUpdates.length, 0);
    fact.snapshots.push({ initial, denial, before, deniedRetry, again, ordinary, result, after, undone, redone, reopened });
  } finally { await page.evaluate(() => window.retryFixture.dispose()); }
}));
