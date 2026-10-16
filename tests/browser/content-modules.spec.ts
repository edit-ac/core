import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('content-modules','fixtures/browser-content-modules');
const cell=(page,r=2,c=1)=>page.getByRole('textbox',{name:`Table row ${r} column ${c}`,exact:true});
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
const table=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');
const image=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.image');
test('image host policy receives inert metadata; alt/title and rectangle render accessibly',()=>probe('render',async(page,fact)=>{
 const s=await state(page,fact);assert.equal(s.policyCalls,1);assert.equal(image(s).blockAttributes[2].url,'https://assets.invalid/image.png');assert.equal(s.requests[0].alt,'Literal <alt> 😀');assert.equal(await page.getByRole('img',{name:'Literal <alt> 😀'}).getAttribute('title'),'Host title');await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===2);assert.equal(await page.getByRole('table',{name:'Simple table'}).count(),1);assert.equal(await cell(page,1,1).inputValue(),'head');assert.equal(await page.locator('th strong').textContent(),'head');assert.equal(await cell(page).inputValue(),'alpha😀');assert.equal(await page.locator('th a').getAttribute('href'),'mailto:team@example.test');assert.equal(await page.locator('[rowspan],[colspan],input[type=file]').count(),0);assert.equal(await page.locator('th').first().getAttribute('scope'),'col');
}));
for(const url of ['javascript:alert(1)','https://user:pass@assets.invalid/a','https://assets.invalid/%0a.png'])test(`unsafe host image URL is inert: ${url}`,()=>probe(`unsafe-${encodeURIComponent(url)}`,async(page,fact)=>{
 const s=await state(page,fact);assert.equal(await page.locator('img').getAttribute('src'),null);assert.equal(await page.locator('img').isHidden(),true);assert.equal(image(s).blockAttributes[2].source.includes('Literal &lt;alt&gt;'),true);
},{url}));
test('absent policy never loads authored asset URLs',()=>probe('no-policy',async(page,fact)=>{const s=await state(page,fact);assert.equal(s.policyCalls,0);assert.equal(await page.locator('img').getAttribute('src'),null);},{noPolicy:true}));
test('throwing host policy is isolated with preserved source',()=>probe('failed-policy',async(page,fact)=>{const s=await state(page,fact);assert.equal(await page.locator('img').getAttribute('src'),null);assert.match(await page.locator('[data-content-module="image"] [role="status"]').textContent(),/source preserved/);assert.equal(image(s).blockAttributes[2].alt,'Literal <alt> 😀');},{throwPolicy:true}));
test('native keyboard selection/copy and Tab traverse cell controls without editor commands',()=>probe('keyboard-copy',async(page,fact)=>{
 await cell(page).focus();await cell(page).press('Home');await cell(page).press('Shift+ArrowRight');await cell(page).press('Shift+ArrowRight');const copied=await cell(page).evaluate(el=>{const d=new DataTransfer();const e=window.preparedClipboardEvent('copy',d);el.dispatchEvent(e);return{plain:d.getData('text/plain'),prevented:e.defaultPrevented,start:el.selectionStart,end:el.selectionEnd};});assert.deepEqual(copied,{plain:'al',prevented:true,start:0,end:2});await page.keyboard.press('Tab');assert.equal(await cell(page,2,2).evaluate(el=>el===document.activeElement),true);const s=await state(page,fact);assert.equal(s.commands.length,0);assert.equal(s.history.undoGroups,0);
}));
test('cell editing commits through storage, retains owner, marks and unrelated metadata',()=>probe('edit',async(page,fact)=>{
 const before=await state(page,fact);await cell(page,1,1).fill('heading😀');const s=await state(page,fact);assert.equal(table(s).id,table(before).id);assert.equal(table(s).blockAttributes[2].rows[0][0][0][0],'heading😀');assert.deepEqual(table(s).blockAttributes[2].rows[0][0][0][1],[['bold']]);assert.deepEqual(table(s).blockAttributes[2].rows[1],table(before).blockAttributes[2].rows[1]);assert.deepEqual(image(s),image(before));assert.equal(s.history.undoGroups,1);assert.equal(s.commands.length,1);assert.equal(s.journal.at(-1),'editac:local:module-table-cell');assert.match(s.markdown.markdown,/heading😀/);
}));
test('undo and redo restore both cell tuple and fallback text',()=>probe('history',async(page,fact)=>{
 const before=await state(page,fact);await cell(page).fill('changed');await cell(page).press('ControlOrMeta+z');let s=await state(page,fact);assert.deepEqual(table(s).blockAttributes,table(before).blockAttributes);assert.equal(await cell(page).inputValue(),'alpha😀');await cell(page).press('ControlOrMeta+Shift+z');s=await state(page,fact);assert.equal(table(s).blockAttributes[2].rows[1][0][0][0],'changed');assert.match(table(s).runs.map(r=>r.text).join(''),/changed/);
}));
test('composition stays temporary until one committed cell edit',()=>probe('composition',async(page,fact)=>{
 await cell(page).evaluate(el=>{el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='日本😀';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'日本😀'}));});let s=await state(page,fact);assert.equal(s.commands.length,0);assert.equal(table(s).blockAttributes[2].rows[1][0][0][0],'alpha😀');await cell(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'日本😀'})));s=await state(page,fact);assert.equal(s.commands.length,1);assert.equal(table(s).blockAttributes[2].rows[1][0][0][0],'日本😀');
}));
test('stale composition cannot replace a newer engine cell update',()=>probe('stale-composition',async(page,fact)=>{
 await cell(page).evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='stale';});assert.equal(await page.evaluate(()=>window.inputFixture.peerCell('newer')),true);await cell(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'stale'})));const s=await state(page,fact);assert.equal(table(s).blockAttributes[2].rows[1][0][0][0],'newer');assert.equal(await cell(page).inputValue(),'newer');assert.match(await page.locator('[data-content-module="table"] [role="status"]').textContent(),/rejected/);
}));
test('read-only blocks native edits and retains selectable copy controls',()=>probe('readonly',async(page,fact)=>{
 const before=await state(page,fact);await page.evaluate(()=>window.inputFixture.surface.setReadOnly(true));assert.equal(await cell(page).getAttribute('readonly'),'');await cell(page).evaluate(el=>{el.value='blocked';el.dispatchEvent(new InputEvent('input',{bubbles:true}));});const s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.equal(s.commands.length,0);
}));
test('disabled storage round-trip retains edited data and re-enabling restores cells',()=>probe('disabled-recovery',async(page,fact)=>{
 await cell(page).fill('persisted😀');const edited=await state(page,fact);await page.evaluate(()=>window.inputFixture.reopen(true));let s=await state(page,fact);assert.deepEqual(s.nodes,edited.nodes);assert.equal(await page.locator('[data-content-module]').count(),0);assert.match(await page.locator('#projection').textContent(),/persisted😀/);const disabledMarkdown=s.markdown;await page.evaluate(()=>window.inputFixture.reopen());s=await state(page,fact);assert.deepEqual(s.nodes,edited.nodes);assert.equal(await cell(page).inputValue(),'persisted😀');assert.deepEqual(s.markdown,disabledMarkdown);
}));
test('disabled initial mount preserves complete descriptors without asset calls',()=>probe('disabled-initial',async(page,fact)=>{const s=await state(page,fact);assert.equal(s.policyCalls,0);assert.equal(s.inputs.length,0);assert.equal(table(s).blockAttributes[2].rows.length,2);assert.equal(image(s).blockAttributes[2].alt,'Literal <alt> 😀');},{disabled:true}));
test('multiline and stale direct commands reject atomically',()=>probe('invalid-commands',async(page,fact)=>{
 const before=await state(page,fact);const result=await page.evaluate(()=>{const f=window.inputFixture,n=f.engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');return [{row:128,column:0,text:'x',expected:n.blockAttributes},{row:0,column:0,text:'a\nb',expected:n.blockAttributes},{row:0,column:0,text:'x',expected:null}].map(c=>f.engine.can({kind:'editor',origin:'prepared-invalid',commands:[{type:'tableCell',owner:n.id,...c}]}));});assert.deepEqual(result,[false,false,false]);const s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.deepEqual(s.history,before.history);assert.deepEqual(s.journal,before.journal);
}));
test('disposal detaches cell edit listeners and asset URL',()=>probe('dispose',async(page,fact)=>{
 const before=await state(page,fact);await cell(page).evaluate(el=>{window.oldCell=el;window.inputFixture.disposeSurface();el.value='late';el.dispatchEvent(new InputEvent('input',{bubbles:true}));});const s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.equal(s.commands.length,0);assert.equal(s.markdownAvailable,false);assert.equal(before.markdownAvailable,true);assert.equal(await page.locator('img').getAttribute('src'),null);
}));

test('image source has keyboard selection and literal copy without asset mutation',()=>probe('image-copy',async(page,fact)=>{
 const before=await state(page,fact),source=page.getByRole('textbox',{name:'Image source',exact:true});await source.focus();await source.press('ControlOrMeta+a');const copied=await source.evaluate(el=>{const data=new DataTransfer();el.dispatchEvent(window.preparedClipboardEvent('copy',data));return data.getData('text/plain');});assert.equal(copied,image(before).blockAttributes[2].source);assert.deepEqual((await state(page,fact)).nodes,before.nodes);
}));
test('empty-cell editing preserves the rectangle; multiline input restores committed data',()=>probe('empty-multiline',async(page,fact)=>{
 await cell(page).fill('');let s=await state(page,fact);assert.equal(table(s).blockAttributes[2].rows[1][0][0][0],'');const before=s;await cell(page).fill('unsupported\nrow');s=await state(page,fact);assert.deepEqual(s.nodes,before.nodes);assert.equal(await cell(page).inputValue(),'');assert.match(await page.locator('[data-content-module="table"] [role="status"]').textContent(),/rejected/);await page.evaluate(()=>window.inputFixture.reopen());assert.equal(await cell(page).inputValue(),'');
}));

test('registered content status mutations do not exhaust native reconciliation or freeze table input',()=>probe('owned-status',async(page,fact)=>{
 const before=await state(page,fact);
 await page.evaluate(()=>{const status=document.querySelector('[data-content-module="table"] [role="status"]');const fragment=document.createDocumentFragment();for(let i=0;i<2100;i++){const span=document.createElement('span');span.textContent='adapter status';fragment.append(span);}status.replaceChildren(fragment);});
 const unchanged=await state(page,fact);assert.deepEqual(unchanged.nodes,before.nodes);assert(unchanged.inputs.filter(i=>i.value!=='').some(i=>!i.readOnly));assert.equal(await cell(page).isEditable(),true);
 await cell(page).fill('owned status still editable');const after=await state(page,fact);assert.equal(table(after).blockAttributes[2].rows[1][0][0][0],'owned status still editable');
}));
test('authored module attributes outside a registered content view cannot bypass native recovery',()=>probe('unowned-status',async(page,fact)=>{
 const before=await state(page,fact);
 await page.evaluate(()=>{const fake=document.createElement('section');fake.dataset.contentModule='table';fake.dataset.moduleView='true';for(let i=0;i<2100;i++)fake.append(document.createElement('span'));document.querySelector('#projection').append(fake);});
 const after=await state(page,fact);assert.deepEqual(after.nodes,before.nodes);assert.equal(await cell(page).isEditable(),false);assert.equal(await page.locator('#projection').getAttribute('contenteditable'),'false');
}));
