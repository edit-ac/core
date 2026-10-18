import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restorePinnedEvidence } from '../scripts/restore-pinned-evidence.mjs';
import { digest } from '../scripts/architecture-budgets.mjs';

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'editac-evidence-test-')));
  const source = join(root, 'source'), destination = join(root, 'destination');
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'receipt.json'), 'receipt');
  await writeFile(join(source, 'nested/sample.bin'), 'sample');
  const pins = { 'receipt.json': digest('receipt'), 'nested/sample.bin': digest('sample') };
  try { await run({ root, source, destination, pins }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('restores every pinned byte and safely reuses an identical existing tree', () => fixture(async ({ source, destination, pins }) => {
  assert.deepEqual(await restorePinnedEvidence(source, destination, pins), { copied: 2, reused: 0, verified: 2, pinsHash: digest(JSON.stringify(pins)), qualification: 'historical-bytes-only' });
  assert.equal(await readFile(join(destination, 'nested/sample.bin'), 'utf8'), 'sample');
  const again = await restorePinnedEvidence(source, destination, pins);
  assert.equal(again.copied, 0); assert.equal(again.reused, 2);
}));
test('corrupt or absent source fails before creating destination', () => fixture(async ({ source, destination, pins }) => {
  await writeFile(join(source, 'nested/sample.bin'), 'corrupt');
  await assert.rejects(restorePinnedEvidence(source, destination, pins), /Changed pinned/);
  await rm(join(source, 'nested/sample.bin'));
  await assert.rejects(restorePinnedEvidence(source, destination, pins), /ENOENT/);
  await assert.rejects(access(destination), /ENOENT/);
}));
test('conflicting destination is preserved and no other file is copied', () => fixture(async ({ source, destination, pins }) => {
  await mkdir(destination); await writeFile(join(destination, 'receipt.json'), 'user bytes');
  await assert.rejects(restorePinnedEvidence(source, destination, pins), /Conflicting/);
  assert.equal(await readFile(join(destination, 'receipt.json'), 'utf8'), 'user bytes');
  await assert.rejects(access(join(destination, 'nested')), /ENOENT/);
}));
test('invalid paths and empty or malformed pins cannot create a destination', () => fixture(async ({ source, destination }) => {
  for (const pins of [{}, null, { '../escape': digest('x') }, { '/absolute': digest('x') }, { 'nested//sample.bin': digest('x') }, { 'nested/./sample.bin': digest('x') }, { 'receipt.json': 'bad' }]) await assert.rejects(restorePinnedEvidence(source, destination, pins));
  await assert.rejects(access(destination), /ENOENT/);
}));
test('source symlink escaping pinned root is rejected', () => fixture(async ({ root, source, destination, pins }) => {
  await writeFile(join(root, 'outside'), 'sample'); await rm(join(source, 'nested/sample.bin'));
  await symlink(join(root, 'outside'), join(source, 'nested/sample.bin'));
  await assert.rejects(restorePinnedEvidence(source, destination, pins), /Escaping/);
}));
test('destination symlinks and symlink ancestors cannot redirect writes', () => fixture(async ({ root, source, destination, pins }) => {
  const outside = join(root, 'outside'); await mkdir(outside); await mkdir(destination);
  await symlink(outside, join(destination, 'nested'));
  await assert.rejects(restorePinnedEvidence(source, destination, pins), /Symlink/);
  await symlink(outside, join(root, 'redirect'));
  await assert.rejects(restorePinnedEvidence(source, join(root, 'redirect/child'), pins), /Symlink/);
  await assert.rejects(access(join(outside, 'receipt.json')), /ENOENT/);
}));
test('source and destination may not overlap in either direction', () => fixture(async ({ root, source, pins }) => {
  for (const destination of [source, join(source, 'child'), root]) await assert.rejects(restorePinnedEvidence(source, destination, pins), /overlaps/);
}));
