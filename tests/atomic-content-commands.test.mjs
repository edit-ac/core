// Current production WASM; the same Rust portable translator as NativeSession.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {init} from '../packages/core/dist/index.js';
const runtime=await init('data:application/wasm;base64,'+(await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm',import.meta.url))).toString('base64'));
const descriptors=[['module:editac.image',1,{url:'https://assets.example.invalid/a.png',alt:'A 😀',title:'a',source:'![A](https://assets.example.invalid/a.png)'}],['module:editac.reference',1,{targetId:'document-a',label:'Reference 😀'}]];
for(const [i,tuple] of descriptors.entries()) {
 test(`production WASM atomic ${i} replace/remove/history and captured-target rejection`,()=>{
  const e=runtime.createEngine({profile:'v5',documentId:`ac150000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,epoch:'ac150000-0000-4000-8000-000000000001',nodes:[{text:''}]});
  try {
   const seed=e.read().visible[0].id, cut=e.anchor(seed,0,'right');
   e.commit(e.prepare({kind:'fragment',origin:'baseline',range:{anchor:cut,focus:cut},blocks:[{runs:i===1?[{text:tuple[2].label,marks:[]}]:[],attributes:{type:'content',tuple}}]}));e.releaseAnchor(cut);e.history({type:'clear'});
   const find=()=>e.read().visible.find(n=>n.blockAttributes?.[0]===tuple[0]);
   const original=structuredClone(find()),at=e.anchor(original.id,0,'right');
   const replacement=structuredClone(tuple);if(i===0){replacement[2].alt='New 😀';replacement[2].source='replacement source';}else{replacement[2].targetId='document-b';replacement[2].label='New 😀';}
   const command=(expected,replacement)=>({kind:'editor',origin:'atomic-wasm',commands:[{type:'atomicContent',owner:original.id,expected,at,replacement}]});
   const p=e.prepare(command(tuple,replacement));assert.deepEqual(find(),original);e.commit(p);
   const after=structuredClone(find());assert.deepEqual(after.blockAttributes,replacement);assert.equal(after.id,original.id);
   assert.throws(()=>e.prepare(command(tuple,null)));const cp=e.checkpoint();assert.throws(()=>e.prepare(command(replacement,['module:editac.image',99,{}])));assert.deepEqual(e.checkpoint().bytes,cp.bytes);
   // Re-capture at the current source start: the old right-biased cut may have
   // followed the replacement text. Captured source identity is never guessed.
   e.releaseAnchor(at);const current=e.anchor(original.id,0,'right');
   const remove={kind:'editor',origin:'atomic-wasm',commands:[{type:'atomicContent',owner:original.id,expected:replacement,at:current,replacement:null}]};
   e.commit(e.prepare(remove));const removed=e.read().visible.find(n=>n.id===original.id);assert.deepEqual(removed.blockAttributes,['paragraph']);assert.equal(removed.runs.map(r=>r.text).join(''),'');
   e.history({type:'undo'});assert.deepEqual(find(),after);e.history({type:'undo'});assert.deepEqual(find(),original);
   e.history({type:'redo'});e.history({type:'redo'});assert.deepEqual(e.read().visible.find(n=>n.id===original.id),removed);
   e.releaseAnchor(current);
  } finally {e.dispose();}
 });
}
