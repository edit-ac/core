import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { budgets } from './browser-size-contract.mjs';
import { sharedResourceSources } from './shared-resource-sources.mjs';

export const sharedCases = Object.freeze({
  'SHR-01': ['equal-description-first', 'equal-comment-first'],
  'SHR-02': ['mixed-description-first', 'mixed-comment-first', 'two-optional'],
  'SHR-03': ['disposed-waiter', 'failure-retry', 'remount', 'pending-save-report', 'optional-failure-retry'],
  'SHR-04': ['plain', 'react', 'astro', 'mixed-bindings', 'ssr'],
  'SHR-05': ['client-task-document-back'],
  'SHR-06': ['cold-full-navigation', 'warm-full-navigation', 'cache-disabled-full-navigation'],
  'SHR-07': ['url-conflict', 'incompatible-build', 'duplicate-detector', 'eager-detector', 'version-rollover'],
  'SHR-08': ['disposed-renderer', 'updated-renderer'],
});
const sha = value => createHash('sha256').update(value).digest('hex');
export function auditSharedAssets(assets, { defaultOnly = false } = {}) {
  assert(Array.isArray(assets) && assets.length > 0, 'Missing shared asset inventory');
  const urls = new Map(), hashes = new Map();
  for (const asset of assets) {
    assert(typeof asset.url === 'string' && asset.url.startsWith('/') && !asset.url.includes('?') && !asset.url.includes('#'), 'Stable versioned asset URL required');
    assert(/^[a-f0-9]{64}$/.test(asset.sha256) && Number.isSafeInteger(asset.bytes) && asset.bytes > 0, 'Missing asset bytes/hash');
    assert(typeof asset.role === 'string' && typeof asset.build === 'string' && asset.build.length, 'Missing asset role/build identity');
    assert(!urls.has(asset.url), `Duplicate emitted URL: ${asset.url}`); urls.set(asset.url, asset);
    const prior = hashes.get(asset.sha256);
    assert(!prior || prior.url === asset.url, `Duplicate emitted bytes under different URLs: ${prior?.url} / ${asset.url}`);
    hashes.set(asset.sha256, asset);
    assert(!defaultOnly || !asset.role.startsWith('optional-'), `Eager optional asset: ${asset.url}`);
  }
  const core = assets.filter(asset => asset.role === 'core-wasm');
  assert.equal(core.length, 1, 'Expected one compatible core WASM owner');
  for (const asset of assets.filter(asset => ['core-glue', 'core-runtime', 'core-wasm'].includes(asset.role))) {
    assert.equal(asset.build, core[0].build, 'Incompatible generated glue/WASM build');
  }
  return { assets: assets.length, bytes: assets.reduce((n, asset) => n + asset.bytes, 0), coreBuild: core[0].build };
}
export function auditSharedGraph(metafile, { defaultOnly = false } = {}) {
  const inputs = Object.keys(metafile?.inputs ?? {});
  assert(inputs.length > 0 && Object.keys(metafile.outputs ?? {}).length > 0, 'Missing/empty production import/chunk graph');
  const owners = name => new Set(inputs.filter(path => path.includes(`node_modules/@edit-ac/${name}/dist/`)).map(path => path.split(`/@edit-ac/${name}/dist/`)[0]));
  assert.equal(owners('core').size, 1, 'Duplicate or missing resolved core package');
  assert.equal(owners('web').size, 1, 'Duplicate or missing resolved web package');
  if (defaultOnly) assert(!inputs.some(path => /node_modules\/@edit-ac\/(?:markdown|highlighting|conversion|cloud)\/|(?:^|\/)katex(?:[./-]|$)|modules\/vendor\/katex/.test(path)), 'Eager optional import in disabled graph');
  return { inputs: inputs.length, outputs: Object.keys(metafile.outputs).length };
}
export function assertSharedMatrix(receipt, { prerequisiteOnly = false } = {}) {
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, 'editac.shared-resources');
  if (prerequisiteOnly) {
    assert.equal(receipt.scope, 'packed-resource-prerequisite');
    assert.equal(receipt.complete, false);
    assert.equal(receipt.prerequisiteComplete, true);
  } else assert.notEqual(receipt.scope, 'packed-resource-prerequisite', 'Prerequisite receipt cannot establish aggregate qualification');
  assert.equal(receipt.provenance, 'actual-packed-browser-runtime', 'Prepared fixtures cannot qualify runtime behavior');
  assert.deepEqual(receipt.browsers.map(value => value.engine).sort(), ['chromium', 'firefox', 'webkit']);
  for (const browser of receipt.browsers) {
    assert(browser.version && browser.playwright === '1.64.0', 'Missing pinned browser identity');
    for (const [requirement, cases] of Object.entries(sharedCases)) for (const name of cases) {
      const matched = browser.cases.filter(value => value.requirement === requirement && value.name === name);
      assert.equal(matched.length, 1, `Missing/duplicate ${browser.engine}/${requirement}/${name}`);
      assert.equal(matched[0].passed, true, `Failed ${browser.engine}/${requirement}/${name}`);
      assert(matched[0].evidence && matched[0].evidenceSha256, 'Missing durable case evidence');
    }
    assert.equal(browser.failed, 0); assert.equal(browser.skipped, 0); assert.equal(browser.cancelled, 0);
  }
  assert.equal(receipt.limits?.totalGzip, budgets.total.hard); assert.equal(receipt.limits?.editorJsGzip, budgets.js.hard);
  assert(receipt.defaultGzip?.total > 0 && (prerequisiteOnly || receipt.defaultGzip.total <= budgets.total.hard));
  assert(receipt.defaultGzip?.editorJs > 0 && (prerequisiteOnly || receipt.defaultGzip.editorJs <= budgets.js.hard));
  assert(receipt.transfers?.cold && receipt.transfers?.warm && receipt.transfers?.cacheDisabled, 'Missing route/cache transfer evidence');
  assert(typeof receipt.graph?.enabled === 'string' && typeof receipt.graph?.default === 'string', 'Missing production graph artifacts');
  for (const name of ['core', 'web', 'react', 'astro', 'markdown']) {
    const matches = (receipt.packages ?? []).filter(value => value.name === `@edit-ac/${name}`);
    assert.equal(matches.length, 1, `Missing/duplicate packed package identity: ${name}`);
    assert(matches[0].version && matches[0].file && /^[a-f0-9]{64}$/.test(matches[0].sha256), 'Invalid package artifact identity');
  }
  auditSharedAssets(receipt.assets);
  auditSharedAssets(receipt.defaultAssets, { defaultOnly: true });
  return receipt;
}
// The canonical consumer must authenticate retained evidence and exact current
// source/artifact pins, not trust a green summary or cache-hidden transfers.
export async function admitSharedReceipt(directory, currentRoot, options = {}) {
  const base = resolve(directory), root = resolve(currentRoot);
  const receipt = assertSharedMatrix(JSON.parse(await readFile(resolve(base, 'shared-receipt.json'), 'utf8')), options);
  const inside = (directory, path) => { const target = resolve(directory, path), rel = relative(directory, target); assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Evidence escaped owner'); return target; };
  assert(Object.keys(receipt.sources ?? {}).length > 0, 'Missing current source identities');
  for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(inside(root, path))), digest, `Stale shared-resource source: ${path}`);
  for (const path of ['scripts/shared-resource-sources.mjs', ...sharedResourceSources(root)]) {
    assert(receipt.sources[path], `Missing current production source: ${path}`);
  }
  assert(Object.keys(receipt.artifacts ?? {}).length > 0, 'Missing retained artifact identities');
  for (const [path, digest] of Object.entries(receipt.artifacts)) assert.equal(sha(await readFile(inside(base, path))), digest, `Stale shared-resource artifact: ${path}`);
  for (const path of ['scripts/shared-resource-contract.mjs', 'packages/core/src/index.ts', 'packages/web/src/editor.ts', 'packages/markdown/src/index.ts']) assert(receipt.sources[path], `Missing current source: ${path}`);
  for (const pack of receipt.packages) assert.equal(receipt.artifacts[pack.file], pack.sha256, 'Unpinned package artifact');
  for (const [mode, path] of Object.entries(receipt.graph)) {
    assert(receipt.artifacts[path], 'Unpinned production graph');
    auditSharedGraph(JSON.parse(await readFile(inside(base, path), 'utf8')), { defaultOnly: mode === 'default' });
  }
  for (const browser of receipt.browsers) for (const value of browser.cases) {
    assert.equal(receipt.artifacts[value.evidence], value.evidenceSha256, 'Unpinned case evidence');
    const observation = JSON.parse(await readFile(inside(base, value.evidence), 'utf8'));
    assert.equal(observation.browser?.engine, browser.engine, 'Case browser identity differs');
    assert.equal(observation.browser?.version, browser.version, 'Case browser version differs');
    assert.equal(observation.sourcesUnchanged, true, 'Runtime sources changed during execution');
    assert(observation.cases?.some(probe => probe.name === value.probe && probe.requirement === value.requirement && probe.passed && !probe.failure), 'Case lacks passing actual runtime observation');
    assert(observation.cleanup?.browserExited && observation.cleanup?.serverClosed && observation.cleanup?.consumerRemoved, 'Incomplete runtime cleanup');
  }
  return receipt;
}
