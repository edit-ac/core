import { assertDisabledPresenters } from './graph.mjs';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { assertLightweight, eagerInputs } from '../../extension-dx/loading-consumer.mjs';
import { requireTestNode } from '../../../scripts/test-toolchain.mjs';

// Limits are declared before measurement; no timing or device qualification.
export function assertDisabledGraph(inputs) { assertLightweight(inputs); assertDisabledPresenters(inputs); }
const sha = value => createHash('sha256').update(value).digest('hex');
let consumer, output, manifest;
async function run(command, args, log) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  await writeFile(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, log); assert.equal(result.status, 0, log); return result.stdout;
}
before(async () => {
  await requireTestNode();
  output = process.env.EDITAC_MOBILE_DISABLED_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-mobile-disabled-evidence-'));
  await mkdir(output, { recursive: true });
  consumer = await mkdtemp(join(tmpdir(), 'editac-mobile-disabled-consumer-'));
  manifest = { node: process.version, sources: {}, packages: [], limits: { disabledImplementationBytes: 0, disabledAssets: 0 }, qualification: 'packed import/asset correctness; no performance/platform support claim' };
  for (const path of ['package.json', 'package-lock.json', 'tests/consumers/mobile-extensions/disabled.test.mjs']) manifest.sources[path] = sha(await readFile(path));
  for (const name of ['core', 'web']) {
    const directory = join(consumer, 'node_modules/@edit-ac', name); await mkdir(directory, { recursive: true });
    const pack = JSON.parse(await run('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--json', '--pack-destination', consumer], `pack-${name}.log`))[0];
    const bytes = await readFile(join(consumer, pack.filename));
    await writeFile(join(output, pack.filename), bytes);
    manifest.packages.push({ name, sha256: sha(bytes), filename: pack.filename });
    await run('tar', ['-xzf', join(consumer, pack.filename), '--strip-components=1', '-C', directory], `unpack-${name}.log`);
  }
});
after(async () => {
  if (manifest) await writeFile(join(output, 'packed-receipt.json'), JSON.stringify(manifest, null, 2));
  if (consumer) await rm(consumer, { recursive: true, force: true });
});
test('MWX-C01 installed minimal editor imports without browser globals or network', async () => {
  await run(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch=()=>{throw Error('import network')};
    for(const key of ['document','window','navigator','indexedDB'])Object.defineProperty(globalThis,key,{get(){throw Error('import '+key)}});
    const m=await import(${JSON.stringify(join(consumer, 'node_modules/@edit-ac/web/dist/editor.js'))});
    if(typeof m.BrowserEditor!=='function')throw Error('missing BrowserEditor');
  `], 'ssr.log');
  manifest.ssr = 'passed';
});
for (const [name, source] of [
  ['minimal', "import { BrowserEditor } from '@edit-ac/web/editor'; globalThis.MexEditor=BrowserEditor;"],
  ['public-default', "import { createEditor } from '@edit-ac/web'; globalThis.MexEditor=(root,options)=>createEditor(root,{...options,preset:'default'});"],
]) test(`MWX-C01 ${name} packed graph omits disabled presenter code and assets`, async () => {
  const bundle = await build({ stdin: { contents: source, resolveDir: consumer }, bundle: true, splitting: true, format: 'esm', platform: 'browser', metafile: true, outdir: join(output, name), write: true, minify: true });
  await writeFile(join(output, `${name}-metafile.json`), JSON.stringify(bundle.metafile, null, 2));
  const entry = Object.entries(bundle.metafile.outputs).find(([, value]) => value.entryPoint === '<stdin>')[0];
  const inputs = eagerInputs(bundle.metafile, entry);
  manifest.graphs ??= {};
  manifest.graphs[name] = { eagerInputs: inputs.map(path => path.replace(consumer, '<installed-consumer>')),
    contributions: Object.entries(bundle.metafile.outputs).flatMap(([file, value]) => Object.entries(value.inputs).map(([source, info]) => ({ file: file.replace(resolve(output), '<output>'), source: source.replace(consumer, '<installed-consumer>'), bytes: info.bytesInOutput }))),
    assets: Object.keys(bundle.metafile.outputs).filter(path => !/\.js$/.test(path)) };
  assertDisabledGraph(inputs);
  assert.deepEqual(manifest.graphs[name].assets, [], 'disabled CSS/assets emitted');
});
for (const [path, symbol] of [ ['modules/search','documentSearch'], ['modules/reorder','reorderControls'],
  ['modules/slash','slashCommands'], ['modules/references','referenceSuggestions'],
  ['extensions/runtime/search','documentSearch'], ['extensions/runtime/reorder','reorderControls'], ['extensions/runtime/slash','slashCommands'], ['extensions/runtime/references','referenceSuggestions'], ['extensions/runtime/content','contentModules'],
  ['extensions/authoring','Extension'], ['extensions/matching','attachPatternMatching'], ['extensions/spelling','Spelling']
]) test(`MWX-C01 emitted eager-import control rejects ${path}`, async () => {
  const target = join(consumer, 'node_modules/@edit-ac/web/dist', `${path}.js`);
  const bundle = await build({ stdin: { contents: `import { ${symbol} } from ${JSON.stringify(target)}; globalThis.EagerControl=${symbol};`, resolveDir: consumer }, bundle: true, splitting: true, format: 'esm', platform: 'browser', metafile: true, outdir: join(output, 'controls', path), write: true, minify: true });
  const entry = Object.entries(bundle.metafile.outputs).find(([, value]) => value.entryPoint === '<stdin>')[0];
  const inputs = eagerInputs(bundle.metafile, entry);
  assert.ok(inputs.some(input => input.endsWith(`/dist/${path}.js`)), 'real control implementation missing');
  assert.throws(() => assertDisabledGraph(inputs), /disabled optional presenter implementation/);
  manifest.controls ??= []; manifest.controls.push({ path, detected: true, inputs: inputs.map(input => input.replace(consumer, '<installed-consumer>')) });
  await writeFile(join(output, 'controls', path, 'metafile.json'), JSON.stringify(bundle.metafile, null, 2));
});
test('MWX-C01 absence guard rejects injected disabled feature code', () => {
  assert.throws(() => assertDisabledGraph(['node_modules/@edit-ac/web/dist/modules/slash.js']));
  assert.throws(() => assertDisabledGraph(['node_modules/@edit-ac/web/dist/modules/code/presenter.js']));
});

test('MWX-C01 installed native minimal graph omits disabled code and rejects a real eager import', async () => {
  async function graph(entry) {
    const seen = new Set();
    async function visit(path) {
      if (seen.has(path)) return; seen.add(path);
      const ast = parse(await readFile(path, 'utf8'), { sourceType: 'module' });
      for (const statement of ast.program.body) {
        if (!['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(statement.type) || !statement.source) continue;
        const name = statement.source.value;
        const target = name.startsWith('.') ? resolve(dirname(path), name) : name === '@edit-ac/core' ? join(consumer, 'node_modules/@edit-ac/core/dist/index.js') : name === '@edit-ac/core/extensions' ? join(consumer, 'node_modules/@edit-ac/core/dist/extensions/index.js') : undefined;
        assert.ok(target, `unresolved installed native import: ${name}`); await visit(target);
      }
    }
    await visit(entry); return [...seen].sort();
  }
  const inputs = await graph(join(consumer, 'node_modules/@edit-ac/web/dist/editor.js'));
  assertDisabledGraph(inputs); assert.ok(inputs.length > 0);
  const control = join(consumer, 'eager-native.mjs');
  await writeFile(control, `import { slashCommands } from "./node_modules/@edit-ac/web/dist/modules/slash.js"; globalThis.EagerNative=slashCommands;`);
  const eager = await graph(control);
  assert.throws(() => assertDisabledGraph(eager), /disabled optional presenter implementation/);
  manifest.native = { inputs: inputs.map(path => path.replace(consumer, '<installed-consumer>')), realEagerControlRejected: true };
});
