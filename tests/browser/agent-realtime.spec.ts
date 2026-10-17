import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserHarness } from './browser-harness.ts';

const owners=new Map();let serial=0;
const sourcePaths=['packages/web/src/host/apply.ts','packages/web/src/host/contract.ts','packages/web/src/host/index.ts',
  'examples/host-mcp/realtime-owner.rs','crates/editac-session/src/edit_service.rs','crates/editac-session/src/session.rs',
  'crates/editac-session/src/receipts.rs','crates/editac-session/src/store/mod.rs','crates/editac-core/src/history.rs',
  'packages/web/src/storage/index.ts','packages/web/src/storage/outbox.ts','packages/web/src/sync/session.ts',
  'packages/web/src/sync/protocol.ts','fixtures/browser-agent-realtime/session.mjs','fixtures/browser-agent-realtime/index.html'];
const {probe}=browserHarness('agent-realtime','fixtures/browser-agent-realtime',{
  autoMount:false,sourcePaths,assertSourcesUnchanged:true,
  async beforeNavigate(page,fact){
    page.setDefaultTimeout(5000);
    const directory=join(process.env.EDITAC_AGENT_REALTIME_OUTPUT,`owner-${++serial}`);await mkdir(directory,{recursive:true});
    const executable=resolve('target/debug/examples/host-realtime-owner');
    const child=spawn(executable,[join(directory,'host.sqlite3')],{stdio:['pipe','pipe','pipe']});
    const exit=once(child,'exit');const waiting=[];const transcript=[];let errors='';
    child.stderr.on('data',b=>{errors+=b;});
    createInterface({input:child.stdout}).on('line',line=>waiting.shift()?.(JSON.parse(line)));
    let queue=Promise.resolve();
    const send=input=>{
      const result=queue.then(()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Host RPC timeout: '+input.op)),5000);waiting.push(value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify(input)+'\n');}));
      queue=result.then(async output=>{transcript.push({input,output});await appendFile(join(directory,'steps.log'),input.op+'\n');},()=>{});return result;
    };
    fact.hostOwner={pid:child.pid,executable,directory,transport:'prepared serialized JSON process; no provider',store:'actual SQLite'};
    owners.set(page,async()=>{child.stdin.end();const [code,signal]=await exit;await writeFile(join(directory,'transport.json'),JSON.stringify(transcript,null,2));await writeFile(join(directory,'stderr.log'),errors);fact.hostOwner.exit={code,signal};assert.equal(code,0,errors);});
    await page.exposeFunction('hostRpc',send);
  },
  async cleanup(page){await owners.get(page)?.();owners.delete(page);},
});
const mount=async page=>{await page.waitForFunction(()=>!!window.agentFixture);await page.evaluate(()=>Promise.race([window.agentFixture.mount(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Mount timeout: '+window.agentPhase)),8000))]));};
const state=page=>page.evaluate(()=>window.agentFixture.snapshot());
const prepare=(page,text='A',index=0)=>page.evaluate(([text,index])=>window.agentFixture.prepare(text,index),[text,index]);
const apply=(page,p,id='request-a')=>page.evaluate(([p,id])=>window.agentFixture.apply(p,id),[p,id]);
const push=page=>page.evaluate(()=>window.agentFixture.push());

test('AGT-LIVE-01 durable host apply updates two mounted human views through ordinary patches and storage',()=>probe('live-patches',async(page,fact)=>{
  await mount(page);const before=await state(page),p=await prepare(page);const result=await apply(page,p);
  assert.equal(result.status,'ok');assert.equal(result.data.outcome,'committed');assert.equal(result.data.localDurability,'durable');assert.equal(result.data.remoteDurability,'pending');
  assert.deepEqual((await state(page)).map(v=>v.texts),before.map(v=>v.texts),'MCP receipt is not a content channel');
  await push(page);const after=await state(page);for(const view of after){assert.deepEqual(view.texts,['Abase','other']);assert.deepEqual(view.ids,before[0].ids);assert.match(view.dom,/Abase/);assert.equal(view.retained,true);assert.ok(view.patches.some(p=>p.update));}
  const evidence=await page.evaluate(()=>window.agentFixture.evidence());for(const v of evidence){assert.equal(v.state.pending,0);assert.equal(v.state.saved,true);assert.ok(v.journal.length>0);assert.ok(v.pending.entries.length>0);}
  assert.deepEqual(await page.evaluate(()=>window.agentFixture.reopen()),['Abase','other']);fact.snapshots.push({before,after,result,journals:evidence.map(v=>({entries:v.journal.length,pending:v.pending.entries.length,state:v.state}))});
}));

test('AGT-LIVE-02 human undo never absorbs remote agent edits and each agent request has a distinct history group',()=>probe('history-groups',async(page,fact)=>{
  await mount(page);await page.evaluate(()=>window.agentFixture.human('H'));await page.evaluate(()=>window.agentFixture.humanToHost());
  await apply(page,await prepare(page,'A'),'agent-one');await push(page);await apply(page,await prepare(page,'B'),'agent-two');await push(page);
  const before=await state(page);assert.deepEqual(before[0].texts,['BAbase','Hother']);assert.equal(before[0].history.undoGroups,1);
  const owner=await page.evaluate(()=>window.agentFixture.rpc({op:'state'}));assert.equal(owner.undoGroups,2);
  await page.evaluate(()=>window.agentFixture.undoHuman());assert.deepEqual((await state(page))[0].texts,['BAbase','other']);
  await page.evaluate(()=>window.agentFixture.humanToHost());await page.evaluate(()=>window.agentFixture.rpc({op:'undo'}));await push(page);
  const after=await state(page);for(const v of after){assert.deepEqual(v.texts,['Abase','other']);assert.equal(v.retained,true);}fact.snapshots.push({before,owner,after});
}));

test('AGT-LIVE-03 concurrent independent human and agent changes converge and survive local reopen',()=>probe('concurrent-independent',async(page,fact)=>{
  await mount(page);const p=await prepare(page,'A');await page.evaluate(()=>window.agentFixture.human('H'));
  const result=await apply(page,p);assert.equal(result.data.outcome,'committed');await page.evaluate(()=>window.agentFixture.humanToHost());await push(page);
  const after=await state(page);for(const v of after)assert.deepEqual(v.texts,['Abase','Hother']);
  assert.deepEqual(await page.evaluate(()=>window.agentFixture.reopen()),['Abase','Hother']);fact.snapshots.push({result,after});
}));

test('AGT-LIVE-04 stale overlapping proposal rejects after human publication with human content recoverable',()=>probe('stale-conflict',async(page,fact)=>{
  await mount(page);const p=await prepare(page);await page.evaluate(()=>window.agentFixture.human('H',0));await page.evaluate(()=>window.agentFixture.humanToHost());
  const result=await apply(page,p);assert.equal(result.status,'error');assert.equal(result.code,'unknown-outcome');
  const owner=await page.evaluate(()=>window.agentFixture.rpc({op:'state'}));assert.deepEqual(owner.texts,['Hbase','other']);
  assert.deepEqual(await page.evaluate(()=>window.agentFixture.reopen()),['Hbase','other']);fact.snapshots.push({result,owner});
}));

test('AGT-LIVE-05 current write revocation denies admission and preserves human source and receipt access',()=>probe('revoked-write',async(page,fact)=>{
  await mount(page);const p=await prepare(page);await page.evaluate(()=>window.agentFixture.human('H'));await page.evaluate(()=>window.agentFixture.policy({writable:false}));
  const result=await apply(page,p);assert.equal(result.code,'denied');
  const direct=await page.evaluate(async p=>{try{await window.agentFixture.rpc({op:'apply',...p,requestId:'bypass'});return 'allowed';}catch(e){return e.message;}},p);assert.match(direct,/Unauthorized/);
  const receipt=await page.evaluate(()=>window.agentFixture.call('receipt',{requestId:'bypass'}));assert.equal(receipt.data.outcome,'not-found');
  assert.deepEqual(await page.evaluate(()=>window.agentFixture.reopen()),['base','Hother']);fact.snapshots.push({result,direct,receipt});
}));

test('AGT-LIVE-06 revocation after commit withholds the result; same identity later resolves exactly one effect',()=>probe('inflight-revocation',async(page,fact)=>{
  await mount(page);const p=await prepare(page);await page.evaluate(()=>window.agentFixture.revokeAfterCommit());const result=await apply(page,p);assert.equal(result.code,'unknown-outcome');
  assert.equal((await page.evaluate(()=>window.agentFixture.call('receipt',{requestId:'request-a'}))).code,'denied');
  await page.evaluate(()=>window.agentFixture.policy({readable:true,writable:true}));const retried=await apply(page,p);assert.equal(retried.data.outcome,'committed');await push(page);
  assert.deepEqual((await state(page))[0].texts,['Abase','other']);fact.snapshots.push({result,retried});
}));

test('AGT-LIVE-07 persistence failure stays pending, blocks sync, then ordered recovery releases one recoverable update',()=>probe('pending-recovery',async(page,fact)=>{
  await mount(page);const p=await prepare(page);await page.evaluate(()=>window.agentFixture.rpc({op:'fail'}));const result=await apply(page,p);assert.equal(result.data.outcome,'pending');assert.equal(result.data.localDurability,'pending');assert.equal(result.data.remoteDurability,'unknown');
  const blocked=await page.evaluate(async()=>{try{await window.agentFixture.push();return 'published';}catch(e){return e.message;}});assert.match(blocked,/Recovery|Store|Unavailable|Pending/);
  assert.deepEqual((await state(page))[0].texts,['base','other']);
  const pending=await page.evaluate(()=>window.agentFixture.call('receipt',{requestId:'request-a'}));assert.equal(pending.data.outcome,'pending');
  await page.evaluate(()=>window.agentFixture.rpc({op:'recover'}));const receipt=await page.evaluate(()=>window.agentFixture.call('receipt',{requestId:'request-a'}));assert.equal(receipt.data.localDurability,'durable');assert.equal(receipt.data.remoteDurability,'pending');
  await push(page);assert.deepEqual(await page.evaluate(()=>window.agentFixture.reopen()),['Abase','other']);fact.snapshots.push({result,blocked,pending,receipt});
}));

test('AGT-LIVE-08 duplicate retries and duplicate collaboration bytes do not duplicate insertion or claim remote durability',()=>probe('duplicate-delivery',async(page,fact)=>{
  await mount(page);const p=await prepare(page),original=await apply(page,p);await push(page);const revision=(await state(page))[0].history.revision;
  const retry=await apply(page,p);assert.deepEqual(retry,original);await push(page);await push(page);const after=await state(page);assert.equal(after[0].history.revision,revision);assert.deepEqual(after[0].texts,['Abase','other']);
  const changed=await apply(page,{...p,proposalId:'forged'});assert.equal(changed.code,'unknown-outcome');
  const receipt=await page.evaluate(()=>window.agentFixture.call('receipt',{requestId:'request-a'}));assert.equal(receipt.data.remoteDurability,'pending');fact.snapshots.push({original,retry,changed,receipt,after});
}));

test('AGT-LIVE-09 native keyboard human input remains usable after live agent patches without remount',()=>probe('human-keyboard',async(page,fact)=>{
  await mount(page);await apply(page,await prepare(page));await push(page);await page.evaluate(()=>window.agentFixture.select(1));await page.keyboard.type('K');await page.evaluate(()=>window.agentFixture.pump());
  const after=await state(page);assert.deepEqual(after[0].texts,['Abase','Kother']);assert.deepEqual(after[1].texts,after[0].texts);assert.equal(after[0].retained,true);fact.snapshots.push(after);
}));
