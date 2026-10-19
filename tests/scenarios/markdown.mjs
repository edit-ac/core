import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { prepareProductHarness, sha } from './harness.mjs';
import { loadScenario, root } from './run.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
await requireTestNode();
assert.ok(process.env.EDITAC_PRODUCT_SITE_RECEIPT, 'Prepare one installed optional product first');
assert.ok(process.env.EDITAC_PRODUCT_CASE_OUTPUT, 'Name an evidence output');
const engine = process.env.EDITAC_PRODUCT_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert.ok(browserType, 'Unknown engine');
const output = resolve(process.env.EDITAC_PRODUCT_CASE_OUTPUT);
await mkdir(output, { recursive: true });
const facts = { parent: 'WFE-3.1', child: 'WFE-3.1-C4i', scenario: 'web-markdown',
  command: ['node', 'tests/scenarios/markdown.mjs'], output, profile: { engine, storage: 'real IndexedDB', optionalMarkdown: 'explicit query only' },
  commands: [], cases: [], processes: [], teardown: [] };
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(facts, null, 2) + '\n');
let server, controller, browser;
async function teardown() {
  for (const [name, resource] of [['browser connection', browser], ['browser controller', controller], ['fixture listener', server]]) {
    if (!resource) continue;
    try { await resource.close(); facts.teardown.push(name + ' closed'); }
    catch (error) { facts.teardown.push(name + ': ' + error.message); process.exitCode = 1; }
  }
  browser = controller = server = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void teardown().finally(() => process.exit(143)); });
async function check(id, run) {
  try { await run(); facts.cases.push({ id, passed: true }); }
  catch (error) { facts.cases.push({ id, passed: false, error: error.stack }); throw error; }
  await save();
}
const state = page => page.evaluate(async () => {
  const m = await import('/fixture/editor.mjs');
  return Object.fromEntries(['task', 'comment'].map(name => [name, { visible: m[name].editor.read().visible,
    identity: m[name].options.identity, database: m[name].options.databaseName, errors: m[name].events.error }]));
});
const text = slot => slot.visible.flatMap(n => n.runs?.map(r => r.text) ?? []).join('');
async function paste(page, selector, source) {
  await page.locator(selector + ' [data-node-id]').first().click();
  await page.keyboard.press('Meta+a');
  await page.locator(selector).evaluate((root, source) => {
    const data = new DataTransfer(); data.setData('text/markdown', source); data.setData('text/plain', source);
    // Firefox does not retain clipboardData supplied to ClipboardEvent's constructor.
    // Use the same deterministic event envelope as the original browser harness;
    // the actual product clipboard middleware still handles and commits the paste.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    root.dispatchEvent(event);
  }, source);
  await page.evaluate(async () => { const m = await import('/fixture/editor.mjs'); await Promise.all([m.task.editor.settle(), m.comment.editor.settle()]); });
}
try {
  const { scenario } = await loadScenario('web-task-workspace');
  const { site } = await prepareProductHarness(output, facts, scenario);
  for (const path of ['tests/scenarios/markdown.mjs', 'examples/task-editor/product.mjs', 'examples/task-editor/product-markdown.mjs']) {
    if (!facts.sources.some(p => p.path === path)) facts.sources.push({ path, sha256: sha(await readFile(join(root, path))) });
  }
  server = await startFixtureServer({ fixtureDirectory: join(site, 'fixture'), coreDirectory: join(site, 'core'),
    webDirectory: join(site, 'web'), markdownDirectory: join(site, 'markdown'), recordRequests: true });
  facts.processes.push({ pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: 'installed opt-in Markdown product', log: join(output, 'receipt.json') });
  controller = await browserType.launchServer({ headless: true });
  facts.processes.push({ pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: root, purpose: engine, log: join(output, 'receipt.json') });
  browser = await browserType.connect(controller.wsEndpoint()); facts.browser = { engine, version: browser.version() };
  const errors = [];
  const open = async query => {
    const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.url + '/fixture/index.html' + query);
    await page.evaluate(async () => { await (await import('/fixture/editor.mjs')).ready; });
    return { page, context };
  };
  const literal = '# **literal 😀**';
  await check('product-default-literal-without-parser', async () => {
    const { page, context } = await open('');
    await paste(page, '#editor', literal);
    const before = await state(page);
    assert.equal(text(before.task), literal); assert.equal(text(before.comment), 'Add a comment');
    assert.deepEqual(before.task.visible[0].blockAttributes, ['paragraph']);
    assert.ok(before.task.visible[0].runs.every(run => !run.attributes.bold));
    assert.equal(server.requests.filter(r => r.url.includes('/markdown/')).length, 0);
    await page.evaluate(async () => { const m = await import('/fixture/editor.mjs'); await m.saveLocally(); await m.reopenOffline(); });
    assert.deepEqual((await state(page)).task.visible, before.task.visible);
    await context.close();
  });
  const { page, context } = await open('?markdown');
  let enabled;
  await check('product-opt-in-parser-first-frame', async () => {
    await paste(page, '#editor', '# **enabled 😀**'); enabled = await state(page);
    assert.equal(text(enabled.task), 'enabled 😀');
    assert.deepEqual(enabled.task.visible[0].blockAttributes, ['heading', 1]);
    assert.equal(enabled.task.visible[0].runs[0].attributes.bold, true);
    assert.equal(text(enabled.comment), 'Add a comment');
    const wasm = server.requests.filter(r => r.url === '/markdown/wasm/editac_markdown_wasm_bg.wasm');
    assert.equal(wasm.length, 1); assert.equal(wasm[0].status, 200);
    assert.equal(wasm[0].sha256, facts.artifacts.find(a => a.path.endsWith('/markdown/wasm/editac_markdown_wasm_bg.wasm')).sha256);
  });
  await check('product-opt-in-comment-stays-literal', async () => {
    await paste(page, '#comment', literal); const result = await state(page);
    assert.equal(text(result.comment), literal); assert.deepEqual(result.comment.visible[0].blockAttributes, ['paragraph']);
    assert.ok(result.comment.visible[0].runs.every(run => !run.attributes.bold));
    assert.deepEqual(result.task.visible, enabled.task.visible);
    assert.notDeepEqual(result.task.identity, result.comment.identity); assert.notEqual(result.task.database, result.comment.database);
  });
  await check('product-markdown-save-reopen-preserves-semantics', async () => {
    await page.evaluate(async () => { const m = await import('/fixture/editor.mjs'); await m.saveLocally(); await m.reopenOffline(); });
    const reopened = await state(page); assert.deepEqual(reopened.task.visible, enabled.task.visible);
    assert.deepEqual(reopened.task.identity, enabled.task.identity); assert.equal(text(reopened.comment), literal);
    assert.deepEqual(reopened.task.errors, []);
  });
  await check('product-disposal-preserves-independent-comment', async () => {
    await page.evaluate(async () => { await (await import('/fixture/editor.mjs')).task.close(); });
    await page.locator('#comment [data-node-id]').first().click(); await page.keyboard.press('End'); await page.keyboard.type(' still live');
    const result = await page.evaluate(async () => { const { comment } = await import('/fixture/editor.mjs'); await comment.editor.settle(); await comment.save(); return { nodes: comment.editor.read().visible, errors: comment.events.error }; });
    assert.equal(result.nodes.flatMap(n => n.runs?.map(r => r.text) ?? []).join(''), literal + ' still live');
    assert.deepEqual(result.errors, []); assert.deepEqual(errors, []);
  });
  await context.close(); facts.exit = 0;
} catch (error) { facts.failure = error.stack; facts.exit = 1; process.exitCode = 1; }
finally {
  facts.serverRequests = server?.requests; await teardown();
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.passed).length,
    failed: facts.cases.filter(c => !c.passed).length, skipped: 0, required: 5 };
  if (facts.counts.executed !== 5 || process.exitCode) { facts.exit = 1; process.exitCode = 1; }
  facts.sourcesUnchanged = facts.sources && (await Promise.all(facts.sources.map(async p => sha(await readFile(join(root, p.path))) === p.sha256))).every(Boolean);
  if (!facts.sourcesUnchanged) { facts.exit = 1; process.exitCode = 1; }
  await save(); console.log(JSON.stringify({ engine, counts: facts.counts, exit: facts.exit, failure: facts.failure?.split('\n').slice(0, 3) }));
}
