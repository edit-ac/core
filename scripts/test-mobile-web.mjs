import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireTestNode } from './test-toolchain.mjs';
import { assertIndex, selectGroup, assertCounts } from '../tests/mobile-web/catalog.mjs';
await requireTestNode();
const files = selectGroup(process.argv.slice(2));
assertIndex(JSON.parse(readFileSync('tests/mobile-web/case-index.json', 'utf8')));
const output = process.env.EDITAC_MOBILE_HARNESS_OUTPUT ?? mkdtempSync(join(tmpdir(), 'editac-mobile-harness-'));
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
const receipt = { group: 'harness', counts, browserCounts: browser.counts, browserReceiptSha256: createHash('sha256').update(readFileSync(join(output, 'receipt.json'))).digest('hex'), qualification: 'prepared delivery through real packed BrowserEditor/WASM/IndexedDB; no device or performance admission' };
writeFileSync(join(output, 'dispatch-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...receipt, output }));
