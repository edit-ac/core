import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {browserHarness} from './browser-harness.ts';
const directory='fixtures/browser-image-lifecycle';
const corpus=JSON.parse(await readFile('fixtures/rich-content/asset-descriptors.json','utf8'));
const asset=corpus.descriptors.find(d=>d.kind==='image');
const {probe}=browserHarness('image-lifecycle',directory,{markdown:true,autoMount:false,assertSourcesUnchanged:true,sourcePaths:[
 'packages/web/src/modules/images/policy.ts','packages/web/src/modules/images/presenter.ts','packages/web/src/modules/content.ts','packages/web/src/index.ts','packages/web/src/modules/index.ts','packages/web/src/dom/render.ts',
 ...['session.mjs','index.html','pixel.png','pixel.jpg','crc.png','inflate.png','huge.png','animated.png','animated.gif','malformed.png','vector.svg'].map(n=>`${directory}/${n}`),'fixtures/rich-content/asset-descriptors.json',
],beforeNavigate:async(page,fact)=>{
 await page.route('https://assets.invalid/**',async route=>{
  fact.authorizedFetches??=[];fact.authorizedFetches.push({url:route.request().url(),headers:route.request().headers()});
  const name=new URL(route.request().url()).pathname.slice(1)||'pixel.png';
  await route.fulfill({status:200,body:await readFile(`${directory}/${name}`),headers:{'content-type':'application/octet-stream','access-control-allow-origin':'*'}});
 });
 await page.addInitScript(()=>{
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),make=document.createElement.bind(document);
  const live=new Set(),images=[];window.imageResources={live,images,created:0,revoked:0};
  URL.createObjectURL=blob=>{const url=create(blob);live.add(url);window.imageResources.created++;return url;};
  URL.revokeObjectURL=url=>{if(live.delete(url))window.imageResources.revoked++;revoke(url);};
  document.createElement=(tag,...rest)=>{const el=make(tag,...rest);if(tag==='img')images.push(el);return el;};
 });
}});
async function mount(page,options={}){
 await page.waitForFunction(()=>!!window.inputFixture);
 await page.evaluate(async({options,asset})=>{
  const control=window.imageControl={calls:[],cancels:[],signals:[],pending:[],release(){for(const done of this.pending.splice(0))done();}};
  window.imageLifecycleOptions={imageLimits:options.limits,imageAssets:{
   async resolve(request,signal){control.calls.push(request);control.signals.push(signal);if(options.paused)await new Promise(done=>control.pending.push(done));
    const identity=options.wrongIdentity?{host:'other',key:'wrong'}:request.identity;
    return {state:options.state??'available',grant:{identity,actions:options.noRead?['resolve-url']:['resolve-url','read']},resolution:{identity,operationId:options.wrongOperation?'wrong':request.operationId,url:options.url??`https://assets.invalid/${options.media??'pixel.png'}`}};
   },cancel(request){control.cancels.push(request.operationId);}
  }};
  await window.inputFixture.mount({...options,...(options.legacy?{}:{asset})});
 },{options,asset});
}
const imageState=page=>page.locator('[data-image-state]').getAttribute('data-image-state');
async function waitState(page,expected){await page.waitForFunction(expected=>[...document.querySelectorAll('[data-image-state]')].some(e=>e.dataset.imageState===expected),expected,{timeout:15000});assert.equal(await imageState(page),expected);}
async function unchanged(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.equal(s.commands.length,0);assert.equal(s.history.undoGroups,0);assert.deepEqual(s.errors,[]);return s;}
async function disposed(page,fact){
 await page.evaluate(()=>window.inputFixture.disposeSurface());
 const state=await page.evaluate(()=>({urls:window.imageResources.live.size,created:window.imageResources.created,revoked:window.imageResources.revoked,images:window.imageResources.images.filter(i=>i.hasAttribute('src')).length,signals:window.imageControl.signals.filter(s=>!s.aborted).length,cancels:window.imageControl.cancels.length,calls:window.imageControl.calls.length}));
 fact.resources=state;assert.equal(state.urls,0);assert.equal(state.images,0);assert.equal(state.signals,0);assert.equal(state.created,state.revoked);assert.equal(state.cancels,state.calls);
}
test('stable asset actual PNG bytes decode through identity-scoped host records; source/history stay inert',()=>probe('asset-ready',async(page,fact)=>{
 await mount(page);await waitState(page,'ready');const image=page.locator('[data-content-module=image] img');await page.waitForFunction(()=>document.querySelector('[data-content-module=image] img').naturalWidth===2);
 assert.equal(await image.getAttribute('alt'),asset.metadata.alt);assert.equal(await page.getByRole('textbox',{name:'Image source',exact:true}).inputValue(),asset.source.replaceAll('\r\n','\n'));
 const s=await unchanged(page,fact);assert.deepEqual(s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.asset').blockAttributes[2],asset);
 const request=await page.evaluate(()=>window.imageControl.calls[0]);assert.equal(request.version,1);assert.equal(request.action,'resolve-url');assert.deepEqual(request.identity,asset.identity);assert.equal(request.byteLimit,8388608);
 assert.equal(await page.evaluate(()=>window.imageResources.images.length),1);assert.equal(fact.authorizedFetches.length,1);assert.equal(fact.authorizedFetches[0].headers.cookie,undefined);assert.equal(fact.authorizedFetches[0].headers.referer,undefined);await disposed(page,fact);
}));
for(const [media,state]of [['vector.svg','media-unsupported'],['animated.gif','media-unsupported'],['animated.png','animated-unsupported'],['huge.png','decoded-size-limit'],['malformed.png','malformed'],['crc.png','malformed'],['inflate.png','malformed']])test(`actual media policy: ${media}`,()=>probe(media,async(page,fact)=>{
 await mount(page,{media});await waitState(page,state);assert.equal(await page.locator('[data-content-module=image] img').getAttribute('src'),null);assert.equal(await page.locator('svg,iframe,object').count(),0);await unchanged(page,fact);await disposed(page,fact);
}));
for(const state of ['offline','locked','missing','queued','revoked','failed'])test(`accessible ${state} fallback makes no media request`,()=>probe(`state-${state}`,async(page,fact)=>{
 await mount(page,{state});await waitState(page,state);assert.match(await page.locator('[data-content-module=image] [role=status]').textContent(),new RegExp(state));assert.equal(await page.getByRole('textbox',{name:'Image source',exact:true}).inputValue(),asset.source.replaceAll('\r\n','\n'));assert.equal(fact.authorizedFetches?.length??0,0);await unchanged(page,fact);await disposed(page,fact);
}));
for(const option of ['wrongIdentity','wrongOperation','noRead'])test(`reject mismatched authorization ${option}`,()=>probe(option,async(page,fact)=>{
 await mount(page,{[option]:true});await waitState(page,'unauthorized');assert.equal(fact.authorizedFetches?.length??0,0);await disposed(page,fact);
}));
test('encoded byte cap rejects stream before object URL or decoding',()=>probe('encoded-cap',async(page,fact)=>{await mount(page,{limits:{encodedBytes:32}});await waitState(page,'encoded-byte-limit');assert.equal(await page.evaluate(()=>window.imageResources.created),0);await disposed(page,fact);}));
test('pixel and dimension policies are separately enforced before decode',()=>probe('pixel-cap',async(page,fact)=>{await mount(page,{limits:{pixels:3}});await waitState(page,'decoded-size-limit');assert.equal(await page.evaluate(()=>window.imageResources.created),0);await disposed(page,fact);}));
test('absent legacy policy never fetches authored URL',()=>probe('disabled',async(page,fact)=>{await mount(page,{legacy:true,noPolicy:true,imageSource:'![alt](https://assets.invalid/pixel.png)'});await waitState(page,'missing');assert.equal(fact.authorizedFetches?.length??0,0);await disposed(page,fact);}));
test('legacy host URL uses the same bounded decoder',()=>probe('legacy',async(page,fact)=>{await mount(page,{legacy:true,imageSource:'![Literal alt](https://untrusted.invalid/a)'});await waitState(page,'ready');await unchanged(page,fact);await disposed(page,fact);}));
test('dispose during authorization fences late resolution and issues host read cancel',()=>probe('cancel-resolve',async(page,fact)=>{await mount(page,{paused:true});await waitState(page,'loading');await disposed(page,fact);await page.evaluate(()=>window.imageControl.release());await page.evaluate(()=>new Promise(done=>setTimeout(done,30)));assert.equal(fact.authorizedFetches?.length??0,0);assert.equal(await page.evaluate(()=>window.imageResources.live.size),0);}));
test('timeout aborts uncooperative authorization without a late fetch',()=>probe('timeout',async(page,fact)=>{await mount(page,{paused:true,limits:{timeoutMs:30}});await waitState(page,'timeout');await page.evaluate(()=>window.imageControl.release());assert.equal(fact.authorizedFetches?.length??0,0);await disposed(page,fact);}));
test('repeated mount/dispose releases every image URL, decoder and request',()=>probe('repeat-disposal',async(page,fact)=>{
 await mount(page);await waitState(page,'ready');for(let i=0;i<12;i++){await page.evaluate(()=>window.inputFixture.reopen());await waitState(page,'ready');}await unchanged(page,fact);await disposed(page,fact);assert.equal(fact.resources.created,13);
}));
test('shared pool bounds concurrent work with no queue',()=>probe('concurrency',async(page,fact)=>{
 await mount(page,{legacy:true,imageSource:Array.from({length:5},(_,i)=>`![${i}](https://assets.invalid/${i}.png)`).join('\n\n')});
 await page.waitForFunction(()=>document.querySelectorAll('[data-image-state=busy]').length===3);assert.equal(await page.locator('[data-image-state=busy]').count(),3);await disposed(page,fact);
}));

test('static JPEG is admitted by actual bytes',()=>probe('jpeg',async(page,fact)=>{await mount(page,{media:'pixel.jpg'});await waitState(page,'ready');await disposed(page,fact);}));
test('explicit retry preserves fallback and document state',()=>probe('retry',async(page,fact)=>{
 await mount(page,{legacy:true,noPolicy:true,imageSource:'![alt](https://assets.invalid/pixel.png)'});await waitState(page,'missing');await page.getByRole('button',{name:'Load image',exact:true}).click();await waitState(page,'missing');await unchanged(page,fact);await disposed(page,fact);
}));
test('content retirement aborts work and a late host result cannot resurrect the presenter',()=>probe('retire-pending',async(page,fact)=>{
 await mount(page,{paused:true});await waitState(page,'loading');
 await page.evaluate(async()=>{const f=window.inputFixture,n=f.engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.asset'),at=f.engine.anchor(n.id,0,'right');try{f.engine.commit(f.engine.prepare({kind:'editor',origin:'retire-image',commands:[{type:'atomicContent',owner:n.id,expected:n.blockAttributes,at,replacement:null}]}));}finally{f.engine.releaseAnchor(at);}await f.settle();window.imageControl.release();});
 await page.waitForFunction(()=>!document.querySelector('[data-content-module=image]'),null,{timeout:5000});assert.equal(fact.authorizedFetches?.length??0,0);await disposed(page,fact);
}));
test('disposing during actual fetch aborts its signal and retains zero decoder resources',()=>probe('cancel-fetch',async(page,fact)=>{
 let release;const pending=new Promise(done=>{release=done;});let requested=false;
 await page.route('https://assets.invalid/pixel.png',async route=>{requested=true;await pending;await route.fulfill({body:await readFile(`${directory}/pixel.png`),headers:{'access-control-allow-origin':'*'}}).catch(()=>{});});
 await mount(page);await page.waitForRequest('https://assets.invalid/pixel.png',{timeout:5000}).catch(()=>{assert.equal(requested,true);});
 await disposed(page,fact);release();assert.equal(await page.evaluate(()=>window.imageResources.created),0);
}));

for(const url of ['javascript:alert(1)','https://user:secret@assets.invalid/pixel.png','http://assets.invalid/pixel.png'])test(`asset URL policy rejects ${url}`,()=>probe(`url-${encodeURIComponent(url)}`,async(page,fact)=>{await mount(page,{url});await waitState(page,'unauthorized');assert.equal(fact.authorizedFetches?.length??0,0);await disposed(page,fact);}));
test('untrusted host errors do not become presentation text',()=>probe('host-error',async(page,fact)=>{await mount(page,{legacy:true,throwPolicy:true});await waitState(page,'failed');assert.equal(await page.locator('[data-content-module=image] [role=status]').textContent(),'Image failed; source preserved.');await disposed(page,fact);}));

test('stable source copies literal selected text and never enters an editor command',()=>probe('stable-copy',async(page,fact)=>{
 await mount(page);await waitState(page,'ready');const source=page.getByRole('textbox',{name:'Image source',exact:true});await source.focus();await source.press('ControlOrMeta+a');
 const copied=await source.evaluate(el=>{const data=new DataTransfer();el.dispatchEvent(window.preparedClipboardEvent('copy',data));return data.getData('text/plain');});assert.equal(copied,asset.source.replaceAll('\r\n','\n'));await unchanged(page,fact);await disposed(page,fact);
}));
