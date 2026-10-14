import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '@edit-ac/core';
import { ModuleRuntime, ExtensionCommandSession } from '@edit-ac/web/modules';
import { BrowserLifecycle } from '../packages/web/dist/lifecycle.js';
import { StorageWriter } from '../packages/web/dist/storage/writer.js';
import { UpdateJournal } from '../packages/web/dist/storage/journal.js';
import { LocalStorageLifecycle } from '../packages/web/dist/storage/index.js';
import { PreparedIndexedDB } from './helpers/journal-storage.mjs';
const output=process.env.EDITAC_EXTENSION_COMMANDS_OUTPUT;
assert(output,'unique worktree-owned EDITAC_EXTENSION_COMMANDS_OUTPUT required; run Rust harness first');
const corpus=JSON.parse(await readFile(new URL('../fixtures/extensions/commands/conformance.json',import.meta.url)));
let runtime,seed;const results=[];
const text=e=>e.read().visible[0].runs.map(r=>r.text).join('');
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
before(async()=>{
 runtime=await init('data:application/wasm;base64,'+(await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm',import.meta.url))).toString('base64'));
 const e=runtime.createEngine({profile:'v5',documentId:'71000000-0000-4000-8000-000000000005',epoch:'72000000-0000-4000-8000-000000000005',nodes:[{text:'a😀b'}]});seed=e.checkpoint();e.dispose();
});
const coverage={
 'read-only':'read-only and revocation','revocation':'read-only and revocation',
 'irrelevant-patch':'irrelevant patches and local/remote origins','local-remote-origin':'irrelevant patches and local/remote origins',
 'reentrant-observer':'reentrant observers run after engine borrow and errors preserve commits',
 'observer-error':'reentrant observers run after engine borrow and errors preserve commits',
 'stable-view':'stable view identity and renderer failure cleanup','renderer-error':'stable view identity and renderer failure cleanup',
};
after(async()=>{
 const passed=new Set(results.map(r=>r.id));
 await writeFile(join(output,'web-results.json'),JSON.stringify({cases:results,node:process.version,coverage:corpus.lifecycle.map(id=>({id,test:coverage[id]??id,passed:passed.has(coverage[id]??id)}))})+'\n');
 for(const id of corpus.lifecycle)assert(passed.has(coverage[id]??id),'required lifecycle fixture not executed/passed: '+id);
 for(const c of corpus.cases)assert(passed.has(c.id),'required command fixture not executed/passed: '+c.id);
});
async function harness(options={}){
 const db=new PreparedIndexedDB();const held=new Set();const locks={async request(name,options,callback){assert(!held.has(name));held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
 const writer=await StorageWriter.restore(runtime,locks,seed.identity,seed),engine=writer.engine;
 const journal=await UpdateJournal.open(db),storage=new LocalStorageLifecycle(writer,journal),state=new BrowserLifecycle(true,false);state.update({phase:'ready',ready:true});
 const modules=new ModuleRuntime(engine,options);let committed=0,alive=true;
 const host={get active(){return alive&&state.state.ready;},revision(){const s=engine.read();return JSON.stringify([s.identity,s.revision]);},can(request){return this.active&&!state.state.readOnly&&storage.state.phase!=='error'&&engine.can(request);},commit(request){assert(this.active&&!state.state.readOnly,'current host capability required');engine.history({type:'boundary'});engine.history({type:'explicit'});try{const result=storage.commit(request);committed++;return result;}finally{engine.history({type:'boundary'});}}};
 const commands=new ExtensionCommandSession(host);
 const request=(value='X',from=0,to=1)=>({kind:'editor',origin:'extension:fixture',commands:[{type:'replaceAt',owner:engine.read().visible[0].id,from,to,text:value}]});
 async function settle(){
  const deadline=Date.now()+5000;
  while(storage.state.pending){
   assert(Date.now()<deadline,'prepared journal completion timeout');
   await new Promise(r=>setTimeout(r,5));
   for(const tx of db.transactions){if(tx.settled)continue;tx.lookupSuccess();tx.writeSuccess();tx.complete();tx.settled=true;}
  }
  await storage.flush({target:'local'});
 }
 async function close(){commands.dispose();modules.dispose();state.dispose();alive=false;await settle();await storage.destroy({policy:'report'});await tick();assert.equal(held.size,0);assert.equal(db.closed,true);}
 return {db,engine,storage,state,modules,host,commands,request,settle,close,commits:()=>committed,stop:()=>{alive=false;}};
}
function check(id,fn){test(id,async()=>{const h=await harness();try{await fn(h);results.push({id,passed:true});}finally{await h.close();}});}
for(const c of corpus.cases)test('Rust/production WASM command checkpoint: '+c.id,async()=>{
 const meta=JSON.parse(await readFile(join(output,c.id+'.json')));const e=runtime.restoreEngine(meta.identity,{identity:meta.identity,writerId:meta.writerId,initialized:true,bytes:new Uint8Array(await readFile(join(output,c.id+'.bin')))});
 try{assert.equal(text(e),meta.text);assert.equal(e.read().identity.profile,seed.identity.profile);results.push({id:c.id,passed:true});}finally{e.dispose();}
});
check('prepare/nonmutating/one-intent history',async h=>{
 const r=h.request('table',1,3);r.commands.push({type:'replaceAt',owner:h.engine.read().visible[0].id,from:6,to:6,text:'!'});
 const before=h.engine.checkpoint(),revision=h.engine.read().revision;let calls=0;h.modules.subscribe({},()=>calls++);
 assert.equal(h.host.can(r),true);const p=h.engine.prepare(r);assert.deepEqual(h.engine.checkpoint(),before);assert.equal(calls,0);h.engine.releasePlan(p);
 assert.equal((await h.commands.run(()=>r)).status,'committed');assert.equal(h.commits(),1);assert.equal(h.engine.read().revision,revision+1);assert.equal(calls,1);assert.equal(text(h.engine),'atable!b');assert.equal(h.engine.history({type:'state'}).undoGroups,1);
 h.engine.history({type:'undo'});assert.equal(text(h.engine),'a😀b');h.engine.history({type:'redo'});assert.equal(text(h.engine),'atable!b');assert.equal(calls,3);
 await h.settle();assert.equal(h.storage.state.saved,true);assert.equal(h.db.records.size,3);
});
check('invalid batch is atomic and unavailable',async h=>{
 const before=h.engine.checkpoint(),r=h.request('changed');r.commands.push({...r.commands[0],from:999,to:999});
 assert.equal((await h.commands.run(()=>r)).status,'unavailable');assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.commits(),0);assert.equal(h.db.transactions.length,0);
});
check('read-only and revocation',async h=>{
 const before=h.engine.checkpoint();h.state.update({readOnly:true});assert.equal((await h.commands.run(()=>h.request())).status,'unavailable');
 h.state.update({readOnly:false});const pending=deferred();const run=h.commands.run(()=>pending.promise);h.state.update({readOnly:true});pending.resolve(h.request());assert.equal((await run).status,'unavailable');assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.commits(),0);
});
check('irrelevant patches and local/remote origins',async h=>{
 const source=h.engine.read().visible[0].spans[0].source;const events=[];let irrelevant=0;
 h.modules.subscribe({kinds:['Editor','Remote'],range:{source,start:0,end:4}},e=>events.push([e.patch.operation,e.patch.origin]));h.modules.subscribe({range:{source:'absent',start:0,end:4}},()=>irrelevant++);
 await h.commands.run(()=>h.request('L'));const peer=runtime.restoreEngine(seed.identity,seed);try{const p=peer.prepare({kind:'editor',origin:'extension:peer',commands:[{type:'replaceAt',owner:peer.read().visible[0].id,from:4,to:4,text:'R'}]});peer.commit(p);h.engine.applyUpdate(peer.encodeUpdate(h.engine.stateVector()));}finally{peer.dispose();}
 assert.equal(irrelevant,0);assert.deepEqual(events.map(e=>e[0]),['Editor','Remote']);assert.equal(events[0][1],'editac:local:extension:fixture');
 h.engine.history({type:'undo'});assert.equal(text(h.engine),'a😀bR');assert.equal(h.engine.history({type:'state'}).undoGroups,0);
});
check('reentrant observers run after engine borrow and errors preserve commits',async h=>{
 const order=[];let once=false;
 h.modules.subscribe({},()=>{order.push('first');assert.doesNotThrow(()=>h.engine.read());if(!once){once=true;h.host.commit(h.request('Z',4,4));}});
 h.modules.subscribe({},()=>{order.push('throw');throw {toString(){throw Error('conversion');}};});h.modules.subscribe({},()=>order.push('last'));
 assert.equal((await h.commands.run(()=>h.request('L'))).status,'committed');assert.deepEqual(order,['first','throw','last','first','throw','last']);assert.equal(h.commits(),2);assert.equal(text(h.engine),'L😀bZ');assert.equal(h.modules.takeErrors().length,2);assert.deepEqual(h.engine.takeObserverErrors(),[]);
});
check('stable view identity and renderer failure cleanup',async h=>{
 let mounts=0,updates=0,disposed=0,fallback=0;const element={remove(){disposed++;}};
 const content={type:'demo.atom',version:1,kind:'inline-atom',text:'label',attributes:{label:'label'}};
 const m=new ModuleRuntime(h.engine,{renderers:{'demo.atom':{mount(_element,c){mounts++;assert(Object.isFrozen(c));return {update(c){updates++;if(c.text==='fail')throw Error('update');},dispose(){disposed++;throw Error('cleanup');}};}}},onError(){throw Error('reporter');}});
 try{const view=m.mountView(element,content,()=>fallback++);const sub=m.subscribe({},()=>view.update(content));await h.commands.run(()=>h.request());await h.commands.run(()=>h.request('Y'));assert.deepEqual([mounts,updates,disposed],[1,2,0]);
 view.update({...content,text:'fail'});view.dispose();view.dispose();view.update(content);assert.deepEqual([mounts,updates,disposed,fallback],[1,3,2,1]);assert.deepEqual(m.takeErrors().map(e=>e.phase),['update','dispose']);sub.dispose();sub.dispose();m.dispose();m.dispose();assert.equal(sub.active,false);
 }finally{m.dispose();}
});
for(const mode of ['stale-async','superseded-async','cancel','dispose','host-dispose','prepare-error','commit-error','reentrant-can'])check(mode,async h=>{
 const before=h.engine.checkpoint(),pending=deferred();let signal;const r=h.request();
 if(mode==='commit-error')h.host.commit=()=>{throw Error('prepared failure');};
 if(mode==='reentrant-can'){const can=h.host.can.bind(h.host);h.host.can=request=>{const result=can(request);h.commands.cancel();return result;};}
 const run=h.commands.run(s=>{signal=s;return pending.promise;});let expected='cancelled';
 if(mode==='stale-async'){h.host.commit(h.request('fresh'));expected='stale';}
 if(mode==='superseded-async'){assert.equal((await h.commands.run(()=>h.request('fresh'))).status,'committed');}
 if(mode==='cancel'){h.commands.cancel();h.commands.cancel();}
 if(mode==='dispose'){h.commands.dispose();h.commands.dispose();}
 if(mode==='host-dispose')h.stop();
 if(mode==='prepare-error'){pending.reject(Error('prepared failure'));expected='failed';}else pending.resolve(r);
 if(mode==='commit-error')expected='failed';
 assert.equal((await run).status,expected);
 if(['cancel','dispose','superseded-async','reentrant-can'].includes(mode))assert.equal(signal.aborted,true);
 if(['stale-async','superseded-async'].includes(mode)){assert.equal(text(h.engine),'fresh😀b');assert.equal(h.commits(),1);}else{assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.commits(),0);}
});
check('out-of-order rejection after newer success cannot corrupt live request',async h=>{
 const old=deferred(),next=deferred();const first=h.commands.run(()=>old.promise),second=h.commands.run(()=>next.promise);old.reject(Error('late'));assert.equal((await first).status,'cancelled');next.resolve(h.request('new'));assert.equal((await second).status,'committed');assert.equal(text(h.engine),'new😀b');assert.equal(h.commits(),1);
});
check('repeated disposal removes subscriptions and suppresses live callbacks',async h=>{
 let calls=0;const sub=h.modules.subscribe({},()=>calls++);h.modules.dispose();h.modules.dispose();sub.dispose();sub.dispose();assert.equal(sub.active,false);assert.equal((await h.commands.run(()=>h.request())).status,'committed');assert.equal(calls,0);assert.throws(()=>h.modules.subscribe({},()=>{}));
 h.commands.dispose();assert.equal((await h.commands.run(()=>{throw Error('must not execute');})).status,'cancelled');
});

check('remote mutation invalidates pending async preparation',async h=>{
 const pending=deferred(),r=h.request('stale');const run=h.commands.run(()=>pending.promise);
 const peer=runtime.restoreEngine(seed.identity,seed);
 try{const p=peer.prepare({kind:'editor',origin:'extension:remote',commands:[{type:'replaceAt',owner:peer.read().visible[0].id,from:0,to:1,text:'remote'}]});peer.commit(p);h.engine.applyUpdate(peer.encodeUpdate(h.engine.stateVector()));}finally{peer.dispose();}
 pending.resolve(r);assert.equal((await run).status,'stale');assert.equal(text(h.engine),'remote😀b');assert.equal(h.commits(),0);assert.equal(h.engine.history({type:'state'}).undoGroups,0);
});
check('commit rechecks permissions changed by applicability callback',async h=>{
 const before=h.engine.checkpoint(),can=h.host.can.bind(h.host);
 h.host.can=request=>{const available=can(request);h.state.update({readOnly:true});return available;};
 assert.equal((await h.commands.run(()=>h.request())).status,'failed');assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.commits(),0);assert.equal(h.db.transactions.length,0);
});
