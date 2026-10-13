import { init } from '@edit-ac/core';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { DOMSelection } from '/web/dom/selection.js';
import { DOMRenderer } from '/web/dom/render.js';
import { InputProtocol } from '/web/input/protocol.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-input-policy';
let runtime,session,renderer,selection,protocol,ids,patches=[];
async function mount(text='alpha',other='independent') {
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const engine=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text},{text:other}]});
 ids=engine.read().visible.map(n=>n.id);const checkpoint=engine.checkpoint();engine.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 session.writer.engine.history({type:'clear'});
 session.writer.engine.subscribe({type:'all'},p=>patches.push({sequence:p.sequence,revision:p.revision,operation:p.operation,origin:p.origin,update:!!p.update,bytes:p.update?.bytes.length??0}));
 renderer=new DOMRenderer(root,session.writer.engine);selection=new DOMSelection(renderer,session.writer.engine);
 protocol=new InputProtocol(renderer,selection,session.writer.engine,request=>session.storage.commit(request));
 document.querySelector('#status').textContent='Real engine/storage/DOM protocol attached';select(ids[0],text.length);return {ids};
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
async function state(){await settle();const engine=session.writer.engine;const journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}
 const s=document.getSelection();return {ids,blocks:engine.read().visible.map(n=>n.id),text:engine.read().visible.map(n=>n.runs.map(r=>r.text).join('')),dom:engine.read().visible.map(n=>renderer.getBlock(n.id)?.textContent??null),boundDom:ids.map(id=>renderer.getBlock(id)?.textContent??null),intents:protocol.intents,trace:protocol.trace,patches,history:engine.history({type:'state'}),journal:entries.map(e=>({origin:e.origin,sequence:e.sequence,bytes:e.bytes.length})),caret:s?.anchorNode?selection.toModel(s.anchorNode,s.anchorOffset):null,errors:engine.takeObserverErrors(),storage:session.storage.state.phase};}
async function remote(offset,text,id=ids[0]){const local=session.writer.engine,vector=local.stateVector(),peer=runtime.restoreEngine(identity,local.checkpoint());const at=peer.anchor(id,offset,'right');try{peer.commit(peer.prepare({kind:'text',origin:'protocol-peer',command:{type:'insert',at,text}}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.releaseAnchor(at);peer.dispose();}await session.storage.flush({target:'local'});}
async function apply(bytes){session.writer.engine.applyUpdate({identity,bytes:new Uint8Array(bytes)});await session.storage.flush({target:'local'});}
async function destroy(){protocol.dispose();selection.dispose();renderer.dispose();await session.storage.destroy({policy:'flush'});}
window.policyFixture={mount,select,event,mutate,settle,state,remote,apply,destroy,get ids(){return ids},get root(){return root},get protocol(){return protocol},get engine(){return session.writer.engine},get renderer(){return renderer},get selection(){return selection}};
