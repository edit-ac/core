import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Admission must fail before loading a runtime. These failures cannot become
// an accidental successful zero-test qualification of a misspelled case group.
for (const [name, args] of [
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
