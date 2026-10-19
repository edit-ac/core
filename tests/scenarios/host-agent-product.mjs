import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { prepareShell, root, defaultReceipt } from '../../examples/host-agent-product/setup.mjs';
import * as humanCases from './host-agent-product-human.mjs';
import { prepareHuman } from '../../examples/host-agent-product/human-setup.mjs';
import * as readCases from './host-agent-product-read.mjs';
import { prepareRead } from '../../examples/host-agent-product/read-setup.mjs';
import * as shellCases from './host-agent-product-shell.mjs';
import * as capabilitiesCases from './host-agent-product-capabilities.mjs';
import { prepareCapabilities } from '../../examples/host-agent-product/capabilities-setup.mjs';
import * as bridgeCases from './host-agent-product-bridge.mjs';
import { prepareBridge } from '../../examples/host-agent-product/bridge-setup.mjs';
const manifest = JSON.parse(await readFile(join(root,'fixtures/product-scenarios/host-agent-product/manifest.json')));
const group = process.argv[2];
assert.equal(process.argv.length, 3, 'Expected exactly one group');
assert.ok(Object.hasOwn(manifest.groups, group), 'Unknown group');
const completeSelection = manifest.groups[group];
const only = process.env.EDITAC_HOST_PRODUCT_ONLY;
assert.ok(only === undefined || only === 'browser', 'Unknown case subset');
assert.ok(completeSelection.modelCases.length && completeSelection.browserCases.length && completeSelection.engines.length, 'Zero-case selection');
const selection = { ...completeSelection, modelCases:only === 'browser' ? [] : completeSelection.modelCases };
const { modelCases, browserCases } = group === 'human' ? humanCases : group === 'read' ? readCases : group === 'capabilities' ? capabilitiesCases : group === 'bridge' ? bridgeCases : shellCases;
assert.ok(selection.modelCases.length + selection.browserCases.length * selection.engines.length > 0,'Zero-case selection');
const output = resolve(process.env.EDITAC_HOST_PRODUCT_OUTPUT ?? join(root,'../architecture/evidence/host-agent-product-20261019/host-workspace',selection.parent,`shell-${Date.now()}`));
await mkdir(output, { recursive: true });
const facts = { group, parent: selection.parent, scope: manifest.scope, command: [process.execPath, ...process.argv.slice(1)], output, selection:{subset:only ?? 'all',modelCases:selection.modelCases,browserCases:selection.browserCases,engines:selection.engines}, cases: [], processes: [], browsers: [] };
let server;
const checker = (engine, expected) => { let index = 0; return async (id, action) => {
  assert.equal(id, expected[index++], 'Manifest case order');
  try { await action(); facts.cases.push({ engine, id, status: 'passed' }); }
  catch (error) { facts.cases.push({ engine, id, status: 'failed', error: error.stack }); }
}; };
try {
  server = await (group === 'human' ? prepareHuman : group === 'read' ? prepareRead : group === 'capabilities' ? prepareCapabilities : group === 'bridge' ? prepareBridge : prepareShell)(output, facts, process.env.EDITAC_HOST_PRODUCT_SDK_RECEIPT ?? defaultReceipt);
  facts.processes.push({ pid: process.pid, launcher: process.execPath, workspace: root, port: server.port, purpose: 'Shell loopback fixture server', log: join(output,'receipt.json') });
  if (selection.modelCases.length) await modelCases(checker('node', selection.modelCases), { server, facts, output });
  const fixture = JSON.parse(await readFile(join(root,'fixtures/product-scenarios/host-agent-product/shell.json')));
  for (const engine of selection.engines) {
    let browser, controller; const detail = { engine }; facts.browsers.push(detail);
    try {
      controller = await ({ chromium, firefox, webkit }[engine]).launchServer({ headless: true });
      const child = controller.process(); detail.pid = child.pid;
      facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: root, purpose: `Shell ${engine}`, log: join(output,'receipt.json') });
      browser = await ({ chromium, firefox, webkit }[engine]).connect(controller.wsEndpoint());
      detail.version = browser.version();
      const page = await browser.newPage({ viewport: { width:1280, height:900 } }); page.setDefaultTimeout(10000);
      await browserCases({ page, server, check: checker(engine, selection.browserCases), fixture, facts: detail });
      await page.screenshot({ path: join(output, `${engine}.png`), fullPage: true });
    } catch (error) { detail.failure = error.stack; facts.cases.push({ engine, id: 'setup-or-teardown', status:'failed', error:error.stack }); }
    finally { try { if (browser) await browser.close(); } finally { if (controller) await controller.close(); detail.closed = true; } }
  }
} catch (error) { facts.failure = error.stack; }
finally {
  if (server) { await server.close(); facts.listenerStopped = !server.listening; facts.requests = server.requests; }
  for (const [engine, ids] of [['node',selection.modelCases], ...selection.engines.map(e => [e,selection.browserCases])]) for (const id of ids) if (!facts.cases.some(c => c.engine === engine && c.id === id)) facts.cases.push({ engine, id, status:'skipped', reason: 'Case not executed after prerequisite failure' });
  facts.counts = { executed: facts.cases.filter(c => c.status !== 'skipped').length, passed: facts.cases.filter(c => c.status === 'passed').length, failed: facts.cases.filter(c => c.status === 'failed').length, skipped: facts.cases.filter(c => c.status === 'skipped').length };
  facts.pass = !facts.failure && facts.counts.executed > 0 && facts.counts.failed === 0 && facts.counts.skipped === 0 && facts.listenerStopped === true;
  await writeFile(join(output,'receipt.json'), JSON.stringify(facts,null,2));
  console.log(JSON.stringify({ output, pass:facts.pass, ...facts.counts, failure:facts.failure, failures:facts.cases.filter(c=>c.status==='failed') }));
  if (!facts.pass) process.exitCode = 1;
}
