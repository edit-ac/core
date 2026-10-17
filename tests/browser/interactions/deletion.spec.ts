import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
const registryCorpus=JSON.parse(await readFile('fixtures/modules/registration.json','utf8'));
const vectors=JSON.parse(await readFile('fixtures/editing-failures/deletion-vectors.json','utf8'));
import { browserHarness } from '../browser-harness.ts';


const { probe, facts } = browserHarness('interaction-deletion', 'fixtures/browser-input', {
  autoMount: false, markdown: true, assertSourcesUnchanged: true,
  testFile: 'tests/browser/interactions/deletion.spec.ts',
  sourcePaths: ['packages/web/src/input/keyboard.ts', 'packages/web/src/dom/selection.ts',
    'packages/web/src/dom/render.ts', 'fixtures/editing-failures/deletion-vectors.json', 'crates/editac-core/tests/deletion_commands.rs'],
});
facts.binding = { gate:'INT-1.4', ids:['DEL-01','DEL-02','DEL-03','DEL-04','DEL-05','DEL-06','DEL-07','DEL-08'], profile:'macOS native browser word/soft-line ranges; Rust Unicode extended grapheme command', provenance:'synthetic fixtures; real packed WASM, IndexedDB, mounted adapter and trusted browser keys; no OS qualification' };

async function mount(page, texts, mode = 'paragraph', target = 0) {
  await page.evaluate(async ({ texts, mode, target }) => {
    const f = window.inputFixture;
    await f.mount(texts[0], null, texts);
    f.protocol.shortcuts.enabled=false;
    const ids = f.ids;
    if (mode !== 'paragraph') {
      const request = mode === 'heading' ? {kind:'format',origin:'break-fixture',marks:[],blocks:[{targets:[ids[target]],attributes:{type:'heading',level:2},action:'apply'}]}
        : {kind:'editor',origin:'break-fixture',commands:mode === 'code' ? [{type:'setCode',owner:ids[target],language:'js'}]
          : [{type:'wrap',targets:ids,style:{type:mode}}]};
      const plan = f.engine.prepare(request);
      try { f.engine.commit(plan); } finally { f.engine.releasePlan(plan); }
    }
    f.engine.history({type:'clear'}); await f.settle();
  }, { texts, mode, target });

}
async function position(page, start, end = start) {
  await page.evaluate(({start,end}) => {
    const f = window.inputFixture, nodes = f.engine.read().visible.filter(n => n.kind === 'block');
    const a = f.selection.toDOM({node:nodes[start[0]].id,offset:start[1],bias:'right'});
    const b = f.selection.toDOM({node:nodes[end[0]].id,offset:end[1],bias:'right'});
    f.root.focus(); document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset); f.selection.capture();
  }, {start,end});
}
async function state(page, fact) {
  const s = await page.evaluate(async () => {
    const f = window.inputFixture, s = await f.state(), sel = document.getSelection();
    const blocks = f.engine.read().visible.filter(n => n.kind === 'block');
    const endpoint = (node,offset) => { const p = f.selection.toModel(node,offset); return p ? [blocks.findIndex(n=>n.id===p.node),p.offset] : null; };
    return {...s,nodes:f.engine.read().visible,text:blocks.map(n=>n.runs.map(r=>r.text).join('')),
      selection:sel?.anchorNode ? {anchor:endpoint(sel.anchorNode,sel.anchorOffset),focus:endpoint(sel.focusNode,sel.focusOffset)} : null};
  });
  fact.snapshots.push(s); assert.deepEqual(s.errors,[]); assert.equal(s.storage,'localCommitted');
  assert.deepEqual(s.dom.filter((_,i)=>s.nodes[i].kind==='block'),s.text);
  return s;
}
function caret(s, point) { assert.deepEqual(s.selection,{anchor:point,focus:point}); }
function effects(before, after, count = 1) {
  assert.equal(after.history.undoGroups - before.history.undoGroups,count);
  assert.equal(after.journal.length - before.journal.length,count);
  assert.equal(after.patches.filter(p=>p.update).length - before.patches.filter(p=>p.update).length,count);
}
async function undo(page, fact, before) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  const s = await state(page,fact); assert.deepEqual(s.nodes,before.nodes); assert.deepEqual(s.selection,before.selection);
}
async function redo(page, fact, after) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  const s=await state(page,fact);assert.deepEqual(s.nodes,after.nodes);assert.deepEqual(s.selection,after.selection);
}
async function sentinel(page, fact, expected, point) {
  await page.keyboard.type('X'); const s = await state(page,fact); assert.deepEqual(s.text,expected); caret(s,point);
}


const primary = process.platform === 'darwin' ? 'Meta' : 'Control';
async function mark(page, owner=0, from=0, to=2, name='bold') { await page.evaluate(({owner,from,to,name})=>{const f=window.inputFixture,n=f.engine.read().visible.filter(n=>n.kind==='block')[owner];const p=f.engine.prepare({kind:'editor',origin:'deletion-fixture',commands:[{type:'markAt',owner:n.id,from,to,mark:name,action:'apply'}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});},{owner,from,to,name}); }

for(const key of ['Backspace','Delete'])test(`DEL-01 digit and letter ${key}`,()=>probe(`DEL-01-${key}`,async(page,fact)=>{
 await mount(page,['1a']);await position(page,[0,key==='Backspace'?2:1]);const before=await state(page,fact);await page.keyboard.press(key);const after=await state(page,fact);assert.deepEqual(after.text,['1']);caret(after,[0,1]);effects(before,after);await undo(page,fact,before);
}));
for(const {cluster} of vectors)for(const key of ['Backspace','Delete'])for(const placement of ['start','middle','end'])test(`DEL-02 ${JSON.stringify(cluster)} ${key} ${placement}`,()=>probe(`DEL-02-${cluster}-${key}-${placement}`,async(page,fact)=>{
 const prefix=placement==='start'?'':'a',suffix=placement==='end'?'':'b';await mount(page,[prefix+cluster+suffix]);await mark(page,0,0,prefix.length+cluster.length+suffix.length);await position(page,[0,prefix.length+(key==='Backspace'?cluster.length:0)]);const before=await state(page,fact);await page.keyboard.press(key);const after=await state(page,fact);assert.deepEqual(after.text,[prefix+suffix]);caret(after,[0,prefix.length]);effects(before,after);assert.ok(after.nodes[0].runs.every(r=>r.attributes.bold===true));await undo(page,fact,before);await redo(page,fact,after);
}));
for(const backward of [false,true])test(`DEL-03 cross-block marked range backward=${backward}`,()=>probe(`DEL-03-${backward}`,async(page,fact)=>{
 await mount(page,['abcd','efgh']);await mark(page,0,0,4);await mark(page,1,0,4,'italic');await position(page,backward?[1,2]:[0,2],backward?[0,2]:[1,2]);const before=await state(page,fact);await page.keyboard.press('Backspace');const after=await state(page,fact);assert.deepEqual(after.text,['abgh']);assert.deepEqual(after.nodes[0].runs.map(r=>[r.text,r.attributes]),[['ab',{bold:true}],['gh',{italic:true}]]);caret(after,[0,2]);effects(before,after);await undo(page,fact,before);await redo(page,fact,after);
}));
for(const key of ['Backspace','Delete'])test(`DEL-04 marked join ${key}`,()=>probe(`DEL-04-${key}`,async(page,fact)=>{
 await mount(page,['ab','cd']);await mark(page);await mark(page,1,0,2,'italic');await position(page,key==='Backspace'?[1,0]:[0,2]);const before=await state(page,fact);await page.keyboard.press(key);const after=await state(page,fact);assert.deepEqual(after.text,['abcd']);assert.deepEqual(after.nodes[0].runs.map(r=>[r.text,r.attributes]),[['ab',{bold:true}],['cd',{italic:true}]]);caret(after,[0,2]);effects(before,after);await undo(page,fact,before);
}));
test('DEL-04 incompatible code join rejects atomically',()=>probe('DEL-04-rejected',async(page,fact)=>{
 await mount(page,['ab','cd'],'code',1);await position(page,[1,0]);const before=await state(page,fact);await page.keyboard.press('Backspace');const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.selection,before.selection);effects(before,after,0);assert.equal(after.intents.at(-1).disposition,'rejected');
}));
for(const mode of ['unordered','quote','checklist'])test(`DEL-05 nested ${mode} outdent first`,()=>probe(`DEL-05-${mode}`,async(page,fact)=>{
 await mount(page,['ab','cd'],mode);await page.evaluate(()=>{const f=window.inputFixture,n=f.ids[1];const p=f.engine.prepare({kind:'editor',origin:'nested-fixture',commands:[{type:'indent',owner:n}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});await position(page,[1,0]);const before=await state(page,fact);await page.keyboard.press('Backspace');const after=await state(page,fact);assert.deepEqual(after.text,['ab','cd']);assert.notEqual(after.nodes.filter(n=>n.kind==='block')[1].parent,before.nodes.filter(n=>n.kind==='block')[1].parent);effects(before,after);await undo(page,fact,before);
}));
for(const key of ['Backspace','Delete','preselected'])test(`DEL-06 separator ${key}`,()=>probe(`DEL-06-${key}`,async(page,fact)=>{
 await mount(page,['ab','','cd']);await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'atom-fixture',commands:[{type:'convertSeparator',owner:f.ids[1]}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
 if(key==='preselected')await page.evaluate(()=>{const f=window.inputFixture,r=document.createRange();r.selectNode(f.renderer.getBlock(f.ids[1]));f.root.focus();document.getSelection().removeAllRanges();document.getSelection().addRange(r);});else await position(page,key==='Backspace'?[2,0]:[0,2]);
 const before=await state(page,fact);if(key!=='preselected'){await page.keyboard.press(key);const first=await state(page,fact);effects(before,first,0);assert.equal(await page.evaluate(()=>window.inputFixture.selection.selectedNode()),before.nodes[1].id);}await page.keyboard.press(key==='Delete'?'Delete':'Backspace');const after=await state(page,fact);assert.deepEqual(after.text,['ab','cd']);effects(before,after);await page.keyboard.press(`${primary}+z`);assert.deepEqual((await state(page,fact)).nodes,before.nodes);
}));
for(const key of ['Backspace','Delete'])test(`DEL-07 boundary repeats ${key}`,()=>probe(`DEL-07-${key}`,async(page,fact)=>{
 await mount(page,['ab']);await position(page,[0,key==='Backspace'?0:2]);const before=await state(page,fact);await page.evaluate(()=>{window.deletionRepeats=[];window.inputFixture.root.addEventListener('keydown',e=>window.deletionRepeats.push(e.repeat));});for(let i=0;i<5;i++)await page.keyboard.down(key);await page.keyboard.up(key);assert.equal(await page.evaluate(()=>window.deletionRepeats.filter(Boolean).length),4);const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.selection,before.selection);effects(before,after,0);
}));
for(const [type,text,from,to] of [['deleteWordBackward','one,  two!',6,9],['deleteWordForward','אבג דהו',4,7],['deleteSoftLineBackward','one, two!',0,9]])test(`DEL-08 supplied native profile ${type}`,()=>probe(`DEL-08-${type}`,async(page,fact)=>{
 await mount(page,[text]);await position(page,[0,type.endsWith('Backward')?to:from]);const before=await state(page,fact);await page.evaluate(({type,from,to})=>{const f=window.inputFixture,n=f.ids[0],a=f.selection.toDOM({node:n,offset:from,bias:'right'}),b=f.selection.toDOM({node:n,offset:to,bias:'left'});const e=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:type});Object.defineProperty(e,'getTargetRanges',{value:()=>[new StaticRange({startContainer:a.node,startOffset:a.offset,endContainer:b.node,endOffset:b.offset})]});f.root.dispatchEvent(e);},{type,from,to});const after=await state(page,fact);assert.deepEqual(after.text,[text.slice(0,from)+text.slice(to)]);caret(after,[0,from]);effects(before,after);await undo(page,fact,before);
}));
for(const [chord,text,expected] of [['Alt+Backspace','one,  two','one,  '],[`${primary}+Backspace`,'אבג one, two','']])test(`DEL-08 trusted macOS browser ${chord}`,()=>probe(`DEL-08-trusted-${chord}`,async(page,fact)=>{
 await mount(page,[text]);await position(page,[0,text.length]);const before=await state(page,fact);await page.keyboard.press(chord);const after=await state(page,fact);assert.deepEqual(after.text,[expected]);caret(after,[0,expected.length]);effects(before,after);fact.profile={os:process.platform,chord,text,expected,traces:after.trace.filter(e=>e.type==='beforeinput')};await undo(page,fact,before);
}));

async function inlineAtom(page,texts=['aBADGEb']) {
 await page.evaluate(definitions=>{window.inputModuleDefinitions=definitions;},registryCorpus.definitions);await mount(page,texts);
 const input=await page.evaluate(()=>{const f=window.inputFixture;return{bytes:Array.from(f.engine.checkpoint().bytes),source:f.engine.read().visible[0].spans[0].source};});
 const d=new Y.Doc();Y.applyUpdate(d,new Uint8Array(input.bytes));const v=Y.encodeStateVector(d);d.getMap('registry-texts').get(input.source).format(1,5,{'module:demo.badge':[1,{label:'badge'}]});const update=Y.encodeStateAsUpdate(d,v);d.destroy();await page.evaluate(async bytes=>{const f=window.inputFixture;f.apply(bytes);f.engine.history({type:'clear'});await f.settle();},Array.from(update));
}
for(const key of ['Backspace','Delete','preselected'])test(`DEL-06 registered inline atom ${key}`,()=>probe(`DEL-06-inline-${key}`,async(page,fact)=>{
 await inlineAtom(page);if(key==='preselected')await page.evaluate(()=>{const f=window.inputFixture,r=document.createRange();r.selectNode(f.root.querySelector('[data-module-type="demo.badge"]'));f.root.focus();document.getSelection().removeAllRanges();document.getSelection().addRange(r);f.selection.capture();});else await position(page,[0,key==='Backspace'?6:1]);
 const before=await state(page,fact);if(key!=='preselected'){await page.keyboard.press(key);const first=await state(page,fact);assert.deepEqual(first.nodes,before.nodes);effects(before,first,0);assert.equal(await page.evaluate(()=>document.getSelection().toString()),'BADGE');}await page.keyboard.press(key==='Delete'?'Delete':'Backspace');const after=await state(page,fact);assert.deepEqual(after.text,['ab']);caret(after,[0,1]);effects(before,after);await page.keyboard.press(`${primary}+z`);assert.deepEqual((await state(page,fact)).nodes,before.nodes);
}));
for(const backward of [false,true])test(`DEL-03 selected inline atom and marked blocks backward=${backward}`,()=>probe(`DEL-03-inline-${backward}`,async(page,fact)=>{
 await inlineAtom(page,['aBADGEb','cdef']);await mark(page,0,0,1);await mark(page,1,0,4,'italic');await position(page,backward?[1,2]:[0,1],backward?[0,1]:[1,2]);const before=await state(page,fact);await page.keyboard.press('Delete');const after=await state(page,fact);assert.deepEqual(after.text,['aef']);assert.deepEqual(after.nodes[0].runs.map(r=>[r.text,r.attributes]),[['a',{bold:true}],['ef',{italic:true}]]);caret(after,[0,1]);effects(before,after);await undo(page,fact,before);
}));
for(const offset of [1,99])test(`DEL-02 invalid shared WASM cut ${offset}`,()=>probe(`DEL-02-invalid-${offset}`,async(page,fact)=>{
 await mount(page,['e\u0301']);const before=await state(page,fact);const result=await page.evaluate(offset=>{const f=window.inputFixture,request={kind:'editor',origin:'invalid-cut',commands:[{type:'markAt',owner:f.ids[0],from:0,to:2,mark:'bold',action:'apply'},{type:'deleteGraphemeAt',owner:f.ids[0],offset,backward:true}]};return f.engine.can(request);},offset);assert.equal(result,false);const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);effects(before,after,0);
}));

test('DEL-01 digit and letter native ArrowLeft has zero content effects',()=>probe('DEL-01-native-arrow',async(page,fact)=>{
 await mount(page,['1a']);await position(page,[0,2]);const before=await state(page,fact);await page.keyboard.press('ArrowLeft');const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);caret(after,[0,1]);effects(before,after,0);
}));
