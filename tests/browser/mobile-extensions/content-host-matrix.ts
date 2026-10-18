import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commandProfiles } from './command-inventory.mjs';
const descriptors=JSON.parse(readFileSync('fixtures/rich-content/asset-descriptors.json','utf8')).descriptors;
const embed={url:'https://content.invalid/watch?v=prepared',provider:'prepared-video',fallback:'Prepared safe card',source:'<oembed url="https://content.invalid/watch?v=prepared">'};
const contentProfiles=[
 {id:'image',selector:'[data-content-module="image"]',options:{asset:descriptors.find(x=>x.kind==='image')},commands:['Load image'],owner:'modules/images/presenter.ts'},
 {id:'file',selector:'[data-content-module="attachment"]',options:{asset:descriptors.find(x=>x.kind==='file')},commands:['Select source to copy','Open file','Download file'],owner:'modules/attachments/presenter.ts'},
 {id:'embed',selector:'[data-content-module="embed"]',options:{embed},commands:['Refresh card','Activate embed','Deactivate embed'],owner:'modules/embeds/presenter.ts'},
];
export function registerContentHostMatrix({probe,mount,snapshot,finish,frame}) {
 for(const profile of contentProfiles)for(const mode of ['absent','denied','unknown','rejected','readonly'])
 test(`MWX-C02 owning ${profile.id} host ${mode}`,()=>probe(`MWX-C02-host-${profile.id}-${mode}`,async(page,fact)=>{
  const baseline=await mount(page,{...profile.options,contentHost:mode==='readonly'?'denied':mode,readOnly:mode==='readonly'});
  await page.waitForFunction(()=>document.querySelector('[data-image-state="loading"]')===null);
  const before=await snapshot(page);fact.snapshots.push(before);
  assert.equal(await page.locator(profile.selector).count(),1,'the owning production presenter must actually mount');
  const initial=await page.evaluate(selector=>{const e=document.querySelector(selector)!;return {buttons:[...e.querySelectorAll<HTMLButtonElement>('button')].map(b=>({label:b.textContent,disabled:b.disabled})),source:e.querySelector<HTMLTextAreaElement>('textarea')!.value,rawSource:(window as any).inputFixture.engine.read().visible.find(n=>Array.isArray(n.blockAttributes)&&n.blockAttributes[0].startsWith('module:')).blockAttributes[2].source,calls:(window as any).contentHostState.calls};},profile.selector);
  assert.deepEqual(initial.buttons.map(b=>b.label),profile.commands);
  assert.equal(initial.rawSource,profile.options.asset?.source??embed.source,'raw source preserved exactly in owning engine');
  assert.equal(initial.source,initial.rawSource.replace(/\r\n?/g,'\n'),'textarea displays native normalized line endings');
  if(profile.id!=='image')assert.equal(initial.calls.length,0,'opening a card does not invoke an action host');
  else assert.equal(initial.calls.length,mode==='absent'?0:1,'only an explicitly supplied image port may resolve');
  for(const label of profile.commands){
   await page.evaluate(({selector,label})=>{const e=document.querySelector(selector)!;[...e.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!.click();},{selector:profile.selector,label});
   await frame(page);
  }
  assert.deepEqual(await snapshot(page),before,'host refusal/read-only/fallback never edits content or history');
  const final=await page.evaluate(selector=>{const e=document.querySelector(selector)!,s=(window as any).contentHostState;return {calls:s.calls,status:e.querySelector('[role="status"]')!.textContent,frameCount:e.querySelectorAll('iframe').length,source:e.querySelector<HTMLTextAreaElement>('textarea')!.value,signals:s.signals.map(s=>s.aborted)};},profile.selector);
  assert.equal(final.frameCount,0);assert.equal(final.source,initial.source);
  assert.equal(final.calls.filter(c=>c.operation==='execute').length,0,'denied file actions never reach the host effect');
  if(mode==='absent'||(profile.id==='embed'&&(mode==='denied'||mode==='readonly')))assert.equal(final.calls.length,0);
  fact.capability={id:profile.id,owner:profile.owner,available:mode!=='absent',enabled:true,authorized:false,qualified:false,mode,initial,final};
  await finish(page,baseline,fact);
  const released=await page.evaluate(()=>(window as any).contentHostState.signals.map(s=>s.aborted));
  assert.ok(released.every(Boolean),'host requests released on rejection/teardown');fact.hostSignalsAfter=released;
 }));
 for(const profile of contentProfiles)
 test(`MWX-C03 remote ${profile.id} never opens an absent host`,()=>probe(`MWX-C03-remote-host-${profile.id}`,async(page,fact)=>{
  const baseline=await mount(page,{...profile.options,contentHost:'absent'}),before=await snapshot(page);
  await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.remote(0,0,'remote ');});await frame(page);
  const after=await snapshot(page);assert.equal(after.history.undoGroups,0);assert.equal(after.journal.length,1);assert.equal(after.patches.filter(p=>p.update).length,1);
  assert.deepEqual(await page.evaluate(()=>(window as any).contentHostState.calls),[]);
  assert.equal(await page.locator('iframe').count(),0);
  fact.capability={id:profile.id,owner:profile.owner,available:false,enabled:true,authorized:false,qualified:false,remoteUpdates:after.patches.filter(p=>p.update).length,localUndoGroups:after.history.undoGroups};
  await finish(page,baseline,fact);
 }));
 test('MWX-C02 unknown inert envelope retains generic fallback without host work',()=>probe('MWX-C02-unknown-inert-fallback',async(page,fact)=>{
  const baseline=await mount(page,{embed,inertType:'fixture.future',contentHost:'rejected'}),before=await snapshot(page);
  assert.equal(await page.locator('[data-content-module="embed"]').count(),0);
  const source=page.locator('[data-content-module="extension-source"] textarea');assert.equal(await source.inputValue(),embed.source);assert.equal(await source.getAttribute('readonly'),'');
  assert.deepEqual(await page.evaluate(()=>(window as any).contentHostState.calls),[]);assert.equal(await page.locator('iframe').count(),0);
  assert.deepEqual(await snapshot(page),before);fact.capability={available:false,enabled:false,authorized:false,qualified:false,fallback:'inert source',source:await source.inputValue()};await finish(page,baseline,fact);
 }));
 test('MWX-C03 all advertised table writes reject protected cells',()=>probe('MWX-C03-table-denied',async(page,fact)=>{
  const profile=commandProfiles.find(p=>p.id==='table')!;
  const baseline=await mount(page,{table:true,protectedCells:[[0,0]]}),before=await snapshot(page);
  await page.evaluate(()=>document.querySelector<HTMLButtonElement>('[aria-label="Select cell row 1 column 1"]')!.click());
  const rows=[];
  for(const label of profile.commands){
   await page.evaluate(label=>{const root=document.querySelector('[data-content-module="table"]')!;const link=root.querySelector<HTMLInputElement>('[aria-label="Table cell link"]')!;link.value='https://example.test/prepared';[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!.click();},label);
   assert.deepEqual(await snapshot(page),before,`${label}: owning protected-cell policy preserves the entire document`);rows.push({label,nonmutating:true});
  }
  fact.capability={available:true,enabled:true,authorized:false,qualified:false,owner:profile.owner,rows};await finish(page,baseline,fact);
 }));
 test('MWX-C03 slash denied and unknown metadata cannot dispatch',()=>probe('MWX-C03-slash-denied-unknown',async(page,fact)=>{
  const baseline=await mount(page,{baselineModules:true}),before=await snapshot(page);
  const state=await page.evaluate(async()=>{const p=(window as any).inputFixture.surface.slash;p.control.click();const denied=p.menu.querySelector('[data-command="disabled"]');const aria=denied.getAttribute('aria-disabled');denied.click();await p.activate('unknown-mobile-command');return {aria,status:p.status.textContent};});
  assert.equal(state.aria,'true');assert.deepEqual(await snapshot(page),before);fact.applicability=state;await finish(page,baseline,fact);
 }));
}
