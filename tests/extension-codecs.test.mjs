import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '@edit-ac/core';
import { initMarkdown } from '@edit-ac/markdown';
import { ModuleRegistry, prepareModuleMigration, canonicalSemanticJson, prepareExtensionSource } from '@edit-ac/web/modules';
import { ClipboardInput, FRAGMENT_MIME } from '../packages/web/dist/clipboard/fragment.js';

const corpus=JSON.parse(await readFile(new URL('../fixtures/extensions/versions/conformance.json',import.meta.url),'utf8'));
const output=process.env.EDITAC_EXTENSION_CODECS_OUTPUT;
assert(output,'unique worktree-owned EDITAC_EXTENSION_CODECS_OUTPUT required; run Rust harness first');
let runtime,codec,rustMigrations,rustCodecs,rustSource,created=0;
const results=[];
const semantic=e=>e.read().visible.filter(n=>n.kind==='block').map(n=>({blockAttributes:n.blockAttributes,runs:n.runs}));
const dataUrl=async file=>'data:application/wasm;base64,'+(await readFile(new URL(file,import.meta.url))).toString('base64');
before(async()=>{
  runtime=await init(await dataUrl('../packages/core/dist/wasm/editac_wasm_bg.wasm'));
  codec=await initMarkdown(await dataUrl('../packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm'));
  rustMigrations=JSON.parse(await readFile(join(output,'rust-migrations.json'),'utf8'));
  rustCodecs=JSON.parse(await readFile(join(output,'rust-codecs.json'),'utf8'));
  rustSource=JSON.parse(await readFile(join(output,'rust-source.json'),'utf8'));
});
after(async()=>{await writeFile(join(output,'web-results.json'),canonicalSemanticJson(results)+'\n');});
async function restore(name) {
  const meta=JSON.parse(await readFile(join(output,name+'.json'),'utf8'));
  return runtime.restoreEngine(meta.identity,{identity:meta.identity,initialized:true,writerId:meta.writerId,bytes:new Uint8Array(await readFile(join(output,name+'.bin')))});
}
function blank(){const suffix=String(++created).padStart(12,'0');return runtime.createEngine({profile:'v5',documentId:`71000000-0000-4000-8000-${suffix}`,epoch:`72000000-0000-4000-8000-${suffix}`,nodes:[{text:''}]});}
function commitBlocks(engine,blocks){
  const node=engine.read().visible.find(n=>n.kind==='block');const range={anchor:engine.anchor(node.id,0,'right'),focus:engine.anchor(node.id,0,'left')};
  try { const plan=engine.prepare({kind:'fragment',origin:'extension-codec:fixture',range,blocks});engine.commit(plan); }
  finally {engine.releaseAnchor(range.anchor);engine.releaseAnchor(range.focus);}
}
function copy(engine){
  const nodes=engine.read().visible.filter(n=>n.kind==='block'&&!(n.blockAttributes?.[0]==='paragraph'&&n.runs.every(r=>r.text.length===0)));let released=0;
  const range={anchor:engine.anchor(nodes[0].id,0,'right'),focus:engine.anchor(nodes.at(-1).id,nodes.at(-1).runs.reduce((n,r)=>n+r.text.length,0),'left')};
  const selection={retain:()=>({range,dispose(){released++;engine.releaseAnchor(range.anchor);engine.releaseAnchor(range.focus);}})};
  const clipboard=new ClipboardInput({},selection,engine,()=>{throw Error('copy cannot commit');},()=>false);
  const data=new Map();try {const result=clipboard.copy({getData:m=>data.get(m)??'',setData:(m,v)=>data.set(m,v)});assert.equal(result.disposition,'handled');assert.equal(released,1);return {data,diagnostics:[...clipboard.diagnostics]};}finally{clipboard.dispose();}
}
for(const fixture of corpus.migrationCases)test('candidate migration: '+fixture.id,async()=>{
  const engine=await restore('new-epoch');try{
    const before=engine.checkpoint(),revision=engine.read().revision,input=structuredClone(fixture.envelope);let calls=0,result,outcome='prepared';
    try{result=prepareModuleMigration(corpus.evolution,input,'é😀',fixture.target,attrs=>{
      calls++;if(fixture.mode==='fail')throw Error('prepared failure');if(fixture.mode==='invalid')return {wrong:'value'};
      if(fixture.mode==='oversized')return {title:'x'.repeat(129)};return {title:attrs.label};
    });}catch(error){outcome=error.code;}
    assert.equal(outcome,fixture.expected);assert.deepEqual(input,fixture.envelope);
    if(result){assert.equal(canonicalSemanticJson(result.source),canonicalSemanticJson(input));assert.equal(canonicalSemanticJson(result.candidate),canonicalSemanticJson([2,{title:'é😀'}]));assert.equal(result.admission,'host-prepared-edit-or-explicit-new-epoch');assert(Object.isFrozen(result.candidate));result=undefined;}
    assert.deepEqual(engine.checkpoint(),before);assert.equal(engine.read().revision,revision);
    const observation={id:fixture.id,outcome,calls};assert.deepEqual(observation,rustMigrations.find(r=>r.id===fixture.id));results.push(observation);
  }finally{engine.dispose();}
});
for(const fixture of corpus.codecCases)test('owning codec, actual WASM paste/copy/export: '+fixture.id,async()=>{
  const engine=blank(),restored=await restore(fixture.id);let pasted;
  try{
    let calls=0;const counted={importMarkdown(...args){calls++;return codec.importMarkdown(...args);},exportMarkdown:codec.exportMarkdown};
    const prepared=prepareExtensionSource(counted,fixture.source,fixture.options,fixture.literal??false);
    assert.equal(prepared.source,fixture.source);assert.equal(calls,fixture.literal?0:1);
    const before=engine.checkpoint();engine.validateFragment(JSON.stringify({version:1,schema:engine.read().identity.schema,blocks:prepared.blocks}));assert.deepEqual(engine.checkpoint(),before);
    commitBlocks(engine,prepared.blocks);const rust=rustCodecs.find(r=>r.id===fixture.id);assert.deepEqual(semantic(engine),rust.semantic);assert.deepEqual(semantic(restored),rust.semantic);
    const copied=copy(engine);assert(copied.data.has(FRAGMENT_MIME),copied.diagnostics.join(','));const fragment=JSON.parse(copied.data.get(FRAGMENT_MIME));assert(copied.diagnostics.every(d=>d==='unsupported-html-export'),copied.diagnostics.join(','));
    const exported=codec.exportMarkdown(fragment.blocks);assert.equal(exported.markdown,rust.markdown);assert.deepEqual(exported.diagnostics.map(d=>d.code),rust.diagnostics);if(fixture.lossless)assert.equal(exported.recovery.length,0);else assert.deepEqual(exported.recovery,fragment.blocks);
    pasted=blank();commitBlocks(pasted,fragment.blocks);assert.deepEqual(semantic(pasted),semantic(engine));
    if(fixture.lossless){const reparsed=codec.importMarkdown(exported.markdown,fixture.options);assert.deepEqual(codec.exportMarkdown(reparsed.blocks),exported);}else{const recovery=blank();try{commitBlocks(recovery,exported.recovery);assert.deepEqual(semantic(recovery),semantic(engine));}finally{recovery.dispose();}}
    results.push({id:fixture.id,outcome:'copied-exported',semantic:semantic(engine)});
  }finally{pasted?.dispose();restored.dispose();engine.dispose();}
});
for(const fixture of corpus.opaqueCases)test('actual Rust source reconciliation to WASM opaque retention: '+fixture.id,async()=>{
  const engine=await restore(fixture.id);let restored;
  try{
    const rust=rustSource.find(r=>r.id===fixture.id);assert.deepEqual(semantic(engine),rust.semantic);
    const nodes=engine.read().visible.filter(n=>n.kind==='block');const opaque=structuredClone(nodes[1]);assert.equal(opaque.id,rust.owner);
    engine.commit(engine.prepare({kind:'editor',origin:'extension-codec:elsewhere',commands:[{type:'replaceAt',owner:nodes[0].id,from:0,to:0,text:'elsewhere ' }]}));
    assert.deepEqual(engine.read().visible.find(n=>n.id===opaque.id),opaque);
    const registry=new ModuleRegistry().freeze();registry.validate(engine.read().visible);const before=engine.checkpoint();
    // No richer copy support is invented for future tuples/attributes.
    const range={anchor:engine.anchor(opaque.id,0,'right'),focus:engine.anchor(opaque.id,opaque.runs.reduce((n,r)=>n+r.text.length,0),'left')};
    try{assert.throws(()=>engine.prepare({kind:'fragment',origin:'extension-codec:unsafe',range,blocks:[{attributes:{type:'content',tuple:['vendor:future',99,{source:'changed'}]},runs:[]}]}));}
    finally{engine.releaseAnchor(range.anchor);engine.releaseAnchor(range.focus);}
    assert.deepEqual(engine.checkpoint(),before);
    restored=runtime.restoreEngine(before.identity,before);assert.deepEqual(semantic(restored),semantic(engine));
    results.push({id:fixture.id,outcome:'preserved',owner:opaque.id});
  }finally{restored?.dispose();engine.dispose();}
});
test('actual owning new-epoch migration rejects delayed old offline update before mutation',async()=>{
  const engine=await restore('new-epoch');try{
    const old=JSON.parse(await readFile(join(output,'old-epoch.json'),'utf8'));const bytes=new Uint8Array(await readFile(join(output,'old-epoch.bin')));const before=engine.checkpoint(),revision=engine.read().revision;
    assert.throws(()=>engine.applyUpdate({identity:old.identity,bytes}),error=>error.code==='EngineRejected'&&/WrongEpoch/.test(error.message));
    assert.deepEqual(engine.checkpoint(),before);assert.equal(engine.read().revision,revision);
    results.push({id:'delayed-old-epoch',outcome:'rejected'});
  }finally{engine.dispose();}
});
test('declaration validation and unsafe callback output invoke no code and admit no partial data',()=>{
  const e=corpus.evolution;
  for(const transitions of [[{from:1,to:1}],[{from:1,to:99}],[{from:1,to:2},{from:1,to:2}]])assert.throws(()=>prepareModuleMigration({...e,transitions},[1,{label:'x'}],'x',2,()=>{throw Error('not invoked');}),error=>error.code==='invalid-evolution');
  assert.throws(()=>prepareModuleMigration({...e,reads:[...e.reads,e.reads[0]]},[1,{label:'x'}],'x',2,()=>({title:'x'})),error=>error.code==='invalid-evolution');
  for (const declaration of [
    {...e,reads:[]}, {...e,reads:Array(33).fill(e.reads[0])},
    {...e,transitions:Array(33).fill({from:1,to:2})},
    {...e,reads:[e.reads[0],{...e.reads[1],kind:'mark'}]},
    {...e,reads:[e.reads[0],{...e.reads[1],type:'other.badge'}]},
  ]) assert.throws(()=>prepareModuleMigration(declaration,[1,{label:'x'}],'x',2,()=>{throw Error('not invoked');}), error=>error.code==='invalid-evolution');
  const source=[1,{label:'x'}], attributes={title:'x'};
  const prepared=prepareModuleMigration(e,source,'x',2,()=>attributes);
  attributes.title='later';source[1].label='later';
  assert.equal(prepared.source[1].label,'x');assert.equal(prepared.candidate[1].title,'x');
  assert(!Object.isFrozen(source));assert(!Object.isFrozen(attributes));
  assert.throws(()=>prepareModuleMigration(e,[1,{label:'x'}],'x',2,attrs=>{attrs.label='changed';return {title:'x'};}), error=>error.code==='migration-failed');
  let calls=0;const candidate={};Object.defineProperty(candidate,'title',{enumerable:true,get(){calls++;return 'x';}});
  assert.throws(()=>prepareModuleMigration(e,[1,{label:'x'}],'x',2,()=>candidate),error=>error.code==='invalid-definition');assert.equal(calls,0);
  const attrs={title:'x',execute(){calls++;}};assert.throws(()=>prepareModuleMigration(e,[1,{label:'x'}],'x',2,()=>attrs),error=>error.code==='invalid-definition');assert.equal(calls,0);
  assert.throws(()=>prepareExtensionSource(codec,'x'.repeat(1_048_577),{},true),RangeError);
});
test('trusted custom source hooks retain lossless and failed/unsafe export recovery',()=>{
  const hooks=[{name:'badge',prepare:p=>p.source.startsWith('[badge] ')?[{attributes:{type:'heading',level:2},runs:[{text:p.source.slice(8),marks:[{mark:'bold'}]}]}]:undefined,serialize:blocks=>blocks[0]?.attributes?.type==='heading'?'[badge] '+blocks[0].runs.map(r=>r.text).join(''):undefined}];
  const p=prepareExtensionSource(codec,'[badge] é😀',{extensions:hooks});assert.equal(p.source,'[badge] é😀');const e=codec.exportMarkdown(p.blocks,{extensions:hooks});assert.equal(e.markdown,p.source);assert.deepEqual(e.recovery,[]);
  const lossy=codec.exportMarkdown(p.blocks,{extensions:[{name:'lossy',serialize:()=> 'changed'}]});assert.equal(lossy.diagnostics[0].code,'extension-unrepresentable');assert.deepEqual(lossy.recovery,p.blocks);
  assert.throws(()=>prepareExtensionSource(codec,'exact source',{extensions:[{name:'unsafe',prepare:()=>[{attributes:{type:'content',tuple:['vendor:unknown',99,'source']},runs:[]}]}]}));
});
test('fixed manifest has complete nonzero matching Rust/web coverage',()=>{
  assert.equal(corpus.migrationCases.length,12);assert.equal(corpus.codecCases.length,7);assert.equal(corpus.opaqueCases.length,4);
  assert.equal(rustMigrations.length,12);assert.equal(rustCodecs.length,7);assert.equal(rustSource.length,4);assert.equal(results.length,24);
  assert.equal(new Set(results.map(r=>r.id)).size,24);
});

test('actual reference clipboard keeps identity and Markdown reports recoverable loss',async()=>{
  const engine=await restore('reference-recovery');try{
    const rust=JSON.parse(await readFile(join(output,'rust-reference.json'),'utf8'));assert.deepEqual(semantic(engine),rust.semantic);
    // A reference retains its qualified label text and structured fragment through
    // the owning codec, rather than interpreting a label as its identity.
    const copied=copy(engine);assert(copied.data.has(FRAGMENT_MIME));assert.equal(copied.diagnostics.length,0);
    const blocks=JSON.parse(copied.data.get(FRAGMENT_MIME)).blocks;
    assert.equal(blocks[0].attributes.tuple[2].targetId,'host:unknown/😀');
    const pasted=blank();try{commitBlocks(pasted,blocks);assert.deepEqual(semantic(pasted),semantic(engine));}finally{pasted.dispose();}
    engine.validateFragment(JSON.stringify({version:1,schema:engine.read().identity.schema,blocks}));
    const before=engine.checkpoint(),exported=codec.exportMarkdown(blocks);
    assert.equal(exported.markdown,rust.markdown);assert.equal(exported.diagnostics[0].code,rust.diagnostic);assert.deepEqual(exported.recovery,blocks);assert.deepEqual(engine.checkpoint(),before);
  }finally{engine.dispose();}
});
