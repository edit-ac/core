import { build, transform, version as esbuildVersion } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeAsset, evaluateBudget, assertBudget, compression, auditTaskGraph } from './browser-size-contract.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.env.EDITAC_BROWSER_SIZE_OUTPUT || join(root, '../architecture/evidence/browser-size-optimization/current'));
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'editac-browser-size-'));
const commands = [];
function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  commands.push({ command, args, exit: result.status, error: result.error?.message, label });
  return writeFile(join(output, label + '.log'), (result.stdout || '') + (result.stderr || '')).then(() => {
    if (result.error || result.status !== 0) throw result.error || new Error(`${label} exited ${result.status}`);
    return result.stdout;
  });
}
try {
  const packs = [];
  for (const name of ['core', 'web']) {
    const baselineCore = process.argv.find(arg => arg.startsWith('--baseline-core='))?.slice('--baseline-core='.length);
    if (baselineCore && !process.argv.includes('--allow-fixture-baseline')) throw new Error('Baseline override cannot qualify production');
    const pack = JSON.parse(await run('npm', ['pack', ...(name === 'core' && baselineCore ? [resolve(baselineCore)] : [`--workspace=@edit-ac/${name}`]), '--pack-destination', temp, '--json'], root, 'pack-' + name))[0];
    packs.push({ name, filename: pack.filename, integrity: pack.integrity, shasum: pack.shasum });
    await copyFile(join(temp, pack.filename), join(output, pack.filename));
  }
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...packs.map(p => join(temp, p.filename))], temp, 'install');
  // Public Task entry retains durable lifecycle, sync attachment and creation/recovery APIs.
  await writeFile(join(temp, 'task.mjs'), "export {init} from '@edit-ac/core'; export {createEditor,taskPreset,CheckpointStorage} from '@edit-ac/web';\n");
  const dist = join(temp, 'public');
  const bundle = await build({ absWorkingDir: temp, entryPoints: ['task.mjs'], outdir: dist, bundle: true, splitting: false, format: 'esm', minify: true, target: 'es2022', metafile: true, write: true });
  const inputs = Object.keys(bundle.metafile.inputs);
  const sources = Object.fromEntries(await Promise.all(inputs.map(async name => [name, await readFile(join(temp, name), 'utf8')])));
  // Include opaque generated-glue import explicitly; reject all other hidden lazy roots.
  auditTaskGraph(sources);
  await mkdir(join(dist, 'wasm'), { recursive: true });
  const core = join(temp, 'node_modules/@edit-ac/core/dist/wasm');
  const glue = await readFile(join(core, 'editac_wasm.js'), 'utf8');
  const wasmExports = WebAssembly.Module.exports(new WebAssembly.Module(await readFile(join(core, 'editac_wasm_bg.wasm')))).map(item => item.name);
  const productionFixtureAbsent = !wasmExports.some(name => name.includes('fixture') || name === 'created_document_count') && !/\b(?:class Fixture|function created_document_count)\b/.test(glue);
  if (!wasmExports.includes('engine_new') || !wasmExports.includes('engine_restore')) throw new Error('Missing required semantic engine WASM roots');
  if (!productionFixtureAbsent && !process.argv.includes('--allow-fixture-baseline')) throw new Error('Fixture qualification WASM roots leaked into production');
  if (/\b(?:class Fixture|function created_document_count)\b/.test(glue) && !process.argv.includes('--allow-fixture-baseline')) throw new Error('Fixture qualification exports leaked into production');
  if (/\bimport\s*(?:\(|["'{*])/.test(glue)) throw new Error('Generated glue has unaccounted dependencies');
  const opaqueGlue = !inputs.some(p => p.endsWith('core/dist/wasm/editac_wasm.js'));
  if (opaqueGlue) await writeFile(join(dist, 'wasm/editac_wasm.js'), (await transform(glue, { minify: true, format: 'esm', target: 'es2022' })).code);
  await copyFile(join(core, 'editac_wasm_bg.wasm'), join(dist, 'wasm/editac_wasm_bg.wasm'));
  const html = await readFile(join(root, 'examples/task-editor/index.html'), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (!css) throw new Error('Missing essential Task stylesheet');
  await writeFile(join(dist, 'task.css'), (await transform(css, { loader: 'css', minify: true })).code);
  const required = [ ...Object.keys(bundle.metafile.outputs).map(p => ({ name: relative(dist, resolve(temp, p)), kind: 'js' })), ...(opaqueGlue ? [{ name: 'wasm/editac_wasm.js', kind: 'js' }] : []), { name: 'wasm/editac_wasm_bg.wasm', kind: 'wasm' }, { name: 'task.css', kind: 'css' } ];
  const assets = [];
  for (const item of required) {
    const bytes = await readFile(join(dist, item.name));
    assets.push(describeAsset(item.name, item.kind, bytes));
    await mkdir(join(output, 'artifacts', relative(dist, join(dist, item.name, '..'))), { recursive: true });
    await copyFile(join(dist, item.name), join(output, 'artifacts', item.name));
  }
  const result = evaluateBudget(assets, required);
  const receipt = { schema: 1, profile: 'default-task', fixtureBaseline: process.argv.includes('--allow-fixture-baseline'), productionFixtureAbsent, wasmExports, node: process.version, zlib: process.versions.zlib, esbuild: esbuildVersion, minifier: { target: 'es2022', minify: true, bundle: true, splitting: false }, compression, packs, required, assets, result, commands, inputs, ephemeralRoot: temp };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(join(output, 'metafile.json'), JSON.stringify(bundle.metafile, null, 2) + '\n');
  console.log(JSON.stringify({ output, result, productionFixtureAbsent: receipt.productionFixtureAbsent }));
  assertBudget(result);
  if (receipt.fixtureBaseline) throw new Error("Diagnostic baseline cannot establish release qualification");
} finally {
  await writeFile(join(output, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  await rm(temp, { recursive: true, force: true });
}
