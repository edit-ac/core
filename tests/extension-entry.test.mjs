import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const workspace = new URL('../../', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = path => readFile(new URL(path, workspace));
const json = async path => JSON.parse(await bytes(path));
const map = await json('core/fixtures/extensions/entry-map.json');

test('entry map covers the six qualified built-ins and current owning contracts', async () => {
  assert.equal(map.parent, 'EXT-1.1');
  assert.equal(map.schemaVersion, 1);
  assert.equal(map.ownership.fixtureDirectory, 'fixtures/extensions/');
  assert.deepEqual(map.modules.map(m => m.module), ['slash', 'references', 'reorder', 'images', 'tables', 'math']);
  for (const [path, digest] of Object.entries(map.contracts)) assert.equal(hash(await bytes(`architecture/${path}`)), digest, path);
  for (const [path, digest] of Object.entries(map.sourceHashes)) assert.equal(hash(await bytes(`core/${path}`)), digest, path);
});

for (const module of map.modules) test(`${module.module} maps existing symbols, commands, codecs, fallback and unsupported cases`, async () => {
  for (const field of ['descriptor', 'command', 'codec', 'fallback']) assert.ok(module[field].length > 0, field);
  assert.ok(module.unsupported.length > 0);
  assert.ok(module.symbols.length > 0);
  for (const entry of module.symbols) {
    const [path, symbol] = entry.split(':');
    assert.ok(map.sourceHashes[path], path);
    const source = (await bytes(`core/${path}`)).toString();
    assert.match(source, new RegExp(`\\b(?:struct|enum|class|interface|type|function|const)\\s+${symbol}\\b`), entry);
  }
});

test('all nine original module gates have passing receipts at the current roadmap revision', async () => {
  const revision = hash(await bytes('architecture/roadmaps/07-extension-modules.md'));
  const directories = ['entry', 'registration', 'runtime', 'slash', 'references', 'reorder', 'content', 'math', 'matrix'];
  for (const [index, directory] of directories.entries()) {
    const receipt = await json(`architecture/evidence/modules-${directory}/receipt.json`);
    assert.equal(receipt.gate, `MOD-1.${index + 1}`);
    assert.match(receipt.state, /implemented and verified/);
    assert.equal(receipt.sourceRevision ?? receipt.sourceRoadmap?.revision, revision);
    // Earlier failed attempts are durable history, not current passing evidence.
    // module-bundles checks the final case-level proofs and presenter hashes.
    const checks = (receipt.checks ?? receipt.commands).map(check => ({
      exit: check.exitCode ?? check.exit,
      counts: check.counts ?? check,
    })).filter(c => c.counts.executed > 0 && c.counts.failed === 0 && (c.exit === undefined || c.exit === 0));
    assert.ok(checks.length > 0, directory);
    for (const check of checks) {
      // Some original receipts store flat counts without a separate exit field.
      if (check.exit !== undefined) assert.equal(check.exit, 0);
      assert.equal(check.counts.passed, check.counts.executed);
      assert.equal(check.counts.skipped, 0);
    }
  }
});

test('client final qualification retains passing real-adapter traces and hashed fixture artifacts', async () => {
  const receipt = await json('architecture/evidence/client-contracts/conformance-20261013/receipt.json');
  assert.equal(receipt.state, 'implemented-and-verified');
  assert.equal(receipt.sourceRevision, hash(await bytes('architecture/roadmaps/12-client-contracts.md')));
  assert.equal(receipt.conformance.normalizedTracesAgree, true);
  assert.equal(receipt.conformance.adapters.length, 3);
  for (const check of receipt.checks.filter(c => c.executed > 0)) {
    assert.equal(check.exit, 0); assert.equal(check.passed, check.executed);
    assert.equal(check.failed, 0); assert.equal(check.skipped, 0);
  }
  // Build/dependency changes are rechecked by this gate's current regression run.
  // Reuse only unchanged conformance inputs; do not claim historical builds are current.
  for (const path of ['core/crates/editac-session/tests/conformance.rs', 'core/tests/session-conformance.test.mjs', 'core/tests/local-channel.test.mjs', 'core/fixtures/client-contracts/conformance.tsv']) {
    assert.equal(hash(await bytes(path)), receipt.sources[path], path);
  }
  // Historical dist paths are reproducible output, not immutable evidence.
  // Fresh WASM/JS and actual browser conformance qualify the current artifacts.
  const retained = Object.entries(receipt.artifacts).filter(([path]) => path.startsWith('architecture/evidence/'));
  assert.ok(retained.length > 0);
  for (const [path, digest] of retained) assert.equal(hash(await bytes(path)), digest, path);
});

test('actual virtual clipboard development entry is distinct from physical release qualification', async () => {
  const receipt = await json('architecture/evidence/markdown/emulator-development/receipt.json');
  assert.equal(receipt.developmentGate, 'PASS');
  assert.equal(receipt.physicalReleaseGate, 'NOT_QUALIFIED');
  assert.deepEqual(receipt.counts, { executed: 5, passed: 5, failed: 0, skipped: 0, cancelled: 0 });
  assert.equal(receipt.cases.length, 5);
  assert.ok(receipt.virtualDevice);
  for (const [path, digest] of Object.entries(receipt.artifactHashes)) {
    assert.equal(hash(await bytes(`architecture/evidence/markdown/emulator-development/${path}`)), digest, path);
  }
});
