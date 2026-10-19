import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Build once, then exercise the original installed-SDK browser/IndexedDB oracles.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_TABLE_BOUNDARY_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_TABLE_BOUNDARY_OUTPUT);
mkdirSync(output); // Never overwrite a prior failure or success.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
function sourcePins() {
  const listed = spawnSync('git', ['ls-files', '--', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.node-version', 'package.json', 'package-lock.json', 'tsconfig.base.json', 'crates', 'scripts', 'packages',
    'tests/browser/browser-harness.ts', 'tests/browser/editing-packed-cache.mjs', 'tests/browser/fixture-server.mjs', 'tests/browser/format-helpers.ts',
    'tests/browser/table-selection.spec.ts', 'tests/browser/table-command.spec.ts', 'tests/browser/table-command-cases.ts', 'tests/browser/table-invalidation.spec.ts',
    'tests/browser/extension-formatting.spec.ts', 'tests/browser/extension-formatting-mixed.spec.ts', 'tests/browser/source-table-format.spec.ts', 'tests/consumers/source-table-format',
    'tests/editing/fixture-loader.ts', 'fixtures/browser-content-modules', 'fixtures/browser-extension-formatting', 'fixtures/browser-input', 'fixtures/tables', 'fixtures/rich-presenters/formatting'], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  const paths = listed.stdout.trim().split('\n').filter(p => !p.startsWith('packages/') || /^packages\/(core|web|markdown|formats)\/(src\/|package.json$|tsconfig.json$)/.test(p));
  paths.push('scripts/run-web-table-boundary.mjs');
  return Object.fromEntries([...new Set(paths)].sort().map(p => [p, hash(readFileSync(p))]));
}
const sources = sourcePins();
save('source-pins.json', sources);
const execution = { task: 'WFE-3.1-C2c', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [] };
function run(name, program, args, env = {}) {
  const log = `${name}.log`, fd = openSync(join(output, log), 'wx');
  let result;
  try { result = spawnSync(program, args, { stdio: ['ignore', fd, fd], env: { ...process.env, ...env } }); }
  finally { closeSync(fd); }
  const record = { program, args, log, exit: result.status, signal: result.signal,
    error: result.error?.message, sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(record); save('execution.json', execution);
  console.log(`${name}: exit ${record.exit}; ${join(output, log)}`);
  assert.equal(result.error, undefined, name);
  assert.equal(record.signal, null, name);
  assert.equal(record.exit, 0, name);
}
for (const script of ['build:wasm', 'build:wasm:markdown', 'build']) run(script.replaceAll(':', '-'), 'npm', ['run', script]);
const packages = {};
for (const name of ['core', 'web', 'markdown']) {
  run(`pack-${name}`, 'npm', ['pack', '--offline', '--ignore-scripts', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', output]);
  const manifest = JSON.parse(readFileSync(join(output, `pack-${name}.log`)))[0];
  const path = join(output, manifest.filename);
  packages[name] = { path, sha256: hash(readFileSync(path)), manifest };
}
save('packages.json', packages);
const totals = [];
for (const suite of ['table-selection', 'table-command', 'table-invalidation', 'extension-formatting', 'source-table-format']) {
  const key = `EDITAC_${suite.toUpperCase().replaceAll('-', '_')}_OUTPUT`;
  run(suite, process.execPath, ['scripts/test-browser.mjs', suite], {
    EDITAC_EDITING_PACKS: join(output, 'packages.json'), [key]: join(output, suite), EDITAC_EDITING_ALL_OUTPUT: output,
  });
  totals.push(tapCounts(readFileSync(join(output, `${suite}.log`), 'utf8')));
}
const counts = Object.fromEntries(Object.keys(totals[0]).map(key => [key, totals.reduce((n, c) => n + c[key], 0)]));
assert.ok(counts.executed > 0);
assert.equal(counts.passed, counts.executed);
for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key], 0, key);
assert.deepEqual(sourcePins(), sources, 'Sources changed during proof');
const receipts = walk(output).filter(path => path.endsWith('/receipt.json')).map(path => {
  const receipt = JSON.parse(readFileSync(path));
  assert.ok(receipt.counts.executed > 0);
  assert.equal(receipt.counts.executed, receipt.counts.passed);
  assert.equal(receipt.counts.failed, 0); assert.equal(receipt.counts.skipped, 0);
  assert.equal(receipt.sourcesUnchanged, true);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true, key);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  return { path, sha256: hash(readFileSync(path)), engine: receipt.engine, suite: receipt.suite,
    counts: receipt.counts, cases: receipt.cases.map(c => c.name) };
});
assert.equal(receipts.length, 18, 'Six original suites in three engines');
assert.equal(receipts.reduce((n, r) => n + r.counts.executed, 0), counts.executed);
execution.finished = new Date().toISOString(); execution.counts = counts;
execution.receipts = receipts; execution.sourcesUnchanged = true;
save('execution.json', execution);
console.log(JSON.stringify({ counts, receipts: receipts.length, sourcePins: Object.keys(sources).length }));
