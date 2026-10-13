import * as Y from 'yjs';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { chromium, firefox, webkit } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';
const engineName=process.env.EDITAC_COMPOSITION_REMOTE_BROWSER??'chromium';
const browserType={chromium,firefox,webkit}[engineName];
if(!browserType)throw Error(`Unknown input browser: ${engineName}`);
const output=process.env.EDITAC_COMPOSITION_REMOTE_OUTPUT??await mkdtemp(join(tmpdir(),'editac-composition-remote-evidence-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[],packed:{},browser:{},server:{},cleanup:{}};
let consumer,server,browser,controller;
async function run(command,args,log){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});await writeFile(join(output,log),`${r.stdout??''}\n${r.stderr??''}`);assert.equal(r.error,undefined,log);assert.equal(r.status,0,log);return r.stdout;}
const sourcePaths=['packages/web/src/input/composition.ts','packages/web/dist/input/composition.js','packages/web/src/input/reconcile.ts','packages/web/dist/input/reconcile.js','packages/web/src/input/text.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input/session.mjs','fixtures/browser-input/index.html','tests/browser/composition-remote.spec.ts','scripts/test-browser.mjs','packages/core/src/engine.ts','packages/core/dist/index.js','packages/core/dist/engine.js','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/web/dist/input/text.js','packages/web/dist/dom/render.js','packages/web/dist/dom/selection.js','packages/web/dist/entry.js','packages/web/dist/storage/index.js','packages/web/dist/storage/journal.js','packages/web/dist/storage/writer.js','package-lock.json'];
async function hashSources(){return Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
before(async()=>{
 facts.sources=await hashSources();
 facts.coreBaseRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 consumer=await mkdtemp(join(tmpdir(),'editac-composition-remote-consumer-'));
 const packed=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/core','--json','--pack-destination',consumer],'pack.log'))[0];
 const bytes=await readFile(join(consumer,packed.filename));await writeFile(join(output,packed.filename),bytes);
 facts.packed={filename:packed.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),includesWasm:packed.files.some(f=>f.path==='dist/wasm/editac_wasm_bg.wasm')};assert.equal(facts.packed.includesWasm,true);
 await run('tar',['-xzf',join(consumer,packed.filename),'-C',consumer],'unpack.log');
 server=await startFixtureServer({fixtureDirectory:'fixtures/browser-input',coreDirectory:join(consumer,'package/dist')});
 facts.server={port:server.port,url:server.url,pid:process.pid,launcher:'node --test tests/browser/composition-remote.spec.ts',workspace:process.cwd(),purpose:'WEB-1.7 real packed protocol probe',log:output};
 controller=await browserType.launchServer({headless:true});const child=controller.process();
 facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'WEB-1.7 pinned '+engineName,log:output});
 browser=await browserType.connect(controller.wsEndpoint());facts.browser={engine:engineName,version:browser.version(),playwright:'1.64.0',node:process.version,platform:process.platform,arch:process.arch};
});
after(async()=>{
 try{await browser?.close();}finally{try{if(controller){await controller.close();facts.cleanup.browserExited=controller.process().exitCode!==null||controller.process().signalCode!==null;assert.equal(facts.cleanup.browserExited,true);}}finally{try{if(server){await server.close();facts.cleanup.listenerRemoved=await new Promise(resolve=>{const socket=createConnection(server.port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve(e.code==='ECONNREFUSED'));});assert.equal(facts.cleanup.listenerRemoved,true);}}finally{if(consumer)await rm(consumer,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;facts.sourcesUnchanged=JSON.stringify(facts.sources)===JSON.stringify(await hashSources());await writeFile(join(output,'facts.json'),JSON.stringify(facts,null,2));assert.equal(facts.sourcesUnchanged,true,'Probe source/artifacts changed during execution');}}}
});
async function probe(name,action,mountText='alpha'){
 const context=await browser.newContext(),fact={name,passed:false,provenance:name.startsWith('native-')?'actual Playwright browser keyboard':'prepared real-DOM event replay',snapshots:[]};facts.cases.push(fact);
 const page=await context.newPage();page.on('pageerror',error=>{fact.pageErrors??=[];fact.pageErrors.push(error.message);});
 try{await page.goto(server.url);await page.waitForFunction(()=>!!window.inputFixture);await page.evaluate(text=>window.inputFixture.mount(text),mountText);await action(page,fact);fact.traceProvenance={nativeTrustedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>t.trusted).map(t=>t.type)))],preparedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>!t.trusted&&!t.type.endsWith('mutations')&&t.type!=='renderer-echo').map(t=>t.type)))],composition:'prepared event replay; no OS IME'};assert.deepEqual(fact.pageErrors??[],[]);fact.passed=true;}
 finally{try{await page.evaluate(()=>window.inputFixture.destroy());}finally{await context.close();}}
}
async function observe(page,fact){const state=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(state);assert.deepEqual(state.errors,[]);assert.equal(state.storage,'localCommitted');assert.equal(state.unrelatedIdentity,true);return state;}
function effects(state,count){const commits=state.patches.filter(p=>p.origin.startsWith('editac:local:text-input:')&&p.update);const journal=state.journal.filter(p=>p.origin.startsWith('editac:local:text-input:'));assert.equal(commits.length,count);assert.equal(journal.length,count);assert.equal(state.history.undoGroups,count);assert.equal(new Set(commits.map(p=>p.origin)).size,count);assert.equal(state.intents.filter(i=>i.disposition==='committed').length,count);for(const p of commits)assert.ok(p.bytes>0);}
function content(state,text,caret=text.length){assert.equal(state.text[0],text);assert.equal(state.dom[0],text);assert.deepEqual(state.dom,state.text);assert.equal(state.caret?.offset,caret);assert.equal(state.caret?.node,state.ids[0]);}

async function begin(page,start=2,end=start,text='al語pha') {
 await page.evaluate(({start,end,text})=>{const f=window.inputFixture;f.select(f.ids[0],start,end);
  window.composingBlock=f.renderer.getBlock(f.ids[0]);window.composingText=document.createTreeWalker(window.composingBlock,NodeFilter.SHOW_TEXT).nextNode();
  f.event('compositionstart');f.mutate(text);f.event('compositionupdate',{data:'語'});f.event('input',{inputType:'insertCompositionText',data:'語',isComposing:true});},{start,end,text});
}
async function held(page,fact,native,model,other='independent') {
 const state=await observe(page,fact);effects(state,0);assert.equal(state.text[0],model);assert.equal(state.boundDom[0],native);
 assert.equal(state.text[1],other);assert.equal(state.dom[1],other);assert.equal(state.selectionSuspended,true);
 assert.equal(await page.evaluate(()=>{const f=window.inputFixture;return window.composingBlock===f.renderer.getBlock(f.ids[0])&&window.composingText===document.createTreeWalker(window.composingBlock,NodeFilter.SHOW_TEXT).nextNode();}),true);
 return state;
}
async function finish(page,mode='final') {
 await page.evaluate(mode=>{const f=window.inputFixture;if(mode==='readonly')f.protocol.setReadOnly(true);else f.event(mode==='blur'?'blur':'compositionend',mode==='cancel'?{data:''}:{data:'語'});
  f.event('compositionend',{data:'語'});f.event('beforeinput',{inputType:'insertCompositionText',data:'語',cancelable:true});f.event('input',{inputType:'insertCompositionText',data:'語'});},mode);
}
function remoteEffects(state,count) {
 assert.equal(state.patches.filter(p=>p.operation==='Remote'&&p.update).length,count);
 assert.equal(state.journal.filter(p=>!p.origin.startsWith('editac:local:text-input:')).length,count);
 assert.equal(state.selectionSuspended,false);
}
function rejected(state,reason,text='語') {
 effects(state,0);assert.equal(state.intents[0].disposition,'rejected');assert.equal(state.intents[0].reason,reason);assert.equal(state.intents[0].text,text);
 assert.equal(state.recovery.at(-1).reason,reason);assert.equal(state.recovery.at(-1).text,text);assert.equal(state.recovery.at(-1).truncated,false);
 assert.equal(state.caret,null);assert.equal(state.nativeCaret,null);assert.deepEqual(state.dom,state.text);
}
for(const [where,offset,model,final,caret] of [
 ['before',0,'!alpha','!al語pha',4],['at',2,'al!pha','al!語pha',4],['after',5,'alpha!','al語pha!',3]
])test(`collapsed-${where}: remote insertion keeps native subtree and retained affinity`,()=>probe('collapsed-'+where,async(page,fact)=>{
 await begin(page);await page.evaluate(async offset=>{await window.inputFixture.remote(offset,'!');},offset);
 await held(page,fact,'al語pha',model);await finish(page);const state=await observe(page,fact);content(state,final,caret);effects(state,1);remoteEffects(state,1);assert.deepEqual(state.recovery,[]);
}));
for(const backward of [false,true])for(const [where,offset,model,final,caret] of [
 ['before',0,'!alpha','!a語a',3],['start',1,'a!lpha','a!語a',3],['after',5,'alpha!','a語a!',2]
])test(`replacement-${where}-${backward}: captured directional range follows peer edit`,()=>probe(`replacement-${where}-${backward}`,async(page,fact)=>{
 await begin(page,backward?4:1,backward?1:4,'a語a');await page.evaluate(offset=>window.inputFixture.remote(offset,'!'),offset);
 await held(page,fact,'a語a',model);await finish(page);const state=await observe(page,fact);content(state,final,caret);effects(state,1);remoteEffects(state,1);
}));
for(const [where,offset,model] of [['inside',2,'al!pha'],['end',4,'alph!a']])test(`overlap-${where}: preserve peer content and explicit recovery`,()=>probe('overlap-'+where,async(page,fact)=>{
 await begin(page,1,4,'a語a');await page.evaluate(offset=>window.inputFixture.remote(offset,'!'),offset);await held(page,fact,'a語a',model);
 await finish(page);const state=await observe(page,fact);rejected(state,'remote-overlap');remoteEffects(state,1);assert.equal(state.text[0],model);
 // Rejection cannot retain an owner that swallows a new deliberate identical edit.
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0);f.event('beforeinput',{inputType:'insertText',data:'語',cancelable:true});});
 const next=await observe(page,fact);effects(next,1);content(next,'語'+model,1);assert.equal(next.intents.length,2);
}));
for(const [label,start,end,text,model] of [['delete-selected',1,4,'','aa'],['replace-selected',1,4,'PEER','aPEERa']])test(`${label}: remote replacement is not overwritten`,()=>probe(label,async(page,fact)=>{
 await begin(page,1,4,'a語a');await page.evaluate(({start,end,text})=>window.inputFixture.remoteReplace(start,end,text),{start,end,text});await held(page,fact,'a語a',model);
 await finish(page);const state=await observe(page,fact);rejected(state,'remote-overlap');remoteEffects(state,1);assert.equal(state.text[0],model);
}));
test('independent-and-burst: apply independent block patches while coalescing held owner',()=>probe('independent-and-burst',async(page,fact)=>{
 await begin(page);await page.evaluate(async()=>{const f=window.inputFixture;await f.remote(0,'!');await f.remote(6,'?');await f.remote(0,'REMOTE ',f.ids[1]);});
 // Independent edits legitimately change their text identity; the block survives.
 const mid=await page.evaluate(()=>{const f=window.inputFixture;return {native:f.renderer.getBlock(f.ids[0]).textContent,other:f.renderer.getBlock(f.ids[1]).textContent,identity:window.composingBlock===f.renderer.getBlock(f.ids[0])&&window.composingText===document.createTreeWalker(window.composingBlock,NodeFilter.SHOW_TEXT).nextNode()};});fact.intermediate=mid;
 assert.deepEqual(mid,{native:'al語pha',other:'REMOTE independent',identity:true});const interim=await observe(page,fact);effects(interim,0);assert.deepEqual(interim.text,['!alpha?','REMOTE independent']);
 await finish(page);const state=await observe(page,fact);content(state,'!al語pha?',4);effects(state,1);remoteEffects(state,3);assert.equal(state.text[1],'REMOTE independent');
 await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));const undone=await observe(page,fact);assert.deepEqual(undone.text,['!alpha?','REMOTE independent']);assert.deepEqual(undone.dom,undone.text);assert.equal(undone.history.undoGroups,0);assert.equal(undone.history.redoGroups,1);
 await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));const redone=await observe(page,fact);assert.deepEqual(redone.text,['!al語pha?','REMOTE independent']);assert.deepEqual(redone.dom,redone.text);
}));
for(const mode of ['final','blur','cancel','readonly'])test(`deleted-owner-${mode}: preserve captured text without redirect`,()=>probe('deleted-owner-'+mode,async(page,fact)=>{
 await begin(page);const initial=await page.evaluate(()=>{const f=window.inputFixture;return {bytes:[...f.engine.encodeUpdate().bytes],vector:[...f.engine.stateVector()],id:f.ids[0]};});
 const peer=new Y.Doc();peer.clientID=1901;let update;try{Y.applyUpdate(peer,new Uint8Array(initial.bytes));peer.getMap('delete-probe-tombstones').set(initial.id,true);update=[...Y.encodeStateAsUpdate(peer,new Uint8Array(initial.vector))];}finally{peer.destroy();}
 await page.evaluate(bytes=>window.inputFixture.apply(bytes),update);
 const mid=await observe(page,fact);effects(mid,0);assert.deepEqual(mid.text,['independent']);assert.equal(mid.boundDom[0],'al語pha');assert.equal(mid.selectionSuspended,true);
 await finish(page,mode);const state=await observe(page,fact);effects(state,0);remoteEffects(state,1);assert.deepEqual(state.text,['independent']);assert.deepEqual(state.dom,state.text);assert.equal(state.boundDom[0],null);
 if(mode==='final'||mode==='blur')rejected(state,'stale-target');else{assert.equal(state.intents[0].disposition,'canceled');assert.equal(state.intents[0].text,'語');}
}));
for(const mode of ['blur','cancel','readonly'])test(`remote-before-${mode}: terminal policy projects peer without duplicate commit`,()=>probe('remote-before-'+mode,async(page,fact)=>{
 await begin(page);await page.evaluate(()=>window.inputFixture.remote(0,'!'));await held(page,fact,'al語pha','!alpha');await finish(page,mode);
 const state=await observe(page,fact);remoteEffects(state,1);if(mode==='blur'){effects(state,1);content(state,'!al語pha',4);}else{effects(state,0);assert.equal(state.text[0],'!alpha');assert.deepEqual(state.dom,state.text);assert.equal(state.intents[0].disposition,'canceled');assert.equal(state.intents[0].text,'語');}
}));
test('unicode-stable-target: UTF-16 peer insertion retains emoji and composed caret',()=>probe('unicode-stable-target',async(page,fact)=>{
 await begin(page,3,3,'a😀語b');await page.evaluate(()=>window.inputFixture.remote(0,'!'));await held(page,fact,'a😀語b','!a😀b');await finish(page);
 const state=await observe(page,fact);content(state,'!a😀語b',5);effects(state,1);remoteEffects(state,1);
},'a😀b'));
test('consecutive-sessions: held patch and owner are released before identical next composition',()=>probe('consecutive-sessions',async(page,fact)=>{
 await begin(page);await page.evaluate(()=>window.inputFixture.remote(0,'!'));await finish(page);let state=await observe(page,fact);content(state,'!al語pha',4);effects(state,1);
 await begin(page,4,4,'!al語語pha');await page.evaluate(()=>window.inputFixture.remote(0,'?'));await finish(page);state=await observe(page,fact);content(state,'?!al語語pha',6);effects(state,2);remoteEffects(state,2);assert.equal(state.intents.length,2);
}));
