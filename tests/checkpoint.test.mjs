import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { init } from '../packages/core/dist/index.js';
import { CheckpointStorage } from '../packages/web/dist/storage/checkpoint.js';
import { UpdateJournal, JournalIntegrityError } from '../packages/web/dist/storage/journal.js';
import { CheckpointIndexedDB } from './helpers/checkpoint-storage.mjs';
const output = process.env.EDITAC_CHECKPOINT_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-checkpoint-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [] };
function check(name, fn) { test(name, async () => { const c = { name, passed: false }; facts.cases.push(c); await fn(); c.passed = true; }); }
const runtime = await init('data:application/wasm;base64,' + (await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url))).toString('base64'));
const options = { profile: 'v5', documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', nodes: [{ text: 'a😀b' }] };
const engine = runtime.createEngine(options), initial = engine.checkpoint(), updates = [];
const sub = engine.subscribe({ type: 'updates' }, p => { if (p.update) updates.push({ identity: p.identity, writerId: p.writerId, sequence: p.sequence, origin: p.origin, bytes: p.update.bytes }); });
function edit(text) { const a = engine.anchor(engine.read().visible[0].id, 3, 'right'); engine.commit(engine.prepare({ kind: 'text', origin: 'checkpoint:test', command: { type: 'insert', at: a, text } })); engine.releaseAnchor(a); }
edit('B'); const middle = engine.checkpoint(); edit('C'); const latest = engine.checkpoint(); sub.dispose(); engine.dispose();
const text = e => e.read().visible[0].runs.map(r => r.text).join('');
function restore(state) { const e = runtime.restoreEngine(initial.identity, state.checkpoint, state.tail.map(u => ({ identity: u.identity, bytes: u.bytes }))); try { return text(e); } finally { e.dispose(); } }
async function publish(store, db, point, ids) { const p = store.publish(point, ids); const tx = await db.nextWrite(); await new Promise(resolve => setImmediate(resolve)); tx.complete(); return p; }
async function append(journal, db, update) { const p = journal.append(update); const tx = await db.nextWrite(); await new Promise(resolve => setImmediate(resolve)); tx.complete(); return p; }
async function setup() {
  const db = new CheckpointIndexedDB(), store = await CheckpointStorage.open(db), journal = await UpdateJournal.open(db);
  await publish(store, db, initial, []); const ids = [];
  for (const u of updates) ids.push((await append(journal, db, u)).updateId);
  return { db, store, journal, ids };
}
check('publication and coverage remain invisible until transaction completion; owned bytes survive reopen', async () => {
  const { db,store,ids } = await setup(); const input = structuredClone(latest), coverage = [...ids];
  let settled = false; const p = store.publish(input,coverage).then(v => { settled = true; return v; }); input.bytes.fill(0); coverage.length = 0;
  const tx = await db.nextWrite(); tx.requestSuccess(); assert.equal(settled,false);
  assert.equal((await store.restore(initial.identity,restore)).value,'a😀CBb');
  assert.equal([...db.stores.checkpoints.values()][0].latest.coverage.length,0);
  tx.complete(); assert.equal((await p).state,'checkpointCommitted');
  const row = [...db.stores.checkpoints.values()][0]; assert.deepEqual(row.latest.coverage,ids); assert.equal(row.previous.coverage.length,0);
  store.close(); const reopened = await CheckpointStorage.open(db); assert.equal((await reopened.restore(initial.identity,restore)).value,'a😀CBb');
  assert.equal(db.stores.updates.size,2);
});
for (const boundary of ['before-write-success','after-write-success']) check(`aborted publication ${boundary} recovers all locally committed real engine edits`, async () => {
  const { db,store,ids } = await setup(); const p = store.publish(latest,ids); const tx = await db.nextWrite(); if (boundary === 'after-write-success') { await new Promise(resolve => setImmediate(resolve)); tx.requestSuccess(); }
  tx.abort(); await assert.rejects(p,{name:'AbortError'}); const result = await store.restore(initial.identity,restore); assert.equal(result.value,'a😀CBb'); assert.equal(result.recovery.source,'latest'); assert.equal(db.stores.updates.size,2);
});
check('after-complete publication recovers covered and later committed tail without loss', async () => {
  const {db,store,ids}=await setup(); await publish(store,db,middle,[ids[0]]); const result = await store.restore(initial.identity,restore);
  assert.equal(result.value,'a😀CBb'); assert.equal(result.recovery.tail.length,2);
});
for (const corruption of ['bytes','coverage','version','identity','semantic']) check(`corrupt latest ${corruption} falls back to previous point and full committed tail`, async () => {
  const {db,store,ids}=await setup();
  if (corruption === 'semantic') await publish(store,db,{...latest,bytes:Uint8Array.of(0)},ids); else await publish(store,db,latest,ids);
  const row = [...db.stores.checkpoints.values()][0];
  if (corruption==='bytes') row.latest.checkpoint.bytes[0]^=1;
  if (corruption==='coverage') row.latest.coverage=[];
  if (corruption==='version') row.latest.version=99;
  if (corruption==='identity') row.latest.checkpoint.identity.schema='other';
  const result=await store.restore(initial.identity,restore); assert.equal(result.value,'a😀CBb'); assert.equal(result.recovery.source,'previous'); assert.equal(result.recovery.rejected.length,1);
});
check('both corrupt checkpoints, corrupt journal, missing and incompatible identity fail explicitly', async () => {
  const {db,store,ids}=await setup(); await publish(store,db,latest,ids); const row=[...db.stores.checkpoints.values()][0]; row.latest.checkpoint.bytes[0]^=1; row.previous.checkpoint.bytes[0]^=1;
  await assert.rejects(store.restore(initial.identity,restore),JournalIntegrityError);
  await assert.rejects(store.restore({...initial.identity,documentId:'missing'},restore),/missing checkpoint/);
  await assert.rejects(store.restore({...initial.identity,epoch:''},restore),JournalIntegrityError);
  [...db.stores.updates.values()][0].bytes[0]^=1; await assert.rejects(store.restore(initial.identity,restore),/Corrupt journal/);
});
check('uncommitted/foreign coverage rejected without publishing; quota and permission failure preserve prior state', async () => {
  const {db,store}=await setup(); await assert.rejects(store.publish(latest,['foreign']),/uncommitted or foreign/);
  for (const name of ['QuotaExceededError','SecurityError']) { db.creationError=new DOMException('Injected',name); await assert.rejects(store.publish(latest,[]),{name}); db.creationError=null; assert.equal((await store.restore(initial.identity,restore)).value,'a😀CBb'); }
});
check('strict durability fallback is reported and repeated checkpoint publication retains journal/outbox identities',async()=>{
  const {db,store,ids}=await setup();db.strictSupported=false;assert.equal((await publish(store,db,latest,ids)).durability,'default');await publish(store,db,latest,ids);assert.equal(db.stores.updates.size,2);assert.equal((await store.restore(initial.identity,restore)).value,'a😀CBb');
});
check('publication transaction-creation and put failures never acknowledge or replace recoverable state',async()=>{
  const {db,store,ids}=await setup();
  for(const field of ['writeCreationError','putError']){
    db[field]=new DOMException('Injected write boundary','QuotaExceededError');
    await assert.rejects(store.publish(latest,ids),{name:'QuotaExceededError'}); db[field]=null;
    assert.equal((await store.restore(initial.identity,restore)).value,'a😀CBb');
    assert.equal([...db.stores.checkpoints.values()][0].latest.coverage.length,0);
  }
});
check('replacement of checksum-corrupt latest retains previous valid fallback and detached recovery state',async()=>{
  const {db,store,ids}=await setup();await publish(store,db,middle,[ids[0]]);
  [...db.stores.checkpoints.values()][0].latest.checkpoint.bytes[0]^=1;
  await publish(store,db,latest,ids);const row=[...db.stores.checkpoints.values()][0];row.latest.checkpoint.bytes[0]^=1;
  const result=await store.restore(initial.identity,restore);assert.equal(result.value,'a😀CBb');assert.equal(result.recovery.source,'previous');
  result.recovery.checkpoint.bytes.fill(0);result.recovery.tail[0].bytes.fill(0);
  assert.equal((await store.restore(initial.identity,restore)).value,'a😀CBb');
});
let controller, browser;
check('actual Chromium atomic publication, abort boundaries, reopen and corrupt-latest fallback restore real Rust content',async()=>{
  controller=await chromium.launchServer({headless:true});const child=controller.process();facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'checkpoint IndexedDB integration',port:null,log:'full.log'});
  browser=await chromium.connect(controller.wsEndpoint());facts.browser={version:browser.version(),playwright:JSON.parse(await readFile(new URL('../node_modules/playwright/package.json',import.meta.url))).version};
  const context=await browser.newContext();
  try{
    await context.route('https://checkpoint.test/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Checkpoint qualification</title>'});
      if(path.includes('..')||!/^\/(core|web)\//.test(path))return route.abort();
      const prefix=path.startsWith('/core/')?'../packages/core/dist/':'../packages/web/dist/';
      await route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:await readFile(new URL(prefix+path.replace(/^\/(core|web)\//,''),import.meta.url))});
    });
    const page=await context.newPage();await page.goto('https://checkpoint.test/');
    const result=await page.evaluate(async({options})=>{
      const {init}=await import('/core/index.js'),{UpdateJournal}=await import('/web/storage/journal.js'),{CheckpointStorage}=await import('/web/storage/checkpoint.js');
      const runtime=await init('/core/wasm/editac_wasm_bg.wasm');const engine=runtime.createEngine(options),initial=engine.checkpoint(),updates=[];
      const sub=engine.subscribe({type:'updates'},p=>{if(p.update)updates.push({identity:p.identity,writerId:p.writerId,sequence:p.sequence,origin:p.origin,bytes:p.update.bytes});});
      const journal=await UpdateJournal.open(indexedDB,'checkpoint-integration');let storage=await CheckpointStorage.open(indexedDB,'checkpoint-integration');
      const replay=state=>{const e=runtime.restoreEngine(initial.identity,state.checkpoint,state.tail.map(u=>({identity:u.identity,bytes:u.bytes})));try{return e.read().visible[0].runs.map(r=>r.text).join('');}finally{e.dispose();}};
      const nativePut=IDBObjectStore.prototype.put,nativeTransaction=IDBDatabase.prototype.transaction;let boundary='',completed=0;const errors=[],observed=[];
      IDBDatabase.prototype.transaction=function(...args){const tx=nativeTransaction.apply(this,args);if(args[0]==='checkpoints'&&args[1]==='readwrite')tx.addEventListener('complete',()=>completed++);return tx;};
      IDBObjectStore.prototype.put=function(...args){const request=nativePut.apply(this,args);if(this.name==='checkpoints'&&boundary==='before-success')this.transaction.abort();if(this.name==='checkpoints'&&boundary==='after-success')request.addEventListener('success',()=>this.transaction.abort());return request;};
      try{
        await storage.publish(initial,[]);
        for(const word of ['B','C']){const a=engine.anchor(engine.read().visible[0].id,3,'right');engine.commit(engine.prepare({kind:'text',origin:'checkpoint:browser',command:{type:'insert',at:a,text:word}}));engine.releaseAnchor(a);await journal.append(updates.at(-1));}
        const point=engine.checkpoint(),entries=await journal.read(initial.identity),ids=entries.map(e=>e.updateId);
        for(const phase of ['before-success','after-success']){boundary=phase;try{await storage.publish(point,ids);}catch(e){errors.push(e.name);}boundary='';storage.close();storage=await CheckpointStorage.open(indexedDB,'checkpoint-integration');observed.push((await storage.restore(initial.identity,replay)).value);}
        await storage.publish(point,ids);if(completed!==2)throw Error('Publication acknowledgment preceded transaction completion');storage.close();storage=await CheckpointStorage.open(indexedDB,'checkpoint-integration');observed.push((await storage.restore(initial.identity,replay)).value);
        // Simulate durable corruption in latest point; previous and journal remain intact.
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('checkpoint-integration',4);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        try{await new Promise((resolve,reject)=>{const tx=db.transaction('checkpoints','readwrite'),store=tx.objectStore('checkpoints'),key=JSON.stringify([initial.identity.documentId,initial.identity.epoch,initial.identity.schema]),r=store.get(key);r.onsuccess=()=>{r.result.latest.checkpoint.bytes[0]^=1;store.put(r.result,key);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
        const fallback=await storage.restore(initial.identity,replay);observed.push(fallback.value);
        const retained=await journal.read(initial.identity);
        return{errors,observed,fallback:fallback.recovery.source,rejected:fallback.recovery.rejected,completed,count:retained.length,idsPreserved:JSON.stringify(retained.map(e=>e.updateId))===JSON.stringify(ids),fixtures:{initial:{...initial,bytes:Array.from(initial.bytes)},latest:{...point,bytes:Array.from(point.bytes)},entries:retained.map(e=>({...e,bytes:Array.from(e.bytes)}))}};
      }finally{IDBObjectStore.prototype.put=nativePut;IDBDatabase.prototype.transaction=nativeTransaction;sub.dispose();engine.dispose();storage.close();journal.close();}
    },{options});
    assert.deepEqual(result.errors,['AbortError','AbortError']);assert.deepEqual(result.observed,Array(4).fill('a😀CBb'));assert.equal(result.fallback,'previous');assert.equal(result.rejected.length,1);assert.equal(result.count,2);assert.equal(result.idsPreserved,true);assert.equal(result.completed,3);facts.integration=result;
  }finally{await context.close();}
});
after(async()=>{
  try{await browser?.close();}finally{await controller?.close();facts.teardown={browserClosed:!browser?.isConnected(),browserProcessExited:!controller||controller.process().exitCode!==null,fixtureServersStarted:0};await writeFile(join(output,'harness.json'),JSON.stringify(facts,null,2));if(!process.env.EDITAC_CHECKPOINT_OUTPUT&&facts.cases.every(c=>c.passed))await rm(output,{recursive:true});}
});
