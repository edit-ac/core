import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeAsset, evaluateBudget, assertBudget, auditTaskGraph } from '../scripts/browser-size-contract.mjs';
const required = [{name:'task.js',kind:'js'},{name:'glue.js',kind:'js'},{name:'engine.wasm',kind:'wasm'},{name:'task.css',kind:'css'},{name:'required-lazy.js',kind:'js'}];
const manifest = (js, total) => [
 {name:'task.js',kind:'js',gzip:js-2}, {name:'glue.js',kind:'js',gzip:1}, {name:'required-lazy.js',kind:'js',gzip:1},
 {name:'engine.wasm',kind:'wasm',gzip:total-js-1}, {name:'task.css',kind:'css',gzip:1},
].map(a=>({...a,raw:a.gzip,sha256:'a'.repeat(64)}));
for (const [scope, js, total] of [['total',32768,524288],['js',32768,100000]]) {
 test(`${scope} cap admits its exact boundary`,()=>assertBudget(evaluateBudget(manifest(js,total),required)));
 test(`${scope} cap rejects one byte above`,()=>assert.throws(()=>assertBudget(evaluateBudget(manifest(js+(scope==='js'?1:0),total+(scope==='total'?1:0)),required)),new RegExp(scope+':')));
}
test('preferred misses remain visible when hard caps pass',()=>{
 const result=evaluateBudget(manifest(32768,524288),required);assertBudget(result);assert.equal(result.total.preferredPass,false);assert.equal(result.js.preferredPass,false);
});
test('preferred exact boundaries pass',()=>{
 const result=evaluateBudget(manifest(16000,256000),required);assert.equal(result.total.preferredPass,true);assert.equal(result.js.preferredPass,true);
});
for (const item of required) test(`omitted required resource fails: ${item.name}`,()=>assert.throws(()=>evaluateBudget(manifest(32768,524288).filter(a=>a.name!==item.name),required),/Missing required/));
test('duplicate resources cannot disguise the inventory',()=>{const a=manifest(32768,524288);assert.throws(()=>evaluateBudget([...a,a[0]],required),/Duplicate/);});
test('invalid measurements and incomplete inventory fail',()=>{
 for(const invalid of [0,-1,NaN,undefined]){const a=manifest(32768,524288);a[0].gzip=invalid;assert.throws(()=>evaluateBudget(a,required),/Invalid/);}
 assert.throws(()=>evaluateBudget([],[]),/inventory/);assert.throws(()=>evaluateBudget(manifest(32768,524288),required.filter(a=>a.kind!=='wasm')),/Incomplete/);
});
test('resource hashes and level-9 fixed-metadata gzip are reproducible',()=>{
 const a=describeAsset('task.js','js',Buffer.from('export const x=1;'.repeat(100)));assert.deepEqual(a,describeAsset('task.js','js',Buffer.from('export const x=1;'.repeat(100))));assert.ok(a.raw>a.gzip);assert.ok(a.brotli>0);
});

const packedGraph = () => Object.fromEntries(['core/dist/index.js','core/dist/engine.js','web/dist/editor.js','web/dist/storage/checkpoint.js','web/dist/sync/protocol.js','web/dist/surface.js'].map(p=>['node_modules/@edit-ac/'+p,p.endsWith('core/dist/index.js') ? 'const gluePath=new URL("./wasm/editac_wasm.js",import.meta.url);import(gluePath)' : 'export const fixture=1;']));
test('production graph admits only audited packed dependencies',()=>auditTaskGraph(packedGraph()));
test('omitted required runtime dependency fails graph admission',()=>{const graph=packedGraph();delete graph['node_modules/@edit-ac/web/dist/sync/protocol.js'];assert.throws(()=>auditTaskGraph(graph),/Missing Task/);});
test('workspace source resolution fails graph admission',()=>{const graph=packedGraph();graph['packages/web/src/editor.ts']='';assert.throws(()=>auditTaskGraph(graph),/outside packed/);});
test('hidden required lazy code fails even when statically bundled bytes fit',()=>{const graph=packedGraph();graph['node_modules/@edit-ac/web/dist/editor.js']='import(runtimeDependency)';assert.throws(()=>auditTaskGraph(graph),/Uninventoried/);});
test('an extra hidden lazy dependency in the known glue loader fails',()=>{const graph=packedGraph();graph['node_modules/@edit-ac/core/dist/index.js']+=';import(hidden)';assert.throws(()=>auditTaskGraph(graph),/Uninventoried/);});

test('production WASM/glue exclude foundation roots; explicit qualification build retains them', async () => {
 const {readFile}=await import('node:fs/promises');
 const production=await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm',import.meta.url));
 const qualification=await readFile(new URL('../packages/core/dist/wasm-fixture/editac_wasm_bg.wasm',import.meta.url));
 const names=bytes=>WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(e=>e.name);
 assert.ok(names(production).some(n=>n.startsWith('engine_')));
 assert.ok(!names(production).some(n=>n.includes('fixture')||n==='created_document_count'));
 assert.ok(names(qualification).some(n=>n.startsWith('fixture_')));
 assert.ok(names(qualification).includes('created_document_count'));
 const core=await import('../packages/core/dist/index.js');assert.equal(core.initFixture,undefined);
 const fixture=await import('../packages/core/dist/fixture.js');assert.equal(typeof fixture.initFixture,'function');
});

test('visible direct async glue import must resolve inside the packed graph',()=>{const graph=packedGraph();graph['node_modules/@edit-ac/core/dist/index.js']='import("./wasm/editac_wasm.js")';assert.throws(()=>auditTaskGraph(graph),/Uninventoried/);graph['node_modules/@edit-ac/core/dist/wasm/editac_wasm.js']='export default function init(){}';auditTaskGraph(graph);});
