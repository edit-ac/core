import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { baselineOwner } from '../../examples/host-agent-product/baseline-owner.mjs';
import { DOCUMENT, EPOCH } from '../../examples/host-agent-product/bridge.mjs';
const access={actorId:'agent-a',documentId:DOCUMENT,epoch:EPOCH,permissions:['read','observe','prepare'],readOnly:false};
const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const sqlite=database=>{
 const r=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({t:[list(r) for r in c.execute('SELECT * FROM "'+t+'"')] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")},default=lambda b:b.hex(),sort_keys=True))`,database],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
};
export async function modelCases(check,{server,facts}) {
 const before=await server.owner.send({op:'state'}),db=sqlite(server.owner.database);
 const prior=JSON.parse(await readFile(facts.inputs.receipt));
 const {createHostPrepare}=await import(pathToFileURL(join(prior.output,'site/web/host/index.js')).href);
 const held=[];let hold;
 const owner=baselineOwner({createHostPrepare,access:()=>access,available:()=>true,send:async input=>{
   const result=await server.owner.send(input);
   if(hold?.op===input.op){const h=hold;h.input=input;hold=undefined;held.push({op:input.op,target:input.target,result});h.started.resolve(result);await h.resume.promise;}
   return result;
 }});
 const read=()=>owner.services.read.execute({representation:'source'},access);
 const prepare=b=>owner.services.prepare.execute({expectedRevision:b.revision,sourceHash:b.sourceHash,candidateMarkdown:b.source.replace('base','Prepared cancellation candidate')},access);
 const arm=op=>{const h={op,started:deferred(),resume:deferred()};hold=h;return h;};
 const missing=target=>assert.rejects(server.owner.send({op:'prepare_markdown',target,candidate:'',access}),/MissingTarget/);
 try {
  await check('cancel-releases-bounded-upload-and-baseline',async()=>{
   const b=await read();assert.equal(typeof b.source,'string');
   const baseline={...b,...access,generation:owner.generation};
   const u=await owner.upload({action:'upload-begin',generation:owner.generation,baseline,totalBytes:5,checksum:hash('local')});assert.equal(u.status,'uploading');
   await owner.reset();assert.equal((await owner.upload({action:'upload-chunk',generation:baseline.generation,uploadId:u.uploadId,index:0,text:'local',checksum:hash('local')})).code,'expired');
  });
  await check('late-read-withheld-new-generation-retained',async()=>{
   const h=arm('capture'),pending=read(),old=await h.started.promise;
   const reset=owner.reset();const current=await read();assert.equal(current.source,before.texts.join('\n\n')+'\n');
   h.resume.resolve();assert.equal((await pending).code,'expired');await reset;await missing(old.target);
   assert.equal((await prepare(current)).status,'prepared');
  });
  await check('late-real-prepare-withheld-and-target-released',async()=>{
   const b=await read(),h=arm('prepare_markdown'),pending=prepare(b),actual=await h.started.promise;
   assert.equal(actual.status,'prepared');assert.ok(actual.proposalId);const reset=owner.reset();
   const fresh=await read();h.resume.resolve();assert.equal((await pending).code,'expired');await reset;await missing(h.input.target);
   assert.equal((await prepare(fresh)).status,'prepared');
  });
  await check('close-fences-late-read-and-denies-future-work',async()=>{
   const h=arm('capture'),pending=read(),old=await h.started.promise,closed=owner.reset(true);
   assert.equal((await read()).code,'unavailable');h.resume.resolve();assert.equal((await pending).code,'expired');await closed;await missing(old.target);
  });
  await check('independent-session-sqlite-identity-nonmutation',async()=>{
   assert.deepEqual(await server.owner.send({op:'state'}),before);assert.deepEqual(sqlite(server.owner.database),db);
   const identity=(await server.owner.send({op:'seed'})).identity;assert.equal(identity.documentId,DOCUMENT);assert.equal(identity.epoch,EPOCH);
   facts.proposalCancelIndependent={before,sqliteBefore:db,identity,delayedActualResults:held};
  });
 } finally {hold?.resume.resolve();await owner.reset(true);}
}
export async function browserCases({page,server,check,facts,output}) {
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(server.url))external.push(r.url());});
 await page.goto(server.url);await page.waitForFunction(()=>window.humanWorkspace?.mounted && document.querySelector('#baseline-capture')?.disabled===false);
 const snapshot=()=>page.evaluate(()=>window.humanWorkspace.evidence());
 const before=await server.owner.send({op:'state'}),db=sqlite(server.owner.database),peer=await snapshot();
 const idle=()=>page.waitForFunction(()=>document.querySelector('#baseline-region').getAttribute('aria-busy')==='false' && document.querySelector('#upload-region').getAttribute('aria-busy')==='false');
 const capture=async()=>{await idle();await page.locator('#baseline-capture').click();await idle();assert.ok(await page.locator('#baseline-source').textContent(),await page.locator('#baseline-status').textContent());};
 const click=async id=>{await page.locator('#upload-'+id).click();await idle();};
 const start=async()=>{await page.locator('#upload-source').fill((await page.locator('#baseline-source').textContent()).replace('base','Prepared cancellation candidate'));await click('start');};
 const complete=async()=>{await capture();await start();while(!await page.locator('#upload-next').isDisabled())await click('next');};
 const cleared=async()=>{await idle();for(const id of ['baseline-source','baseline-metadata','upload-source','upload-metadata'])assert.equal(await page.locator('#'+id)[id==='upload-source'?'inputValue':'textContent'](),'');assert.equal(await page.locator('#upload-finish').isDisabled(),true);};
 async function delay(action,work) {
  const started=deferred(),resume=deferred(),finished=deferred();let selected=false;
  const handler=async route=>{
   if(selected || route.request().postDataJSON().action!==action){await route.continue();return;}selected=true;
   try {const response=await route.fetch();started.resolve(await response.json());await resume.promise;await route.fulfill({response});}
   catch(error){if(!selected)throw error;}
   finally {finished.resolve();}
  };
  await page.route('**/bridge/baseline',handler);
  try {await work(started.promise,resume.resolve);}finally {resume.resolve();if(selected)await finished.promise;await page.unroute('**/bridge/baseline',handler);}
 }
 await check('keyboard-cancel-clears-partial-and-releases-owner',async()=>{
  await capture();const old=server.owner.lifecycle.generation;await start();
  await page.locator('#proposal-cancel').focus();await page.keyboard.press('Enter');await cleared();assert.ok(server.owner.lifecycle.generation>old);
  assert.match(await page.locator('#proposal-cancel-status').textContent(),/cancelled/);assert.equal(await page.locator('#upload-start').isDisabled(),true);
 });
 await check('scope-switch-and-close-clear-prepared-views',async()=>{
  for(const exit of ['scope','close']){
   await complete();await click('finish');assert.match(await page.locator('#upload-status').textContent(),/prepared by shared owner/);
   if(exit==='scope')await page.locator('#baseline-scope').selectOption('other');else await page.locator('#human-close').click();
   await cleared();assert.equal(await page.locator('#upload-start').isDisabled(),true);
   if(exit==='scope')await page.locator('#baseline-scope').selectOption('current');else {await page.locator('#human-open').click();await page.waitForFunction(()=>window.humanWorkspace.mounted);}
  }
 });
 await check('late-read-cannot-replace-newer-capture',async()=>{
  await delay('capture',async(started,unblock)=>{
   await page.locator('#baseline-capture').click();assert.equal((await started).status,'captured');
   await page.locator('#proposal-cancel').click();await cleared();await capture();const fresh=await page.locator('#baseline-metadata').textContent();
   unblock();await idle();assert.equal(await page.locator('#baseline-metadata').textContent(),fresh);
  });
 });
 await check('late-prepare-cannot-replace-newer-scope',async()=>{
  await complete();await delay('upload-finish',async(started,unblock)=>{
   await page.locator('#upload-finish').click();const actual=await started;assert.equal(actual.status,'prepared');assert.ok(actual.proposalId);
   await page.locator('#baseline-scope').selectOption('other');await cleared();await page.locator('#baseline-scope').selectOption('current');await capture();
   const fresh=await page.locator('#baseline-metadata').textContent();unblock();await idle();assert.equal(await page.locator('#baseline-metadata').textContent(),fresh);assert.equal(await page.locator('#upload-metadata').textContent(),'');
   facts.latePrepare={proposalId:actual.proposalId,withheld:true};
  });
 });
 await check('close-during-real-prepare-withholds-result',async()=>{
  await complete();await delay('upload-finish',async(started,unblock)=>{
   await page.locator('#upload-finish').click();assert.equal((await started).status,'prepared');await page.locator('#human-close').click();await cleared();unblock();
   assert.equal(await page.locator('#upload-metadata').textContent(),'');
  });
  await page.locator('#human-open').click();await page.waitForFunction(()=>window.humanWorkspace.mounted);
 });
 await check('cancel-pending-begin-releases-admitted-upload',async()=>{
  await capture();await page.locator('#upload-source').fill('local candidate');
  await delay('upload-begin',async(started,unblock)=>{
   await page.locator('#upload-start').click();const actual=await started;assert.equal(actual.status,'uploading');
   const generation=server.owner.lifecycle.generation;await page.locator('#proposal-cancel').click();await cleared();unblock();
   const late=await server.owner.baseline({action:'upload-chunk',generation,uploadId:actual.uploadId,index:0,text:'local candidate',checksum:hash('local candidate')});assert.equal(late.code,'expired');
  });
 });
 await check('expiry-clears-prepared-presentation',async()=>{
  await complete();await click('finish');assert.match(await page.locator('#upload-metadata').textContent(),/proposalId/);
  await page.locator('#baseline-expire').click();await idle();await page.locator('#baseline-check').click();await idle();
  await page.waitForFunction(()=>document.querySelector('#upload-metadata').textContent==='');assert.equal(await page.locator('#upload-source').inputValue(),'');assert.equal(await page.locator('#upload-finish').isDisabled(),true);
 });
 await check('independent-owner-browser-history-journal-unchanged',async()=>{
  assert.deepEqual(await server.owner.send({op:'state'}),before);assert.deepEqual(sqlite(server.owner.database),db);
  const after=await snapshot();for(const key of ['identity','texts','ids','history','journal','pending'])assert.deepEqual(after[key],peer[key],key);
  facts.proposalCancel={identity:after.identity,history:after.history,sqliteTables:Object.keys(db)};assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 });
 await check('cancel-preserves-independent-human-edit',async()=>{
  const editor=page.locator('#human-editor');await editor.click();await page.keyboard.press('Home');await page.keyboard.type('H');await page.locator('#human-publish').click();await page.waitForFunction(()=>!document.querySelector('#human-publish').disabled);
  const changed=await server.owner.send({op:'state'}),changedDB=sqlite(server.owner.database),changedPeer=await snapshot();assert.notEqual(changed.revision,before.revision);
  await capture();await start();await page.locator('#proposal-cancel').click();await cleared();
  assert.deepEqual(await server.owner.send({op:'state'}),changed);assert.deepEqual(sqlite(server.owner.database),changedDB);assert.deepEqual((await snapshot()).history,changedPeer.history);
 });
 await check('page-exit-releases-retained-target',async()=>{
  await capture();const generation=server.owner.lifecycle.generation;await page.screenshot({path:join(output,facts.engine+'-lifetime.png'),fullPage:true});await page.goto('about:blank');
  for(let n=0;n<100 && server.owner.lifecycle.generation===generation;n++)await new Promise(r=>setTimeout(r,20));
  assert.ok(server.owner.lifecycle.generation>generation);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 });
}
