import {init} from '@edit-ac/core';
import {mountEditorSurface,reorderControls,slashCommands} from '/web/index.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
import {SyncSession} from '/web/sync/session.js';
import {DirectSyncAdapter} from '/web/sync/protocol.js';
import {UpdateOutbox} from '/web/storage/outbox.js';
const root=document.querySelector('#projection'),databaseName='browser-reorder-pointer';
let slashEnabled=false;
let viewDisposed=false;
let runtime,session,surface,ids,commands=[],peer,vector,sync,outbox,patches=[],subscription;
async function mount(value='alpha'){
 const text=typeof value==='string'?value:value.text;slashEnabled=typeof value==='object'&&!!value.slash;
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text},{text:'beta'},{text:'gamma'},...Array.from({length:Math.max(0,(value.count??3)-3)},(_,i)=>({text:'Block '+i}))]});const checkpoint=seed.checkpoint();seed.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);bind();subscription=session.writer.engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,bytes:p.update?.bytes.length??0}));
 outbox=await UpdateOutbox.open(indexedDB,databaseName);sync=new SyncSession(session.writer.engine,outbox);
 select(ids[0],2);return {ids};
}
function bind(disabled=false){viewDisposed=false;surface=mountEditorSurface(root,session.writer.engine,{...(disabled?{}:{reorder:reorderControls()}),...(slashEnabled?{slash:slashCommands([{id:'prepared',label:'Prepared command',prepare:()=>({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'prepared',marks:[]}]}]})}])}:{}),commit:request=>{commands.push(request);return session.storage.commit(request);}});}
function select(id,offset,end=offset){root.focus();const block=root.querySelector(`[data-node-id="${id}"]`);const point=at=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(at<=n.length)return[n,at];at-=n.length;}return[block,0];};document.getSelection().setBaseAndExtent(...point(offset),...point(end));}
async function settle(){if(!viewDisposed)await surface.settle();await session.storage.flush({target:'local'});if(!viewDisposed)await surface.settle();await Promise.resolve();}
async function state(){await settle();const e=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}const selection=document.getSelection(),point=(node,offset)=>{const block=node?.nodeType===3?node.parentElement?.closest('[data-node-id]'):node?.closest?.('[data-node-id]');return{node:block?.dataset.nodeId,offset};};return{nodes:e.read().visible,text:e.read().visible.map(n=>n.runs.map(r=>r.text).join('')),dom:[...root.querySelectorAll('[data-node-id]')].map(n=>n.textContent),history:e.history({type:'state'}),journal:entries.map(e=>e.origin),commands:commands.map(r=>({kind:r.kind,origin:r.origin,commands:r.commands})),errors:e.takeObserverErrors(),focus:document.activeElement===root,selection:{anchor:point(selection.anchorNode,selection.anchorOffset),focus:point(selection.focusNode,selection.focusOffset)},status:surface.reorder?.status.textContent,pointer:surface.reorder?.pointerState,patches:[...patches],sync:sync?.state,controls:document.querySelectorAll('[aria-label="Reorder block"]').length};}
function fork(offset=1,text='PEER😀'){const local=session.writer.engine;peer=runtime.restoreEngine(identity,local.checkpoint());vector=local.stateVector();const at=peer.anchor(ids[0],offset,'right');try{peer.commit(peer.prepare({kind:'text',origin:'prepared-peer',command:{type:'insert',at,text}}));}finally{peer.releaseAnchor(at);}}
async function deliver(){const local=session.writer.engine,adapter=new DirectSyncAdapter(peer,identity),replies=[];
 sync.attach({send:frame=>{const result=adapter.receive(frame.slice());if(result.reply)replies.push(result.reply);return true;}},identity,true);
 sync.receive(adapter.update(peer.encodeUpdate(vector)));
 for(let i=0;i<8;i++){await sync.pump(20+i);while(replies.length)sync.receive(replies.shift());}
 await settle();return JSON.stringify(peer.read().visible)===JSON.stringify(local.read().visible);}
function peerJoin(first,second){const local=session.writer.engine;peer=runtime.restoreEngine(identity,local.checkpoint());vector=local.stateVector();peer.commit(peer.prepare({kind:'editor',origin:'prepared-peer-delete',commands:[{type:'join',first:ids[first],second:ids[second]}]}));}
async function nested(){const e=session.writer.engine;session.storage.commit({kind:'editor',origin:'fixture-wrap',commands:[{type:'wrap',targets:[ids[0],ids[1]],style:{type:'quote'}}]});const outer=e.read().visible.find(n=>n.kind==='quote').id;session.storage.commit({kind:'editor',origin:'fixture-wrap',commands:[{type:'wrap',targets:[ids[0]],style:{type:'quote'}}]});const inner=e.read().visible.find(n=>n.kind==='quote'&&n.id!==outer).id;e.history({type:'clear'});select(ids[0],2);await settle();return{outer,inner};}
async function reopen(disabled=false){sync.dispose();outbox.close();surface.dispose();subscription.dispose();await session.storage.destroy({policy:'flush'});session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});bind(disabled);outbox=await UpdateOutbox.open(indexedDB,databaseName);sync=new SyncSession(session.writer.engine,outbox);subscription=session.writer.engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,bytes:p.update?.bytes.length??0}));await settle();}
function event(type,options={}){const e=type.startsWith('composition')?new CompositionEvent(type,{bubbles:true,...options}):new KeyboardEvent(type,{bubbles:true,cancelable:true,...options});root.dispatchEvent(e);return e.defaultPrevented;}
async function destroy(){sync.dispose();outbox.close();subscription.dispose();surface.dispose();peer?.dispose();await session.storage.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={disposeView(){viewDisposed=true;surface.dispose();},mount,select,settle,state,fork,peerJoin,deliver,nested,reopen,event,destroy,get root(){return root},get ids(){return ids},get engine(){return session.writer.engine},get surface(){return surface}};
