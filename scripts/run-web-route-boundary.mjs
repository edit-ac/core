import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareProductSite } from '../examples/task-editor/product.mjs';
import { loadScenario } from '../tests/scenarios/run.mjs';
import { sha } from '../tests/scenarios/harness.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose the original product route contract against one real installed SDK.
// Preparation is input evidence only; every route assertion executes afresh.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_ROUTE_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_ROUTE_OUTPUT);
await mkdir(output); // Never overwrite a prior failed or successful boundary.
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const { scenario } = await loadScenario('web-react-routes');
const execution = { task: 'WFE-3.1-C4h', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  node: process.version, started: new Date().toISOString(), commands: [], receipts: [] };
const prepared = { output: join(output, 'prepared'), commands: [], purpose: 'Current installed SDK route boundary' };
try {
  // Keep the existing SDK/WASM/React compiler, installed consumer and asset graph.
  await prepareProductSite(prepared.output, prepared);
  const originalProof = (await json('fixtures/product-scenarios/web/features.json')).proofs.find(p => p.id === 'pwe-1.5');
  const runtime = await json('../architecture/evidence/web-feature-first-20261018/wfe-3.1/c2c-tables/runtime-source-pins.json');
  const sources = Object.fromEntries(prepared.sources.map(p => [p.path, p.sha256]));
  for (const [path, expected] of Object.entries(runtime)) {
    assert.equal(sha(await readFile(path)), expected, 'Changed current SDK input: ' + path);
    sources[path] = expected;
  }
  for (const path of ['scripts/run-web-route-boundary.mjs', 'examples/task-editor/product.mjs']) sources[path] = sha(await readFile(path));
  await save('source-pins.json', sources);
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const originalPin = originalProof.receipts.find(p => p.path.includes('/' + engine + '/web-react-routes/'));
    assert.ok(originalPin);
    const originalBytes = await readFile(originalPin.path), original = JSON.parse(originalBytes);
    assert.equal(sha(originalBytes), originalPin.sha256);
    assert.equal(original.exit, 0);
    assert.deepEqual(original.cases.map(c => c.id), scenario.cases, 'Original route coverage changed');
    for (const path of [...scenario.fixtures, scenario.command[1]]) {
      assert.equal(sources[path], original.sources.find(p => p.path === path)?.sha256, 'Original fixture/assertions changed: ' + path);
    }
    const child = join(output, engine), log = engine + '.log', fd = openSync(join(output, log), 'wx');
    let result;
    try {
      result = spawnSync(process.execPath, ['tests/scenarios/run.mjs', 'web-react-routes'], {
        stdio: ['ignore', fd, fd], timeout: 180000,
        env: { ...process.env, EDITAC_PRODUCT_SITE_RECEIPT: join(prepared.output, 'prepared.json'),
          EDITAC_PRODUCT_BROWSER: engine, EDITAC_PRODUCT_CASE_OUTPUT: child },
      });
    } finally { closeSync(fd); }
    execution.commands.push({ program: process.execPath, args: ['tests/scenarios/run.mjs', 'web-react-routes'],
      engine, exit: result.status, signal: result.signal, error: result.error?.message, log, sha256: sha(await readFile(join(output, log))) });
    await save('execution.json', execution);
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
    const path = join(child, 'receipt.json'), bytes = await readFile(path), receipt = JSON.parse(bytes);
    assert.equal(receipt.exit, 0); assert.equal(receipt.counts.executed, scenario.cases.length);
    assert.equal(receipt.counts.passed, scenario.cases.length);
    for (const key of ['failed', 'skipped']) assert.equal(receipt.counts[key], 0);
    assert.deepEqual(receipt.cases, original.cases);
    assert.ok(receipt.teardown.includes('fixture listener closed'));
    execution.receipts.push({ path, sha256: sha(bytes), engine, counts: receipt.counts, original: originalPin });
    console.log(JSON.stringify({ engine, ...receipt.counts }));
  }
  for (const [path, expected] of Object.entries(sources)) assert.equal(sha(await readFile(path)), expected, 'Input changed during execution: ' + path);
  execution.counts = { executed: execution.receipts.reduce((n, r) => n + r.counts.executed, 0),
    passed: execution.receipts.reduce((n, r) => n + r.counts.passed, 0), failed: 0, skipped: 0 };
  execution.exit = 0;
} catch (error) {
  execution.failure = error.stack; execution.exit = 1; process.exitCode = 1;
} finally {
  execution.finished = new Date().toISOString();
  await save('execution.json', execution);
  console.log(JSON.stringify({ output, counts: execution.counts, exit: execution.exit, failure: execution.failure?.split('\n').slice(0, 3) }));
}
