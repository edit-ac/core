import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('registered-inline-transfer','fixtures/browser-extension-formatting',{markdown:true,assertSourcesUnchanged:true,sourcePaths:['crates/editac-core/src/clipboard.rs','crates/editac-core/src/interchange.rs','crates/editac-core/src/commands/fragment.rs','packages/core/src/extensions/transfer.ts','packages/web/src/clipboard/fragment.ts','fixtures/browser-extension-formatting/session.mjs']});
const mime='application/x-edit-ac-extension+json',fragment='application/x-edit-ac-fragment+json';
const tuple=[1,{latex:'x^2',display:false}];
const cases=[
 {id:'registered-inline-math-tuple',type:'editac.math',source:'LaTeX source: x^2',payload:[{attributes:{type:'paragraph'},runs:[{text:'LaTeX source: x^2',marks:[{mark:'bold'}],attributes:{'module:editac.math':tuple}}]}]},
 {id:'marked-atomic-reference-label',type:'editac.reference',source:'label',payload:[{attributes:{type:'content',tuple:['module:editac.reference',1,{targetId:'host:opaque',label:'label'}]},runs:[{text:'label',marks:[{mark:'bold'}]}]}]}
];
const atomCorpus=JSON.parse(await readFile('fixtures/rich-presenters/formatting/mixed-extensions.json','utf8'));
const file=structuredClone(atomCorpus.cases.find(c=>c.id==='file-caption-bold').envelope.payload[0]);
file.runs[0].marks=[{mark:'bold'}];
cases.push({id:'marked-atomic-asset-fallback',type:'editac.file',source:file.runs[0].text,payload:[file]});
const inert={version:1,type:'vendor.atom',dataVersion:7,source:'opaque 😀 source',payload:{identity:'stable:atom',data:[true,42]}};
cases.push({id:'marked-atomic-inert-source',type:'editac.inert',source:inert.source,payload:[{attributes:{type:'content',tuple:['module:editac.inert-extension',1,inert]},runs:[{text:inert.source,marks:[{mark:'bold'}],opaqueMarks:[{key:'vendor-note',value:{exact:true}}]}]}]});
const descriptor=c=>({type:c.type,versions:[1],inline:['bold','italic','underline','strike','code','link'],blocks:['paragraph','content'],tableMetadata:[],fallback:'inert-source-with-recovery'});
const config={descriptors:cases.map(descriptor)};
const offer=c=>({[mime]:JSON.stringify({version:1,type:c.type,dataVersion:1,source:c.source,payload:c.payload})});
const state=p=>p.evaluate(()=>window.inputFixture.state());
const semantic=s=>s.nodes.map(n=>({kind:n.kind,attributes:n.blockAttributes,runs:n.runs}));
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);assert.equal(b.commands.length,a.commands.length);}
for(const c of cases)test(c.id+' real mounted clipboard/history/reopen/source recovery',()=>probe(c.id,async(p,f)=>{
 const before=await state(p);await p.evaluate(()=>window.inputFixture.select());
 assert.equal((await p.evaluate(data=>window.inputFixture.paste(data),offer(c))).disposition,'committed');
 const after=await state(p);f.snapshots.push(before,after);assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.journal.length,before.journal.length+1);
 const node=after.nodes.find(n=>c.type==='editac.math'?n.runs.some(r=>r.attributes['module:editac.math']):n.blockAttributes?.[0]===c.payload[0].attributes.tuple[0]);
 assert(node);assert.equal(node.runs.map(r=>r.text).join(''),c.source);assert.equal(node.runs[0].attributes.bold,true);
 if(c.type==='editac.math')assert.deepEqual(node.runs[0].attributes['module:editac.math'],tuple);
 else assert.deepEqual(node.blockAttributes,c.payload[0].attributes.tuple);
 await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual(semantic(await state(p)),semantic(before));
 await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual(semantic(await state(p)),semantic(after));
 await p.evaluate(()=>window.inputFixture.select(false,true));const round=await p.evaluate(()=>window.inputFixture.roundTrip());f.snapshots.push(round);assert.deepEqual(semantic(round),semantic(after));assert(round.exported.recovery.length);assert(round.exported.diagnostics.length);
 const data=await p.evaluate(()=>window.inputFixture.copy());assert(data[fragment]);
 await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual(semantic(await state(p)),semantic(after));
 assert.equal(await p.locator('script,iframe').evaluateAll(nodes=>nodes.filter(n=>n.closest('#projection')).length),0);
},config));
for(const mode of ['malformed-tuple','wrong-type','wrong-version','duplicate','surrogate','budget','readonly','cancel','stale','unsupported-atom','partial-atom'])test('registered transfer rejection '+mode,()=>probe(mode,async(p,f)=>{
 let c=structuredClone(cases[0]);
 if(mode==='malformed-tuple')c.payload[0].runs[0].attributes['module:editac.math']=[1,[]];
 if(mode==='wrong-type')c.payload[0].runs[0].attributes={'module:vendor.other':tuple};
 if(mode==='wrong-version')c.payload[0].runs[0].attributes['module:editac.math']=[2,{}];
 if(mode==='duplicate')c.payload[0].runs[0].opaqueMarks=[{key:'module:editac.math',value:tuple}];
 if(mode==='surrogate')c.payload[0].runs[0].text='\ud800';
 if(mode==='budget')c.payload[0].runs[0].attributes['module:editac.math']=[1,{latex:'x'.repeat(17000)}];
 if(mode==='unsupported-atom'){c=structuredClone(cases[1]);c.payload[0].attributes.tuple[0]='module:vendor.atom';}
 if(mode==='partial-atom'){c=structuredClone(cases[1]);c.payload[0].runs[0].text='labe';}
 await p.evaluate(()=>window.inputFixture.select());
 if(mode==='readonly')await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));
 const before=await state(p);
 if(mode==='cancel'||mode==='stale'){
  await p.evaluate(data=>window.inputFixture.defer(data),offer(c));
  if(mode==='cancel')await p.evaluate(()=>window.pendingTransfer.job.cancel());
  else await p.evaluate(()=>{const e=window.inputFixture.engine,n=e.read().visible[1];e.commit(e.prepare({kind:'editor',origin:'other',commands:[{type:'wrap',targets:[n.id],style:{type:'quote'}}]}));});
  const stable=await state(p);const result=await p.evaluate(async()=>{window.pendingTransfer.release();return window.pendingTransfer.job.result;});assert.equal(result.disposition,'rejected');unchanged(stable,await state(p));
 }else{assert.equal((await p.evaluate(data=>window.inputFixture.paste(data),offer(c))).disposition,'rejected');unchanged(before,await state(p));}
 f.snapshots.push(await state(p));
},config));
for(const c of cases)for(const ack of [true,false])test(c.id+' cut acknowledgment '+ack,()=>probe(c.id+'-cut-'+ack,async(p,f)=>{
 await p.evaluate(()=>window.inputFixture.select());assert.equal((await p.evaluate(data=>window.inputFixture.paste(data),offer(c))).disposition,'committed');
 await p.evaluate(()=>window.inputFixture.select(false,true));const before=await state(p);
 const result=await p.evaluate(({ack})=>{const data={};const result=window.inputFixture.protocol.clipboard.copy({setData:(m,v)=>{if(ack)data[m]=v;},getData:m=>data[m]??''},true);return{result,data};},{ack});
 const after=await state(p);f.snapshots.push(before,after);
 if(!ack){unchanged(before,after);assert.notEqual(result.result.disposition,'committed');}
 else{assert(result.data[fragment]);assert.equal(result.result.disposition,'committed');assert.equal(after.history.undoGroups,before.history.undoGroups+1);await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual(semantic(await state(p)),semantic(before));}
},config));

for(const c of cases.filter(c=>c.type!=='editac.math'))test(c.id+' partial copy/cut rejects structured acknowledgment',()=>probe(c.id+'-partial',async(p,f)=>{
 await p.evaluate(()=>window.inputFixture.select());assert.equal((await p.evaluate(data=>window.inputFixture.paste(data),offer(c))).disposition,'committed');
 if(c.type!=='editac.reference'){
  const before=await state(p);const bounded=await p.evaluate(tag=>{const f=window.inputFixture,e=f.engine,n=e.read().visible.find(n=>n.blockAttributes?.[0]===tag),a=e.anchor(n.id,1,'right'),b=e.anchor(n.id,2,'left');try{return{mapping:f.selection.toDOM({node:n.id,offset:1,bias:'right'})===undefined,can:e.can({kind:'fragment',origin:'partial',range:{anchor:a,focus:b},blocks:[{runs:[],attributes:null}]})};}finally{e.releaseAnchor(a);e.releaseAnchor(b);}},c.payload[0].attributes.tuple[0]);
  assert.equal(bounded.mapping,true);assert.equal(bounded.can,false);unchanged(before,await state(p));f.snapshots.push(before);return;
 }
 await p.evaluate(tag=>{const f=window.inputFixture,n=f.engine.read().visible.find(n=>n.blockAttributes?.[0]===tag),a=f.selection.toDOM({node:n.id,offset:1,bias:'right'}),b=f.selection.toDOM({node:n.id,offset:2,bias:'left'});document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);f.selection.capture();},c.payload[0].attributes.tuple[0]);
 const before=await state(p);const copy=await p.evaluate(()=>{const f=window.inputFixture,data={};const result=f.protocol.clipboard.copy({setData:(m,v)=>data[m]=v,getData:m=>data[m]??''},true);return{result,data};});assert.equal(copy.result.disposition,'rejected');assert.equal(copy.data[fragment],undefined);unchanged(before,await state(p));f.snapshots.push(before);
},config));
