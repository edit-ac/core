import {init} from '/core/index.js';
import {openEditorStorage,mountEditorSurface} from '/web/index.js';
import {assetInputControls} from '/web/sync/assets.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
export async function setup(options={}) {
 const runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
 const databaseName='mobile-asset-input',root=document.querySelector('#projection');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text:'alpha 😀 אב'},{text:'unrelated sibling'}]});
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 const state=window.assetInput={calls:[],signals:[],effects:[],waiting:[],mode:options.mode,number:0,descriptions:[],release(){for(const r of this.waiting.splice(0))r();}};
 const wait=()=>new Promise(r=>state.waiting.push(r));
 const host={async authorize(request,signal){state.calls.push(['authorize',request.operationId]);state.signals.push(signal);return {identity:request.identity,actions:['denied','revoked'].includes(state.mode)?[]:['ingest','read','cancel','release-reference']};},async execute(reference,request,bytes,signal){state.calls.push(['execute',request.operationId]);state.signals.push(signal);if(state.mode==='delayed-host')await wait();state.effects.push({reference,request,bytes:bytes?Array.from(bytes):null});return null;}};
 const storageOptions={assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks};
 const open=async()=>{
  state.owner=await openEditorStorage(storageOptions);state.assets=await state.owner.enableAssets();
  state.surfaceDisposed=false;state.surface=mountEditorSurface(root,state.owner.engine,{storageOwner:state.owner,readOnly:options.readOnly,plainPasteControl:false});
  state.controls=state.surface.enableAssetInputControls(assetInputControls({host,capture:options.capture,maxBytes:options.maxBytes,online:()=>state.mode!=='offline',async describe(file,signal){
   state.descriptions.push(file.name);state.signals.push(signal);if(state.mode==='delayed-describe')await wait();
   const n=++state.number,identity={host:'mobile-prepared',key:`file_${n}`};
   const descriptor={identity,kind:file.type==='image/png'?'image':'file',metadata:{filename:file.name,mediaType:file.type||'application/octet-stream',byteLength:file.size,sha256:null,width:file.type==='image/png'?1:null,height:file.type==='image/png'?1:null,durationMs:null,alt:'Prepared alt 😀 אב',caption:''},fallback:`File ${file.name}`,source:`prepared local original ${file.name}`};
   return {request:{version:1,identity,operationId:`mobile_ingest_${n}`,action:'ingest',byteLimit:options.maxBytes??2*1024*1024},descriptor:{attributes:{type:'content',tuple:['module:editac.asset',1,descriptor]},runs:[{text:descriptor.fallback,marks:[]}]}};
  }}));
  root.parentElement.append(state.controls.element);state.owner.engine.history({type:'clear'});state.select();
 };
 state.select=()=>{root.focus();const node=root.querySelector('[data-node-id]'),text=document.createTreeWalker(node,NodeFilter.SHOW_TEXT).nextNode();getSelection().setBaseAndExtent(text,2,text,2);};
 state.inspect=async()=>{await state.controls.settle();if(!state.surfaceDisposed)await state.surface.settle();await state.owner.flush({target:'local'});const journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {nodes:state.owner.engine.read().visible,checkpoint:Array.from(state.owner.engine.checkpoint().bytes),history:state.owner.engine.history({type:'state'}),entries:entries.map(e=>({origin:e.origin,bytes:e.bytes.length})),assets:await state.assets.inspect(),receipt:state.controls.receipt,status:state.controls.status.textContent,recovery:state.controls.recovery?.name,calls:state.calls,effects:state.effects,errors:state.owner.engine.takeObserverErrors()};};
 state.close=async()=>{await state.controls.dispose();await state.surface.dispose();await state.owner.destroy({policy:'flush',assetPolicy:'suspend'});};
 state.reopen=async()=>{await state.close();await open();};
 state.edit=async()=>{const e=state.owner.engine,at=e.anchor(e.read().visible[0].id,0,'right');try{state.owner.commit({kind:'text',origin:'local:changed-target',command:{type:'insert',at,text:'changed '}});}finally{e.releaseAnchor(at);}await state.surface.settle();};
 await open();return state;
}
