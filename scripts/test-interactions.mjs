import { spawnSync } from 'node:child_process';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--group' || args[1] !== 'harness') {
  throw Error('Unknown or unimplemented interaction group. Qualified dispatcher: --group harness');
}
for (const command of [
  ['--test', '--test-reporter=tap', 'tests/interaction-fixtures/catalog.test.mjs'],
  ['scripts/test-browser.mjs', 'interaction-harness'],
]) {
  const result = spawnSync(process.execPath, command, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
