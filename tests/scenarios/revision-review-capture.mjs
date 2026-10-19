import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './run.mjs';
import { sha } from './harness.mjs';

export async function captureCases({ page, server, facts, check, output }) {
  const moduleURL = '/fixture/revision-review.mjs';
  const call = (name, ...args) => page.evaluate(async ({ moduleURL, name, args }) => (await import(moduleURL))[name](...args), { moduleURL, name, args });
  const observe = () => page.evaluate(async moduleURL => {
    const { workspace } = await import(moduleURL);
    return (await import('/fixture/oracles.mjs')).liveOracle(workspace);
  }, moduleURL);
  const retained = () => page.evaluate(async moduleURL => {
    const { workspace: w } = await import(moduleURL);
    return { usage: w.store.usage, revisions: w.store.list(w.access()).map(item => w.store.read(item.handle, w.access()).revision) };
  }, moduleURL);
  const edit = async text => {
    if (text.length > 1000) {
      // Large deterministic quota inputs use the real public owner lifecycle;
      // ordinary edited capture states below use actual browser keyboard input.
      await page.evaluate(async ({ moduleURL, text }) => {
        const { workspace: w } = await import(moduleURL);
        const node = w.owner.engine.read().visible[0];
        w.owner.commit({ kind: 'editor', origin: 'revision-quota-fixture', commands: [{ type: 'replaceAt', owner: node.id, from: 0, to: node.runs.reduce((n, r) => n + r.text.length, 0), text }] });
      }, { moduleURL, text });
    } else {
      await page.locator('#revision-editor [data-node-id]').first().click();
      await page.keyboard.press('Meta+a'); await page.keyboard.type(text);
    }
    await call('save');
    assert.equal((await observe()).text, text, 'Actual browser input must reach the live engine');
  };
  const capture = async name => {
    await page.locator('#revision-name').fill(name); await page.locator('#revision-capture').click();
    await page.waitForFunction(name => {
      const status = document.querySelector('#revision-capture-status');
      return status.dataset.state === 'error' || status.textContent.startsWith(`Captured “${name}”`);
    }, name);
    assert.match(await page.locator('#revision-capture-status').textContent(), new RegExp(`^Captured “${name}”`));
    return (await retained()).revisions.at(-1);
  };
  const stable = ({ snapshot, checkpoint, journal }) => ({ snapshot, checkpoint, journal });
  let first, second, firstExpected;
  await page.goto(server.url + '/fixture/revision-review.html');
  await page.evaluate(async moduleURL => { await (await import(moduleURL)).ready; }, moduleURL);

  await check('installed-editable-explicit-capture', async () => {
    assert.equal(await page.title(), 'Local revision review');
    assert.equal(await page.locator('#revision-capture').isEnabled(), true);
    assert.equal(await page.locator('#revision-editor [contenteditable="true"]').count() > 0 || await page.locator('#revision-editor').getAttribute('contenteditable') === 'true', true);
    await edit('First revision: local capture.');
    const live = await observe();
    assert.ok(live.journalUpdates > 0); assert.equal(live.retained.revisions, 0);
    assert.match(await page.locator('#revision-save-status').textContent(), /saved locally/);
    assert.match(await page.locator('.note').textContent(), /Reloading loses captures/);
    facts.oracles.edit = live;
  });
  await check('two-named-immutable-semantic-captures', async () => {
    firstExpected = (await observe()).snapshot;
    first = await capture('Before rewrite');
    await edit('Second revision: a distinct saved document.');
    const secondExpected = (await observe()).snapshot;
    second = await capture('After rewrite');
    const history = await retained();
    assert.equal(history.revisions.length, 2);
    assert.deepEqual(first.snapshot, firstExpected); assert.deepEqual(second.snapshot, secondExpected);
    assert.deepEqual(history.revisions[0], first, 'Later editing cannot change the first capture');
    for (const [revision, snapshot, label] of [[first, firstExpected, 'Before rewrite'], [second, secondExpected, 'After rewrite']]) {
      const body = { label, representation: 'semantic', profile: 'editac-web-history-v1', scope: { identity: snapshot.identity, moduleProfile: 'revision-review-task-v1' }, snapshot, provenance: { origin: 'unknown' }, keyProfile: null };
      assert.equal(revision.hash, sha(JSON.stringify(body)), 'Independent Node hash of the expected captured input');
    }
    assert.notEqual(first.hash, second.hash);
    await page.getByRole('button', { name: 'Inspect Before rewrite', exact: true }).click();
    const detail = page.getByRole('region', { name: 'Readonly historical inspection', exact: true });
    assert.match(await detail.textContent(), /First revision: local capture\./);
    assert.match(await detail.textContent(), new RegExp(first.hash));
    assert.match(await detail.textContent(), /Unknown \/ unverified attribution/);
    assert.match(await detail.textContent(), /semantic projection; original source spelling is not retained/);
    assert.equal(await detail.locator('input,textarea,[contenteditable="true"]').count(), 0);
    facts.oracles.captures = { first, second };
  });
  await check('inspection-preserves-live-engine-and-journal', async () => {
    const before = await observe();
    for (const label of ['After rewrite', 'Before rewrite', 'After rewrite']) await page.getByRole('button', { name: `Inspect ${label}`, exact: true }).click();
    const after = await observe(); assert.deepEqual(stable(after), stable(before));
    const detached = await page.evaluate(async ({ moduleURL, handle }) => {
      const { workspace: w } = await import(moduleURL); const read = w.store.read(handle, w.access());
      try { read.revision.snapshot.visible.length = 0; } catch {}
      return w.store.read(handle, w.access()).revision;
    }, { moduleURL, handle: first.handle });
    assert.deepEqual(detached, first);
    facts.oracles.inspection = { before, after };
    await page.screenshot({ path: join(output, 'capture-inspection.png'), fullPage: true });
  });
  await check('fifo-count-pruning', async () => {
    await capture('Third capture'); await capture('Fourth capture');
    const history = await retained();
    assert.equal(history.usage.revisions, 3); assert.ok(history.usage.bytes <= 24576);
    assert.deepEqual(history.revisions.map(r => r.label), ['After rewrite', 'Third capture', 'Fourth capture']);
    const read = await page.evaluate(async ({ moduleURL, handle }) => {
      const { workspace: w } = await import(moduleURL); w.review.inspect(handle); return w.store.read(handle, w.access());
    }, { moduleURL, handle: first.handle });
    assert.deepEqual(read, { kind: 'unavailable', reason: 'pruned' });
    assert.match(await page.getByRole('region', { name: 'Revision history', exact: true }).textContent(), /History unavailable: pruned/);
    facts.oracles.count = history;
  });
  await check('encoded-byte-pruning', async () => {
    await edit('B'.repeat(3000));
    for (const name of ['Large one', 'Large two', 'Large three']) await capture(name);
    const history = await retained();
    assert.equal(history.usage.revisions, 2, 'Bytes must prune before the three-capture count limit');
    assert.deepEqual(history.revisions.map(r => r.label), ['Large two', 'Large three']);
    const encodedBytes = history.revisions.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0);
    assert.equal(history.usage.bytes, encodedBytes); assert.ok(encodedBytes <= 24576);
    assert.ok(history.revisions.every(r => Buffer.byteLength(JSON.stringify(r)) <= 12288));
    facts.oracles.bytes = { usage: history.usage, independentlyCountedBytes: encodedBytes, labels: history.revisions.map(r => r.label) };
  });
  await check('oversized-capture-error-preserves-history-and-live', async () => {
    await edit('X'.repeat(14000));
    const before = await observe(), history = await retained();
    await page.locator('#revision-name').fill('Too large'); await page.locator('#revision-capture').click();
    await page.waitForFunction(() => document.querySelector('#revision-capture-status').dataset.state === 'error');
    assert.match(await page.locator('#revision-capture-status').textContent(), /exceeds byte limit/);
    assert.deepEqual(stable(await observe()), stable(before)); assert.deepEqual(await retained(), history);
    assert.equal(await page.locator('#revision-capture').isEnabled(), true);
    await edit('Recovered after the oversized capture.'); await capture('Retry works');
    facts.oracles.oversize = { before, after: 'Live bytes and retained history unchanged on rejection; smaller retry succeeds' };
  });
  await check('saved-live-reopens-captures-do-not', async () => {
    await edit('Saved live content survives reload.');
    const before = await observe(); assert.ok(before.retained.revisions > 0);
    await call('close'); await page.reload();
    await page.evaluate(async moduleURL => { await (await import(moduleURL)).ready; }, moduleURL);
    const after = await observe(); assert.equal(after.text, before.text); assert.deepEqual(after.snapshot.identity, before.snapshot.identity);
    assert.deepEqual(after.snapshot.visible, before.snapshot.visible); assert.equal(after.retained.revisions, 0);
    await edit('Reopened document remains editable.');
    facts.oracles.reopen = { before, after };
  });
  await check('default-routes-remain-disabled', async () => {
    const paths = ['examples/task-editor/index.html', 'examples/task-editor/product.mjs', 'examples/task-editor/editor.mjs', 'examples/task-editor/workspace.mjs', 'examples/task-editor/react.mjs', 'examples/task-editor/formats.mjs', 'examples/task-editor/offline.mjs', 'examples/task-editor/offline-worker.mjs', 'examples/task-editor/FEATURES.md', 'fixtures/product-scenarios/web/features.json', 'fixtures/product-scenarios/web/manifest.json', 'tests/scenarios/run.mjs', 'tests/scenarios/harness.mjs'];
    const hashes = [];
    for (const path of paths) { const bytes = await readFile(join(root, path)); assert.doesNotMatch(bytes.toString(), /revision-review/); hashes.push({ path, sha256: sha(bytes) }); }
    assert.equal(server.requests.some(r => /\/(?:editor|workspace|formats|offline|react)\.mjs/.test(r.url)), false);
    assert.equal(server.requests.some(r => /\/fixture\/oracles\.mjs/.test(r.url)), true, 'Independent oracle actually ran');
    facts.defaultRoutes = hashes;
  });
  await call('close');
}
