import {init} from '@edit-ac/core';
import {mountEditorSurface,contentModules} from '/web/index.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const carrier=d=>({type:'editac.embed',version:1,dataVersion:1,source:d.source,payload:{url:d.url,provider:d.provider,fallback:d.fallback}});
const root=document.querySelector('#projection'),databaseName='browser-controlled-embeds';
let runtime,session,surface,config,viewDisposed=false,commands=[];
async function mount(value){config=value;
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text:''}]});
 const id=seed.read().visible[0].id,at=seed.anchor(id,0,'right');
 seed.commit(seed.prepare({kind:'fragment',origin:'prepared-embed',range:{anchor:at,focus:at},blocks:(config.embeds??[config.embed]).map(d=>({attributes:{type:'content',tuple:['module:editac.inert-extension',1,carrier(d)]},runs:[{text:d.source,marks:[]}]}))}));seed.releaseAnchor(at);seed.history({type:'clear'});
 const checkpoint=seed.checkpoint();seed.dispose();const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});session.writer.engine.history({type:'clear'});bind();return true;
}
function bind(){viewDisposed=false;surface=mountEditorSurface(root,session.writer.engine,{...(config.disabled?{}:{content:contentModules(window.embedOptions)}),commit:request=>{commands.push(request);return session.storage.commit(request);}});}
async function settle(){if(!viewDisposed)await surface.settle();await session.storage.flush({target:'local'});if(!viewDisposed)await surface.settle();}
async function state(){await settle();const e=session.writer.engine,j=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await j.read(identity);}finally{j.close();}return{checkpoint:e.checkpoint(),vector:[...e.stateVector()],nodes:e.read().visible,history:e.history({type:'state'}),journal:entries.map(e=>e.origin),commands,errors:e.takeObserverErrors(),html:root.innerHTML};}
async function reopen(){surface?.dispose();if(session)await session.storage.destroy({policy:'flush'});session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});bind();await settle();}
async function destroy(){surface?.dispose();if(session)await session.storage.destroy({policy:'flush'});window.fixtureDisposed=true;}
async function change(replacement,remote=false){
 const e=session.writer.engine,peer=remote?runtime.restoreEngine(identity,e.checkpoint()):e,vector=e.stateVector(),n=peer.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.inert-extension'),at=peer.anchor(n.id,0,'right');
 const commit=request=>remote?peer.commit(peer.prepare(request)):session.storage.commit(request);
 try{
  commit({kind:'editor',origin:'retire-embed',commands:[{type:'atomicContent',owner:n.id,expected:n.blockAttributes,at,replacement:null}]});
  if(replacement){const target=peer.anchor(n.id,0,'right');try{commit({kind:'fragment',origin:'insert-embed',range:{anchor:target,focus:target},blocks:[{attributes:{type:'content',tuple:['module:editac.inert-extension',1,carrier(replacement)]},runs:[{text:replacement.source,marks:[]}]}]});}finally{peer.releaseAnchor(target);}}
  if(remote)e.applyUpdate(peer.encodeUpdate(vector));
 }finally{peer.releaseAnchor(at);if(remote)peer.dispose();}await settle();
}
window.inputFixture={mount,settle,state,reopen,destroy,replace:(d,remote=false)=>change(d,remote),retire:()=>change(null),disposeSurface(){surface.dispose();viewDisposed=true;},get engine(){return session.writer.engine},get surface(){return surface}};
