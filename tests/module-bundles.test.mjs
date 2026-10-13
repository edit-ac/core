import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const evidence = resolve('../architecture/evidence');
const output = resolve(process.env.EDITAC_MODULE_BUNDLES ?? join(evidence, 'modules-matrix/bundles'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const presenters = ['slash', 'references', 'reorder', 'content', 'math'];
const profiles = {
  minimal: "export { mountEditor } from '@edit-ac/web';",
  disabled: "export { mountEditor } from '@edit-ac/web'; export const modules = Object.freeze({});",
  slash: "export { mountEditor, slashCommands } from '@edit-ac/web';",
  references: "export { mountEditor, referenceSuggestions, referenceBlock } from '@edit-ac/web';",
  reorder: "export { mountEditor, reorderControls } from '@edit-ac/web';",
  content: "export { mountEditor, contentModules } from '@edit-ac/web';",
  math: "export { mountEditor } from '@edit-ac/web'; export { mathRenderer, mathAtom, mathModuleDefinition } from '@edit-ac/web/math';",
  all: "export { mountEditor, slashCommands, referenceSuggestions, referenceBlock, reorderControls, contentModules } from '@edit-ac/web'; export { mathRenderer, mathAtom, mathModuleDefinition } from '@edit-ac/web/math';",
};
const manifests = {};
const measurements = { profiles: {}, packs: [], scope: 'Minified ESM transfer bytes, Brotli default compression; no latency/device qualification. WASM is a separate shared asset. MathML has no CSS/fonts.' };
let consumer;

before(async () => {
  await mkdir(output, { recursive: true });
  consumer = await mkdtemp(join(tmpdir(), 'editac-module-bundles-'));
  for (const name of ['core', 'web']) {
    const destination = join(output, `pack-${name}`);
    await mkdir(destination, { recursive: true });
    const { stdout, stderr } = await run('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', destination]);
    await writeFile(join(output, `pack-${name}.log`), stdout + stderr);
    const [pack] = JSON.parse(stdout);
    const archive = join(destination, pack.filename);
    measurements.packs.push({ name, file: archive, sha256: hash(await readFile(archive)), files: pack.files.map(f => f.path) });
    const directory = join(consumer, 'node_modules/@edit-ac', name);
    await mkdir(directory, { recursive: true });
    await run('tar', ['-xzf', archive, '-C', directory, '--strip-components=1']);
  }
  const wasm = await readFile(join(consumer, 'node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm'));
  measurements.wasm = { bytes: wasm.length, brotliBytes: brotliCompressSync(wasm).length, sha256: hash(wasm) };
  const glue = await readFile(join(consumer, 'node_modules/@edit-ac/core/dist/wasm/editac_wasm.js'));
  measurements.wasmGlue = { bytes: glue.length, brotliBytes: brotliCompressSync(glue).length, sha256: hash(glue) };
  for (const [profile, contents] of Object.entries(profiles)) {
    const result = await build({ stdin: { contents, resolveDir: consumer, sourcefile: `${profile}.mjs` }, bundle: true, format: 'esm', splitting: true, minify: true, platform: 'browser', outdir: join(output, profile), metafile: true, write: false });
    manifests[profile] = result.metafile;
    await mkdir(join(output, profile), { recursive: true });
    await writeFile(join(output, `${profile}-manifest.json`), JSON.stringify(result.metafile, null, 2) + '\n');
    const files = [];
    for (const file of result.outputFiles) {
      await writeFile(file.path, file.contents);
      files.push({ file: file.path, bytes: file.contents.length, brotliBytes: brotliCompressSync(file.contents).length, sha256: hash(file.contents) });
    }
    measurements.profiles[profile] = { files, jsBytes: files.reduce((n, f) => n + f.bytes, 0), brotliJsBytes: files.reduce((n, f) => n + f.brotliBytes, 0) };
  }
  await writeFile(join(output, 'profiles.json'), JSON.stringify(measurements, null, 2) + '\n');
});

after(async () => {
  if (consumer) await rm(consumer, { recursive: true, force: true });
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ consumer, consumerRemoved: true, browsersStarted: 0, serversStarted: 0 }) + '\n');
});

function contributed(manifest, pattern) {
  return Object.values(manifest.outputs).flatMap(o => Object.entries(o.inputs))
    .filter(([path, data]) => pattern.test(path) && data.bytesInOutput > 0);
}
const modulePattern = name => new RegExp(`/modules/${name}\\.js$`);
const lazyPattern = /\/modules\/(math-renderer\.js|vendor\/katex\.mjs)$/;

for (const profile of ['minimal', 'disabled']) test(`${profile} packed production graph contains no optional presenter or math asset bytes`, () => {
  for (const name of presenters) assert.deepEqual(contributed(manifests[profile], modulePattern(name)), [], name);
  assert.deepEqual(contributed(manifests[profile], lazyPattern), []);
  assert.ok(measurements.wasm.bytes > 0);
  assert.ok(measurements.profiles[profile].jsBytes > 0);
});

for (const profile of presenters) test(`${profile} packed enabled graph retains its presenter and excludes unrelated optional code`, () => {
  assert.ok(contributed(manifests[profile], modulePattern(profile)).length > 0);
  for (const name of presenters.filter(n => n !== profile)) assert.deepEqual(contributed(manifests[profile], modulePattern(name)), [], name);
  if (profile !== 'math') assert.deepEqual(contributed(manifests[profile], lazyPattern), []);
});

test('all-enabled graph is the absence-oracle positive control and keeps the verified math renderer lazy', async () => {
  for (const name of presenters) assert.ok(contributed(manifests.all, modulePattern(name)).length > 0);
  for (const profile of ['math', 'all']) {
    const entry = Object.values(manifests[profile].outputs).find(o => o.entryPoint && basename(o.entryPoint) === `${profile}.mjs`);
    assert.ok(entry);
    assert.equal(Object.keys(entry.inputs).some(p => lazyPattern.test(p)), false);
    assert.ok(entry.imports.some(i => i.kind === 'dynamic-import'));
    assert.equal(new Set(contributed(manifests[profile], lazyPattern).map(([p]) => p)).size, 2);
    assert.ok(measurements.profiles[profile].files.every(f => f.file.endsWith('.js')));
  }
  assert.equal(hash(await readFile(join(consumer, 'node_modules/@edit-ac/web/dist/modules/vendor/katex.mjs'))), 'e5bc26598084ad869939ecaa262673814f26ed586312a409b5f8427c01e4f681');
});

test('every advertised module capability has hashed passing three-engine fixture evidence at the current presenter revision', async () => {
  const matrix = JSON.parse(await readFile(join(evidence, 'modules-matrix/capabilities.json')));
  assert.deepEqual(matrix.modules.map(m => m.module), ['slash', 'references', 'reorder', 'images', 'tables', 'math']);
  const cache = new Map();
  const required = {
    slash: ['read', 'edit', 'disabled'], references: ['read', 'edit', 'copy', 'disabled'],
    reorder: ['read', 'edit', 'disabled'], images: ['read', 'copy', 'disabled'],
    tables: ['read', 'edit', 'copy', 'markdown', 'disabled'], math: ['read', 'disabled'],
  };
  for (const module of matrix.modules) {
    assert.deepEqual(module.qualifiedCapabilities, required[module.module]);
    assert.equal(hash(await readFile(module.source)), module.sourceSha256, module.source);
    for (const capability of module.qualifiedCapabilities) {
      const proofs = module.proofs.filter(p => p.capability === capability);
      assert.ok(proofs.length > 0);
      for (const engine of ['chromium', 'firefox', 'webkit']) assert.ok(proofs.some(p => p.engine === engine));
      for (const proof of proofs) {
        if (!cache.has(proof.artifact)) {
          const bytes = await readFile(join(evidence, proof.artifact));
          cache.set(proof.artifact, { bytes, receipt: JSON.parse(bytes) });
        }
        const { bytes, receipt } = cache.get(proof.artifact);
        assert.equal(hash(bytes), proof.sha256, proof.artifact);
        assert.equal(receipt.engine, proof.engine);
        assert.equal(receipt.sources[module.source], module.sourceSha256);
        assert.equal(receipt.cases.find(c => c.name === proof.case)?.passed, true, proof.case);
        assert.ok(receipt.counts.executed > 0);
      }
    }
  }
});
