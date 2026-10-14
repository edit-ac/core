import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { editingSuites } from '../../scripts/editing-suites.mjs';
import { spawnSync } from 'node:child_process';

// Admission must fail before loading a runtime. These failures cannot become
// an accidental successful zero-test qualification of a misspelled case group.
for (const [name, args] of [
  ['schema storage selector on fixtures', ['--group', 'fixtures', '--cases', 'schema-storage']],
  ['mixed storage selector on fixtures', ['--group', 'fixtures', '--cases', 'mixed-storage']],
  ['storage selector on fixtures', ['--group', 'fixtures', '--cases', 'storage-atomicity']],
  ['pending selector on fixtures', ['--group', 'fixtures', '--cases', 'pending']],
  ['Unicode selector on fixtures', ['--group', 'fixtures', '--cases', 'unicode']],
  ['mixed selector on fixtures', ['--group', 'fixtures', '--cases', 'mixed-batch']],
  ['schema selector on fixtures', ['--group', 'fixtures', '--cases', 'schema-rejection']],
  ['unknown selector', ['--group', 'semantic', '--cases', 'missing']],
  ['action selector on fixtures', ['--group', 'fixtures', '--cases', 'selection-actions']],
  ['selection selector on fixtures', ['--group', 'fixtures', '--cases', 'selection-results']],
  ['selector on fixtures', ['--group', 'fixtures', '--cases', 'regression-variants']],
  ['trailing selector arguments', ['--group', 'semantic', '--cases', 'regression-variants', 'extra']],
  ['missing selector', ['--group', 'semantic', '--cases']],
]) test(`dispatcher rejects ${name}`, () => {
  const result = spawnSync(process.execPath, ['scripts/test-editing.mjs', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Usage: npm run test:editing/);
  assert.doesNotMatch(result.stdout + result.stderr, /Subtest:|REG-05|REG-07/);
});

test('mixed proof is mandatory in the canonical semantic group and has a real suite', () => {
  const selected = editingSuites('semantic', 'mixed-batch');
  assert.deepEqual(selected, ['tests/editing/mixed-batch.test.mjs']);
  const full = editingSuites('semantic');
  assert.equal(full.filter(path => path === selected[0]).length, 1);
  assert.ok(full.includes('tests/editing/semantic.test.mjs'));
  assert.ok(full.includes('tests/editing/semantic-variants.test.mjs'));
  for (const path of full) assert.ok(existsSync(path), `Missing canonical suite ${path}`);
});

test('Unicode proof is mandatory in canonical semantic dispatch', () => {
  const selected = editingSuites('semantic', 'unicode');
  assert.deepEqual(selected, ['tests/editing/unicode.test.mjs']);
  assert.equal(editingSuites('semantic').filter(path => path === selected[0]).length, 1);
  assert.ok(existsSync(selected[0]));
});

test('pending proof is mandatory in canonical semantic dispatch', () => {
  const selected = editingSuites('semantic', 'pending');
  assert.deepEqual(selected, ['tests/editing/pending.test.mjs']);
  assert.equal(editingSuites('semantic').filter(path => path === selected[0]).length, 1);
  assert.ok(existsSync(selected[0]));
});

test('storage atomicity proof is mandatory in canonical semantic dispatch', () => {
  const selected = editingSuites('semantic', 'storage-atomicity');
  assert.deepEqual(selected, ['tests/editing/storage-atomicity.test.mjs']);
  assert.equal(editingSuites('semantic').filter(path => path === selected[0]).length, 1);
  assert.ok(existsSync(selected[0]));
});

test('mixed storage proof is mandatory in canonical semantic dispatch', () => {
  const selected = editingSuites('semantic', 'mixed-storage');
  assert.deepEqual(selected, ['tests/editing/mixed-storage.test.mjs']);
  assert.equal(editingSuites('semantic').filter(path => path === selected[0]).length, 1);
  assert.ok(existsSync(selected[0]));
});

test('schema rejection storage proof is mandatory in canonical semantic dispatch', () => {
  const selected = editingSuites('semantic', 'schema-storage');
  assert.deepEqual(selected, ['tests/editing/schema-storage.test.mjs']);
  assert.equal(editingSuites('semantic').filter(path => path === selected[0]).length, 1);
  assert.ok(existsSync(selected[0]));
});
