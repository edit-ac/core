import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const { probe } = browserHarness('link-enrichment','fixtures/browser-link-enrichment',{sourcePaths:[
 'packages/web/src/modules/links/enrichment.ts','packages/web/src/modules/links/contract.ts','packages/web/src/surface.ts','packages/web/src/editor.ts','packages/web/src/index.ts','fixtures/browser-link-enrichment/session.mjs','fixtures/browser-link-enrichment/index.html',
]});
const url='https://example.com/path?private=query';
const state=async(page,fact)=>{const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.ok(fact.requests.every(r=>new URL(r).hostname==='127.0.0.1'||r.startsWith('blob:http://127.0.0.1:')));return s;};
const paste=async page=>{await page.evaluate(()=>window.inputFixture.paste());await page.waitForFunction(()=>window.inputFixture.state().requests.length===1);};
const reply=async(page,kind='available')=>{await page.evaluate(kind=>window.inputFixture.respond(0,kind),kind);await page.waitForFunction(()=>window.inputFixture.state().preview!=='Loading link metadata');};
const text=s=>s.nodes.map(n=>n.runs.map(r=>r.text).join('')).join('\n');
test('successful local HTML paste invokes typed host once and renders inert transient metadata',()=>probe('local-paste',async(page,fact)=>{
 await paste(page);const before=await state(page,fact);assert.equal(before.history.undoGroups,1);assert.equal(before.requests[0].origin,'local-paste');assert.equal(before.requests[0].node,before.nodes[0].id);assert.equal(before.requests[0].target.url,url);
 await reply(page);const after=await state(page,fact);assert.equal(after.preview,'<Safe & title> 😀');assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.history,before.history);assert.equal(after.commands.length,1);assert.equal(await page.locator('aside img, aside a, aside script').count(),0);assert.ok(!fact.requests.some(r=>r.includes('example.com')));assert.equal(await page.getByRole('status').last().textContent(),after.preview);
}));
test('literal plain URL paste enriches through the same local command boundary',()=>probe('plain-url',async(page,fact)=>{
 await page.evaluate(url=>{const f=window.inputFixture;f.select(f.ids[0],5);document.querySelector('#projection').dispatchEvent(preparedClipboardEvent('paste',{getData:m=>m==='text/plain'?url:''}));},url);
 await page.waitForFunction(()=>window.inputFixture.state().requests.length===1);await reply(page);const s=await state(page,fact);assert.ok(text(s).includes(url));assert.equal(s.preview,'<Safe & title> 😀');assert.equal(s.commands.length,1);
}));
for(const policy of ['disabled','explicit-refresh'])test(`${policy} makes no automatic lookup`,()=>probe(`policy-${policy}`,async(page,fact)=>{
 await page.evaluate(p=>{window.inputFixture.setPolicy(p);window.inputFixture.paste();},policy);await page.keyboard.type('typed');const s=await state(page,fact);assert.equal(s.requests.length,0);assert.ok(text(s).includes('typed'));
}));
test('explicit refresh is a separate initiating action and supports readonly preview',()=>probe('refresh',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.setPolicy('explicit-refresh');f.paste();f.surface.setReadOnly(true);f.refresh();});await page.waitForFunction(()=>window.inputFixture.state().requests.length===1);await reply(page);const s=await state(page,fact);assert.equal(s.requests[0].origin,'explicit-refresh');assert.equal(s.requests[0].host.readonly,true);assert.equal(s.preview,'<Safe & title> 😀');assert.equal(await page.evaluate(()=>window.inputFixture.commit()),false);assert.equal((await state(page,fact)).commands.length,1);
}));
for(const action of ['edit','delete','remote','history','readonly','session','principal','permission','policy','revoked','dispose'])test(`${action} rejects a late host result even if host ignores abort`,()=>probe(`late-${action}`,async(page,fact)=>{
 if(action==='delete')await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[1],6);});
 await paste(page);await page.evaluate(action=>window.inputFixture.mutate(action),action);const before=await state(page,fact);await page.evaluate(()=>window.inputFixture.respond());await page.waitForTimeout(0);const after=await state(page,fact);assert.deepEqual(after.aborted,[true]);if(action==='delete')assert.ok(!after.nodes.some(n=>n.id===after.requests[0].node));assert.equal(after.preview,'');assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.history,before.history);assert.deepEqual(after.commands,before.commands);
}));
for(const action of ['edit','delete','readonly','session','principal','permission','policy','revoked'])test(`${action} clears an already displayed preview`,()=>probe(`display-${action}`,async(page,fact)=>{
 if(action==='delete')await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[1],6);});
 await paste(page);await reply(page);await page.evaluate(action=>window.inputFixture.mutate(action),action);const s=await state(page,fact);assert.equal(s.views,0);assert.equal(s.preview,'');assert.deepEqual(s.aborted,[true]);assert.equal(await page.evaluate(()=>window.inputFixture.commit()),false);
}));
test('deliberate metadata commit keeps original target and creates an independent undo group',()=>probe('shared-commit',async(page,fact)=>{
 await paste(page);await reply(page);assert.equal(await page.evaluate(()=>window.inputFixture.commit()),true);let s=await state(page,fact);assert.equal(s.history.undoGroups,2);assert.ok(text(s).includes('<Safe & title> 😀'));assert.equal(s.commands.length,2);assert.equal(s.commands[1].origin,'link:commit-metadata');assert.equal(s.nodes[0].runs.find(r=>r.attributes.link)?.attributes.link,url);assert.equal(s.preview,'');
 await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await state(page,fact);assert.ok(text(s).includes(url));assert.ok(!text(s).includes('<Safe & title>'));assert.equal(s.requests.length,1);
 await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));s=await state(page,fact);assert.ok(text(s).includes('<Safe & title>'));assert.equal(s.requests.length,1);
}));
test('opening/remounting, remote updates, checkpoint replay and history never initiate lookup',()=>probe('no-call-origins',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.setPolicy('disabled');f.paste();f.setPolicy('local-paste');f.remount();f.mutate('remote');const checkpoint=f.engine.checkpoint();f.engine.history({type:'undo'});f.engine.history({type:'redo'});f.replay();});const s=await state(page,fact);assert.equal(s.requests.length,0);assert.equal(s.commands.length,1);assert.equal(s.preview,'');
}));
for(const kind of ['unavailable','forbidden','canceled','stale','malformed','reject'])test(`prepared ${kind} response leaves shared state untouched`,()=>probe(`outcome-${kind}`,async(page,fact)=>{
 await paste(page);const before=await state(page,fact);await reply(page,kind);const s=await state(page,fact);assert.equal(s.preview,'');assert.deepEqual(s.nodes,before.nodes);assert.deepEqual(s.history,before.history);
}));
test('pending host wait never blocks typing and disposal releases subscription once',()=>probe('typing-disposal',async(page,fact)=>{
 await paste(page);await page.keyboard.type('typed');let s=await state(page,fact);assert.ok(text(s).includes('typed'));assert.deepEqual(s.aborted,[true]);await page.evaluate(()=>{window.inputFixture.surface.dispose();window.inputFixture.surface.dispose();});s=await state(page,fact);assert.equal(s.released,1);assert.equal(s.listeners,0);assert.equal(await page.locator('aside[aria-label="Link metadata"]').count(),0);
}));

test('burst requests stay inside finite presentation/request capacity',()=>probe('burst-bound',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;const links=Array.from({length:24},(_,i)=>`<p><a href="https://example.com/${i}">label${i}</a></p>`).join('');document.querySelector('#projection').dispatchEvent(preparedClipboardEvent('paste',{getData:m=>m==='text/html'?links:''}));});
 await page.waitForFunction(()=>window.inputFixture.state().requests.length===16);const s=await state(page,fact);assert.equal(s.views,16);assert.equal(s.requests.length,16);await page.evaluate(()=>window.inputFixture.surface.dispose());assert.ok((await state(page,fact)).aborted.every(Boolean));
}));
test('disabled explicit refresh and ordinary link edits make no calls',()=>probe('disabled-refresh',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.setPolicy('disabled');f.paste();f.refresh();f.mutate('edit');f.refresh();});assert.equal((await state(page,fact)).requests.length,0);
}));

test('current host scope rejects results even before invalidation notification arrives',()=>probe('silent-session',async(page,fact)=>{
 await paste(page);await page.evaluate(()=>window.inputFixture.silentSession());await reply(page);const s=await state(page,fact);assert.equal(s.preview,'');assert.equal(s.commands.length,1);
}));
test('deliberate sharing rechecks current host readonly even without notification',()=>probe('silent-readonly',async(page,fact)=>{
 await paste(page);await reply(page);await page.evaluate(()=>window.inputFixture.silentReadonly());assert.equal(await page.evaluate(()=>window.inputFixture.commit()),false);const s=await state(page,fact);assert.equal(s.commands.length,1);assert.equal(s.history.undoGroups,1);
}));
test('finite deadline aborts a host that never settles without blocking editing',()=>probe('deadline',async(page,fact)=>{
 await page.clock.install();await paste(page);await page.clock.fastForward(15001);const s=await state(page,fact);assert.deepEqual(s.aborted,[true]);assert.equal(s.views,0);assert.equal(s.commands.length,1);
}));

test('a lost host context before dispatch aborts safely without rejecting the committed paste',()=>probe('context-loss',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.paste();f.unavailableContext();});const s=await state(page,fact);assert.equal(s.requests.length,0);assert.equal(s.views,0);assert.equal(s.commands.length,1);assert.ok(text(s).includes(url));
}));

test('host-vetted favicon bytes use a local object URL revoked on disposal',()=>probe('favicon-blob',async(page,fact)=>{
 await page.evaluate(()=>window.inputFixture.assetMode('gif'));await paste(page);await reply(page);await page.waitForFunction(()=>document.querySelector('aside img')?.naturalWidth===1);let s=await state(page,fact);assert.equal(s.assetUrls.length,1);assert.ok(s.assetUrls[0].startsWith('blob:http://127.0.0.1:'));assert.equal(await page.locator('aside img').getAttribute('aria-hidden'),'true');assert.equal(await page.locator('aside img').getAttribute('alt'),'');await page.evaluate(()=>window.inputFixture.surface.dispose());s=await state(page,fact);assert.deepEqual(s.revokedAssets,s.assetUrls);
}));
for(const mode of ['svg','huge'])test(`host ${mode} icon retains safe title fallback without asset request`,()=>probe(`favicon-${mode}`,async(page,fact)=>{
 await page.evaluate(mode=>window.inputFixture.assetMode(mode),mode);await paste(page);await reply(page);const s=await state(page,fact);assert.equal(s.preview,'<Safe & title> 😀');assert.deepEqual(s.assetUrls,[]);assert.equal(await page.locator('aside img').count(),0);
}));

test('qualification records real input, checkpoint and focus while prepared lookup is unresolved',()=>probe('qualification-input-timing',async(page,fact)=>{
 const samples={baseline_input_to_frame_ms:[],pending_input_to_frame_ms:[],checkpoint_ms:[],restore_ms:[],local_paste_ms:[],prepared_wait_ms:[],reply_to_frame_ms:[]};
 let attempted=0, aborted=0;
 // Same fixture/runtime, alternating order to avoid treating startup drift as a
 // resolver regression. Ten warmups per profile; 120 measured samples each.
 for(let i=0;i<130;i++)for(const enabled of (i%2?[true,false]:[false,true])){
  const start=await page.evaluate(async enabled=>{
   const f=window.inputFixture;f.setPolicy(enabled?'local-paste':'disabled');f.reset();
   const t=performance.now();f.paste();await Promise.resolve();await Promise.resolve();
   const s=f.state(),index=s.requests.length-1;
   const checkpointStart=performance.now(),checkpoint=f.engine.checkpoint();
   const checkpointMs=performance.now()-checkpointStart;
   if(enabled && (index<0||s.aborted[index]))throw Error('expected pending prepared lookup');
   if(!checkpoint.bytes.length)throw Error('missing persistence bytes');
   f.select(f.ids[1],0);
   window.qualificationInputStamp=null;
   document.querySelector('#projection').addEventListener('beforeinput',()=>{window.qualificationInputStamp=performance.now();},{capture:true,once:true});
   return {index,pasteMs:checkpointStart-t,checkpointMs,started:t,requests:s.requests.length};
  },enabled);
  await page.keyboard.type('x');
  const result=await page.evaluate(async ({enabled,start})=>{
   await new Promise(requestAnimationFrame);
   const f=window.inputFixture,s=f.state(),root=document.querySelector('#projection');
   if(window.qualificationInputStamp===null||!root.textContent.includes('xsecond'))throw Error('real input not presented');
   if(document.activeElement!==root)throw Error('editing lost focus');
   const inputMs=performance.now()-window.qualificationInputStamp;
   const checkpoint=f.engine.checkpoint(),persisted=Array.from(checkpoint.bytes);
   const restoreStart=performance.now();f.replay();const restoreMs=performance.now()-restoreStart;
   if(JSON.stringify(Array.from(f.engine.checkpoint().bytes))!==JSON.stringify(persisted))throw Error('checkpoint restore changed committed bytes');
   const waited=performance.now()-start.started;
   // A result from the old request cannot change restored/edited content.
   if(enabled)f.respond(start.index);await Promise.resolve();await Promise.resolve();
   if(JSON.stringify(Array.from(f.engine.checkpoint().bytes))!==JSON.stringify(persisted))throw Error('late metadata wrote shared bytes');
   return {inputMs,restoreMs,waited,aborted:enabled?f.state().aborted[start.index]:true,requests:s.requests.length};
  },{enabled,start});
  if(enabled){attempted++;assert.equal(result.aborted,true);aborted++;}
  else assert.equal(result.requests,start.requests,'disabled input schedules no request');
  if(i>=10){samples[enabled?'pending_input_to_frame_ms':'baseline_input_to_frame_ms'].push(result.inputMs);if(enabled){samples.checkpoint_ms.push(start.checkpointMs);samples.restore_ms.push(result.restoreMs);samples.local_paste_ms.push(start.pasteMs);samples.prepared_wait_ms.push(result.waited);}}
 }
 // Measure inert preview delivery separately from editing/restore cancellation.
 for(let i=0;i<130;i++){
  const sample=await page.evaluate(async()=>{const f=window.inputFixture;f.setPolicy('local-paste');f.reset();f.paste();await Promise.resolve();await Promise.resolve();const index=f.state().requests.length-1;const start=performance.now();f.respond(index);await Promise.resolve();await Promise.resolve();await new Promise(requestAnimationFrame);if(!f.state().preview.includes('Safe'))throw Error('preview not delivered');return performance.now()-start;});
  if(i>=10)samples.reply_to_frame_ms.push(sample);
 }
 fact.timings={provenance:'headless real browser keyboard and packed WASM editor; prepared unresolved host; alternating profiles, 10 warmups excluded; frame is rAF observation, not OS input/physical display',samples,attempted,aborted};
 const final=await page.evaluate(()=>{const f=window.inputFixture;f.surface.dispose();const s=f.state();return{listeners:s.listeners,views:s.views,aborted:s.aborted.every(Boolean)};});
 assert.equal(final.listeners,0);assert.equal(final.views,0);assert.equal(final.aborted,true);fact.timings.disposed=final;
 assert.ok(fact.requests.every(r=>new URL(r).hostname==='127.0.0.1'||r.startsWith('blob:http://127.0.0.1:')));
}));
