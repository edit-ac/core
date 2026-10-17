import { init } from '@edit-ac/core';
import { createHostAgent, createHostApply } from '/web/host/index.js';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { UpdateOutbox } from '/web/storage/outbox.js';
import { SyncSession } from '/web/sync/session.js';
import { DirectSyncAdapter } from '/web/sync/protocol.js';
import { DOMRenderer } from '/web/dom/render.js';
import { DOMSelection } from '/web/dom/selection.js';
import { TextInput } from '/web/input/text.js';

const rpc = async input => {
  const r = await window.hostRpc(input);
  if (r.error) throw new Error(r.error);
  return r.ok;
};
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
let views=[], readable=true,writable=true, revokeAfterCommit=false;
const permissions=['apply','receipt'];
const access=()=>({actorId:'agent-a',documentId:views[0].engine.read().identity.documentId,
  epoch:views[0].engine.read().identity.epoch,permissions,readOnly:!writable});
const services=createHostApply({
  available:(_a,op)=>readable&&(op==='receipt'||writable),
  async apply(request){const r=await rpc({op:'apply',...request});if(revokeAfterCommit){revokeAfterCommit=false;readable=false;writable=false;await rpc({op:'policy',writable:false,readable:false});}return r;},
  receipt:request=>rpc({op:'receipt',...request}),
});
const agent=createHostAgent({authorize:async(context,id)=>context==='authenticated'&&readable&&id===access().documentId?access():null,services});
const call=(op,request={})=>agent.call(op,{version:1,documentId:access().documentId,...request},'authenticated');
function texts(engine){return engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));}
async function flush(){for(const v of views)await v.session.storage.flush({target:'local'});}
async function pump(){for(let n=0;n<8;n++){await flush();for(const v of views)await v.sync.pump(n);}await flush();}
async function push(){
  for(const v of views){
    const update=await rpc({op:'sync',vector:[...v.engine.stateVector()]});
    v.sync.receive(v.adapter.update({identity:update.identity,bytes:new Uint8Array(update.bytes)}));
  }
  await pump();
}
async function humanToHost(v=views[0]){
  const vector=new Uint8Array(await rpc({op:'vector'}));
  const u=v.engine.encodeUpdate(vector);
  return rpc({op:'peer',writerId:v.engine.checkpoint().writerId,bytes:[...u.bytes]});
}
async function mount(){
  window.agentPhase="seed";
  const seed=await rpc({op:'seed'});seed.bytes=new Uint8Array(seed.bytes);
  for(const id of ['one','two']){
    window.agentPhase=`open-${id}`;
    const name=`agent-realtime-${id}`;
    const disk=await CheckpointStorage.open(indexedDB,name);try{await disk.publish(seed,[]);}finally{disk.close();}
    const session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:name,identity:seed.identity,indexedDB,locks:navigator.locks});
    const engine=session.writer.engine;engine.history({type:'clear'});
    const root=document.querySelector(`#${id}`),renderer=new DOMRenderer(root,engine),selection=new DOMSelection(renderer,engine);
    const input=new TextInput(renderer,selection,engine,request=>session.storage.commit(request));
    const outbox=await UpdateOutbox.open(indexedDB,name),sync=new SyncSession(engine,outbox),patches=[];
    const subscription=engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,operation:p.operation,update:!!p.update,revision:p.revision}));
    const off=session.storage.subscribeCommitted(u=>sync.localCommitted(u.origin));
    views.push({name,session,engine,root,renderer,selection,input,outbox,sync,subscription,off,patches,
      retained:root.firstElementChild});
  }
  for(const [n,v]of views.entries()){
    v.adapter=new DirectSyncAdapter(v.engine,seed.identity);
    v.sync.attach({send(frame){views[1-n].sync.receive(new Uint8Array(frame));return true;}},seed.identity,true);
  }
  window.agentPhase="pump";await pump();window.fixtureDisposed=false;window.agentPhase="mounted";
}
async function destroy(){for(const v of views){v.input.dispose();v.selection.dispose();v.renderer.dispose();v.subscription.dispose();v.off();v.sync.dispose();v.outbox.close();await v.session.storage.destroy({policy:'flush'});}views=[];window.fixtureDisposed=true;}
window.agentFixture={
  mount,call,push,pump,humanToHost,rpc,
  async prepare(text='A',index=0){return rpc({op:'prepare',text,index});},
  async apply(p,requestId='request-a'){return call('apply',{...p,requestId});},
  async human(text='H',index=1){const v=views[0],node=v.engine.read().visible[index],a=v.engine.anchor(node.id,0,'right');try{v.session.storage.commit({kind:'editor',origin:'human:typing',commands:[{type:'insert',at:a,text}]});}finally{v.engine.releaseAnchor(a);}await pump();},
  select(index=0){const v=views[0],n=v.engine.read().visible[index],p=v.selection.toDOM({node:n.id,offset:0,bias:'right'});v.root.focus();document.getSelection().setBaseAndExtent(p.node,p.offset,p.node,p.offset);v.selection.capture();},
  async policy(options){await rpc({op:'policy',...options});writable=options.writable??writable;readable=options.readable??readable;},
  revokeAfterCommit(){revokeAfterCommit=true;},
  async undoHuman(){views[0].engine.history({type:'undo'});await pump();},
  async evidence(){await flush();const records=[];for(const v of views){const j=await UpdateJournal.open(indexedDB,v.name);try{records.push({journal:await j.read(v.engine.read().identity),pending:await v.outbox.pendingPage(v.engine.read().identity,null,128,1048576),state:v.session.storage.state});}finally{j.close();}}return records;},
  snapshot(){return views.map(v=>({texts:texts(v.engine),ids:v.engine.read().visible.map(n=>n.id),dom:v.root.innerText,
    retained:v.retained===v.root.firstElementChild,history:v.engine.history({type:'state'}),patches:v.patches}));},
  async reopen(){const identity=views[0].engine.read().identity,name=views[0].name;await destroy();const s=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:name,identity,indexedDB,locks:navigator.locks});try{return texts(s.writer.engine);}finally{await s.storage.destroy({policy:'flush'});}},
  destroy,
};
window.inputFixture={destroy};
