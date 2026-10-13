import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { startExampleServer } from '../../examples/web/serve.mjs';

let server, browser, controller;
const output = process.env.EDITAC_EXAMPLE_OUTPUT ?? await mkdtemp(resolve(tmpdir(), 'editac-example-evidence-'));
const facts = { cases: [], processes: [], cleanup: {} };
const engineName = process.env.EDITAC_EXAMPLE_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engineName];
if (!browserType) throw Error(`Unknown example browser: ${engineName}`);
before(async () => {
  await mkdir(output, { recursive: true });
  server = await startExampleServer(0);
  facts.server = { pid: process.pid, url: server.url, port: Number(new URL(server.url).port), workspace: process.cwd(), purpose: 'baseline rendered examples', log: output };
  controller = await browserType.launchServer({ headless: true });
  facts.processes.push({ pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: process.cwd(), purpose: `baseline examples ${engineName}`, log: output });
  browser = await browserType.connect(controller.wsEndpoint());
  facts.browser = { engine: engineName, version: browser.version() };
});
after(async () => {
  try { await browser?.close(); } finally {
    try { await controller?.close(); facts.cleanup.browserExited = !controller || controller.process().exitCode !== null || controller.process().signalCode !== null; }
    finally {
      try {
        await server?.close();
        facts.cleanup.listenerRemoved = !server || await new Promise(resolve => {
          const socket = createConnection(Number(new URL(server.url).port), '127.0.0.1');
          socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
        });
      } finally {
        facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.passed).length, failed: facts.cases.filter(c => !c.passed).length, skipped: 0 };
        await writeFile(resolve(output, 'receipt.json'), JSON.stringify(facts, null, 2));
      }
    }
  }
  assert.equal(facts.cleanup.browserExited, true); assert.equal(facts.cleanup.listenerRemoved, true);
});
async function withPage(run, options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  const page = await context.newPage(), errors = [], remote = [];
  const fact = { index: facts.cases.length, passed: false, errors, remote }; facts.cases.push(fact);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(server.url)) remote.push(request.url()); });
  try {
    await run(page);
    assert.deepEqual(errors, [], 'No browser exceptions');
    assert.deepEqual(remote, [], 'No remote services or provider requests');
    fact.passed = true;
  } finally { await context.close(); }
}
async function ready(page) {
  await page.goto(server.url);
  await page.locator('#status').filter({ hasText: 'Ready' }).waitFor();
}
async function headingEnd(page, locator) {
  await locator.evaluate(element => {
    element.closest('[contenteditable]').focus();
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
}
async function exportedText(page) {
  const downloaded = page.waitForEvent('download'); await page.locator('#export').click();
  const stream = await (await downloaded).createReadStream();
  let text = ''; for await (const chunk of stream) text += chunk.toString(); return text;
}
test('example heading trailing spaces remain visible and export as U+0020', async () => withPage(async page => {
  await ready(page);
  const heading = page.locator('#editor h1'), original = await heading.textContent();
  await headingEnd(page, heading); await page.keyboard.press('Space'); await page.keyboard.press('Space');
  assert.equal(await heading.textContent(), original + '  ');
  const widths = await heading.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let last;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
    return [last.length - 2, last.length - 1].map(offset => {
      const range = document.createRange(); range.setStart(last, offset); range.setEnd(last, offset + 1);
      return range.getBoundingClientRect().width;
    });
  });
  assert.ok(widths.every(width => width > 0), 'Both authored trailing spaces are visible');
  await page.keyboard.insertText('X');
  assert.equal(await heading.textContent(), original + '  X');
  const text = await exportedText(page); assert.ok(text.startsWith(original + '  X\n\n')); assert.ok(!text.includes('\u00a0'));
}));
test('example heading Enter before a list creates a paragraph with the next typed character', async () => withPage(async page => {
  await ready(page);
  const heading = page.locator('#editor h2').filter({ hasText: 'What we want to build' });
  const list = page.locator('#editor > ul'), originalList = await list.textContent();
  await heading.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  const destination = heading.locator('xpath=following-sibling::*[1]');
  assert.equal(await destination.evaluate(element => element.tagName), 'P');
  assert.equal(await destination.textContent(), '');
  assert.equal(await destination.evaluate(element => element.nextElementSibling?.tagName), 'UL');
  assert.equal(await destination.evaluate(element => element.contains(getSelection().anchorNode) && getSelection().isCollapsed), true);
  await page.keyboard.insertText('X'); assert.equal(await destination.textContent(), 'X'); assert.equal(await list.textContent(), originalList);
  await page.locator('#undo').click(); assert.equal(await destination.textContent(), '');
  await page.locator('#undo').click(); assert.equal(await heading.evaluate(element => element.nextElementSibling.tagName), 'UL');
  await page.locator('#redo').click(); await page.locator('#redo').click();
  assert.equal(await destination.textContent(), 'X'); assert.equal(await list.textContent(), originalList);
}));
test('public surface shares mount ownership and releases adapters while the host retains its engine', async () => withPage(async page => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { init } = await import('@edit-ac/core'), { mountEditorSurface, mountEditor } = await import('@edit-ac/web');
    const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
    const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: [{ text: 'alpha  ' }] });
    const root = document.createElement('div'); document.body.append(root);
    let surface;
    try {
      surface = mountEditorSurface(root, engine);
      let duplicates = 0;
      for (const mount of [() => mountEditorSurface(root, engine), () => mountEditor(root, {})]) {
        try { mount(); } catch (error) { if (/already mounted/.test(error.message)) duplicates++; else throw error; }
      }
      surface.setReadOnly(true);
      const readOnly = root.contentEditable === 'false' && root.getAttribute('aria-readonly') === 'true';
      const text = root.textContent;
      surface.dispose(); surface.dispose();
      const retained = engine.read().visible[0].runs.map(run => run.text).join('');
      surface = mountEditorSurface(root, engine);
      return { duplicates, readOnly, text, retained, remounted: root.contentEditable === 'true' };
    } finally { surface?.dispose(); engine.dispose(); root.remove(); }
  });
  assert.deepEqual(result, { duplicates: 2, readOnly: true, text: 'alpha  ', retained: 'alpha  ', remounted: true });
}));
test('all three documents render real headings, marks and lists, then export their text', async () => withPage(async page => {
  await ready(page);
  for (const [id, heading, expected] of [
    ['kickoff', 'A quieter workspace', 'calm place'],
    ['bug-report', 'The search field loses focus', 'keeps focus'],
    ['meeting-notes', 'Monday design review', 'three examples'],
  ]) {
    await page.locator(`.example[data-id="${id}"]`).click();
    await page.locator('#editor h1').filter({ hasText: heading }).waitFor();
    assert.equal(await page.locator('#editor strong').textContent(), expected);
    assert.equal(await page.locator('#editor li').count(), 3);
    const downloaded = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloaded, stream = await download.createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk.toString();
    assert.equal(download.suggestedFilename(), `${id}.txt`);
    assert.ok(text.includes(heading)); assert.ok(text.includes(expected));
    assert.match(await page.locator('#word-count').textContent(), /^[1-9]\d* words$/u);
  }
}));
test('typing, undo, redo, read-only, reset and reload work without persistence', async () => withPage(async page => {
  await ready(page);
  const paragraph = page.locator('#editor > p').first();
  const initial = await paragraph.textContent();
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' preview check');
  await paragraph.filter({ hasText: 'preview check' }).waitFor();
  await page.locator('#undo:not([disabled])').waitFor();
  await page.locator('#undo').click();
  assert.equal(await paragraph.textContent(), initial);
  await page.locator('#redo').click();
  assert.ok((await paragraph.textContent()).includes('preview check'));
  await page.locator('#read-only').click();
  assert.equal(await page.locator('#editor').getAttribute('contenteditable'), 'false');
  assert.equal(await page.locator('#editor').getAttribute('aria-readonly'), 'true');
  assert.equal(await page.locator('#undo').isDisabled(), true);
  await page.locator('#read-only').click();
  assert.equal(await page.locator('#editor').getAttribute('contenteditable'), 'true');
  await page.locator('#reset').click();
  assert.equal(await paragraph.textContent(), initial);
  assert.equal(await page.locator('#undo').isDisabled(), true);
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' temporary');
  await paragraph.filter({ hasText: 'temporary' }).waitFor();
  await page.reload(); await page.locator('#status').filter({ hasText: 'Ready' }).waitFor();
  assert.equal(await paragraph.textContent(), initial);
}));
test('mobile layout fits the viewport and controls remain keyboard accessible', async () => withPage(async page => {
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.example[data-id="bug-report"]').focus(); await page.keyboard.press('Enter');
  await page.locator('#editor h1').filter({ hasText: 'The search field loses focus' }).waitFor();
  assert.equal(await page.locator('.example[data-id="bug-report"]').getAttribute('aria-pressed'), 'true');
  if (output) await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
}, { viewport: { width: 390, height: 844 } }));
test('missing WASM keeps the editor disabled and shows a loading failure', async () => withPage(async page => {
  await page.route('**/*.wasm', route => route.abort());
  await page.goto(server.url);
  await page.locator('#status').filter({ hasText: 'Editor could not load' }).waitFor();
  assert.equal(await page.locator('#editor').getAttribute('contenteditable'), 'false');
  assert.equal(await page.locator('#export').isDisabled(), true);
}));
