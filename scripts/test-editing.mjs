import { spawnSync } from 'node:child_process';
import { groupIds } from '../tests/editing/fixture-loader.ts';
const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--group' || (args.length === 4 && (args[1] !== 'semantic' || args[2] !== '--cases' || !['regression-variants', 'selection-results', 'selection-actions'].includes(args[3])))) throw new Error('Usage: npm run test:editing -- --group fixtures|semantic [--cases regression-variants|selection-results|selection-actions]');
groupIds(args[1]);
const suites = { fixtures: 'tests/editing/fixture-loader.test.mjs', semantic: 'tests/editing/semantic.test.mjs' };
if (!suites[args[1]]) throw new Error(`Editing group ${args[1]} has no qualified runtime suite yet`);
// Full semantic qualification always includes the owning variants, including failures.
const files = args.length === 4 ? [['selection-results', 'selection-actions'].includes(args[3]) ? 'tests/editing/selection-results.test.mjs' : 'tests/editing/semantic-variants.test.mjs'] : args[1] === 'semantic' ? [suites.semantic, 'tests/editing/semantic-variants.test.mjs', 'tests/editing/selection-results.test.mjs'] : [suites[args[1]]];
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, EDITAC_EDITING_SELECTION_SCOPE: args[3] === 'selection-actions' ? 'actions' : 'all' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
