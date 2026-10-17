import {init} from '@edit-ac/core';
import {AiHost} from '@edit-ac/core/extensions';
import {mountEditor,contentModules} from '/web/index.js';
import {aiCompletion} from '/web/extensions/ai/completion.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-ai-completion';
let runtime,session,editor,actions,ids,requests=[],aborts=0,pending=[],mode='good',response='Prepared שלום 🧪',commands=[],allowRemote=true,completionPending=Promise.resolve();
async function mount(value='alpha') {
 const config=typeof value==='object'?value:{};const text=typeof value==='string'?value:value.text??'alpha';
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text},{text:'independent'}]});const checkpoint=seed.checkpoint();seed.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 const host=new AiHost({version:1,enabled:config.enabled!==false,capabilities:['completion'],limits:{requests:config.requests??3,instructionBytes:1024,contextBytes:4096,outputBytes:1024,timeoutMs:5000}}, {async *send(request,signal){
  requests.push(request);signal.addEventListener('abort',()=>aborts++,{once:true});
  if(mode==='slow') await new Promise(resolve=>{pending.push(resolve);signal.addEventListener('abort',resolve,{once:true});});
  if(mode==='error')throw Error('Prepared disconnect');
  if(mode==='unsafe') {yield {version:1,requestId:request.requestId,sequence:0,type:'delta',text:response};}
  else {const response=await fetch('/prepared-completion',{method:'POST',body:JSON.stringify(request),signal});if(!response.ok)throw Error('Prepared backend failure');for(const event of await response.json())yield event;return;}
  yield {version:1,requestId:request.requestId,sequence:1,type:'finish',usage:null};
 }},()=>({allowRemote,protectedDocument:false}),()=>true);
 editor=mountEditor(root,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,
  ...(config.table?{content:contentModules()}:{}),
  recover:async options=>{session=await recoverLocalDocument(options);const commit=session.storage.commit.bind(session.storage);session.storage.commit=request=>{commands.push(request.origin);return commit(request);};return session;},
  slash:aiCompletion(host,{enabled:config.optIn===true,debounceMs:1000,contextBytes:4096,outputBytes:1024,acceptKey:config.acceptKey,attached(value){actions=value;const complete=value.complete.bind(value);value.complete=(...args)=>completionPending=complete(...args);}})});
 await editor.ready;if(config.table){const e=session.writer.engine,owner=editor.read().visible[0].id,anchor=e.anchor(owner,0,'right'),focus=e.anchor(owner,text.length,'left'),tuple=['module:editac.table',1,{alignments:['none','none'],rows:[[[['one',[]]],[['two',[]]]],[[['alpha',[]]],[['beta',[]]]]],source:'| one | two |\n| --- | --- |\n| alpha | beta |'}];try{session.storage.commit({kind:'fragment',origin:'fixture-table',range:{anchor,focus},blocks:[{attributes:{type:'content',tuple},runs:[{text:'one\ttwo\nalpha\tbeta',marks:[]}]}]});}finally{e.releaseAnchor(anchor);e.releaseAnchor(focus);}}if(config.code){session.storage.commit({kind:'editor',origin:'fixture-code',commands:[{type:'setCode',owner:editor.read().visible[0].id,language:'js'}]});}if(config.atom){const e=session.writer.engine,owner=editor.read().visible[0].id,anchor=e.anchor(owner,0,'right'),focus=e.anchor(owner,text.length,'left');try{session.storage.commit({kind:'fragment',origin:'fixture-atom',range:{anchor,focus},blocks:[{attributes:{type:'paragraph'},runs:[{text,marks:[],attributes:{'module:editac.math':[1,{latex:text,display:false}]}}]}]});}finally{e.releaseAnchor(anchor);e.releaseAnchor(focus);}}session.writer.engine.history({type:'clear'});ids=editor.read().visible.map(n=>n.id);select(0,text.length);return {ids};
}
function select(index,offset,end=offset){root.focus();const block=root.querySelector(`[data-node-id="${ids[index]}"]`);const point=at=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(at<=n.length)return[n,at];at-=n.length;}return[block,0];};document.getSelection().setBaseAndExtent(...point(offset),...point(end));document.dispatchEvent(new Event('selectionchange'));}
async function settle(){await session.storage.flush({target:'local'});}
async function state(){await settle();const journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {text:editor.read().visible.map(n=>n.runs.map(r=>r.text).join('')),history:session.writer.engine.history({type:'state'}),requests,aborts,commands,journal:entries.map(e=>e.origin),checkpoint:session.writer.engine.checkpoint(),vector:[...session.writer.engine.stateVector()],html:root.innerHTML,ghost:actions.ghost.textContent,ai:actions.session.state,focus:document.activeElement===root,status:actions.status.textContent,executed:!!window.executed,errors:session.writer.engine.takeObserverErrors()};}
async function remote(index,text){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector();try{peer.commit(peer.prepare({kind:'editor',origin:'fixture:remote',commands:[{type:'replaceAt',owner:ids[index],from:0,to:0,text}]}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.dispose();}await settle();}
async function reopen(){await destroy();const recovered=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});try{return recovered.writer.engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));}finally{await recovered.storage.destroy({policy:'flush'});}}
async function destroy(){await editor.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={get transportState(){return{requests:requests.length,aborts};},idle(){return completionPending;},deny(){allowRemote=false;},mount,select,settle,state,remote,reopen,destroy,get actions(){return actions},get engine(){return session.writer.engine},get editor(){return editor},setMode(value){mode=value;},setResponse(value){response=value;},finish(){pending.splice(0).forEach(f=>f());},async history(type){const e=session.writer.engine,r=e.history({type});if(r.caret)e.releaseAnchor(r.caret);if(r.selection){e.releaseAnchor(r.selection.anchor);e.releaseAnchor(r.selection.focus);}await settle();}};
