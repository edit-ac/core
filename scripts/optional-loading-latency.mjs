import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir, cpus, totalmem, platform, release, arch } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { digest } from './architecture-budgets.mjs';
import { inspectStartupPhases } from './loading-evidence.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';
import { presets } from '../benchmarks/presets.mjs';

export const optionalLatencyInputs = ['scripts/optional-loading-latency.mjs', 'scripts/loading-evidence.mjs',
  'benchmarks/optional-loading-sdk.mjs', 'benchmarks/loading-client.mjs', 'benchmarks/loading-command-attribution.mjs',
  'benchmarks/loading-startup-attribution.mjs', 'benchmarks/fixtures.mjs', 'benchmarks/presets.mjs', 'benchmarks/profiles/loading-v1.json'];
const finite = n => Number.isFinite(n) && n >= 0;
const sha = n => typeof n === 'string' && /^[0-9a-f]{64}$/.test(n);
const modes = ['cold', 'warm'];
const keys = ['Task/baseline', 'Task/task', 'Long/baseline', 'Long/task'];
export async function waitForOptionalBootstrap(page) {
  // Module readiness does not require a rendering opportunity. Keep the
  // existing bootstrap deadline even when the browser suspends animation frames.
  await page.waitForFunction(() => !!window.loadingRun, undefined, { polling: 100, timeout: 30000 });
}
function policyCheck(p) {
  assert.equal(p.id, 'loading-v1'); assert.equal(p.version, 1);
  assert.deepEqual(p.fixtures, ['Task', 'Long']); assert.deepEqual(p.presets, ['baseline', 'task']);
  assert.equal(p.samplePairs, 12); assert.equal(p.minimumTailSamples, 100);
  assert.equal(p.legacyColdLimitMs, 300); assert.deepEqual(p.warmLimitsMs, { Task: 50, Long: 200 });
  assert.equal(p.pageDeadlineMs, 120000);
}
export function inspectOptionalLatency(record, policy, packs) {
  policyCheck(policy);
  assert.equal(record.version, 1); assert.equal(record.status, 'diagnostic');
  assert.equal(record.profileHash, digest(JSON.stringify(policy))); // semantic policy identity plus retained bytes below
  assert.deepEqual(record.errors, []);
  assert.deepEqual(record.counts, { executed: 192, passed: 192, failed: 0, skipped: 0 });
  assert.equal(record.cleanup.browserExited, true); assert.equal(record.cleanup.serverClosed, true); assert.equal(record.cleanup.temporaryRemoved, true);
  for (const key of ['cpu', 'hostOS', 'browser', 'node', 'provenance']) assert.equal(typeof record.metadata[key], 'string');
  assert(record.metadata.cores > 0 && record.metadata.memoryBytes > 0);
  assert.equal(record.metadata.provenance, 'headless-browser-on-host');
  assert(Date.parse(policy.reviewedAt) < Date.parse(record.metadata.startedAt), 'Policy must precede measurement');
  assert.equal(record.metadata.cacheScope, policy.cacheScope); assert.equal(record.metadata.timingScope, policy.timingScope);
  assert(sha(record.seedEvidence.resultsHash));
  assert.deepEqual(record.cases.map(c => `${c.profile}/${c.fixture}/${c.preset}`), ['default', 'markdown'].flatMap(p => keys.map(k => `${p}/${k}`)), 'Missing/reordered optional matrix');
  const summaries = [];
  for (const item of record.cases) {
    const expected = fixture(item.fixture), enabled = item.profile === 'markdown';
    assert.equal(item.fixtureHash, digest(JSON.stringify(expected))); assert.equal(item.textBytes, expected.textBytes);
    assert.deepEqual(item.features, [...presets[item.preset].featureSet, ...(enabled ? ['markdown'] : [])]);
    assert(sha(item.checkpointHash)); assert.equal(item.checkpointHash, record.checkpoints[item.fixture]);
    assert.deepEqual(item.pairs.map(p => p.index), Array.from({ length: policy.samplePairs }, (_, i) => i));
    for (const pair of item.pairs) {
      assert.equal(pair.databaseDeleted, true);
      assert.equal(pair.cold.initialHash, pair.warm.initialHash, 'Warm source differs from acknowledged cold restore');
      for (const mode of modes) {
        const raw = pair[mode];
        assert(sha(raw.initialHash)); assert.equal(raw.initialHash, raw.finalHash); assert.equal(raw.sourcePreserved, true); assert.equal(raw.persisted, true);
        inspectStartupPhases(raw, mode);
        for (const key of ['moduleMs', 'initMs', 'restoreMs', 'readyMs', 'firstFrameMs', 'acceptedEditMs', 'commandRestoreMs']) assert(finite(raw.samples[key]));
        assert(raw.samples.moduleMs <= raw.samples.readyMs && raw.samples.readyMs <= raw.samples.firstFrameMs && raw.samples.firstFrameMs <= raw.samples.acceptedEditMs);
        assert.equal(raw.commands.length, 0, 'Instrumented distribution cannot qualify ordinary optional costs');
        assert.deepEqual(raw.errors, []);
        assert.equal(raw.optional.enabled, enabled); assert.equal(raw.optional.mounts, 1);
        for (const key of ['init', 'firstUse']) {
          const phase = raw.optional[key];
          if (!enabled) assert.equal(phase, null, 'Disabled provider executed');
          else {
            assert(phase && finite(phase.startMs) && finite(phase.endMs) && finite(phase.durationMs));
            assert(phase.startMs <= phase.endMs && phase.endMs <= raw.samples.moduleMs);
            assert(Math.abs(phase.endMs - phase.startMs - phase.durationMs) < 1e-6);
          }
        }
        if (enabled) { assert.equal(raw.optional.firstUse.roundTrip, true); assert(raw.optional.init.endMs <= raw.optional.firstUse.startMs); }
        const assets = packs[item.profile].assets;
        assert.deepEqual(raw.assets, assets.map(a => ({ name: a.name, sha256: a.sha256 })), 'Different executed distribution');
        const allowed = new Set(assets.map(a => '/fixture/assets/' + a.name));
        for (const request of raw.requests) assert(allowed.has(request.path) || request.path === '/' || request.path.startsWith('/fixture/harness/') || request.path === `/fixture/corpus/${item.fixture}.checkpoint.json`, 'Unexpected network request');
        assert(raw.requests.every(r => r.sameOrigin) && raw.responses.every(r => r.status < 400 && !r.fromServiceWorker), 'Failed/external network boundary');
        assert.equal(raw.requests.some(r => r.path.includes('markdown')), enabled, 'Disabled/eager or missing enabled parser fetch');
        for (const asset of assets.filter(a => a.kind !== 'css')) {
          const path = '/fixture/assets/' + asset.name;
          assert(raw.requests.some(r => r.path === path), 'Missing asset request');
          const timing = raw.resourceTimings.find(r => r.name === path);
          assert(timing && timing.decodedBodySize > 0, 'Missing transfer/cache timing');
          assert(mode === 'cold' ? timing.transferSize > 0 : timing.transferSize === 0, 'Incorrect cold/warm cache provenance');
        }
      }
    }
    const median = values => { const sorted = values.sort((a, b) => a - b); return (sorted[5] + sorted[6]) / 2; };
    const samples = mode => median(item.pairs.map(p => p[mode].samples.acceptedEditMs));
    const optional = Object.fromEntries(modes.map(mode => [mode, enabled ? Object.fromEntries(['init', 'firstUse'].map(phase => [phase + 'P50Ms', median(item.pairs.map(p => p[mode].optional[phase].durationMs))])) : null]));
    summaries.push({ profile: item.profile, fixture: item.fixture, preset: item.preset,
      coldP50Ms: samples('cold'), warmP50Ms: samples('warm'), optional,
      coldLimitMs: policy.legacyColdLimitMs, warmLimitMs: policy.warmLimitsMs[item.fixture],
      coldWithinLimit: samples('cold') <= policy.legacyColdLimitMs, warmWithinLimit: samples('warm') <= policy.warmLimitsMs[item.fixture],
      samplesPerMode: 12, p95Ms: null, p99Ms: null, tails: 'inconclusive' });
  }
  return { cases: summaries, qualification: 'unqualified', scope: 'Packed disabled/enabled Markdown initialization/first use and full-corpus startup observations; harness/oracle overhead included. No tail, compositor, memory, highlighter or target-platform qualification.' };
}

export async function produceOptionalLatency(root, output, seedDirectory, packs) {
  const policyBytes = await readFile(join(root, 'benchmarks/profiles/loading-v1.json')), policy = JSON.parse(policyBytes);
  policyCheck(policy);
  const directory = join(output, 'latency'); await mkdir(directory);
  const record = { version: 1, status: 'failed', profileHash: digest(JSON.stringify(policy)), metadata: {
    startedAt: new Date().toISOString(), cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), hostOS: `${platform()}/${release()}/${arch()}`,
    node: process.version, provenance: 'headless-browser-on-host', cacheScope: policy.cacheScope, timingScope: policy.timingScope },
    counts: { executed: 0, passed: 0, failed: 0, skipped: 192 }, checkpoints: {}, cases: [], errors: [], cleanup: {} };
  await writeFile(join(directory, 'loading-policy.json'), policyBytes);
  const seeds = resolve(seedDirectory), seedBytes = await readFile(join(seeds, 'results.json')), seed = JSON.parse(seedBytes);
  record.seedEvidence = { directory: relative(root, seeds), resultsHash: digest(seedBytes) };
  const temp = await mkdtemp(join(tmpdir(), 'editac-optional-latency-'));
  let controller, browser, server;
  const stop = () => { void browser?.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await mkdir(join(temp, 'harness')); await mkdir(join(temp, 'corpus'));
    for (const name of ['loading-client.mjs', 'loading-command-attribution.mjs', 'loading-startup-attribution.mjs', 'fixtures.mjs', 'optional-loading-sdk.mjs']) await cp(join(root, 'benchmarks', name), join(temp, 'harness', name));
    for (const name of policy.fixtures) {
      const bytes = await readFile(join(seeds, 'fixtures', name + '.checkpoint.json'));
      assert.equal(digest(bytes), seed.artifacts[`fixtures/${name}.checkpoint.json`], 'Changed retained checkpoint');
      record.checkpoints[name] = digest(bytes); await writeFile(join(temp, 'corpus', name + '.checkpoint.json'), bytes);
      await writeFile(join(directory, name + '.checkpoint.json'), bytes);
    }
    let activeProfile;
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
          const options = JSON.parse(url.searchParams.get('options'));
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
          res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture/assets/task.css"><div id="editor" style="width:900px;height:360px;overflow:auto"></div><script type="importmap">{"imports":{"@loading/sdk":"/fixture/harness/optional-loading-sdk.mjs"}}</script><script id="options" type="application/json">${JSON.stringify(options)}</script><script type="module" src="/fixture/harness/loading-client.mjs"></script>`); return;
        }
        const path = resolve(temp, url.pathname.replace(/^\/fixture\//, ''));
        assert(url.pathname.startsWith('/fixture/') && path.startsWith(temp + sep));
        const bytes = await readFile(path);
        res.writeHead(200, { 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'public,max-age=3600' }); res.end(bytes);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${server.address().port}`;
    record.metadata.server = { pid: process.pid, port: server.address().port, workspace: root, purpose: 'optional PRF-06 latency', log: directory };
    controller = await chromium.launchServer({ headless: true }); browser = await chromium.connect(controller.wsEndpoint()); record.metadata.browser = browser.version();
    record.metadata.browserProcess = { pid: controller.process().pid, launcher: controller.process().spawnfile, workspace: root, purpose: 'optional PRF-06 latency', log: directory };
    for (const profile of ['default', 'markdown']) {
      activeProfile = profile;
      await cp(join(output, activeProfile, 'artifacts'), join(temp, 'assets'), { recursive: true });
      // These are clean per-profile trees: no enabled file can leak into default.
      for (const name of policy.fixtures) for (const preset of policy.presets) {
        const item = { profile, fixture: name, preset, features: [...presets[preset].featureSet, ...(profile === 'markdown' ? ['markdown'] : [])],
          textBytes: fixture(name).textBytes, fixtureHash: digest(JSON.stringify(fixture(name))), checkpointHash: record.checkpoints[name], pairs: [] }; record.cases.push(item);
        console.log(`optional latency ${profile}/${name}/${preset}: 12 cold/warm pairs`);
        for (let index = 0; index < policy.samplePairs; index++) {
          await writeFile(join(directory, 'progress.json'), JSON.stringify({ profile, name, preset, index, at: new Date().toISOString() }));
          const context = await browser.newContext(), page = await context.newPage();
          const pair = { index }; item.pairs.push(pair);
          try {
            for (const mode of modes) {
              const requests = [], responses = [], errors = [], failedRequests = [];
              const onRequest = req => { const url = new URL(req.url()); requests.push({ path: url.pathname, sameOrigin: url.origin === origin }); };
              const onResponse = res => responses.push({ path: new URL(res.url()).pathname, status: res.status(), fromServiceWorker: res.fromServiceWorker() });
              const onError = e => errors.push(e.message);
              const onFailedRequest = req => failedRequests.push({ path: new URL(req.url()).pathname, error: req.failure()?.errorText });
              page.on('request', onRequest); page.on('response', onResponse); page.on('pageerror', onError); page.on('requestfailed', onFailedRequest);
              let deadline;
              record.counts.executed++; record.counts.skipped--;
              try {
                const frozen = JSON.parse(await readFile(join(temp, 'corpus', name + '.checkpoint.json')));
                const options = { name, preset, mode, databaseName: `optional-${profile}-${name}-${preset}-${index}`, identity: frozen.identity, optional: profile === 'markdown' };
                await page.goto(`${origin}/?options=${encodeURIComponent(JSON.stringify(options))}`);
                await waitForOptionalBootstrap(page);
                pair[mode] = await Promise.race([page.evaluate(async () => ({ ...await window.loadingRun, optional: window.optionalLoading })), new Promise((_, fail) => { deadline = setTimeout(() => fail(Error('Optional latency deadline')), policy.pageDeadlineMs); })]);
                Object.assign(pair[mode], { requests, responses, errors, assets: packs[profile].assets.map(a => ({ name: a.name, sha256: a.sha256 })) });
                assert.deepEqual(errors, []); record.counts.passed++;
              } catch (error) {
                await writeFile(join(directory, 'failed-observation.json'), JSON.stringify({ profile, name, preset, index, mode,
                  error: error.stack, requests, responses, errors, failedRequests, pageClosed: page.isClosed() }, null, 2) + '\n');
                throw error;
              } finally { clearTimeout(deadline); page.off('request', onRequest); page.off('response', onResponse); page.off('pageerror', onError); page.off('requestfailed', onFailedRequest); }
            }
            await page.evaluate(database => new Promise((ok, fail) => { const r = indexedDB.deleteDatabase(database); r.onsuccess = () => ok(); r.onerror = () => fail(r.error); r.onblocked = () => fail(Error('Database deletion blocked')); }), `optional-${profile}-${name}-${preset}-${index}`);
            pair.databaseDeleted = true;
          } finally { await context.close(); }
        }
        await writeFile(join(directory, `${profile}-${name}-${preset}.json`), JSON.stringify(item));
      }
      await rm(join(temp, 'assets'), { recursive: true });
    }
  } catch (error) { record.errors.push(error.stack); }
  finally {
    try { await browser?.close(); await controller?.close(); record.cleanup.browserExited = !controller || controller.process().exitCode !== null || controller.process().signalCode !== null; } catch (e) { record.errors.push(e.message); }
    if (server) { server.closeAllConnections(); await new Promise(ok => server.close(ok)); } record.cleanup.serverClosed = true;
    await rm(temp, { recursive: true, force: true }); record.cleanup.temporaryRemoved = true;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  record.counts.failed = record.counts.executed - record.counts.passed;
  if (!record.errors.length) record.status = 'diagnostic';
  try { record.summary = inspectOptionalLatency(record, policy, packs); } catch (error) { record.errors.push(error.stack); record.status = 'failed'; }
  await writeFile(join(directory, 'results.json'), JSON.stringify(record, null, 2) + '\n');
  assert.deepEqual(record.errors, [], 'See optional latency/results.json');
  return record;
}
