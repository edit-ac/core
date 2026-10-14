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
const engineName=process.env.EDITAC_COMPOSITION_BROWSER??'chromium';
const browserType={chromium,firefox,webkit}[engineName];
if(!browserType)throw Error(`Unknown input browser: ${engineName}`);
const output=process.env.EDITAC_COMPOSITION_OUTPUT??await mkdtemp(join(tmpdir(),'editac-composition-evidence-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[],packed:{},browser:{},server:{},cleanup:{}};
let consumer,server,browser,controller;
async function run(command,args,log){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});await writeFile(join(output,log),`${r.stdout??''}\n${r.stderr??''}`);assert.equal(r.error,undefined,log);assert.equal(r.status,0,log);return r.stdout;}
const sourcePaths=['packages/web/src/input/keyboard.ts','packages/web/dist/input/keyboard.js','packages/web/src/input/composition.ts','packages/web/dist/input/composition.js','packages/web/src/input/reconcile.ts','packages/web/dist/input/reconcile.js','packages/web/src/input/text.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input/session.mjs','fixtures/browser-input/index.html','tests/browser/composition.spec.ts','scripts/test-browser.mjs','packages/core/src/engine.ts','packages/core/dist/index.js','packages/core/dist/engine.js','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/web/dist/input/text.js','packages/web/dist/dom/render.js','packages/web/dist/dom/selection.js','packages/web/dist/entry.js','packages/web/dist/storage/index.js','packages/web/dist/storage/journal.js','packages/web/dist/storage/writer.js','package-lock.json'];
async function hashSources(){return Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
before(async()=>{
 facts.sources=await hashSources();
 facts.coreBaseRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 consumer=await mkdtemp(join(tmpdir(),'editac-composition-consumer-'));
 const packed=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/core','--json','--pack-destination',consumer],'pack.log'))[0];
 const bytes=await readFile(join(consumer,packed.filename));await writeFile(join(output,packed.filename),bytes);
 facts.packed={filename:packed.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),includesWasm:packed.files.some(f=>f.path==='dist/wasm/editac_wasm_bg.wasm')};assert.equal(facts.packed.includesWasm,true);
 await run('tar',['-xzf',join(consumer,packed.filename),'-C',consumer],'unpack.log');
 server=await startFixtureServer({fixtureDirectory:'fixtures/browser-input',coreDirectory:join(consumer,'package/dist')});
 facts.server={port:server.port,url:server.url,pid:process.pid,launcher:'node --test tests/browser/composition.spec.ts',workspace:process.cwd(),purpose:'WEB-1.6 real packed protocol probe',log:output};
 controller=await browserType.launchServer({headless:true});const child=controller.process();
 facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'WEB-1.6 pinned '+engineName,log:output});
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
function effects(state,count,keyboard=0){
 const local=p=>p.origin.startsWith('editac:local:text-input:')||p.origin.startsWith('editac:local:keyboard:');
 const commits=state.patches.filter(p=>local(p)&&p.update),journal=state.journal.filter(local);
 assert.equal(commits.length,count);assert.equal(journal.length,count);
 // Selected deletions now belong to the structural keyboard bridge. Keep
 // exact owner counts, rather than dropping their update/journal assertions.
 for(const family of ['text-input','keyboard']){
  const expected=family==='keyboard'?keyboard:count-keyboard,prefix=`editac:local:${family}:`;
  assert.equal(commits.filter(p=>p.origin.startsWith(prefix)).length,expected);
  assert.equal(journal.filter(p=>p.origin.startsWith(prefix)).length,expected);
 }
 assert.equal(state.history.undoGroups,count);assert.equal(new Set(commits.map(p=>p.origin)).size,count);assert.equal(state.intents.filter(i=>i.disposition==='committed').length,count);for(const p of commits)assert.ok(p.bytes>0);
}
function content(state,text,caret=text.length){assert.equal(state.text[0],text);assert.equal(state.dom[0],text);assert.deepEqual(state.dom,state.text);assert.equal(state.caret?.offset,caret);assert.equal(state.caret?.node,state.ids[0]);}
function deliberateEnter(state){
 assert.deepEqual(state.text,['alpha字','','independent']);assert.deepEqual(state.dom,state.text);
 assert.equal(state.caret?.offset,0);assert.ok(state.caret?.node);assert.ok(!state.ids.includes(state.caret.node));
 effects(state,2,1);
}



async function start(page,start=5,end=start){
 return page.evaluate(({start,end})=>{const f=window.inputFixture;f.select(f.ids[0],start,end);
  window.composingBlock=f.renderer.getBlock(f.ids[0]);window.composingText=document.createTreeWalker(window.composingBlock,NodeFilter.SHOW_TEXT).nextNode();
  f.event('compositionstart');return f.protocol.intents.at(-1);},{start,end});
}
async function intermediate(page,fact,text,data=text){
 await page.evaluate(({text,data})=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertCompositionText',data,isComposing:true});f.mutate(text);f.event('compositionupdate',{data});f.event('input',{inputType:'insertCompositionText',data,isComposing:true});},{text,data});
 const state=await observe(page,fact);effects(state,0);assert.equal(state.text[0],'alpha');assert.equal(state.dom[0],text);
 assert.equal(await page.evaluate(()=>{const f=window.inputFixture;return window.composingBlock===f.renderer.getBlock(f.ids[0])&&window.composingText===document.createTreeWalker(window.composingBlock,NodeFilter.SHOW_TEXT).nextNode();}),true);
 assert.equal(state.selectionSuspended,true);assert.deepEqual(state.nativeCaret,{anchor:text.length,focus:text.length});assert.equal(state.caret,null);assert.ok(state.trace.some(t=>t.type==='composition-mutations'&&t.count>0));
 assert.equal(state.intents.filter(i=>i.origin==='composition').length,1);assert.equal(state.intents.at(-1).disposition,'native-pending');
}
async function end(page,data,order='after'){
 await page.evaluate(({data,order})=>{const f=window.inputFixture;
  if(order==='before'){const e=f.event('input',{inputType:'insertCompositionText',data,isComposing:false});if(e.inputType!=='insertCompositionText')throw Error('Composition fixture inputType normalized');}
  f.event('compositionend',{data});
  if(order==='after'){const e=f.event('input',{inputType:'insertCompositionText',data,isComposing:false});if(e.inputType!=='insertCompositionText')throw Error('Composition fixture inputType normalized');}
 },{data,order});
}
for(const [label,steps] of [['japanese',['に','日本']],['korean',['ㅎ','한']],['chinese',['中','中文']],['accent',['e','é']],['emoji',['👩','👩🏽‍💻']],['multiline',['a','a\nb']]]) {
 test(`multi-event-${label}: buffered native ownership then one edit`,()=>probe(`multi-event-${label}`,async(page,fact)=>{
  await start(page);for(const text of steps)await intermediate(page,fact,'alpha'+text,text);
  await end(page,steps.at(-1));const state=await observe(page,fact);content(state,'alpha'+steps.at(-1));effects(state,1);
  assert.equal(state.intents.at(-1).origin,'composition');assert.equal(state.intents.at(-1).text,steps.at(-1));
 }));
}
test('split-text-node: native siblings are removed at the canonical finalization boundary',()=>probe('split-text-node',async(page,fact)=>{
 await start(page,1,4);
 await page.evaluate(()=>{const f=window.inputFixture;
  const range=document.getSelection().getRangeAt(0);range.deleteContents();
  const text=document.createTextNode('文');range.insertNode(text);
  document.getSelection().setBaseAndExtent(text,1,text,1);
  f.event('input',{inputType:'insertCompositionText',data:'文',isComposing:true});
 });
 const provisional=await observe(page,fact);effects(provisional,0);assert.equal(provisional.dom[0],'a文a');
 await end(page,'文');const state=await observe(page,fact);content(state,'a文a',2);effects(state,1);
}));
for(const order of ['before','after','missing'])test(`final-input-${order}: duplicate final notifications have one owner`,()=>probe('final-input-'+order,async(page,fact)=>{
 await start(page);await intermediate(page,fact,'alpha文','文');await end(page,'文',order);
 await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionend',{data:'文'});f.event('beforeinput',{inputType:'insertCompositionText',data:'文',cancelable:true});f.event('input',{inputType:'insertCompositionText',data:'文'});f.event('input',{inputType:'insertCompositionText',data:'文'});});
 const state=await observe(page,fact);content(state,'alpha文');effects(state,1);
}));
for(const backward of [false,true])test(`replacement-${backward?'backward':'forward'}: retained UTF-16 target and caret`,()=>probe('replacement-'+backward,async(page,fact)=>{
 await start(page,backward?4:1,backward?1:4);await intermediate(page,fact,'a😊a','😊');await end(page,'😊');
 const state=await observe(page,fact);content(state,'a😊a',3);effects(state,1);
}));
test('empty-block: placeholder contributes no composition text',()=>probe('empty-block',async(page,fact)=>{
 await start(page,0);
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('字');f.event('input',{inputType:'insertCompositionText',data:'字',isComposing:true});});
 let state=await observe(page,fact);effects(state,0);assert.equal(state.text[0],'');assert.equal(state.dom[0],'字');
 await end(page,'字');state=await observe(page,fact);content(state,'字',1);effects(state,1);
},''));
for(const mode of ['empty-end','unchanged','readonly','dispose'])test(`cancel-${mode}: zero intermediate or canceled commits`,()=>probe('cancel-'+mode,async(page,fact)=>{
 await start(page,1,4);
 if(mode!=='unchanged')await intermediate(page,fact,'a文a','文');
 await page.evaluate(mode=>{const f=window.inputFixture;
  if(mode==='readonly')f.protocol.setReadOnly(true);else if(mode==='dispose')f.protocol.dispose();else f.event('compositionend',{data:mode==='empty-end'?'':'lph'});
  f.event('compositionend',{data:'文'});f.event('beforeinput',{inputType:'insertCompositionText',data:'文',cancelable:true});f.event('input',{inputType:'insertCompositionText',data:'文'});
 },mode);
 const state=await observe(page,fact);effects(state,0);assert.equal(state.text[0],'alpha');assert.equal(state.dom[0],'alpha');
 assert.equal(state.intents.length,1);assert.equal(state.intents.at(-1).disposition,mode==='dispose'?'disposed':'canceled');
 if(mode==='readonly'||mode==='dispose')assert.equal(state.editable,'false');
}));
for(const blur of ['before-end','after-end'])test(`blur-${blur}: committed input survives late notifications`,()=>probe('blur-'+blur,async(page,fact)=>{
 await start(page);await intermediate(page,fact,'alpha文','文');
 await page.evaluate(blur=>{const f=window.inputFixture;if(blur==='after-end')f.event('compositionend',{data:'文'});f.event('blur');f.event('compositionend',{data:'文'});f.event('beforeinput',{inputType:'insertCompositionText',data:'文',cancelable:true});f.event('input',{inputType:'insertCompositionText',data:'文'});},blur);
 const state=await observe(page,fact);content(state,'alpha文');effects(state,1);
}));
test('identical-independent-sessions: duplicates do not swallow deliberate repeat',()=>probe('identical-independent-sessions',async(page,fact)=>{
 for(let i=0;i<2;i++){
  await start(page,5+i);await page.evaluate(i=>{const f=window.inputFixture;f.mutate('alpha'+'文'.repeat(i+1));f.event('input',{inputType:'insertCompositionText',data:'文',isComposing:true});f.event('compositionend',{data:'文'});f.event('compositionend',{data:'文'});f.event('beforeinput',{inputType:'insertCompositionText',data:'文',cancelable:true});f.event('input',{inputType:'insertCompositionText',data:'文'});},i);
  const state=await observe(page,fact);content(state,'alpha'+'文'.repeat(i+1));effects(state,i+1);
 }
 const state=fact.snapshots.at(-1);assert.equal(new Set(state.intents.filter(i=>i.origin==='composition').map(i=>i.id)).size,2);
}));
for(const order of ['key-before-end','end-before-key'])test(`commit-Enter-${order}: one composition owner until keyup`,()=>probe('commit-Enter-'+order,async(page,fact)=>{
 await start(page);await intermediate(page,fact,'alpha字','字');
 const prevented=await page.evaluate(order=>{const f=window.inputFixture;let key;
  if(order==='key-before-end')key=f.event('keydown',{key:'Enter',isComposing:true});
  f.event('compositionend',{data:'字'});
  if(order==='end-before-key')key=f.event('keydown',{key:'Enter',isComposing:false});
  const before=f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});f.event('keyup',{key:'Enter'});
  const deliberate=f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});
  return {key:key.defaultPrevented,before:before.defaultPrevented,deliberate:deliberate.defaultPrevented};
 },order);
 assert.deepEqual(prevented,{key:true,before:true,deliberate:true});
 const state=await observe(page,fact);deliberateEnter(state);
}));
test('commit-key-dispatch-expiry: next deliberate Enter is independent',()=>probe('commit-key-dispatch-expiry',async(page,fact)=>{
 await start(page);await intermediate(page,fact,'alpha字','字');await end(page,'字');
 await page.evaluate(()=>new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();resolve();};c.port2.postMessage(null);}));
 assert.equal(await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertParagraph',cancelable:true}).defaultPrevented),true);
 const state=await observe(page,fact);deliberateEnter(state);
}));
test('history-group: composition is one undo step between ordinary edits',()=>probe('history-group',async(page,fact)=>{
 await page.keyboard.press('x');await start(page,6);
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alphax字');f.event('input',{inputType:'insertCompositionText',data:'字',isComposing:true});f.event('compositionend',{data:'字'});});
 await page.keyboard.press('y');let state=await observe(page,fact);content(state,'alphax字y');effects(state,3);
 for(const text of ['alphax字','alphax','alpha']){
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));state=await observe(page,fact);assert.equal(state.text[0],text);assert.equal(state.dom[0],text);
 }
}));
test('unsupported-shape: recovery retains native text without partial commit',()=>probe('unsupported-shape',async(page,fact)=>{
 await start(page,1,4);await page.evaluate(()=>{const f=window.inputFixture;f.mutate('outside captured prefix');f.event('compositionend',{data:'文'});});
 const state=await observe(page,fact);effects(state,0);assert.equal(state.text[0],'alpha');assert.equal(state.dom[0],'alpha');assert.equal(state.intents.at(-1).reason,'unsupported-composition-shape');assert.equal(state.recovery.at(-1).text,'outside captured prefix');assert.equal(state.caret,null);
}));
for(const preceding of ['beforeinput','Process','Dead'])test(`adopt-${preceding}: preceding native owner becomes the composition`,()=>probe('adopt-'+preceding,async(page,fact)=>{
 const owners=await page.evaluate(preceding=>{const f=window.inputFixture;
  if(preceding==='beforeinput')f.event('beforeinput',{inputType:'insertCompositionText',data:'字',cancelable:false,isComposing:true});else f.event('keydown',{key:preceding});
  const prior=f.protocol.intents.at(-1)?.id;f.event('compositionstart');return {prior,active:f.protocol.intents.at(-1)?.id,count:f.protocol.intents.length};
 },preceding);
 assert.ok(owners.prior);assert.equal(owners.prior,owners.active);assert.equal(owners.count,1);
 await page.evaluate(()=>{const f=window.inputFixture;f.mutate('alpha字');f.event('input',{inputType:'insertCompositionText',data:'字',isComposing:true});f.event('compositionend',{data:'字'});f.event('keyup',{key:'Process'});});
 const state=await observe(page,fact);content(state,'alpha字');effects(state,1);
}));
for(const ending of ['end','keyup','blur'])test(`adopted-key-${ending}-then-ordinary: later non-keyboard input is independent`,()=>probe('adopted-key-'+ending+'-then-ordinary',async(page,fact)=>{
 await page.evaluate(ending=>{const f=window.inputFixture;
  f.event('keydown',{key:'Process'});f.event('compositionstart');f.mutate('alpha字');
  f.event('input',{inputType:'insertCompositionText',data:'字',isComposing:true});
  if(ending==='blur')f.event('blur');else f.event('compositionend',{data:'字'});
  if(ending==='keyup')f.event('keyup',{key:'Process'});
  // Duplicate final notifications retain their owner, but an independent
  // ordinary beforeinput has no physical key and must allocate a new intent.
  f.event('compositionend',{data:'字'});f.event('input',{inputType:'insertCompositionText',data:'字'});
  f.event('beforeinput',{inputType:'insertText',data:'字',cancelable:true});
  f.event('input',{inputType:'insertText',data:'字'});
 },ending);
 const state=await observe(page,fact);content(state,'alpha字字');effects(state,2);
 assert.equal(state.intents.filter(i=>i.disposition==='committed').length,2);
 assert.deepEqual(state.intents.filter(i=>i.disposition==='committed').map(i=>i.origin),['composition','beforeinput']);
}));
test('adopted-key-readonly-resume: canceled owner cannot swallow later ordinary input',()=>probe('adopted-key-readonly-resume',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;
  f.event('keydown',{key:'Dead'});f.event('compositionstart');f.mutate('alphaé');
  f.event('input',{inputType:'insertCompositionText',data:'é',isComposing:true});
  f.protocol.setReadOnly(true);f.protocol.setReadOnly(false);
  f.event('compositionend',{data:'é'});f.event('input',{inputType:'insertCompositionText',data:'é'});
  f.event('beforeinput',{inputType:'insertText',data:'é',cancelable:true});f.event('input',{inputType:'insertText',data:'é'});
 });
 const state=await observe(page,fact);content(state,'alphaé');effects(state,1);
 assert.deepEqual(state.intents.map(i=>({origin:i.origin,disposition:i.disposition})),[
  {origin:'composition',disposition:'canceled'},{origin:'beforeinput',disposition:'committed'}]);
}));
test('observer-only-composition: native mutation remains buffered without input',()=>probe('observer-only-composition',async(page,fact)=>{
 await start(page);await page.evaluate(()=>window.inputFixture.mutate('alpha字'));
 let state=await observe(page,fact);effects(state,0);assert.equal(state.dom[0],'alpha字');assert.equal(state.selectionSuspended,true);
 await end(page,'字','missing');state=await observe(page,fact);content(state,'alpha字');effects(state,1);
}));
test('keyup-before-end: completed commit cycle does not suppress a later Enter',()=>probe('keyup-before-end',async(page,fact)=>{
 await start(page);await intermediate(page,fact,'alpha字','字');
 await page.evaluate(()=>{const f=window.inputFixture;f.event('keydown',{key:'Enter',isComposing:true});f.event('keyup',{key:'Enter'});f.event('compositionend',{data:'字'});});
 await page.evaluate(()=>new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();resolve();};c.port2.postMessage(null);}));
 assert.equal(await page.evaluate(()=>window.inputFixture.event('keydown',{key:'Enter'}).defaultPrevented),true);
 const state=await observe(page,fact);deliberateEnter(state);
}));
for(const mode of ['readonly','blur'])test(`after-final-${mode}: transition preserves the admitted edit`,()=>probe('after-final-'+mode,async(page,fact)=>{
 await start(page);await intermediate(page,fact,'alpha字','字');await end(page,'字');
 await page.evaluate(mode=>{const f=window.inputFixture;if(mode==='readonly')f.protocol.setReadOnly(true);else f.event('blur');f.event('compositionend',{data:'字'});f.event('input',{inputType:'insertCompositionText',data:'字'});},mode);
 const state=await observe(page,fact);content(state,'alpha字');effects(state,1);
}));
for(const variant of ['markup','limit'])test(`unsupported-${variant}: bounded recovery and no edit`,()=>probe('unsupported-'+variant,async(page,fact)=>{
 await start(page);await page.evaluate(variant=>{const f=window.inputFixture,block=f.renderer.getBlock(f.ids[0]);
  if(variant==='markup'){const element=document.createElement('img');element.alt='untrusted';block.append(element);}else f.mutate('alpha'+'a'.repeat(256*1024));
  f.event('compositionend',{data:'字'});
 },variant);
 const state=await observe(page,fact);effects(state,0);assert.equal(state.text[0],'alpha');assert.equal(state.dom[0],'alpha');
 assert.equal(state.recovery.at(-1).reason,variant==='markup'?'unsupported-composition-structure':'native-limit');assert.equal(state.caret,null);
 if(variant==='limit'){assert.equal(state.recovery.at(-1).truncated,true);assert.equal(state.recovery.at(-1).text.length,256*1024);}
}));
test('rejected-outside-selection: unrelated page selection survives cleanup',()=>probe('rejected-outside-selection',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture,n=document.querySelector('#status').firstChild;document.getSelection().setBaseAndExtent(n,0,n,4);f.event('compositionstart');f.event('compositionend',{data:'字'});});
 const state=await observe(page,fact);effects(state,0);assert.equal(state.intents.at(-1).reason,'unmapped-selection');
 assert.equal(await page.evaluate(()=>document.getSelection().toString()),'Real');
}));
