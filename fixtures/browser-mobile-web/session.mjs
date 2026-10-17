import { init } from '@edit-ac/core';
import { BrowserEditor, reorderControls, ModuleRegistry } from '/web/index.js';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { UpdateJournal } from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='mobile-harness';
let runtime,session,editor,subscription,ids,selection,patches=[],disposed=false,preparedViewport=false;
const viewportGeometry=()=>{if(window.mobileGeometryError)throw Error("prepared unavailable");return window.mobileGeometry;};
async function mount(value){
 const options=typeof value==='string'?{text:value}:value;preparedViewport=!!options.viewport;
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:options.nodes??[{text:options.text}]});
 if(options.code){const plan=seed.prepare({kind:'editor',origin:'mobile-seed-code',commands:[{type:'setCode',owner:seed.read().visible[0].id,language:'typescript'}]});try{seed.commit(plan);}finally{seed.releasePlan(plan);}}
 let modules;
 if(options.marks){for(const mark of options.marks){const owner=seed.read().visible[mark.node??0].id;seed.commit(seed.prepare({kind:'editor',origin:'mobile-seed',commands:[{type:'markAt',owner,from:mark.from,to:mark.to,mark:mark.type,action:'apply'}]}));}}
 if(options.reorder){const first=seed.read().visible[0].id;seed.commit(seed.prepare({kind:'editor',origin:'mobile-seed',commands:[{type:'markAt',owner:first,from:0,to:5,mark:'bold',action:'apply'}]}));}
 if(options.mapping){const nodes=seed.read().visible,at=seed.anchor(nodes[4].id,4,'right');try{seed.commit(seed.prepare({kind:'editor',origin:'mobile-seed',commands:[{type:'hardBreak',at}]}));}finally{seed.releaseAnchor(at);}const a=seed.anchor(nodes[5].id,0,'right'),b=seed.anchor(nodes[5].id,4,'left');try{seed.commit(seed.prepare({kind:'fragment',origin:'mobile-seed',range:{anchor:a,focus:b},blocks:[{attributes:{type:'paragraph'},runs:[{text:'atom',marks:[],attributes:{'module:fixture.atom':[1,{label:'atom'}]}}]}]}));}finally{seed.releaseAnchor(a);seed.releaseAnchor(b);}modules=new ModuleRegistry();modules.register({type:'fixture.atom',version:1,kind:'inline-atom',attributes:{label:{type:'string',required:true,maxUtf16:8}},content:{type:'text',maxUtf16:8},fallback:{type:'text',source:'content'}},{tag:'span'});}
 const store=await CheckpointStorage.open(indexedDB,databaseName);
 try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);
 subscription=session.writer.engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,update:!!p.update,revision:p.revision}));
 let markdown,slash;
 if(options.triggers){const {initMarkdown}=await import('/markdown/index.js'),{markdownExtension}=await import('/markdown/web.js'),{slashCommands}=await import('/web/modules/slash.js');markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));slash=slashCommands([{id:'paragraph',label:'Insert mobile paragraph',prepare:()=>({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'mobile command',marks:[]}]}]})}]);}
 editor=new BrowserEditor(root,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,plainPasteControl:options.plainPasteControl??false,readOnly:options.readOnly,commandAllowed:name=>!options.deniedCommands?.includes(name),commandControls:options.commandControls,inputHints:options.inputHints,modules,markdown,slash,viewport:options.viewport?{requestedMode:options.requestedMode,geometry:viewportGeometry}:undefined,...(options.reorder?{reorder:context=>{selection=context.selection;return reorderControls()(context);}}:{}),recover:async()=>session});
 await editor.ready;window.editor=editor;select(ids[0],0);return ids;
}
function select(id,a,b=a,focusId=id){root.focus();const point=(id,offset)=>{const block=root.querySelector(`[data-node-id="${id}"]`),walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(offset<=node.length)return {node,offset};offset-=node.length;}return {node:block,offset:0};};const anchor=point(id,a),focus=point(focusId,b);getSelection().setBaseAndExtent(anchor.node,anchor.offset,focus.node,focus.offset);selection?.capture();}
async function settle(){await editor.settle();await session.storage.flush({target:'local'});await editor.settle();}
async function remote(index,offset,text){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector(),at=peer.anchor(ids[index],offset,'right');try{const result=peer.commit(peer.prepare({kind:'text',origin:'mobile-peer',command:{type:'insert',at,text}}));if(result.caret)peer.releaseAnchor(result.caret);local.applyUpdate(peer.encodeUpdate(vector));await settle();}finally{peer.releaseAnchor(at);peer.dispose();}}
function point(node,offset){const el=node?.nodeType===1?node:node?.parentElement,block=el?.closest('[data-node-id]');if(!block)return null;const r=document.createRange();r.selectNodeContents(block);r.setEnd(node,offset);return {node:block.dataset.nodeId,offset:r.toString().length};}
async function state(){await settle();const native=getSelection(),engine=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {nodes:engine.read().visible,selection:{anchor:point(native.anchorNode,native.anchorOffset),focus:point(native.focusNode,native.focusOffset)},history:engine.history({type:'state'}),patches,journal:entries.map(e=>({origin:e.origin,bytes:e.bytes.length})),storage:session.storage.state.phase,errors:engine.takeObserverErrors(),focus:document.activeElement===root,dom:root.textContent,revision:engine.read().revision,recovery:editor.inputRecovery};}
async function destroy(){if(disposed)return;disposed=true;subscription?.dispose();const report=await editor?.destroy({policy:'flush'});window.fixtureDisposed=true;return report;}
// Host contract records observed CSS coordinates, owning window/root and requested
// policy. It does not infer keyboard visibility, API authorization or device support.
function host(){const w=root.ownerDocument.defaultView,v=w.visualViewport,r=root.getBoundingClientRect();return {requestedMode:'resizes-content',observed:{layout:{width:w.innerWidth,height:w.innerHeight},visual:v?{width:v.width,height:v.height,offsetLeft:v.offsetLeft,offsetTop:v.offsetTop,scale:v.scale}:null,root:{x:r.x,y:r.y,width:r.width,height:r.height}},ownerWindow:w===window,scrollRoot:root.parentElement.id,focus:document.activeElement===root,viewportMeta:document.querySelector('meta[name=viewport]').content};}
// Prepared optional API objects are passed explicitly by tests. No globals are
// replaced and no permission request is made during mount or detection.
async function requestCapability(platform,key){try{const call=platform[key];if(typeof call!=='function')return {outcome:'unavailable',fallback:'native-contenteditable'};await call();return {outcome:'prepared-success',fallback:'native-contenteditable'};}catch{return {outcome:'denied',fallback:'native-contenteditable'};}}
function capability(platform,key){try{const value=platform[key];return {available:typeof value==='function',fallback:'native-contenteditable'};}catch{return {available:false,fallback:'native-contenteditable'};}}
// Prepared platform delivery only: mutate native DOM, never inject engine results.
function domPoint(index,offset){const block=root.querySelector(`[data-node-id="${ids[index]}"]`),walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(offset<=node.length)return {node,offset};offset-=node.length;}return {node:block,offset:0};}
function deliver(type,options={},range){let event;if(type.startsWith('composition'))event=new CompositionEvent(type,{bubbles:true,...options});else if(type.startsWith('key'))event=new KeyboardEvent(type,{bubbles:true,cancelable:true,...options});else if(type==='blur')event=new FocusEvent(type);else event=new InputEvent(type,{bubbles:true,...options});if(range){const a=domPoint(range.node??0,range.from),b=domPoint(range.node??0,range.to);const target=new StaticRange({startContainer:a.node,startOffset:a.offset,endContainer:b.node,endOffset:b.offset});Object.defineProperty(event,'getTargetRanges',{value:()=>[target]});}root.dispatchEvent(event);return {type,prepared:true,prevented:event.defaultPrevented,inputType:event.inputType,data:event.data};}
function mutate(text,index=0,anchor=text.length,focus=anchor){const block=root.querySelector(`[data-node-id="${ids[index]}"]`);block.textContent=text;const a=domPoint(index,anchor),b=domPoint(index,focus);getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);}
async function sibling(){
 const databaseName='mobile-harness-sibling',store=await CheckpointStorage.open(indexedDB,databaseName);
 try{await store.publish(session.writer.engine.checkpoint(),[]);}finally{store.close();}
 const secondRoot=document.createElement('div');secondRoot.setAttribute('aria-label','Second mobile document');root.parentElement.append(secondRoot);
 const second=new BrowserEditor(secondRoot,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,plainPasteControl:false,viewport:preparedViewport?{geometry:viewportGeometry}:undefined});await second.ready;
 return {editor:second,root:secondRoot,async dispose(){await second.destroy({policy:'flush'});secondRoot.remove();}};
}
window.inputFixture={sibling,deliver,mutate,mount,select,settle,state,destroy,host,capability,requestCapability,get engine(){return session?.writer.engine},get root(){return root},get ids(){return ids},remote,get selection(){return selection},get pointer(){return editor.reorder?.pointerState},get surface(){return editor}};
