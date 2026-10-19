import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function conflictCases({ page, server, facts, check, output }) {
  const url = '/fixture/revision-review.mjs';
  const original = 'Captured café and 世界. Keep every character.';
  const current = 'Current wording must survive a denied restore.';
  const history = page.locator('#revision-history');
  const button = name => history.getByRole('button', { name, exact: true });
  const run = (fn, arg) => page.evaluate(fn, { url, ...arg });
  const observe = (name = 'task') => run(async ({ url, name }) => {
    const w = (await import(url)).instances[name];
    return { ...await (await import('/fixture/oracles.mjs')).liveOracle(w), history: w.owner.engine.history({ type: 'state' }) };
  }, { name });
  const stable = ({ snapshot, checkpoint, journal, history }) => ({ snapshot, checkpoint, journal, history });
  const edit = async text => {
    await page.locator('#revision-editor [data-node-id]').first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type(text);
    await run(async ({ url }) => (await import(url)).workspace.save());
    assert.equal((await observe()).text, text);
  };
  const capture = async label => {
    await page.locator('#revision-name').fill(label); await page.locator('#revision-capture').click();
    await page.waitForFunction(label => document.querySelector('#revision-capture-status').textContent.startsWith(`Captured “${label}”`), label);
    return run(async ({ url }) => { const w = (await import(url)).workspace; return w.store.list(w.access()).at(-1).handle; });
  };
  let handle, baseline, before, sibling, started = false;
  const setup = async () => {
    if (started) {
      await run(async ({ url }) => {
        await (await import(url)).close();
        localStorage.clear();
        for (const name of ['example-revision-review', 'example-revision-review-comment']) await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Fixture database still owned'));
        });
      });
    }
    await page.goto(server.url + '/fixture/revision-review.html');
    await run(async ({ url }) => { await (await import(url)).ready; }); started = true;
    await edit(original); handle = await capture('Baseline'); baseline = await observe();
    await edit(current); before = await observe(); sibling = await observe('comment');
  };
  const preview = async () => { await button('Inspect Baseline').click(); await button('Preview restore as new edit').click(); };
  const unchanged = async expected => {
    assert.deepEqual(stable(await observe()), stable(expected));
    assert.deepEqual(stable(await observe('comment')), stable(sibling));
  };
  const context = async (reason, expectedBase, expectedCurrent, expectedProposed) => {
    const recovery = await run(async ({ url }) => (await import(url)).workspace.restoreRecovery);
    assert.equal(recovery.kind, 'conflict'); assert.equal(recovery.reason, reason);
    assert.deepEqual(recovery.base, expectedBase); assert.deepEqual(recovery.current, expectedCurrent); assert.deepEqual(recovery.proposed, expectedProposed);
    assert.deepEqual(JSON.parse(await page.locator('#revision-restore-recovery').textContent()), { base: expectedBase, current: expectedCurrent, proposed: expectedProposed });
    assert.match(await page.locator('#revision-restore-status').textContent(), reason === 'rejected' ? /post-call state/ : new RegExp(reason));
    facts.oracles[Object.keys(facts.oracles).length] = { reason, recovery, current: await observe() };
  };
  await check('readonly-roundtrip-retires-preview-and-detached-confirm', async () => {
    await setup(); await preview();
    await run(async ({ url }) => { const w = (await import(url)).workspace; window.oldRestorer = w.restorer; window.detachedApply = [...document.querySelectorAll('#revision-history button')].find(b => b.textContent === 'Apply restore as new edit'); });
    await page.locator('#revision-readonly').check();
    await context('readonly', before.snapshot, before.snapshot, baseline.snapshot); await unchanged(before);
    assert.equal(await button('Apply restore as new edit').count(), 0);
    await button('Inspect Baseline').click(); assert.equal(await button('Preview restore as new edit').count(), 0);
    await page.locator('#revision-readonly').uncheck();
    await page.evaluate(() => window.detachedApply.click()); await unchanged(before);
    assert.equal(await button('Apply restore as new edit').count(), 0, 'Writable again still requires a fresh preview');
    await preview(); await unchanged(before);
  });
  await check('edit-after-preview-keeps-base-current-proposed', async () => {
    await setup(); await preview(); await edit('A newer draft after preview.'); const newer = await observe();
    await button('Apply restore as new edit').click(); await context('stale', before.snapshot, newer.snapshot, baseline.snapshot); await unchanged(newer);
    assert.equal(await button('Apply restore as new edit').count(), 0);
    await preview(); await unchanged(newer);
  });
  await check('consumed-preview-replay-is-stale-without-second-commit', async () => {
    await setup();
    await run(async ({ url, handle }) => { const w = (await import(url)).workspace; const original = w.restorer.preview.bind(w.restorer); w.restorer.preview = h => (window.consumedPreview = original(h)); }, { handle });
    await preview(); await button('Apply restore as new edit').click();
    await run(async ({ url }) => (await import(url)).workspace.save()); const applied = await observe();
    assert.equal(applied.text, original); assert.equal(applied.journalUpdates, before.journalUpdates + 1);
    await run(async ({ url }) => (await import(url)).workspace.restorer.apply(window.consumedPreview));
    await context('stale', before.snapshot, applied.snapshot, baseline.snapshot); await unchanged(applied);
  });
  await check('foreign-identity-and-missing-capture-remain-unavailable', async () => {
    await setup();
    await run(async ({ url, handle }) => {
      const { instances } = await import(url); const w = instances.task;
      window.foreignAccess = { scope: { ...w.access().scope, identity: instances.comment.options.identity } };
      window.foreignRead = w.store.read(handle, window.foreignAccess);
      const foreignHandle = await instances.comment.capture('Foreign comment');
      w.restorer.preview(foreignHandle);
    }, { handle });
    assert.equal(await page.evaluate(() => window.foreignRead.reason), 'incompatible');
    await context('unavailable', null, before.snapshot, null); await unchanged(before);
    // Same captured handle with a foreign scope exercises the real store's identity policy.
    await run(async ({ url, handle }) => {
      const { RevisionRestorer } = await import('/fixture/revision-review-restorer.mjs');
      const w = (await import(url)).workspace;
      const foreign = new RevisionRestorer(w.store, w.restorer.host, () => window.foreignAccess, result => { window.foreignResult = result; });
      window.foreignResult = foreign.preview(handle);
      w.restorer.preview('never-issued-capture');
    }, { handle });
    assert.equal(await page.evaluate(() => window.foreignResult.reason), 'unavailable');
    await context('unavailable', null, before.snapshot, null); await unchanged(before);
  });
  await check('pruned-after-preview-keeps-current-and-recovery', async () => {
    await setup(); await preview();
    for (let n = 0; n < 3; n++) await capture(`Pruner ${n}`);
    assert.equal(await run(async ({ url, handle }) => { const w = (await import(url)).workspace; return w.store.read(handle, w.access()).reason; }, { handle }), 'pruned');
    await button('Apply restore as new edit').click();
    await context('unavailable', before.snapshot, before.snapshot, baseline.snapshot); await unchanged(before);
    assert.equal(await button('Apply restore as new edit').count(), 0);
  });
  await check('cancel-fences-retained-preview-and-late-apply', async () => {
    await setup(); await preview();
    await run(async ({ url, handle }) => { const w = (await import(url)).workspace; window.retired = w.restorer; window.retiredPreview = w.restorer.preview(handle); }, { handle });
    await page.locator('#revision-cancel-restore').click();
    await run(async () => { await Promise.resolve(); window.retired.apply(window.retiredPreview); });
    await context('stale', before.snapshot, before.snapshot, baseline.snapshot); await unchanged(before);
    assert.equal(await button('Apply restore as new edit').count(), 0);
    await preview(); await unchanged(before);
  });
  await check('close-fences-callback-before-flush-and-after-disposal', async () => {
    await setup(); await preview();
    await run(async ({ url, handle }) => {
      const w = (await import(url)).workspace;
      window.retired = w.restorer; window.retiredPreview = w.restorer.preview(handle);
      document.querySelector('#revision-close').click(); window.retired.apply(window.retiredPreview);
    }, { handle });
    await page.waitForFunction(() => document.querySelector('#revision-editor').closest('.workspace').dataset.lifecycle === 'closed');
    await page.evaluate(() => { window.afterDisposal = window.retired.apply(window.retiredPreview); });
    assert.equal(await page.evaluate(() => window.afterDisposal.reason), 'stale');
    assert.deepEqual(stable(await observe('comment')), stable(sibling));
    await page.locator('#revision-reopen').click();
    await page.waitForFunction(() => document.querySelector('#revision-editor').closest('.workspace').dataset.lifecycle === 'ready');
    assert.equal((await observe()).text, current); assert.equal((await observe()).journalUpdates, before.journalUpdates);
    assert.equal(await button('Apply restore as new edit').count(), 0);
  });
  await check('host-pre-admission-rejection-keeps-engine-and-journal', async () => {
    await setup(); await preview();
    await run(async ({ url }) => { const w = (await import(url)).workspace; w.restorer.host.commit = () => { throw Error('Prepared host admission denied'); }; });
    await button('Apply restore as new edit').click();
    await context('rejected', before.snapshot, before.snapshot, baseline.snapshot);
    const after = await observe(); assert.deepEqual(after.snapshot, before.snapshot); assert.equal(after.checkpoint, before.checkpoint); assert.equal(after.journal, before.journal);
    assert.deepEqual(stable(await observe('comment')), stable(sibling));
  });
  await check('post-call-host-failure-reports-actual-mutation-without-rollback-claim', async () => {
    await setup(); await preview();
    await run(async ({ url }) => {
      const w = (await import(url)).workspace, commit = w.restorer.host.commit;
      w.restorer.host.commit = plan => { commit(plan); throw Error('Prepared host failure after admission'); };
    });
    await button('Apply restore as new edit').click(); await run(async ({ url }) => (await import(url)).workspace.save());
    const after = await observe(); assert.equal(after.text, original); assert.equal(after.snapshot.revision, before.snapshot.revision + 1); assert.equal(after.journalUpdates, before.journalUpdates + 1);
    await context('rejected', before.snapshot, after.snapshot, baseline.snapshot);
    assert.match(await page.locator('#revision-restore-status').textContent(), /a change may already have occurred/);
    assert.deepEqual(stable(await observe('comment')), stable(sibling));
  });
  await check('marked-and-structural-changes-remain-visible-unsupported', async () => {
    await setup();
    await run(async ({ url }) => {
      const w = (await import(url)).workspace, id = w.owner.engine.read().visible[0].id;
      const anchor = w.owner.engine.anchor(id, 0, 'right'), focus = w.owner.engine.anchor(id, 45, 'left');
      try { w.owner.commit({ kind: 'fragment', origin: 'revision-unsupported-fixture', range: { anchor, focus }, blocks: [{ attributes: { type: 'heading', level: 2 }, runs: [{ text: 'Marked current', marks: [{ mark: 'bold' }] }] }] }); }
      finally { w.owner.engine.releaseAnchor(anchor); w.owner.engine.releaseAnchor(focus); }
      await w.save();
    });
    const rich = await observe(); assert.ok(rich.snapshot.visible.some(n => n.runs.some(r => r.marks.length)));
    await preview(); await context('unsupported', rich.snapshot, rich.snapshot, baseline.snapshot); await unchanged(rich);
    assert.equal(await button('Apply restore as new edit').count(), 0);
  });
  await check('opaque-unsupported-data-is-retained-exactly', async () => {
    await setup();
    await run(async ({ url }) => {
      const w = (await import(url)).workspace, id = w.owner.engine.read().visible[0].id;
      const at = w.owner.engine.anchor(id, 0, 'right');
      try { w.owner.commit({ kind: 'fragment', origin: 'revision-opaque-fixture', range: { anchor: at, focus: at }, blocks: [{ attributes: { type: 'content', tuple: ['module:editac.inert-extension', 1, { type: 'revision.widget', version: 1, dataVersion: 1, source: 'opaque source', payload: { retained: 'unknown exact payload' } }] }, runs: [{ text: 'opaque source', marks: [] }] }] }); }
      finally { w.owner.engine.releaseAnchor(at); } await w.save();
    });
    const opaque = await observe(); assert.ok(JSON.stringify(opaque.snapshot).includes('unknown exact payload'));
    await preview(); await context('unsupported', opaque.snapshot, opaque.snapshot, baseline.snapshot); await unchanged(opaque);
    await page.screenshot({ path: join(output, 'unsupported-recovery.png'), fullPage: true });
  });
  await check('denied-instance-keeps-sibling-editable-and-saveable', async () => {
    const task = await observe();
    await page.locator('#comment-revision-editor [data-node-id]').first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type('Independent sibling remains writable.');
    await run(async ({ url }) => (await import(url)).instances.comment.save());
    assert.equal((await observe('comment')).text, 'Independent sibling remains writable.'); assert.deepEqual(stable(await observe()), stable(task));
    facts.oracles.finalTask = await observe(); facts.oracles.finalSibling = await observe('comment');
    await run(async ({ url }) => (await import(url)).close());
  });
}
