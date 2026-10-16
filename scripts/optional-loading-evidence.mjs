import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest, verifyPins, validateFitnessProfile } from './architecture-budgets.mjs';
import { admitMeasuredConsumer } from './consumers-loading.mjs';
import { testCounts } from './check-architecture.mjs';
import { requireTestNode } from './test-toolchain.mjs';
import { optionalLatencyInputs, produceOptionalLatency, inspectOptionalLatency } from './optional-loading-latency.mjs';

const implementation = ['scripts/optional-loading-evidence.mjs', 'scripts/check-browser-size.mjs',
  'scripts/build-wasm.mjs', 'scripts/share-wasm-glue.mjs', 'scripts/build-wasm-notices.mjs', 'rust-toolchain.toml',
  'scripts/consumers-loading.mjs', 'scripts/browser-size-contract.mjs', 'scripts/minify-task.mjs',
  'scripts/architecture-budgets.mjs', 'scripts/architecture-layers.mjs', 'scripts/check-architecture.mjs',
  'scripts/test-toolchain.mjs', 'tests/browser-size-runtime.test.mjs', '.node-version',
  'benchmarks/profiles/fitness-v1.json', 'benchmarks/config.json', 'tests/architecture/budgets/optional-loading.test.mjs', ...optionalLatencyInputs];
export function optionalLoadingInputs(root) {
  const result = spawnSync('git', ['ls-files', 'crates', 'packages', 'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Cannot inventory optional runtime closure');
  return [...new Set([...result.stdout.trim().split('\n'), ...implementation])].sort();
}
const buildFiles = {
  engine: ['packages/core/dist/wasm/editac_wasm_bg.wasm', 'packages/core/dist/wasm/editac_wasm.js', 'packages/core/dist/wasm/editac_runtime.js'],
  markdown: ['packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm', 'packages/markdown/dist/wasm/editac_markdown_wasm.js'],
};
export function inspectOptionalLoading(record) {
  assert.equal(record.version, 3);
  assert.equal(record.scope, 'current-packed-default-and-markdown');
  assert.deepEqual(record.errors, [], 'Optional loading producer failed');
  assert(Number.isFinite(Date.parse(record.startedAt)) && Date.parse(record.reviewedAt) < Date.parse(record.startedAt), 'Policy must precede measurement');
  assert.deepEqual(record.commands.map(c => c.label), ['build-engine-wasm', 'build-markdown-wasm', 'build-packages', 'default-measurement', 'default-runtime', 'markdown-measurement', 'markdown-runtime']);
  for (const [index, args] of [[0, []], [1, ['--markdown']]]) {
    const command = record.commands[index].command;
    assert.equal(command.length, 2 + args.length, 'Unexpected WASM build command');
    assert.equal(command[1], 'scripts/build-wasm.mjs', 'Missing source WASM build');
    assert.deepEqual(command.slice(2), args, 'Wrong WASM build profile');
  }
  assert.deepEqual(Object.keys(record.buildOutputs).sort(), Object.values(buildFiles).flat().sort(), 'Incomplete built WASM outputs');
  for (const hash of Object.values(record.buildOutputs)) assert.match(hash, /^[0-9a-f]{64}$/, 'Invalid built WASM hash');
  for (const command of record.commands) {
    assert.equal(command.exit, 0, 'Failed optional loading command'); assert.equal(command.error, null);
    assert.equal(record.artifacts[command.log], command.sha256, 'Command log must be retained');
    if (command.label.endsWith('-runtime')) {
      assert.deepEqual(command.counts, { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 }, 'All three browsers must execute');
    }
  }
  assert.deepEqual(Object.keys(record.profiles).sort(), ['default', 'markdown']);
  for (const name of ['default', 'markdown']) {
    const item = record.profiles[name], runtime = item.runtime;
    assert.equal(runtime.profile, name === 'default' ? 'default-task' : 'markdown-enabled-task');
    assert.deepEqual(runtime.artifacts, item.measurement.assets.map(a => ({ name: a.name, sha256: a.sha256 })), 'Runtime must execute measured assets');
    assert.deepEqual(runtime.cases.map(c => c.engine).sort(), ['chromium', 'firefox', 'webkit']);
    for (const test of runtime.cases) {
      assert.equal(test.passed, true); assert.deepEqual(test.errors, []);
      assert.equal(test.cleanup.browserExited, true); assert.equal(test.cleanup.serverClosed, true);
      const paths = test.requests.map(url => new URL(url).pathname);
      for (const asset of item.measurement.assets.filter(a => a.kind !== 'css')) assert(paths.includes('/' + asset.name), 'Required measured runtime asset did not execute');
      assert.equal(paths.some(path => path.includes('markdown')), name === 'markdown', 'Disabled/enabled optional fetch mismatch');
    }
  }
  const baseline = record.profiles.default.measurement, enabled = record.profiles.markdown.measurement;
  for (const [measurement, source, asset] of [[baseline, buildFiles.engine[0], 'wasm/editac_wasm_bg.wasm'],
    [enabled, buildFiles.engine[0], 'wasm/editac_wasm_bg.wasm'], [enabled, buildFiles.markdown[0], 'wasm/editac_markdown_wasm_bg.wasm']]) {
    assert.equal(measurement.assets.find(a => a.name === asset)?.sha256, record.buildOutputs[source], 'Measured WASM differs from source build');
  }
  for (const name of ['core', 'web']) assert.equal(baseline.packs.find(p => p.name === name).sha256, enabled.packs.find(p => p.name === name).sha256, 'Optional delta needs identical base packages');
  const incremental = Object.fromEntries(['total', 'js'].map(key => [key, enabled.result[key].bytes - baseline.result[key].bytes]));
  assert(incremental.total > 0 && incremental.js > 0);
  const latency = inspectOptionalLatency(record.latency, record.loadingPolicy, { default: baseline, markdown: enabled });
  return { baseline: baseline.result, enabled: enabled.result, incremental, latency,
    scope: 'Exact current packed gzip costs, three-browser behavior and Chromium full-corpus optional latency diagnostics; no tail/memory, highlighter, target-platform or release qualification' };
}

async function currentPack(root, directory, pack) {
  const temp = await mkdtemp(join(tmpdir(), 'editac-optional-pack-'));
  try {
    const unpack = spawnSync('tar', ['-xzf', join(directory, pack.filename), '-C', temp], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const files = async (dir, prefix = '') => {
      const result = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(prefix, entry.name);
        if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), path));
        else { assert(entry.isFile(), 'Non-file packed runtime'); result.push(path); }
      }
      return result.sort();
    };
    const packed = join(temp, 'package'), current = join(root, 'packages', pack.name);
    const paths = await files(join(packed, 'dist'));
    assert.deepEqual(paths, await files(join(current, 'dist')), 'Current dist inventory differs from packed runtime');
    for (const path of ['package.json', ...paths.map(p => join('dist', p))])
      assert.equal(digest(await readFile(join(packed, path))), digest(await readFile(join(current, path))), 'Current package differs from measured runtime: ' + pack.name + '/' + path);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function admitOptionalLoading(root, directory, record) {
  const summary = inspectOptionalLoading(record);
  assert.deepEqual(Object.keys(record.sourceInputs).sort(), optionalLoadingInputs(root), 'Incomplete current optional source closure');
  await verifyPins(root, record.sourceInputs);
  await verifyPins(root, record.buildOutputs);
  assert.equal(digest(await readFile(resolve(root, '../architecture/specs/verification.md'))), record.verificationSpecHash, 'Current optional policy drift');
  assert.equal(record.artifacts['policy/verification.md'], record.verificationSpecHash);
  await verifyPins(directory, record.artifacts);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'benchmarks/profiles/loading-v1.json'))), record.loadingPolicy, 'Current optional loading policy drift');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'latency/loading-policy.json'))), record.loadingPolicy, 'Retained optional loading policy changed');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'latency/results.json'))), record.latency, 'Retained optional latency changed');
  for (const name of record.loadingPolicy.fixtures) assert.equal(digest(await readFile(join(directory, 'latency', name + '.checkpoint.json'))), record.latency.checkpoints[name], 'Changed optional corpus');
  for (const name of ['default', 'markdown']) {
    const dir = join(directory, name), item = record.profiles[name];
    const measured = await admitMeasuredConsumer(dir, { markdown: name === 'markdown' });
    assert.deepEqual(measured, item.measurement, 'Retained optional measurement changed');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'runtime-harness.json'))), item.runtime, 'Retained runtime evidence changed');
    for (const pack of measured.packs) await currentPack(root, dir, pack);
  }
  return summary;
}

async function main() {
  await requireTestNode();
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert(process.env.EDITAC_OPTIONAL_LOADING_OUTPUT, 'Explicit isolated optional loading output required');
  const output = resolve(process.env.EDITAC_OPTIONAL_LOADING_OUTPUT);
  await mkdir(output, { recursive: false });
  const profile = JSON.parse(await readFile(join(root, 'benchmarks/profiles/fitness-v1.json')));
  const spec = await readFile(resolve(root, '../architecture/specs/verification.md'));
  validateFitnessProfile(profile, await readFile(join(root, 'benchmarks/config.json')), spec);
  assert(process.env.EDITAC_OPTIONAL_LOADING_SEED, 'Explicit retained loading seed directory required');
  const record = { version: 3, scope: 'current-packed-default-and-markdown', startedAt: new Date().toISOString(), reviewedAt: profile.reviewedAt,
    verificationSpecHash: digest(spec), revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    node: process.version, sourceInputs: {}, buildOutputs: {}, commands: [], profiles: {}, artifacts: {}, errors: [] };
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  // Inherited diagnostic transforms must never contaminate delivered-byte proof.
  for (const key of Object.keys(env)) if (/^EDITAC_(LOADING|BROWSER_SIZE|SIZE_RUNTIME)/.test(key)) delete env[key];
  const run = async (label, command, args, extra = {}, tests = false) => {
    const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 360000, maxBuffer: 16 * 1024 * 1024 });
    const log = (result.stdout ?? '') + (result.stderr ?? '');
    await writeFile(join(output, label + '.log'), log);
    const entry = { label, command: [command, ...args], exit: result.status, error: result.error?.message ?? null, log: label + '.log', sha256: digest(log) };
    record.commands.push(entry);
    if (tests) entry.counts = testCounts(log);
    assert.equal(entry.error, null); assert.equal(entry.exit, 0, 'See ' + join(output, entry.log));
  };
  try {
    for (const path of optionalLoadingInputs(root)) record.sourceInputs[path] = digest(await readFile(join(root, path)));
    await mkdir(join(output, 'policy')); await writeFile(join(output, 'policy/verification.md'), spec);
    // Package/TypeScript builds do not compile Rust. Rebuild both actual WASM
    // profiles before packing so current source pins cannot bless stale binaries.
    await run('build-engine-wasm', process.execPath, ['scripts/build-wasm.mjs']);
    await run('build-markdown-wasm', process.execPath, ['scripts/build-wasm.mjs', '--markdown']);
    for (const path of Object.values(buildFiles).flat()) record.buildOutputs[path] = digest(await readFile(join(root, path)));
    await run('build-packages', 'npm', ['run', 'build']);
    for (const name of ['default', 'markdown']) {
      const directory = join(output, name);
      await run(name + '-measurement', process.execPath, ['scripts/check-browser-size.mjs', ...(name === 'markdown' ? ['--markdown'] : [])], { EDITAC_BROWSER_SIZE_OUTPUT: directory });
      const measurement = await admitMeasuredConsumer(directory, { markdown: name === 'markdown' });
      await run(name + '-runtime', process.execPath, ['--test', '--test-reporter=tap', 'tests/browser-size-runtime.test.mjs'], { EDITAC_SIZE_RUNTIME_ARTIFACTS: directory, EDITAC_SIZE_RUNTIME_RESULTS: directory }, true);
      record.profiles[name] = { measurement, runtime: JSON.parse(await readFile(join(directory, 'runtime-harness.json'))) };
    }
    record.loadingPolicy = JSON.parse(await readFile(join(root, 'benchmarks/profiles/loading-v1.json')));
    record.latency = await produceOptionalLatency(root, output, process.env.EDITAC_OPTIONAL_LOADING_SEED,
      Object.fromEntries(Object.entries(record.profiles).map(([name, item]) => [name, item.measurement])));
  } catch (error) { record.errors.push(error.message); process.exitCode = 1; }
  const inventory = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else record.artifacts[relative(output, path)] = digest(await readFile(path));
    }
  };
  await inventory(output);
  try { assert.deepEqual(record.errors, []); record.summary = await admitOptionalLoading(root, output, record); }
  catch (error) { record.errors.push(error.message); process.exitCode = 1; }
  await writeFile(join(output, 'optional-loading.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ output, commands: record.commands.length, summary: record.summary, errors: record.errors }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error.message); process.exitCode = 1; });
