import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose the full original boundaries with the reconciled C7-4 admission.
// No original assertion, fixture, browser, or independent reader is replaced.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_MARKDOWN_TOUCH_CONVERSION_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_MARKDOWN_TOUCH_CONVERSION_OUTPUT);
mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const current = join(base, 'c7-4');
const sources = json(join(current, 'runtime-source-pins.json'));
const members = json(join(current, 'package-runtime-pins.json'));
const conversionRunner = 'scripts/run-web-conversion-current-inputs-boundary.mjs';
const delta = [];
for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, path);
sources[conversionRunner] = hash(readFileSync(conversionRunner));
for (const [path, expected] of Object.entries(members)) assert.equal(hash(readFileSync(path)), expected, path);
sources['scripts/run-web-markdown-touch-conversion-refresh-boundary.mjs'] = hash(readFileSync('scripts/run-web-markdown-touch-conversion-refresh-boundary.mjs'));
const admission = join(output, 'admission'); mkdirSync(admission); mkdirSync(join(admission, 'run-1'));
save(join(admission, 'runtime-source-pins.json'), sources);
save(join(admission, 'package-runtime-pins.json'), members);
const packs = json(join(current, 'run-1/packages.json'));
const qualified = json(join(current, 'qualified-main-reconciliation.json'));
const formats = qualified.qualifiedPackageArchives.find(p => p.name === 'formats'); assert.ok(formats);
packs.formats = formats;
for (const pack of Object.values(packs)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
save(join(admission, 'run-1/packages.json'), packs);
const execution = { task: 'WFE-3.1-C7-5', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
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
  run('markdown', 'scripts/run-web-markdown-boundary.mjs', {
    EDITAC_WEB_MARKDOWN_OUTPUT: join(output, 'markdown'), EDITAC_WEB_MARKDOWN_BUILD: admission });
  run('touch', 'scripts/run-web-touch-boundary.mjs', {
    EDITAC_WEB_TOUCH_OUTPUT: join(output, 'touch'), EDITAC_WEB_TOUCH_BUILD: admission });
  run('conversion', conversionRunner, { EDITAC_WEB_CONVERSION_REFRESH_OUTPUT: join(output, 'conversion'),
    EDITAC_WEB_CONVERSION_BUILD: admission, EDITAC_EDITING_PACKS: join(admission, 'run-1/packages.json') });
  execution.exit = 0;
} catch (error) { execution.failures.push(error.stack); execution.exit = 1; process.exitCode = 1; }
finally {
  execution.finished = new Date().toISOString(); save(join(output, 'execution.json'), execution);
  console.log(JSON.stringify({ output, exit: execution.exit, failures: execution.failures.map(e => e.split('\n')[0]) }));
}
