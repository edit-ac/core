import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';
import { admitImmutableSdk } from './immutable-sdk-admission.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose the original mobile controls and qualified assistance on one installed
// SDK build. Browser specs own the independent semantic assertions and teardown.
await requireTestNode();
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_MOBILE_EXTENSION_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_MOBILE_EXTENSION_OUTPUT); mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const countsOK = c => {
  assert.ok(c.executed > 0); assert.equal(c.executed, c.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(c[key] ?? 0, 0, key);
};
const verify = sources => { for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, path); };
const ledger = json('fixtures/product-scenarios/web/features.json');
const original = ledger.proofs.find(p => p.id === 'wex-2.2').receipts.map(p => {
  assert.equal(hash(readFileSync(p.path)), p.sha256); return { ...p, receipt: json(p.path) };
});
const groups = ['capabilities', 'menus', 'content-controls', 'gestures', 'assets', 'formats'];
const execution = { task: 'WFE-3.1-C6', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  feature: 'WEB-MOBILE-EXTENSIONS', node: process.version, started: new Date().toISOString(),
  commands: [], receipts: [], failures: [] };
function run(name, program, args, environment = {}) {
  const log = name + '.log', fd = openSync(join(output, log), 'wx'); let result;
  try { result = spawnSync(program, args, { stdio: ['ignore', fd, fd], timeout: 240000, env: { ...process.env, ...environment } }); }
  finally { closeSync(fd); }
  const command = { program, args, environment, cwd: process.cwd(), log, exit: result.status,
    signal: result.signal, error: result.error?.message, sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(command); save('execution.json', execution);
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
  return command;
}
try {
  const admissionPath = process.env.EDITAC_PRODUCT_SDK_ADMISSION ?? process.env.EDITAC_WEB_MOBILE_ADMISSION;
  assert.ok(admissionPath, 'Name the current immutable SDK admission; historical/build defaults are not proof');
  const admission = admitImmutableSdk(admissionPath);
  execution.admission = admission.receipt;
  const prior = json(join(base, 'c4o-14/runtime-source-pins.json'));
  const sources = { ...admission.sources, ...Object.fromEntries(Object.keys(prior).map(path => [path, hash(readFileSync(path))])) };
  for (const path of ['scripts/immutable-sdk-admission.mjs', 'tests/assistive-input-contract.test.mjs', 'fixtures/extensions/assistive-input/contract-v1.json']) sources[path] = hash(readFileSync(path));
  for (const path of ['scripts/run-web-mobile-extension-boundary.mjs', 'tests/browser/mobile-extensions/assistance.spec.ts']) sources[path] = hash(readFileSync(path));
  for (const old of original) for (const path of Object.keys(old.receipt.sources)) sources[path] = hash(readFileSync(path));
  for (const path of [...walk('packages/web/src'), ...walk('packages/core/src'), ...walk('packages/markdown/src')]) sources[path] = hash(readFileSync(path));
  const impact = Object.keys(prior).filter(path => prior[path] !== sources[path]).map(path => ({ path, prior: prior[path], current: sources[path] }));
  save('input-impact.json', { changed: impact, originalReceipts: original.map(p => ({ path: p.path, sha256: p.sha256, engine: p.receipt.engine, cases: p.receipt.counts.executed })),
    composition: 'Six original Chromium mobile groups; full Firefox/WebKit formats supersede two original narrow cases each; all three engines formatting, mobile assistance, dictation and presenter. No overlapping dispatcher recount.' });
  const packages = admission.packages;
  save('packages.json', packages);
  const members = Object.fromEntries(['core', 'web', 'markdown'].flatMap(name => walk('packages/' + name + '/dist')).map(path => [path, hash(readFileSync(path))]));
  Object.assign(sources, members); save('source-pins.json', sources); save('package-runtime-pins.json', members);
  const jobs = groups.map(group => ({ group, engine: 'chromium', mobile: true }));
  for (const engine of ['firefox', 'webkit']) jobs.push({ group: 'formats', engine, mobile: true });
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    jobs.push({ group: 'assistance', engine, mobile: true });
    for (const group of ['mobile-extension-formatting', 'assistive-dictation', 'assistive-presenter']) jobs.push({ group, engine, mobile: false });
  }
  for (const { group, engine, mobile } of jobs) {
    const child = join(output, engine, group);
    const suite = mobile ? 'mobile-extensions' : group;
    const key = 'EDITAC_' + suite.toUpperCase().replaceAll('-', '_');
    const environment = { EDITAC_EDITING_PACKS: join(output, 'packages.json'), [`${key}_OUTPUT`]: child, [`${key}_BROWSER`]: engine };
    const args = mobile ? ['scripts/test-mobile-extensions.mjs', '--group', group] : ['--test', '--test-reporter=tap', 'tests/browser/' + group + '.spec.ts'];
    try {
      const command = run(engine + '-' + group, process.execPath, args, environment);
      const path = join(child, 'receipt.json'), receipt = json(path); countsOK(receipt.counts); verify(receipt.sources);
      assert.equal(receipt.sourcesUnchanged, true);
      for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
      for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
      const tap = mobile ? join(child, 'tests.tap') : join(output, command.log);
      const counts = tapCounts(readFileSync(tap, 'utf8')); countsOK(counts);
      if (mobile) {
        const dispatch = json(join(child, 'dispatch-receipt.json')); countsOK(dispatch.counts);
        assert.equal(dispatch.browserReceiptSha256, hash(readFileSync(path)));
        assert.deepEqual(dispatch.browserCounts, receipt.counts);
      }
      const expected = original.filter(p => p.receipt.engine === engine && (mobile
        ? Object.keys(p.receipt.sources).includes('tests/browser/mobile-extensions/' + group + '.spec.ts')
        : p.receipt.suite === group));
      for (const old of expected) for (const c of old.receipt.cases) assert.ok(receipt.cases.some(n => n.name === c.name), 'Missing original ' + c.name);
      execution.receipts.push({ ...pin(path), group, engine, counts: receipt.counts, dispatcherCounts: counts, command: execution.commands.length - 1,
        original: expected.map(p => ({ path: p.path, sha256: p.sha256 })), tap: pin(tap) });
      for (const [path, expected] of Object.entries(receipt.sources)) { if (path in sources) assert.equal(sources[path], expected, path); sources[path] = expected; }
    } catch (error) { execution.failures.push({ group, engine, error: error.stack }); }
    save('execution.json', execution);
  }
  save('source-pins.json', sources);
  assert.equal(execution.failures.length, 0, 'See retained group failures');
  assert.equal(execution.receipts.length, jobs.length);
  const total = key => execution.receipts.reduce((sum, r) => { for (const [k, v] of Object.entries(r[key])) sum[k] = (sum[k] ?? 0) + v; return sum; }, {});
  execution.counts = total('counts'); countsOK(execution.counts);
  execution.dispatcherCounts = total('dispatcherCounts'); countsOK(execution.dispatcherCounts);
  assert.equal(execution.counts.executed, 1406, 'Full original browser composition');
  const contract = run('assistive-contract', process.execPath, ['--test', '--test-reporter=tap', 'tests/assistive-input-contract.test.mjs']);
  contract.counts = tapCounts(readFileSync(join(output, contract.log), 'utf8')); countsOK(contract.counts);
  assert.equal(contract.counts.executed, 67, 'Original portable assistance contract');
  execution.contract = contract;
  execution.acceptedUniqueAssertions = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key => [key, (execution.counts[key] ?? 0) + (contract.counts[key] ?? 0)]));
  countsOK(execution.acceptedUniqueAssertions); assert.equal(execution.acceptedUniqueAssertions.executed, 1473);
  verify(sources); verify(members); execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, exit: execution.exit, counts: execution.counts, failures: execution.failures.length, failure: execution.failure?.split('\n').slice(0, 3) })); }
