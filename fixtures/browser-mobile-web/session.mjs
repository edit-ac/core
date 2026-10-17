import { init } from '@edit-ac/core';
import { BrowserEditor } from '/web/index.js';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { UpdateJournal } from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='mobile-harness';
let session,editor,subscription,ids,patches=[],disposed=false;
async function mount(text){
 const runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text}]});
 const store=await CheckpointStorage.open(indexedDB,databaseName);
 try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);
 subscription=session.writer.engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,update:!!p.update,revision:p.revision}));
 editor=new BrowserEditor(root,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,plainPasteControl:false,recover:async()=>session});
 await editor.ready;window.editor=editor;select(ids[0],0);return ids;
}
function select(id,a,b=a){root.focus();const node=root.querySelector(`[data-node-id="${id}"]`);const text=document.createTreeWalker(node,NodeFilter.SHOW_TEXT).nextNode();if(!text)throw Error('Missing native text');getSelection().setBaseAndExtent(text,a,text,b);}
async function settle(){await editor.settle();await session.storage.flush({target:'local'});await editor.settle();}
function point(node,offset){const el=node?.nodeType===1?node:node?.parentElement,block=el?.closest('[data-node-id]');if(!block)return null;const r=document.createRange();r.selectNodeContents(block);r.setEnd(node,offset);return {node:block.dataset.nodeId,offset:r.toString().length};}
async function state(){await settle();const native=getSelection(),engine=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {nodes:engine.read().visible,selection:{anchor:point(native.anchorNode,native.anchorOffset),focus:point(native.focusNode,native.focusOffset)},history:engine.history({type:'state'}),patches,journal:entries.map(e=>({origin:e.origin,bytes:e.bytes.length})),storage:session.storage.state.phase,errors:engine.takeObserverErrors(),focus:document.activeElement===root,dom:root.textContent,revision:engine.read().revision};}
async function destroy(){if(disposed)return;disposed=true;subscription?.dispose();await editor?.destroy({policy:'flush'});window.fixtureDisposed=true;}
// Host contract records observed CSS coordinates, owning window/root and requested
// policy. It does not infer keyboard visibility, API authorization or device support.
function host(){const w=root.ownerDocument.defaultView,v=w.visualViewport,r=root.getBoundingClientRect();return {requestedMode:'resizes-content',observed:{layout:{width:w.innerWidth,height:w.innerHeight},visual:v?{width:v.width,height:v.height,offsetLeft:v.offsetLeft,offsetTop:v.offsetTop,scale:v.scale}:null,root:{x:r.x,y:r.y,width:r.width,height:r.height}},ownerWindow:w===window,scrollRoot:root.parentElement.id,focus:document.activeElement===root,viewportMeta:document.querySelector('meta[name=viewport]').content};}
// Prepared optional API objects are passed explicitly by tests. No globals are
// replaced and no permission request is made during mount or detection.
async function requestCapability(platform,key){try{const call=platform[key];if(typeof call!=='function')return {outcome:'unavailable',fallback:'native-contenteditable'};await call();return {outcome:'prepared-success',fallback:'native-contenteditable'};}catch{return {outcome:'denied',fallback:'native-contenteditable'};}}
function capability(platform,key){try{const value=platform[key];return {available:typeof value==='function',fallback:'native-contenteditable'};}catch{return {available:false,fallback:'native-contenteditable'};}}
window.inputFixture={mount,select,settle,state,destroy,host,capability,requestCapability,get engine(){return session?.writer.engine},get root(){return root},get ids(){return ids},get surface(){return editor}};
