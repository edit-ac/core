import { spawnSync } from 'node:child_process';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--group' || !['text-transfer', 'text-drag', 'accessibility', 'history', 'parsing', 'pointer-selection', 'harness', 'breaks', 'formatting', 'deletion', 'navigation', 'keyboard', 'replacement', 'whitespace', 'slash', 'paste'].includes(args[1])) {
  throw Error('Unknown or unimplemented interaction group. Qualified dispatcher: --group text-transfer|text-drag|accessibility|history|parsing|pointer-selection|harness|breaks|formatting|deletion|navigation|keyboard|replacement|whitespace|slash|paste');
}
for (const command of args[1] === 'text-transfer' ? [['scripts/test-browser.mjs', 'interaction-text-transfer']] : args[1] === 'text-drag' ? [['scripts/test-browser.mjs', 'interaction-text-drag']] : args[1] === 'accessibility' ? [['scripts/test-browser.mjs', 'interaction-accessibility']] : args[1] === 'history' ? [['scripts/test-browser.mjs', 'interaction-history']] : args[1] === 'parsing' ? [['scripts/test-parsing-vectors.mjs'], ['scripts/test-browser.mjs', 'interaction-parsing']] : args[1] === 'pointer-selection' ? [['scripts/test-browser.mjs', 'interaction-pointer-selection']] : args[1] === 'paste' ? [['scripts/test-browser.mjs', 'interaction-paste']] : args[1] === 'slash' ? [['scripts/test-browser.mjs', 'interaction-slash']] : args[1] === 'whitespace' ? [['scripts/test-browser.mjs', 'interaction-whitespace']] : args[1] === 'replacement' ? [['scripts/test-browser.mjs', 'interaction-replacement']] : args[1] === 'keyboard' ? [['scripts/test-browser.mjs', 'interaction-keyboard'], ['scripts/test-browser.mjs', 'interaction-keyboard-tables']] : args[1] === 'navigation' ? [['scripts/test-browser.mjs', 'interaction-navigation']] : args[1] === 'deletion' ? [['scripts/test-browser.mjs', 'interaction-deletion']] : args[1] === 'formatting' ? [['scripts/test-browser.mjs', 'interaction-formatting']] : args[1] === 'breaks' ? [
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
