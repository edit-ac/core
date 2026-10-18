import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const descriptors=JSON.parse(readFileSync('fixtures/rich-content/asset-descriptors.json','utf8')).descriptors;
const embed={url:'https://content.invalid/watch',provider:'prepared-video',fallback:'Prepared video 😀',source:'exact inert embed source'};
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installExtensionCounters } from './resources.mjs';
import { installResourceCounters } from '../../mobile-web/resources.mjs';

const { probe, facts } = browserHarness('mobile-extensions', 'fixtures/browser-mobile-extensions', {
  autoMount: false, testFile: 'tests/browser/mobile-extensions/assets.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: process.env.EDITAC_MOBILE_EXTENSIONS_BROWSER !== 'firefox' },
  serverOptions: { recordRequests: true }, beforeNavigate: async (page, fact) => {
    page.setDefaultTimeout(5000);
    fact.unexpectedRequests=[];fact.unexpectedPages=[];
    page.context().on('page',p=>fact.unexpectedPages.push(p.url()));
    await page.addInitScript(()=>{
      (window as any).mobileAuthorityProbes={permissions:0,capture:0,open:0};
      window.open=()=>{(window as any).mobileAuthorityProbes.open++;return null;};
      if(navigator.permissions)navigator.permissions.query=()=>{(window as any).mobileAuthorityProbes.permissions++;return Promise.reject(Error('No real permission probing in prepared checks'));};
      if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{(window as any).mobileAuthorityProbes.capture++;return Promise.reject(Error('No capture in prepared checks'));};
    });
    fact.assetFetches=[];fact.embedFetches=[];
    await page.route('**/*',async route=>{const url=route.request().url();
      if(url.startsWith('https://assets.invalid/')){fact.assetFetches.push(url);const name=new URL(url).pathname.slice(1);return route.fulfill({body:readFileSync('fixtures/browser-image-lifecycle/'+name),contentType:'application/octet-stream',headers:{'access-control-allow-origin':'*'}});}
      if(url.startsWith('https://isolated.invalid/player?')){fact.embedFetches.push(url);return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Prepared player</title><div style="height:800px">Local prepared embed</div>'});}
      if(new URL(url).origin!==new URL(fact.origin).origin){fact.unexpectedRequests.push(url);return route.abort();}return route.continue();});
    await page.addInitScript(()=>{const urls=new Set<string>(),create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);(window as any).assetUrls={urls,created:0,revoked:0};URL.createObjectURL=blob=>{const url=create(blob);urls.add(url);(window as any).assetUrls.created++;return url;};URL.revokeObjectURL=url=>{if(urls.delete(url))(window as any).assetUrls.revoked++;revoke(url);};});
    await page.addInitScript(installResourceCounters); await page.addInitScript(installExtensionCounters); },
  sourcePaths: ['../architecture/specs/editor-interactions.md', '../architecture/specs/link-resolution.md','fixtures/browser-mobile-extensions/reference-display.mjs', 'packages/web/src/modules/references/display.ts', 'packages/web/dist/modules/references/display.js', 'packages/web/src/modules/links/activation.ts', 'packages/core/src/links/activation.ts','packages/web/src/modules/touch-controls.ts', 'packages/web/dist/modules/touch-controls.js', 'packages/web/src/ui/commands.ts', 'packages/web/dist/ui/commands.js','packages/web/src/extensions/highlighting.ts', 'packages/web/src/extensions/assets.ts', 'packages/web/src/extensions/math.ts', 'tests/consumers/mobile-extensions/graph.mjs', 'scripts/build-extension-runtime.mjs','packages/web/src/modules/presenter-sequence.ts','packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts', ...['search','reorder','slash','references','content'].flatMap(n=>[`packages/web/src/extensions/runtime/${n}.ts`,`packages/web/dist/extensions/runtime/${n}.js`]),'packages/web/dist/extensions/runtime/manifest.json',...browserInputSources, 'fixtures/browser-mobile-extensions/session.mjs', 'fixtures/browser-mobile-extensions/index.html',
    'tests/browser/mobile-extensions/assets.spec.ts', 'fixtures/browser-mobile-extensions/asset-input.mjs', 'packages/web/src/modules/asset-input.ts', 'packages/web/dist/modules/asset-input.js', 'packages/web/src/sync/assets.ts', 'packages/web/dist/sync/assets.js', 'packages/web/src/storage/owner.ts', 'packages/web/src/storage/index.ts', ...['pixel.png','malformed.png','huge.png'].map(n=>'fixtures/browser-image-lifecycle/'+n), 'fixtures/browser-mobile-extensions/asset-host.mjs', '../architecture/specs/rich-content-extensions.md', 'tests/browser/mobile-extensions/content-host-matrix.ts', 'tests/browser/mobile-extensions/command-matrix.ts', 'tests/browser/mobile-extensions/command-inventory.mjs',
    'fixtures/rich-content/asset-descriptors.json', 'packages/core/src/extensions/profiles.ts', 'packages/web/src/commands/catalog.ts',
    ...['modules/images/presenter','modules/attachments/presenter','modules/embeds/presenter','modules/content','modules/reorder','modules/search','modules/references','modules/slash','extensions/code'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
    'tests/browser/mobile-extensions/index.mjs', 'tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs', 'tests/browser/mobile-extensions/resources.mjs', 'scripts/test-mobile-extensions.mjs', 'packages/web/package.json',
    '../architecture/tests/mobile-extension-cases.md', '../architecture/specs/mobile-web.md',
    ...['editor', 'surface', 'extensions/configuration', 'extensions/contract', 'platform/viewport'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`])],
});
facts.binding = {gate:'MEX-1.5', ids:['MWX-C17','MWX-C18','MWX-C19','MWX-C20'],
 semantics:'actual packed BrowserEditor/Session/WASM/IndexedDB; prepared viewport/pointer/remote edits',
 platform:'desktop Chromium/Firefox/WebKit mechanics; original MWX-1.8 device/OS/native/IME/AT pending',
 incomplete:'Device/OS/native/IME/AT/performance/release remain deferred; portable picker/ingest uses actual AssetSession',
 targetRule:'intrinsic 44 CSS px width/height, scoped touch-action:none on explicit drag handle only'};
async function frame(page) { await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); }
async function mount(page, options = {}) {
  await page.waitForFunction(() => !!(window as any).inputFixture);
  await page.evaluate(() => { // Do not let fixture CSS supply production target sizes.
    const style = document.querySelector('style')!; style.textContent = style.textContent!.replace(/button \{[^}]+\}/g, '');
    (window as any).mobileGeometry = { visual: { left:0, top:0, width:390, height:740 }, scale:1 };
  });
  const baseline = await page.evaluate(() => (window as any).mobileResources());
  await page.evaluate(async options => { const f = (window as any).inputFixture; await f.mount({ text: 'alpha', viewport:true, ...options }); f.select(f.ids[0], 2); await f.settle(); }, options);
  await frame(page); return baseline;
}
async function snapshot(page) {
  return page.evaluate(async () => { const f = (window as any).inputFixture, s = await f.state();
    return { nodes: s.nodes, selection:s.selection, history: s.history, patches: s.patches, journal: s.journal, checkpoint: Array.from(f.engine.checkpoint().bytes), errors: s.errors, storage: s.storage }; });
}
async function finish(page, baseline, fact) {
  fact.activeResources = await page.evaluate(() => (window as any).mobileResources());
  const changes = await page.evaluate(async () => { const f = (window as any).inputFixture, updates = [];
    const sub = f.engine.subscribe({type:'all'}, patch => { if(patch.update)updates.push(patch.origin); });
    try { await f.destroy(); } finally { sub.dispose(); } return updates; });
  assert.deepEqual(changes, [], 'teardown emits no semantic transactions'); fact.teardownUpdates = changes; await frame(page);
  const after = await page.evaluate(() => (window as any).mobileResources());
  fact.resources = { baseline, after }; assert.deepEqual(after, baseline, 'all mounted resource ownership released');
  fact.urls=await page.evaluate(()=>({...((window as any).assetUrls),urls:[...(window as any).assetUrls.urls]}));assert.deepEqual(fact.urls.urls,[],'owned object URLs released');
  fact.optionalAfter=await page.evaluate(()=>(window as any).mobileExtensionResources());
  assert.equal(fact.optionalAfter.listeners,0,'optional listeners released separately from baseline');
  assert.deepEqual(fact.unexpectedRequests,[],'no unsolicited network work');
  assert.deepEqual(fact.unexpectedPages,[],'no unsolicited browser context');
  fact.authorityProbes=await page.evaluate(()=>(window as any).mobileAuthorityProbes);
  assert.deepEqual(fact.authorityProbes,{permissions:0,capture:0,open:0},'no real permission/capture/open work');
}

const card=page=>page.locator('[data-content-module="image"],[data-content-module="attachment"],[data-content-module="embed"]');
async function mountAsset(page,kind,options={}) {
 await page.waitForFunction(() => !!(window as any).inputFixture);
 await page.evaluate(async options=>{const {assetHost}=await import('/fixture/asset-host.mjs');(window as any).mobileAssetOptions=assetHost(options);},options);
 const asset=descriptors.find(d=>d.kind===kind);
 const baseline=await mount(page,{assetActions:true,nodes:[{text:''},{text:'surrounding 😀 text'}],...(kind==='embed'?{embed}:{asset})});
 // Retain a real backward native text selection beside the content card.
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids.at(-1),8,2);});await frame(page);
 return baseline;
}
async function waitState(page,value){await page.waitForFunction(value=>{const e=document.querySelector<HTMLElement>('[data-content-module="image"],[data-content-module="attachment"],[data-content-module="embed"]');return e&&Object.values(e.dataset).includes(value);},value);}
async function control(page){return page.evaluate(()=>{const c=(window as any).assetControl;return {calls:c.calls,canceled:c.canceled,signals:c.signals.map(s=>s.aborted),pending:c.pending.length};});}
async function semantic(page){const s=await snapshot(page);return {nodes:s.nodes,selection:(s as any).selection,history:s.history,patches:s.patches,journal:s.journal,checkpoint:s.checkpoint};}
async function size(page,label){
 const b=card(page).getByRole('button',{name:label,exact:true});
 const r=await b.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,minWidth:s.minWidth,minHeight:s.minHeight};});
 assert.ok(parseFloat(r.minWidth)>=44&&parseFloat(r.minHeight)>=44,`${label}: intrinsic CSS touch target ${JSON.stringify(r)}`);
 assert.ok(r.width>=44&&r.height>=44,`${label}: DOM touch target ${JSON.stringify(r)}`);return r;
}
async function release(page){await page.evaluate(()=>(window as any).assetControl.release());await frame(page);}

for(const kind of ['image','file','embed'])test(`MWX-C17 prerequisite ${kind} opening is inert and source remains accessible`,()=>probe(`MWX-C17-inert-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind),before=await semantic(page);
 assert.deepEqual((await control(page)).calls,[]);assert.deepEqual(fact.assetFetches,[]);assert.deepEqual(fact.embedFetches,[]);
 const source=card(page).locator('textarea');assert.equal(await source.getAttribute('readonly'),'');assert.ok((await source.inputValue()).length>0);
 const label=kind==='image'?'Load image':kind==='file'?'Open file':'Activate embed';fact.target=await size(page,label);
 assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const kind of ['image','file','embed'])test(`MWX-C18 absent ${kind} host retains inert fallback`,()=>probe(`MWX-C18-absent-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind,{noPort:true}),before=await semantic(page);
 if(kind==='image')assert.equal(await card(page).getAttribute('data-image-state'),'missing');
 else assert.equal(await card(page).getByRole('button',{name:kind==='file'?'Open file':'Activate embed',exact:true}).isDisabled(),true);
 assert.deepEqual((await control(page)).calls,[]);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const state of ['queued','offline','revoked','locked','failed','missing'])test(`MWX-C19 image ${state} remains usable without fetch`,()=>probe(`MWX-C19-image-${state}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'image',{state}),before=await semantic(page);
 await card(page).getByRole('button',{name:'Load image',exact:true}).click();await waitState(page,state);
 assert.equal((await control(page)).calls.length,1);assert.deepEqual(fact.assetFetches,[]);assert.deepEqual(await semantic(page),before);
 await size(page,'Load image');await finish(page,baseline,fact);
}));
for(const [media,state] of [['pixel.png','ready'],['malformed.png','malformed'],['huge.png','decoded-size-limit']])test(`MWX-C19 bounded explicit image ${media}`,()=>probe(`MWX-C19-${media}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'image',{media}),before=await semantic(page);
 await card(page).getByRole('button',{name:'Load image',exact:true}).click();await waitState(page,state);
 assert.equal((await control(page)).calls.length,1);assert.equal(fact.assetFetches.length,1);assert.deepEqual(await semantic(page),before);
 if(state==='ready'){assert.equal(await card(page).locator('img').isVisible(),true);assert.equal(await card(page).locator('img').getAttribute('alt'),descriptors.find(d=>d.kind==='image').metadata.alt);}
 await finish(page,baseline,fact);
}));
for(const state of ['offline','revoked','locked','failed','missing'])test(`MWX-C18 file ${state} cannot execute`,()=>probe(`MWX-C18-file-${state}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'file',{state,observed:state}),before=await semantic(page);
 await card(page).getByRole('button',{name:'Open file',exact:true}).click();await waitState(page,state);
 assert.equal((await control(page)).calls.filter(c=>c.operation==='execute').length,0);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const kind of ['image','file','embed'])test(`MWX-C18 ${kind} cancellation releases pending host and ignores late return`,()=>probe(`MWX-C18-cancel-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind,{paused:true}),before=await semantic(page);
 await card(page).getByRole('button',{name:kind==='image'?'Load image':kind==='file'?'Open file':'Activate embed',exact:true}).click();
 const label=kind==='image'?'Cancel image load':kind==='file'?'Cancel file action':'Deactivate embed';await size(page,label);await card(page).getByRole('button',{name:label,exact:true}).click();
 const afterCancel=await control(page);assert.ok(afterCancel.signals.every(Boolean));
 assert.equal(await card(page).getByRole('button',{name:kind==='image'?'Load image':kind==='file'?'Open file':'Activate embed',exact:true}).evaluate(e=>e===document.activeElement),true);
 await release(page);assert.deepEqual(fact.assetFetches,[]);assert.deepEqual(fact.embedFetches,[]);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const kind of ['image','file','embed'])test(`MWX-C18 ${kind} teardown prevents late resurrection`,()=>probe(`MWX-C18-dispose-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind,{paused:true}),before=await semantic(page);
 await card(page).getByRole('button',{name:kind==='image'?'Load image':kind==='file'?'Open file':'Activate embed',exact:true}).click();
 assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);await release(page);assert.ok((await control(page)).signals.every(Boolean));assert.deepEqual(fact.assetFetches,[]);assert.deepEqual(fact.embedFetches,[]);
}));
for(const action of ['Open file','Download file'])test(`MWX-C18 explicit ${action} uses one identity-scoped owning operation`,()=>probe(`MWX-C18-${action}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'file'),before=await semantic(page);
 await card(page).getByRole('button',{name:action,exact:true}).click();await waitState(page,'completed');const c=await control(page);
 assert.deepEqual(c.calls.map(c=>c.operation),['authorize','execute']);assert.deepEqual(c.calls[0].request,c.calls[1].request);assert.ok(c.signals.every(Boolean));
 assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
test('MWX-C20 explicit activation and exit returns focus to the safe card',()=>probe('MWX-C20-activate-exit',async(page,fact)=>{
 const baseline=await mountAsset(page,'embed'),before=await semantic(page);
 await card(page).getByRole('button',{name:'Activate embed',exact:true}).click();await waitState(page,'active');await frame(page);
 assert.equal((await control(page)).calls.length,1);assert.equal(await card(page).locator('iframe').count(),1);
 assert.equal(await card(page).locator('iframe').getAttribute('sandbox'),'allow-scripts');await size(page,'Deactivate embed');
 await card(page).getByRole('button',{name:'Deactivate embed',exact:true}).click();await waitState(page,'inactive');assert.equal(await card(page).locator('iframe').count(),0);
 assert.equal(await card(page).getByRole('button',{name:'Activate embed',exact:true}).evaluate(e=>e===document.activeElement),true);
 assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const mode of ['denied','unsupported','stale','escape'])test(`MWX-C20 ${mode} keeps source and does no privileged load`,()=>probe(`MWX-C20-${mode}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'embed',{noTemplate:mode==='unsupported',paused:mode==='stale'||mode==='escape'}),before=await semantic(page);
 if(mode==='denied')await page.evaluate(()=>(window as any).assetControl.host.capabilities.activate=false);
 if(mode==='unsupported')assert.equal(await card(page).getByRole('button',{name:'Activate embed',exact:true}).isDisabled(),true);
 else {await card(page).getByRole('button',{name:'Activate embed',exact:true}).click();
  if(mode==='stale'){await page.evaluate(()=>{(window as any).assetControl.host.scope.session='new-session';});await release(page);await waitState(page,'stale');}
  else if(mode==='escape'){await card(page).getByRole('button',{name:'Deactivate embed',exact:true}).focus();await page.keyboard.press('Escape');await release(page);await waitState(page,'inactive');}
  else await waitState(page,'forbidden');
 }
 assert.deepEqual(fact.embedFetches,[]);assert.equal(await card(page).locator('iframe').count(),0);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const kind of ['image','file','embed'])test(`MWX-C18 ${kind} remote target retirement discards pending result`,()=>probe(`MWX-C18-retire-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind,{paused:true});
 await card(page).getByRole('button',{name:kind==='image'?'Load image':kind==='file'?'Open file':'Activate embed',exact:true}).click();
 await page.evaluate(()=>(window as any).inputFixture.retireContent());const afterRemote=await semantic(page);
 assert.equal(await card(page).count(),0);await release(page);assert.deepEqual(await semantic(page),afterRemote);assert.deepEqual(fact.assetFetches,[]);assert.deepEqual(fact.embedFetches,[]);
 assert.ok((await control(page)).signals.every(Boolean));await finish(page,baseline,fact);
}));
for(const kind of ['image','file','embed'])test(`MWX-C18 ${kind} repeated activation is single-flight and can recover after cancel`,()=>probe(`MWX-C18-single-flight-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind,{paused:true}),before=await semantic(page),label=kind==='image'?'Load image':kind==='file'?'Open file':'Activate embed';
 await card(page).getByRole('button',{name:label,exact:true}).click();
 await card(page).getByRole('button',{name:label,exact:true,includeHidden:true}).dispatchEvent('click');assert.equal((await control(page)).calls.length,1);
 await card(page).getByRole('button',{name:kind==='image'?'Cancel image load':kind==='file'?'Cancel file action':'Deactivate embed',exact:true}).click();await release(page);
 await page.evaluate(()=>{(window as any).assetControl.paused=false;(window as any).assetControl.state='offline';});
 await card(page).getByRole('button',{name:label,exact:true}).click();await waitState(page,kind==='embed'?'unavailable':'offline');
 assert.equal((await control(page)).calls.length,2);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const options of [{wrongIdentity:true},{imageLimits:{encodedBytes:32}}])test(`MWX-C19 image rejects ${options.wrongIdentity?'wrong authority':'oversize bytes'} before decoding`,()=>probe(`MWX-C19-limit-${JSON.stringify(options)}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'image',options),before=await semantic(page);
 await card(page).getByRole('button',{name:'Load image',exact:true}).click();await waitState(page,options.wrongIdentity?'unauthorized':'encoded-byte-limit');
 assert.equal(await page.evaluate(()=>(window as any).assetUrls.created),0);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const kind of ['image','file','embed'])test(`MWX-C19/20 ${kind} controls remain reachable with a prepared keyboard viewport`,()=>probe(`MWX-C19-layout-${kind}`,async(page,fact)=>{
 const baseline=await mountAsset(page,kind),before=await semantic(page);
 await page.setViewportSize({width:320,height:480});await page.evaluate(()=>{(window as any).mobileGeometry={visual:{left:0,top:0,width:320,height:260},scale:2};window.dispatchEvent(new Event('resize'));});await frame(page);
 const labels=kind==='image'?['Load image']:kind==='file'?['Open file','Download file','Select source to copy']:['Refresh card','Activate embed'];
 for(const label of labels){const b=card(page).getByRole('button',{name:label,exact:true});await b.scrollIntoViewIfNeeded();const r=await size(page,label);assert.ok(r.x>=0&&r.x+r.width<=320.5,label+' stays within narrow viewport');}
 const source=card(page).locator('textarea'),r=await source.boundingBox();assert.ok(r&&r.width<=320,'bounded source view');
 assert.deepEqual((await control(page)).calls,[]);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
test('MWX-C18 file denied authority preserves selection without host execution',()=>probe('MWX-C18-file-denied',async(page,fact)=>{
 const baseline=await mountAsset(page,'file',{denied:true}),before=await semantic(page);await card(page).getByRole('button',{name:'Open file',exact:true}).click();await waitState(page,'forbidden');
 assert.equal((await control(page)).calls.length,1);assert.deepEqual(await semantic(page),before);await finish(page,baseline,fact);
}));
for(const htmlImage of [false,true])test(`MWX-C18 prepared mixed files/image/HTML paste uses owning ${htmlImage?'plain recovery':'HTML'} precedence once`,()=>probe(`MWX-C18-mixed-paste-${htmlImage}`,async(page,fact)=>{
 const baseline=await mountAsset(page,'file'),before=await snapshot(page);
 await page.evaluate(async htmlImage=>{const f=(window as any).inputFixture,dt=new DataTransfer();
  dt.items.add(new File(['prepared image bytes'],'local.png',{type:'image/png'}));dt.items.add(new File(['prepared file bytes'],'local.txt',{type:'text/plain'}));
  dt.setData('text/html','<p><strong>Chosen once</strong>'+(htmlImage?'<img src="https://never-request.invalid/pixel.png" alt="inert">':'')+'</p>');dt.setData('text/plain','Alternate plain');
  f.select(f.ids.at(-1),0);f.root.dispatchEvent((window as any).preparedClipboardEvent('paste',dt));await f.settle();
 },htmlImage);
 const after=await snapshot(page);fact.mixed={before,after,recovery:await page.evaluate(()=>(window as any).inputFixture.surface.clipboardRecovery)};const text=after.nodes.map(n=>n.runs.map(r=>r.text).join('')).join('\n');
 assert.equal(text.split(htmlImage?'Alternate plain':'Chosen once').length-1,1);assert.ok(!text.includes(htmlImage?'Chosen once':'Alternate plain'));if(htmlImage)assert.ok(fact.mixed.recovery.some(r=>r.reason==='html-img-requires-extension-codec'));assert.equal(after.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.asset').length,1);
 assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.journal.length,before.journal.length+1);assert.deepEqual((await control(page)).calls,[]);
 fact.binaryQualification='existing HTML/plain representation precedence only; file-byte ingestion remains unavailable';await finish(page,baseline,fact);
}));


async function inputSetup(page, options={}) {
 await page.waitForFunction(()=>!!(window as any).inputFixture);
 const baseline=await page.evaluate(()=>(window as any).mobileResources());
 await page.evaluate(async options=>{const {setup}=await import('/fixture/asset-input.mjs');await setup(options);},options);
 return baseline;
}
const inputState=page=>page.evaluate(()=>(window as any).assetInput.inspect());
async function choose(page,label='Add file',buffer=Buffer.from([0,255,13,10,128,42])) {
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:label,exact:true}).click();
 await (await chooser).setFiles({name:'prepared.bin',mimeType:'application/octet-stream',buffer});
}
async function inputFinish(page,baseline,fact) {
 await page.evaluate(()=>(window as any).assetInput.close());await frame(page);
 const after=await page.evaluate(()=>(window as any).mobileResources());fact.resources={baseline,after};assert.deepEqual(after,baseline);
 assert.deepEqual(await page.evaluate(()=>(window as any).mobileAuthorityProbes),{permissions:0,capture:0,open:0});
 assert.deepEqual(fact.unexpectedRequests,[]);assert.deepEqual(fact.unexpectedPages,[]);
 assert.deepEqual(await page.evaluate(()=>[...(window as any).assetUrls.urls]),[]);
}
test('MEX-1.5-C4 MWX-C17 bounded file picker commits one owned asset, distinct receipts, exact original, history and reopen',()=>probe('MWX-C17-file-atomic',async(page,fact)=>{
 const baseline=await inputSetup(page),before=await inputState(page);
 assert.deepEqual(before.calls,[]);assert.equal(await page.getByRole('button',{name:'Take photo (optional)',exact:true}).count(),0);
 await choose(page);const after=await inputState(page);fact.before=before;fact.after=after;
 assert.equal(after.entries.length,1);assert.equal(after.entries[0].origin,'editac:local:asset-input');
 assert.equal(after.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.asset').length,1);
 assert.equal(after.effects.length,1);assert.deepEqual(after.effects[0].bytes,[0,255,13,10,128,42]);
 assert.ok(after.receipt.localCommit);assert.ok(after.receipt.content);assert.equal(after.recovery,undefined);
 const bytes=await page.evaluate(async()=>{const s=(window as any).assetInput,p=(await s.assets.inspect()).prepared[0];return Array.from(await s.assets.preparedSource(p.job,p.reference,{identity:p.request.identity,actions:['read']}));});
 assert.deepEqual(bytes,[0,255,13,10,128,42]);
 await page.evaluate(async()=>{const s=(window as any).assetInput;s.owner.engine.history({type:'undo'});await s.owner.flush({target:'local'});});
 const undo=await inputState(page);assert.deepEqual(undo.nodes,before.nodes);
 await page.evaluate(async()=>{const s=(window as any).assetInput;s.owner.engine.history({type:'redo'});await s.owner.flush({target:'local'});});
 assert.deepEqual((await inputState(page)).nodes,after.nodes);
 await page.evaluate(()=>(window as any).assetInput.reopen());const reopened=await inputState(page);
 assert.deepEqual(reopened.nodes,after.nodes);assert.deepEqual(reopened.calls,after.calls,'reopen does no host work');assert.deepEqual(reopened.errors,[]);
 await inputFinish(page,baseline,fact);
}));
for(const capture of [undefined,'environment'])test(`MEX-1.5-C4 MWX-C17 ${capture??'absent'} capture cancel preserves content and file fallback`,()=>probe(`MWX-C17-capture-${capture??'absent'}`,async(page,fact)=>{
 const baseline=await inputSetup(page,{capture}),before=await inputState(page);
 const label=capture?'Take photo (optional)':'Add file';
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:label,exact:true}).click();await chooser;
 await page.evaluate(capture=>{const s=(window as any).assetInput;(capture?s.controls.camera:s.controls.input).dispatchEvent(new Event('cancel'));},capture);
 const canceled=await inputState(page);assert.deepEqual(canceled.checkpoint,before.checkpoint);assert.deepEqual(canceled.calls,[]);
 assert.equal(canceled.assets.fencedJobs.length,1);await choose(page);assert.equal((await inputState(page)).effects.length,1);
 await inputFinish(page,baseline,fact);
}));
for(const mode of ['denied','revoked','offline','oversized'])test(`MEX-1.5-C4 MWX-C18 ${mode} retains original and never inserts a descriptor first`,()=>probe(`MWX-C18-input-${mode}`,async(page,fact)=>{
 const baseline=await inputSetup(page,{mode,maxBytes:mode==='oversized'?4:32}),before=await inputState(page);
 await choose(page);const after=await inputState(page);fact.after=after;
 assert.deepEqual(after.checkpoint,before.checkpoint);assert.deepEqual(after.history,before.history);assert.deepEqual(after.entries,[]);
 assert.equal(after.recovery,'prepared.bin');assert.equal(after.effects.length,0);assert.equal(after.assets.fencedJobs.length,1);
 await inputFinish(page,baseline,fact);
}));
for(const mode of ['delayed-describe','delayed-host'])test(`MEX-1.5-C4 MWX-C18 ${mode} cancellation fences late callbacks and preserves sibling bytes`,()=>probe(`MWX-C18-late-${mode}`,async(page,fact)=>{
 const baseline=await inputSetup(page,{mode}),before=await inputState(page);await choose(page);
 await page.waitForFunction(()=>(window as any).assetInput.waiting.length>0);
 await page.getByRole('button',{name:'Cancel adding asset',exact:true}).click();
 await page.evaluate(()=>{const s=(window as any).assetInput;s.release();});
 const after=await inputState(page);fact.after=after;assert.deepEqual(after.checkpoint,before.checkpoint);assert.deepEqual(after.entries,[]);
 assert.equal(after.assets.fencedJobs.length,1);assert.equal(after.recovery,'prepared.bin');
 assert.ok(await page.evaluate(()=>(window as any).assetInput.signals.some(s=>s.aborted)));
 await inputFinish(page,baseline,fact);
}));
test('MEX-1.5-C4 MWX-C18 changed target rejects delayed picker insertion and leaves recovery usable',()=>probe('MWX-C18-target-change',async(page,fact)=>{
 const baseline=await inputSetup(page,{mode:'delayed-describe'});await choose(page);await page.waitForFunction(()=>(window as any).assetInput.waiting.length>0);
 await page.evaluate(async()=>{const s=(window as any).assetInput;await s.edit();s.release();});
 const after=await inputState(page);assert.equal(after.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.asset').length,0);assert.equal(after.effects.length,0);assert.equal(after.entries.length,1);assert.equal(after.recovery,'prepared.bin');
 await inputFinish(page,baseline,fact);
}));
test('MEX-1.5-C4 MWX-C18 mixed binary and HTML paste inserts one asset without HTML echo',()=>probe('MWX-C18-binary-precedence',async(page,fact)=>{
 const baseline=await inputSetup(page);
 await page.evaluate(()=>{const s=(window as any).assetInput,d=new DataTransfer();d.items.add(new File([new Uint8Array([0,255,42])],'prepared.bin',{type:'application/octet-stream'}));d.setData('text/html','<p>unwanted duplicate</p>');d.setData('text/plain','unwanted duplicate');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:d});s.controls.context.root.dispatchEvent(event);});
 const after=await inputState(page);fact.after=after;assert.equal(after.entries.length,1);assert.equal(after.effects.length,1);assert.deepEqual(after.effects[0].bytes,[0,255,42]);assert.ok(!JSON.stringify(after.nodes).includes('unwanted duplicate'));
 await inputFinish(page,baseline,fact);
}));
for(const boundary of ['background','readOnly','dispose'])test(`MEX-1.5-C4 MWX-C18 ${boundary} fences pending original before late success`,()=>probe(`MWX-C18-boundary-${boundary}`,async(page,fact)=>{
 const baseline=await inputSetup(page,{mode:'delayed-host'});await choose(page);await page.waitForFunction(()=>(window as any).assetInput.waiting.length>0);
 await page.evaluate(async boundary=>{const s=(window as any).assetInput;
  if(boundary==='background')window.dispatchEvent(new Event('pagehide'));
  if(boundary==='readOnly')s.surface.setReadOnly(true);
  if(boundary==='dispose'){await s.surface.dispose();s.surfaceDisposed=true;}
  s.release();await s.controls.settle();
 },boundary);
 const after=await inputState(page);fact.after=after;assert.equal(after.entries.length,0);assert.equal(after.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.asset').length,0);assert.equal(after.assets.fencedJobs.length,1);
 await inputFinish(page,baseline,fact);
}));
test('MEX-1.5-C4 MWX-C17 declined capture retains usable file fallback and intrinsic labeled touch targets',()=>probe('MWX-C17-capture-declined',async(page,fact)=>{
 const baseline=await inputSetup(page,{capture:'environment',mode:'denied'});
 for(const name of ['Add file','Take photo (optional)','Cancel adding asset']){
  const rect=await page.getByRole('button',{name,exact:true}).evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {minWidth:s.minWidth,minHeight:s.minHeight,width:r.width,height:r.height};});
  assert.ok(parseFloat(rect.minWidth)>=44&&parseFloat(rect.minHeight)>=44&&rect.width>=44&&rect.height>=44);
 }
 await choose(page,'Take photo (optional)');assert.equal((await inputState(page)).entries.length,0);
 await page.evaluate(()=>(window as any).assetInput.mode='available');await choose(page);
 const after=await inputState(page);assert.equal(after.entries.length,1);assert.equal(after.effects.length,1);
 await inputFinish(page,baseline,fact);
}));
test('MEX-1.5-C4 MWX-C18 cancellation preserves independent staged sibling original and captured selection',()=>probe('MWX-C18-input-sibling',async(page,fact)=>{
 const baseline=await inputSetup(page,{mode:'delayed-describe'});
 await page.evaluate(async()=>{const s=(window as any).assetInput,identity={host:'sibling',key:'kept'};await s.assets.stageOriginal('sibling_job','sibling_original',{version:1,identity,action:'ingest',operationId:'sibling_op',byteLimit:8},{identity,actions:['ingest','read']},new Uint8Array([7,8]));});
 await choose(page);await page.waitForFunction(()=>(window as any).assetInput.waiting.length>0);
 await page.getByRole('button',{name:'Cancel adding asset',exact:true}).click();await page.evaluate(()=>(window as any).assetInput.release());
 const after=await inputState(page);assert.equal(after.entries.length,0);assert.equal(after.assets.prepared.find(p=>p.job==='sibling_job').active,true);
 const result=await page.evaluate(async()=>{const s=(window as any).assetInput,selection=getSelection();return {bytes:Array.from(await s.assets.preparedSource('sibling_job','sibling_original',{identity:{host:'sibling',key:'kept'},actions:['read']})),anchor:selection.anchorOffset,focus:selection.focusOffset};});
 assert.deepEqual(result,{bytes:[7,8],anchor:2,focus:2});await inputFinish(page,baseline,fact);
}));
test('MEX-1.5-C4 MWX-C18 structured clipboard owner precedes external binary representation',()=>probe('MWX-C18-structured-precedence',async(page,fact)=>{
 const baseline=await inputSetup(page);
 const result=await page.evaluate(()=>{const s=(window as any).assetInput,root=s.controls.context.root,text=document.createTreeWalker(root.querySelector('[data-node-id]'),NodeFilter.SHOW_TEXT).nextNode();root.focus();getSelection().setBaseAndExtent(text,0,text,2);
  const d=new DataTransfer();const copy=new ClipboardEvent('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:d});root.dispatchEvent(copy);
  const raw=d.getData('application/x-edit-ac-fragment+json');d.items.add(new File(['binary'],'prepared.bin',{type:'application/octet-stream'}));const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:d});root.dispatchEvent(paste);return {raw};
 });
 assert.ok(result.raw);const after=await inputState(page);assert.equal(after.effects.length,0);assert.equal(await page.evaluate(()=>(window as any).assetInput.descriptions.length),0);assert.equal(after.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.asset').length,0);
 await inputFinish(page,baseline,fact);
}));
test('MEX-1.5-C4 MWX-C17 prepared captured image retains exact original and safe alt metadata without implicit decode',()=>probe('MWX-C17-image-original',async(page,fact)=>{
 const baseline=await inputSetup(page,{capture:'environment'}),buffer=readFileSync('fixtures/browser-image-lifecycle/pixel.png');
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Take photo (optional)',exact:true}).click();await (await chooser).setFiles({name:'pixel.png',mimeType:'image/png',buffer});
 const after=await inputState(page);fact.after=after;assert.equal(after.entries.length,1);assert.deepEqual(after.effects[0].bytes,Array.from(buffer));
 const image=after.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.asset').blockAttributes[2];assert.equal(image.kind,'image');assert.equal(image.metadata.alt,'Prepared alt 😀 אב');
 assert.deepEqual(fact.assetFetches,[]);await inputFinish(page,baseline,fact);
}));
