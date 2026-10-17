import { spawnSync } from 'node:child_process';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const [suite, ...options] = process.argv.slice(2);
if (!['ai-actions', 'ai-completion', 'ai-transformations'].includes(suite)) throw Error('Expected web suite: ai-actions, ai-completion or ai-transformations');
const backend = suite === 'ai-completion' ? ['examples/ai-completion-backend/backend.test.mjs'] : [];
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...options, `packages/web/tests/${suite}.test.ts`, ...backend], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
