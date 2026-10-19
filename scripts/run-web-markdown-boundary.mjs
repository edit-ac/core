import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareMarkdownProductSite } from '../examples/task-editor/product-markdown.mjs';
import { sha } from '../tests/scenarios/harness.mjs';
import { requireTestNode } from './test-toolchain.mjs';
import { tapCounts, walk } from './editing-coverage.mjs';
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_MARKDOWN_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_MARKDOWN_OUTPUT); await mkdir(output);
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const suites = ['optional-markdown', 'markdown-paste', 'markdown-extensions'];
const expected = { 'optional-markdown': 6, 'markdown-paste': 7, 'markdown-extensions': 6 };
const execution = { task: 'WFE-3.1-C4i', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  node: process.version, started: new Date().toISOString(), commands: [], receipts: [], failures: [] };
const current = resolve(process.env.EDITAC_WEB_MARKDOWN_BUILD ?? '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-8');
const runtime = await json(join(current, 'runtime-source-pins.json'));
const runtimeMembers = await json(join(current, 'package-runtime-pins.json'));
const priorOutput = process.env.EDITAC_WEB_MARKDOWN_RESUME && resolve(process.env.EDITAC_WEB_MARKDOWN_RESUME);
const prior = priorOutput && await json(join(priorOutput, 'execution.json'));
const priorSources = priorOutput && await json(join(priorOutput, 'source-pins.json'));
try {
  for (const [path, hash] of Object.entries(runtime)) assert.equal(sha(await readFile(path)), hash, 'Changed SDK source: ' + path);
  for (const [path, hash] of Object.entries(runtimeMembers)) assert.equal(sha(await readFile(path)), hash, 'Changed SDK package member: ' + path);
  execution.runtimeAdmission = { directory: current, sources: Object.keys(runtime).length, members: Object.keys(runtimeMembers).length };
  let prepared;
  if (process.env.EDITAC_PRODUCT_SITE_RECEIPT) {
    const path = resolve(process.env.EDITAC_PRODUCT_SITE_RECEIPT); prepared = await json(path);
    assert.equal(prepared.prepared, true); assert.equal(prepared.optionalMarkdown.installed, true);
    for (const p of prepared.sources) assert.equal(sha(await readFile(p.path)), p.sha256, 'Changed prepared source: ' + p.path);
    for (const p of prepared.artifacts) assert.equal(sha(await readFile(join(prepared.output, p.path))), p.sha256, 'Changed prepared artifact');
    execution.preparedReuse = { path, sha256: sha(await readFile(path)) };
  } else {
    prepared = { output: join(output, 'prepared'), commands: [], purpose: 'Current installed opt-in Markdown product' };
    await prepareMarkdownProductSite(prepared.output, prepared);
  }
  execution.prepared = { path: join(prepared.output, 'prepared.json'), sha256: sha(await readFile(join(prepared.output, 'prepared.json'))) };
  const sources = { ...runtime, ...Object.fromEntries(prepared.sources.map(p => [p.path, p.sha256])) };
  for (const path of ['scripts/run-web-markdown-boundary.mjs', 'tests/scenarios/markdown.mjs', 'tests/browser/browser-harness.ts',
    'tests/browser/editing-packed-cache.mjs', 'tests/browser/format-helpers.ts', 'scripts/test-browser.mjs', ...suites.map(s => `tests/browser/${s}.spec.ts`), ...walk('fixtures/browser-input')]) sources[path] = sha(await readFile(path));
  await save('source-pins.json', sources);
  const packages = {};
  for (const name of ['core', 'web', 'markdown']) {
    const manifestPath = name !== 'markdown' && prepared.reusedPackageReceipt
      ? join(dirname(prepared.reusedPackageReceipt.path), 'pack-' + name + '.log')
      : join(prepared.output, 'pack-' + name + '.log');
    const [manifest] = await json(manifestPath);
    assert.equal(manifest.name, '@edit-ac/' + name);
    const pin = prepared.packs.find(p => p.name === name), path = join(prepared.output, pin.file);
    assert.equal(sha(await readFile(path)), pin.sha256);
    packages[name] = { path, sha256: pin.sha256, manifest };
  }
  await save('packages.json', packages);
  async function run(label, args, env) {
    const log = label + '.log', fd = openSync(join(output, log), 'wx'); let result;
    try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 300000, env: { ...process.env, ...env } }); }
    finally { closeSync(fd); }
    const command = { program: process.execPath, args, log, exit: result.status, signal: result.signal,
      error: result.error?.message, sha256: sha(await readFile(join(output, log))) };
    execution.commands.push(command); await save('execution.json', execution);
    return command;
  }
  for (const suite of suites) {
    let reusable = prior?.commands.find(c => c.args?.[1] === suite && c.exit === 0 && !c.signal && !c.error);
    if (reusable) {
      try {
        assert.equal(sha(await readFile(join(priorOutput, reusable.log))), reusable.sha256);
        for (const path of [...Object.keys(runtime), ...walk('fixtures/browser-input')]) assert.equal(priorSources[path], sources[path]);
        for (const engine of ['chromium', 'firefox', 'webkit']) {
          const r = await json(join(priorOutput, suite, engine, 'receipt.json'));
          assert.equal(r.counts.executed, expected[suite]); assert.equal(r.counts.passed, expected[suite]);
          assert.equal(r.counts.failed, 0); assert.equal(r.counts.skipped, 0);
          for (const [path, hash] of Object.entries(r.sources)) assert.equal(sha(await readFile(path)), hash);
          for (const p of r.packs) assert.equal(p.sha256, packages[p.name].sha256);
        }
      } catch { reusable = undefined; }
    }
    const command = reusable ? { ...reusable, log: join(priorOutput, reusable.log), reused: true,
      reuseScope: 'Exact runtime, original fixture/assertion and installed package bytes; prior CLI and TAP succeeded' } : await run(suite, ['scripts/test-browser.mjs', suite], {
      EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: output,
      ['EDITAC_' + suite.toUpperCase().replaceAll('-', '_') + '_OUTPUT']: join(output, suite),
    });
    try {
      assert.equal(command.exit, 0); assert.equal(command.signal, null); assert.equal(command.error, undefined);
      if (reusable) execution.commands.push(command);
      const counts = tapCounts(await readFile(resolve(output, command.log), 'utf8'));
      assert.equal(counts.executed, expected[suite] * 3); assert.equal(counts.passed, counts.executed);
      for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key], 0);
      for (const engine of ['chromium', 'firefox', 'webkit']) {
        const path = join(reusable ? priorOutput : output, suite, engine, 'receipt.json'), bytes = await readFile(path), receipt = JSON.parse(bytes);
        assert.equal(receipt.counts.executed, expected[suite]); assert.equal(receipt.counts.passed, expected[suite]);
        assert.equal(receipt.counts.failed, 0); assert.equal(receipt.counts.skipped, 0); assert.notEqual(receipt.sourcesUnchanged, false);
        for (const [path, hash] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(path)), hash);
        for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
        for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
        execution.receipts.push({ path, sha256: sha(bytes), engine, suite, counts: receipt.counts, reused: Boolean(reusable) });
      }
    } catch (error) { execution.failures.push({ suite, failure: error.stack }); }
    await save('execution.json', execution);
  }
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const label = 'product-' + engine, path = join(output, label, 'receipt.json');
    const command = await run(label, ['tests/scenarios/markdown.mjs'], {
      EDITAC_PRODUCT_SITE_RECEIPT: execution.prepared.path, EDITAC_PRODUCT_BROWSER: engine, EDITAC_PRODUCT_CASE_OUTPUT: join(output, label),
    });
    try {
      assert.equal(command.exit, 0); assert.equal(command.signal, null); assert.equal(command.error, undefined);
      const bytes = await readFile(path), receipt = JSON.parse(bytes);
      assert.equal(receipt.exit, 0); assert.equal(receipt.counts.executed, 5); assert.equal(receipt.counts.passed, 5);
      assert.equal(receipt.counts.failed, 0); assert.equal(receipt.counts.skipped, 0); assert.equal(receipt.sourcesUnchanged, true);
      for (const source of receipt.sources) assert.equal(sha(await readFile(source.path)), source.sha256);
      for (const name of ['browser connection', 'browser controller', 'fixture listener']) assert.ok(receipt.teardown.includes(name + ' closed'));
      execution.receipts.push({ path, sha256: sha(bytes), engine, suite: 'web-markdown', counts: receipt.counts });
    } catch (error) { execution.failures.push({ suite: label, failure: error.stack }); }
    await save('execution.json', execution);
  }
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const label = 'routes-' + engine;
    const command = await run(label, ['tests/scenarios/run.mjs', 'web-react-routes'], {
      EDITAC_PRODUCT_SITE_RECEIPT: execution.prepared.path, EDITAC_PRODUCT_BROWSER: engine, EDITAC_PRODUCT_CASE_OUTPUT: join(output, label),
    });
    try {
      assert.equal(command.exit, 0); assert.equal(command.signal, null); assert.equal(command.error, undefined);
      const path = join(output, label, 'receipt.json'), bytes = await readFile(path), receipt = JSON.parse(bytes);
      assert.equal(receipt.exit, 0); assert.equal(receipt.counts.executed, 11); assert.equal(receipt.counts.passed, 11);
      assert.equal(receipt.counts.failed, 0); assert.equal(receipt.counts.skipped, 0);
      execution.receipts.push({ path, sha256: sha(bytes), engine, suite: 'web-react-routes', counts: receipt.counts });
    } catch (error) { execution.failures.push({ suite: label, failure: error.stack }); }
    await save('execution.json', execution);
  }
  for (const [path, hash] of Object.entries(sources)) assert.equal(sha(await readFile(path)), hash, 'Source changed during execution: ' + path);
  execution.counts = { executed: execution.receipts.reduce((n, r) => n + r.counts.executed, 0),
    passed: execution.receipts.reduce((n, r) => n + r.counts.passed, 0), failed: execution.failures.length, skipped: 0 };
  execution.observedCounts = { executed: 0, passed: 0, failed: 0, skipped: 0 };
  for (const suite of suites) for (const engine of ['chromium', 'firefox', 'webkit']) {
    const p = execution.receipts.find(r => r.suite === suite && r.engine === engine)?.path ?? join(output, suite, engine, 'receipt.json');
    try { const r = await json(p); for (const key of Object.keys(execution.observedCounts)) execution.observedCounts[key] += r.counts[key]; } catch { /* Absent preparation is recorded by the command/failure, never counted as passed. */ }
  }
  for (const suite of ['product', 'routes']) for (const engine of ['chromium', 'firefox', 'webkit']) {
    try { const r = await json(join(output, suite + '-' + engine, 'receipt.json')); for (const key of Object.keys(execution.observedCounts)) execution.observedCounts[key] += r.counts[key]; } catch { /* See saved failing command. */ }
  }
  execution.exit = execution.failures.length ? 1 : 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; }
finally {
  execution.finished = new Date().toISOString(); await save('execution.json', execution);
  console.log(JSON.stringify({ output, counts: execution.counts, exit: execution.exit, failure: execution.failure?.split('\n').slice(0, 3), failures: execution.failures.map(f => f.suite) }));
  process.exitCode = execution.exit;
}
