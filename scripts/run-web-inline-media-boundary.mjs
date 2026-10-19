import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Reuse the authenticated current SDK, not the drifted WFE-1.2 packages.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_INLINE_MEDIA_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_INLINE_MEDIA_OUTPUT);
mkdirSync(output); // Preserve every prior result, including failures.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const prior = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1/c2c-tables');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const runtime = json(join(prior, 'runtime-source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const suites = ['image-lifecycle', 'attachment-actions', 'controlled-embeds'];
const paths = [...Object.keys(runtime), 'scripts/run-web-inline-media-boundary.mjs',
  ...suites.flatMap(suite => [`tests/browser/${suite}.spec.ts`, ...walk(`fixtures/browser-${suite}`)]),
  'tests/browser/browser-harness.ts', 'tests/browser/editing-packed-cache.mjs',
  'scripts/test-browser.mjs', 'scripts/editing-coverage.mjs',
  'crates/editac-core/tests/asset_descriptors.rs', 'crates/editac-session/tests/asset_lifecycle.rs',
  ...walk('crates/editac-core/src'), ...walk('crates/editac-session/src'),
  'crates/editac-session/Cargo.toml', 'crates/editac-core/Cargo.toml',
  'fixtures/rich-content/asset-descriptors.json', 'Cargo.lock', 'Cargo.toml'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
const packages = json(join(prior, 'run-1/packages.json'));
for (const pack of Object.values(packages)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
save('packages.json', packages);
const execution = { task: 'WFE-3.1-C4c-INLINE-MEDIA', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
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
    const segments = raw.split(/(?:image-lifecycle|attachment-actions|controlled-embeds) browser: (?:chromium|firefox|webkit)\n/).slice(1);
    assert.equal(segments.length, 3);
    const counts = segments.map(tapCounts);
    entry.counts = Object.fromEntries(['executed','passed','failed','skipped','cancelled','todo'].map(k => [k, counts.reduce((n,c)=>n+c[k],0)]));
  } else entry.counts = tapCounts(raw);
  assert.ok(entry.counts.executed > 0); assert.equal(entry.counts.executed, entry.counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(entry.counts[key], 0);
}
run('asset-descriptors', ['test', '-p', 'editac-core', '--test', 'asset_descriptors', '--locked'], {}, 'cargo');
run('asset-lifecycle', ['test', '-p', 'editac-session', '--test', 'asset_lifecycle', '--locked'],
  { EDITAC_ASSET_FIXTURES: join(output, 'session-fixtures') }, 'cargo');
for (const suite of suites) {
  const key = 'EDITAC_' + suite.toUpperCase().replaceAll('-', '_');
  run(suite, ['scripts/test-browser.mjs', suite], { [key + '_OUTPUT']: join(output, suite) });
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
assert.deepEqual(sourcePins(), sources); verifyPins(members);
execution.freshCounts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
  [key, execution.commands.filter(c => !c.reusedFrom).reduce((sum, c) => sum + c.counts[key], 0)]));
execution.counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key =>
  [key, execution.commands.reduce((sum, command) => sum + command.counts[key], 0)]));
Object.assign(execution, { finished: new Date().toISOString(), sourcesUnchanged: true });
save('execution.json', execution);
console.log(JSON.stringify({ counts: execution.counts, receipts: execution.receipts.length, sourcePins: Object.keys(sources).length }));
