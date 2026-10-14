import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { chromium, firefox, webkit } from 'playwright';
import * as Y from 'yjs';
import { startFixtureServer } from './fixture-server.mjs';
const engineName=process.env.EDITAC_INPUT_POLICY_BROWSER??'chromium';
const browserType={chromium,firefox,webkit}[engineName];
if(!browserType)throw Error(`Unknown input-policy browser: ${engineName}`);
const output=process.env.EDITAC_INPUT_POLICY_OUTPUT??await mkdtemp(join(tmpdir(),'editac-input-policy-evidence-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[],packed:{},browser:{},server:{},cleanup:{}};
let consumer,server,browser,controller;
async function run(command,args,log){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});await writeFile(join(output,log),`${r.stdout??''}\n${r.stderr??''}`);assert.equal(r.error,undefined,log);assert.equal(r.status,0,log);return r.stdout;}
const sourcePaths=['packages/web/src/input/protocol.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input-policy/session.mjs','fixtures/browser-input-policy/index.html','tests/browser/input-policy.spec.ts','scripts/test-browser.mjs','packages/core/src/engine.ts','packages/core/dist/index.js','packages/core/dist/engine.js','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/web/dist/input/protocol.js','packages/web/dist/dom/render.js','packages/web/dist/dom/selection.js','packages/web/dist/entry.js','packages/web/dist/storage/index.js','packages/web/dist/storage/journal.js','packages/web/dist/storage/writer.js','package-lock.json'];
async function hashSources(){return Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
before(async()=>{
 facts.sources=await hashSources();
 facts.coreBaseRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 consumer=await mkdtemp(join(tmpdir(),'editac-input-policy-consumer-'));
 const packed=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/core','--json','--pack-destination',consumer],'pack.log'))[0];
 const bytes=await readFile(join(consumer,packed.filename));await writeFile(join(output,packed.filename),bytes);
 facts.packed={filename:packed.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),includesWasm:packed.files.some(f=>f.path==='dist/wasm/editac_wasm_bg.wasm')};assert.equal(facts.packed.includesWasm,true);
 await run('tar',['-xzf',join(consumer,packed.filename),'-C',consumer],'unpack.log');
 server=await startFixtureServer({fixtureDirectory:'fixtures/browser-input-policy',coreDirectory:join(consumer,'package/dist')});
 facts.server={port:server.port,url:server.url,pid:process.pid,launcher:'node --test tests/browser/input-policy.spec.ts',workspace:process.cwd(),purpose:'WEB-1.13 real packed protocol probe',log:output};
 controller=await browserType.launchServer({headless:true});const child=controller.process();
 facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'WEB-1.13 pinned '+engineName,log:output});
 browser=await browserType.connect(controller.wsEndpoint());facts.browser={engine:engineName,version:browser.version(),playwright:'1.64.0',node:process.version,platform:process.platform,arch:process.arch};
});
after(async()=>{
 try{await browser?.close();}finally{try{if(controller){await controller.close();facts.cleanup.browserExited=controller.process().exitCode!==null||controller.process().signalCode!==null;assert.equal(facts.cleanup.browserExited,true);}}finally{try{if(server){await server.close();facts.cleanup.listenerRemoved=await new Promise(resolve=>{const socket=createConnection(server.port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve(e.code==='ECONNREFUSED'));});assert.equal(facts.cleanup.listenerRemoved,true);}}finally{if(consumer)await rm(consumer,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;facts.sourcesUnchanged=JSON.stringify(facts.sources)===JSON.stringify(await hashSources());await writeFile(join(output,'facts.json'),JSON.stringify(facts,null,2));assert.equal(facts.sourcesUnchanged,true,'Probe source/artifacts changed during execution');}}}
});
async function probe(name,action){
 const context=await browser.newContext(),fact={name,passed:false,provenance:name==='native-typing-delete'?'actual Playwright browser keyboard':'prepared real-DOM event replay',snapshots:[]};facts.cases.push(fact);
 const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>{fact.pageErrors??=[];fact.pageErrors.push(error.message);});
 try{await page.goto(server.url);await page.waitForFunction(()=>!!window.policyFixture);await page.evaluate(()=>window.policyFixture.mount());await action(page,fact);fact.traceProvenance={nativeTrustedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>t.trusted).map(t=>t.type)))],preparedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>!t.trusted&&!t.type.endsWith('mutations')&&t.type!=='renderer-echo').map(t=>t.type)))],composition:'prepared event replay; no OS IME'};assert.deepEqual(fact.pageErrors??[],[]);fact.passed=true;}
 catch(error){fact.failure={message:error.message,stack:error.stack};await writeFile(join(output,`${name}-failure.json`),JSON.stringify(fact,null,2));throw error;}
 finally{try{await page.evaluate(()=>window.policyFixture?.destroy());}finally{await context.close();}}
}
async function observe(page,fact){const state=await page.evaluate(()=>window.policyFixture.state());fact.snapshots.push(state);assert.deepEqual(state.errors,[]);assert.equal(state.storage,'localCommitted');return state;}
function effects(state,count){const commits=state.patches.filter(p=>p.origin.startsWith('editac:local:input-policy:')&&p.update);const journal=state.journal.filter(p=>p.origin.startsWith('editac:local:input-policy:'));assert.equal(commits.length,count);assert.equal(journal.length,count);assert.equal(state.history.undoGroups,count);assert.equal(new Set(commits.map(p=>p.origin)).size,count);assert.equal(state.intents.filter(i=>i.disposition==='committed').length,count);for(const p of commits)assert.ok(p.bytes>0);}
function content(state,text,caret=text.length){assert.equal(state.text[0],text);assert.equal(state.dom[0],text);assert.equal(state.caret?.offset,caret);assert.equal(state.caret?.node,state.ids[0]);}

test('native-typing-delete: physical keyboard edits correlate real beforeinput/input/observer traces',()=>probe('native-typing-delete',async(page,fact)=>{
 await page.keyboard.type('xx');await page.keyboard.press('Backspace');const state=await observe(page,fact);content(state,'alphax');effects(state,3);
 assert.ok(state.trace.some(t=>t.type==='keydown'&&t.trusted));assert.ok(state.trace.some(t=>t.type==='beforeinput'&&t.trusted));
 assert.ok(state.trace.some(t=>t.type==='input'&&t.trusted)||state.trace.some(t=>t.type==='renderer-echo'));
}));
for(const order of ['input-first','observer-first','missing-input'])test(`missing-beforeinput ${order}: duplicates preserve a deliberate identical second edit`,()=>probe('missing-'+order,async(page,fact)=>{
 await page.evaluate(async order=>{const f=window.policyFixture;f.mutate('alphaX');if(order==='observer-first')await f.settle();if(order!=='missing-input'){const e=f.event('input',{inputType:'insertText',data:'X'});f.root.dispatchEvent(e);f.event('input',{inputType:'insertText',data:'X'});}await f.settle();f.mutate('alphaXX');f.event('input',{inputType:'insertText',data:'X'});await f.settle();f.event('input',{inputType:'insertText',data:'X'});},order);
 const state=await observe(page,fact);content(state,'alphaXX');effects(state,2);assert.equal(new Set(state.intents.map(i=>i.id)).size,state.intents.length);
}));
test('noncancelable beforeinput remains native-pending until the actual DOM mutation',()=>probe('noncancelable',async(page,fact)=>{
 const pending=await page.evaluate(()=>{const f=window.policyFixture;f.event('beforeinput',{inputType:'insertReplacementText',data:'!',cancelable:false});return f.protocol.intents;});assert.equal(pending[0].disposition,'native-pending');
 await page.evaluate(()=>{const f=window.policyFixture;f.mutate('alpha!');f.event('input',{inputType:'insertReplacementText',data:'!'});});const state=await observe(page,fact);content(state,'alpha!');effects(state,1);
}));
test('cancelable event identity prevents duplicate command replay while an identical new intent commits',()=>probe('cancelable-duplicates',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;const e=f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true});f.root.dispatchEvent(e);f.event('input',{inputType:'insertText',data:'X'});f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true});});const state=await observe(page,fact);content(state,'alphaXX');effects(state,2);
}));
test('identified renderer echo and independent native mutation in the same turn retain only the real input',()=>probe('renderer-echo',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.policyFixture;await f.remote(0,'!',f.ids[1]);f.mutate('alphaX');f.event('input',{inputType:'insertText',data:'X'});});const state=await observe(page,fact);content(state,'alphaX');effects(state,1);assert.equal(state.text[1],'!independent');assert.ok(state.trace.some(t=>t.type==='renderer-echo'&&t.count>0));
}));
test('native mutation queued before a renderer patch is retained rather than mislabeled as an echo',()=>probe('native-before-render',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.policyFixture;f.mutate('alphaX');await f.remote(0,'!',f.ids[1]);});const state=await observe(page,fact);content(state,'alphaX');effects(state,1);assert.equal(state.text[1],'!independent');
}));
test('composition buffers all intermediate updates and commits one UTF-16 replacement per independent session',()=>probe('composition-sessions',async(page,fact)=>{
 const intermediate=await page.evaluate(async()=>{const f=window.policyFixture;f.select(f.ids[0],1,4);f.event('compositionstart');f.mutate('aにa');f.event('compositionupdate',{data:'に'});f.event('beforeinput',{inputType:'insertCompositionText',data:'に',isComposing:true});f.event('input',{inputType:'insertCompositionText',data:'に',isComposing:true});await f.settle();return {text:f.engine.read().visible[0].runs.map(r=>r.text).join(''),dom:f.renderer.getBlock(f.ids[0]).textContent,history:f.engine.history({type:'state'}),intents:f.protocol.intents};});assert.equal(intermediate.text,'alpha');assert.equal(intermediate.dom,'aにa');assert.equal(intermediate.history.undoGroups,0);assert.equal(intermediate.intents[0].disposition,'native-pending');fact.intermediate=intermediate;
 await page.evaluate(async()=>{const f=window.policyFixture;f.mutate('a日本😀a');f.event('compositionend',{data:'日本😀'});await f.settle();f.select(f.ids[0],5);f.event('compositionstart');f.mutate('a日本😀日本😀a');f.event('compositionend',{data:'日本😀'});});
 const state=await observe(page,fact);content(state,'a日本😀日本😀a',9);effects(state,2);assert.equal(state.intents.filter(i=>i.origin==='composition').length,2);
}));
for(const mode of ['cancel','blur','readonly','dispose'])test(`composition ${mode} has one explicit terminal result and zero intermediate commits`,()=>probe('composition-'+mode,async(page,fact)=>{
 await page.evaluate(mode=>{const f=window.policyFixture;f.select(f.ids[0],5);f.event('compositionstart');f.mutate('alpha語');f.event('compositionupdate',{data:'語'});if(mode==='cancel')f.event('compositionend',{data:''});else if(mode==='blur')f.event('blur');else if(mode==='readonly')f.protocol.setReadOnly(true);else f.protocol.dispose();f.event('compositionend',{data:'語'});},mode);
 const state=await observe(page,fact);assert.equal(state.text[0],mode==='blur'?'alpha語':'alpha');assert.equal(state.dom[0],state.text[0]);assert.equal(state.caret?.offset,mode==='blur'?6:5);assert.equal(state.caret?.node,state.ids[0]);effects(state,mode==='blur'?1:0);assert.equal(state.intents[0].disposition,mode==='blur'?'committed':mode==='dispose'?'disposed':'canceled');
}));
for(const where of ['before','after','independent'])test(`remote ${where} preserves the browser-owned subtree and resolves the captured composition anchor`,()=>probe('composition-remote-'+where,async(page,fact)=>{
 const mid=await page.evaluate(async where=>{const f=window.policyFixture;f.select(f.ids[0],2);f.event('compositionstart');f.mutate('al語pha');await f.remote(where==='before'?0:where==='after'?5:0,'!',where==='independent'?f.ids[1]:f.ids[0]);return {dom:f.renderer.getBlock(f.ids[0]).textContent,other:f.renderer.getBlock(f.ids[1]).textContent};},where);assert.equal(mid.dom,'al語pha');if(where==='independent')assert.equal(mid.other,'!independent');fact.intermediate=mid;
 await page.evaluate(()=>window.policyFixture.event('compositionend',{data:'語'}));const state=await observe(page,fact);content(state,where==='before'?'!al語pha':where==='after'?'al語pha!':'al語pha',where==='before'?4:3);effects(state,1);assert.equal(state.patches.filter(p=>p.operation==='Remote'&&p.update).length,1);assert.equal(state.journal.length,2);
}));
test('remote overlap rejects finalization with captured recovery text instead of deleting peer content',()=>probe('composition-remote-overlap',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.policyFixture;f.select(f.ids[0],1,4);f.event('compositionstart');f.mutate('a語a');await f.remote(2,'!');f.event('compositionend',{data:'語'});});const state=await observe(page,fact);assert.equal(state.text[0],'al!pha');assert.equal(state.dom[0],'al!pha');effects(state,0);assert.equal(state.caret,null);assert.equal(state.intents[0].reason,'remote-overlap');assert.equal(state.intents[0].text,'語');
}));
test('remote deletion of the composition owner reports stale-target without redirecting to another block',()=>probe('composition-deleted-target',async(page,fact)=>{
 const initial=await page.evaluate(()=>{const f=window.policyFixture;f.select(f.ids[0],2);f.event('compositionstart');f.mutate('al語pha');return {bytes:[...f.engine.encodeUpdate().bytes],vector:[...f.engine.stateVector()],id:f.ids[0]};});
 const peer=new Y.Doc();peer.clientID=1901;let update;try{Y.applyUpdate(peer,new Uint8Array(initial.bytes));peer.getMap('delete-probe-tombstones').set(initial.id,true);update=[...Y.encodeStateAsUpdate(peer,new Uint8Array(initial.vector))];}finally{peer.destroy();}
 await page.evaluate(async bytes=>{const f=window.policyFixture;await f.apply(bytes);f.event('compositionend',{data:'語'});},update);const state=await observe(page,fact);assert.deepEqual(state.text,['independent']);effects(state,0);assert.equal(state.intents[0].reason,'stale-target');assert.equal(state.intents[0].text,'語');assert.equal(state.boundDom[0],null);assert.equal(state.caret,null);
}));
test('compositionend before commit Enter does not split; keyup releases the next deliberate Enter',()=>probe('composition-commit-key',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.event('compositionstart');f.mutate('alpha語');f.event('compositionend',{data:'語'});f.event('keydown',{key:'Enter',isComposing:false});f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});f.event('keyup',{key:'Enter'});});const first=await observe(page,fact);content(first,'alpha語');effects(first,1);assert.equal(first.text.length,2);
 await page.keyboard.press('Enter');const final=await observe(page,fact);assert.deepEqual(final.text,['alpha語','','independent']);assert.deepEqual(final.dom,['alpha語','','independent']);assert.equal(final.caret?.node,final.blocks[1]);assert.equal(final.caret?.offset,0);effects(final,2);assert.ok(final.trace.some(t=>t.type==='keydown'&&t.trusted));
}));
test('read-only ordinary input is rejected and disposed queued generations cannot commit',()=>probe('read-only-disposed',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.protocol.setReadOnly(true);f.event('beforeinput',{inputType:'insertText',data:'X',cancelable:true});f.protocol.setReadOnly(false);f.mutate('alphaX');f.event('input',{inputType:'insertText',data:'X'});f.protocol.dispose();f.protocol.dispose();});const state=await observe(page,fact);content(state,'alpha');effects(state,0);assert.equal(state.intents[0].reason,'read-only');assert.ok(state.intents.some(i=>i.disposition==='disposed'));
}));

test('native wrapper replacement reprojects only the affected block and keeps unrelated node identity',()=>probe('native-wrapper-replacement',async(page,fact)=>{
 const stable=await page.evaluate(async()=>{const f=window.policyFixture,other=f.renderer.getBlock(f.ids[1]);f.renderer.getBlock(f.ids[0]).replaceChildren(document.createTextNode('alphaX'));f.event('input',{inputType:'insertText',data:'X'});await f.settle();return other===f.renderer.getBlock(f.ids[1]);});assert.equal(stable,true);const state=await observe(page,fact);content(state,'alphaX');effects(state,1);
}));
test('read-only noncancelable mutation restores authoritative content with an explicit rejection',()=>probe('read-only-native-mutation',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.protocol.setReadOnly(true);f.event('beforeinput',{inputType:'insertReplacementText',data:'X',cancelable:false});f.mutate('alphaX');f.event('input',{inputType:'insertReplacementText',data:'X'});});const state=await observe(page,fact);content(state,'alpha');effects(state,0);assert.ok(state.intents.every(i=>i.disposition==='rejected'));
}));
test('composition keydown before finalization and duplicate final input notifications commit once',()=>probe('composition-keydown-first',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.event('compositionstart');f.mutate('alpha語');f.event('keydown',{key:'Enter',isComposing:true});f.event('input',{inputType:'insertCompositionText',data:'語',isComposing:false});f.event('compositionend',{data:'語'});f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});f.event('input',{inputType:'insertText',data:'語'});f.event('compositionend',{data:'語'});f.event('keyup',{key:'Enter'});});const state=await observe(page,fact);content(state,'alpha語');effects(state,1);assert.equal(state.intents.length,1);
}));
test('commit-key suppression expires at a dispatcher boundary when no keyup arrives',()=>probe('composition-key-turn-expiry',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.event('compositionstart');f.mutate('alpha語');f.event('compositionend',{data:'語'});});
 await page.evaluate(()=>new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();resolve();};c.port2.postMessage(null);}));
 await page.keyboard.press('Enter');const state=await observe(page,fact);assert.deepEqual(state.text,['alpha語','','independent']);assert.deepEqual(state.dom,['alpha語','','independent']);assert.equal(state.caret?.node,state.blocks[1]);assert.equal(state.caret?.offset,0);effects(state,2);
}));

test('composition adopts its preceding physical key intent instead of leaving an extra pending edit',()=>probe('composition-preceding-key',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.event('keydown',{key:'Process'});f.event('beforeinput',{inputType:'insertCompositionText',data:'に',cancelable:false,isComposing:true});f.event('compositionstart');f.mutate('alpha日本');f.event('compositionend',{data:'日本'});f.event('input',{inputType:'insertText',data:'日本'});f.event('keyup',{key:'Process'});});const state=await observe(page,fact);content(state,'alpha日本');effects(state,1);assert.equal(state.intents.length,1);const correlated=state.trace.filter(t=>['keydown','beforeinput','compositionstart','compositionend','input','keyup'].includes(t.type));assert.ok(correlated.every(t=>t.intent===state.intents[0].id));
}));
test('composition preserves a backward replacement range and restores the resulting caret',()=>probe('composition-backward-selection',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.policyFixture;f.select(f.ids[0],4,1);f.event('compositionstart');f.mutate('a語a');f.event('compositionend',{data:'語'});});const state=await observe(page,fact);content(state,'a語a',2);effects(state,1);
}));
test('composition remote insertion at the collapsed anchor precedes the final local text under right affinity',()=>probe('composition-remote-at-anchor',async(page,fact)=>{
 await page.evaluate(async()=>{const f=window.policyFixture;f.select(f.ids[0],2);f.event('compositionstart');f.mutate('al語pha');await f.remote(2,'!');f.event('compositionend',{data:'語'});});const state=await observe(page,fact);content(state,'al!語pha',4);effects(state,1);assert.equal(state.journal.length,2);
}));
