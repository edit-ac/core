import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';
import { admitImmutableSdk } from './immutable-sdk-admission.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// One current SDK admission; original behavioral dispatchers and assertions stay intact.
await requireTestNode();
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
assert.equal(cargo.error, undefined, 'Cargo must be available before command/reference proof');
assert.equal(cargo.status, 0, 'Cargo preflight must succeed');
assert.match(cargo.stdout, /^cargo 1\.97\.1\b/, 'Use the admitted Rust fixture toolchain');
assert.ok(process.env.EDITAC_PRODUCT_SDK_ADMISSION, 'Name the current immutable SDK admission');
assert.ok(process.env.EDITAC_WEB_COMMAND_REFERENCE_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_COMMAND_REFERENCE_OUTPUT);
mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const admissionPath = resolve(process.env.EDITAC_PRODUCT_SDK_ADMISSION);
const admitted = admitImmutableSdk(admissionPath);
const sources = admitted.sources, members = admitted.runtime;
const verify = pins => {
  assert.ok(Object.keys(pins).length);
  for (const [path, expected] of Object.entries(pins))
    assert.equal(hash(readFileSync(path)), expected, 'Changed admitted input: ' + path);
};
verify(sources); verify(members);
const admission = join(output, 'admission'); mkdirSync(admission);
writeFileSync(join(admission, 'runtime-source-pins.json'), JSON.stringify(sources, null, 2) + '\n');
writeFileSync(join(admission, 'package-runtime-pins.json'), JSON.stringify(members, null, 2) + '\n');
save('build-admission.json', { sdkAdmission: admitted.receipt, sources, members, runner: {
  path: 'scripts/run-web-command-reference-refresh-boundary.mjs',
  sha256: hash(readFileSync('scripts/run-web-command-reference-refresh-boundary.mjs')) } });
const execution = { task: 'WFE-3.1-C9-3', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), commands: [], receipts: [], failures: [] };
function run(name, args, env) {
  const log = name + '.log', fd = openSync(join(output, log), 'wx'); let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], env: { ...process.env, ...env } }); }
  finally { closeSync(fd); }
  const command = { program: process.execPath, args, env, exit: result.status, signal: result.signal,
    error: result.error?.message, log, sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(command); save('execution.json', execution);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  return command;
}
try {
  for (const [name, key, previous, cells] of [
    ['command', 'COMMAND', 'c4o-5', 3], ['slash', 'SLASH', 'c4o-6', 6], ['reference', 'REFERENCE', 'c4o-7', 12],
  ]) {
    const directory = join(output, name);
    const command = run(name, [`scripts/run-web-${name}-boundary.mjs`], {
      [`EDITAC_WEB_${key}_BUILD`]: admission, [`EDITAC_WEB_${key}_OUTPUT`]: directory,
    });
    const child = json(join(directory, 'execution.json'));
    assert.equal(child.sourcesUnchanged, true); assert.equal(child.receipts.length, cells);
    const old = json(resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1', previous, 'binding.json'));
    for (const receipt of child.receipts) {
      assert.equal(hash(readFileSync(receipt.path)), receipt.sha256);
      const original = old.currentReceipts.find(r => r.suite === receipt.suite && r.engine === receipt.engine);
      assert.ok(original); assert.deepEqual(receipt.cases, original.cases);
      execution.receipts.push({ ...receipt, boundary: name });
    }
    command.counts = child.counts; save('execution.json', execution);
  }
  // References require marked atomic transfers AND the mixed reference-label predicate.
  // Run complete original suites; these are prerequisites, not C7-4 closure.
  const directory = join(output, 'reference-prerequisites'); mkdirSync(directory);
  const packages = json(join(output, 'reference/packages.json'));
  for (const pack of Object.values(packages)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
  writeFileSync(join(directory, 'packages.json'), JSON.stringify(packages, null, 2) + '\n');
  const originalRoot = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
  const oldPaths = (suite, engine) => suite === 'registered-inline-transfer'
    ? join(originalRoot, 'c4o-7/transfer-1/registered-inline-transfer', engine, 'receipt.json')
    : join(originalRoot, 'c4o-4/run-5/extension-formatting', engine,
      ...(suite === 'extension-formatting-mixed' ? ['mixed'] : []), 'receipt.json');
  const suites = ['registered-inline-transfer', 'extension-formatting', 'extension-formatting-mixed'];
  for (const suite of suites) {
    const old = json(oldPaths(suite, 'chromium'));
    for (const [path, expected] of Object.entries(old.sources))
      if (path === `tests/browser/${suite}.spec.ts` || path.startsWith('fixtures/'))
        assert.equal(hash(readFileSync(path)), expected, 'Original prerequisite assertion/fixture changed: ' + path);
  }
  const command = run('reference-prerequisites', ['scripts/test-browser.mjs', 'shared-rich-transfer'], {
    EDITAC_EDITING_PACKS: join(directory, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: directory,
    EDITAC_SHARED_RICH_TRANSFER_OUTPUT: directory,
  });
  const receipts = walk(directory).filter(path => path.endsWith('/receipt.json')).map(path => {
    const receipt = json(path); assert.ok(suites.includes(receipt.suite));
    verify(receipt.sources); assert.notEqual(receipt.sourcesUnchanged, false);
    assert.equal(receipt.counts.executed, receipt.counts.passed); assert.ok(receipt.counts.executed > 0);
    assert.equal(receipt.counts.failed + receipt.counts.skipped, 0);
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
    for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
    const originalPath = oldPaths(receipt.suite, receipt.engine), original = json(originalPath);
    assert.deepEqual(receipt.cases.map(c => c.name), original.cases.map(c => c.name));
    return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine,
      counts: receipt.counts, cases: receipt.cases.map(c => c.name), boundary: 'reference-prerequisites',
      original: { path: originalPath, sha256: hash(readFileSync(originalPath)) } };
  });
  assert.deepEqual(receipts.map(r => r.engine + '/' + r.suite).sort(),
    ['chromium', 'firefox', 'webkit'].flatMap(engine => suites.map(suite => engine + '/' + suite)).sort());
  command.counts = tapCounts(readFileSync(join(output, command.log), 'utf8'));
  assert.equal(command.counts.executed, receipts.reduce((n, r) => n + r.counts.executed, 0));
  execution.receipts.push(...receipts);
  for (const command of execution.commands) {
    assert.ok(command.counts.executed > 0); assert.equal(command.counts.executed, command.counts.passed);
    for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(command.counts[key], 0);
  }
  verify(sources); verify(members);
  execution.counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo']
    .map(key => [key, execution.commands.reduce((sum, command) => sum + command.counts[key], 0)]));
  execution.sourcesUnchanged = true;
} catch (error) { execution.failures.push({ error: error.stack }); throw error; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution); }
console.log(JSON.stringify({ counts: execution.counts, receipts: execution.receipts.length }));
