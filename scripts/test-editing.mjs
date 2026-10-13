import { spawnSync } from 'node:child_process';
import { groupIds } from '../tests/editing/fixture-loader.ts';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--group') throw new Error('Usage: npm run test:editing -- --group fixtures');
groupIds(args[1]);
if (args[1] !== 'fixtures') throw new Error(`Editing group ${args[1]} has no qualified runtime suite yet`);
const result = spawnSync(process.execPath, ['--test', 'tests/editing/fixture-loader.test.mjs'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
