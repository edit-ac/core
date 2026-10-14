import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const prerequisiteGroups = Object.freeze([
  'native-core', 'native-markdown', 'session-default', 'session-native',
  'minimal-core', 'production-build', 'session-browser', 'storage-sync',
  'module-web', 'module-browser', 'emulator-menu',
]);
const buildGroups = new Set(['minimal-core', 'production-build']);
export const requiredSourcePaths = Object.freeze([
  'architecture/roadmaps/07-extension-modules.md', 'architecture/roadmaps/12-client-contracts.md',
  'architecture/specs/verification.md', 'architecture/specs/client-contracts.md',
  'architecture/specs/extension-library.md', 'architecture/specs/extension-presenters.md',
  'architecture/specs/formats.md', 'architecture/tests/native-clipboard-cases.md',
  'core/crates/editac-core/Cargo.toml', 'core/crates/editac-session/Cargo.toml',
  'core/Cargo.lock', 'core/package-lock.json', 'core/crates/editac-core/src/commands/editor.rs',
  'core/crates/editac-session/src/edit_service.rs', 'core/fixtures/extensions/capabilities.json',
  'core/packages/web/src/clipboard/fragment.ts',
  'core/crates/editac-session/tests/conformance.rs', 'core/tests/session-conformance.test.mjs',
  'core/tests/local-channel.test.mjs', 'core/fixtures/client-contracts/conformance.tsv',
]);
export const requiredArtifactPaths = Object.freeze([
  'core/packages/core/dist/wasm/editac_wasm_bg.wasm',
  'core/packages/core/dist/wasm/editac_wasm.js',
  'core/packages/core/dist/wasm-fixture/editac_wasm_bg.wasm',
  'core/packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm',
  'core/packages/web/dist/entry.js',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function measuredCounts(bytes) {
  const text = bytes.toString();
  if (/^# tests \d+/m.test(text)) {
    const sum = key => [...text.matchAll(new RegExp('^# '+key+' (\\d+)$','gm'))].reduce((n,m) => n+Number(m[1]),0);
    return {executed:sum('tests'),passed:sum('pass'),failed:sum('fail'),skipped:sum('skipped'),cancelled:sum('cancelled')};
  }
  const rows = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)];
  assert.ok(rows.length, 'missing executed-case footer');
  const sum = i => rows.reduce((n,m) => n+Number(m[i]),0);
  return {executed:sum(1)+sum(2)+sum(3),passed:sum(1),failed:sum(2),skipped:sum(3),cancelled:0};
}

// Historical receipts never stand in for changed current sources or runtime artifacts.
export async function verifyPrerequisiteQualification({ workspace, path, read = p => readFile(new URL(p, workspace)) }) {
  const receipt = JSON.parse(await read(path));
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.state, 'implemented-and-verified-current-prerequisites');
  assert.deepEqual(receipt.requiredGroups, [...prerequisiteGroups]);
  assert.equal(receipt.providerCalls, 0);
  assert.equal(receipt.sourceRoadmapEdits, 0);
  for (const group of prerequisiteGroups) {
    const checks = receipt.checks.filter(c => c.group === group);
    assert.equal(checks.length, group === 'minimal-core' ? 3 : group === 'production-build' ? 5 : group === 'storage-sync' ? 2 : 1, `complete current ${group}`);
    for (const check of checks) {
      assert.equal(check.exit, 0, `${group} exit`);
      assert.ok(receipt.evidenceHashes[check.log], `${group} log identity`);
      if (!buildGroups.has(group)) {
        for (const field of ['executed', 'passed', 'failed', 'skipped', 'cancelled']) {
          assert.ok(Number.isSafeInteger(check[field]) && check[field] >= 0, `${group} ${field} count`);
        }
        assert.ok(check.executed > 0, `${group} nonzero executed cases`);
        assert.equal(check.passed, check.executed, `${group} passed`);
        for (const field of ['failed', 'skipped', 'cancelled']) assert.equal(check[field], 0, `${group} ${field}`);
        const observed = measuredCounts(await read(check.log));
        for (const field of Object.keys(observed)) assert.equal(check[field], observed[field], `${group} raw ${field}`);
        if (group === 'emulator-menu') assert.equal(check.executed, 5, 'five actual virtual cases');
      }
    }
  }
  for (const [field, minimum] of [['sourceHashes', 10], ['artifactHashes', 2], ['evidenceHashes', 2]]) {
    const entries = Object.entries(receipt[field]);
    assert.ok(entries.length >= minimum, `${field} coverage`);
    for (const [name, digest] of entries) {
      assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), `workspace-relative identity: ${name}`);
      assert.equal(sha256(await read(name)), digest, `${field}: ${name}`);
    }
  }
  for (const source of requiredSourcePaths) {
    assert.ok(receipt.sourceHashes[source], `current requirement ${source}`);
  }
  for (const artifact of requiredArtifactPaths) assert.ok(receipt.artifactHashes[artifact], `current runtime ${artifact}`);
  assert.equal(receipt.virtualClipboard.developmentGate, 'PASS');
  assert.deepEqual(receipt.virtualClipboard.counts, { executed: 5, passed: 5, failed: 0, skipped: 0, cancelled: 0 });
  assert.equal(receipt.virtualClipboard.physicalDevicesObserved, 0);
  assert.ok(receipt.evidenceHashes[receipt.virtualClipboard.receipt], 'fresh virtual receipt identity');
  return receipt;
}
