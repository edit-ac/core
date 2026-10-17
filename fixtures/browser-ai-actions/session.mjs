import {preparedTransformations} from '/fixture/prepared-transformations.mjs';
import {init} from '@edit-ac/core';
import {AiHost} from '@edit-ac/core/extensions';
import {mountEditor} from '/web/index.js';
import {aiActions} from '/web/extensions/ai/actions.js';
import {recoverLocalDocument} from '/web/entry.js';
import {CheckpointStorage} from '/web/storage/checkpoint.js';
import {UpdateJournal} from '/web/storage/journal.js';
const identity={documentId:'45678901-4567-4567-8567-45678901abcd',epoch:'56789012-5678-4678-8678-56789012abcd',schema:'editac.registry.editor.v5',offsets:'utf16',profile:'editac.yrs-yjs.editor.v5',protocolVersion:1,updateEncoding:1};
const root=document.querySelector('#projection'),databaseName='browser-ai-actions';
let runtime,session,editor,actions,ids,requests=[],aborts=0,pending=[],mode='good',response='Prepared שלום 🧪',commands=[],allowRemote=true;
async function mount(value='alpha') {
 const config=typeof value==='object'?value:{};const text=typeof value==='string'?value:value.text??'alpha';
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:[{text},{text:'independent'}]});const checkpoint=seed.checkpoint();seed.dispose();
 const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(checkpoint,[]);}finally{store.close();}
 const host=new AiHost({version:1,enabled:config.enabled!==false,capabilities:['ask','fill','continue','rewrite'],limits:{requests:3,instructionBytes:1024,contextBytes:4096,outputBytes:1024,timeoutMs:5000}}, {async *send(request,signal){
  requests.push(request);signal.addEventListener('abort',()=>aborts++,{once:true});
  if(mode==='slow') await new Promise(resolve=>{pending.push(resolve);signal.addEventListener('abort',resolve,{once:true});});
  if(mode==='error')throw Error('Prepared disconnect');
  if(mode==='rich') {yield {version:1,requestId:request.requestId,sequence:0,type:'delta',text:{html:'<b>invalid</b>'}};}
  else if(mode==='unsafe') {yield {version:1,requestId:request.requestId,sequence:0,type:'delta',text:'<script>window.executed=true</script><b>plain</b>'};}
  else {const id=request.instruction.split(':')[0].split('/')[1];yield {version:1,requestId:request.requestId,sequence:0,type:'delta',text:config.commandResults?preparedTransformations[id]:response};}
  yield {version:1,requestId:request.requestId,sequence:1,type:'finish',usage:null};
 }},()=>({allowRemote,protectedDocument:false}),()=>true);
 editor=mountEditor(root,{assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,
  recover:async options=>{session=await recoverLocalDocument(options);const commit=session.storage.commit.bind(session.storage);session.storage.commit=request=>{commands.push(request.origin);return commit(request);};return session;},
  slash:aiActions(host,{contextBytes:4096,outputBytes:1024,attached(value){actions=value;}})});
 await editor.ready;
 if(config.code) session.storage.commit({kind:'editor',origin:'fixture-code',commands:[{type:'setCode',owner:editor.read().visible[0].id,language:'js'}]});
 if(config.marks) { const owner=editor.read().visible[0].id;session.storage.commit({kind:'editor',origin:'fixture-marks',commands:config.marks.map(m=>({type:'markAt',owner,from:m.from??0,to:m.to??text.length,mark:m.mark,action:'apply',...(m.href?{href:m.href}:{})}))}); }
 if(config.atom) {const e=session.writer.engine,owner=editor.read().visible[config.atom===2?1:0].id,anchor=e.anchor(owner,0,'right'),focus=e.anchor(owner,config.atom===2?11:text.length,'left');try{session.storage.commit({kind:'fragment',origin:'fixture-atom',range:{anchor,focus},blocks:[{attributes:{type:'paragraph'},runs:[{text:'x',marks:[],attributes:{'module:editac.math':[1,{latex:'x',display:false}]}}]}]});}finally{e.releaseAnchor(anchor);e.releaseAnchor(focus);}}
 commands=[];session.writer.engine.history({type:'clear'});ids=editor.read().visible.map(n=>n.id);select(0,text.length);return {ids};
}
function select(index,offset,end=offset){root.focus();const block=root.querySelector(`[data-node-id="${ids[index]}"]`);const point=at=>{const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(at<=n.length)return[n,at];at-=n.length;}return[block,0];};document.getSelection().setBaseAndExtent(...point(offset),...point(end));document.dispatchEvent(new Event('selectionchange'));}
async function settle(){await session.storage.flush({target:'local'});await new Promise(r=>requestAnimationFrame(r));}
async function state(){await settle();const journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {nodes:editor.read().visible,text:editor.read().visible.map(n=>n.runs.map(r=>r.text).join('')),history:session.writer.engine.history({type:'state'}),requests,aborts,commands,journal:entries.map(e=>e.origin),ai:actions.session.state,focus:document.activeElement===root,status:actions.status.textContent,executed:!!window.executed,errors:session.writer.engine.takeObserverErrors()};}
async function remote(index,text){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector();try{peer.commit(peer.prepare({kind:'editor',origin:'fixture:remote',commands:[{type:'replaceAt',owner:ids[index],from:0,to:0,text}]}));local.applyUpdate(peer.encodeUpdate(vector));}finally{peer.dispose();}await settle();}
async function reopen(){await destroy();const recovered=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});try{return recovered.writer.engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));}finally{await recovered.storage.destroy({policy:'flush'});}}
async function destroy(){await editor.destroy({policy:'flush'});window.fixtureDisposed=true;}
window.inputFixture={mount,select,settle,state,remote,reopen,destroy,get actions(){return actions},get engine(){return session.writer.engine},get editor(){return editor},setPolicy(value){allowRemote=value;},setMode(value){mode=value;},setResponse(value){response=value;},finish(){pending.splice(0).forEach(f=>f());},async history(type){const e=session.writer.engine,r=e.history({type});if(r.caret)e.releaseAnchor(r.caret);if(r.selection){e.releaseAnchor(r.selection.anchor);e.releaseAnchor(r.selection.focus);}await settle();}};
