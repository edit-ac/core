// Local public SDK + real production WASM prerequisite. Installed browsers are BCC-1.2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { init } from '../packages/core/dist/index.js';
import { WebHistoryStore, prepareReview } from '../packages/web/dist/index.js';
const wasm = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init(`data:application/wasm;base64,${wasm.toString('base64')}`);
let serial=100;
function engine() { const s=String(++serial).padStart(12,'0'); return runtime.createEngine({profile:'v5',documentId:`95000000-0000-4000-8000-${s}`,epoch:`96000000-0000-4000-8000-${s}`,nodes:[{text:'before 😀'},{text:'second'}]}); }
const access=e=>({scope:{identity:e.read().identity,moduleProfile:'builtin-v5'}});
function commit(e,commands) { const p=e.prepare({kind:'editor',origin:'capture-comparison',commands});try {e.commit(p);}finally{e.releasePlan(p);} }
function oracle(e,patches,store) { return {snapshot:e.read(),checkpoint:e.checkpoint(),vector:e.stateVector(),update:e.encodeUpdate(),history:e.history({type:'state'}),patches:structuredClone(patches),usage:store.usage,list:store.list(access(e))}; }
test('public history derives Rust model from two real captures and remains read-only',async()=>{
 const e=engine(),store=new WebHistoryStore(),patches=[];const sub=e.subscribe({type:'all'},p=>patches.push(p));
 try {
  const a=access(e),old=await store.capture(e,a,'old'),id=e.read().visible[0].id;
  commit(e,[{type:'replaceAt',owner:id,from:0,to:6,text:'after'},{type:'markAt',owner:id,from:0,to:5,mark:'bold',action:'apply'},{type:'markAt',owner:id,from:0,to:5,mark:'link',action:'apply',href:'https://example.test/'}]);
  const current=await store.capture(e,a,'current');const before=oracle(e,patches,store);
  const model=store.compare(e,old,current,a);
  assert.equal(model.version,'editac-semantic-diff-v1');assert.equal(model.attribution,'unknown');
  const c=model.changes.find(c=>c.id===id);for(const facet of ['Text','Formatting','References'])assert.ok(c.facets.includes(facet));
  assert.equal(c.before.runs.map(r=>r.text).join(''),'before 😀');assert.equal(c.after.runs.map(r=>r.text).join(''),'after 😀');
  assert.equal(prepareReview({representation:'semantic',model}).changes.length,model.changes.length);
  assert.deepEqual(oracle(e,patches,store),before);assert.deepEqual(store.compare(e,old,current,a),model);
  assert.deepEqual(store.compare(e,current,current,a).changes,[]);assert.deepEqual(oracle(e,patches,store),before);
 } finally{sub.dispose();e.dispose();}
});
test('missing, pruned, incompatible and locked histories reject without live/store mutation',async()=>{
 const e=engine(),store=new WebHistoryStore({maxRevisions:2});try {
  const a=access(e),pruned=await store.capture(e,a,'pruned'),one=await store.capture(e,a,'one'),two=await store.capture(e,a,'two');
  const before=oracle(e,[],store);
  for(const [x,y,scope,reason] of [['absent',two,a,'missing'],[pruned,two,a,'pruned'],[one,'absent',a,'missing'],[one,two,{scope:{...a.scope,moduleProfile:'other'}},'incompatible'],[one,two,{...a,keyProfile:'rotated'},'key-unavailable']]) {
   assert.throws(()=>store.compare(e,x,y,scope),new RegExp(reason));assert.deepEqual(oracle(e,[],store),before);
  }
 }finally{e.dispose();}
});
test('oversize capture rejects before eviction and detached captures are immutable',async()=>{
 const e=engine(),store=new WebHistoryStore();try {
  const a=access(e),h=await store.capture(e,a,'kept'),before=oracle(e,[],store);
  await assert.rejects(store.capture(e,a,'x'.repeat(1024*1024)),/byte limit/);
  assert.deepEqual(oracle(e,[],store),before);const r=store.read(h,a).revision;
  assert.ok(Object.isFrozen(r.comparison));assert.throws(()=>r.comparison.hash='tampered',TypeError);
  assert.deepEqual(store.compare(e,h,h,a).changes,[]);
 }finally{e.dispose();}
});
test('raw public comparison rejects tampering, wrong engine, invalid token and excessive requests',()=>{
 const e=engine(),other=engine(),store=new WebHistoryStore();try {
  const c=e.captureSemantic('builtin-v5').comparison,before=oracle(e,[],store);
  for(const change of [{hash:'0'.repeat(64)},{version:'future'},{payload:'invalid'},{observedToken:[2]},{moduleProfile:'other'},{identity:other.read().identity}]) {
   assert.throws(()=>e.compareSemantic(c,{...structuredClone(c),...change}));assert.deepEqual(oracle(e,[],store),before);
  }
  const rescoped={...c,moduleProfile:'rescope-both'};assert.throws(()=>e.compareSemantic(rescoped,rescoped),/binding mismatch/);
  assert.throws(()=>other.compareSemantic(c,c),/incompatible/);
  assert.throws(()=>e.compareSemantic(c,{...c,hash:'x'.repeat(4*1024*1024)}),/byte limit/);
  assert.deepEqual(oracle(e,[],store),before);
 }finally{e.dispose();other.dispose();}
});
test('public capture/compare recipe and existing README consumer compile against package declarations',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {spawnSync}=await import('node:child_process');
 const directory=await mkdtemp(new URL('../.bcc-types-',import.meta.url));
 try {
  const readme=await readFile(new URL('../packages/web/README.md',import.meta.url),'utf8');
  const example=readme.match(/```ts\n([\s\S]*?)```/)[1];
  await writeFile(`${directory}/consumer.mts`,`
   import {WebHistoryStore,prepareReview} from '@edit-ac/web';
   import type {EngineHandle,SemanticCapture,SemanticComparison,DocumentIdentity} from '@edit-ac/core';
   declare const root:HTMLElement,assetUrl:string,databaseName:string,identity:DocumentIdentity,engine:EngineHandle;
   ${example}
   const store=new WebHistoryStore(),access={scope:{identity:engine.read().identity,moduleProfile:'builtin-v5'}};
   const before=await store.capture(engine,access,'Before');
   const after=await store.capture(engine,access,'After');
   const model:SemanticComparison=store.compare(engine,before,after,access);
   prepareReview({representation:'semantic',model});
   const capture:SemanticCapture=engine.captureSemantic('builtin-v5').comparison;
   engine.compareSemantic(capture,capture);
   // @ts-expect-error comparison requires captures, never supplied diff models
   engine.compareSemantic(model,model);
  `);
  const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--target','ES2022','--module','NodeNext','--lib','ES2022,DOM',`${directory}/consumer.mts`],{encoding:'utf8'});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{await rm(directory,{recursive:true,force:true});}
});
