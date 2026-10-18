import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe,facts}=browserHarness('assistive-presenter','fixtures/browser-assistive-presenter',{
 markdown:true,assertSourcesUnchanged:true,sourcePaths:[
 'packages/core/src/extensions/assistive-input.ts','packages/web/src/modules/assistive-input.ts',
 'packages/web/src/input/text.ts','packages/web/src/input/keyboard.ts','packages/web/src/dom/selection.ts',
 'packages/web/src/editor.ts','packages/web/src/surface.ts','packages/web/src/index.ts','packages/web/src/modules/index.ts',
 'fixtures/browser-assistive-presenter/session.mjs','fixtures/browser-assistive-presenter/index.html',
 'packages/web/dist/modules/assistive-input.js','packages/core/dist/wasm/editac_wasm_bg.wasm']
});
facts.binding={gate:'AIN-1.2',scope:'Installed production BrowserEditor/Session/WASM/IndexedDB/shared history and anchors; trusted keyboard/pointer controls, prepared status/permission/composition/peer fixtures. Structural accessibility only; no OS dictation, microphone, provider, device or screen-reader qualification.'};
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);return s;}
async function select(page,a=1,b=4){await page.evaluate(({a,b})=>{const f=window.inputFixture;f.select(f.ids[0],a,b);},{a,b});}
function unchanged(a,b,selection=true){for(const k of ['nodes','revision','history','journal','commands','patches',...(selection?['selection']:[])])assert.deepEqual(b[k],a[k],k);}
async function status(page,state='active',message='Assistance active',provisional='PRIVATE TRANSCRIPT'){
 await page.evaluate(({state,message,provisional})=>window.editor.assistive.update({version:1,state,session:{sessionId:'prepared-session',generation:1},reason:null,message,provisional}),{state,message,provisional});
}
async function show(page){await page.getByRole('button',{name:'Editing assistance',exact:true}).click();}
for(const mode of ['absent','disabled'])test(`${mode} extension leaves baseline controls and input intact`,()=>probe(mode,async(page,fact)=>{
 assert.equal(await page.getByRole('button',{name:'Editing assistance',exact:true}).count(),0);
 await select(page,5,5);await page.keyboard.type('!');const s=await state(page,fact);assert.equal(s.text[0],'alpha!');assert.equal(s.assistance,null);
}, {text:'alpha',[mode]:true}));
test('keyboard entry, dedicated search, visible labels, shared command and undo',()=>probe('keyboard-command',async(page,fact)=>{
 await select(page,4,1);const before=await state(page,fact);
 // Use the existing Escape-then-Tab document focus exit; no printable shortcut.
 await page.keyboard.press('Escape');
 const entry=page.getByRole('button',{name:'Editing assistance',exact:true});
 for(let i=0;i<25&&!await entry.evaluate(e=>e===document.activeElement);i++)await page.keyboard.press(i>0&&facts.engine==='webkit'?'Alt+Tab':'Tab');
 assert.equal(await entry.evaluate(e=>e===document.activeElement),true);
 await page.keyboard.press('Enter');const search=page.getByRole('searchbox',{name:'Search assistance commands'});assert.equal(await search.evaluate(e=>e===document.activeElement),true);
 assert.equal(await page.locator('#projection').getAttribute('role'),'textbox');assert.equal(await page.getByRole('combobox').count(),0);
 for(const label of ['Bold','Italic','Undo','Redo','Cancel assistance','Recover assistance','Close assistance'])assert.equal(await page.getByRole('button',{name:label,exact:true}).textContent(),label);
 await search.fill('bold');assert.equal(await page.getByRole('button',{name:'Italic',exact:true}).count(),0);
 await search.press('Enter');const after=await state(page,fact);assert.equal(after.commands.length-before.commands.length,1);assert.equal(after.history.undoGroups-before.history.undoGroups,1);assert.equal(after.journal.length-before.journal.length,1);assert.deepEqual(after.selection,before.selection);assert.equal(after.focus,true);assert.equal(after.text[0],'alpha');assert.ok(after.nodes[0].runs.some(r=>r.attributes.bold));
 await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');assert.deepEqual((await state(page,fact)).nodes,before.nodes);
},'alpha'));
for(const route of ['escape','close','cancel'])test(`${route} keeps backward UTF-16 selection/content/history`,()=>probe(route,async(page,fact)=>{
 await select(page,5,1);const before=await state(page,fact);await show(page);
 if(route==='cancel'){await status(page);await page.getByRole('button',{name:'Cancel assistance',exact:true}).click();assert.deepEqual((await state(page,fact)).hostActions,['cancel']);await page.getByRole('button',{name:'Close assistance',exact:true}).click();}
 else if(route==='close')await page.getByRole('button',{name:'Close assistance',exact:true}).click();else await page.getByRole('searchbox',{name:'Search assistance commands'}).press('Escape');
 const after=await state(page,fact);unchanged(before,after);assert.equal(after.focus,true);assert.equal(after.assistance.open,false);
},'a😊bc'));
test('status transitions are bounded, private provisional updates silent, invalid update atomic',()=>probe('status',async(page,fact)=>{
 await select(page);const before=await state(page,fact);await show(page);await status(page);
 const region=page.locator('[data-assistive-input] [role=status]');assert.equal(await region.getAttribute('aria-live'),'polite');assert.equal(await region.textContent(),'Assistance active');
 await page.evaluate(()=>{const p=window.editor.assistive;window.statusMutations=0;window.statusObserver=new MutationObserver(records=>window.statusMutations+=records.length);window.statusObserver.observe(p.status,{childList:true,subtree:true,characterData:true});});
 await status(page,'active','Assistance active','NEW PRIVATE');await page.evaluate(()=>Promise.resolve());assert.equal(await page.evaluate(()=>window.statusMutations),0);assert.equal(await page.locator('body').textContent().then(t=>t.includes('PRIVATE')),false);
 const rejected=await page.evaluate(()=>{try{window.editor.assistive.update({version:1,state:'failed',session:null,reason:null,message:'x'.repeat(513),provisional:''});return false;}catch{return true;}});assert.equal(rejected,true);assert.equal(await region.textContent(),'Assistance active');
 await status(page,'failed','Permission denied. Use recovery.','');await page.getByRole('button',{name:'Recover assistance',exact:true}).click();assert.deepEqual((await state(page,fact)).hostActions,['recover']);assert.equal(await region.textContent(),'Assistance ready. Select text and try again.');
 await page.getByRole('button',{name:'Close assistance',exact:true}).click();unchanged(before,await state(page,fact));
}));
for(const mode of ['read-only','composition','permission','remote'])test(`captured applicability rejects ${mode} without redirecting`,()=>probe('guard-'+mode,async(page,fact)=>{
 await select(page);await show(page);
 await page.evaluate(async mode=>{const f=window.inputFixture;if(mode==='read-only')window.editor.setReadOnly(true);if(mode==='composition')f.event('compositionstart',{data:''});if(mode==='permission')window.commandPermission=false;if(mode==='remote')await f.remote(0,'R');},mode);
 const before=await state(page,fact);await page.evaluate(()=>window.editor.assistive.activate('bold'));const after=await state(page,fact);unchanged(before,after);assert.equal(after.assistance.applicability.find(c=>c.commandId==='bold').enabled,false);
}));
test('foreign focus and later editor selection are never overridden',()=>probe('foreign-focus',async(page,fact)=>{
 await select(page);await show(page);await page.evaluate(()=>{const i=document.createElement('input');i.setAttribute('aria-label','Other task');document.body.append(i);i.focus();});
 const before=await state(page,fact);await page.evaluate(()=>{window.editor.assistive.close();window.editor.assistive.activate('bold');});const after=await state(page,fact);unchanged(before,after);assert.equal(await page.getByRole('textbox',{name:'Other task'}).evaluate(e=>e===document.activeElement),true);assert.equal(after.assistance.open,false);
 await select(page,0,1);await show(page);await page.getByRole('button',{name:'Bold',exact:true}).click();const edited=await state(page,fact);assert.equal(edited.nodes[0].runs[0].text,'a');assert.equal(edited.nodes[0].runs[0].attributes.bold,true);
}));
for(const mode of ['registration','editor'])test(`${mode} teardown removes UI and late callbacks/listeners are inert`,()=>probe('teardown-'+mode,async(page,fact)=>{
 await select(page);await show(page);const before=await state(page,fact);const audit=await page.evaluate(()=>window.inputFixture.audit());
 await page.evaluate(async mode=>{window.oldPresenter=window.editor.assistive;if(mode==='registration')window.assistiveRegistration.dispose();else await window.inputFixture.destroy();window.oldPresenter.update({version:1,state:'active',session:null,reason:null,message:'late',provisional:'private'});window.oldPresenter.show();window.oldPresenter.activate('bold');window.oldPresenter.dispose();},mode);
 assert.equal(await page.locator('[data-assistive-input]').count(),0);assert.deepEqual(await page.evaluate(()=>window.inputFixture.audit()),audit);if(mode==='registration')unchanged(before,await state(page,fact),false);
}));
test('unsupported host controls explain availability and status-only registration omits commands',()=>probe('unsupported',async(page,fact)=>{
 await show(page);for(const name of ['Cancel assistance','Recover assistance'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
 assert.ok((await page.locator('[data-assistive-input]').textContent()).includes('Host transport is unsupported'));assert.ok((await page.locator('[data-assistive-input]').textContent()).includes('Cancellation is unsupported'));assert.equal(await page.getByRole('button',{name:'Bold',exact:true}).count(),0);
}, {text:'alpha',unsupported:true,statusOnly:true}));

test('shared formatting applicability disables marks in code and empty history with visible reasons',()=>probe('semantic-applicability',async(page,fact)=>{
 await select(page,1,4);const before=await state(page,fact);await show(page);
 for(const label of ['Bold','Italic','Undo','Redo']){
  const button=page.getByRole('button',{name:label,exact:true});assert.equal(await button.isDisabled(),true);
  const reason=await button.getAttribute('aria-describedby');assert.match(await page.locator('#'+reason).textContent(),/Command unavailable/);
 }
 await page.getByRole('button',{name:'Close assistance',exact:true}).click();unchanged(before,await state(page,fact));
},{text:'alpha',code:true}));
