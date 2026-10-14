import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExtensionCommandSession, ModuleRuntime } from '../../packages/web/dist/modules/index.js';
import { packedRuntime, sha256 } from './packed-runtime.mjs';
import { loadSuite } from './fixture-loader.ts';
import { variantStorage } from './variant-storage-harness.mjs';

const output = process.env.EDITAC_EDITING_OUTPUT;
const initial = { blocks: [{ id: 'p1', kind: 'paragraph', text: 'abc', marks: [], hardBreaks: [] }], selection: { anchor: { block: 'p1', offset: 1 }, focus: { block: 'p1', offset: 1 }, affinity: 'forward' }, pendingMarks: null };
const facts = { gate: 'RGS-1.6', fixtureHashes: loadSuite().hashes, cases: [], negativeControls: [], profile: { clockMs: 42000, scheduling: 'post-native-transaction FIFO notifications; ExtensionCommandSession awaited preparation before reentrant mutation', cancellation: 'owned AbortController + revision/capability recheck', persistence: 'production storage with prepared IndexedDB', layer: 'packed WASM/production ModuleRuntime/ExtensionCommandSession' } };
let pack; const originalNow=Date.now;
before(async () => { Date.now=()=>42000; assert.ok(output); await mkdir(output, { recursive: true }); pack = await packedRuntime(process.env.EDITAC_EDITING_PACK_TARBALL); });
after(async () => {
  Date.now=originalNow; if (pack) { await pack.close(); facts.runtime = pack.facts; }
  facts.profileSha256 = sha256(JSON.stringify(facts.profile)); facts.sourceHashes = {};
  for (const p of ['tests/editing/failure-injection.test.mjs', 'tests/editing/variant-storage-harness.mjs', 'tests/editing/storage-harness.mjs', 'tests/editing/replica-state.mjs', 'tests/helpers/journal-storage.mjs', 'tests/editing/semantic-adapter.ts', 'tests/editing/packed-runtime.mjs', 'scripts/test-editing.mjs', 'scripts/editing-suites.mjs', ...['modules/runtime','modules/conformance','storage/index','storage/writer','storage/journal'].flatMap(p => [`packages/web/src/${p}.ts`, `packages/web/dist/${p}.js`]), 'packages/core/src/engine.ts', 'packages/core/dist/engine.js']) facts.sourceHashes[p] = sha256(await readFile(p));
  facts.counts = { executed: facts.cases.length, passed: facts.cases.filter(f => f.status === 'passed').length, failed: facts.cases.filter(f => f.status === 'failed').length, skipped: 0, checkpoints: facts.cases.reduce((n,f) => n+f.checkpoints,0), controls: facts.cases.reduce((n,f) => n+f.controls,0) };
  await writeFile(join(output, 'failure-harness.json'), JSON.stringify(facts, null, 2)+'\n');
});
function check(f, actual, expected, label) { assert.deepEqual(actual, expected, label); f.checkpoints++; const corrupt = value => { if (typeof value === 'string') return value+'?'; if (typeof value === 'number') return value+1; if (typeof value === 'boolean') return !value; if (value === null) return {}; if (Array.isArray(value)) return value.length ? [corrupt(value[0]),...value.slice(1)] : ['unexpected']; const keys=Object.keys(value); return keys.length ? {...value,[keys[0]]:corrupt(value[keys[0]])} : {unexpected:true}; }; const wrong = corrupt(structuredClone(expected)); assert.throws(() => assert.deepEqual(actual, wrong), assert.AssertionError); f.controls++; }
function cell(id, run) { test(id, { timeout: 15000 }, async () => {
  const f = { id, status: 'running', checkpoints: 0, controls: 0, trace: [] }; facts.cases.push(f);
  let s, modules, commands;
  try {
    s = await variantStorage(pack.runtime, initial, f, facts); const e = s.engine;const originalNode=e.read().visible[0];
    const host = { active: true, revision: () => JSON.stringify([e.read().identity,e.read().revision]), can: r => e.can(r), commit: r => { e.history({type:'explicit'}); const p=e.prepare(r); try { return s.commit(p); } finally { e.releasePlan(p); e.history({type:'boundary'}); } } };
    commands = new ExtensionCommandSession(host); modules = new ModuleRuntime(e);
    const request = (text='X', at=1) => ({ kind:'editor', origin:'rgs:failure', commands:[{type:'replaceAt',owner:s.driver.ids.get('p1'),from:at,to:at,text}] });
    await run({s,e,host,commands,modules,request,f});
    const node=e.read().visible[0];check(f,node.id,originalNode.id,'retained semantic owner');check(f,node.spans.map(s=>[s.source,s.identity]),originalNode.spans.map(s=>[s.source,s.identity]),'retained source identities');check(f,node.blockAttributes,['paragraph']);check(f,node.runs.map(r=>r.attributes),node.runs.map(()=>({})));check(f, e.takeObserverErrors(), [], 'no hidden engine callback failure'); f.status='passed';
  } catch(error) { f.status='failed'; f.error=error.stack; throw error; }
  finally { commands?.dispose(); modules?.dispose(); if(s) f.teardown=await s.close(); await writeFile(join(output,id+'.json'),JSON.stringify(f,null,2)+'\n'); }
}); }
const text = e => e.read().visible.map(n=>n.runs.map(r=>r.text).join(''));
const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
function release(e,r) { for(const a of new Set([r.caret,r.selection?.anchor,r.selection?.focus].filter(Boolean))) e.releaseAnchor(a); }
cell('G02-final-prepare-failure', async ({s,e,request,commands,f}) => {
  const before=s.driver.frozen(), bad=request('lost'); bad.commands.push({type:'markAt',owner:s.driver.ids.get('p1'),from:0,to:999,mark:'bold',action:'apply'});
  assert.throws(()=>e.prepare(bad),error=>{f.finalPrepareFailure={code:error.code,operation:error.operation};return error.operation==='prepare'&&typeof error.code==='string'&&error.code!=='Disposed';});f.checkpoints++;check(f,(await commands.run(()=>bad)).status,'unavailable'); check(f,s.driver.frozen(),before); await s.verifyStep('final-rejection',0);
  const r=await commands.run(()=>request()); check(f,r.status,'committed'); release(e,r.result); check(f,text(e),['aXbc']); await s.verifyStep('valid-retry',1);
});
for(const mode of ['throw','unsubscribe','deferred-command','destroy','queued-destroy']) cell('REG-12-'+mode, async ({s,e,request,commands,modules,host,f}) => {
  let nested, once=false, second=0, depth=0,maxDepth=0; const order=[]; let later; const gate=deferred();
  const sub=modules.subscribe({},event=>{ depth++;maxDepth=Math.max(maxDepth,depth);order.push('first');
    try { check(f,text(e),once?['aXbcY']:['aXbc']); check(f,e.read().revision,event.patch.revision); e.checkpoint();
      if(!once) { once=true;
        if(mode==='throw') throw Error('intentional subscriber failure');
        if(mode==='unsubscribe') { sub.dispose(); later.dispose(); }
        if(mode==='deferred-command') { nested=commands.run(async()=>{await gate.promise;return request('Y',4);}); check(f,text(e),['aXbc'],'deferred command has not mutated within callback'); }
        if(mode==='queued-destroy') nested=commands.run(()=>request('lost',4));
        if(mode==='destroy'||mode==='queued-destroy') { commands.dispose(); modules.dispose(); host.active=false; }
      }
    } finally { depth--; }
  });
  later=modules.subscribe({},()=>{order.push('second');second++;});
  // A synchronous host commit is complete before observers run. The command
  // session is idle so its queued request owns the next dispatcher turn.
  const r=host.commit(request()); release(e,r); check(f,text(e),['aXbc']);
  await s.verifyStep('first-durable-commit',1);
  if(mode==='deferred-command') { gate.resolve(); const next=await nested;check(f,next.status,'committed');release(e,next.result); await s.verifyStep('deferred-second-commit',1);check(f,text(e),['aXbcY']);check(f,order,['first','second','first','second']); }
  else { if(mode==='queued-destroy') check(f,(await nested).status,'cancelled');await s.verifyStep('no-duplicate',0);check(f,text(e),['aXbc']);check(f,second,mode==='throw'?1:0); }
  check(f,maxDepth,1);check(f,modules.takeErrors().map(x=>x.phase),mode==='throw'?['subscription']:[]);
  check(f,e.history({type:'state'}).undoGroups,mode==='deferred-command'?2:1);
});
for(const mode of ['cancel','dispose','session-replaced','superseded','target-revised','provider-error']) cell('G11-'+mode, async ({s,e,host,commands,request,f}) => {
  const pending=deferred(),before=s.driver.frozen(); let signal;
  const result=commands.run(s=>{signal=s;return pending.promise;});
  let expected='cancelled';
  if(mode==='cancel') commands.cancel();
  if(mode==='dispose') commands.dispose();
  if(mode==='session-replaced') host.active=false;
  if(mode==='superseded') { const r=await commands.run(()=>request('N'));release(e,r.result);await s.verifyStep('new-generation',1); }
  if(mode==='target-revised') { const r=host.commit(request('R'));release(e,r);await s.verifyStep('independent-target-revision',1);expected='stale'; }
  if(mode==='provider-error') { pending.reject(Error('prepared provider failure'));expected='failed'; } else pending.resolve(request('lost'));
  check(f,(await result).status,expected); await s.verifyStep('late-completion-zero-effect',0);
  if(['cancel','dispose','superseded'].includes(mode)) check(f,signal.aborted,true);
  if(['superseded','target-revised'].includes(mode)) check(f,text(e),[mode==='superseded'?'aNbc':'aRbc']);else check(f,s.driver.frozen(),before);
  check(f,e.history({type:'state'}).undoGroups,['superseded','target-revised'].includes(mode)?1:0);
});
