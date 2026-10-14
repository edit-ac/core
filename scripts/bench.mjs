import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { cpus, platform, arch, tmpdir, loadavg, totalmem } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startFixtureServer } from '../tests/browser/fixture-server.mjs';
import { fixture, fixtureVersion } from '../benchmarks/fixtures.mjs';
import { options } from '../benchmarks/options.mjs';
import { aggregate, markdown } from '../benchmarks/report.mjs';
import { stopOwnedProcess } from './owned-processes.mjs';
import { requireTestNode } from './test-toolchain.mjs';
import { summarize } from '../benchmarks/statistics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await requireTestNode();
const flags = options(process.argv.slice(2));
const config = JSON.parse(await readFile('benchmarks/config.json', 'utf8'));
const profile = flags.quick ? { ...config, runs: 1, warmups: 1, samples: 5, formatSamples: 2, memoryEdits: 100, mountCycles: 2, operationSamples: 2 }
  : { ...config, operationSamples: 5 };
profile.fitness = flags.fitness === true;
const output = resolve(flags.output ?? join('benchmark-results', new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
try { await readFile(join(output, 'results.json')); throw Error(`Output already contains evidence; choose a new --output directory: ${output}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.status !== 0) throw Error('Cannot resolve source revision');
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().length > 0;
const result = { version: 1, bundleVersion: 1, mode: flags.quick ? 'quick' : 'full', status: 'running', errors: [], cases: [], bundles: {}, cleanup: {},
  metadata: { command: [process.execPath, ...process.argv.slice(1)], revision: revision.stdout.trim(), dirty, timestamp: new Date().toISOString(), packageVersion: packageJson.version,
    node: process.version, playwright: packageJson.devDependencies.playwright, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model, cores: cpus().length, totalMemoryBytes: totalmem(), loadAverage: loadavg(),
    runnerClass: process.env.EDITAC_BENCH_RUNNER_CLASS ?? 'local', output },
  profileInputs: {},
  fixtures: flags.fixtures.map(name => ({ name, version: fixtureVersion, chars: fixture(name).chars,
    sha256: hash(Buffer.from(JSON.stringify(fixture(name)))) })),
  deferred: { reactWrapper: 'Scaffold only', comparisonEditors: 'Pinned Tiptap/Lexical runs not implemented', tables: 'Not in this fixture version', virtualization: 'No viewport virtualization scenario' },
  plan: { runs: profile.runs, warmups: profile.warmups, samples: profile.samples, metrics: metricNames(flags.fixtures), sampleCounts: {} } };
for (const name of result.plan.metrics) result.plan.sampleCounts[name] = name.startsWith('load.') || name.startsWith('editable.') ? 1
  : ['paste.large', 'select-all-format.large', 'delete-range.large', 'remote-update.large'].includes(name) ? profile.operationSamples
  : /^(bold|italic|heading|undo|redo)\./.test(name) ? profile.formatSamples : profile.samples;
for (const file of ['benchmarks/config.json', 'benchmarks/profiles/fitness-v1.json', 'benchmarks/client.mjs', 'benchmarks/fixtures.mjs',
  'benchmarks/options.mjs', 'benchmarks/statistics.mjs', 'benchmarks/report.mjs', 'scripts/bench.mjs',
  'package.json', 'package-lock.json', '.node-version', 'tsconfig.base.json', 'Cargo.toml', 'rust-toolchain.toml', 'Cargo.lock']) result.profileInputs[file] = hash(await readFile(file));
result.metadata.osRelease = (await import('node:os')).release();
// Freeze the executable source closure before compilation, including dirty files.
// The observation index is output metadata, never an executable/build input.
const sourceFiles = spawnSync('git', ['ls-files', 'crates', 'packages', 'scripts', 'benchmarks'], { encoding: 'utf8' });
if (sourceFiles.status !== 0) throw Error('Cannot inventory benchmark sources');
result.sourceInputs = {};
for (const file of sourceFiles.stdout.trim().split('\n').filter(file => /\.(rs|toml|ts|mjs|json|css)$/.test(file) && !/\/(dist|generated)\//.test(file)
  && file !== 'benchmarks/profiles/baseline-evidence.json')) {
  result.sourceInputs[file] = hash(await readFile(file));
}

let server, controller, browser, temporary, child, interrupted = false;
const stop = () => { interrupted = true; if (child) result.cleanup.interruptedProcesses = stopOwnedProcess(child); void browser?.close().catch(() => {}); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function metricNames(fixtures) {
  const names = fixtures.flatMap(name => [
    ...['start', 'middle', 'end'].flatMap(position => [`typing.${name}.${position}`, `delete.${name}.${position}`]),
    ...['bold', 'italic', 'heading', 'undo', 'redo'].map(operation => `${operation}.${name}`),
    `load.${name}.cold`, `editable.${name}.cold`, `editable.${name}.warm`]);
  if (fixtures.includes('large')) names.push('paste.large', 'select-all-format.large', 'delete-range.large', 'remote-update.large');
  return names;
}
async function command(args, logName) {
  if (interrupted) throw Error('Benchmark interrupted');
  const logPath = join(output, logName), stream = createWriteStream(logPath);
  console.log(`${args.join(' ')} → ${logPath}`);
  try {
    await new Promise((done, reject) => {
      child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
      child.once('error', reject); child.once('close', (code, signal) => code === 0 ? done() : reject(Error(`npm ${args.join(' ')} failed (${code ?? signal}); see ${logPath}`)));
    });
  } finally { child = undefined; await new Promise(resolve => stream.end(resolve)); }
}
async function bundles() {
  const directory = join(output, 'bundles'); await mkdir(directory);
  await mkdir(join(directory, 'wasm'));
  const wasm = await readFile('packages/core/dist/wasm/editac_wasm_bg.wasm');
  const glue = await readFile('packages/core/dist/wasm/editac_wasm.js');
  await writeFile(join(directory, 'wasm/editac_wasm_bg.wasm'), wasm);
  await writeFile(join(directory, 'wasm/editac_wasm.js'), glue);
  const react = JSON.parse(await readFile('packages/react/package.json', 'utf8'));
  const profiles = react.peerDependencies?.react ? ['full', 'minimal', 'react'] : ['full', 'minimal'];
  if (profiles.includes('react')) {
    result.deferred.reactWrapper = 'Wrapper bytes measured; peer React runtime excluded';
    result.metadata.reactWrapper = { version: react.version, peerReact: react.peerDependencies.react, peerRuntimeIncluded: false };
  }
  for (const name of profiles) {
    const contents = name === 'full' ? 'export * from "@edit-ac/web"; export * from "@edit-ac/core";'
      : name === 'react' ? 'export * from "@edit-ac/web"; export * from "@edit-ac/core"; export * from "@edit-ac/react";'
      : 'export {createEditor, CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core";';
    const built = await build({ stdin: { contents, resolveDir: root, sourcefile: `benchmark-${name}.mjs` },
      bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['react'], write: false, metafile: true });
    const js = built.outputFiles[0].contents;
    await writeFile(join(directory, `${name}.js`), js);
    await writeFile(join(directory, `${name}.metafile.json`), JSON.stringify(built.metafile));
    const components = Object.fromEntries([['js', js], ['wasm', wasm], ['glue', glue]].map(([key, bytes]) => [key, {
      bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length,
      brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length, sha256: hash(bytes) }]));
    result.bundles[name] = { components, bytes: Object.values(components).reduce((sum, value) => sum + value.bytes, 0),
      gzipBytes: Object.values(components).reduce((sum, value) => sum + value.gzipBytes, 0),
      brotliBytes: Object.values(components).reduce((sum, value) => sum + value.brotliBytes, 0) };
  }
  result.metadata.artifactHash = hash(Buffer.from(JSON.stringify(result.bundles)));
  result.findings = Object.entries(result.bundles).filter(([name, bundle]) => bundle.brotliBytes > config.budgets[`bundle.${name}`])
    .map(([name, bundle]) => ({ name: `bundle.${name}`, severity: 'budget', value: bundle.brotliBytes, limit: config.budgets[`bundle.${name}`] }));
  await mkdir(join(temporary, 'wasm'));
  // The test helper captures the ordinary host recovery session for remote-update fixtures.
  // Production size measurements above use only package exports.
  await build({ stdin: { contents: 'export {createEditor, CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core"; export {recoverLocalDocument} from "./packages/web/dist/entry.js";', resolveDir: root },
    outfile: join(temporary, 'sdk.js'), bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  result.metadata.harnessBundleHash = hash(await readFile(join(temporary, 'sdk.js')));
  await copyFile(join(temporary, 'sdk.js'), join(output, 'harness/sdk.js'));
  await copyFile('packages/core/dist/wasm/editac_wasm.js', join(temporary, 'wasm/editac_wasm.js'));
  await copyFile('packages/core/dist/wasm/editac_wasm_bg.wasm', join(temporary, 'wasm/editac_wasm_bg.wasm'));
}

try {
  await command(['run', 'build:wasm'], 'build-wasm.log');
  await command(['run', 'build'], 'build-packages.log');
  temporary = await mkdtemp(join(tmpdir(), 'editac-benchmark-'));
  result.cleanup.temporaryDirectory = temporary;
  await mkdir(join(output, 'fixtures'));
  for (const name of flags.fixtures) await writeFile(join(output, 'fixtures', `${name}.json`), JSON.stringify(fixture(name)));
  await copyFile('benchmarks/config.json', join(output, 'config.json'));
  await mkdir(join(output, 'harness'));
  for (const file of ['client.mjs', 'fixtures.mjs']) await copyFile(join('benchmarks', file), join(output, 'harness', file));
  await bundles();
  for (const file of ['client.mjs', 'fixtures.mjs']) await copyFile(join(output, 'harness', file), join(temporary, file));
  await writeFile(join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><title>edit.ac benchmarks</title><style>#editor{max-width:900px;font:16px/1.5 sans-serif;white-space:pre-wrap}body{margin:24px}</style><div id="editor"></div>');
  server = await startFixtureServer({ fixtureDirectory: temporary });
  result.metadata.server = { pid: process.pid, port: server.port, workspace: root, purpose: 'benchmarks', log: output };
  controller = await chromium.launchServer({ headless: true });
  result.metadata.browserProcess = { pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: root, purpose: 'benchmarks', log: output };
  browser = await chromium.connect(controller.wsEndpoint()); result.metadata.browser = browser.version();
  result.signature = { fixtureVersion, mode: result.mode, fixtures: flags.fixtures, runs: profile.runs, samples: profile.samples,
    fixtureHashes: result.fixtures.map(document => document.sha256),
    harnessHash: hash(await readFile(join(output, 'harness/client.mjs'))), warmups: profile.warmups,
    operationSamples: profile.operationSamples, memoryEdits: profile.memoryEdits, mountCycles: profile.mountCycles,
    formatSamples: profile.formatSamples,
    interKeyDelayMs: profile.interKeyDelayMs, platform: platform(), arch: arch(), nodeMajor: process.versions.node.split('.')[0],
    browser: result.metadata.browser, runnerClass: result.metadata.runnerClass,
    hardware: result.metadata.runnerClass === 'local' ? `${result.metadata.cpu}/${result.metadata.cores}` : `${result.metadata.runnerClass}/${result.metadata.cores} cores/${Math.round(totalmem() / 2 ** 30)} GiB`,
    fitness: profile.fitness, preset: 'minimal', endpoint: profile.fitness ? 'dispatch-layout-two-animation-frames-v1' : 'dispatch-dom-layout-v1' };
  for (const name of flags.fixtures) {
    for (let iteration = 0; iteration < profile.warmups + profile.runs; iteration++) {
      if (interrupted) throw Error('Benchmark interrupted');
      console.log(`${name}: ${iteration < profile.warmups ? 'warmup' : 'measured'} ${iteration + 1}/${profile.warmups + profile.runs}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const item = { fixture: name, iteration, measured: iteration >= profile.warmups, metrics: {}, errors: [] };
      result.cases.push(item);
      try {
        const page = await context.newPage(); page.setDefaultTimeout(120000);
        page.on('console', message => { if (message.type() === 'info' && message.text().startsWith('editac-benchmark-phase ')) {
          console.log(message.text()); (item.phases ??= []).push({ phase: message.text(), timestamp: new Date().toISOString() });
        } });
        await page.exposeFunction('benchmarkCheckpoint', async observation => { Object.assign(item, observation); item.partial = true; await writeFile(join(output, 'raw.json'), JSON.stringify(result, null, 2)); });
        page.on('pageerror', error => item.errors.push(error.message));
        const origin = new URL(server.url).origin;
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const cdp = await context.newCDPSession(page);
        await page.exposeFunction('benchmarkHeap', async () => { await cdp.send('HeapProfiler.collectGarbage'); return cdp.send('Runtime.getHeapUsage'); });
        await page.goto(server.url);
        await page.addScriptTag({ type: 'module', content: 'import * as benchmark from "/fixture/client.mjs"; window.benchmark = benchmark;' });
        await page.waitForFunction(() => !!window.benchmark);
        const prepared = await bounded(page.evaluate(name => window.benchmark.prepareFixture(name), name), 300000, 'Checkpoint preparation exceeded 5 minutes');
        // Preserve the prepared IndexedDB checkpoint while dropping the JS realm
        // and initialized runtime, so cold editable includes actual asset loading.
        await page.reload();
        await page.addScriptTag({ type: 'module', content: 'import * as benchmark from "/fixture/client.mjs"; window.benchmark = benchmark;' });
        await page.waitForFunction(() => !!window.benchmark);
        const observation = await bounded(page.evaluate(({ name, config, prepared }) => window.benchmark.runScenario(name, config, prepared),
          { name, config: { ...profile, measureMemory: name === 'large' && iteration === profile.warmups + profile.runs - 1 }, prepared }), 600000, 'Benchmark scenario exceeded 10 minutes');
        Object.assign(item, observation);
        item.partial = false;
        if (item.correctness !== 'passed') throw Error(item.failure ?? 'Scenario correctness failed');
        if (item.errors.length) throw Error(item.errors.join('; '));
      } catch (error) { item.errors.push(error.message); result.errors.push(`${name} iteration ${iteration + 1}: ${error.message}`); }
      finally { await context.close(); await writeFile(join(output, 'raw.json'), JSON.stringify(result, null, 2)); }
    }
  }
  let baseline;
  if (flags.baseline) {
    baseline = JSON.parse(await readFile(resolve(flags.baseline), 'utf8'));
    if (baseline.version !== 1 || baseline.mode !== 'full' || baseline.errors?.length || !baseline.metrics || !baseline.bundles || !baseline.signature) throw Error('Invalid or incomplete baseline');
    result.metadata.baseline = resolve(flags.baseline);
  }
  Object.assign(result, aggregate(result, config, baseline));
  result.status = result.findings.some(item => item.severity === 'hard') || flags.enforce && result.findings.length ? 'failed'
    : result.findings.length ? 'warning' : flags.quick ? 'diagnostic' : 'passed';
  result.metadata.regressionGate = process.env.EDITAC_REGRESSION_GATE ?? 'not run by this command';
  if (process.env.EDITAC_REGRESSION_GATE && process.env.EDITAC_REGRESSION_GATE !== 'success') {
    result.status = 'failed'; result.findings.push({ name: 'functional-regression-gate', severity: 'hard', value: 1, limit: 0 });
  }
} catch (error) { result.status = 'failed'; result.errors.push(error.stack ?? error.message); }
finally {
  try { await browser?.close(); } catch (error) { result.errors.push(`Browser cleanup: ${error.message}`); }
  try {
    await controller?.close();
    result.cleanup.browserExited = !controller || controller.process().exitCode !== null || controller.process().signalCode !== null;
  } catch (error) { result.errors.push(`Controller cleanup: ${error.message}`); }
  try { await server?.close(); result.cleanup.serverClosed = true; } catch (error) { result.errors.push(`Server cleanup: ${error.message}`); }
  try { if (temporary) await rm(temporary, { recursive: true, force: true }); result.cleanup.temporaryRemoved = true; } catch (error) { result.errors.push(`Temporary cleanup: ${error.message}`); }
  if (result.errors.length) result.status = 'failed';
  if (!result.metrics && result.cases.length) {
    const measured = result.cases.filter(item => item.measured && Object.keys(item.metrics).length);
    const available = measured.length ? measured : result.cases.filter(item => Object.keys(item.metrics).length);
    result.partialMetricsProvenance = measured.length ? 'Incomplete measured runs; qualification failed' : 'Discarded warmup diagnostics only; no measured results';
    result.partialMetrics = {};
    for (const name of result.plan.metrics) {
      const runs = available.map(item => item.metrics[name]).filter(samples => samples?.length && samples.every(value => Number.isFinite(value) && value >= 0));
      if (runs.length) result.partialMetrics[name] = { ...summarize(runs), deltaPercent: null };
    }
  }
  result.metadata.finalLoadAverage = loadavg();
  result.counts = { executed: result.cases.length, passed: result.cases.filter(item => item.correctness === 'passed' && !item.errors.length).length,
    failed: result.cases.filter(item => item.correctness !== 'passed' || item.errors.length).length, skipped: 0 };
  result.artifactInputs = {};
  for (const file of ['harness/client.mjs', 'harness/fixtures.mjs', 'harness/sdk.js', 'bundles/wasm/editac_wasm.js', 'bundles/wasm/editac_wasm_bg.wasm', 'config.json']) {
    try { result.artifactInputs[file] = hash(await readFile(join(output, file))); }
    catch (error) { result.errors.push(`Missing retained artifact ${file}: ${error.message}`); result.status = 'failed'; }
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
  await writeFile(join(output, 'summary.md'), markdown(result));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown(result));
  if (flags.saveBaseline && result.status !== 'failed') {
    const destination = resolve(flags.saveBaseline); await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(result, null, 2));
  }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
console.log(`${result.status}: ${result.counts.passed}/${result.counts.executed} scenarios passed; ${result.findings?.length ?? 0} threshold findings. ${join(output, 'summary.md')}`);
if (result.status === 'failed') process.exitCode = 1;
