import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tapCounts } from './editing-coverage.mjs';
import { requireTestNode } from './test-toolchain.mjs';

// Refresh both original conversion boundaries without changing historical proof
// or the PARALLEL-owned converter. All worker/Session checks use installed bytes.
await requireTestNode();
assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.17.0');
assert.ok(process.env.EDITAC_WEB_CONVERSION_REFRESH_OUTPUT, 'Name a new evidence directory');
const output = resolve(process.env.EDITAC_WEB_CONVERSION_REFRESH_OUTPUT);
mkdirSync(output);
const base = resolve('../architecture/evidence/web-feature-first-20261018/wfe-3.1');
const original = join(base, 'c2b-formats');
const runtime = join(output, 'runtime'); mkdirSync(runtime);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const pin = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const verify = sources => { for (const [path, expected] of Object.entries(sources)) assert.equal(hash(readFileSync(path)), expected, path); };
const countsOK = counts => {
  assert.ok(counts.executed > 0); assert.equal(counts.executed, counts.passed);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(counts[key] ?? 0, 0, key);
};
const caseNames = path => [...readFileSync(path, 'utf8').matchAll(/^ok (\d+) - (.+)$/gm)].map(m => m[1] + ':' + m[2]);
const execution = { task: 'WFE-3.1-C2b-REFRESH', originalParents: ['WFE-3.1-I1', 'WFE-3.1-V1'],
  feature: 'WEB-CONVERSION', started: new Date().toISOString(), node: process.version, npm: '11.17.0',
  commands: [], receipts: [], failures: [] };
function run(name, args, environment = {}, expected) {
  const log = name + '.log', fd = openSync(join(output, log), 'wx'); let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 240000,
    env: { ...process.env, EDITAC_FORMATS_OUTPUT: runtime, ...environment } }); }
  finally { closeSync(fd); }
  const command = { program: process.execPath, args, log, exit: result.status, signal: result.signal,
    error: result.error?.message, sha256: hash(readFileSync(join(output, log))), cwd: process.cwd(), environment };
  execution.commands.push(command); save('execution.json', execution);
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, 'See ' + log);
  if (expected !== undefined) {
    command.counts = tapCounts(readFileSync(join(output, log), 'utf8')); countsOK(command.counts);
    assert.equal(command.counts.executed, expected);
    assert.deepEqual(caseNames(join(output, log)), caseNames(join(original, 'pinned-' + log)), 'Original case coverage changed');
  }
  save('execution.json', execution); return command;
}
try {
  const sources = json(join(resolve(process.env.EDITAC_WEB_CONVERSION_BUILD ?? join(base, 'c4o-14')), 'runtime-source-pins.json'));
  sources['scripts/run-web-conversion-current-inputs-boundary.mjs'] = hash(readFileSync('scripts/run-web-conversion-current-inputs-boundary.mjs'));
  verify(sources); save('source-pins.json', sources);
  // The converter build receipt still binds every original source and WASM asset.
  const build = json('packages/formats/dist/build-receipt.json'); verify(build.sourcePins);
  run('prepare', ['tests/formats/consumers/prepare.mjs']);
  const packed = json(join(runtime, 'packed-artifacts.json'));
  const members = {};
  for (const archive of packed.archives) {
    assert.equal(hash(readFileSync(archive.path)), archive.sha256);
    for (const file of archive.files) {
      const path = 'packages/' + archive.name + '/' + file.path;
      assert.equal(hash(readFileSync(path)), hash(readFileSync(join(packed.consumer, 'node_modules/@edit-ac', archive.name, file.path))));
      members[path] = hash(readFileSync(path));
    }
  }
  save('package-runtime-pins.json', members);
  run('browser', ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=45000',
    ...['browser', 'media', 'odt-media', 'epub-media'].map(n => 'tests/formats/consumers/' + n + '.test.mjs')], {}, 62);
  run('contracts', ['--test', '--test-reporter=tap', '--test-name-pattern=packed archives|default Rust graph|installed public|independent readers|independent DOCX|partial DOCX|independent EPUB',
    'tests/formats/consumers/contracts.test.mjs'], { EDITAC_EPUB_READER_PYTHON: '/tmp/editac-epub-export-20261017-reader/bin/python' }, 7);
  run('media-oracles', ['--test', '--test-reporter=tap', '--test-concurrency=1',
    ...['media', 'odt-media', 'epub-media'].map(n => 'tests/formats/consumers/' + n + '-contracts.test.mjs')], {}, 5);
  // Exact-artifact reuse is limited to the original independent ODT/PDF readers.
  const readerReuses = [];
  for (const name of ['odt', 'pdf']) {
    const prior = join(original, 'pinned-' + name + '-reader-reuse.json'), reuse = json(prior);
    for (const artifact of reuse.artifacts) {
      assert.equal(hash(readFileSync(artifact.prior)), artifact.sha256);
      artifact.current = artifact.current.replace(join(original, 'pinned-runtime'), runtime)
        .replace('../architecture/evidence/web-feature-first-20261018/wfe-3.1/c2b-formats/pinned-runtime', runtime);
      assert.equal(hash(readFileSync(artifact.current)), artifact.sha256, 'Independent reader artifact mismatch');
    }
    for (const command of reuse.commands) {
      assert.equal(hash(readFileSync(command.path)), command.sha256);
      const record = json(command.path); assert.equal(record.exit, 0); assert.ok(!record.signal);
    }
    save(name + '-reader-reuse.json', reuse); readerReuses.push({ name, ...pin(prior), assertions: 1 });
  }
  execution.readerReuses = readerReuses;
  // The original mobile FormatControls harness uses current core/web/markdown
  // plus its independently pinned complete converter profile archive.
  const packages = json(resolve(process.env.EDITAC_EDITING_PACKS ?? join(base, 'c4o-13/run-1/packages.json')));
  for (const pack of Object.values(packages)) assert.equal(hash(readFileSync(pack.path)), pack.sha256);
  save('packages.json', packages);
  const controlsOutput = join(output, 'controls');
  run('controls', ['scripts/test-mobile-extensions.mjs', '--group', 'formats'], {
    EDITAC_EDITING_PACKS: join(output, 'packages.json'), EDITAC_MOBILE_EXTENSIONS_OUTPUT: controlsOutput,
    EDITAC_MOBILE_EXTENSIONS_BROWSER: 'chromium' });
  const receiptPath = join(controlsOutput, 'receipt.json'), receipt = json(receiptPath);
  const old = json(join(original, 'control-binding/binding.json'));
  assert.equal(hash(readFileSync(old.receipt.path)), old.receipt.sha256);
  const prior = json(old.receipt.path); countsOK(receipt.counts); verify(receipt.sources);
  assert.equal(receipt.sourcesUnchanged, true);
  for (const key of ['browserExited', 'serverClosed', 'consumerRemoved']) assert.equal(receipt.cleanup[key], true);
  assert.deepEqual(receipt.cases.map(c => c.name), prior.cases.map(c => c.name));
  for (const name of old.cases) assert.ok(receipt.cases.some(c => c.name === name && c.passed), name);
  for (const pack of receipt.packs) assert.equal(pack.sha256, packages[pack.name].sha256);
  execution.receipts.push({ ...pin(receiptPath), engine: receipt.engine, counts: receipt.counts, original: old.receipt });
  verify(sources); verify(members);
  const tested = execution.commands.filter(c => c.counts).map(c => c.counts);
  tested.push(receipt.counts);
  execution.freshCounts = Object.fromEntries(['executed', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].map(key => [key, tested.reduce((n, c) => n + (c[key] ?? 0), 0)]));
  countsOK(execution.freshCounts);
  execution.reusedCounts = { executed: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  execution.sourcesUnchanged = true; execution.exit = 0;
} catch (error) { execution.failure = error.stack; execution.exit = 1; process.exitCode = 1; }
finally { execution.finished = new Date().toISOString(); save('execution.json', execution);
  console.log(JSON.stringify({ output, exit: execution.exit, fresh: execution.freshCounts, reused: execution.reusedCounts,
    failure: execution.failure?.split('\n').slice(0, 3) })); }
