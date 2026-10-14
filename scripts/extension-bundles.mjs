import { build, version as esbuildVersion } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describeAsset, evaluateBudget, compression } from './browser-size-contract.mjs';
import { minifyTask, taskMinifier } from './minify-task.mjs';
const exec = promisify(execFile);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loggedRun(output, label, command, args, options = {}) {
  await mkdir(output, { recursive: true });
  try {
    const environment = { ...process.env, ...options.env };
    // A child CLI is a distinct test runner, not an in-process recursive run.
    delete environment.NODE_TEST_CONTEXT;
    const result = await exec(command, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000, ...options, env: environment });
    await writeFile(join(output, label + '.log'), result.stdout + result.stderr);
    return { command, args, exit: 0, log: label + '.log', stdout: result.stdout };
  } catch (error) {
    await writeFile(join(output, label + '.log'), (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message);
    throw error;
  }
}
export async function buildExtensionConsumers(output, config) {
  const consumer = await mkdtemp(join(tmpdir(), 'editac-extension-bundles-'));
  const receipt = { schema: 1, gate: 'EXT-1.9', packs: [], profiles: {}, settings: { node: process.version, zlib: process.versions.zlib, esbuild: esbuildVersion, minifier: taskMinifier, target: 'es2022', bundle: true, splitting: true, compression }, commands: [], cleanup: { consumer, removed: false } };
  try {
    await mkdir(output, { recursive: true });
    for (const name of ['core', 'web']) {
      const result = await loggedRun(output, 'pack-' + name, 'npm', ['pack', '--workspace=@edit-ac/' + name, '--json', '--pack-destination', output]);
      receipt.commands.push({ ...result, stdout: undefined });
      const [pack] = JSON.parse(result.stdout), archive = join(output, pack.filename);
      receipt.packs.push({ name, filename: pack.filename, integrity: pack.integrity, sha256: sha256(await readFile(archive)), files: pack.files.map(f => f.path) });
      const destination = join(consumer, 'node_modules/@edit-ac', name);
      await mkdir(destination, { recursive: true });
      await loggedRun(output, 'extract-' + name, 'tar', ['-xzf', archive, '-C', destination, '--strip-components=1']);
    }
    for (const [name, profile] of Object.entries(config.profiles)) {
      // Copy only documented consumer entry points; package code comes from tarballs.
      for (const entry of ['minimal.mjs', 'enabled.mjs']) await copyFile(resolve('fixtures/extensions/consumers', entry), join(consumer, entry));
      const dir = join(output, name);
      const bundle = await build({ absWorkingDir: consumer, entryPoints: { consumer: profile.entry }, bundle: true, format: 'esm', splitting: true, minify: true, target: 'es2022', platform: 'browser', outdir: dir, metafile: true });
      const required = [], assets = [];
      for (const path of Object.keys(bundle.metafile.outputs)) {
        const file = resolve(consumer, path), resource = relative(dir, file);
        await writeFile(file, await minifyTask(await readFile(file, 'utf8')));
        required.push({ name: resource, kind: 'js' });
      }
      const core = join(consumer, 'node_modules/@edit-ac/core/dist/wasm');
      const bytes = await readFile(join(core, 'editac_wasm_bg.wasm'));
      const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(e => e.name);
      if (!exports.includes('engine_new') || !exports.includes('engine_restore') || exports.some(e => /fixture|markdown/.test(e))) throw Error('Nonproduction engine in packed extension consumer');
      await mkdir(join(dir, 'wasm'), { recursive: true });
      await writeFile(join(dir, 'wasm/editac_wasm_bg.wasm'), bytes);
      required.push({ name: 'wasm/editac_wasm_bg.wasm', kind: 'wasm' });
      await copyFile(join(output, 'default-task/artifacts/task.css'), join(dir, 'task.css'));
      required.push({ name: 'task.css', kind: 'css' });
      for (const asset of required) assets.push(describeAsset(asset.name, asset.kind, await readFile(join(dir, asset.name))));
      // Every external/static/dynamic output import must be a delivered JS resource.
      const delivered = new Set(Object.keys(bundle.metafile.outputs).map(p => resolve(consumer, p)));
      for (const info of Object.values(bundle.metafile.outputs)) for (const imp of info.imports) {
        if (imp.external || !delivered.has(resolve(consumer, imp.path))) throw Error('Uninventoried import: ' + imp.path);
      }
      const inputs = {};
      for (const path of Object.keys(bundle.metafile.inputs)) {
        if (!['minimal.mjs', 'enabled.mjs'].includes(path) && !path.startsWith('node_modules/@edit-ac/')) throw Error('Private/unpacked dependency: ' + path);
        inputs[path] = sha256(await readFile(join(consumer, path)));
      }
      await writeFile(join(output, name + '-metafile.json'), JSON.stringify(bundle.metafile, null, 2) + '\n');
      receipt.profiles[name] = { ...profile, assets, required, inputs, result: evaluateBudget(assets, required), wasmExports: exports };
    }
    const baseline = JSON.parse(await readFile(join(output, 'default-task/manifest.json')));
    const defaultBytes = scope => baseline.result[scope].bytes;
    for (const profile of Object.values(receipt.profiles)) profile.deltaFromDefaultGzip = Object.fromEntries(['total', 'js'].map(scope => [scope, profile.result[scope].bytes - defaultBytes(scope)]));
    receipt.enabledDeltaFromMinimalGzip = Object.fromEntries(['total', 'js'].map(scope => [scope, receipt.profiles.enabled.result[scope].bytes - receipt.profiles.minimal.result[scope].bytes]));
    return receipt;
  } finally {
    await rm(consumer, { recursive: true, force: true });
    receipt.cleanup.removed = true;
    await writeFile(join(output, 'profiles.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
}
export async function nativeInventory(output, config) {
  const inventories = [];
  for (const [host, cwd] of [['native', process.cwd()], ['terminal', resolve('../cli')]]) {
    const command = await loggedRun(output, host + '-metadata', 'cargo', ['metadata', '--format-version=1', '--no-deps', '--locked', '--offline'], { cwd });
    const metadata = JSON.parse(command.stdout);
    inventories.push({ host, command: { ...command, stdout: undefined, cwd }, packages: metadata.packages.filter(p => metadata.workspace_members.includes(p.id)).map(p => ({ name: p.name, manifest: p.manifest_path, features: p.features, dependencies: p.dependencies.map(d => ({ name: d.name, optional: d.optional, features: d.features, defaultFeatures: d.uses_default_features, kind: d.kind, target: d.target })) })) });
  }
  const sources = {};
  for (const path of config.nativeInventory) sources[path] = { sha256: sha256(await readFile(path)) };
  // Android dependencies are declared in the actual control probe, not renderer binaries.
  const gradle = await readFile('native/android/probe/control/build.gradle.kts', 'utf8');
  const android = [...gradle.matchAll(/implementation\("([^"]+)"\)/g)].map(m => m[1]);
  const result = { schema: 1, inventories, sources, android, rendererAssets: [], scope: 'Actual Cargo workspace manifests and Android control-probe dependency declarations. Built-in portable modules are compiled into editac-core, with no per-module optional Cargo feature. FFI bindgen is tooling-only. Terminal inventory records the current CLI manifest, including its vendored engine/session and terminal UI dependencies. Presence of a dependency does not prove renderer parity. Swift/Kotlin/desktop richer presenters remain downstream; no native binary size or per-feature savings claimed.' };
  await writeFile(join(output, 'native-terminal-inventory.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
