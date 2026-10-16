import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';
import { tmpdir, cpus, totalmem, platform, arch, release } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startFixtureServer } from '../tests/browser/fixture-server.mjs';
import { gestureInstrumentation } from './gesture-instrumentation.mjs';
import { gestureVersion } from '../benchmarks/gesture-trace.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { digest, validateFitnessProfile, verifyPins } from './architecture-budgets.mjs';
import { inspectGestures, inspectGesture, validateGesturePolicy, gestureInputs, gestureBuildOutputs } from './gesture-evidence.mjs';
import { requireTestNode } from './test-toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)); process.chdir(root); await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--seed-directory' || args[2] !== '--output') throw Error('Expected --seed-directory <retained owning directory> --output <unique directory>');
const seeds = resolve(root, args[1]), output = resolve(root, args[3]);
if (!relative(root, output) || relative(root, output).startsWith('..')) throw Error('Retain output inside repository');
await mkdir(output, { recursive: false });
const profilePath = 'benchmarks/profiles/gestures-v1.json', profileBytes = await readFile(profilePath), profile = JSON.parse(profileBytes);
const fitnessPath = 'benchmarks/profiles/fitness-v1.json';
const fitnessPolicy = JSON.parse(await readFile(fitnessPath));
const verificationPolicy = await readFile(resolve(root, '../architecture/specs/verification.md'));
// Fail before launching a browser; a receipt must capture the policy measured.
validateFitnessProfile(fitnessPolicy, await readFile('benchmarks/config.json'), verificationPolicy);
const record = { version: gestureVersion, qualification: 'unqualified', profileHash: digest(profileBytes),
  metadata: { startedAt: new Date().toISOString(), command: [process.execPath, ...process.argv.slice(1)],
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), hostOS: `${platform()}/${release()}/${arch()}`,
    verificationPolicy: { source: 'architecture/specs/verification.md', sha256: digest(verificationPolicy), reviewedAt: fitnessPolicy.reviewedAt },
    provenance: 'headless-browser-on-host', node: process.version, input: profile.input },
  counts: { executed: 0, passed: 0, failed: 0, skipped: profile.fixtures.length * profile.presets.length * profile.gestures.length }, cases: [], sourceInputs: {}, artifacts: {}, errors: [], cleanup: {} };
for (const file of gestureInputs(root)) record.sourceInputs[file] = digest(await readFile(file));
record.buildProvenance = { version: 1, commands: [], outputs: {} };
const temporary = await mkdtemp(join(tmpdir(), 'editac-prf02-'));
let browser, controller, server, interrupted = false;
const stop = () => { interrupted = true; void browser?.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function retain(file, bytes) { await mkdir(join(output, file, '..'), { recursive: true }); await writeFile(join(output, file), bytes); record.artifacts[file] = digest(bytes); }
try {
  await retain('policy/verification.md', verificationPolicy);
  validateGesturePolicy(fitnessPolicy, record);
  // A current TypeScript bundle cannot establish that its WASM came from
  // these Rust inputs. Compile the production profile before measuring either.
  for (const [label, executable, args] of [['engine-wasm', process.execPath, ['scripts/build-wasm.mjs']], ['packages', 'npm', ['run', 'build']]]) {
    const built = spawnSync(executable, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const log = `build/${label}.log`, bytes = (built.stdout ?? '') + (built.stderr ?? '') + (built.error?.message ?? '');
    await retain(log, bytes);
    record.buildProvenance.commands.push({ label, command: [executable, ...args], exit: built.status, log, sha256: digest(bytes) });
    if (built.error || built.status !== 0) throw Error(`Gesture ${label} build failed: ${built.status}; see ${log}`);
  }
  for (const file of gestureBuildOutputs) record.buildProvenance.outputs[file] = digest(await readFile(file));
  await verifyPins(root, record.sourceInputs);
  await mkdir(join(temporary, 'wasm'));
  await build({ plugins: [gestureInstrumentation()], stdin: { contents: 'export {createEditor,taskPreset,CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core";', resolveDir: root },
    outfile: join(temporary, 'sdk.js'), bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  for (const file of ['sdk.js']) await retain(`harness/${file}`, await readFile(join(temporary, file)));
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm']) {
    await copyFile(`packages/core/dist/wasm/${file}`, join(temporary, 'wasm', file));
    await retain(`harness/wasm/${file}`, await readFile(join(temporary, 'wasm', file)));
  }
  for (const file of ['gesture-client.mjs', 'gesture-trace.mjs', 'fixtures.mjs', 'presets.mjs']) {
    await copyFile(`benchmarks/${file}`, join(temporary, file)); await retain(`harness/${file}`, await readFile(`benchmarks/${file}`));
  }
  const html = '<!doctype html><meta charset="utf-8"><title>PRF-02</title><style>body{margin:24px}#outer{width:900px;height:360px;overflow:auto;border:1px solid}#inner{margin:16px;height:240px;overflow:auto}#editor{font:16px/1.5 sans-serif;white-space:pre-wrap}#after{height:600px}</style><div id="outer"><div id="inner"><div id="editor"></div></div><div id="after"></div></div>';
  await writeFile(join(temporary, 'index.html'), html); await retain('harness/index.html', html);
  server = await startFixtureServer({ fixtureDirectory: temporary });
  record.metadata.server = { pid: process.pid, port: server.port, workspace: root, purpose: 'PRF-02', log: output };
  controller = await chromium.launchServer({ headless: true });
  record.metadata.browserProcess = { pid: controller.process().pid, launcher: controller.process().spawnfile, purpose: 'PRF-02', workspace: root, log: output };
  browser = await chromium.connect(controller.wsEndpoint()); record.metadata.browser = browser.version();
  for (const name of profile.fixtures) {
    const bytes = await readFile(join(seeds, 'fixtures', `${name}.checkpoint.json`)), frozen = JSON.parse(bytes);
    await retain(`fixtures/${name}.checkpoint.json`, bytes);
    await retain(`fixtures/${name}.json`, JSON.stringify(fixture(name)));
    for (const preset of profile.presets) {
      if (interrupted) throw Error('Gesture run interrupted');
      console.log(`${name}/${preset} → ${output}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const item = { fixture: name, preset, features: presets[preset].featureSet, checkpointHash: digest(bytes), fixtureHash: digest(JSON.stringify(fixture(name))), gestures: [] };
      record.cases.push(item);
      try {
        const page = await context.newPage(); page.setDefaultTimeout(120000);
        await context.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
        await page.goto(server.url);
        await page.addScriptTag({ type: 'module', content: 'import * as gestures from "/fixture/gesture-client.mjs"; window.gestures=gestures;' });
        await page.waitForFunction(() => !!window.gestures);
        const prepared = await page.evaluate(({ name, preset, frozen }) => window.gestures.prepare(name, preset, frozen), { name, preset, frozen });
        item.semanticHash = digest(prepared.semantics); delete prepared.semantics; Object.assign(item, prepared);
        for (const kind of profile.gestures) {
          let points = await page.evaluate(kind => window.gestures.setup(kind), kind);
          // Retain the former fractional midpoint as a trusted native control,
          // outside the measured repaired gesture. Reset before measurement.
          const fractional = points.start.fractionalControl;
          await page.mouse.move(fractional.x, fractional.y); await page.mouse.down();
          const fractionalDown = await page.evaluate(() => window.gestures.endpoint());
          await page.mouse.up();
          const replayControl = { requested: fractional, afterDown: fractionalDown };
          points = await page.evaluate(kind => window.gestures.setup(kind), kind);
          await page.mouse.move(points.start.x, points.start.y);
          await page.evaluate(kind => window.gestures.begin(kind), kind);

          await page.mouse.down();
          const afterDown = await page.evaluate(() => window.gestures.endpoint());
          if (kind === 'drag') await page.waitForTimeout(200);
          for (let i = 1; i <= profile.pointerSteps; i++) {
            const target = kind === 'selection' ? { x: points.start.x + (points.end.x - points.start.x) * i / profile.pointerSteps, y: points.end.y }
              : kind === 'drag' ? { x: points.start.x + 100 + i, y: points.start.y + 36 }
              : { x: points.innerEdge.x, y: i <= profile.pointerSteps / 2 ? points.innerEdge.y : points.outerEdge.y };
            await page.mouse.move(target.x, target.y);
            await page.evaluate(() => window.gestures.frames(1));
          }
          const beforeCancel = await page.evaluate(() => window.gestures.state());
          await page.keyboard.press('Escape'); await page.mouse.up();

          await page.evaluate(() => window.gestures.frames(3));
          const trace = await page.evaluate(() => window.gestures.finish());
          Object.assign(trace, { setup: points, replayControl, afterDown, beforeCancel, cancel: { escape: true, mouseReleased: true } }); item.gestures.push(trace);
          record.counts.executed++; record.counts.skipped--;
          try { inspectGesture(profile, item, trace); record.counts.passed++; }
          catch (error) { record.counts.failed++; record.errors.push(`${name}/${preset}/${kind}: ${error.message}`); }
          // Preserve all related observations; validate the combined matrix once.
          await writeFile(join(output, 'raw.json'), JSON.stringify(record, null, 2));
        }
        item.teardown = await page.evaluate(() => window.gestures.destroy());
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
try {
  await verifyPins(root, record.sourceInputs);
  await verifyPins(root, record.buildProvenance.outputs);
  if (digest(await readFile(resolve(root, '../architecture/specs/verification.md'))) !== digest(verificationPolicy)) throw Error('Verification policy changed during measurement');
  validateGesturePolicy(fitnessPolicy, record); record.observations = inspectGestures(profile, record);
}
catch (error) { record.errors.push(error.message); }
if (record.errors.length) record.status = 'failed'; else record.status = 'diagnostic';
await writeFile(join(output, 'results.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, counts: record.counts, errors: record.errors, output }));
if (record.errors.length) process.exitCode = 1;
