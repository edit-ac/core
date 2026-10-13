import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopOwnedProcess } from './owned-processes.mjs';
import { requireTestNode } from './test-toolchain.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await requireTestNode();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--browser' || !['chromium', 'firefox', 'webkit'].includes(args[1]))) throw Error('Expected --browser chromium|firefox|webkit');
const browser = args[1] ?? 'chromium';
const output = resolve('regression-results', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const files = [...(await readdir('tests')).filter(name => name.endsWith('.test.mjs')).map(name => join('tests', name)),
  ...(await readdir('tests/browser')).filter(name => name.endsWith('.spec.ts') || name.endsWith('.test.mjs')).map(name => join('tests/browser', name))].sort();
if (!files.length) throw Error('No regression tests found');
const env = { ...process.env };
for (const path of files.filter(name => name.startsWith('tests/browser/'))) {
  const name = path.split('/').at(-1).replace(/\.(spec\.ts|test\.mjs)$/, '');
  const key = `EDITAC_${name.toUpperCase().replaceAll('-', '_')}`;
  env[`${key}_BROWSER`] = browser; env[`${key}_OUTPUT`] = join(output, 'browser', name);
}
env.EDITAC_BASELINE_OUTPUT = join(output, 'baseline');
env.EDITAC_EXTENSION_ENTRY_OUTPUT = join(output, 'rust-fixtures', 'extension-entry');
env.EDITAC_EXTENSION_ENTRY_FIXTURES = env.EDITAC_EXTENSION_ENTRY_OUTPUT;
env.EDITAC_MATH_FIXTURES = join(output, 'rust-fixtures', 'math');
env.EDITAC_MODULE_REGISTRY_FIXTURES = join(output, 'rust-fixtures', 'module-registry');
env.EDITAC_MATH_BUNDLES = join(output, 'math-bundles');
env.EDITAC_ASTRO_OUTPUT = join(output, 'astro');
let child, interrupted = false;
const stop = () => { interrupted = true; stopOwnedProcess(child); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
async function run(command, arguments_, name) {
  if (interrupted) throw Error('Regression suite interrupted');
  const log = join(output, name), stream = createWriteStream(log);
  console.log(`${command} ${arguments_.join(' ')} → ${log}`);
  try {
    await new Promise((done, reject) => {
      child = spawn(command, arguments_, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
      child.once('error', reject); child.once('close', (code, signal) => code === 0 ? done() : reject(Error(`${name}: exit ${code ?? signal}; ${log}`)));
    });
  } finally { child = undefined; await new Promise(resolve => stream.end(resolve)); }
}
const receipt = { version: 1, browser, files, output, node: process.version,
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  process: { pid: process.pid, launcher: process.execPath, workspace: process.cwd(), purpose: 'regression tests', log: output },
  errors: [], counts: null };
try {
  await run('npm', ['run', 'build:wasm'], 'build-wasm.log');
  await run('npm', ['run', 'build'], 'build.log');
  receipt.artifactHash = createHash('sha256').update(await readFile('packages/core/dist/wasm/editac_wasm_bg.wasm')).digest('hex');
  await run('cargo', ['test', '-p', 'editac-core', '--test', 'patches', '--test', 'math_atom', '--test', 'module_registry', '--locked', '--offline'], 'rust-fixtures.log');
  const rustLog = await readFile(join(output, 'rust-fixtures.log'), 'utf8');
  const rustCounts = [...rustLog.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/g)];
  receipt.rust = { passed: rustCounts.reduce((sum, match) => sum + Number(match[1]), 0), failed: rustCounts.reduce((sum, match) => sum + Number(match[2]), 0), skipped: rustCounts.reduce((sum, match) => sum + Number(match[3]), 0) };
  if (!receipt.rust.passed || receipt.rust.failed || receipt.rust.skipped) throw Error('Missing, failed or skipped native fixture tests');
  await run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], 'tests.tap');
} catch (error) { receipt.errors.push(error.message); }
finally {
  try {
    const tap = await readFile(join(output, 'tests.tap'), 'utf8');
    receipt.counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(name => [name, Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
    if (!(receipt.counts.tests > 0) || receipt.counts.pass !== receipt.counts.tests || receipt.counts.fail !== 0 || receipt.counts.skipped !== 0 || receipt.counts.cancelled !== 0) receipt.errors.push('Incomplete, failed, cancelled or skipped regression tests');
  } catch (error) { receipt.errors.push(`No test evidence: ${error.message}`); }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
console.log(JSON.stringify({ counts: receipt.counts, errors: receipt.errors, output }));
if (receipt.errors.length) process.exitCode = 1;
