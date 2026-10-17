import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { browserHarness } from '../../browser/browser-harness.ts';
import { hostOwner } from './host.mjs';
import { fixture, prepareConsumer } from './artifacts.mjs';

const portable = process.env.EDITAC_PRIMARY_FLOW_PROFILE === 'portable-mobile';
const owners = new Map(); let serial = 0;
const output = resolve(process.env.EDITAC_PRIMARY_FLOW_OUTPUT!);
const { probe, facts } = browserHarness('primary-flow', fixture, {
  autoMount: false, markdown: false, assertSourcesUnchanged: true,
  testFile: 'tests/integrated-browser/primary-flow-20261018/product.spec.ts',
  contextOptions: portable ? { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } },
  sourcePaths: ['session.mjs','index.html','host.mjs','artifacts.mjs'].map(n => `tests/integrated-browser/primary-flow-20261018/${n}`).concat([
    'packages/web/src/editor.ts','packages/web/src/sdk.ts','packages/web/src/extensions/configuration.ts','packages/web/src/host/apply.ts','packages/web/src/host/contract.ts',
    'packages/web/src/modules/search.ts','packages/web/src/modules/reorder.ts','packages/web/src/sync/session.ts','packages/web/src/sync/protocol.ts',
    'examples/host-mcp/realtime-owner.rs','crates/editac-session/src/edit_service.rs','crates/editac-session/src/session.rs','crates/editac-core/src/history.rs',
    'packages/web/dist/editor.js','packages/web/dist/extensions/configuration.js','target/debug/examples/host-realtime-owner']),
  prepareConsumer,
  async beforeNavigate(page, fact) {
    page.setDefaultTimeout(8000);
    const owner = await hostOwner(join(output, `host-${++serial}`)); owners.set(page, owner); fact.hostOwner = owner.facts;
    await page.exposeFunction('hostRpc', owner.rpc); await page.exposeFunction('hostFrame', owner.frame);
    // Reject accidental provider/external requests before fixture startup.
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient'));
  },
  async cleanup(page) {
    try { await page.evaluate(() => window.productFlow?.close()); }
    finally { const owner = owners.get(page); if (owner) owner.facts.exit = await owner.close(); owners.delete(page); }
  },
});
facts.binding = { gate: 'PIN-1.3', children: ['PIN-1.3-I1','PIN-1.3-V1'], profile: portable ? 'portable-mobile' : 'desktop',
  provenance: 'production installed BrowserEditor/Session/Rust-WASM/IndexedDB + real SQLite host admission; prepared peer/agent process transports; desktop browser mechanics only' };
async function mount(page) { await page.waitForFunction(() => !!(window as any).productFlow); await page.evaluate(() => (window as any).productFlow.mount()); }
async function state(page, fact) {
  const result = await page.evaluate(() => (window as any).productFlow.snapshot()); fact.snapshots.push(result);
  for (const row of result) { assert.equal(row.unsaved, 0); assert.equal(row.storage.ready, true); assert.equal(row.storage.error, null); }
  assert.ok(fact.requests.every(url => new URL(url).hostname === '127.0.0.1'), 'loopback-only fixture requests');
  return result;
}
async function pull(page) { await page.evaluate(() => (window as any).productFlow.pull()); }
async function select(page, which, index, start, end = start) { await page.evaluate(({which,index,start,end}) => { const f = (window as any).productFlow; f.select(f.views.find(v => v.root.id === which).editor,index,start,end); }, {which,index,start,end}); }
const semantics = rows => rows.map(r => ({id:r.id,identity:r.identity,nodes:r.nodes.map(n => ({id:n.id,kind:n.kind,runs:n.runs,blockAttributes:n.blockAttributes}))}));
async function reopen(page, fact, expected) { await page.evaluate(() => (window as any).productFlow.reopen()); assert.deepEqual(semantics(await state(page,fact)),semantics(expected)); }

test('PIN-FLOW-01 local configured typing, formatting and durable recovery stay independent from collaborative tools', () => probe('local-configured-recovery', async(page,fact) => {
  await mount(page); let s = await state(page,fact);
  assert.deepEqual(s.map(r=>[r.id,r.search,r.reorder]),[['one',true,true],['two',true,true],['local',false,false]]);
  assert.equal(s[2].collaboration,'idle'); assert.notEqual(s[0].identity.documentId,s[2].identity.documentId);
  await select(page,'local',0,10); await page.keyboard.insertText(' saved');
  await select(page,'local',0,0,5); await page.locator('#local').locator('..').getByRole('button',{name:'Bold',exact:true}).click();
  s=await state(page,fact); assert.deepEqual(s[2].texts,['Local note saved']); assert.ok(s[2].nodes[0].runs.some(r=>r.attributes.bold));
  assert.deepEqual(s[0].texts,['base','other']); assert.deepEqual(s[1].texts,['base','other']);
  assert.equal(await page.locator('#local').locator('..').getByRole('button',{name:'Italic',exact:true}).count(),0);
  await reopen(page,fact,s);
}));

test('PIN-FLOW-02 configured formatting Search/Reorder, peer and host-agent edits share history and durable reopen', () => probe('combined-tools-remote-agent-history', async(page,fact) => {
  await mount(page); await select(page,'one',0,4,0);
  await page.locator('#one').locator('..').getByRole('button',{name:'Bold',exact:true}).click();
  await pull(page); let s=await state(page,fact); assert.ok(s[0].nodes[0].runs.some(r=>r.attributes.bold)); assert.deepEqual(s[0].nodes,s[1].nodes);
  const section=page.locator('#one').locator('..');
  await section.getByRole('button',{name:'Find in document',exact:true}).click();
  await section.getByRole('textbox',{name:'Find text',exact:true}).fill('base');
  await page.waitForFunction(() => (window as any).productFlow.views[0].editor.search.session.result.status === 'ready');
  await section.getByRole('textbox',{name:'Replacement text',exact:true}).fill('found');
  await section.getByRole('button',{name:'Replace all',exact:true}).click();
  await select(page,'one',0,2); await page.locator('#one').press('Alt+ArrowDown');
  await pull(page); s=await state(page,fact); assert.deepEqual(s[0].texts,['other','found']); assert.deepEqual(s[1].texts,s[0].texts);
  await select(page,'two',0,0); await page.keyboard.insertText('R😀'); await pull(page);
  s=await state(page,fact); assert.deepEqual(s[0].texts,['R😀other','found']);
  const result=await page.evaluate(() => (window as any).productFlow.agentEdit('Agent ')); fact.agent=result;
  assert.equal(result.first.data.outcome,'committed'); assert.equal(result.retry.data.outcome,'committed'); assert.deepEqual(result.retry.data,result.first.data); assert.equal(result.first.data.localDurability,'durable'); assert.equal(result.first.data.remoteDurability,'pending');
  s=await state(page,fact); assert.deepEqual(s[0].texts,['Agent R😀other','found']); assert.deepEqual(s[1].texts,s[0].texts);
  await select(page,'one',0,0); await page.evaluate(() => (window as any).productFlow.history()); await pull(page);
  s=await state(page,fact); assert.deepEqual(s[0].texts,['found','Agent R😀other'],'human undo excludes remote human/agent edits');
  await select(page,'one',0,0); await page.evaluate(() => (window as any).productFlow.history((window as any).productFlow.views[0],true)); await pull(page);
  s=await state(page,fact); assert.deepEqual(s[0].texts,['Agent R😀other','found']); assert.deepEqual(s[1].texts,s[0].texts); assert.deepEqual(s[2].texts,['Local note']);
  assert.ok(s[0].patches.some(p=>p.update&&p.origin.startsWith('editac:local:'))); assert.ok(s[0].patches.some(p=>p.update&&!p.origin.startsWith('editac:local:')));
  await reopen(page,fact,s);
}));

test('PIN-FLOW-03 disposing one configured peer preserves the local field and surviving host-agent flow', () => probe('peer-disposal-recovery', async(page,fact) => {
  await mount(page); await select(page,'local',0,10); await page.keyboard.insertText(' independent');
  await page.evaluate(() => {const f=(window as any).productFlow; return f.dispose(f.views[1]);});
  const result=await page.evaluate(() => (window as any).productFlow.agentEdit('After ', 'after-dispose')); assert.equal(result.first.data.outcome,'committed');
  let s=await state(page,fact); assert.deepEqual(s.map(r=>r.id),['one','local']); assert.deepEqual(s[0].texts,['After base','other']); assert.deepEqual(s[1].texts,['Local note independent']);
  await select(page,'one',0,10); await page.keyboard.insertText(' usable'); await pull(page);
  s=await state(page,fact); assert.deepEqual(s[0].texts,['After base usable','other']);
  await reopen(page,fact,s);
}));
