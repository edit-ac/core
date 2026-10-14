import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, realpath, rm, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright';
import { requireTestNode } from '../scripts/test-toolchain.mjs';

const root=resolve('.');
const docs=process.env.EDITAC_DOCS_EXAMPLES==='1';
const output=resolve(process.env.EDITAC_PACKED_OUTPUT ?? '../evidence/sdk-packed/iteration2');
const names=['core','web','react','astro','markdown'];
let temp, common, astro;
const facts={commands:[],packs:[],cases:[],processes:[],teardown:[]};
async function put(path,text){await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,text);}
async function run(command,args,cwd,label,env={}){
  const result=spawnSync(command,args,{cwd,env:{...process.env,...env},encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
  const log=join(output,label+'.log');await writeFile(log,(result.stdout??'')+'\n'+(result.stderr??''));
  facts.commands.push({command,args,cwd,label,exit:result.status,error:result.error?.message,log});
  assert.equal(result.error,undefined,`${label}: ${result.error}; ${log}`);
  assert.equal(result.status,0,`${label}: see ${log}`);return result.stdout;
}
const shared=`import {init} from '@edit-ac/core';
import {CheckpointStorage} from '@edit-ac/web';
export const editors=new Map(); window.editors=editors; window.reports=[];
export async function options(name){
 const runtime=await init('/engine.wasm');window.runtime=runtime;
 const databaseName='packed-'+name;let identity=JSON.parse(localStorage.getItem(name)||'null');
 if(!identity){const engine=runtime.createEngine({profile:'v5',documentId:crypto.randomUUID(),epoch:crypto.randomUUID(),nodes:[{text:name==='task'?'alpha':'beta'}]});
 const store=await CheckpointStorage.open(indexedDB,databaseName);
 try{await store.publish(engine.checkpoint(),[]);identity=engine.read().identity;localStorage.setItem(name,JSON.stringify(identity));}finally{store.close();engine.dispose();}}
 return {identity,databaseName,assetUrl:'/engine.wasm',indexedDB,locks:navigator.locks,plainPasteControl:false};
}
export const events={onReady(editor,host){editors.set(host?.dataset.editorName||'task',editor);window.ready=true;},onError(error){throw error;},onDispose(result){window.reports.push(result);}};`;
async function install(dir,framework){
 await mkdir(dir,{recursive:true});
 const dependencies=Object.fromEntries((framework==='astro'?['core','web','astro','markdown']:['core','web','react','markdown']).map(n=>['@edit-ac/'+n,'file:'+join(temp,`edit-ac-${n}-0.0.0.tgz`)]));
 Object.assign(dependencies,framework==='astro'?{'astro':'7.3.8','@astrojs/node':'11.1.7'}:{react:'19.3.0','react-dom':'19.3.0','@types/react':'19.3.0','@types/react-dom':'19.3.0',esbuild:'0.25.12'});
 dependencies.typescript='7.0.2';
 await put(join(dir,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
 await run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund'],dir,'install-'+framework);
}
before(async()=>{
 await requireTestNode();await mkdir(output,{recursive:true});temp=await realpath(await mkdtemp(join(tmpdir(),'editac-packed-')));common=join(temp,'common');astro=join(temp,'astro');
 for(const name of names){const pack=JSON.parse(await run('npm',['pack',`--workspace=@edit-ac/${name}`,'--pack-destination',temp,'--json'],root,'pack-'+name))[0];facts.packs.push({...pack,shortName:name});await copyFile(join(temp,pack.filename),join(output,pack.filename));}
 await install(common,'react');await install(astro,'astro');

 for(const dir of [common,astro]){await put(join(dir,'shared.js'),shared);await mkdir(join(dir,'public'),{recursive:true});await copyFile(join(dir,'node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm'),join(dir,'public/engine.wasm'));}
 await copyFile(join(astro,'node_modules/@edit-ac/markdown/dist/wasm/editac_markdown_wasm_bg.wasm'),join(astro,'public/markdown.wasm'));
 if(docs) {
  for(const file of ['editor.mjs','document.mjs','recovery.mjs','markdown.mjs','react.mjs','index.html','react.html']) {
   const source=join(root,'examples/task-editor',file);const content=await readFile(source);facts.sources??=[];facts.sources.push({path:source,sha256:createHash('sha256').update(content).digest('hex')});
   await copyFile(source,join(common,'public',file));
  }
  await cp(join(common,'node_modules/@edit-ac/core/dist'),join(common,'public/core'),{recursive:true});
  await cp(join(common,'node_modules/@edit-ac/core/dist/wasm'),join(common,'public/wasm'),{recursive:true});
  await cp(join(common,'node_modules/@edit-ac/markdown/dist'),join(common,'public/markdown'),{recursive:true});
  await cp(join(common,'node_modules/@edit-ac/web/dist'),join(common,'public/web'),{recursive:true});
  await mkdir(join(common,'public/fixture'),{recursive:true});
  for(const file of ['editor.mjs','recovery.mjs','markdown.mjs']) await copyFile(join(common,'public',file),join(common,'public/fixture',file));
  // Bundle the actual React entry; retain native ESM for the plain entry.
  await run(join(common,'node_modules/.bin/esbuild'),['public/react.mjs','--bundle','--format=esm','--outfile=public/react-built.mjs'],common,'docs-react-build');
  // The served HTML entry points at the built version of the same source.
  const html=await readFile(join(common,'public/react.html'),'utf8');await copyFile(join(common,'public/react-built.mjs'),join(common,'public/fixture/react-built.mjs'));
  await cp(join(common,'public/wasm'),join(common,'public/fixture/wasm'),{recursive:true});
  await put(join(common,'public/react.html'),html);
  await cp(join(root,'examples/astro/src'),join(astro,'src'),{recursive:true});
  await copyFile(join(root,'examples/astro/astro.config.mjs'),join(astro,'astro.config.mjs'));
  await mkdir(join(temp,'task-editor'),{recursive:true});await copyFile(join(root,'examples/task-editor/recovery.mjs'),join(temp,'task-editor/recovery.mjs'));await copyFile(join(root,'examples/task-editor/markdown.mjs'),join(temp,'task-editor/markdown.mjs'));
  for(const mode of ['static','ssr']) await run(process.execPath,['node_modules/astro/bin/astro.mjs','build'],astro,'docs-astro-'+mode,{EDITAC_ASTRO_MODE:mode,PUBLIC_EDITAC_ASTRO_FIXTURE:'0'});
 } else {
 await put(join(common,'app.js'),`import {createElement,StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {EditorHost} from '@edit-ac/react';import {options,events} from './shared.js';const opts=await options('task');window.reactRoot=createRoot(document.querySelector('#host'));window.reactRoot.render(createElement(StrictMode,null,createElement(EditorHost,{options:opts,...events})));`);
 await run(join(common,'node_modules/.bin/esbuild'),['app.js','--bundle','--format=esm','--outdir=public','--asset-names=assets/[name]-[hash]','--loader:.wasm=file'],common,'react-build');
 await cp(join(common,'node_modules/@edit-ac/core/dist/wasm'),join(common,'public/wasm'),{recursive:true});
 await put(join(common,'public/index.html'),'<html><body><div id="host"></div><script type="module" src="/app.js"></script></body></html>');
 await put(join(astro,'astro.config.mjs'),`import {defineConfig} from 'astro/config';import node from '@astrojs/node';export default defineConfig({output:process.env.MODE==='ssr'?'server':'static',adapter:process.env.MODE==='ssr'?node({mode:'standalone'}):undefined,outDir:'./dist-'+process.env.MODE});`);
 await put(join(astro,'src/client.js'),`import {installEditorHosts} from '@edit-ac/astro';import {options,events} from '../shared.js';installEditorHosts(document,options,events);`);
 await put(join(astro,'src/pages/index.astro'),`---\nimport Editor from '@edit-ac/astro/Editor.astro';import {ClientRouter} from 'astro:transitions';\n---\n<html><head><ClientRouter /></head><body><a href="/away">Away</a><Editor name="task"/><Editor name="notes" readOnly/><script>import '../client.js';</script></body></html>`);
 await put(join(astro,'src/pages/away.astro'),`---\nimport {ClientRouter} from 'astro:transitions';\n---\n<html><head><ClientRouter /></head><body><a href="/">Back</a></body></html>`);
 for(const mode of ['static','ssr'])await run(process.execPath,['node_modules/astro/bin/astro.mjs','build'],astro,'astro-'+mode,{MODE:mode});
 }

},{timeout:240000});
after(async()=>{
 try {if(temp) {
  const paths=['common/public','common/package.json','common/package-lock.json','astro/dist-static','astro/dist-ssr','astro/package.json','astro/package-lock.json'];
  facts.archive={included:[],missing:[]};
  for(const path of paths) {
   try {await access(join(temp,path));facts.archive.included.push(path);}
   catch(error) {if(error.code!=='ENOENT')throw error;facts.archive.missing.push(path);}
  }
  // Retain partial setup evidence without replacing its primary failure with
  // an archive error for build outputs that were never produced.
  if(facts.archive.included.length)await run('tar',['-czf',join(output,'compiled-consumers.tgz'),'-C',temp,...facts.archive.included],root,'archive-consumers');
 }}
 finally {try {await mkdir(output,{recursive:true});await writeFile(join(output,'harness.json'),JSON.stringify(facts,null,2)+'\n');} finally {if(temp)await rm(temp,{recursive:true,force:true});}}
});

test('tarballs contain exports, declarations, Apache license/notices and no workspace links; one core owner',async()=>{
 for(const [dir,selected] of [[common,['core','web','react']],[astro,['core','web','astro']]]){
  const core=await realpath(join(dir,'node_modules/@edit-ac/core'));
  for(const name of selected){const location=join(dir,'node_modules/@edit-ac',name);assert.equal(await realpath(location),location);assert.ok(location.startsWith(temp+sep));
   const pkg=JSON.parse(await readFile(join(location,'package.json')));assert.equal(pkg.private,true);assert.equal(pkg.license,'Apache-2.0');
   assert.match(await readFile(join(location,'LICENSE'),'utf8'),/Apache License/);
   assert.ok((await readFile(join(location,name==='core'?'THIRD-PARTY-NOTICES.txt':'NOTICE'))).length>0);
   for(const value of Object.values(pkg.exports)){for(const path of typeof value==='string'?[value]:Object.values(value))assert.ok((await readFile(join(location,path))).length>0);}
   assert.equal(await realpath(join(dir,'node_modules/@edit-ac/core')),core);
   await assert.rejects(realpath(join(location,'node_modules/@edit-ac/core')),/ENOENT/);
   if(name==='core')assert.match(await readFile(join(location,'THIRD-PARTY-NOTICES.txt'),'utf8'),/Bartosz Sypytkowski/);
  }
 }
 const dirs=await readdir(join(astro,'node_modules'));assert.ok(!dirs.includes('react'));assert.ok(!dirs.includes('react-dom'));
 const webpack=facts.packs.find(p=>p.shortName==='web');assert.ok(webpack.files.some(f=>f.path==='dist/modules/vendor/LICENSE.katex'));
});

test('isolated declarations resolve all public SDK exports',async()=>{
 for(const [dir,framework] of [[common,'react'],[astro,'astro']]){
 await put(join(dir,'types.ts'),`import {init,type EngineRuntime} from '@edit-ac/core';import {createEditor,type EditorOptions} from '@edit-ac/web';import {mathRenderer} from '@edit-ac/web/math';import {initMarkdown} from '@edit-ac/markdown';import {markdownExtension} from '@edit-ac/markdown/web';void initMarkdown;void markdownExtension;${framework==='react'?"import {EditorHost,useEditorState} from '@edit-ac/react';void EditorHost;void useEditorState;":"import {mountEditorHost,installEditorHosts} from '@edit-ac/astro';void mountEditorHost;void installEditorHosts;"}void init;void createEditor;void mathRenderer;let runtime:EngineRuntime;let options:EditorOptions;`);
 await run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--module','NodeNext','--target','ES2022','--lib','ES2022,DOM','types.ts'],dir,'types-'+framework);
 }
});

test('tarball SSR imports and React render never touch browser globals or initialize WASM',async()=>{
 for(const [dir,framework] of [[common,'react'],[astro,'astro']]){
 await put(join(dir,'ssr.mjs'),`import assert from 'node:assert/strict';${framework==='react'?"import {createElement} from 'react';import {renderToString} from 'react-dom/server';":''}for(const name of ['window','document','indexedDB','navigator','fetch','WebAssembly'])Object.defineProperty(globalThis,name,{configurable:true,get(){throw Error('SSR accessed '+name);}});const core=await import('@edit-ac/core');await import('@edit-ac/web');await import('@edit-ac/web/math');await import('@edit-ac/markdown');await import('@edit-ac/markdown/web');const framework=await import('@edit-ac/${framework}');${framework==='react'?"assert.equal(renderToString(createElement(framework.EditorHost,{options:{identity:{documentId:'ssr'},databaseName:'ssr',assetUrl:'/never.wasm'},attributes:{id:'host'}})),'<div id=\"host\"></div>');":''}assert.ok(import.meta.resolve('@edit-ac/core/wasm').includes('/node_modules/@edit-ac/core/'));`);
 await run(process.execPath,['ssr.mjs'],dir,'ssr-import-'+framework);
 }
});

async function serve(dir,csp=true){
 const requests=[];const server=createServer(async(req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);requests.push(pathname);
 try{let p=pathname;if(!p.includes('.'))p=p.replace(/\/$/,'')+'/index.html';const file=resolve(dir,'.'+p);if(!file.startsWith(dir+sep))throw Error('outside fixture');
 res.setHeader('Access-Control-Allow-Origin','*');if(csp)res.setHeader('Content-Security-Policy',typeof csp==='string'?csp:"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'");res.setHeader('Content-Type',p.endsWith('.wasm')?'application/wasm':p.endsWith('.html')?'text/html':'text/javascript');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
 await new Promise(yes=>server.listen(0,'127.0.0.1',yes));const port=server.address().port;facts.processes.push({pid:process.pid,launcher:'node --test tests/packed-consumers.test.mjs',workspace:dir,port,purpose:'packed consumer',log:join(output,'harness.json')});
 return {url:`http://127.0.0.1:${port}`,requests,close:async()=>{server.closeAllConnections();await new Promise(yes=>server.close(yes));facts.teardown.push({port,closed:!server.listening});}};
}
async function ssrServer(){
 const reservation=await serve(join(astro,'public'));const port=Number(new URL(reservation.url).port);await reservation.close();
 const child=spawn(process.execPath,['dist-ssr/server/entry.mjs'],{cwd:astro,env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 facts.processes.push({pid:child.pid,launcher:process.execPath,workspace:astro,port,purpose:'packed Astro SSR',log:join(output,'ssr-server.log')});
 const close=async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(yes=>child.once('exit',yes));}await writeFile(join(output,'ssr-server.log'),log);facts.teardown.push({pid:child.pid,exited:child.exitCode!==null||child.signalCode!==null});};
 try{for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}`)).ok)return{url:`http://127.0.0.1:${port}`,close};}catch{}await new Promise(yes=>setTimeout(yes,50));}throw Error('SSR startup timeout');}catch(e){await close();throw e;}
}
async function browserCase(engine,name,fn){const controller=await engine.launchServer({headless:true});const process=controller.process();facts.processes.push({pid:process.pid,launcher:process.spawnfile,workspace:temp,purpose:name,log:join(output,'harness.json')});let browser;
 try{browser=await engine.connect(controller.wsEndpoint());const page=await browser.newPage();page.setDefaultTimeout(15000);const errors=[];const consoleLog=[];page.on('console',message=>consoleLog.push(message.type()+': '+message.text()));page.on('requestfailed',request=>consoleLog.push(request.url()+': '+request.failure()?.errorText));page.on('pageerror',e=>{errors.push(e.message);void writeFile(join(output,name+'-browser-error.log'),errors.join('\n'));});try{await fn(page);}finally{await writeFile(join(output,name+'-console.log'),consoleLog.join('\n'));}assert.deepEqual(errors,[]);facts.cases.push({name,browser:browser.version(),passed:true});}
 catch(error){facts.cases.push({name,passed:false,error:String(error)});throw error;}finally{await browser?.close();await controller.close();facts.teardown.push({pid:process.pid,exited:process.exitCode!==null});}}
async function edit(page){await page.waitForFunction(()=>window.editors?.get('task')?.state.ready);const surface=page.locator('[contenteditable="true"]').first();await surface.click();await page.keyboard.press('End');await page.keyboard.type(' packed');await page.waitForFunction(()=>window.editors.get('task').read().visible[0].runs.map(r=>r.text).join('')==='alpha packed');await page.evaluate(()=>window.editors.get('task').flush({target:'local'}));}
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
 if(docs) { registerDocsCases(name,engine); continue; }
 test(`${name}: native ESM tarball runtime supports explicit CDN assets and CSP without unsafe-eval`,{timeout:60000},async()=>{
 const cdn=await serve(join(common,'node_modules/@edit-ac/core/dist'),false);const host=await serve(common,`default-src 'none'; script-src 'nonce-packed' ${cdn.url} 'self' 'wasm-unsafe-eval'; connect-src ${cdn.url} 'self'; style-src 'unsafe-inline'`);
 try{
 await put(join(common,'native-shared.js'),shared.replaceAll("'/engine.wasm'",JSON.stringify(cdn.url+'/wasm/editac_wasm_bg.wasm')));
 await put(join(common,'native.js'),"import {createEditor} from '@edit-ac/web';import {options,events} from './native-shared.js';const editor=createEditor(document.querySelector('#host'),await options('task'));window.current=editor;await editor.ready;events.onReady(editor);");
 await browserCase(engine,name+'-native',async page=>{
 const map=JSON.stringify({imports:{'@edit-ac/core':cdn.url+'/index.js','@edit-ac/core/extensions':cdn.url+'/extensions/index.js','@edit-ac/web':host.url+'/node_modules/@edit-ac/web/dist/index.js'}});
 await put(join(common,'index.html'),`<html><div id="host"></div><script type="importmap" nonce="packed">${map}</script><script type="module" src="/native.js"></script></html>`);
 await page.goto(host.url);try{await edit(page);}catch(error){await writeFile(join(output,name+'-native-state.json'),JSON.stringify(await page.evaluate(()=>({text:document.body.innerText,current:window.current?.state,ready:window.ready,editors:window.editors?.size,resources:performance.getEntriesByType('resource').map(e=>e.name)})),null,2));throw error;}
 const result=await page.evaluate(async url=>{const {init}=await import(url+'/index.js');const a=init(url+'/wasm/editac_wasm_bg.wasm');const shared=a===init(url+'/wasm/editac_wasm_bg.wasm');const runtime=await a;const sameRuntime=runtime===window.runtime;const report=await window.editors.get('task').destroy();return {shared,sameRuntime,unsaved:report.unsaved};},cdn.url);
 assert.deepEqual(result,{shared:true,sameRuntime:true,unsaved:false});assert.ok(cdn.requests.includes('/wasm/editac_wasm_bg.wasm'));
 });}finally{await host.close();await cdn.close();}
 });
 test(`${name}: installed React bundle edits and disposes its shared runtime`,{timeout:60000},async()=>{const server=await serve(join(common,'public'));try{await browserCase(engine,name+'-react',async page=>{await page.goto(server.url);await edit(page);await page.evaluate(()=>window.reactRoot.unmount());await page.waitForFunction(()=>window.reports.length===1);assert.equal(await page.evaluate(()=>window.reports[0].unsaved),false);assert.equal(await page.locator('[contenteditable="true"]').count(),0);});}finally{await server.close();}});
 for(const mode of ['static','ssr'])test(`${name}: installed Astro ${mode} compiles hosts/assets and preserves edits through ClientRouter`,{timeout:60000},async()=>{const server=mode==='static'?await serve(join(astro,'dist-static'),false):await ssrServer();try{await browserCase(engine,name+'-astro-'+mode,async page=>{await page.goto(server.url);await page.waitForFunction(()=>window.editors?.size===2);assert.equal(await page.locator('edit-ac-editor').count(),2);await edit(page);const identity=await page.evaluate(()=>window.editors.get('task').read().identity);await page.getByText('Away',{exact:true}).click();await page.waitForURL('**/away');assert.equal(await page.evaluate(()=>window.reports.length),2);await page.getByText('Back',{exact:true}).click();await page.waitForURL(server.url+'/');await page.waitForFunction(()=>window.editors.get('task').state.ready);assert.deepEqual(await page.evaluate(()=>window.editors.get('task').read().identity),identity);assert.equal(await page.evaluate(()=>window.editors.get('task').read().visible[0].runs.map(r=>r.text).join('')),'alpha packed');await page.evaluate(async()=>{for(const editor of window.editors.values())await editor.destroy();});});}finally{await server.close();}});
}

function registerDocsCases(name,engine) {
 for(const framework of ['plain','react','astro']) test(`${name}: shipped ${framework} recovery controls expose a prepared journal failure`,{timeout:60000},async()=>{
  const server=await serve(framework==='astro'?join(astro,'dist-static'):join(common,'public'),false);
  try {await browserCase(engine,`${name}-docs-${framework}-save-failure`,async page=>{
   await page.goto(server.url+(framework==='react'?'/react.html':'/'));await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));
   await page.evaluate(()=>{const add=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){if(this.name==='updates')throw new DOMException('prepared journal failure','QuotaExceededError');return add.apply(this,args);};});
   const surface=page.locator('[contenteditable="true"]').first();await surface.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type(' retained');
   await page.getByRole('button',{name:'Save locally',exact:true}).click();
   await page.waitForFunction(()=>document.body.innerText.includes('Local save failed'));
   const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export recovery',exact:true}).click();const download=await downloaded;const file=join(output,`${name}-${framework}-live-recovery.json`);await download.saveAs(file);const report=JSON.parse(await readFile(file,'utf8'));assert.ok(JSON.stringify(report).includes('bytes'));assert.ok(JSON.stringify(report).includes('data'));assert.ok(report.length>0);
   if(framework==='astro') {
    await page.getByText('Navigate away',{exact:true}).click();await page.waitForURL('**/away');await page.getByRole('link').click();await page.waitForURL(server.url+'/');await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent.includes('Unsaved content retained'));
    const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export recovery'}).click();const retained=await recoveryDownload(await event,`${name}-${framework}-disposed-recovery.json`);assert.ok(retained.some(r=>r.unsaved&&r.recovery));
   } else {
    await page.evaluate(async framework=>{const app=await import(framework==='plain'?'/fixture/editor.mjs':'/fixture/react-built.mjs');await app.close();},framework);
    await page.waitForFunction(()=>!document.querySelector('[contenteditable="true"]'));
    if(framework==='react')await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Unsaved content retained'));
    const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export recovery'}).click();const retained=await recoveryDownload(await event,`${name}-${framework}-disposed-recovery.json`);assert.ok(retained.some(r=>r.unsaved&&r.recovery));
   }
  });}finally{await server.close();}
 });
 for(const framework of ['plain','react','astro'])test(`${name}: shipped ${framework} opening failure preserves stored identity`,{timeout:60000},async()=>{
  const server=await serve(framework==='astro'?join(astro,'dist-static'):join(common,'public'),false);
  try{await browserCase(engine,`${name}-docs-${framework}-load-failure`,async page=>{
   await page.goto(server.url+(framework==='react'?'/react.html':'/'));await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));
   const identity=await page.evaluate(()=>JSON.stringify({...localStorage}));
   await page.addInitScript(()=>{IDBFactory.prototype.open=function(){throw new DOMException('prepared opening failure','UnknownError');};});
   await page.reload();await page.waitForFunction(()=>document.body.innerText.includes('Unable to open')||document.body.innerText.includes('loading/saving failed'));
   assert.equal(await page.locator('[contenteditable="true"]').count(),0);assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),identity);
  });}finally{await server.close();}
 });

 for(const framework of ['plain','react']) test(`${name}: shipped ${framework} example edits, saves, exports recovery and reopens offline`,{timeout:60000},async()=>{
  const server=await serve(join(common,'public'),false);
  try {await browserCase(engine,`${name}-docs-${framework}`,async page=>{
   await page.goto(server.url+(framework==='react'?'/react.html':'/'));
   await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));
   const surface=page.locator('[contenteditable="true"]');await surface.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type(' docs');
   await page.getByRole('button',{name:'Save locally',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Saved locally'));
   const text=await surface.innerText();assert.ok(text.includes(' docs'));
   const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export recovery',exact:true}).click();const download=await downloaded;assert.equal(download.suggestedFilename(),'editac-recovery.json');
   if(framework==='plain') {await page.getByRole('button',{name:'Reopen offline'}).click();await page.waitForFunction(()=>document.querySelector('#message').textContent==='Task ready offline');assert.equal(await page.locator('[contenteditable="true"]').innerText(),text);}
   await page.reload();await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));assert.equal(await page.locator('[contenteditable="true"]').innerText(),text);
   await page.locator('[contenteditable="true"]').click();await page.keyboard.press('ControlOrMeta+End');
   const result=await page.evaluate(async framework=>{const app=await import(framework==='plain'?'/fixture/editor.mjs':'/fixture/react-built.mjs');
    const editor=app.editor;const outcome=editor.paste({getData:type=>type==='text/plain'?'**literal**':''},{literal:true});
    const literal=editor.read().visible.some(b=>b.runs?.some(r=>r.text.includes('**literal**')));await editor.flush({target:'local'});
    if(framework==='plain') {const report=await app.close();return {literal,outcome,unsaved:report.unsaved};}
    app.close();return {literal,outcome};
   },framework);assert.equal(result.literal,true,JSON.stringify(result));if(framework==='plain')assert.equal(result.unsaved,false);
   await page.waitForFunction(()=>!document.querySelector('[contenteditable="true"]'));
  });}finally{await server.close();}
 });
 for(const mode of ['static','ssr'])test(`${name}: shipped Astro ${mode} example preserves identity/content through navigation and exposes local save`,{timeout:60000},async()=>{
  const server=mode==='static'?await serve(join(astro,'dist-static'),false):await ssrServer();
  try {await browserCase(engine,`${name}-docs-astro-${mode}`,async page=>{
   await page.goto(server.url);await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));
   assert.equal(await page.locator('edit-ac-editor').count(),2);
   const surface=page.locator('edit-ac-editor[data-editor-name="task"] [contenteditable="true"]');await surface.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type(' docs');
   await page.getByRole('button',{name:'Save locally',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('Saved locally'));
   const text=await surface.innerText();const identity=await page.evaluate(()=>localStorage.getItem('editac-astro-identity-task'));
   const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export recovery'}).click();assert.equal((await download).suggestedFilename(),'editac-recovery.json');
   await page.getByText('Navigate away',{exact:true}).click();await page.waitForURL('**/away');await page.getByRole('link').click();await page.waitForURL(server.url+'/');await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));
   assert.equal(await surface.innerText(),text);assert.equal(await page.evaluate(()=>localStorage.getItem('editac-astro-identity-task')),identity);
   assert.equal(await page.locator('edit-ac-editor[data-editor-name="notes"] [contenteditable="true"]').count(),0);
  });}finally{await server.close();}
 });
}

async function recoveryDownload(download,name) {const path=join(output,name);await download.saveAs(path);return JSON.parse(await readFile(path,'utf8'));}

if(docs) for(const [name,engine] of Object.entries({chromium,firefox,webkit})) {
 for(const framework of ['plain','react','astro-static','astro-ssr']) test(`${name}: shipped ${framework} explicitly enabled Markdown preserves its offline document`,{timeout:60000},async()=>{
  const isAstro=framework.startsWith('astro');
  const server=framework==='astro-ssr'?await ssrServer():await serve(isAstro?join(astro,'dist-static'):join(common,'public'),false);
  try{await browserCase(engine,`${name}-enabled-${framework}`,async page=>{
   const requests=[];page.on('request',r=>requests.push(r.url()));
   await page.goto(server.url+(framework==='react'?'/react.html':'/')+'?markdown');
   await page.waitForFunction(()=>document.querySelector('[contenteditable="true"]'));
   const identity=await page.evaluate(()=>JSON.stringify({...localStorage}));
   const surface=page.locator('[contenteditable="true"]').first();await surface.click();await page.keyboard.press('ControlOrMeta+End');
   await page.evaluate(()=>{const root=document.querySelector('[contenteditable="true"]');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:m=>m==='text/plain'?'\n\n# **Enabled 😀**':''}});root.dispatchEvent(event);});
   await page.waitForFunction(()=>document.querySelector('[contenteditable="true"] h1 strong')?.textContent==='Enabled 😀');
   await page.getByRole('button',{name:'Save locally',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#message,#save-status')?.textContent.includes('Saved locally'));
   assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),identity);
   const text=await surface.innerText();assert(requests.some(u=>u.includes('markdown')&&u.includes('.wasm')),'explicit parser asset must load');
   await page.reload();await page.waitForFunction(()=>document.querySelector('[contenteditable="true"] h1 strong')?.textContent==='Enabled 😀');
   assert.equal(await surface.innerText(),text);assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),identity);
  });}finally{await server.close();}
 });
}
