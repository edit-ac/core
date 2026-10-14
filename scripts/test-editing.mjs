import { spawnSync } from 'node:child_process';
import { caseSelectors, editingSuites } from './editing-suites.mjs';
import { groupIds } from '../tests/editing/fixture-loader.ts';
const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--group' || (args.length === 4 && (args[1] !== 'semantic' || args[2] !== '--cases' || !caseSelectors.includes(args[3])))) throw new Error('Usage: npm run test:editing -- --group fixtures|semantic [--cases regression-variants|selection-results|selection-actions|schema-rejection|mixed-batch|unicode|pending|storage-atomicity|mixed-storage|schema-storage|pending-storage|unicode-storage]');
groupIds(args[1]);
// Full semantic qualification includes every owning suite, including failures.
const files = editingSuites(args[1], args[3]);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, EDITAC_EDITING_SELECTION_SCOPE: args[3] === 'selection-actions' ? 'actions' : 'all' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
