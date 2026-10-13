import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { chromium } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';

const output = process.env.EDITAC_ENTRY_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-entry-evidence-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [], packed: {}, browser: {}, server: {}, cleanup: {} };
let consumer, server, browser, controller;
async function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  await writeFile(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, `${command}: see ${log}`);
  assert.equal(result.status, 0, `${command}: see ${log}`);
  return result.stdout;
}
before(async () => {
  consumer = await mkdtemp(join(tmpdir(), 'editac-entry-consumer-'));
  const packed = JSON.parse(await run('npm', ['pack', '--workspace', '@edit-ac/core', '--json', '--pack-destination', consumer],
    process.cwd(), 'pack.log'))[0];
  const tarball = await readFile(join(consumer, packed.filename));
  await writeFile(join(output, packed.filename), tarball);
  facts.packed = { filename: packed.filename, bytes: tarball.length,
    sha256: createHash('sha256').update(tarball).digest('hex'), consumer,
    includesWasm: packed.files.some(file => file.path === 'dist/wasm/editac_wasm_bg.wasm') };
  assert.equal(facts.packed.includesWasm, true);
  await run('tar', ['-xzf', join(consumer, packed.filename), '-C', consumer], process.cwd(), 'unpack.log');
  server = await startFixtureServer({ fixtureDirectory: 'fixtures/browser-entry', coreDirectory: join(consumer, 'package/dist') });
  facts.server = { ...server, close: undefined, launcher: 'node --test tests/browser/entry.spec.ts',
    purpose: 'WEB-1.1 packed-core canonical entry', log: 'entry.log' };
  controller = await chromium.launchServer({ headless: true });
  const child = controller.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(),
    port: null, purpose: 'WEB-1.1 pinned Chromium', log: 'entry.log' });
  browser = await chromium.connect(controller.wsEndpoint());
  facts.browser = { engine: 'Chromium', version: browser.version(), playwright: '1.64.0',
    node: process.version, platform: process.platform, arch: process.arch };
});
after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (controller) {
        await controller.close();
        facts.cleanup.browserExited = controller.process().exitCode !== null || controller.process().signalCode !== null;
        assert.equal(facts.cleanup.browserExited, true);
      }
    } finally {
      try {
        if (server) {
          await server.close();
          facts.cleanup.listenerRemoved = await new Promise(resolve => {
            const socket = createConnection(server.port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(false); });
            socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
          });
          assert.equal(facts.cleanup.listenerRemoved, true);
        }
      } finally {
        if (consumer) await rm(consumer, { recursive: true, force: true });
        facts.cleanup.consumerRemoved = true;
        await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2));
      }
    }
  }
});
async function open(context) {
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForFunction(() => !!window.entry);
  return page;
}
async function withContext(name, action) {
  const context = await browser.newContext();
  const fact = { name, passed: false }; facts.cases.push(fact);
  try { await action(context, fact); fact.passed = true; }
  finally { await context.close(); }
}

test('recovery entry packed core restores checkpoint and tail before semantic edits and local flush', { timeout: 30000 }, async () => {
  await withContext('checkpoint-tail', async (context, fact) => {
    let page = await open(context);
    await page.evaluate(() => window.entry.seed());
    await page.close(); page = await open(context);
    fact.recovery = await page.evaluate(() => window.entry.activate());
    assert.equal(fact.recovery.phase, 'ready');
    assert.equal(fact.recovery.text, 'a😀b tail');
    assert.deepEqual(fact.recovery.events, ['engine-recovered', 'persistence-attached', 'ready']);
    fact.edit = await page.evaluate(() => window.entry.edit(' α😀'));
    assert.equal(fact.edit.text, 'a😀b tail α😀');
    assert.equal(fact.edit.beforeFlush.pending, 1);
    assert.equal(fact.edit.beforeFlush.saved, false);
    assert.equal(fact.edit.afterFlush.pending, 0);
    assert.equal(fact.edit.afterFlush.saved, true);
    assert.equal(fact.edit.afterFlush.localCommitted.state, 'localCommitted');
    assert.equal(fact.edit.patches.length, 1);
    assert.equal(fact.edit.patches[0].origin, 'editac:local:browser-entry');
    assert.equal(fact.edit.patches[0].changedNodes.length, 1);
    assert.equal(fact.edit.resolved.offset, 'a😀b tail α😀'.length);
    await page.evaluate(() => window.entry.destroy());
    await page.close(); page = await open(context);
    assert.equal((await page.evaluate(() => window.entry.activate())).text, 'a😀b tail α😀');
    await page.evaluate(() => window.entry.destroy());
  });
});

test('recovery entry cannot accept edits while actual WASM initialization is pending', { timeout: 30000 }, async () => {
  await withContext('pending-wasm', async (context, fact) => {
    let page = await open(context); await page.evaluate(() => window.entry.seed());
    await page.close(); page = await open(context);
    let release, requestSeen;
    const held = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { requestSeen = resolve; });
    await page.route('**/*.wasm', async route => { requestSeen(); await held; await route.continue(); });
    try {
      await page.evaluate(() => { window.activation = window.entry.activate(); });
      // Observe the actual transport boundary before asserting blocked commands.
      await requested;
      fact.actualWasmRequestHeld = true;
      await page.waitForFunction(() => window.entry.view().phase === 'recovering');
      fact.pending = await page.evaluate(async () => {
        try { await window.entry.edit('forbidden'); return { allowed: true }; }
        catch (error) { return { allowed: false, view: window.entry.view(), error: error.message }; }
      });
      assert.equal(fact.pending.allowed, false);
      assert.equal(fact.pending.view.editable, false);
      assert.deepEqual(fact.pending.view.events, []);
    } finally { release(); }
    assert.equal((await page.evaluate(() => window.activation)).phase, 'ready');
    assert.equal((await page.evaluate(() => window.entry.view())).text, 'a😀b tail');
    await page.evaluate(() => window.entry.destroy());
  });
});

for (const [name, setup, options, expected] of [
  ['missing-checkpoint', false, {}, /No valid recovery checkpoint/],
  ['missing-writer-isolation', true, { missingLocks: true }, /requires Web Locks/],
  ['missing-wasm', true, { assetUrl: '/missing.wasm' }, /fetch|WebAssembly|Response|404/i],
]) {
  test(`recovery entry ${name} leaves recovery view and rejects edits`, { timeout: 30000 }, async () => {
    await withContext(name, async (context, fact) => {
      let page = await open(context);
      if (setup) { await page.evaluate(() => window.entry.seed()); await page.close(); page = await open(context); }
      fact.failure = await page.evaluate(options => window.entry.activate(options), options);
      assert.equal(fact.failure.phase, 'failed'); assert.equal(fact.failure.editable, false);
      assert.match(fact.failure.error, expected); assert.deepEqual(fact.failure.events, []);
      assert.match(await page.locator('[role=status]').textContent(), /Recovery failed:/);
      assert.equal(await page.evaluate(async () => {
        try { await window.entry.edit('forbidden'); return true; } catch { return false; }
      }), false);
      if (setup) {
        assert.equal((await page.evaluate(() => window.entry.activate())).text, 'a😀b tail');
        await page.evaluate(() => window.entry.destroy());
      }
    });
  });
}
