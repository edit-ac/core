import { init } from '@edit-ac/core';
import { WebHistoryStore, HistoryRestorer, HistoryReview, CheckpointStorage, ChangeReview, prepareReview, exportChangeModel, importChangeModel } from '/web/index.js';
import { recoverLocalDocument } from '/web/entry.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { UpdateOutbox } from '/web/storage/outbox.js';
import { SyncSession } from '/web/sync/session.js';
import { DirectSyncAdapter } from '/web/sync/protocol.js';
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const db = 'review-concurrent';
const portable = await (await fetch('/fixture/models.json')).json();
portable.concurrent = await (await fetch('/fixture/concurrent.json')).json();
let changeView;
let session, peer, sync, outbox, view, store, access, restorer, old, writable=true, unsubscribe, mountCount=0, interfere=false;
const patches=[];let replies=[];
function replace(engine,commit,text,index=0) {
  const node=engine.read().visible[index];const anchor=engine.anchor(node.id,0,'right'),focus=engine.anchor(node.id,node.runs.map(r=>r.text).join('').length,'left');
  try { return commit({kind:'editor',origin:'history-fixture',commands:[{type:'replace',range:{anchor,focus},text}]}); }
  finally{engine.releaseAnchor(anchor);engine.releaseAnchor(focus);}
}
const engineCommit=engine=>request=>{const plan=engine.prepare(request);try{return engine.commit(plan);}finally{engine.releasePlan(plan);}};
async function cleanup(){changeView?.destroy();view?.destroy();sync?.dispose();unsubscribe?.();outbox?.close();peer?.dispose();if(session){await session.storage.destroy({policy:'flush'});session=null;}window.fixtureDisposed=true;}
window.historyFixture={
  portable, exportChangeModel, importChangeModel, prepareReview,
  show(name,options={}){changeView?.destroy();changeView=new ChangeReview(document.querySelector("#portable"),importChangeModel(JSON.stringify(portable[name])),{...options,mode:"history"});},
  peerSnapshot(){return peer.read();},
  async mount(options={}) {
    if(session)await cleanup();
    await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(db);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Fixture database still active'));});
    patches.length=0;interfere=false;writable=options.writable??true;
    const seed=runtime.createEngine({profile:'v5',documentId:'45678901-4567-4567-8567-45678901abcd',epoch:`56789012-5678-4678-8678-${String(++mountCount).padStart(12,'0')}`,nodes:[{text:options.text??'alpha 🙂\r\nold'},{text:'independent'}]});
    const checkpoint=seed.checkpoint();seed.dispose();const identity=checkpoint.identity;
    const disk=await CheckpointStorage.open(indexedDB,db);try{await disk.publish(checkpoint,[]);}finally{disk.close();}
    session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:db,identity,indexedDB,locks:navigator.locks});
    const engine=session.writer.engine; engine.history({type:'clear'});peer=runtime.restoreEngine(identity,engine.checkpoint());
    engine.subscribe({type:'all'},p=>patches.push({operation:p.operation,origin:p.origin,update:!!p.update,revision:p.revision}));
    access={scope:{identity:engine.read().identity,moduleProfile:'builtin-v5'},keyProfile:options.keyProfile??null};
    store=new WebHistoryStore(options.limits);restorer=new HistoryRestorer(store,{engine,commit:plan=>{if(interfere){interfere=false;replace(engine,r=>session.storage.commit(r),'intervening callback edit');}return session.storage.commitPrepared(plan);},writable:()=>writable},()=>access);
    old=await store.capture(engine,access,options.label??'Initial revision',options.provenance);
    if(options.edit!==false){replace(engine,r=>session.storage.commit(r),'current beta');await session.storage.flush({target:'local'});engine.history({type:'boundary'});}
    view=new HistoryReview(document.querySelector('#review'),store,()=>access,{restorer,pageSize:options.pageSize??3,maxValueChars:options.maxValueChars??4096});
    outbox=await UpdateOutbox.open(indexedDB,db);sync=new SyncSession(engine,outbox);replies=[];const adapter=new DirectSyncAdapter(peer,identity);
    sync.attach({send(frame){const r=adapter.receive(new Uint8Array(frame));if(r.reply)replies.push(r.reply);return true;}},identity,true);
    unsubscribe=session.storage.subscribeCommitted(u=>sync.localCommitted(u.origin));
    for(let i=0;i<8;i++){await sync.pump(i);while(replies.length)sync.receive(replies.shift());}
    await session.storage.flush({target:'local'});window.fixtureDisposed=false;
    return {old,snapshot:engine.read(),usage:store.usage};
  },
  get old(){return old;}, get patches(){return patches;}, get store(){return store;},get access(){return access;},get engine(){return session.writer.engine;},get restorer(){return restorer;},
  inspect(handle=old){view.inspect(handle);},read(handle=old){return store.read(handle,access);},
  async capture(label='Captured',provenance){const handle=await store.capture(session.writer.engine,access,label,provenance);view.refresh();return handle;},
  async edit(text,index=0){replace(session.writer.engine,r=>session.storage.commit(r),text,index);await session.storage.flush({target:'local'});},
  async remote(text='peer deletion',index=0){
    const vector=session.writer.engine.stateVector();replace(peer,engineCommit(peer),text,index);
    const adapter=new DirectSyncAdapter(peer,peer.read().identity);sync.receive(adapter.update(peer.encodeUpdate(vector)));await sync.pump(20);await session.storage.flush({target:'local'});
    return {current:session.writer.engine.read(),peer:peer.read(),sync:sync.state};
  },
  async converge(){for(let i=30;i<38;i++){await sync.pump(i);while(replies.length)sync.receive(replies.shift());}await session.storage.flush({target:'local'});return {current:session.writer.engine.read(),peer:peer.read(),sync:sync.state};},
  async peerMark(){const vector=session.writer.engine.stateVector();const n=peer.read().visible[0],a=peer.anchor(n.id,0,'right'),f=peer.anchor(n.id,1,'left');try{engineCommit(peer)({kind:'format',origin:'untrusted-peer-author-Alice',marks:[{range:{anchor:a,focus:f},mark:'bold',action:'apply'}],blocks:[]});}finally{peer.releaseAnchor(a);peer.releaseAnchor(f);}const adapter=new DirectSyncAdapter(peer,peer.read().identity);sync.receive(adapter.update(peer.encodeUpdate(vector)));await session.storage.flush({target:'local'});},
  async mark(){const e=session.writer.engine,n=e.read().visible[0],a=e.anchor(n.id,0,'right'),f=e.anchor(n.id,1,'left');try{session.storage.commit({kind:'format',origin:'history-fixture',marks:[{range:{anchor:a,focus:f},mark:'bold',action:'apply'}],blocks:[]});}finally{e.releaseAnchor(a);e.releaseAnchor(f);}await session.storage.flush({target:'local'});},
  readonly(value=true){writable=!value;},key(value){access={...access,keyProfile:value};},scope(value){access={...access,scope:{...access.scope,moduleProfile:value}};},
  interfere(){interfere=true;},snapshot(){return {...session.writer.engine.read(),changedNodes:[],touchedRanges:[]};},history(type='state'){return session.writer.engine.history({type});},
  async flush(){await session.storage.flush({target:'local'});const journal=await UpdateJournal.open(indexedDB,db);try{return {state:session.storage.state,entries:await journal.read(session.writer.engine.read().identity)};}finally{journal.close();}},
  async reopen(){view.destroy();sync.dispose();unsubscribe();outbox.close();peer.dispose();const identity=session.writer.engine.read().identity;await session.storage.destroy({policy:'flush'});session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:db,identity,indexedDB,locks:navigator.locks});return session.writer.engine.read();},
  destroy:cleanup,
};
window.inputFixture={destroy:cleanup};
