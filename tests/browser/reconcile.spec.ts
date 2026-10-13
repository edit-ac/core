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
const engineName=process.env.EDITAC_RECONCILE_BROWSER??'chromium';
const browserType={chromium,firefox,webkit}[engineName];
if(!browserType)throw Error(`Unknown input browser: ${engineName}`);
const output=process.env.EDITAC_RECONCILE_OUTPUT??await mkdtemp(join(tmpdir(),'editac-reconcile-evidence-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[],packed:{},browser:{},server:{},cleanup:{}};
let consumer,server,browser,controller;
async function run(command,args,log){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});await writeFile(join(output,log),`${r.stdout??''}\n${r.stderr??''}`);assert.equal(r.error,undefined,log);assert.equal(r.status,0,log);return r.stdout;}
const sourcePaths=['packages/web/src/input/reconcile.ts','packages/web/dist/input/reconcile.js','packages/web/src/input/text.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input/session.mjs','fixtures/browser-input/index.html','tests/browser/reconcile.spec.ts','scripts/test-browser.mjs','packages/core/src/engine.ts','packages/core/dist/index.js','packages/core/dist/engine.js','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/web/dist/input/text.js','packages/web/dist/dom/render.js','packages/web/dist/dom/selection.js','packages/web/dist/entry.js','packages/web/dist/storage/index.js','packages/web/dist/storage/journal.js','packages/web/dist/storage/writer.js','package-lock.json'];
async function hashSources(){return Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
before(async()=>{
 facts.sources=await hashSources();
 facts.coreBaseRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 consumer=await mkdtemp(join(tmpdir(),'editac-reconcile-consumer-'));
 const packed=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/core','--json','--pack-destination',consumer],'pack.log'))[0];
 const bytes=await readFile(join(consumer,packed.filename));await writeFile(join(output,packed.filename),bytes);
 facts.packed={filename:packed.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),includesWasm:packed.files.some(f=>f.path==='dist/wasm/editac_wasm_bg.wasm')};assert.equal(facts.packed.includesWasm,true);
 await run('tar',['-xzf',join(consumer,packed.filename),'-C',consumer],'unpack.log');
 server=await startFixtureServer({fixtureDirectory:'fixtures/browser-input',coreDirectory:join(consumer,'package/dist')});
 facts.server={port:server.port,url:server.url,pid:process.pid,launcher:'node --test tests/browser/reconcile.spec.ts',workspace:process.cwd(),purpose:'WEB-1.5 real packed protocol probe',log:output};
 controller=await browserType.launchServer({headless:true});const child=controller.process();
 facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'WEB-1.5 pinned '+engineName,log:output});
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
async function observe(page,fact,unrelated=true){const state=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(state);assert.deepEqual(state.errors,[]);assert.equal(state.storage,'localCommitted');assert.equal(state.unrelatedIdentity,unrelated);return state;}
function effects(state,count){const commits=state.patches.filter(p=>p.origin.startsWith('editac:local:text-input:')&&p.update);const journal=state.journal.filter(p=>p.origin.startsWith('editac:local:text-input:'));assert.equal(commits.length,count);assert.equal(journal.length,count);assert.equal(state.history.undoGroups,count);assert.equal(new Set(commits.map(p=>p.origin)).size,count);assert.equal(state.intents.filter(i=>i.disposition==='committed').length,count);for(const p of commits)assert.ok(p.bytes>0);}
function content(state,text,caret=text.length){assert.equal(state.text[0],text);assert.equal(state.dom[0],text);assert.deepEqual(state.dom,state.text);assert.equal(state.caret?.offset,caret);assert.equal(state.caret?.node,state.ids[0]);}


// Prepared mutations exercise browser mechanics; none is an OS autocorrect/IME claim.
for (const [name,inputType,text] of [['spellcheck','insertReplacementText','alfa'],['autocorrect','insertReplacementText','Alpha'],['paste-like','insertFromPaste','alpha <literal>']]) {
 for (const order of ['input-first','observer-first','observer-only']) test(`prepared ${name} ${order} reconciles exactly once`,()=>probe(name+'-'+order,async(page,fact)=>{
  await page.evaluate(async ({inputType,text,order})=>{const f=window.inputFixture;
   if(order!=='observer-only')f.event('beforeinput',{inputType,data:null,cancelable:false});
   f.mutate(text);
   if(order!=='input-first')await f.settle();
   if(order!=='observer-only'){f.event('input',{inputType,data:null});f.event('input',{inputType,data:null});}
  },{inputType,text,order});
  const state=await observe(page,fact);content(state,text);effects(state,1);assert.deepEqual(state.recovery,[]);
  assert.equal(state.intents.filter(i=>i.disposition==='committed').length,1);
 }));
}
test('prepared input without any beforeinput admits an existing text-node mutation',()=>probe('missing-beforeinput',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alphaX');f.event('input',{inputType:'insertText',data:'X'});});
 const state=await observe(page,fact);content(state,'alphaX');effects(state,1);assert.equal(state.intents[0].origin,'native');
}));
test('prepared unusable cancelable beforeinput falls back to native text',()=>probe('unusable-beforeinput',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;const e=f.event('beforeinput',{inputType:'insertText',data:null,cancelable:true});if(e.defaultPrevented)throw Error('Unusable event incorrectly commanded');f.mutate('alphaX');f.event('input',{inputType:'insertText',data:null});});
 const state=await observe(page,fact);content(state,'alphaX');effects(state,1);
}));
test('prepared plain-text child replacement canonicalizes only the affected block',()=>probe('child-replacement',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,b=f.renderer.getBlock(f.ids[0]);b.replaceChildren(document.createTextNode('corrected'));document.getSelection().setBaseAndExtent(b.firstChild,9,b.firstChild,9);f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);content(state,'corrected');effects(state,1);assert.deepEqual(state.recovery,[]);
}));
test('prepared observer-owned duplicates retain a deliberate identical second edit',()=>probe('deliberate-identical',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture;f.mutate('alphaX');await f.settle();const e=f.event('input',{inputType:'insertText',data:'X'});f.root.dispatchEvent(e);f.event('input',{inputType:'insertText',data:'X'});});
 let state=await observe(page,fact);content(state,'alphaX');effects(state,1);
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alphaXX');f.event('input',{inputType:'insertText',data:'X'});});
 state=await observe(page,fact);content(state,'alphaXX');effects(state,2);
 assert.equal(new Set(state.intents.filter(i=>i.disposition==='committed').map(i=>i.id)).size,2);
}));
test('prepared multiple mutations in one owned batch commit final text once',()=>probe('multiple-records',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alphax');f.mutate('alphaxy');f.mutate('alphaxyz');f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);content(state,'alphaxyz');effects(state,1);
}));
test('prepared Unicode replacement preserves UTF-16 scalar boundaries and native caret',()=>probe('unicode-replacement',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alpha😀');f.event('input',{inputType:'insertReplacementText'});});
 let state=await observe(page,fact);content(state,'alpha😀',7);effects(state,1);
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alpha😁');f.event('input',{inputType:'insertReplacementText'});});
 state=await observe(page,fact);content(state,'alpha😁',7);effects(state,2);
}));
test('prepared no-op child replacement rebuilds mappings without a semantic update',()=>probe('noop-replacement',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,b=f.renderer.getBlock(f.ids[0]);b.replaceChildren(document.createTextNode('alpha'));f.event('input',{inputType:'insertReplacementText'});});
 let state=await observe(page,fact);assert.equal(state.text[0],'alpha');assert.deepEqual(state.dom,state.text);effects(state,0);
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],5);f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true});});
 state=await observe(page,fact);content(state,'alphaX');effects(state,1);
}));
test('prepared renderer echo cannot consume an unprompted native mutation in the same turn',()=>probe('renderer-echo',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture;f.mutate('alphaX');await f.remote(0,'!',f.ids[1]);f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);content(state,'alphaX');effects(state,1);assert.equal(state.text[1],'!independent');assert.ok(state.trace.some(t=>t.type==='renderer-echo'));
}));
test('prepared pure renderer patches and input-only notifications produce zero local effects',()=>probe('pure-echo',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture;await f.remote(0,'!',f.ids[0]);f.event('input',{inputType:'insertReplacementText'});f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);content(state,'!alpha',6);effects(state,0);assert.deepEqual(state.recovery,[]);assert.equal(state.intents.length,0);
}));
function recovery(state,reason,text,truncated=false){effects(state,0);assert.equal(state.recovery.length,1);assert.equal(state.recovery[0].reason,reason);assert.equal(state.recovery[0].text,text);assert.equal(state.recovery[0].truncated,truncated);assert.equal(state.intents.at(-1).disposition,'rejected');}
test('prepared pasted markup exposes recovery and leaves authoritative text unchanged',()=>probe('unsupported-markup',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,b=f.renderer.getBlock(f.ids[0]),span=document.createElement('strong');span.textContent='pasted';b.replaceChildren(span);f.event('input',{inputType:'insertFromPaste'});f.event('input',{inputType:'insertFromPaste'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha');assert.deepEqual(state.dom,state.text);recovery(state,'unsupported-native-structure','pasted');assert.equal(state.editable,'true');
}));
test('prepared unknown root mutation exposes recovery and stops editing without root diff',()=>probe('unsupported-root',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,p=document.createElement('p');p.textContent='foreign';f.root.append(p);f.event('input',{inputType:'insertFromPaste'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha');recovery(state,'unsupported-native-scope','foreign');assert.equal(state.editable,'false');
}));
test('prepared multi-block mutation is explicit unsupported recovery, never partial commit',()=>probe('multi-block',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alphaX');f.mutate('independentY',f.ids[1]);f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.deepEqual(state.text,['alpha','independent']);assert.deepEqual(state.dom,state.text);recovery(state,'unsupported-native-scope','alphaXindependentY');assert.equal(state.editable,'false');
}));
test('prepared affected-block resource limit retains bounded recovery and no semantic effect',()=>probe('resource-limit',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('x'.repeat(256*1024+1));f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha');assert.deepEqual(state.dom,state.text);recovery(state,'native-limit','x'.repeat(256*1024),true);
}));
test('prepared same-block remote patch rejects a changed baseline with captured recovery',()=>probe('remote-baseline',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture;f.mutate('alphaX');await f.remote(0,'!',f.ids[0]);f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'!alpha');assert.deepEqual(state.dom,state.text);recovery(state,'native-baseline-changed','alphaX');
}));
test('prepared read-only unprompted native text is restored with observable recovery',()=>probe('read-only-native',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.protocol.setReadOnly(true);f.mutate('alphaX');f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha');assert.deepEqual(state.dom,state.text);recovery(state,'read-only','alphaX');
}));
test('prepared dispose invalidates queued observer-owned edit',()=>probe('disposed-native',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture;f.mutate('alphaX');await Promise.resolve();f.protocol.dispose();f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha');effects(state,0);assert.ok(state.intents.every(i=>i.disposition==='disposed'));
}));

test('prepared removed root block retains removed text and disables editing',()=>probe('removed-root',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.renderer.getBlock(f.ids[0]).remove();f.event('input',{inputType:'deleteContentBackward'});});
 const state=await observe(page,fact);assert.deepEqual(state.text,['alpha','independent']);recovery(state,'unsupported-native-scope','alpha');assert.equal(state.editable,'false');
}));
test('prepared record limit stops editing and preserves bounded final text',()=>probe('record-limit',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;for(let i=1;i<=65;i++)f.mutate('alpha'+'x'.repeat(i));f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha');assert.deepEqual(state.dom,state.text);recovery(state,'native-limit','alpha'+'x'.repeat(65),true);assert.equal(state.editable,'false');
}));
test('prepared correction preserves independently navigated caret in another block',()=>probe('independent-caret',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('Alpha');f.select(f.ids[1],3);f.event('input',{inputType:'insertReplacementText'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'Alpha');assert.deepEqual(state.dom,state.text);effects(state,1);assert.equal(state.caret.node,state.ids[1]);assert.equal(state.caret.offset,3);
}));
test('prepared multiline pasted text uses semantic LF rather than textContent omission',()=>probe('multiline-literal',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alpha\nline');f.event('input',{inputType:'insertFromPaste'});});
 const state=await observe(page,fact);assert.equal(state.text[0],'alpha\nline');assert.equal(state.dom[0],'alpha\nline');effects(state,1);assert.equal(state.caret.offset,10);
 await page.evaluate(()=>{const f=window.inputFixture,b=f.renderer.getBlock(f.ids[0]);b.querySelector('span').firstChild.data='Alpha';f.event('input',{inputType:'insertReplacementText'});});
 const next=await observe(page,fact);assert.equal(next.text[0],'Alpha\nline');assert.equal(next.dom[0],'Alpha\nline');effects(next,2);
}));
test('prepared unknown root recovery preserves selection outside this editor',()=>probe('outside-root-selection',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.inputFixture,outside=document.querySelector('#status').firstChild;document.getSelection().setBaseAndExtent(outside,2,outside,2);const p=document.createElement('p');p.textContent='foreign';f.root.append(p);f.event('input',{inputType:'insertFromPaste'});await f.settle();const selection=document.getSelection();if(selection.anchorNode!==outside||selection.anchorOffset!==2)throw Error('Outside selection was cleared');});
 const state=await observe(page,fact);recovery(state,'unsupported-native-scope','foreign');assert.equal(state.editable,'false');
}));
