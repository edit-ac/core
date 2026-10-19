import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';
import { admitImmutableSdk } from './immutable-sdk-admission.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose unchanged original cases; shared rich prerequisites execute only once.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_EDITING_MEDIA_TABLE_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_EDITING_MEDIA_TABLE_OUTPUT);
mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const verify = pins => {
  assert.ok(Object.keys(pins).length);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, 'Changed input: ' + path);
};
const valid = counts => {
  assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key] ?? 0, 0, key);
};
const admissionPath = resolve(process.env.EDITAC_PRODUCT_SDK_ADMISSION ??
  '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c9-4/admission.json');
const admitted = admitImmutableSdk(admissionPath);
const sources = admitted.sources, members = admitted.runtime;
verify(sources); verify(members);
const admission = join(output, 'admission'); mkdirSync(admission);
writeFileSync(join(admission, 'runtime-source-pins.json'), JSON.stringify(sources, null, 2) + '\n');
writeFileSync(join(admission, 'package-runtime-pins.json'), JSON.stringify(members, null, 2) + '\n');
const packages = admitted.packages;
for (const [name, pack] of Object.entries(packages)) {
  assert.equal(pack.manifest.name, '@edit-ac/' + name);
  assert.ok(pack.manifest.files.length, 'Archive manifest files required before browser dispatch');
}
save('packages.json', packages);
save('build-admission.json', { sdkAdmission: admitted.receipt, sources, members });
const execution = { task: 'WFE-3.1-C9-4', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), commands: [], receipts: [], failures: [] };
function run(name, program, args, env = {}) {
  const log = name + '.log', fd = openSync(join(output, log), 'wx'); let result;
  try { result = spawnSync(program, args, { stdio: ['ignore', fd, fd], env: { ...process.env,
    EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: output, ...env } }); }
  finally { closeSync(fd); }
  const command = { name, program, args, env, exit: result.status, signal: result.signal,
    error: result.error?.message, log, sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(command); save('execution.json', execution);
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
  return command;
}
try {
  // The previous rich receipts predate the owner delta. Execute their full
  // original public suites once on the same admitted packages as every row.
  const richCommand = run('rich-prerequisites', process.execPath,
    ['scripts/test-browser.mjs', 'shared-rich-transfer'], {
      EDITAC_SHARED_RICH_TRANSFER_OUTPUT: join(output, 'rich-prerequisites'),
    });
  richCommand.counts = tapCounts(readFileSync(join(output, richCommand.log), 'utf8'));
  valid(richCommand.counts);
  const rich = walk(join(output, 'rich-prerequisites')).filter(p => p.endsWith('/receipt.json')).map(path => {
    const receipt = json(path); valid(receipt.counts); verify(receipt.sources);
    assert.equal(receipt.sourcesUnchanged, true);
    for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
    for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
    return { ...pin(path), suite: receipt.suite, engine: receipt.browser?.engine ?? receipt.engine,
      counts: receipt.counts, cases: receipt.cases.map(c => c.name), boundary: 'rich-prerequisites' };
  });
  assert.equal(rich.length, 9);
  assert.deepEqual(rich.map(r => r.suite + '/' + r.engine).sort(),
    ['registered-inline-transfer', 'extension-formatting', 'extension-formatting-mixed']
      .flatMap(s => ['chromium', 'firefox', 'webkit'].map(e => s + '/' + e)).sort());
  execution.receipts.push(...rich); save('execution.json', execution);
  const command = run('editing', process.execPath, ['scripts/run-web-editing-boundary.mjs'], {
    EDITAC_WEB_EDITING_BUILD: admission, EDITAC_WEB_EDITING_OUTPUT: join(output, 'editing'),
  });
  const editing = json(join(output, 'editing/execution.json'));
  assert.equal(editing.sourcesUnchanged, true); assert.deepEqual(editing.failures, []); valid(editing.counts);
  command.counts = editing.counts;
  for (const r of editing.receipts) execution.receipts.push({ ...r, boundary: 'editing' });
  save('execution.json', execution);
  // WEB-EDIT retains these original command/slash/search predicates in addition
  // to its interaction suites. Other feature-row gates remain separate.
  mkdirSync(join(admission, 'run-1'));
  writeFileSync(join(admission, 'run-1/source-pins.json'), JSON.stringify(sources, null, 2) + '\n');
  for (const [name, key] of [['command', 'COMMAND'], ['slash', 'SLASH'], ['search-code', 'SEARCH_CODE']]) {
    const dependency = run('editing-' + name, process.execPath, [`scripts/run-web-${name}-boundary.mjs`], {
      [`EDITAC_WEB_${key}_BUILD`]: admission, [`EDITAC_WEB_${key}_OUTPUT`]: join(output, 'editing-' + name),
    });
    const child = json(join(output, 'editing-' + name, 'execution.json'));
    assert.equal(child.sourcesUnchanged, true); valid(child.counts);
    assert.deepEqual(child.failures ?? [], []); dependency.counts = child.counts;
    for (const r of child.receipts) execution.receipts.push({ ...r, boundary: 'editing-' + name });
    save('execution.json', execution);
  }
  for (const [name, args, env] of [
    ['asset-descriptors', ['test', '-p', 'editac-core', '--test', 'asset_descriptors', '--locked', '--offline'], {}],
    ['asset-lifecycle', ['test', '-p', 'editac-session', '--test', 'asset_lifecycle', '--locked', '--offline'], { EDITAC_ASSET_FIXTURES: join(output, 'session-fixtures') }],
    ['asset-lifecycle-sqlite', ['test', '-p', 'editac-session', '--test', 'asset_lifecycle', '--features', 'native-store', '--locked', '--offline'], { EDITAC_ASSET_FIXTURES: join(output, 'sqlite-fixtures') }],
  ]) {
    const command = run(name, resolve(process.env.HOME, '.cargo/bin/cargo'), args, env);
    const raw = readFileSync(join(output, command.log), 'utf8');
    const rows = [...raw.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
    assert.equal(rows.length, 1);
    const [, status, passed, failed, skipped] = rows[0]; assert.equal(status, 'ok');
    command.counts = { executed: +passed + +failed + +skipped, passed: +passed, failed: +failed, skipped: +skipped, cancelled: 0, todo: 0 };
    valid(command.counts); save('execution.json', execution);
  }
  for (const suite of ['image-lifecycle', 'attachment-actions', 'controlled-embeds', 'table-selection', 'table-command', 'table-invalidation', 'source-table-format']) {
    const directory = join(output, suite);
    const command = run(suite, process.execPath, ['scripts/test-browser.mjs', suite], {
      ['EDITAC_' + suite.toUpperCase().replaceAll('-', '_') + '_OUTPUT']: directory,
    });
    command.counts = tapCounts(readFileSync(join(output, command.log), 'utf8')); valid(command.counts);
    const paths = walk(directory).filter(p => p.endsWith('/receipt.json')); assert.equal(paths.length, 3);
    for (const path of paths) {
      const receipt = json(path); valid(receipt.counts); verify(receipt.sources);
      assert.equal(receipt.sourcesUnchanged, true);
      for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
      for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
      execution.receipts.push({ ...pin(path), suite, engine: receipt.browser?.engine ?? receipt.engine,
        counts: receipt.counts, cases: receipt.cases.map(c => c.name), boundary: suite.startsWith('table-') || suite === 'source-table-format' ? 'tables' : 'media' });
    }
    save('execution.json', execution);
  }
  verify(sources); verify(members);
  const sum = records => Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key => [key, records.reduce((n, r) => n + (r.counts[key] ?? 0), 0)]));
  execution.freshCounts = sum(execution.commands); execution.reusedCounts = sum([]);
  execution.counts = sum(execution.commands); valid(execution.counts);
  execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, exit: execution.exit, counts: execution.counts, failure: execution.failure?.split('\n').slice(0, 4) })); }
