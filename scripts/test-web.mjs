import { spawnSync } from 'node:child_process';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const [suite, ...options] = process.argv.slice(2);
if (suite !== 'ai-actions') throw Error('Expected web suite: ai-actions');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...options, 'packages/web/tests/ai-actions.test.ts'], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
