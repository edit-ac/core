import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '@edit-ac/core';
import { ModuleRegistry, canonicalSemanticJson, runDescriptorFixture, projectExtensionNodes } from '@edit-ac/web/modules';

const corpus = JSON.parse(await readFile(new URL('../fixtures/extensions/conformance.json', import.meta.url), 'utf8'));
const output = process.env.EDITAC_EXTENSION_CONTRACT_OUTPUT;
assert(output, 'set unique worktree-owned EDITAC_EXTENSION_CONTRACT_OUTPUT; run the Rust harness first');
const admitted = corpus.cases.filter(c => ['known','opaque','preserved'].includes(c.expected));
let runtime, identity, rustResults, rustProjections;
const results = [], projections = {};
before(async () => {
  await mkdir(output, {recursive:true});
  rustResults = JSON.parse(await readFile(join(output,'rust-results.json'), 'utf8'));
  rustProjections = JSON.parse(await readFile(join(output,'rust-projections.json'), 'utf8'));
  identity = JSON.parse(await readFile(join(output,'identity.json'), 'utf8'));
  const bytes = await readFile(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
  runtime = await init('data:application/wasm;base64,'+bytes.toString('base64'));
});
after(async () => {
  await writeFile(join(output,'web-results.json'),canonicalSemanticJson(results)+'\n');
  await writeFile(join(output,'web-projections.json'),canonicalSemanticJson(projections)+'\n');
});
for (const fixture of corpus.cases) test('descriptor cell: '+fixture.id, () => {
  const before = JSON.stringify(fixture);
  const result = runDescriptorFixture(corpus.definitions, fixture);
  assert.equal(result.outcome,fixture.expected,fixture.id);
  assert.equal(JSON.stringify(fixture),before,'inspection is nonmutating');
  const rust = rustResults.find(r => r.id===fixture.id);
  assert.deepEqual(result,rust,'Rust/web canonical semantic result');
  assert.equal(canonicalSemanticJson(result),canonicalSemanticJson(JSON.parse(JSON.stringify(result))), 'deterministic serialization');
  results.push(result);
});
for (const fixture of admitted) test('real Rust to WASM checkpoint recovery: '+fixture.id, async () => {
  const checkpoint={identity,initialized:true,writerId:11,bytes:new Uint8Array(await readFile(join(output,fixture.id+'.bin')))};
  const engine=runtime.restoreEngine(identity,checkpoint);
  let restored;
  try {
    const before=engine.checkpoint();const snapshot=engine.read();
    const registry=new ModuleRegistry();
    if (!fixture.disabled) for (const d of corpus.definitions) registry.register(d);
    registry.freeze();
    const nodes=snapshot.visible.filter(n=>n.id==='n:11:1');
    assert.equal(nodes.length,1);
    const projection=projectExtensionNodes(registry,nodes)[0];
    assert.deepEqual(projection,rustProjections[fixture.id]);
    assert.deepEqual(projection.runs,[fixture.run ?? {text:fixture.text,attributes:{}}]);
    if (fixture.category==='block') assert.deepEqual(projection.blockAttributes,fixture.blockAttributes);
    assert.deepEqual(engine.checkpoint(),before,'inspection and absent presenters never mutate');
    restored=runtime.restoreEngine(identity,before);
    assert.deepEqual(projectExtensionNodes(registry,restored.read().visible.filter(n=>n.id==='n:11:1')),[projection]);
    projections[fixture.id]=projection;
  } finally {restored?.dispose();engine.dispose();engine.dispose();}
});
test('semantic serialization ignores object insertion order without executing code', () => {
  assert.equal(canonicalSemanticJson({z:[{b:2,a:1}],a:'😀'}),canonicalSemanticJson({a:'😀',z:[{a:1,b:2}]}));
  let calls=0;
  const value={};Object.defineProperty(value,'x',{enumerable:true,get(){calls++;throw Error('executed');}});
  assert.throws(()=>canonicalSemanticJson(value),TypeError);assert.equal(calls,0);
  assert.throws(()=>canonicalSemanticJson({execute(){calls++;}}),TypeError);
  const cycle={};cycle.self=cycle;assert.throws(()=>canonicalSemanticJson(cycle),TypeError);
  assert.equal(calls,0);
  const array=[1];array[Symbol('hidden')]=()=>calls++;assert.throws(()=>canonicalSemanticJson(array),TypeError);
});
test('disabled presenters and hostile descriptors invoke no host callbacks', () => {
  let calls=0;const d={...corpus.definitions[0]};
  Object.defineProperty(d,'version',{enumerable:true,get(){calls++;return 1;}});
  assert.equal(runDescriptorFixture([], {id:'getter',category:'descriptor',definition:d}).outcome,'invalid-definition');
  assert.equal(runDescriptorFixture([], {id:'callback',category:'descriptor',definition:{...corpus.definitions[0],execute(){calls++;}}}).outcome,'invalid-definition');
  assert.equal(calls,0);
  const r=new ModuleRegistry().register(corpus.definitions[0]).freeze();
  const run=corpus.cases.find(c=>c.id==='disabled-renderer').run;
  assert.equal(r.resolve('module:demo.highlight',run.attributes['module:demo.highlight'],run.text).presentation,undefined);
});
test('cell manifest and artifacts have complete nonzero coverage', () => {
  assert.equal(corpus.cases.length,44);assert.equal(new Set(corpus.cases.map(c=>c.id)).size,44);
  assert.equal(results.length,44);assert.equal(rustResults.length,44);
  assert.equal(admitted.length,13);assert.equal(Object.keys(projections).length,13);assert.equal(Object.keys(rustProjections).length,13);
  assert.deepEqual(Object.keys(corpus.transientBuiltins).sort(),['reorder','slash']);
  assert.equal(corpus.definitions.some(d=>d.type==='editac.math'),true);
});
