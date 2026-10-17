import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './architecture-layers.mjs';
import { auditTaskGraph, describeAsset, evaluateBudget, assertBudget, compression } from './browser-size-contract.mjs';

// Admit only the implemented public 0.0.0 SDK consumers. This is not a claim
// about arbitrary semver ranges, published releases, or native platform SDKs.
export function auditConsumerGraph(sources, metafile, manifest, { markdown = false } = {}) {
  auditTaskGraph(sources, { markdown });
  const packages = markdown ? ['core', 'web', 'markdown'] : ['core', 'web'];
  const pattern = new RegExp(`^node_modules/@edit-ac/(${packages.join('|')})/dist/`);
  for (const path of Object.keys(sources)) {
    assert(path === 'task.mjs' || (pattern.test(path) && !path.split('/').includes('..') && !path.includes('\\')), `Unqualified optional/private package: ${path}`);
  }
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(metafile.inputs).sort(), 'Graph input inventory differs');
  assert.deepEqual(Object.keys(sources).sort(), [...manifest.inputs].sort(), 'Measured input inventory differs');
  const outputName = path => {
    const local = isAbsolute(path) ? relative(manifest.ephemeralRoot, path) : path;
    assert(local.startsWith('public/') && !local.split('/').includes('..'), `Unpacked output: ${path}`);
    return posix.relative('public', local);
  };
  const outputs = new Set(Object.keys(metafile.outputs).map(outputName));
  assert(outputs.has('task.js'), 'Missing production Task entry');
  for (const [path, info] of Object.entries(metafile.outputs)) {
    assert(manifest.required.some(a => a.name === outputName(path) && a.kind === 'js'), `Uncounted output: ${path}`);
    for (const imp of info.imports) {
      assert(!imp.external && outputs.has(outputName(imp.path)), `Uninventoried output import: ${imp.path}`);
    }
  }
  const opaque = !Object.keys(sources).some(p => p.endsWith('core/dist/wasm/editac_wasm.js'));
  for (const [name, kind] of [['task.js', 'js'], ['task.css', 'css'], ['wasm/editac_wasm_bg.wasm', 'wasm'], ...(opaque ? [['wasm/editac_wasm.js', 'js']] : []), ...(markdown ? [['wasm/editac_markdown_wasm_bg.wasm', 'wasm']] : [])]) {
    assert(manifest.required.some(a => a.name === name && a.kind === kind), `Missing required resource: ${name}`);
  }
}

export async function admitMeasuredConsumer(directory, { markdown = false, prerequisiteOnly = false } = {}) {
  const json = async path => JSON.parse(await readFile(join(directory, path), 'utf8'));
  const manifest = await json('manifest.json'), metafile = await json('metafile.json');
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.profile, markdown ? 'markdown-enabled-task' : 'default-task');
  assert.equal(manifest.fixtureBaseline, false, 'Fixture baseline is not qualification');
  assert.equal(manifest.productionFixtureAbsent, true);
  assert.deepEqual(manifest.compression, compression);
  assert(manifest.commands.length > 0 && manifest.commands.every(c => c.exit === 0 && !c.error), 'Incomplete measurement commands');
  assert.deepEqual(manifest.packs.map(p => p.name).sort(), (markdown ? ['core', 'web', 'markdown'] : ['core', 'web']).sort());
  const temp = await mkdtemp(join(tmpdir(), 'editac-fit-loading-'));
  try {
    for (const pack of manifest.packs) {
      assert.equal(pack.filename, `edit-ac-${pack.name}-0.0.0.tgz`, 'Only current implemented package identity is qualified');
      const archive = resolve(directory, pack.filename);
      assert.equal(hash(await readFile(archive)), pack.sha256, 'Packed artifact identity changed');
      const dest = join(temp, 'node_modules/@edit-ac', pack.name);
      await mkdir(dest, { recursive: true });
      const unpack = spawnSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { encoding: 'utf8' });
      assert.equal(unpack.status, 0, unpack.stderr);
      const pkg = JSON.parse(await readFile(join(dest, 'package.json')));
      assert.equal(pkg.name, '@edit-ac/' + pack.name); assert.equal(pkg.version, '0.0.0');
      assert(!Object.values({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }).some(v => /^(?:workspace:|file:|link:)/.test(v)), 'Workspace alias in packed manifest');
    }
    const sources = {};
    for (const path of manifest.inputs) {
      assert(path === 'task.mjs' || /^node_modules\/@edit-ac\/(core|web|markdown)\/dist\//.test(path), 'Unpacked input');
      assert(!path.split('/').includes('..') && !path.includes('\\'), 'Input escapes consumer');
      if (path === 'task.mjs') sources[path] = (markdown ? "export {initMarkdown} from '@edit-ac/markdown'; export {markdownExtension} from '@edit-ac/markdown/web';\n" : '') + "export {init} from '@edit-ac/core'; export {createEditor,taskPreset,CheckpointStorage} from '@edit-ac/web';\n";
      else sources[path] = await readFile(join(temp, path), 'utf8');
    }
    assert.deepEqual(manifest.inputHashes, Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, hash(text)])), 'Packed source identities changed');
    auditConsumerGraph(sources, metafile, manifest, { markdown });
    const assets = [];
    for (const asset of manifest.assets) {
      assert(!isAbsolute(asset.name) && !asset.name.split('/').includes('..') && !asset.name.includes('\\'), 'Resource escapes artifact directory');
      const bytes = await readFile(join(directory, 'artifacts', asset.name));
      const measured = describeAsset(asset.name, asset.kind, bytes);
      assert.deepEqual(measured, asset, `Resource measurement changed: ${asset.name}`);
      if (asset.kind === 'wasm') {
        const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(e => e.name);
        assert(!exports.some(n => /fixture|created_document_count/.test(n)), 'Qualification-only WASM');
        if (asset.name === 'wasm/editac_wasm_bg.wasm') {
          assert(exports.includes('engine_new') && exports.includes('engine_restore'));
          assert(!exports.some(n => /markdown/.test(n)), 'Optional parser in minimal engine');
        }
      }
      assets.push(measured);
    }
    assert.deepEqual(manifest.required.map(a => a.name).sort(), assets.map(a => a.name).sort(), 'Delivered/countable resource inventory differs');
    const result = evaluateBudget(assets, manifest.required);
    assert.deepEqual(result, manifest.result, 'Budget result differs');
    if (!markdown && !prerequisiteOnly) assertBudget(result);
    return { profile: manifest.profile, result, packs: manifest.packs, inputHashes: manifest.inputHashes, manifestHash: hash(await readFile(join(directory, 'manifest.json'))), assets };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
