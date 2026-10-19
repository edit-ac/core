import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './run.mjs';
import { sha } from './harness.mjs';

export async function keyboardCases({ page, server, facts, check, output }) {
  const moduleURL = '/fixture/revision-review.mjs';
  // macOS WebKit follows Safari: Option-Tab includes native buttons.
  const tabKey = facts.engine === 'webkit' ? 'Alt+Tab' : 'Tab';
  const observe = (name = 'task') => page.evaluate(async ({ moduleURL, name }) =>
    { const w = (await import(moduleURL)).instances[name]; return { ...await (await import('/fixture/oracles.mjs')).liveOracle(w), history: w.owner.engine.history({ type: 'state' }) }; }, { moduleURL, name });
  const stable = value => {
    // Patch-delivery hints are consumed by reads; they are not document state.
    const { changedNodes, touchedRanges, ...snapshot } = value.snapshot;
    return { snapshot, checkpoint: value.checkpoint, journal: value.journal, history: value.history };
  };
  const focused = locator => locator.evaluate(node => node === document.activeElement);
  const key = async (locator, key = 'Enter') => { await locator.focus(); await page.keyboard.press(key); };
  const history = page.locator('#revision-history');
  const inspect = label => history.getByRole('button', { name: 'Inspect ' + label, exact: true });
  const preview = () => history.getByRole('button', { name: 'Preview restore as new edit', exact: true });
  const capture = async label => {
    await page.locator('#revision-name').focus(); await page.keyboard.type(label);
    await page.keyboard.press(tabKey); assert.equal(await focused(page.locator('#revision-capture')), true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(label => document.querySelector('#revision-capture-status').textContent.startsWith(`Captured “${label}”`), label);
  };
  const edit = async text => {
    await page.locator('#revision-editor [data-node-id]').first().click();
    await page.keyboard.press('Meta+a'); await page.keyboard.type(text);
    await key(page.locator('#revision-save'));
    await page.waitForFunction(() => document.querySelector('#revision-save-status').textContent.startsWith('Live document saved locally'));
    assert.equal((await observe()).text, text);
  };
  await page.goto(server.url + '/fixture/revision-review.html');
  await page.evaluate(async url => { await (await import(url)).ready; }, moduleURL);
  let before, sibling;
  await check('native-controls-have-visible-labels-and-focus-style', async () => {
    const labels = await page.locator('button,input,select').evaluateAll(nodes => nodes.map(node => ({
      id: node.id, tag: node.tagName, text: node.textContent.trim(), labels: [...(node.labels ?? [])].map(label => label.textContent.trim()),
    })));
    assert.ok(labels.length > 20);
    for (const control of labels) assert.ok(control.tag === 'BUTTON' ? control.text : control.labels.some(Boolean), JSON.stringify(control));
    assert.equal(await page.locator('#revision-cancel-restore').isDisabled(), true);
    assert.equal(await page.locator('#revision-reopen').isDisabled(), true);
    assert.equal(await page.locator('#revision-compare').isDisabled(), true);
    assert.equal(await page.locator('#revision-before').isDisabled(), true);
    await page.locator('#revision-name').focus(); await page.keyboard.press(tabKey);
    assert.equal(await focused(page.locator('#revision-capture')), true);
    assert.equal(await page.locator('#revision-capture').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    facts.oracles.labels = labels;
  });
  await check('keyboard-capture-opens-details-with-preserved-selection', async () => {
    await edit('Keyboard baseline: café 世界.');
    before = await observe(); sibling = await observe('comment');
    facts.oracles.before = { task: before, sibling };
    const selection = await page.evaluate(() => String(getSelection()));
    await capture('Alpha');
    assert.equal(await focused(history.locator('[aria-label="Readonly historical inspection"]')), true);
    assert.equal(await page.evaluate(() => String(getSelection())), selection);
    assert.deepEqual(stable(await observe()), stable(before));
  });
  await check('detail-close-returns-to-inspect-invoker', async () => {
    await key(page.locator('#revision-close-detail'), 'Space');
    assert.equal(await focused(page.locator('#revision-capture')), true);
    await key(inspect('Alpha'));
    assert.equal(await focused(history.locator('[aria-label="Readonly historical inspection"]')), true);
    await key(page.locator('#revision-close-detail'));
    assert.equal(await focused(inspect('Alpha')), true);
    const live = page.locator('#revision-editor [data-node-id]').first();
    await live.click(); await page.keyboard.press('Meta+ArrowLeft'); await page.keyboard.press('Shift+ArrowRight');
    const selection = () => page.evaluate(() => {
      const s = getSelection(); const point = node => node?.parentElement?.closest('[data-node-id]')?.dataset.nodeId;
      return { text: String(s), anchor: point(s.anchorNode), focus: point(s.focusNode), anchorOffset: s.anchorOffset, focusOffset: s.focusOffset };
    });
    const selected = await selection(); assert.equal(selected.text, 'K'); assert.ok(selected.anchor);
    await key(inspect('Alpha')); assert.deepEqual(await selection(), selected);
    await key(page.locator('#revision-close-detail')); assert.deepEqual(await selection(), selected);
    facts.oracles.selection = selected;
    assert.deepEqual(stable(await observe()), stable(before));
  });
  await check('keyboard-native-select-compare-layout-close-focus', async () => {
    await edit('Keyboard current version.');
    await page.locator('#revision-name').fill(''); await capture('Beta');
    before = await observe();
    await page.locator('#revision-before').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('a'); await page.keyboard.press('Enter');
    await page.locator('#revision-after').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('b'); await page.keyboard.press('Enter');
    assert.ok(await page.locator('#revision-before').inputValue()); assert.ok(await page.locator('#revision-after').inputValue());
    assert.notEqual(await page.locator('#revision-before').inputValue(), await page.locator('#revision-after').inputValue());
    await key(page.locator('#revision-compare'));
    assert.equal(await page.locator('#revision-comparison').evaluate(node => node.contains(document.activeElement)), true);
    const layout = page.locator('#revision-comparison').getByRole('button', { name: 'inline view', exact: true });
    await key(layout, 'Space'); assert.equal(await focused(layout), true);
    await key(page.locator('#revision-close-compare'));
    assert.equal(await focused(page.locator('#revision-compare')), true);
    assert.equal(await page.locator('#revision-comparison').innerText(), '');
    assert.deepEqual(stable(await observe()), stable(before));
  });
  await check('restore-preview-cancel-returns-to-preview-invoker', async () => {
    await key(inspect('Alpha')); await key(preview());
    assert.equal(await focused(history.locator('[aria-label="Restore as new edit"]')), true);
    assert.equal(await page.locator('#revision-cancel-restore').isEnabled(), true);
    await page.evaluate(() => { window.retiredApply = document.querySelector('#revision-history [aria-label="Restore as new edit"] button'); });
    await key(page.locator('#revision-cancel-restore'));
    assert.equal(await focused(preview()), true);
    assert.equal(await page.locator('#revision-cancel-restore').isDisabled(), true);
    assert.deepEqual(stable(await observe()), stable(before));
  });
  await check('readonly-denies-restore-with-accurate-controls', async () => {
    await key(page.locator('#revision-readonly'), 'Space');
    assert.equal(await page.locator('#revision-readonly').isChecked(), true);
    await key(inspect('Alpha'));
    assert.equal(await preview().count(), 0);
    assert.equal(await page.locator('#revision-cancel-restore').isDisabled(), true);
    assert.equal(await page.locator('#revision-capture').isEnabled(), true, 'Readonly inspection/capture remains available');
    await page.evaluate(() => window.retiredApply.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.deepEqual(stable(await observe()), stable(before));
    await key(page.locator('#revision-readonly'), 'Space');
    assert.equal(await focused(page.locator('#revision-readonly')), true);
  });
  await check('keyboard-confirm-restore-is-one-ordinary-journaled-edit', async () => {
    await key(inspect('Alpha')); await key(preview());
    await key(history.getByRole('button', { name: 'Apply restore as new edit', exact: true }), 'Space');
    assert.equal(await focused(preview()), true);
    assert.equal(await page.locator('#revision-cancel-restore').isDisabled(), true);
    await key(page.locator('#revision-save'));
    const restored = await observe();
    assert.equal(restored.text, 'Keyboard baseline: café 世界.');
    assert.deepEqual(restored.snapshot.identity, before.snapshot.identity);
    assert.equal(restored.journalUpdates, before.journalUpdates + 1);
    assert.deepEqual(stable(await observe('comment')), stable(sibling));
    facts.oracles.restored = restored; before = restored;
  });
  await check('duplicate-label-detail-return-preserves-exact-invoker', async () => {
    await page.locator('#revision-name').fill(''); await capture('Alpha');
    const duplicate = history.getByRole('button', { name: 'Inspect Alpha', exact: true }).nth(1);
    await key(duplicate); await key(page.locator('#revision-close-detail'));
    assert.equal(await focused(duplicate), true);
    assert.deepEqual(stable(await observe()), stable(before));
  });
  await check('capture-close-race-drains-without-late-history-or-writes', async () => {
    await page.evaluate(async url => {
      const w = (await import(url)).workspace, settle = w.surface.settle.bind(w.surface);
      let held = false;
      w.surface.settle = async () => { await settle(); if (!held) { held = true; await new Promise(resolve => { window.releaseCapture = resolve; }); } };
    }, moduleURL);
    await page.locator('#revision-name').fill('Late capture'); await key(page.locator('#revision-capture'));
    await page.waitForFunction(() => !!window.releaseCapture);
    await key(page.locator('#revision-close'));
    assert.equal(await page.locator('#revision-capture').isDisabled(), true);
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'closed');
    assert.equal(await focused(page.locator('#revision-reopen')), true);
    assert.equal(await page.locator('#revision-capture-status').innerText().then(text => text.includes('Captured “Late capture”')), false);
  });
  await check('closed-listeners-inert-and-keyboard-remount-recovers-durable-text', async () => {
    const closedDOM = await page.locator('.workspace').first().innerHTML();
    await page.locator('.workspace').first().evaluate(root => {
      for (const control of root.querySelectorAll('button:not([id$="revision-reopen"]),input,select,form')) {
        const event = new Event(control.tagName === 'FORM' ? 'submit' : 'click', { bubbles: true, cancelable: true });
        event.preventDefault(); control.dispatchEvent(event);
      }
    });
    assert.equal(await page.locator('.workspace').first().innerHTML(), closedDOM);
    await key(page.locator('#revision-reopen'));
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'ready');
    const reopened = await observe();
    assert.equal(reopened.text, before.text); assert.deepEqual(reopened.snapshot.identity, before.snapshot.identity);
    assert.equal(reopened.journal, before.journal); assert.equal(reopened.retained.revisions, 0);
    assert.equal(await focused(page.locator('#revision-name')), true);
    assert.deepEqual(stable(await observe('comment')), stable(sibling));
    facts.oracles.reopened = reopened;
  });
  await check('page-disposal-retires-reopen-and-retained-presenter-callbacks', async () => {
    await page.locator('#revision-name').fill(''); await capture('Final');
    await key(preview());
    await page.evaluate(() => { window.disposedApply = document.querySelector('#revision-history [aria-label="Restore as new edit"] button'); });
    await page.screenshot({ path: join(output, 'keyboard.png'), fullPage: true });
    await page.evaluate(async url => { await (await import(url)).dispose(); }, moduleURL);
    const disposedDOM = await page.locator('main').innerHTML();
    await page.evaluate(() => {
      window.disposedApply?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (const control of document.querySelectorAll('button,input,select,form')) {
        const event = new Event(control.tagName === 'FORM' ? 'submit' : 'click', { bubbles: true, cancelable: true });
        event.preventDefault(); control.dispatchEvent(event);
      }
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('main').innerHTML(), disposedDOM);
    const remount = await page.evaluate(async url => { try { await (await import(url)).remount('task'); return 'opened'; } catch (error) { return error.message; } }, moduleURL);
    assert.equal(remount, 'This page is disposed');
    assert.equal(await page.locator('input:enabled,button:enabled,select:enabled').count(), 0);
    await page.reload(); await page.evaluate(async url => { await (await import(url)).ready; }, moduleURL);
    const after = await observe(); assert.equal(after.text, before.text); assert.equal(after.journal, before.journal);
    const reopenedSibling = await observe('comment');
    for (const field of ['identity', 'visible', 'retainedStructure']) assert.deepEqual(reopenedSibling.snapshot[field], sibling.snapshot[field]);
    assert.equal(reopenedSibling.text, sibling.text); assert.equal(reopenedSibling.journal, sibling.journal);
    facts.oracles.reopenedSibling = reopenedSibling;
    facts.oracles.afterDisposalReload = after;
  });
  await check('disposal-awaits-opening-owner-and-concurrent-close', async () => {
    await key(page.locator('#revision-close'));
    await page.waitForFunction(() => document.querySelector('.workspace').dataset.lifecycle === 'closed');
    await page.evaluate(async url => {
      const mod = await import(url);
      window.lockHeld = new Promise(resolve => {
        window.holdCreation = navigator.locks.request('example-revision-review-creation', async () => {
          resolve(); await new Promise(release => { window.releaseCreation = release; });
        });
      });
      await window.lockHeld;
      window.pendingRemount = mod.remount('task');
      window.pendingDispose = Promise.all([mod.dispose(), mod.dispose()]);
    }, moduleURL);
    assert.equal(await page.locator('.workspace').first().getAttribute('data-lifecycle'), 'opening');
    await page.evaluate(async () => { window.releaseCreation(); await window.holdCreation; await window.pendingRemount; await window.pendingDispose; });
    assert.equal(await page.locator('input:enabled,button:enabled,select:enabled').count(), 0);
    assert.deepEqual(await page.locator('.workspace').evaluateAll(nodes => nodes.map(node => node.dataset.lifecycle)), ['closed', 'closed']);
    await page.reload(); await page.evaluate(async url => { await (await import(url)).ready; }, moduleURL);
    const after = await observe(); assert.equal(after.text, before.text); assert.equal(after.journal, before.journal);
    facts.oracles.afterOpeningDisposal = after;
  });
  await check('default-routes-unchanged-and-no-orphan-requests', async () => {
    facts.defaultRoutes = [];
    for (const path of ['examples/task-editor/index.html', 'examples/task-editor/product.mjs', 'examples/task-editor/editor.mjs', 'examples/task-editor/workspace.mjs', 'examples/task-editor/react.mjs', 'examples/task-editor/formats.mjs', 'examples/task-editor/offline.mjs', 'examples/task-editor/offline-worker.mjs', 'examples/task-editor/FEATURES.md', 'fixtures/product-scenarios/web/features.json', 'fixtures/product-scenarios/web/manifest.json', 'tests/scenarios/run.mjs', 'tests/scenarios/harness.mjs']) {
      const bytes = await readFile(join(root, path)); assert.doesNotMatch(bytes.toString(), /revision-review/);
      facts.defaultRoutes.push({ path, sha256: sha(bytes) });
    }
    assert.equal(server.requests.some(r => /\/(?:editor|workspace|formats|offline|react)\.mjs/.test(r.url)), false);
    await page.evaluate(async url => { await (await import(url)).dispose(); }, moduleURL);
  });
  await writeFile(join(output, 'oracles.json'), JSON.stringify(facts.oracles, null, 2));
}
