import assert from 'node:assert/strict';
import {test} from 'node:test';
import {preparedCompletionBackend} from '../../examples/ai-completion-backend/prepared.mjs';
import {browserHarness} from './browser-harness.ts';
const harness=browserHarness('ai-completion','fixtures/browser-ai-completion',{
 contextOptions:{hasTouch:true},assertSourcesUnchanged:true,
 beforeNavigate:async(page,fact)=>{
  page.setDefaultTimeout(5000);await page.clock.install({time:new Date('2026-10-17T14:00:00Z')});
  fact.sdk={calls:0,version:'ai@7.0.143 / provider@4.0.29',provider:'MockLanguageModelV4',providerCalls:0};
  const backend=preparedCompletionBackend(()=>fact.sdk.calls++);
  await page.route('**/prepared-completion',async route=>{
   const events=[];try { for await(const event of backend.send(route.request().postDataJSON(),new AbortController().signal))events.push(event);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(events)});
   } catch { await route.fulfill({status:503,body:'Prepared backend failure'}); }
  });
 },
 sourcePaths:['packages/web/src/extensions/ai/completion.ts','packages/web/tests/ai-completion.test.ts','fixtures/browser-ai-completion/session.mjs','fixtures/browser-ai-completion/index.html','scripts/test-web.mjs','examples/ai-completion-backend/backend.mjs','examples/ai-completion-backend/prepared.mjs','examples/ai-completion-backend/package-lock.json'],
});
const probe=(name,action,config={})=>harness.probe(name,async(page,fact)=>{await page.clock.pauseAt(await page.evaluate(()=>Date.now()+1000));await action(page,fact);},{optIn:true,...config});
const state=page=>page.evaluate(()=>window.inputFixture.state());
const manual=page=>page.evaluate(()=>window.inputFixture.actions.complete());
const select=(page,a,b=a)=>page.evaluate(v=>window.inputFixture.select(0,...v),[a,b]);
const tick=(page,ms=1001)=>page.clock.runFor(ms);
const button=(page,name)=>page.getByRole('button',{name,exact:true});

test('disabled by default with zero background or manual requests',()=>probe('disabled',async page=>{
 await manual(page);await page.keyboard.type('x');await tick(page);assert.equal((await state(page)).requests.length,0);assert.match((await state(page)).status,/disabled/);
},{optIn:false}));
test('host admission is mandatory after editor opt-in',()=>probe('unavailable',async page=>{await manual(page);assert.equal((await state(page)).requests.length,0);assert.match((await state(page)).status,/Configure/);},{enabled:false}));
test('rapid real typing debounces to exactly one latest-context request',()=>probe('debounce',async(page,fact)=>{
 await page.keyboard.type('xyz');assert.equal((await state(page)).requests.length,0);await tick(page,999);assert.equal((await state(page)).requests.length,0);await tick(page,2);await page.evaluate(()=>window.inputFixture.idle());const s=await state(page);assert.equal(s.requests.length,1);assert.equal(s.requests[0].context,'alphaxyz');assert.equal(fact.sdk.calls,1);assert.equal(s.ai.status,'review');
}));
test('ghost never changes CRDT, history, offsets, copying or persisted content',()=>probe('ephemeral',async page=>{
 const before=await state(page);await manual(page);const s=await state(page);for(const key of ['checkpoint','vector','history','journal','html','text'])assert.deepEqual(s[key],before[key],key);assert.equal(s.ghost,'Prepared שלום 🧪');assert.equal(await page.locator('#projection').textContent(),'alphaindependent');
 const copied=await page.evaluate(()=>{const root=document.querySelector('#projection');document.getSelection().selectAllChildren(root);const d=new DataTransfer(),event=new ClipboardEvent('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:d});root.dispatchEvent(event);return d.getData('text/plain');});assert.ok(!copied.includes('Prepared'));
 assert.deepEqual(await page.evaluate(()=>window.inputFixture.reopen()),before.text);
}));
test('actual Tab accepts once through storage middleware and one undo group',()=>probe('keyboard',async(page,fact)=>{
 await manual(page);await page.keyboard.press('Tab');let s=await state(page);assert.equal(s.text[0],'alphaPrepared שלום 🧪');assert.deepEqual(s.commands,['ai:reviewed']);assert.equal(s.history.undoGroups,1);await page.evaluate(()=>window.inputFixture.actions.accept());assert.equal((await state(page)).commands.length,1);await page.evaluate(()=>window.inputFixture.history('undo'));assert.deepEqual((await state(page)).text,['alpha','independent']);fact.mechanics={keyboard:'Actual Chromium Tab via real middleware',screenReader:'original OS AT deferred'};
}));
test('actual touch controls and polite accessible live status',()=>probe('touch',async(page,fact)=>{
 await manual(page);assert.match(await page.getByRole('region',{name:'Writing completion'}).ariaSnapshot(),/Accept completion/);assert.equal(await page.getByRole('status').filter({hasText:'Suggestion:'}).getAttribute('aria-live'),'polite');await button(page,'Dismiss completion').tap();assert.equal((await state(page)).ghost,'');await manual(page);await button(page,'Accept completion').tap();assert.equal((await state(page)).text[0],'alphaPrepared שלום 🧪');fact.mechanics={touch:'Virtual Playwright touchscreen; no physical/OS AT claim'};
}));
test('no-suggestion Tab preserves navigation; configured Enter accepts',()=>probe('keymap',async page=>{
 await page.keyboard.press('Tab');assert.equal(await page.locator('#projection').evaluate(e=>e===document.activeElement),false);await select(page,5);await manual(page);await page.keyboard.press('Tab');assert.equal((await state(page)).commands.length,0);await select(page,5);await manual(page);await page.keyboard.press('Enter');assert.equal((await state(page)).text[0],'alphaPrepared שלום 🧪');
},{acceptKey:'Enter'}));
test('Escape clears suggestion without editing',()=>probe('escape',async page=>{await manual(page);await page.keyboard.press('Escape');const s=await state(page);assert.equal(s.ghost,'');assert.equal(s.history.undoGroups,0);assert.deepEqual(s.text,['alpha','independent']);}));
test('composition and host dictation suspend automatic and manual requests',()=>probe('composition',async page=>{
 await page.locator('#projection').dispatchEvent('compositionstart');await manual(page);await tick(page);assert.equal((await state(page)).requests.length,0);await page.locator('#projection').dispatchEvent('compositionend');await page.evaluate(()=>window.inputFixture.actions.setDictating(true));await manual(page);await tick(page);assert.equal((await state(page)).requests.length,0);await page.evaluate(()=>window.inputFixture.actions.setDictating(false));await manual(page);assert.equal((await state(page)).requests.length,1);
}));
test('range and active pointer selection suspend requests',()=>probe('selection',async page=>{
 await select(page,0,3);await manual(page);assert.equal((await state(page)).requests.length,0);await select(page,5);await page.locator('#projection').dispatchEvent('pointerdown');await manual(page);assert.equal((await state(page)).requests.length,0);await page.locator('#projection').dispatchEvent('pointerup');await manual(page);assert.equal((await state(page)).requests.length,1);
}));
test('caret moves, remote target changes and blur invalidate suggestions',()=>probe('invalidation',async page=>{
 await manual(page);await select(page,1);assert.equal((await state(page)).ghost,'');await manual(page);await page.evaluate(()=>window.inputFixture.remote(0,'remote'));assert.equal((await state(page)).ghost,'');await select(page,2);await manual(page);await page.locator('#elsewhere').focus();assert.equal((await state(page)).ghost,'');assert.equal((await state(page)).commands.length,0);
}));
test('superseding edits abort pending work and reject late output',()=>probe('supersede',async page=>{
 await page.evaluate(()=>{window.inputFixture.setMode('slow');void window.inputFixture.actions.complete();});assert.equal((await state(page)).requests.length,1);await page.keyboard.type('x');assert.equal((await state(page)).aborts,1);await page.evaluate(()=>{window.inputFixture.setMode('good');window.inputFixture.finish();});await tick(page);await page.evaluate(()=>window.inputFixture.idle());const s=await state(page);assert.equal(s.requests.length,2);assert.equal(s.ghost,'Prepared שלום 🧪');assert.equal(s.requests[1].context,'alphax');assert.equal(s.commands.filter(origin=>origin==='ai:reviewed').length,0);
}));
test('quota counts manual replacement requests',()=>probe('quota',async page=>{await manual(page);await manual(page);await manual(page);const s=await state(page);assert.equal(s.requests.length,2);assert.equal(s.ai.status,'failed');assert.equal(s.ai.error,'quota');assert.equal(s.ghost,'');},{requests:2}));
for(const [name,text] of [['context-limit','é'.repeat(3000)],['atom','before\uFFFCafter']])test(`${name} excludes transport before dispatch`,()=>probe(name,async page=>{await manual(page);assert.equal((await state(page)).requests.length,0);},{text}));
test('unrelated remote edit survives acceptance and undo',()=>probe('remote-undo',async page=>{
 await manual(page);await page.evaluate(()=>window.inputFixture.remote(1,'REMOTE'));assert.equal((await state(page)).requests.length,1);assert.equal((await state(page)).ghost,'Prepared שלום 🧪');await button(page,'Accept completion').click();assert.deepEqual((await state(page)).text,['alphaPrepared שלום 🧪','REMOTEindependent']);await page.evaluate(()=>window.inputFixture.history('undo'));assert.deepEqual((await state(page)).text,['alpha','REMOTEindependent']);
}));
test('read-only and disposal abort pending work and remove owned UI',()=>probe('lifecycle',async page=>{
 await page.evaluate(()=>{window.inputFixture.setMode('slow');void window.inputFixture.actions.complete();});await page.evaluate(()=>window.inputFixture.editor.setReadOnly(true));assert.equal((await state(page)).aborts,1);assert.equal((await state(page)).ghost,'');await page.evaluate(()=>window.inputFixture.actions.setEnabled(false));await page.evaluate(()=>window.inputFixture.destroy());assert.equal(await page.getByRole('region',{name:'Writing completion'}).count(),0);
}));

test('code blocks exclude transport before dispatch',()=>probe('code',async page=>{await manual(page);assert.equal((await state(page)).requests.length,0);},{code:true}));
test('oversized output fails closed with no ghost or history',()=>probe('output-cap',async page=>{await page.evaluate(()=>{window.inputFixture.setMode('unsafe');window.inputFixture.setResponse('x'.repeat(1025));});await manual(page);const s=await state(page);assert.equal(s.ai.status,'failed');assert.equal(s.ghost,'');assert.equal(s.history.undoGroups,0);}));
test('disable cancels debounce and permission transition rejects pending acceptance',()=>probe('disable-permission',async page=>{await page.keyboard.type('x');await page.evaluate(()=>window.inputFixture.actions.setEnabled(false));await tick(page);assert.equal((await state(page)).requests.length,0);await page.evaluate(()=>window.inputFixture.actions.setEnabled(true));await manual(page);await page.evaluate(()=>{window.inputFixture.deny();});await button(page,'Accept completion').click({force:true});assert.equal((await state(page)).commands.filter(o=>o==='ai:reviewed').length,0);assert.equal((await state(page)).ghost,'');}));

test('real inline module atom excludes completion without flattening',()=>probe('module-atom',async page=>{const before=await state(page);await manual(page);assert.equal((await state(page)).requests.length,0);assert.deepEqual((await state(page)).checkpoint,before.checkpoint);},{text:'x^2',atom:true}));

test('without a valid suggestion Tab preserves real table cell navigation',()=>probe('table-tab',async page=>{
 const first=page.getByRole('textbox',{name:'Table row 2 column 1',exact:true}),second=page.getByRole('textbox',{name:'Table row 2 column 2',exact:true});
 await first.focus();await manual(page);assert.equal((await state(page)).requests.length,0);await first.press('Tab');assert.equal(await second.evaluate(e=>e===document.activeElement),true);await second.press('Shift+Tab');assert.equal(await first.evaluate(e=>e===document.activeElement),true);assert.equal((await state(page)).commands.filter(origin=>origin==='ai:reviewed').length,0);
},{table:true}));
test('code Tab indentation stays with existing input middleware',()=>probe('code-tab',async page=>{
 const before=await state(page);await page.keyboard.press('Tab');const after=await state(page);assert.equal(after.requests.length,0);assert.notEqual(after.text[0],before.text[0]);assert.ok(after.text[0].includes('alpha'));assert.equal(after.commands.filter(origin=>origin==='ai:reviewed').length,0);
},{code:true}));

for(const reason of ['blur','dispose','caret','remote'])test(`pending ${reason} aborts exactly once and late output cannot publish`,()=>probe(`pending-${reason}`,async page=>{
 await page.evaluate(()=>{window.inputFixture.setMode('slow');void window.inputFixture.actions.complete();});
 assert.deepEqual(await page.evaluate(()=>window.inputFixture.transportState),{requests:1,aborts:0});
 if(reason==='blur')await page.locator('#elsewhere').focus();
 else if(reason==='dispose')await page.evaluate(()=>window.inputFixture.destroy());
 else if(reason==='caret')await select(page,1);
 else await page.evaluate(()=>window.inputFixture.remote(0,'remote'));
 await page.evaluate(()=>{window.inputFixture.finish();});await page.evaluate(()=>window.inputFixture.idle());
 assert.deepEqual(await page.evaluate(()=>window.inputFixture.transportState),{requests:1,aborts:1});
 assert.equal(await page.evaluate(()=>window.inputFixture.actions.ghost.textContent),'');
 assert.notEqual(await page.evaluate(()=>window.inputFixture.actions.session.state.status),'review');
}));
