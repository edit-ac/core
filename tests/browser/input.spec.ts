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
const engineName=process.env.EDITAC_INPUT_BROWSER??'chromium';
const browserType={chromium,firefox,webkit}[engineName];
if(!browserType)throw Error(`Unknown input browser: ${engineName}`);
const output=process.env.EDITAC_INPUT_OUTPUT??await mkdtemp(join(tmpdir(),'editac-input-evidence-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[],packed:{},browser:{},server:{},cleanup:{}};
let consumer,server,browser,controller;
async function run(command,args,log){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});await writeFile(join(output,log),`${r.stdout??''}\n${r.stderr??''}`);assert.equal(r.error,undefined,log);assert.equal(r.status,0,log);return r.stdout;}
const sourcePaths=['packages/web/src/input/keyboard.ts','packages/web/dist/input/keyboard.js','packages/web/src/input/text.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input/session.mjs','fixtures/browser-input/index.html','tests/browser/input.spec.ts','scripts/test-browser.mjs','packages/core/src/engine.ts','packages/core/dist/index.js','packages/core/dist/engine.js','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/web/dist/input/text.js','packages/web/dist/dom/render.js','packages/web/dist/dom/selection.js','packages/web/dist/entry.js','packages/web/dist/storage/index.js','packages/web/dist/storage/journal.js','packages/web/dist/storage/writer.js','package-lock.json'];
async function hashSources(){return Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
before(async()=>{
 facts.sources=await hashSources();
 facts.coreBaseRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 consumer=await mkdtemp(join(tmpdir(),'editac-input-consumer-'));
 const packed=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/core','--json','--pack-destination',consumer],'pack.log'))[0];
 const bytes=await readFile(join(consumer,packed.filename));await writeFile(join(output,packed.filename),bytes);
 facts.packed={filename:packed.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),includesWasm:packed.files.some(f=>f.path==='dist/wasm/editac_wasm_bg.wasm')};assert.equal(facts.packed.includesWasm,true);
 await run('tar',['-xzf',join(consumer,packed.filename),'-C',consumer],'unpack.log');
 server=await startFixtureServer({fixtureDirectory:'fixtures/browser-input',coreDirectory:join(consumer,'package/dist')});
 facts.server={port:server.port,url:server.url,pid:process.pid,launcher:'node --test tests/browser/input.spec.ts',workspace:process.cwd(),purpose:'WEB-1.4 real packed protocol probe',log:output};
 controller=await browserType.launchServer({headless:true});const child=controller.process();
 facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'WEB-1.4 pinned '+engineName,log:output});
 browser=await browserType.connect(controller.wsEndpoint());facts.browser={engine:engineName,version:browser.version(),playwright:'1.64.0',node:process.version,platform:process.platform,arch:process.arch};
});
after(async()=>{
 try{await browser?.close();}finally{try{if(controller){await controller.close();facts.cleanup.browserExited=controller.process().exitCode!==null||controller.process().signalCode!==null;assert.equal(facts.cleanup.browserExited,true);}}finally{try{if(server){await server.close();facts.cleanup.listenerRemoved=await new Promise(resolve=>{const socket=createConnection(server.port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve(e.code==='ECONNREFUSED'));});assert.equal(facts.cleanup.listenerRemoved,true);}}finally{if(consumer)await rm(consumer,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;facts.sourcesUnchanged=JSON.stringify(facts.sources)===JSON.stringify(await hashSources());await writeFile(join(output,'facts.json'),JSON.stringify(facts,null,2));assert.equal(facts.sourcesUnchanged,true,'Probe source/artifacts changed during execution');}}}
});
async function probe(name,action){
 const context=await browser.newContext(),fact={name,passed:false,provenance:name.startsWith('native-')?'actual Playwright browser keyboard':'prepared real-DOM event replay',snapshots:[]};facts.cases.push(fact);
 const page=await context.newPage();page.on('pageerror',error=>{fact.pageErrors??=[];fact.pageErrors.push(error.message);});
 try{await page.goto(server.url);await page.waitForFunction(()=>!!window.inputFixture);await page.evaluate(()=>window.inputFixture.mount());await action(page,fact);fact.traceProvenance={nativeTrustedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>t.trusted).map(t=>t.type)))],preparedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>!t.trusted&&!t.type.endsWith('mutations')&&t.type!=='renderer-echo').map(t=>t.type)))],composition:'prepared event replay; no OS IME'};assert.deepEqual(fact.pageErrors??[],[]);fact.passed=true;}
 finally{try{await page.evaluate(()=>window.inputFixture.destroy());}finally{await context.close();}}
}
async function observe(page,fact){const state=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(state);assert.deepEqual(state.errors,[]);assert.equal(state.storage,'localCommitted');assert.equal(state.unrelatedIdentity,true);return state;}
function effects(state,count,keyboard=0){
 const local=p=>p.origin.startsWith('editac:local:text-input:')||p.origin.startsWith('editac:local:keyboard:');
 const commits=state.patches.filter(p=>local(p)&&p.update),journal=state.journal.filter(local);
 assert.equal(commits.length,count);assert.equal(journal.length,count);
 // Character and selected deletions belong to the prepared keyboard bridge. Keep
 // exact owner counts, rather than dropping their update/journal assertions.
 for(const family of ['text-input','keyboard']){
  const expected=family==='keyboard'?keyboard:count-keyboard,prefix=`editac:local:${family}:`;
  assert.equal(commits.filter(p=>p.origin.startsWith(prefix)).length,expected);
  assert.equal(journal.filter(p=>p.origin.startsWith(prefix)).length,expected);
 }
 assert.equal(state.history.undoGroups,count);assert.equal(new Set(commits.map(p=>p.origin)).size,count);assert.equal(state.intents.filter(i=>i.disposition==='committed').length,count);for(const p of commits)assert.ok(p.bytes>0);
}
function content(state,text,caret=text.length){assert.equal(state.text[0],text);assert.equal(state.dom[0],text);assert.deepEqual(state.dom,state.text);assert.equal(state.caret?.offset,caret);assert.equal(state.caret?.node,state.ids[0]);}


test('native-typing: agreement and attributable effects after every physical edit',()=>probe('native-typing',async(page,fact)=>{
 let text='alpha',count=0,keyboard=0;
 for(const key of ['x','x','Backspace','y','Backspace','Backspace']) {
  await page.keyboard.press(key);text=key==='Backspace'?text.slice(0,-1):text+key;
  const state=await observe(page,fact);content(state,text);if(key==='Backspace')keyboard++;effects(state,++count,keyboard);
 }
 const state=fact.snapshots.at(-1);assert.ok(state.trace.some(t=>t.type==='beforeinput'&&t.trusted));assert.ok(state.trace.some(t=>t.type==='renderer-echo'&&t.count>0));
}));
test('native-forward-delete: browser deletion range preserves caret and unrelated nodes',()=>probe('native-forward-delete',async(page,fact)=>{
 await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],1));await page.keyboard.press('Delete');let state=await observe(page,fact);content(state,'apha',1);effects(state,1,1);
 await page.keyboard.press('Delete');state=await observe(page,fact);content(state,'aha',1);effects(state,2,2);
}));
for(const backward of [false,true])test(`native-selected-${backward?'backward':'forward'} replacement`,()=>probe('native-selected-'+backward,async(page,fact)=>{
 await page.evaluate(backward=>{const f=window.inputFixture;f.select(f.ids[0],backward?4:1,backward?1:4);},backward);
 await page.keyboard.press('X');const state=await observe(page,fact);content(state,'aXa',2);effects(state,1);
}));
for(const key of ['Backspace','Delete'])test(`native-selected deletion ${key}`,()=>probe('native-selected-delete-'+key,async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],4,1);});await page.keyboard.press(key);const state=await observe(page,fact);content(state,'aa',1);effects(state,1,1);
}));
test('native-empty-block: delete final character then type again',()=>probe('native-empty-block',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0,5);});await page.keyboard.press('Backspace');let state=await observe(page,fact);content(state,'',0);effects(state,1,1);
 await page.keyboard.press('q');state=await observe(page,fact);content(state,'q',1);effects(state,2,1);
 await page.keyboard.press('Backspace');state=await observe(page,fact);content(state,'',0);effects(state,3,2);
 await page.keyboard.press('z');state=await observe(page,fact);content(state,'z',1);effects(state,4,2);
}));
test('native-emoji: browser deletion never splits UTF-16 pairs',()=>probe('native-emoji',async(page,fact)=>{
 fact.provenance='prepared ordinary emoji insertion; actual browser Backspace (Firefox insertText automation uses composition, outside WEB-1.4)';
 await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertText',data:'😀',cancelable:true}));let state=await observe(page,fact);content(state,'alpha😀',7);effects(state,1);
 await page.keyboard.press('Backspace');state=await observe(page,fact);content(state,'alpha',5);effects(state,2,1);
}));
test('native-boundary: deletion no-op has no update/history/journal effect',()=>probe('native-boundary',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0);});await page.keyboard.press('Backspace');const state=await observe(page,fact);content(state,'alpha',0);effects(state,0);
}));
test('prepared cancelable: event identity and duplicate input preserve a deliberate identical edit',()=>probe('cancelable-identity',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;const e=f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true});if(!e.defaultPrevented)throw Error('Not owned');f.root.dispatchEvent(e);f.event('input',{inputType:'insertText',data:'X'});f.event('input',{inputType:'insertText',data:'X'});});let state=await observe(page,fact);content(state,'alphaX');effects(state,1);
 await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true}));state=await observe(page,fact);content(state,'alphaXX');effects(state,2);
}));
test('prepared key-cycle: distinct duplicate notifications are owned once; repeat keydown is a new edit',()=>probe('key-cycle',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.event('keydown',{key:'x'});f.event('beforeinput',{inputType:'insertText',data:'x',cancelable:true});f.event('beforeinput',{inputType:'insertText',data:'x',cancelable:true});f.event('input',{inputType:'insertText',data:'x'});f.event('keydown',{key:'x',repeat:true});f.event('beforeinput',{inputType:'insertText',data:'x',cancelable:true});f.event('keyup',{key:'x'});});const state=await observe(page,fact);content(state,'alphaxx');effects(state,2);
}));
for(const order of ['input-first','observer-first'])test(`prepared ordinary native ${order} reconciles once`,()=>probe('native-replay-'+order,async(page,fact)=>{
 fact.provenance='prepared real-DOM ordinary input replay';
 await page.evaluate(async order=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:false});f.mutate('alphaX');if(order==='observer-first')await f.settle();f.event('input',{inputType:'insertText',data:'X'});f.event('input',{inputType:'insertText',data:'X'});},order);
 let state=await observe(page,fact);content(state,'alphaX');effects(state,1);
 await page.evaluate(()=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:false});f.mutate('alphaXX');f.event('input',{inputType:'insertText',data:'X'});});state=await observe(page,fact);content(state,'alphaXX');effects(state,2);
}));
test('prepared cancelable target deletion uses the supplied mapped range',()=>probe('target-range',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],3);const start=f.selection.toDOM({node:f.ids[0],offset:2,bias:'right'}),end=f.selection.toDOM({node:f.ids[0],offset:3,bias:'left'});const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'deleteContentBackward'});Object.defineProperty(e,'getTargetRanges',{value:()=>[new StaticRange({startContainer:start.node,startOffset:start.offset,endContainer:end.node,endOffset:end.offset})]});f.root.dispatchEvent(e);if(!e.defaultPrevented)throw Error('Deletion not owned');});const state=await observe(page,fact);content(state,'alha',2);effects(state,1,1);
}));
test('prepared renderer echo leaves an independent native edit in the same turn',()=>probe('renderer-echo',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:false});f.mutate('alphaX');await f.remote(0,'!',f.ids[1]);f.event('input',{inputType:'insertText',data:'X'});});const state=await observe(page,fact);content(state,'alphaX');effects(state,1);assert.equal(state.text[1],'!independent');assert.ok(state.trace.some(t=>t.type==='renderer-echo'));
}));
test('prepared read-only rejects insertion/deletion without effects',()=>probe('read-only',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.protocol.setReadOnly(true);for(const type of ['insertText','deleteContentBackward']){const e=f.event('beforeinput',{inputType:type,data:'X',cancelable:true});if(!e.defaultPrevented)throw Error('Read-only event not blocked');}});const state=await observe(page,fact);content(state,'alpha');effects(state,0);assert.ok(state.intents.every(i=>i.reason==='read-only'));
}));
test('prepared disposed generation cannot commit a pending native edit',()=>probe('disposed-generation',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:false});f.mutate('alphaX');f.protocol.dispose();f.event('input',{inputType:'insertText',data:'X'});});const state=await observe(page,fact);assert.equal(state.text[0],'alpha');effects(state,0);assert.equal(state.intents[0].disposition,'disposed');
}));
