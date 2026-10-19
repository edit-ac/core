import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from './browser-harness.ts';
const {probe}=browserHarness('capture-compare','fixtures/browser-capture-compare',{
  autoMount:false, assertSourcesUnchanged:true, serverOptions:{recordRequests:true},
  sourcePaths:['fixtures/browser-capture-compare/index.html','fixtures/browser-capture-compare/session.mjs','packages/web/src/review/history.ts','packages/web/src/review/model.ts','packages/web/src/storage/owner.ts','packages/web/src/entry.ts','crates/editac-wasm/src/lib.rs','crates/editac-diff/src/semantic.rs'],
});
async function mount(page,limits={}){await page.waitForFunction(()=>!!window.comparisonFixture);await page.evaluate(limits=>window.comparisonFixture.mount(limits),limits);}
const oracle=page=>page.evaluate(()=>window.comparisonFixture.oracle());
test('packed public captures return complete Rust semantics without any live or durable mutation',()=>probe('complete-public-comparison',async(page,fact)=>{
  await mount(page);const current=await page.evaluate(()=>window.comparisonFixture.change());const before=await oracle(page);
  const result=await page.evaluate(current=>{const f=window.comparisonFixture;const model=f.compare(f.old,current);const first=f.store.read(f.old,f.access).revision;const last=f.store.read(current,f.access).revision;
    return {model,first,last,prepared:f.prepare(model),equal:f.compare(current,current),repeat:f.compare(f.old,current)};},current);
  assert.equal(result.model.version,'editac-semantic-diff-v1');assert.equal(result.model.attribution,'unknown');assert.notEqual(result.model.before_hash,result.model.after_hash);
  const id=before.snapshot.visible[0].id,change=result.model.changes.find(c=>c.id===id);
  for(const facet of ['Text','Formatting','References'])assert.ok(change.facets.includes(facet),facet);
  assert.equal(change.before.runs.map(r=>r.text).join(''),'before 😀');assert.equal(change.after.runs.map(r=>r.text).join(''),'after 😀');
  assert.ok(change.before.spans.length);assert.ok(change.after.spans.length);assert.ok(change.after.runs.some(r=>r.marks.bold));assert.ok(change.after.runs.some(r=>r.marks.link==='https://example.test/'));
  assert.deepEqual(result.model.retained_structure,[result.first.snapshot.retainedStructure,result.last.snapshot.retainedStructure]);
  assert.equal(result.model.before_hash,result.first.comparison.hash);assert.equal(result.model.after_hash,result.last.comparison.hash);
  assert.deepEqual(result.repeat,result.model);assert.deepEqual(result.equal.changes,[]);assert.equal(result.prepared.changes.length,result.model.changes.length);
  const after=await oracle(page);assert.deepEqual(after,before);assert.equal(before.disk.checkpoints.length,1);assert.equal(before.disk.updates.length,1);assert.ok(before.history.undoGroups>0);assert.ok(before.patches.some(p=>p.update));assert.notDeepEqual(result.first.comparison.observedToken,result.last.comparison.observedToken);assert.deepEqual(result.last.snapshot.identity,before.snapshot.identity);
  fact.snapshots.push({before,after,...result});
}));
test('missing incompatible and key-unavailable public history reject without mutation',()=>probe('public-access-rejections',async(page,fact)=>{
  await mount(page);const current=await page.evaluate(()=>window.comparisonFixture.change());const before=await oracle(page);
  const errors=await page.evaluate(current=>{const f=window.comparisonFixture;return [['absent',current,f.access],[f.old,'absent',f.access],[f.old,current,{...f.access,keyProfile:'rotated'}],[f.old,current,{scope:{...f.access.scope,moduleProfile:'wrong'}}]].map(args=>{try{f.compare(...args);return 'unexpected-success';}catch(e){return e.message;}});},current);
  for(const [i,reason] of ['missing','missing','key-unavailable','incompatible'].entries())assert.match(errors[i],new RegExp(reason));
  const after=await oracle(page);assert.deepEqual(after,before);fact.snapshots.push({before,after,errors});
}));
test('pruning and oversize capture rejection preserve retained history and real disk',()=>probe('public-retention-limits',async(page,fact)=>{
  await mount(page,{maxRevisions:2});const handles=await page.evaluate(async()=>{const f=window.comparisonFixture;return [await f.capture('one'),await f.capture('two')];});const before=await oracle(page);
  const errors=await page.evaluate(async handles=>{const f=window.comparisonFixture,errors=[];try{f.compare(f.old,handles[1]);errors.push('unexpected-success');}catch(e){errors.push(e.message);}try{await f.capture('x'.repeat(1024*1024));errors.push('unexpected-success');}catch(e){errors.push(e.message);}return errors;},handles);
  assert.match(errors[0],/pruned/);assert.match(errors[1],/byte limit/);const after=await oracle(page);assert.deepEqual(after,before);fact.snapshots.push({before,after,errors});
}));
test('integrity scope version token and request bounds reject at the real packed WASM boundary',()=>probe('public-wasm-rejections',async(page,fact)=>{
  await mount(page);await page.evaluate(()=>window.comparisonFixture.change());const before=await oracle(page);
  const errors=await page.evaluate(()=>{const e=window.comparisonFixture.engine,c=e.captureSemantic('builtin-v5').comparison;
    return [{hash:'0'.repeat(64)},{version:'future'},{payload:'invalid'},{observedToken:[2]},{moduleProfile:'wrong'},{identity:{...c.identity,epoch:'96000000-0000-4000-8000-000000000002'}},{hash:'x'.repeat(4*1024*1024)}].map(change=>{try{e.compareSemantic(c,{...c,...change});return 'unexpected-success';}catch(e){return e.message;}});});
  assert.equal(errors.length,7);for(const error of errors)assert.doesNotMatch(error,/unexpected-success/);assert.match(errors.at(-1),/byte limit/);
  const after=await oracle(page);assert.deepEqual(after,before);fact.snapshots.push({before,after,errors});
}));
