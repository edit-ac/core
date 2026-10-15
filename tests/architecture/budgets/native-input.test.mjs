import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, verifyPins } from '../../../scripts/architecture-budgets.mjs';
import { inspectNativeInput } from '../../../scripts/native-input-evidence.mjs';
const root = fileURLToPath(new URL('../../../',import.meta.url));
const read = p => readFile(resolve(root,p));
const profileBytes = await read('benchmarks/profiles/native-input-v1.json'), profile = JSON.parse(profileBytes);
const index = JSON.parse(await read('benchmarks/profiles/native-input-evidence.json'));
assert.match(index.directory,/^architecture-results\/fit-1\.8-[a-z0-9/-]+$/); assert(!index.directory.includes('..'));
const bytes = await read(index.directory+'/receipt.json'), receipt = JSON.parse(bytes);
const result = JSON.parse(await read(index.directory+'/native-result.json'));
const accessibility = JSON.parse(await read(index.directory+'/accessibility.json'));
let observations;
test('native OS keyboard, accessibility client, semantic preservation and display callbacks admit exact target runtime artifacts', async () => {
  assert.equal(digest(bytes), index.receiptHash); assert.equal(digest(profileBytes),receipt.profileHash);
  const fitness = JSON.parse(await read('benchmarks/profiles/fitness-v1.json'));
  assert.equal(profile.limits.inputVisiblePhoneMs,fitness.limits.phone['input-visible']);
  await verifyPins(root,receipt.sourceInputs);
  await verifyPins(resolve(root,index.directory),receipt.artifacts);
  assert.equal(receipt.sourceInputs['benchmarks/profiles/native-input-v1.json'],digest(profileBytes));
  for (const p of ['tests/native/ios-fitness.py','native/ios/fitness/NativeFitness.swift','native/ios/fitness/NativeFitnessUITests.swift']) {
    assert.equal(receipt.sourceInputs[p],digest(await read(p))); assert.equal(receipt.artifacts['sources/'+p],receipt.sourceInputs[p]);
  }
  for (const p of ['native-result.json','accessibility.json','NativeFitness','xcresult-summary.log']) assert(receipt.artifacts[p]);
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
  'missing driver response': (r,n,a) => a.driverSamples.pop(),
  'corrupted intermediate accessibility source': (r,n,a) => a.driverSamples[0].value+='x',
  'invented screen reader': (r,n,a) => a.screenReader='qualified',
  'accessibility source mismatch': (r,n,a) => a.value='different'
};
for (const [name,mutate] of Object.entries(mutations)) test('native admission rejects '+name,()=>{
  const r=structuredClone(receipt),n=structuredClone(result),a=structuredClone(accessibility); mutate(r,n,a);
  assert.throws(()=>inspectNativeInput(profile,r,n,a));
});
test('native diagnostic cannot lower tail bar or reduce the fixed scenario',()=>{
  for (const mutate of [p=>p.minimumTailSamples=12,p=>p.samples=1,p=>p.features.pop(),p=>p.typed='a',p=>p.runtimeBuildVersion='mock']) {
    const p=structuredClone(profile); mutate(p); assert.throws(()=>inspectNativeInput(p,receipt,result,accessibility));
  }
});
after(async()=>{if(process.env.EDITAC_ARCHITECTURE_OUTPUT) await writeFile(resolve(process.env.EDITAC_ARCHITECTURE_OUTPUT,'native-input-inventory.json'),JSON.stringify({version:1,parent:'FIT-1.8',receiptHash:index.receiptHash,observations},null,2));});
