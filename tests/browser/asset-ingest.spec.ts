import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir,copyFile,symlink,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {browserHarness} from './browser-harness.ts';
const descriptor=JSON.parse(await readFile('fixtures/rich-content/asset-descriptors.json','utf8')).descriptors[0];
const {probe}=browserHarness('asset-ingest','fixtures/browser-input',{
 assertSourcesUnchanged:true,serverOptions:{recordRequests:true},
 sourcePaths:['crates/editac-session/Cargo.toml','crates/editac-wasm/Cargo.toml','Cargo.lock','scripts/build-wasm-notices.mjs','scripts/share-wasm-glue.mjs','packages/web/package.json','tests/browser/fixture-server.mjs','crates/editac-session/src/assets.rs','crates/editac-session/src/ports/memory.rs','crates/editac-wasm/src/assets.rs','crates/editac-wasm/src/engine.rs','packages/core/src/index.ts','packages/web/src/sync/assets.ts','packages/web/src/storage/journal.ts','packages/web/src/storage/index.ts','fixtures/browser-input/session.mjs','fixtures/browser-asset-ingest/host.mjs','fixtures/rich-content/asset-descriptors.json','tests/consumers/asset-ingest/public-types.ts'],
 async prepareConsumer(consumer,{facts,run}){
  await mkdir(join(consumer,'node_modules/@edit-ac'),{recursive:true});
  for(const name of ['core','web'])await symlink(join(consumer,name,'package'),join(consumer,'node_modules/@edit-ac',name));
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  const input=join(consumer,'public-types.ts');await copyFile('tests/consumers/asset-ingest/public-types.ts',input);
  await run(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','--module','nodenext','--moduleResolution','nodenext','--target','es2022','--lib','es2022,dom,dom.iterable',input],'public-types.log');facts.publicTypes={passed:true,invalidExamples:2};
  const fixture=join(consumer,'fixture');await mkdir(fixture);
  for(const file of ['index.html','session.mjs'])await copyFile('fixtures/browser-input/'+file,join(fixture,file));
  await copyFile('fixtures/browser-asset-ingest/host.mjs',join(fixture,'host.mjs'));return fixture;
 }
});
async function setup(page){await page.evaluate(async descriptor=>{
 const f=window.inputFixture,e=f.engine,first=e.read().visible[0],a=e.anchor(first.id,0,'left'),b=e.anchor(first.id,5,'right');
 try{f.commit({kind:'fragment',origin:'local:asset-fixture',range:{anchor:a,focus:b},blocks:[{runs:[{text:descriptor.fallback,marks:[]}],attributes:{type:'content',tuple:['module:editac.asset',1,descriptor]}}]});}finally{e.releaseAnchor(a);e.releaseAnchor(b);}
 await f.storage.flush({target:'local'});const owner=e.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.asset').id;
 const session=await f.storage.enableAssets(indexedDB,'browser-input');const {mockAssetHost}=await import('/fixture/host.mjs');
 const grant={identity:descriptor.identity,actions:['ingest','read','publish','cancel','release-reference']};
 window.assetFixture={owner,session,host:mockAssetHost(descriptor.identity),grant,descriptor,
  request(operationId,action='ingest'){return {version:1,operationId,identity:descriptor.identity,action,byteLimit:32};},
  async remove(){const node=e.read().visible.find(n=>n.id===owner),at=e.anchor(owner,0,'left');try{f.commit({kind:'editor',origin:'local:delete-asset',commands:[{type:'atomicContent',owner,expected:node.blockAttributes,at,replacement:null}]});}finally{e.releaseAnchor(at);}await f.storage.flush({target:'local'});}
 };
},descriptor);}

test('retained ingest uses public Rust owner and distinct idempotent receipts without document writes',()=>probe('ingest-idempotency',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const f=window.inputFixture,e=f.engine,a=window.assetFixture;
 const before=Array.from(e.checkpoint().bytes),history=e.history({type:'state'}),source=new Uint8Array([0,1,255,13,10]);
 const receipt=await a.session.enqueue(a.owner,a.request('ingest_1'),a.grant,source);source.fill(7);
 const duplicate=await a.session.enqueue(a.owner,a.request('ingest_1'),a.grant,new Uint8Array([0,1,255,13,10]));
 const first=await a.session.runOne('ingest_1',true,a.host),second=await a.session.runOne('ingest_1',true,a.host);
 return {before,after:Array.from(e.checkpoint().bytes),history,afterHistory:e.history({type:'state'}),receipt,duplicate,first,second,source:Array.from(await a.session.retainedSource(a.owner,a.grant)),calls:a.host.state.calls,intents:(await a.session.inspect()).intents};});
 fact.snapshots.push(r);assert.deepEqual(r.before,r.after);assert.deepEqual(r.history,r.afterHistory);assert.equal(r.receipt.kind,'assetOperation');assert.equal('updateId' in r.receipt,false);assert.deepEqual(r.receipt,r.duplicate);assert.equal(r.first,true);assert.equal(r.second,false);assert.deepEqual(r.source,[0,1,255,13,10]);assert.equal(r.calls.filter(c=>c[0]==='execute').length,1);assert.equal(r.intents[0].attempts,1);assert.equal(r.intents[0].status,'Complete');
}));

test('denied unsupported conflicting and invalid targets abort storage and document admission',()=>probe('denied-noops',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const a=window.assetFixture,e=window.inputFixture.engine,before=Array.from(e.checkpoint().bytes),failures=[];
 for(const [owner,request,grant,bytes] of [[a.owner,a.request('denied'),{identity:a.grant.identity,actions:[]},new Uint8Array([1])],[a.owner,a.request('unsupported','open'),a.grant,undefined],['missing',a.request('missing'),a.grant,new Uint8Array([1])]]){try{await a.session.enqueue(owner,request,grant,bytes);failures.push(false);}catch{failures.push(true);}}
 const empty=(await a.session.inspect()).intents.length;await a.session.enqueue(a.owner,a.request('retained'),a.grant,new Uint8Array([1]));const journal=(await a.session.inspect()).journal;
 try{await a.session.enqueue(a.owner,a.request('retained'),a.grant,new Uint8Array([2]));failures.push(false);}catch{failures.push(true);}
 let deniedRead=false;try{await a.session.retainedSource(a.owner,{identity:a.grant.identity,actions:[]});}catch{deniedRead=true;}
 let unsupported=false;try{await a.session.runOne('retained',true,null);}catch{unsupported=true;}
 return {failures,empty,deniedRead,unsupported,journal,afterJournal:(await a.session.inspect()).journal,before,after:Array.from(e.checkpoint().bytes)};});fact.snapshots.push(r);assert.deepEqual(r.failures,[true,true,true,true]);assert.equal(r.empty,0);assert.equal(r.deniedRead,true);assert.equal(r.unsupported,true);assert.equal(r.journal,r.afterJournal);assert.deepEqual(r.before,r.after);
}));

test('suspended Session restart recovers pending IDs exact local bytes and retained descriptor source',()=>probe('restart-source',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const f=window.inputFixture,a=window.assetFixture;await a.session.enqueue(a.owner,a.request('restart_1'),a.grant,new Uint8Array([0,255,0,10]));const beforeNodes=f.engine.read().visible;const before=Array.from(f.engine.checkpoint().bytes);await f.reopen({assetPolicy:'suspend'});const s=await f.storage.enableAssets(indexedDB,'browser-input');a.session=s;const bytes=Array.from(await s.retainedSource(a.owner,a.grant)),intents=(await s.inspect()).intents,automatic=a.host.state.calls.length;await s.runOne('restart_1',true,a.host);return {beforeNodes,afterNodes:f.engine.read().visible,before,after:Array.from(f.engine.checkpoint().bytes),bytes,intents,automatic,source:f.engine.read().visible.find(n=>n.id===a.owner).blockAttributes[2].source,expected:a.descriptor.source,journal:(await f.state()).journal};});fact.snapshots.push(r);assert.deepEqual(r.beforeNodes,r.afterNodes);assert.deepEqual(r.bytes,[0,255,0,10]);assert.equal(r.intents[0].request.operationId,'restart_1');assert.equal(r.intents[0].attempts,0);assert.equal(r.automatic,0);assert.equal(r.source,r.expected);assert.ok(r.journal.length>0);
}));

test('target deletion fences late publication and undo redo cannot resurrect retired work',()=>probe('deletion-late-history',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const f=window.inputFixture,a=window.assetFixture;await a.session.enqueue(a.owner,a.request('publish_1','publish'),a.grant);a.host.state.paused=true;const pending=a.session.runOne('publish_1',true,a.host);await Promise.race([pending.then(()=>{throw Error('Host did not pause');}),new Promise((resolve,reject)=>{const until=Date.now()+5000;const check=()=>a.host.state.waiting.length?resolve():Date.now()>until?reject(Error('Host pause timeout')):setTimeout(check,5);check();})]);await a.remove();await a.session.reconcile();const deleted=Array.from(f.engine.checkpoint().bytes);a.host.release();await pending;const after=Array.from(f.engine.checkpoint().bytes);f.engine.history({type:'undo'});const undone=f.engine.read().visible.some(n=>n.id===a.owner);f.engine.history({type:'redo'});await f.storage.flush({target:'local'});const intents=(await a.session.inspect()).intents;let rejected=false;try{await a.session.enqueue(a.owner,a.request('again'),a.grant,new Uint8Array([1]));}catch{rejected=true;}return {deleted,after,undone,rejected,intents,aborted:a.host.state.signals.some(s=>s.aborted)};});fact.snapshots.push(r);assert.deepEqual(r.deleted,r.after);assert.equal(r.undone,true);assert.equal(r.rejected,true);assert.equal(r.intents[0].status,'Canceled');assert.equal(r.aborted,true);assert.ok(r.intents.some(i=>i.request.action==='cancel'));
}));

test('cancel and scoped release ordering preserve bytes until host cleanup acknowledgement',()=>probe('cancel-release',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const a=window.assetFixture;await a.session.enqueue(a.owner,a.request('ingest_cancel'),a.grant,new Uint8Array([1,2]));await a.session.retire(a.owner,a.grant.identity,'cancel_1');let blocked=false;try{await a.session.runOne('cancel_1_release',true,a.host);}catch{blocked=true;}const retained=Array.from(await a.session.retainedSource(a.owner,a.grant));await a.session.runOne('cancel_1_cancel',true,a.host);await a.session.runOne('cancel_1_release',true,a.host);return {blocked,retained,after:await a.session.retainedSource(a.owner,a.grant),intents:(await a.session.inspect()).intents,calls:a.host.state.calls};});fact.snapshots.push(r);assert.equal(r.blocked,true);assert.deepEqual(r.retained,[1,2]);assert.equal(r.after,null);assert.equal(r.calls.filter(c=>c[0]==='execute').length,2);assert.equal(r.intents[0].status,'Canceled');
}));

test('storage teardown aborts host and fences late results before disposing the engine',()=>probe('teardown-late',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const f=window.inputFixture,a=window.assetFixture;await a.session.enqueue(a.owner,a.request('dispose_1'),a.grant,new Uint8Array([1]));a.host.state.paused=true;const pending=a.session.runOne('dispose_1',true,a.host);await Promise.race([pending.then(()=>{throw Error('Host did not pause');}),new Promise((resolve,reject)=>{const until=Date.now()+5000;const check=()=>a.host.state.waiting.length?resolve():Date.now()>until?reject(Error('Host pause timeout')):setTimeout(check,5);check();})]);await f.destroy();window.fixtureDisposed=true;a.host.release();const result=await pending;await f.mount();window.fixtureDisposed=false;return {result,aborted:a.host.state.signals.some(s=>s.aborted)};});fact.snapshots.push(r);assert.equal(r.result,false);assert.equal(r.aborted,true);
}));

test('offline and expired authorization retain same pending ID without consuming attempts',()=>probe('offline-denied-dispatch',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const a=window.assetFixture;await a.session.enqueue(a.owner,a.request('offline_1'),a.grant,new Uint8Array([1]));const failures=[];try{await a.session.runOne('offline_1',false,a.host);failures.push(false);}catch{failures.push(true);}a.host.state.denied=true;try{await a.session.runOne('offline_1',true,a.host);failures.push(false);}catch{failures.push(true);}return {failures,intents:(await a.session.inspect()).intents,executions:a.host.state.calls.filter(c=>c[0]==='execute').length,bytes:Array.from(await a.session.retainedSource(a.owner,a.grant))};});fact.snapshots.push(r);assert.deepEqual(r.failures,[true,true]);assert.equal(r.intents[0].attempts,0);assert.equal(r.intents[0].status,'Pending');assert.equal(r.executions,0);assert.deepEqual(r.bytes,[1]);
}));

test('failed host effect retries recovered exact operation through idempotent transport',()=>probe('effect-recovery',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const f=window.inputFixture,a=window.assetFixture;await a.session.enqueue(a.owner,a.request('effect_1'),a.grant,new Uint8Array([3,4]));const execute=a.host.execute;let lost=true;a.host.execute=async(...args)=>{const result=await execute(...args);if(lost){lost=false;throw Error('prepared crash after host effect');}return result;};let failed=false;try{await a.session.runOne('effect_1',true,a.host);}catch{failed=true;}const pending=(await a.session.inspect()).intents[0];await f.reopen({assetPolicy:'suspend'});a.session=await f.storage.enableAssets(indexedDB,'browser-input');await a.session.runOne('effect_1',true,a.host);return {failed,pending,effects:a.host.state.effects.size,intent:(await a.session.inspect()).intents[0],bytes:Array.from(await a.session.retainedSource(a.owner,a.grant))};});fact.snapshots.push(r);assert.equal(r.failed,true);assert.equal(r.pending.attempts,1);assert.equal(r.pending.status,'Pending');assert.equal(r.effects,1);assert.equal(r.intent.attempts,2);assert.equal(r.intent.status,'Complete');assert.deepEqual(r.bytes,[3,4]);
}));

test('recovery reconciles deletion while suspended before any host dispatch',()=>probe('recovery-deleted-target',async(page,fact)=>{
 await setup(page);const r=await page.evaluate(async()=>{const f=window.inputFixture,a=window.assetFixture;await a.session.enqueue(a.owner,a.request('deleted_recovery'),a.grant,new Uint8Array([9]));await a.session.dispose('suspend');await a.remove();await f.reopen({assetPolicy:'suspend'});a.session=await f.storage.enableAssets(indexedDB,'browser-input');const automatic=a.host.state.calls.length,ran=await a.session.runOne('deleted_recovery',true,a.host);return {automatic,ran,intents:(await a.session.inspect()).intents,exists:f.engine.read().visible.some(n=>n.id===a.owner&&n.blockAttributes?.[0]==='module:editac.asset'),bytes:Array.from(await a.session.retainedSource(a.owner,a.grant))};});fact.snapshots.push(r);assert.equal(r.automatic,0);assert.equal(r.ran,false);assert.equal(r.exists,false);assert.equal(r.intents[0].status,'Canceled');assert.deepEqual(r.bytes,[9]);
}));
