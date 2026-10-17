import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describeAsset, budgets, compression } from './browser-size-contract.mjs';
import { admitMeasuredConsumer } from './consumers-loading.mjs';
import { admitSharedReceipt, auditSharedAssets, auditSharedGraph, sharedCases } from './shared-resource-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const engines = ['chromium', 'firefox', 'webkit'];
const productionCases = Object.entries(sharedCases).flatMap(([requirement, names]) =>
  names.filter(name => ['SHR-04', 'SHR-05', 'SHR-06', 'SHR-07'].includes(requirement) && name !== 'url-conflict')
    .map(name => [requirement + '-' + name, { requirement, name }]));
const counts = receipt => {
  assert.deepEqual(receipt.counts, { executed: 13, passed: 13, failed: 0, skipped: 0 }, 'Incomplete packed browser group');
  assert.equal(receipt.cases.length, 13);
  assert(receipt.cleanup.browserExited && receipt.cleanup.serverClosed && receipt.cleanup.consumerRemoved);
  assert.equal(receipt.sourcesUnchanged, true);
};
function sourcePins(target, source) {
  for (const [path, digest] of Object.entries(source)) {
    assert(!target[path] || target[path] === digest, `Different producer source: ${path}`);
    target[path] = digest;
  }
}
function packIdentity(packs) { return packs.map(pack => [pack.name, pack.sha256]).sort(); }
const totals = assets => ({ total: assets.reduce((sum, asset) => sum + asset.gzip, 0), editorJs: assets.filter(asset => asset.kind === 'js').reduce((sum, asset) => sum + asset.gzip, 0) });
function selectedAssets(inventory, transfers) {
  const names = new Set(transfers.map(value => new URL(value.url).pathname));
  for (const name of names) if (/\.(?:js|mjs|css|wasm)$/.test(name)) assert(inventory.some(asset => asset.url === name), `Uncounted delivered resource: ${name}`);
  return inventory.filter(asset => names.has(asset.url));
}
export function siteCosts(production, cases) {
  const route = cases.find(value => value.name === 'SHR-05-client-task-document-back');
  assert(route?.passed);
  const { first, second, third } = route.snapshots[0];
  const task = selectedAssets(production.inventory, first.transfers);
  const union = selectedAssets(production.inventory, third.transfers);
  const incremental = union.filter(asset => !task.some(prior => prior.url === asset.url));
  assert(task.some(asset => asset.role === 'core-wasm') && !task.some(asset => asset.role.startsWith('optional-')));
  assert(incremental.some(asset => asset.role === 'optional-markdown-wasm'));
  assert.equal(second.runtime.realm, third.runtime.realm);
  const mixed = cases.find(value => value.name === 'SHR-04-mixed-bindings');
  const bindings = selectedAssets(production.inventory, mixed.snapshots[0].before.transfers);
  const mixedUnion = [...new Map([...union, ...bindings].map(asset => [asset.url, asset])).values()];
  const report = assets => ({ ...totals(assets), urls: assets.map(asset => asset.url).sort() });
  return { task: report(task), documentUnion: report(union), documentIncrement: report(incremental), mixedBindings: report(bindings), mixedFeatureUnion: report(mixedUnion), compression };
}
export function routeTransfers(cases, cacheProfile) {
  const result = {};
  for (const [name, key] of [['cold', 'cold'], ['warm', 'warm'], ['cache-disabled', 'cacheDisabled']]) {
    const value = cases.find(value => value.name === `SHR-06-${name}-full-navigation`);
    assert(value?.passed && value.cacheProfile === cacheProfile);
    assert(value.persistentCleanup?.closed, 'Persistent HTTP cache profile was not closed');
    const observations = value.snapshots[0].observations;
    assert.deepEqual(observations.map(value => value.route), ['task', 'document', 'task']);
    assert.equal(new Set(observations.map(value => value.runtime.realm)).size, 3);
    const coreRequests = observations.map(value => value.requests.filter(request => /editac_wasm_bg[.-].*\.wasm$/.test(request.url)));
    assert(coreRequests.every(value => value.length === 1), 'Missing/duplicate per-realm core request');
    for (let i = 0; i < observations.length; i++) {
      const observation = observations[i], request = coreRequests[i][0];
      assert.equal(observation.runtime.streaming, observation.route === 'document' ? 2 : 1);
      assert.equal(observation.runtime.buffered, 0);
      assert.equal(observation.evaluations, 1);
      const revalidate = name === 'warm' || name === 'cold' && i > 0;
      assert.equal(request.status, revalidate ? 304 : 200);
      assert(revalidate ? request.bodyBytes === 0 && request.ifNoneMatch : request.bodyBytes > 0 && !request.ifNoneMatch);
      assert.equal(request.cacheControl, 'public, max-age=0, must-revalidate');
      assert.equal(observation.state.live.length, 0);
      assert.equal(observation.state.roots, 0);
      assert(observation.state.reports.every(report => report && !report.unsaved));
    }
    result[key] = { probe: value.name, cacheProfile, routes: observations.map((value, i) => ({ route: value.route, realm: value.runtime.realm, core: coreRequests[i][0], bodyBytes: value.requests.reduce((sum, request) => sum + request.bodyBytes, 0), requests: value.requests.length })) };
  }
  return result;
}

// Additional admission ties the consolidated summary to actual emitted bytes,
// navigation observations and the existing measured-consumer counting harness.
export async function admitSharedSite(directory, root, { prerequisiteOnly = false } = {}) {
  const receipt = await admitSharedReceipt(directory, root, { prerequisiteOnly });
  assert.equal(receipt.complete, !prerequisiteOnly);
  assert.deepEqual(receipt.compression, compression);
  const measured = await admitMeasuredConsumer(join(directory, 'default-task'), { prerequisiteOnly });
  const optional = await admitMeasuredConsumer(join(directory, 'markdown-enabled'), { markdown: true });
  assert.deepEqual(receipt.defaultGzip, totals(measured.assets));
  assert.deepEqual(receipt.optionalGzip, { combined: totals(optional.assets), incremental: { total: totals(optional.assets).total - totals(measured.assets).total, editorJs: totals(optional.assets).editorJs - totals(measured.assets).editorJs } });
  for (const pack of [...measured.packs, ...optional.packs]) assert(receipt.packages.some(value => value.name === '@edit-ac/' + pack.name && value.sha256 === pack.sha256), 'Measured package differs from site runtime');
  const expectedTransfers = {};
  for (const engine of engines) {
    const observation = await json(join(directory, 'production', engine, 'receipt.json'));
    counts(observation);
    const production = observation.production;
    for (const [role, assets, name] of [['core-wasm', measured.assets, 'wasm/editac_wasm_bg.wasm'], ['optional-markdown-wasm', optional.assets, 'wasm/editac_markdown_wasm_bg.wasm']]) {
      const binaries = production.inventory.filter(asset => asset.role === role);
      assert.equal(binaries.length, 1, 'Missing/duplicate emitted binary owner: ' + role);
      assert.equal(binaries[0].kind, 'wasm', 'URL wrapper is not a WASM binary');
      assert.equal(binaries[0].sha256, assets.find(asset => asset.name === name).sha256, 'Emitted binary differs from measured package');
    }
    assert.deepEqual(production.inventory, receipt.assets);
    for (const asset of production.inventory) {
      const bytes = await readFile(join(directory, 'production', engine, 'site', asset.name));
      const actual = describeAsset(asset.name, asset.kind, bytes);
      for (const [field, value] of Object.entries(actual)) assert.equal(asset[field], value, `Changed production ${field}: ${asset.name}`);
      assert.equal(asset.bytes, bytes.length);
      assert.equal(asset.build, production.build);
    }
    assert.equal(production.build, sha(JSON.stringify(observation.packs.map(pack => [pack.name, pack.sha256]))));
    auditSiteGraph(await json(join(directory, 'production', engine, 'production-graph.json')));
    assert.deepEqual(production.eagerGraph, await json(join(directory, 'production', engine, 'negative/eager-graph.json')));
    assert.equal((await readFile(join(directory, 'production', engine, 'negative/eager.js'))).length, production.eagerGraph.outputs['negative/eager.js'].bytes);
    assert.throws(() => auditSharedGraph(production.eagerGraph, { defaultOnly: true }), /Eager optional/);
    const duplicate = await readFile(join(directory, 'production', engine, 'site', production.duplicate.url.slice('/fixture/'.length)));
    assert.equal(sha(duplicate), production.duplicate.sha256);
    assert.throws(() => auditSharedAssets([...production.inventory, production.duplicate]), /Duplicate emitted bytes/);
    const stalePage = await readFile(join(directory, 'production', engine, production.rollover.file));
    assert.equal(sha(stalePage), production.rollover.sha256);
    const rollover = observation.cases.find(value => value.name === 'SHR-07-version-rollover');
    assert.equal(rollover.snapshots[0].stalePage.sha256, production.rollover.sha256);
    assert.equal(rollover.snapshots[0].rejectedBeforeInitialization.streaming, 0);
    assert.deepEqual(rollover.snapshots[0].rejectedBeforeInitialization.wasmFetches, []);
    for (const binding of ['plain', 'react', 'astro', 'mixed-bindings']) {
      const samples = observation.cases.find(value => value.name === 'SHR-04-' + binding).snapshots[0].after.state.timings;
      assert.equal(samples.length, binding === 'mixed-bindings' ? 3 : 1);
      assert(samples.every(sample => Number.isFinite(sample.readyAndFrameMs) && sample.readyAndFrameMs > 0 && Number.isFinite(sample.realmToFrameMs) && sample.realmToFrameMs >= sample.readyAndFrameMs && sample.timingScope.includes('options/runtime/DOM')));
      assert(samples.some(sample => Number.isFinite(sample.acceptedEditMs) && sample.acceptedEditMs >= 0), 'Missing accepted-edit timing');
    }
    assert.deepEqual(receipt.costs[engine], siteCosts(production, observation.cases));
    expectedTransfers[engine] = routeTransfers(observation.cases, 'isolated-persistent-http-profile');
    assert.deepEqual(packIdentity(observation.packs), receipt.packages.map(pack => [pack.name.replace('@edit-ac/', ''), pack.sha256]).sort());
  }
  assert.deepEqual(receipt.transfers, Object.fromEntries(['cold', 'warm', 'cacheDisabled'].map(mode => [mode, Object.fromEntries(engines.map(engine => [engine, expectedTransfers[engine][mode]]))])));
  return receipt;
}
export function auditSiteGraph(graph) {
  const result = auditSharedGraph(graph), owners = new Map();
  for (const [chunk, output] of Object.entries(graph.outputs)) {
    assert(Array.isArray(output.inputs), 'Missing emitted module membership');
    for (const input of output.inputs.filter(path => /node_modules\/@edit-ac\/(?:core|web)\/dist\//.test(path))) {
      assert(!owners.has(input), `Common module emitted in multiple chunks: ${input}`);
      owners.set(input, chunk);
    }
  }
  assert(owners.size > 0, 'Missing common module ownership');
  return result;
}

export async function collectSharedSite(args, { prerequisiteOnly = false } = {}) {
  assert.equal(args.length, 5, 'Expected same-page, production, default, Markdown and unique output directories');
  const [same, site, baseline, markdown, target] = args.map(value => resolve(value));
  await mkdir(target, { recursive: false });
  for (const [from, to] of [[same, 'same-page'], [site, 'production'], [baseline, 'default-task'], [markdown, 'markdown-enabled']]) await cp(from, join(target, to), { recursive: true });
  const partial = await json(join(target, 'same-page/same-page-receipt.json'));
  const measured = await admitMeasuredConsumer(join(target, 'default-task'), { prerequisiteOnly });
  const optional = await admitMeasuredConsumer(join(target, 'markdown-enabled'), { markdown: true });
  const sources = {}, browsers = [], costs = {}, transfers = { cold: {}, warm: {}, cacheDisabled: {} };
  sourcePins(sources, partial.sources);
  let first;
  for (const engine of engines) {
    const observation = await json(join(target, 'production', engine, 'receipt.json')); counts(observation);
    sourcePins(sources, observation.sources);
    if (first) assert.deepEqual(packIdentity(observation.packs), packIdentity(first.packs)); else first = observation;
    const sameBrowser = partial.browsers.find(value => value.engine === engine);
    assert.equal(sameBrowser.version, observation.browser.version);
    const sameObservation = await json(join(target, 'same-page', engine, 'receipt.json')); counts(sameObservation);
    for (const pack of sameObservation.packs) assert(observation.packs.some(value => value.name === pack.name && value.sha256 === pack.sha256), 'Same-page and production packages differ');
    const evidence = `production/${engine}/receipt.json`, evidenceSha256 = sha(await readFile(join(target, evidence)));
    const cases = sameBrowser.cases.map(value => ({ ...value, evidence: 'same-page/' + value.evidence }));
    for (const value of observation.cases) {
      const identity = productionCases.find(([probe]) => probe === value.name)?.[1];
      assert(identity && value.requirement === identity.requirement && value.passed && !value.failure);
      cases.push({ ...identity, passed: true, probe: value.name, evidence, evidenceSha256 });
    }
    browsers.push({ ...observation.browser, cases, failed: 0, skipped: 0, cancelled: 0 });
    costs[engine] = siteCosts(observation.production, observation.cases);
    for (const [mode, value] of Object.entries(routeTransfers(observation.cases, 'isolated-persistent-http-profile'))) transfers[mode][engine] = value;
  }
  for (const path of ['scripts/collect-shared-resources.mjs', 'scripts/shared-site-receipt.mjs', 'scripts/browser-size-contract.mjs', 'scripts/consumers-loading.mjs', 'scripts/check-browser-size.mjs', 'tests/architecture/loading/loading.test.mjs', 'tests/shared-site-receipt.test.mjs', 'contracts/layers.json', 'tests/architecture/loading/README.md']) sources[path] = sha(await readFile(path));
  for (const [path, digest] of Object.entries(sources)) assert.equal(sha(await readFile(path)), digest, `Stale producer: ${path}`);
  const artifacts = {};
  async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) await inventory(path); else artifacts[relative(target, path)] = sha(await readFile(path)); } }
  await inventory(target);
  const packages = first.packs.map(pack => {
    const file = `production/chromium/${pack.file}`;
    const command = spawnSync('tar', ['-xOf', join(target, file), 'package/package.json'], { encoding: 'utf8' }); assert.equal(command.status, 0);
    const metadata = JSON.parse(command.stdout);
    assert.equal(metadata.name, '@edit-ac/' + pack.name);
    return { name: metadata.name, version: metadata.version, file, sha256: pack.sha256 };
  });
  const build = first.production.build;
  const receipt = { version: 1, kind: 'editac.shared-resources', complete: !prerequisiteOnly, provenance: 'actual-packed-browser-runtime',
    ...(prerequisiteOnly ? { scope: 'packed-resource-prerequisite', prerequisiteComplete: true, budgetQualification: 'deferred; exact measured failures retained' } : {}),
    browsers, packages, sources, artifacts, compression, limits: { totalGzip: budgets.total.hard, editorJsGzip: budgets.js.hard },
    defaultGzip: totals(measured.assets), optionalGzip: { combined: totals(optional.assets), incremental: { total: totals(optional.assets).total - totals(measured.assets).total, editorJs: totals(optional.assets).editorJs - totals(measured.assets).editorJs } },
    preferred: { totalGzip: budgets.total.preferred, editorJsGzip: budgets.js.preferred, totalPass: totals(measured.assets).total <= budgets.total.preferred, editorJsPass: totals(measured.assets).editorJs <= budgets.js.preferred },
    graph: { default: 'default-task/metafile.json', enabled: 'production/chromium/production-graph.json' }, assets: first.production.inventory,
    defaultAssets: measured.assets.map(asset => ({ ...asset, bytes: asset.raw, url: `/standalone/${build.slice(0, 16)}/${asset.name}`, build, role: asset.name.endsWith('editac_wasm_bg.wasm') ? 'core-wasm' : 'standalone-' + asset.kind })), costs, transfers };
  await writeFile(join(target, 'shared-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await admitSharedSite(target, process.cwd(), { prerequisiteOnly });
  console.log(JSON.stringify({ directory: relative(process.cwd(), target), cases: browsers.map(browser => ({ engine: browser.engine, passed: browser.cases.length, failed: 0, skipped: 0 })), defaultGzip: receipt.defaultGzip, optionalGzip: receipt.optionalGzip, preferred: receipt.preferred, artifacts: Object.keys(artifacts).length }));
}
