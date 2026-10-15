import { init } from '@edit-ac/core';
import { mountEditorSurface, linkEnrichment } from '/web/index.js';
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const root = document.querySelector('#projection');
const documentId='45678901-4567-4567-8567-45678901abcd', epoch='56789012-5678-4678-8678-56789012abcd';
let contextAvailable=true, assetMode='none';
const assetUrls=[], revokedAssets=[];
const createAsset=URL.createObjectURL.bind(URL),revokeAsset=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createAsset(blob);assetUrls.push(url);return url;};
URL.revokeObjectURL=url=>{revokedAssets.push(url);revokeAsset(url);};
function iconAsset(handle){
 if(assetMode==='none')return null;
 if(assetMode==='svg')return new Blob(['<svg/>'],{type:'image/svg+xml'});
 if(assetMode==='huge')return new Blob([new Uint8Array(32769)],{type:'image/png'});
 return new Blob([Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),c=>c.charCodeAt(0))],{type:'image/gif'});
}
let initialCheckpoint;
let engine, surface, links, ids, policy='local-paste', pending=[], commands=[], patches=[], listeners=new Set(), released=0, host;
const url='https://example.com/path?private=query';
function mount(text='alpha') {
 engine=runtime.createEngine({profile:'v5',documentId,epoch,nodes:[{text},{text:'second'}]});ids=engine.read().visible.map(n=>n.id);
 host={principal:'alice',tenant:'team',authority:null,scope:{document:documentId,session:'session1',revision:'policy:1',permission:'permission1',authorized:true},policyRevision:'1',readonly:false,
 capabilities:{publicMetadata:true,privateLookup:false,title:true,icon:true,preview:true,activate:true,publishMetadata:true}};
 engine.subscribe({type:'all'},p=>patches.push({operation:p.operation,origin:p.origin}));
 bind();select(ids[0],text.length);engine.history({type:'clear'});initialCheckpoint=engine.checkpoint();
}
function bind(){surface=mountEditorSurface(root,engine,{links:linkEnrichment({iconAsset,attached:p=>{links=p;},policy:()=>policy,context:()=>{if(!contextAvailable)throw Error('Prepared host unavailable');return host;},subscribe:cb=>{listeners.add(cb);return()=>{listeners.delete(cb);released++;};},ports:{publicMetadata:(request,signal)=>new Promise((resolve,reject)=>pending.push({request,signal,resolve,reject}))}}),commit:r=>{commands.push(r);return engine.commit(engine.prepare(r));}});}
function select(node,offset=0,to=offset){
 const walker=document.createTreeWalker(root.querySelector(`[data-node-id="${node}"]`),NodeFilter.SHOW_TEXT);const texts=[];while(walker.nextNode())texts.push(walker.currentNode);
 const point=pos=>{for(const t of texts){if(pos<=t.length)return[t,pos];pos-=t.length;}return[texts.at(-1),texts.at(-1)?.length??0];};
 const a=point(offset),b=point(to);root.focus();const selection=getSelection();selection.removeAllRanges();const range=document.createRange();range.setStart(...a);range.setEnd(...b);selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
}
function paste(href=url,label=href){root.dispatchEvent(preparedClipboardEvent('paste',{getData:m=>m==='text/html'?`<a href="${href}">${label}</a>`:m==='text/plain'?label:''}));}
function respond(i=0,kind='available'){
 const p=pending[i];if(kind==='reject'){p.reject(Error('prepared offline'));return;}
 const outcome=kind==='available'?{status:'available',metadata:{kind:'public',provider:'fixture',requestedUrl:p.request.target.url,canonicalUrl:'https://advisory.example/',display:{title:'<Safe & title> 😀',iconAsset:'host_asset'}},freshness:{fetchedAt:100,expiresAt:Date.now()+60000,policyRevision:'1'}}:{status:kind};
 if(kind==='malformed')outcome.status='available';p.resolve(outcome);
}
function mutate(action){
 if(action==='edit')engine.commit(engine.prepare({kind:'editor',origin:'edit-label',commands:[{type:'replaceAt',owner:ids[0],from:0,to:engine.read().visible[0].runs.map(r=>r.text).join('').length,text:'edited'}]}));
 if(action==='delete')engine.commit(engine.prepare({kind:'editor',origin:'delete-link-owner',commands:[{type:'join',first:ids[0],second:ids[1]}]}));
 if(action==='remote'){const peer=runtime.restoreEngine(engine.read().identity,engine.checkpoint());const vector=engine.stateVector();const at=peer.anchor(ids[1],0,'right');try{peer.commit(peer.prepare({kind:'text',origin:'peer',command:{type:'insert',at,text:'remote '}}));engine.applyUpdate(peer.encodeUpdate(vector));}finally{peer.releaseAnchor(at);peer.dispose();}}
 if(action==='history')engine.history({type:'undo'});
 if(action==='readonly')surface.setReadOnly(true);
 if(action==='dispose')surface.dispose();
 if(['session','principal','permission','policy','revoked'].includes(action)){
  if(action==='session')host={...host,scope:{...host.scope,session:'session2'}};
  if(action==='principal')host={...host,principal:'bob'};
  if(action==='permission')host={...host,scope:{...host.scope,permission:'permission2'}};
  if(action==='policy')policy='disabled';
  if(action==='revoked')host={...host,capabilities:{...host.capabilities,publishMetadata:false}};
  for(const cb of listeners)cb();
 }
}
function replay(){const checkpoint=engine.checkpoint();surface.dispose();engine.dispose();engine=runtime.restoreEngine(checkpoint.identity,checkpoint);ids=engine.read().visible.map(n=>n.id);bind();}
function reset(){surface.dispose();engine.dispose();engine=runtime.restoreEngine(initialCheckpoint.identity,initialCheckpoint);ids=engine.read().visible.map(n=>n.id);bind();select(ids[0],5);engine.history({type:'clear'});}
function state(){return {assetUrls,revokedAssets,nodes:engine.read().visible,revision:engine.read().revision,history:engine.history({type:'state'}),commands,patches,requests:pending.map(p=>p.request),aborted:pending.map(p=>p.signal.aborted),preview:links.element.textContent,views:links.element.childElementCount,released,listeners:listeners.size,errors:engine.takeObserverErrors?.()??[]};}
window.inputFixture={mount,reset,get engine(){return engine;},get surface(){return surface;},get ids(){return ids;},select,paste,respond,mutate,state,replay,assetMode:mode=>{assetMode=mode;},unavailableContext:()=>{contextAvailable=false;},silentReadonly:()=>{host={...host,readonly:true};},silentSession:()=>{host={...host,scope:{...host.scope,session:'silent-session2'}};},setPolicy:p=>{policy=p;for(const cb of listeners)cb();},refresh:()=>links.refresh(ids[0]),commit:()=>links.commitMetadata(pending.at(-1).request.requestId),remount:()=>{surface.dispose();bind();},destroy:()=>{surface.dispose();engine.dispose();}};
