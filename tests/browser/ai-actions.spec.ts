import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('ai-actions','fixtures/browser-ai-actions',{
 contextOptions:{hasTouch:true},
 assertSourcesUnchanged:true,
 beforeNavigate: page => { page.setDefaultTimeout(5000); },
 sourcePaths:['packages/web/src/extensions/ai/actions.ts','packages/web/tests/ai-actions.test.ts','fixtures/browser-ai-actions/session.mjs','fixtures/browser-ai-actions/index.html','scripts/test-web.mjs'],
});
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const state=page=>page.evaluate(()=>window.inputFixture.state());
async function open(page,name='Fill text',scope='passage') {
 await button(page,name).click();await page.getByLabel('Instruction',{exact:true}).fill('Prepared instruction');await page.getByLabel('Context scope',{exact:true}).selectOption(scope);
}
async function generate(page) {await button(page,'Generate').click();await page.waitForFunction(()=>['review','failed','stale'].includes(window.inputFixture.actions.session.state.status));}
async function select(page,index,from,to=from){await page.evaluate(v=>window.inputFixture.select(...v),[index,from,to]);}

test('Ask AI answers remain ephemeral and selection context is explicit',()=>probe('answer',async page=>{
 await select(page,0,0,5);const before=await state(page);await open(page,'Ask AI about selection','selection');await generate(page);const after=await state(page);
 assert.deepEqual(after.text,before.text);assert.deepEqual(after.history,before.history);assert.deepEqual(after.journal,before.journal);assert.equal(after.requests.length,1);assert.equal(after.requests[0].context,'alpha');assert.equal(after.requests[0].operation,'ask');assert.equal(after.ai.text,'Prepared שלום 🧪');assert.equal(await button(page,'Accept').isDisabled(),true);assert.match(after.status,/Answer only/);
 await button(page,'Reject').click();assert.equal((await state(page)).ai.text,'');
}));
test('reviewed selection commits via real storage middleware once and survives reopening',()=>probe('selection-storage',async page=>{
 await select(page,0,1,4);await open(page);await generate(page);assert.deepEqual((await state(page)).text,['alpha','independent']);
 await button(page,'Accept').click();let s=await state(page);assert.deepEqual(s.text,['aPrepared שלום 🧪a','independent']);assert.equal(s.history.undoGroups,1);assert.deepEqual(s.commands,['ai:reviewed']);assert.ok(s.journal.includes('editac:local:ai:reviewed'));assert.equal(s.focus,true);assert.equal(await button(page,'Regenerate').isDisabled(),true);
 await page.evaluate(()=>window.inputFixture.actions.accept());assert.equal((await state(page)).commands.length,1);
 await page.evaluate(()=>window.inputFixture.history('undo'));assert.deepEqual((await state(page)).text,['alpha','independent']);await page.evaluate(()=>window.inputFixture.history('redo'));assert.deepEqual((await state(page)).text,s.text);
 assert.deepEqual(await page.evaluate(()=>window.inputFixture.reopen()),s.text);
}));
for(const [name,text,from,to,operation,target,expected] of [
 ['empty','',0,0,'Fill text','selection','Prepared שלום 🧪'],
 ['caret','alpha',2,2,'Fill text','selection','alPrepared שלום 🧪pha'],
 ['block','alpha',2,2,'Fill text','block','Prepared שלום 🧪'],
 ['continue','alpha',1,1,'Continue writing','selection','alphaPrepared שלום 🧪'],
 ['unicode','אבג 🧪',4,6,'Fill text','selection','אבג Prepared שלום 🧪'],
]) test(`captured ${name} target stays fixed across focus/caret changes`,()=>probe(name,async page=>{
 await select(page,0,from,to);await open(page,operation);await page.getByLabel('Proposal target',{exact:true}).selectOption(target);await generate(page);
 await select(page,1,2);await page.locator('#elsewhere').focus();await page.evaluate(()=>window.inputFixture.actions.accept());const s=await state(page);assert.equal(s.text[0],expected);assert.equal(s.text[1],'independent');assert.equal(s.focus,false);assert.equal(s.history.undoGroups,1);assert.equal(s.errors.length,0);
},text));
test('Stop aborts a prepared pending request and late chunks cannot apply',()=>probe('stop',async page=>{
 await page.evaluate(()=>window.inputFixture.setMode('slow'));await open(page);await button(page,'Generate').click();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='pending');await button(page,'Stop').click();await page.evaluate(()=>window.inputFixture.finish());const s=await state(page);assert.equal(s.ai.status,'canceled');assert.equal(s.requests.length,1);assert.equal(s.aborts,1);assert.deepEqual(s.text,['alpha','independent']);assert.equal(s.history.undoGroups,0);assert.equal(s.commands.length,0);
}));
test('Regenerate is a new admitted request with a fixed original target and hard cap',()=>probe('regenerate-cap',async page=>{
 await select(page,0,1,4);await open(page);await generate(page);await select(page,1,1);await button(page,'Regenerate').click();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='review'&&window.inputFixture.actions.host.used===2);
 await button(page,'Regenerate').click();await page.waitForFunction(()=>window.inputFixture.actions.host.used===3);await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='review');await button(page,'Regenerate').click();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='failed');const s=await state(page);assert.equal(s.requests.length,3);assert.equal(new Set(s.requests.map(r=>r.requestId)).size,3);assert.ok(s.requests.every(r=>r.context==='alpha'));assert.equal(s.ai.error,'quota');assert.deepEqual(s.text,['alpha','independent']);assert.equal(s.commands.length,0);
}));
test('Reject clears review without mutating the document or history',()=>probe('reject',async page=>{
 const before=await state(page);await open(page);await generate(page);await button(page,'Reject').click();const s=await state(page);assert.equal(s.ai.status,'rejected');assert.equal(s.focus,true);assert.deepEqual(s.text,before.text);assert.deepEqual(s.history,before.history);assert.deepEqual(s.journal,before.journal);
}));
test('relevant remote changes visibly stale the proposal; unrelated changes survive acceptance/undo',()=>probe('remote',async page=>{
 await select(page,0,0,5);await open(page);await generate(page);await page.evaluate(()=>window.inputFixture.remote(1,'peer '));await button(page,'Accept').click();assert.deepEqual((await state(page)).text,['Prepared שלום 🧪','peer independent']);await page.evaluate(()=>window.inputFixture.history('undo'));assert.deepEqual((await state(page)).text,['alpha','peer independent']);
 await select(page,0,0,5);await open(page);await generate(page);await page.evaluate(()=>window.inputFixture.remote(0,'changed '));assert.equal((await state(page)).ai.status,'stale');assert.equal(await button(page,'Accept').isDisabled(),true);assert.deepEqual((await state(page)).text,['changed alpha','peer independent']);
}));
test('explicit document scope binds every included context owner',()=>probe('document-scope',async page=>{
 await open(page,'Ask AI','document');await generate(page);assert.equal((await state(page)).requests[0].context,'alpha\nindependent');await page.evaluate(()=>window.inputFixture.remote(1,'changed '));assert.equal((await state(page)).ai.status,'stale');
}));
test('unsafe markup is inert plain text in review and accepted content',()=>probe('inert-format',async page=>{
 await page.evaluate(()=>window.inputFixture.setMode('unsafe'));await select(page,0,0,5);await open(page);await generate(page);assert.equal(await page.locator('[aria-label="AI answer or proposed plain text"] script').count(),0);await button(page,'Accept').click();const s=await state(page);assert.equal(s.executed,false);assert.equal(s.text[0],'<script>window.executed=true</script><b>plain</b>');assert.equal(await page.locator('#projection script').count(),0);
}));
test('prepared transport failure retains content and exposes recovery state',()=>probe('failure',async page=>{
 await page.evaluate(()=>window.inputFixture.setMode('error'));await open(page);await generate(page);const s=await state(page);assert.equal(s.ai.status,'failed');assert.equal(s.ai.error,'transport');assert.equal(s.history.undoGroups,0);assert.deepEqual(s.text,['alpha','independent']);assert.equal(await button(page,'Accept').isDisabled(),true);
}));
test('read-only and disposal abort work and remove owned UI',()=>probe('lifecycle',async page=>{
 await page.evaluate(()=>window.inputFixture.setMode('slow'));await open(page);await button(page,'Generate').click();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='pending');await page.evaluate(()=>window.inputFixture.editor.setReadOnly(true));let s=await state(page);assert.equal(s.ai.status,'stale');assert.equal(s.aborts,1);assert.equal(s.history.undoGroups,0);await page.evaluate(()=>window.inputFixture.destroy());assert.equal(await page.getByRole('region',{name:'AI writing',exact:true}).count(),0);
}));
test('actual virtual keyboard invokes slash action and controls Escape/Generate/Accept',()=>probe('keyboard-mechanics',async(page,fact)=>{
 await page.locator('#projection').press('End');await page.keyboard.type('/ask');await page.waitForFunction(()=>window.inputFixture.editor.slash.open);await page.keyboard.press('Enter');await page.getByLabel('Instruction',{exact:true}).waitFor({state:'visible'});
 assert.equal(await page.getByLabel('Instruction',{exact:true}).evaluate(e=>e===document.activeElement),true);await page.keyboard.type('Prepared keyboard answer');await page.keyboard.press('Tab');await page.keyboard.press('Tab');assert.equal(await button(page,'Generate').evaluate(e=>e===document.activeElement),true);await page.keyboard.press('Enter');await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='review');assert.equal((await state(page)).requests.length,1);await page.keyboard.press('Escape');assert.equal((await state(page)).ai.status,'canceled');fact.mechanics={keyboard:'Playwright actual key dispatch to real middleware',screenReader:'not executed'};
},''));
test('actual virtual touchscreen accepts a captured selection',()=>probe('touch-mechanics',async(page,fact)=>{
 await select(page,0,0,5);await button(page,'Fill text').tap();await page.getByLabel('Instruction',{exact:true}).fill('Prepared touch');await button(page,'Generate').tap();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='review');await button(page,'Accept').tap();assert.equal((await state(page)).text[0],'Prepared שלום 🧪');fact.mechanics={touch:'Playwright touchscreen in touch-enabled Chromium; no physical device claim'};
}));
test('browser accessibility semantics expose labels, polite status and answer-only state',()=>probe('accessibility-semantics',async(page,fact)=>{
 await open(page,'Ask AI');await generate(page);const tree=await page.getByRole('region',{name:'AI writing',exact:true}).ariaSnapshot();assert.match(tree,/Instruction/);assert.match(tree,/Context scope/);assert.match(tree,/Accept.*disabled/);assert.match(tree,/Answer only/);assert.equal(await page.getByRole('status').filter({hasText:'Answer only'}).getAttribute('aria-live'),'polite');fact.mechanics={accessibilityTree:tree,screenReader:'not executed; actual VoiceOver/OS AT remains required'};
}));

test('unconfigured availability is visible and dispatches zero requests',()=>probe('unavailable',async page=>{
 await button(page,'Ask AI').click();assert.match(await page.getByRole('status').filter({hasText:'AI unavailable'}).textContent(),/Configure a host transport/);assert.equal(await button(page,'Generate').isDisabled(),true);assert.equal((await state(page)).requests.length,0);
},{enabled:false}));
test('context byte cap rejects before transport and leaves history untouched',()=>probe('context-limit',async page=>{
 await open(page);await button(page,'Generate').click();assert.match(await page.getByRole('status').filter({hasText:'context-limit'}).textContent(),/context-limit/);const s=await state(page);assert.equal(s.requests.length,0);assert.equal(s.history.undoGroups,0);assert.equal(s.text[0].length,5000);
},'é'.repeat(5000)));
test('actual keyboard reviews and accepts without requiring pointer activation',()=>probe('keyboard-accept',async(page,fact)=>{
 await select(page,0,0,5);await button(page,'Fill text').focus();await page.keyboard.press('Enter');await page.keyboard.type('Prepared keyboard fill');await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Enter');await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='review');await button(page,'Accept').focus();await page.keyboard.press('Enter');assert.equal((await state(page)).text[0],'Prepared שלום 🧪');assert.equal((await state(page)).focus,true);fact.mechanics={keyboard:'Actual Playwright Enter/Tab to controls; real BrowserEditor and prepared transport'};
}));

test('selection-only control explains absent selection without dispatch',()=>probe('missing-selection',async page=>{
 await button(page,'Ask AI about selection').click();assert.match(await page.getByRole('status').filter({hasText:'select a supported paragraph target'}).textContent(),/Unavailable/);assert.equal(await button(page,'Generate').isDisabled(),true);const s=await state(page);assert.equal(s.requests.length,0);assert.deepEqual(s.text,['alpha','independent']);
}));

test('actual touch stop, regeneration and rejection retain the captured editing target',()=>probe('touch-lifecycle',async(page,fact)=>{
 await select(page,0,1,4);await page.evaluate(()=>window.inputFixture.setMode('slow'));await button(page,'Fill text').tap();await page.getByLabel('Instruction',{exact:true}).fill('Prepared touch lifecycle');await button(page,'Generate').tap();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='pending');await button(page,'Stop').tap();assert.equal((await state(page)).ai.status,'canceled');await select(page,1,0);await page.evaluate(()=>window.inputFixture.setMode('good'));await button(page,'Regenerate').tap();await page.waitForFunction(()=>window.inputFixture.actions.session.state.status==='review');assert.equal((await state(page)).requests.length,2);await button(page,'Reject').tap();const s=await state(page);assert.equal(s.ai.status,'rejected');assert.equal(s.focus,true);assert.deepEqual(s.text,['alpha','independent']);assert.equal(s.history.undoGroups,0);
 const range=await page.evaluate(()=>{const e=window.inputFixture.engine,r=document.getSelection(),p=(n,o)=>{const el=n.nodeType===1?n:n.parentElement,b=el.closest('[data-node-id]'),v=document.createRange();v.selectNodeContents(b);v.setEnd(n,o);return {owner:b.dataset.nodeId,offset:v.toString().length};};return [p(r.anchorNode,r.anchorOffset),p(r.focusNode,r.focusOffset)];});assert.deepEqual(range.map(p=>p.offset),[1,4]);assert.equal(range[0].owner,range[1].owner);fact.mechanics={touch:'Actual virtual touchscreen Stop/Regenerate/Reject, captured root range restored'};
}));
