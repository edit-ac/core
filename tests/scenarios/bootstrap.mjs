import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
import { loadScenario, validateScenario, root } from './run.mjs';
import { prepareProductHarness, sha } from './harness.mjs';
await requireTestNode();
const { manifest, scenario } = await loadScenario('web-bootstrap');
const output = resolve(root, '../architecture/evidence/browser-product-workflows-20261018/pwe-1.1', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const facts = { parent: scenario.parent, scenario: 'web-bootstrap', command: ['node', 'tests/scenarios/run.mjs', 'web-bootstrap'], output, profile: manifest.profile, commands: [], cases: [], processes: [], teardown: [], scope: manifest.scope };
let server, controller, browser, activePage;
async function teardown() {
  for (const [name, resource] of [['browser connection', browser], ['Chromium controller', controller], ['fixture listener', server]]) {
    if (!resource) continue;
    try { await resource.close(); facts.teardown.push(name + ' closed'); }
    catch (error) { facts.teardown.push(name + ': ' + error.message); process.exitCode = 1; }
  }
  browser = controller = server = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void teardown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});
async function check(id, run) {
  try { await run(); facts.cases.push({ id, status: 'passed' }); }
  catch (error) { facts.cases.push({ id, status: 'failed', error: error.stack }); throw error; }
}
const text = page => page.evaluate(async () => { const { editor } = await import('/fixture/editor.mjs'); return editor.read().visible.flatMap(n => n.runs?.map(r => r.text) ?? []).join(''); });
try {
  await check('dispatcher-rejects-invalid-inputs', async () => {
    assert.throws(() => validateScenario(manifest, 'unknown-task'), /Unknown scenario/);
    for (const patch of [{ command: [] }, { cases: [] }, { fixtures: [] }]) assert.throws(() => validateScenario({ scenarios: { broken: { ...scenario, ...patch } } }, 'broken'));
    const file = join(output, 'missing-fixture.json');
    await writeFile(file, JSON.stringify({ scenarios: { broken: { ...scenario, fixtures: ['fixtures/product-scenarios/web/absent.json'] } } }));
    await assert.rejects(loadScenario('broken', file), /ENOENT/);
    await writeFile(file, JSON.stringify({ scenarios: { broken: { ...scenario, command: ['node', 'tests/scenarios/absent.mjs'] } } }));
    await assert.rejects(loadScenario('broken', file), /ENOENT/);
    const unknown = spawnSync(process.execPath, ['tests/scenarios/run.mjs', 'unknown-task'], { cwd: root, encoding: 'utf8' });
    assert.equal(unknown.status, 1); assert.match(unknown.stderr, /Unknown scenario/);
    await writeFile(join(output, 'unknown-task.log'), unknown.stderr);
  });
  const { site } = await prepareProductHarness(output, facts, scenario);
  server = await startFixtureServer({ fixtureDirectory: join(site, 'fixture'), coreDirectory: join(site, 'core'), webDirectory: join(site, 'web'), recordRequests: true });
  facts.processes.push({ pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: 'PWE-1.1 installed SDK fixture', log: join(output, 'receipt.json') });
  controller = await chromium.launchServer({ headless: true });
  facts.processes.push({ pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: root, purpose: 'PWE-1.1 Chromium', log: join(output, 'receipt.json') });
  browser = await chromium.connect(controller.wsEndpoint());
  facts.browserVersion = browser.version();
  const page = activePage = await browser.newPage(); const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const ready = async () => { await page.goto(server.url); await page.evaluate(async () => { const sample = await import('/fixture/editor.mjs'); await sample.ready; if (!sample.editor.state.ready) throw Error('Sample ready resolved before editor readiness'); }); };
  let identity;
  await check('installed-sdk-bootstrap', async () => {
    await ready(); assert.equal(await text(page), 'Plan the task');
    identity = await page.evaluate(() => JSON.parse(localStorage.getItem('standalone-task-identity')));
    assert.ok(identity.documentId); assert.ok(identity.epoch);
    assert.ok((await page.evaluate(() => indexedDB.databases())).some(db => db.name === 'standalone-task'));
    assert.ok(server.requests.some(r => r.url.endsWith('.wasm') && r.status === 200));
    assert.equal(await page.locator('[contenteditable="true"]').count(), 1);
  });
  const expected = 'Plan the task persisted product edit';
  await check('local-commit-reload', async () => {
    await page.locator('[contenteditable="true"]').click(); await page.keyboard.press('End'); await page.keyboard.type(' persisted product edit');
    await page.evaluate(async () => (await import('/fixture/editor.mjs')).saveLocally());
    assert.equal(await text(page), expected);
    await page.evaluate(async () => (await import('/fixture/editor.mjs')).close());
    await ready(); assert.equal(await text(page), expected);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('standalone-task-identity'))), identity);
  });
  await check('existing-data-never-reseeded', async () => {
    await page.evaluate(async () => (await import('/fixture/editor.mjs')).reopenOffline());
    assert.equal(await text(page), expected);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('standalone-task-identity'))), identity);
    await page.screenshot({ path: join(output, 'persisted-task.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
  });
  await check('missing-checkpoint-never-reseeded', async () => {
    await page.evaluate(async () => {
      await (await import('/fixture/editor.mjs')).close();
      await new Promise((yes, no) => { const request = indexedDB.deleteDatabase('standalone-task'); request.onsuccess = yes; request.onerror = () => no(request.error); request.onblocked = () => no(Error('Database deletion blocked')); });
    });
    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelector('#message').textContent.startsWith('Unable to open or save task:'));
    assert.equal(await page.evaluate(async () => (await import('/fixture/editor.mjs')).editor.state.ready), false);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('standalone-task-identity'))), identity);
    assert.doesNotMatch(await page.locator('#message').textContent(), /Saved locally/);
    await page.screenshot({ path: join(output, 'missing-checkpoint.png'), fullPage: true });
  });
  assert.deepEqual(new Set(facts.cases.map(c => c.id)), new Set(scenario.cases));
} catch (error) {
  facts.failure = error.stack; process.exitCode = 1;
  if (activePage) {
    try { facts.failureState = await activePage.evaluate(async () => ({ message: document.querySelector('#message')?.textContent, state: (await import('/fixture/editor.mjs')).editor?.state })); await activePage.screenshot({ path: join(output, 'failure.png'), fullPage: true }); }
    catch (diagnostic) { facts.diagnosticError = diagnostic.message; }
  }
}
finally {
  if (server) facts.requests = server.requests;
  await teardown();
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: 0, required: scenario.cases.length };
  if (facts.failure && facts.counts.failed === 0) facts.setupFailure = true;
  if (facts.counts.executed !== facts.counts.required) process.exitCode = 1;
  facts.exit = process.exitCode ?? 0;
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, resolved: { sourceRevision: facts.sourceRevision, sourceTree: facts.sourceTree, sources: facts.sources, packs: facts.packs, browserVersion: facts.browserVersion, artifacts: facts.artifacts } }, null, 2));
  facts.manifestSha256 = sha(await readFile(join(output, 'manifest.json')));
  await writeFile(join(output, 'receipt.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ output, counts: facts.counts, exit: facts.exit, failure: facts.failure?.split('\n').slice(0,3) }));
}
