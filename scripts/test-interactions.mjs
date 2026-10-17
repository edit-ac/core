import { spawnSync } from 'node:child_process';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--group' || !['harness', 'breaks', 'formatting', 'deletion', 'navigation'].includes(args[1])) {
  throw Error('Unknown or unimplemented interaction group. Qualified dispatcher: --group harness|breaks|formatting|deletion|navigation');
}
for (const command of args[1] === 'navigation' ? [['scripts/test-browser.mjs', 'interaction-navigation']] : args[1] === 'deletion' ? [['scripts/test-browser.mjs', 'interaction-deletion']] : args[1] === 'formatting' ? [['scripts/test-browser.mjs', 'interaction-formatting']] : args[1] === 'breaks' ? [
  ['scripts/test-browser.mjs', 'interaction-breaks'],
  ['scripts/test-browser.mjs', 'interaction-break-tables'],
] : [
  ['--test', '--test-reporter=tap', 'tests/interaction-fixtures/catalog.test.mjs'],
  ['scripts/test-browser.mjs', 'interaction-harness'],
]) {
  const result = spawnSync(process.execPath, command, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
