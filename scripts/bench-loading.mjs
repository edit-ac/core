import { readFile, writeFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, sep } from 'node:path';
import { tmpdir, cpus, totalmem, platform, arch, release } from 'node:os';
import { chromium } from 'playwright';
import { digest } from './architecture-budgets.mjs';
import { admitMeasuredConsumer } from './consumers-loading.mjs';
import { inspectLoading, loadingInputs, summarizeLoading } from './loading-evidence.mjs';
import { presets } from '../benchmarks/presets.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';
import { requireTestNode } from './test-toolchain.mjs';
import { layoutProbeCss, installLayoutProbe, runLayoutAction } from './loading-layout-probe.mjs';
import { startRenderTrace } from './loading-render-attribution.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)); process.chdir(root); await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--seed-directory' || args[2] !== '--output') throw Error('Expected --seed-directory <retained owning directory> --output <unique directory>');
const seeds = resolve(args[1]), output = resolve(args[3]);
const commandTrace = process.env.EDITAC_LOADING_COMMAND_TRACE === '1';
const engineTrace = process.env.EDITAC_LOADING_ENGINE_TRACE === '1';
const layoutProbe = process.env.EDITAC_LOADING_LAYOUT_PROBE;
const probeCss = layoutProbe ? layoutProbeCss(layoutProbe) : '';
const renderTrace = process.env.EDITAC_LOADING_RENDER_TRACE === '1';
if (engineTrace && !commandTrace) throw Error('Internal attribution requires the command observer');
if (!relative(root, output) || relative(root, output).startsWith('..')) throw Error('Retain output inside repository');
await mkdir(output, { recursive: false });
const profileBytes = await readFile('benchmarks/profiles/loading-v1.json'), profile = JSON.parse(profileBytes);
const record = { version: 1, qualification: 'unqualified', profileHash: digest(profileBytes), metadata: {
  startedAt: new Date().toISOString(), command: [process.execPath, ...process.argv.slice(1)], revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), hostOS: `${platform()}/${release()}/${arch()}`, provenance: 'headless-browser-on-host', node: process.version,
  commandAttribution: commandTrace ? 'packed-observer-exports-v1' : 'none', engineAttribution: engineTrace ? 'fitness-preparation-v1' : 'none',
  ...(layoutProbe ? { layoutProbe: `experimental-${layoutProbe}-v1`, accessibilityMode: 'cdp-enabled-before-navigation-owner-stages-v2', axStageProbes: process.env.EDITAC_LOADING_AX_STAGES === '1' } : {}),
  renderAttribution: renderTrace ? 'cdp-rendering-v1' : 'none',
  phaseAttribution: profile.phaseAttribution, phaseScope: profile.phaseScope, replay: profile.replay, cacheScope: profile.cacheScope, timingScope: profile.timingScope, coverageMethod: profile.coverageMethod, warmupPolicy: profile.warmupPolicy, sampleOrder: profile.sampleOrder },
  counts: { executed: 0, passed: 0, failed: 0, skipped: 24 }, cases: [], sourceInputs: {}, artifacts: {}, errors: [], cleanup: {} };
for (const path of loadingInputs) record.sourceInputs[path] = digest(await readFile(path));
const temp = await mkdtemp(join(tmpdir(), 'editac-prf06-'));
let browser, controller, server;
const stop = () => { void browser?.close(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function retain(path, bytes) { await mkdir(join(output, path, '..'), { recursive: true }); await writeFile(join(output, path), bytes); record.artifacts[path] = digest(bytes); }
try {
  if (layoutProbe) { await retain('ax-coverage-source.mjs', await readFile('scripts/loading-ax-coverage.mjs')); await retain('experiment.css', probeCss); await retain('layout-probe-source.mjs', await readFile('scripts/loading-layout-probe.mjs')); }
  const packed = spawnSync(process.execPath, ['scripts/check-browser-size.mjs'], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, EDITAC_BROWSER_SIZE_OUTPUT: join(output, 'packed') } });
  await retain('packed.log', (packed.stdout || '') + (packed.stderr || ''));
  if (packed.status !== 0 || packed.error) throw Error(`Packed measurement failed: ${packed.status} ${packed.error || ''}`);
  record.consumer = await admitMeasuredConsumer(join(output, 'packed'));
  const manifest = JSON.parse(await readFile(join(output, 'packed/manifest.json')));
  for (const path of ['manifest.json', 'metafile.json', ...manifest.packs.map(p => p.filename), ...manifest.assets.map(a => `artifacts/${a.name}`)]) await retain(`packed/${path}`, await readFile(join(output, 'packed', path)));
  await cp(join(output, 'packed/artifacts'), join(temp, 'assets'), { recursive: true });
  if (commandTrace) for (const path of ['task.js', 'metafile.json']) {
    const bytes = await readFile(join(output, 'packed/diagnostic', path)); await retain(`diagnostic/${path}`, bytes);
    await mkdir(join(temp, 'diagnostic'), { recursive: true }); await writeFile(join(temp, 'diagnostic', path), bytes);
  }
  if (engineTrace) for (const path of ['editac_wasm.js', 'editac_wasm_bg.wasm', 'editac_runtime.js']) {
    const bytes = await readFile(join(root, 'target/fitness-runtime', path));
    await retain(`diagnostic/${path}`, bytes);
    if (path.endsWith('.wasm')) await writeFile(join(temp, 'assets/wasm', path), bytes);
  }
  for (const path of ['loading-client.mjs', 'loading-command-attribution.mjs', 'loading-startup-attribution.mjs', 'fixtures.mjs']) { const bytes = await readFile(`benchmarks/${path}`); await retain(`harness/${path}`, bytes); await mkdir(join(temp, 'harness'), { recursive: true }); await writeFile(join(temp, 'harness', path), bytes); }
  await mkdir(join(temp, 'corpus'));
  const seedBytes = await readFile(join(seeds, 'results.json'));
  record.seedEvidence = { directory: relative(root, seeds), resultsHash: digest(seedBytes) };
  const seedRecord = JSON.parse(seedBytes);
  const frozen = {};
  for (const name of profile.fixtures) { const bytes = await readFile(join(seeds, 'fixtures', `${name}.checkpoint.json`)); if (seedRecord.artifacts[`fixtures/${name}.checkpoint.json`] !== digest(bytes)) throw Error('Checkpoint differs from retained owning evidence'); frozen[name] = JSON.parse(bytes); await retain(`fixtures/${name}.checkpoint.json`, bytes); await writeFile(join(temp, 'corpus', `${name}.checkpoint.json`), bytes); }
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        const name = url.searchParams.get('name'), preset = url.searchParams.get('preset'), mode = url.searchParams.get('mode');
        if (!profile.fixtures.includes(name) || !profile.presets.includes(preset) || !['cold','warm'].includes(mode)) throw Error('Unknown replay');
        const options = { name, preset, mode, databaseName: url.searchParams.get('database'), identity: frozen[name].identity };
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture/assets/task.css">${layoutProbe ? `<style>${probeCss}</style>` : ''}<div id="editor" style="width:900px;height:360px;overflow:auto"></div><script type="importmap">{"imports":{"@loading/sdk":"/fixture/${commandTrace ? 'diagnostic' : 'assets'}/task.js"}}</script><script id="options" type="application/json">${JSON.stringify(options)}</script><script type="module" src="/fixture/harness/loading-client.mjs"></script>`); return;
      }
      const path = resolve(temp, decodeURIComponent(url.pathname).replace(/^\/fixture\//, ''));
      if (!path.startsWith(temp + sep) || !url.pathname.startsWith('/fixture/')) throw Error('Invalid path');
      const bytes = await readFile(path); res.writeHead(200, { 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'public,max-age=3600' }); res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  record.metadata.server = { pid: process.pid, port: server.address().port, workspace: root, purpose: 'PRF-06', log: output };
  controller = await chromium.launchServer({ headless: true }); browser = await chromium.connect(controller.wsEndpoint()); record.metadata.browser = browser.version();
  record.metadata.browserProcess = { pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: root, purpose: 'PRF-06', log: output };
  for (const name of profile.fixtures) for (const preset of profile.presets) {
    const item = { fixture: name, preset, features: presets[preset].featureSet, textBytes: fixture(name).textBytes, fixtureHash: digest(JSON.stringify(fixture(name))), checkpointHash: record.artifacts[`fixtures/${name}.checkpoint.json`], pairs: [], errors: [] }; record.cases.push(item);
    console.log(`${name}/${preset}: ${profile.samplePairs} cold/warm pairs`);
    for (let index = 0; index < profile.samplePairs; index++) {
      if (index % 10 === 0) console.log(`${name}/${preset} pair ${index}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(120000); const cdp = await context.newCDPSession(page);
        if (layoutProbe) {
          await cdp.send('Accessibility.enable');
          await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
          await page.exposeBinding('__loadingLayoutAction', (_, action, data) => runLayoutAction(page, cdp, action, data));
          await page.addInitScript(installLayoutProbe, { enabled: index === 0, stages: process.env.EDITAC_LOADING_AX_STAGES === '1' });
        }
        await cdp.send('Network.enable'); await cdp.send('Profiler.enable');
        if (renderTrace) await cdp.send('Performance.enable');
        const requests = [], responses = [];
        cdp.on('Network.requestWillBeSent', e => requests.push({ url: e.request.url, type: e.type }));
        cdp.on('Network.responseReceived', e => responses.push({ url: new URL(e.response.url).pathname, status: e.response.status, fromDiskCache: !!e.response.fromDiskCache, fromServiceWorker: !!e.response.fromServiceWorker }));
        page.on('pageerror', e => item.errors.push(e.message));
        const pair = { index }; await writeFile(join(output, 'progress.json'), JSON.stringify({ fixture: name, preset, index, at: new Date().toISOString() })); item.pairs.push(pair);
        for (const mode of ['cold','warm']) {
          requests.length = responses.length = 0;
          const finishRender = renderTrace ? await startRenderTrace(cdp) : undefined;
          // Best-effort coverage avoids recompiling/instrumenting the WASM engine during startup.
          await page.goto(`${origin}/?name=${name}&preset=${preset}&mode=${mode}&database=prf06-${name}-${preset}-${index}`);
          await page.waitForFunction(() => !!window.loadingRun);
          let deadline;
          const raw = await Promise.race([page.evaluate(() => window.loadingRun), new Promise((_, fail) => { deadline = setTimeout(() => fail(Error(`Loading deadline: ${name}/${preset}/${index}/${mode}`)), profile.pageDeadlineMs); })]).finally(() => clearTimeout(deadline));
          if (raw.layoutProbe) await retain(`behavior/${name}-${preset}-${mode}.json`, JSON.stringify(raw.layoutProbe));
          if (finishRender) raw.renderTrace = await finishRender(raw);
          const coverage = await cdp.send('Profiler.getBestEffortCoverage');
          raw.scripts = coverage.result.filter(s => s.url.startsWith(origin) && s.functions.some(f => f.ranges.some(r => r.count > 0))).map(s => ({ url: new URL(s.url).pathname, hash: record.artifacts[s.url.includes('/diagnostic/') ? 'diagnostic/' + new URL(s.url).pathname.split('/diagnostic/')[1] : s.url.includes('/assets/') ? 'packed/artifacts/' + new URL(s.url).pathname.split('/assets/')[1] : 'harness/' + new URL(s.url).pathname.split('/harness/')[1]] })); raw.requests = [...requests]; raw.responses = [...responses];
          raw.coverage = coverage.result.filter(s => s.url.startsWith(origin)).map(s => ({ url: new URL(s.url).pathname, functions: s.functions.map(f => ({ ranges: f.ranges })) }));
          if (requests.some(r => new URL(r.url).origin !== origin) || responses.some(r => r.status >= 400 || r.fromServiceWorker)) throw Error('Unexpected network boundary');
          raw.requests = raw.requests.map(r => ({ ...r, url: new URL(r.url).pathname })); pair[mode] = raw;
        }
        await page.evaluate(async database => { await new Promise((ok, fail) => { const r = indexedDB.deleteDatabase(database); r.onsuccess = ok; r.onerror = () => fail(r.error); r.onblocked = () => fail(Error('Database deletion blocked')); }); }, `prf06-${name}-${preset}-${index}`);
        pair.databaseDeleted = true;
      } finally { await context.close(); }
    }
    await retain(`raw/${name}-${preset}.json`, JSON.stringify(item));
    for (const kind of profile.requiredObservations) { record.counts.executed++; record.counts.skipped--; try { inspectLoading(profile, record, item, kind); record.counts.passed++; } catch (e) { record.counts.failed++; record.errors.push(`${name}/${preset}/${kind}: ${e.message}`); } }
  }
} catch (e) { record.errors.push(e.stack); }
finally {
  try { await browser?.close(); await controller?.close(); record.cleanup.browserExited = !controller || (controller.process().exitCode !== null || controller.process().signalCode !== null); } catch (e) { record.errors.push(e.message); }
  if (server) { server.closeAllConnections(); await new Promise(ok => server.close(ok)); } record.cleanup.serverClosed = true;
  await rm(temp, { recursive: true, force: true }); record.cleanup.temporaryRemoved = true;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
if (layoutProbe) {
  const cases = record.cases.flatMap(item => item.pairs.flatMap(pair => ['cold', 'warm'].flatMap(mode => pair[mode]?.layoutProbe?.cases ?? [])));
  record.layoutProbeCounts = { executed: cases.length, passed: cases.filter(c => c.status === 'passed').length, failed: cases.filter(c => c.status === 'failed').length, skipped: Math.max(0, 64 - cases.length) };
  if (record.layoutProbeCounts.executed !== 64 || record.layoutProbeCounts.failed || record.layoutProbeCounts.skipped) record.errors.push('Incomplete/failed experimental layout behavior; see retained behavior artifacts');
}
await retain('summary.json', JSON.stringify(summarizeLoading(profile, record), null, 2));
record.status = record.errors.length ? 'failed' : 'diagnostic';
await writeFile(join(output, 'results.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, counts: record.counts, errors: record.errors, output })); if (record.errors.length) process.exitCode = 1;
