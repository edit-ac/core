import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reconcileFormats } from '../tests/browser/mobile-extensions/format-contract.mjs';
import { requireTestNode } from './test-toolchain.mjs';
import { assertIndex, selectGroup } from '../tests/browser/mobile-extensions/index.mjs';
await requireTestNode();
const files = selectGroup(process.argv.slice(2));
assertIndex(JSON.parse(readFileSync('tests/browser/mobile-extensions/case-index.json')));
const output = process.env.EDITAC_MOBILE_EXTENSIONS_OUTPUT ?? mkdtempSync(join(tmpdir(), 'editac-mobile-extensions-'));
mkdirSync(output, { recursive: true });
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, EDITAC_MOBILE_EXTENSIONS_OUTPUT: output },
});
writeFileSync(join(output, 'tests.tap'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
const count = name => Number(result.stdout?.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
const counts = { executed: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') };
let browser;
try { browser = JSON.parse(readFileSync(join(output, 'receipt.json'))); } catch { /* Retain failure counts even if setup never produced a receipt. */ }
const receipt = { counts, exit: result.status, browserCounts: browser?.counts,
  browserReceiptSha256: browser ? createHash('sha256').update(readFileSync(join(output, 'receipt.json'))).digest('hex') : null,
  qualification: 'portable browser mechanics only' };
writeFileSync(join(output, 'dispatch-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ counts, output, exit: result.status }));
if (result.error || result.status !== 0 || counts.executed === 0 || counts.passed !== counts.executed || counts.skipped || counts.cancelled) process.exit(result.status || 1);
assert.ok(browser?.counts.executed > 0, 'catalog tests cannot substitute for browser execution');
assert.equal(browser.counts.executed, browser.counts.passed);
assert.equal(browser.counts.failed, 0); assert.equal(browser.counts.skipped, 0);
assert.equal(browser.sourcesUnchanged, true);
assert.ok(browser.cleanup.browserExited && browser.cleanup.serverClosed && browser.cleanup.consumerRemoved, 'missing task teardown');

if (process.argv[3] === 'formats') {
  const reconciliation = reconcileFormats(browser);
  reconciliation.browserReceiptSha256 = receipt.browserReceiptSha256;
  writeFileSync(join(output, 'format-reconciliation.json'), JSON.stringify(reconciliation, null, 2));
}
