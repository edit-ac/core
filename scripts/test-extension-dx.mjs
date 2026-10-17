import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireTestNode } from './test-toolchain.mjs';
await requireTestNode();
const args = process.argv.slice(2);
const groups = { contract: { files: ['tests/extension-dx/contract.test.mjs'], minimumTests: 30 }, configuration: { files: ['tests/extension-dx/configuration.test.mjs'], minimumTests: 45 } };
if (args.length !== 2 || args[0] !== '--group' || !Object.hasOwn(groups, args[1])) {
  console.error('Specify exactly --group contract or --group configuration; unavailable/unimplemented groups fail closed.'); process.exit(2);
}
const output = resolve(process.env.EDITAC_EXTENSION_DX_OUTPUT ?? `.artifacts/extension-dx/${args[1]}`);
mkdirSync(output, { recursive: true });
const { files, minimumTests } = groups[args[1]];
for (const file of files) if (!readFileSync(file).length) throw Error(`Missing/empty test file ${file}`);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8', env: { ...process.env, EDITAC_EXTENSION_DX_OUTPUT: output }, maxBuffer: 16 * 1024 * 1024,
});
const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
writeFileSync(resolve(output, 'tests.tap'), log);
const count = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
const counts = { executed: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), todo: count('todo') };
writeFileSync(resolve(output, 'dispatch-receipt.json'), JSON.stringify({ group: args[1], files, minimumTests, node: process.versions.node, counts, status: result.status }, null, 2));
console.log(JSON.stringify({ group: args[1], counts, output }));
if (result.error || result.status !== 0 || !(counts.executed >= minimumTests) || counts.passed !== counts.executed || counts.failed !== 0 || counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) process.exit(1);
