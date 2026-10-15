import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';
import { tmpdir, cpus, totalmem, platform, arch, release } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startFixtureServer } from '../tests/browser/fixture-server.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { digest } from './architecture-budgets.mjs';
import { inspectLifecycles, inspectLifecycle } from './lifecycle-evidence.mjs';
import { requireTestNode } from './test-toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)); process.chdir(root); await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--seed-directory' || args[2] !== '--output') throw Error('Expected --seed-directory <retained owning directory> --output <unique directory>');
const seeds = resolve(root, args[1]), output = resolve(root, args[3]);
if (!relative(root, output) || relative(root, output).startsWith('..')) throw Error('Retain output inside repository');
await mkdir(output, { recursive: false });
const profilePath = 'benchmarks/profiles/lifecycle-v1.json', profileBytes = await readFile(profilePath), profile = JSON.parse(profileBytes);
const record = { version: 1, qualification: 'unqualified', profileHash: digest(profileBytes),
  metadata: { startedAt: new Date().toISOString(), command: [process.execPath, ...process.argv.slice(1)],
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), hostOS: `${platform()}/${release()}/${arch()}`,
    provenance: 'headless-browser-on-host', node: process.version, replay: profile.replay, memoryMethod: profile.memoryMethod, liveMemoryMethod: profile.liveMemoryMethod },
  counts: { executed: 0, passed: 0, failed: 0, skipped: profile.fixtures.length * profile.presets.length * profile.requiredObservations.length }, cases: [], sourceInputs: {}, artifacts: {}, errors: [], cleanup: {} };
const tracked = spawnSync('git', ['ls-files', 'crates', 'packages', 'fixtures/schema-v5', 'Cargo.lock', 'Cargo.toml', 'package-lock.json', 'package.json', 'scripts/build-wasm.mjs'], { encoding: 'utf8' });
if (tracked.status !== 0) throw Error('Cannot pin source closure');
const inputs = [...new Set([...tracked.stdout.trim().split('\n'), profilePath, 'contracts/services.json', 'benchmarks/lifecycle-client.mjs',
  'benchmarks/fixtures.mjs', 'benchmarks/presets.mjs', 'benchmarks/resource-probe.mjs', 'scripts/lifecycle-evidence.mjs', 'scripts/bench-lifecycle.mjs'])];
for (const file of inputs) record.sourceInputs[file] = digest(await readFile(file));
const temporary = await mkdtemp(join(tmpdir(), 'editac-prf05-'));
let browser, controller, server, interrupted = false;
const stop = () => { interrupted = true; void browser?.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function retain(file, bytes) { await mkdir(join(output, file, '..'), { recursive: true }); await writeFile(join(output, file), bytes); record.artifacts[file] = digest(bytes); }
try {
  await mkdir(join(temporary, 'wasm'));
  await build({ stdin: { contents: 'export {createEditor,taskPreset,CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core"; export {ServiceLifecycle,ReferenceLookupSession} from "@edit-ac/web/modules"; export {DirectSyncAdapter} from "./packages/web/src/sync/protocol.ts";', resolveDir: root },
    outfile: join(temporary, 'sdk.js'), bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  for (const file of ['sdk.js']) await retain(`harness/${file}`, await readFile(join(temporary, file)));
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) {
    await copyFile(`packages/core/dist/wasm/${file}`, join(temporary, 'wasm', file));
    await retain(`harness/wasm/${file}`, await readFile(join(temporary, 'wasm', file)));
  }
  for (const file of ['lifecycle-client.mjs', 'resource-probe.mjs', 'fixtures.mjs', 'presets.mjs']) {
    await copyFile(`benchmarks/${file}`, join(temporary, file)); await retain(`harness/${file}`, await readFile(`benchmarks/${file}`));
  }
  const html = '<!doctype html><meta charset="utf-8"><title>PRF-05</title><style>body{margin:24px}#outer{width:900px;height:360px;overflow:auto;border:1px solid}#inner{margin:16px;height:240px;overflow:auto}#editor{font:16px/1.5 sans-serif;white-space:pre-wrap}#after{height:600px}</style><div id="outer"><div id="inner"><div id="editor"></div></div><div id="after"></div></div>';
  await writeFile(join(temporary, 'index.html'), html); await retain('harness/index.html', html);
  server = await startFixtureServer({ fixtureDirectory: temporary });
  record.metadata.server = { pid: process.pid, port: server.port, workspace: root, purpose: 'PRF-05', log: output };
  controller = await chromium.launchServer({ headless: true });
  record.metadata.browserProcess = { pid: controller.process().pid, launcher: controller.process().spawnfile, purpose: 'PRF-05', workspace: root, log: output };
  browser = await chromium.connect(controller.wsEndpoint()); record.metadata.browser = browser.version();
  for (const name of profile.fixtures) {
    const bytes = await readFile(join(seeds, 'fixtures', `${name}.checkpoint.json`)), frozen = JSON.parse(bytes);
    await retain(`fixtures/${name}.checkpoint.json`, bytes);
    await retain(`fixtures/${name}.json`, JSON.stringify(fixture(name)));
    for (const preset of profile.presets) {
      if (interrupted) throw Error('Service run interrupted');
      console.log(`${name}/${preset} → ${output}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const item = { fixture: name, preset, features: presets[preset].featureSet, checkpointHash: digest(bytes), fixtureHash: digest(JSON.stringify(fixture(name))), observations: [], cycles: [], errors: [] };
      record.cases.push(item);
      try {
        const page = await context.newPage(); page.setDefaultTimeout(120000);
        await context.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
        await page.goto(server.url);
        await page.addScriptTag({ type: 'module', content: 'import * as services from "/fixture/lifecycle-client.mjs"; window.services=services;' });
        await page.waitForFunction(() => !!window.services);
        page.on('pageerror', error => item.errors.push(error.message));
        const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
        item.probeControl = await page.evaluate(options => window.services.setup(options), { name, preset, frozen, profile });
        const memory = async (collected = true) => {
          if (collected) await cdp.send('HeapProfiler.collectGarbage');
          const { metrics } = await cdp.send('Performance.getMetrics');
          const metricsMap = Object.fromEntries(metrics.map(m => [m.name, m.value]));
          return { collected, at: metricsMap.Timestamp, jsHeapUsedBytes: metricsMap.JSHeapUsedSize, jsHeapTotalBytes: metricsMap.JSHeapTotalSize,
            ...await cdp.send('Memory.getDOMCounters'), heap: await cdp.send('Runtime.getHeapUsage') };
        };
        await page.exposeFunction('lifecycleHeap', () => memory(false));
        item.baseline = await memory();
        for (let i = 0; i < profile.cycles; i++) {
          const raw = await page.evaluate(index => window.services.cycle(index), i);
          raw.memory = { ...await memory(), resources: await page.evaluate(() => window.services.resources()) };
          raw.sampledHighWater = Object.fromEntries(['jsHeapUsedBytes', 'nodes', 'documents', 'jsEventListeners', 'backingStorageBytes'].map(key =>
            [key, Math.max(...raw.liveMemory.map(m => key === 'backingStorageBytes' ? m.heap.backingStorageSize : m[key]))]));
          item.cycles.push(raw);
          await writeFile(join(output, 'raw.json'), JSON.stringify(record, null, 2));
        }
        item.memoryStatus = 'inconclusive';
        item.observations = profile.requiredObservations.map(kind => ({ kind }));
        for (const observation of item.observations) {
          record.counts.executed++; record.counts.skipped--;
          try { inspectLifecycle(profile, item, observation); record.counts.passed++; }
          catch (error) { record.counts.failed++; record.errors.push(`${name}/${preset}/${observation.kind}: ${error.message}`); }
        }
        await writeFile(join(output, 'raw.json'), JSON.stringify(record, null, 2));
      } finally { await context.close(); }
    }
  }
} catch (error) { record.errors.push(error.stack); }
finally {
  try { await browser?.close(); await controller?.close(); record.cleanup.browserExited = !controller || controller.process().exitCode !== null; }
  catch (error) { record.errors.push(`Browser cleanup: ${error.message}`); }
  try { await server?.close(); record.cleanup.serverClosed = true; } catch (error) { record.errors.push(`Server cleanup: ${error.message}`); }
  await rm(temporary, { recursive: true, force: true }); record.cleanup.temporaryRemoved = true;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
// Exact executed/pass/fail counts also survive admission failure.
try { record.observations = inspectLifecycles(profile, record); }
catch (error) { record.errors.push(error.message); }
if (record.errors.length) record.status = 'failed'; else record.status = 'diagnostic';
await writeFile(join(output, 'results.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, counts: record.counts, errors: record.errors, output }));
if (record.errors.length) process.exitCode = 1;
