import {initMarkdown} from '/markdown/index.js';
import {markdownExtension} from '/markdown/web.js';
import {init} from '@edit-ac/core';
import {BrowserEditor,mountEditorSurface,slashCommands,documentSearch} from '/web/index.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'), databaseName='browser-native-commands-'+(new URL(location.href).searchParams.get('run')??'manual');
let runtime,session,surface,ids,markdown,commands=[],patches=[],pending=[],others=[],disposed=false,subscription,disposeHost;
async function mount(value='') {
 const config=typeof value==='string'?{text:value}:value,text=config.text??'';
 markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text},{text:'independent'}]});const checkpoint=seed.checkpoint();seed.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 const originalCommit=session.storage.commit.bind(session.storage);session.storage.commit=request=>{commands.push(request);if(window.rejectCommand)throw Error('injected-command-rejection');return originalCommit(request);};
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);
 subscription=session.writer.engine.subscribe({type:'all'},patch=>patches.push({operation:patch.operation,origin:patch.origin,update:!!patch.update}));
 window.commandPermission=true;
 surface=new BrowserEditor(root,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,
   markdown,search:documentSearch(),plainPasteControl:false,shortcutProfile:config.shortcutProfile,commandAllowed:()=>window.commandPermission,
   readOnly:config.readOnly,slash:slashCommands([{id:'alpha',label:'Alpha',prepare:()=>fragment('chosen')}]),
   recover:async()=>session});
 await surface.ready;
 window.editor=surface;

 if(config.code){session.storage.commit({kind:'editor',origin:'fixture-code',commands:[{type:'setCode',owner:ids[0],language:'js'}]});await session.storage.flush({target:'local'});session.writer.engine.history({type:'clear'});commands=[];patches=[];}
 select(ids[0],text.length);
 if(config.accessibility) disposeHost=(await import('/fixture/accessibility.mjs')).accessibilityHost(root,surface,session.writer.engine);
 return {ids};
}
function select(id,offset,end=offset){root.focus();const block=root.querySelector(`[data-node-id="${id}"]`);const point=at=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(at<=n.length)return[n,at];at-=n.length;}return[block,0];};const a=point(offset),b=point(end);document.getSelection().setBaseAndExtent(...a,...b);}
async function settle(){if(!disposed)await surface.settle();await session.storage.flush({target:'local'});if(!disposed)await surface.settle();await Promise.resolve();}
async function state(){await settle();const engine=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {selection:nativeSelection(),nodes:engine.read().visible,text:engine.read().visible.filter(n=>n.kind==='block').map(n=>n.runs.map(r=>r.text).join('')),history:engine.history({type:'state'}),journal:entries.map(e=>e.origin),commands:commands.map(r=>({kind:r.kind,origin:r.origin})),patches,errors:engine.takeObserverErrors(),focus:document.activeElement===root,revision:engine.read().revision,open:surface.slash.open,recovery:surface.clipboardRecovery,aborted:pending.map(p=>p.signal.aborted)};}
async function remote(offset,text){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector(),at=peer.anchor(ids[0],offset,'right');try{peer.commit(peer.prepare({kind:'text',origin:'slash-peer',command:{type:'insert',at,text}}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.releaseAnchor(at);peer.dispose();}await settle();}
async function remoteDelete(from,to){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector();try{peer.commit(peer.prepare({kind:'editor',origin:'slash-peer-delete',commands:[{type:'replaceAt',owner:ids[0],from,to,text:''}]}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.dispose();}await settle();}
function nativeSelection(){const s=document.getSelection();const point=(node,offset)=>{const el=node?.nodeType===1?node:node?.parentElement;const block=el?.closest('[data-node-id]');if(!block)return null;const r=document.createRange();r.selectNodeContents(block);r.setEnd(node,offset);return {node:block.dataset.nodeId,offset:r.toString().length};};return {anchor:point(s?.anchorNode,s?.anchorOffset),focus:point(s?.focusNode,s?.focusOffset)};}
function event(type,options={}){const e=type.startsWith('composition')?new CompositionEvent(type,{bubbles:true,...options}):type.startsWith('key')?new KeyboardEvent(type,{bubbles:true,cancelable:true,...options}):new InputEvent(type,{bubbles:true,...options});root.dispatchEvent(e);return e.defaultPrevented;}
async function reopen(){await destroy();const restored=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});try{return restored.writer.engine.read().visible;}finally{await restored.storage.destroy({policy:'flush'});}}
async function destroy(){disposeHost?.();await surface.destroy({policy:'flush'});disposed=true;subscription.dispose();for(const other of others){other.surface.dispose();await other.session.storage.destroy({policy:'flush'});}window.fixtureDisposed=true;}
function paste(text){const data=new DataTransfer();data.setData('text/plain',text);root.dispatchEvent(window.preparedClipboardEvent('paste',data));}
const fragment=text=>({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text,marks:[]}]}]});
async function second(){
 const otherIdentity={...identity,documentId:'66678901-4567-4567-8567-45678901abcd'},name=databaseName+'-second';
 const seed=runtime.createEngine({profile:'v5',documentId:otherIdentity.documentId,epoch:otherIdentity.epoch,nodes:[{text:'second'}]}),store=await CheckpointStorage.open(indexedDB,name);
 try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 const session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:name,identity:otherIdentity,indexedDB,locks:navigator.locks});
 const root=document.createElement('div');root.id='second';document.body.append(root);
 const surface=mountEditorSurface(root,session.writer.engine,{label:'Second editor',commit:r=>session.storage.commit(r)});others.push({session,surface,root});return root.id;
}
window.inputFixture={second,fragment,get pending(){return pending},get others(){return others},async disposeSurface(){await surface.destroy({policy:'flush'});disposed=true;},paste,reopen,mount,select,settle,state,remote,remoteDelete,event,destroy,get root(){return root},get ids(){return ids},get engine(){return session.writer.engine},get surface(){return surface},get codec(){return markdown.codec}};
