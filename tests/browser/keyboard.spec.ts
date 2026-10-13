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
const engineName=process.env.EDITAC_KEYBOARD_BROWSER??'chromium';
const browserType={chromium,firefox,webkit}[engineName];
if(!browserType)throw Error(`Unknown input browser: ${engineName}`);
const output=process.env.EDITAC_KEYBOARD_OUTPUT??await mkdtemp(join(tmpdir(),'editac-keyboard-evidence-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[],packed:{},browser:{},server:{},cleanup:{}};
let consumer,server,browser,controller;
async function run(command,args,log){const r=spawnSync(command,args,{encoding:'utf8',timeout:120000});await writeFile(join(output,log),`${r.stdout??''}\n${r.stderr??''}`);assert.equal(r.error,undefined,log);assert.equal(r.status,0,log);return r.stdout;}
const sourcePaths=['packages/web/src/storage/index.ts','packages/web/dist/storage/index.js','packages/web/src/input/keyboard.ts','packages/web/dist/input/keyboard.js','packages/web/src/input/text.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','fixtures/browser-input/session.mjs','fixtures/browser-input/index.html','tests/browser/keyboard.spec.ts','scripts/test-browser.mjs','packages/core/src/engine.ts','packages/core/dist/index.js','packages/core/dist/engine.js','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/web/dist/input/text.js','packages/web/dist/dom/render.js','packages/web/dist/dom/selection.js','packages/web/dist/entry.js','packages/web/dist/storage/index.js','packages/web/dist/storage/journal.js','packages/web/dist/storage/writer.js','package-lock.json'];
async function hashSources(){return Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
before(async()=>{
 facts.sources=await hashSources();
 facts.coreBaseRevision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 consumer=await mkdtemp(join(tmpdir(),'editac-keyboard-consumer-'));
 const packed=JSON.parse(await run('npm',['pack','--workspace','@edit-ac/core','--json','--pack-destination',consumer],'pack.log'))[0];
 const bytes=await readFile(join(consumer,packed.filename));await writeFile(join(output,packed.filename),bytes);
 facts.packed={filename:packed.filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),includesWasm:packed.files.some(f=>f.path==='dist/wasm/editac_wasm_bg.wasm')};assert.equal(facts.packed.includesWasm,true);
 await run('tar',['-xzf',join(consumer,packed.filename),'-C',consumer],'unpack.log');
 server=await startFixtureServer({fixtureDirectory:'fixtures/browser-input',coreDirectory:join(consumer,'package/dist')});
 facts.server={port:server.port,url:server.url,pid:process.pid,launcher:'node --test tests/browser/keyboard.spec.ts',workspace:process.cwd(),purpose:'WEB-1.8 real packed protocol probe',log:output};
 controller=await browserType.launchServer({headless:true});const child=controller.process();
 facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'WEB-1.8 pinned '+engineName,log:output});
 browser=await browserType.connect(controller.wsEndpoint());facts.browser={engine:engineName,version:browser.version(),playwright:'1.64.0',node:process.version,platform:process.platform,arch:process.arch};
});
after(async()=>{
 try{await browser?.close();}finally{try{if(controller){await controller.close();facts.cleanup.browserExited=controller.process().exitCode!==null||controller.process().signalCode!==null;assert.equal(facts.cleanup.browserExited,true);}}finally{try{if(server){await server.close();facts.cleanup.listenerRemoved=await new Promise(resolve=>{const socket=createConnection(server.port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve(e.code==='ECONNREFUSED'));});assert.equal(facts.cleanup.listenerRemoved,true);}}finally{if(consumer)await rm(consumer,{recursive:true,force:true});facts.cleanup.consumerRemoved=true;facts.sourcesUnchanged=JSON.stringify(facts.sources)===JSON.stringify(await hashSources());await writeFile(join(output,'facts.json'),JSON.stringify(facts,null,2));assert.equal(facts.sourcesUnchanged,true,'Probe source/artifacts changed during execution');}}}
});
async function probe(name,action,initialText='alpha'){
 const context=await browser.newContext(),fact={name,passed:false,provenance:name.startsWith('native-')?'actual Playwright browser keyboard':'prepared real-DOM event replay',snapshots:[]};facts.cases.push(fact);
 const page=await context.newPage();page.on('pageerror',error=>{fact.pageErrors??=[];fact.pageErrors.push(error.message);});
 try{await page.goto(server.url);await page.waitForFunction(()=>!!window.inputFixture);await page.evaluate(text=>window.inputFixture.mount(text),initialText);fact.initialText=initialText;await action(page,fact);fact.traceProvenance={nativeTrustedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>t.trusted).map(t=>t.type)))],preparedEventTypes:[...new Set(fact.snapshots.flatMap(s=>s.trace.filter(t=>!t.trusted&&!t.type.endsWith('mutations')&&t.type!=='renderer-echo').map(t=>t.type)))],composition:'prepared event replay; no OS IME'};assert.deepEqual(fact.pageErrors??[],[]);fact.passed=true;}
 finally{try{await page.evaluate(()=>window.inputFixture.destroy());}finally{await context.close();}}
}
async function observe(page,fact){const state=await page.evaluate(async()=>{const f=window.inputFixture,s=await f.state(),native=document.getSelection();return {...s,nodes:f.engine.read().visible,semanticSelection:native?.anchorNode?{anchor:f.selection.toModel(native.anchorNode,native.anchorOffset),focus:f.selection.toModel(native.focusNode,native.focusOffset)}:null};});fact.snapshots.push(state);assert.deepEqual(state.errors,[]);assert.equal(state.storage,'localCommitted');assert.deepEqual(state.dom.filter((_,i)=>state.nodes[i].kind==='block'),state.text.filter((_,i)=>state.nodes[i].kind==='block'));return state;}
async function position(page,index,start,end=start,endIndex=index){await page.evaluate(({index,start,end,endIndex})=>{const f=window.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block');const a=f.selection.toDOM({node:n[index].id,offset:start,bias:'right'}),b=f.selection.toDOM({node:n[endIndex].id,offset:end,bias:'right'});f.root.focus();document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);f.selection.capture();},{index,start,end,endIndex});}
async function setup(page,mode){await page.evaluate(mode=>{const f=window.inputFixture,ids=f.ids;let request;
 if(mode==='heading')request={kind:'format',origin:'fixture',marks:[],blocks:[{targets:[ids[0]],attributes:{type:'heading',level:2},action:'apply'}]};
 else request={kind:'editor',origin:'fixture',commands:mode==='code'?[{type:'setCode',owner:ids[0],language:'js'}]:[{type:'wrap',targets:ids,style:{type:mode}}]};
 const plan=f.engine.prepare(request);try{f.engine.commit(plan);}finally{f.engine.releasePlan(plan);}f.engine.history({type:'clear'});
 },mode);await page.evaluate(()=>window.inputFixture.settle());}
function caret(state,index,offset){const id=state.nodes.filter(n=>n.kind==='block')[index].id;assert.equal(state.semanticSelection.anchor.node,id);assert.equal(state.semanticSelection.focus.node,id);assert.equal(state.semanticSelection.anchor.offset,offset);assert.equal(state.semanticSelection.focus.offset,offset);}
function commits(state,count){const updates=state.patches.filter(p=>p.origin.startsWith('editac:local:keyboard:')&&p.update);assert.equal(updates.length,count);assert.equal(state.journal.filter(p=>p.origin.startsWith('editac:local:keyboard:')).length,count);}

test('native-prose-shift-tab moves focus backward without updates', () => probe('native-prose-shift-tab', async (page, fact) => {
 await page.evaluate(() => {
  const before = document.createElement('input'); before.id = 'before-editor'; before.setAttribute('aria-label', 'Before editor');
  window.inputFixture.root.before(before);
 });
 await position(page, 0, 2);
 const before = await observe(page, fact);
 await page.keyboard.press('Shift+Tab');
 assert.equal(await page.evaluate(() => document.activeElement.id), 'before-editor');
 const after = await observe(page, fact);
 assert.deepEqual(after.nodes, before.nodes);
 assert.deepEqual(after.history, before.history);
 assert.deepEqual(after.journal, before.journal);
 commits(after, 0);
}));

test('native-code-shift-tab dedents a caret line and preserves authored spaces', () => probe('native-code-shift-tab', async (page, fact) => {
 await setup(page, 'code'); await position(page, 0, 4);
 await page.keyboard.press('Shift+Tab');
 const after = await observe(page, fact);
 assert.deepEqual(after.text, ['  alpha', 'independent']);
 caret(after, 0, 3); commits(after, 1);
 assert.equal(after.history.undoGroups, 1);
}, '\t  alpha'));

for (const mode of ['code', 'unordered']) {
 test(`native-escape-shift-tab leaves ${mode} backward without updates`, () => probe(`native-escape-shift-tab-${mode}`, async (page, fact) => {
  await setup(page, mode);
  await page.evaluate(() => {
   const before = document.createElement('input'); before.id = 'before-editor'; before.setAttribute('aria-label', 'Before editor');
   window.inputFixture.root.before(before);
  });
  await position(page, 0, 2);
  const before = await observe(page, fact);
  await page.keyboard.press('Escape'); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'before-editor');
  const after = await observe(page, fact);
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.journal, before.journal);
  commits(after, 0);
 }));
}

test('native-paragraph-enter splits and moves caret once',()=>probe('native-paragraph-enter',async(page,fact)=>{await position(page,0,2);await page.keyboard.press('Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['al','pha','independent']);caret(s,1,0);commits(s,1);assert.equal(s.history.undoGroups,1);}));
for(const backward of [false,true])test(`native-selected-enter-${backward}`,()=>probe(`native-selected-enter-${backward}`,async(page,fact)=>{await position(page,0,backward?4:1,backward?1:4);await page.keyboard.press('Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['a','a','independent']);caret(s,1,0);commits(s,1);}));
for(const key of ['Enter','Shift+Enter'])test(`native-code-${key}`,()=>probe(`native-code-${key}`,async(page,fact)=>{await setup(page,'code');await position(page,0,2);await page.keyboard.press(key);const s=await observe(page,fact);assert.deepEqual(s.text,['al\npha','independent']);caret(s,0,3);commits(s,1);}));
test('native-hard-break stays in paragraph including repeated trailing breaks',()=>probe('native-hard-break',async(page,fact)=>{await page.keyboard.press('Shift+Enter');await page.keyboard.press('Shift+Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['alpha\n\n','independent']);caret(s,0,7);commits(s,2);}));
test('native-heading-middle retains level',()=>probe('native-heading-middle',async(page,fact)=>{await setup(page,'heading');await position(page,0,2);await page.keyboard.press('Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['al','pha','independent']);assert.deepEqual(s.nodes.filter(n=>n.kind==='block').slice(0,2).map(n=>n.blockAttributes),[['heading',2],['heading',2]]);caret(s,1,0);}));
test('native-heading-end creates paragraph (original acceptance)',()=>probe('native-heading-end',async(page,fact)=>{await setup(page,'heading');await position(page,0,5);await page.keyboard.press('Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['alpha','','independent']);assert.deepEqual(s.nodes.filter(n=>n.kind==='block')[1].blockAttributes,['paragraph']);caret(s,1,0);}));

for (const text of ['alpha', 'alpha  ']) test(`native heading-end before a list preserves placement, next input and content history (${JSON.stringify(text)})`, () => probe(`heading-before-list-${text.length}`, async (page, fact) => {
 await setup(page, 'heading');
 await page.evaluate(() => {
  const f = window.inputFixture;
  f.engine.commit(f.engine.prepare({ kind: 'editor', origin: 'fixture', commands: [{ type: 'wrap', targets: [f.ids[1]], style: { type: 'unordered' } }] }));
  f.engine.history({ type: 'clear' });
 });
 await page.locator('#projection h2').click(); await page.keyboard.press('End');
 const initial = await observe(page, fact), heading = initial.nodes.find(n => n.blockAttributes?.[0] === 'heading');
 const item = initial.nodes.find(n => n.kind === 'block' && n.parent !== '@root');
 caret(initial, 0, text.length);
 await page.keyboard.press('Enter');
 const split = await observe(page, fact), blocks = split.nodes.filter(n => n.kind === 'block');
 assert.deepEqual(blocks.map(n => n.runs.map(r => r.text).join('')), [text, '', 'independent']);
 assert.equal(blocks[0].id, heading.id); assert.equal(blocks[1].parent, '@root');
 assert.deepEqual(blocks[1].blockAttributes, ['paragraph']); assert.equal(blocks[2].id, item.id); assert.equal(blocks[2].parent, item.parent);
 assert.ok(split.nodes.indexOf(blocks[1]) < split.nodes.findIndex(n => n.id === item.parent));
 caret(split, 1, 0); commits(split, 1); assert.equal(split.history.undoGroups, 1);
 await page.keyboard.insertText('X');
 const typed = await observe(page, fact);
 assert.deepEqual(typed.nodes.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')), [text, 'X', 'independent']);
 caret(typed, 1, 1); assert.equal(typed.history.undoGroups, 2);
 const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
 await page.keyboard.press(`${primary}+z`); caret(await observe(page, fact), 1, 0);
 await page.keyboard.press(`${primary}+z`);
 const undone = await observe(page, fact);
 assert.deepEqual(undone.nodes.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')), [text, 'independent']);
 await page.keyboard.press(`${primary}+Shift+z`); await page.keyboard.press(`${primary}+Shift+z`);
 const redone = await observe(page, fact);
 assert.deepEqual(redone.nodes.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join('')), [text, 'X', 'independent']);
 // Full stored-selection restoration belongs to RGS-1.3/G07. Preserve the
 // observed gap alongside the passing direct-Enter and content-history checks.
 fact.historySelection = { afterUndo: undone.semanticSelection, afterRedo: redone.semanticSelection,
   qualification: 'Observed only; stored history bookmarks are not qualified by this baseline case' };
}, text));

async function releasedHeadingCaret(page) {
 const released = await page.evaluate(() => {
  const f = window.inputFixture, token = f.commandResults.find(result => result.caret)?.caret;
  if (!token) return false;
  try { f.engine.resolve(token); return false; } catch (error) { return error.code === 'InvalidHandle'; }
 });
 assert.equal(released, true, 'Engine-owned result caret released after selection restoration');
}
for (const backward of [false, true]) {
 test(`native-heading-selected-tail-${backward}`, () => probe(`native-heading-selected-tail-${backward}`, async (page, fact) => {
  await setup(page, 'heading'); await position(page, 0, 0, 2);
  await page.evaluate(() => { const t = window.inputFixture.protocol.keyboard.captureToolbar(); t.format('bold'); t.dispose(); window.inputFixture.engine.history({ type: 'clear' }); });
  await position(page, 0, backward ? 5 : 2, backward ? 2 : 5);
  const before = await observe(page, fact);
  await page.keyboard.press('Enter');
  let state = await observe(page, fact), blocks = state.nodes.filter(n => n.kind === 'block');
  assert.deepEqual(state.text, ['al', '', 'independent']); caret(state, 1, 0); commits(state, 1);
  assert.equal(blocks[0].id, before.nodes[0].id); assert.deepEqual(blocks[0].blockAttributes, ['heading', 2]);
  assert.deepEqual(blocks[0].runs.map(r => [r.text, !!r.attributes.bold]), [['al', true]]);
  assert.equal(blocks[2].id, before.nodes[1].id); assert.equal(state.unrelatedIdentity, true);
  assert.equal(state.history.undoGroups, 1); await releasedHeadingCaret(page);
  await page.keyboard.type('X'); state = await observe(page, fact);
  assert.deepEqual(state.text, ['al', 'X', 'independent']); caret(state, 1, 1);
 }));
 test(`native-heading-cross-block-end-${backward}`, () => probe(`native-heading-cross-block-end-${backward}`, async (page, fact) => {
  await setup(page, 'heading'); await position(page, backward ? 1 : 0, backward ? 11 : 2, backward ? 2 : 11, backward ? 0 : 1);
  await page.keyboard.press('Enter'); const state = await observe(page, fact);
  assert.deepEqual(state.text, ['al', '']); caret(state, 1, 0); commits(state, 1);
  assert.equal(state.history.undoGroups, 1); await releasedHeadingCaret(page);
  await page.evaluate(() => window.inputFixture.event('beforeinput', { inputType: 'historyUndo', cancelable: true }));
  const undo = await observe(page, fact); assert.deepEqual(undo.text, ['alpha', 'independent']);
 }));
 test(`native-heading-selected-all-${backward}`, () => probe(`native-heading-selected-all-${backward}`, async (page, fact) => {
  await setup(page, 'heading'); await position(page, 0, backward ? 5 : 0, backward ? 0 : 5);
  await page.keyboard.press('Enter'); const state = await observe(page, fact);
  assert.deepEqual(state.text, ['', 'independent']); assert.deepEqual(state.nodes[0].blockAttributes, ['paragraph']);
  caret(state, 0, 0); commits(state, 1); assert.equal(state.history.undoGroups, 1);
 }));
}
test('native-heading cross-block suffix retains heading split', () => probe('native-heading-cross-block-suffix', async (page, fact) => {
 await setup(page, 'heading'); await position(page, 0, 2, 3, 1); await page.keyboard.press('Enter');
 const state = await observe(page, fact); assert.deepEqual(state.text, ['al', 'ependent']);
 assert.deepEqual(state.nodes.filter(n => n.kind === 'block').map(n => n.blockAttributes), [['heading', 2], ['heading', 2]]);
 caret(state, 1, 0); commits(state, 1);
}));
test('native-heading-end undo redo preserves remote sibling and result caret', () => probe('native-heading-end-history', async (page, fact) => {
 await setup(page, 'heading'); await position(page, 0, 5); const before = await observe(page, fact);
 await page.keyboard.press('Enter'); let state = await observe(page, fact); caret(state, 1, 0); commits(state, 1);
 assert.equal(state.history.undoGroups, 1); assert.equal(state.unrelatedIdentity, true); await releasedHeadingCaret(page);
 await page.evaluate(() => { const f = window.inputFixture; return f.remote(0, 'R', f.ids[1]); });
 await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
 state = await observe(page, fact); assert.deepEqual(state.text, ['alpha', 'Rindependent']);
 assert.equal(state.nodes[0].id, before.nodes[0].id); assert.equal(state.history.redoGroups, 1);
 await page.evaluate(() => window.inputFixture.event('beforeinput', { inputType: 'historyRedo', cancelable: true }));
 state = await observe(page, fact); assert.deepEqual(state.text, ['alpha', '', 'Rindependent']);
 assert.equal(state.nodes.filter(n => n.kind === 'block')[2].id, before.nodes[1].id);
}));
test('prepared-heading result caret releases when DOM restoration throws', () => probe('prepared-heading-caret-finally', async (page, fact) => {
 await setup(page, 'heading'); await position(page, 0, 5);
 const result = await page.evaluate(() => {
  const f = window.inputFixture, original = f.selection.toDOM;
  f.selection.toDOM = function (...args) { if (f.commandResults.some(result => result.caret)) throw Error('prepared-selection-failure'); return original.apply(this, args); };
  try { return f.protocol.keyboard.execute('enter'); } finally { f.selection.toDOM = original; }
 });
 assert.equal(result.disposition, 'rejected'); assert.equal(result.reason, 'prepared-selection-failure');
 const state = await observe(page, fact); assert.deepEqual(state.text, ['alpha', '', 'independent']); commits(state, 1);
 await releasedHeadingCaret(page);
}));
test('native-heading-end shared-source sibling keeps identity through follow-up typing', () => probe('native-heading-shared-source', async (page, fact) => {
 await setup(page, 'heading'); await position(page, 0, 2); await page.keyboard.press('Enter');
 const before = await observe(page, fact), sibling = before.nodes.filter(n => n.kind === 'block')[1];
 await position(page, 0, 2); await page.keyboard.press('Enter'); let state = await observe(page, fact);
 assert.deepEqual(state.text, ['al', '', 'pha', 'independent']); caret(state, 1, 0); commits(state, 2);
 const placedSibling = state.nodes.filter(n => n.kind === 'block')[2];
 assert.deepEqual({ ...placedSibling, order: sibling.order }, sibling); await releasedHeadingCaret(page);
 await page.keyboard.type('X'); state = await observe(page, fact);
 assert.deepEqual(state.text, ['al', 'X', 'pha', 'independent']); caret(state, 1, 1);
 assert.deepEqual(state.nodes.filter(n => n.kind === 'block')[2], placedSibling);
}));
test('prepared-menu heading-end uses the same result and read-only rejects', () => probe('prepared-menu-heading-end', async (page, fact) => {
 await setup(page, 'heading'); await position(page, 0, 5);
 await page.evaluate(() => window.inputFixture.protocol.setReadOnly(true));
 await page.evaluate(() => window.inputFixture.event('beforeinput', { inputType: 'insertParagraph', cancelable: true }));
 let state = await observe(page, fact); assert.deepEqual(state.text, ['alpha', 'independent']); commits(state, 0);
 await page.evaluate(() => { const f = window.inputFixture; f.protocol.setReadOnly(false); f.event('beforeinput', { inputType: 'insertParagraph', cancelable: true }); });
 state = await observe(page, fact); assert.deepEqual(state.text, ['alpha', '', 'independent']); caret(state, 1, 0); commits(state, 1);
 await releasedHeadingCaret(page);
}));
test('native-empty-heading becomes paragraph',()=>probe('native-empty-heading',async(page,fact)=>{await setup(page,'heading');await position(page,0,0,5);await page.keyboard.press('Backspace');await page.keyboard.press('Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['','independent']);assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);caret(s,0,0);}));
for(const key of ['Backspace','Delete'])test(`native-boundary-${key}`,()=>probe(`native-boundary-${key}`,async(page,fact)=>{await position(page,key==='Backspace'?1:0,key==='Backspace'?0:5);await page.keyboard.press(key);const s=await observe(page,fact);assert.deepEqual(s.text,['alphaindependent']);caret(s,0,5);commits(s,1);}));
for(const key of ['Enter','Shift+Enter','Backspace'])test(`native-cross-block-${key}`,()=>probe(`native-cross-block-${key}`,async(page,fact)=>{await position(page,1,3,2,0);await page.keyboard.press(key);const s=await observe(page,fact);assert.deepEqual(s.text,key==='Enter'?['al','ependent']:key==='Shift+Enter'?['al\nependent']:['alependent']);caret(s,key==='Enter'?1:0,key==='Enter'?0:key==='Shift+Enter'?3:2);commits(s,1);assert.equal(s.history.undoGroups,1);}));
for(const mode of ['unordered','checklist','quote'])test(`native-${mode}-enter`,()=>probe(`native-${mode}-enter`,async(page,fact)=>{await setup(page,mode);await position(page,0,2);await page.keyboard.press('Enter');const s=await observe(page,fact);assert.deepEqual(s.text.filter(t=>t),['al','pha','independent']);const blocks=s.nodes.filter(n=>n.kind==='block');assert.equal(blocks[0].parent,blocks[1].parent);if(mode==='checklist')assert.equal(blocks[1].editor.checked,false);caret(s,1,0);}));
test('native-list-tab indentation and outdent preserve backward selection',()=>probe('native-list-tab',async(page,fact)=>{await setup(page,'unordered');await position(page,1,7,2);const before=await observe(page,fact);await page.keyboard.press('Tab');let s=await observe(page,fact);assert.deepEqual(s.nodes.filter(n=>n.kind==='block').map(n=>n.runs),before.nodes.filter(n=>n.kind==='block').map(n=>n.runs));assert.deepEqual(s.semanticSelection,before.semanticSelection);assert.notEqual(s.nodes.filter(n=>n.kind==='block')[1].parent,before.nodes.filter(n=>n.kind==='block')[1].parent);await page.keyboard.press('Shift+Tab');s=await observe(page,fact);assert.deepEqual(s.semanticSelection,before.semanticSelection);assert.equal(s.nodes.filter(n=>n.kind==='block')[1].parent,before.nodes.filter(n=>n.kind==='block')[1].parent);}));
test('native-prose-tab and Escape-Tab leave focus without updates',()=>probe('native-prose-tab',async(page,fact)=>{await page.evaluate(()=>{const b=document.createElement('input');b.id='after';b.setAttribute('aria-label','After editor');document.body.append(b);});await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'after');await setup(page,'code');await position(page,0,1);await page.keyboard.press('Escape');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'after');const s=await observe(page,fact);commits(s,0);}));
test('native-code-tab inserts literal tab; selection indents and outdents lines',()=>probe('native-code-tab',async(page,fact)=>{await setup(page,'code');await position(page,0,2);await page.keyboard.press('Tab');let s=await observe(page,fact);assert.equal(s.text[0],'al\tpha');caret(s,0,3);await position(page,0,0,6);await page.keyboard.press('Tab');s=await observe(page,fact);assert.equal(s.text[0],'\tal\tpha');await page.keyboard.press('Shift+Tab');s=await observe(page,fact);assert.equal(s.text[0],'al\tpha');commits(s,3);}));
test('prepared-toolbar retains backward captured selection after focus moves',()=>probe('prepared-toolbar',async(page,fact)=>{await position(page,0,4,1);const before=await observe(page,fact);const result=await page.evaluate(()=>{const f=window.inputFixture,t=f.protocol.keyboard.captureToolbar();const b=document.createElement('button');document.body.append(b);b.focus();f.select(f.ids[1],3);const applicable=t.applicable('bold'),result=t.format('bold');t.dispose();return{applicable,result,focused:document.activeElement===f.root};});assert.equal(result.applicable,true);assert.equal(result.result.disposition,'committed');assert.equal(result.focused,true);const s=await observe(page,fact);assert.deepEqual(s.semanticSelection,before.semanticSelection);assert.deepEqual(s.nodes[0].runs.map(r=>[r.text,!!r.attributes.bold]),[['a',false],['lph',true],['a',false]]);assert.equal(s.history.undoGroups,1);}));
test('prepared-toolbar read-only and disposed targets reject without mutation',()=>probe('prepared-toolbar-guards',async(page,fact)=>{const r=await page.evaluate(()=>{const f=window.inputFixture,t=f.protocol.keyboard.captureToolbar();f.protocol.setReadOnly(true);const first=t.format('bold');f.protocol.setReadOnly(false);t.dispose();return[first,t.format('bold')];});assert.ok(r.every(v=>v.disposition==='rejected'));const s=await observe(page,fact);assert.equal(s.text[0],'alpha');assert.equal(s.history.undoGroups,0);}));
test('native-keyboard and prepared-menu undo redo preserve remote text',()=>probe('native-history',async(page,fact)=>{await page.keyboard.press('Shift+Enter');await page.evaluate(()=>window.inputFixture.remote(0,'R'));await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');let s=await observe(page,fact);assert.equal(s.text[0],'Ralpha');assert.equal(s.history.redoGroups,1);await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'historyRedo',cancelable:true}));s=await observe(page,fact);assert.equal(s.text[0],'Ralpha\n');await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'historyUndo',cancelable:true}));s=await observe(page,fact);assert.equal(s.text[0],'Ralpha');}));
test('prepared-key-beforeinput duplicates retain a second deliberate Enter',()=>probe('prepared-key-identity',async(page,fact)=>{await page.evaluate(()=>{const f=window.inputFixture;const key=f.event('keydown',{key:'Enter'});f.root.dispatchEvent(key);f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});f.event('input',{inputType:'insertParagraph'});f.event('keyup',{key:'Enter'});f.event('keydown',{key:'Enter'});f.event('keyup',{key:'Enter'});});const s=await observe(page,fact);assert.deepEqual(s.text,['alpha','','','independent']);commits(s,2);}));
test('native-navigation and modified host Enter retain ownership',()=>probe('native-navigation',async(page,fact)=>{const before=await observe(page,fact);await page.keyboard.press('ArrowLeft');let s=await observe(page,fact);caret(s,0,4);assert.equal(s.history.undoGroups,0);const prevented=await page.evaluate(()=>{const f=window.inputFixture;return [f.event('keydown',{key:'Enter',ctrlKey:true}).defaultPrevented,f.event('keydown',{key:'x',altKey:true,ctrlKey:true}).defaultPrevented];});assert.deepEqual(prevented,[false,false]);s=await observe(page,fact);assert.deepEqual(s.text,before.text);commits(s,0);}));
for(const mode of ['unordered','quote'])test(`native-empty-${mode} exits one level`,()=>probe(`native-empty-${mode}`,async(page,fact)=>{await setup(page,mode);const index=mode==='quote'?1:0;await position(page,index,0,index===1?11:5);await page.keyboard.press('Backspace');await page.keyboard.press('Enter');const s=await observe(page,fact);const blocks=s.nodes.filter(n=>n.kind==='block');assert.equal(blocks[index].parent,'@root');assert.deepEqual(blocks[index].blockAttributes,['paragraph']);caret(s,index,0);commits(s,2);}));
test('prepared-toolbar across blocks retains direction and supported marks',()=>probe('prepared-toolbar-cross-block',async(page,fact)=>{await position(page,1,3,2,0);const before=await observe(page,fact);const r=await page.evaluate(()=>{const t=window.inputFixture.protocol.keyboard.captureToolbar();const result=t.format('italic');t.dispose();return result;});assert.equal(r.disposition,'committed');const s=await observe(page,fact);assert.deepEqual(s.semanticSelection,before.semanticSelection);const blocks=s.nodes.filter(n=>n.kind==='block');assert.deepEqual(blocks[0].runs.map(r=>[r.text,!!r.attributes.italic]),[['al',false],['pha',true]]);assert.deepEqual(blocks[1].runs.map(r=>[r.text,!!r.attributes.italic]),[['ind',true],['ependent',false]]);}));
test('prepared-toolbar deleted target rejects instead of using current caret',()=>probe('prepared-toolbar-deleted',async(page,fact)=>{await position(page,0,1,4);const initial=await page.evaluate(()=>{const f=window.inputFixture;window.toolbar=f.protocol.keyboard.captureToolbar();return{bytes:[...f.engine.encodeUpdate().bytes],vector:[...f.engine.stateVector()],id:f.ids[0]};});const peer=new Y.Doc();peer.clientID=1911;let update;try{Y.applyUpdate(peer,new Uint8Array(initial.bytes));peer.getMap('delete-probe-tombstones').set(initial.id,true);update=[...Y.encodeStateAsUpdate(peer,new Uint8Array(initial.vector))];}finally{peer.destroy();}await page.evaluate(bytes=>window.inputFixture.apply(bytes),update);const r=await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[1],2);const result=window.toolbar.format('bold');window.toolbar.dispose();return result;});assert.equal(r.disposition,'rejected');const s=await observe(page,fact);assert.deepEqual(s.text,['independent']);assert.equal(s.history.undoGroups,0);}));
test('prepared-nonkeyboard Enter and break have semantic selection results',()=>probe('prepared-menu-enter',async(page,fact)=>{await position(page,0,2);await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertParagraph',cancelable:true}));let s=await observe(page,fact);assert.deepEqual(s.text,['al','pha','independent']);caret(s,1,0);await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertLineBreak',cancelable:true}));s=await observe(page,fact);assert.deepEqual(s.text,['al','\npha','independent']);caret(s,1,1);commits(s,2);}));
test('native-code-multiline Tab preserves backward range and existing whitespace',()=>probe('native-code-multiline',async(page,fact)=>{await setup(page,'code');await position(page,0,6,0);const before=await observe(page,fact);assert.equal(before.text[0],'\n x\n\ty');await page.keyboard.press('Tab');let s=await observe(page,fact);assert.equal(s.text[0],'\t\n\t x\n\t\ty');assert.equal(s.semanticSelection.anchor.offset,9);assert.equal(s.semanticSelection.focus.offset,1);await page.keyboard.press('Shift+Tab');s=await observe(page,fact);assert.equal(s.text[0],before.text[0]);assert.equal(s.semanticSelection.anchor.offset,6);assert.equal(s.semanticSelection.focus.offset,0);commits(s,2);assert.equal(s.history.undoGroups,2);},'\n x\n\ty'));
test('prepared-read-only structural and history commands never mutate',()=>probe('prepared-read-only',async(page,fact)=>{await page.evaluate(()=>window.inputFixture.protocol.setReadOnly(true));const prevented=await page.evaluate(()=>{const f=window.inputFixture;return['insertParagraph','insertLineBreak','historyUndo','historyRedo'].map(inputType=>f.event('beforeinput',{inputType,cancelable:true}).defaultPrevented);});assert.deepEqual(prevented,[true,true,true,true]);const s=await observe(page,fact);assert.deepEqual(s.text,['alpha','independent']);assert.equal(s.history.undoGroups,0);commits(s,0);}));
test('prepared-composition owns Enter before structural routing',()=>probe('prepared-composition-precedence',async(page,fact)=>{await position(page,0,2);await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionstart',{data:''});f.event('compositionupdate',{data:'語'});f.mutate('al語pha');f.event('keydown',{key:'Enter',isComposing:true});f.event('compositionend',{data:'語'});f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});f.event('keyup',{key:'Enter'});});const s=await observe(page,fact);assert.deepEqual(s.text,['al語pha','independent']);assert.equal(s.history.undoGroups,1);commits(s,0);await page.keyboard.press('Enter');const after=await observe(page,fact);assert.deepEqual(after.text,['al語','pha','independent']);commits(after,1);}));
for(const backward of [false,true])test(`native-selected-hard-break-${backward}`,()=>probe(`native-selected-hard-break-${backward}`,async(page,fact)=>{await position(page,0,backward?4:1,backward?1:4);await page.keyboard.press('Shift+Enter');const s=await observe(page,fact);assert.deepEqual(s.text,['a\na','independent']);caret(s,0,2);commits(s,1);}));
test('native-inapplicable-list-Tab follows focus',()=>probe('native-inapplicable-list-tab',async(page,fact)=>{await setup(page,'unordered');await position(page,0,2);await page.evaluate(()=>{const input=document.createElement('input');input.id='after';input.setAttribute('aria-label','After editor');document.body.append(input);});await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'after');const s=await observe(page,fact);commits(s,0);}));
test('prepared-host-owned structural events are not consumed',()=>probe('prepared-host-owned',async(page,fact)=>{await page.evaluate(()=>{const f=window.inputFixture,key=new KeyboardEvent('keydown',{key:'Enter',cancelable:true,bubbles:true});key.preventDefault();f.root.dispatchEvent(key);const input=new InputEvent('beforeinput',{inputType:'insertParagraph',cancelable:true,bubbles:true});input.preventDefault();f.root.dispatchEvent(input);});const s=await observe(page,fact);assert.deepEqual(s.text,['alpha','independent']);commits(s,0);}));

for (const boundary of ['shortcut', 'beforeinput', 'blur', 'composition', 'input', 'observer']) {
 test(`native-focus-escape expires after ${boundary}`, () => probe(`native-focus-escape-${boundary}`, async (page, fact) => {
  await setup(page, 'code'); await position(page, 0, 2);
  await page.keyboard.press('Escape');
  if (boundary === 'shortcut') await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  else if (boundary === 'beforeinput') await page.evaluate(() => window.inputFixture.event('beforeinput', { inputType: 'insertText', data: 'X', cancelable: true }));
  else if (boundary === 'input' || boundary === 'observer') await page.evaluate(boundary => {
   const f = window.inputFixture; f.mutate('alXpha');
   if (boundary === 'input') f.event('input', { inputType: 'insertText', data: 'X' });
  }, boundary);
  else if (boundary === 'blur') await page.evaluate(() => {
   const f = window.inputFixture, control = document.createElement('button'); document.body.append(control); control.focus(); f.root.focus();
  });
  else await page.evaluate(() => {
   const f = window.inputFixture;
   f.event('compositionstart', { data: '' }); f.event('compositionupdate', { data: '語' }); f.mutate('al語pha'); f.event('compositionend', { data: '語' });
  });
  // WebKit places the caret at the start on refocus. Set the explicit target
  // without a key/input event so blur remains the escape-invalidating boundary.
  if (boundary === 'blur') await position(page, 0, 2);
  // The next Tab must edit code, rather than use the earlier Escape to leave.
  const before = await observe(page, fact);
  const offset = boundary === 'beforeinput' || boundary === 'composition' ? 3 : boundary === 'input' || boundary === 'observer' ? 6 : 2;
  caret(before, 0, offset);
  await page.keyboard.press('Tab');
  const after = await observe(page, fact);
  assert.equal(await page.evaluate(() => document.activeElement === window.inputFixture.root), true);
  assert.equal(after.text[0], before.text[0].slice(0, offset) + '\t' + before.text[0].slice(offset));
  caret(after, 0, offset + 1); commits(after, 1);
 }));
}
