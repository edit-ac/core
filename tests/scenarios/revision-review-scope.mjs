import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function scopeCases({ page, server, facts, check, output }) {
  const moduleURL = '/fixture/revision-review.mjs';
  const prefix = name => name === 'task' ? '' : 'comment-';
  const id = (name, suffix) => `#${prefix(name)}revision-${suffix}`;
  const observe = async name => {
    try { return await page.evaluate(async ({ moduleURL, name }) => {
      const { instances } = await import(moduleURL);
      return (await import('/fixture/oracles.mjs')).liveOracle(instances[name]);
    }, { moduleURL, name }); }
    catch (error) {
      facts.lifecycleFailure = await page.evaluate(async moduleURL => {
        const { instances } = await import(moduleURL);
        return { url: location.href, states: Object.fromEntries(Object.entries(instances).map(([name, w]) => {
          const root = document.querySelector(name === 'task' ? '#revision-editor' : '#comment-revision-editor').closest('.workspace');
          let read; try { read = w.owner.engine.read().revision; } catch (error) { read = error.message; }
          return [name, { closed: w.closed, lifecycle: root.dataset.lifecycle, read, status: root.querySelector('[id$="revision-save-status"]').textContent }];
        })) };
      }, moduleURL).catch(() => null);
      throw error;
    }
  };
  const durable = ({ identity, visible, recovery, retainedStructure }) => ({ identity, visible, recovery, retainedStructure });
  const stable = ({ snapshot, checkpoint, journal }) => ({ snapshot, checkpoint, journal });
  const edit = async (name, text) => {
    await page.locator(`${id(name, 'editor')} [data-node-id]`).first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type(text);
    await page.evaluate(async ({ moduleURL, name }) => (await import(moduleURL)).instances[name].save(), { moduleURL, name });
    assert.equal((await observe(name)).text, text);
  };
  const capture = async (name, label) => {
    await page.locator(id(name, 'name')).fill(label);
    await page.locator(id(name, 'capture')).click();
    await page.waitForFunction(({ selector, label }) => document.querySelector(selector).textContent.startsWith(`Captured “${label}”`), { selector: id(name, 'capture-status'), label });
    return page.evaluate(async ({ moduleURL, name }) => {
      const w = (await import(moduleURL)).instances[name];
      return w.store.list(w.access()).at(-1).handle;
    }, { moduleURL, name });
  };
  const lifecycle = async (name, action) => {
    await page.locator(id(name, action)).click();
    // Poll DOM only. Importing the product from a browser's polling realm can
    // instantiate a second module graph and alter the page under observation.
    await page.waitForFunction(({ name, action }) => {
      const button = document.querySelector(name === 'task' ? '#revision-reopen' : '#comment-revision-reopen');
      const phase = button.closest('.workspace').dataset.lifecycle;
      return action === 'close' ? phase === 'closed' && !button.disabled : phase === 'ready' && button.disabled;
    }, { name, action });
  };
  let taskHandle, commentHandle, taskBeforeClose, siblingBeforeClose;
  await page.goto(server.url + '/fixture/revision-review.html');
  await page.evaluate(async moduleURL => { await (await import(moduleURL)).ready; }, moduleURL);
  await check('simultaneous-independent-identities-and-journals', async () => {
    await edit('task', 'Task owns its saved draft.');
    const before = await observe('task');
    await edit('comment', 'Comment owns its independent reply.');
    const comment = await observe('comment');
    assert.deepEqual(stable(await observe('task')), stable(before));
    assert.notDeepEqual(before.snapshot.identity, comment.snapshot.identity);
    assert.ok(before.journalUpdates > 0 && comment.journalUpdates > 0);
    const options = await page.evaluate(async moduleURL => Object.values((await import(moduleURL)).instances).map(w => ({ database: w.options.databaseName, scope: w.access().scope })), moduleURL);
    assert.notEqual(options[0].database, options[1].database);
    assert.notEqual(options[0].scope.moduleProfile, options[1].scope.moduleProfile);
    facts.oracles.initial = { task: before, comment, options };
  });
  await check('independent-capture-selection', async () => {
    taskHandle = await capture('task', 'Task before edit');
    commentHandle = await capture('comment', 'Comment before edit');
    const before = { task: await observe('task'), comment: await observe('comment') };
    await capture('task', 'Task second capture');
    await page.locator('#revision-history').getByRole('button', { name: 'Inspect Task before edit', exact: true }).click();
    assert.match(await page.locator('#revision-history').innerText(), /Task before edit/);
    assert.match(await page.locator('#comment-revision-history [aria-label="Readonly historical inspection"]').innerText(), /Comment before edit/);
    assert.doesNotMatch(await page.locator('#comment-revision-history').innerText(), /Task before edit/);
    assert.deepEqual(stable(await observe('task')), stable(before.task));
    assert.deepEqual(stable(await observe('comment')), stable(before.comment));
    assert.equal((await observe('task')).retained.revisions, 2);
    assert.equal((await observe('comment')).retained.revisions, 1);
  });
  await check('foreign-handle-and-scope-denied', async () => {
    const before = { task: await observe('task'), comment: await observe('comment') };
    const results = await page.evaluate(async ({ moduleURL, taskHandle, commentHandle }) => {
      const { task, comment } = (await import(moduleURL)).instances;
      task.review.inspect(commentHandle); comment.review.inspect(taskHandle);
      return { task: task.store.read(taskHandle, comment.access()), comment: comment.store.read(commentHandle, task.access()), foreign: comment.store.read(taskHandle, comment.access()) };
    }, { moduleURL, taskHandle, commentHandle });
    assert.deepEqual(results, { task: { kind: 'unavailable', reason: 'incompatible' }, comment: { kind: 'unavailable', reason: 'incompatible' }, foreign: { kind: 'unavailable', reason: 'missing' } });
    for (const name of ['task', 'comment']) {
      assert.match(await page.locator(id(name, 'history')).innerText(), /History unavailable: missing/);
      assert.deepEqual(stable(await observe(name)), stable(before[name]));
    }
    assert.equal(await page.getByRole('button', { name: /^(Preview|Apply) restore as new edit$/ }).count(), 0, 'Foreign history exposes no preview or confirmation capability');
    facts.oracles.foreign = { before, results };
  });
  await check('readonly-instance-keeps-sibling-editable', async () => {
    const before = await observe('task');
    await page.locator('#revision-readonly').check();
    assert.equal(await page.locator('#revision-editor').getAttribute('aria-readonly'), 'true');
    assert.equal(await page.locator('#comment-revision-editor').getAttribute('aria-readonly'), 'false');
    await page.locator('#revision-editor [data-node-id]').first().click(); await page.keyboard.type('blocked');
    assert.deepEqual(stable(await observe('task')), stable(before));
    await edit('comment', 'Sibling remains editable while task is readonly.');
    assert.deepEqual(stable(await observe('task')), stable(before));
    await page.locator('#revision-readonly').uncheck();
    await edit('task', 'Task saved before disposal.');
  });
  await check('dispose-detaches-only-target-instance', async () => {
    taskBeforeClose = await observe('task'); siblingBeforeClose = await observe('comment');
    await page.evaluate(async moduleURL => { window.oldTaskReview = (await import(moduleURL)).instances.task; }, moduleURL);
    await lifecycle('task', 'close');
    assert.equal(await page.locator('#revision-history [aria-label="Revision history"]').count(), 0);
    assert.equal(await page.locator('#revision-editor').getAttribute('contenteditable'), 'false');
    assert.equal(await page.locator('#revision-capture').isDisabled(), true);
    // Dispatch on the old host: removed listeners cannot capture or change readonly state.
    const detached = await page.evaluate(async moduleURL => {
      const old = window.oldTaskReview;
      const count = old.store.usage.revisions;
      // Suppress the browser's native submit action while testing detached product listeners.
      document.querySelector('#revision-capture-form').addEventListener('submit', event => event.preventDefault(), { once: true });
      document.querySelector('#revision-capture-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      document.querySelector('#revision-readonly').dispatchEvent(new Event('change'));
      await Promise.resolve();
      return { before: count, after: old.store.usage.revisions, closed: old.closed, readonly: old.readonly, siblingClosed: (await import(moduleURL)).instances.comment.closed };
    }, moduleURL);
    assert.deepEqual(detached, { before: 2, after: 2, closed: true, readonly: false, siblingClosed: false });
    assert.deepEqual(stable(await observe('comment')), stable(siblingBeforeClose));
    await edit('comment', 'Sibling saved after task disposal.');
    facts.oracles.disposal = { taskBeforeClose, siblingBeforeClose, detached, siblingAfterEdit: await observe('comment') };
  });
  await check('sibling-save-and-reopen', async () => {
    const before = await observe('comment');
    await lifecycle('comment', 'close'); await lifecycle('comment', 'reopen');
    const after = await observe('comment');
    assert.equal(after.text, before.text); assert.deepEqual(durable(after.snapshot), durable(before.snapshot));
    assert.equal(after.retained.revisions, 0);
    assert.match(await page.locator(id('comment', 'capture-status')).innerText(), /No captures retained/);
    assert.equal(await page.locator('#revision-reopen').isEnabled(), true);
    await edit('comment', 'Reopened sibling is still editable.');
    facts.oracles.siblingReopen = { before, after };
  });
  await check('remount-reopens-only-own-durable-document', async () => {
    const before = await observe('comment');
    await lifecycle('task', 'reopen');
    const after = await observe('task');
    assert.equal(after.text, taskBeforeClose.text); assert.deepEqual(durable(after.snapshot), durable(taskBeforeClose.snapshot));
    assert.equal(after.retained.revisions, 0);
    assert.deepEqual(stable(await observe('comment')), stable(before));
    assert.equal(await page.locator('#revision-readonly').isEnabled(), true);
    assert.equal(await page.locator('#revision-readonly').isChecked(), false);
    await capture('task', 'Remounted task');
    const counts = await page.evaluate(async moduleURL => ({ old: window.oldTaskReview.store.usage.revisions, current: (await import(moduleURL)).instances.task.store.usage.revisions }), moduleURL);
    assert.deepEqual(counts, { old: 2, current: 1 }, 'Remount must not duplicate old capture listeners');
    facts.oracles.taskReopen = { before: taskBeforeClose, after, counts };
  });
  await check('scope-swap-preserves-live-bytes', async () => {
    const before = { task: await observe('task'), comment: await observe('comment') };
    const reads = await page.evaluate(async ({ moduleURL, taskHandle, commentHandle }) => {
      const { task, comment } = (await import(moduleURL)).instances;
      task.review.inspect(taskHandle); comment.review.inspect(commentHandle);
      return [task.store.read(commentHandle, task.access()), comment.store.read(taskHandle, comment.access())];
    }, { moduleURL, taskHandle, commentHandle });
    assert.deepEqual(reads, [{ kind: 'unavailable', reason: 'missing' }, { kind: 'unavailable', reason: 'missing' }]);
    for (const name of ['task', 'comment']) assert.deepEqual(stable(await observe(name)), stable(before[name]));
    facts.oracles.final = before;
    await page.screenshot({ path: join(output, 'independent-scopes.png'), fullPage: true });
    await page.evaluate(async moduleURL => { await (await import(moduleURL)).close(); }, moduleURL);
  });
}
