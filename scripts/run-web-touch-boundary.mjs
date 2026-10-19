import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts } from './editing-coverage.mjs';
import { portableGroups, catalogRows, portableCases, assertCounts } from '../tests/mobile-web/catalog.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Full original portable assertions against authenticated current packed SDK.
// Real middleware, Session/WASM and IndexedDB; no historical outcome reuse.
await requireTestNode();
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_TOUCH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_TOUCH_OUTPUT); mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const verify = sources => { assert.ok(Object.keys(sources).length); for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, 'Changed source: ' + path); };
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const originalProof = json('fixtures/product-scenarios/web/features.json').proofs.find(p => p.id === 'wfe-2.2');
const mapping = json('tests/mobile-web/portable-cases.json');
const execution = { task: 'WFE-3.1-C4j', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  feature: 'WEB-TOUCH', started: new Date().toISOString(), node: process.version, commands: [], receipts: [], failures: [] };
try {
  const current = resolve(process.env.EDITAC_WEB_TOUCH_BUILD ?? join(base, 'c4o-9'));
  const runtime = json(join(current, 'runtime-source-pins.json'));
  const members = json(join(current, 'package-runtime-pins.json'));
  verify(runtime); verify(members);
  const catalog = json(join(current, 'run-1/packages.json'));
  const packages = Object.fromEntries(['core', 'web', 'markdown'].map(name => [name, catalog[name]]));
  for (const pack of Object.values(packages)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
  execution.runtimeAdmission = { directory: current, sources: Object.keys(runtime).length, members: Object.keys(members).length };
  save('packages.json', packages); save('package-runtime-pins.json', members);
  const original = originalProof.receipts.map(p => {
    assert.equal(hash(readFileSync(p.path)), p.sha256);
    const r = json(p.path), testFile = Object.keys(r.sources).find(s => /^tests\/mobile-web\/.*\.spec\.ts$/.test(s));
    const group = testFile.split('/').pop().replace('.spec.ts', '');
    assert.ok(portableGroups.includes(group)); assertCounts(r.counts);
    assert.equal(r.sourcesUnchanged, true);
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(r.cleanup[key], true);
    const dispatch = json(join(dirname(p.path), 'dispatch-receipt.json'));
    assertCounts(dispatch.counts); assert.equal(dispatch.browserReceiptSha256, p.sha256);
    assert.deepEqual(dispatch.browserCounts, r.counts);
    const tap = join(dirname(p.path), 'tests.tap');
    const counts = tapCounts(readFileSync(tap, 'utf8'));
    for (const key of ['executed', 'passed', 'failed', 'skipped', 'cancelled']) assert.equal(counts[key], dispatch.counts[key]);
    for (const pack of r.packs) assert.equal(hash(readFileSync(join(dirname(p.path), pack.file))), pack.sha256);
    return { ...p, ...pin(p.path), engine: r.engine, group, receipt: r, dispatch, tap: pin(tap) };
  });
  assert.equal(original.length, portableGroups.length * 3);
  assert.equal(new Set(original.map(r => r.engine + '/' + r.group)).size, original.length);
  const sources = { ...runtime, ...members };
  for (const entry of original) for (const path of Object.keys(entry.receipt.sources)) sources[path] = hash(readFileSync(path));
  for (const path of ['scripts/run-web-touch-boundary.mjs', 'tests/mobile-web/portable-cases.json']) sources[path] = hash(readFileSync(path));
  save('source-pins.json', sources);
  for (const entry of original) {
    const { group, engine } = entry;
    const child = join(output, engine, group), log = `${engine}-${group}.log`, fd = openSync(join(output, log), 'wx'); let result;
    try { result = spawnSync(process.execPath, ['scripts/test-mobile-web.mjs', '--group', group], {
      stdio: ['ignore', fd, fd], timeout: 180000, env: { ...process.env,
        EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_MOBILE_HARNESS_OUTPUT: child, EDITAC_MOBILE_HARNESS_BROWSER: engine },
    }); } finally { closeSync(fd); }
    const command = { program: process.execPath, args: ['scripts/test-mobile-web.mjs', '--group', group], engine,
      exit: result.status, signal: result.signal, error: result.error?.message, log, sha256: hash(readFileSync(join(output, log))) };
    execution.commands.push(command); save('execution.json', execution);
    try {
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
      const path = join(child, 'receipt.json'), receipt = json(path), dispatch = json(join(child, 'dispatch-receipt.json'));
      assertCounts(receipt.counts); assertCounts(dispatch.counts); verify(receipt.sources);
      assert.equal(receipt.sourcesUnchanged, true);
      for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
      for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
      assert.deepEqual(receipt.cases.map(c => c.name), entry.receipt.cases.map(c => c.name), 'Original portable case coverage changed');
      execution.receipts.push({ ...pin(path), group, engine, reused: false, counts: receipt.counts,
        dispatcherCounts: dispatch.counts, original: pin(entry.path), tap: pin(join(child, 'tests.tap')) });
    } catch (error) { execution.failures.push({ group, engine, error: error.stack }); }
    save('execution.json', execution);
  }
  assert.equal(execution.failures.length, 0, 'Retained original portable-group failures');
  assert.equal(execution.receipts.length, original.length);
  const caseMapping = {};
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    caseMapping[engine] = portableGroups.flatMap(group => {
      const r = execution.receipts.find(r => r.engine === engine && r.group === group);
      return portableCases(catalogRows().filter(row => row.group === group), mapping, json(r.path).cases);
    });
    assert.equal(caseMapping[engine].length, 54);
  }
  save('case-mapping.json', caseMapping);
  const totals = entries => entries.reduce((sum, r) => {
    for (const key of ['executed', 'passed', 'failed', 'skipped']) sum[key] += r.counts[key]; return sum;
  }, { executed: 0, passed: 0, failed: 0, skipped: 0 });
  execution.counts = totals(execution.receipts); assert.equal(execution.counts.executed, 726); assertCounts(execution.counts);
  execution.freshCounts = totals(execution.receipts.filter(r => !r.reused));
  execution.reusedCounts = totals(execution.receipts.filter(r => r.reused));
  execution.dispatcherCounts = totals(execution.receipts.map(r => ({ counts: r.dispatcherCounts })));
  assert.equal(execution.dispatcherCounts.executed, 759); assertCounts(execution.dispatcherCounts);
  verify(sources); verify(members); execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, counts: execution.counts, fresh: execution.freshCounts, reused: execution.reusedCounts,
    exit: execution.exit, failure: execution.failure?.split('\n').slice(0, 3) })); }
