import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, parseArgs, runProbes, validateManifest } from './check-security-targets.mjs';

test('explicit manifest covers all intended platform families and has no empty target', () => {
  assert.equal(validateManifest(manifest).targets.length, 10);
  for (const family of ['wasm32', 'darwin', 'windows', 'linux-gnu', 'ios', 'android']) {
    assert.ok(manifest.targets.some(target => target.id.includes(family)), family);
  }
});
test('all selects every declared target; specific targets remain explicit', () => {
  assert.deepEqual(parseArgs(['--all']).targets, manifest.targets.map(target => target.id));
  assert.deepEqual(parseArgs(['--target', manifest.targets[0].id]).targets, [manifest.targets[0].id]);
});
for (const args of [[], ['--target'], ['--target', 'unknown'], ['--all', '--target', manifest.targets[0].id],
  ['--all', '--all'], ['--target', manifest.targets[0].id, '--target', manifest.targets[0].id],
  ['--all', '--fake'], ['--all', '--evidence'], ['--all', '--evidence', '--all']]) {
  test(`invalid selection fails closed: ${JSON.stringify(args)}`, () => assert.throws(() => parseArgs(args)));
}
test('manifest rejects missing, empty, duplicate and malformed targets', () => {
  for (const targets of [undefined, [], [manifest.targets[0], manifest.targets[0]], [{ id: '--bad', platform: 'bad' }]]) {
    assert.throws(() => validateManifest({ ...manifest, targets }));
  }
});
test('run boundary also rejects empty, unknown or duplicate selections', () => {
  for (const ids of [[], ['unknown'], [manifest.targets[0].id, manifest.targets[0].id]]) {
    assert.throws(() => runProbes(manifest, ids, new Set(), () => assert.fail('must not compile')));
  }
});
test('missing toolchain target is unavailable and never qualified or skipped', () => {
  const report = runProbes(manifest, [manifest.targets[0].id], new Set(), () => assert.fail('must not compile'));
  assert.equal(report.exit, 1);
  assert.deepEqual(report.counts, { selected: 1, executed: 0, passed: 0, failed: 0, unavailable: 1, skipped: 0 });
  assert.equal(report.results[0].qualified, false);
});
test('mixed actual compile results retain failures and unavailable counts', () => {
  const ids = manifest.targets.slice(0, 3).map(target => target.id);
  const report = runProbes(manifest, ids, new Set(ids.slice(0, 2)), target => ({ status: target === ids[0] ? 0 : 101 }));
  assert.deepEqual(report.counts, { selected: 3, executed: 2, passed: 1, failed: 1, unavailable: 1, skipped: 0 });
  assert.equal(report.exit, 1);
});
test('spawn error or signal cannot masquerade as successful compilation', () => {
  const id = manifest.targets[0].id;
  for (const result of [{ status: null, error: new Error('not found') }, { status: 0, signal: 'SIGTERM' }, { status: 0, error: new Error('timeout') }]) {
    assert.equal(runProbes(manifest, [id], new Set([id]), () => result).counts.failed, 1);
  }
});
test('all selected successful compilations produce a nonzero passing set', () => {
  const ids = manifest.targets.map(target => target.id);
  const report = runProbes(manifest, ids, new Set(ids), () => ({ status: 0 }));
  assert.equal(report.exit, 0);
  assert.equal(report.counts.passed, 10);
  assert.equal(report.counts.executed, 10);
});
