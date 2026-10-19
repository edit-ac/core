import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DOCUMENT, EPOCH } from '../../examples/host-agent-product/bridge.mjs';
const hash = source => 'sha256:'+createHash('sha256').update(source).digest('hex');
const access = {actorId:'agent-a',documentId:DOCUMENT,epoch:EPOCH,permissions:['read','observe','prepare'],readOnly:false};
const sqlite = database => {
  const r=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({t:[list(r) for r in c.execute('SELECT * FROM "'+t+'"')] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")},default=lambda b:b.hex(),sort_keys=True))`,database],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
};
const capture = async server => {const r=await server.owner.baseline({action:'capture',generation:server.owner.lifecycle.generation});assert.equal(r.status,'captured');return r.baseline;};
const checkBase = (server,baseline) => server.owner.baseline({action:'check',baseline});
const prepare = (server,target,candidate) => server.owner.send({op:'prepare_markdown',target,candidate,access});
export async function modelCases(check,{server,facts}) {
  const before=await server.owner.send({op:'state'}),db=sqlite(server.owner.database);
  let base,target;
  await check('real-owner-retention-and-public-prepare',async()=>{
    base=await capture(server);target=facts.baselineTargets.at(-1);
    assert.ok(target>0);assert.equal(base.source,before.texts.join('\n\n')+'\n');
    assert.equal(base.revision,before.revision);assert.equal(base.profile,'markdown-v1/images-disabled');assert.equal(base.sourceHash,hash(base.source));
    assert.equal(base.documentId,DOCUMENT);assert.equal(base.epoch,EPOCH);assert.equal(Object.hasOwn(base,'target'),false);
    const result=(await server.owner.tools.call('editac_v1_prepare',{version:1,documentId:DOCUMENT,expectedRevision:base.revision,sourceHash:base.sourceHash,candidateMarkdown:base.source},server.owner.context)).structuredContent;
    assert.equal(result.status,'ok');assert.equal(result.data.status,'prepared');assert.equal(result.data.sourceHash,base.sourceHash);assert.equal(result.data.profile,base.profile);
    assert.equal((await checkBase(server,base)).status,'valid');
  });
  await check('foreign-and-forged-metadata-nonmutating',async()=>{
    for(const changed of [{documentId:'foreign'},{epoch:'foreign'},{actorId:'foreign'}])assert.equal((await checkBase(server,{...base,...changed})).code,'foreign-baseline');
    for(const changed of [{profile:'foreign-profile'},{revision:'changed'},{sourceHash:hash('forged')},{expiresAt:base.expiresAt+1}])assert.equal((await checkBase(server,{...base,...changed})).code,'mismatch');
    assert.equal((await checkBase(server,{...base,generation:-1})).code,'expired');
  });
  await check('expiry-releases-real-target',async()=>{
    server.owner.lifecycle.expire();assert.equal((await checkBase(server,base)).code,'expired');
    await assert.rejects(prepare(server,target,base.source),/MissingTarget/);
  });
  await check('release-and-policy-scope-fencing',async()=>{
    base=await capture(server);target=facts.baselineTargets.at(-1);
    await server.owner.baseline({action:'release'});
    assert.equal((await server.owner.baseline({action:'capture',generation:base.generation})).code,'expired');
    assert.equal((await checkBase(server,base)).code,'expired');await assert.rejects(prepare(server,target,base.source),/MissingTarget/);
    base=await capture(server);target=facts.baselineTargets.at(-1);await server.owner.configure('revoked');assert.equal((await checkBase(server,base)).code,'denied');
    await assert.rejects(prepare(server,target,base.source),/MissingTarget/);await server.owner.configure('authorized');
    assert.equal((await checkBase(server,base)).code,'expired');
  });
  await check('actual-session-sqlite-identity-unchanged',async()=>{
    assert.deepEqual(await server.owner.send({op:'state'}),before);assert.deepEqual(sqlite(server.owner.database),db);
    const seed=await server.owner.send({op:'seed'});assert.equal(seed.identity.documentId,DOCUMENT);assert.equal(seed.identity.epoch,EPOCH);
    facts.baselineIndependent={before,sqliteBefore:db,identity:seed.identity,retainedTargets:facts.baselineTargets};
  });
}
export async function browserCases({page,server,check,facts}) {
  const errors=[],external=[],checkRequests=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(server.url))external.push(r.url());if(r.url()===server.url+'/bridge/baseline' && r.method()==='POST'){const input=r.postDataJSON();if(input.action==='check')checkRequests.push(input.baseline);}});
  await page.goto(server.url);await page.waitForFunction(()=>window.humanWorkspace?.mounted && !document.querySelector('#baseline-capture').disabled);
  const snap=()=>page.evaluate(()=>window.humanWorkspace.evidence());
  const click=async id=>{await page.locator('#baseline-'+id).click();await page.waitForFunction(()=>!document.querySelector('#baseline-capture').disabled);};
  const dbBefore=sqlite(server.owner.database),ownerBefore=await server.owner.send({op:'state'}),peerBefore=await snap();
  let baseline;
  await check('visible-exact-baseline-and-owner-binding',async()=>{
    await click('capture');assert.ok(await page.locator('#baseline-metadata').textContent(),await page.locator('#baseline-status').textContent());baseline=JSON.parse(await page.locator('#baseline-metadata').textContent());
    const source=await page.locator('#baseline-source').textContent();
    assert.equal(source,ownerBefore.texts.join('\n\n')+'\n');assert.equal(baseline.sourceHash,hash(source));assert.equal(baseline.profile,'markdown-v1/images-disabled');assert.equal(baseline.revision,ownerBefore.revision);
    assert.match(await page.locator('#baseline-heading').textContent(),/Revision-bound/);assert.match(await page.locator('#baseline-heading').locator('..').textContent(),/not current semantic state/);
    await click('check');assert.match(await page.locator('#baseline-status').textContent(),/valid at observed revision/);
    assert.ok(checkRequests.length);assert.equal(Object.hasOwn(checkRequests.at(-1),'source'),false);assert.equal(Object.hasOwn(checkRequests.at(-1),'diagnostics'),false);
  });
  await check('foreign-metadata-real-boundary-and-inert-source',async()=>{
    const result=await page.evaluate(async b=>{const c=await(await fetch('/bridge.json')).json();return(await fetch('/bridge/baseline',{method:'POST',headers:{'Content-Type':'application/json','X-Host-Fixture':c.token},body:JSON.stringify({action:'check',baseline:{...b,epoch:'foreign'}})})).json();},baseline);
    assert.equal(result.code,'foreign-baseline');assert.equal(await page.locator('#baseline-source script').count(),0);assert.deepEqual(external,[]);
  });
  await check('prepared-expiry-and-real-owner-release',async()=>{
    const target=server.owner.lifecycle ? (await server.owner.send({op:'state'})).revision : null;assert.ok(target);
    await click('expire');await click('check');assert.match(await page.locator('#baseline-status').textContent(),/invalid: expired/);assert.equal(await page.locator('#baseline-source').textContent(),'');assert.equal(await page.locator('#baseline-check').isDisabled(),true);
  });
  await check('keyboard-release-scope-and-close',async()=>{
    await click('capture');await page.locator('#baseline-release').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#baseline-source').textContent==='');
    await click('capture');await page.locator('#baseline-scope').selectOption('other');await page.waitForFunction(()=>document.querySelector('#baseline-source').textContent==='');assert.equal(await page.locator('#baseline-capture').isDisabled(),true);
    await page.locator('#baseline-scope').selectOption('current');await page.waitForFunction(()=>!document.querySelector('#baseline-capture').disabled);await click('capture');
    await page.locator('#human-close').click();await page.waitForFunction(()=>!window.humanWorkspace.mounted && document.querySelector('#baseline-source').textContent==='');
    await page.locator('#human-open').click();await page.waitForFunction(()=>window.humanWorkspace.mounted);
  });
  await check('independent-history-storage-before-human-edit',async()=>{
    const after=await snap();for(const key of ['identity','history','texts','ids','journal','pending'])assert.deepEqual(after[key],peerBefore[key],key);
    assert.deepEqual(await server.owner.send({op:'state'}),ownerBefore);assert.deepEqual(sqlite(server.owner.database),dbBefore);
  });
  await check('human-edit-invalidates-real-revision-without-overwrite',async()=>{
    await click('capture');const retained=JSON.parse(await page.locator('#baseline-metadata').textContent()),exactBase=await page.locator('#baseline-source').textContent();const editor=page.locator('#human-editor');await editor.click();await page.keyboard.press('Home');await page.keyboard.type('H');
    await page.locator('#human-publish').click();await page.waitForFunction(()=>!document.querySelector('#human-publish').disabled);
    const changed=await server.owner.send({op:'state'}),db=sqlite(server.owner.database),peer=await snap();assert.notEqual(changed.revision,ownerBefore.revision);
    const conflict=(await server.owner.tools.call('editac_v1_prepare',{version:1,documentId:DOCUMENT,expectedRevision:retained.revision,sourceHash:retained.sourceHash,candidateMarkdown:exactBase},server.owner.context)).structuredContent;
    assert.equal(conflict.status,'ok');assert.equal(conflict.data.status,'conflict');assert.equal(conflict.data.recovery.base,exactBase);assert.equal(conflict.data.recovery.currentRevision,changed.revision);
    await click('check');assert.match(await page.locator('#baseline-status').textContent(),/invalid: changed/);assert.equal(await page.locator('#baseline-source').textContent(),'');
    assert.deepEqual(await server.owner.send({op:'state'}),changed);assert.deepEqual(sqlite(server.owner.database),db);assert.deepEqual((await snap()).history,peer.history);
    await click('capture');assert.equal(await page.locator('#baseline-source').textContent(),changed.texts.join('\n\n')+'\n');
    facts.baseline={oldRevision:ownerBefore.revision,currentRevision:changed.revision,identity:peer.identity,history:peer.history,sqliteTables:Object.keys(db)};
  });
  await check('late-capture-scope-fence-and-policy-release',async()=>{
    let unblock,started,finished;
    const held=new Promise(r=>unblock=r),captured=new Promise(r=>started=r),settled=new Promise(r=>finished=r);
    await page.route('**/bridge/baseline',async route=>{
      if(route.request().postDataJSON().action!=='capture'){await route.continue();return;}
      try {const response=await route.fetch();started();await held;await route.fulfill({response});}
      catch { /* Scope exit aborts this deliberately delayed browser request. */ }
      finally {finished();}
    });
    await page.locator('#baseline-capture').click();await captured;
    await page.locator('#baseline-scope').selectOption('other');unblock();await settled;await page.unroute('**/bridge/baseline');
    await page.waitForFunction(()=>document.querySelector('#baseline-source').textContent==='');assert.equal(await page.locator('#baseline-check').isDisabled(),true);
    await page.locator('#baseline-scope').selectOption('current');await page.waitForFunction(()=>!document.querySelector('#baseline-capture').disabled);await click('capture');
    await page.locator('#policy').selectOption('revoked');await page.waitForFunction(()=>document.querySelector('#baseline-source').textContent==='');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.locator('#policy').selectOption('authorized');await page.waitForFunction(()=>!document.querySelector('#baseline-capture').disabled);
  });
}
