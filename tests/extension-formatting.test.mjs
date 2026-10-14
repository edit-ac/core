import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareTutorial } from '../scripts/prepare-extension-tutorial.mjs';
import { sha256 } from '../scripts/extension-bundles.mjs';
import { presenterHost } from './helpers/extension-presenter-host.mjs';
let ClipboardInput, FRAGMENT_MIME, middleware;
const output=resolve(process.env.EDITAC_EXTENSION_FORMATTING_OUTPUT??'../architecture/evidence/extension-formatting');
const corpus=JSON.parse(await readFile('fixtures/extensions/clipboard/conformance.json'));
const facts={gate:'EXT-1.13',qualification:'portable-contract-partial; admitted table v2 qualified, ordinary bounded inert carrier qualified; platform receipts remain downstream',sourceRevision:'ee774e02a4e2fb78208a106b8f5028b07e2a1788f8e6f937759fe5c3c73b4d4e',loadedPrompt:'2e18a98412c7',node:process.version,checks:[],sourceHashes:{},artifactHashes:{},pending:corpus.pending};
let directory,api,runtime,markdown,registry,seed,count=0;
const packed = relative => import(pathToFileURL(join(directory,'node_modules/@edit-ac',relative)));
before(async()=>{
 await mkdir(output,{recursive:true});directory=await mkdtemp(join(tmpdir(),'editac-extension-formatting-'));
 const manifest=await prepareTutorial(directory);
 facts.packing=manifest.commands;
 await writeFile(join(directory,'public-transfer.mjs'),"export * from '@edit-ac/web/modules'; export {init} from '@edit-ac/core'; export {ExtensionTransferRegistry as PortableTransferRegistry} from '@edit-ac/core/extensions'; export {initMarkdown} from '@edit-ac/markdown';\n");
 ({ClipboardInput,FRAGMENT_MIME}=await packed('web/dist/clipboard/fragment.js'));
 middleware={...(await packed('web/dist/lifecycle.js')),...(await packed('web/dist/storage/writer.js')),...(await packed('web/dist/storage/journal.js')),...(await packed('web/dist/storage/index.js'))};
 for(const name of ['web/dist/lifecycle.js','web/dist/storage/writer.js','web/dist/storage/journal.js','web/dist/storage/index.js','web/dist/clipboard/fragment.js','core/dist/extensions/transfer.js','web/dist/modules/presenters.js']){
  const artifact='packed-artifacts/'+name;await mkdir(join(output,artifact,'..'),{recursive:true});await copyFile(join(directory,'node_modules/@edit-ac',name),join(output,artifact));facts.artifactHashes[artifact]=sha256(await readFile(join(output,artifact)));
 }
 await copyFile(join(directory,'qualification/consumer.json'),join(output,'packed-consumer.json'));facts.artifactHashes['packed-consumer.json']=sha256(await readFile(join(output,'packed-consumer.json')));
 api=await import(pathToFileURL(join(directory,'public-transfer.mjs')));assert.equal(api.ExtensionTransferRegistry,api.PortableTransferRegistry,'one public owning registry');
 const wasm=await readFile(join(directory,'engine.wasm'));runtime=await api.init('data:application/wasm;base64,'+wasm.toString('base64'));
 markdown=await api.initMarkdown('data:application/wasm;base64,'+(await readFile(join(directory,'markdown.wasm'))).toString('base64'));
 assert.equal(sha256(wasm),sha256(await readFile('packages/core/dist/wasm/editac_wasm_bg.wasm')),'packed rebuilt production engine');
 for(const pack of manifest.packs){await copyFile(join(directory,'qualification',pack.filename),join(output,pack.filename));facts.artifactHashes[pack.filename]=pack.sha256;}
 facts.artifactHashes['engine.wasm']=sha256(wasm);facts.artifactHashes['markdown.wasm']=sha256(await readFile(join(directory,'markdown.wasm')));
 for(const name of ['engine.wasm','markdown.wasm','public-transfer.mjs'])await copyFile(join(directory,name),join(output,name));
 facts.artifactHashes['public-transfer.mjs']=sha256(await readFile(join(output,'public-transfer.mjs')));
 registry=new api.ExtensionTransferRegistry(corpus.descriptors.map(descriptor=>({descriptor,...(!['editac.disabled-image','editac.rich-table'].includes(descriptor.type)?{codec:{prepare:e=>e.payload}}:{})})));
 const e=blank();seed=e.checkpoint();e.dispose();
 for(const path of ['packages/core/src/extensions/transfer.ts','packages/core/src/extensions/index.ts','packages/web/src/modules/index.ts','packages/web/src/modules/presenters.ts','fixtures/extensions/clipboard/conformance.json','tests/extension-formatting.test.mjs','tests/helpers/extension-presenter-host.mjs','tests/helpers/journal-storage.mjs','scripts/prepare-extension-tutorial.mjs','docs/extensions/transfer.md','crates/editac-core/src/commands/editor.rs','crates/editac-core/src/modules/content.rs','crates/editac-core/src/modules/rich_table.rs','crates/editac-core/src/modules/inert_content.rs','packages/web/src/clipboard/fragment.ts'])facts.sourceHashes[path]=sha256(await readFile(path));
});
after(async()=>{try{await writeFile(join(output,'receipt.json'),JSON.stringify(facts,null,2)+'\n');}finally{if(directory)await rm(directory,{recursive:true,force:true});}});
function blank(){const suffix=String(++count).padStart(12,'0');const engine=runtime.createEngine({profile:'v5',documentId:`81000000-0000-4000-8000-${suffix}`,epoch:`82000000-0000-4000-8000-${suffix}`,nodes:[{text:''}]});engine.registerMarkdown(markdown);return engine;}
const text=e=>e.read().visible.filter(n=>n.kind==='block').flatMap(n=>n.runs.map(r=>r.text)).join('');
const semantic=e=>e.read().visible.filter(n=>n.kind==='block'&&!(n.blockAttributes?.[0]==='paragraph'&&n.runs.every(r=>r.text===''))).map(n=>({blockAttributes:n.blockAttributes,runs:n.runs,editor:n.editor?{containerAttributes:n.editor.containerAttributes,checked:n.editor.checked,number:n.editor.number}:null}));
function range(e,from=0,to=0){const node=e.read().visible.find(n=>n.kind==='block');const a=e.anchor(node.id,from,'right'),b=e.anchor(node.id,to,'left');return {value:{anchor:a,focus:b},close(){e.releaseAnchor(a);e.releaseAnchor(b);}};}
function release(e,result){if(result?.caret)e.releaseAnchor(result.caret);if(result?.selection){e.releaseAnchor(result.selection.anchor);e.releaseAnchor(result.selection.focus);}}
async function harness(host='browser'){
 const h=await presenterHost(runtime,seed,api,{middleware});h.engine.registerMarkdown(markdown);return {...h,...view(h,host),async close(){this.session.dispose();await h.close();}};
}
function view(h,host='browser'){
 const node=h.engine.read().visible[0];const trace=[];
 const adapter={host,update:x=>trace.push(x),focus(){},input(){},accessibility:()=>({label:'transfer',actions:[],readOnly:false}),representation:mime=>({mime,text:'',fallback:true}),cancel(){},dispose(){}};
 const snapshot=()=>({version:1,nodeId:node.id,sourceId:node.spans[0].source,content:{type:'transfer.fixture',version:1,kind:'mark',text:text(h.engine),attributes:{}},selection:null,readOnly:h.state.state.readOnly,theme:'fixture',capabilities:api.PRESENTER_CAPABILITIES[host]});
 const session=new api.ExtensionPresenterSession(h.modules,adapter,snapshot,h.host,{range:{source:node.spans[0].source,start:0,end:1_048_576},selection:true});
 return {session,trace};
}
function copied(e){const nodes=e.read().visible.filter(n=>n.kind==='block');
 const a=e.anchor(nodes[0].id,0,'right'),b=e.anchor(nodes.at(-1).id,nodes.at(-1).runs.reduce((n,r)=>n+r.text.length,0),'left');let released=0;
 const clipboard=new ClipboardInput({}, {retain:()=>({range:{anchor:a,focus:b},dispose(){released++;e.releaseAnchor(a);e.releaseAnchor(b);}})},e,()=>{throw Error('copy must not mutate');},()=>false);
 const values=new Map();try{assert.equal(clipboard.copy({getData:m=>values.get(m)??'',setData:(m,v)=>values.set(m,v)}).disposition,'handled');assert.equal(released,1);assert(values.has(FRAGMENT_MIME),clipboard.diagnostics.join(','));return JSON.parse(values.get(FRAGMENT_MIME));}finally{clipboard.dispose();}
}
for(const fixture of corpus.cases)test('bounded export/import and atomic semantic transfer: '+fixture.id,async()=>{
 const h=await harness(),r=range(h.engine);try{
  const encoded=api.exportExtensionTransfer(fixture.envelope),offer=api.importExtensionTransfer(encoded);assert.deepEqual(JSON.parse(encoded),fixture.envelope);
  const before=h.engine.checkpoint(),prepared=registry.prepare(h.engine,offer);assert.equal(prepared.mode,fixture.mode);assert(Object.isFrozen(prepared.recovery.payload));assert.deepEqual(h.engine.checkpoint(),before);
  assert.deepEqual(JSON.parse(api.exportExtensionTransfer(prepared.recovery)),fixture.envelope);
  if(fixture.mode==='fallback'){assert(prepared.diagnostics.length);assert.equal(prepared.blocks[0].runs[0].text,fixture.envelope.source);assert.deepEqual(JSON.parse(JSON.stringify(prepared.blocks[0].attributes.tuple)),['module:editac.inert-extension',1,fixture.envelope]);}
  const result=await h.session.transfer(prepared,h.engine,r.value);assert.equal(result.status,'committed');release(h.engine,result.result);await h.settle();assert.equal(h.commits(),1);assert.equal(h.engine.history({type:'state'}).undoGroups,1);
  const saved=semantic(h.engine),fragment=copied(h.engine);assert(fragment.blocks.length>0);
  if(fixture.mode==='fallback'){assert.deepEqual(saved[0].blockAttributes,['module:editac.inert-extension',1,fixture.envelope]);assert.deepEqual(fragment.blocks.find(b=>b.attributes?.type==='content').attributes.tuple,saved[0].blockAttributes);const exported=h.engine.exportMarkdown(fragment.blocks);assert(exported.diagnostics.some(d=>d.code==='inert-extension-source-fallback'));assert.deepEqual(exported.recovery,fragment.blocks);}
  if(fixture.id==='table-v2-mixed-cell'){assert.deepEqual(saved[0].blockAttributes,fixture.envelope.payload[0].attributes.tuple);assert.deepEqual(fragment.blocks.find(b=>b.attributes?.type==='content').attributes.tuple,fixture.envelope.payload[0].attributes.tuple);}
  await writeFile(join(output,fixture.id+'-recovery.json'),encoded);facts.artifactHashes[fixture.id+'-recovery.json']=sha256(await readFile(join(output,fixture.id+'-recovery.json')));
  assert.deepEqual(JSON.parse(api.exportExtensionTransfer(api.importExtensionTransfer(await readFile(join(output,fixture.id+'-recovery.json'),'utf8')))),fixture.envelope);
  const checkpoint=h.storage.recoveryExport().checkpoint;assert.equal(h.storage.state.pending,0);assert.equal(h.storage.state.saved,true);
  const other=blank(),otherRange=range(other);try{const plan=other.prepare({kind:'fragment',origin:'fixture:copy',range:otherRange.value,blocks:fragment.blocks});const result=other.commit(plan);release(other,result);assert.deepEqual(semantic(other),saved);}finally{otherRange.close();other.dispose();}
  h.engine.history({type:'undo'});assert.equal(text(h.engine),'');h.engine.history({type:'redo'});assert.deepEqual(semantic(h.engine),saved);
  const restored=runtime.restoreEngine(checkpoint.identity,checkpoint);try{assert.deepEqual(semantic(restored),saved);}finally{restored.dispose();}
  facts.checks.push({id:fixture.id,mode:prepared.mode,diagnostics:prepared.diagnostics,semanticHash:sha256(JSON.stringify(saved)),recoveryHash:sha256(encoded)});
 }finally{r.close();await h.close();}
});
for(const host of ['browser','terminal','swift-ios','kotlin-android','desktop'])for(const fixture of [corpus.cases[3],corpus.cases.find(f=>f.id==='table-v2-mixed-cell'),corpus.cases.find(f=>f.id==='future-atom')])for(const literal of [false,true])test('shared presenter policy '+host+' '+fixture.id+' '+(literal?'literal':'formatted'),async()=>{
 const h=await harness(host),r=range(h.engine);try{const prepared=registry.prepare(h.engine,fixture.envelope,literal);const result=await h.session.transfer(prepared,h.engine,r.value);assert.equal(result.status,'committed');release(h.engine,result.result);assert.equal(prepared.mode,literal?'literal':fixture.mode);if(literal)assert.equal(text(h.engine),fixture.envelope.source);assert.equal(h.commits(),1);await h.settle();facts.checks.push({id:host+'-'+prepared.mode});}finally{r.close();await h.close();}
});
test('cut deletes only after acknowledged transfer; failed/refused/canceled offers preserve state',async()=>{
 for(const disposition of ['refused','throw','cancel','accepted']){const h=await harness(),r=range(h.engine);try{
  const first=registry.prepare(h.engine,corpus.cases[3].envelope,true),paste=await h.session.transfer(first,h.engine,r.value);release(h.engine,paste.result);await h.settle();r.close();
  const selection=range(h.engine,0,text(h.engine).length),prepared=registry.prepare(h.engine,corpus.cases[3].envelope),before=h.engine.checkpoint(),undo=h.engine.history({type:'state'}).undoGroups;
  try{const result=await h.session.cut(prepared,h.engine,selection.value,async offer=>{assert.deepEqual(JSON.parse(api.exportExtensionTransfer(offer)),corpus.cases[3].envelope);if(disposition==='throw')throw Error('prepared clipboard write');if(disposition==='cancel')h.session.cancel();return disposition==='accepted'||disposition==='cancel';});
   if(disposition==='accepted'){assert.equal(result.status,'committed');release(h.engine,result.result);assert.equal(text(h.engine),'');assert.equal(h.engine.history({type:'state'}).undoGroups,undo+1);h.engine.history({type:'undo'});assert.equal(text(h.engine),corpus.cases[3].envelope.source);}else{assert.notEqual(result.status,'committed');assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.engine.history({type:'state'}).undoGroups,undo);}
  }finally{selection.close();}
 }finally{await h.close();}}
 facts.checks.push({id:'cut-acknowledgment'});
});
test('two-view/native prepared ownership, source disposal, wrong-document and stale rejection',async()=>{
 const source=blank(),target=await harness(),r=range(target.engine);try{
  const offer=api.importExtensionTransfer(api.exportExtensionTransfer(corpus.cases[0].envelope));source.dispose();const prepared=registry.prepare(target.engine,offer);
  const unrelated=blank(),u=range(unrelated);try{assert.throws(()=>api.extensionTransferRequest(prepared,unrelated,u.value,'wrong'),e=>e.code==='stale-target');}finally{u.close();unrelated.dispose();}
  const otherWriter=await harness();try{assert.deepEqual(otherWriter.engine.read().identity,target.engine.read().identity);assert.throws(()=>api.extensionTransferRequest(prepared,otherWriter.engine,r.value,'wrong-writer'),e=>e.code==='stale-target');}finally{await otherWriter.close();}
  const second=view(target,'desktop');try{
   const result=await second.session.transfer(prepared,target.engine,r.value);assert.equal(result.status,'committed');release(target.engine,result.result);await target.settle();assert.equal(target.commits(),1);
   const before=target.engine.checkpoint();assert.equal((await target.session.transfer(prepared,target.engine,r.value)).status,'failed');assert.deepEqual(target.engine.checkpoint(),before);
   second.session.dispose();assert.equal(target.session.active,true);assert.equal(second.session.active,false);
  }finally{second.session.dispose();}
  facts.checks.push({id:'two-view-native-ownership',qualification:'prepared contract, no OS clipboard'});
 }finally{r.close();await target.close();}
});
test('read-only, composition and delayed stale completion cannot mutate',async()=>{
 for(const mode of ['readOnly','composition','disposed','stale']){const h=await harness(),r=range(h.engine);try{
  const prepared=registry.prepare(h.engine,corpus.cases[3].envelope);const before=h.engine.checkpoint();
  if(mode==='readOnly')h.state.update({readOnly:true});if(mode==='composition')h.session.input({type:'composition-start',text:'仮'});
  if(mode==='disposed')h.session.dispose();
  if(mode==='stale'){
   let resolveWrite;const pending=h.session.cut(prepared,h.engine,r.value,()=>new Promise(resolve=>{resolveWrite=resolve;}));
   await new Promise(resolve=>setImmediate(resolve));h.session.cancel();resolveWrite(true);assert.notEqual((await pending).status,'committed');
  }else assert.notEqual((await h.session.transfer(prepared,h.engine,r.value)).status,'committed');
  assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.commits(),0);
 }finally{r.close();await h.close();}}
 facts.checks.push({id:'capability-lifetime'});
});
test('resource/version, executable data, malformed and failed codecs reject before any mutation',()=>{
 const e=blank(),before=e.checkpoint(),offer=corpus.cases[0].envelope;try{
  for(const raw of ['{',JSON.stringify({...offer,version:2}),'x'.repeat(1_048_577)])assert.throws(()=>api.importExtensionTransfer(raw));
  let calls=0;const payload={};Object.defineProperty(payload,'execute',{enumerable:true,get(){calls++;return 'bad';}});
  assert.throws(()=>registry.prepare(e,{...offer,payload}));assert.equal(calls,0);
  assert.throws(()=>registry.prepare(e,{...offer,payload:{execute(){calls++;}}}));assert.equal(calls,0);
  let deep={};for(let i=0;i<18;i++)deep={deep};assert.throws(()=>registry.prepare(e,{...offer,payload:deep}));
  assert.throws(()=>new api.ExtensionTransferRegistry([{descriptor:corpus.descriptors[0]},{descriptor:corpus.descriptors[0]}]),e=>e.code==='duplicate');
  for(const prepare of [()=>{throw Error('codec failed');},()=>[{attributes:{type:'content',tuple:['module:editac.table',1,{rows:[],alignments:[],source:'unsafe'}]},runs:[]}],()=>[{attributes:{type:'paragraph'},runs:[{text:'x',marks:[{mark:'execute'}]}]}]]){
   const unsafe=new api.ExtensionTransferRegistry([{descriptor:corpus.descriptors[0],codec:{prepare}}]);
   const r=range(e);try{let prepared;try{prepared=unsafe.prepare(e,offer);}catch(error){assert(error instanceof api.ExtensionTransferError);}
    if(prepared)assert.equal(e.can(api.extensionTransferRequest(prepared,e,r.value,'invalid-codec')),false,'owning engine rejects unsupported semantic data before mutation');
   }finally{r.close();}
  }
  const throwing=new api.ExtensionTransferRegistry([{descriptor:corpus.descriptors[0],codec:{prepare(){calls++;throw Error('never literal');}}}]);assert.equal(throwing.prepare(e,offer,true).mode,'literal');assert.equal(calls,0);
  assert.deepEqual(e.checkpoint(),before);facts.checks.push({id:'bounded-rejection'});
 }finally{e.dispose();}
});
test('partial marked selection copies through the owning clipboard without altering neighbors',async()=>{
 const h=await harness(),r=range(h.engine);try{
  const offer={version:1,type:'editac.text',dataVersion:1,source:'left é😀 right',payload:[{attributes:{type:'heading',level:2},runs:[{text:'left ',marks:[]},{text:'é😀',marks:[{mark:'bold'},{mark:'link',href:'https://example.invalid/'}]},{text:' right',marks:[]}]}]};
  const prepared=registry.prepare(h.engine,offer),result=await h.session.transfer(prepared,h.engine,r.value);release(h.engine,result.result);await h.settle();
  const before=h.engine.checkpoint(),selected=range(h.engine,5,8),values=new Map();let released=0;
  const clipboard=new ClipboardInput({}, {retain:()=>({range:selected.value,dispose(){released++;}})},h.engine,()=>{throw Error('copy mutation');},()=>false);
  try{assert.equal(clipboard.copy({getData:m=>values.get(m)??'',setData:(m,v)=>values.set(m,v)}).disposition,'handled');assert.equal(released,1);const fragment=JSON.parse(values.get(FRAGMENT_MIME));assert.equal(values.get('text/plain'),'é😀');assert.deepEqual(fragment.blocks[0].runs,[{text:'é😀',marks:[{mark:'bold'},{mark:'link',href:'https://example.invalid/'}]}]);assert.deepEqual(h.engine.checkpoint(),before);}finally{clipboard.dispose();selected.close();}
  facts.checks.push({id:'partial-selection'});
 }finally{r.close();await h.close();}
});
test('structured table/image/reference transfer cuts and restores one semantic history group',async()=>{
 for(const fixture of corpus.cases.filter(f=>['table-v2-mixed-cell',...corpus.cases.filter(f=>f.mode==='fallback').map(f=>f.id),...corpus.cases.slice(0,3).map(f=>f.id)].includes(f.id))){
  const h=await harness(),r=range(h.engine);try{
   const inserted=await h.session.transfer(registry.prepare(h.engine,fixture.envelope),h.engine,r.value);assert.equal(inserted.status,'committed');release(h.engine,inserted.result);await h.settle();
   const before=semantic(h.engine),nodes=h.engine.read().visible.filter(n=>n.kind==='block'),selection={anchor:h.engine.anchor(nodes[0].id,0,'right'),focus:h.engine.anchor(nodes.at(-1).id,nodes.at(-1).runs.reduce((n,run)=>n+run.text.length,0),'left')};
   try{const prepared=registry.prepare(h.engine,fixture.envelope),result=await h.session.cut(prepared,h.engine,selection,async offer=>{assert.deepEqual(JSON.parse(api.exportExtensionTransfer(offer)),fixture.envelope);return true;});assert.equal(result.status,'committed');release(h.engine,result.result);await h.settle();assert.deepEqual(semantic(h.engine),[]);assert.equal(h.engine.history({type:'state'}).undoGroups,2);h.engine.history({type:'undo'});assert.deepEqual(semantic(h.engine),before);h.engine.history({type:'redo'});assert.deepEqual(semantic(h.engine),[]);await h.settle();assert.equal(h.storage.state.pending,0);assert.equal(h.storage.state.saved,true);const checkpoint=h.storage.recoveryExport().checkpoint,reopened=runtime.restoreEngine(checkpoint.identity,checkpoint,[]);try{assert.deepEqual(semantic(reopened),[]);}finally{reopened.dispose();}}finally{h.engine.releaseAnchor(selection.anchor);h.engine.releaseAnchor(selection.focus);}
  }finally{r.close();await h.close();}
 }
 facts.checks.push({id:'structured-cut-history'});
});
test('mixed structured cut preserves unselected formatted text and restores exact tuples on undo/redo',async()=>{
 for(const fixture of corpus.cases.filter(f=>['table-v2-mixed-cell',...corpus.cases.filter(f=>f.mode==='fallback').map(f=>f.id),...corpus.cases.slice(0,3).map(f=>f.id)].includes(f.id))){
  const h=await harness(),r=range(h.engine);try{
   const payload=[{attributes:{type:'heading',level:2},runs:[{text:'prefixDROP',marks:[{mark:'bold'}]}]},...JSON.parse(JSON.stringify(registry.prepare(h.engine,fixture.envelope).blocks)),{attributes:{type:'paragraph'},runs:[{text:'DROPtail😀',marks:[{mark:'link',href:'https://example.invalid/tail'}]}]}];
   const inserted=h.host.commit({kind:'fragment',origin:'mixed:transfer',range:r.value,blocks:payload});release(h.engine,inserted);await h.settle();
   const before=semantic(h.engine),nodes=h.engine.read().visible.filter(n=>n.kind==='block'),selection={anchor:h.engine.anchor(nodes[0].id,6,'right'),focus:h.engine.anchor(nodes.at(-1).id,4,'left')};
   try{
    let writes=0;const result=await h.session.cut(registry.prepare(h.engine,fixture.envelope),h.engine,selection,async()=>{writes++;return true;});assert.equal(result.status,'committed');assert.equal(writes,1);release(h.engine,result.result);await h.settle();
    assert.equal(text(h.engine),'prefixtail😀');const after=semantic(h.engine);assert.deepEqual(after[0].blockAttributes,['heading',2]);assert.equal(after[0].runs[0].attributes.bold,true);assert.equal(after[0].runs.at(-1).attributes.link,'https://example.invalid/tail');assert.equal(h.engine.history({type:'state'}).undoGroups,2);
    h.engine.history({type:'undo'});assert.deepEqual(semantic(h.engine),before);h.engine.history({type:'redo'});assert.deepEqual(semantic(h.engine),after);await h.settle();
    assert.equal(h.storage.state.pending,0);assert.equal(h.storage.state.saved,true);const checkpoint=h.storage.recoveryExport().checkpoint,reopened=runtime.restoreEngine(checkpoint.identity,checkpoint,[]);try{assert.deepEqual(semantic(reopened),after);}finally{reopened.dispose();}
   }finally{h.engine.releaseAnchor(selection.anchor);h.engine.releaseAnchor(selection.focus);}
  }finally{r.close();await h.close();}
 }
 facts.checks.push({id:'mixed-structured-cut-history-reopen'});
});
test('partial reference and collapsed empty atom cuts reject before clipboard write',async()=>{
 for(const index of [0,2]){
  const fixture=corpus.cases[index],h=await harness(),r=range(h.engine);try{
   const inserted=await h.session.transfer(registry.prepare(h.engine,fixture.envelope),h.engine,r.value);assert.equal(inserted.status,'committed');release(h.engine,inserted.result);await h.settle();
   const node=h.engine.read().visible.find(n=>n.blockAttributes?.[0].startsWith('module:')),selection={anchor:h.engine.anchor(node.id,index===2?1:0,'right'),focus:h.engine.anchor(node.id,index===2?4:0,'left')};
   try{let writes=0;const before=h.engine.checkpoint(),commits=h.commits(),history=h.engine.history({type:'state'});const result=await h.session.cut(registry.prepare(h.engine,fixture.envelope),h.engine,selection,async()=>{writes++;return true;});assert.notEqual(result.status,'committed');assert.equal(writes,0);assert.equal(h.commits(),commits);assert.deepEqual(h.engine.checkpoint(),before);assert.deepEqual(h.engine.history({type:'state'}),history);}finally{h.engine.releaseAnchor(selection.anchor);h.engine.releaseAnchor(selection.focus);}
  }finally{r.close();await h.close();}
 }
 facts.checks.push({id:'partial-atom-cut-atomicity'});
});
test('plain transfer retains destination paragraph style and inline formatting',async()=>{
 const h=await harness(),r=range(h.engine);try{
  const first=registry.prepare(h.engine,{version:1,type:'editac.text',dataVersion:1,source:'abc',payload:[{attributes:{type:'heading',level:3},runs:[{text:'abc',marks:[{mark:'bold'}]}]}]}),initial=await h.session.transfer(first,h.engine,r.value);release(h.engine,initial.result);await h.settle();
  const selected=range(h.engine,1,2);try{const plain=registry.prepare(h.engine,{version:1,type:'editac.text',dataVersion:1,source:'*literal*',payload:{ignored:true}},true),result=await h.session.transfer(plain,h.engine,selected.value);assert.equal(result.status,'committed');release(h.engine,result.result);await h.settle();const block=h.engine.read().visible.find(n=>n.kind==='block');assert.deepEqual(block.blockAttributes,['heading',3]);assert.equal(text(h.engine),'a*literal*c');assert(block.runs.every(run=>run.attributes.bold===true));h.engine.history({type:'undo'});assert.equal(text(h.engine),'abc');}finally{selected.close();}
  facts.checks.push({id:'literal-destination-style'});
 }finally{r.close();await h.close();}
});
test('cut admits current capabilities before clipboard writes and rechecks delayed revocation',async()=>{
 for(const mode of ['readOnly','wrongEngine','revoked','remoteEdit','disposed']){
  const h=await harness(),r=range(h.engine),other=blank();let calls=0;try{
   const prepared=registry.prepare(h.engine,corpus.cases[3].envelope),before=h.engine.checkpoint();
   if(mode==='readOnly')h.state.update({readOnly:true});
   const result=await h.session.cut(prepared,mode==='wrongEngine'?other:h.engine,r.value,async()=>{calls++;if(mode==='revoked')h.state.update({readOnly:true});if(mode==='disposed')h.session.dispose();if(mode==='remoteEdit'){const plan=h.engine.prepare(h.request('remote',0,0));release(h.engine,h.engine.commit(plan));}return true;});
   assert.notEqual(result.status,'committed');assert.equal(calls,['readOnly','wrongEngine'].includes(mode)?0:1);assert.equal(h.commits(),0);
   if(mode==='remoteEdit')assert.equal(text(h.engine),'remote');else assert.deepEqual(h.engine.checkpoint(),before);
  }finally{r.close();other.dispose();await h.close();}
 }
 facts.checks.push({id:'cut-capability-admission'});
});
test('declared old/new transfer versions use pure candidates; unknown versions bypass codecs',()=>{
 const e=blank(),before=e.checkpoint();let calls=0;try{
  const versions=new api.ExtensionTransferRegistry([{descriptor:{...corpus.descriptors[3],versions:[1,2]},codec:{prepare(offer){calls++;return [{attributes:{type:'paragraph'},runs:[{text:offer.dataVersion===1?offer.payload.old:offer.payload.current,marks:[]}]}];}}}]);
  const offer={version:1,type:'editac.text',dataVersion:1,source:'v1 source',payload:{old:'same'}};
  assert.deepEqual(versions.prepare(e,offer).blocks,versions.prepare(e,{...offer,dataVersion:2,payload:{current:'same'}}).blocks);
  const unsupported=versions.prepare(e,{...offer,dataVersion:3,payload:{unknown:'exact'}});assert.equal(unsupported.mode,'fallback');assert.equal(unsupported.recovery.payload.unknown,'exact');assert.equal(calls,2);assert.deepEqual(e.checkpoint(),before);
  facts.checks.push({id:'transfer-versions'});
 }finally{e.dispose();}
});
test('data bounds and registry snapshots reject malformed declarations without invoking getters',()=>{
 const e=blank(),before=e.checkpoint(),offer=corpus.cases[3].envelope;try{
  const cycle={};cycle.self=cycle;
  for(const payload of [cycle,new Date(),Array(2),{['x'.repeat(1_048_577)]:true},Array(65537).fill(null)])assert.throws(()=>registry.prepare(e,{...offer,payload}),error=>error instanceof api.ExtensionTransferError);
  for(const descriptor of [null,{}, {...corpus.descriptors[3],inline:['bold','bold']},{...corpus.descriptors[3],versions:[0]}])assert.throws(()=>new api.ExtensionTransferRegistry([{descriptor}]),error=>error instanceof api.ExtensionTransferError);
  const descriptor=structuredClone(corpus.descriptors[3]);let captures=0;
  const codec={get prepare(){captures++;return ()=>[{attributes:{type:'paragraph'},runs:[{text:'captured',marks:[]}]}];}};
  const snapshot=new api.ExtensionTransferRegistry([{descriptor,codec}]);descriptor.inline.length=0;descriptor.versions.length=0;
  assert.equal(snapshot.prepare(e,offer).blocks[0].runs[0].text,'captured');assert.equal(captures,1);assert(Object.isFrozen(snapshot.descriptors()[0].inline));
  const malformed=new api.ExtensionTransferRegistry([{descriptor:corpus.descriptors[3],codec:{prepare:()=>[null]}}]);assert.throws(()=>malformed.prepare(e,offer),error=>error.code==='invalid-data');
  assert.deepEqual(e.checkpoint(),before);facts.checks.push({id:'registry-data-bounds'});
 }finally{e.dispose();}
});
test('unsupported richer atoms remain an explicit owning admission gap rather than a prepared success',async()=>{
 const h=await harness(),r=range(h.engine);try{
  const original=corpus.cases.find(f=>f.id==='rich-table-recovery').envelope,before=h.engine.checkpoint();
  const unqualified=new api.ExtensionTransferRegistry([{descriptor:corpus.descriptors.find(d=>d.type==='editac.rich-table'),codec:{prepare:offer=>[{attributes:{type:'content',tuple:['module:editac.rich-table',1,offer.payload]},runs:[{text:offer.source,marks:[]}]}]}}]);
  assert.throws(()=>unqualified.prepare(h.engine,original),error=>error.code==='InvalidInput'&&error.message==='fragment-content');assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.commits(),0);assert.equal(h.engine.history({type:'state'}).undoGroups,0);
  facts.checks.push({id:'owning-rich-atom-gap',qualification:'unsupported; parent remains open'});
 }finally{r.close();await h.close();}
});
test('table v2 rejects malformed spans, styles, versions and undeclared formatting atomically',async()=>{
 const fixture=corpus.cases.find(f=>f.id==='table-v2-mixed-cell'),h=await harness(),r=range(h.engine);
 try{
  let rejected=0;
  const reject=async offer=>{
   let prepared;
   try{prepared=registry.prepare(h.engine,offer);}catch(error){
    assert(error instanceof api.ExtensionTransferError||['InvalidInput','ResourceLimit'].includes(error.code));return;
   }
   // Clipboard shape validation may retain opaque tuples. Semantic admission
   // belongs to the owning prepared engine edit and must still reject atomically.
   assert.equal(h.engine.can(api.extensionTransferRequest(prepared,h.engine,r.value,'invalid-table')),false);
   assert.notEqual((await h.session.transfer(prepared,h.engine,r.value)).status,'committed');
  };
  for(const damage of [data=>{data.alignments=[];},data=>{data.alignments[0]='unsupported';},data=>{data.rows=[];},data=>{data.rows=Array(129).fill(data.rows[0]);},data=>{data.source='x'.repeat(1_048_577);},data=>{data.rows[1][1]=null;},data=>{data.rows[1][1].paragraphs=[];},data=>{data.rows[1][1].paragraphs=Array(1025).fill(data.rows[1][1].paragraphs[0]);}]){
   const offer=structuredClone(fixture.envelope);damage(offer.payload[0].attributes.tuple[2]);const before=h.engine.checkpoint(),history=h.engine.history({type:'state'});
   await reject(offer);
   assert.deepEqual(h.engine.checkpoint(),before);assert.deepEqual(h.engine.history({type:'state'}),history);assert.equal(h.commits(),0);rejected++;
  }
  for(const damage of [data=>{data.rows[0][0].rowSpan=3;},data=>{data.rows[0][2]=data.rows[1][1];},data=>{data.rows[1][0]=data.rows[1][1];},data=>{data.rows[0][0].paragraphs[0].style=['heading',7];},data=>{data.rows[1][1].paragraphs[0].style=['code','bad language'];},data=>{data.rows[0][0].header='yes';},data=>{data.rows[0][0].paragraphs[0].runs[0][1]=[['link','javascript:alert(1)']];},data=>{data.rows[0][0].paragraphs[0].runs=Array(1025).fill(['x',[]]);}]){
   const offer=structuredClone(fixture.envelope);damage(offer.payload[0].attributes.tuple[2]);const before=h.engine.checkpoint(),history=h.engine.history({type:'state'}).undoGroups;
   await reject(offer);
   assert.deepEqual(h.engine.checkpoint(),before);assert.equal(h.engine.history({type:'state'}).undoGroups,history);assert.equal(h.commits(),0);rejected++;
  }
  const descriptor=corpus.descriptors.find(d=>d.type===fixture.envelope.type);
  for(const field of ['spans','cell-paragraph-style']){const narrow=new api.ExtensionTransferRegistry([{descriptor:{...descriptor,tableMetadata:descriptor.tableMetadata.filter(x=>x!==field)},codec:{prepare:e=>e.payload}}]);assert.throws(()=>narrow.prepare(h.engine,fixture.envelope),e=>e.code==='undeclared-formatting');}
  const offer=structuredClone(fixture.envelope);offer.payload[0].attributes.tuple[1]=3;assert.throws(()=>registry.prepare(h.engine,offer));
  facts.checks.push({id:'table-v2-atomic-rejection',cases:rejected+3});
 }finally{r.close();await h.close();}
});
test('ordinary absent-codec transfer preserves payload with no optional presenter, execution or fetch',async()=>{
 const h=await harness(),r=range(h.engine),previousFetch=globalThis.fetch;let fetches=0;
 try{
  globalThis.fetch=()=>{fetches++;throw Error('forbidden implicit asset fetch');};
  const absent=new api.ExtensionTransferRegistry([]),offer={version:1,type:'vendor.inert',dataVersion:4294967295,source:'<script>unsafe()</script> ![x](https://example.invalid/x) 😀',payload:{formula:'=unsafe()',code:'throw new Error()',url:'javascript:unsafe()',nested:[null,true,17]}};
  const prepared=absent.prepare(h.engine,offer);assert.equal(prepared.mode,'fallback');assert.deepEqual(prepared.diagnostics,['unknown-extension']);
  const result=await h.session.transfer(prepared,h.engine,r.value);assert.equal(result.status,'committed');release(h.engine,result.result);await h.settle();
  const before=semantic(h.engine),fragment=copied(h.engine);assert.deepEqual(before[0].blockAttributes,['module:editac.inert-extension',1,offer]);
  const exported=h.engine.exportMarkdown(fragment.blocks);assert(exported.markdown.includes('\\<script\\>'));assert(exported.markdown.includes('\\!\\[x\\]'));assert.deepEqual(exported.recovery,fragment.blocks);
  const other=blank(),q=range(other);try{const plan=other.prepare({kind:'fragment',origin:'ordinary:recovery',range:q.value,blocks:exported.recovery});release(other,other.commit(plan));assert.deepEqual(semantic(other),before);}finally{q.close();other.dispose();}
  const checkpoint=h.storage.recoveryExport().checkpoint,reopened=runtime.restoreEngine(checkpoint.identity,checkpoint,[]);try{assert.deepEqual(semantic(reopened),before);}finally{reopened.dispose();}
  assert.equal(fetches,0);assert.equal(h.commits(),1);assert.equal(h.engine.history({type:'state'}).undoGroups,1);
  facts.checks.push({id:'ordinary-inert-no-presenter',fetches,semanticHash:sha256(JSON.stringify(before))});
 }finally{globalThis.fetch=previousFetch;r.close();await h.close();}
});
test('owning inert carrier rejects invalid versions, identities, bounds, fallback edits and partial cuts atomically',async()=>{
 const h=await harness(),r=range(h.engine);try{
  const offer=corpus.cases.find(f=>f.id==='future-atom').envelope,valid=registry.prepare(h.engine,offer).blocks[0],before=h.engine.checkpoint();
  const mutations=[b=>b.attributes.tuple[1]=2,b=>b.attributes.tuple[2].version=2,b=>b.attributes.tuple[2].type='vendor.bad.name',b=>b.attributes.tuple[2].dataVersion=0,b=>b.attributes.tuple[2].dataVersion=1.5,b=>b.attributes.tuple[2].payload={constructor:null},b=>b.attributes.tuple[2].payload=Array(65536).fill(null),b=>b.attributes.tuple[2].source='x'.repeat(1_048_577),b=>b.runs[0].text='silently flattened',b=>b.runs[0].marks=[{mark:'bold'}]];
  for(const mutate of mutations){const block=structuredClone(valid);mutate(block);const request={kind:'fragment',origin:'invalid-inert',range:r.value,blocks:[block]};assert.equal(h.engine.can(request),false);assert.throws(()=>h.engine.prepare(request));assert.deepEqual(h.engine.checkpoint(),before);}
  assert.equal(h.commits(),0);assert.equal(h.engine.history({type:'state'}).undoGroups,0);
  const inserted=await h.session.transfer(registry.prepare(h.engine,offer),h.engine,r.value);assert.equal(inserted.status,'committed');release(h.engine,inserted.result);await h.settle();
  const node=h.engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.inert-extension'),partial={anchor:h.engine.anchor(node.id,1,'right'),focus:h.engine.anchor(node.id,2,'left')};let writes=0;
  try{const checkpoint=h.engine.checkpoint(),result=await h.session.cut(registry.prepare(h.engine,offer),h.engine,partial,()=>{writes++;return true;});assert.notEqual(result.status,'committed');assert.equal(writes,0);assert.deepEqual(h.engine.checkpoint(),checkpoint);}finally{h.engine.releaseAnchor(partial.anchor);h.engine.releaseAnchor(partial.focus);}
  facts.checks.push({id:'owning-inert-atomic-rejection',cases:mutations.length+1});
 }finally{r.close();await h.close();}
});
test('ordinary clipboard requires inert structured flavor before cut and pastes through real storage',async()=>{
 const source=await harness(),target=await harness(),r=range(source.engine),offer=corpus.cases.find(f=>f.id==='future-atom').envelope;
 const clipboard=(h,all)=>new ClipboardInput({}, {retain(){const nodes=h.engine.read().visible.filter(n=>n.kind==='block'),anchor=h.engine.anchor(nodes[0].id,0,'right'),focus=h.engine.anchor(nodes.at(-1).id,all?nodes.at(-1).runs.reduce((n,r)=>n+r.text.length,0):0,'left');return {range:{anchor,focus},active:true,dispose(){h.engine.releaseAnchor(anchor);h.engine.releaseAnchor(focus);}};},move(){},restore(){}},h.engine,request=>h.host.commit(request),()=>false);
 let copy,paste;try{
  const inserted=await source.session.transfer(registry.prepare(source.engine,offer),source.engine,r.value);assert.equal(inserted.status,'committed');release(source.engine,inserted.result);await source.settle();const saved=semantic(source.engine),before=source.engine.checkpoint();
  copy=clipboard(source,true);paste=clipboard(target,false);
  const refused=new Map();assert.equal(copy.copy({setData(m,v){if(m!==FRAGMENT_MIME)refused.set(m,v);},getData:m=>refused.get(m)??''},true).disposition,'rejected');assert.deepEqual(source.engine.checkpoint(),before);assert.equal(source.engine.history({type:'state'}).undoGroups,1);
  const data=new Map(),transport={setData:(m,v)=>data.set(m,v),getData:m=>data.get(m)??''};assert.equal(copy.copy(transport,true).disposition,'committed');assert(copy.diagnostics.includes('inert-extension-source-fallback'));await source.settle();assert.deepEqual(semantic(source.engine),[]);
  assert.equal(paste.paste(transport).disposition,'committed');assert(paste.diagnostics.includes('inert-extension-source-fallback'));await target.settle();assert.deepEqual(semantic(target.engine),saved);
  assert.equal(target.commits(),1);assert.equal(target.engine.history({type:'state'}).undoGroups,1);
  const checkpoint=target.storage.recoveryExport().checkpoint,restored=runtime.restoreEngine(checkpoint.identity,checkpoint,[]);try{assert.deepEqual(semantic(restored),saved);}finally{restored.dispose();}
  source.engine.history({type:'undo'});assert.deepEqual(semantic(source.engine),saved);source.engine.history({type:'redo'});assert.deepEqual(semantic(source.engine),[]);
  facts.checks.push({id:'ordinary-inert-clipboard-storage',rejected:1,committed:2,semanticHash:sha256(JSON.stringify(saved))});
 }finally{copy?.dispose();paste?.dispose();r.close();await source.close();await target.close();}
});
test('all fixture and host cells execute with admitted table v2 and without native qualification',()=>{
 assert.equal(corpus.cases.length,10);for(const fixture of corpus.cases)assert(facts.checks.some(x=>x.id===fixture.id));
 assert.equal(facts.checks.filter(x=>/^(browser|terminal|swift-ios|kotlin-android|desktop)-/.test(x.id)).length,30);
 assert.equal(facts.checks.find(x=>x.id==='rich-table-recovery').mode,'fallback');assert.equal(corpus.pending.length,1);
});
