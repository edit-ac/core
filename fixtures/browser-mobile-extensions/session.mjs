import { init } from '@edit-ac/core';
import { BrowserEditor } from '/web/editor.js';
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
 const seed=runtime.createEngine({profile:'v5',documentId:identity.documentId,epoch:identity.epoch,nodes:options.nodes??[{text:(options.embed||options.tableSource)?'':options.text}]});
 if(options.tableSource){
  const {initMarkdown}=await import('/markdown/index.js');
  const registration=seed.registerMarkdown(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));
  const parsed=seed.importMarkdown(options.tableSource,{tables:true});
  const at=seed.anchor(seed.read().visible[0].id,0,'right');
  try{const plan=seed.prepare({kind:'fragment',origin:'mobile-source-seed',range:{anchor:at,focus:at},blocks:parsed.blocks});try{seed.commit(plan);}finally{seed.releasePlan(plan);}}
  finally{seed.releaseAnchor(at);registration.dispose();}
  const represented=seed.read().visible.slice();
  const empty=n=>n.blockAttributes?.[0]==='paragraph'&&n.runs.every(r=>r.text==='');
  while(represented.length>parsed.blocks.length&&empty(represented[0]))represented.shift();
  while(represented.length>parsed.blocks.length&&empty(represented.at(-1)))represented.pop();
  if(represented.length!==parsed.blocks.length)throw Error('source binding count');
  window.mobileTableSource={source:options.tableSource,owners:represented.map(n=>n.id),opening:seed.checkpoint(),captures:0,disposals:0};
 }
 if(options.code){const plan=seed.prepare({kind:'editor',origin:'mobile-seed-code',commands:[{type:'setCode',owner:seed.read().visible[0].id,language:options.language??'typescript'}]});try{seed.commit(plan);}finally{seed.releasePlan(plan);}}
 if(options.table&&!options.tableSource){for(const tableNode of seed.read().visible.slice(0,options.tableCopies??1)){const owner=tableNode.id,at=seed.anchor(owner,0,'right');try{seed.commit(seed.prepare({kind:'fragment',origin:'mobile-seed-table',range:{anchor:at,focus:at},blocks:[{attributes:{type:'content',tuple:['module:editac.table',1,{alignments:['none','none','none','none'],rows:(options.tableRows??[['one','two','three','four'],['alpha','beta','gamma','delta']]).map(row=>row.map(t=>[[t,[]]])),source:'prepared table source'}]},runs:[{text:'prepared table source',marks:[]}]}]}));}finally{seed.releaseAnchor(at);}}}
 if(options.asset||options.embed){const owner=seed.read().visible[0].id,at=seed.anchor(owner,0,'right');const payload=options.asset??{type:options.inertType??'editac.embed',version:1,dataVersion:1,source:options.embed.source,payload:{url:options.embed.url,provider:options.embed.provider,fallback:options.embed.fallback}};try{const plan=seed.prepare({kind:'fragment',origin:'mobile-seed-host-content',range:{anchor:at,focus:at},blocks:[{attributes:{type:'content',tuple:[options.asset?'module:editac.asset':'module:editac.inert-extension',1,payload]},runs:[{text:options.asset?.fallback??options.embed.source,marks:[]}]}]});try{seed.commit(plan);}finally{seed.releasePlan(plan);}}finally{seed.releaseAnchor(at);}}
 let modules;
 if(options.marks){for(const mark of options.marks){const owner=seed.read().visible[mark.node??0].id;seed.commit(seed.prepare({kind:'editor',origin:'mobile-seed',commands:[{type:'markAt',owner,from:mark.from,to:mark.to,mark:mark.type,action:'apply'}]}));}}
 if(options.reorder){const first=seed.read().visible[0].id;seed.commit(seed.prepare({kind:'editor',origin:'mobile-seed',commands:[{type:'markAt',owner:first,from:0,to:5,mark:'bold',action:'apply'}]}));}
 if(options.mapping){const nodes=seed.read().visible,at=seed.anchor(nodes[4].id,4,'right');try{seed.commit(seed.prepare({kind:'editor',origin:'mobile-seed',commands:[{type:'hardBreak',at}]}));}finally{seed.releaseAnchor(at);}const a=seed.anchor(nodes[5].id,0,'right'),b=seed.anchor(nodes[5].id,4,'left');try{seed.commit(seed.prepare({kind:'fragment',origin:'mobile-seed',range:{anchor:a,focus:b},blocks:[{attributes:{type:'paragraph'},runs:[{text:'atom',marks:[],attributes:{'module:fixture.atom':[1,{label:'atom'}]}}]}]}));}finally{seed.releaseAnchor(a);seed.releaseAnchor(b);}const {ModuleRegistry}=await import('/web/modules/registry.js');modules=new ModuleRegistry();modules.register({type:'fixture.atom',version:1,kind:'inline-atom',attributes:{label:{type:'string',required:true,maxUtf16:8}},content:{type:'text',maxUtf16:8},fallback:{type:'text',source:'content'}},{tag:'span'});}
 if(options.unrelatedCode){for(const node of seed.read().visible.filter(n=>n.runs.some(r=>r.text.startsWith('unrelated ')))){const plan=seed.prepare({kind:'editor',origin:'mobile-seed-unrelated-code',commands:[{type:'setCode',owner:node.id,language:'typescript'}]});try{seed.commit(plan);}finally{seed.releasePlan(plan);}}}
 const store=await CheckpointStorage.open(indexedDB,databaseName);
 try{await store.publish(seed.checkpoint(),[]);}finally{store.close();seed.dispose();}
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 return bind(options,modules);
}
async function bind(options={},modules){
 disposed=false;patches=[];
 window.gestureCommands=[];
 if(options.gestureAudit){const commit=session.storage.commit.bind(session.storage);session.storage.commit=request=>{window.gestureCommands.push(structuredClone(request));return commit(request);};}
 session.writer.engine.history({type:'clear'});ids=session.writer.engine.read().visible.map(n=>n.id);
 subscription=session.writer.engine.subscribe({type:'all'},p=>patches.push({origin:p.origin,update:!!p.update,revision:p.revision}));
 let markdown,slash,content,codeCommands,reorder,references,search,codeHighlight;
 window.contentCounters={created:0,updates:[],disposed:0};
 window.highlightCounters={created:0,requests:[],terminated:0};
 if(options.searchAuthorization){const {documentSearch}=await import('/web/modules/search.js');search=documentSearch({authorize:()=>options.searchAuthorization!=='denied'});}
 if(options.referenceHost){
  const state=window.referenceHostState={mode:options.referenceHost,resolveCalls:0,catalogCalls:0,subscriptions:0,signals:[],requests:[],listeners:new Set()};
  const host={version:1,permission:()=>({revision:state.mode,lookup:state.mode!=='denied',insert:state.mode!=='denied-insert'&&state.mode!=='denied'}),
   catalog:targetId=>{state.catalogCalls++;return {targetId,status:state.mode==='unknown'?'missing':'local'};},
   resolve:async request=>{state.resolveCalls++;state.signals.push(request.signal);state.requests.push(request);if(state.mode==='rejected')throw Error('prepared reference host rejection');if(state.mode==='delayed')return new Promise(resolve=>{state.complete=resolve;});if(options.referenceCount)return Array.from({length:options.referenceCount},(_,i)=>({targetId:'ac://team-1/12345678-1234-4234-8234-'+String(i).padStart(12,'0'),label:'Prepared target '+i}));return [{targetId:'ac://team-1/12345678-1234-4234-8234-123456789abc',label:'Prepared local target'}];},
   subscribe(listener){state.subscriptions++;state.listeners.add(listener);return {dispose(){state.subscriptions--;state.listeners.delete(listener);}};}};
  const {referenceSuggestions}=await import('/web/modules/references.js');references=referenceSuggestions(host);
 }
 if(options.references){const {referenceSuggestions}=await import('/web/modules/references.js');references=referenceSuggestions(async()=>[{targetId:'ac://team-1/12345678-1234-4234-8234-123456789abc',label:'Mobile target'}]);}
 if(options.baselineModules){
  const {slashCommands}=await import('/web/modules/slash.js');
  slash=slashCommands([
   {id:'code',label:'Make code block',prepare:({node})=>({type:'editor',commands:[{type:'setCode',owner:node,language:'js'}]})},
   {id:'insert',label:'Insert mobile text',prepare:()=>({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'mobile',marks:[]}]}]})},
   {id:'delayed',label:'Delayed module action',prepare:({signal})=>new Promise(resolve=>{window.modulePending={signal,resolve};})},
   {id:'disabled',label:'Unavailable module action',disabled:'Unavailable in this document',prepare:()=>{throw Error('Disabled action must not run');}},
   ...Array.from({length:24},(_,i)=>({id:'extra'+i,label:'Extra command '+i,prepare:()=>undefined})),
  ]);
 }
 if((options.table||options.asset||options.embed)&&!options.presentersDisabled){
  const {contentModules}=await import('/web/modules/content.js');const contentOptions={};
  if(options.protectedCells)contentOptions.tableProtectedCells=()=>options.protectedCells;
  if(options.tableSource&&!options.sourcePortAbsent)contentOptions.tableSource={
   capture(owner){
    const t=window.mobileTableSource;
    const retained=editor.captureSourceBaseline(t.source,t.owners,{tables:true},t.opening);
    let current;try{current=retained.sourceWithCurrentTable(owner);}finally{retained.dispose();}
    const base=editor.captureSourceBaseline(current,t.owners,{tables:true});t.captures++;
    return {originalSource:base.originalSource,prepareTableFormat:(...args)=>base.prepareTableFormat(...args),sourceWithCurrentTable:id=>base.sourceWithCurrentTable(id),dispose(){base.dispose();t.disposals++;}};
   },
   commitPrepared:plan=>editor.commitPrepared(plan),
  };
  if(options.asset||options.embed){
   const state=window.contentHostState={calls:[],signals:[],canceled:[],mode:options.contentHost??'absent'};
   const record=(operation,request,signal)=>{state.calls.push({operation,request});state.signals.push(signal);if(state.mode==='rejected')throw Error('prepared host failure');};
   if(state.mode!=='absent'){
    if(options.asset?.kind==='image')contentOptions.imageAssets={async resolve(request,signal){record('resolve',request,signal);return {state:state.mode==='unknown'?'missing':'locked'};},cancel(request){state.canceled.push(request.operationId);}};
    if(options.asset?.kind==='file')contentOptions.attachments={async authorize(request,signal){record('authorize',request,signal);return {identity:request.identity,state:state.mode==='unknown'?'missing':'forbidden',actions:[]};},async execute(request,signal){record('execute',request,signal);throw Error('Denied asset must never execute');},cancel(request){state.canceled.push(request.operationId);}};
    if(options.embed)contentOptions.embeds={context:()=>({principal:'viewer',tenant:'fixture',authority:null,scope:{document:'document',session:'session',revision:'1',permission:'1',authorized:state.mode!=='denied'},policyRevision:'1',readonly:false,capabilities:{publicMetadata:state.mode!=='denied',privateLookup:false,title:true,icon:true,preview:true,activate:state.mode!=='denied',publishMetadata:false}}),templates:[{provider:'prepared-video',endpoint:'https://never-request.invalid/player'}],resolver:{async publicMetadata(request,signal){record('metadata',request,signal);return {status:state.mode==='unknown'?'missing':'forbidden'};}}};
   }
  }
  if(options.assetActions)Object.assign(contentOptions,window.mobileAssetOptions);
  const factory=contentModules(contentOptions);content=context=>{const view=factory(context);if(!view)return;window.contentCounters.created++;return {element:view.element,update(node){window.contentCounters.updates.push(node.id);return view.update(node);},setReadOnly(value){view.setReadOnly(value);},dispose(){window.contentCounters.disposed++;view.dispose();}};};
 }
 if(options.codeTools){const {codeCommands:factory}=await import('/web/extensions/code.js');codeCommands=context=>{selection=context.selection;return factory()(context);};}
 if(options.highlight){const {codeHighlighting}=await import('/web/modules/code/presenter.js');codeHighlight=codeHighlighting({enabled:options.highlight!=='disabled',createWorker(){window.highlightCounters.created++;return {onmessage:null,onerror:null,postMessage(message){window.highlightCounters.requests.push(message);queueMicrotask(()=>this.onmessage?.({data:{id:message.id,input:message.input,projection:{status:'highlighted',spans:[]},timing:{startup:0,transfer:0,work:0,application:0}}}));},terminate(){window.highlightCounters.terminated++;}};}});}
 if(options.reorder){const {reorderControls}=await import('/web/modules/reorder.js');reorder=context=>{selection=context.selection;return reorderControls()(context);};}
 if(options.triggers||options.palette||options.tableSource){const {initMarkdown}=await import('/markdown/index.js'),{markdownExtension}=await import('/markdown/web.js'),{slashCommands}=await import('/web/modules/slash.js');markdown=markdownExtension(await initMarkdown('/markdown/wasm/editac_markdown_wasm_bg.wasm'));if(options.triggers)slash=slashCommands([{id:'paragraph',label:'Insert mobile paragraph',prepare:()=>({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'mobile command',marks:[]}]}]})}]);}
 if(options.referenceDisplay){const {referenceDisplay}=await import('/fixture/reference-display.mjs');const reference=referenceDisplay(),other=content;content=context=>reference(context)??other?.(context);}
 const legacyOptions={assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,plainPasteControl:options.plainPasteControl??false,readOnly:options.readOnly,commandAllowed:name=>!options.deniedCommands?.includes(name),commandControls:options.commandControls,inputHints:options.inputHints,modules,markdown,slash,content,codeCommands,codeHighlight,reorder,references,search,contentCodecs:(options.palette||options.tableSource)?{images:true,tables:true,callouts:true}:undefined,viewport:options.viewport?{requestedMode:options.requestedMode,geometry:viewportGeometry}:undefined,recover:async()=>session};
 let editorOptions=legacyOptions;
 if(options.facade){
  const factories=await import('/web/extensions/configuration.js');
  const extensions=[];
  if(options.facade==='math')extensions.push(factories.MathNotation.configure());
  if(options.facade==='markdown')extensions.push(factories.Markdown.configure({input:false}));
  if(options.facade==='search')extensions.push(factories.DocumentSearch.configure());
  if(options.facade==='reorder')extensions.push(factories.BlockReorder.configure());
  if(options.facade==='images')extensions.push(factories.Images.configure());
  if(options.facade==='tables')extensions.push(factories.Tables.configure());
  if(options.facade==='references')extensions.push(factories.References.configure({host:async()=>[]}));
  if(options.facade==='slash')extensions.push(factories.SlashCommands.configure({commands:[{id:'code',label:'Make code block',prepare:({node})=>({type:'editor',commands:[{type:'setCode',owner:node,language:'js'}]})}]}));
  editorOptions={assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks,extensions,plainPasteControl:false,readOnly:options.readOnly,formatting:options.formatting,viewport:options.viewport?{geometry:viewportGeometry}:undefined,recover:async()=>session};
 }
 editor=new BrowserEditor(root,editorOptions);
 await editor.ready;window.editor=editor;select(ids[0],0);return ids;
}
function select(id,a,b=a,focusId=id){root.focus();const point=(id,offset)=>{const block=root.querySelector(`[data-node-id="${id}"]`),walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(offset<=node.length)return {node,offset};offset-=node.length;}return {node:block,offset:0};};const anchor=point(id,a),focus=point(focusId,b);getSelection().setBaseAndExtent(anchor.node,anchor.offset,focus.node,focus.offset);selection?.capture();}
async function settle(){await editor.settle();await session.storage.flush({target:'local'});await editor.settle();}
async function remote(index,offset,text){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector(),at=peer.anchor(ids[index],offset,'right');try{const result=peer.commit(peer.prepare({kind:'text',origin:'mobile-peer',command:{type:'insert',at,text}}));if(result.caret)peer.releaseAnchor(result.caret);local.applyUpdate(peer.encodeUpdate(vector));await settle();}finally{peer.releaseAnchor(at);peer.dispose();}}
async function retireContent(){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector(),node=peer.read().visible.find(n=>['module:editac.asset','module:editac.inert-extension'].includes(n.blockAttributes?.[0])),at=peer.anchor(node.id,0,'right');try{const plan=peer.prepare({kind:'editor',origin:'mobile-peer-retire-content',commands:[{type:'atomicContent',owner:node.id,expected:node.blockAttributes,at,replacement:null}]});try{peer.commit(plan);}finally{peer.releasePlan(plan);}local.applyUpdate(peer.encodeUpdate(vector));await settle();}finally{peer.releaseAnchor(at);peer.dispose();}}
async function remoteJoin(first,second){const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector();try{const plan=peer.prepare({kind:'editor',origin:'mobile-peer-delete-owner',commands:[{type:'join',first:ids[first],second:ids[second]}]});try{const result=peer.commit(plan);if(result.caret)peer.releaseAnchor(result.caret);}finally{peer.releasePlan(plan);}local.applyUpdate(peer.encodeUpdate(vector));await settle();}finally{peer.dispose();}}
function point(node,offset){const el=node?.nodeType===1?node:node?.parentElement,block=el?.closest('[data-node-id]');if(!block)return null;const r=document.createRange();r.selectNodeContents(block);r.setEnd(node,offset);return {node:block.dataset.nodeId,offset:r.toString().length};}
async function state(){await settle();const native=getSelection(),engine=session.writer.engine,journal=await UpdateJournal.open(indexedDB,databaseName);let entries;try{entries=await journal.read(identity);}finally{journal.close();}return {nodes:engine.read().visible,selection:{anchor:point(native.anchorNode,native.anchorOffset),focus:point(native.focusNode,native.focusOffset)},history:engine.history({type:'state'}),patches,journal:entries.map(e=>({origin:e.origin,bytes:e.bytes.length})),storage:session.storage.state.phase,errors:engine.takeObserverErrors(),focus:document.activeElement===root,dom:root.textContent,revision:engine.read().revision,recovery:editor.inputRecovery};}
async function destroy(policy='flush'){if(disposed)return;disposed=true;subscription?.dispose();const report=await editor?.destroy({policy});window.fixtureDisposed=true;return report;}
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
async function recover(){
 runtime=await init('/core/wasm/editac_wasm_bg.wasm');
 session=await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity,indexedDB,locks:navigator.locks});
 return bind(window.mobileTableSource?{table:true,tableSource:window.mobileTableSource.source}:{});
}
async function remoteStructure(index,wrap=false){
 const local=session.writer.engine,peer=runtime.restoreEngine(identity,local.checkpoint()),vector=local.stateVector();
 try{const nodes=peer.read().visible,node=nodes.find(n=>n.id===ids[index]);
  const commands=wrap?[{type:'wrap',targets:[node.id],style:{type:'quote'}}]:[{type:'move',target:{id:node.id,version:node.editor.version},parent:{id:'@root',version:'base'},before:{id:ids[0],version:nodes.find(n=>n.id===ids[0]).editor.version}}];
  const plan=peer.prepare({kind:'editor',origin:'mobile-peer-structure',commands});try{const result=peer.commit(plan);if(result.caret)peer.releaseAnchor(result.caret);}finally{peer.releasePlan(plan);}
  local.applyUpdate(peer.encodeUpdate(vector));await settle();
 }finally{peer.dispose();}
}
window.inputFixture={retireContent,remoteStructure,remoteJoin,recover,sibling,deliver,mutate,mount,select,settle,state,destroy,host,capability,requestCapability,get storage(){return session?.storage},get engine(){return session?.writer.engine},get root(){return root},get ids(){return ids},remote,get selection(){return selection},get pointer(){return editor.reorder?.pointerState},get surface(){return editor}};
