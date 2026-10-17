import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sharedCases } from './shared-resource-contract.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === '--consolidate') {
  const { collectSharedSite } = await import('./shared-site-receipt.mjs');
  await collectSharedSite(process.argv.slice(3).filter(arg => arg !== '--prerequisite-only'), { prerequisiteOnly: process.argv.includes('--prerequisite-only') });
  process.exit(0);
}
const [directory] = process.argv.slice(2); assert(directory, 'Usage: node scripts/collect-shared-resources.mjs <browser-output>');
const base = resolve(directory), browsers = [], artifacts = {};
const names = {
  'SHR-01-description': ['SHR-01', 'equal-description-first'], 'SHR-01-comment': ['SHR-01', 'equal-comment-first'],
  'SHR-02-description': ['SHR-02', 'mixed-description-first'], 'SHR-02-comment': ['SHR-02', 'mixed-comment-first'], 'SHR-02-two-optional': ['SHR-02', 'two-optional'],
  'SHR-03-disposed-waiter': ['SHR-03', 'disposed-waiter'], 'SHR-03-failure-retry': ['SHR-03', 'failure-retry'], 'SHR-03-remount': ['SHR-03', 'remount'],
  'SHR-03-pending-save': ['SHR-03', 'pending-save-report'], 'SHR-03-optional-retry': ['SHR-03', 'optional-failure-retry'],
  'SHR-07-urls': ['SHR-07', 'url-conflict'], 'SHR-08-true': ['SHR-08', 'disposed-renderer'], 'SHR-08-false': ['SHR-08', 'updated-renderer'],
};
for (const engine of ['chromium', 'firefox', 'webkit']) {
  const path = join(engine, 'receipt.json'), bytes = await readFile(join(base, path)), receipt = JSON.parse(bytes);
  artifacts[path] = hash(bytes); assert.equal(receipt.engine, engine); assert.equal(receipt.browser.playwright, '1.64.0'); assert.equal(receipt.sourcesUnchanged, true);
  assert.equal(receipt.counts.executed, Object.keys(names).length); assert.equal(receipt.counts.passed, receipt.counts.executed);
  assert.equal(receipt.counts.failed, 0); assert.equal(receipt.counts.skipped, 0);
  assert(receipt.cleanup.browserExited && receipt.cleanup.serverClosed && receipt.cleanup.consumerRemoved);
  assert(receipt.packs.length === 3 && receipt.serverRequests.length > 0);
  for (const [source, digest] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(source)), digest, `Stale source: ${source}`);
  for (const pack of receipt.packs) { const path = join(engine, pack.file); const bytes = await readFile(join(base, path)); assert.equal(hash(bytes), pack.sha256); artifacts[path] = pack.sha256; }
  const cases = receipt.cases.map(value => {
    assert(value.passed && !value.failure); const identity = names[value.name]; assert(identity, `Unexpected shared-resource case ${value.name}`);
    return { requirement: identity[0], name: identity[1], passed: true, probe: value.name, evidence: path, evidenceSha256: artifacts[path] };
  });
  assert.equal(new Set(cases.map(value => `${value.requirement}/${value.name}`)).size, Object.keys(names).length);
  browsers.push({ engine, ...receipt.browser, cases, failed: 0, skipped: 0, cancelled: 0,
    missing: Object.entries(sharedCases).flatMap(([requirement, values]) => values.filter(name => !cases.some(value => value.requirement === requirement && value.name === name)).map(name => `${requirement}/${name}`)),
  });
}
const first = JSON.parse(await readFile(join(base, 'chromium/receipt.json'), 'utf8'));
for (const engine of ['firefox', 'webkit']) { const other = JSON.parse(await readFile(join(base, engine, 'receipt.json'), 'utf8')); assert.deepEqual(other.packs.map(p => [p.name, p.sha256]), first.packs.map(p => [p.name, p.sha256]), 'Browser packages differ'); assert.deepEqual(other.sources, first.sources, 'Browser source closures differ'); }
const result = { version: 1, kind: 'editac.shared-resources.observations', provenance: 'actual-packed-browser-runtime',
  complete: false, scope: 'SHR-01/02/03/08 same-page prerequisite and SHR-07 explicit URL guard; not consolidated FIT loading qualification',
  browsers, packages: first.packs.map(pack => ({ name: `@edit-ac/${pack.name}`, file: join('chromium', pack.file), sha256: pack.sha256 })), sources: first.sources, artifacts,
};
await writeFile(join(base, 'same-page-receipt.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ file: relative(process.cwd(), join(base, 'same-page-receipt.json')), passed: browsers.map(value => ({ engine: value.engine, cases: value.cases.length, missing: value.missing.length })), complete: false }));
