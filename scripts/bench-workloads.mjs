import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';
import { tmpdir, cpus, totalmem, platform, arch, release } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startFixtureServer } from '../tests/browser/fixture-server.mjs';
import { workload, expectedWorkload, canonicalWorkload } from '../benchmarks/workloads.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { digest, verifyPins, validateFitnessProfile } from './architecture-budgets.mjs';
import { inspectWorkloads, inspectWorkload, validateWorkloadPolicy, workloadInputs, workloadBuildProof, inspectWorkloadBuild } from './workload-evidence.mjs';
import { replayTableInput } from './table-workload-accessibility.mjs';
import { admitOptionalLoading } from './optional-loading-evidence.mjs';
import { requireTestNode } from './test-toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)); process.chdir(root); await requireTestNode();
const args = process.argv.slice(2);
const tableAccessibility = args[0] === '--table-accessibility'; if (tableAccessibility) args.shift();
if (args.length !== 2 || args[0] !== '--output') throw Error('Expected --output <unique directory>');
const output = resolve(root, args[1]);
if (!relative(root, output) || relative(root, output).startsWith('..')) throw Error('Retain output inside repository');
await mkdir(output, { recursive: false });
const profilePath = tableAccessibility ? 'benchmarks/profiles/table-accessibility-v1.json' : 'benchmarks/profiles/workloads-v1.json', profileBytes = await readFile(profilePath), profile = JSON.parse(profileBytes);
const fitnessPath = 'benchmarks/profiles/fitness-v1.json';
const fitnessPolicy = JSON.parse(await readFile(fitnessPath));
const verificationPolicy = await readFile(resolve(root, '../architecture/specs/verification.md'));
validateFitnessProfile(fitnessPolicy, await readFile('benchmarks/config.json'), verificationPolicy);
const record = { version: 1, qualification: 'unqualified', profileHash: digest(profileBytes),
  metadata: { startedAt: new Date().toISOString(), command: [process.execPath, ...process.argv.slice(1)],
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), hostOS: `${platform()}/${release()}/${arch()}`,
    verificationPolicy: { source: 'architecture/specs/verification.md', sha256: digest(verificationPolicy), reviewedAt: fitnessPolicy.reviewedAt },
    provenance: 'headless-browser-on-host', node: process.version, warmupPolicy: profile.warmupPolicy, seedContext: profile.seedContext, semanticPolicy: profile.semanticPolicy },
  counts: { executed: 0, passed: 0, failed: 0, skipped: profile.scales.length * profile.presets.length * profile.workloads.length }, cases: [], sourceInputs: {}, artifacts: {}, errors: [], cleanup: {} };
for (const file of workloadInputs(root, profilePath)) record.sourceInputs[file] = digest(await readFile(file));
const temporary = await mkdtemp(join(tmpdir(), 'editac-prf04-'));
let browser, controller, server, interrupted = false;
const stop = () => { interrupted = true; void browser?.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function retain(file, bytes) { await mkdir(join(output, file, '..'), { recursive: true }); await writeFile(join(output, file), bytes); record.artifacts[file] = digest(bytes); }
try {
  await retain('policy/verification.md', verificationPolicy);
  validateWorkloadPolicy(fitnessPolicy, record);
  const optionalIndex = JSON.parse(await readFile('benchmarks/profiles/optional-loading-evidence.json'));
  const optionalDirectory = resolve(root, optionalIndex.directory);
  const optionalBytes = await readFile(join(optionalDirectory, 'optional-loading.json'));
  if (digest(optionalBytes) !== optionalIndex.receiptHash) throw Error('Changed workload source-build receipt');
  const optionalRecord = JSON.parse(optionalBytes);
  await admitOptionalLoading(root, optionalDirectory, optionalRecord);
  record.metadata.optionalLoading = optionalIndex;
  record.buildProvenance = workloadBuildProof(optionalRecord, optionalIndex.receiptHash);
  await retain('inputs/optional-loading.json', optionalBytes);
  for (const command of record.buildProvenance.commands) await retain(`source-build/${command.log}`, await readFile(join(optionalDirectory, command.log)));
  for (const [file, hash] of Object.entries(record.buildProvenance.outputs)) {
    const bytes = await readFile(file);
    if (digest(bytes) !== hash) throw Error(`Current workload source build drift: ${file}`);
    await retain(`source-build/${file}`, bytes);
  }
  await mkdir(join(temporary, 'wasm'));
  await build({ stdin: { contents: 'export {createEditor,taskPreset,CheckpointStorage} from "@edit-ac/web"; export {init} from "@edit-ac/core"; export {contentModules} from "@edit-ac/web";', resolveDir: root },
    outfile: join(temporary, 'sdk.js'), bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022' });
  for (const file of ['sdk.js']) await retain(`harness/${file}`, await readFile(join(temporary, file)));
  for (const file of ['editac_wasm.js', 'editac_wasm_bg.wasm', 'editac_runtime.js']) {
    await copyFile(`packages/core/dist/wasm/${file}`, join(temporary, 'wasm', file));
    await retain(`harness/wasm/${file}`, await readFile(join(temporary, 'wasm', file)));
  }
  for (const file of ['workload-client.mjs', 'workloads.mjs', 'fixtures.mjs', 'presets.mjs', 'workload-image.png']) {
    await copyFile(`benchmarks/${file}`, join(temporary, file)); await retain(`harness/${file}`, await readFile(`benchmarks/${file}`));
  }
  const html = '<!doctype html><meta charset="utf-8"><title>PRF-04</title><style>body{margin:24px}#outer{width:900px;height:360px;overflow:auto;border:1px solid}#inner{margin:16px;height:240px;overflow:auto}#editor{font:16px/1.5 sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}#after{height:600px}</style><div id="outer"><div id="inner"><div id="editor"></div></div><div id="after"></div></div>';
  await writeFile(join(temporary, 'index.html'), html); await retain('harness/index.html', html);
  inspectWorkloadBuild(record, optionalRecord);
  await verifyPins(root, record.sourceInputs);
  server = await startFixtureServer({ fixtureDirectory: temporary });
  record.metadata.server = { pid: process.pid, port: server.port, workspace: root, purpose: 'PRF-04', log: output };
  controller = await chromium.launchServer({ headless: true });
  record.metadata.browserProcess = { pid: controller.process().pid, launcher: controller.process().spawnfile, purpose: 'PRF-04', workspace: root, log: output };
  browser = await chromium.connect(controller.wsEndpoint()); record.metadata.browser = browser.version();
  for (const scale of profile.scales) for (const kind of profile.workloads) {
    const document = workload(profile, scale, kind), docBytes = JSON.stringify(document), fixtureHash = digest(docBytes);
    await retain(`fixtures/${scale}-${kind}.json`, docBytes);
    let frozen, checkpointHash;
    const preparation = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    try {
      const page = await preparation.newPage();
      await preparation.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
      await page.goto(server.url);
      await page.addScriptTag({ type: 'module', content: 'import * as workloads from "/fixture/workload-client.mjs"; window.workloads=workloads;' });
      await page.waitForFunction(() => !!window.workloads);
      frozen = await page.evaluate(({ profile, scale, kind }) => window.workloads.prepare(profile, scale, kind), { profile, scale, kind });
      const bytes = JSON.stringify(frozen); checkpointHash = digest(bytes); await retain(`fixtures/${scale}-${kind}.checkpoint.json`, bytes);
    } finally { await preparation.close(); }
    for (const preset of profile.presets) {
      if (interrupted) throw Error('Workload run interrupted');
      console.log(`${scale}/${kind}/${preset} → ${output}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', hasTouch: tableAccessibility });
      const item = { scale, kind, preset, features: [...presets[preset].featureSet, ...(kind === 'images' || kind === 'table-selection' ? ['content-modules'] : [])], fixtureHash, samples: [] };
      record.cases.push(item);
      try {
        const page = await context.newPage(); page.setDefaultTimeout(120000);
        item.errors = []; item.requests = [];
        page.on('pageerror', error => item.errors.push(error.message));
        await context.route('**/*', route => { const url = new URL(route.request().url()); item.requests.push({ pathname: url.pathname, sameOrigin: url.origin === new URL(server.url).origin }); return url.origin === new URL(server.url).origin ? route.continue() : route.abort(); });
        const cdp = await context.newCDPSession(page);
        await page.exposeFunction('workloadHeap', () => cdp.send('Runtime.getHeapUsage'));
        if (tableAccessibility && kind === 'table-selection') {
          await cdp.send('Accessibility.enable');
          await page.exposeFunction('workloadTableInput', index => replayTableInput(page, cdp, profile, scale, index));
        }
        await page.goto(server.url);
        await page.addScriptTag({ type: 'module', content: 'import * as workloads from "/fixture/workload-client.mjs"; window.workloads=workloads;' });
        await page.waitForFunction(() => !!window.workloads);
        item.checkpointHash = checkpointHash;
        const raw = await page.evaluate(({ profile, scale, kind, preset, frozen }) => window.workloads.run(profile, scale, kind, preset, frozen), { profile, scale, kind, preset, frozen });
        Object.assign(item, raw); item.semanticHash = digest(raw.initialSemantics ?? 'missing'); item.finalSemanticHash = digest(raw.finalSemantics ?? 'missing');
        if (item.tableAccessibility) {
          for (const [index, entry] of (item.tableAccessibility.persistedJournal?.entries ?? []).entries()) {
            const bytes = Buffer.from(entry.payload, 'base64');
            if (bytes.length !== entry.byteLength || digest(bytes) !== entry.checksum) throw Error('Persisted journal payload identity mismatch');
            entry.file = `journal/${scale}-${preset}/${index}.bin`;
            await retain(entry.file, bytes); delete entry.payload;
          }
          item.tableAccessibility.reopenHash = digest(item.tableAccessibility.reopenSemantics ?? 'missing');
          delete item.tableAccessibility.reopenSemantics;
        }
        item.expectedSemanticHash = digest(canonicalWorkload(expectedWorkload(document))); delete item.initialSemantics; delete item.finalSemantics;
        if (raw.failure) record.errors.push(`${scale}/${kind}/${preset}: ${raw.failure}`);
        record.counts.executed++; record.counts.skipped--;
        try { inspectWorkload(profile, item); record.counts.passed++; }
        catch (error) { record.counts.failed++; record.errors.push(`${scale}/${kind}/${preset}: ${error.message}`); }
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
try {
  await verifyPins(root, record.sourceInputs);
  if (digest(await readFile(resolve(root, '../architecture/specs/verification.md'))) !== digest(verificationPolicy)) throw Error('Verification policy changed during measurement');
  validateWorkloadPolicy(fitnessPolicy, record);
  inspectWorkloadBuild(record);
  record.observations = inspectWorkloads(profile, record);
}
catch (error) { record.errors.push(error.message); }
if (record.errors.length) record.status = 'failed'; else record.status = 'diagnostic';
await writeFile(join(output, 'results.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, counts: record.counts, errorCount: record.errors.length, output }));
if (record.errors.length) process.exitCode = 1;
