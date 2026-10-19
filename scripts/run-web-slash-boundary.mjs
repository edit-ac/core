import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// One canonical command composes INT-1.9 with the WEX-1.2 catalog consumer.
// Preserve reviewed assertions, authenticate current runtime bytes, and freshly pack the SDK.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_SLASH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_SLASH_OUTPUT);
mkdirSync(output); // Never overwrite successful or failed proof.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const prior = resolve(process.env.EDITAC_WEB_SLASH_BUILD ?? '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-5');
const original = resolve('../architecture/evidence/web-feature-first-20261018/wex-1.2/run-1');
const runtime = json(join(prior, 'runtime-source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const assertions = ['tests/browser/slash-context.spec.ts', 'tests/browser/interactions/slash.spec.ts',
  'tests/browser/interactions/slash-target-cases.ts', 'tests/browser/slash-cases.ts',
  ...walk('fixtures/browser-slash')];
const oldSources = { ...json(join(original, 'chromium/receipt.json')).sources,
  ...json(join(original, 'chromium/baseline/receipt.json')).sources };
for (const path of assertions) assert.equal(hash(readFileSync(path)), oldSources[path], `Original assertions changed: ${path}`);
const paths = [...Object.keys(runtime), ...assertions, 'scripts/run-web-slash-boundary.mjs',
  'tests/browser/browser-harness.ts', 'tests/browser/fixture-server.mjs',
  'tests/browser/editing-packed-cache.mjs', 'scripts/test-browser.mjs', 'scripts/test-interactions.mjs'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
const packages = {};
for (const name of ['core', 'web', 'markdown']) {
  const packed = spawnSync('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', output], { encoding: 'utf8' });
  writeFileSync(join(output, `pack-${name}.log`), (packed.stdout ?? '') + (packed.stderr ?? ''));
  assert.equal(packed.status, 0, `Pack ${name}`); assert.equal(packed.error, undefined);
  const [manifest] = JSON.parse(packed.stdout), path = join(output, manifest.filename);
  packages[name] = { path, manifest, sha256: hash(readFileSync(path)) };
}
verifyPins(members);
save('packages.json', packages);
const execution = { task: 'WFE-3.1-C4e-REFRESH', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  buildAdmission: { path: prior, sourcePins: Object.keys(runtime).length, runtimeMembers: Object.keys(members).length },
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [] };
const log = 'slash-context.log';
const fd = openSync(join(output, log), 'wx');
let result;
try {
  result = spawnSync('npm', ['run', 'test:browser', '--', 'slash-context'], {
    stdio: ['ignore', fd, fd], env: { ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'),
      EDITAC_SLASH_CONTEXT_OUTPUT: join(output, 'slash-context'), EDITAC_EDITING_ALL_OUTPUT: output },
  });
} finally { closeSync(fd); }
execution.commands.push({ program: 'npm', args: ['run', 'test:browser', '--', 'slash-context'],
  log, exit: result.status, signal: result.signal, error: result.error?.message, sha256: hash(readFileSync(join(output, log))) });
save('execution.json', execution);
assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
const counts = tapCounts(readFileSync(join(output, log), 'utf8'));
assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key], 0);
const receipts = walk(join(output, 'slash-context')).filter(path => path.endsWith('/receipt.json')).map(path => {
  const receipt = json(path);
  assert.ok(['interaction-slash', 'slash-context'].includes(receipt.suite));
  assert.equal(receipt.sourcesUnchanged, true); verifyPins(receipt.sources);
  assert.equal(receipt.counts.executed, receipt.counts.passed);
  for (const key of ['failed', 'skipped']) assert.equal(receipt.counts[key], 0);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  const baseline = receipt.suite === 'interaction-slash';
  const originalPath = join(original, receipt.engine, baseline ? 'baseline/receipt.json' : 'receipt.json');
  const previous = json(originalPath);
  assert.equal(receipt.counts.executed, baseline ? 53 : 22);
  assert.deepEqual(receipt.cases.map(c => c.name), previous.cases.map(c => c.name), 'Original case coverage changed');
  if (baseline) {
    const covered = new Set(receipt.cases.flatMap(c => c.caseIds));
    assert.deepEqual([...covered].sort(), ['SLH-01', 'SLH-02', 'SLH-03', 'SLH-04', 'SLH-05', 'SLH-06', 'SLH-07']);
  }
  return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine, counts: receipt.counts,
    cases: receipt.cases.map(c => c.name), original: { path: originalPath, sha256: hash(readFileSync(originalPath)) } };
});
assert.deepEqual(receipts.map(r => `${r.engine}/${r.suite}`).sort(),
  ['chromium', 'firefox', 'webkit'].flatMap(engine => ['interaction-slash', 'slash-context'].map(suite => `${engine}/${suite}`)).sort());
assert.equal(receipts.reduce((n, r) => n + r.counts.executed, 0), counts.executed);
assert.deepEqual(sourcePins(), sources, 'Sources changed during proof'); verifyPins(members);
Object.assign(execution, { finished: new Date().toISOString(), counts, receipts, sourcesUnchanged: true });
save('execution.json', execution);
console.log(JSON.stringify({ counts, receipts: receipts.length, sourcePins: Object.keys(sources).length }));
