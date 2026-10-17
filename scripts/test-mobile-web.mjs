import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireTestNode } from './test-toolchain.mjs';
import { assertIndex, selectGroup, assertCounts, portableGroups, catalogRows, portableCases } from '../tests/mobile-web/catalog.mjs';
await requireTestNode();
const files = selectGroup(process.argv.slice(2));
assertIndex(JSON.parse(readFileSync('tests/mobile-web/case-index.json', 'utf8')));
const output = process.env.EDITAC_MOBILE_HARNESS_OUTPUT ?? mkdtempSync(join(tmpdir(), 'editac-mobile-harness-'));
mkdirSync(output, { recursive: true });
if (process.argv[3] === 'portable') {
  const groups = [], perId = [];
  const mapping = JSON.parse(readFileSync('tests/mobile-web/portable-cases.json', 'utf8'));
  for (const group of portableGroups) {
    const directory = join(output, group);
    mkdirSync(directory, { recursive: true });
    const child = spawnSync(process.execPath, ['scripts/test-mobile-web.mjs', '--group', group], {
      encoding: 'utf8', env: { ...process.env, EDITAC_MOBILE_HARNESS_OUTPUT: directory }, maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(join(directory, 'dispatch.log'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    if (child.error || child.status !== 0) throw Error(`Portable group ${group} failed; retained ${directory}/dispatch.log`);
    const dispatch = JSON.parse(readFileSync(join(directory, 'dispatch-receipt.json'), 'utf8'));
    const browser = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assertCounts(dispatch.counts); assertCounts(browser.counts);
    groups.push({ group, ...dispatch, receipt: `${group}/receipt.json`, browser: browser.browser });
    perId.push(...portableCases(catalogRows().filter(row => row.group === group), mapping, browser.cases).map(row => ({ ...row, browser: browser.browser })));
  }
  const totals = groups.reduce((sum, g) => { for (const key of Object.keys(sum)) sum[key] += g.counts[key]; return sum; }, { executed: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 });
  assertCounts(totals);
  const deferred = catalogRows().map(row => ({ id: row.id, originalParent: row.originalParent, device: 'deferred-original-MWB-1.11', ...(row.projectedParent ? {} : { mechanics: row.provenance }) }));
  const receipt = { group: 'portable', gate: 'MWF-1.9', groups, counts: totals, perId, deferred,
    qualification: 'portable projected predicates only; original MWB-1.1/1.9/1.10/1.11 cost/device/performance/full-platform/release remain open' };
  writeFileSync(join(output, 'portable-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ group: 'portable', counts: totals, perId: perId.length, output }));
  process.exit(0);
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8', env: { ...process.env, EDITAC_MOBILE_HARNESS_OUTPUT: output }, maxBuffer: 16 * 1024 * 1024,
});
writeFileSync(join(output, 'tests.tap'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
if (result.error || result.status !== 0) {
  console.error(`Mobile harness failed; retained log: ${join(output, 'tests.tap')}`);
  if (result.error) console.error(result.error.message);
  process.exit(result.status || 1);
}
const count = name => Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
const counts = { executed: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') };
assertCounts(counts);
const browser = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
assertCounts(browser.counts);
if (!browser.sourcesUnchanged || !browser.cleanup.browserExited || !browser.cleanup.serverClosed) throw Error('Missing immutable source/teardown proof');
const receipt = { group: process.argv[3], counts, browserCounts: browser.counts, browserReceiptSha256: createHash('sha256').update(readFileSync(join(output, 'receipt.json'))).digest('hex'), qualification: 'prepared delivery through real packed BrowserEditor/WASM/IndexedDB; no device or performance admission' };
writeFileSync(join(output, 'dispatch-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...receipt, output }));
