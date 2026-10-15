import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
import { inspectNativeInput, inspectNativeCJK, inspectNativeBuild, inspectNativeWorkload } from '../../../scripts/native-input-evidence.mjs';
const root = fileURLToPath(new URL('../../../',import.meta.url));
const read = p => readFile(resolve(root,p));
const profileBytes = await read('benchmarks/profiles/native-input-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/native-input-evidence.json'));
assert.match(index.directory,/^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(index.directory+'/receipt.json'), receipt = JSON.parse(bytes);
const result = JSON.parse(await read(index.directory+'/native-result.json'));
const accessibility = JSON.parse(await read(index.directory+'/accessibility.json'));
const cjk = JSON.parse(await read(index.directory+'/cjk-result.json'));
const cjkAX = JSON.parse(await read(index.directory+'/cjk-accessibility.json'));
let observations, cjkObservations;
const workloadObservations=[];
const nativeBuild = Object.fromEntries(await Promise.all([
  ['graph','native-target-graph.log'],['rustc','native-rustc.log'],['library','libeditac_ffi.a'],['app','NativeFitness']
].map(async([key,path])=>[key,await read(index.directory+'/'+path)])));
test('fresh native execution binds actual current target features, compiler and rebuilt library/app',async()=>{
  const cargo=spawnSync(resolve(homedir(),'.cargo/bin/cargo'),['+1.97.1','tree','--locked','--offline','--target','aarch64-apple-ios-sim','-p','editac-ffi','--edges','normal,build,features','--prefix','none','--format','{p}|{f}'],{cwd:root,encoding:'utf8'});
  assert.equal(cargo.status,0,cargo.stderr); assert.equal(cargo.stdout,nativeBuild.graph.toString());
  const rustc=spawnSync(resolve(homedir(),'.cargo/bin/rustc'),['+1.97.1','-vV'],{cwd:root,encoding:'utf8'});
  assert.equal(rustc.status,0,rustc.stderr); assert.equal(rustc.stdout,nativeBuild.rustc.toString());
  inspectNativeBuild(receipt,{...nativeBuild,
    library:await read('target/native-fitness/aarch64-apple-ios-sim/release/libeditac_ffi.a'),
    app:await read('target/native-fitness-xcode/Build/Products/Release-iphonesimulator/NativeFitness.app/NativeFitness')});
  const products=resolve(root,'target/native-fitness-xcode/Build/Products/Release-iphonesimulator');
  const appPins=Object.fromEntries(Object.entries(receipt.artifacts).filter(([path])=>path.startsWith('NativeFitness.app/')));
  const appFiles=[];
  for(const path of await readdir(resolve(products,'NativeFitness.app'),{recursive:true})) {
    if((await stat(resolve(products,'NativeFitness.app',path))).isFile()) appFiles.push('NativeFitness.app/'+path);
  }
  assert(appPins['NativeFitness.app/NativeFitness'] && appPins['NativeFitness.app/Info.plist']);
  assert.deepEqual(Object.keys(appPins).sort(),appFiles.sort()); await verifyPins(products,appPins);
  const runtimes=spawnSync('xcrun',['simctl','list','runtimes','-j'],{cwd:root,encoding:'utf8'});
  assert.equal(runtimes.status,0,runtimes.stderr);
  const runtime=JSON.parse(runtimes.stdout).runtimes.find(r=>r.identifier===profile.runtime);
  assert(runtime); assert.deepEqual(receipt.metadata.runtime,Object.fromEntries(['identifier','version','buildversion','isAvailable'].map(k=>[k,runtime[k]])));
});
for (const field of ['graph','rustc','library','app']) test('native build admission rejects changed '+field,()=>{
  assert.throws(()=>inspectNativeBuild(receipt,{...nativeBuild,[field]:Buffer.concat([nativeBuild[field],Buffer.from('changed')])}));
});
for (const [field,value] of [['features','all'],['target','wasm32-unknown-unknown'],['measurementReuse',true]]) test('native build admission rejects changed '+field,()=>{
  const r=structuredClone(receipt); r.nativeBuild[field]=value; assert.throws(()=>inspectNativeBuild(r,nativeBuild));
});
test('native build admission rejects failed build or altered feature command',()=>{
  for (const mutate of [r=>r.checks.find(c=>c.id==='native-target-graph').exit=1,
    r=>r.checks.find(c=>c.id==='native-build').command+=' --all-features',
    r=>delete r.artifacts['native-target-graph-after.log']]) {
    const r=structuredClone(receipt); mutate(r); assert.throws(()=>inspectNativeBuild(r,nativeBuild));
  }
});
for (const path of ['Cargo.toml','Cargo.lock','native/ios/fitness/NativeFitness.swift','native/ios/fitness/NativeFitnessUITests.swift',
  'tests/native/fixtures/bounded-abi.json']) test('native source admission rejects changed '+path,async()=>{
  assert(receipt.sourceInputs[path]); await assert.rejects(verifyPins(root,{[path]:'0'.repeat(64)}));
});
test('native OS keyboard, accessibility client, semantic preservation and display callbacks admit exact target runtime artifacts', async () => {
  assert.equal(digest(bytes), index.receiptHash); assert.equal(digest(profileBytes),receipt.profileHash);
  const fitness = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
  assert.equal(profile.limits.inputVisiblePhoneMs,fitness.limits.phone['input-visible']);
  const sources=['.node-version','scripts/prepare-native-workloads.mjs','benchmarks/fixtures.mjs','crates/editac-ffi/examples/fitness-seed.rs','fixtures/schema-v5/mapping.rs','fixtures/schema-v5/seed.json','benchmarks/profiles/native-input-v1.json','tests/native/ios-fitness.py','native/ios/fitness/NativeFitness.swift',
    'native/ios/fitness/NativeFitnessUITests.swift','tests/native/fixtures/bounded-abi.json','Cargo.toml','Cargo.lock'];
  for (const crate of ['editac-core','editac-ffi','editac-wasm']) {
    sources.push(`crates/${crate}/Cargo.toml`);
    for(const path of await readdir(resolve(root,`crates/${crate}/src`),{recursive:true})) if(path.endsWith('.rs')) sources.push(`crates/${crate}/src/${path}`);
  }
  for(const entry of await readdir(resolve(root,'crates/editac-ffi/generated'),{withFileTypes:true})) if(entry.isFile()) sources.push('crates/editac-ffi/generated/'+entry.name);
  assert.deepEqual(Object.keys(receipt.sourceInputs).sort(),sources.sort());
  await verifyPins(root,receipt.sourceInputs);
  await verifyPins(resolve(root,index.directory),receipt.artifacts);
  for(const [path,hash] of Object.entries(receipt.sourceInputs)) assert.equal(receipt.artifacts['sources/'+path],hash);
  assert.equal(receipt.sourceInputs['benchmarks/profiles/native-input-v1.json'],digest(profileBytes));
  for (const p of ['tests/native/ios-fitness.py','native/ios/fitness/NativeFitness.swift','native/ios/fitness/NativeFitnessUITests.swift']) {
    assert.equal(receipt.sourceInputs[p],digest(await read(p))); assert.equal(receipt.artifacts['sources/'+p],receipt.sourceInputs[p]);
  }
  for (const p of ['native-result.json','accessibility.json','NativeFitness','xcresult-summary.log','cjk-result.json','cjk-accessibility.json','simulator-keyboard-preferences.plist']) assert(receipt.artifacts[p]);
  observations = inspectNativeInput(profile,receipt,result,accessibility);
});
const mutations = {
  'skipped native case': (r,n) => n.counts.skipped++,
  'skipped XCTest': r => r.xctestCounts.skippedTests++,
  'unexecuted XCTest': r => r.checks.find(c=>c.id==='xctest').exit=1,
  'simulator leak': r => r.cleanup.simulatorDeleted=false,
  'physical relabeling': r => r.metadata.physical=true,
  'missing runtime image': r => delete r.metadata.runtime,
  'wrong runtime': r => r.metadata.simulator.runtime='mock',
  'qualification claim': r => r.qualification='qualified',
  'missing sample': (r,n) => n.samples.pop(),
  'missing geometry': (r,n) => delete n.samples[0].caretRect,
  'missing keyboard': (r,n) => n.keyboards=[],
  'missing frame': (r,n) => n.frames=[],
  'reversed response': (r,n) => n.samples[0].frameCallbackAt=0,
  'source corruption': (r,n) => n.cases[2].observed.after+='x',
  'missing thermal': (r,n) => delete n.host.thermalStart,
  'unbounded replacement': (r,n) => n.samples[0].replacementUtf16=100,
  'missing input locale': (r,n) => n.samples[0].inputMode='unavailable',
  'lost native focus during commit': (r,n) => n.samples[0].firstResponderBeforeAndAfterCommit=false,
  'lost native focus before display callback': (r,n) => n.samples[0].firstResponderAtFrame=false,
  'missing driver response': (r,n,a) => a.driverSamples.pop(),
  'corrupted intermediate accessibility source': (r,n,a) => a.driverSamples[0].value+='x',
  'invented screen reader': (r,n,a) => a.screenReader='qualified',
  'accessibility source mismatch': (r,n,a) => a.value='different'
};
for (const [name,mutate] of Object.entries(mutations)) test('native admission rejects '+name,()=>{
  const r=structuredClone(receipt),n=structuredClone(result),a=structuredClone(accessibility); mutate(r,n,a);
  assert.throws(()=>inspectNativeInput(profile,r,n,a));
});
test('OS Pinyin candidate composition, commit, cancellation and accessibility geometry admit exact native artifacts',()=>{
  cjkObservations=inspectNativeCJK(profile,receipt,cjk,cjkAX);
});
const cjkMutations={
  'missing marked input':(r,n)=>n.compositionEvents=n.compositionEvents.filter(e=>!e.marked),
  'wrong keyboard':(r,n)=>n.compositionEvents[0].inputMode='en-US',
  'marked text commits early':(r,n)=>n.compositionEvents.find(e=>e.marked).committedAfter+='x',
  'missing marked geometry':(r,n)=>delete n.compositionEvents.find(e=>e.marked).markedRect,
  'missing cancellation':(r,n)=>n.cases[2].observed.after='different',
  'missing CJK checkpoint':(r,n)=>n.cases[4].observed.text='different',
  'missing CJK frame':(r,n)=>n.frames=[],
  'reversed CJK callback':(r,n)=>n.samples[0].frameCallbackAt=0,
  'missing CJK thermal':(r,n)=>delete n.host.thermalStart,
  'skipped CJK case':r=>r.cjkCounts.skipped++,
  'wrong selected candidate':(r,n,a)=>a.candidate.label='好',
  'absent candidate geometry':(r,n,a)=>delete a.candidate.frame,
  'unhittable candidate':(r,n,a)=>a.candidate.hittable=false,
  'missing candidate source':(r,n,a)=>a.committed='different',
  'missing composition AX query':(r,n,a)=>a.keys.pop(),
  'composition AX source corruption':(r,n,a)=>a.keys[0].source+='n'
};
for(const [name,mutate] of Object.entries(cjkMutations)) test('CJK admission rejects '+name,()=>{
  const r=structuredClone(receipt),n=structuredClone(cjk),a=structuredClone(cjkAX); mutate(r,n,a);
  assert.throws(()=>inspectNativeCJK(profile,r,n,a));
});
test('native diagnostic cannot lower tail bar or reduce the fixed scenario',()=>{
  for (const mutate of [p=>p.minimumTailSamples=12,p=>p.samples=1,p=>p.features.pop(),p=>p.typed='a',p=>p.runtimeBuildVersion='mock']) {
    const p=structuredClone(profile); mutate(p); assert.throws(()=>inspectNativeInput(p,receipt,result,accessibility));
  }
});
after(async()=>{if(process.env.EDITAC_ARCHITECTURE_OUTPUT) await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT,'native-input-inventory.json'),JSON.stringify({version:1,parent:'FIT-1.8',receiptHash:index.receiptHash,observations,cjkObservations,workloadObservations},null,2));});

for (const name of ['Task','Long']) {
  const load=async p=>JSON.parse(await read(index.directory+'/'+p));
  const inputs=[profile,receipt,await load(name+'-result.json'),await load('fixtures/'+name+'.json'),
    await load('fixtures/'+name+'.native-snapshot.json'),await load(name+'-final-snapshot.json'),await load(name+'-reopened-snapshot.json'),
    await read(index.directory+'/'+name+'-checkpoint.bin'),await load(name+'-checkpoint-metadata.json')];
  test(name+' full native workload, exact restoration and raw resource envelope',()=>{
    workloadObservations.push(inspectNativeWorkload(...inputs));
  });
  const mutations={
    'source loss':v=>v[5].visible.pop(),
    'reopen mismatch':v=>v[6].visible.pop(),
    'skipped workload':v=>v[2].counts.skipped++,
    'missing sample':v=>v[2].samples.pop(),
    'missing resources':v=>v[2].resources.pop(),
    'failed memory probe':v=>v[2].resources[0].status=1,
    'broadened mutation':v=>v[2].samples[0].changedBlocks=2,
    'clock reversal':v=>v[2].samples[0].layoutDoneAt=0,
    'false size':v=>v[2].setup.textUtf8Bytes--,
    'lower tail bar':v=>v[0].workloads.minimumTailSamples=12,
    'empty checkpoint':v=>v[7]=Buffer.alloc(0)
  };
  for(const [label,mutate] of Object.entries(mutations)) test(name+' native workload rejects '+label,()=>{
    const copy=structuredClone(inputs); mutate(copy); assert.throws(()=>inspectNativeWorkload(...copy));
  });
}
