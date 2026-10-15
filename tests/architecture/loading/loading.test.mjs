import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hash, checkLayers } from '../../../scripts/architecture-layers.mjs';
import { testCounts } from '../../../scripts/check-architecture.mjs';
import { auditConsumerGraph, admitMeasuredConsumer } from '../../../scripts/consumers-loading.mjs';
import { admitSharedSite } from '../../../scripts/shared-site-receipt.mjs';
import { budgets } from '../../../scripts/browser-size-contract.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
assert(process.env.EDITAC_ARCHITECTURE_OUTPUT, 'Canonical output required');
const output = resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT);
mkdirSync(output, { recursive: true });
const facts = { version: 1, scope: 'Current unpublished 0.0.0 public SDK packages and portable FFI; no arbitrary semver/native SDK/deployed qualification', commands: [], profiles: {}, sources: {}, artifacts: {} };
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
delete env.EDITAC_DOCS_EXAMPLES;
function run(label, command, args, extra = {}, tests = false) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 360000, maxBuffer: 16 * 1024 * 1024 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, label + '.log'), log);
  const receipt = { label, command: [command, ...args], exit: result.status, error: result.error?.message ?? null, log: label + '.log', sha256: hash(log) };
  facts.commands.push(receipt);
  if (tests) {
    try { receipt.counts = testCounts(log); }
    catch (error) { receipt.counts = error.counts; throw error; }
  }
  assert.equal(result.error, undefined, label); assert.equal(result.status, 0, `See ${output}/${label}.log`);
  return log;
}
function node(label, args, extra, tests) { return run(label, process.execPath, args, extra, tests); }

test('current production packages build before measurement', () => {
  node('build-wasm', ['scripts/build-wasm.mjs']);
  node('build-fixture-wasm', ['scripts/build-wasm.mjs', '--fixture']);
  node('build-markdown-wasm', ['scripts/build-wasm.mjs', '--markdown']);
  run('build-packages', 'npm', ['run', 'build']);
});
test('default Task packed bytes and complete graph pass the shared independent hard caps', async () => {
  const directory = join(output, 'default-task');
  node('default-measurement', ['scripts/check-browser-size.mjs'], { EDITAC_BROWSER_SIZE_OUTPUT: directory });
  facts.profiles.default = await admitMeasuredConsumer(directory);
  assert.deepEqual(budgets, { total: { hard: 524288, preferred: 256000 }, js: { hard: 32768, preferred: 16000 } });
});
test('enabled Markdown costs are measured separately without changing default admission', async () => {
  const directory = join(output, 'markdown-enabled');
  node('enabled-measurement', ['scripts/check-browser-size.mjs', '--markdown'], { EDITAC_BROWSER_SIZE_OUTPUT: directory });
  facts.profiles.markdown = await admitMeasuredConsumer(directory, { markdown: true });
  assert(facts.profiles.default, 'Default profile must qualify first');
  for (const scope of ['total', 'js']) {
    facts.profiles.markdown.result[scope].incrementalBytes = facts.profiles.markdown.result[scope].bytes - facts.profiles.default.result[scope].bytes;
    assert(facts.profiles.markdown.result[scope].incrementalBytes > 0);
  }
  for (const name of ['core', 'web']) assert.equal(facts.profiles.default.packs.find(p => p.name === name).sha256, facts.profiles.markdown.packs.find(p => p.name === name).sha256, 'Same packed base for optional delta');
});
for (const [profile, dir] of [['default', 'default-task'], ['markdown', 'markdown-enabled']]) {
  test(`${profile}: exact measured minified artifacts execute real edit/history/peer/persistence runtime on three browsers`, () => {
    assert(facts.profiles[profile], 'Measured admission required');
    const directory = join(output, dir);
    node(profile + '-runtime', ['--test', '--test-reporter=tap', 'tests/browser-size-runtime.test.mjs'], { EDITAC_SIZE_RUNTIME_ARTIFACTS: directory, EDITAC_SIZE_RUNTIME_RESULTS: directory }, true);
    assert.equal(facts.commands.at(-1).counts.tests, 3, 'All browser engines must execute');
  });
}
test('shared site receipt controls reject invalid cache, union and common-module evidence', () => {
  node('shared-site-contracts', ['--test', '--test-reporter=tap', 'tests/shared-site-receipt.test.mjs', 'tests/shared-editor-resources.test.mjs'], {}, true);
  assert.equal(facts.commands.at(-1).counts.tests, 39);
});
test('SHR-01–08 exact packed site receipt is required for shared-resource qualification', async () => {
  const directory = process.env.EDITAC_SHARED_RESOURCES_RECEIPT;
  assert(directory, 'Missing SDK-1.10 consolidated SHR-01–08 receipt; same-page observations alone cannot pass FIT-1.6-I2');
  const receipt = await admitSharedSite(directory, root, { currentProfiles: facts.profiles });
  assert.equal(receipt.defaultGzip.total, facts.profiles.default.result.total.bytes, 'Shared receipt must match current default inventory');
  assert.equal(receipt.defaultGzip.editorJs, facts.profiles.default.result.js.bytes, 'Shared receipt must match current default JS inventory');
  assert.deepEqual(receipt.defaultAssets.map(a => [a.sha256, a.bytes]).sort(), facts.profiles.default.assets.map(a => [a.sha256, a.raw]).sort(), 'Shared receipt must use exact current default delivered artifacts');
  for (const pack of facts.profiles.default.packs) assert(receipt.packages.some(value => value.name === `@edit-ac/${pack.name}` && value.sha256 === pack.sha256), 'Shared receipt package differs from current default pack');
  facts.sharedResources = { directory: relative(root, directory), artifact: 'shared-receipt.json', sha256: hash(await readFile(join(directory, 'shared-receipt.json'))) };
});
test('independent tarball public ESM, declarations, React, Astro static/SSR and browser consumers work without aliases', () => {
  const directory = join(output, 'packed-consumers');
  node('packed-consumers', ['--test', '--test-reporter=tap', 'tests/packed-consumers.test.mjs'], { EDITAC_PACKED_OUTPUT: directory }, true);
  assert.equal(facts.commands.at(-1).counts.tests, 15);
  const packed = JSON.parse(readFileSync(join(directory, 'harness.json')));
  assert.equal(packed.packs.length, 5);
  assert(packed.cases.length > 0 && packed.cases.every(c => c.passed));
  assert(packed.teardown.length > 0 && packed.teardown.every(t => t.exited === true || t.closed === true));
});
test('portable FFI public consumer executes real atomicity, UTF-16, recovery and disposal', () => {
  const log = run('native-abi', 'cargo', ['+1.97.1', 'test', '-p', 'editac-ffi', '--test', 'native_abi', '--locked', '--offline']);
  const counts = [...log.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)];
  assert.equal(counts.length, 1); assert.deepEqual(counts[0].slice(1), ['8', '0', '0']);
  facts.commands.at(-1).counts = { tests: 8, pass: 8, fail: 0, skipped: 0 };
});
test('actual locked Cargo features and JS imports preserve the engine/minimum SDK optional boundaries', async () => {
  const graph = await checkLayers(root, JSON.parse(readFileSync(join(root, 'contracts/layers.json'))));
  assert(graph.cargo.members > 0 && graph.js.members > 0);
  writeFileSync(join(output, 'loading-graph.json'), JSON.stringify(graph, null, 2) + '\n');
});

const graph = () => Object.fromEntries(['core/dist/index.js', 'core/dist/engine.js', 'web/dist/editor.js', 'web/dist/storage/checkpoint.js', 'web/dist/sync/protocol.js', 'web/dist/surface.js'].map(path => ['node_modules/@edit-ac/' + path, path.endsWith('core/dist/index.js') ? 'const gluePath=new URL("./wasm/editac_wasm.js",import.meta.url);import(gluePath)' : 'export const x=1;']));
function fixture() {
  const sources = { 'task.mjs': '', ...graph() };
  const required = [{ name: 'task.js', kind: 'js' }, { name: 'task.css', kind: 'css' }, { name: 'wasm/editac_wasm_bg.wasm', kind: 'wasm' }, { name: 'wasm/editac_wasm.js', kind: 'js' }];
  return { sources, meta: { inputs: Object.fromEntries(Object.keys(sources).map(p => [p, {}])), outputs: { 'public/task.js': { imports: [] } } }, manifest: { required, inputs: Object.keys(sources), ephemeralRoot: '/tmp/consumer' } };
}
test('bounded fixture graph admits the explicit required lazy glue resource', () => {
  const f = fixture(); auditConsumerGraph(f.sources, f.meta, f.manifest);
});
for (const name of ['highlight', 'cloud', 'pdf', 'conversion', 'markdown']) test(`negative: disabled ${name} cannot enter a minimal packed graph`, () => {
  const f = fixture(), path = `node_modules/@edit-ac/${name}/dist/index.js`;
  f.sources[path] = ''; f.meta.inputs[path] = {}; f.manifest.inputs.push(path);
  assert.throws(() => auditConsumerGraph(f.sources, f.meta, f.manifest), /optional|Optional/);
});
for (const name of ['task.js', 'task.css', 'wasm/editac_wasm.js', 'wasm/editac_wasm_bg.wasm']) test(`negative: omitted required byte inventory ${name} rejects`, () => {
  const f = fixture(); f.manifest.required = f.manifest.required.filter(a => a.name !== name);
  assert.throws(() => auditConsumerGraph(f.sources, f.meta, f.manifest), /Uncounted|Missing required/);
});
test('negative: private workspace source cannot substitute for packed public input', () => {
  const f = fixture(); f.sources['../../packages/web/src/editor.ts'] = '';
  assert.throws(() => auditConsumerGraph(f.sources, f.meta, f.manifest), /outside packed/);
});
for (const imp of [{ path: 'cloud-sdk', external: true }, { path: 'public/required-lazy.js', external: false }]) test(`negative: unresolved output import ${imp.path} rejects`, () => {
  const f = fixture(); f.meta.outputs['public/task.js'].imports.push(imp);
  assert.throws(() => auditConsumerGraph(f.sources, f.meta, f.manifest), /Unpacked output|Uninventoried/);
});
test('negative: graph/measurement input mismatch rejects', () => {
  const f = fixture(); f.manifest.inputs.pop(); assert.throws(() => auditConsumerGraph(f.sources, f.meta, f.manifest), /inventory differs/);
});

for (const [name, mutate, expected] of [
  ['fixture-only baseline', m => { m.fixtureBaseline = true; }, /Fixture baseline/],
  ['failed measurement command', m => { m.commands[0].exit = 1; }, /Incomplete measurement/],
  ['changed packed archive identity', m => { m.packs[0].sha256 = '0'.repeat(64); }, /Packed artifact identity/],
  ['changed packed input identity', m => { m.inputHashes['task.mjs'] = '0'.repeat(64); }, /Packed source identities/],
  ['invented gzip measurement', m => { m.assets[0].gzip--; }, /Resource measurement/],
  ['invented passing budget result', m => { m.result.js.bytes--; }, /Budget result/],
  ['omitted required WASM', m => { m.required = m.required.filter(a => a.kind !== 'wasm'); }, /Missing required/],
]) test(`negative measured artifact admission: ${name}`, async () => {
  assert(facts.profiles.default, 'Current measured default required');
  const source = join(output, 'default-task');
  const temp = await mkdtemp(join(tmpdir(), 'editac-fit-negative-'));
  try {
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json')));
    for (const path of ['artifacts', 'metafile.json', ...manifest.packs.map(p => p.filename)]) await symlink(join(source, path), join(temp, path));
    mutate(manifest); await writeFile(join(temp, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(admitMeasuredConsumer(temp), expected);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

after(() => {
  facts.revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const files = spawnSync('git', ['ls-files', '--', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package-lock.json', 'packages', 'crates', 'examples', 'scripts', 'contracts'], { cwd: root, encoding: 'utf8' });
  assert.equal(files.status, 0);
  for (const path of files.stdout.trim().split('\n').filter(Boolean)) facts.sources[path] = hash(readFileSync(join(root, path)));
  function inventory(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isDirectory()) inventory(path); else facts.artifacts[relative(output, path)] = hash(readFileSync(path)); } }
  inventory(output);
  writeFileSync(join(output, 'consumers-loading-inventory.json'), JSON.stringify(facts, null, 2) + '\n');
});
