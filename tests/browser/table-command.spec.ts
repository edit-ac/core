import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('table-command','fixtures/browser-content-modules',{markdown:true,assertSourcesUnchanged:true,sourcePaths:[
 'packages/web/src/modules/content.ts','packages/web/src/modules/reorder.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','packages/web/src/surface.ts',
 'fixtures/browser-content-modules/session.mjs','fixtures/browser-content-modules/index.html','crates/editac-core/src/commands/table.rs','crates/editac-core/src/interchange.rs',
]});
const section=p=>p.locator('[data-content-module="table"]');
const input=(p,r=2,c=1)=>p.getByRole('textbox',{name:`Table row ${r} column ${c}`,exact:true});
const choose=(p,r,c,shift=false)=>p.getByRole('button',{name:`Select cell row ${r} column ${c}`,exact:true}).click(shift?{modifiers:['Shift']} : {});
const table=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');
const cells=s=>table(s).blockAttributes[2].rows.map(r=>r.map(c=>c.map(run=>run[0]).join('')));
async function state(p,f){const s=await p.evaluate(()=>window.inputFixture.state());f.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);}
function oneEffect(a,b){assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);assert.equal(b.commands.length,a.commands.length+1);}
async function clipboard(p,type,data={}){return p.evaluate(({type,data})=>{const transfer=new DataTransfer();for(const [key,value]of Object.entries(data))transfer.setData(key,value);const e=window.preparedClipboardEvent(type,transfer);document.querySelector('[data-content-module="table"]').dispatchEvent(e);return{prevented:e.defaultPrevented,data:Object.fromEntries([...transfer.types].map(t=>[t,transfer.getData(t)]))};},{type,data});}
for(const key of ['Delete','Backspace'])test(`TBL-01 ${key} clears a rectangle once; geometry, owner, undo and recovery survive`,()=>probe(`clear-${key}`,async(p,f)=>{
 const before=await state(p,f);await p.evaluate(()=>window.untouched=document.querySelector('[data-content-module="image"]'));
 await choose(p,1,1);await choose(p,2,2,true);assert.equal(await p.locator('[aria-pressed="true"]').count(),4);
 await section(p).press(key);const after=await state(p,f);oneEffect(before,after);assert.deepEqual(cells(after),[['',''],['','']]);assert.equal(table(after).id,table(before).id);assert.deepEqual(table(after).blockAttributes[2].alignments,table(before).blockAttributes[2].alignments);
 assert.equal(await p.evaluate(()=>window.untouched===document.querySelector('[data-content-module="image"]')),true);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));const undone=await state(p,f);assert.deepEqual(undone.nodes,before.nodes);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);
 await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);
}));
for(const [label,expected]of [['Remove rows',[['head','other mail']]],['Remove columns',[['other mail'],['beta']]]])test(`TBL-01 explicit ${label} changes geometry once and undo restores`,()=>probe(label.replaceAll(' ','-'),async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await p.getByRole('button',{name:label,exact:true}).click();const after=await state(p,f);oneEffect(before,after);assert.deepEqual(cells(after),expected);assert.equal(table(after).id,table(before).id);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);
}));
for(const [label,rows,columns]of [['Insert row before',3,2],['Insert row after',3,2],['Insert column before',2,3],['Insert column after',2,3]])test(`TBL-01 explicit ${label} uses existing shape planner`,()=>probe(label.replaceAll(' ','-'),async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await p.getByRole('button',{name:label,exact:true}).click();const after=await state(p,f);oneEffect(before,after);assert.equal(cells(after).length,rows);assert.equal(cells(after)[0].length,columns);assert.equal(table(after).id,table(before).id);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);
}));
test('TBL-02 native text selection/copy/delete, Enter and explicit cell typing have distinct owners',()=>probe('text-versus-cells',async(p,f)=>{
 const before=await state(p,f);await input(p).focus();await input(p).press('Home');await input(p).press('Shift+ArrowRight');await input(p).press('Shift+ArrowRight');
 const copied=await input(p).evaluate(el=>{const data=new DataTransfer();const e=window.preparedClipboardEvent('copy',data);el.dispatchEvent(e);return data.getData('text/plain');});assert.equal(copied,'al');unchanged(before,await state(p,f));
 await input(p).press('Backspace');const edited=await state(p,f);oneEffect(before,edited);assert.equal(cells(edited)[1][0],'pha😀');assert.equal(cells(edited).length,2);
 await choose(p,2,1);await section(p).press('Enter');assert.equal(await input(p).evaluate(el=>el===document.activeElement),true);unchanged(edited,await state(p,f));
 await choose(p,2,2);await section(p).press('X');const typed=await state(p,f);oneEffect(edited,typed);assert.equal(cells(typed)[1][1],'X');assert.equal(await input(p,2,2).evaluate(el=>el===document.activeElement),true);
}));
for(const mime of ['text/tab-separated-values','text/plain','text/html'])test(`TBL-03 copy/paste literal row preserves dimensions via ${mime}`,()=>probe(`clipboard-${mime.replaceAll('/','-')}`,async(p,f)=>{
 const before=await state(p,f);await choose(p,1,1);await choose(p,1,2,true);const copied=await clipboard(p,'copy');assert.equal(copied.prevented,true);assert.equal(copied.data['text/plain'],'one\ttwo');assert.match(copied.data['text/html'],/<tr><td>one<\/td><td>two<\/td><\/tr>/);unchanged(before,await state(p,f));
 await choose(p,2,1);await choose(p,2,2,true);await clipboard(p,'paste',{[mime]:copied.data[mime]});const after=await state(p,f);oneEffect(before,after);assert.deepEqual(cells(after),[['one','two'],['one','two']]);assert.equal(after.commands.at(-1).commands[0].type,'tableRectangle');
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);
},{plainTable:true}));
test('TBL-03 dimension mismatch, protected cell, multiline and merged/rich HTML reject without partial effects',()=>probe('paste-rejection',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await choose(p,2,2,true);
 for(const data of [
  {'text/plain':'one'}, {'text/plain':'one\ttwo\nthree\tfour'}, {'text/plain':'a\rb\tc'},
  {'text/html':'<table><tr><td colspan="2">merged</td></tr></table>'},
  {'text/html':'<table><tr><td colspan="2">merged</td></tr></table>','text/tab-separated-values':'one\ttwo'},
  {'text/html':'<table><tr><td><strong>rich</strong></td><td>x</td></tr></table>'},
  {'text/html':'<table><tr><td><table><tr><td>nested</td></tr></table></td><td>x</td></tr></table>'},
 ]){await clipboard(p,'paste',data);unchanged(before,await state(p,f));}
 await p.evaluate(()=>window.inputFixture.config.protected=[[1,1]]);await clipboard(p,'paste',{'text/plain':'one\ttwo'});unchanged(before,await state(p,f));assert.match(await section(p).getByRole('status').textContent(),/rejected/);
}));
test('TBL-01/03 readonly, policy failure, stale target and limits preserve engine/history/storage',()=>probe('authority-stale-limits',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));await section(p).press('Delete');await clipboard(p,'paste',{'text/plain':'x'});unchanged(before,await state(p,f));assert.equal(await p.getByRole('button',{name:'Remove rows',exact:true}).isDisabled(),true);
 await p.evaluate(()=>{window.inputFixture.surface.setReadOnly(false);window.inputFixture.config.policyError=true;});await section(p).press('Delete');unchanged(before,await state(p,f));await p.evaluate(()=>window.inputFixture.config.policyError=false);
 const results=await p.evaluate(()=>{const e=window.inputFixture.engine,n=e.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');const command={type:'tableRectangle',owner:n.id,expected:n.blockAttributes,row:0,column:0,rows:1,columns:1,cells:null,protected:[]};window.savedTableCommand=command;return [{...command,rows:0},{...command,rows:129},{...command,cells:[['a\nb']]},{...command,protected:[[0,0]]},{...command,expected:null}].map(c=>e.can({kind:'editor',origin:'invalid',commands:[c]}));});assert.deepEqual(results,[false,false,false,false,false]);unchanged(before,await state(p,f));
 assert.equal(await p.evaluate(()=>window.inputFixture.peerCell('remote😀')),true);const remote=await state(p,f);assert.equal(await p.evaluate(()=>window.inputFixture.engine.can({kind:'editor',origin:'stale',commands:[window.savedTableCommand]})),false);unchanged(remote,await state(p,f));assert.equal(await p.locator('[aria-pressed="true"]').count(),0);
}));
test('TBL-04 native input pointer/drag/cancel and IME do not enter block reorder or steal text selection',()=>probe('gesture-ownership',async(p,f)=>{
 const before=await state(p,f);const box=await input(p).boundingBox();assert.ok(box);await p.mouse.move(box.x+5,box.y+10);await p.mouse.down();await p.mouse.move(box.x+55,box.y+10,{steps:5});await p.mouse.up();
 assert.equal(await input(p).evaluate(el=>el.selectionEnd>el.selectionStart),true);unchanged(before,await state(p,f));
 await input(p).press('Home');await input(p).press('Shift+ArrowRight');
 const retained=await input(p).evaluate(el=>({start:el.selectionStart,end:el.selectionEnd}));
 const result=await input(p).evaluate(el=>{let outside=0;const root=window.inputFixture.root,listener=()=>outside++;root.addEventListener('pointermove',listener);const data=new DataTransfer();for(const type of ['pointerdown','pointermove','pointercancel'])el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch'}));const drag=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data});el.dispatchEvent(drag);el.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));root.removeEventListener('pointermove',listener);return{outside,types:[...data.types],start:el.selectionStart,end:el.selectionEnd};});assert.deepEqual(result,{outside:0,types:[],...retained});unchanged(before,await state(p,f));
 await input(p).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'})));await choose(p,2,2);assert.equal(await p.locator('[aria-pressed="true"]').count(),0);
 await input(p).evaluate(el=>{el.value='中😀';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中😀'}));});const after=await state(p,f);oneEffect(before,after);assert.equal(cells(after)[1][0],'中😀');assert.equal(after.commands.some(c=>c.origin==='module-reorder'),false);
},{reorder:true}));
test('Escape/disposal cancel transient cell selection; detached actions cannot commit',()=>probe('dispose-cells',async(p,f)=>{
 const before=await state(p,f);await choose(p,2,1);await section(p).press('Escape');assert.equal(await p.locator('[aria-pressed="true"]').count(),0);unchanged(before,await state(p,f));await choose(p,2,1);
 await p.evaluate(()=>{const el=document.querySelector('[data-content-module="table"]'),button=[...el.querySelectorAll('button')].find(b=>b.textContent==='Remove rows');window.inputFixture.disposeSurface();button.click();el.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));});const after=await state(p,f);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.history,before.history);assert.deepEqual(after.journal,before.journal);
}));
