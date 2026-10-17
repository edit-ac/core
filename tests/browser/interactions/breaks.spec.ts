import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';
import { InteractionHarness } from '../interaction-harness.ts';

const { probe, facts } = browserHarness('interaction-breaks', 'fixtures/browser-input', {
  autoMount: false, markdown: true, assertSourcesUnchanged: true,
  testFile: 'tests/browser/interactions/breaks.spec.ts',
  sourcePaths: ['packages/web/src/input/keyboard.ts', 'packages/web/src/dom/selection.ts',
    'packages/web/src/dom/render.ts', 'tests/browser/interaction-harness.ts'],
});
facts.binding = { gate: 'INT-1.2', ids: ['BRK-01','BRK-02','BRK-03','BRK-04','BRK-05','BRK-06','BRK-07','BRK-08','SEL-01','SEL-02','SEL-03','SEL-04'],
  provenance: 'real engine, mounted adapter, native browser keyboard, IndexedDB; no OS input qualification' };

async function mount(page, texts, mode = 'paragraph', target = 0) {
  await page.evaluate(async ({ texts, mode, target }) => {
    const f = window.inputFixture;
    await f.mount(texts[0], null, texts);
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
  await new InteractionHarness(page).requireEngine();
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
    const endpoint = (node,offset) => { const p = f.selection.toModel(node,offset); return [blocks.findIndex(n=>n.id===p.node),p.offset]; };
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

for (const hard of [false,true]) test(`BRK-01 BRK-02: ${hard ? 'hard break' : 'split'} preserves suffix and sentinel`, () => probe(`BRK-0${hard?2:1}`,async(page,fact)=>{
  await mount(page,['abcd']); await position(page,[0,2]); const before=await state(page,fact);
  await page.keyboard.press(hard?'Shift+Enter':'Enter'); const after=await state(page,fact);
  assert.deepEqual(after.text,hard?['ab\ncd']:['ab','cd']); caret(after,hard?[0,3]:[1,0]); effects(before,after);
  await sentinel(page,fact,hard?['ab\nXcd']:['ab','Xcd'],hard?[0,4]:[1,1]);
}));

for (const text of ['', 'abc']) test(`BRK-03: repeated authored trailing breaks ${JSON.stringify(text)} survive codecs and storage`,()=>probe(`BRK-03-${text||'empty'}`,async(page,fact)=>{
  await mount(page,[text]); await position(page,[0,text.length]); const before=await state(page,fact);
  await page.keyboard.press('Shift+Enter'); await page.keyboard.press('Shift+Enter');
  const after=await state(page,fact); assert.deepEqual(after.text,[text+'\n\n']); caret(after,[0,text.length+2]); effects(before,after,2);
  await position(page,[0,0],[0,text.length+2]);
  const copied=await page.evaluate(()=>{const f=window.inputFixture,data=new DataTransfer();f.root.dispatchEvent(window.preparedClipboardEvent('copy',data));return data.getData('text/plain');});
  assert.equal(copied,text+'\n\n','copy excludes renderer fillers');
  const codec=await page.evaluate(()=>{const f=window.inputFixture,blocks=f.engine.read().visible.filter(n=>n.kind==='block').map(n=>({attributes:{type:'paragraph'},runs:n.runs.map(r=>({text:r.text,marks:[]}))}));
    const exported=f.engine.exportMarkdown(blocks);return {exported,imported:f.engine.importMarkdown(exported.markdown)};});
  fact.codec=codec; assert.deepEqual(codec.exported.diagnostics,[]); assert.deepEqual(codec.imported.blocks.map(b=>b.runs.map(r=>r.text).join('')),[text+'\n\n']);
  await page.evaluate(()=>window.inputFixture.reopen()); const restored=await state(page,fact); assert.deepEqual(restored.nodes,after.nodes);
  await position(page,[0,text.length+2]); await sentinel(page,fact,[text+'\n\nX'],[0,text.length+3]);
}));

for (const backward of [false,true]) for (const hard of [false,true]) for (const multi of [false,true]) {
  const id=multi?'SEL-02':'BRK-04-SEL-01';
  test(`${id}: ${backward?'backward':'forward'} selected ${hard?'hard break':'Enter'}`,()=>probe(`${id}-${backward}-${hard}`,async(page,fact)=>{
    await mount(page,multi?['abc','def']:['abcd']);
    const a=[0,multi?2:1], b=multi?[1,2]:[0,3]; await position(page,backward?b:a,backward?a:b); const before=await state(page,fact);
    await page.keyboard.press(hard?'Shift+Enter':'Enter'); const after=await state(page,fact);
    assert.deepEqual(after.text,hard?[multi?'ab\nf':'a\nd']:multi?['ab','f']:['a','d']); caret(after,hard?[0,multi?3:2]:[1,0]); effects(before,after);
    await undo(page,fact,before);
    await page.keyboard.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');
    const redone=await state(page,fact); assert.deepEqual(redone.nodes,after.nodes); caret(redone,hard?[0,multi?3:2]:[1,0]);
    await sentinel(page,fact,hard?[multi?'ab\nXf':'a\nXd']:multi?['ab','Xf']:['a','Xd'],hard?[0,multi?4:3]:[1,1]);
  }));
}

for (const texts of [['abc'],['abc','']]) for (const action of ['Enter','Delete','X']) for (const backward of [false,true]) test(`SEL-03: whole document ${texts.length} blocks ${action} ${backward}`,()=>probe(`SEL-03-${texts.length}-${action}-${backward}`,async(page,fact)=>{
  await mount(page,texts); const a=[0,0],b=[texts.length-1,texts.at(-1).length];await position(page,backward?b:a,backward?a:b);const before=await state(page,fact);
  if(action==='X')await page.keyboard.type('X');else await page.keyboard.press(action);
  const after=await state(page,fact);assert.deepEqual(after.text,action==='Enter'?['','']:action==='X'?['X']:['']);caret(after,action==='Enter'?[1,0]:action==='X'?[0,1]:[0,0]);effects(before,after);await undo(page,fact,before);
}));

for (const text of ['abcd','abc','abc  ','']) test(`BRK-05: heading ${JSON.stringify(text)} transitions before unchanged list`,()=>probe(`BRK-05-${text.replaceAll(' ','space')||'empty'}`,async(page,fact)=>{
  await mount(page,[text,'list'],'heading');
  await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'break-fixture',commands:[{type:'wrap',targets:[f.ids[1]],style:{type:'unordered'}}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
  const offset=text==='abcd'?2:text.length;await position(page,[0,offset]);const before=await state(page,fact);await page.keyboard.press('Enter');const after=await state(page,fact);
  assert.deepEqual(after.text,text==='abcd'?['ab','cd','list']:text?[text,'','list']:['','list']);effects(before,after);
  const blocks=after.nodes.filter(n=>n.kind==='block');assert.deepEqual(blocks[text?1:0].blockAttributes,text==='abcd'?['heading',2]:['paragraph']);
  await undo(page,fact,before);
  await redo(page,fact,after);await sentinel(page,fact,text==='abcd'?['ab','Xcd','list']:text?[text,'X','list']:['X','list'],[text?1:0,1]);
}));

for (const mode of ['unordered','checklist','quote']) for (const empty of [false,true]) for (const hard of [false,true]) test(`BRK-06 BRK-07: ${mode} ${empty?'empty final':'nonempty'} ${hard?'hard break':'Enter'}`,()=>probe(`BRK-context-${mode}-${empty}-${hard}`,async(page,fact)=>{
  await mount(page,['left',empty?'':'abcd'],mode);
  if(mode==='checklist')await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'break-fixture',commands:[{type:'setChecked',owner:f.ids[1],checked:true}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
  await position(page,[1,empty?0:2]);const before=await state(page,fact);await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);effects(before,after);
  assert.deepEqual(after.text,hard?['left',empty?'\n':'ab\ncd']:empty?['left','']:['left','ab','cd']);
  const blocks=after.nodes.filter(n=>n.kind==='block');const dest=hard||empty?1:2;caret(after,[dest,hard?(empty?1:3):0]);
  if(empty&&!hard)assert.equal(blocks[1].parent,'@root');else assert.equal(blocks[dest].parent,blocks[0].parent);
  if(mode==='checklist'&&!empty&&!hard)assert.equal(blocks[dest].editor.checked,false);
  await undo(page,fact,before);await redo(page,fact,after);
  await sentinel(page,fact,hard?['left',empty?'\nX':'ab\nXcd']:empty?['left','X']:['left','ab','Xcd'],[dest,hard?(empty?2:4):1]);
}));

for (const empty of [false,true]) for (const hard of [false,true]) test(`BRK-06: nested item ${empty} ${hard} exits one level or preserves its parent`,()=>probe(`BRK-06-nested-${empty}-${hard}`,async(page,fact)=>{
  await mount(page,['left',empty?'':'abcd'],'unordered');
  await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'break-fixture',commands:[{type:'indent',owner:f.ids[1]}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
  await position(page,[1,empty?0:2]);const before=await state(page,fact);const outer=before.nodes.find(n=>n.id===before.ids[0]).parent,nested=before.nodes.find(n=>n.id===before.ids[1]).parent;
  assert.notEqual(nested,outer);await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);effects(before,after);
  assert.deepEqual(after.text,hard?['left',empty?'\n':'ab\ncd']:empty?['left','']:['left','ab','cd']);
  const dest=after.nodes.filter(n=>n.kind==='block').at(-1);assert.equal(dest.parent,empty&&!hard?outer:nested);
  await undo(page,fact,before);await redo(page,fact,after);
  await sentinel(page,fact,hard?['left',empty?'\nX':'ab\nXcd']:empty?['left','X']:['left','ab','Xcd'],[hard||empty?1:2,hard?(empty?2:4):1]);
}));

for(const hard of [false,true])for(const backward of [false,true])test(`SEL-04: marked compatible replacement ${hard} ${backward} retains suffix marks`,()=>probe(`SEL-04-marked-${hard}-${backward}`,async(page,fact)=>{
  await mount(page,['abcd']);await page.evaluate(()=>{const f=window.inputFixture,a=f.engine.anchor(f.ids[0],0,'right'),b=f.engine.anchor(f.ids[0],4,'left');
    try {const p=f.engine.prepare({kind:'format',origin:'break-fixture',marks:[{range:{anchor:a,focus:b},mark:'bold',action:'apply'}],blocks:[]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}}finally{f.engine.releaseAnchor(a);f.engine.releaseAnchor(b);}f.engine.history({type:'clear'});});
  await position(page,[0,backward?3:1],[0,backward?1:3]);const before=await state(page,fact);await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);effects(before,after);
  assert.deepEqual(after.text,hard?['a\nd']:['a','d']);const runs=after.nodes.filter(n=>n.kind==='block').flatMap(n=>n.runs);assert.ok(runs.filter(r=>/[ad]/.test(r.text)).every(r=>r.attributes.bold));await undo(page,fact,before);
}));

for(const hard of [false,true])for(const backward of [false,true])test(`SEL-04: separator crossed by selected replacement ${hard} ${backward} rejects before deletion`,()=>probe(`SEL-04-atom-${hard}-${backward}`,async(page,fact)=>{
  await mount(page,['abc','','def']);await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'break-fixture',commands:[{type:'convertSeparator',owner:f.ids[1]}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
  const a=[0,1],b=[2,2];await position(page,backward?b:a,backward?a:b);const before=await state(page,fact);await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.selection,before.selection);effects(before,after,0);
}));

for(const hard of [false,true])for(const backward of [false,true])test(`SEL-04: table crossed by selected replacement ${hard} ${backward} rejects atomically`,()=>probe(`SEL-04-table-${hard}-${backward}`,async(page,fact)=>{
  await mount(page,['abc','','def']);
  await page.evaluate(()=>{const f=window.inputFixture,at=f.engine.anchor(f.ids[1],0,'right');
    try {const blocks=f.engine.importMarkdown('| one | two |\n| --- | --- |\n| left | right |',{tables:true}).blocks;
      const p=f.engine.prepare({kind:'fragment',origin:'break-fixture',range:{anchor:at,focus:at},blocks});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}
    } finally {f.engine.releaseAnchor(at);}f.engine.history({type:'clear'});});
  const count=await page.evaluate(()=>window.inputFixture.engine.read().visible.filter(n=>n.kind==='block').length);
  const a=[0,1],b=[count-1,2];await position(page,backward?b:a,backward?a:b);const before=await state(page,fact);assert.ok(before.nodes.some(n=>n.blockAttributes?.[0]==='module:editac.table'));
  await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.selection,before.selection);effects(before,after,0);
}));

test('BRK-01: keydown/beforeinput/input echoes correlate to one split; read-only and host ownership reject',()=>probe('BRK-01-ownership',async(page,fact)=>{
  await mount(page,['abcd']);await position(page,[0,2]);const before=await state(page,fact);
  await page.evaluate(()=>{const f=window.inputFixture;f.event('keydown',{key:'Enter'});f.event('beforeinput',{inputType:'insertParagraph',cancelable:true});f.event('input',{inputType:'insertParagraph'});f.event('keyup',{key:'Enter'});});
  const after=await state(page,fact);assert.deepEqual(after.text,['ab','cd']);caret(after,[1,0]);effects(before,after);
  await page.evaluate(()=>window.inputFixture.protocol.setReadOnly(true));
  await page.keyboard.press('Enter');await page.keyboard.press('Shift+Enter');const blocked=await state(page,fact);assert.deepEqual(blocked.nodes,after.nodes);effects(after,blocked,0);
  await page.evaluate(()=>{const f=window.inputFixture;f.protocol.setReadOnly(false);const e=new KeyboardEvent('keydown',{key:'Enter',cancelable:true,bubbles:true});e.preventDefault();f.root.dispatchEvent(e);});
  const host=await state(page,fact);assert.deepEqual(host.nodes,after.nodes);effects(after,host,0);
}));

for (const hard of [false,true]) test(`BRK-08: code ${hard?'Shift+Enter':'Enter'} remains literal`,()=>probe(`BRK-08-code-${hard}`,async(page,fact)=>{
  await mount(page,['abcd'],'code');await position(page,[0,2]);const before=await state(page,fact);await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);
  assert.deepEqual(after.text,['ab\ncd']);caret(after,[0,3]);effects(before,after);await undo(page,fact,before);await page.keyboard.press(hard?'Shift+Enter':'Enter');await sentinel(page,fact,['ab\nXcd'],[0,4]);
}));

for (const mode of ['code','unordered']) for (const hard of [false,true]) for (const backward of [false,true]) test(`SEL-04: incompatible ${mode} ${hard} ${backward} rejects atomically`,()=>probe(`SEL-04-${mode}-${hard}-${backward}`,async(page,fact)=>{
  await mount(page,['abc','def'],mode==='code'?'code':'paragraph',1);
  if(mode==='unordered')await page.evaluate(()=>{const f=window.inputFixture,p=f.engine.prepare({kind:'editor',origin:'break-fixture',commands:[{type:'wrap',targets:[f.ids[1]],style:{type:'unordered'}}]});try{f.engine.commit(p);}finally{f.engine.releasePlan(p);}f.engine.history({type:'clear'});});
  const a=[0,1],b=[1,2];await position(page,backward?b:a,backward?a:b);const before=await state(page,fact);await page.keyboard.press(hard?'Shift+Enter':'Enter');const after=await state(page,fact);
  assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.selection,before.selection);effects(before,after,0);
}));
