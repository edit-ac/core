import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { init } from '@edit-ac/core';
import * as links from '@edit-ac/core/links';
import * as web from '@edit-ac/web/links';
const corpus = JSON.parse(readFileSync(new URL('./platforms.json', import.meta.url)));
const platform = corpus.platforms.find(p => p.id === process.env.EDITAC_LINK_PLATFORM);
assert.ok(platform, 'named platform fixture must exist');
assert.equal(corpus.qualification, 'headless-contract-only');
assert.deepEqual(corpus.states, ['available','unavailable','forbidden','missing','locked','unsupported','canceled','stale']);
const runtime = await init('data:application/wasm;base64,' + readFileSync(new URL(import.meta.resolve('@edit-ac/core/wasm'))).toString('base64'));
const targetId = 'ac://team/71000000-0000-4000-8000-000000000008';
let sequence=0;
function fixture(kind = 'private', readonly = false) {
  const engine = runtime.createEngine({ profile:'v5', documentId:'71000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'), epoch:'72000000-0000-4000-8000-000000000001', nodes:[{text:'Shared authored label'}] });
  const r = { requestId:'request1', cancellationToken:'cancel1', node:engine.read().visible[0].id, epoch:engine.read().identity.epoch, labelRevision:'label1',
    host:{principal:'alice',tenant:'tenant1',authority:'team',scope:{document:engine.read().identity.documentId,session:'session1',revision:String(engine.read().revision),permission:'permission1',authorized:true},policyRevision:'policy1',readonly,
      capabilities:{publicMetadata:true,privateLookup:true,title:true,icon:true,preview:true,activate:true,publishMetadata:true}},
    target:kind === 'private' ? {kind,targetId,authority:'team'} : {kind,url:'https://example.test/a%2Fb?q=intentional#part'},policy:'explicit-refresh',origin:'explicit-refresh'};
  const before = engine.checkpoint().bytes;
  const h = {request:r,current:structuredClone(r),calls:[],catalogs:0,lookups:0,entry:'hosted',locator:targetId};
  h.presenter = new links.LinkPresenterSession(r, 'Shared authored label');
  h.activation = new links.LinkActivation({context:()=>h.current.host,current:()=>h.current,
    catalog:{catalog(id){h.catalogs++;return {status:h.entry,targetId:id};}},privateLocator:()=>h.locator,
    dispatch(action){assert.ok(Object.isFrozen(action));h.calls.push(action);return 'available';}});
  h.result = status => ({request:structuredClone(r),outcome:status === 'available' ? {status,metadata:kind === 'private'
    ? {kind,targetId,display:{title:'SECRET title',description:'SECRET preview',iconAsset:'vetted-icon'}}
    : {kind,requestedUrl:r.target.url,provider:'prepared',canonicalUrl:'https://example.test/advisory',display:{title:'Public title'}},
    freshness:{fetchedAt:10,expiresAt:100,policyRevision:'policy1'}} : {status}});
  h.done = () => {assert.deepEqual(engine.checkpoint().bytes,before,'no fetched data/action enters actual shared CRDT');assert.equal(h.lookups,0);h.presenter.dispose();h.activation.dispose();engine.dispose();};
  return h;
}
for (const readonly of [false,true]) for (const kind of ['public','private']) for (const state of corpus.states) test(`${platform.id}: readonly=${readonly} ${kind} ${state} safe display and unchanged shared state`,()=>{
  const h=fixture(kind,readonly);try {
    const view=h.presenter.present(h.result(state),h.current,20);
    assert.equal(view.state,state);assert.equal(view.label,'Shared authored label');assert.ok(Object.isFrozen(view));
    if(state==='available'){assert.equal(view.display.title,kind==='private'?'SECRET title':'Public title');assert.ok(Object.isFrozen(view.display));}
    else {assert.equal(view.display,undefined);assert.equal(view.freshness,undefined);assert.ok(!JSON.stringify(view).includes('SECRET'));}
    assert.equal(h.calls.length,0);assert.equal(h.catalogs,0);
    assert.ok(view.actions.every(a=>a.kind==='activate'||a.kind==='copy-locator'));
  }finally{h.done();}
});
for(const [field,expected] of [['principal','forbidden'],['tenant','forbidden'],['authority','forbidden'],['permission','forbidden'],['policy','stale'],['session','stale'],['revision','stale'],['node','stale'],['token','stale'],['readonly','stale']]) test(`${platform.id}: current ${field} invalidates private metadata and action`,()=>{
  const h=fixture();try {
    if(['principal','tenant','authority'].includes(field))h.current.host[field]='other';
    else if(['permission','session','revision'].includes(field))h.current.host.scope[field]='other';
    else if(field==='policy')h.current.host.policyRevision='other';
    else if(field==='node')h.current.node='other';else if(field==='token')h.current.cancellationToken='other';else h.current.host.readonly=true;
    const view=h.presenter.present(h.result('available'),h.current,20);
    assert.equal(view.state,expected);assert.equal(view.display,undefined);assert.deepEqual(view.actions,[]);
    assert.equal(h.activation.perform({kind:'activate',request:h.request}),field==='readonly'?'available':expected);assert.equal(h.calls.length,field==='readonly'?1:0);
  }finally{h.done();}
});
test(`${platform.id}: canceled and disposed sessions discard late private results`,()=>{
  const h=fixture();try{
    const controller=new AbortController();const presenter=new links.LinkPresenterSession(h.request,'Shared authored label',controller.signal);
    controller.abort();let view=presenter.present(h.result('available'),h.current,20);assert.equal(view.state,'canceled');assert.equal(view.display,undefined);assert.deepEqual(view.actions,[]);
    assert.equal(h.activation.perform({kind:'activate',request:h.request},controller.signal),'canceled');
    h.presenter.dispose();h.activation.dispose();view=h.presenter.present(h.result('available'),h.current,20);assert.equal(view.state,'canceled');assert.equal(view.display,undefined);assert.deepEqual(view.actions,[]);
    assert.equal(h.activation.copy(h.request),'canceled');assert.deepEqual(h.calls,[]);
  }finally{h.done();}
});
test(`${platform.id}: readonly host receives exact typed navigation and safe copy without publication`,()=>{
  const h=fixture('private',true);try{
    const view=h.presenter.present(h.result('available'),h.current,20);
    assert.equal(view.state,'available');assert.ok(view.actions.some(a=>a.kind==='activate'));
    assert.equal(links.linkIntentPermission(h.request,h.current.host,'commit-metadata'),'forbidden');
    assert.equal(h.activation.perform(view.actions.find(a=>a.kind==='activate')),'available');assert.equal(h.activation.copy(h.request),'available');
    assert.deepEqual(h.calls.map(a=>a.kind),['open-private','copy-locator']);assert.ok(h.calls.every(a=>a.locator===targetId&&a.target.targetId===targetId));
    assert.ok(h.calls.every(a=>!('command' in a)&&!('args' in a)));
  }finally{h.done();}
});
for(const state of ['locked','unauthorized','unavailable','incompatible'])test(`${platform.id}: current catalog ${state} blocks activation and copy`,()=>{
  const h=fixture();try{h.entry=state;const expected={locked:'locked',unauthorized:'forbidden',unavailable:'unavailable',incompatible:'unsupported'}[state];
    assert.equal(h.activation.perform({kind:'activate',request:h.request}),expected);assert.equal(h.activation.copy(h.request),expected);assert.deepEqual(h.calls,[]);
  }finally{h.done();}
});
test(`${platform.id}: metadata canonical URL cannot change external activation identity`,()=>{
  const h=fixture('public',true);try{h.presenter.present(h.result('available'),h.current,20);
    assert.equal(h.activation.perform({kind:'activate',request:h.request}),'available');assert.equal(h.calls[0].kind,'open-external');assert.equal(h.calls[0].locator,h.request.target.url);
  }finally{h.done();}
});
test(`${platform.id}: malformed, expired and wrong-ticket private results never disclose`,()=>{
  const h=fixture();try{
    for(const change of [r=>r.outcome.freshness.expiresAt=20,r=>r.request.node='other',r=>r.outcome.metadata.display.iconAsset='https://secret.test/icon',r=>r.outcome.metadata.targetId='other']){
      const result=h.result('available');change(result);const view=h.presenter.present(result,h.current,20);assert.notEqual(view.state,'available');assert.equal(view.display,undefined);
    }
  }finally{h.done();}
});
test(`${platform.id}: private field capability loss hides title icon and preview`,()=>{
  const h=fixture();try{for(const cap of ['title','icon','preview']){const r=structuredClone(h.request);r.host.capabilities[cap]=false;
    const presenter=new links.LinkPresenterSession(r,'Shared authored label');const result=h.result('available');result.request=r;
    const view=presenter.present(result,r,20);assert.equal(view.state,'forbidden');assert.equal(view.display,undefined);presenter.dispose();}
  }finally{h.done();}
});
test(`${platform.id}: imports share public owner identity and browser factories`,()=>{
  for(const name of ['LinkActivation','LinkPresenterSession','captureLinkRequest','validateLinkResult'])assert.equal(web[name],links[name]);
  for(const name of ['bindLinkActivation','linkEnrichment','privateReferenceDisplay'])assert.equal(typeof web[name],'function');
});
for(const origin of ['open','render','remote','replay','history'])test(`${platform.id}: ${origin} policy admission makes zero host calls`,async()=>{
  const h=fixture();try{
    const ports={publicMetadata:async()=>{h.lookups++;return {status:'unavailable'};},privateCatalog:async()=>{h.lookups++;return {status:'unavailable'};}};
    const r={...h.request,origin,policy:'local-paste'};const admitted=links.admitLinkRequest(r,r.host);
    if(admitted.status==='ready')await ports[admitted.port==='public'?'publicMetadata':'privateCatalog'](r,new AbortController().signal);
    assert.deepEqual(admitted,{status:'unavailable'});assert.equal(h.lookups,0);
  }finally{h.done();}
});
test(`${platform.id}: finite cache policy records match portable defaults and reject unbounded values`,()=>{
  assert.deepEqual(links.DEFAULT_PUBLIC_LINK_CACHE_POLICY,{concurrency:4,queue:32,pending:128,cacheEntries:64,positiveMs:300000,negativeMs:5000,queueMs:5000});
  assert.deepEqual(links.DEFAULT_PRIVATE_LINK_CACHE_POLICY,{entries:64,offlineLeaseMs:0});
  assert.ok(links.validPublicLinkCachePolicy(links.DEFAULT_PUBLIC_LINK_CACHE_POLICY));assert.ok(links.validPrivateLinkCachePolicy(links.DEFAULT_PRIVATE_LINK_CACHE_POLICY));
  for(const [key,max] of Object.entries({concurrency:8,queue:256,pending:1024,cacheEntries:256,positiveMs:3600000,negativeMs:60000,queueMs:30000})){
    assert.ok(links.validPublicLinkCachePolicy({...links.DEFAULT_PUBLIC_LINK_CACHE_POLICY,[key]:max}));
    for(const value of [0,-1,0.5,NaN,Infinity,max+1])assert.equal(links.validPublicLinkCachePolicy({...links.DEFAULT_PUBLIC_LINK_CACHE_POLICY,[key]:value}),false);
  }
  for(const [key,max,min] of [['entries',256,1],['offlineLeaseMs',300000,0]]){
    assert.ok(links.validPrivateLinkCachePolicy({...links.DEFAULT_PRIVATE_LINK_CACHE_POLICY,[key]:max}));
    for(const value of [min-1,0.5,NaN,Infinity,max+1])assert.equal(links.validPrivateLinkCachePolicy({...links.DEFAULT_PRIVATE_LINK_CACHE_POLICY,[key]:value}),false);
  }
});
