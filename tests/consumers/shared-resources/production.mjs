import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile, cp, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describeAsset } from '../../../scripts/browser-size-contract.mjs';
import { auditSharedAssets, auditSharedGraph } from '../../../scripts/shared-resource-contract.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
export async function prepareSharedSite(consumer, { output, facts }) {
  const site = join(consumer, 'site'); await mkdir(site);
  async function put(path, text) { await mkdir(join(site, path, '..'), { recursive: true }); await writeFile(join(site, path), text); }
  async function run(args, label) {
    const result = spawnSync(process.execPath, args, { cwd: site, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    assert.equal(result.error, undefined, label); assert.equal(result.status, 0, label);
    return { command: [process.execPath, ...args], exit: result.status, log: label + '.log' };
  }
  const dependencies = Object.fromEntries(facts.packs.map(pack => ['@edit-ac/' + pack.name, 'file:' + join(consumer, pack.name, pack.file)]));
  Object.assign(dependencies, { astro: '7.3.8', react: '19.3.0', 'react-dom': '19.3.0', '@astrojs/node': '11.1.7', esbuild: '0.25.12' });
  await put('package.json', JSON.stringify({ private: true, type: 'module', dependencies }));
  const install = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: site, encoding: 'utf8', timeout: 180000 });
  await writeFile(join(output, 'site-install.log'), (install.stdout ?? '') + (install.stderr ?? ''));
  assert.equal(install.error, undefined); assert.equal(install.status, 0, 'site-install');
  const build = sha(JSON.stringify(facts.packs.map(pack => [pack.name, pack.sha256]))), assetBase = '/fixture/v-' + build.slice(0, 16);
  const engineSha256 = sha(await readFile(join(site, 'node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm')));
  await put('src/site.mjs', (await readFile('tests/consumers/shared-resources/site.mjs', 'utf8')).replace('__EDITAC_RELEASE__', JSON.stringify({ build, engineSha256 })));
  // Rollup's actual emitted modules/import edges are normalized to the existing
  // graph contract; this is not a hand-maintained package inventory.
  await put('astro.config.mjs', `import {defineConfig} from 'astro/config';import {writeFileSync} from 'node:fs';
export default defineConfig({base:'/fixture',vite:{build:{minify:true},plugins:[{name:'retain-actual-graph',generateBundle(_,bundle){const inputs={},outputs={};for(const [name,item] of Object.entries(bundle)){if(item.type!=='chunk')continue;for(const id of Object.keys(item.modules)){const local=id.replace(process.cwd()+'/', '');inputs[local]={};}outputs[name]={imports:item.imports.map(path=>({path,kind:'import-statement'})),dynamicImports:item.dynamicImports,entryPoint:item.facadeModuleId,inputs:Object.keys(item.modules).map(id=>id.replace(process.cwd()+'/', ''))};}writeFileSync('production-graph.json',JSON.stringify({inputs,outputs},null,2));}}]}});`);
  const html = `---\nimport Editor from '@edit-ac/astro/Editor.astro';\n---\n<html><head><meta name="editac-assets" content="${assetBase}" /><meta name="editac-build" content="${build}" /><meta name="editac-engine" content="${engineSha256}" /></head><body><main id="editors"></main><template id="astro-template"><Editor name="description" /></template><script>import '../site.mjs';</script></body></html>`;
  // A shared layout owns the client entry. Repeating the same script on every
  // page makes Astro emit identical wrapper bytes at distinct URLs.
  await put('src/Layout.astro', html.replace("import '../site.mjs'", "import './site.mjs'"));
  const page = "---\nimport Layout from '../Layout.astro';\n---\n<Layout />";
  await put('src/pages/index.astro', page);
  for (const name of ['plain', 'react', 'astro', 'mixed', 'task', 'document']) await put('src/pages/' + name + '.astro', page);
  const commands = [await run(['node_modules/astro/bin/astro.mjs', 'build'], 'site-build')];
  // Existing packed-consumer SSR guard: actual package imports and React render.
  await put('ssr.mjs', `import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToString} from 'react-dom/server';for(const name of ['window','document','indexedDB','navigator','fetch','WebAssembly'])Object.defineProperty(globalThis,name,{configurable:true,get(){throw Error('SSR accessed '+name)}});for(const name of ['core','web','astro','markdown'])await import('@edit-ac/'+name);const {EditorHost}=await import('@edit-ac/react');assert.equal(renderToString(createElement(EditorHost,{options:{identity:{documentId:'ssr'},databaseName:'ssr',assetUrl:'/never.wasm'},attributes:{id:'host'}})),'<div id="host"></div>');`);
  commands.push(await run(['ssr.mjs'], 'site-ssr'));
  await put('eager.mjs', "export {init} from '@edit-ac/core';export {createEditor} from '@edit-ac/web';export {initMarkdown} from '@edit-ac/markdown';\n");
  await put('negative-build.mjs', "import {build} from 'esbuild';import {writeFileSync} from 'node:fs';const result=await build({entryPoints:['eager.mjs'],bundle:true,format:'esm',minify:true,outfile:'negative/eager.js',metafile:true});writeFileSync('negative/eager-graph.json',JSON.stringify(result.metafile,null,2));\n");
  commands.push(await run(['negative-build.mjs'], 'site-eager-build'));
  const eagerGraph = JSON.parse(await readFile(join(site, 'negative/eager-graph.json')));
  assert.throws(() => auditSharedGraph(eagerGraph, { defaultOnly: true }), /Eager optional/);
  await cp(join(site, 'negative'), join(output, 'negative'), { recursive: true });
  const graph = JSON.parse(await readFile(join(site, 'production-graph.json'))); auditSharedGraph(graph);
  const inventory = [];
  async function walk(directory) { for (const value of await readdir(directory, { withFileTypes: true })) { const path = join(directory, value.name); if (value.isDirectory()) await walk(path); else if (/\.(js|mjs|wasm|css)$/.test(path)) { const bytes = await readFile(path), name = relative(join(site, 'dist'), path), kind = name.endsWith('.wasm') ? 'wasm' : name.endsWith('.css') ? 'css' : 'js'; inventory.push({ ...describeAsset(name, kind, bytes), url: '/fixture/' + name, bytes: bytes.length, build, role: kind === 'wasm' && /editac_wasm_bg[.-]/.test(name) ? 'core-wasm' : kind === 'wasm' && /editac_markdown_wasm_bg[.-]/.test(name) ? 'optional-markdown-wasm' : 'site-chunk' }); } } }
  await walk(join(site, 'dist')); auditSharedAssets(inventory);
  // Sensitivity uses copied emitted bodies under a second URL, not invented hashes.
  const core = inventory.find(a => a.role === 'core-wasm');
  const duplicate = { ...core, url: core.url.replace(/[^/]+$/, 'duplicate.wasm') };
  await copyFile(join(site, 'dist', core.name), join(site, 'dist', core.name.replace(/[^/]+$/, 'duplicate.wasm')));
  await writeFile(join(output, 'duplicate-inventory.json'), JSON.stringify([...inventory, duplicate], null, 2));
  assert.throws(() => auditSharedAssets([...inventory, duplicate]), /Duplicate emitted bytes/);
  const staleHtml = (await readFile(join(site, 'dist/task/index.html'), 'utf8')).replace(build, 'stale-' + build);
  await mkdir(join(site, 'dist/rollover')); await writeFile(join(site, 'dist/rollover/index.html'), staleHtml);
  const rollover = { file: 'site/rollover/index.html', sha256: sha(staleHtml), staleBuild: 'stale-' + build, currentBuild: build };
  await cp(join(site, 'dist'), join(output, 'site'), { recursive: true });
  await copyFile(join(site, 'production-graph.json'), join(output, 'production-graph.json'));
  await copyFile(join(site, 'package-lock.json'), join(output, 'site-package-lock.json'));
  const parser = inventory.find(a => a.role === 'optional-markdown-wasm');
  facts.production = { build, assetBase, rollover, commands, graph: 'production-graph.json', inventory, ssr: { passed: true, browserAccess: 0 }, duplicate, eagerGraph, incompatible: { build: parser.build + '-incompatible', engineSha256: parser.sha256, assetUrl: parser.url }, packageLockSha256: sha(await readFile(join(site, 'package-lock.json'))) };
  return join(site, 'dist');
}
