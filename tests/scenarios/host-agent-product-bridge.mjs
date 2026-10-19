import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { DOCUMENT, EPOCH, LIMITS } from '../../examples/host-agent-product/bridge.mjs';
const sqlite = database => {
  const r=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({t:[list(r) for r in c.execute('SELECT * FROM "'+t+'"')] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")},default=lambda b:b.hex(),sort_keys=True))`,database],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
};
async function post(server,input,overrides={}) {
  const config=await (await fetch(server.url+'/bridge.json')).json();
  return fetch(server.url+'/bridge/observe',{method:'POST',headers:{Origin:server.url,'Content-Type':'application/json','X-Host-Fixture':config.token,...overrides},body:typeof input === 'string' ? input : JSON.stringify(input)});
}
export async function modelCases(check,{server,facts}) {
  const before=await server.owner.send({op:'state'}), seed=await server.owner.send({op:'seed'}), db=sqlite(facts.owner.database);
  facts.independent={before,identity:seed.identity,sqliteBefore:db};
  await check('actual-owner',async()=>{
    assert.deepEqual(before.texts,['base','other']); assert.equal(seed.identity.documentId,DOCUMENT); assert.equal(seed.identity.epoch,EPOCH);
    assert.ok(seed.bytes.length>0); assert.ok(Object.keys(db).length>0); assert.ok(facts.owner.pid>0); assert.match(before.revision,/^[0-9a-f]+$/);
  });
  await check('registered-facade',async()=>{
    const result=(await server.owner.call({version:1,documentId:DOCUMENT})).structuredContent;
    assert.equal(result.status,'ok'); assert.equal(result.data.revision,before.revision); assert.equal(result.data.durability,'not-reported');
    assert.equal(result.data.dataChannel,'collaboration');
    assert.equal((await server.owner.tools.call('editac_v1_observe',{version:1,documentId:DOCUMENT},{})).structuredContent.code,'denied');
  });
  await check('transport-admission',async()=>{
    const r=await post(server,{version:1,documentId:DOCUMENT}); assert.equal(r.status,200);
    assert.equal((await r.json()).data.revision,before.revision);
    assert.equal((await post(server,{version:1,documentId:DOCUMENT},{Origin:'https://example.invalid'})).status,403);
    assert.equal((await post(server,{version:1,documentId:DOCUMENT},{'X-Host-Fixture':'forged'})).status,403);
    assert.equal((await post(server,{version:1,documentId:'private-document'})).status,400);
  });
  await check('cancelled-response',async()=>{
    const config=await (await fetch(server.url+'/bridge.json')).json();
    const original=server.owner.call; let entered,release;
    const started=new Promise(yes=>{entered=yes;});const held=new Promise(yes=>{release=yes;});
    server.owner.call=async input=>{const result=await original(input);entered();await held;return result;};
    const req=request(server.url+'/bridge/observe',{method:'POST',headers:{Origin:server.url,'Content-Type':'application/json','X-Host-Fixture':config.token}});
    req.on('error',()=>{});req.end(JSON.stringify({version:1,documentId:DOCUMENT}));
    try { await started; req.destroy(); await new Promise(yes=>req.once('close',yes)); }
    finally { release();server.owner.call=original; }
    const response=await post(server,{version:1,documentId:DOCUMENT});assert.equal(response.status,200);
    assert.equal((await response.json()).data.revision,before.revision);
    assert.deepEqual(await server.owner.send({op:'state'}),before);
  });
  await check('bounded-messages',async()=>{
    assert.equal((await post(server,'x'.repeat(LIMITS.message+1))).status,413);
    assert.equal((await post(server,{version:1,documentId:DOCUMENT,cursor:'x'.repeat(513)})).status,400);
    await assert.rejects(server.owner.send({op:'unknown',value:'x'.repeat(LIMITS.message)}),/limit/);
    const requests=Array.from({length:LIMITS.pending},()=>server.owner.send({op:'state'}));
    await assert.rejects(server.owner.send({op:'state'}),/limit/); for(const value of await Promise.all(requests)) assert.equal(value.revision,before.revision);
  });
  await check('fixed-endpoints',async()=>{
    for(const input of [{op:'state'},{version:1,documentId:DOCUMENT,command:'sh'},{version:1,documentId:DOCUMENT,url:'https://example.invalid'},{version:1,documentId:DOCUMENT,actorId:'forged'}]) assert.equal((await post(server,input)).status,400);
    for(const path of ['/bridge/apply','/bridge/seed','/bridge/state','/bridge/peer','/bridge/shell','/bridge/fetch']) assert.equal((await fetch(server.url+path)).status,404);
    assert.equal((await fetch(server.url+'/bridge/observe')).status,405);
  });
  await check('independent-state',async()=>{
    assert.deepEqual(await server.owner.send({op:'state'}),before);
    assert.deepEqual(await server.owner.send({op:'seed'}),seed); assert.deepEqual(sqlite(facts.owner.database),db);
    facts.independent.sqliteUnchanged=true; facts.independent.sessionUnchanged=true;
  });
}
export async function browserCases({page,server,check,facts}) {
  const errors=[],external=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==server.url){external.push(route.request().url());return route.abort();}return route.continue();});
  const ownerBefore=await server.owner.send({op:'state'}), seed=await server.owner.send({op:'seed'});
  await page.goto(server.url); await page.getByText('Observation connection check available. Source read and human view are not mounted.',{exact:true}).waitFor();
  await page.evaluate(async seed=>{
    const {init}=await import('/core/index.js');const runtime=await init('/core/wasm/editac_wasm_bg.wasm');
    seed.bytes=new Uint8Array(seed.bytes); window.bridgePeer=runtime.restoreEngine(seed.identity,seed); window.bridgePeer.read();
  },seed);
  const oracle=()=>page.evaluate(async()=>({checkpoint:window.bridgePeer.checkpoint(),semantic:window.bridgePeer.read(),history:window.bridgePeer.history({type:'state'}),databases:await indexedDB.databases()}));
  const before=await oracle();
  await check('connected-observation',async()=>{
    await page.locator('#read').click();await page.waitForFunction(()=>!document.querySelector('#read').disabled);
    const result=JSON.parse(await page.locator('#transcript li:last-child pre').textContent());
    assert.equal(result.status,'ok');assert.equal(result.data.revision,ownerBefore.revision);assert.equal(result.data.durability,'not-reported');
    assert.match(await page.locator('#connection').textContent(),/Actual Session\/SQLite observation received/);
    facts.observed=result;
  });
  await check('cancel-and-resume',async()=>{
    let entered; const started=new Promise(resolve=>{entered=resolve;});let release;const held=new Promise(resolve=>{release=resolve;});
    await page.route('**/bridge/observe',async route=>{entered();await held;try{await route.continue();}catch{}});
    await page.locator('#read').click();await started;await page.locator('#cancel').click();
    await page.waitForFunction(()=>!document.querySelector('#read').disabled); release();await page.unroute('**/bridge/observe');
    assert.match(await page.locator('#transcript li:last-child pre').textContent(),/outcome unknown/);
    await page.locator('#read').click();await page.waitForFunction(()=>!document.querySelector('#read').disabled);
    assert.equal(JSON.parse(await page.locator('#transcript li:last-child pre').textContent()).data.revision,ownerBefore.revision);
  });
  await check('scope-and-inert-content',async()=>{
    assert.equal(await page.locator('#document').textContent(),DOCUMENT);assert.equal(await page.locator('#epoch').textContent(),EPOCH);
    assert.equal(await page.locator('#transcript img,#transcript a,[contenteditable]').count(),0);
    assert.match(await page.locator('#human-state').textContent(),/Unavailable/);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  });
  await check('actual-wasm-peer-unchanged',async()=>{
    assert.deepEqual(await oracle(),before);assert.deepEqual(await server.owner.send({op:'state'}),ownerBefore);
    assert.deepEqual(before.semantic.visible.map(n=>n.runs.map(r=>r.text).join('')),['base','other']);
    facts.actualPeer={identity:before.checkpoint.identity,history:before.history,unchanged:true};
    await page.evaluate(()=>window.bridgePeer.dispose());
  });
}
