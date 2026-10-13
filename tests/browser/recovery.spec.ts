import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { chromium } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';

const output = process.env.EDITAC_RECOVERY_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-recovery-evidence-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [], browser: {}, server: {}, cleanup: [] };
let server, executable;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = pid => {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
before(async () => {
  // Ask the installed pinned Playwright launcher which headless executable it
  // uses; do not guess cache paths or silently substitute another revision.
  const controller = await chromium.launchServer({ headless: true });
  const child = controller.process();
  executable = child.spawnfile;
  await controller.close();
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  facts.processes.push({ pid: child.pid, launcher: executable, purpose: 'LOC-1.7 pinned executable setup',
    workspace: process.cwd(), port: null, log: 'full.log', exited: true, helpersExited: true });
  server = await startFixtureServer();
  facts.server = { pid: server.pid, port: server.port, workspace: server.workspace,
    launcher: 'node --test tests/browser/recovery.spec.ts', purpose: 'LOC-1.7 loopback fixture', log: 'full.log' };
});
after(async () => {
  if (server) {
    await server.close();
    const refused = await new Promise(resolve => {
      const socket = createConnection(server.port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
    });
    facts.server.listenerRemoved = refused;
    assert.equal(refused, true, 'task fixture listener remained after teardown');
  }
  await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2));
});

async function launch(profile, label) {
  // Direct pinned executable + CDP lets the test kill an exact OS browser PID
  // without a graceful Playwright close, while reusing a disposable disk profile.
  const logPath = join(output, `${label}-browser.log`), log = createWriteStream(logPath);
  await rm(join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(executable, ['--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ spawnError: error.message }));
  });
  const processFact = { pid: child.pid, launcher: executable, workspace: process.cwd(), profile,
    port: null, purpose: `LOC-1.7 ${label}`, log: logPath, exited: false };
  facts.processes.push(processFact);
  let browser;
  const stop = async abrupt => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const current = command(child.pid);
      assert.ok(current.includes(executable) && current.includes(`--user-data-dir=${profile}`), 'browser PID ownership changed');
      if (abrupt) child.kill('SIGKILL');
      else child.kill('SIGTERM');
    }
    let timer;
    const outcome = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Browser process failed to exit')), 10000);
    })]).finally(() => clearTimeout(timer));
    processFact.exit = outcome; processFact.exited = true;
    if (browser?.isConnected()) await browser.close();
    // The closed browser pipe should end its helpers. Only exact task-profile
    // helpers that still exist after exit are eligible for additional teardown.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
        .filter(row => row.includes(`--user-data-dir=${profile}`));
      if (!rows.length) break;
      for (const row of rows) {
        const pid = Number(row.trim().split(/\s+/)[0]);
        const current = command(pid);
        if (current.includes('--type=') && current.includes(`--user-data-dir=${profile}`)) process.kill(pid, 'SIGTERM');
      }
      await delay(50);
    }
    const remaining = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
      .filter(row => row.includes(`--user-data-dir=${profile}`));
    assert.equal(remaining.length, 0, 'task-owned browser helpers remained');
    processFact.helpersExited = true;
    log.end(); await once(log, 'finish');
    return outcome;
  };
  try {
    const deadline = Date.now() + 15000;
    let port;
    while (!port) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error(`Browser exited before CDP: ${child.exitCode}`);
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
      if (Date.now() > deadline) throw Error('No browser debugging port');
      if (!port) await delay(50);
    }
    processFact.port = port;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    facts.browser = { engine: 'Chromium', version: browser.version(), playwright: '1.64.0', executable,
      platform: process.platform, architecture: process.arch, qualifiedMechanisms: ['CDP Page.crash', 'browser PID SIGKILL'],
      exclusions: ['Firefox/WebKit', 'mobile devices', 'eviction/user deletion', 'power/hardware failure'] };
    return { browser, context: browser.contexts()[0], stop };
  } catch (error) { await stop(false); throw error; }
}
async function open(context) {
  const page = await context.newPage();
  // Reject unload registrations before any adapter initializes. Crashes do not
  // call destroy()/flush()/page.close(), so cleanup cannot satisfy the oracle.
  await page.addInitScript(() => {
    const native = EventTarget.prototype.addEventListener;
    window.unloadRegistrations = 0;
    EventTarget.prototype.addEventListener = function(type, ...args) {
      if (['unload', 'beforeunload', 'pagehide'].includes(type)) { window.unloadRegistrations++; throw Error('Unload dependency is forbidden'); }
      return native.call(this, type, ...args);
    };
    for (const name of ['onunload', 'onbeforeunload', 'onpagehide']) Object.defineProperty(window, name, {
      configurable: false, set() { window.unloadRegistrations++; throw Error('Unload dependency is forbidden'); },
    });
  });
  await page.goto(server.url);
  await page.waitForFunction(() => !!window.recovery);
  return page;
}

for (const mechanism of ['renderer-crash', 'browser-kill']) {
  for (const boundary of ['journal-ack', 'checkpoint-tail-ack', 'pre-ack-request-success']) {
    test(`recovery ${mechanism} ${boundary}`, { timeout: 60000 }, async () => {
      const label = `${mechanism}-${boundary}`, profile = await mkdtemp(join(tmpdir(), 'editac-crash-profile-'));
      const result = { name: label, passed: false, mechanism, boundary };
      facts.cases.push(result);
      let session;
      try {
        session = await launch(profile, label);
        let page = await open(session.context);
        result.initial = await page.evaluate(() => window.recovery.seed());
        assert.equal(result.initial.text, 'a😀b');
        result.committed = await page.evaluate(() => window.recovery.commit([' α', '😀', 'é']));
        const expected = 'a😀b α😀é';
        assert.equal(result.committed.text, expected);
        assert.equal(result.committed.entries.length, 3);
        assert.equal(new Set(result.committed.entries.map(e => e.updateId)).size, 3);
        for (const ack of result.committed.acknowledgments) {
          assert.equal(ack.saved, true); assert.equal(ack.pending, 0);
          assert.equal(ack.localCommitted.state, 'localCommitted');
        }
        if (boundary === 'checkpoint-tail-ack') {
          result.publication = await page.evaluate(() => window.recovery.publish());
          assert.equal(result.publication.acknowledgment.state, 'checkpointCommitted');
          result.tail = await page.evaluate(() => window.recovery.commit([' tail']));
          assert.equal(result.tail.text, expected + ' tail');
        }
        if (boundary === 'pre-ack-request-success') {
          await page.evaluate(() => window.recovery.holdBeforeCompletion(' LOST'));
          await page.waitForFunction(() => window.preAck?.requestSucceeded);
          result.preAck = await page.evaluate(() => window.preAck);
          assert.equal(result.preAck.text, expected + ' LOST');
          assert.equal(result.preAck.state.pending, 1); assert.equal(result.preAck.state.saved, false);
          assert.equal(result.preAck.state.localCommitted.updateId, result.committed.entries.at(-1).updateId);
        }
        assert.equal(await page.evaluate(() => window.unloadRegistrations), 0);
        if (mechanism === 'browser-kill') {
          result.termination = await session.stop(true); session = undefined;
          assert.equal(result.termination.signal, 'SIGKILL');
          session = await launch(profile, `${label}-reopen`);
        } else {
          const cdp = await session.context.newCDPSession(page);
          const crashed = page.waitForEvent('crash', { timeout: 10000 });
          // The crash event is the boundary. The renderer cannot reliably reply
          // to the CDP request that killed it; never wait for that reply first.
          void cdp.send('Page.crash').catch(() => {});
          await crashed;
          result.rendererCrashObserved = true;
        }
        page = await open(session.context);
        result.restored = await page.evaluate(() => window.recovery.restore());
        assert.equal(result.restored.text, expected + (boundary === 'checkpoint-tail-ack' ? ' tail' : ''));
        const acknowledged = boundary === 'checkpoint-tail-ack' ? result.tail.entries : result.committed.entries;
        assert.deepEqual(result.restored.entries, acknowledged, 'every acknowledged identity and immutable byte must survive');
        assert.notEqual(result.restored.writerId, result.initial.writerId, 'restoration must use a new live writer');
        assert.equal(result.restored.rejected.length, 0);
        assert.equal(await page.evaluate(() => window.unloadRegistrations), 0);
        if (result.preAck) {
          assert.ok(!result.restored.entries.some(e => e.updateId === result.preAck.entry.updateId));
          result.preAck.observedLoss = true;
        }
        // Recovery must remain editable, not just return a snapshot.
        result.afterRecovery = await page.evaluate(() => window.recovery.commit([' reopened']));
        assert.equal(result.afterRecovery.text, result.restored.text + ' reopened');
        result.passed = true;
      } finally {
        if (session) await session.stop(false);
        await rm(profile, { recursive: true, force: true });
        facts.cleanup.push({ profile, removed: true });
        await writeFile(join(output, `${label}.json`), JSON.stringify(result, null, 2));
      }
    });
  }
}
