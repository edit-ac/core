// Reuse the reviewed INT-1.9 input policy verbatim in the same canonical command.
import './interactions/slash.spec.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const engine=process.env.EDITAC_SLASH_CONTEXT_BROWSER??'chromium';
const {probe:rawProbe,facts}=browserHarness('slash-context','fixtures/browser-slash',{
 assertSourcesUnchanged:true,contextOptions:engine==='firefox'?{}:{hasTouch:true},sourcePaths:[
 'fixtures/browser-slash/session.mjs','fixtures/browser-slash/index.html','packages/web/src/modules/slash.ts',
 'packages/web/src/surface.ts','packages/web/src/dom/selection.ts','packages/web/src/input/keyboard.ts',
 'packages/web/src/input/composition.ts','scripts/build-wasm.mjs','tests/browser/interactions/slash.spec.ts','tests/browser/interactions/slash-target-cases.ts',
 'tests/browser/slash-cases.ts','packages/web/dist/modules/slash.js','packages/core/dist/wasm/editac_wasm_bg.wasm']});
facts.binding={gate:'RCH-1.16',baseline:'INT-1.9 SLH-01–07 composed by import',catalog:500,
 provenance:'Headless browser, production packed WASM and recovered Session/IndexedDB. Accessibility-tree/live-region readiness is a tested portable equivalent; no spoken AT, physical touch/device or general performance qualification.'};
const probe=(name,action,text='')=>rawProbe(name,action,{text,catalog:true});
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(before,after){for(const key of ['nodes','history','journal','commands','patches'])assert.deepEqual(after[key],before[key],key);}
async function clear(page){await page.keyboard.press('Escape');await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],0,f.engine.read().visible[0].runs.map(r=>r.text).join('').length);});await page.keyboard.press('Backspace');}

test('500 registrations are frozen and bounded; 501 is rejected',()=>probe('catalog-bound',async(page,fact)=>{
 await page.keyboard.type('/');assert.equal(await page.locator('[role=menuitem][data-command]').count(),500);
 const result=await page.evaluate(async()=>{const {slashCommands}=await import('/web/index.js');const commands=Array.from({length:501},(_,i)=>({id:`test-${i}`,label:`Test ${i}`,prepare:()=>undefined}));try{slashCommands(commands);return false;}catch{return true;}});assert.equal(result,true);
 const before=await state(page,fact);assert.equal(before.status,'500 slash commands. Catalog 000.');
 await page.keyboard.press('Escape');unchanged(before,await state(page,fact));
}));
test('500-command filtering matches normalized labels and keywords, with disabled and empty result states',()=>probe('filter-keyword',async(page,fact)=>{
 await page.keyboard.type('/NeEdLe');assert.equal(await page.locator('[role=menuitem][data-command]').count(),3);
 assert.deepEqual(await page.locator('[role=menuitem][data-command]').evaluateAll(items=>items.map(i=>i.getAttribute('data-command'))),['catalog-0','catalog-249','catalog-493']);
 assert.equal(await page.locator('[data-command=catalog-249]').getAttribute('aria-disabled'),'true');
 await page.keyboard.press('ArrowDown');assert.equal((await state(page,fact)).active,'catalog-493');
 await page.keyboard.press('Home');assert.equal((await state(page,fact)).active,'catalog-0');
 await clear(page);await page.keyboard.type('/Catalog');assert.equal(await page.locator('[role=menuitem][data-command]').count(),494);
 await clear(page);await page.keyboard.type('/absent');const before=await state(page,fact);
 await page.keyboard.press('Enter');unchanged(before,await state(page,fact));assert.equal(await page.locator('[role=menuitem][data-command]').count(),0);
}));
for(const mode of ['pointer','touch','keyboard'])test(`large catalog ${mode} picks exact command, one undo group and durable source`,()=>probe(`activation-${mode}`,async(page,fact)=>{
 await page.keyboard.type('/Needle');const before=await state(page,fact),item=page.locator('[data-command=catalog-493]');
 if(mode==='touch')await page.evaluate(()=>{window.touchTrace=[];for(const type of ['pointerdown','pointerup','touchstart','touchend','click','focusin','focusout'])document.addEventListener(type,event=>window.touchTrace.push({type,target:event.target?.getAttribute?.('data-command'),pointer:event.pointerType,active:document.activeElement?.getAttribute('data-command'),time:performance.now()}),true);});
 if(mode==='pointer')await item.click();
 else if(mode==='keyboard'){await page.keyboard.press('End');await page.keyboard.press('Enter');}
 else if(engine!=='firefox'){await item.tap();fact.touch='Playwright touchscreen in touch-enabled virtual browser';}
 else {await item.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,bubbles:true,cancelable:true});await item.click();fact.touch='Firefox tested pointerType touch plus activation equivalent; Firefox has no Playwright touch context';}
 if(mode==='touch'){try{await page.waitForFunction(()=>window.inputFixture.engine.read().visible[0].runs.map(r=>r.text).join('')==='catalog result 493',undefined,{timeout:5000});}finally{fact.touchEvents=await page.evaluate(()=>window.touchTrace);}}
 const after=await state(page,fact);assert.equal(after.text[0],'catalog result 493');assert.equal(after.text[1],'independent');assert.equal(after.focus,true);assert.equal(after.selection.focus.offset,18);
 assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.commands.length,before.commands.length+1);assert.equal(after.journal.length,before.journal.length+1);assert.equal(after.patches.length,before.patches.length+1);
 assert.equal(after.commands.at(-1).origin,'slash:catalog-493');
 await page.keyboard.press('ControlOrMeta+z');const undone=await state(page,fact);assert.equal(undone.text[0],'/Needle');assert.equal(undone.selection.focus.offset,7);
 await page.keyboard.press('ControlOrMeta+Shift+z');assert.equal((await state(page,fact)).text[0],'catalog result 493');
 const restored=await page.evaluate(()=>window.inputFixture.reopen());assert.equal(restored[0].runs.map(r=>r.text).join(''),'catalog result 493');fact.reopened=restored;
}));
test('large catalog touch control opens literal query, restores selection on Escape and commits one command',()=>probe('touch-explicit',async(page,fact)=>{
 const before=await state(page,fact);assert.equal(before.open,false);const control=page.getByRole('button',{name:'Slash commands',exact:true});
 async function open(){
  if(engine==='firefox'){await control.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,bubbles:true,cancelable:true});await control.click();fact.touch='Firefox pointerType touch plus click equivalent';}
  else {await control.tap();fact.touch='Playwright touchscreen in touch-enabled virtual browser';}
  await page.waitForFunction(()=>window.inputFixture.surface.slash.open,undefined,{timeout:5000});
 }
 await open();const opened=await state(page,fact);unchanged(before,opened);assert.equal(opened.active,'catalog-0');assert.equal(opened.query,'Needle');
 await page.keyboard.press('Escape');const escaped=await state(page,fact);unchanged(before,escaped);assert.equal(escaped.focus,true);assert.deepEqual(escaped.selection,before.selection);
 await open();await page.keyboard.press('End');await page.keyboard.press('Enter');const after=await state(page,fact);
 assert.equal(after.text[0],'catalog result 493');assert.equal(after.text[1],'independent');assert.equal(after.focus,true);assert.equal(after.history.undoGroups,before.history.undoGroups+1);
 assert.equal(after.commands.length,before.commands.length+1);assert.equal(after.journal.length,before.journal.length+1);assert.equal(after.patches.length,before.patches.length+1);
 await page.keyboard.press('ControlOrMeta+z');assert.equal((await state(page,fact)).text[0],'/Needle');
},'/Needle'));
for(const mode of ['error','cancel','readonly'])test(`large catalog ${mode} preserves document and selected query`,()=>probe(`preserve-${mode}`,async(page,fact)=>{
 await page.keyboard.type(mode==='error'?'/Error':'/Slow');const before=await state(page,fact);
 await page.keyboard.press('Enter');await page.evaluate(()=>window.inputFixture.settle());
 if(mode==='error')assert.match((await state(page,fact)).status,/failed.*retained/i);
 else {if(mode==='readonly')await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));else await page.keyboard.press('Escape');await page.evaluate(()=>{const f=window.inputFixture;for(const p of f.pending)p.resolve(f.fragment('must not commit'));});}
 await page.evaluate(()=>window.inputFixture.settle());const after=await state(page,fact);unchanged(before,after);assert.deepEqual(after.selection,before.selection);assert.equal(after.focus,true);
}));
test('500-command DOM roles, disabled state and announcements follow bounded filtering and focus',()=>probe('accessible-catalog',async(page,fact)=>{
 for(const query of ['Needle','Catalog','absent']){
  await page.keyboard.type('/'+query);const before=await state(page,fact);
  assert.equal(await page.locator('[role=menu]').getAttribute('aria-label'),'Slash commands');
  assert.equal(await page.locator('[aria-live=polite]').getAttribute('role'),'status');
  assert.equal(await page.locator('[role=menuitem][tabindex="0"]').count(),1);
  if(query==='Needle'){
   await page.keyboard.press('End');assert.equal((await state(page,fact)).status,'3 slash commands. Catalog 493.');
   assert.match(await page.locator('[role=menu]').ariaSnapshot(),/Catalog 249.*disabled/);
  }else if(query==='absent')assert.equal(before.status,'0 slash commands. No enabled command.');
  assert.equal(await page.locator('#projection').getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Escape');unchanged(before,await state(page,fact));
  assert.equal(await page.locator('#projection').getAttribute('aria-expanded'),'false');await clear(page);
 }
}));

for(const mode of ['Enter','Space','pointer','touch'])test(`Close commands ${mode} cancels pending response without accepting the active result`,()=>probe(`close-${mode}`,async(page,fact)=>{
 await page.keyboard.type('/Slow');const before=await state(page,fact);await page.keyboard.press('Enter');
 const close=page.getByRole('menuitem',{name:'Close commands',exact:true});
 if(mode==='pointer')await close.click();
 else if(mode==='touch'){
  if(engine==='firefox'){await close.dispatchEvent('pointerdown',{pointerType:'touch',bubbles:true,cancelable:true});await close.click();fact.touch='Firefox pointerType touch plus click equivalent';}
  else await close.tap();
 }else{await close.focus();await page.keyboard.press(mode);}
 await page.evaluate(()=>{const f=window.inputFixture;for(const p of f.pending)p.resolve(f.fragment('must not commit'));});
 const after=await state(page,fact);unchanged(before,after);assert.equal(after.open,false);assert.equal(after.focus,true);
 assert.deepEqual(after.selection,before.selection);assert.deepEqual(after.aborted,[true]);
 assert.equal(await page.locator('#projection').getAttribute('aria-expanded'),'false');
 assert.equal(await page.getByRole('button',{name:'Slash commands',exact:true}).getAttribute('aria-expanded'),'false');
}));
for(const query of ['absent','Blocked'])test(`explicit ${query} focuses accessible Close and Enter preserves source`,()=>probe(`empty-close-${query}`,async(page,fact)=>{
 const before=await state(page,fact);await page.getByRole('button',{name:'Slash commands',exact:true}).click();
 assert.equal(await page.getByRole('menuitem',{name:'Close commands',exact:true}).evaluate(e=>e===document.activeElement),true);
 assert.equal(await page.locator('[role=menuitem][tabindex="0"]').count(),1);
 await page.keyboard.press('Enter');const after=await state(page,fact);unchanged(before,after);
 assert.equal(after.open,false);assert.equal(after.focus,true);assert.deepEqual(after.selection,before.selection);
},'/'+query));

test('Space on a focused command uses the same atomic command and resulting caret',()=>probe('focused-space',async(page,fact)=>{
 await page.keyboard.type('/Needle');const before=await state(page,fact);await page.locator('[data-command=catalog-493]').focus();
 await page.keyboard.press('Space');const after=await state(page,fact);
 assert.equal(after.text[0],'catalog result 493');assert.equal(after.text[1],'independent');assert.equal(after.focus,true);
 assert.equal(after.selection.focus.offset,18);assert.equal(after.history.undoGroups,before.history.undoGroups+1);
 for(const key of ['commands','patches','journal'])assert.equal(after[key].length,before[key].length+1,key);
 await page.keyboard.press('ControlOrMeta+z');assert.equal((await state(page,fact)).text[0],'/Needle');
}));

for(const tag of ['input','textarea','select','button','editable'])test(`nested ${tag} owns focus and aborts the pending editor command`,()=>probe(`nested-${tag}`,async(page,fact)=>{
 await page.keyboard.type('/Slow');await page.keyboard.press('Enter');const before=await state(page,fact);
 await page.evaluate(tag=>{const f=window.inputFixture,wrapper=document.createElement('div');wrapper.contentEditable='false';wrapper.dataset.editacUi='';
  const target=document.createElement(tag==='editable'?'div':tag);target.id='nested-slash-control';
  if(tag==='editable'){target.contentEditable='true';target.tabIndex=0;}else if(tag==='select')target.add(new Option('owned','owned'));
  wrapper.append(target);f.root.append(wrapper);target.focus();
 },tag);
 await page.evaluate(()=>{const f=window.inputFixture;for(const p of f.pending)p.resolve(f.fragment('must not commit'));});
 const after=await state(page,fact);unchanged(before,after);assert.equal(after.open,false);assert.deepEqual(after.aborted,[true]);
 assert.equal(await page.locator('#nested-slash-control').evaluate(e=>e===document.activeElement),true);
}));
