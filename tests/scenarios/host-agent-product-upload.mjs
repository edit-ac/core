import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { candidateChunks } from '../../examples/host-agent-product/upload-input.mjs';
const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
const sqlite=database=>{
  const r=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({t:[list(r) for r in c.execute('SELECT * FROM "'+t+'"')] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")},default=lambda b:b.hex(),sort_keys=True))`,database],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
};
const capture=async server=>{await server.owner.baseline({action:'release'});const r=await server.owner.baseline({action:'capture',generation:server.owner.lifecycle.generation});assert.equal(r.status,'captured');return r.baseline;};
const request=(server,b,action,fields={})=>server.owner.baseline({action:'upload-'+action,generation:b.generation,...fields});
const begin=(server,b,source,extra={})=>request(server,b,'begin',{baseline:b,totalBytes:Buffer.byteLength(source),checksum:hash(source),...extra});
const chunk=(server,b,u,index,text,checksum=hash(text))=>request(server,b,'chunk',{uploadId:u.uploadId,index,text,checksum});
export async function modelCases(check,{server,facts}) {
  const state=await server.owner.send({op:'state'}),db=sqlite(server.owner.database);
  let b=await capture(server),count=facts.uploadPrepareCalls ?? 0;
  const unchanged=async()=>{assert.equal(facts.uploadPrepareCalls ?? 0,count,'invalid/partial upload reached owner prepare');assert.deepEqual(await server.owner.send({op:'state'}),state);assert.deepEqual(sqlite(server.owner.database),db);};
  await check('utf8-framing-and-bounds',async()=>{
    const source='a'.repeat(1023)+'🌱é\n'+ 'b'.repeat(1024),c=candidateChunks(source);
    assert.equal(c.chunks.join(''),source);assert.equal(c.total,Buffer.byteLength(source));assert.ok(c.chunks.length===3 && c.chunks.every(s=>s.isWellFormed() && Buffer.byteLength(s)<=1024));
    assert.throws(()=>candidateChunks('🌱'.repeat(1025)));assert.throws(()=>candidateChunks('\ud800'));assert.deepEqual(candidateChunks('').chunks,[]);
  });
  await check('partial-and-order-errors-never-prepare',async()=>{
    const u=await begin(server,b,'firstsecond');assert.equal(u.status,'uploading');
    assert.equal((await chunk(server,b,u,1,'second')).code,'invalid');
    assert.equal((await chunk(server,b,u,0,'first')).receivedBytes,5);
    assert.equal((await chunk(server,b,u,0,'first')).receivedBytes,5,'identical retry must not count twice');
    assert.equal((await chunk(server,b,u,0,'other')).code,'mismatch');
    assert.equal((await request(server,b,'finish',{uploadId:u.uploadId})).code,'incomplete');await unchanged();
    assert.equal((await request(server,b,'cancel',{uploadId:u.uploadId})).status,'cancelled');
  });
  await check('byte-and-unicode-errors-never-prepare',async()=>{
    assert.equal((await begin(server,b,'',{totalBytes:4097})).code,'limit');assert.equal((await begin(server,b,'',{totalBytes:-1})).code,'limit');
    const u=await begin(server,b,'é',{totalBytes:1});assert.equal((await chunk(server,b,u,0,'é')).code,'limit');
    assert.equal((await chunk(server,b,u,0,'a'.repeat(1025))).code,'limit');assert.equal((await chunk(server,b,u,0,'\ud800')).code,'invalid');
    await request(server,b,'cancel',{uploadId:u.uploadId});await unchanged();
  });
  await check('chunk-and-complete-checksum-errors',async()=>{
    const u=await begin(server,b,'right');assert.equal((await chunk(server,b,u,0,'right',hash('wrong'))).code,'mismatch');
    assert.equal((await chunk(server,b,u,0,'wrong')).status,'partial');assert.equal((await request(server,b,'finish',{uploadId:u.uploadId})).code,'mismatch');
    assert.equal((await request(server,b,'finish',{uploadId:u.uploadId})).code,'expired');await unchanged();
  });
  await check('expiry-scope-and-current-authority',async()=>{
    const u=await begin(server,b,'candidate');server.owner.lifecycle.expire();assert.equal((await chunk(server,b,u,0,'candidate')).code,'expired');
    b=await capture(server);assert.equal((await begin(server,{...b,documentId:'foreign'},'candidate')).code,'foreign-baseline');
    const v=await begin(server,b,'candidate');await server.owner.configure('readonly');assert.equal((await chunk(server,b,v,0,'candidate')).code,'denied');
    await server.owner.configure('authorized');assert.equal((await chunk(server,b,v,0,'candidate')).code,'expired');await unchanged();b=await capture(server);
  });
  await check('only-complete-candidate-reaches-real-owner',async()=>{
    const source=b.source.replace('base','Uploaded 🌱 local candidate. '.repeat(60)),u=await begin(server,b,source);assert.equal(u.status,'uploading');
    const parts=candidateChunks(source).chunks;for(let i=0;i<parts.length;i++)assert.equal((await chunk(server,b,u,i,parts[i])).status,'partial');await unchanged();
    const r=await request(server,b,'finish',{uploadId:u.uploadId});assert.equal(r.status,'prepared');assert.equal(r.candidateHash,hash(source));assert.equal(r.sourceHash,b.sourceHash);assert.equal(r.expectedRevision,b.revision);assert.ok(r.proposalId);assert.ok(r.affectedIds.length>0);
    count++;assert.equal(facts.uploadPrepareCalls,count);assert.equal((await request(server,b,'finish',{uploadId:u.uploadId})).code,'expired');await unchanged();
    facts.uploadPrepared={proposalId:r.proposalId,candidateHash:r.candidateHash,profile:r.profile};
  });
  await check('empty-complete-candidate-and-cancel',async()=>{
    const u=await begin(server,b,'');assert.equal(u.status,'uploading');const r=await request(server,b,'finish',{uploadId:u.uploadId});assert.equal(r.status,'conflict');assert.ok(r.code);assert.equal(r.recovery.base,b.source);assert.equal(r.recovery.proposed,'');count++;facts.emptyCandidateConflict={code:r.code,currentRevision:r.recovery.currentRevision};
    const v=await begin(server,b,'cancel');await request(server,b,'cancel',{uploadId:v.uploadId});assert.equal((await chunk(server,b,v,0,'cancel')).code,'expired');await unchanged();
  });
  await check('independent-session-sqlite-and-identity',async()=>{
    await unchanged();facts.uploadIndependent={before:state,sqliteBefore:db,identity:(await server.owner.send({op:'seed'})).identity,prepareCalls:count};
  });
}
export async function browserCases({page,server,check,facts}) {
  const errors=[],external=[],uploads=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(server.url))external.push(r.url());if(r.url()===server.url+'/bridge/baseline' && r.method()==='POST'){const body=r.postDataJSON();if(body.action?.startsWith('upload-'))uploads.push(body);}});
  await page.goto(server.url);await page.waitForFunction(()=>window.humanWorkspace?.mounted && !document.querySelector('#baseline-capture').disabled);
  const snapshot=()=>page.evaluate(()=>window.humanWorkspace.evidence());
  const prepareBefore=server.owner.prepareCount;
  const before=await server.owner.send({op:'state'}),db=sqlite(server.owner.database),peer=await snapshot();
  const captureUI=async()=>{await page.locator('#baseline-capture').click();await page.waitForFunction(()=>!document.querySelector('#upload-start').disabled);};
  const click=async id=>{await page.locator('#upload-'+id).click();await page.waitForFunction(()=>document.querySelector('#upload-region').getAttribute('aria-busy')==='false');};
  const start=async source=>{await page.locator('#upload-source').fill(source);await click('start');await page.waitForFunction(()=>!document.querySelector('#upload-next').disabled || !document.querySelector('#upload-finish').disabled);};
  await check('explicit-local-input-and-partial-progress',async()=>{
    await captureUI();assert.ok(await page.locator('#upload-heading').isVisible());const source='a'.repeat(1023)+'🌱é\n'+ 'b'.repeat(1100);await start(source);
    assert.match(await page.locator('#upload-status').textContent(),/Partial upload: 0/);assert.equal(await page.locator('#upload-finish').isDisabled(),true);
    await click('next');await page.waitForFunction(()=>document.querySelector('#upload-progress').value===1023);assert.match(await page.locator('#upload-status').textContent(),/1023/);assert.equal(await page.locator('#upload-finish').isDisabled(),true);
    assert.deepEqual(await server.owner.send({op:'state'}),before);assert.deepEqual(sqlite(server.owner.database),db);
    await page.locator('#upload-cancel').click();
  });
  await check('visible-order-checksum-and-byte-errors',async()=>{
    for(const fault of ['order','checksum','bytes','complete-checksum']){
      await page.route('**/bridge/baseline',async route=>{const data=route.request().postDataJSON();if(data.action==='upload-begin' && fault==='complete-checksum'){data.checksum=hash('wrong');await route.continue({postData:JSON.stringify(data)});}else if(data.action==='upload-chunk'){if(fault==='order')data.index=1;if(fault==='checksum')data.checksum=hash('wrong');if(fault==='bytes'){data.text='x'.repeat(1025);data.checksum=hash(data.text);}await route.continue({postData:JSON.stringify(data)});}else await route.continue();});
      await start('candidate');await click('next');if(fault==='complete-checksum')await page.locator('#upload-finish').click();await page.waitForFunction(()=>document.querySelector('#upload-status').textContent.includes('Upload rejected:'));
      assert.match(await page.locator('#upload-status').textContent(),new RegExp(fault==='order'?'invalid':fault.includes('checksum')?'mismatch':'limit'));await page.unroute('**/bridge/baseline');
    }
    assert.deepEqual(await server.owner.send({op:'state'}),before);assert.deepEqual(sqlite(server.owner.database),db);
  });
  await check('visible-expiry-and-fresh-capture',async()=>{
    await start('expires');await page.locator('#baseline-expire').click();await page.waitForFunction(()=>document.querySelector('#baseline-status').textContent.includes('clock advanced'));
    await page.locator('#upload-next').click();await page.waitForFunction(()=>document.querySelector('#upload-status').textContent.includes('rejected: expired'));await captureUI();
  });
  await check('complete-owner-prepare-and-inert-url-content',async()=>{
    const source=(await page.locator('#baseline-source').textContent()).replace('base','Local 🌱 upload https://untrusted.invalid/no-fetch '.repeat(26));await start(source);
    while(!await page.locator('#upload-next').isDisabled()){await click('next');}
    await page.waitForFunction(()=>!document.querySelector('#upload-finish').disabled);await page.locator('#upload-finish').click();await page.waitForFunction(()=>document.querySelector('#upload-status').textContent.includes('prepared by shared owner'));
    const r=JSON.parse(await page.locator('#upload-metadata').textContent());assert.equal(r.status,'prepared');assert.ok(r.proposalId);assert.equal(r.candidateHash,hash(source));facts.uploadPrepared=r;
  });
  await check('bounded-input-keyboard-and-unknown-state',async()=>{
    await page.locator('#upload-source').fill('🌱'.repeat(1025));await page.locator('#upload-start').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#upload-status').textContent.includes('Invalid candidate'));
    await start('unknown');await page.route('**/bridge/baseline',route=>route.request().postDataJSON().action==='upload-chunk'?route.abort():route.continue());
    await page.locator('#upload-next').click();await page.waitForFunction(()=>document.querySelector('#upload-status').textContent.includes('outcome unknown'));await page.unroute('**/bridge/baseline');
    await captureUI();
  });
  await check('baseline-release-discards-pending-upload',async()=>{
    await start('release me');const u=uploads.findLast(r=>r.action==='upload-begin');await page.locator('#baseline-release').click();await page.waitForFunction(()=>document.querySelector('#upload-start').disabled && document.querySelector('#upload-next').disabled);
    assert.equal(await page.locator('#upload-metadata').textContent(),'');assert.equal(u.totalBytes,10);await captureUI();
  });
  await check('independent-browser-owner-journal-history',async()=>{
    assert.deepEqual(await server.owner.send({op:'state'}),before);assert.deepEqual(sqlite(server.owner.database),db);const after=await snapshot();
    for(const key of ['texts','ids','identity','history','journal','pending','storage'])assert.deepEqual(after[key],peer[key],key);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.equal(server.owner.prepareCount,prepareBefore+1,'only one complete browser candidate reaches real prepare');assert.ok(uploads.length>=12);facts.uploadIndependent={before,sqliteBefore:db,peerBefore:peer,peerAfter:after,external,errors,uploadRequests:uploads.map(({action,index,totalBytes,text})=>({action,index,totalBytes,chunkBytes:text?Buffer.byteLength(text):undefined}))};
  });
}
