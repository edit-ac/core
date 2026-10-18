import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { commandProfiles } from './command-inventory.mjs';
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installExtensionCounters } from './resources.mjs';
import { installResourceCounters } from '../../mobile-web/resources.mjs';

const { probe, facts } = browserHarness('mobile-extensions', 'fixtures/browser-mobile-extensions', {
  autoMount: false, testFile: 'tests/browser/mobile-extensions/gestures.spec.ts', assertSourcesUnchanged: true,
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
    await page.route('**/*',route=>{const url=route.request().url();if(new URL(url).origin!==new URL(fact.origin).origin){fact.unexpectedRequests.push(url);return route.abort();}return route.continue();});
    await page.addInitScript(installResourceCounters); await page.addInitScript(installExtensionCounters); },
  sourcePaths: ['../.roadmap-runner/overnight-features-20261018/.roadmap-runner/02-mobile-extension-features-f5cf70ae3d13/source-0d7e6b959a8a.md', '../architecture/specs/editor-interactions.md', '../architecture/specs/link-resolution.md','fixtures/browser-mobile-extensions/reference-display.mjs', 'packages/web/src/modules/references/display.ts', 'packages/web/dist/modules/references/display.js', 'packages/web/src/modules/links/activation.ts', 'packages/core/src/links/activation.ts','packages/web/src/modules/touch-controls.ts', 'packages/web/dist/modules/touch-controls.js', 'packages/web/src/ui/commands.ts', 'packages/web/dist/ui/commands.js','packages/web/src/extensions/highlighting.ts', 'packages/web/src/extensions/assets.ts', 'packages/web/src/extensions/math.ts', 'tests/consumers/mobile-extensions/graph.mjs', 'scripts/build-extension-runtime.mjs','packages/web/src/modules/presenter-sequence.ts','packages/web/src/extensions/authoring-metadata.ts','packages/web/src/extensions/spelling-metadata.ts','packages/web/src/modules/slash-metadata.ts','packages/web/src/dom/pattern-text.ts', ...['search','reorder','slash','references','content'].flatMap(n=>[`packages/web/src/extensions/runtime/${n}.ts`,`packages/web/dist/extensions/runtime/${n}.js`]),'packages/web/dist/extensions/runtime/manifest.json',...browserInputSources, 'fixtures/browser-mobile-extensions/session.mjs', 'fixtures/browser-mobile-extensions/index.html',
    'tests/browser/mobile-extensions/gestures.spec.ts', '../architecture/specs/rich-content-extensions.md', 'tests/browser/mobile-extensions/content-host-matrix.ts', 'tests/browser/mobile-extensions/command-matrix.ts', 'tests/browser/mobile-extensions/command-inventory.mjs',
    'fixtures/rich-content/asset-descriptors.json', 'packages/core/src/extensions/profiles.ts', 'packages/web/src/commands/catalog.ts',
    ...['modules/images/presenter','modules/attachments/presenter','modules/embeds/presenter','modules/content','modules/reorder','modules/search','modules/references','modules/slash','extensions/code'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
    'tests/browser/mobile-extensions/index.mjs', 'tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs', 'tests/browser/mobile-extensions/resources.mjs', 'scripts/test-mobile-extensions.mjs', 'packages/web/package.json',
    '../architecture/tests/mobile-extension-cases.md', '../architecture/specs/mobile-web.md',
    ...['editor', 'surface', 'extensions/configuration', 'extensions/contract', 'platform/viewport'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`])],
});
facts.binding = {gate:'MEX-1.4', ids:['MWX-C13','MWX-C14','MWX-C15','MWX-C16'],
 semantics:'actual packed BrowserEditor/Session/WASM/IndexedDB; prepared viewport/pointer/remote edits',
 platform:'desktop Chromium/Firefox/WebKit mechanics; original MWX-1.8 device/OS/native/IME/AT pending',
 resize:'unsupported: no advertised portable image/table resize command; no dimensions persisted',
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

async function mountGesture(page, options = {}) {
  const baseline = await mount(page, {reorder:true, gestureAudit:true,
    nodes:[{text:'alpha😀 אב'},{text:'beta'},{text:'gamma'},{text:'delta'},{text:'epsilon'}], ...options});
  await page.evaluate(() => {
    const f=(window as any).inputFixture;
    Object.assign(f.root.style,{height:'220px',minHeight:'0',overflow:'auto',lineHeight:'32px'});
    Object.assign(document.querySelector<HTMLElement>('#scroll-root')!.style,{height:'340px',overflow:'visible'});
    f.select(f.ids[0],4,1);
  });
  await frame(page); return baseline;
}
async function state(page) {
  return page.evaluate(async () => { const f=(window as any).inputFixture;
    return {...await f.state(), pointer:f.pointer, commands:(window as any).gestureCommands,
      status:f.surface.reorder?.status.textContent}; });
}
function unchanged(before, after) {
  for (const key of ['nodes','history','journal','patches','commands']) assert.deepEqual(after[key],before[key],key);
}
function released(s) {
  for (const key of ['captured','active','pendingFrame','retainedSelection']) assert.equal(s.pointer[key],false,key);
}
function moved(before, after) {
  assert.equal(after.history.undoGroups,before.history.undoGroups+1);
  assert.equal(after.commands.length,before.commands.length+1);
  assert.equal(after.commands.at(-1).origin,'module-reorder');
  assert.equal(after.commands.at(-1).commands.length,1);
  assert.equal(after.commands.at(-1).commands[0].type,'move');
  assert.equal(after.patches.filter(p=>p.update).length,before.patches.filter(p=>p.update).length+1);
  assert.equal(after.journal.length,before.journal.length+1);
  assert.deepEqual(after.selection,before.selection,'retained backward selection');
  for (const node of before.nodes) {
    const next=after.nodes.find(n=>n.id===node.id);
    for(const field of ['runs','spans','blockAttributes']) assert.deepEqual(next[field],node[field],field);
  }
  released(after);
}
async function undo(page) {
  await page.evaluate(()=>{const f=(window as any).inputFixture;f.root.focus();const c=f.surface.captureCommand('undo');
    if(!c)throw Error('Undo unavailable');try{c.execute();}finally{c.dispose();}});await frame(page);
}
async function start(page) {
  await page.evaluate(()=>document.addEventListener('pointerdown',e=>(window as any).gesturePointer=e.pointerId,{capture:true,once:true}));
  const b=await page.getByRole('button',{name:'Drag selected block',exact:true}).boundingBox();
  assert.ok(b);await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
  assert.equal((await state(page)).pointer.captured,true,'real browser capture established');
  assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="Drag selected block"]').hasPointerCapture((window as any).gesturePointer)),true);
}
async function hover(page,index=2,after=true) {
  const b=await page.locator('#projection [data-node-id]').nth(index).boundingBox();assert.ok(b);
  const point={x:b.x+30,y:b.y+b.height*(after?.75:.25)};
  await page.mouse.move(point.x,point.y);await frame(page);return point;
}
async function terminalEvents(page) {
  await page.evaluate(()=>{const grip=document.querySelector('[aria-label="Drag selected block"]');if(!grip)return;
    for(const type of ['pointerup','lostpointercapture','pointercancel','click'])grip.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:(window as any).gesturePointer,isPrimary:true}));});
  await frame(page);
  assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="Drag selected block"]')?.hasPointerCapture((window as any).gesturePointer)??false),false);
}

for(const facade of [false,true]) for(const path of ['drag','tap']) test(`MWX-C13 ${facade?'configured':'advanced'} ${path} preserves identity, selection and one move/undo group`,()=>probe(`MWX-C13-${facade}-${path}`,async(page,fact)=>{
  const baseline=await mountGesture(page,facade?{facade:'reorder'}:{}),before=await state(page);
  if(path==='drag') {await start(page);await hover(page,1,true);const preview=await state(page);unchanged(before,preview);await page.mouse.up();}
  else await page.getByRole('button',{name:'Move block down',exact:true}).tap();
  const after=await state(page);fact.snapshots.push(before,after);moved(before,after);
  assert.deepEqual(after.nodes.map(n=>n.id),[before.nodes[1].id,before.nodes[0].id,...before.nodes.slice(2).map(n=>n.id)]);
  await terminalEvents(page);unchanged(after,await state(page));
  await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);
  await page.evaluate(()=>{const f=(window as any).inputFixture;(window as any).retired=f.surface.reorder;});
  await finish(page,baseline,fact);fact.retired=await page.evaluate(()=>(window as any).retired.pointerState);
  assert.equal(fact.retired.listeners,0);assert.equal(fact.retired.subscribed,false);released({pointer:fact.retired});
}));

test('MWX-C13 tap alternatives work with pointer capture unavailable and have intrinsic targets',()=>probe('MWX-C13-no-drag',async(page,fact)=>{
  const baseline=await mountGesture(page);const before=await state(page);
  fact.targets=await page.evaluate(()=>[...document.querySelectorAll('[aria-label="Reorder block"] button')].map(el=>{
    const b=el.getBoundingClientRect();return {name:el.textContent,width:b.width,height:b.height,touchAction:getComputedStyle(el).touchAction};}));
  for(const t of fact.targets){assert.ok(t.width>=44&&t.height>=44,JSON.stringify(t));if(t.name!=='Drag selected block')assert.notEqual(t.touchAction,'none');}
  await page.evaluate(()=>{HTMLElement.prototype.setPointerCapture=()=>{throw Error('prepared unavailable');};});
  await startWithoutCapture(page);released(await state(page));unchanged(before,await state(page));
  await page.getByRole('button',{name:'Move block down',exact:true}).tap();moved(before,await state(page));
  await page.getByRole('button',{name:'Move block up',exact:true}).tap();
  const restored=await state(page);
  assert.deepEqual(restored.nodes.map(n=>({id:n.id,order:n.order,parent:n.parent,runs:n.runs,spans:n.spans})),
    before.nodes.map(n=>({id:n.id,order:n.order,parent:n.parent,runs:n.runs,spans:n.spans})));
  assert.equal(restored.commands.length,2);assert.equal(restored.history.undoGroups,2);
  await finish(page,baseline,fact);
}));
async function startWithoutCapture(page){const b=await page.getByRole('button',{name:'Drag selected block',exact:true}).boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2);}

test('MWX-C14 ordinary text/native drag and unrelated pointers retain their input owner; resize is unavailable',()=>probe('MWX-C14-native-owner',async(page,fact)=>{
  const baseline=await mountGesture(page),before=await state(page);
  const result=await page.evaluate(()=>{
    const f=(window as any).inputFixture,block=f.root.querySelector('[data-node-id]');
    const events=['pointerdown','pointermove','pointerup'].map(type=>{const e=new PointerEvent(type,{bubbles:true,cancelable:true,isPrimary:true,pointerId:81,pointerType:'touch',clientX:30,clientY:60});block.dispatchEvent(e);return e.defaultPrevented;});
    const data=new DataTransfer(),drag=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data});block.dispatchEvent(drag);
    return {events,blockMime:data.getData('application/x-editac-block'),touchAction:getComputedStyle(f.root).touchAction,
      controls:[...document.querySelectorAll('[aria-label="Reorder block"] button')].map(b=>b.textContent)};
  });
  assert.deepEqual(result.events,[false,false,false]);assert.equal(result.blockMime,'');assert.equal(result.touchAction,'auto');
  assert.deepEqual(result.controls,['Move block up','Move block down','Drag selected block']);
  unchanged(before,await state(page));released(await state(page));
  await start(page);await hover(page);
  await page.evaluate(()=>{document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse',pointerId:91}));
    document.querySelector('[aria-label="Drag selected block"]').dispatchEvent(new PointerEvent('pointercancel',{pointerId:91}));});
  assert.equal((await state(page)).pointer.captured,true);unchanged(before,await state(page));
  fact.unsupportedResize={image:'no portable resize command',table:'no portable resize command',inventedDimensions:false};
  await page.keyboard.press('Escape');await page.mouse.up();released(await state(page));
  await finish(page,baseline,fact);
}));

for(const profile of ['image','table'])test(`MWX-C14 ${profile} advertises no unsupported resize control or persisted dimensions`,()=>probe(`MWX-C14-${profile}-inventory`,async(page,fact)=>{
  const asset=JSON.parse(readFileSync('fixtures/rich-content/asset-descriptors.json','utf8')).descriptors.find(x=>x.kind==='image');
  const baseline=await mount(page,{gestureAudit:true,...(profile==='table'?{table:true}:{asset,contentHost:'absent'})});
  const before=await snapshot(page),selector=profile==='table'?'[data-content-module="table"]':'[data-content-module="image"]';
  const labels=await page.locator(`${selector} button`).allTextContents();
  const expected=profile==='table'?commandProfiles.find(p=>p.id==='table').commands.concat(commandProfiles.find(p=>p.id==='table').derivedControls):['Load image'];
  assert.deepEqual([...labels].sort(),[...expected].sort(),'exact advertised action inventory');
  assert.ok(labels.every(label=>!/resize|width|height|size preset/i.test(label)));
  assert.equal(await page.locator(`${selector} [data-resize-handle]`).count(),0);
  const native=await page.evaluate(()=>{const f=(window as any).inputFixture,e=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',pointerId:71,isPrimary:true});f.root.dispatchEvent(e);return e.defaultPrevented;});
  assert.equal(native,false);assert.deepEqual(await snapshot(page),before);
  fact.resize={available:false,enabled:false,authorized:false,qualified:false,owner:profile==='table'?'modules/content.ts':'modules/images/presenter.ts',advertisedActions:labels};
  await finish(page,baseline,fact);
}));

test('MWX-C15 real subthreshold touch release preserves the document and backward selection',()=>probe('MWX-C15-touch-threshold',async(page,fact)=>{
  const baseline=await mountGesture(page),before=await state(page);
  await page.getByRole('button',{name:'Drag selected block',exact:true}).tap();
  const after=await state(page);unchanged(before,after);released(after);assert.deepEqual(after.selection,before.selection);
  fact.snapshots.push(before,after);await finish(page,baseline,fact);
}));

for(const reason of ['pointercancel','lostpointercapture','second-touch','blur','readonly','composition','resize','orientationchange','visual-resize','pagehide','scale','unavailable-geometry','destroy'])
test(`MWX-C15 ${reason} cancels capture, frames and selection without a command`,()=>probe(`MWX-C15-${reason}`,async(page,fact)=>{
  const baseline=await mountGesture(page),before=await state(page);
  await start(page);await hover(page);unchanged(before,await state(page));
  await page.evaluate(async reason=>{
    const f=(window as any).inputFixture;(window as any).retired=f.surface.reorder;
    const grip=f.surface.reorder.controls.querySelector('[aria-label="Drag selected block"]');
    if(reason==='readonly')f.surface.setReadOnly(true);
    else if(reason==='composition')f.deliver('compositionstart');
    else if(reason==='destroy'){
      const updates=(window as any).gestureDestroyUpdates=[];
      const sub=f.engine.subscribe({type:'all'},p=>{if(p.update)updates.push(p.origin);});
      try{await f.destroy();}finally{sub.dispose();}
    }
    else if(reason==='second-touch'){const e=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',pointerId:999});f.root.dispatchEvent(e);(window as any).secondTouchPrevented=e.defaultPrevented;}
    else if(reason==='scale'||reason==='unavailable-geometry'){
      if(reason==='scale')(window as any).mobileGeometry.scale=2;else (window as any).mobileGeometryError=true;
      document.querySelector('#scroll-root').dispatchEvent(new Event('scroll'));
    } else if(reason==='visual-resize')window.visualViewport.dispatchEvent(new Event('resize'));
    else if(['blur','resize','orientationchange','pagehide'].includes(reason))window.dispatchEvent(new Event(reason));
    else grip.dispatchEvent(new PointerEvent(reason,{pointerId:(window as any).gesturePointer}));
  },reason);
  // Prepared geometry is sampled by the real coalesced viewport owner.
  // Wait for that notification before delivering a later release event.
  if(reason==='scale'||reason==='unavailable-geometry')await frame(page);
  await page.mouse.up();await frame(page);await terminalEvents(page);
  const retired=await page.evaluate(()=>(window as any).retired.pointerState);fact.retired=retired;released({pointer:retired});
  if(reason==='destroy'){
    assert.equal(retired.listeners,0);assert.equal(retired.subscribed,false);
    assert.deepEqual(await page.evaluate(()=>(window as any).gestureDestroyUpdates),[]);
    assert.equal(await page.evaluate(()=>(window as any).gestureCommands.length),0);
    const resources=await page.evaluate(()=>(window as any).mobileResources());assert.deepEqual(resources,baseline);
  }else{
    unchanged(before,await state(page));
    if(reason==='second-touch')assert.equal(await page.evaluate(()=>(window as any).secondTouchPrevented),false);
    if(reason==='composition')await page.evaluate(()=>(window as any).inputFixture.deliver('compositionend'));
    await finish(page,baseline,fact);
  }
}));

test('MWX-C16 session replacement rejects retired captured callbacks and preserves recovered content',()=>probe('MWX-C16-session-replacement',async(page,fact)=>{
  const baseline=await mountGesture(page),before=await state(page);await start(page);await hover(page);
  const recovered=await page.evaluate(async()=>{const f=(window as any).inputFixture,retired=f.surface.reorder,grip=retired.controls.querySelector('[aria-label="Drag selected block"]');
    const updates=[],sub=f.engine.subscribe({type:'all'},p=>{if(p.update)updates.push(p.origin);});
    try{await f.destroy();}finally{sub.dispose();}
    const oldCommands=(window as any).gestureCommands.length;await f.recover();
    for(const type of ['pointermove','pointerup','lostpointercapture','click'])grip.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:(window as any).gesturePointer,isPrimary:true}));
    return {updates,oldCommands,retired:retired.pointerState};});
  await page.mouse.up();const after=await state(page);
  assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.journal,before.journal);assert.equal(after.history.undoGroups,0);
  assert.deepEqual(recovered.updates,[]);assert.equal(recovered.oldCommands,0);assert.equal(after.commands.length,0);
  released({pointer:recovered.retired});assert.equal(recovered.retired.listeners,0);assert.equal(recovered.retired.subscribed,false);
  fact.snapshots.push(before,after);fact.recovered=recovered;await finish(page,baseline,fact);
}));

for(const target of ['source-delete','destination-delete','source-reparent','destination-reparent','destination-relocate'])
test(`MWX-C16 ${target} releases resources immediately and never redirects the move`,()=>probe(`MWX-C16-${target}`,async(page,fact)=>{
  const baseline=await mountGesture(page);
  if(target==='source-delete')await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[1],2);});
  await start(page);await hover(page,2,true);
  await page.evaluate(async target=>{const f=(window as any).inputFixture;
    if(target==='source-delete')await f.remoteJoin(0,1);
    else if(target==='destination-delete')await f.remoteJoin(1,2);
    else await f.remoteStructure(target==='source-reparent'?0:2,target!=='destination-relocate');
  },target);
  const changed=await state(page);released(changed);assert.equal(changed.commands.length,0);
  await page.mouse.up();await terminalEvents(page);unchanged(changed,await state(page));
  fact.snapshots.push(changed);await finish(page,baseline,fact);
}));

test('MWX-C16 unrelated remote Unicode edit keeps valid stable targets and survives accepted move/undo',()=>probe('MWX-C16-valid-peer',async(page,fact)=>{
  const baseline=await mountGesture(page);await start(page);await hover(page,2,true);
  await page.evaluate(()=>(window as any).inputFixture.remote(4,1,'PEER😀'));
  const before=await state(page);assert.equal(before.pointer.captured,true);assert.equal(before.commands.length,0);
  await page.mouse.up();const after=await state(page);moved(before,after);
  assert.ok(after.nodes.find(n=>n.id===before.nodes[4].id).runs.some(r=>r.text.includes('PEER😀')));
  await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);
  fact.snapshots.push(before,after);await finish(page,baseline,fact);
}));

for(const remoteDelete of [false,true])test(`MWX-C13/16 nested scroll refresh and ${remoteDelete?'remote deletion':'accepted termination'} release all work`,()=>probe(`MWX-C13-nested-scroll-${remoteDelete}`,async(page,fact)=>{
  const baseline=await mountGesture(page,{nodes:Array.from({length:40},(_,i)=>({text:i===0?'alpha😀':`block ${i}`}))});
  await page.evaluate(()=>{const f=(window as any).inputFixture;
    Object.assign(f.root.style,{height:'auto',overflow:'visible'});
    Object.assign(document.querySelector<HTMLElement>('#scroll-root').style,{height:'320px',overflow:'auto'});
    // Host toolbar outside the nested scroller leaves its lower edge available
    // as a text drop target rather than covering that target with controls.
    document.body.append(f.surface.reorder.controls);
    Object.assign(f.surface.reorder.controls.style,{position:'fixed',top:'600px',left:'0'});
  });await frame(page);const before=await state(page);await start(page);
  const box=await page.locator('#scroll-root').boundingBox();await page.mouse.move(box.x+30,box.y+box.height-12);
  await page.waitForFunction(()=>document.querySelector('#scroll-root').scrollTop>=32,{},{timeout:3000});
  const during=await state(page);fact.hit=await page.evaluate(point=>document.elementFromPoint(point.x,point.y)?.outerHTML.slice(0,400),{x:box.x+30,y:box.y+box.height-12});
  assert.equal(during.pointer.captured,true);unchanged(before,during);
  assert.equal(during.pointer.frames,during.pointer.hitTests);assert.ok(during.pointer.geometryReads<=during.pointer.frames*2);
  assert.ok(during.pointer.scrollAncestorChecks<=during.pointer.frames*32);
  assert.ok(during.pointer.scrollWrites<=during.pointer.frames);
  let remote;
  if(remoteDelete){
    fact.deletedTarget=await page.evaluate(async()=>{const f=(window as any).inputFixture,id=f.pointer.destinationId,index=f.ids.indexOf(id);
      if(index<=1)throw Error('Expected a non-source scrolled destination');await f.remoteJoin(index-1,index);return id;});
    remote=await state(page);released(remote);assert.equal(remote.commands.length,0);assert.ok(!remote.nodes.some(n=>n.id===fact.deletedTarget));
  }else{
    // Move from the edge onto a visible block before release. Paragraph margin
    // gaps are intentionally not destinations, especially in WebKit hit tests.
    const target=await page.evaluate(()=>{const container=document.querySelector('#scroll-root').getBoundingClientRect();
      return [...document.querySelectorAll('#projection [data-node-id]')].map(el=>el.getBoundingClientRect())
        .filter(r=>r.top>container.top+60&&r.bottom<container.bottom-60).map(r=>({x:r.x+30,y:r.y+r.height*.6})).at(-1);});
    assert.ok(target);await page.mouse.move(target.x,target.y);await frame(page);
  }
  await page.mouse.up();
  const after=await state(page);fact.snapshots.push(during,after);if(remoteDelete)unchanged(remote,after);else moved(before,after);
  const idle=after.pointer;await frame(page);assert.deepEqual((await state(page)).pointer,idle);
  await finish(page,baseline,fact);
}));
