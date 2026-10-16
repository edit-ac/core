// Actual current production WASM and JS command transport; no prepared runtime.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {init} from '../packages/core/dist/index.js';
import {decodeStateVector} from 'yjs';
const runtime=await init('data:application/wasm;base64,'+(await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm',import.meta.url))).toString('base64'));
let serial=2;
function fixture(v2, large = false) {
 const engine=runtime.createEngine({profile:'v5',documentId:`ac120000-0000-4000-8000-${String(serial++).padStart(12,'0')}`,epoch:'ac120000-0000-4000-8000-000000000001',nodes:[{text:''}]});
 const runs=[[large ? 'a😀'.repeat(21)+'a' : 'ab😀', large ? [] : [['bold'],['link','https://example.test/']]]];
 const cell=v2?{paragraphs:[{style:['heading',2],runs}],rowSpan:1,columnSpan:1,header:true}:runs;
 const tuple=['module:editac.table',v2?2:1,{alignments:large ? Array(8).fill('left') : ['left','right'],rows:large ? Array.from({length:128},()=>Array(8).fill(cell)) : [[cell,cell],[cell,cell]],source:'exact retained source'}];
 const owner=engine.read().visible[0].id, at=engine.anchor(owner,0,'right');
 engine.commit(engine.prepare({kind:'fragment',origin:'baseline',range:{anchor:at,focus:at},blocks:[{runs:large ? [{text:tuple[2].rows.map(row=>row.map(cell=>cell[0][0]).join('\t')).join('\n'),marks:[]}] : [],attributes:{type:'content',tuple}}]}));engine.releaseAnchor(at);
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


test('full Long table edits retain unchanged fallback clocks and replay every acknowledged journal update', () => {
 const e=fixture(false,true);let restored;
 const semantic=node=>({...node,runs:node.runs.reduce((out,run)=>{const last=out.at(-1);if(last && JSON.stringify(last.attributes)===JSON.stringify(run.attributes))last.text+=run.text;else out.push(structuredClone(run));return out;},[])});
 try {
  const original=structuredClone(table(e)), checkpoint=e.checkpoint(), updates=[], clocks=decodeStateVector(e.stateVector());
  const subscription=e.subscribe({type:'updates'}, patch=>{if(patch.update)updates.push(patch.update);});
  try {
   for(let i=0;i<24;i++) {
    const row=Math.floor(i*127/23), column=i%8, text=original.blockAttributes[2].rows[row][column][0][0];
    for(const value of ['z'+text.slice(1),text]) {
     e.history({type:'explicit'});
     const result=e.commit(e.prepare(command(e,'tableCell',{row,column,text:value})));
     if(result.caret)e.releaseAnchor(result.caret);
    }
   }
  } finally {subscription.dispose();}
  assert.equal(updates.length,48);
  assert.deepEqual(semantic(table(e)),semantic(original));
  assert.ok(updates.reduce((n,u)=>n+u.bytes.length,0)>2*1024*1024,'exercise the old JSON request overflow');
  for(const [client,clock] of decodeStateVector(e.stateVector())) assert.ok(clock-(clocks.get(client)??0)<1024,'unchanged fallback must not consume CRDT clocks');
  restored=runtime.restoreEngine(checkpoint.identity,checkpoint,updates);
  assert.deepEqual(semantic(table(restored)),semantic(original));
  assert.deepEqual(restored.stateVector(),e.stateVector());
  e.history({type:'undo'});assert.notDeepEqual(table(e),original);
  e.history({type:'redo'});assert.deepEqual(semantic(table(e)),semantic(original));
 } finally {restored?.dispose();e.dispose();}
});
