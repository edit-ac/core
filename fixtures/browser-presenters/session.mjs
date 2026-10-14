import { init } from '@edit-ac/core';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { DOMSelection } from '/web/dom/selection.js';
import { DOMRenderer } from '/web/dom/render.js';
import { reorderControls } from '/web/modules/reorder.js';
import { ModuleRegistry } from '/web/modules/registry.js';
import { TextInput } from '/web/input/text.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-presenters';
let mountGeneration=0;
let views=[], releases=[], config={};
function viewRenderer(){return {mount(element,content){
 const index=views.length, input=document.createElement('input');input.setAttribute('aria-label','Nested presenter '+index);input.value='inner';
 if(config.reorder){const grip=document.createElement('span');grip.contentEditable='false';grip.draggable=true;grip.setAttribute('data-editac-reorder-handle','');grip.style.cssText='display:inline-block;width:24px;height:24px;user-select:none';element.append(grip);}
 let disposed=false;const listeners=[];
 for(const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','copy','cut','paste','dragstart','dragover','drop','dragend']){const fn=e=>e.stopPropagation();element.addEventListener(type,fn);listeners.push([type,fn]);}
 const release=()=>{if(disposed)return false;element.append(input);return true;};
 const state={index,mount:1,updates:0,dispose:0,resources:1,input,element};views.push(state);releases.push(release);if(!config.delayed)release();
 return {update(){state.updates++;},dispose(){if(disposed)return;disposed=true;state.dispose++;state.resources--;for(const [type,fn]of listeners)element.removeEventListener(type,fn);input.disabled=true;}};
}};}

let markdownRegistration, runtime,session,renderer,selection,protocol,ids,patches=[],commandResults=[],otherBlock,otherText;
async function mount(value='alpha',other='independent') {
 config=typeof value==='object'?value:{};const text=typeof value==='string'?value:'alpha';views=[];releases=[];
 if(config.seed)Object.assign(identity,config.seed.identity);
 // A remount is a new session, never a second initialization of an existing
 // document/epoch. Preserve first-mount fixture pins for existing suites.
 if (++mountGeneration > 1) identity.epoch=`56789012-5678-4678-8678-${String(mountGeneration).padStart(12,'0')}`;
 patches=[];commandResults=[];
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const engine=config.seed?runtime.restoreEngine(identity,{identity,initialized:true,writerId:11,bytes:new Uint8Array(config.seed.bytes)}):runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:config.separatorOnly?[{text:''}]:other===null?[{text}]:[{text},{text:other}]});
 if(config.separatorOnly&&!config.seed){const first=engine.read().visible[0];engine.commit(engine.prepare({kind:'editor',origin:'fixture-separator',commands:[{type:'convertSeparator',owner:first.id}]}));}
 if(config.separator){const first=engine.read().visible.find(n=>n.kind==='block');engine.commit(engine.prepare({kind:'editor',origin:'fixture-separator',commands:[{type:'insertSeparator',beside:first.id,side:'after'}]}));}
 ids=engine.read().visible.filter(n=>n.kind==='block').map(n=>n.id);const checkpoint=engine.checkpoint();engine.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 if (window.markdownEnabled) {
   const {initMarkdown}=await import('/markdown/index.js');
   const {markdownExtension}=await import('/markdown/web.js');
   const adapter=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
   markdownRegistration=session.writer.engine.registerMarkdown(adapter.codec); window.markdownAdapter=adapter;
 }
 session.writer.engine.history({type:'clear'});
 session.writer.engine.subscribe({type:'all'},p=>patches.push({sequence:p.sequence,revision:p.revision,operation:p.operation,origin:p.origin,update:!!p.update,bytes:p.update?.bytes.length??0}));
 const modules=config.definitions?new ModuleRegistry():undefined;for(const d of config.definitions??[])modules.register(d,{tag:d.kind==='mark'?'mark':'code'});
 renderer=new DOMRenderer(root,session.writer.engine,{modules,moduleRuntime:modules?{renderers:Object.fromEntries(config.definitions.map(d=>[d.type,viewRenderer()]))}:undefined});selection=new DOMSelection(renderer,session.writer.engine);
 protocol=new TextInput(renderer,selection,session.writer.engine,request=>{const result=session.storage.commit(request);commandResults.push(result);return result;});
 if(config.reorder)protocol.attachReorder(reorderControls());
 if (window.markdownAdapter) protocol.shortcuts=window.markdownAdapter.createShortcuts(session.writer.engine, request=>session.storage.commit(request));
 otherBlock=ids[1]?renderer.getBlock(ids[1]):undefined;otherText=otherBlock?document.createTreeWalker(otherBlock,NodeFilter.SHOW_TEXT).nextNode():undefined;
 document.querySelector('#status').textContent='Real engine/storage/DOM protocol attached';if(config.separatorOnly)root.focus();else select(ids[0],config.seed?0:text.length);return {ids};
}
function select(id,offset,end=offset){root.focus();const a=selection.toDOM({node:id,offset,bias:'right'}),b=selection.toDOM({node:id,offset:end,bias:'left'});if(!a||!b)throw Error('Unmapped selection');document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);selection.capture();}
function event(type,options={}) {
 const e=type.startsWith('composition')?new CompositionEvent(type,{bubbles:true,...options}):type.startsWith('key')?new KeyboardEvent(type,{bubbles:true,cancelable:true,...options}):type==='blur'?new FocusEvent(type):new InputEvent(type,{bubbles:true,...options});root.dispatchEvent(e);return e;
}
function mutate(text,id=ids[0]) {
 const block=renderer.getBlock(id);let node=document.createTreeWalker(block,NodeFilter.SHOW_TEXT).nextNode();
 if(node?.nodeType===3)node.data=text;else block.replaceChildren(document.createTextNode(text));
 // Actual native caret movement follows the DOM edit, independently of model.
 const last=node?.nodeType===3?node:block.lastChild;if(last?.nodeType===3)document.getSelection().setBaseAndExtent(last,last.length,last,last.length);
}
async function settle(){await protocol.settle();await session.storage.flush({target:'local'});await protocol.settle();}
function projectedText(block){if(!block)return null;let text='';const walker=document.createTreeWalker(block,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.nodeType===3)text+=n.data;else if(n.nodeName==='BR'&&!n.hasAttribute('data-placeholder'))text+='\n';}return text;}
async function state(){await settle();const engine=session.writer.engine;const journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}
 const s=document.getSelection();return {unrelatedIdentity:otherBlock?otherBlock===renderer.getBlock(ids[1])&&otherText===document.createTreeWalker(otherBlock,NodeFilter.SHOW_TEXT).nextNode():null,ids,blocks:engine.read().visible.map(n=>n.id),text:engine.read().visible.map(n=>n.runs.map(r=>r.text).join('')),dom:engine.read().visible.map(n=>projectedText(renderer.getBlock(n.id))),boundDom:ids.map(id=>renderer.getBlock(id)?.textContent??null),intents:protocol.intents,recovery:protocol.recovery,editable:root.contentEditable,trace:protocol.trace,patches,history:engine.history({type:'state'}),journal:entries.map(e=>({origin:e.origin,sequence:e.sequence,bytes:e.bytes.length})),selectionSuspended:selection.suspended,nativeCaret:s?.anchorNode?{anchor:s.anchorOffset,focus:s.focusOffset}:null,caret:!selection.suspended&&s?.anchorNode?selection.toModel(s.anchorNode,s.anchorOffset):null,errors:engine.takeObserverErrors(),storage:session.storage.state.phase};}
async function remote(offset,text,id=ids[0]){const local=session.writer.engine,vector=local.stateVector(),peer=runtime.restoreEngine(identity,local.checkpoint());const at=peer.anchor(id,offset,'right');try{peer.commit(peer.prepare({kind:'text',origin:'protocol-peer',command:{type:'insert',at,text}}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.releaseAnchor(at);peer.dispose();}await session.storage.flush({target:'local'});}
async function remoteReplace(start,end,text,id=ids[0]) {
 const local=session.writer.engine,vector=local.stateVector(),peer=runtime.restoreEngine(identity,local.checkpoint());
 const anchor=peer.anchor(id,start,'right'),focus=peer.anchor(id,end,'right');
 try{peer.commit(peer.prepare({kind:'text',origin:'protocol-peer',command:{type:'replace',range:{anchor,focus},text}}));local.applyUpdate(peer.encodeUpdate(vector));}
 finally{peer.releaseAnchor(anchor);peer.releaseAnchor(focus);peer.dispose();}
 await session.storage.flush({target:'local'});
}
async function apply(bytes){session.writer.engine.applyUpdate({identity,bytes:new Uint8Array(bytes)});await session.storage.flush({target:'local'});}
async function destroy(){
 // Setup can fail before any adapter is attached. Release what exists, and
 // make repeated teardown safe without hiding a storage flush failure.
 protocol?.dispose();selection?.dispose();renderer?.dispose();
 protocol=undefined;selection=undefined;renderer=undefined;
 const active=session;session=undefined;
 if(active)await active.storage.destroy({policy:'flush'});
}
window.inputFixture={insertBeside(side){const atom=session.writer.engine.read().visible.find(n=>n.blockAttributes?.[0]==='separator');const result=session.storage.commit({kind:'editor',origin:'presenter-insertion',commands:[{type:'insertParagraph',separator:atom.id,side,text:'X'}]});if(result.caret){selection.move(result.caret);session.writer.engine.releaseAnchor(result.caret);}return result;},commit(request){return session.storage.commit(request);},selectAtom(){const atom=session.writer.engine.read().visible.find(n=>n.blockAttributes?.[0]==='separator');if(!atom)throw Error('Missing fixture atom');const element=renderer.getBlock(atom.id),range=document.createRange();range.selectNode(element);root.focus();getSelection().removeAllRanges();getSelection().addRange(range);return {id:atom.id,capture:selection.capture()};},releaseViews(){return releases.map(f=>f());},viewState(){return views.map(v=>({index:v.index,mount:v.mount,updates:v.updates,dispose:v.dispose,resources:v.resources,connected:v.element.isConnected,value:v.input.value}));},tag(level){return session.storage.commit({kind:'format',origin:'presenter-tag',marks:[],blocks:[{targets:[ids[0]],attributes:{type:'heading',level},action:'apply'}]});},retain(){return selection.retain();},restore(target){root.focus();selection.restoreRetained(target);},disableMarkdown(){markdownRegistration?.dispose();protocol.shortcuts.enabled=false;},mount,select,event,mutate,settle,state,remote,remoteReplace,apply,destroy,get commandResults(){return commandResults},get ids(){return ids},get root(){return root},get protocol(){return protocol},get engine(){return session.writer.engine},get renderer(){return renderer},get selection(){return selection}};
