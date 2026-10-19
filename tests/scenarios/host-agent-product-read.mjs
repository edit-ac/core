import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DOCUMENT, EPOCH } from '../../examples/host-agent-product/bridge.mjs';
const hash = text => 'sha256:'+createHash('sha256').update(text).digest('hex');
const sqlite = database => {
  const r = spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({t:[list(r) for r in c.execute('SELECT * FROM "'+t+'"')] for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")},default=lambda b:b.hex(),sort_keys=True))`,database],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
};
const input = extra => ({version:1,documentId:DOCUMENT,representation:'source',...extra});
const call = async (server,extra={},context=server.owner.context) => (await server.owner.tools.call('editac_v1_read',input(extra),context)).structuredContent;
async function post(server,path,value,headers={}) {
  const config = await (await fetch(server.url+'/bridge.json')).json();
  return fetch(server.url+path,{method:'POST',headers:{Origin:server.url,'Content-Type':'application/json','X-Host-Fixture':config.token,...headers},body:JSON.stringify(value)});
}
const denied = result => { assert.equal(result.status,'error'); assert.deepEqual(Object.keys(result).sort(),['code','status','version']); assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OWNER_DETAIL|base|other|source|profile|diagnostics/); };
const validate = (result,state) => {
  assert.equal(result.status,'ok'); const data = result.data;
  assert.equal(data.source,state.texts.join('\n\n')+'\n'); assert.equal(data.revision,state.revision);
  assert.equal(data.profile,'markdown-v1/images-disabled'); assert.deepEqual(data.diagnostics,[]); assert.equal(data.sourceHash,hash(data.source));
  assert.ok(data.expiresAt > Date.now()); assert.equal(Object.hasOwn(data,'target'),false); return data;
};
export async function modelCases(check,{server,facts}) {
  const before = await server.owner.send({op:'state'}), seed = await server.owner.send({op:'seed'}), db = sqlite(server.owner.database);
  facts.independent = {before,identity:seed.identity,sqliteBefore:db};
  await check('actual-scoped-read',async()=>{
    assert.deepEqual((await server.owner.inventory()).tools.map(t=>t.name),['editac_v1_read','editac_v1_observe']);
    const data = validate(await call(server),before); facts.exported = data;
    assert.equal(seed.identity.documentId,DOCUMENT); assert.equal(seed.identity.epoch,EPOCH); assert.ok(Object.keys(db).length);
    validate(await call(server,{representation:'markdown'}),before);
  });
  await check('detached-repeat-and-revision',async()=>{
    const first = await call(server); first.data.source = 'caller mutation'; first.data.diagnostics.push('caller mutation');
    validate(await call(server,{revision:before.revision}),before);
    const stale = await call(server,{revision:'stale-revision'}); assert.equal(stale.status,'ok'); assert.deepEqual(stale.data,{status:'rejected',code:'mismatch'});
    validate(await call(server),before);
  });
  await check('authorization-and-cross-document',async()=>{
    denied(await call(server,{},{})); denied(await call(server,{documentId:'private-document'}));
    for (const field of ['actorId','epoch','permissions','url']) denied(await call(server,{[field]:'private-owner-payload'}));
    server.owner.configure('revoked'); denied(await call(server)); server.owner.configure('no-read'); denied(await call(server));
    server.owner.configure('authorized'); validate(await call(server),before);
  });
  await check('readonly-unavailable-private-errors',async()=>{
    server.owner.configure('readonly'); validate(await call(server),before);
    for (const op of ['prepare','apply','receipt']) { const result = (await server.owner.probe(op,{version:1,documentId:DOCUMENT})).structuredContent; assert.equal(result.status,'error'); }
    server.owner.configure('unavailable'); denied(await call(server));
    server.owner.configure('private-error'); denied(await call(server));
    server.owner.configure('authorized'); validate(await call(server),before);
  });
  await check('transport-and-fixed-boundaries',async()=>{
    const request = {operation:'read',arguments:input()};
    assert.equal((await post(server,'/bridge/probe',request,{'X-Host-Fixture':'forged'})).status,403);
    assert.equal((await post(server,'/bridge/probe',request,{Origin:'https://example.invalid'})).status,403);
    assert.equal((await post(server,'/bridge/probe',{...request,url:'https://example.invalid'})).status,400);
    const response = await post(server,'/bridge/probe',request); assert.equal(response.status,200); validate(await response.json(),before);
    for (const path of ['/bridge/capture','/bridge/seed','/bridge/peer','/bridge/shell','/bridge/fetch']) assert.equal((await fetch(server.url+path)).status,404);
  });
  await check('independent-session-sqlite-identity',async()=>{
    assert.deepEqual(await server.owner.send({op:'state'}),before); assert.deepEqual(await server.owner.send({op:'seed'}),seed); assert.deepEqual(sqlite(server.owner.database),db);
    facts.independent.sessionUnchanged = true; facts.independent.sqliteUnchanged = true;
  });
}
export async function browserCases({page,server,check,facts}) {
  server.owner.configure('authorized'); const state = await server.owner.send({op:'state'}), seed = await server.owner.send({op:'seed'}), db = sqlite(server.owner.database);
  const errors = [], external = []; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{ if (new URL(route.request().url()).origin !== server.url) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(server.url); await page.waitForFunction(()=>!document.getElementById('read').disabled);
  await page.evaluate(async seed=>{ const {init} = await import('/core/index.js'); const runtime = await init('/core/wasm/editac_wasm_bg.wasm'); window.readPeer = runtime.restoreEngine(seed.identity,{...seed,bytes:new Uint8Array(seed.bytes)}); window.readPeer.read(); },seed);
  const oracle = () => page.evaluate(async()=>({checkpoint:window.readPeer.checkpoint(),semantic:window.readPeer.read(),history:window.readPeer.history({type:'state'}),databases:await indexedDB.databases()}));
  const before = await oracle(), idle = () => page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  const read = async()=>{ await page.locator('#read').click(); await idle(); const result = JSON.parse(await page.locator('#outcome').textContent());
    if (result.status === 'ok' && result.data?.sourceHash) result.data.source = await page.locator('#export-source').textContent(); return result; };
  const policy = async mode=>{ await page.selectOption('#policy',mode); await idle(); };
  const empty = async()=>{ assert.equal(await page.locator('#export-source').textContent(),''); assert.equal(await page.locator('#export-metadata').textContent(),''); assert.equal(await page.locator('#copy').isDisabled(),true); };
  await check('exact-visible-export',async()=>{
    assert.equal(await page.locator('#document').textContent(),DOCUMENT); assert.equal(await page.locator('#actor').textContent(),'agent-a');
    assert.equal(await page.locator('#copy').isDisabled(),true); const result = await read(); const data = validate(result,state);
    assert.equal(await page.locator('#export-source').textContent(),data.source);
    const metadata = JSON.parse(await page.locator('#export-metadata').textContent());
    assert.deepEqual(metadata,{documentId:DOCUMENT,epoch:EPOCH,revision:data.revision,profile:data.profile,sourceHash:data.sourceHash,diagnostics:[],expiresAt:data.expiresAt});
    assert.equal(await page.locator('#document-heading').locator('..').locator('dd').last().textContent(),state.revision);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),'Revision metadata stays within the viewport');
    assert.deepEqual(await page.locator('#tools li').allTextContents(),['read: available','prepare: unavailable','apply: unavailable','receipt: unavailable','observe: available']);
  });
  await check('explicit-authorized-copy',async()=>{
    await page.evaluate(()=>{ window.copied=[]; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copied.push(text)}}); });
    assert.deepEqual(await page.evaluate(()=>window.copied),[]);
    await page.locator('#copy').click(); await idle(); assert.deepEqual(await page.evaluate(()=>window.copied),[state.texts.join('\n\n')+'\n']);
    assert.equal(await page.locator('#copy-status').textContent(),'Exact source copied.');
    server.owner.configure('revoked'); await page.locator('#copy').click(); await idle(); await empty();
    assert.equal((await page.evaluate(()=>window.copied)).length,1); denied(JSON.parse(await page.locator('#outcome').textContent()));
    await policy('authorized'); await read();
  });
  await check('policy-and-private-payload-clear',async()=>{
    for (const mode of ['readonly','no-read','unavailable','private-error','revoked']) {
      await policy(mode); await empty();
      if (mode === 'readonly') validate(await read(),state);
      if (mode === 'private-error') { denied(await read()); await empty(); assert.doesNotMatch(await page.locator('#transcript').textContent(),/PRIVATE_OWNER_DETAIL/); }
      if (['no-read','unavailable','revoked'].includes(mode)) assert.equal(await page.locator('#read').isDisabled(),true);
    }
    await policy('authorized'); validate(await read(),state);
  });
  await check('transport-unknown-and-recovery',async()=>{
    await page.route('**/bridge/probe',route=>route.abort()); await page.locator('#read').click(); await idle(); await empty();
    assert.match(await page.locator('#outcome').textContent(),/outcome unknown/); assert.equal(await page.locator('#read').isDisabled(),true);
    await page.unroute('**/bridge/probe'); await page.locator('#refresh').click(); await idle(); validate(await read(),state);
  });
  await check('inert-bounded-keyboard-and-clear',async()=>{
    assert.match(await page.locator('#prose').textContent(),/<img/); assert.equal(await page.locator('#prose img,#export-source img,#transcript img,#export-source a').count(),0);
    await page.locator('#read').focus(); await page.keyboard.press('Enter'); await idle(); assert.equal(await page.locator('#export-source').textContent(),state.texts.join('\n\n')+'\n');
    assert.ok(await page.locator('#transcript li').count() <= 64); assert.ok((await page.locator('#transcript pre').allTextContents()).every(t=>t.length<=4096));
    await page.locator('#clear').click(); await empty(); assert.equal(await page.locator('#transcript li').count(),0); assert.equal(await page.locator('#outcome').textContent(),'');
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
  });
  await check('reject-oversized-detached-payload',async()=>{
    await read();
    await page.route('**/bridge/probe',async route=>{
      const response = await route.fetch(), result = await response.json();
      assert.equal(result.status,'ok'); result.data.source = 'x'.repeat(16385);
      await route.fulfill({response,json:result});
    });
    await page.locator('#read').click(); await idle(); await empty();
    assert.match(await page.locator('#outcome').textContent(),/outcome unknown/);
    assert.equal(await page.locator('#export-source').textContent(),'');
    await page.unroute('**/bridge/probe'); await page.locator('#refresh').click(); await idle(); validate(await read(),state);
  });
  await check('independent-owner-peer-history',async()=>{
    assert.deepEqual(await oracle(),before); assert.deepEqual(await server.owner.send({op:'state'}),state); assert.deepEqual(await server.owner.send({op:'seed'}),seed); assert.deepEqual(sqlite(server.owner.database),db);
    facts.independentRead = {identity:before.checkpoint.identity,history:before.history,sqliteUnchanged:true,peerUnchanged:true};
  });
  await check('current-revision-after-real-human-update',async()=>{
    validate(await read(),state);
    const copies = await page.evaluate(()=>window.copied.length);
    const vector = await server.owner.send({op:'vector'});
    const update = await page.evaluate(vector=>{
      const engine = window.readPeer, n = engine.read().visible[0], at = engine.anchor(n.id,0,'right');
      try { const plan=engine.prepare({kind:'editor',origin:'human:typing',commands:[{type:'insert',at,text:'human 😀 '}]}); engine.commit(plan); } finally { engine.releaseAnchor(at); }
      return {writerId:engine.checkpoint().writerId,bytes:[...engine.encodeUpdate(new Uint8Array(vector)).bytes]};
    },vector);
    await server.owner.send({op:'peer',...update}); const changed = await server.owner.send({op:'state'});
    assert.notEqual(changed.revision,state.revision); assert.equal(changed.texts[0],'human 😀 '+state.texts[0]);
    const changedDB = sqlite(server.owner.database);
    await page.locator('#copy').click(); await idle();
    assert.equal(await page.evaluate(()=>window.copied.length),copies);
    assert.match(await page.locator('#copy-status').textContent(),/Source changed/);
    assert.equal(await page.locator('#export-source').textContent(),changed.texts.join('\n\n')+'\n');
    validate(await read(),changed);
    assert.deepEqual(await server.owner.send({op:'state'}),changed); assert.deepEqual(sqlite(server.owner.database),changedDB);
    facts.currentRevision = {before:state.revision,after:changed.revision,sourceHash:hash(changed.texts.join('\n\n')+'\n'),humanChannel:'actual installed WASM peer → Session/SQLite'};
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]); await page.evaluate(()=>window.readPeer.dispose());
  });
}
