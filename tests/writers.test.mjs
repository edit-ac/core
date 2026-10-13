import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { init } from '../packages/core/dist/index.js';
import { StorageWriter } from '../packages/web/dist/storage/writer.js';
import { CheckpointStorage, CheckpointConflictError } from '../packages/web/dist/storage/checkpoint.js';
import { UpdateJournal } from '../packages/web/dist/storage/journal.js';
import { UpdateOutbox } from '../packages/web/dist/storage/outbox.js';
import { CheckpointIndexedDB } from './helpers/checkpoint-storage.mjs';
const output = process.env.EDITAC_WRITERS_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-writers-'));
await mkdir(output,{recursive:true});
const facts={cases:[],processes:[]};
function check(name,fn){test(name,async()=>{const c={name,passed:false};facts.cases.push(c);await fn();c.passed=true;});}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const runtime=await init('data:application/wasm;base64,'+(await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm',import.meta.url))).toString('base64'));
const seed=runtime.createEngine({profile:'v5',documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',nodes:[{text:'a😀b'}]});
const initial=seed.checkpoint();seed.dispose();
const text=e=>e.read().visible[0].runs.map(r=>r.text).join('');
class Locks {
  held=new Set();
  async request(name,options,callback){if(this.held.has(name))return callback(null);this.held.add(name);try{return await callback({name});}finally{this.held.delete(name);}}
}
function edit(engine,word){let update;const sub=engine.subscribe({type:'updates'},p=>{if(p.update)update={identity:p.identity,writerId:p.writerId,sequence:p.sequence,origin:p.origin,bytes:p.update.bytes};});const a=engine.anchor(engine.read().visible[0].id,3,'right');engine.commit(engine.prepare({kind:'text',origin:'writers:test',command:{type:'insert',at:a,text:word}}));engine.releaseAnchor(a);sub.dispose();return update;}
async function commit(db,op){const p=op(),tx=await db.nextWrite();await tick();tx.complete();return p;}
function replay(state){const e=runtime.restoreEngine(initial.identity,state.checkpoint,state.tail.map(u=>({identity:u.identity,bytes:u.bytes})));try{return text(e);}finally{e.dispose();}}
check('deterministic fresh live replicas, lease collision retry and disposal',async()=>{
 const locks=new Locks(),a=await StorageWriter.restore(runtime,locks,initial.identity,initial),b=await StorageWriter.restore(runtime,locks,initial.identity,initial);
 try{assert.notEqual(a.writerId,b.writerId);assert.notEqual(a.writerId,initial.writerId);assert.notEqual(b.writerId,initial.writerId);assert.equal(locks.held.size,2);assert.equal(text(a.engine),'a😀b');}finally{a.dispose();a.dispose();b.dispose();}await tick();assert.equal(locks.held.size,0);
 let disposed=0,tries=0;
 // Force collision independently of random engine behavior.
 const collisionLocks={request:async(name,opts,fn)=>fn(++tries===1?null:{name})};
 const fake={restoreEngine:()=>({checkpoint:()=>({writerId:7}),dispose:()=>disposed++})};
 const c=await StorageWriter.restore(fake,collisionLocks,initial.identity,initial);assert.equal(tries,2);assert.equal(disposed,1);c.dispose();assert.equal(disposed,2);
});
check('deterministic unavailable/failed lock acquisition disposes replica and fails explicitly',async()=>{
 await assert.rejects(StorageWriter.restore(runtime,null,initial.identity,initial),/requires Web Locks/);
 let disposed=0;await assert.rejects(StorageWriter.restore({restoreEngine:()=>({checkpoint:()=>({writerId:1}),dispose:()=>disposed++})},{request:async()=>{throw Error('denied');}},initial.identity,initial),/denied/);assert.equal(disposed,1);
 await assert.rejects(StorageWriter.restore({restoreEngine:()=>({checkpoint:()=>({writerId:1}),dispose:()=>disposed++})},{request:()=>{throw Error('synchronous denial');}},initial.identity,initial),/synchronous denial/);assert.equal(disposed,2);
});
check('deterministic simultaneous publication rejects stale fallback; retry, corruption fallback and reordered replay retain both writers and outbox',async()=>{
 const db=new CheckpointIndexedDB(),journal=await UpdateJournal.open(db),points=await CheckpointStorage.open(db),outbox=await UpdateOutbox.open(db),locks=new Locks();
 const a=await StorageWriter.restore(runtime,locks,initial.identity,initial),b=await StorageWriter.restore(runtime,locks,initial.identity,initial);
 try{
  await commit(db,()=>points.publish(initial,[]));const ua=edit(a.engine,'A'),ub=edit(b.engine,'B');
  await commit(db,()=>journal.append(ua));await commit(db,()=>journal.append(ub));
  const entries=await journal.read(initial.identity);assert.equal(entries.length,2);assert.deepEqual(entries.map(e=>e.sequence),[1,1]);assert.notEqual(entries[0].writerId,entries[1].writerId);
  const p=points.publish(a.engine.checkpoint(),[entries.find(e=>e.writerId===a.writerId).updateId]);const q=points.publish(b.engine.checkpoint(),[entries.find(e=>e.writerId===b.writerId).updateId]);
  const rejected=assert.rejects(q,CheckpointConflictError);const ta=await db.nextWrite(),tb=await db.nextWrite();await tick();ta.complete();await tick();assert.equal(tb.aborted,true);await p;await rejected;
  await commit(db,()=>points.publish(b.engine.checkpoint(),[entries.find(e=>e.writerId===b.writerId).updateId]));
  const row=[...db.stores.checkpoints.values()][0];assert.equal(row.previous.checkpoint.writerId,a.writerId);
  const expected='a😀'+(a.writerId<b.writerId?'AB':'BA')+'b';assert.equal((await points.restore(initial.identity,replay)).value,expected);assert.deepEqual(await outbox.pending(initial.identity),entries);
  const e=runtime.restoreEngine(initial.identity,initial,[ub,ua,ub,ua].map(u=>({identity:u.identity,bytes:u.bytes})));try{assert.equal(text(e),expected);}finally{e.dispose();}
  row.latest.checkpoint.bytes[0]^=1;const restored=await points.restore(initial.identity,replay);assert.equal(restored.recovery.source,'previous');assert.equal(restored.value,expected);assert.deepEqual(await outbox.pending(initial.identity),entries);
  facts.fixtures={initial:{...initial,bytes:Array.from(initial.bytes)},updates:[ua,ub].map(u=>({...u,bytes:Array.from(u.bytes)})),expected};
 }finally{a.dispose();b.dispose();journal.close();points.close();outbox.close();}
});
let controller,browser;
check('actual Chromium two tabs share journal and outbox, hold distinct live leases and safely retry simultaneous checkpoints',async()=>{
 controller=await chromium.launchServer({headless:true});const child=controller.process();facts.processes.push({pid:child.pid,launcher:child.spawnfile,workspace:process.cwd(),purpose:'two-tab IndexedDB writer isolation',port:null,log:'full.log'});browser=await chromium.connect(controller.wsEndpoint());facts.browser={version:browser.version()};const context=await browser.newContext();
 try{
  await context.route('https://writers.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Writer isolation</title>'});if(path.includes('..')||!/^\/(core|web)\//.test(path))return route.abort();const prefix=path.startsWith('/core/')?'../packages/core/dist/':'../packages/web/dist/';await route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:await readFile(new URL(prefix+path.replace(/^\/(core|web)\//,''),import.meta.url))});});
  const pages=await Promise.all([context.newPage(),context.newPage()]);let ready=0,release;const barrier=new Promise(resolve=>release=resolve);await context.exposeFunction('raceReady',async()=>{if(++ready===2)release();await barrier;});
  const point={...initial,bytes:Array.from(initial.bytes)};
  const writers=await Promise.all(pages.map(async(page,i)=>{await page.goto('https://writers.test/');return page.evaluate(async({point,i})=>{
   const {init}=await import('/core/index.js'),{StorageWriter}=await import('/web/storage/writer.js'),{CheckpointStorage}=await import('/web/storage/checkpoint.js'),{UpdateJournal}=await import('/web/storage/journal.js'),{UpdateOutbox}=await import('/web/storage/outbox.js');
   const runtime=await init('/core/wasm/editac_wasm_bg.wasm');point.bytes=new Uint8Array(point.bytes);const writer=await StorageWriter.restore(runtime,navigator.locks,point.identity,point);const journal=await UpdateJournal.open(indexedDB,'writers'),points=await CheckpointStorage.open(indexedDB,'writers'),outbox=await UpdateOutbox.open(indexedDB,'writers');
   let update;const sub=writer.engine.subscribe({type:'updates'},p=>{if(p.update)update={identity:p.identity,writerId:p.writerId,sequence:p.sequence,origin:p.origin,bytes:p.update.bytes};});const a=writer.engine.anchor(writer.engine.read().visible[0].id,3,'right');writer.engine.commit(writer.engine.prepare({kind:'text',origin:'writers:tab',command:{type:'insert',at:a,text:i?'B':'A'}}));writer.engine.releaseAnchor(a);sub.dispose();await journal.append(update);
   const entries=await journal.read(point.identity);window.fixture={runtime,writer,journal,points,outbox,point,coverage:entries.filter(e=>e.writerId===writer.writerId).map(e=>e.updateId)};
   const native=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=native.apply(this,args);if(window.racing&&Array.isArray(args[0])&&args[0].includes('checkpoints')&&args[1]==='readonly'){Object.defineProperty(tx,'oncomplete',{set(fn){tx.addEventListener('complete',async()=>{await window.raceReady();fn();});}});}return tx;};
   return {writerId:writer.writerId,sequence:update.sequence};
  },{point,i});}));
  assert.deepEqual(writers.map(w=>w.sequence),[1,1]);assert.notEqual(writers[0].writerId,writers[1].writerId);for(const w of writers)assert.notEqual(w.writerId,initial.writerId);
  const locks=await pages[0].evaluate(async()=> (await navigator.locks.query()).held.map(l=>l.name));assert.equal(locks.length,2);
  await pages[0].evaluate(()=>fixture.points.publish(fixture.point,[]));
  const raced=await Promise.all(pages.map(page=>page.evaluate(async()=>{window.racing=true;try{await fixture.points.publish(fixture.writer.engine.checkpoint(),fixture.coverage);return 'committed';}catch(e){return e.name;}finally{window.racing=false;}})));
  assert.deepEqual([...raced].sort(),['CheckpointConflictError','committed']);const loser=raced.indexOf('CheckpointConflictError');await pages[loser].evaluate(()=>fixture.points.publish(fixture.writer.engine.checkpoint(),fixture.coverage));
  const expected='a😀'+(writers[0].writerId<writers[1].writerId?'AB':'BA')+'b';
  const restored=await Promise.all(pages.map(page=>page.evaluate(async()=>{const f=fixture;f.points.close();const {CheckpointStorage}=await import('/web/storage/checkpoint.js');f.points=await CheckpointStorage.open(indexedDB,'writers');const result=await f.points.restore(f.point.identity,state=>{const tail=[...state.tail].reverse();const e=f.runtime.restoreEngine(f.point.identity,state.checkpoint,[...tail,...tail].map(u=>({identity:u.identity,bytes:u.bytes})));try{return e.read().visible[0].runs.map(r=>r.text).join('');}finally{e.dispose();}});const entries=await f.journal.read(f.point.identity),pending=await f.outbox.pending(f.point.identity);return {text:result.value,entries:entries.map(e=>({id:e.updateId,writerId:e.writerId,sequence:e.sequence})),pending:pending.map(e=>e.updateId)};})));
  for(const r of restored){assert.equal(r.text,expected);assert.equal(r.entries.length,2);assert.deepEqual(r.pending,r.entries.map(e=>e.id));assert.deepEqual(r.entries.map(e=>e.writerId).sort((a,b)=>a-b),writers.map(w=>w.writerId).sort((a,b)=>a-b));}
  await Promise.all(pages.map(page=>page.evaluate(()=>{fixture.writer.dispose();fixture.journal.close();fixture.points.close();fixture.outbox.close();})));
  assert.equal((await pages[0].evaluate(()=>navigator.locks.query())).held.length,0);facts.integration={writers,raced,restored,expected};
 }finally{await context.close();}
});
after(async()=>{try{await browser?.close();}finally{await controller?.close();facts.teardown={browserClosed:!browser?.isConnected(),browserProcessExited:!controller||controller.process().exitCode!==null,fixtureServersStarted:0};await writeFile(join(output,'harness.json'),JSON.stringify(facts,null,2));if(!process.env.EDITAC_WRITERS_OUTPUT&&facts.cases.every(c=>c.passed))await rm(output,{recursive:true});}});
