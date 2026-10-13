import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('references','fixtures/browser-references');
const old=[{targetId:'host:old',label:'Old result'}], fresh=[{targetId:'host:unknown/😀',label:'<Unknown & 😀>'}];
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
async function open(page){await page.getByRole('button',{name:'Insert reference',exact:true}).click();}
async function respond(page,index,results){await page.evaluate(({index,results})=>window.inputFixture.respond(index,results),{index,results});await page.waitForFunction(()=>window.inputFixture.surface.references.menu.getAttribute('aria-busy')==='false');}
const atoms=s=>s.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.reference');

test('opening and typing a document make no implicit host resolver or network calls',()=>probe('no-implicit',async(page,fact)=>{
 await page.keyboard.type('@query');const s=await state(page,fact);assert.deepEqual(s.requests,[]);assert.deepEqual(s.network,[]);assert.equal(s.open,false);assert.equal(s.text[0],'prefix @query');
},'prefix '));
test('out-of-order replies from a host ignoring abort cannot insert or replace current suggestions',()=>probe('stale-query',async(page,fact)=>{
 await open(page);await page.getByRole('searchbox',{name:'Search references'}).fill('new');
 await respond(page,1,fresh);let s=await state(page,fact);assert.deepEqual(s.aborted,[true,false]);assert.deepEqual(s.requests.map(r=>r.query),['','new']);assert.ok(s.requests[1].requestId>s.requests[0].requestId);
 await page.evaluate(results=>window.inputFixture.respond(0,results),old);await page.waitForTimeout(0);assert.equal(await page.getByRole('menuitem').textContent(),fresh[0].label);
 await page.getByRole('menuitem').click();s=await state(page,fact);assert.equal(atoms(s).length,1);assert.deepEqual(atoms(s)[0].blockAttributes,['module:editac.reference',1,fresh[0]]);assert.equal(atoms(s)[0].runs[0].text,fresh[0].label);assert.equal(s.commands.filter(c=>c.origin==='reference:insert').length,1);assert.equal(s.open,false);assert.equal(s.focus,true);assert.deepEqual(s.network,[]);
}));
test('old query results are cleared immediately while the new request is pending',()=>probe('clear-results',async(page,fact)=>{
 await open(page);await respond(page,0,old);await page.getByRole('searchbox').fill('next');await page.getByRole('searchbox').press('Enter');let s=await state(page,fact);assert.equal(atoms(s).length,0);assert.equal(await page.getByRole('menuitem').count(),0);assert.equal(s.text[0],'alpha');await respond(page,1,fresh);await page.getByRole('searchbox').press('Enter');s=await state(page,fact);assert.equal(atoms(s)[0].runs[0].text,fresh[0].label);
}));
for(const action of ['escape','readonly','dispose','remote','target-edit','composition'])test(`${action} invalidates pending replies without mutation`,()=>probe(`cancel-${action}`,async(page,fact)=>{
 await open(page);const before=await state(page,fact);
 if(action==='escape')await page.getByRole('searchbox').press('Escape');
 else await page.evaluate(action=>{const f=window.inputFixture;
  if(action==='readonly')f.surface.setReadOnly(true);
  if(action==='dispose')f.surface.dispose();
  if(action==='remote')return f.remote(0,'remote ');
  if(action==='target-edit'){const at=f.engine.anchor(f.ids[0],0,'right');try{f.engine.commit(f.engine.prepare({kind:'text',origin:'target-edit',command:{type:'insert',at,text:'changed '}}));}finally{f.engine.releaseAnchor(at);}}
  if(action==='composition')f.event('compositionstart',{data:''});
 },action);
 await page.evaluate(results=>window.inputFixture.respond(0,results),fresh);let s;
 if(action==='dispose'){s=await page.evaluate(()=>({nodes:window.inputFixture.engine.read().visible,aborted:window.inputFixture.pending.map(p=>p.signal.aborted)}));fact.snapshots.push(s);}
 else s=await state(page,fact);
 assert.deepEqual(s.aborted,[true]);assert.equal(atoms(s).length,0);if(!['remote','target-edit','dispose'].includes(action)){assert.equal(s.text[0],before.text[0]);assert.deepEqual(s.history,before.history);}
}));
test('named menu supports keyboard selection, literal safe labels and one undo/redo group',()=>probe('keyboard-history',async(page,fact)=>{
 await page.keyboard.press('Tab');await page.keyboard.press('Enter');await respond(page,0,[...old,...fresh]);
 assert.equal(await page.getByRole('dialog').getAttribute('aria-label'),'Reference suggestions');assert.equal(await page.getByRole('menu').getAttribute('aria-label'),'Reference results');
 await page.getByRole('searchbox').press('End');await page.keyboard.press('Enter');let s=await state(page,fact);assert.equal(atoms(s).length,1);assert.equal(atoms(s)[0].runs[0].text,fresh[0].label);assert.equal(s.history.undoGroups,1);assert.ok(s.journal.some(o=>o.includes('reference:insert')));
 await page.keyboard.press('ControlOrMeta+z');s=await state(page,fact);assert.equal(atoms(s).length,0);assert.equal(s.text[0],'alpha');await page.keyboard.press('ControlOrMeta+Shift+z');s=await state(page,fact);assert.equal(atoms(s).length,1);
}));
test('unknown ID/label survive checkpoint recovery with enabled and disabled presenter without resolving',()=>probe('recovery-fallback',async(page,fact)=>{
 await open(page);await respond(page,0,fresh);await page.getByRole('menuitem').click();let s=await state(page,fact);const expected=atoms(s);assert.equal(expected.length,1);
 await page.evaluate(()=>window.inputFixture.reopen(false));s=await state(page,fact);assert.deepEqual(atoms(s),expected);assert.equal(s.requests.length,1);assert.deepEqual(s.network,[]);assert.ok(s.dom.includes(fresh[0].label));
 await page.evaluate(()=>window.inputFixture.reopen(true));s=await state(page,fact);assert.deepEqual(atoms(s),expected);assert.equal(s.requests.length,1);assert.equal(s.open,false);assert.deepEqual(s.network,[]);assert.ok(s.dom.includes(fresh[0].label));
}));
test('host errors, oversized/duplicate/invalid targets and no results retain source',()=>probe('invalid-results',async(page,fact)=>{
 await open(page);await page.evaluate(()=>window.inputFixture.reject(0));await page.waitForFunction(()=>window.inputFixture.surface.references.menu.getAttribute('aria-busy')==='false');let s=await state(page,fact);assert.match(s.status,/failed/);
 const variants=[[],[...old,...old],[{targetId:'',label:'x'}],[{targetId:'id',label:'😀'.repeat(257)}],Array.from({length:65},(_,i)=>({targetId:String(i),label:'x'})),[{targetId:'id',label:'bad\nlabel'}]];
 for(let i=0;i<variants.length;i++){await page.getByRole('searchbox').fill(String(i));await respond(page,i+1,variants[i]);await page.getByRole('searchbox').press('Enter');s=await state(page,fact);assert.equal(atoms(s).length,0);assert.equal(s.text[0],'alpha');assert.equal(s.history.undoGroups,0);assert.equal(s.commands.length,0);}
}));
test('unrelated edits preserve the anchored target; selected text is replaced only after explicit choice',()=>probe('anchored-selection',async(page,fact)=>{
 await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],1,4));await open(page);
 await page.evaluate(()=>{const f=window.inputFixture,at=f.engine.anchor(f.ids[1],0,'right');try{f.engine.commit(f.engine.prepare({kind:'text',origin:'other-node',command:{type:'insert',at,text:'other '}}));}finally{f.engine.releaseAnchor(at);}});
 await respond(page,0,old);await page.getByRole('menuitem').click();const s=await state(page,fact);assert.equal(atoms(s).length,1);assert.equal(atoms(s)[0].runs[0].text,'Old result');assert.equal(s.text[0],'a');assert.ok(s.text.includes('a'));assert.ok(s.text.includes('other independent'));assert.equal(s.commands.length,1);
}));
test('Tab dismisses without accepting and new sessions reject old-session replies',()=>probe('session-generation',async(page,fact)=>{
 await open(page);await respond(page,0,old);await page.getByRole('searchbox').press('Tab');let s=await state(page,fact);assert.equal(s.open,false);assert.equal(atoms(s).length,0);
 await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],5));await open(page);await page.getByRole('searchbox').press('Escape');await open(page);await respond(page,2,fresh);await page.evaluate(results=>window.inputFixture.respond(1,results),old);await page.getByRole('menuitem').click();s=await state(page,fact);assert.equal(atoms(s)[0].runs[0].text,fresh[0].label);assert.equal(s.requests.length,3);assert.deepEqual(s.aborted,[false,true,false]);
}));
test('invalid persisted descriptor or mismatched fallback rejects atomically before mutation',()=>probe('invalid-descriptor',async(page,fact)=>{
 const before=await state(page,fact);const rejected=await page.evaluate(()=>{const f=window.inputFixture,e=f.engine;const a=e.anchor(f.ids[0],0,'right'),b=e.anchor(f.ids[0],5,'left');try{return [
 ['module:editac.reference',2,{targetId:'id',label:'label'}],['module:editac.reference',1,{targetId:'id',label:'label',execute:'code'}],['module:editac.reference',1,{targetId:'id',label:'label'}]
 ].map(tuple=>{try{e.prepare({kind:'fragment',origin:'invalid-reference',range:{anchor:a,focus:b},blocks:[{attributes:{type:'content',tuple},runs:[{text:'mismatch',marks:[]}]}]});return false;}catch{return true;}});}finally{e.releaseAnchor(a);e.releaseAnchor(b);}});
 assert.deepEqual(rejected,[true,true,true]);const s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.deepEqual(s.history,before.history);assert.deepEqual(s.journal,before.journal);
}));

test('duplicate native input notifications reuse one request and composition delays host search',()=>probe('query-notifications',async(page,fact)=>{
 await open(page);await page.evaluate(()=>{const search=window.inputFixture.surface.references.search;search.value='same';search.dispatchEvent(new InputEvent('input',{bubbles:true}));search.dispatchEvent(new InputEvent('input',{bubbles:true}));});let s=await state(page,fact);assert.equal(s.requests.length,2);assert.deepEqual(s.aborted,[true,false]);await respond(page,1,old);
 await page.evaluate(()=>{const search=window.inputFixture.surface.references.search;search.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));search.value='composed';search.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));search.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter'}));});s=await state(page,fact);assert.equal(s.requests.length,2);assert.equal(atoms(s).length,0);
 await page.evaluate(()=>{const search=window.inputFixture.surface.references.search;search.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));search.dispatchEvent(new InputEvent('input',{bubbles:true}));});s=await state(page,fact);assert.equal(s.requests.length,3);assert.equal(s.requests[2].query,'composed');await respond(page,2,fresh);await page.getByRole('menuitem').click();s=await state(page,fact);assert.equal(atoms(s)[0].runs[0].text,fresh[0].label);
}));
test('unknown labels copy as plain text and internal clipboard round-trip keeps host identity',()=>probe('clipboard-fallback',async(page,fact)=>{
 await open(page);await respond(page,0,fresh);await page.getByRole('menuitem').click();
 const copied=await page.evaluate(()=>{const f=window.inputFixture,atom=f.engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.reference');f.select(atom.id,0,atom.runs[0].text.length);const data={};f.root.dispatchEvent(preparedClipboardEvent('copy',{setData:(m,v)=>data[m]=v,getData:m=>data[m]??''}));return data;});assert.equal(copied['text/plain'],fresh[0].label);assert.deepEqual(JSON.parse(copied['application/x-edit-ac-fragment+json']).blocks[0].attributes.tuple,['module:editac.reference',1,fresh[0]]);
 await page.evaluate(data=>{const f=window.inputFixture;f.select(f.ids[1],0);f.root.dispatchEvent(preparedClipboardEvent('paste',{getData:m=>data[m]??''}));},copied);const s=await state(page,fact);assert.equal(atoms(s).length,2);for(const atom of atoms(s)){assert.deepEqual(atom.blockAttributes,['module:editac.reference',1,fresh[0]]);assert.equal(atom.runs[0].text,fresh[0].label);}assert.equal(s.requests.length,1);
}));
