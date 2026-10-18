import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';
const {probe,facts}=browserHarness('mobile-harness','fixtures/browser-mobile-web',{
 autoMount:false,testFile:'tests/mobile-web/viewport.spec.ts',assertSourcesUnchanged:true,
 contextOptions:{viewport:{width:390,height:740},hasTouch:true,isMobile:true},
 beforeNavigate:async page=>page.addInitScript(installResourceCounters),
 sourcePaths:[...browserInputSources,...['editor','surface','platform/viewport','selection/pointer','modules/reorder'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
 'fixtures/browser-mobile-web/session.mjs','fixtures/browser-mobile-web/index.html','tests/mobile-web/viewport.spec.ts','tests/mobile-web/resources.mjs','tests/mobile-web/catalog.mjs','tests/mobile-web/case-index.json','scripts/test-mobile-web.mjs','../architecture/specs/mobile-web.md','../architecture/tests/mobile-web-cases.md'],
});
facts.binding={gate:'MWF-1.4',ids:Array.from({length:9},(_,i)=>`MBV-0${i+1}`),provenance:'prepared owning-window geometry and occlusions over packed production BrowserEditor/Session/Rust/WASM/IndexedDB; actual keyboard/native zoom/device observations deferred to original MWB-1.11'};
const normal={visual:{left:0,top:0,width:390,height:740},scale:1};
async function frames(page){await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));}
async function mount(page,prepared=true,requestedMode='resizes-content'){
 await page.waitForFunction(()=>!!(window as any).inputFixture);const baseline=await page.evaluate(()=>(window as any).mobileResources());
 await page.evaluate(async({prepared,normal,requestedMode})=>{const w=window as any;w.mobileGeometry=normal;const f=w.inputFixture;await f.mount({nodes:Array.from({length:35},(_,i)=>({text:`row ${i} alpha😀`})),reorder:true,viewport:prepared,requestedMode});f.root.style.cssText='min-height:0;font:18px/28px monospace;white-space:pre-wrap;touch-action:auto';f.select(f.ids[0],5,1);await f.settle();},{prepared,normal,requestedMode});await frames(page);return baseline;
}
async function observe(page,fact){const s=await page.evaluate(()=>(window as any).inputFixture.state());assert.deepEqual(s.errors,[]);assert.equal(s.storage,'localCommitted');fact.snapshots.push(s);return s;}
function unchanged(a,b){for(const key of ['nodes','selection','history','patches','journal'])assert.deepEqual(b[key],a[key],key);}
async function geometry(page,g){await page.evaluate(g=>{(window as any).mobileGeometry=g;for(let i=0;i<30;i++){window.dispatchEvent(new Event('resize'));document.querySelector('#scroll-root')!.dispatchEvent(new Event('scroll'));}},g);await frames(page);}
async function clean(page,baseline,fact){await page.evaluate(async()=>{const w=window as any;await w.second?.dispose();w.extra?.dispose();w.iframe?.remove();await w.inputFixture.destroy();});await frames(page);const after=await page.evaluate(()=>(window as any).mobileResources());fact.resources={baseline,after};assert.deepEqual(after,baseline);}
async function viewport(page){return page.evaluate(()=>(window as any).inputFixture.surface.viewport.state);}
for(const mode of ['resizes-content','resizes-visual','overlays-content'])test(`MBV-01/02 ${mode} follows only local caret requests without semantic/focus changes`,()=>probe('MBV-01-'+mode,async(page,fact)=>{
 const baseline=await mount(page,true,mode);assert.equal((await viewport(page)).requestedMode,mode);await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[34],3);document.querySelector('#scroll-root')!.scrollTop=0;});await frames(page);const before=await observe(page,fact);
 const g=mode==='overlays-content'?{...normal,occlusions:[{left:0,top:190,width:390,height:550}]}:{...normal,visual:{...normal.visual,height:190}};
 await geometry(page,g);assert.equal(await page.locator('#scroll-root').evaluate(e=>e.scrollTop),0,'passive resize does not chase reader');
 await page.evaluate(()=>(window as any).inputFixture.surface.viewport.requestCaret());await frames(page);
 assert.ok(await page.locator('#scroll-root').evaluate(e=>e.scrollTop)>0);const caret=await page.evaluate(()=>{const r=document.createRange(),s=getSelection()!;r.setStart(s.focusNode!,s.focusOffset);r.collapse(true);const b=r.getBoundingClientRect();return {top:b.top,bottom:b.bottom};});assert.ok(caret.bottom<=191,JSON.stringify(caret));
 unchanged(before,await observe(page,fact));assert.equal(await page.locator('#projection').evaluate(e=>e===document.activeElement),true);await clean(page,baseline,fact);
}));
test('MBV-02 two recovered editors share one read/write batch and preserve host policy through teardown',()=>probe('MBV-02-two-editors',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);const meta=await page.locator('meta[name=viewport]').getAttribute('content');
 await page.evaluate(async()=>{const w=window as any;w.second=await w.inputFixture.sibling();});await frames(page);const start=await viewport(page);assert.equal(start.consumers,2);
 await geometry(page,{...normal,occlusions:[{left:0,top:240,width:390,height:500}],safeArea:{top:0,left:0,right:0,bottom:20}});const end=await viewport(page);assert.equal(end.readBatches-start.readBatches,1);assert.equal(end.writePhases-start.writePhases,1);
 await page.evaluate(async()=>{const w=window as any;await w.second.dispose();w.second=undefined;});assert.equal((await viewport(page)).consumers,1);await geometry(page,normal);unchanged(before,await observe(page,fact));assert.equal(await page.locator('meta[name=viewport]').getAttribute('content'),meta);await clean(page,baseline,fact);
}));
test('MBV-03/05 rotation and zoom offsets stay in CSS coordinates, with no DPR compensation',()=>probe('MBV-03-05-coordinates',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);await geometry(page,{visual:{left:35,top:60,width:260,height:120},scale:2,safeArea:{top:8,left:4,right:4,bottom:12}});
 const style=await page.evaluate(()=>{const e=(window as any).inputFixture.surface.reorder.controls;return {top:e.style.top,left:e.style.left,maxHeight:e.style.maxHeight};});assert.deepEqual(style,{top:'68px',left:'39px',maxHeight:'100px'});
 await geometry(page,{visual:{left:0,top:0,width:740,height:180},scale:1});unchanged(before,await observe(page,fact));assert.equal((await viewport(page)).observed.visual.width,740);await clean(page,baseline,fact);
}));
test('MBV-04 floating occlusion avoids invented bottom inset and leaves reachable controls',()=>probe('MBV-04-floating',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);await geometry(page,{...normal,occlusions:[{left:180,top:430,width:160,height:160}]});const state=await viewport(page);assert.equal(state.observed.visual.height,740);assert.deepEqual(state.observed.occlusions,[{left:180,top:430,width:160,height:160}]);assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.reorder.controls.style.maxHeight),'430px');unchanged(before,await observe(page,fact));await clean(page,baseline,fact);
}));
test('MBV-06 safe area applied once and browser-chrome changes preserve content, selection and host focus',()=>probe('MBV-06-safe-area',async(page,fact)=>{
 const baseline=await mount(page);const retained=await page.evaluate(()=>{const w=window as any,f=w.inputFixture;w.viewportRetained=f.selection.retain();return [f.engine.resolve(w.viewportRetained.range.anchor),f.engine.resolve(w.viewportRetained.range.focus)];});await page.locator('#host-control').focus();const before=await observe(page,fact);await geometry(page,{visual:{left:0,top:0,width:390,height:260},scale:1,occlusions:[{left:0,top:260,width:390,height:480}],safeArea:{top:10,left:0,right:0,bottom:20}});
 assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.reorder.controls.style.maxHeight),'230px');assert.equal(await page.evaluate(()=>document.activeElement!.id),'host-control');unchanged(before,await observe(page,fact));const resolved=await page.evaluate(()=>{const w=window as any,f=w.inputFixture;try{return [f.engine.resolve(w.viewportRetained.range.anchor),f.engine.resolve(w.viewportRetained.range.focus)];}finally{w.viewportRetained.dispose();}});assert.deepEqual(resolved,retained);await clean(page,baseline,fact);
}));
test('MBV-07 nested scroll events are owned; same-origin iframe uses its own window without parent access',()=>probe('MBV-07-owners',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);const start=await viewport(page);await page.locator('#scroll-root').evaluate(e=>e.dispatchEvent(new Event('scroll')));await frames(page);assert.equal((await viewport(page)).readBatches,start.readBatches+1);
 const result=await page.evaluate(async()=>{const w=window as any,{EditorViewport}=await import('/web/index.js');const iframe=document.createElement('iframe');iframe.srcdoc='<div id="editor" contenteditable="true">iframe</div>';document.body.append(iframe);await new Promise(r=>iframe.onload=r);w.iframe=iframe;const root=iframe.contentDocument!.querySelector<HTMLElement>('#editor')!;w.extra=new EditorViewport(root);const before=w.inputFixture.surface.viewport.state.readBatches;iframe.contentWindow!.dispatchEvent(new Event('resize'));await new Promise(r=>iframe.contentWindow!.requestAnimationFrame(r));return {mainBefore:before,mainAfter:w.inputFixture.surface.viewport.state.readBatches,iframeConsumers:w.extra.state.consumers,iframeWidth:w.extra.state.observed.visual.width};});assert.equal(result.mainAfter,result.mainBefore);assert.equal(result.iframeConsumers,1);assert.ok(result.iframeWidth>0);unchanged(before,await observe(page,fact));await clean(page,baseline,fact);
}));
test('MBV-08 burst coalescing is idle after delivery; remote edit cannot scroll or steal focus',()=>probe('MBV-08-burst-remote',async(page,fact)=>{
 const baseline=await mount(page);await page.locator('#host-control').focus();const start=await viewport(page);await geometry(page,{...normal,visual:{...normal.visual,height:250}});const end=await viewport(page);assert.equal(end.readBatches-start.readBatches,1);assert.equal(end.pendingFrame,false);await frames(page);assert.deepEqual(await viewport(page),end);
 const scroll=await page.locator('#scroll-root').evaluate(e=>e.scrollTop);await page.evaluate(async()=>{await(window as any).inputFixture.remote(0,0,'!');});await frames(page);assert.equal(await page.locator('#scroll-root').evaluate(e=>e.scrollTop),scroll);assert.equal(await page.evaluate(()=>document.activeElement!.id),'host-control');const s=await observe(page,fact);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,0);assert.equal(s.nodes[0].runs.map(r=>r.text).join(''),'!row 0 alpha😀');await clean(page,baseline,fact);
}));
for(const failure of ['throwing','invalid','tiny','native'])test(`MBV-09 ${failure} geometry retains native editing and reachable actions`,()=>probe('MBV-09-'+failure,async(page,fact)=>{
 const baseline=await mount(page,failure!=='native');if(failure==='throwing')await page.evaluate(()=>(window as any).mobileGeometryError=true);
 await geometry(page,failure==='invalid'?{...normal,visual:{...normal.visual,width:NaN}}:failure==='tiny'?{...normal,visual:{...normal.visual,width:100,height:48}}:normal);
 if(['throwing','invalid'].includes(failure))assert.equal((await viewport(page)).observed.fallback,true);
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('beforeinput',{inputType:'insertText',data:'x',cancelable:true});});await page.evaluate(()=>(window as any).inputFixture.settle());const s=await observe(page,fact);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);assert.equal(s.nodes[0].runs.map(r=>r.text).join(''),'rx alpha😀');assert.equal(await page.locator('#projection').getAttribute('contenteditable'),'true');await clean(page,baseline,fact);
}));
for(const failure of ['valid','scale','throwing','standalone','orientation'])test(`MBV-03/08 gesture ${failure} refresh preserves or cancels the existing capture/scroll owner`,()=>probe('MBV-gesture-'+failure,async(page,fact)=>{
 const baseline=await mount(page);await page.evaluate(()=>{const f=(window as any).inputFixture;f.root.style.height='240px';f.root.style.overflow='auto';f.surface.reorder.controls.style.cssText='position:fixed;bottom:4px;left:4px;background:Canvas';});await frames(page);const before=await observe(page,fact);
 const grip=page.getByRole('button',{name:'Drag selected block',exact:true});const box=await grip.boundingBox();assert.ok(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();const root=await page.locator('#projection').boundingBox();assert.ok(root);await page.mouse.move(root.x+30,root.y+root.height-4);await frames(page);const active=await page.evaluate(()=>(window as any).inputFixture.pointer);assert.equal(active.captured,true);assert.ok(active.scrollWrites>0);
 if(failure==='throwing')await page.evaluate(()=>(window as any).mobileGeometryError=true);
 if(failure==='standalone')await page.evaluate(()=>(window as any).inputFixture.surface.reorder.setViewportManaged(false));
 if(failure==='orientation')await page.evaluate(()=>window.dispatchEvent(new Event('orientationchange')));
 await geometry(page,{...normal,scale:failure==='scale'?2:1,visual:{...normal.visual,height:700}});
 const after=await page.evaluate(()=>(window as any).inputFixture.pointer);fact.gesture={before:active,after};assert.equal(after.captured,failure==='valid');
 if(failure==='valid'){assert.ok(after.scrollWrites>active.scrollWrites);await grip.dispatchEvent('pointercancel',{pointerId:1});await page.keyboard.press('Escape');}else{assert.equal(after.pendingFrame,false);assert.equal(after.retainedSelection,false);}
 await page.mouse.up();unchanged(before,await observe(page,fact));await clean(page,baseline,fact);
}));
test('MBV-01 local committed input requests one caret follow while passive frames remain idle',()=>probe('MBV-local-edit',async(page,fact)=>{
 const baseline=await mount(page);await geometry(page,{...normal,visual:{...normal.visual,height:190}});await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[34],3);document.querySelector('#scroll-root')!.scrollTop=0;f.deliver('beforeinput',{inputType:'insertText',data:'!',cancelable:true});});await page.evaluate(()=>(window as any).inputFixture.settle());await frames(page);assert.ok(await page.locator('#scroll-root').evaluate(e=>e.scrollTop)>0);const s=await observe(page,fact);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);assert.equal(s.nodes[34].runs.map(r=>r.text).join(''),'row! 34 alpha😀');const end=await viewport(page);await frames(page);assert.deepEqual(await viewport(page),end);await clean(page,baseline,fact);
}));
test('MBV-05 zoom-offset reachable control hit commits exactly once with backward selection retained',()=>probe('MBV-05-hit',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);await geometry(page,{visual:{left:35,top:60,width:300,height:160},scale:2});
 const button=page.getByRole('button',{name:'Move block down',exact:true});await button.click();await page.evaluate(()=>(window as any).inputFixture.settle());const after=await observe(page,fact);
 assert.equal(after.nodes[1].id,before.nodes[0].id);assert.equal(after.nodes[0].id,before.nodes[1].id);assert.deepEqual(after.selection,before.selection);assert.equal(after.journal.length,1);assert.equal(after.history.undoGroups,1);assert.equal(after.patches.filter(p=>p.update).length,1);await clean(page,baseline,fact);
}));
test('MBV-07 cross-origin embedded editor owns only its window and tears down its session',()=>probe('MBV-07-cross-origin',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);const url=page.url().replace('127.0.0.1','localhost');assert.notEqual(new URL(url).origin,new URL(page.url()).origin);
 const navigation=page.waitForEvent('framenavigated',{predicate:f=>f.url().startsWith(new URL(url).origin)});
 await page.evaluate(url=>{const f=document.createElement('iframe');f.id='cross-origin';f.src=url;document.body.append(f);},url);
 const frame=await navigation;await frame.waitForFunction(()=>!!(window as any).inputFixture);
 const childBaseline=await frame.evaluate(()=>(window as any).mobileResources());const proof=await frame.evaluate(async()=>{const f=(window as any).inputFixture;let blocked=false;try{void parent.document.body;}catch{blocked=true;}await f.mount('cross origin');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {blocked,state:f.surface.viewport.state,text:f.engine.read().visible[0].runs.map(r=>r.text).join('')};});assert.equal(proof.blocked,true);assert.equal(proof.text,'cross origin');assert.equal(proof.state.consumers,1);
 await frame.evaluate(async()=>{await(window as any).inputFixture.destroy();await new Promise(r=>requestAnimationFrame(r));});assert.deepEqual(await frame.evaluate(()=>(window as any).mobileResources()),childBaseline);await page.locator('#cross-origin').evaluate(e=>e.remove());unchanged(before,await observe(page,fact));await clean(page,baseline,fact);
}));
test('MBV-02 conflicting host geometry port rejects a second mount without leaking ownership',()=>probe('MBV-02-conflict',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);const resources=await page.evaluate(()=>(window as any).mobileResources());
 const message=await page.evaluate(async()=>{const {mountEditorSurface}=await import('/web/index.js'),f=(window as any).inputFixture,root=document.createElement('div');f.root.parentElement.append(root);try{mountEditorSurface(root,f.engine,{viewport:{geometry:()=>({visual:{left:0,top:0,width:390,height:740},scale:1})}});return 'unexpected mount';}catch(e){return e.message;}finally{root.remove();}});assert.match(message,/Conflicting owning-window/);await frames(page);assert.deepEqual(await page.evaluate(()=>(window as any).mobileResources()),resources);assert.equal((await viewport(page)).consumers,1);unchanged(before,await observe(page,fact));await clean(page,baseline,fact);
}));
test('MBV-08/09 mutable host snapshots are isolated and excessive occlusions fall back within fixed bounds',()=>probe('MBV-08-09-resource-bound',async(page,fact)=>{
 const baseline=await mount(page),before=await observe(page,fact);const first=await viewport(page);await page.evaluate(()=>{const w=window as any;w.mobileGeometry.visual.height=220;window.dispatchEvent(new Event('resize'));});await frames(page);assert.equal(first.observed.visual.height,740);assert.equal((await viewport(page)).observed.visual.height,220);
 await geometry(page,{...normal,occlusions:Array.from({length:9},(_,i)=>({left:i,top:100,width:10,height:10}))});assert.equal((await viewport(page)).observed.fallback,true);const end=await viewport(page);await frames(page);assert.deepEqual(await viewport(page),end);unchanged(before,await observe(page,fact));await clean(page,baseline,fact);
}));
