import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from '../browser-harness.ts';
const {probe:rawProbe,facts}=browserHarness('interaction-history','fixtures/browser-history',{
 markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/history.spec.ts',sourcePaths:[
 'fixtures/browser-history/session.mjs','fixtures/browser-history/index.html','packages/web/src/surface.ts',
 'packages/web/src/input/keyboard.ts','packages/web/src/commands/formatting.ts','packages/web/src/input/composition.ts',
 'packages/web/src/modules/slash.ts','packages/web/src/clipboard/pending.ts','packages/web/src/storage/writer.ts',
 'packages/web/dist/surface.js','packages/web/dist/input/keyboard.js','packages/core/dist/wasm/editac_wasm_bg.wasm',
 'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm','scripts/test-interactions.mjs'],
 beforeNavigate:async page=>page.addInitScript(()=>{
  const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener,records=[];
  EventTarget.prototype.addEventListener=function(type,listener,options){const capture=typeof options==='boolean'?options:!!options?.capture;if(!records.some(r=>r.target===this&&r.type===type&&r.listener===listener&&r.capture===capture))records.push({target:this,type,listener,capture});return add.call(this,type,listener,options);};
  EventTarget.prototype.removeEventListener=function(type,listener,options){const capture=typeof options==='boolean'?options:!!options?.capture;const i=records.findIndex(r=>r.target===this&&r.type===type&&r.listener===listener&&r.capture===capture);if(i>=0)records.splice(i,1);return remove.call(this,type,listener,options);};
  window.listenerRecords=records;
 })});
facts.binding={gate:'INT-1.12',ids:['HIS-01','HIS-02','HIS-03','HIS-04','HIS-05'],provenance:'Packed current WASM/Session, production surface/Markdown/slash/IndexedDB. Trusted browser keys/pointer; prepared clipboard/composition and deterministic peer updates. No native OS/AT qualification.',profile:{os:process.platform,arch:process.arch,layout:'1280x720 headless default'}};
const mod=process.platform==='darwin'?'Meta':'Control';
function probe(name,action,value='alpha'){return rawProbe(name,async(page,fact)=>{fact.caseIds=[name.slice(0,6)];await action(page,fact);},value);}
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(a,b){for(const key of ['nodes','history','commands','journal','patches','revision'])assert.deepEqual(b[key],a[key],key);}
function delta(a,b,n){assert.equal(b.journal.length-a.journal.length,n,'durable updates');assert.equal(b.patches.filter(p=>p.update).length-a.patches.filter(p=>p.update).length,n,'emitted updates');}
async function select(page,a,b=a){await page.evaluate(({a,b})=>{const f=window.inputFixture;f.select(f.ids[0],a,b);},{a,b});}
async function control(page,action,route){
 if(route==='keyboard'){await page.keyboard.press(`${mod}+${action==='undo'?'z':'Shift+z'}`);return;}
 await page.evaluate(({action,route})=>{const f=window.inputFixture,button=document.createElement('button');button.textContent=`${action} ${route}`;if(route==='menu')button.setAttribute('role','menuitem');let target;
 const capture=()=>{target?.dispose();target=f.surface.captureHistory();};button.addEventListener('pointerdown',capture);
 button.addEventListener('click',()=>{try{window.historyResult=target?.execute(action);}finally{target?.dispose();button.remove();}});
 document.body.append(button);if(route==='menu'){capture();button.focus();}},{action,route});
 if(route==='menu')await page.keyboard.press('Enter');else await page.getByRole('button',{name:`${action} ${route}`,exact:true}).click();
 assert.equal(await page.evaluate(()=>window.historyResult?.disposition),'committed');
}
async function intent(page,kind,fact){
 if(kind==='format'){await select(page,1,4);const before=await state(page,fact);await page.keyboard.press(`${mod}+b`);return before;}
 if(kind==='slash'){await select(page,0);await page.keyboard.type('/Alpha');const before=await state(page,fact);await page.keyboard.press('Enter');return before;}
 const before=await state(page,fact);
 if(kind==='split')await page.keyboard.press('Enter');
 if(kind==='paste')await page.evaluate(()=>window.inputFixture.paste(' é😀\nnext'));
 if(kind==='composition')await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionstart');f.event('beforeinput',{inputType:'insertCompositionText',data:'語',isComposing:true,cancelable:true});const block=f.root.querySelector('[data-node-id]');block.textContent='alpha語';const n=block.firstChild;getSelection().setBaseAndExtent(n,6,n,6);f.event('input',{inputType:'insertCompositionText',data:'語',isComposing:true});f.event('compositionend',{data:'語'});});
 return before;
}
for(const kind of ['format','split','paste','composition','slash'])for(const route of ['keyboard','menu','toolbar'])test(`HIS-01 ${kind} grouped undo and redo via ${route}`,()=>probe(`HIS-01-${kind}-${route}`,async(page,fact)=>{
 const before=await intent(page,kind,fact),after=await state(page,fact);delta(before,after,1);assert.equal(after.history.undoGroups,before.history.undoGroups+1);
 if(kind==='format')assert.ok(after.nodes[0].runs.some(r=>r.attributes.bold));
 if(kind==='split')assert.deepEqual(after.text,['alpha','','independent']);
 if(kind==='paste')assert.deepEqual(after.text,['alpha é😀\nnext','independent']);
 if(kind==='composition')assert.equal(after.text[0],'alpha語');
 if(kind==='slash')assert.equal(after.text[0],'chosen');
 await control(page,'undo',route);const undone=await state(page,fact);assert.deepEqual(undone.nodes,before.nodes);assert.deepEqual(undone.selection,kind==='slash'?{anchor:{...before.selection.anchor,offset:0},focus:before.selection.focus}:before.selection);delta(after,undone,1);assert.equal(undone.history.redoGroups,1);
 await control(page,'redo',route);const redone=await state(page,fact);assert.deepEqual(redone.nodes,after.nodes);assert.deepEqual(redone.selection,after.selection);delta(undone,redone,1);
 const restored=await page.evaluate(()=>window.inputFixture.reopen());assert.deepEqual(restored,redone.nodes);
},kind==='slash'?'':'alpha'));
for(const kind of ['typing','format','split'])test(`HIS-02 remote insertion survives ${kind} undo redo`,()=>probe(`HIS-02-${kind}`,async(page,fact)=>{
 if(kind==='typing')await page.keyboard.type('L');else await intent(page,kind,fact);
 const local=await state(page,fact);await page.evaluate(()=>window.inputFixture.remote(0,'R'));const remote=await state(page,fact);assert.equal(remote.history.undoGroups,local.history.undoGroups);assert.equal(remote.patches.length,local.patches.length+1);
 await control(page,'undo','keyboard');const undo=await state(page,fact);assert.equal(undo.text[0],'Ralpha');assert.deepEqual(undo.text,['Ralpha','independent']);delta(remote,undo,1);
 await control(page,'redo','menu');const redo=await state(page,fact);assert.ok(redo.text[0].startsWith('R'));assert.deepEqual(redo.text,local.text.map((s,i)=>i===0?'R'+s:s));delta(undo,redo,1);
}));
for(const action of ['undo','redo'])for(const mode of ['readonly','stale','cancel','disposed','redirect'])test(`HIS-03 captured ${action} rejects ${mode}`,()=>probe(`HIS-03-${action}-${mode}`,async(page,fact)=>{
 await page.keyboard.type('L');if(action==='redo'){await control(page,'undo','keyboard');await state(page,fact);}
 await page.evaluate(()=>{window.target=window.inputFixture.surface.captureHistory();});
 if(mode==='readonly')await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));
 if(mode==='stale')await page.evaluate(()=>window.inputFixture.remote(0,'R'));
 if(mode==='cancel')await page.evaluate(()=>window.target.dispose());
 if(mode==='disposed')await page.evaluate(()=>window.inputFixture.disposeSurface());
 if(mode==='redirect'){await page.evaluate(()=>window.inputFixture.second());await page.locator('#second').click();}
 const before=await state(page,fact),focus=await page.evaluate(()=>document.activeElement.id);
 assert.equal(await page.evaluate(action=>window.target.execute(action).disposition,action),'rejected');
 unchanged(before,await state(page,fact));assert.equal(await page.evaluate(()=>document.activeElement.id),focus);await page.evaluate(()=>window.target.dispose());
}));
for(const path of ['toolbar','paste','slash','keyboard'])test(`HIS-03 late read-only prevents ${path}`,()=>probe(`HIS-03-readonly-${path}`,async(page,fact)=>{
 if(path==='slash'){await select(page,0);await page.keyboard.type('/Slow');await page.keyboard.press('Enter');}
 if(path==='toolbar')await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],1,4);window.target=f.surface.captureToolbar();});
 await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));const before=await state(page,fact);
 if(path==='toolbar')assert.equal(await page.evaluate(()=>window.target.format('bold').disposition),'rejected');
 if(path==='paste')await page.evaluate(()=>window.inputFixture.paste('forbidden'));
 if(path==='keyboard'){await page.keyboard.press(`${mod}+b`);await page.keyboard.press(`${mod}+z`);}
 if(path==='slash')await page.evaluate(()=>window.inputFixture.pending[0].resolve(window.inputFixture.fragment('forbidden')));
 unchanged(before,await state(page,fact));if(path==='toolbar')await page.evaluate(()=>window.target.dispose());
},path==='slash'?'':'alpha'));
for(const mode of ['readonly','dispose','focus','remote'])test(`HIS-04 delayed slash cancels on ${mode}`,()=>probe(`HIS-04-slash-${mode}`,async(page,fact)=>{
 await select(page,0);await page.keyboard.type('/Slow');await page.keyboard.press('Enter');await page.evaluate(()=>window.inputFixture.second());
 if(mode==='readonly')await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));
 if(mode==='dispose')await page.evaluate(()=>window.inputFixture.disposeSurface());
 if(mode==='focus')await page.locator('#second').click();
 if(mode==='remote')await page.evaluate(()=>window.inputFixture.remoteDelete(0,5));
 const before=await state(page,fact),focus=await page.evaluate(()=>document.activeElement.id),other=await page.evaluate(()=>window.inputFixture.others[0].session.writer.engine.read().visible);
 await page.evaluate(()=>window.inputFixture.pending[0].resolve(window.inputFixture.fragment('late')));unchanged(before,await state(page,fact));assert.equal(await page.evaluate(()=>document.activeElement.id),focus);assert.deepEqual(await page.evaluate(()=>window.inputFixture.others[0].session.writer.engine.read().visible),other);
},''));
test('HIS-04 two editor teardown releases listeners and retained targets',()=>probe('HIS-04-teardown',async(page,fact)=>{
 await page.evaluate(()=>window.inputFixture.second());await page.evaluate(()=>{window.target=window.inputFixture.surface.captureHistory();window.formatTarget=window.inputFixture.surface.captureToolbar();});
 await page.evaluate(()=>window.inputFixture.destroy());
 const result=await page.evaluate(()=>({history:window.target.active,format:window.formatTarget.active,help:document.querySelectorAll('[id^="editac-keyboard-help"]').length,listeners:window.listenerRecords.filter(r=>r.target===document||r.target.id==='projection'||r.target.id==='second').map(r=>({type:r.type,id:r.target.id??'document'}))}));fact.teardown=result;assert.equal(result.history,false);assert.equal(result.format,false);assert.equal(result.help,0);assert.deepEqual(result.listeners,[]);
}));
for(const mode of ['invalid-prepared','boundary','empty-history','bad-link'])test(`HIS-05 ${mode} is atomic and actionable`,()=>probe(`HIS-05-${mode}`,async(page,fact)=>{
 await select(page,0);const before=await state(page,fact);
 if(mode==='invalid-prepared'){const result=await page.evaluate(()=>{const f=window.inputFixture;try{f.engine.prepare({kind:'editor',origin:'malformed-fixture',commands:[{type:'replaceAt',owner:f.ids[0],from:0,to:1,text:'changed'},{type:'replaceAt',owner:'missing',from:0,to:1,text:'bad'}]});return null;}catch(e){return String(e);}});fact.diagnostic=result;assert.ok(result);}
 if(mode==='boundary')await page.keyboard.press('Backspace');
 if(mode==='empty-history'){await page.keyboard.press(`${mod}+z`);await page.keyboard.press(`${mod}+Shift+z`);}
 if(mode==='bad-link'){const result=await page.evaluate(()=>{const t=window.inputFixture.surface.captureToolbar();try{return t.apply({link:'javascript:alert(1)'});}finally{t.dispose();}});fact.diagnostic=result;assert.equal(result.disposition,'rejected');assert.ok(result.reason);}
 const after=await state(page,fact);unchanged(before,after);assert.deepEqual(after.selection,before.selection);
}));
for(const focus of ['second'])test(`HIS-04 captured formatting cannot reclaim ${focus} focus`,()=>probe(`HIS-04-format-${focus}`,async(page,fact)=>{
 await select(page,1,4);await page.evaluate(()=>{window.target=window.inputFixture.surface.captureToolbar();});
 if(focus==='second'){await page.evaluate(()=>window.inputFixture.second());await page.locator('#second').click();}
 else {await page.evaluate(()=>{const input=document.createElement('input');input.id='host';document.body.append(input);});await page.locator('#host').click();}
 const before=await state(page,fact),active=await page.evaluate(()=>document.activeElement.id);assert.equal(await page.evaluate(()=>window.target.format('bold').disposition),'rejected');unchanged(before,await state(page,fact));assert.equal(await page.evaluate(()=>document.activeElement.id),active);await page.evaluate(()=>window.target.dispose());
}));
for(const route of ['keyboard','menu','toolbar'])test(`HIS-01 finalized composition history remains distinct from later formatting ${route}`,()=>probe(`HIS-01-composition-format-${route}`,async(page,fact)=>{
 const before=await intent(page,'composition',fact),composed=await state(page,fact);await select(page,0,6);await page.keyboard.press(`${mod}+b`);const formatted=await state(page,fact);delta(composed,formatted,1);assert.equal(formatted.history.undoGroups,2);
 await control(page,'undo',route);let s=await state(page,fact);assert.deepEqual(s.nodes,composed.nodes);assert.equal(s.history.undoGroups,1);
 await control(page,'undo',route);s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.equal(s.history.undoGroups,0);
 await control(page,'redo',route);await state(page,fact);await control(page,'redo',route);assert.deepEqual((await state(page,fact)).nodes,formatted.nodes);
}));
for(const route of ['menu','toolbar'])test(`HIS-01 pending marks survive successful ${route} history and next typing`,()=>probe(`HIS-01-pending-${route}`,async(page,fact)=>{
 await page.keyboard.press(`${mod}+b`);const pending=await state(page,fact);assert.equal(pending.history.undoGroups,0);assert.equal(pending.journal.length,0);
 await page.keyboard.type('X');const typed=await state(page,fact);assert.ok(typed.nodes[0].runs.at(-1).attributes.bold);
 await control(page,'undo',route);const undone=await state(page,fact);assert.deepEqual(undone.nodes,pending.nodes);await control(page,'redo',route);assert.deepEqual((await state(page,fact)).nodes,typed.nodes);
 await page.keyboard.type('Y');const next=await state(page,fact);assert.equal(next.text[0],'alphaXY');assert.ok(next.nodes[0].runs.at(-1).attributes.bold);
}));
test('HIS-03 rejected collapsed formatting cannot install pending marks',()=>probe('HIS-03-pending-readonly',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;window.target=f.surface.captureToolbar();f.surface.setReadOnly(true);});const before=await state(page,fact);assert.equal(await page.evaluate(()=>window.target.format('bold').disposition),'rejected');unchanged(before,await state(page,fact));
 await page.evaluate(()=>{window.target.dispose();window.inputFixture.surface.setReadOnly(false);});await page.keyboard.type('X');const s=await state(page,fact);assert.equal(s.text[0],'alphaX');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));delta(before,s,1);
}));
