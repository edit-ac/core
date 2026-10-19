import assert from 'node:assert/strict';
import { join } from 'node:path';

// One installed consumer journey. Oracles read public engine state and raw IDB;
// no presenter result substitutes for observed content or journal admission.
export async function integratedCases({ page, server, facts, check, output }) {
  const url = '/fixture/revision-review.mjs';
  const baselineText = 'Integrated baseline: café and 世界.';
  const draftText = 'Integrated working draft awaiting review.';
  const staleText = 'Newer local edit must survive stale confirmation.';
  const history = page.locator('#revision-history');
  const button = name => history.getByRole('button', { name, exact: true });
  const call = name => page.evaluate(async ({ url, name }) => (await import(url))[name](), { url, name });
  const observe = (name = 'task') => page.evaluate(async ({ url, name }) => {
    const w = (await import(url)).instances[name];
    return { ...await (await import('/fixture/oracles.mjs')).liveOracle(w), history: w.owner.engine.history({ type: 'state' }) };
  }, { url, name });
  const semantic = ({ changedNodes, touchedRanges, ...snapshot }) => snapshot;
  const stable = s => ({ snapshot: semantic(s.snapshot), checkpoint: s.checkpoint, journal: s.journal, history: s.history });
  const durable = ({ identity, visible, recovery, retainedStructure }) => ({ identity, visible, recovery, retainedStructure });
  const structure = s => ({ identity: s.identity, retainedStructure: s.retainedStructure,
    nodes: s.visible.map(({ id, parent, kind, blockAttributes, editor, spans }) => ({ id, parent, kind, blockAttributes, editor,
      spans: spans.map(({ source, identity }) => ({ source, identity })) })) });
  const edit = async text => {
    await page.locator('#revision-editor [data-node-id]').first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type(text); await call('save');
    assert.equal((await observe()).text, text);
  };
  const capture = async label => {
    await page.locator('#revision-name').fill(label); await page.locator('#revision-capture').click();
    await page.waitForFunction(label => document.querySelector('#revision-capture-status').textContent.startsWith(`Captured “${label}”`), label);
    return page.evaluate(async url => { const w = (await import(url)).workspace; return w.store.list(w.access()).at(-1).handle; }, url);
  };
  const preview = async () => { await button('Inspect Integrated baseline').click(); await button('Preview restore as new edit').click(); };
  const sameOwner = () => page.evaluate(async url => {
    const w = (await import(url)).workspace;
    return w.owner === window.integratedOwner && w.owner.engine === window.integratedEngine;
  }, url);
  let first, second, baseline, draft, restored, sibling, final;
  await page.goto(server.url + '/fixture/revision-review.html');
  await page.evaluate(async url => { await (await import(url)).ready; }, url);
  try {
    await check('integrated-capture-edit-two-real-revisions', async () => {
      await edit(baselineText); first = await capture('Integrated baseline'); baseline = await observe();
      await page.evaluate(async url => { const w = (await import(url)).workspace; window.integratedOwner = w.owner; window.integratedEngine = w.owner.engine; }, url);
      await edit(draftText); second = await capture('Integrated draft'); draft = await observe(); sibling = await observe('comment');
      assert.notEqual(first, second); assert.equal(draft.retained.revisions, 2);
      assert.deepEqual(structure(draft.snapshot), structure(baseline.snapshot));
      facts.oracles.baseline = baseline; facts.oracles.draft = draft;
    });
    await check('integrated-compare-is-readonly-and-semantic', async () => {
      await page.locator('#revision-before').selectOption(first); await page.locator('#revision-after').selectOption(second);
      await page.locator('#revision-compare').click();
      const text = await page.locator('#revision-comparison').innerText();
      assert.ok(text.includes(baselineText)); assert.ok(text.includes(draftText)); assert.match(text, /unknown/);
      const model = await page.evaluate(async ({ url, first, second }) => (await import(url)).workspace.compare(first, second), { url, first, second });
      assert.equal(model.version, 'editac-semantic-diff-v1'); assert.equal(model.attribution, 'unknown');
      assert.ok(model.changes.some(c => c.facets.includes('Text')));
      assert.deepEqual(stable(await observe()), stable(draft)); assert.equal(await sameOwner(), true);
      facts.oracles.comparison = model;
    });
    await check('integrated-supported-restore-is-one-owner-edit', async () => {
      await preview(); assert.deepEqual(stable(await observe()), stable(draft));
      await button('Apply restore as new edit').click(); await call('save'); restored = await observe();
      assert.match(await page.locator('#revision-restore-status').innerText(), /Restore applied as a new edit/);
      assert.equal(restored.text, baselineText); assert.equal(restored.journalUpdates, draft.journalUpdates + 1);
      assert.equal(restored.history.undoGroups, draft.history.undoGroups + 1);
      assert.equal(restored.snapshot.revision, draft.snapshot.revision + 1);
      assert.equal(JSON.parse(restored.journal).updates.at(-1).origin, 'editac:local:history-restore');
      assert.deepEqual(structure(restored.snapshot), structure(draft.snapshot)); assert.equal(await sameOwner(), true);
      facts.oracles.restored = restored;
    });
    await check('integrated-undo-redo-retains-restored-identities', async () => {
      await page.locator('#revision-editor [data-node-id]').first().click(); await page.keyboard.press('Meta+z'); await call('save');
      const undone = await observe(); assert.equal(undone.text, draftText);
      assert.equal(undone.history.undoGroups, draft.history.undoGroups); assert.equal(undone.history.redoGroups, 1);
      await page.keyboard.press('Meta+Shift+z'); await call('save'); const redone = await observe();
      assert.equal(redone.text, baselineText); assert.equal(redone.history.redoGroups, 0);
      assert.deepEqual(durable(redone.snapshot), durable(restored.snapshot));
      assert.equal(await sameOwner(), true); facts.oracles.undone = undone; facts.oracles.redone = redone;
    });
    await check('integrated-stale-denial-preserves-newer-journal', async () => {
      await preview(); await edit(staleText); const before = await observe();
      await button('Apply restore as new edit').click();
      assert.match(await page.locator('#revision-restore-status').innerText(), /stale/);
      assert.deepEqual(stable(await observe()), stable(before));
      const recovery = await page.evaluate(async url => (await import(url)).workspace.restoreRecovery, url);
      assert.equal(recovery.kind, 'conflict'); assert.equal(recovery.reason, 'stale');
      assert.deepEqual(semantic(recovery.current), semantic(before.snapshot));
      assert.deepEqual(semantic(recovery.proposed), semantic(baseline.snapshot));
      facts.oracles.stale = { before, recovery };
    });
    await check('integrated-readonly-denial-requires-fresh-preview', async () => {
      await preview(); const before = await observe();
      await page.evaluate(async url => { const w = (await import(url)).workspace; window.integratedRetired = w.restorer; window.integratedPreview = w.restorer.preview(w.store.list(w.access())[0].handle); }, url);
      await page.locator('#revision-readonly').check();
      await button('Inspect Integrated baseline').click();
      assert.equal(await button('Preview restore as new edit').count(), 0); assert.equal(await button('Apply restore as new edit').count(), 0);
      await page.evaluate(() => window.integratedRetired.apply(window.integratedPreview));
      assert.deepEqual(stable(await observe()), stable(before));
      await page.locator('#revision-readonly').uncheck();
      assert.equal(await button('Apply restore as new edit').count(), 0);
      await preview(); await button('Apply restore as new edit').click(); await call('save'); final = await observe();
      assert.equal(final.text, baselineText); assert.equal(final.journalUpdates, before.journalUpdates + 1);
      assert.deepEqual(stable(await observe('comment')), stable(sibling));
      facts.oracles.beforeReopen = final;
      await page.screenshot({ path: join(output, 'integrated-restored.png'), fullPage: true });
    });
    await check('integrated-save-full-reload-empty-captures', async () => {
      await call('close'); await page.reload(); await page.evaluate(async url => { await (await import(url)).ready; }, url);
      const reopened = await observe(); assert.equal(reopened.text, baselineText);
      assert.deepEqual(durable(reopened.snapshot), durable(final.snapshot));
      assert.equal(reopened.retained.revisions, 0); assert.equal(await history.getByRole('button', { name: /^Inspect / }).count(), 0);
      const other = await observe('comment'); assert.deepEqual(durable(other.snapshot), durable(sibling.snapshot));
      facts.oracles.reopened = reopened;
    });
  } finally { await call('dispose'); }
}
