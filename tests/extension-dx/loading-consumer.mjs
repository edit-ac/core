import { assertDisabledPresenters } from '../consumers/mobile-extensions/graph.mjs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha = value => createHash('sha256').update(value).digest('hex');
const forbidden = /(?:\/sync\/(?:attachment|configured|session|protocol|presence)\.js|\/modules\/math(?:-renderer)?\.js|\/modules\/vendor\/|\/modules\/code\/|\/markdown\/)/;
export function assertLightweight(inputs) {
  assert.deepEqual(inputs.filter(path => forbidden.test('/' + path)), [], 'disabled implementation in the eager graph');
}
export function eagerInputs(meta, entry) {
  const visited = new Set(), inputs = new Set();
  function visit(file) {
    if (visited.has(file)) return; visited.add(file);
    const output = meta.outputs[file]; assert.ok(output, 'missing emitted import: ' + file);
    for (const path of Object.keys(output.inputs)) inputs.add(path);
    for (const edge of output.imports) if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
  }
  visit(entry); return [...inputs].sort();
}
export function assertOneEngine(requests) {
  const assets = requests.filter(r => /editac_wasm_bg\.wasm(?:\?|$)/.test(r.url) && r.status === 200);
  assert.equal(assets.length, 1, 'duplicate engine asset request');
  assert.ok(assets[0].sha256); return assets[0].sha256;
}

export async function prepareLoadingConsumer(consumer, { output, facts, run }) {
  const fixture = resolve('tests/extension-dx/configuration-consumer');
  await writeFile(join(consumer,'package.json'), JSON.stringify({ private:true, type:'module' }));
  const pins = JSON.parse(await readFile('../architecture/evidence/extension-dx/contract-20261017/generated-artifacts.json','utf8'));
  facts.authenticatedRuntime = [];
  for (const pin of pins) {
    const extraction = spawnSync('tar',['-xOf',pin.pack,pin.member],{maxBuffer:16*1024*1024});
    assert.equal(extraction.status,0); const hash=sha(extraction.stdout);
    assert.equal(hash,pin.authenticatedSha256,'admitted generated member');
    const path=pin.member.replace('package/',''), name=pin.member.includes('editac_markdown')?'markdown':'core';
    await writeFile(join(consumer,name,'package',path),extraction.stdout);
    facts.authenticatedRuntime.push({ pack:pin.pack,member:pin.member,sha256:hash,localStaleDistUsed:false,assembledBeforeInstallation:true });
  }
  // Produce immutable, authenticated tarballs before installation. No installed
  // package is patched, and stale local dist members remain preserved in the
  // original input packs retained by browserHarness.
  const tested=join(output,'tested-packages');await mkdir(tested);facts.testedPackages=[];
  for(const name of ['core','web','markdown']) {
    const directory=join(tested,name);await mkdir(directory);
    const result=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',directory],{cwd:join(consumer,name,'package'),encoding:'utf8',maxBuffer:4*1024*1024});
    await writeFile(join(output,`authenticated-pack-${name}.log`),result.stdout+'\n'+result.stderr);assert.equal(result.status,0,'authenticated '+name+' pack');
    const pack=JSON.parse(result.stdout)[0],path=join(directory,pack.filename),bytes=await readFile(path);
    facts.testedPackages.push({name,path,sha256:sha(bytes),bytes:bytes.length,installed:name!=='markdown',postInstallMutation:false});
  }
  // Markdown is deliberately not installed. An optional bare specifier must not
  // prevent the ordinary public facade from bundling in this clean consumer.
  await run('npm', ['install','--prefix',consumer,'--offline','--ignore-scripts','--no-audit','--no-fund',...facts.testedPackages.filter(pack=>pack.installed).map(pack=>pack.path)], 'install.log');
  for(const pin of facts.authenticatedRuntime) {
    if(pin.member.includes('editac_markdown'))continue;
    assert.equal(sha(await readFile(join(consumer,'node_modules/@edit-ac/core',pin.member.replace('package/','')))),pin.sha256,'installed authenticated core member');
  }
  const highlight = JSON.parse(await readFile('../architecture/evidence/code-highlight/receipt.json','utf8'));
  const backend='packages/web/dist/modules/code/backend/editac_highlighting_bg.wasm';
  assert.equal(sha(await readFile(backend)),highlight.runtimeHashes[backend], 'qualified highlighting backend');
  facts.highlighting={ owner:'RCH-1.5',receipt:'architecture/evidence/code-highlight/receipt.json',backendSha256:highlight.runtimeHashes[backend],preparedBackend:false };
  await writeFile(join(consumer,'public-smoke.ts'),(await readFile(join(fixture,'public-smoke.ts'),'utf8'))+"\nimport {managedCodeHighlighting} from '@edit-ac/web';\nimport {managedCodeHighlighting as advancedHighlighting} from '@edit-ac/web/highlighting';\nconst managed = managedCodeHighlighting({enabled:false}); const advanced = advancedHighlighting();\n");
  await run(process.execPath,['node_modules/typescript/bin/tsc','--strict','--skipLibCheck','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',join(consumer,'public-smoke.ts')],'installed-typecheck.log');
  await run(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('SSR fetch')};for(const key of ['document','window','indexedDB'])Object.defineProperty(globalThis,key,{get(){throw Error('SSR '+key)}});const m=await import(${JSON.stringify(join(consumer,'node_modules/@edit-ac/web/dist/index.js'))});if(!m.managedCodeHighlighting||!m.createEditor)throw Error('Missing public exports');`],'installed-ssr.log');
  facts.installedConsumer={typecheck:true,ssr:true,privateImports:false,install:'offline core/web tarballs; Markdown deliberately omitted'};
  const id=sha(JSON.stringify({packs:facts.packs,recipe:sha(await readFile(new URL(import.meta.url))),fixture:sha(await readFile(join(fixture,'session.mjs')))})).slice(0,20), base='/fixture/v-'+id;
  const site=join(consumer,'site'), version=join(site,'v-'+id); await mkdir(version,{recursive:true});
  for(const name of ['core','web','markdown']) await cp(join(consumer,name,'package/dist'),join(version,name),{recursive:true});
  const paths={ core:base+'/core',web:base+'/web',markdown:base+'/markdown',bundle:base+'/bundle' };
  let source=await readFile(join(fixture,'session.mjs'),'utf8');
  // Prepared clipboard payloads are explicit in every browser. Firefox discards
  // clipboardData on constructed ClipboardEvents; this is not OS clipboard proof.
  source=source.replace("new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})","window.preparedClipboardEvent('paste',data)");
  source=source.replace("new URL('/core/wasm/editac_wasm_bg.wasm', location.href)",`new URL('${paths.core}/wasm/editac_wasm_bg.wasm', location.href)`);
  source+="\nimport { managedCodeHighlighting } from '@edit-ac/web';\nwindow.configurationFixture.init=init; window.configurationFixture.assetUrl=assetUrl; window.configurationFixture.managedCodeHighlighting=managedCodeHighlighting;\nwindow.configurationFixture.options=options=>({...options,...(window.loadingAssets?{assets:window.loadingAssets}:{})});\n";
  await writeFile(join(consumer,'session.mjs'),source);
  await writeFile(join(version,'session.mjs'),source);
  // The enabled optional codec is a dedicated entry over its admitted package;
  // it has no static edge from the ordinary facade/consumer entry.
  const markdownEntry=join(consumer,'markdown-entry.mjs');
  await writeFile(markdownEntry,`export {loadMarkdownAdapter} from ${JSON.stringify(join(consumer,'markdown/package/dist/web.js'))};`);
  const minimalSource=(await readFile(join(fixture,'minimal.mjs'),'utf8')).replace("new URL('/core/wasm/editac_wasm_bg.wasm', location.href)",`new URL('${paths.core}/wasm/editac_wasm_bg.wasm', location.href)`);
  await writeFile(join(consumer,'minimal.mjs'),minimalSource);
  const minimal=await build({absWorkingDir:consumer,entryPoints:{minimal:join(consumer,'minimal.mjs')},outdir:join(version,'minimal'),bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent',chunkNames:'chunks/[name]-[hash]'});
  const minimalEntry=Object.keys(minimal.metafile.outputs).find(key=>minimal.metafile.outputs[key].entryPoint==='minimal.mjs');
  const minimalEager=eagerInputs(minimal.metafile,minimalEntry);assertLightweight(minimalEager);assertDisabledPresenters(minimalEager);
  facts.minimalGraph={entry:minimalEntry,eager:minimalEager,optionalOutputs:Object.entries(minimal.metafile.outputs).filter(([,value])=>Object.keys(value.inputs).some(input=>/\/extensions\/runtime\/|\/extensions\/(authoring|matching|spelling)\.js|\/modules\/(search|reorder|references|slash|content)\.js/.test(input))).map(([path])=>path.slice(path.indexOf('/minimal/')+1))};
  await writeFile(join(output,'minimal-metafile.json'),JSON.stringify(minimal.metafile,null,2));
  await writeFile(join(site,'minimal-default.html'),`<!doctype html><html lang="en"><title>Minimal installed default</title><script type="module" src="${base}/minimal/minimal.js"></script></html>`);
  const result=await build({absWorkingDir:consumer,entryPoints:{session:join(consumer,'session.mjs'),markdown:markdownEntry},
    outdir:join(version,'bundle'),bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent',
    chunkNames:'chunks/[name]-[hash]',assetNames:'assets/[name]-[hash]'});
  const meta=result.metafile; await writeFile(join(output,'bundler-metafile.json'),JSON.stringify(meta,null,2));
  const entry=Object.keys(meta.outputs).find(key=>meta.outputs[key].entryPoint==='session.mjs'); assert.ok(entry);
  const eager=eagerInputs(meta,entry); assertLightweight(eager);
  const features={};
  for(const [path,info] of Object.entries(meta.outputs)) for(const input of Object.keys(info.inputs)) {
    if(forbidden.test('/'+input)) (features[input]??=[]).push(path);
  }
  facts.graph={entry,eager,features,omittedOptionalInstallation:true,allInputs:Object.keys(meta.inputs),baseline:'Yrs/update/local storage remain in core; no engine binary or size-budget claim'};
  assert.ok(Object.keys(features).some(path=>path.includes('/sync/attachment.js')));
  assert.ok(Object.keys(features).some(path=>path.includes('/modules/math-renderer.js')));
  const native=new Map();
  async function traverse(path) {
    if(native.has(path))return;const text=await readFile(path,'utf8');const edges=[];native.set(path,edges);
    const pattern=/\b(?:import|export)\s+(?:[^'"();]*?\s+from\s*)?['"]([^'"]+)['"]/g;
    for(const [,specifier] of text.matchAll(pattern)) {
      const target=specifier.startsWith('.')?resolve(dirname(path),specifier):specifier==='@edit-ac/core'?join(version,'core/index.js'):specifier==='@edit-ac/core/extensions'?join(version,'core/extensions/index.js'):specifier==='@edit-ac/web'?join(version,'web/index.js'):undefined;
      assert.ok(target,'unexpected native static import '+specifier); edges.push(target); await traverse(target);
    }
  }
  await traverse(join(version,'session.mjs'));
  const nativeInputs=[...native.keys()].map(path=>relative(version,path));assertLightweight(nativeInputs);
  facts.nativeGraph={eager:nativeInputs,edges:Object.fromEntries([...native].map(([path,edges])=>[relative(version,path),edges.map(e=>relative(version,e))]))};
  await writeFile(join(output,'native-graph.json'),JSON.stringify(facts.nativeGraph,null,2));
  // A real counterfactual bundle forces orchestration into the entry graph.
  const control=join(consumer,'eager-control.mjs');
  await writeFile(control,`import {connectConfiguredCollaboration} from ${JSON.stringify(join(consumer,'web/package/dist/sync/configured.js'))};globalThis.eagerControl=connectConfiguredCollaboration;`);
  const corrupted=await build({absWorkingDir:consumer,entryPoints:[control],write:false,bundle:true,format:'esm',platform:'browser',metafile:true,logLevel:'silent'});
  assert.throws(()=>assertLightweight(Object.keys(corrupted.metafile.inputs)),/disabled implementation/);
  facts.controls={realEagerBundleRejected:true};
  await writeFile(join(output,'eager-control-metafile.json'),JSON.stringify(corrupted.metafile,null,2));
  const imports={'@edit-ac/core':paths.core+'/index.js','@edit-ac/core/extensions':paths.core+'/extensions/index.js','@edit-ac/web':paths.web+'/index.js','@edit-ac/markdown/web':paths.markdown+'/web.js'};
  const bundled=process.env.EDITAC_LOADING_HOST==='bundler';
  const assets=bundled?{manifest:{markdownModule:paths.bundle+'/markdown.js',markdown:paths.markdown+'/wasm/editac_markdown_wasm_bg.wasm'}}:undefined;
  const hostManifest={manifest:{engine:paths.core+'/wasm/editac_wasm_bg.wasm',markdownModule:bundled?paths.bundle+'/markdown.js':paths.markdown+'/web.js',markdown:paths.markdown+'/wasm/editac_markdown_wasm_bg.wasm',mathModule:paths.web+'/modules/math.js',highlightWorker:paths.web+'/modules/code/worker-entry.js',highlightBackend:paths.web+'/modules/code/backend/editac_highlighting.js'}};
  // Runtime configuration requires absolute host URLs. The recipe serializes
  // paths so the same immutable tree can be deployed at any authorized origin.
  await writeFile(join(output,'host-manifest.json'),JSON.stringify({identity:id,assets:hostManifest},null,2));
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Installed loading consumer</title><script type="importmap">${JSON.stringify({imports})}</script><script>window.loadingPaths=${JSON.stringify(paths)};window.loadingAssets=${JSON.stringify(assets)};window.loadingManifest=${JSON.stringify(hostManifest)};if(window.loadingAssets)for(const [key,path] of Object.entries(window.loadingAssets.manifest))window.loadingAssets.manifest[key]=new URL(path,location.href).href;for(const [key,path] of Object.entries(window.loadingManifest.manifest))window.loadingManifest.manifest[key]=new URL(path,location.href).href;</script><body><script type="module" src="${bundled?paths.bundle+'/session.js':base+'/session.mjs'}"></script></body></html>`;
  await writeFile(join(site,'index.html'),html);
  facts.host={kind:bundled?'bundler':'direct-browser',paths,identity:id};
  const assetsManifest=[];
  async function inventory(dir) { for(const item of await readdir(dir,{withFileTypes:true})) { const path=join(dir,item.name); if(item.isDirectory())await inventory(path);else {const bytes=await readFile(path); assetsManifest.push({url:base+'/'+relative(version,path),bytes:bytes.length,sha256:sha(bytes)});} } }
  await inventory(version);await writeFile(join(output,'asset-manifest.json'),JSON.stringify(assetsManifest,null,2));
  facts.assets={manifest:'asset-manifest.json',count:assetsManifest.length,engineSha256:sha(await readFile(join(version,'core/wasm/editac_wasm_bg.wasm')))};
  facts.converters=[{format:'PDF',directions:['import','export'],state:'unavailable',owner:'CNV',reason:'no admitted directional facade/worker artifact; runtime cells not executed or counted as passing'},{format:'DOCX',directions:['import','export'],state:'unavailable',owner:'CNV',reason:'no admitted directional facade/worker artifact; runtime cells not executed or counted as passing'}];
  return site;
}
