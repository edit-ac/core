import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { Engine } from '../packages/core/dist/wasm/editac_wasm.js';
import { createHandle } from '../packages/core/dist/engine.js';
import { decodeFragment } from '../packages/web/dist/clipboard/fragment.js';
await init({ module_or_path: await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url)) });
const engine = createHandle(input => new Engine(input), { profile:'v5', documentId:'97000000-0000-4000-8000-000000000001', epoch:'98000000-0000-4000-8000-000000000001', nodes:[{text:'unchanged 😀'}] });
const valid = () => ({version:1,schema:engine.read().identity.schema,blocks:[{attributes:{type:'paragraph'},runs:[{text:'😀',marks:[]}]}]});
const cases = [
 ['fragment-schema',v=>v.extra=true], ['fragment-schema',v=>v.schema='other'], ['fragment-schema',v=>v.blocks=[]],
 ['fragment-block',v=>v.blocks[0].extra=true], ['fragment-check',v=>v.blocks[0].checked=1],
 ['fragment-container',v=>v.blocks[0].containers=[{key:'k',style:{type:'ordered',start:2147483648}}]],
 ['fragment-container',v=>v.blocks[0].containers=[{key:'😀'.repeat(65),style:{type:'quote'}}]],
 ['fragment-style',v=>v.blocks[0].attributes={type:'paragraph',extra:true}],
 ['fragment-content',v=>v.blocks[0].attributes={type:'content',tuple:['unknown']}],
 ['fragment-heading',v=>v.blocks[0].attributes={type:'heading',level:7}],
 ['fragment-code',v=>v.blocks[0].attributes={type:'code',language:'😀'.repeat(65)}],
 ['fragment-run',v=>v.blocks[0].runs[0].extra=true],
 ['fragment-mark',v=>v.blocks[0].runs[0].marks=[{mark:'bold'},{mark:'bold'}]],
 ['fragment-mark',v=>v.blocks[0].runs[0].marks=[{mark:'bold',href:'https://a'}]],
 ['fragment-url',v=>v.blocks[0].runs[0].marks=[{mark:'link',href:'javascript:alert(1)'}]],
 ['fragment-url',v=>v.blocks[0].runs[0].marks=[{mark:'link',href:'https://a/ bad'}]],
];
for (const [index,[reason,mutate]] of cases.entries()) test(`compiled clipboard diagnostic ${index}: ${reason} preserves document/history/update`,()=>{
 const v=valid();mutate(v);engine.read(); const before=engine.read(), checkpoint=engine.checkpoint(), vector=engine.stateVector(), history=engine.history({type:'state'});let updates=0;const sub=engine.subscribe({type:'updates'},()=>updates++);
 try { assert.throws(()=>decodeFragment(JSON.stringify(v),engine),{message:reason}); assert.deepEqual(engine.read(),before);assert.deepEqual(engine.checkpoint(),checkpoint);assert.deepEqual(engine.stateVector(),vector);assert.deepEqual(engine.history({type:'state'}),history);assert.equal(updates,0); }
 finally{sub.dispose();}
});
test('compiled limits, international URLs and source JSON syntax remain precise',()=>{
 const v=valid();v.blocks[0].runs[0].marks=[{mark:'link',href:'https://例え.テスト/道'}]; const raw=JSON.stringify(v);
 assert.deepEqual(decodeFragment(raw,engine),v); assert.throws(()=>decodeFragment('{',engine),SyntaxError);
 assert.deepEqual(decodeFragment(raw+' '.repeat(1048576-Buffer.byteLength(raw)),engine),v);
 assert.throws(()=>decodeFragment(raw+' '.repeat(1048577-Buffer.byteLength(raw)),engine),{message:'fragment-limit'});
});
test('disposed validation rejects instead of reporting success',()=>{const raw=JSON.stringify(valid());engine.dispose();assert.throws(()=>engine.validateFragment(raw),{code:'Disposed',operation:'validateFragment'});});
test('compiled repeated literal fragments preserve owners, reverse targets and one update per commit',()=>{
 const e=createHandle(input=>new Engine(input),{profile:'v5',documentId:'97000000-0000-4000-8000-000000000002',epoch:'98000000-0000-4000-8000-000000000002',nodes:[{text:'alpha'},{text:'independent'}]});
 try { const initial=e.read(), id=initial.visible[0].id;let updates=0;const sub=e.subscribe({type:'updates'},()=>updates++);
 for(let i=0;i<2;i++){const length=e.read().visible[0].runs.map(r=>r.text).join('').length;const anchor=e.anchor(id,length,'right'),focus=e.anchor(id,length,'right');
 const plan=e.prepare({kind:'fragment',origin:'clipboard:literal',range:{anchor,focus},blocks:[{attributes:null,runs:[{text:'same',marks:[]}]}]});
 e.commit(plan);e.releasePlan(plan);e.releaseAnchor(anchor);e.releaseAnchor(focus);}
 assert.deepEqual(e.read().visible.map(n=>n.runs.map(r=>r.text).join('')),['alphasamesame','independent']);assert.deepEqual(e.read().visible.map(n=>n.id),initial.visible.map(n=>n.id));assert.equal(updates,2);
 const anchor=e.anchor(id,9,'right'),focus=e.anchor(id,5,'left');const plan=e.prepare({kind:'fragment',origin:'clipboard:reverse',range:{anchor,focus},blocks:[{attributes:null,runs:[{text:'😀',marks:[]}]}]});e.commit(plan);e.releasePlan(plan);e.releaseAnchor(anchor);e.releaseAnchor(focus);
 assert.equal(e.read().visible[0].runs.map(r=>r.text).join(''),'alpha😀same');assert.equal(updates,3);sub.dispose();
 }finally{e.dispose();}
});
