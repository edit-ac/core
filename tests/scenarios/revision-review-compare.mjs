import assert from 'node:assert/strict';

export async function compareCases({ page, server, facts, check, output }) {
  const moduleURL = '/fixture/revision-review.mjs';
  const observe = () => page.evaluate(async url => {
    const { workspace: w } = await import(url);
    const live = await (await import('/fixture/oracles.mjs')).liveOracle(w);
    return { ...live, vector: w.owner.engine.stateVector(), update: w.owner.engine.encodeUpdate(), history: w.owner.engine.history({ type: 'state' }),
      generation: w.owner.engine.captureSemantic(w.access().scope.moduleProfile).comparison.observedToken,
      captures: w.store.list(w.access()).map(item => w.store.read(item.handle, w.access())) };
  }, moduleURL);
  const select = async (before, after) => {
    await page.locator('#revision-before').selectOption(before); await page.locator('#revision-after').selectOption(after);
    await page.locator('#revision-compare').click();
  };
  const capture = async label => {
    await page.locator('#revision-name').fill(label); await page.locator('#revision-capture').click();
    await page.waitForFunction(label => { const s = document.querySelector('#revision-capture-status'); return s.dataset.state === 'error' || s.textContent.startsWith(`Captured “${label}”`); }, label);
    assert.match(await page.locator('#revision-capture-status').textContent(), /^Captured/);
    return page.evaluate(async url => { const w = (await import(url)).workspace; return w.store.list(w.access()).at(-1).handle; }, moduleURL);
  };
  const host = page.locator('#revision-comparison');
  let beforeHandle, afterHandle, initial, baseline;
  await page.goto(server.url + '/fixture/revision-review.html');
  await page.evaluate(async url => { await (await import(url)).ready; }, moduleURL);
  await check('two-real-captures-text-mark-attributes-opaque', async () => {
    await page.locator('#revision-editor [data-node-id]').first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type('Before comparison');
    await page.evaluate(async url => (await import(url)).workspace.save(), moduleURL);
    await page.evaluate(async url => {
      const w = (await import(url)).workspace, owner = w.owner.engine.read().visible[0].id;
      const at = w.owner.engine.anchor(owner, 17, 'right');
      try { w.owner.commit({ kind: 'fragment', origin: 'revision-opaque-before', range: { anchor: at, focus: at }, blocks: [{ attributes: { type: 'content', tuple: ['module:editac.inert-extension', 1, { type: 'revision.widget', version: 1, dataVersion: 1, source: 'opaque baseline', payload: { retained: 'unknown payload' } }] }, runs: [{ text: 'opaque baseline', marks: [] }] }] }); }
      finally { w.owner.engine.releaseAnchor(at); }
      await w.save();
    }, moduleURL);
    beforeHandle = await capture('Before comparison'); initial = await observe();
    // Deterministic semantic fixture edits use the same public storage owner as browser typing.
    await page.evaluate(async url => {
      const w = (await import(url)).workspace, owner = w.owner.engine.read().visible[0].id;
      const anchor = w.owner.engine.anchor(owner, 0, 'right'), focus = w.owner.engine.anchor(owner, 17, 'left');
      try {
        w.owner.commit({ kind: 'fragment', origin: 'revision-compare-fixture', range: { anchor, focus }, blocks: [{ attributes: { type: 'heading', level: 2 }, runs: [
          { text: 'After', marks: [{ mark: 'bold' }], attributes: { 'module:revision.opaque': [1, { retained: 'unknown payload' }] } },
          { text: ' comparison', marks: [] }
        ] }] });
      } finally { w.owner.engine.releaseAnchor(anchor); w.owner.engine.releaseAnchor(focus); }
      const opaque = w.owner.engine.read().visible.find(node => node.blockAttributes?.[0] === 'module:editac.inert-extension');
      const at = w.owner.engine.anchor(opaque.id, 0, 'right');
      try { w.owner.commit({ kind: 'editor', origin: 'revision-opaque-after', commands: [{ type: 'atomicContent', owner: opaque.id, expected: opaque.blockAttributes, at, replacement: ['module:editac.inert-extension', 1, { type: 'revision.widget', version: 1, dataVersion: 1, source: 'opaque changed', payload: { retained: 'unknown payload' } }] }] }); }
      finally { w.owner.engine.releaseAnchor(at); }
      await w.save();
    }, moduleURL);
    afterHandle = await capture('After comparison'); baseline = await observe();
    assert.match(initial.text, /Before comparison/); assert.match(baseline.text, /After comparison/);
    assert.deepEqual(baseline.captures[0], initial.captures[0], 'Earlier real capture remains immutable');
    assert.notDeepEqual(baseline.snapshot.visible, initial.snapshot.visible);
    await select(beforeHandle, afterHandle);
    assert.match(await page.locator('#revision-compare-status').textContent(), /Showing semantic differences/);
    for (const text of ['Before comparison', 'After', ' comparison', 'Formatting / marks', 'Attributes', 'Opaque / unknown module', 'unknown payload']) assert.ok((await host.textContent()).includes(text), text);
    facts.oracles.captured = { initial, baseline };
  });
  await check('public-model-hashes-and-facets-visible', async () => {
    const model = await page.evaluate(async ({ url, beforeHandle, afterHandle }) => (await import(url)).workspace.compare(beforeHandle, afterHandle), { url: moduleURL, beforeHandle, afterHandle });
    assert.equal(model.version, 'editac-semantic-diff-v1'); assert.equal(model.attribution, 'unknown');
    for (const facet of ['Text', 'Formatting', 'Attributes', 'UnknownModule']) assert.ok(model.changes.some(change => change.facets.includes(facet)), facet);
    assert.match(await host.textContent(), new RegExp(model.before_hash)); assert.match(await host.textContent(), new RegExp(model.after_hash));
    assert.match(await host.textContent(), /[Ss]emantic/); assert.match(await host.textContent(), /unknown/);
    assert.equal(await host.locator('[contenteditable="true"],textarea,input').count(), 0);
    facts.oracles.model = model;
  });
  await check('all-three-public-display-modes', async () => {
    for (const mode of ['inline', 'side-by-side', 'unified']) {
      await host.getByRole('button', { name: `${mode} view`, exact: true }).click();
      assert.equal(await host.locator('.editac-change-review').getAttribute('data-layout'), mode);
      for (const text of ['Before comparison', 'After', ' comparison', 'unknown payload']) assert.ok((await host.textContent()).includes(text));
    }
    await page.screenshot({ path: output + '/comparison.png', fullPage: true });
  });
  await check('inspection-and-comparison-preserve-engine-journal-history', async () => {
    await page.getByRole('button', { name: 'Inspect Before comparison', exact: true }).click();
    await select(afterHandle, beforeHandle); await select(beforeHandle, afterHandle);
    assert.deepEqual(await observe(), baseline, 'Whole snapshot/checkpoint/raw-IDB/vector/update/undo/generation/capture state equality');
    const sibling = await page.evaluate(async url => { const w = (await import(url)).instances.comment; return (await import('/fixture/oracles.mjs')).liveOracle(w); }, moduleURL);
    assert.equal(sibling.retained.revisions, 0); assert.equal(sibling.text, 'Write a comment here.');
    facts.oracles.unchanged = await observe();
  });
  await check('pruned-selection-recovers-without-live-mutation', async () => {
    await capture('Third capture'); await capture('Fourth capture');
    const stable = await observe();
    assert.match(await page.locator('#revision-compare-status').textContent(), /unavailable.*pruned/);
    await page.locator('#revision-compare').click();
    assert.match(await page.locator('#revision-compare-status').textContent(), /Before capture is pruned/);
    assert.equal(await host.locator('.editac-change-review').count(), 0);
    const handles = stable.captures.map(read => read.revision.handle);
    await select(handles[0], handles[1]); assert.match(await page.locator('#revision-compare-status').textContent(), /Showing semantic differences/);
    assert.deepEqual(await observe(), stable); facts.oracles.pruned = stable;
  });
  await check('missing-and-foreign-handles-recover-without-live-mutation', async () => {
    const stable = await observe();
    for (const handle of ['missing-capture', await page.evaluate(async url => (await import(url)).instances.comment.capture('Foreign capture'), moduleURL)]) {
      await page.evaluate(async ({ url, handle, afterHandle }) => (await import(url)).workspace.compare(handle, afterHandle), { url: moduleURL, handle, afterHandle: stable.captures.at(-1).revision.handle });
      assert.match(await page.locator('#revision-compare-status').textContent(), /capture is missing/);
      assert.equal(await host.locator('.editac-change-review').count(), 0);
    }
    assert.deepEqual(await observe(), stable); facts.oracles.missing = stable;
  });
  await check('presenter-clips-long-values-with-visible-notice', async () => {
    // Full text is retained in the actual model; clipping belongs solely to the public presenter.
    await page.evaluate(async url => {
      const w = (await import(url)).workspace, owner = w.owner.engine.read().visible[0].id;
      const anchor = w.owner.engine.anchor(owner, 0, 'right'), focus = w.owner.engine.anchor(owner, 16, 'left');
      try { w.owner.commit({ kind: 'fragment', origin: 'revision-long-fixture', range: { anchor, focus }, blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text: 'L'.repeat(1200), marks: [] }] }] }); }
      finally { w.owner.engine.releaseAnchor(anchor); w.owner.engine.releaseAnchor(focus); }
      await w.save();
    }, moduleURL);
    const first = await capture('Long before');
    await page.evaluate(async url => { const w = (await import(url)).workspace, owner = w.owner.engine.read().visible[0].id; w.owner.commit({ kind: 'editor', origin: 'revision-long-fixture', commands: [{ type: 'replaceAt', owner, from: 0, to: 1, text: 'M' }] }); await w.save(); }, moduleURL);
    const last = await capture('Long after'), stable = await observe();
    await select(first, last);
    assert.match(await host.textContent(), /Display truncated:/);
    assert.deepEqual(await observe(), stable); facts.oracles.long = stable;
  });
  await check('comparison-disposal-and-remount-clears-only-own-view', async () => {
    await page.locator('#revision-close').click(); await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'closed');
    assert.equal(await host.locator('.editac-change-review').count(), 0);
    assert.equal(await page.locator('#revision-compare').isDisabled(), true);
    await page.locator('#revision-reopen').click(); await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'ready');
    assert.equal(await page.locator('#revision-before option').count(), 1);
    assert.equal(await host.locator('.editac-change-review').count(), 0);
    await page.evaluate(async url => (await import(url)).close(), moduleURL);
  });
}
