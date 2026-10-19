import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts, walk } from './editing-coverage.mjs';

// Reuse the authenticated current SDK, not the drifted WFE-1.2 packages.
assert.equal(process.version, 'v24.19.0');
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_RICH_TRANSFER_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_RICH_TRANSFER_OUTPUT);
mkdirSync(output); // Preserve every prior result, including failures.
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const prior = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4o-7');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const verifyPins = pins => {
  assert.ok(Object.keys(pins).length > 0);
  for (const [path, expected] of Object.entries(pins)) assert.equal(hash(readFileSync(path)), expected, `Changed input: ${path}`);
};
const runtime = json(join(prior, 'runtime-source-pins.json'));
const members = json(join(prior, 'package-runtime-pins.json'));
verifyPins(runtime); verifyPins(members);
const paths = [...Object.keys(runtime), 'scripts/run-web-reference-transfer-prerequisite.mjs',
  'tests/browser/registered-inline-transfer.spec.ts'];
const sourcePins = () => Object.fromEntries([...new Set(paths)].sort().map(path => [path, hash(readFileSync(path))]));
const sources = sourcePins(); save('source-pins.json', sources);
const packages = json(join(prior, 'run-1/packages.json'));
for (const pack of Object.values(packages)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
save('packages.json', packages);
const original = json(resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1/c2d-rich-transfer/run-1/registered-inline-transfer/chromium/receipt.json'));
for (const path of ['tests/browser/registered-inline-transfer.spec.ts','fixtures/browser-extension-formatting/session.mjs']) {
 assert.equal(hash(readFileSync(path)), original.sources[path], `Original assertion/fixture changed: ${path}`);
}
const execution = { task: 'WFE-3.1-C4f-TRANSFER-PREREQUISITE', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  node: process.version, npm: '11.17.0', started: new Date().toISOString(), commands: [] };
const log = 'registered-inline-transfer.log';
const fd = openSync(join(output, log), 'wx');
let result;
try {
  result = spawnSync(process.execPath, ['scripts/test-browser.mjs', 'registered-inline-transfer'], {
    stdio: ['ignore', fd, fd], env: { ...process.env, EDITAC_EDITING_PACKS: join(output, 'packages.json'),
      EDITAC_REGISTERED_INLINE_TRANSFER_OUTPUT: join(output, 'registered-inline-transfer'), EDITAC_EDITING_ALL_OUTPUT: output },
  });
} finally { closeSync(fd); }
execution.commands.push({ program: process.execPath, args: ['scripts/test-browser.mjs', 'registered-inline-transfer'],
  log, exit: result.status, signal: result.signal, error: result.error?.message, sha256: hash(readFileSync(join(output, log))) });
save('execution.json', execution);
assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
const counts = tapCounts(readFileSync(join(output, log), 'utf8'));
assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key], 0);
const receipts = walk(join(output, 'registered-inline-transfer')).filter(path => path.endsWith('/receipt.json')).map(path => {
  const receipt = json(path);
  assert.equal(receipt.suite, 'registered-inline-transfer');
  assert.equal(receipt.sourcesUnchanged, true); verifyPins(receipt.sources);
  assert.equal(receipt.counts.executed, receipt.counts.passed);
  for (const key of ['failed', 'skipped']) assert.equal(receipt.counts[key], 0);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  const originalPath = resolve(`../architecture/evidence/web-feature-first-20261018/wfe-1.2/canonical/${receipt.engine}/registered-inline-transfer/receipt.json`);
  const original = json(originalPath);
  assert.deepEqual(receipt.cases.map(c => c.name), original.cases.map(c => c.name), 'Original case coverage changed');
  return { path, sha256: hash(readFileSync(path)), suite: receipt.suite, engine: receipt.engine, counts: receipt.counts,
    cases: receipt.cases.map(c => c.name), original: { path: originalPath, sha256: hash(readFileSync(originalPath)) } };
});
assert.deepEqual(receipts.map(r => r.engine).sort(), ['chromium', 'firefox', 'webkit']);
assert.equal(receipts.reduce((n, r) => n + r.counts.executed, 0), counts.executed);
assert.deepEqual(sourcePins(), sources, 'Sources changed during proof'); verifyPins(members);
Object.assign(execution, { finished: new Date().toISOString(), counts, receipts, sourcesUnchanged: true });
save('execution.json', execution);
console.log(JSON.stringify({ counts, receipts: receipts.length, sourcePins: Object.keys(sources).length }));
