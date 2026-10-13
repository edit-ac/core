import {init} from '@edit-ac/core';
import {mountEditorSurface,ModuleRegistry} from '/web/index.js';
import {mathRenderer,mathModuleDefinition} from '/web/modules/math.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'77777777-7777-4777-8777-777777777777',epoch:'88888888-8888-4888-8888-888888888888',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-math';
let session,surface,config={},disposed=false;
async function mount(value){config=value;
 const runtime=await init('/core/wasm/editac_wasm_bg.wasm');const seed=runtime.restoreEngine(identity,{identity,initialized:true,writerId:11,bytes:new Uint8Array(value.bytes)});
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});bind(value.disabled);return true;
}
function bind(disabled){disposed=false;const registry=new ModuleRegistry();if(!disabled)registry.register(mathModuleDefinition,{tag:'span'});
 surface=mountEditorSurface(root,session.writer.engine,{modules:registry,...(!disabled&&!config.absentRenderer?{moduleRuntime:{renderers:{'editac.math':mathRenderer()}}}:{}),commit:request=>session.storage.commit(request)});}
async function settle(){if(!disposed)await surface.settle();await session.storage.flush({target:'local'});}
async function state(){await settle();const e=session.writer.engine,j=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await j.read(identity);}finally{j.close();}
 return{nodes:e.read().visible,history:e.history({type:'state'}),journal:entries.map(e=>e.origin),html:root.innerHTML,text:root.textContent,errors:e.takeObserverErrors(),moduleErrors:surface.moduleRuntime?.takeErrors()??[]};}
async function reopen(disabled=false){surface.dispose();await session.storage.destroy({policy:'flush'});session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});bind(disabled);await settle();}
async function destroy(){surface.dispose();await session.storage.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={mount,settle,state,reopen,destroy,disposeSurface(){surface.dispose();disposed=true;},applyUpdate(bytes){return session.writer.engine.applyUpdate({identity,bytes:new Uint8Array(bytes)});},get root(){return root},get engine(){return session.writer.engine},get surface(){return surface}};
