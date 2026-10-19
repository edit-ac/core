import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Authenticate the repaired current product build, then pack its canonical SDK.
// Preserve historical math/reorder evidence and execute every original case.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_MATH_REORDER_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_MATH_REORDER_OUTPUT);
mkdirSync(output); // Preserve every prior result, including failures.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const prior = resolve(process.env.EDITAC_WEB_MATH_REORDER_BUILD ?? '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-2');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const runtime = json(join(prior, 'run-1/source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const paths = [...Object.keys(runtime), 'scripts/run-web-math-reorder-boundary.mjs',
  'tests/browser/math.spec.ts', 'tests/browser/reorder.spec.ts', 'tests/browser/reorder-pointer.spec.ts',
  'tests/math-bundles.test.mjs', 'tests/browser/browser-harness.ts',
  'tests/browser/editing-packed-cache.mjs', 'scripts/test-browser.mjs', 'scripts/editing-coverage.mjs',
  'crates/editac-core/tests/math_atom.rs', 'fixtures/schema-v5/mapping.rs',
  ...walk('crates/editac-core/src'), 'Cargo.lock', 'Cargo.toml',
  ...walk('fixtures/modules'), ...walk('fixtures/browser-math'),
  ...walk('fixtures/browser-reorder'), ...walk('fixtures/browser-reorder-pointer'),
  'fixtures/browser-input/session.mjs', 'fixtures/browser-input/index.html'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
// Exact runtime-member equality authenticates the reused build. npm packs
// install the real SDK and all lazy math assets into separate browser consumers.
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
const execution = { task: 'WFE-3.1-C4b-REFRESH', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  buildAdmission: { path: prior, sourcePins: Object.keys(runtime).length, runtimeMembers: Object.keys(members).length },
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [] };
const failures = [];
function run(name, args, env = {}, program = process.execPath) {
  const log = name + '.log', fd = openSync(join(output, log), 'wx'); let result;
  try { result = spawnSync(program, args, { stdio: ['ignore', fd, fd],
    env: { ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_EDITING_ALL_OUTPUT: output, ...env } }); }
  finally { closeSync(fd); }
  const entry = { program, args, log, exit: result.status, signal: result.signal, error: result.error?.message,
    sha256: hash(readFileSync(join(output, log))) };
  execution.commands.push(entry); save('execution.json', execution);
  if (result.error || result.signal || result.status !== 0) { failures.push(name); return; }
  const raw = readFileSync(join(output, log), 'utf8');
  if (program === 'cargo') {
    const count = raw.match(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/);
    assert.ok(count, 'Missing Rust result');
    entry.counts = { executed: +count[1] + +count[2], passed: +count[1], failed: +count[2], skipped: +count[3], cancelled: 0, todo: 0 };
  } else if (args[0] === 'scripts/test-browser.mjs') {
    const segments = raw.split(/(?:math|reorder|reorder-pointer) browser: (?:chromium|firefox|webkit)\n/).slice(1);
    assert.equal(segments.length, 3);
    const counts = segments.map(tapCounts);
    entry.counts = Object.fromEntries(['executed','passed','failed','skipped','cancelled','todo'].map(k => [k, counts.reduce((n,c)=>n+c[k],0)]));
  } else entry.counts = tapCounts(raw);
  assert.ok(entry.counts.executed > 0); assert.equal(entry.counts.executed, entry.counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(entry.counts[key], 0);
}
const reuse = process.env.EDITAC_WEB_MATH_REORDER_PREREQUISITES;
if (reuse) {
  const directory = resolve(reuse), previous = json(join(directory, 'execution.json'));
  const pins = json(join(directory, 'source-pins.json'));
  // Orchestration changed after interruption; all behavior, fixtures and package inputs must match.
  execution.prerequisiteExcludedInputs = {
    'scripts/run-web-math-reorder-boundary.mjs': 'Interrupted orchestration repaired; not an input to the Rust or bundle tests.',
    'fixtures/browser-math/index.html': 'Browser import-map repair; neither portable Rust fixtures nor lazy-bundle graph consumes HTML.'
  };
  for (const path of Object.keys(execution.prerequisiteExcludedInputs)) delete pins[path];
  verifyPins(pins);
  verifyPins(json(join(directory, 'fixture-pins.json')));
  assert.deepEqual(json(join(directory, 'packages.json')), packages);
  for (const name of ['portable-math', 'lazy-math-bundles']) {
    const command = previous.commands.find(c => c.log === name + '.log');
    assert.ok(command); assert.equal(command.exit, 0); assert.equal(command.signal, null);
    const path = join(directory, command.log), raw = readFileSync(path);
    assert.equal(hash(raw), command.sha256);
    const counts = name === 'portable-math'
      ? { executed: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0 }
      : tapCounts(raw.toString());
    if (name === 'portable-math') assert.match(raw.toString(), /test result: ok\. 2 passed; 0 failed; 0 ignored;/);
    assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
    for (const k of ['failed','skipped','cancelled','todo']) assert.equal(counts[k], 0);
    execution.commands.push({ ...command, counts, reusedFrom: path });
  }
  execution.prerequisiteSources = { path: join(directory, 'source-pins.json'), sha256: hash(readFileSync(join(directory, 'source-pins.json'))) };
  execution.fixtures = join(directory, 'fixtures');
} else {
  run('portable-math', ['test', '-p', 'editac-core', '--test', 'math_atom', '--locked', '--offline'],
    { EDITAC_MATH_FIXTURES: join(output, 'fixtures') }, 'cargo');
  assert.deepEqual(failures, [], 'Portable source fixtures are required before browser checks');
  execution.fixtures = join(output, 'fixtures');
  run('lazy-math-bundles', ['--test', '--test-reporter=tap', 'tests/math-bundles.test.mjs'],
    { EDITAC_MATH_BUNDLES: join(output, 'bundles') });
}
const fixtures = Object.fromEntries(walk(execution.fixtures).map(path => [path, hash(readFileSync(path))]));
save('fixture-pins.json', fixtures); save('execution.json', execution);
for (const suite of ['math', 'reorder', 'reorder-pointer']) {
  const key = 'EDITAC_' + suite.toUpperCase().replaceAll('-', '_');
  run(suite, ['scripts/test-browser.mjs', suite],
    { [key + '_OUTPUT']: join(output, suite), EDITAC_MATH_FIXTURES: execution.fixtures });
}
execution.failures = failures; save('execution.json', execution);
assert.deepEqual(failures, [], 'Repair failed boundaries before rerunning');
execution.receipts = walk(output).filter(path => path.endsWith('/receipt.json')).map(path => {
  const receipt = json(path); verifyPins(receipt.sources);
  assert.notEqual(receipt.sourcesUnchanged, false); assert.ok(receipt.counts.executed > 0);
  assert.equal(receipt.counts.executed, receipt.counts.passed);
  for (const key of ['failed', 'skipped']) assert.equal(receipt.counts[key], 0);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine,
    counts: receipt.counts, cases: receipt.cases.map(c => c.name) };
});
assert.equal(execution.receipts.length, 9);
assert.deepEqual(sourcePins(), sources); verifyPins(members); verifyPins(fixtures);
execution.freshCounts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
  [key, execution.commands.filter(c => !c.reusedFrom).reduce((sum, c) => sum + c.counts[key], 0)]));
execution.counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
  [key, execution.commands.reduce((sum, command) => sum + command.counts[key], 0)]));
Object.assign(execution, { finished: new Date().toISOString(), sourcesUnchanged: true });
save('execution.json', execution);
console.log(JSON.stringify({ counts: execution.counts, receipts: execution.receipts.length, sourcePins: Object.keys(sources).length }));
