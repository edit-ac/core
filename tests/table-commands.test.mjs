// Actual current production WASM and JS command transport; no prepared runtime.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {init} from '../packages/core/dist/index.js';
const runtime=await init('data:application/wasm;base64,'+(await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm',import.meta.url))).toString('base64'));
let serial=2;
function fixture(v2) {
 const engine=runtime.createEngine({profile:'v5',documentId:`ac120000-0000-4000-8000-${String(serial++).padStart(12,'0')}`,epoch:'ac120000-0000-4000-8000-000000000001',nodes:[{text:''}]});
 const runs=[['ab😀', [['bold'],['link','https://example.test/']]]];
 const cell=v2?{paragraphs:[{style:['heading',2],runs}],rowSpan:1,columnSpan:1,header:true}:runs;
 const tuple=['module:editac.table',v2?2:1,{alignments:['left','right'],rows:[[cell,cell],[cell,cell]],source:'exact retained source'}];
 const owner=engine.read().visible[0].id, at=engine.anchor(owner,0,'right');
 engine.commit(engine.prepare({kind:'fragment',origin:'baseline',range:{anchor:at,focus:at},blocks:[{runs:[],attributes:{type:'content',tuple}}]}));engine.releaseAnchor(at);
 engine.history({type:'clear'});
 return engine;
}
const table=e=>e.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');
const command=(e,type,rest)=>({kind:'editor',origin:'table-wasm',commands:[{type,owner:table(e).id,expected:table(e).blockAttributes,...rest}]});
for(const v2 of [false,true]) {
 test(`v${v2?2:1} production WASM cell and all four structure actions retain tuple and history`,()=>{
  const e=fixture(v2);try {
   const original=structuredClone(table(e)), captured=command(e,'tableCell',{row:0,column:0,text:'abX😀'});
   const p=e.prepare(captured);assert.deepEqual(table(e),original);e.commit(p);
   const edited=structuredClone(table(e));assert.notDeepEqual(edited,original);
   for(const action of ['insertRow','insertColumn','deleteRow','deleteColumn']) e.commit(e.prepare(command(e,'tableStructure',{action,index:1})));
   assert.deepEqual(table(e),edited);assert.equal(e.history({type:'state'}).undoGroups,5);
   assert.equal(e.can(captured),false);assert.throws(()=>e.prepare(captured));
   for(let i=0;i<5;i++)e.history({type:'undo'});assert.deepEqual(table(e),original);
   for(let i=0;i<5;i++)e.history({type:'redo'});assert.deepEqual(table(e),edited);
   const checkpoint=e.checkpoint(), restored=runtime.restoreEngine(checkpoint.identity,checkpoint);try{assert.deepEqual(table(restored).blockAttributes,edited.blockAttributes);}finally{restored.dispose();}
  }finally{e.dispose();}
 });
 test(`v${v2?2:1} production WASM rejects invalid captured structural actions without mutation`,()=>{
  const e=fixture(v2);try {
   const before=e.checkpoint();
   for(const rest of [{action:'insertRow',index:3},{action:'deleteColumn',index:2},{action:'merge',index:0}]){
    const c=command(e,'tableStructure',rest);assert.throws(()=>e.prepare(c));assert.deepEqual(e.checkpoint().bytes,before.bytes);
   }
   const c=command(e,'tableCell',{row:0,column:0,text:'no\nflatten'});assert.throws(()=>e.prepare(c));assert.deepEqual(e.checkpoint().bytes,before.bytes);
  }finally{e.dispose();}
 });
}
