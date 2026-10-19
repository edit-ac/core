// Diagnose Firefox's worker control plane against an installed product site.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { firefox } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
await requireTestNode();
assert.equal(process.argv.length, 4, 'Expected installed site and output receipt');
const [site, output] = process.argv.slice(2).map(value => resolve(value));
const facts = { cases: [], requests: [], processes: [], teardown: [] };
let server, controller, browser;
try {
  server = await startFixtureServer({ fixtureDirectory: join(site, 'fixture'), coreDirectory: join(site, 'core'), webDirectory: join(site, 'web'), recordRequests: true });
  facts.processes.push({ pid: process.pid, port: server.port, purpose: 'Firefox offline control-plane diagnosis' });
  controller = await firefox.launchServer({ headless: true });
  facts.processes.push({ pid: controller.process().pid, purpose: 'Firefox diagnosis browser' });
  browser = await firefox.connect(controller.wsEndpoint());
  const page = await browser.newPage(); page.setDefaultTimeout(8000);
  await page.goto(server.url + '/fixture/index.html');
  await page.evaluate(async () => { await (await import('/fixture/editor.mjs')).ready; });
  await page.locator('#prepare-offline').click();
  await page.waitForFunction(() => document.querySelector('#offline-message').dataset.state === 'ready');
  await page.context().setOffline(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  server.setPhase('emulated-offline-explicit-update');
  const before = server.requests.length;
  facts.update = await page.evaluate(async () => {
    try { await (await navigator.serviceWorker.getRegistration()).update(); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });
  facts.updateRequests = server.requests.slice(before);
  assert.equal(facts.update.success, true, 'Firefox update did not bypass page offline emulation');
  assert.ok(facts.updateRequests.some(request => request.serviceWorker === 'script' && request.status === 200));
  facts.cases.push({ id: 'firefox-worker-update-bypasses-page-offline', status: 'passed' });
  await server.suspendTransport();
  assert.equal(server.listening, false);
  const unavailableCount = server.requests.length;
  facts.unavailableUpdate = await page.evaluate(async () => {
    try { await (await navigator.serviceWorker.getRegistration()).update(); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });
  assert.equal(facts.unavailableUpdate.success, false);
  assert.equal(server.requests.length, unavailableCount);
  facts.cases.push({ id: 'worker-update-fails-with-real-transport-loss', status: 'passed' });
  await assert.rejects(fetch(server.url + '/fixture/offline-worker.mjs'));
  assert.equal(server.requests.length, unavailableCount);
  facts.cases.push({ id: 'uncached-http-cannot-reach-closed-listener', status: 'passed' });
  await page.reload();
  await page.evaluate(async () => { await (await import('/fixture/editor.mjs')).ready; });
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  assert.equal(server.requests.length, unavailableCount);
  facts.cases.push({ id: 'installed-product-reloads-with-real-transport-loss', status: 'passed' });
  await server.resumeTransport();
  assert.equal(server.listening, true);
  assert.equal((await fetch(server.url + '/fixture/offline-worker.mjs')).status, 200);
  facts.cases.push({ id: 'same-port-transport-restored', status: 'passed' });
} catch (error) { facts.failure = error.stack; process.exitCode = 1; }
finally {
  if (server) { facts.requests = server.requests; facts.transport = server.transport; }
  if (browser) { await browser.close(); facts.teardown.push('browser connection closed'); }
  if (controller) { await controller.close(); facts.teardown.push('browser controller closed'); }
  if (server) { await server.close(); facts.teardown.push('listener closed'); }
  facts.counts = { executed: facts.cases.length + (facts.failure ? 1 : 0), passed: facts.cases.length, failed: facts.failure ? 1 : 0, skipped: 0 };
  await writeFile(output, JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ counts: facts.counts, failure: facts.failure }));
}
