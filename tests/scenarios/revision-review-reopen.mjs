import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export async function reopenCases({ page, server, facts, check, output }) {
  const moduleURL = '/fixture/revision-review.mjs';
  const expectedEdit = 'Durable edit: café, 世界, and the original source identity.';
  const expectedRestore = 'Accepted restore persists after the next reload.';
  const unsavedText = 'Recovery must retain this UNSAVED content: café 世界.';
  const moduleCall = name => page.evaluate(async ({ moduleURL, name }) => (await import(moduleURL)).workspace[name](), { moduleURL, name });
  const ready = () => page.evaluate(async url => { await (await import(url)).ready; }, moduleURL);
  const observe = (name = 'task') => page.evaluate(async ({ moduleURL, name }) => (await import('/fixture/oracles.mjs')).liveOracle((await import(moduleURL)).instances[name]), { moduleURL, name });
  const stable = value => ({ snapshot: value.snapshot, checkpoint: value.checkpoint, journal: value.journal, retained: value.retained });
  const edit = async (text, name = 'task', save = true) => {
    const prefix = name === 'task' ? '' : 'comment-';
    await page.locator(`#${prefix}revision-editor [data-node-id]`).first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type(text);
    if (save) await page.evaluate(async ({ moduleURL, name }) => (await import(moduleURL)).instances[name].save(), { moduleURL, name });
    assert.equal((await observe(name)).text, text);
  };
  const capture = async label => {
    await page.locator('#revision-name').fill(label); await page.locator('#revision-capture').click();
    await page.waitForFunction(label => document.querySelector('#revision-capture-status').textContent.startsWith(`Captured “${label}”`), label);
  };
  const reload = async () => { await page.reload(); await ready(); };
  const compareReopen = (before, after, expected) => {
    assert.equal(after.text, expected); assert.deepEqual(after.snapshot.identity, before.snapshot.identity);
    assert.deepEqual(after.snapshot.visible, before.snapshot.visible);
    assert.deepEqual(after.snapshot.retainedStructure, before.snapshot.retainedStructure);
    assert.equal(after.journal, before.journal, 'Opening does not seed or append updates');
    assert.equal(after.retained.revisions, 0);
  };
  const recovery = () => page.evaluate(async url => {
    const w = (await import(url)).workspace;
    return JSON.parse(JSON.stringify(w.owner.recoveryExport(), (_key, value) => value instanceof Uint8Array ? { encoding: 'bytes', data: [...value] } : value));
  }, moduleURL);
  const saveAttempt = () => page.evaluate(async url => {
    try { await (await import(url)).workspace.save(); return { saved: true }; }
    catch (error) { return { saved: false, error: error.message }; }
  }, moduleURL);
  await page.goto(server.url + '/fixture/revision-review.html'); await ready();
  let failed, failedRecovery, sibling;
  await check('edit-full-reload-keeps-durable-current-without-reseed', async () => {
    await edit(expectedEdit); await capture('Ephemeral before reload');
    const before = await observe(); await reload(); const after = await observe();
    compareReopen(before, after, expectedEdit);
    assert.match(await page.locator('#revision-capture-status').innerText(), /No captures.*Reload.*memory-only.*without reseeding/);
    assert.equal(await page.locator('#revision-history').getByRole('button', { name: /^Inspect / }).count(), 0);
    facts.oracles.editReload = { before, after };
  });
  await check('accepted-restore-full-reload-keeps-identity-and-current', async () => {
    await edit(expectedRestore); await capture('Reload restore'); await edit('Later live draft before restore.');
    const history = page.locator('#revision-history');
    await history.getByRole('button', { name: 'Inspect Reload restore', exact: true }).click();
    await history.getByRole('button', { name: 'Preview restore as new edit', exact: true }).click();
    await history.getByRole('button', { name: 'Apply restore as new edit', exact: true }).click();
    await moduleCall('save'); const before = await observe(); assert.equal(before.text, expectedRestore);
    assert.equal(JSON.parse(before.journal).updates.at(-1).origin, 'editac:local:history-restore');
    await reload(); const after = await observe(); compareReopen(before, after, expectedRestore);
    facts.oracles.restoreReload = { before, after };
  });
  await check('open-failure-retains-creation-source-and-explicit-retry-reopens', async () => {
    const before = await observe();
    const creation = await page.evaluate(() => localStorage.getItem('editac-example-revision-review'));
    await page.locator('#revision-close').click(); await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'closed');
    await page.evaluate(async () => { window.removeFault = (await import('/fixture/revision-review-faults.mjs')).installFault({ databaseName: 'example-revision-review', operation: 'open' }); });
    await page.locator('#revision-reopen').click(); await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'failed');
    assert.match(await page.locator('#revision-save-status').innerText(), /Reopen failed.*Retry/);
    assert.equal(await page.evaluate(() => localStorage.getItem('editac-example-revision-review')), creation);
    await page.evaluate(() => window.removeFault()); await page.locator('#revision-reopen').click();
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'ready');
    const after = await observe(); compareReopen(before, after, expectedRestore);
    facts.oracles.openRetry = { before, after, creation };
  });
  await check('failed-local-save-keeps-live-source-journal-and-recovery', async () => {
    await capture('Keep recovery context'); const durable = await observe();
    await page.evaluate(async () => { window.removeFault = (await import('/fixture/revision-review-faults.mjs')).installFault({ databaseName: 'example-revision-review' }); });
    await edit(unsavedText, 'task', false); const result = await saveAttempt(); assert.equal(result.saved, false);
    failed = await observe(); failedRecovery = await recovery();
    assert.equal(failed.journal, durable.journal, 'Denied append leaves durable source bytes unchanged');
    assert.equal(failed.text, unsavedText); assert.ok(failedRecovery.unsavedUpdates.length > 0);
    assert.deepEqual(failed.snapshot.identity, durable.snapshot.identity); assert.equal(failed.retained.revisions, 1);
    assert.match(await page.locator('#revision-save-status').innerText(), /Local save failed.*Keep this page open.*export recovery.*remotely/);
    const retained = await page.evaluate(async url => (await import(url)).workspace.retainedRecovery.unsavedUpdates.length, moduleURL);
    assert.equal(retained, failedRecovery.unsavedUpdates.length);
    facts.oracles.failure = { durable, failed, recovery: failedRecovery, result };
  });
  await check('explicit-recovery-download-preserves-binary-source-and-independent-content', async () => {
    const waiting = page.waitForEvent('download'); await page.locator('#revision-export-recovery').click();
    const download = await waiting, path = join(output, 'task-recovery.json'); await download.saveAs(path);
    const bytes = await readFile(path), downloaded = JSON.parse(bytes);
    assert.deepEqual(downloaded, failedRecovery);
    const decoded = await page.evaluate(async recovery => {
      const value = JSON.parse(JSON.stringify(recovery), (_key, v) => v?.encoding === 'bytes' ? Uint8Array.from(v.data) : v);
      const runtime = await (await import('@edit-ac/core')).init('/core/wasm/editac_wasm_bg.wasm');
      const engine = runtime.restoreEngine(value.checkpoint.identity, value.checkpoint, []);
      try { return engine.read(); } finally { engine.dispose(); }
    }, downloaded);
    assert.equal(decoded.visible.flatMap(n => n.runs?.map(r => r.text) ?? []).join(''), unsavedText);
    assert.deepEqual(decoded.identity, failed.snapshot.identity); assert.deepEqual(decoded.visible, failed.snapshot.visible);
    assert.deepEqual(decoded.retainedStructure, failed.snapshot.retainedStructure);
    assert.deepEqual(stable(await observe()), stable(failed));
    assert.match(await page.locator('#revision-recovery-status').innerText(), /does not confirm a local save or remote durability/);
    facts.oracles.download = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), decoded };
  });
  await check('failed-export-retains-source-recovery-and-live-editor', async () => {
    await page.evaluate(() => { window.originalObjectURL = URL.createObjectURL; URL.createObjectURL = () => { throw Error('Prepared download denial'); }; });
    await page.locator('#revision-export-recovery').click();
    await page.evaluate(() => { URL.createObjectURL = window.originalObjectURL; });
    assert.match(await page.locator('#revision-recovery-status').innerText(), /export failed.*Keep this page open.*source data is retained/);
    assert.deepEqual(await recovery(), failedRecovery); assert.deepEqual(stable(await observe()), stable(failed));
    assert.equal(await page.locator('#revision-export-recovery').isEnabled(), true);
  });
  await check('failed-close-retains-owner-recovery-captures-and-writable-view', async () => {
    await page.evaluate(async url => { window.failedOwner = (await import(url)).workspace.owner; }, moduleURL);
    await page.locator('#revision-close').click(); await page.waitForFunction(() => document.querySelector('#revision-save-status').textContent.startsWith('Close failed'));
    assert.equal(await page.evaluate(async url => (await import(url)).workspace.owner === window.failedOwner, moduleURL), true);
    assert.equal(await page.locator('#revision-editor').getAttribute('aria-readonly'), 'false');
    assert.deepEqual(await recovery(), failedRecovery); assert.deepEqual(stable(await observe()), stable(failed));
    assert.equal(await page.locator('#revision-reopen').isDisabled(), true);
    facts.oracles.closeFailure = { unchanged: true, sameOwner: true, readonly: false };
  });
  await check('save-failure-isolated-from-sibling-and-does-not-claim-success', async () => {
    await edit('Sibling saves independently while task retains failed recovery.', 'comment'); sibling = await observe('comment');
    assert.match(await page.locator('#comment-revision-save-status').innerText(), /saved locally.*No remote save/);
    assert.deepEqual(stable(await observe()), stable(failed));
    assert.equal(await page.locator('#revision-save-status').getAttribute('data-state'), 'error');
    facts.oracles.sibling = sibling; await page.screenshot({ path: join(output, 'recovery-retained.png'), fullPage: true });
  });
  await check('repaired-storage-retry-persists-retained-edit-and-reopens-without-loss', async () => {
    await page.evaluate(() => window.removeFault());
    const result = await saveAttempt(); const after = await observe();
    facts.oracles.storageRetry = { result, before: failed, after, recovery: await recovery(), sibling: await observe('comment') };
    // Original acceptance: removing the storage fault must permit retry and durable reopen.
    // A rejected retained promise is not successful retry, even though recovery export is intact.
    assert.equal(result.saved, true, `Public owner retry did not persist retained updates: ${result.error}`);
    assert.ok(after.journalUpdates > failed.journalUpdates); assert.equal(after.text, unsavedText);
    await reload(); const reopened = await observe(); compareReopen(after, reopened, unsavedText);
    assert.equal((await observe('comment')).text, sibling.text); facts.oracles.storageRetry.reopened = reopened;
    await page.evaluate(async url => { await (await import(url)).close(); }, moduleURL);
  });
}
