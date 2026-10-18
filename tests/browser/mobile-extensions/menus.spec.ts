import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installExtensionCounters } from './resources.mjs';
import { installResourceCounters } from '../../mobile-web/resources.mjs';

const { probe, facts } = browserHarness('mobile-extensions', 'fixtures/browser-mobile-extensions', {
  autoMount: false, testFile: 'tests/browser/mobile-extensions/menus.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: process.env.EDITAC_MOBILE_EXTENSIONS_BROWSER !== 'firefox' },
  serverOptions: { recordRequests: true }, beforeNavigate: async (page, fact) => {
    fact.unexpectedRequests=[];fact.unexpectedPages=[];
    page.context().on('page',p=>fact.unexpectedPages.push(p.url()));
    await page.addInitScript(()=>{
      (window as any).mobileAuthorityProbes={permissions:0,capture:0,open:0};
      window.open=()=>{(window as any).mobileAuthorityProbes.open++;return null;};
      if(navigator.permissions)navigator.permissions.query=()=>{(window as any).mobileAuthorityProbes.permissions++;return Promise.reject(Error('No real permission probing in prepared checks'));};
      if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{(window as any).mobileAuthorityProbes.capture++;return Promise.reject(Error('No capture in prepared checks'));};
    });
    await page.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin!==new URL(fact.origin).origin){fact.unexpectedRequests.push(url);return route.abort();}return route.continue();});
    await page.addInitScript(installResourceCounters); await page.addInitScript(installExtensionCounters); },
  sourcePaths: ['../architecture/specs/editor-interactions.md', '../architecture/specs/link-resolution.md','fixtures/browser-mobile-extensions/reference-display.mjs', 'packages/web/src/modules/references/display.ts', 'packages/web/dist/modules/references/display.js', 'packages/web/src/modules/links/activation.ts', 'packages/core/src/links/activation.ts','packages/web/src/modules/touch-controls.ts', 'packages/web/dist/modules/touch-controls.js', 'packages/web/src/ui/commands.ts', 'packages/web/dist/ui/commands.js','packages/web/src/extensions/highlighting.ts', 'packages/web/src/extensions/assets.ts', 'packages/web/src/extensions/math.ts', 'tests/consumers/mobile-extensions/graph.mjs', 'scripts/build-extension-runtime.mjs','packages/web/src/modules/presenter-sequence.ts','packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts', ...['search','reorder','slash','references','content'].flatMap(n=>[`packages/web/src/extensions/runtime/${n}.ts`,`packages/web/dist/extensions/runtime/${n}.js`]),'packages/web/dist/extensions/runtime/manifest.json',...browserInputSources, 'fixtures/browser-mobile-extensions/session.mjs', 'fixtures/browser-mobile-extensions/index.html',
    'tests/browser/mobile-extensions/content-host-matrix.ts', 'tests/browser/mobile-extensions/command-matrix.ts', 'tests/browser/mobile-extensions/command-inventory.mjs',
    'fixtures/rich-content/asset-descriptors.json', 'packages/core/src/extensions/profiles.ts', 'packages/web/src/commands/catalog.ts',
    ...['modules/images/presenter','modules/attachments/presenter','modules/embeds/presenter','modules/content','modules/reorder','modules/search','modules/references','modules/slash','extensions/code'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
    'tests/browser/mobile-extensions/index.mjs', 'tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs', 'tests/browser/mobile-extensions/resources.mjs', 'scripts/test-mobile-extensions.mjs', 'packages/web/package.json',
    '../architecture/tests/mobile-extension-cases.md', '../architecture/specs/mobile-web.md',
    ...['editor', 'surface', 'extensions/configuration', 'extensions/contract', 'platform/viewport'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`])],
});
facts.binding = { gate: 'MEX-1.2', ids: ['MWX-C05','MWX-C06','MWX-C07','MWX-C08'],
  platform: 'production desktop browser with prepared mobile viewport/touch/composition; original MWX-1.8 pending',
  targetRule: '44 CSS px minimum width and height for each named action',
  semantics: 'real BrowserEditor/Session/WASM/IndexedDB; hand-authored host and geometry only' };
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
    return { nodes: s.nodes, history: s.history, patches: s.patches, journal: s.journal, checkpoint: Array.from(f.engine.checkpoint().bytes), errors: s.errors, storage: s.storage }; });
}
async function finish(page, baseline, fact) {
  fact.activeResources = await page.evaluate(() => (window as any).mobileResources());
  const changes = await page.evaluate(async () => { const f = (window as any).inputFixture, updates = [];
    const sub = f.engine.subscribe({type:'all'}, patch => { if(patch.update)updates.push(patch.origin); });
    try { await f.destroy(); } finally { sub.dispose(); } return updates; });
  assert.deepEqual(changes, [], 'teardown emits no semantic transactions'); fact.teardownUpdates = changes; await frame(page);
  const after = await page.evaluate(() => (window as any).mobileResources());
  fact.resources = { baseline, after }; assert.deepEqual(after, baseline, 'all mounted resource ownership released');
  fact.optionalAfter=await page.evaluate(()=>(window as any).mobileExtensionResources());
  assert.equal(fact.optionalAfter.listeners,0,'optional listeners released separately from baseline');
  assert.deepEqual(fact.unexpectedRequests,[],'no unsolicited network work');
  assert.deepEqual(fact.unexpectedPages,[],'no unsolicited browser context');
  fact.authorityProbes=await page.evaluate(()=>(window as any).mobileAuthorityProbes);
  assert.deepEqual(fact.authorityProbes,{permissions:0,capture:0,open:0},'no real permission/capture/open work');
}
const target = { targetId:'ac://team-1/12345678-1234-4234-8234-123456789abc', label:'Current prepared target' };
async function state(page) { return page.evaluate(() => (window as any).inputFixture.state()); }
const text = s => s.nodes.map(n => n.runs.map(r => r.text).join('')).join('\n');
const atoms = s => s.nodes.filter(n => n.blockAttributes?.[0] === 'module:editac.reference');
async function tap(page, name) { await page.getByRole('button', { name, exact:true }).tap(); await frame(page); }
async function undo(page) { await page.evaluate(() => { const f=(window as any).inputFixture; f.root.focus(); const command=f.surface.captureCommand('undo'); if(!command)throw Error('Undo unavailable');try{command.execute();}finally{command.dispose();} }); await frame(page); }
for (const name of ['Bold','Italic','Underline'])
test(`MWX-C05 named ${name} tap preserves selected phrase and one undo`,()=>probe(`MWX-C05-${name}`,async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha bravo charlie',commandControls:true}),before=await state(page);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],6,11);});await tap(page,name);
 const after=await state(page);assert.equal(text(after),text(before));assert.equal(after.history.undoGroups,1);
 assert.equal(after.nodes[0].runs.filter(r=>r.attributes[name.toLowerCase()]).map(r=>r.text).join(''),'bravo');
 await undo(page);const restored=await state(page);assert.deepEqual(restored.nodes,before.nodes);assert.equal(restored.history.undoGroups,0);
 fact.snapshots.push({before,after,restored});await finish(page,baseline,fact);
}));
test('MWX-C05 explicit slash tap activates once without slash typing or hover',()=>probe('MWX-C05-slash',async(page,fact)=>{
 const baseline=await mount(page,{baselineModules:true}),before=await state(page);await tap(page,'Slash commands');
 await page.getByRole('menuitem',{name:'Make code block',exact:true}).tap();const after=await state(page);
 assert.equal(after.history.undoGroups,1);assert.equal(after.nodes[0].blockAttributes[0],'code');assert.equal(text(after),'alpha');
 await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);fact.snapshots.push({before,after});await finish(page,baseline,fact);
}));
test('MWX-C05 reference touch replaces captured selection in one group',()=>probe('MWX-C05-reference',async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha bravo charlie',referenceHost:'allowed'}),before=await state(page);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],6,11);});await tap(page,'Insert reference');
 await page.getByRole('searchbox',{name:'Search references'}).fill('prepared');await page.getByRole('menuitem',{name:'Prepared local target',exact:true}).tap();
 const after=await state(page);assert.equal(atoms(after).length,1);assert.equal(after.history.undoGroups,1);assert.equal(atoms(after)[0].runs[0].text,'Prepared local target');
 assert.ok(!text(after).includes('bravo'));assert.ok(text(after).includes('alpha '));assert.ok(text(after).includes(' charlie'));
 await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);fact.snapshots.push({before,after});await finish(page,baseline,fact);
}));
for(const kind of ['slash','references','commands'])
test(`MWX-C06 ${kind} targets and panel survive keyboard rotation zoom and floating occlusion`,()=>probe(`MWX-C06-${kind}`,async(page,fact)=>{
 const baseline=await mount(page,{baselineModules:kind==='slash',referenceHost:kind==='references'?'allowed':undefined,referenceCount:64,commandControls:kind==='commands'}),before=await snapshot(page);
 if(kind==='slash')await tap(page,'Slash commands');if(kind==='references')await tap(page,'Insert reference');
 const observations=[];
 for(const geometry of [
  {visual:{left:0,top:0,width:390,height:320},scale:1},
  {visual:{left:0,top:0,width:740,height:220},scale:1},
  {visual:{left:25,top:18,width:195,height:260},scale:2},
  {visual:{left:0,top:0,width:390,height:500},scale:1,occlusions:[{left:140,top:160,width:250,height:340}]},
  {visual:{left:0,top:0,width:390,height:740},scale:1},
 ]){
  await page.evaluate(g=>{const w=window as any;w.mobileGeometry=g;w.inputFixture.surface.viewport.invalidate();},geometry);await frame(page);
  const o=await page.evaluate(kind=>{const f=(window as any).inputFixture,p=kind==='commands'?f.surface.commandControls.element:kind==='slash'?f.surface.slash.menu:f.surface.references.menu;
   const r=p.getBoundingClientRect(),s=getComputedStyle(p),actions=[...p.querySelectorAll('button,input')].filter((e:HTMLElement)=>!e.hidden).map((e:HTMLElement)=>{const b=e.getBoundingClientRect();return {name:e.textContent||e.getAttribute('aria-label'),width:b.width,height:b.height};});
   return {rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:s.overflowY,actions,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,rootTouch:getComputedStyle(f.root).touchAction,rootSelect:getComputedStyle(f.root).userSelect,meta:document.querySelector('meta[name=viewport]')!.getAttribute('content')};},kind);
  const v=geometry.visual;assert.ok(o.rect.left>=v.left-1&&o.rect.top>=v.top-1&&o.rect.right<=v.left+v.width+1&&o.rect.bottom<=v.top+v.height+1,JSON.stringify(o.rect));
  for(const a of o.actions){assert.ok(a.name);assert.ok(a.width>=43.9&&a.height>=43.9,JSON.stringify(a));}assert.equal(o.overflow,'auto');assert.equal(o.rootTouch,'auto');assert.notEqual(o.rootSelect,'none');assert.ok(!/user-scalable=no|maximum-scale=1/.test(o.meta!));
  if(kind!=='commands')assert.ok(o.scrollHeight>o.clientHeight);observations.push({geometry,...o});
 }
 await page.evaluate(kind=>{const f=(window as any).inputFixture,p=kind==='commands'?f.surface.commandControls.element:kind==='slash'?f.surface.slash.menu:f.surface.references.menu;p.scrollTop=p.scrollHeight;f.root.parentElement.scrollTop+=30;const menu=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});f.root.dispatchEvent(menu);if(menu.defaultPrevented)throw Error('Native context menu suppressed');},kind);await frame(page);
 if(kind==='slash')await page.getByRole('menuitem',{name:'Close commands',exact:true}).tap();if(kind==='references')await tap(page,'Close references');
 assert.deepEqual(await snapshot(page),before);fact.geometry=observations;await finish(page,baseline,fact);
}));
test('MWX-C07 reordered replies and former detached result cannot redirect activation',()=>probe('MWX-C07-reordered',async(page,fact)=>{
 const baseline=await mount(page,{referenceHost:'delayed'});await tap(page,'Insert reference');await page.evaluate(()=>{(window as any).oldComplete=(window as any).referenceHostState.complete;});
 await page.getByRole('searchbox').fill('current');await page.evaluate(t=>(window as any).referenceHostState.complete([t]),target);await frame(page);
 await page.evaluate(()=>{(window as any).former=document.querySelector('[data-reference]');});await page.getByRole('searchbox').fill('latest');
 const before=await snapshot(page);await page.evaluate(()=>{const w=window as any;w.former.click();w.oldComplete([{targetId:'ac://team-1/12345678-1234-4234-8234-123456789abc',label:'Obsolete target'}]);});await frame(page);
 assert.deepEqual(await snapshot(page),before);assert.equal(await page.getByRole('menuitem').count(),0);
 await page.evaluate(t=>(window as any).referenceHostState.complete([t]),target);await frame(page);await page.getByRole('menuitem',{name:target.label}).tap();const after=await state(page);
 assert.equal(atoms(after)[0].runs[0].text,target.label);assert.equal(after.history.undoGroups,1);
 fact.resolver=await page.evaluate(()=>{const s=(window as any).referenceHostState;return {queries:s.requests.map(r=>r.query),ids:s.requests.map(r=>r.requestId),aborted:s.signals.map(s=>s.aborted)};});
 assert.deepEqual(fact.resolver.queries,['','current','latest']);assert.ok(fact.resolver.ids[2]>fact.resolver.ids[1]);await finish(page,baseline,fact);
}));
for(const action of ['dismiss','focus-away','remote','deleted-target','permission-loss','readonly'])
test(`MWX-C07 ${action} cancels pending reference without stale mutation`,()=>probe(`MWX-C07-${action}`,async(page,fact)=>{
 const baseline=await mount(page,{referenceHost:'delayed',nodes:[{text:'alpha'},{text:'bravo'}]});if(action==='deleted-target')await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[1],2);});
 await tap(page,'Insert reference');await page.getByRole('searchbox').fill('recoverable query');await page.evaluate(()=>{(window as any).savedComplete=(window as any).referenceHostState.complete;});
 if(action==='dismiss')await tap(page,'Close references');if(action==='focus-away')await page.locator('#host-control').focus();if(action==='remote')await page.evaluate(()=>(window as any).inputFixture.remote(0,0,'remote '));
 if(action==='deleted-target')await page.evaluate(()=>(window as any).inputFixture.remoteJoin(0,1));
 if(action==='permission-loss')await page.evaluate(()=>{const s=(window as any).referenceHostState;s.mode='denied';for(const f of s.listeners)f();});if(action==='readonly')await page.evaluate(()=>(window as any).inputFixture.surface.setReadOnly(true));
 const before=await snapshot(page);await page.evaluate(t=>(window as any).savedComplete([t]),target);await frame(page);assert.deepEqual(await snapshot(page),before);assert.equal(atoms(await state(page)).length,0);
 const result=await page.evaluate(()=>{const w=window as any;return {open:w.inputFixture.surface.references.open,aborted:w.referenceHostState.signals.every(s=>s.aborted),query:w.inputFixture.surface.references.search.value,focus:document.activeElement?.id};});
 assert.equal(result.open,false);assert.equal(result.aborted,true);assert.equal(result.query,'recoverable query');if(action==='focus-away')assert.equal(result.focus,'host-control');fact.resolver=result;await finish(page,baseline,fact);
}));
for(const mode of ['denied','denied-insert','unknown','rejected'])
test(`MWX-C07 ${mode} authority leaves source and history unchanged`,()=>probe(`MWX-C07-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{referenceHost:mode}),before=await snapshot(page);await tap(page,'Insert reference');await page.getByRole('searchbox').fill('private');await frame(page);
 if(await page.getByRole('menuitem').count())await page.getByRole('menuitem').tap();assert.deepEqual(await snapshot(page),before);
 fact.authority=await page.evaluate(()=>{const s=(window as any).referenceHostState;return {resolve:s.resolveCalls,catalog:s.catalogCalls};});if(mode==='denied')assert.equal(fact.authority.resolve,0);await finish(page,baseline,fact);
}));
for(const control of ['Slash commands','Insert reference'])
test(`MWX-C08 composing root rejects ${control} tap without blur or duplicate input`,()=>probe(`MWX-C08-${control.replaceAll(' ','-')}`,async(page,fact)=>{
 const baseline=await mount(page,{baselineModules:true,referenceHost:'allowed'}),before=await snapshot(page);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],5);f.deliver('compositionstart',{data:''});f.mutate('alphaあ',0,6);f.deliver('input',{inputType:'insertCompositionText',data:'あ',isComposing:true});});await tap(page,control);
 const composing=await page.evaluate(()=>{const f=(window as any).inputFixture;return {text:f.root.textContent,focus:document.activeElement===f.root,slash:f.surface.slash.open,references:f.surface.references.open};});assert.deepEqual(composing,{text:'alphaあ',focus:true,slash:false,references:false});assert.deepEqual(await snapshot(page),before);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionend',{data:'あ'});f.deliver('input',{inputType:'insertText',data:'あ',isComposing:false});});await frame(page);
 const after=await state(page);assert.equal(text(after),'alphaあ');assert.equal(after.history.undoGroups,1);fact.composition={composing,after};await finish(page,baseline,fact);
}));
test('MWX-C08 reference IME clears results until end and dismissal respects subsequent focus',()=>probe('MWX-C08-reference-ime',async(page,fact)=>{
 const baseline=await mount(page,{referenceHost:'allowed'}),before=await snapshot(page);await tap(page,'Insert reference');
 await page.evaluate(()=>{const w=window as any,input=w.inputFixture.surface.references.search;w.former=document.querySelector('[data-reference]');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));input.value='あ';input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'あ',isComposing:true}));w.former.click();});assert.equal(await page.getByRole('menuitem').count(),0);assert.deepEqual(await snapshot(page),before);
 await page.evaluate(()=>{const input=(window as any).inputFixture.surface.references.search;input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'あ'}));});await frame(page);assert.equal(await page.getByRole('searchbox').inputValue(),'あ');assert.equal(await page.getByRole('menuitem').count(),1);
 await tap(page,'Close references');await page.locator('#host-control').focus();await frame(page);assert.equal(await page.evaluate(()=>document.activeElement?.id),'host-control');assert.deepEqual(await snapshot(page),before);await finish(page,baseline,fact);
}));
for(const mode of ['allowed','denied','revoked-pending','revoked-ready'])
test(`MWX-C07 ${mode} reference preview and activation use current host authority`,()=>probe(`MWX-C07-display-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{referenceHost:'allowed',referenceDisplay:true});await tap(page,'Insert reference');await page.getByRole('menuitem',{name:'Prepared local target'}).tap();await frame(page);
 const before=await snapshot(page);
 assert.equal(await page.evaluate(()=>(window as any).mobileReferenceDisplay.calls.length),0,'render and insertion do not resolve preview');
 assert.equal(await page.evaluate(()=>(window as any).mobileReferenceDisplay.dispatches.length),0,'render does not launch reference');
 const revoke=()=>page.evaluate(()=>{const s=(window as any).mobileReferenceDisplay;s.authorized=false;s.revision++;for(const f of s.listeners)f();});
 if(mode==='denied')await revoke();
 const metrics=await page.getByRole('button',{name:'Refresh reference'}).evaluate(e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height};});assert.ok(metrics.width>=44&&metrics.height>=44);
 await tap(page,'Refresh reference');
 const calls=await page.evaluate(()=>(window as any).mobileReferenceDisplay.calls.length);assert.equal(calls,mode==='denied'?0:1);
 if(mode==='revoked-pending')await revoke();
 if(mode!=='denied')await page.evaluate(()=>{const s=(window as any).mobileReferenceDisplay;s.complete({status:'available',metadata:{kind:'private',targetId:'ac://team-1/12345678-1234-4234-8234-123456789abc',display:{title:'Prepared private title',description:'Prepared private preview'}},freshness:{fetchedAt:Date.now()-1,expiresAt:Date.now()+60000,policyRevision:'1'}});});await frame(page);
 if(mode==='allowed'||mode==='revoked-ready')assert.equal(await page.locator('[data-private-title]').textContent(),'Prepared private title');
 if(mode==='revoked-ready')await revoke();
 if(mode!=='allowed'){assert.equal(await page.locator('[data-private-title]').textContent(),'');assert.equal(await page.locator('[data-private-preview]').textContent(),'');}
 await tap(page,'Open reference');fact.preview=await page.evaluate(()=>{const s=(window as any).mobileReferenceDisplay;return {calls:s.calls.length,actions:s.dispatches,signals:s.signals.map(s=>s.aborted)};});
 assert.equal(fact.preview.actions.length,mode==='allowed'?1:0);if(mode==='allowed'){assert.equal(fact.preview.actions[0].kind,'open-private');assert.equal(fact.preview.actions[0].locator,target.targetId);}
 assert.deepEqual(await snapshot(page),before,'preview/navigation never mutate document or history');
 await finish(page,baseline,fact);assert.equal(await page.evaluate(()=>(window as any).mobileReferenceDisplay.listeners.size),0);
}));
for(const action of ['accept','focus-away','remote'])
test(`MWX-C08 delayed slash ${action} keeps native focus and one-command ownership`,()=>probe(`MWX-C08-delayed-${action}`,async(page,fact)=>{
 const baseline=await mount(page,{baselineModules:true}),before=await state(page);await tap(page,'Slash commands');await page.getByRole('menuitem',{name:'Delayed module action',exact:true}).tap();
 if(action==='focus-away')await page.locator('#host-control').focus();if(action==='remote')await page.evaluate(()=>(window as any).inputFixture.remote(0,0,'remote '));
 const changed=await snapshot(page);await page.evaluate(()=>{const w=window as any;w.modulePending.resolve({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'accepted',marks:[]}]}]});});await frame(page);
 const after=await state(page);
 if(action==='accept'){assert.equal(after.history.undoGroups,1);assert.ok(text(after).includes('accepted'));await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);}
 else {assert.deepEqual(await snapshot(page),changed);assert.equal(await page.evaluate(()=>(window as any).modulePending.signal.aborted),true);if(action==='focus-away')assert.equal(await page.evaluate(()=>document.activeElement?.id),'host-control');}
 fact.snapshots.push({after});await finish(page,baseline,fact);
}));
