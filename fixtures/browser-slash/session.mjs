import {init} from '@edit-ac/core';
import {mountEditorSurface, slashCommands} from '/web/index.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'), databaseName='browser-slash';
let runtime,session,surface,ids,commands=[],pending=[],patches=[];
const fragment=text=>({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text,marks:[]}]}]});
async function mount(value='') {
 const text=typeof value==='string'?value:value.text, literal=typeof value==='object'&&value.literal;
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text},{text:'independent'}]});const checkpoint=seed.checkpoint();seed.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);
 session.writer.engine.subscribe({type:'all'},patch=>patches.push({operation:patch.operation,origin:patch.origin}));
 surface=mountEditorSurface(root,session.writer.engine,{commit:request=>{commands.push(request);return session.storage.commit(request);},slash:slashCommands([
  {id:'alpha',label:'Alpha',prepare:()=>fragment('chosen')},
  {id:'blocked',label:'Blocked',disabled:'Not available',prepare:()=>{throw Error('disabled command invoked');}},
  {id:'code',label:'Code',prepare:({node})=>({type:'editor',commands:[{type:'setCode',owner:node,language:'js'}]})},
  {id:'error',label:'Error',prepare:()=>Promise.reject(Error('prepared error'))},
  {id:'slow',label:'Slow',prepare:({signal})=>new Promise(resolve=>pending.push({resolve,signal}))},
  {id:'zulu',label:'Zulu',prepare:()=>fragment('last')},
 ],{literal})});
 select(ids[0],text.length);return {ids};
}
function select(id,offset,end=offset){root.focus();const block=root.querySelector(`[data-node-id="${id}"]`);const point=at=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(at<=n.length)return[n,at];at-=n.length;}return[block,0];};const a=point(offset),b=point(end);document.getSelection().setBaseAndExtent(...a,...b);}
async function settle(){await surface.settle();await session.storage.flush({target:'local'});await surface.settle();await Promise.resolve();}
async function state(){await settle();const engine=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}const s=document.getSelection();return {nodes:engine.read().visible,text:engine.read().visible.map(n=>n.runs.map(r=>r.text).join('')),dom:[...root.querySelectorAll('[data-node-id]')].map(n=>n.textContent),open:surface.slash.open,query:surface.slash.query,history:engine.history({type:'state'}),journal:entries.map(e=>e.origin),commands:commands.map(r=>({kind:r.kind,origin:r.origin})),patches,errors:engine.takeObserverErrors(),active:document.activeElement?.getAttribute('data-command'),focus:document.activeElement===root,activeControl:document.activeElement?.textContent,caret:s?.anchorOffset,status:surface.slash.menu.nextSibling?.textContent,aborted:pending.map(p=>p.signal.aborted)};}
async function remote(offset,text){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector(),at=peer.anchor(ids[0],offset,'right');try{peer.commit(peer.prepare({kind:'text',origin:'slash-peer',command:{type:'insert',at,text}}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.releaseAnchor(at);peer.dispose();}await settle();}
function event(type,options={}){const e=type.startsWith('composition')?new CompositionEvent(type,{bubbles:true,...options}):type.startsWith('key')?new KeyboardEvent(type,{bubbles:true,cancelable:true,...options}):new InputEvent(type,{bubbles:true,...options});root.dispatchEvent(e);return e.defaultPrevented;}
async function destroy(){surface.dispose();await session.storage.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={mount,select,settle,state,remote,event,destroy,fragment,get root(){return root},get ids(){return ids},get engine(){return session.writer.engine},get surface(){return surface},get pending(){return pending}};
