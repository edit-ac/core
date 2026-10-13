import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('review','fixtures/browser-review',{autoMount:false});
async function mount(page,name='source',options={}) { await page.waitForFunction(()=>!!window.reviewFixture); await page.evaluate(({name,options})=>window.reviewFixture.mount(name,options),{name,options}); }
async function text(page) { return page.locator('#review').innerText(); }
async function counts(page) { return page.evaluate(()=>({rows:document.querySelectorAll('tbody tr').length,checkboxes:document.querySelectorAll('input[type=checkbox]').length,accept:[...document.querySelectorAll('button')].filter(b=>b.textContent==='Accept selected hunks').length})); }
for (const layout of ['inline','unified','side-by-side']) test(`${layout} exact source preserves newline and Unicode with explicit labels`,()=>probe(`source-${layout}`,async(page,fact)=>{
  await mount(page,'source',{layout}); assert.match(await text(page),/Exact source changes/); assert.match(await text(page),/Original UTF-8/);
  assert.equal(await page.getByRole('table').getAttribute('aria-label'),null); assert.equal(await page.locator('caption').innerText(),`Exact source changes: ${layout} view`);
  assert.match(await text(page),/Removed/); assert.match(await text(page),/Added/); assert.match(await text(page),/No final newline/);
  await page.getByRole('button',{name:'Show whitespace',exact:true}).click(); const value=await text(page);assert.match(value,/␍␊/);assert.match(value,/alpha·/);
  const header=await page.locator('thead th').allTextContents(); assert.deepEqual(header,layout==='side-by-side'?['Change','Before','After']:['Change','Difference']);
  if(layout==='inline'){assert.ok(await page.locator('del').count());assert.ok(await page.locator('ins').count());}
  fact.snapshots.push({header,counts:await counts(page)});
}));
test('formatting-only changes have independent facet and marks with no content claim',()=>probe('format-only',async(page)=>{
  await mount(page,'format'); const value=await text(page);assert.match(value,/Formatting \/ marks/);assert.match(value,/bold/);assert.equal(await page.locator('[data-kind=Text]').count(),0);assert.equal(await page.locator('[data-kind=Formatting]').count(),1);assert.match(value,/Unknown \/ unverified/);
}));
for(const layout of ['inline','unified','side-by-side'])test(`${layout} semantic move keeps content, marks, links, opaque and retained structure visible`,()=>probe(`semantic-${layout}`,async(page,fact)=>{
  await mount(page,'semantic',{layout});const value=await text(page);
  for(const part of [/Move \/ placement/,/Content/,/Formatting \/ marks/,/Link targets \/ references/,/Opaque \/ unknown module/,/Retained document structure/,/https:\/\/example.test\/new/,/changed beta/])assert.match(value,part);
  assert.equal(await page.locator('#review img').count(),0); assert.equal(await counts(page).then(c=>c.accept),0);
  fact.snapshots.push({facets:await page.locator('tbody tr').evaluateAll(rows=>rows.map(r=>r.dataset.kind))});
}));
for(const mode of ['readonly','history']) test(`${mode} exposes display navigation but no mutation controls`,()=>probe(`mode-${mode}`,async(page)=>{
  await mount(page,'selection',{mode,accept:true}); assert.deepEqual(await counts(page).then(c=>[c.checkboxes,c.accept]),[0,0]);assert.match(await text(page),mode==='history'?/Readonly historical/:/Readonly current/);
  await page.getByRole('button',{name:'inline view',exact:true}).click();await page.getByRole('button',{name:'Show whitespace',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.reviewFixture.requests),[]);
}));
test('native keyboard selection persists across layouts, whitespace and page navigation',()=>probe('stable-selection',async(page,fact)=>{
  await mount(page,'selection',{mode:'writable',accept:true,limits:{pageSize:4}});
  const checkbox=page.getByRole('checkbox',{name:'Select hunk 1',exact:true});await checkbox.focus();await checkbox.press('Space');assert.equal(await checkbox.isChecked(),true);assert.equal(await checkbox.evaluate(e=>e===document.activeElement),true);
  for(const name of ['inline view','side-by-side view','unified view','Show whitespace']){await page.getByRole('button',{name,exact:true}).click();assert.equal(await checkbox.isChecked(),true);}
  while(!await page.getByRole('button',{name:'Next page',exact:true}).isDisabled())await page.getByRole('button',{name:'Next page',exact:true}).click();
  await page.getByRole('checkbox',{name:'Select hunk 2',exact:true}).check();const accept=page.getByRole('button',{name:'Accept selected hunks',exact:true});await accept.focus();await accept.press('Enter');
  const requests=await page.evaluate(()=>window.reviewFixture.requests);assert.equal(requests.length,1);assert.deepEqual(requests[0].hunkIndexes,[0,1]);assert.match(requests[0].beforeHash,/^[a-f0-9]{64}$/);assert.equal(requests[0].representation,'exact-source');fact.snapshots.push(requests[0]);
}));
test('same immutable revision retains selection; changed revision clears it',()=>probe('revision-selection',async(page)=>{
  await mount(page,'selection',{mode:'writable',accept:true});await page.getByRole('checkbox',{name:'Select hunk 1',exact:true}).check();await page.evaluate(()=>window.reviewFixture.update('selection'));assert.equal(await page.getByRole('checkbox',{name:'Select hunk 1',exact:true}).isChecked(),true);
  await page.evaluate(()=>window.reviewFixture.update('source'));assert.equal(await page.getByRole('checkbox',{name:'Select hunk 1',exact:true}).isChecked(),false);assert.equal(await page.getByRole('button',{name:'Accept selected hunks',exact:true}).isDisabled(),true);
}));
test('switching writable to history removes callbacks and selected controls',()=>probe('mode-transition',async(page)=>{
  await mount(page,'selection',{mode:'writable',accept:true});await page.getByRole('checkbox',{name:'Select hunk 1',exact:true}).check();await page.evaluate(()=>window.reviewFixture.mode('history'));assert.deepEqual(await counts(page).then(c=>[c.checkboxes,c.accept]),[0,0]);
  await page.evaluate(()=>window.reviewFixture.mode('writable'));assert.equal(await page.getByRole('button',{name:'Accept selected hunks',exact:true}).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>window.reviewFixture.requests),[]);
}));
test('projected Markdown labels serializer/dialect and never labels original source',()=>probe('projected',async(page)=>{
  await mount(page,'projected'); const value=await text(page);assert.match(value,/Projected Markdown changes/);assert.match(value,/editac-markdown-v1; commonmark/);assert.match(value,/normalize source spelling/);assert.equal(await page.getByRole('heading',{name:'Exact source changes',exact:true}).count(),0);
}));
test('deletion-only and unchanged inputs do not invent additions or differences',()=>probe('delete-and-noop',async(page)=>{
  await mount(page,'delete');assert.equal(await page.locator('tr[data-kind=Insert]').count(),0);assert.ok(await page.locator('tr[data-kind=Delete]').count());await page.evaluate(()=>window.reviewFixture.update('unchanged'));assert.equal((await counts(page)).rows,0);assert.match(await text(page),/No differences/);
}));
test('5000-line source has bounded DOM, accurate pagination and final page content',()=>probe('large-source',async(page,fact)=>{
  await mount(page,'large',{limits:{pageSize:100}});assert.equal((await counts(page)).rows,100);assert.match(await text(page),/Page 1 of 50; 5000 difference rows/);
  await page.getByRole('button',{name:'Show whitespace',exact:true}).click();assert.match(await text(page),/⇥🙂␍␊/);
  await page.getByRole('button',{name:'Next page',exact:true}).click();assert.match(await text(page),/line·100/);assert.equal((await counts(page)).rows,100);
  for(let i=0;i<48;i++)await page.getByRole('button',{name:'Next page',exact:true}).click();assert.match(await text(page),/line·4999/);assert.equal(await page.getByRole('button',{name:'Next page',exact:true}).isDisabled(),true);fact.snapshots.push({counts:await counts(page),page:await page.getByRole('status').innerText()});
}));
test('huge and hostile values are clipped honestly and never parsed as HTML',()=>probe('clipped-safe-text',async(page)=>{
  await mount(page,'huge',{limits:{maxValueChars:120}});assert.match(await text(page),/Display truncated/);assert.equal(await page.locator('#review img').count(),0);assert.ok((await text(page)).length<2500);
}));
test('invalid profiles, CRDT input, malformed ranges and resource limits reject before replacing view',()=>probe('invalid-model',async(page)=>{
  await mount(page);const results=await page.evaluate(()=>{
    const f=window.reviewFixture;const bad=[{representation:'crdt-update',wire:'x'},{...f.inputs.projected,serializer:''},{...f.inputs.source,wire:f.inputs.source.wire.replace(/@@ -\d+,\d+/, '@@ -0,99')},{representation:'semantic',model:{...f.inputs.semantic.model,version:'future'}},{representation:'semantic',model:{...f.inputs.semantic.model,retained_structure:true}},{representation:'semantic',model:{...f.inputs.semantic.model,changes:[{...f.inputs.semantic.model.changes[0],before:false}]}}];
    return bad.map(input=>{try{f.invalid(input);return false;}catch{return true;}});
  });assert.deepEqual(results,[true,true,true,true,true,true]);
  const value=await text(page);const error=await page.evaluate(()=>{try{window.reviewFixture.updateInput({representation:'crdt-update',wire:'x'});return null;}catch(e){return e.message;}});assert.match(error,/Unsupported/);assert.equal(await text(page),value);
  const limit=await page.evaluate(()=>{try{window.reviewFixture.mount('source',{limits:{maxInputBytes:10}});return null;}catch(e){return e.message;}});assert.match(limit,/byte limit/);
}));
test('narrow viewport retains readable columns and accessible native control names',()=>probe('narrow-accessible',async(page)=>{
  await page.setViewportSize({width:390,height:844});await mount(page,'semantic',{layout:'side-by-side'});
  assert.equal(await page.getByRole('region',{name:'Change review'}).count(),1);assert.equal(await page.getByRole('group',{name:'Review display controls'}).count(),1);
  const button=page.getByRole('button',{name:'inline view',exact:true});await button.focus();await button.press('Enter');assert.equal(await button.getAttribute('aria-pressed'),'true');assert.equal(await button.evaluate(e=>e===document.activeElement),true);
  if(process.env.EDITAC_REVIEW_OUTPUT)await page.screenshot({path:process.env.EDITAC_REVIEW_OUTPUT+'/narrow-review.png',fullPage:true});
  const width=await page.evaluate(()=>({viewport:innerWidth,body:document.body.scrollWidth}));assert.ok(width.body<=width.viewport+1,JSON.stringify(width));
}));
test('destroy removes owned view and repeated mount leaves one region',()=>probe('dispose',async(page)=>{
  await mount(page);for(let i=0;i<10;i++)await mount(page,'format');assert.equal(await page.getByRole('region',{name:'Change review'}).count(),1);await page.evaluate(()=>window.reviewFixture.destroy());assert.equal(await page.locator('#review').innerText(),'');
}));

test('same hashes with changed hunk mapping clear selection instead of reusing indexes',()=>probe('hunk-remap',async(page)=>{
  await mount(page,'selection',{mode:'writable',accept:true});await page.getByRole('checkbox',{name:'Select hunk 1',exact:true}).check();
  await page.evaluate(()=>{const input=structuredClone(window.reviewFixture.inputs.selection);input.wire=input.wire.replace(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/,(_,a,b,c,d)=>`@@ -${Number(a)+1},${b} +${Number(c)+1},${d} @@`);window.reviewFixture.updateInput(input);});
  assert.equal(await page.getByRole('checkbox',{name:'Select hunk 1',exact:true}).isChecked(),false);
}));
test('large semantic formatting set has bounded rows and complete page count',()=>probe('large-semantic',async(page,fact)=>{
  await mount(page,'largeSemantic',{limits:{pageSize:50}});assert.equal((await counts(page)).rows,50);assert.match(await text(page),/Page 1 of 20; 1000 difference rows/);assert.equal(await page.locator('[data-kind=Text]').count(),0);assert.equal(await page.locator('[data-kind=Formatting]').count(),50);
  await page.getByRole('button',{name:'Next page',exact:true}).click();const expected=await page.evaluate(()=>window.reviewFixture.inputs.largeSemantic.model.changes[50].id);assert.ok((await text(page)).includes(expected+': Formatting'));fact.snapshots.push({counts:await counts(page)});
}));
test('writable presentation without an admission callback has no accept controls',()=>probe('writable-no-host',async(page)=>{
  await mount(page,'selection',{mode:'writable'});assert.deepEqual(await counts(page).then(c=>[c.checkboxes,c.accept]),[0,0]);
}));
