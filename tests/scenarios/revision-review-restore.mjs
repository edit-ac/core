import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function restoreCases({ page, server, facts, check, output }) {
  const moduleURL = '/fixture/revision-review.mjs';
  const original = 'Captured wording: café, 世界, and a clear ending.';
  const current = 'Current draft: keep this until confirmation.';
  const history = page.locator('#revision-history');
  const button = name => history.getByRole('button', { name, exact: true });
  const call = name => page.evaluate(async ({ moduleURL, name }) => (await import(moduleURL))[name](), { moduleURL, name });
  const observe = () => page.evaluate(async moduleURL => {
    const { workspace: w } = await import(moduleURL);
    return { ...await (await import('/fixture/oracles.mjs')).liveOracle(w), history: w.owner.engine.history({ type: 'state' }) };
  }, moduleURL);
  const stable = ({ snapshot, checkpoint, journal, history }) => ({ snapshot, checkpoint, journal, history });
  const durable = ({ identity, visible, recovery, retainedStructure }) => ({ identity, visible, recovery, retainedStructure });
  const identities = s => ({ document: s.identity, nodes: s.visible.map(n => ({ id: n.id, parent: n.parent, kind: n.kind, blockAttributes: n.blockAttributes, editor: n.editor,
    sources: n.spans.map(({ source, identity }) => ({ source, identity })) })), sources: Object.fromEntries(Object.entries(s.retainedStructure.sources).map(([id, value]) => [id, value.identity])) });
  const edit = async text => {
    await page.locator('#revision-editor [data-node-id]').first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type(text); await call('save');
    assert.equal((await observe()).text, text);
  };
  const capture = async label => {
    await page.locator('#revision-name').fill(label); await page.locator('#revision-capture').click();
    await page.waitForFunction(label => document.querySelector('#revision-capture-status').textContent.startsWith(`Captured “${label}”`), label);
  };
  const sameOwner = () => page.evaluate(async moduleURL => {
    const { workspace: w } = await import(moduleURL);
    return w.owner === window.restoreProof.owner && w.owner.engine === window.restoreProof.engine && w.surface === window.restoreProof.surface;
  }, moduleURL);
  let before, restored, sibling, baseline;
  await page.goto(server.url + '/fixture/revision-review.html');
  await page.evaluate(async moduleURL => { await (await import(moduleURL)).ready; }, moduleURL);
  await check('capture-edit-independent-baseline', async () => {
    await edit(original); await capture('Supported text');
    baseline = await observe();
    await edit(current); before = await observe();
    assert.equal(before.text, current); assert.deepEqual(identities(before.snapshot), identities(baseline.snapshot));
    await page.evaluate(async moduleURL => {
      const { workspace: w } = await import(moduleURL);
      window.restoreProof = { owner: w.owner, engine: w.owner.engine, surface: w.surface, commits: [] };
      // Observe the real owner's updates; no product commit, engine or storage method is replaced.
      window.restoreProof.subscription = w.owner.engine.subscribe({ type: 'updates' }, patch => {
        if (patch.update) window.restoreProof.commits.push({ origin: patch.update.origin, sequence: patch.update.sequence });
      });
    }, moduleURL);
    sibling = await page.evaluate(async moduleURL => (await import('/fixture/oracles.mjs')).liveOracle((await import(moduleURL)).instances.comment), moduleURL);
    facts.oracles.baseline = baseline; facts.oracles.before = before;
  });
  await check('preview-does-not-change-live-state', async () => {
    await button('Inspect Supported text').click(); await button('Preview restore as new edit').click();
    assert.match(await history.innerText(), /Proposed new semantic edit/);
    const section = history.getByRole('region', { name: 'Restore as new edit', exact: true });
    assert.match(await section.innerText(), new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(await section.innerText(), /Current draft/);
    assert.deepEqual(stable(await observe()), stable(before)); assert.equal(await sameOwner(), true);
  });
  await check('cancel-discards-preview-without-mutation', async () => {
    await page.locator('#revision-cancel-restore').click();
    assert.equal(await button('Apply restore as new edit').count(), 0);
    assert.match(await page.locator('#revision-restore-status').innerText(), /canceled/);
    assert.deepEqual(stable(await observe()), stable(before)); assert.equal(await sameOwner(), true);
    assert.equal(await button('Inspect Supported text').count(), 1, 'Cancel retains the captured revision');
  });
  await check('confirm-through-owner-preserves-identity-and-journals', async () => {
    await button('Inspect Supported text').click(); await button('Preview restore as new edit').click();
    assert.deepEqual(stable(await observe()), stable(before));
    await button('Apply restore as new edit').click();
    assert.match(await history.innerText(), /Restored as a new edit/);
    await call('save'); restored = await observe();
    assert.equal(restored.text, original); assert.deepEqual(identities(restored.snapshot), identities(before.snapshot));
    assert.equal(restored.snapshot.revision, before.snapshot.revision + 1);
    assert.equal(restored.journalUpdates, before.journalUpdates + 1);
    assert.notEqual(restored.checkpoint, before.checkpoint);
    assert.equal(await sameOwner(), true);
    assert.deepEqual(await page.evaluate(() => window.restoreProof.commits.map(update => update.origin)), ['history-restore']);
    assert.equal(await button('Apply restore as new edit').count(), 0);
    assert.equal(await page.locator('#revision-editor').innerText(), original);
    const actualSibling = await page.evaluate(async moduleURL => (await import('/fixture/oracles.mjs')).liveOracle((await import(moduleURL)).instances.comment), moduleURL);
    assert.deepEqual(actualSibling, sibling);
    facts.oracles.restored = restored;
  });
  await check('restore-is-one-isolated-undo-group', async () => {
    assert.equal(restored.history.undoGroups, before.history.undoGroups + 1);
    await page.locator('#revision-editor [data-node-id]').first().click(); await page.keyboard.press('Meta+z'); await call('save');
    const undone = await observe();
    assert.equal(undone.text, current); assert.equal(undone.history.undoGroups, before.history.undoGroups);
    assert.equal(undone.history.redoGroups, 1); assert.deepEqual(identities(undone.snapshot), identities(before.snapshot));
    assert.equal(await sameOwner(), true); facts.oracles.undone = undone;
  });
  await check('redo-reapplies-only-the-restore', async () => {
    await page.keyboard.press('Meta+Shift+z'); await call('save');
    const redone = await observe(); assert.equal(redone.text, original);
    assert.equal(redone.history.undoGroups, restored.history.undoGroups); assert.equal(redone.history.redoGroups, 0);
    assert.deepEqual(durable(redone.snapshot), durable(restored.snapshot));
    facts.oracles.redone = redone;
  });
  await check('normal-edit-follows-restore', async () => {
    // A subsequent ordinary edit must form its own group, retaining the accepted restore below it.
    await page.locator('#revision-editor [data-node-id]').first().click(); await page.keyboard.press('Meta+ArrowRight');
    await page.keyboard.type(' Additional edit.'); await call('save');
    assert.equal((await observe()).text, original + ' Additional edit.');
    await page.keyboard.press('Meta+z'); await call('save');
    assert.equal((await observe()).text, original);
    facts.oracles.beforeReopen = await observe();
    await page.screenshot({ path: join(output, 'restored.png'), fullPage: true });
    await page.evaluate(() => window.restoreProof.subscription.dispose());
  });
  await check('flush-and-reopen-accepted-live-result', async () => {
    await call('close'); await page.reload();
    await page.evaluate(async moduleURL => { await (await import(moduleURL)).ready; }, moduleURL);
    const reopened = await observe(); assert.equal(reopened.text, original);
    assert.deepEqual(durable(reopened.snapshot), durable(facts.oracles.beforeReopen.snapshot));
    assert.equal(reopened.retained.revisions, 0);
    assert.equal(await history.getByRole('button', { name: /^Inspect / }).count(), 0);
    assert.match(await page.locator('.note').first().innerText(), /Reloading loses captures/);
    assert.match(await page.locator('#revision-save-status').innerText(), /Local document ready/);
    facts.oracles.reopened = reopened;
  });
  await call('close');
}
