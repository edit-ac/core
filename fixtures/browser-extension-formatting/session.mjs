import {init} from '@edit-ac/core';
import {ExtensionTransferRegistry,extensionClipboardCodec,contentModules} from '/web/modules/index.js';
import {bindEditorSurface} from '/web/surface.js';
import {initMarkdown} from '/markdown/index.js';
import {markdownExtension} from '/markdown/web.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
import {ModuleRegistry} from '/web/modules/registry.js';
import {mathModuleDefinition,mathRenderer} from '/web/modules/math.js';
const identity={documentId:'91234567-4567-4567-8567-45678901abcd',epoch:'95678901-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-extension-formatting';
let runtime,markdown,session,binding,config={},commands=[],patches=[],subscription,codecCalls=0;
async function mount(value){config=value;
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text:'before'},{text:'replace😀'},{text:'after'}]});
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});session.writer.engine.history({type:'clear'});bind();return true;
}
function bind(){const engine=session.writer.engine;
 const registry=new ExtensionTransferRegistry(config.descriptors.map(descriptor=>({descriptor,...(config.unavailable?.includes(descriptor.type)?{}:{codec:{prepare(e){codecCalls++;if(config.inaccessible?.includes(e.type))throw Error('permission denied');return e.payload;}}})})));
 const modules=new ModuleRegistry();if(config.math&&!config.absentMath)modules.register(mathModuleDefinition,{tag:'span'});
 binding=bindEditorSurface(root,engine,{markdown,modules,...(config.math&&!config.absentMath?{moduleRuntime:{renderers:{'editac.math':mathRenderer()}}}:{}),plainTextPolicy:'literal',content:contentModules(),clipboardCodecs:[extensionClipboardCodec(registry,engine)],commit:request=>{if(config.rejectCommit)throw Error('fixture-final-commit-rejected');const result=session.storage.commit(request);commands.push(request);return result;}});
 subscription=engine.subscribe({type:'all'},patch=>{if(patch.update)patches.push({origin:patch.origin});});
}
async function settle(){await binding.input.settle();await session.storage.flush({target:'local'});await binding.input.settle();}
async function state(){await settle();const e=session.writer.engine,j=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await j.read(identity);}finally{j.close();}
 const captured=binding.selection.current;return{selection:captured?{anchor:e.resolve(captured.range.anchor),focus:e.resolve(captured.range.focus)}:null,focused:document.activeElement===root,moduleErrors:binding.renderer.moduleRuntime?.takeErrors()??[],nodes:e.read().visible,history:e.history({type:'state'}),journal:entries.map(e=>e.origin),commands,patches,codecCalls,errors:e.takeObserverErrors(),html:root.innerHTML,result:binding.input.clipboard.last,diagnostics:binding.input.clipboard.diagnostics,recovery:binding.input.clipboard.recovery};}
function select(reverse=false,all=false){const e=session.writer.engine,nodes=e.read().visible.filter(n=>n.kind==='block');const first=all?nodes[0]:nodes[1],last=all?nodes.at(-1):nodes[1],a=binding.selection.toDOM({node:first.id,offset:0,bias:'right'}),b=binding.selection.toDOM({node:last.id,offset:last.runs.map(r=>r.text).join('').length,bias:'left'});root.focus();document.getSelection().setBaseAndExtent(...(reverse?[b.node,b.offset,a.node,a.offset]:[a.node,a.offset,b.node,b.offset]));binding.selection.capture();}
function copy(){const data={};binding.input.clipboard.copy({getData:m=>data[m]??'',setData:(m,v)=>data[m]=v});return data;}
async function roundTrip(){const data=copy();const raw=data['application/x-edit-ac-fragment+json'];if(!raw)throw Error('structured copy unavailable');const blocks=JSON.parse(raw).blocks;const exported=markdown.codec.exportMarkdown(blocks,{images:true,tables:true});
 const fresh=runtime.createEngine({profile:'v5',documentId:'f1212121-1212-4212-8212-121212121212',epoch:'f2323232-2323-4232-8232-232323232323',nodes:[{text:''}]});try{fresh.registerMarkdown(markdown.codec);const n=fresh.read().visible[0],a=fresh.anchor(n.id,0,'right');fresh.commit(fresh.prepare({kind:'fragment',origin:'typed-recovery',range:{anchor:a,focus:a},blocks:exported.recovery.length?exported.recovery:markdown.codec.importMarkdown(exported.markdown,{images:true,tables:true}).blocks}));fresh.releaseAnchor(a);return{data,exported,mode:exported.recovery.length?'typed-recovery':'markdown-import',nodes:fresh.read().visible};}finally{fresh.dispose();}}
async function reopen(){subscription.dispose();binding.dispose();await session.storage.destroy({policy:'flush'});session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});bind();await settle();}
async function destroy(){subscription.dispose();binding.dispose();await session.storage.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={mount,settle,state,select,copy,roundTrip,reopen,destroy,rejectCommits(value){config.rejectCommit=value;},paste(data,options={}){return binding.input.clipboard.paste({getData:m=>data[m]??''},options);},defer(data){let release;const wait=new Promise(r=>release=r);const job=binding.input.clipboard.pasteDeferred({getData:m=>data[m]??''},{schedule:()=>wait});window.pendingTransfer={job,release};},get protocol(){return binding.input},get selection(){return binding.selection},get root(){return root},get engine(){return session.writer.engine},get surface(){return{setReadOnly:value=>binding.input.setReadOnly(value)}}};
