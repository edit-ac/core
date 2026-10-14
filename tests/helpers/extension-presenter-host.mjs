import assert from 'node:assert/strict';
import { BrowserLifecycle } from '../../packages/web/dist/lifecycle.js';
import { StorageWriter } from '../../packages/web/dist/storage/writer.js';
import { UpdateJournal } from '../../packages/web/dist/storage/journal.js';
import { LocalStorageLifecycle } from '../../packages/web/dist/storage/index.js';
import { PreparedIndexedDB } from './journal-storage.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
// Production engine + actual owning middleware, deterministic transaction transport.
export async function presenterHost(runtime, seed, api, options={}){
 const {BrowserLifecycle: Lifecycle, StorageWriter: Writer, UpdateJournal: Journal, LocalStorageLifecycle: Storage} = options.middleware ?? {BrowserLifecycle,StorageWriter,UpdateJournal,LocalStorageLifecycle};
 const db=new PreparedIndexedDB();const held=new Set();const locks={async request(name,options,callback){assert(!held.has(name));held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
 const writer=await Writer.restore(runtime,locks,seed.identity,seed),engine=writer.engine;
 const journal=await Journal.open(db),storage=new Storage(writer,journal),state=new Lifecycle(true,false);state.update({phase:'ready',ready:true});
 const modules=new api.ModuleRuntime(engine,options);let committed=0,alive=true;
 const host={get active(){return alive&&state.state.ready;},revision(){const s=engine.read();return JSON.stringify([s.identity,s.revision]);},can(request){return this.active&&!state.state.readOnly&&storage.state.phase!=='error'&&engine.can(request);},commit(request){assert(this.active&&!state.state.readOnly,'current host capability required');engine.history({type:'boundary'});engine.history({type:'explicit'});try{const result=storage.commit(request);committed++;return result;}finally{engine.history({type:'boundary'});}}};
 const commands=new api.ExtensionCommandSession(host);
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
