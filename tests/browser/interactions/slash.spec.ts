import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from '../browser-harness.ts';
import {registerSlashCases} from '../slash-cases.ts';
import {registerSlashTargetCases} from './slash-target-cases.ts';
const {probe:rawProbe,facts}=browserHarness('interaction-slash','fixtures/browser-slash',{
 assertSourcesUnchanged:true,testFile:'tests/browser/interactions/slash.spec.ts',sourcePaths:[
 'tests/browser/slash-cases.ts','tests/browser/interactions/slash-target-cases.ts','fixtures/browser-slash/session.mjs','fixtures/browser-slash/index.html',
 'packages/web/src/modules/slash.ts','packages/web/src/input/text.ts','packages/web/src/input/composition.ts',
 'packages/web/src/input/keyboard.ts','packages/web/src/dom/selection.ts','packages/web/src/dom/render.ts',
 'packages/web/src/surface.ts','packages/web/src/sync/session.ts','scripts/test-interactions.mjs',
 'packages/web/dist/modules/slash.js','packages/core/dist/wasm/editac_wasm_bg.wasm']});
facts.binding={gate:'INT-1.9',ids:['SLH-01','SLH-02','SLH-03','SLH-04','SLH-05','SLH-06','SLH-07'],
 provenance:'Deterministic recovered Session/IndexedDB, current packed WASM, production mountEditorSurface and MOD-1.4 SlashPresenter. Playwright typing/pointer/focus and prepared deferred host actions; no actual AT/OS/device qualification.',
 profile:{os:process.platform,arch:process.arch,layout:'1280x720 headless default keyboard'}};
const groups={eligible:['01'], 'boundary-selection':['01'],'provenance':['02'],'context':['01'],
 'keyboard-history':['03','07'],'pointer-focus':['07'],'composite-explicit':['07'],
 'escape-backspace':['04','05'],'empty-dispatch':['03','04'],'cancellation':['04','05'],
 'ime-priority':['02','04'],'async-stale':['06'],'async-teardown':['05','06'],
 'editor-command':['07'],'bounds-paste':['02','05'],'invalid-command':['06'],
 'focused-item':['03','07'],'focused-editing':['04','05'],'keyboard-explicit':['07'],
 literal:['01'],'list-focus-escape':['04']};
function probe(name,action,text='') {return rawProbe(name,async(page,fact)=>{
 fact.caseIds=name.startsWith('SLH-')?[name.slice(0,6)]:(groups[name]??(name.startsWith('excluded-')?['01']:[])).map(n=>`SLH-${n}`);
 assert.ok(fact.caseIds.length,'Every canonical execution maps to an original SLH criterion');
 await action(page,fact);
},text);}
registerSlashCases(probe);
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function unchanged(a,b){for(const key of ['text','nodes','history','commands','journal','patches'])assert.deepEqual(b[key],a[key],key);}
async function choose(page,text='/Al'){await page.keyboard.type(text);}
async function positions(page){return page.evaluate(()=>window.inputFixture.state().then(s=>s.selection));}

for(const key of ['ArrowDown','ArrowUp','Home','End'])test(`SLH-03 menu ${key} exposes exactly one enabled active result`,()=>probe(`SLH-03-active-${key}`,async(page,fact)=>{
 await choose(page,'/');const before=await state(page,fact);
 assert.equal(await page.locator('[data-active=true]').getAttribute('data-command'),'alpha');
 await page.locator('[data-command=blocked]').focus();
 assert.equal(await page.locator('[data-active=true]').count(),0);
 await page.keyboard.press(key);const expected=key==='ArrowUp'||key==='End'?'zulu':'alpha';
 assert.equal(await page.locator('[data-active=true]').getAttribute('data-command'),expected);
 assert.equal(await page.locator('[role=menuitem][tabindex="0"]').count(),1);
 assert.equal(await page.locator('[data-active=true]').getAttribute('aria-disabled'),'false');
 assert.equal((await state(page,fact)).active,expected);unchanged(before,await state(page,fact));
 assert.equal(await page.locator('[aria-activedescendant]').count(),0,'Roving-focus menu does not mix combobox ARIA');
}));
for(const text of ['/NoMatch','/Blocked'])test(`SLH-03 ${text} repeated navigation and Enter has zero effects`,()=>probe(`SLH-03-empty-${text.slice(1)}`,async(page,fact)=>{
 await choose(page,text);const before=await state(page,fact);
 for(const key of ['Home','End','ArrowUp','ArrowDown','Enter','Enter'])await page.keyboard.press(key);
 const after=await state(page,fact);unchanged(before,after);assert.equal(after.open,true);assert.equal(await page.locator('[data-active=true]').count(),0);assert.match(after.status,/No enabled command/);
}));
for(const mode of ['pointer','internal-focus','keyboard'])test(`SLH-07 ${mode} activation has exact caret and one reversible command`,()=>probe(`SLH-07-parity-${mode}`,async(page,fact)=>{
 await choose(page);const before=await state(page,fact);
 if(mode==='pointer')await page.locator('[data-command=alpha]').click();
 else {if(mode==='internal-focus')await page.locator('[data-command=alpha]').focus();await page.keyboard.press('Enter');}
 const after=await state(page,fact);assert.equal(after.text[0],'chosen');assert.equal(after.text[1],'independent');assert.equal(after.history.undoGroups,before.history.undoGroups+1);
 assert.equal(after.selection.anchor.offset,6);assert.deepEqual(after.selection.anchor,after.selection.focus);assert.equal(after.focus,true);
 assert.equal(after.commands.filter(c=>c.origin==='slash:alpha').length,1);assert.equal(after.journal.length,before.journal.length+1);
 await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
 const undone=await state(page,fact);assert.deepEqual(undone.text,before.text);assert.deepEqual(undone.selection,{anchor:{node:before.selection.anchor.node,offset:0},focus:{node:before.selection.focus.node,offset:3}},'Fragment undo selects its restored semantic replacement range');assert.equal(undone.open,false);
 await page.keyboard.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');
 const redone=await state(page,fact);assert.deepEqual(redone.text,after.text);assert.deepEqual(redone.selection,after.selection);
}));
for(const key of ['Tab','Shift+Tab'])for(const from of ['root','menu'])test(`SLH-04 ${key} from ${from} dismisses and takes normal focus route`,()=>probe(`SLH-04-tab-${key}-${from}`,async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;const before=document.createElement('button');before.id='before';before.tabIndex=0;before.textContent='Before';f.root.before(before);});
 await choose(page);if(from==='menu')await page.keyboard.press('ArrowDown');const before=await state(page,fact);
 await page.keyboard.press(key);const after=await state(page,fact);unchanged(before,after);assert.equal(after.open,false);assert.equal(after.focus,false);
 if(key==='Shift+Tab')assert.equal(await page.evaluate(()=>document.activeElement.id),'before');
 else assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Slash commands');
 assert.equal(await page.locator('[data-active=true]').count(),0);assert.equal(await page.locator('#projection').getAttribute('aria-expanded'),'false');
}));
for(const reason of ['caret','selection','blur','readonly','trigger-delete'])test(`SLH-05 ${reason} cancels deferred action without stale commit`,()=>probe(`SLH-05-cancel-${reason}`,async(page,fact)=>{
 await choose(page,'/Slow');await page.keyboard.press('Enter');
 await page.evaluate(reason=>{const f=window.inputFixture;if(reason==='caret')f.select(f.ids[1],0);else if(reason==='selection')f.select(f.ids[0],0,2);else if(reason==='blur'){const b=document.createElement('button');document.body.append(b);b.focus();}else if(reason==='readonly')f.surface.setReadOnly(true);},reason);
 if(reason==='trigger-delete'){await page.evaluate(()=>window.inputFixture.select(window.inputFixture.ids[0],0,5));await page.keyboard.press('Backspace');}
 const before=await state(page,fact);assert.equal(before.open,false);assert.deepEqual(before.aborted,[true]);
 await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});const after=await state(page,fact);unchanged(before,after);assert.equal(after.activeControl,before.activeControl);
}));
test('SLH-06 remote deletion of trigger rejects delayed response',()=>probe('SLH-06-remote-trigger',async(page,fact)=>{
 await choose(page,'/Slow');await page.keyboard.press('Enter');await page.evaluate(()=>window.inputFixture.remoteDelete(0,1));const before=await state(page,fact);assert.equal(before.text[0],'Slow');assert.equal(before.open,false);assert.deepEqual(before.aborted,[true]);
 await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});unchanged(before,await state(page,fact));
}));
for(const order of ['old-first','new-first'])test(`SLH-06 ${order} response ordering commits only the current generation`,()=>probe(`SLH-06-reorder-${order}`,async(page,fact)=>{
 await choose(page,'/Slow');await page.keyboard.press('Enter');await page.keyboard.type('x');await page.keyboard.press('Backspace');await page.keyboard.press('Enter');const before=await state(page,fact);assert.deepEqual(before.aborted,[true,false]);
 if(order==='old-first'){await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});unchanged(before,await state(page,fact));}
 await page.evaluate(()=>{const f=window.inputFixture;f.pending[1].resolve(f.fragment('CURRENT'));});let after=await state(page,fact);assert.equal(after.text[0],'CURRENT');assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.commands.filter(c=>c.origin==='slash:slow').length,1);
 if(order==='new-first'){await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});unchanged(after,await state(page,fact));}
}));
test('SLH-06 host commit rejection keeps query and closes explicit history mode before subsequent typing',()=>probe('SLH-06-host-reject',async(page,fact)=>{
 await choose(page);const before=await state(page,fact);await page.evaluate(()=>window.inputFixture.setCommitFailure(true));await page.keyboard.press('Enter');const failed=await state(page,fact);unchanged(before,failed);assert.equal(failed.open,true);assert.match(failed.status,/failed.*retained/i);
 await page.keyboard.press('Escape');await page.keyboard.type('x');const typed=await state(page,fact);assert.equal(typed.text[0],'/Alx');
 await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');const undone=await state(page,fact);assert.equal(undone.text[0],'/Al');
}));
test('SLH-06 explicit editor result selection survives commit and history',()=>probe('SLH-06-result-selection',async(page,fact)=>{
 await choose(page,'/Slow');await page.keyboard.press('Enter');await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve({type:'editor',commands:[{type:'replaceAt',owner:f.ids[0],from:0,to:0,text:'result'},{type:'selectionAt',anchor:{owner:f.ids[0],offset:1,bias:'right'},focus:{owner:f.ids[0],offset:4,bias:'left'}}]});});
 const s=await state(page,fact);assert.equal(s.text[0],'result');assert.equal(s.selection.anchor.offset,1);assert.equal(s.selection.focus.offset,4);assert.equal(s.focus,true);
}));

registerSlashTargetCases(probe);
