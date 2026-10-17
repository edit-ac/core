import {init} from '@edit-ac/core';
import {mountEditorSurface,codeCommands,contentModules} from '/web/index.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
import {SyncSession} from '/web/sync/session.js';
import {DirectSyncAdapter} from '/web/sync/protocol.js';
import {UpdateOutbox} from '/web/storage/outbox.js';
const root=document.querySelector('#projection'),databaseName='browser-code-commands';
let slashEnabled=false;
let viewDisposed=false;
let runtime,session,surface,ids,commands=[],peer,vector,sync,outbox,patches=[],subscription;
async function mount(value='alpha'){
 const config=typeof value==='object'?value:{text:value};
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:config.nodes??[{text:config.text??'cat cat'},{text:'unmounted cat'}]});if(!config.prose){const plan=seed.prepare({kind:'editor',origin:'fixture:code',commands:[{type:'setCode',owner:seed.read().visible[0].id,language:config.language??'typescript'}]});try{seed.commit(plan);}finally{seed.releasePlan(plan);}}const checkpoint=seed.checkpoint();seed.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);bind(config);subscription=session.writer.engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,bytes:p.update?.bytes.length??0}));
 outbox=await UpdateOutbox.open(indexedDB,databaseName);sync=new SyncSession(session.writer.engine,outbox);
 select(ids[0],0);return {ids};
}
function bind(config={}){viewDisposed=false;surface=mountEditorSurface(root,session.writer.engine,{...(config.disabled?{}:{codeCommands:codeCommands({autoPair:config.autoPair??false,bindings:[{action:'indent',key:']',ctrl:true},{action:'outdent',key:'[',ctrl:true}]})}),content:contentModules(),commit:request=>{commands.push(request);return session.storage.commit(request);}});}
function select(id,offset,end=offset){root.focus();const block=root.querySelector(`[data-node-id="${id}"]`);const point=at=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(at<=n.length)return[n,at];at-=n.length;}return[block,0];};document.getSelection().setBaseAndExtent(...point(offset),...point(end));}
async function settle(){if(!viewDisposed)await surface.settle();await session.storage.flush({target:'local'});if(!viewDisposed)await surface.settle();await Promise.resolve();}
async function state(){await settle();const e=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}const selection=document.getSelection(),point=(node,offset)=>{const block=node?.nodeType===3?node.parentElement?.closest('[data-node-id]'):node?.closest?.('[data-node-id]');return{node:block?.dataset.nodeId,offset};};return{nodes:e.read().visible,text:e.read().visible.map(n=>n.runs.map(r=>r.text).join('')),dom:[...root.querySelectorAll('[data-node-id]')].map(n=>n.textContent),history:e.history({type:'state'}),journal:entries.map(e=>e.origin),commands:commands.map(r=>({kind:r.kind,origin:r.origin,commands:r.commands})),errors:e.takeObserverErrors(),focus:document.activeElement===root,selection:{anchor:point(selection.anchorNode,selection.anchorOffset),focus:point(selection.focusNode,selection.focusOffset)},status:surface.codeCommands?.status.textContent,patches:[...patches],sync:sync?.state,controls:document.querySelectorAll('[aria-label="Reorder block"]').length};}

async function remote(offset=0,text='remote '){
 const local=session.writer.engine,p=runtime.restoreEngine(identity,local.checkpoint());
 try{
  const vector=local.stateVector(),at=p.anchor(ids[0],offset,'right');
  try{const plan=p.prepare({kind:'text',origin:'prepared-peer',command:{type:'insert',at,text}});try{const r=p.commit(plan);if(r.caret)p.releaseAnchor(r.caret);}finally{p.releasePlan(plan);}}finally{p.releaseAnchor(at);}
  const adapter=new DirectSyncAdapter(p,identity),replies=[];
  sync.attach({send:frame=>{const result=adapter.receive(frame.slice());if(result.reply)replies.push(result.reply);return true;}},identity,true);
  sync.receive(adapter.update(p.encodeUpdate(vector)));
  for(let i=0;i<8;i++){await sync.pump(20+i);while(replies.length)sync.receive(replies.shift());}
  await settle();
  if(JSON.stringify(p.read().visible)!==JSON.stringify(local.read().visible))throw Error('Search peer fixture failed to converge');
 }finally{sync.detach();p.dispose();}
}
async function destroy(){if(viewDisposed)return;surface.dispose();viewDisposed=true;subscription.dispose();sync.dispose();await settle();outbox.close();await session.storage.destroy({policy:'report'});window.fixtureDisposed=true;}
window.inputFixture={mount,state,select,remote,destroy,get surface(){return surface;},get engine(){return session.writer.engine;},get root(){return root;},get ids(){return ids;}};
