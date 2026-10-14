import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './architecture-layers.mjs';
import { requireTestNode } from './test-toolchain.mjs';

export function selectSuite(policy, args) {
  if (args.length !== 2 || args[0] !== '--suite' || !Object.hasOwn(policy.suites ?? {}, args[1])) throw Error('Expected --suite with a registered architecture suite');
  const suite = policy.suites[args[1]];
  if (!Array.isArray(suite.tests) || !suite.tests.length) throw Error('Zero architecture test files');
  if (suite.tests.some(file => !/^tests\/architecture\/[a-z0-9/.-]+\.test\.mjs$/.test(file) || file.includes('..'))) throw Error('Invalid architecture test path');
  return suite;
}

export function testCounts(tap) {
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
  if (!(counts.tests > 0) || counts.pass !== counts.tests || ['fail', 'cancelled', 'skipped', 'todo'].some(k => counts[k] !== 0)) {
    const error = Error(`Incomplete architecture tests: ${JSON.stringify(counts)}`);
    error.counts = counts;
    throw error;
  }
  return counts;
}

async function main() {
  await requireTestNode();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = await readFile(resolve(root, 'contracts/layers.json'));
  const policy = JSON.parse(manifest), args = process.argv.slice(2), suite = selectSuite(policy, args);
  const output = resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT ?? resolve(root, 'architecture-results', `${args[1]}-${new Date().toISOString().replaceAll(':', '-')}`));
  await mkdir(output, { recursive: true });
  const command = [process.execPath, '--test', '--test-reporter=tap', ...suite.tests];
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, EDITAC_ARCHITECTURE_OUTPUT: output } });
  const tap = (result.stdout ?? '') + (result.stderr ?? '');
  await writeFile(resolve(output, 'tests.tap'), tap);
  const receipt = { version: 1, suite: args[1], command, node: process.version, revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), manifestHash: hash(manifest), exit: result.status, counts: null, errors: [], artifacts: { 'tests.tap': hash(tap) }, implementation: {} };
  for (const path of ['scripts/architecture-layers.mjs', 'scripts/check-architecture.mjs', 'scripts/test-toolchain.mjs', ...suite.tests, ...(suite.inputs ?? [])]) receipt.implementation[path] = hash(await readFile(resolve(root, path)));
  try {
    receipt.counts = testCounts(tap);
    if (result.error || result.status !== 0) throw Error(`Test runner failed: ${result.error?.message ?? result.status}`);
    if (args[1] === 'layers') receipt.artifacts['layers-graph.json'] = hash(await readFile(resolve(output, 'layers-graph.json')));
  } catch (error) { receipt.counts ??= error.counts ?? null; receipt.errors.push(error.message); }
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ suite: args[1], exit: receipt.exit, counts: receipt.counts, errors: receipt.errors, output: relative(root, output) }));
  if (receipt.errors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error.message); process.exitCode = 1; });
