import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Authenticate the current product build and pack its exact installed SDK bytes.
// Historical receipts stay immutable; original assertions execute afresh.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_SEARCH_CODE_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_SEARCH_CODE_OUTPUT);
mkdirSync(output); // Preserve every prior result, including failures.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const prior = resolve(process.env.EDITAC_WEB_SEARCH_CODE_BUILD ?? '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const runtime = json(join(prior, 'run-1/source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const paths = [...Object.keys(runtime), 'scripts/run-web-search-code-boundary.mjs',
  'tests/browser/code-highlight.spec.ts', 'tests/browser/document-search.spec.ts', 'tests/browser/code-commands.spec.ts',
  'tests/document-search.test.mjs', 'tests/code-commands.test.mjs',
  ...walk('fixtures/document-search'), ...walk('fixtures/code-commands'),
  ...walk('fixtures/browser-document-search'), ...walk('fixtures/browser-code-commands'),
  'fixtures/browser-input/session.mjs', 'fixtures/browser-input/index.html'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
// Member equality authenticates the reused build; each browser installs a
// separate consumer from the canonical npm package layout.
const packages = {};
for (const name of ['core', 'web']) {
  const packed = spawnSync('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', output], { encoding: 'utf8' });
  writeFileSync(join(output, `pack-${name}.log`), (packed.stdout ?? '') + (packed.stderr ?? ''));
  assert.equal(packed.status, 0, `Pack ${name}`); assert.equal(packed.error, undefined);
  const [manifest] = JSON.parse(packed.stdout), path = join(output, manifest.filename);
  packages[name] = { path, manifest, sha256: hash(readFileSync(path)) };
}
verifyPins(members);
save('packages.json', packages);
const execution = { task: 'WFE-3.1-C4a-REFRESH', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  buildAdmission: { path: prior, sourcePins: Object.keys(runtime).length, runtimeMembers: Object.keys(members).length },
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [] };
const failures = [];
function run(name, args, env = {}) {
  const log = name + '.log', fd = openSync(join(output, log), 'wx'); let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd],
    env: { ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: output, ...env } }); }
  finally { closeSync(fd); }
  const entry = { args, log, exit: result.status, signal: result.signal, error: result.error?.message,
    sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(entry); save('execution.json', execution);
  if (result.error || result.signal || result.status !== 0) { failures.push(name); return; }
  entry.counts = tapCounts(readFileSync(join(output, log), 'utf8'));
  assert.ok(entry.counts.executed > 0); assert.equal(entry.counts.executed, entry.counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(entry.counts[key], 0);
}
run('portable-contracts', ['--test', '--test-reporter=tap', 'tests/document-search.test.mjs', 'tests/code-commands.test.mjs']);
for (const suite of ['document-search', 'code-commands', 'code-highlight']) {
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const key = 'EDITAC_' + suite.toUpperCase().replaceAll('-', '_');
    run(suite + '-' + engine, ['--test', '--test-reporter=tap', `tests/browser/${suite}.spec.ts`],
      { [key + '_BROWSER']: engine, [key + '_OUTPUT']: join(output, suite, engine) });
  }
}
execution.failures = failures; save('execution.json', execution);
assert.deepEqual(failures, [], 'Repair failed boundaries before rerunning');
execution.receipts = walk(output).filter(path => path.endsWith('/receipt.json')).map(path => {
  const receipt = json(path); verifyPins(receipt.sources);
  assert.equal(receipt.sourcesUnchanged, true); assert.ok(receipt.counts.executed > 0);
  assert.equal(receipt.counts.executed, receipt.counts.passed);
  for (const key of ['failed', 'skipped']) assert.equal(receipt.counts[key], 0);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine,
    counts: receipt.counts, cases: receipt.cases.map(c => c.name) };
});
assert.equal(execution.receipts.length, 9);
assert.deepEqual(sourcePins(), sources); verifyPins(members);
execution.counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
  [key, execution.commands.reduce((sum, command) => sum + command.counts[key], 0)]));
Object.assign(execution, { finished: new Date().toISOString(), sourcesUnchanged: true });
save('execution.json', execution);
console.log(JSON.stringify({ counts: execution.counts, receipts: execution.receipts.length, sourcePins: Object.keys(sources).length }));
