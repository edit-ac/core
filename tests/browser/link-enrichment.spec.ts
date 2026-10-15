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
