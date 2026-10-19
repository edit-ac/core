import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose both original boundaries over one authenticated current SDK build.
// This adds admission/accounting, never substitute behavioral cases.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_SEARCH_MATH_REFRESH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_SEARCH_MATH_REFRESH_OUTPUT);
mkdirSync(output);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const current = resolve(process.env.EDITAC_WEB_SEARCH_MATH_REFRESH_BUILD ??
  '../architecture/evidence/web-feature-first-20261018/wfe-3.1/c4p-ai');
const sources = json(join(current, 'runtime-source-pins.json'));
const members = json(join(current, 'package-runtime-pins.json'));
const verify = pins => {
  assert.ok(Object.keys(pins).length);
  for (const [path, expected] of Object.entries(pins))
    assert.equal(hash(readFileSync(path)), expected, 'Changed admitted input: ' + path);
};
verify(sources); verify(members);
const admission = join(output, 'admission');
mkdirSync(join(admission, 'run-1'), { recursive: true });
writeFileSync(join(admission, 'run-1/source-pins.json'), JSON.stringify(sources, null, 2) + '\n');
writeFileSync(join(admission, 'package-runtime-pins.json'), JSON.stringify(members, null, 2) + '\n');
save('build-admission.json', { current, sources, members,
  runner: { path: 'scripts/run-web-search-math-refresh-boundary.mjs',
    sha256: hash(readFileSync('scripts/run-web-search-math-refresh-boundary.mjs')) } });
const execution = { task: 'WFE-3.1-C7-2', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), commands: [], receipts: [], failures: [] };
try {
  for (const [name, key] of [['search-code', 'SEARCH_CODE'], ['math-reorder', 'MATH_REORDER']]) {
    const directory = join(output, name), script = `scripts/run-web-${name}-boundary.mjs`;
    const fd = openSync(join(output, name + '.log'), 'wx'); let result;
    try {
      result = spawnSync(process.execPath, [script], { stdio: ['ignore', fd, fd], env: {
        ...process.env, [`EDITAC_WEB_${key}_BUILD`]: admission, [`EDITAC_WEB_${key}_OUTPUT`]: directory,
      } });
    } finally { closeSync(fd); }
    const command = { program: process.execPath, args: [script], output: directory,
      exit: result.status, signal: result.signal, error: result.error?.message,
      log: name + '.log', sha256: hash(readFileSync(join(output, name + '.log'))) };
    execution.commands.push(command);
    if (result.status !== 0 || result.signal || result.error) { execution.failures.push(name); continue; }
    const child = json(join(directory, 'execution.json'));
    assert.equal(child.sourcesUnchanged, true);
    assert.equal(child.counts.executed, child.counts.passed); assert.ok(child.counts.executed > 0);
    for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(child.counts[key], 0);
    const old = json(resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1',
      name === 'search-code' ? 'c4o-2/binding.json' : 'c4o-3/binding.json'));
    assert.equal(child.receipts.length, 9);
    const pairs = new Set();
    for (const receipt of child.receipts) {
      assert.equal(hash(readFileSync(receipt.path)), receipt.sha256);
      assert.deepEqual(receipt.cases, old.requiredCasesBySuite[receipt.suite]);
      const pair = receipt.suite + '/' + receipt.engine; assert.ok(!pairs.has(pair)); pairs.add(pair);
      execution.receipts.push(receipt);
    }
    command.counts = child.counts;
    save('execution.json', execution);
  }
  assert.deepEqual(execution.failures, [], 'Repair failed boundaries before another run');
  verify(sources); verify(members);
  execution.counts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo']
    .map(key => [key, execution.commands.reduce((sum, command) => sum + command.counts[key], 0)]));
  execution.sourcesUnchanged = true;
} finally {
  execution.finished = new Date().toISOString(); save('execution.json', execution);
}
console.log(JSON.stringify({ counts: execution.counts, receipts: execution.receipts.length }));
