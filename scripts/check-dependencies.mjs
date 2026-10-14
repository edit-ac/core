import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { writeInventory, checkInventory } from './dependency-inventory.mjs';
import { hash } from './architecture-layers.mjs';
import { requireTestNode } from './test-toolchain.mjs';

async function main() {
  await requireTestNode();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const arg = process.argv.slice(2);
  if (arg.length !== 1 || !['--write', '--check'].includes(arg[0])) throw Error('Expected --write or --check');
  const output = resolve(process.env.EDITAC_DEPENDENCIES_OUTPUT ?? join(root, 'architecture-results', `dependencies-${new Date().toISOString().replaceAll(':', '-')}`));
  await mkdir(output, { recursive: true });
  const receipt = { version: 1, command: [process.execPath, 'scripts/check-dependencies.mjs', ...arg], revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), node: process.version, exit: 1, counts: { tests: 1, pass: 0, fail: 1, skipped: 0 }, implementation: {}, artifacts: {}, errors: [] };
  for (const path of ['scripts/check-dependencies.mjs', 'scripts/dependency-inventory.mjs', 'scripts/test-toolchain.mjs', 'scripts/architecture-layers.mjs', 'licenses/policy.json', 'licenses/advisories.json']) receipt.implementation[path] = hash(await readFile(join(root, path)));
  try {
    const inventory = await (arg[0] === '--write' ? writeInventory(root) : checkInventory(root));
    await writeFile(join(output, 'dependencies-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
    receipt.artifacts['dependencies-inventory.json'] = hash(await readFile(join(output, 'dependencies-inventory.json')));
    receipt.inventoryCounts = { cargo: inventory.cargo.length, npm: inventory.npm.length, gradle: inventory.gradle.length, embedded: inventory.embedded.length, artifacts: inventory.artifacts.length, notices: inventory.noticeCount, unavailableNotices: [...inventory.npm, ...inventory.gradle].filter(p => p.noticeState === 'unavailable').length };
    receipt.inputs = inventory.inputs;
    receipt.counts = { tests: 1, pass: 1, fail: 0, skipped: 0 }; receipt.exit = 0;
  } catch (error) { receipt.errors.push(error.message); }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ exit: receipt.exit, counts: receipt.counts, inventoryCounts: receipt.inventoryCounts, errors: receipt.errors, output }));
  process.exitCode = receipt.exit;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error.message); process.exitCode = 1; });
