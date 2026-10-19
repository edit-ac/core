import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose the full original boundaries with the reconciled C7-4 admission.
// No original assertion, fixture, browser, or independent reader is replaced.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_ASSISTANCE_AI_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_ASSISTANCE_AI_OUTPUT);
mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const current = join(base, 'c7-5');
const sources = json(join(current, 'runtime-source-pins.json'));
const members = Object.fromEntries(Object.entries(json(join(current, 'package-runtime-pins.json'))).filter(([path]) => /^packages\/(core|web|markdown)\/dist\//.test(path)));
const delta = [];
for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, path);
for (const [path, expected] of Object.entries(members)) assert.equal(hash(readFileSync(path)), expected, path);
for (const path of ['scripts/run-web-assistance-current-inputs-boundary.mjs']) sources[path] = hash(readFileSync(path));
sources['scripts/run-web-assistance-ai-refresh-boundary.mjs'] = hash(readFileSync('scripts/run-web-assistance-ai-refresh-boundary.mjs'));
const admission = join(output, 'admission'); mkdirSync(admission); mkdirSync(join(admission, 'run-1'));
save(join(admission, 'runtime-source-pins.json'), sources);
save(join(admission, 'package-runtime-pins.json'), members);
const packs = json(join(current, 'run-2/admission/run-1/packages.json'));
for (const pack of Object.values(packs)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
save(join(admission, 'run-1/packages.json'), packs);
const execution = { task: 'WFE-3.1-C8', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), admissionDelta: delta, commands: [], failures: [] };
function run(name, script, env) {
  const log = join(output, name + '.log'), fd = openSync(log, 'wx'); let result;
  try { result = spawnSync(process.execPath, [script], { stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env } }); } finally { closeSync(fd); }
  execution.commands.push({ name, program: process.execPath, args: [script], env, log,
    sha256: hash(readFileSync(log)), exit: result.status, signal: result.signal, error: result.error?.message });
  save(join(output, 'execution.json'), execution);
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
  const receipt = json(join(output, name, 'execution.json')); assert.equal(receipt.exit, 0);
  assert.deepEqual(receipt.failures ?? [], []);
}
try {
  run('assistance', 'scripts/run-web-assistance-current-inputs-boundary.mjs', {
    EDITAC_WEB_ASSISTANCE_OUTPUT: join(output, 'assistance'), EDITAC_WEB_ASSISTANCE_BUILD: admission });
  run('ai', 'scripts/run-web-ai-boundary.mjs', {
    EDITAC_WEB_AI_OUTPUT: join(output, 'ai'), EDITAC_WEB_AI_BUILD: admission });
  execution.exit = 0;
} catch (error) { execution.failures.push(error.stack); execution.exit = 1; process.exitCode = 1; }
finally {
  execution.finished = new Date().toISOString(); save(join(output, 'execution.json'), execution);
  console.log(JSON.stringify({ output, exit: execution.exit, failures: execution.failures.map(e => e.split('\n')[0]) }));
}
