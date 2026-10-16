import {initMarkdown} from '/markdown/index.js';
import {markdownExtension} from '/markdown/web.js';
import {init} from '@edit-ac/core';
import {mountEditorSurface,contentModules,reorderControls} from '/web/index.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-content-modules';
const source='![Literal &lt;alt&gt; 😀](https://assets.invalid/image.png "Host title")\n\n| **head** | other [mail](mailto:team@example.test) |\n| :--- | ---: |\n| alpha😀 | beta |';
let markdown, runtime,session,surface,commands=[],policyCalls=0,requests=[],config={},viewDisposed=false;
async function mount(value){config=typeof value==='object'?value:{};
 markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text:''}]});
 seed.registerMarkdown(markdown.codec);
 const id=seed.read().visible[0].id,at=seed.anchor(id,0,'right');const content=seed.importMarkdown(config.tableSource??(config.plainTable?'| one | two |\n| --- | --- |\n| alpha😀 | beta |':source),{images:true,tables:true});
 seed.commit(seed.prepare({kind:'fragment',origin:'prepared-content',range:{anchor:at,focus:at},blocks:content.blocks}));seed.releaseAnchor(at);seed.history({type:'clear'});
 const checkpoint=seed.checkpoint();seed.dispose();const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});session.writer.engine.history({type:'clear'});bind(!!config.disabled);return true;
}
function bind(disabled){viewDisposed=false;surface=mountEditorSurface(root,session.writer.engine,{markdown,...(disabled?{}:{content:contentModules({...(!config.noPolicy?{imageUrl:metadata=>{policyCalls++;requests.push(metadata);if(config.throwPolicy)throw Error('host failure');return config.url??new URL('/fixture/pixel.svg',location.href).href;}}:{}),tableProtectedCells:()=>{if(config.policyError)throw Error('policy');return config.protected??[];}})}),...(config.reorder?{reorder:reorderControls()}:{}),contentCodecs:{images:true,tables:true},commit:request=>{commands.push(request);return session.storage.commit(request);}});}
async function settle(){if(!viewDisposed)await surface.settle();await session.storage.flush({target:'local'});if(!viewDisposed)await surface.settle();}
async function state(){await settle();const e=session.writer.engine,j=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await j.read(identity);}finally{j.close();}return{nodes:e.read().visible,markdownAvailable:e.markdownAvailable,history:e.history({type:'state'}),journal:entries.map(e=>e.origin),commands,policyCalls,requests,errors:e.takeObserverErrors(),inputs:[...root.querySelectorAll('textarea')].map(i=>({value:i.value,readOnly:i.readOnly})),html:root.innerHTML,markdown:markdown.codec.exportMarkdown(e.read().visible.filter(n=>Array.isArray(n.blockAttributes)&&String(n.blockAttributes[0]).startsWith('module:')).map(n=>({attributes:{type:'content',tuple:n.blockAttributes},runs:n.runs.map(r=>({text:r.text,marks:[]}))})))};}
async function reopen(disabled=false){surface.dispose();await session.storage.destroy({policy:'flush'});session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});bind(disabled);await settle();}
function peerCell(text){const e=session.writer.engine,peer=runtime.restoreEngine(identity,e.checkpoint()),vector=e.stateVector();const n=peer.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');peer.commit(peer.prepare({kind:'editor',origin:'prepared-peer',commands:[{type:'tableCell',owner:n.id,expected:n.blockAttributes,row:1,column:0,text}]}));const update=peer.encodeUpdate(vector);e.applyUpdate(update);peer.applyUpdate(e.encodeUpdate(peer.stateVector()));const converged=JSON.stringify(peer.read().visible)===JSON.stringify(e.read().visible);peer.dispose();return converged;}
async function destroy(){surface.dispose();await session.storage.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={disposeSurface(){surface.dispose();viewDisposed=true;},mount,settle,state,peerCell,reopen,destroy,get config(){return config},get root(){return root},get engine(){return session.writer.engine},get surface(){return surface}};
