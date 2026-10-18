import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real production WASM + IndexedDB + adapter prerequisite proof. No content
// adoption, packed-runtime or cross-browser qualification claim (PMS-1.2/1.3).
// Read-cache change hints are excluded from documentState; exact checkpoint,
// state vector, revision, semantic projection and history remain asserted.
let controller, browser, context, page;
const facts={cases:[],processes:[],boundary:'pre-insertion stage/read/fence only'};
const output=process.env.EDITAC_PREPARED_ASSET_OUTPUT;
before(async()=>{
  if(output)await mkdir(output,{recursive:true});
  controller=await chromium.launchServer({headless:true});
  facts.processes.push({pid:controller.process().pid,launcher:controller.process().spawnfile,workspace:process.cwd(),purpose:'PMS-1.2 prepared original IndexedDB integration'});
  browser=await chromium.connect(controller.wsEndpoint());
  facts.browser=browser.version();context=await browser.newContext();
  await context.route('https://prepared-assets.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Prepared original storage</title>'});
    if(path.includes('..')||!/^\/(core|web)\//.test(path))return route.abort();
    const prefix=path.startsWith('/core/')?'../packages/core/dist/':'../packages/web/dist/';
    return route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:await readFile(new URL(prefix+path.replace(/^\/(core|web)\//,''),import.meta.url))});
  });
  page=await context.newPage();await page.goto('https://prepared-assets.test/');
  await page.evaluate(async()=>{
    const {init}=await import('/core/index.js');
    const {AssetSession}=await import('/web/sync/assets.js');
    const runtime=await init('/core/wasm/editac_wasm_bg.wasm');
    let sequence=0;
    window.setup=async()=>{
      const engine=runtime.createEngine({profile:'v5',documentId:'45678901-4567-4567-8567-'+String(++sequence).padStart(12,'0'),epoch:'56789012-5678-4678-8678-56789012abcd',nodes:[{text:'unchanged'}]});
      const database='prepared-assets-'+sequence;
      const f={engine,database,session:await AssetSession.open(engine,indexedDB,database),identity:{host:'fixture',key:'shared_original'},bytes:new Uint8Array([0,255,13,10,128,42])};
      f.grant={identity:f.identity,actions:['ingest','read','cancel','release-reference']};
      f.documentState=()=>{const {changedNodes,touchedRanges,...snapshot}=engine.read();return {snapshot,history:engine.history({type:'state'}),checkpoint:Array.from(engine.checkpoint().bytes),stateVector:Array.from(engine.stateVector())};};
      f.request=operationId=>({version:1,operationId,identity:f.identity,action:'ingest',byteLimit:32});
      f.stage=(job='job_a',reference='prepared_a',operation='stage_a')=>f.session.stageOriginal(job,reference,f.request(operation),f.grant,f.bytes);
      f.reopen=async()=>{await f.session.dispose('suspend');f.session=await AssetSession.open(engine,indexedDB,database);};
      f.close=async()=>{await f.session.dispose('suspend');engine.dispose();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(database);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});};
      window.fixture=f;return f;
    };
  });
});
after(async()=>{
  try{await context?.close();}finally{try{await browser?.close();}finally{await controller?.close();}}
  if(output)await writeFile(output+'/browser-stage-facts.json',JSON.stringify(facts,null,2)+'\n');
});
function check(name,fn){test(name,async()=>{const fact={name,passed:false};facts.cases.push(fact);await page.evaluate(()=>window.setup().then(()=>{}));try{await fn(fact);fact.passed=true;}finally{await page.evaluate(()=>window.fixture.close());}});}
check('stage copies exact original and authority without document revision/history changes',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;const before=f.documentState();
    const source=new Uint8Array(f.bytes),grant=structuredClone(f.grant),request=structuredClone(f.request('stage_a'));
    const pending=f.session.stageOriginal('job_a','prepared_a',request,grant,source);source.fill(7);grant.actions.length=0;request.identity.key='mutated';await pending;
    const first=await f.session.inspect();await f.stage();const second=await f.session.inspect();
    const original=Array.from(await f.session.preparedSource('job_a','prepared_a',f.grant));
    const changed=await f.session.preparedSource('job_a','prepared_a',f.grant);changed.fill(8);
    return {before,after:f.documentState(),first,second,original,recovered:Array.from(await f.session.preparedSource('job_a','prepared_a',f.grant))};});
  assert.deepEqual(r.before,r.after);assert.deepEqual(r.first,r.second);assert.deepEqual(r.original,[0,255,13,10,128,42]);assert.deepEqual(r.recovered,r.original);assert.deepEqual(r.first.prepared[0].grantActions,['ingest','read','cancel','release-reference']);fact.result=r;
});
check('denied grants, source conflicts and reserved live namespace retain caller source and journal',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;await f.stage();const before=await f.session.inspect(),errors=[];
    for(const action of [()=>f.session.stageOriginal('job_a','prepared_b',f.request('deny'),{identity:f.identity,actions:['read']},f.bytes),()=>f.session.stageOriginal('job_a','prepared_a',f.request('stage_a'),f.grant,new Uint8Array([9])),()=>f.session.stageOriginal('job_b','prepared_a',f.request('stage_b'),f.grant,f.bytes),()=>f.session.stageOriginal('job_a','node_1234',f.request('reserved'),f.grant,f.bytes),()=>f.session.preparedSource('job_a','prepared_a',{identity:f.identity,actions:['ingest']})]){
      try{await action();errors.push(null);}catch(error){errors.push({name:error.name,code:error.code??null,message:error.message});}
    }
    return {before,after:await f.session.inspect(),errors,source:Array.from(f.bytes)};});
  assert.deepEqual(r.before,r.after);assert.equal(r.errors.filter(Boolean).length,5);assert.deepEqual(r.source,[0,255,13,10,128,42]);fact.result=r;
});
check('empty job fence persists across reopen and rejects delayed stage',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;await f.session.fenceJob('early');await f.reopen();let error;try{await f.stage('early');}catch(e){error={code:e.code,message:e.message};}return {error,state:await f.session.inspect(),text:f.engine.read().visible[0].runs[0].text};});
  assert.ok(r.error);assert.deepEqual(r.state.fencedJobs,['early']);assert.equal(r.state.prepared.length,0);assert.equal(r.state.intents.length,0);assert.equal(r.text,'unchanged');fact.result=r;
});
check('concurrent stage and fence commit serially with source retained and sibling untouched',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;await f.stage('job_b','prepared_b','stage_b');const sibling=(await f.session.inspect()).intents[0];await Promise.all([f.stage(),f.session.fenceJob('job_a')]);await f.reopen();await f.session.fenceJob('job_a');const state=await f.session.inspect();let late;try{await f.stage('job_a','late','late_op');late=false;}catch{late=true;}return {state,sibling,late,source:Array.from(await f.session.preparedSource('job_a','prepared_a',f.grant))};});
  assert.equal(r.late,true);assert.deepEqual(r.state.intents.find(i=>i.reference==='prepared_b'),r.sibling);assert.equal(r.state.prepared.find(p=>p.job==='job_b').active,true);assert.equal(r.state.prepared.find(p=>p.job==='job_a').active,false);assert.deepEqual(r.source,[0,255,13,10,128,42]);assert.equal(r.state.intents.length,4);fact.result=r;
});
check('aborted stage transaction retains input without writing journal or document',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture,before=f.documentState();const db=f.session.database,transaction=db.transaction.bind(db);let inject=true;
    db.transaction=(...args)=>{const tx=transaction(...args);if(inject){inject=false;const objectStore=tx.objectStore.bind(tx);tx.objectStore=(...stores)=>{const store=objectStore(...stores),put=store.put.bind(store);store.put=(...values)=>{const r=put(...values);tx.abort();return r;};return store;};}return tx;};
    let failed;try{await f.stage();failed=false;}catch{failed=true;}db.transaction=transaction;await f.reopen();return {failed,before,after:f.documentState(),state:await f.session.inspect(),source:Array.from(f.bytes)};});
  assert.equal(r.failed,true);assert.deepEqual(r.before,r.after);assert.equal(r.state.prepared.length,0);assert.equal(r.state.intents.length,0);assert.deepEqual(r.source,[0,255,13,10,128,42]);fact.result=r;
});
check('suspension reopens original without host work; retirement fences opaque references and cleanup is explicit',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;await f.stage();await f.reopen();const recovered=await f.session.inspect();let dispatched=false;const calls=[],host={authorize:async r=>{calls.push(['authorize',r.operationId]);return f.grant;},execute:async(reference,r,bytes)=>{calls.push(['execute',r.action,reference,bytes]);return null;}};
    const automatic=calls.length;dispatched=await f.session.runOne('stage_a',true,host);
    await f.session.dispose('retire');f.session=await (await import('/web/sync/assets.js')).AssetSession.open(f.engine,indexedDB,f.database);
    const fenced=await f.session.inspect();for(const action of ['cancel','release-reference']){const i=fenced.intents.find(i=>i.request.action===action);await f.session.runOne(i.request.operationId,true,host);}
    return {recovered,fenced,dispatched,automatic,calls,source:Array.from(await f.session.preparedSource('job_a','prepared_a',f.grant)),state:await f.session.inspect()};});
  assert.equal(r.recovered.prepared[0].active,true);assert.equal(r.automatic,0);assert.equal(r.dispatched,true);assert.deepEqual(r.fenced.fencedJobs,['job_a']);assert.deepEqual(r.calls.filter(c=>c[0]==='execute').map(c=>c[1]),['ingest','cancel','release-reference']);assert.deepEqual(r.source,[0,255,13,10,128,42]);assert.equal(r.state.intents[0].status,'Complete');fact.result=r;
});

check('retiring session rejects queued and newly arriving stages before closure and shares teardown completion',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;await f.stage();
    const queued=f.stage('job_b','prepared_b','stage_b').then(()=>true,()=>false);
    const closing=f.session.dispose('retire');const second=f.session.dispose('retire');
    const late=f.stage('job_c','prepared_c','stage_c').then(()=>true,()=>false);
    await Promise.all([closing,second]);const admitted=await queued,lateAdmitted=await late;
    f.session=await (await import('/web/sync/assets.js')).AssetSession.open(f.engine,indexedDB,f.database);
    return {admitted,lateAdmitted,state:await f.session.inspect(),source:Array.from(await f.session.preparedSource('job_a','prepared_a',f.grant))};});
  assert.equal(r.admitted,false);assert.equal(r.lateAdmitted,false);assert.ok(r.state.prepared.every(p=>!p.active));assert.deepEqual(r.source,[0,255,13,10,128,42]);fact.result=r;
});

check('teardown fences dispatch admitted before asynchronous intent lookup completes',async fact=>{
  const r=await page.evaluate(async()=>{const f=window.fixture;await f.stage();await f.session.fenceJob('job_a');
    const operation=(await f.session.inspect()).intents.find(i=>i.request.action==='cancel').request.operationId;
    const inspect=f.session.inspect.bind(f.session);let reads=0,releaseRun,releaseDispose,reachedRun,reachedDispose;
    const runWaiting=new Promise(resolve=>{reachedRun=resolve;}),disposeWaiting=new Promise(resolve=>{reachedDispose=resolve;});
    const runGate=new Promise(resolve=>{releaseRun=resolve;}),disposeGate=new Promise(resolve=>{releaseDispose=resolve;});
    f.session.inspect=async()=>{const result=await inspect(),read=++reads;if(read===2){reachedRun();await runGate;}if(read===3){reachedDispose();await disposeGate;}return result;};
    const calls=[],host={authorize:async r=>{calls.push(['authorize',r.operationId]);return f.grant;},execute:async()=>{calls.push(['execute']);return null;}};
    const running=f.session.runOne(operation,true,host).then(()=>null,error=>error.message);
    await runWaiting;const closing=f.session.dispose('retire');await disposeWaiting;
    let error;try{releaseRun();error=await running;}finally{releaseDispose();await closing;}
    f.session=await (await import('/web/sync/assets.js')).AssetSession.open(f.engine,indexedDB,f.database);
    return {error,calls,state:await f.session.inspect()};});
  assert.match(r.error,/closing/);assert.deepEqual(r.calls,[]);assert.deepEqual(r.state.fencedJobs,['job_a']);fact.result=r;
});
