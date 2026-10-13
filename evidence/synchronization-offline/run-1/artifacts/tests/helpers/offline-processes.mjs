import assert from 'node:assert/strict';
import { spawn, fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = pid => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {encoding:'utf8'}).trim(); } catch { return ''; } };
export function deadline(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), ms); })]).finally(() => clearTimeout(timer));
}
export async function processHarness(output, facts) {
  const controller = await chromium.launchServer({headless:true});
  const setup = controller.process(), executable = setup.spawnfile;
  await controller.close();
  assert.notEqual(setup.exitCode ?? setup.signalCode, null);
  facts.processes.push({pid:setup.pid, launcher:executable, workspace:process.cwd(), purpose:'pinned Chromium executable discovery', port:null, log:'feature.log', exited:true, helpersExited:true});
  const live = new Set();
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
    port: null, purpose: `SYN-1.7 ${label}`, log: logPath, exited: false };
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

  async function browser(profile, label) {
    const value = await launch(profile, label), stop = value.stop;
    let stopped;
    value.stop = abrupt => stopped ??= stop(abrupt).then(outcome => { live.delete(value); return outcome; });
    live.add(value); return value;
  }
  async function relay(databasePath, grants, label) {
    const logPath = join(output, label + '-relay.log'), log = createWriteStream(logPath);
    const child = fork(new URL('./relay-worker.mjs', import.meta.url), [], {stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.pipe(log, {end:false}); child.stderr.pipe(log, {end:false});
    const inbox = [], waiters = [];
    child.on('message', m => { const i = waiters.findIndex(w => w.type === m.type || m.type === 'error');
      if (i < 0) inbox.push(m); else { const w = waiters.splice(i,1)[0]; m.type === 'error' ? w.reject(Error(m.error)) : w.resolve(m); } });
    const exited = once(child, 'exit').then(async ([code,signal]) => { log.end(); await once(log,'finish'); return {code,signal}; });
    function wait(type) { const i = inbox.findIndex(m => m.type === type || m.type === 'error');
      if (i >= 0) { const m = inbox.splice(i,1)[0]; return m.type === 'error' ? Promise.reject(Error(m.error)) : Promise.resolve(m); }
      return deadline(new Promise((resolve,reject) => waiters.push({type,resolve,reject})), 'relay ' + type); }
    const fact = {pid:child.pid, launcher:process.execPath, workspace:process.cwd(), purpose:'SYN-1.7 ' + label, databasePath, log:logPath, exited:false};
    facts.processes.push(fact);
    const value = {wait, child, async arm(boundary) { child.send({type:'arm',fault:{boundary,action:'pause'}}); await wait('armed'); },
      async stop(crash = false) {
        if (child.exitCode === null && child.signalCode === null) {
          assert.ok(command(child.pid).includes('tests/helpers/relay-worker.mjs'), 'relay PID ownership changed');
          if (crash) child.kill('SIGKILL'); else child.send({type:'stop'});
        }
        fact.exit = await deadline(exited,'relay exit'); fact.exited = true;
        if (crash) assert.equal(fact.exit.signal,'SIGKILL'); else assert.equal(fact.exit.code,0);
        await assert.rejects(fetch(value.url + '/session',{signal:AbortSignal.timeout(1000)}));
        fact.listenerRemoved = true; live.delete(value);
      }};
    live.add(value);
    child.send({type:'start',options:{databasePath,grants}});
    const ready = await wait('ready'); value.url = ready.url; fact.port = new URL(ready.url).port;
    return value;
  }
  return {browser, relay, async close() { for (const value of [...live]) await value.stop(false); }};
}
