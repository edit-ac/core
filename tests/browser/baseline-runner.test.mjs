import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../scripts/test-browser.mjs', import.meta.url));
for (const option of ['--test-name-pattern=missing', '--test-skip-pattern=.*', '--test-shard=1/2']) {
  test(`baseline gate rejects partial execution through ${option}`, () => {
    const result = spawnSync(process.execPath, [runner, 'baseline', option], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baseline gate requires the complete renderer, keyboard and example suites/);
    assert.ok(!result.stdout.includes('browser:'), 'Rejected before launching a browser');
  });
}
test('unknown browser suite fails before executing zero tests', () => {
  const result = spawnSync(process.execPath, [runner, 'missing-suite'], { encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected browser suite:/);
});
