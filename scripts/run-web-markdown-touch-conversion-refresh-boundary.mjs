import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './editing-coverage.mjs';
import { admitImmutableSdk } from './immutable-sdk-admission.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Compose full original boundaries with authenticated current owner archives.
// No original assertion, fixture, browser, or independent reader is replaced.
await requireTestNode();
assert.ok(process.env.EDITAC_WEB_MARKDOWN_TOUCH_CONVERSION_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_MARKDOWN_TOUCH_CONVERSION_OUTPUT);
mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const admitted = admitImmutableSdk(resolve(process.env.EDITAC_PRODUCT_SDK_ADMISSION ?? join(base, 'c9-4/admission.json')));
const sources = { ...admitted.sources };
const members = { ...admitted.runtime };
const conversionRunner = 'scripts/run-web-conversion-current-inputs-boundary.mjs';
for (const path of [conversionRunner, 'scripts/run-web-markdown-touch-conversion-refresh-boundary.mjs']) sources[path] = hash(readFileSync(path));
// The converter is rebuilt from its current source closure before admission.
const formatBuild = json('packages/formats/dist/build-receipt.json');
for (const [path, expected] of Object.entries(formatBuild.sourcePins)) {
  assert.equal(hash(readFileSync(path)), expected, 'Stale converter build: ' + path);
  if (sources[path]) assert.equal(sources[path], expected);
  sources[path] = expected;
}
const admission = join(output, 'admission'); mkdirSync(admission); mkdirSync(join(admission, 'run-1'));
const packs = { ...admitted.packages };
const formatPack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', admission],
  { cwd: resolve('packages/formats'), encoding: 'utf8' });
assert.ifError(formatPack.error); assert.equal(formatPack.status, 0, formatPack.stderr);
const [manifest] = JSON.parse(formatPack.stdout);
packs.formats = { path: join(admission, manifest.filename), sha256: hash(readFileSync(join(admission, manifest.filename))), manifest };
// Admission is a build-input receipt only, with no historical browser outcomes.
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
assert.equal(revision.status, 0);
const rust = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
assert.equal(rust.status, 0); assert.match(rust.stdout, /^rustc 1\.97\.1 /);
const packageReceipt = { prepared: true, sourceRevision: revision.stdout.trim(),
  toolchains: { node: process.versions.node, npm: '11.17.0', rust: rust.stdout.trim() },
  optionalMarkdown: { installed: true }, sdkAdmission: admitted.receipt, packs: [] };
for (const [name, pack] of Object.entries(packs)) {
  assert.equal(hash(readFileSync(pack.path)), pack.sha256);
  assert.ok(pack.manifest.files.length); assert.equal(pack.manifest.name, '@edit-ac/' + name);
  const file = pack.manifest.filename ?? ('edit-ac-' + name + '-0.0.0.tgz');
  if (pack.path !== join(admission, file)) copyFileSync(pack.path, join(admission, file));
  save(join(admission, 'pack-' + name + '.log'), [pack.manifest]);
  packageReceipt.packs.push({ name, file, sha256: pack.sha256 });
}
save(join(admission, 'package-receipt.json'), packageReceipt);
save(join(admission, 'runtime-source-pins.json'), sources);
save(join(admission, 'package-runtime-pins.json'), members);
save(join(admission, 'run-1/packages.json'), packs);
const execution = { task: 'WFE-3.1-C9-5', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  started: new Date().toISOString(), sdkAdmission: admitted.receipt, commands: [], failures: [] };
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
    EDITAC_WEB_MARKDOWN_OUTPUT: join(output, 'markdown'), EDITAC_WEB_MARKDOWN_BUILD: admission,
    EDITAC_PRODUCT_PACK_RECEIPT: join(admission, 'package-receipt.json'),
    EDITAC_MARKDOWN_PACK_RECEIPT: join(admission, 'package-receipt.json') });
  run('touch', 'scripts/run-web-touch-boundary.mjs', {
    EDITAC_WEB_TOUCH_OUTPUT: join(output, 'touch'), EDITAC_WEB_TOUCH_BUILD: admission });
  run('conversion', conversionRunner, { EDITAC_WEB_CONVERSION_REFRESH_OUTPUT: join(output, 'conversion'),
    EDITAC_WEB_CONVERSION_BUILD: admission, EDITAC_EDITING_PACKS: join(admission, 'run-1/packages.json') });
  for (const pins of [sources, members]) for (const [path, expected] of Object.entries(pins))
    assert.equal(hash(readFileSync(path)), expected, 'Input changed during dispatch: ' + path);
  execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failures.push(error.stack); execution.exit = 1; process.exitCode = 1; }
finally {
  execution.finished = new Date().toISOString(); save(join(output, 'execution.json'), execution);
  console.log(JSON.stringify({ output, exit: execution.exit, failures: execution.failures.map(e => e.split('\n')[0]) }));
}
