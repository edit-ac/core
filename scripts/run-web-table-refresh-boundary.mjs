import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Refresh the original table boundary with current installed SDK archives.
// Keep historical runners/receipts immutable and reuse only exact-input rich proof.
await requireTestNode();
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_TABLE_REFRESH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_TABLE_REFRESH_OUTPUT);
mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const verify = sources => {
  assert.ok(Object.keys(sources).length);
  for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, 'Changed input: ' + path);
};
const countsOK = counts => {
  assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key] ?? 0, 0, key);
};
const engines = ['chromium', 'firefox', 'webkit'];
const suites = ['table-selection', 'table-command', 'table-invalidation', 'source-table-format'];
const expected = { 'table-selection': 26, 'table-command': 16, 'table-invalidation': 9, 'source-table-format': 8 };
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const execution = { task: 'WFE-3.1-C2c-REFRESH', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  feature: 'WEB-TABLES', node: process.version, npm: '11.17.0', started: new Date().toISOString(),
  commands: [], receipts: [], reusedReceipts: [], failures: [] };
try {
  const current = join(base, 'c4o-12');
  const runtime = json(join(current, 'runtime-source-pins.json'));
  const members = json(join(current, 'package-runtime-pins.json'));
  verify(runtime); verify(members);
  const packages = json(join(current, 'run-3/packages.json'));
  assert.deepEqual(Object.keys(packages).sort(), ['core', 'markdown', 'web']);
  for (const [name, pack] of Object.entries(packages)) {
    assert.equal(hash(readFileSync(pack.path)), pack.sha256);
    assert.equal(pack.manifest.name, '@edit-ac/' + name);
  }
  const fd = openSync(join(output, 'archive-preflight.log'), 'wx'); let archive;
  try { archive = spawnSync('python3', ['-c', `import json,sys,tarfile,pathlib,hashlib
packages,members=json.load(sys.stdin); actual={}
for name,pack in packages.items():
 with tarfile.open(pack['path']) as tar:
  for m in tar.getmembers():
   if m.isfile() and m.name.startswith('package/dist/'):
    p='packages/'+name+'/'+m.name.removeprefix('package/')
    h=hashlib.sha256(tar.extractfile(m).read()).hexdigest()
    assert hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h,p
    actual[p]=h
assert actual==members
print(json.dumps({'packages':len(packages),'matchedRuntimeMembers':len(actual)}))`],
    { input: JSON.stringify([packages, members]), stdio: ['pipe', fd, fd] });
  } finally { closeSync(fd); }
  assert.equal(archive.status, 0, 'Archive preflight; see archive-preflight.log');
  save('packages.json', packages); save('package-runtime-pins.json', members);
  const oldBinding = json(join(base, 'c2c-tables/binding.json'));
  const original = json('fixtures/product-scenarios/web/features.json').proofs.find(p => p.id === 'wfe-3.1-c2c-tables');
  const originals = original.receipts.map(p => {
    assert.equal(hash(readFileSync(p.path)), p.sha256);
    const receipt = json(p.path); countsOK(receipt.counts);
    assert.equal(receipt.sourcesUnchanged, true);
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
    const paths = Object.keys(receipt.sources).filter(path => path.startsWith('tests/') || path.startsWith('fixtures/'));
    assert.ok(paths.includes(`tests/browser/${receipt.suite}.spec.ts`));
    for (const path of paths) assert.equal(hash(readFileSync(path)), receipt.sources[path], 'Original assertion/fixture changed: ' + path);
    for (const pack of receipt.packs) assert.equal(hash(readFileSync(join(dirname(p.path), pack.file))), pack.sha256);
    return { ...pin(p.path), receipt };
  });
  assert.equal(originals.length, 18);
  for (const pin of oldBinding.originalTableReturn.receipts) {
    const path = resolve('../architecture', pin.path);
    assert.equal(hash(readFileSync(path)), pin.sha256);
    const old = json(path);
    const accepted = originals.find(r => r.receipt.suite === old.suite && r.receipt.engine === old.engine);
    assert.ok(accepted);
    assert.deepEqual(accepted.receipt.cases.map(c => c.name), pin.cases);
  }
  const richExecutionPath = join(current, 'run-3/execution.json');
  const rich = json(richExecutionPath);
  assert.equal(rich.exit, 0); assert.equal(rich.sourcesUnchanged, true); countsOK(rich.counts);
  execution.reusedExecution = pin(richExecutionPath);
  for (const record of rich.receipts.filter(r => ['extension-formatting', 'extension-formatting-mixed'].includes(r.suite))) {
    assert.equal(hash(readFileSync(record.path)), record.sha256);
    const receipt = json(record.path); countsOK(receipt.counts); verify(receipt.sources);
    assert.equal(receipt.sourcesUnchanged, true);
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
    for (const pack of receipt.packs) {
      assert.equal(pack.sha256, packages[pack.name].sha256);
      assert.equal(hash(readFileSync(join(dirname(record.path), pack.file))), pack.sha256);
    }
    const old = originals.find(r => r.receipt.engine === receipt.engine && r.receipt.suite === receipt.suite);
    assert.ok(old); assert.deepEqual(receipt.cases.map(c => c.name), old.receipt.cases.map(c => c.name));
    assert.ok(receipt.cases.every(c => c.passed));
    execution.reusedReceipts.push({ ...record, originalTableProof: { path: old.path, sha256: old.sha256 } });
  }
  assert.equal(execution.reusedReceipts.length, 6);
  for (const engine of engines) {
    const names = execution.reusedReceipts.filter(r => r.engine === engine).flatMap(r => json(r.path).cases.map(c => c.name));
    for (const name of oldBinding.richRequiredCases) assert.ok(names.includes(name), name);
  }
  const paths = [...Object.keys(runtime), ...Object.keys(members), ...originals.flatMap(r => Object.keys(r.receipt.sources)),
    'scripts/run-web-table-refresh-boundary.mjs'];
  const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
  const sources = sourcePins(); save('source-pins.json', sources);
  for (const suite of suites) {
    const args = ['scripts/test-browser.mjs', suite];
    const log = suite + '.log', fd = openSync(join(output, log), 'wx'); let result;
    try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 240000,
      env: { ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: output,
        [`EDITAC_${suite.toUpperCase().replaceAll('-', '_')}_OUTPUT`]: join(output, suite) } });
    } finally { closeSync(fd); }
    const command = { suite, program: process.execPath, args, log, exit: result.status, signal: result.signal,
      error: result.error?.message, sha256: hash(readFileSync(join(output, log))) };
    execution.commands.push(command); save('execution.json', execution);
    try {
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
      command.counts = tapCounts(readFileSync(join(output, log), 'utf8')); countsOK(command.counts);
      assert.equal(command.counts.executed, expected[suite] * engines.length);
      const cells = walk(join(output, suite)).filter(p => p.endsWith('/receipt.json'));
      assert.equal(cells.length, 3);
      for (const path of cells) {
        const receipt = json(path); countsOK(receipt.counts); verify(receipt.sources);
        assert.equal(receipt.sourcesUnchanged, true);
        for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
        for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
        const old = originals.find(r => r.receipt.engine === receipt.engine && r.receipt.suite === receipt.suite);
        assert.ok(old); assert.deepEqual(receipt.cases.map(c => c.name), old.receipt.cases.map(c => c.name));
        assert.ok(receipt.cases.every(c => c.passed));
        execution.receipts.push({ ...pin(path), suite: receipt.suite, engine: receipt.engine, counts: receipt.counts,
          original: { path: old.path, sha256: old.sha256 } });
      }
    } catch (error) { execution.failures.push({ suite, error: error.stack }); }
    save('execution.json', execution);
  }
  assert.equal(execution.failures.length, 0, 'Retained original-suite failures');
  assert.equal(execution.receipts.length, 12);
  assert.deepEqual(sourcePins(), sources, 'Inputs changed during proof');
  const total = receipts => Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
    [key, receipts.reduce((n, r) => n + (r.counts[key] ?? 0), 0)]));
  execution.freshCounts = total(execution.receipts); execution.reusedCounts = total(execution.reusedReceipts);
  execution.counts = total([...execution.receipts, ...execution.reusedReceipts]); countsOK(execution.counts);
  assert.equal(execution.freshCounts.executed, 177); assert.equal(execution.reusedCounts.executed, 675);
  assert.equal(execution.counts.executed, 852);
  execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, exit: execution.exit, fresh: execution.freshCounts, reused: execution.reusedCounts,
    failure: execution.failure?.split('\n').slice(0, 3), failures: execution.failures.length })); }
