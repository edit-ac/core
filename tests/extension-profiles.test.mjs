import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {chromium,firefox,webkit} from 'playwright';
import {prepareTutorial} from '../scripts/prepare-extension-tutorial.mjs';
import {sha256} from '../scripts/extension-bundles.mjs';
const output=resolve(process.env.EDITAC_EXTENSION_PROFILES_OUTPUT??'../architecture/evidence/desktop-interactions/extension-profiles');
const fixture=JSON.parse(await readFile('fixtures/extensions/profiles/contracts.json'));
const facts={gate:'EXT-1.12',sourceRevision:process.env.EDITAC_CORE_REVISION??'working-tree',node:process.version,checks:[],browsers:[],sourceHashes:{},artifactHashes:{},cleanup:{},downstream:fixture.downstream};
let directory,manifest,server,url,api,conformance,stdout='',stderr='';
before(async()=>{
  await mkdir(output,{recursive:true});
  directory=await mkdtemp(join(tmpdir(),'editac-extension-profiles-'));
  manifest=await prepareTutorial(directory);
  api=await import(pathToFileURL(join(directory,'node_modules/@edit-ac/core/dist/extensions/index.js')));
  for(const [source,target] of [['conformance.mjs','profile-conformance.mjs'],['browser.mjs','profile-browser.mjs'],['disabled.mjs','profile-disabled.mjs'],['contracts.json','profiles.json'],['prepared-worker.js','prepared-worker.js']])
    await copyFile('fixtures/extensions/profiles/'+source,join(directory,target));
  conformance=await import(pathToFileURL(join(directory,'profile-conformance.mjs')));
  await writeFile(join(directory,'optional-feature.js'),'window.optionalFeatureEvaluated=true; export function mount(){throw Error("Disabled feature evaluated");}\n');
  for(const [entry,name] of [['profile-browser.mjs','profiles.js'],['profile-disabled.mjs','disabled.js']]) {
    const result=await build({absWorkingDir:directory,entryPoints:[entry],outfile:join(directory,name),bundle:true,format:'esm',platform:'browser',target:'es2022',metafile:true,external:['/optional-feature.js']});
    await writeFile(join(output,name+'-metafile.json'),JSON.stringify(result.metafile,null,2)+'\n');
    await copyFile(join(directory,name),join(output,name));
    for(const input of Object.keys(result.metafile.inputs)) {
      assert(!input.startsWith('../')&&!input.includes('/src/'),'private/unpacked input '+input);
      facts.artifactHashes[input]=sha256(await readFile(join(directory,input)));
    }
  }
  await writeFile(join(directory,'index.html'),'<!doctype html><html><body><div id="editor"></div><script type="module" src="/disabled.js"></script><script type="module" src="/profiles.js"></script></body></html>');
  for(const name of ['consumer.json',...manifest.packs.map(p=>p.filename)])await copyFile(join(directory,'qualification',name),join(output,name));
  for(const name of ['engine.wasm','markdown.wasm']) {
    const hash=sha256(await readFile(join(directory,name)));facts.artifactHashes[name]=hash;
    assert.equal(hash,manifest.inputs[name]);
    const previous=JSON.parse(await readFile('../architecture/evidence/extension-tutorial/receipt.json'));
    const prior=previous.artifactHashes[name];assert.equal(hash,prior,'unchanged owning engine/codec');
  }
  const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
  server=spawn(process.execPath,['serve.mjs','--port=0'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>stdout+=chunk);server.stderr.on('data',chunk=>stderr+=chunk);
  await new Promise((done,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Profile server start timeout')),10000);
    server.once('error',reject);server.once('exit',code=>{if(!url)reject(Error('Profile server exited '+code+stderr));});
    const check=()=>{try{url=JSON.parse(stdout.trim().split('\n')[0]).url;clearTimeout(timeout);done();}catch{}};server.stdout.on('data',check);check();
  });
  facts.server={pid:server.pid,workspace:directory,launcher:process.execPath,port:new URL(url).port,purpose:'EXT-1.12 canonical packed profiles',log:'serve.log'};
});
after(async()=>{
  if(server){server.kill('SIGTERM');await new Promise(done=>{if(server.exitCode!==null||server.signalCode!==null)done();else server.once('exit',done);});}
  await writeFile(join(output,'serve.log'),stdout+stderr);
  facts.cleanup.serverExited=!server||server.exitCode!==null||server.signalCode!==null;
  if(directory){await rm(directory,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;}
  for(const path of ['packages/core/src/extensions/profiles.ts','packages/core/src/extensions/index.ts','fixtures/extensions/profiles/contracts.json','fixtures/extensions/profiles/conformance.mjs','fixtures/extensions/profiles/browser.mjs','fixtures/extensions/profiles/disabled.mjs','fixtures/extensions/profiles/prepared-worker.js','tests/extension-profiles.test.mjs','docs/extensions/profiles.md','scripts/prepare-extension-tutorial.mjs','packages/web/src/modules/runtime.ts','packages/web/src/modules/conformance.ts'])facts.sourceHashes[path]=sha256(await readFile(path));
  await writeFile(join(output,'results.json'),JSON.stringify(facts,null,2)+'\n');
});
test('packed Node consumer qualifies all profile contracts and lifecycle cases',async()=>{
  const cases=await conformance.runContractChecks(api,fixture);assert.equal(cases.length,17);assert(cases.every(c=>c.passed));facts.checks.push({host:'packed-node',cases});
});
test('disabled metadata entry imports no feature implementation or browser runtime',async()=>{
  const graph=JSON.parse(await readFile(join(output,'disabled.js-metafile.json')));
  assert(Object.keys(graph.inputs).every(path=>path==='profile-disabled.mjs'||path.startsWith('node_modules/@edit-ac/core/dist/extensions/')));
  assert(!Object.keys(graph.inputs).some(path=>/web|worker|math|search|pairs|optional-feature/.test(path)));
  assert(Object.values(graph.outputs).some(output=>output.imports.some(input=>input.path==='/optional-feature.js'&&input.external)));
});
for(const [name,launcher] of Object.entries({chromium,firefox,webkit}))test(name+': actual packed editor middleware preserves baseline/content/selection/lifecycle',{timeout:120000},async()=>{
  const fact={host:name,passed:false,requests:[],errors:[],cases:[]};facts.browsers.push(fact);let controller,browser;
  try {
    controller=await launcher.launchServer({headless:true});browser=await launcher.connect(controller.wsEndpoint());
    fact.process={pid:controller.process().pid,workspace:directory,launcher:controller.process().spawnfile,purpose:'EXT-1.12 '+name,log:output};fact.version=browser.version();
    const page=await browser.newPage();page.on('request',r=>fact.requests.push(r.url()));page.on('pageerror',e=>fact.errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
    await page.goto(url);await page.waitForFunction(()=>typeof window.profileRun==='function'&&window.profileDisabled);
    // Real baseline input and history, with no optional configuration activated.
    const editor=page.locator('#editor');
    await page.evaluate(()=>{
      const root=document.querySelector('#editor'),node=window.profileEditor().read().visible.find(n=>n.kind==='block'&&n.id!=='n:11:1');
      const target=root.querySelector(`[data-node-id="${node.id}"]`),walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);
      const text=walker.nextNode(),range=document.createRange();range.setStart(text,text.length);range.collapse(true);
      root.focus();const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
    });
    const before=await editor.textContent();await page.keyboard.type('X');assert.notEqual(await editor.textContent(),before);
    await page.keyboard.press('Meta+z');
    const restored=await editor.textContent();assert.equal(restored,before,'baseline undo after none');
    await page.keyboard.press('Meta+Shift+z');assert.notEqual(await editor.textContent(),before,'baseline redo');
    fact.cases.push({id:'FPX-01',name:'actual keyboard input/undo/redo baseline with none',passed:true});
    fact.cases.push(...await page.evaluate(()=>window.profileRun()));
    assert.equal(fact.cases.length,27);assert(fact.cases.every(c=>c.passed));
    for(const id of fixture.qualifiedCases)assert(fact.cases.some(c=>c.id===id),id);
    const disabled=await page.evaluate(()=>({result:window.profileDisabled,evaluated:!!window.optionalFeatureEvaluated}));
    assert.deepEqual(disabled,{result:{resources:0,diagnostics:[]},evaluated:false});
    assert(fact.requests.every(request=>new URL(request).origin===url&&!request.endsWith('/optional-feature.js')),'disabled request');
    assert(await page.evaluate(()=>window.profileFinish()));assert.deepEqual(fact.errors,[]);fact.passed=true;
  } finally {
    try{await browser?.close();}finally{await controller?.close();fact.browserExited=!controller||controller.process().exitCode!==null||controller.process().signalCode!==null;await writeFile(join(output,'browser-'+name+'.json'),JSON.stringify(fact,null,2)+'\n');}
  }
});
test('every required browser executed and closed without skips',()=>{
  assert.equal(facts.browsers.length,3);assert(facts.browsers.every(b=>b.passed&&b.browserExited));
});
