import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';
const {probe,facts}=browserHarness('interaction-command-surfaces','fixtures/browser-command-surfaces',{
 markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/command-surfaces.spec.ts',
 sourcePaths:['packages/web/src/commands/catalog.ts','packages/web/src/input/keyboard.ts','packages/web/src/surface.ts','packages/web/src/modules/search.ts','packages/web/src/editor.ts','packages/web/src/commands/formatting.ts','fixtures/browser-command-surfaces/session.mjs','fixtures/browser-command-surfaces/index.html','packages/web/dist/commands/catalog.js','packages/web/dist/input/keyboard.js','packages/core/dist/wasm/editac_wasm_bg.wasm','scripts/test-interactions.mjs','scripts/test-browser.mjs']
});
facts.binding={gate:'CFS-1.1',original:'INT-1.18',ids:['CMD-01','CMD-02','CMD-03','CMD-04','CMD-05','CMD-06'],provenance:'Trusted browser key/pointer activation on production BrowserEditor and secondary mountEditorSurface, recovered Session/current packed WASM/IndexedDB. Supplied replacement, permission transitions, shortcut profiles and semantic API callers are prepared. No actual CLI process, native menus, OS correction, layout or AT qualification.'};
const mod=process.platform==='darwin'?'Meta':'Control';
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function delta(a,b,n){assert.equal(b.commands.length-a.commands.length,n,'Session commit calls');assert.equal(b.journal.length-a.journal.length,n,'journal updates');assert.equal(b.patches.filter(p=>p.update).length-a.patches.filter(p=>p.update).length,n,'observed updates');assert.equal(b.history.undoGroups-a.history.undoGroups,n,'intentional groups');}
function unchanged(a,b){for(const k of ['nodes','revision','history','journal','patches','selection'])assert.deepEqual(b[k],a[k],k);}
async function select(page,a,b=a){await page.evaluate(({a,b})=>{const f=window.inputFixture;f.select(f.ids[0],a,b);},{a,b});}
async function capture(page,name='bold',range){return page.evaluate(({name,range})=>{const f=window.inputFixture;let supplied;if(range){const a=f.engine.anchor(f.ids[0],range[0],'right'),b=f.engine.anchor(f.ids[0],range[1],'left');supplied={anchor:a,focus:b};try{window.target=f.surface.captureCommand(name,supplied);}finally{f.engine.releaseAnchor(a);f.engine.releaseAnchor(b);}}else window.target=f.surface.captureCommand(name);return !!window.target;},{name,range});}
async function run(page,text){return page.evaluate(text=>window.target?.execute(text),text);}
for(const backward of [false,true])for(const route of ['keyboard','menu','context-menu','toolbar','action','alias','cli-semantic','agent-semantic'])test(`CMD-01 ${route} equivalent bold backward=${backward}`,()=>probe(`CMD-01-${route}-${backward}`,async(page,fact)=>{
 await select(page,backward?4:1,backward?1:4);const before=await state(page,fact);
 if(route==='keyboard')await page.keyboard.press(`${mod}+b`);
 else if(['menu','context-menu','toolbar','action'].includes(route)){
  await page.evaluate(route=>{const f=window.inputFixture,b=document.createElement('button');b.textContent=route;if(route.includes('menu'))b.setAttribute('role','menuitem');const capture=()=>{window.target=f.surface.captureCommand('bold');};b.addEventListener('pointerdown',capture);b.addEventListener('click',()=>{window.result=window.target.execute();window.target.dispose();});document.body.append(b);if(route==='context-menu'){capture();b.hidden=true;f.root.addEventListener('contextmenu',event=>{event.preventDefault();b.hidden=false;b.focus();});}else if(route==='menu'){capture();b.focus();}},route);
  if(route==='context-menu'){await page.locator('#projection').click({button:'right'});await page.keyboard.press('Enter');}
  else if(route==='menu')await page.keyboard.press('Enter');else await page.getByRole('button',{name:route,exact:true}).click();
  assert.equal(await page.evaluate(()=>window.result.disposition),'committed');
 }else{assert.equal(await capture(page,route==='alias'?'toggleBold':'bold'),true);assert.equal((await run(page)).disposition,'committed');}
 const after=await state(page,fact);delta(before,after,1);assert.deepEqual(after.text,before.text);assert.deepEqual(after.selection,before.selection);assert.equal(after.focus,true);
 let offset=0;for(const r of after.nodes[0].runs)for(let i=0;i<r.text.length;i++,offset++)assert.equal(!!r.attributes.bold,offset>=1&&offset<4);
 await page.keyboard.press(`${mod}+z`);const undone=await state(page,fact);assert.deepEqual(undone.nodes,before.nodes);assert.deepEqual(undone.selection,before.selection);
},'alpha'));
test('CMD-01 unknown repeat explicit and empty redo no-op',()=>probe('CMD-01-unsupported',async(page,fact)=>{
 await select(page,2);const before=await state(page,fact);assert.equal(await capture(page,'repeat'),false);assert.equal(await capture(page,'unknown'),false);assert.equal(await capture(page,'historyRedo'),true);assert.equal((await run(page)).disposition,'handled');unchanged(before,await state(page,fact));
},'alpha'));
for(const owner of ['host','find','nested','second'])test(`CMD-02 ${owner} owns Enter SelectAll undo cut`,()=>probe(`CMD-02-${owner}`,async(page,fact)=>{
 await select(page,1,4);await page.keyboard.press(`${mod}+b`);const before=await state(page,fact);
 await page.evaluate(async owner=>{const f=window.inputFixture;if(owner==='find'){f.surface.search.show();f.surface.search.query.id='owner';f.surface.search.query.value='host value';f.surface.search.query.select();return;}if(owner==='second'){const id=await f.second();document.getElementById(id).focus();return;}const input=document.createElement('input');input.id='owner';input.value='host value';input.setAttribute('aria-label',owner);if(owner==='nested')f.root.append(input);else document.body.append(input);input.focus();input.select();},owner);
 assert.equal(await capture(page),false);await page.keyboard.press('Enter');await page.keyboard.press(`${mod}+a`);await page.keyboard.press(`${mod}+z`);
 const cut=await page.evaluate(()=>{const e=new ClipboardEvent('cut',{bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return e.defaultPrevented;});
 const after=await state(page,fact);for(const k of ['nodes','revision','history','journal','patches'])assert.deepEqual(after[k],before[k],k);assert.equal(after.focus,false);if(owner!=='second'){assert.equal(cut,false);assert.equal(await page.evaluate(()=>document.activeElement.id),'owner');}
},'alpha'));
for(const backward of [false,true])test(`CMD-03 supplied replacement once backward=${backward}`,()=>probe(`CMD-03-supplied-${backward}`,async(page,fact)=>{
 await select(page,1,4);await page.keyboard.press(`${mod}+b`);await select(page,5);const before=await state(page,fact);
 assert.equal(await capture(page,'insertReplacementText',backward?[4,1]:[1,4]),true);assert.equal((await run(page,'😊')).disposition,'committed');const after=await state(page,fact);delta(before,after,1);assert.equal(after.text[0],'a😊a');assert.equal(after.nodes[0].runs.find(r=>r.text.includes('😊')).attributes.bold,true);assert.equal(after.selection.anchor.offset,3);assert.equal(after.selection.focus.offset,3);
 assert.equal((await run(page,'bad')).disposition,'rejected');unchanged(after,await state(page,fact));await page.keyboard.press(`${mod}+z`);assert.deepEqual((await state(page,fact)).nodes,before.nodes);
},'alpha'));
for(const change of ['remote','invalid'])test(`CMD-03 ${change} rejects without latest caret fallback`,()=>probe(`CMD-03-${change}`,async(page,fact)=>{
 await select(page,5);assert.equal(await capture(page,'replace',[1,4]),true);
 if(change==='remote')await page.evaluate(()=>window.inputFixture.remote(0,'R'));
 else await page.evaluate(()=>{window.target.dispose();const f=window.inputFixture;window.invalid=f.surface.captureCommand('replace',{anchor:'invalid',focus:'invalid'});});
 const before=await state(page,fact);assert.equal((await run(page,'bad')).disposition,'rejected');if(change==='invalid')assert.equal(await page.evaluate(()=>!!window.invalid),false);unchanged(before,await state(page,fact));
},'alpha'));
for(const change of ['read-only','permission','cancel','foreign-focus','close-reopen'])test(`CMD-04 activation revalidates ${change}`,()=>probe(`CMD-04-${change}`,async(page,fact)=>{
 await select(page,1,4);assert.equal(await capture(page),true);
 await page.evaluate(change=>{const f=window.inputFixture;if(change==='read-only')f.surface.setReadOnly(true);if(change==='permission')window.commandPermission=false;if(change==='cancel'||change==='close-reopen')window.target.dispose();if(change==='foreign-focus'){const input=document.createElement('input');input.id='nested-owner';f.root.append(input);input.focus();}},change);
 const before=await state(page,fact);assert.equal((await run(page)).disposition,'rejected');unchanged(before,await state(page,fact));
 if(change==='close-reopen'){await select(page,0,1);assert.equal(await capture(page),true);assert.equal((await run(page)).disposition,'committed');delta(before,await state(page,fact),1);}
},'alpha'));
for(const owner of ['input','textarea','select','contenteditable','textbox'])for(const command of ['bold','replace'])test(`CMD-04 delayed ${command} rejects after nested ${owner} returns focus`,()=>probe(`CMD-04-nested-${owner}-${command}`,async(page,fact)=>{
 await select(page,1,4);const original=await state(page,fact);assert.equal(await capture(page,command),true);
 // Observe focus and execute before mutation recovery can invalidate the target
 // for an unrelated reason. Root structure recovery is covered separately.
 const result=await page.evaluate(owner=>{const f=window.inputFixture;const control=document.createElement(['contenteditable','textbox'].includes(owner)?'div':owner);if(owner==='contenteditable'){control.contentEditable='true';control.tabIndex=0;}if(owner==='textbox'){control.setAttribute('role','textbox');control.tabIndex=0;}f.root.append(control);control.focus();const focused=document.activeElement===control;f.root.focus();return {focused,active:window.target.active,result:window.target.execute('late')};},owner);
 assert.equal(result.focused,true);assert.equal(result.active,false);assert.equal(result.result.disposition,'rejected');const after=await state(page,fact);for(const key of ['nodes','revision','history','journal','patches'])assert.deepEqual(after[key],original[key],key);
},'alpha'));
test('CMD-05 save retains undo and empty redo never repeats',()=>probe('CMD-05-save',async(page,fact)=>{
 await select(page,1,4);const before=await state(page,fact);await page.keyboard.press(`${mod}+b`);await page.evaluate(()=>window.editor.flush({target:'local'}));const edited=await state(page,fact);delta(before,edited,1);await page.keyboard.press(`${mod}+z`);assert.deepEqual((await state(page,fact)).nodes,before.nodes);await page.keyboard.press(`${mod}+Shift+z`);assert.deepEqual((await state(page,fact)).nodes,edited.nodes);await page.keyboard.press(`${mod}+Shift+z`);const final=await state(page,fact);assert.deepEqual(final.nodes,edited.nodes);assert.equal(final.journal.length,edited.journal.length+2);assert.equal(await capture(page,'repeat'),false);
},'alpha'));
for(const profile of [{reserved:['Primary+b']},{remap:{'Primary+b':null,'Primary+j':'toggleBold'}}])test(`CMD-06 profile ${JSON.stringify(profile)} discoverable alternative`,()=>probe(`CMD-06-${profile.reserved?'reserved':'remap'}`,async(page,fact)=>{
 await select(page,1,4);const before=await state(page,fact);
 // Prepared host/AT owner intercepts its reserved chord before editor delivery.
 await page.evaluate(()=>{window.reservedOwner=0;document.addEventListener('keydown',e=>{if(e.isTrusted&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='b'){window.reservedOwner++;e.preventDefault();}},true);});
 await page.evaluate(mac=>{const f=window.inputFixture;window.syntheticReserved=f.event('keydown',{key:'b',...(mac?{metaKey:true}:{ctrlKey:true})});},process.platform==='darwin');
 assert.equal(await page.evaluate(()=>window.syntheticReserved),false);
 await page.keyboard.press(`${mod}+b`);assert.equal(await page.evaluate(()=>window.reservedOwner),1);unchanged(before,await state(page,fact));assert.equal(await page.evaluate(()=>window.editor.commands.find(c=>c.id==='bold').label),'Bold');
 if(profile.remap)await page.keyboard.press(`${mod}+j`);else{
  await page.evaluate(()=>{const b=document.createElement('button');b.textContent=window.editor.commands.find(c=>c.id==='bold').label;b.addEventListener('pointerdown',()=>window.target=window.editor.captureCommand('bold'));b.addEventListener('click',()=>window.result=window.target.execute());document.body.append(b);});
  await page.getByRole('button',{name:'Bold',exact:true}).click();assert.equal(await page.evaluate(()=>window.result.disposition),'committed');
 }delta(before,await state(page,fact),1);
},{text:'alpha',shortcutProfile:profile}));

for(const [name,mark] of [['toggleItalic','italic'],['toggleUnderline','underline'],['toggleStrike','strike'],['toggleCode','code']])test(`CMD-01 registered alias ${name}`,()=>probe(`CMD-01-alias-${name}`,async(page,fact)=>{
 await select(page,4,1);const before=await state(page,fact);assert.equal(await capture(page,name),true);assert.equal((await run(page)).disposition,'committed');const after=await state(page,fact);delta(before,after,1);assert.deepEqual(after.selection,before.selection);assert.equal(after.nodes[0].runs.find(r=>r.text==='lph').attributes[mark],true);
},'alpha'));
for(const [name,expected] of [['insertParagraph',['a','a','independent']],['insertLineBreak',['a\na','independent']],['deleteContentBackward',['aa','independent']],['deleteContentForward',['aa','independent']]])test(`CMD-01 registered alias ${name}`,()=>probe(`CMD-01-alias-${name}`,async(page,fact)=>{
 await select(page,1,4);const before=await state(page,fact);assert.equal(await capture(page,name),true);assert.equal((await run(page)).disposition,'committed');const after=await state(page,fact);delta(before,after,1);assert.deepEqual(after.text,expected);await page.keyboard.press(`${mod}+z`);assert.deepEqual((await state(page,fact)).nodes,before.nodes);
},'alpha'));
test('CMD-01 registered link and history aliases use existing owners',()=>probe('CMD-01-link-history-alias',async(page,fact)=>{
 await select(page,1,4);const before=await state(page,fact);await capture(page,'editLink');assert.equal((await run(page)).disposition,'handled');await page.getByRole('button',{name:'Cancel link',exact:true}).click();unchanged(before,await state(page,fact));await capture(page,'toggleBold');await run(page);await capture(page,'historyUndo');assert.equal((await run(page)).disposition,'committed');assert.deepEqual((await state(page,fact)).nodes,before.nodes);await capture(page,'historyRedo');assert.equal((await run(page)).disposition,'committed');assert.equal((await state(page,fact)).history.undoGroups,1);
},'alpha'));
test('CMD-01 collapsed empty replacement is a no-op',()=>probe('CMD-01-empty-replace',async(page,fact)=>{
 await select(page,2);const before=await state(page,fact);await capture(page,'replace',[2,2]);assert.equal((await run(page,'')).disposition,'handled');unchanged(before,await state(page,fact));
},'alpha'));
for(const route of ['keyboard','toolbar','captured'])test(`CMD-04 ${route} read-only and permission rejection`,()=>probe(`CMD-04-permission-${route}`,async(page,fact)=>{
 await select(page,1,4);await page.evaluate(route=>{const f=window.inputFixture;if(route==='toolbar')window.oldToolbar=f.surface.captureToolbar();else window.target=f.surface.captureCommand('bold');window.commandPermission=false;},route);const before=await state(page,fact);
 if(route==='keyboard')await page.keyboard.press(`${mod}+b`);else if(route==='toolbar')assert.equal(await page.evaluate(()=>window.oldToolbar.format('bold').disposition),'rejected');else assert.equal((await run(page)).disposition,'rejected');
 // The native key owner may change DOM selection when formatting is unavailable;
 // committed semantics and history must remain untouched.
 const after=await state(page,fact);for(const k of ['nodes','history','journal','revision','patches'])assert.deepEqual(after[k],before[k],k);
 await page.evaluate(()=>{window.commandPermission=true;window.inputFixture.surface.setReadOnly(true);});assert.equal(await capture(page),false);
},'alpha'));
test('CMD-03 replacement survives durable reopen',()=>probe('CMD-03-reopen',async(page,fact)=>{
 await select(page,5);await capture(page,'replace',[1,4]);assert.equal((await run(page,'new')).disposition,'committed');const after=await state(page,fact);const reopened=await page.evaluate(()=>window.inputFixture.reopen());assert.deepEqual(reopened,after.nodes);
},'alpha'));
for(const change of ['apply','read-only','permission','cancel-reopen'])test(`CMD-04 real link dialog ${change}`,()=>probe(`CMD-04-dialog-${change}`,async(page,fact)=>{
 await select(page,4,1);const before=await state(page,fact);await page.keyboard.press(`${mod}+k`);await page.getByRole('textbox',{name:'Link URL',exact:true}).fill('https://example.test/');
 if(change==='read-only')await page.evaluate(()=>window.editor.setReadOnly(true));
 if(change==='permission')await page.evaluate(()=>window.commandPermission=false);
 if(change==='cancel-reopen'){await page.getByRole('button',{name:'Cancel link',exact:true}).click();unchanged(before,await state(page,fact));await select(page,0,1);await page.keyboard.press(`${mod}+k`);await page.getByRole('textbox',{name:'Link URL',exact:true}).fill('https://example.test/');}
 await page.getByRole('button',{name:'Apply link',exact:true}).click();const after=await state(page,fact);
 if(change==='read-only'||change==='permission'){for(const k of ['nodes','journal','history','revision','patches','commands'])assert.deepEqual(after[k],before[k],k);assert.equal(await page.getByRole('dialog',{name:'Edit link'}).count(),1);}
 else{delta(before,after,1);assert.equal(after.nodes[0].runs.find(r=>r.attributes.link)?.attributes.link,'https://example.test/');}
},'alpha'));
test('CMD-04 disposed BrowserEditor invalidates captured command and releases view',()=>probe('CMD-04-disposed',async(page,fact)=>{
 await select(page,1,4);await capture(page);const before=await state(page,fact);await page.evaluate(()=>window.inputFixture.disposeSurface());assert.equal((await run(page)).disposition,'rejected');assert.equal(await page.evaluate(()=>window.target.active),false);const recovered=await page.evaluate(()=>window.inputFixture.reopen());assert.deepEqual(recovered,before.nodes);
},'alpha'));

test('CMD-03 injected final commit rejection is atomic and consumes intent',()=>probe('CMD-03-atomic-rejection',async(page,fact)=>{
 await select(page,5);await capture(page,'replace',[1,4]);const before=await state(page,fact);await page.evaluate(()=>window.rejectCommand=true);const result=await run(page,'bad');assert.equal(result.disposition,'rejected');assert.match(result.reason,/injected-command-rejection/);unchanged(before,await state(page,fact));await page.evaluate(()=>window.rejectCommand=false);assert.equal((await run(page,'bad')).disposition,'rejected');unchanged(before,await state(page,fact));
},'alpha'));
test('CMD-04 composition temporarily owns DOM mapping and undo cancels once',()=>probe('CMD-04-composition-mapping',async(page,fact)=>{
 await select(page,5);await page.keyboard.type('!');await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],1,4);f.event('compositionstart');f.event('beforeinput',{inputType:'insertCompositionText',data:'文',isComposing:true,cancelable:true});const n=f.root.querySelector('[data-node-id]').firstChild;n.data='a文a!';document.getSelection().setBaseAndExtent(n,2,n,2);f.event('input',{inputType:'insertCompositionText',data:'文',isComposing:true});document.dispatchEvent(new Event('selectionchange'));});
 await page.keyboard.press(`${mod}+z`);const after=await state(page,fact);assert.equal(after.text[0],'alpha');assert.equal(after.history.undoGroups,0);assert.equal(after.history.redoGroups,1);assert.equal(after.journal.length,2);
},'alpha'));
