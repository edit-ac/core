import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium,firefox,webkit} from 'playwright';
import {prepareTutorial} from '../scripts/prepare-extension-tutorial.mjs';
import {sha256} from '../scripts/extension-bundles.mjs';
import {loadMatrix,validateCapabilities} from '../scripts/check-extension-capabilities.mjs';
const output=resolve(process.env.EDITAC_EXTENSION_LIBRARY_OUTPUT??'../architecture/evidence/extension-library/current');
const corpus=JSON.parse(await readFile('fixtures/extensions/clipboard/conformance.json'));
const facts={schema:1,gate:'EXT-1.11',qualification:'portable public library; actual platform/device/FPX-04 pending; unpublished',node:process.version,sourceRevision:'ee774e02a4e2fb78208a106b8f5028b07e2a1788f8e6f937759fe5c3c73b4d4e',revisions:{core:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),architecture:execFileSync('git',['-C','../architecture','rev-parse','HEAD'],{encoding:'utf8'}).trim()},sourceHashes:{},artifactHashes:{},packedInputHashes:{},browsers:[],cleanup:{}};
let directory,manifest,server,url,stdout='',stderr='';
before(async()=>{
 await mkdir(output,{recursive:true});directory=await mkdtemp(join(tmpdir(),'editac-extension-library-'));
 manifest=await prepareTutorial(directory);facts.packs=manifest.packs;
 for(const [source,target] of [['fixtures/extensions/consumers/library/browser.mjs','library.mjs'],['fixtures/extensions/profiles/conformance.mjs','profile-conformance.mjs'],['fixtures/extensions/profiles/contracts.json','profiles.json'],['fixtures/extensions/clipboard/conformance.json','clipboard.json']])await copyFile(source,join(directory,target));
 const graph=await build({absWorkingDir:directory,entryPoints:['library.mjs'],outfile:join(directory,'library.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',metafile:true});
 for(const path of Object.keys(graph.metafile.inputs)){assert(!path.startsWith('../')&&!path.includes('/src/'),'private input '+path);facts.packedInputHashes[path]=sha256(await readFile(join(directory,path)));}
 await writeFile(join(output,'library-metafile.json'),JSON.stringify(graph.metafile,null,2)+'\n');
 await writeFile(join(directory,'index.html'),'<!doctype html><html><body><div id="editor"></div><script type="module" src="/library.js"></script></body></html>');
 for(const name of ['consumer.json',...manifest.packs.map(p=>p.filename)])await copyFile(join(directory,'qualification',name),join(output,name));
 await mkdir(join(output,'fixtures'),{recursive:true});
 for(const name of ['custom-checkpoint.bin','identity.json','conformance.json'])await copyFile(join(directory,'fixtures',name),join(output,'fixtures',name));
 for(const name of ['engine.wasm','markdown.wasm','library.js','library.mjs','profile-conformance.mjs','profiles.json','clipboard.json','tutorial.mjs','definitions.json','index.html','serve.mjs']){await copyFile(join(directory,name),join(output,name));facts.artifactHashes[name]=sha256(await readFile(join(output,name)));}
 for(const name of ['engine.wasm','markdown.wasm'])assert.equal(facts.artifactHashes[name],manifest.inputs[name],'unchanged packed engine/codec');
 const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
 server=spawn(process.execPath,['serve.mjs','--port=0'],{cwd:directory,env:environment,stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',c=>stdout+=c);server.stderr.on('data',c=>stderr+=c);
 await new Promise((done,reject)=>{const timeout=setTimeout(()=>reject(Error('Consumer server start timeout')),10000);server.once('error',reject);server.once('exit',code=>{if(!url)reject(Error('server exited '+code+stderr));});server.stdout.on('data',()=>{if(!url&&stdout.includes('\n')){try{url=JSON.parse(stdout.split('\n')[0]).url;clearTimeout(timeout);done();}catch(e){clearTimeout(timeout);reject(e);}}});});
 facts.server={pid:server.pid,launcher:process.execPath,workspace:directory,port:new URL(url).port,purpose:'EXT-1.11 packed public library',log:'serve.log'};
});
after(async()=>{
 try{if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await new Promise((done,reject)=>{const timeout=setTimeout(()=>reject(Error('server teardown timeout')),10000);server.once('exit',()=>{clearTimeout(timeout);done();});});}facts.cleanup.serverExited=!server||server.exitCode!==null||server.signalCode!==null;
 if(directory){await rm(directory,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;}}
 finally{await writeFile(join(output,'serve.log'),stdout+stderr);for(const path of ['tests/extension-consumers.test.mjs','fixtures/extensions/consumers/library/handoff.json','fixtures/extensions/consumers/library/browser.mjs','fixtures/extensions/capabilities.json','fixtures/extensions/profiles/contracts.json','fixtures/extensions/profiles/conformance.mjs','fixtures/extensions/clipboard/conformance.json','scripts/prepare-extension-tutorial.mjs','docs/extensions/library.md','packages/core/package.json','packages/web/package.json','packages/markdown/package.json'])facts.sourceHashes[path]=sha256(await readFile(path));await writeFile(join(output,'results.json'),JSON.stringify(facts,null,2)+'\n');}
});
test('versioned handoff covers all six built-ins, five platform owners and FPX-04',async()=>{
 const matrix=loadMatrix();facts.capabilities=validateCapabilities(matrix);assert.equal(facts.capabilities.cells,210);assert.equal(facts.capabilities.actualPlatformEvidence,'pending-downstream');
 const doc=await readFile('docs/extensions/library.md','utf8');for(const module of matrix.modules)assert(doc.includes(module.id));for(const host of new Set(matrix.cells.map(c=>c.owner.roadmap)))assert(doc.includes(host),host);assert(doc.includes('FPX-04'));assert(doc.includes('FMT-1.15'));assert(doc.includes('unpublished'));
});
test('immutable prerequisite catalog pins current fixtures and every downstream owner',async()=>{
 const catalog=JSON.parse(await readFile('fixtures/extensions/consumers/library/handoff.json'));
 assert.equal(catalog.apiVersion,1);assert.equal(catalog.gate,'EXT-1.11');
 for(const [path,hash] of Object.entries(catalog.fixtureHashes))assert.equal(sha256(await readFile(path)),hash,path);
 for(const gate of ['EXT-1.1','EXT-1.2','EXT-1.3','EXT-1.4','EXT-1.5','EXT-1.6','EXT-1.7','EXT-1.8','EXT-1.9','EXT-1.10','EXT-1.12','EXT-1.13']){
  const receipt=catalog.prerequisites[gate];assert(receipt,gate);assert.equal(sha256(await readFile(receipt.path)),receipt.sha256,gate);
 }
 const matrix=loadMatrix();assert.equal(Object.keys(catalog.platforms).length,5);
 for(const [host,owner] of Object.entries(catalog.platforms)){
  assert.equal(owner.actualEvidence,'pending-downstream');const roadmap=await readFile('../architecture/roadmaps/'+owner.roadmap,'utf8');
  for(const gate of owner.gates)assert(roadmap.includes(gate),gate);
  const cells=matrix.cells.filter(c=>c.host===host);assert.equal(owner.requiredCells,cells.length);
  assert.deepEqual(owner.presenterFixtures,[...new Set(cells.flatMap(c=>c.presenterFixtures))].sort());
 }
 const profiles=JSON.parse(await readFile('fixtures/extensions/profiles/contracts.json'));
 assert.deepEqual(catalog['FPX-04'].combinations,profiles.downstream['FPX-04'].combinations);
 assert.equal(catalog['FPX-04'].state,'pending-actual-feature-platform-evidence');
 for(const owner of catalog['FPX-04'].owners)assert((await readFile('../architecture/roadmaps/'+owner,'utf8')).length>0);
 assert((await readFile(catalog['FPX-04'].fixture,'utf8')).includes('FPX-04'));facts.handoff=catalog;
});
for(const [name,launcher] of Object.entries({chromium,firefox,webkit}))test(name+': packed public profiles, all transfers, history/storage, custom extension and disposal',{timeout:180000},async()=>{
 const fact={host:name,passed:false,cases:[],errors:[],requests:[]};facts.browsers.push(fact);let controller,browser;
 try{controller=await launcher.launchServer({headless:true});browser=await launcher.connect(controller.wsEndpoint());fact.process={pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:directory,purpose:'EXT-1.11 '+name};fact.version=browser.version();
 const page=await browser.newPage();page.on('request',r=>fact.requests.push(r.url()));page.on('pageerror',e=>fact.errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
 await page.goto(url);await page.waitForFunction(()=>!!window.library);
 const profiles=await page.evaluate(()=>window.library.contracts());assert.equal(profiles.length,17);assert(profiles.every(c=>c.passed));fact.profiles=profiles;
 for(const fixture of corpus.cases){const result=await page.evaluate(id=>window.library.open(id),fixture.id);assert.equal(result.mode,fixture.mode);const initial=result.saved;
 // Use the actual browser shortcut and middleware to verify one owning undo group.
 await page.keyboard.press('Meta+z');assert.deepEqual(await page.evaluate(()=>window.library.read()),[],fixture.id+' undo');await page.keyboard.press('Meta+Shift+z');assert.deepEqual(await page.evaluate(()=>window.library.read()),initial,fixture.id+' redo');
 assert.deepEqual(await page.evaluate(()=>window.library.reopen()),initial,fixture.id+' reopen');assert(await page.evaluate(()=>window.library.stale()));fact.cases.push({id:fixture.id,passed:true,mode:result.mode,semantics:initial});}
 fact.tutorial=await page.evaluate(()=>window.library.tutorial());assert(fact.tutorial.passed);assert(await page.evaluate(()=>window.library.finish()));assert.deepEqual(fact.errors,[]);assert(fact.requests.every(r=>new URL(r).origin===url));fact.passed=true;
 }finally{try{await browser?.close();}finally{await controller?.close();fact.browserExited=!controller||controller.process().exitCode!==null||controller.process().signalCode!==null;await writeFile(join(output,'browser-'+name+'.json'),JSON.stringify(fact,null,2)+'\n');}}
});
test('all advertised browser fixture cells executed and resources closed',()=>{assert.equal(facts.browsers.length,3);for(const browser of facts.browsers){assert(browser.passed&&browser.browserExited);assert.equal(browser.cases.length,corpus.cases.length);}});
