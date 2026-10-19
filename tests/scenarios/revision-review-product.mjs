import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { startFixtureServer } from '../browser/fixture-server.mjs';
import { root, loadScenario } from './run.mjs';
import { sha } from './harness.mjs';
import { manifestPath, prepareRevisionProduct } from '../../examples/task-editor/revision-review-product.mjs';
import { scopeCases } from './revision-review-scope.mjs';
import { conflictCases } from './revision-review-conflicts.mjs';
import { reopenCases } from './revision-review-reopen.mjs';
import { restoreCases } from './revision-review-restore.mjs';
import { compareCases } from './revision-review-compare.mjs';
import { captureCases } from './revision-review-capture.mjs';

await requireTestNode();
const group = process.argv[2];
assert.equal(process.argv.length, 3, 'Expected exactly one named group');
const { scenario, manifest } = await loadScenario(group, manifestPath);
const fromCase = process.env.EDITAC_REVISION_FROM_CASE;
if (fromCase) {
  assert.equal(group, 'conflicts', 'Only independent conflict fixtures support a bounded repair suffix');
  assert.ok(scenario.cases.includes(fromCase), 'Unknown repair suffix');
}
const selectedCases = scenario.cases.slice(fromCase ? scenario.cases.indexOf(fromCase) : 0);
const output = resolve(process.env.EDITAC_REVISION_OUTPUT ?? join(root, '../architecture/evidence/revision-review-product-20261019', scenario.parent.toLowerCase(), new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(output, { recursive: true });
const facts = { selection: { fromCase: fromCase ?? null, selectedCases, notSelected: scenario.cases.filter(id => !selectedCases.includes(id)), scope: 'Unselected cases are not executed and supply no passing evidence from this receipt' }, output, parent: scenario.parent, group, command: ['node', 'tests/scenarios/revision-review-product.mjs', group], scope: manifest.scope, commands: [], cases: [], processes: [], browsers: [] };
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
};
let server;
try {
  // Authenticate the named public recipe in committed main and this lane; no private imports.
  const paths = ['packages/core/src/index.ts', 'packages/core/src/engine.ts', 'packages/web/src/index.ts', 'packages/web/src/storage/owner.ts', 'packages/web/src/surface.ts', 'packages/web/src/review/history.ts', 'packages/web/src/review/model.ts', 'packages/web/src/review/view.ts', 'examples/task-editor/document.mjs'];
  facts.entry = { main: git('rev-parse', 'main').trim(), lane: git('rev-parse', 'HEAD').trim(), publicInputs: [] };
  for (const path of paths) {
    const lane = git('show', 'HEAD:' + path), main = git('show', 'main:' + path);
    assert.equal(lane, main, 'Public recipe changed on main: ' + path);
    assert.equal(await readFile(join(root, path), 'utf8'), lane, 'Dirty shared recipe: ' + path);
    facts.entry.publicInputs.push({ path, sha256: sha(lane), equalMainAndLane: true });
  }
  const { site } = await prepareRevisionProduct(output, facts, group);
  server = await startFixtureServer({ fixtureDirectory: join(site, 'fixture'), coreDirectory: join(site, 'core'), webDirectory: join(site, 'web'), recordRequests: true });
  facts.processes.push({ pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: `${scenario.parent} installed ${group} product`, log: join(output, 'receipt.json') });
  for (const engine of scenario.engines) {
    const directory = join(output, engine); await mkdir(directory);
    let controller, browser, page;
    const errors = [], browserFacts = { engine, oracles: {} };
    facts.browsers.push(browserFacts);
    let enumerated = 0;
    const check = async (id, action) => {
      assert.equal(id, scenario.cases[enumerated++], 'Case order mismatch');
      if (!selectedCases.includes(id)) return;
      try { await action(); facts.cases.push({ engine, id, status: 'passed' }); console.log(`PASS ${engine} ${id}`); }
      catch (error) { facts.cases.push({ engine, id, status: 'failed', error: error.stack }); throw error; }
    };
    try {
      controller = await ({ chromium, firefox, webkit }[engine]).launchServer({ headless: true });
      const pid = controller.process().pid;
      facts.processes.push({ pid, launcher: controller.process().spawnfile, workspace: root, purpose: `${scenario.parent} ${engine}`, log: join(directory, 'browser.json') });
      browser = await ({ chromium, firefox, webkit }[engine]).connect(controller.wsEndpoint());
      browserFacts.version = browser.version(); page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      await ({ capture: captureCases, scope: scopeCases, compare: compareCases, restore: restoreCases, conflicts: conflictCases, reopen: reopenCases }[group])({ page, server, facts: browserFacts, check, output: directory });
      assert.deepEqual(errors, [], 'Unhandled browser errors');
    } catch (error) {
      browserFacts.failure = error.stack;
      if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
      if (!facts.cases.some(c => c.engine === engine && c.status === 'failed')) facts.cases.push({ engine, id: 'browser-setup-or-teardown', status: 'failed', error: error.stack });
      for (const id of selectedCases) if (!facts.cases.some(c => c.engine === engine && c.id === id)) facts.cases.push({ engine, id, status: 'skipped', reason: 'Earlier boundary failure; no pass claimed' });
      console.error(`FAIL ${engine}: ${error.message}`);
    } finally {
      if (browser) await browser.close(); if (controller) await controller.close();
      browserFacts.errors = errors; browserFacts.closed = true;
      await writeFile(join(directory, 'browser.json'), JSON.stringify(browserFacts, null, 2));
    }
  }
} catch (error) { facts.failure = error.stack; console.error(error.message); }
finally {
  if (server) { await server.close(); facts.listenerStopped = !server.listening; facts.requests = server.requests; }
  facts.counts = { executed: facts.cases.filter(c => c.status !== 'skipped').length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: facts.cases.filter(c => c.status === 'skipped').length };
  facts.expected = selectedCases.length * scenario.engines.length;
  facts.exit = !facts.failure && facts.counts.passed === facts.expected && facts.counts.failed === 0 && facts.counts.skipped === 0 ? 0 : 1;
  await writeFile(join(output, 'receipt.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ output, counts: facts.counts, expected: facts.expected, exit: facts.exit }));
  process.exitCode = facts.exit;
}
