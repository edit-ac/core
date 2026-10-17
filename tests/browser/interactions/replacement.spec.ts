import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import { browserHarness } from '../browser-harness.ts';

const { probe: rawProbe, facts } = browserHarness('interaction-replacement', 'fixtures/browser-input', {
  markdown: true, autoMount: false, assertSourcesUnchanged: true,
  testFile: 'tests/browser/interactions/replacement.spec.ts',
  sourcePaths: ['packages/web/src/input/composition.ts', 'packages/web/src/input/reconcile.ts',
    'packages/web/src/commands/formatting.ts', 'fixtures/browser-input/session.mjs',
    'packages/web/dist/input/text.js', 'packages/web/dist/input/composition.js',
    'packages/core/dist/wasm/editac_wasm_bg.wasm', 'scripts/test-interactions.mjs'],
});
facts.binding = { gate: 'INT-1.7', ids: Array.from({length:10}, (_,i)=>`EVT-${String(i+1).padStart(2,'0')}`),
  provenance: 'Authored deterministic real-DOM replays of ADR004 event families; recovered Session, packed current WASM, IndexedDB journal and production TextInput. Language strings and prepared events do not qualify OS IME/dictation/handwriting/Safari device support. Actual Playwright typing is labeled separately.',
  profile: {os:process.platform, arch:process.arch, layout:'headless browser default, 1280x720; prepared composition geometry'},
};
function probe(name, action) { return rawProbe(name, async (page, fact) => {
  await page.waitForFunction(()=>!!window.inputFixture);
  await page.evaluate(()=>window.inputFixture.mount('alpha',null));
  await action(page,fact);
}); }
const primary=process.platform==='darwin'?'Meta':'Control';
async function state(page,fact) {
  const s=await page.evaluate(async()=>{const f=window.inputFixture;const n=document.getSelection();return {...await f.state(),nodes:f.engine.read().visible, endpoints:{anchor:!f.selection.suspended&&n?.anchorNode&&f.selection.toModel(n.anchorNode,n.anchorOffset),focus:!f.selection.suspended&&n?.focusNode&&f.selection.toModel(n.focusNode,n.focusOffset)}};});
  fact.snapshots.push(s); assert.deepEqual(s.errors,[]); assert.equal(s.storage,'localCommitted'); return s;
}
function effects(s,count) {
  const local=p=>p.origin.startsWith('editac:local:text-input:');
  const updates=s.patches.filter(p=>local(p)&&p.update), entries=s.journal.filter(local);
  assert.equal(updates.length,count,'semantic updates'); assert.equal(entries.length,count,'durable entries');
  assert.equal(s.intents.filter(i=>i.disposition==='committed').length,count,'committed intent owners');
  assert.equal(new Set(updates.map(p=>p.origin)).size,count,'unique owners');
  assert.equal(s.history.undoGroups,count,'undo groups');
}
function content(s,text,offset=text.length) {
  assert.equal(s.text[0],text);assert.deepEqual(s.dom,s.text);
  if(offset!==null)assert.equal(s.caret?.offset,offset);
}
async function start(page,a=1,b=4) { await page.evaluate(({a,b})=>{const f=window.inputFixture;f.select(f.ids[0],a,b);f.event('compositionstart');},{a,b}); }
async function interim(page,text,data) {await page.evaluate(({text,data})=>{const f=window.inputFixture;f.event('beforeinput',{inputType:'insertCompositionText',data,isComposing:true,cancelable:true});f.mutate(text);f.event('input',{inputType:'insertCompositionText',data,isComposing:true});},{text,data});}
async function end(page,data) {await page.evaluate(data=>window.inputFixture.event('compositionend',{data}),data);}
async function bold(page) {await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0,5);const t=f.protocol.keyboard.captureToolbar();try{t.apply({bold:true});}finally{t.dispose();}f.engine.history({type:'clear'});});}

for(const mode of ['cancelable','noncancelable','missing','observer-first','empty-ranges'])
test(`EVT-01/02 ${mode}: one replacement and echo ownership`,()=>probe(`EVT-01-02-${mode}`,async(page,fact)=>{
  await page.evaluate(mode=>{const f=window.inputFixture;f.select(f.ids[0],1,4);
    if(mode!=='missing'&&mode!=='observer-first')f.event('beforeinput',{inputType:'insertText',data:'字',cancelable:mode==='cancelable'});
    if(mode!=='cancelable'){f.mutate('a字a');const n=document.getSelection().anchorNode;document.getSelection().setBaseAndExtent(n,2,n,2);}
    if(mode!=='observer-first'){f.event('input',{inputType:'insertText',data:'字'});f.event('input',{inputType:'insertText',data:'字'});}
  },mode);
  let s=await state(page,fact);content(s,'a字a',2);effects(s,1);
  await page.evaluate(()=>{const f=window.inputFixture;f.event('input',{inputType:'insertText',data:'字'});});
  s=await state(page,fact);effects(s,1);content(s,'a字a',2);
}));

for(const inputType of ['insertReplacementText','insertText'])
for(const backward of [false,true])
test(`EVT-06/07 ${inputType} supplied target differs from caret ${backward}`,()=>probe(`EVT-06-07-${inputType}-${backward}`,async(page,fact)=>{
  await bold(page);
  const prevented=await page.evaluate(({inputType,backward})=>{const f=window.inputFixture;f.select(f.ids[0],5);const a=f.selection.toDOM({node:f.ids[0],offset:1,bias:'right'}),b=f.selection.toDOM({node:f.ids[0],offset:4,bias:'left'});
    const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType,data:'😊'});
    Object.defineProperty(e,'getTargetRanges',{value:()=>[new StaticRange({startContainer:a.node,startOffset:a.offset,endContainer:b.node,endOffset:b.offset})]});
    if(backward)f.select(f.ids[0],5,4);f.root.dispatchEvent(e);return e.defaultPrevented;
  },{inputType,backward});
  assert.equal(prevented,true);const s=await state(page,fact);content(s,'a😊a',3);effects(s,1);
  assert.deepEqual(s.nodes[0].runs.map(r=>({text:r.text,bold:r.attributes.bold})),[{text:'a😊a',bold:true}]);
  await page.keyboard.press(`${primary}+z`);const undo=await state(page,fact);content(undo,'alpha',1);assert.equal(undo.endpoints.focus.offset,4);assert.equal(undo.nodes[0].runs[0].attributes.bold,true);
}));
for(const mode of ['missing-target','noncancelable'])test(`EVT-02/07 correction ${mode} falls back to native affected block`,()=>probe(`EVT-02-07-${mode}`,async(page,fact)=>{
  await bold(page);await page.evaluate(mode=>{const f=window.inputFixture;f.select(f.ids[0],5);f.event('beforeinput',{inputType:'insertReplacementText',data:'文',cancelable:mode!=='noncancelable'});f.mutate('a文a');f.event('input',{inputType:'insertReplacementText',data:'文'});},mode);
  const s=await state(page,fact);content(s,'a文a');effects(s,1);assert.equal(s.nodes[0].runs[0].attributes.bold,true);
}));
test('EVT-02 supplied foreign target rejects atomically',()=>probe('EVT-02-foreign-target',async(page,fact)=>{
  const prevented=await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],2);const foreign=document.createTextNode('foreign');document.body.append(foreign);const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertReplacementText',data:'X'});Object.defineProperty(e,'getTargetRanges',{value:()=>[new StaticRange({startContainer:foreign,startOffset:0,endContainer:foreign,endOffset:2})]});f.root.dispatchEvent(e);return e.defaultPrevented;});
  assert.equal(prevented,true);const s=await state(page,fact);content(s,'alpha',2);effects(s,0);assert.equal(s.intents.at(-1).reason,'unmapped-replacement-target');
}));

for(const data of ['日本語','한글','中文'])for(const order of ['before','after'])
test(`EVT-03/04 ${data} final input ${order} end and popup Enter`,()=>probe(`EVT-03-04-${data}-${order}`,async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.inputFixture;await f.destroy();await f.mount('/alpha',null);f.select(f.ids[0],1);const {slashCommands}=await import('/web/modules/slash.js');f.protocol.attachSlash(slashCommands([{id:'noop',label:'No action',prepare:()=>{window.accepted=(window.accepted??0)+1;return {type:'editor',commands:[]};}}]));});
  await page.getByRole('button',{name:'Slash commands',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.inputFixture.protocol.slash.open),true);
  await start(page,2,5);await interim(page,`/a${data}a`,data);let s=await state(page,fact);effects(s,0);assert.equal(s.selectionSuspended,true);assert.equal(s.text[0],'/alpha');
  const geometry=await page.evaluate(()=>{const f=window.inputFixture,block=f.renderer.getBlock(f.ids[0]);const r=document.createRange();r.selectNodeContents(block);const rect=r.getBoundingClientRect();return {width:rect.width,height:rect.height,blockHeight:block.getBoundingClientRect().height,text:block.textContent};});
  fact.geometry=geometry;
  if(process.env.EDITAC_INTERACTION_REPLACEMENT_OUTPUT){const file=`EVT-03-${data}-${order}.png`;await writeFile(join(process.env.EDITAC_INTERACTION_REPLACEMENT_OUTPUT,file),await page.screenshot());fact.screenshot=file;}
  assert.ok(geometry.width>0&&geometry.height>0);assert.equal(geometry.text,`/a${data}a`);
  await page.evaluate(({data,order})=>{const f=window.inputFixture;const notify=()=>f.event('input',{inputType:order==='after'?'insertText':'insertFromComposition',data});if(order==='before')notify();f.event('compositionend',{data});f.event('keydown',{key:'Enter',isComposing:false});f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});if(order==='after')notify();f.event('keyup',{key:'Enter'});f.event('input',{inputType:'insertFromComposition',data});},{data,order});
  s=await state(page,fact);content(s,`/a${data}a`,2+data.length);effects(s,1);assert.equal(s.text.length,1);assert.equal(await page.evaluate(()=>window.inputFixture.protocol.slash.open),false);assert.equal(await page.evaluate(()=>window.accepted??0),0);
  await page.keyboard.press(`${primary}+z`);s=await state(page,fact);content(s,'/alpha',2);assert.equal(s.endpoints.focus.offset,5);
  await page.keyboard.press(`${primary}+Shift+z`);s=await state(page,fact);content(s,`/a${data}a`,2+data.length);
  await page.keyboard.press('Enter');s=await state(page,fact);assert.deepEqual(s.text,[`/a${data}`,'a']);assert.equal(s.history.undoGroups,2);
}));
for(const mode of ['readonly','dispose','cancel','blur'])
test(`EVT-08 ${mode} late notifications preserve terminal disposition`,()=>probe(`EVT-08-${mode}`,async(page,fact)=>{
  await start(page);await interim(page,'a文a','文');await page.evaluate(mode=>{const f=window.inputFixture;if(mode==='readonly')f.protocol.setReadOnly(true);else if(mode==='dispose')f.protocol.dispose();else if(mode==='blur')f.event('blur');else f.event('compositionend',{data:''});f.event('compositionend',{data:'文'});f.event('input',{inputType:'insertFromComposition',data:'文'});},mode);
  const s=await state(page,fact);content(s,mode==='blur'?'a文a':'alpha',mode==='blur'?2:null);effects(s,mode==='blur'?1:0);assert.equal(s.selectionSuspended,false);
  assert.equal(s.intents.at(-1).disposition,mode==='dispose'?'disposed':mode==='blur'?'committed':'canceled');assert.equal(s.intents.at(-1).text,'文');
}));
for(const leading of ['\t','  \t'])test(`EVT-05 code tab and Korean composition ${leading.length}`,()=>probe(`EVT-05-${leading.length}`,async(page,fact)=>{
  await page.evaluate(leading=>{const f=window.inputFixture;f.engine.commit(f.engine.prepare({kind:'editor',origin:'fixture',commands:[{type:'setCode',owner:f.ids[0],language:'js'},{type:'replaceAt',owner:f.ids[0],from:0,to:5,text:leading+'alpha'}]}));f.engine.history({type:'clear'});f.select(f.ids[0],leading.length+2);},leading);
  await page.keyboard.press('Tab');let s=await state(page,fact);assert.equal(s.text[0],leading+'al\tpha');
  await start(page,leading.length+3,leading.length+3);await interim(page,leading+'al\t한pha','한');await end(page,'한');s=await state(page,fact);content(s,leading+'al\t한pha',leading.length+4);assert.equal(s.history.undoGroups,2);
  await page.keyboard.type('!');s=await state(page,fact);content(s,leading+'al\t한!pha',leading.length+5);
}));
for(const classified of [false,true])test(`EVT-09 slash eligible direct typing ${classified}`,()=>probe(`EVT-09-${classified}`,async(page,fact)=>{
  fact.provenance=classified?'actual Playwright browser keyboard; no OS dictation claim':'prepared no-keydown insertText, source unclassified';
  await page.evaluate(async()=>{const f=window.inputFixture;await f.destroy();await f.mount('',null);const {slashCommands}=await import('/web/modules/slash.js');f.protocol.attachSlash(slashCommands([{id:'noop',label:'No action',prepare:()=>({type:'editor',commands:[]})}]));f.select(f.ids[0],0);});
  if(classified)await page.keyboard.type('/');else await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertText',data:'/',cancelable:true}));
  const s=await state(page,fact);content(s,'/');effects(s,1);assert.equal(await page.evaluate(()=>window.inputFixture.protocol.slash.open),classified);
}));
test('EVT-10 blur from bold composition to plain paragraph clears typing marks',()=>probe('EVT-10',async(page,fact)=>{
  await page.evaluate(async()=>{await window.inputFixture.destroy();await window.inputFixture.mount('alpha','plain');});await bold(page);await start(page,2,2);await interim(page,'al字pha','字');
  await page.evaluate(()=>{const f=window.inputFixture;f.event('blur');f.event('compositionend',{data:'字'});f.select(f.ids[1],2);});
  await page.keyboard.type('!');const s=await state(page,fact);assert.deepEqual(s.text,['al字pha','pl!ain']);assert.equal(s.nodes[0].runs.every(r=>r.attributes.bold===true),true);assert.equal(s.nodes[1].runs.some(r=>r.attributes.bold===true),false);effects(s,2);
}));
for(const mode of ['undo','paste'])test(`EVT-08 ${mode} interrupts composition once`,()=>probe(`EVT-08-${mode}`,async(page,fact)=>{
  if(mode==='undo')await page.keyboard.type('!');
  await start(page);await interim(page,'a文a'+(mode==='undo'?'!':''),'文');
  if(mode==='undo')await page.keyboard.press(`${primary}+z`);
  else await page.evaluate(()=>{const f=window.inputFixture,data=new DataTransfer();data.setData('text/plain','P');f.root.dispatchEvent(window.preparedClipboardEvent('paste',data));});
  const s=await state(page,fact);assert.deepEqual(s.dom,s.text);assert.equal(s.selectionSuspended,false);
  if(mode==='undo'){assert.equal(s.text[0],'alpha');assert.equal(s.intents.find(i=>i.origin==='composition')?.text,'文');assert.equal(s.intents.find(i=>i.origin==='composition')?.disposition,'canceled');}
  else {content(s,'a文Pa',3);assert.equal(s.intents.filter(i=>i.origin==='composition'&&i.disposition==='committed').length,1);assert.equal(s.history.undoGroups,2);}
}));
for(const mode of ['delete','replace'])test(`EVT-08 remote ${mode} of composition target preserves recovery`,()=>probe(`EVT-08-remote-${mode}`,async(page,fact)=>{
  await start(page);await interim(page,'a文a','文');await page.evaluate(mode=>window.inputFixture.remoteReplace(1,4,mode==='delete'?'':'PEER'),mode);await end(page,'文');
  const s=await state(page,fact);content(s,mode==='delete'?'aa':'aPEERa',null);effects(s,0);assert.equal(s.recovery.at(-1).reason,'remote-overlap');assert.equal(s.recovery.at(-1).text,'文');assert.equal(s.caret,null);
}));
test('EVT-08 remote owner deletion never retargets to surviving block',()=>probe('EVT-08-owner-deleted',async(page,fact)=>{
  await page.evaluate(async()=>{const f=window.inputFixture;await f.destroy();await f.mount('alpha','independent');});
  await start(page);await interim(page,'a文a','文');
  const initial=await page.evaluate(()=>{const f=window.inputFixture;return {bytes:[...f.engine.encodeUpdate().bytes],vector:[...f.engine.stateVector()],id:f.ids[0]};});
  const peer=new Y.Doc();peer.clientID=1901;let bytes;
  try {Y.applyUpdate(peer,new Uint8Array(initial.bytes));peer.getMap('delete-probe-tombstones').set(initial.id,true);bytes=[...Y.encodeStateAsUpdate(peer,new Uint8Array(initial.vector))];}finally{peer.destroy();}
  await page.evaluate(bytes=>window.inputFixture.apply(bytes),bytes);await end(page,'文');
  const s=await state(page,fact);assert.deepEqual(s.text,['independent']);assert.deepEqual(s.dom,s.text);effects(s,0);assert.equal(s.recovery.at(-1).reason,'stale-target');assert.equal(s.recovery.at(-1).text,'文');assert.equal(s.caret,null);
}));
test('EVT-07 marked phrase correction preserves untouched boundaries and exact undo',()=>probe('EVT-07-mixed-marks',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;f.engine.commit(f.engine.prepare({kind:'editor',origin:'fixture',commands:[{type:'markAt',owner:f.ids[0],from:1,to:4,mark:'bold',action:'apply'}]}));f.engine.history({type:'clear'});f.select(f.ids[0],5);
    const a=f.selection.toDOM({node:f.ids[0],offset:1,bias:'right'}),b=f.selection.toDOM({node:f.ids[0],offset:4,bias:'left'});const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertReplacementText',data:'文'});Object.defineProperty(e,'getTargetRanges',{value:()=>[new StaticRange({startContainer:a.node,startOffset:a.offset,endContainer:b.node,endOffset:b.offset})]});f.root.dispatchEvent(e);
  });
  let s=await state(page,fact);content(s,'a文a',2);effects(s,1);assert.deepEqual(s.nodes[0].runs.map(r=>[r.text,r.attributes.bold??false]),[['a',false],['文',true],['a',false]]);
  await page.keyboard.press(`${primary}+z`);s=await state(page,fact);content(s,'alpha',1);assert.deepEqual(s.nodes[0].runs.map(r=>[r.text,r.attributes.bold??false]),[['a',false],['lph',true],['a',false]]);
  await page.keyboard.press(`${primary}+Shift+z`);s=await state(page,fact);content(s,'a文a',2);assert.equal(s.history.undoGroups,1);
}));
