import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';
const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
 autoMount: false, testFile: 'tests/mobile-web/touch.spec.ts', assertSourcesUnchanged: true,
 contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
 beforeNavigate: async page => page.addInitScript(installResourceCounters),
 sourcePaths: [...browserInputSources, ...['editor','surface','selection/pointer','modules/reorder'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
 'fixtures/browser-mobile-web/session.mjs','fixtures/browser-mobile-web/index.html','tests/mobile-web/touch.spec.ts',
 'tests/mobile-web/resources.mjs','tests/mobile-web/catalog.mjs','tests/mobile-web/case-index.json','scripts/test-mobile-web.mjs',
 '../architecture/specs/mobile-web.md','../architecture/tests/mobile-web-cases.md'],
});
facts.binding = { gate:'MWF-1.2', ids:['MBT-01','MBT-02','MBT-03','MBT-04','MBT-05','MBT-06','MBT-07'],
 provenance:'prepared pointer-type/cancel traces over native active pointer capture; production packed BrowserEditor/recovered Session/WASM/IndexedDB; desktop browser touch emulation; native menus/handles/zoom and real device observations deferred to original MWB-1.11' };
const grip = page => page.getByRole('button',{name:'Drag selected block',exact:true});
async function frames(page) { await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))); }
async function mount(page, count=3) {
 await page.waitForFunction(()=>!!(window as any).inputFixture);
 const baseline=await page.evaluate(()=>(window as any).mobileResources());
 await page.evaluate(async count=>{const f=(window as any).inputFixture;await f.mount({nodes:['alpha😀','beta','gamma',...Array.from({length:Math.max(0,count-3)},(_,i)=>`row ${i}`)].map(text=>({text})),reorder:true});f.root.style.cssText='min-height:0;font:18px/28px monospace;white-space:pre-wrap;touch-action:auto';if(count>3){f.root.style.height='240px';f.root.style.overflow='auto';}f.surface.reorder.controls.style.cssText='position:fixed;bottom:4px;left:4px;background:Canvas';f.select(f.ids[0],5,1);await f.settle();},count);
 return baseline;
}
async function state(page,fact?) { const s=await page.evaluate(()=>(window as any).inputFixture.state());assert.deepEqual(s.errors,[]);assert.equal(s.storage,'localCommitted');if(fact)fact.snapshots.push(s);return s; }
function zero(a,b,selection=true) {for(const key of ['nodes','history','patches','journal'])assert.deepEqual(b[key],a[key],key);if(selection)assert.deepEqual(b.selection,a.selection);}
function one(a,b,order) {
 assert.deepEqual(b.nodes.map(n=>n.id),order.map(i=>a.nodes[i].id));
 for(const n of a.nodes){const next=b.nodes.find(x=>x.id===n.id);assert.deepEqual(next.runs,n.runs);assert.deepEqual(next.spans,n.spans);assert.deepEqual(next.blockAttributes,n.blockAttributes);}
 assert.deepEqual(b.selection,a.selection);assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);
 assert.equal(b.patches.filter(p=>p.update).length,a.patches.filter(p=>p.update).length+1);
}
async function pointer(page) {return page.evaluate(()=>(window as any).inputFixture.pointer);}
async function start(page,type='touch') {
 const box=await grip(page).boundingBox();assert.ok(box);const p={x:box.x+box.width/2,y:box.y+box.height/2};
 // Real active browser pointer permits actual setPointerCapture. Only its type
 // and delivered lifecycle below are prepared; capture is never mocked.
 await page.evaluate(type=>{const g=document.querySelector('[aria-label="Drag selected block"]')!;g.addEventListener('pointerdown',e=>{(window as any).trackedPointer=(e as PointerEvent).pointerId;if(type!=='mouse'){e.preventDefault();e.stopImmediatePropagation();}},{capture:true,once:true});},type);
 await page.mouse.move(p.x,p.y);await page.mouse.down();
 if(type!=='mouse')await page.evaluate(({p,type})=>{document.querySelector('[aria-label="Drag selected block"]')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,isPrimary:true,button:0,buttons:1,pointerId:(window as any).trackedPointer,pointerType:type,clientX:p.x,clientY:p.y}));},{p,type});
 assert.equal((await pointer(page)).captured,true);return p;
}
async function hover(page,index=2,edge=false) {const b=await page.locator('#projection > [data-node-id]').nth(index).boundingBox();assert.ok(b);const p={x:b.x+30,y:b.y+b.height*.7};if(edge){const r=await page.locator('#projection').boundingBox();p.y=r.y+r.height-4;}await page.mouse.move(p.x,p.y);await frames(page);return p;}
async function deliver(page,type,other=false) {return page.evaluate(({type,other})=>{const g=document.querySelector('[aria-label="Drag selected block"]')??(window as any).inputFixture.root;const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:!other,pointerId:(window as any).trackedPointer+(other?101:0),buttons:type==='pointerdown'?1:0});g.dispatchEvent(e);return {type,other,prevented:e.defaultPrevented};},{type,other});}
async function clean(page,baseline,fact) {await page.mouse.up();await page.evaluate(()=>(window as any).inputFixture.destroy());await frames(page);const after=await page.evaluate(()=>(window as any).mobileResources());fact.resources={baseline,after};assert.deepEqual(after,baseline);}
for(const terminal of ['pointercancel','lostpointercapture','blur','Escape','read-only','dispose'])test(`MBT-04 ${terminal} clears provisional handle/capture/frame without commit`,()=>probe(`MBT-04-${terminal}`,async(page,fact)=>{
 const baseline=await mount(page,30),before=await state(page,fact);await start(page);await hover(page,2,true);const provisional=await state(page);zero(before,provisional);assert.equal((await pointer(page)).active,true);assert.ok((await pointer(page)).scrollWrites>0);
 if(terminal==='read-only')await page.evaluate(()=>(window as any).inputFixture.surface.setReadOnly(true));
 else if(terminal==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 else if(terminal==='Escape')await page.keyboard.press('Escape');
 else if(terminal==='dispose')await page.evaluate(()=>(window as any).inputFixture.surface.reorder.dispose());
 else fact.trace=[await deliver(page,terminal)];
 const p=await pointer(page);assert.equal(p.captured,false);assert.equal(p.pendingFrame,false);assert.equal(p.retainedSelection,false);
 await deliver(page,'lostpointercapture');if(terminal!=='dispose')await grip(page).dispatchEvent('click');await page.mouse.up();
 zero(before,await state(page,fact));const stable=await pointer(page);await frames(page);assert.deepEqual(await pointer(page),stable);await clean(page,baseline,fact);
}));
for(const type of ['touch','mouse','pen'])test(`MBT-05/06 ${type} tracked success ignores unrelated lifecycle and duplicate click`,()=>probe(`MBT-05-${type}`,async(page,fact)=>{
 const baseline=await mount(page),before=await state(page,fact);await start(page,type);await hover(page);zero(before,await state(page));
 fact.trace=[];for(const event of ['pointermove','pointerup','pointercancel','lostpointercapture'])fact.trace.push(await deliver(page,event,true));
 assert.equal((await pointer(page)).active,true);await page.mouse.up();const after=await state(page,fact);one(before,after,[1,2,0]);
 await deliver(page,'lostpointercapture');await deliver(page,'pointerup');await grip(page).dispatchEvent('click');zero(after,await state(page,fact));
 assert.equal((await pointer(page)).captured,false);assert.equal((await pointer(page)).pendingFrame,false);await clean(page,baseline,fact);
}));
test('MBT-05 competing touch cancels for native pinch without preventing its action',()=>probe('MBT-05-multitouch',async(page,fact)=>{
 const baseline=await mount(page),before=await state(page,fact);await start(page);await hover(page);fact.trace=[await deliver(page,'pointerdown',true)];assert.equal(fact.trace[0].prevented,false);
 assert.equal((await pointer(page)).captured,false);await page.mouse.up();await grip(page).dispatchEvent('click');zero(before,await state(page,fact));await clean(page,baseline,fact);
}));
test('MBT-02 native backward marked selection survives unrelated remote patch and viewport change',()=>probe('MBT-02-remote',async(page,fact)=>{
 const baseline=await mount(page);await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[1],2,1,f.ids[0]);});const before=await state(page,fact);
 const selected=await page.evaluate(()=>getSelection()!.toString());
 fact.dom=await page.evaluate(async()=>{const f=(window as any).inputFixture,block=f.root.firstElementChild,node=block.firstChild;await f.remote(2,0,'peer ');return {blockPreserved:block===f.root.firstElementChild,textPreserved:node===block.firstChild,focus:document.activeElement===f.root};});
 await page.setViewportSize({width:740,height:390});await frames(page);const after=await state(page,fact);
 assert.equal(await page.evaluate(()=>getSelection()!.toString()),selected);assert.deepEqual(after.selection,before.selection);assert.deepEqual(after.nodes.slice(0,2),before.nodes.slice(0,2));assert.equal(after.nodes[2].runs.map(r=>r.text).join(''),'peer gamma');assert.equal(after.history.undoGroups,0);assert.equal(after.journal.length,1);assert.equal(after.patches.filter(p=>p.update).length,1);assert.deepEqual(fact.dom,{blockPreserved:true,textPreserved:true,focus:true});await clean(page,baseline,fact);
}));
test('MBT-01/03/06 native root events retain defaults and mapping without touch-only routing',()=>probe('MBT-01-native',async(page,fact)=>{
 const baseline=await mount(page),before=await state(page,fact);
 fact.native=await page.evaluate(()=>{const f=(window as any).inputFixture,events=[];for(const pointerType of ['touch','pen','mouse'])for(const type of ['pointerdown','pointermove','pointerup','contextmenu']){const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:77,pointerType,isPrimary:true,buttons:0});f.root.dispatchEvent(e);events.push({type,pointerType,prevented:e.defaultPrevented});}for(const type of ['touchstart','touchmove','wheel']){const e=new Event(type,{bubbles:true,cancelable:true});f.root.dispatchEvent(e);events.push({type,prevented:e.defaultPrevented});}const styles=[f.root,f.root.parentElement].map(e=>({touchAction:getComputedStyle(e).touchAction,userSelect:getComputedStyle(e).userSelect}));const offsets=[];for(const offset of [0,1,5,7]){const point={node:f.ids[0],offset,bias:'right'},dom=f.selection.toDOM(point);offsets.push(f.selection.toModel(dom.node,dom.offset));}return {events,styles,offsets};});
 assert.ok(fact.native.events.every(e=>!e.prevented));assert.ok(fact.native.styles.every(s=>s.touchAction==='auto'&&s.userSelect!=='none'));assert.deepEqual(fact.native.offsets.map(p=>p.offset),[0,1,5,7]);zero(before,await state(page,fact));await clean(page,baseline,fact);
}));
for(const route of ['tap','keyboard'])test(`MBT-07/XFR-07 ${route} alternative retains selection with sized named controls`,()=>probe(`MBT-07-${route}`,async(page,fact)=>{
 const baseline=await mount(page),before=await state(page,fact);await page.emulateMedia({forcedColors:'active'});await page.evaluate(()=>{document.body.style.fontSize='28px';});
 fact.targets=await page.getByRole('group',{name:'Reorder block'}).getByRole('button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return {name:b.getAttribute('aria-label')??b.textContent,type:(b as HTMLButtonElement).type,width:r.width,height:r.height};}));assert.equal(fact.targets.length,3);assert.ok(fact.targets.every(b=>b.name&&b.type==='button'&&b.width>=44&&b.height>=44));
 if(route==='tap'){const b=await page.getByRole('button',{name:'Move block down',exact:true}).boundingBox();await page.touchscreen.tap(b.x+b.width/2,b.y+b.height/2);}else{await page.locator('#projection').press('Escape');await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Move block up',exact:true}).evaluate(b=>b===document.activeElement&&b.matches(':focus-visible')&&getComputedStyle(b).outlineStyle!=='none'),true);await page.keyboard.press('Tab');await page.keyboard.press('Enter');}
 one(before,await state(page,fact),[1,0,2]);await clean(page,baseline,fact);
}));
test('MBT-01 empty/filler, trailing hard break and registered inline atom map only logical boundaries',()=>probe('MBT-01-boundaries',async(page,fact)=>{
 await page.waitForFunction(()=>!!(window as any).inputFixture);const baseline=await page.evaluate(()=>(window as any).mobileResources());
 await page.evaluate(()=>(window as any).inputFixture.mount({nodes:['alpha😀','beta','gamma','','tail','atom'].map(text=>({text})),reorder:true,mapping:true}));const before=await state(page,fact);
 fact.mapping=await page.evaluate(()=>{const f=(window as any).inputFixture,offsets=[];for(const [index,values] of [[3,[0]],[4,[0,4,5]],[5,[0,4]]] as any){for(const offset of values){const point={node:f.ids[index],offset,bias:'right'},dom=f.selection.toDOM(point),model=dom&&f.selection.toModel(dom.node,dom.offset);offsets.push({index,offset,model});}}const atom=f.root.querySelector('[data-module-type="fixture.atom"]');return {offsets,atom:atom?.contentEditable,interior:f.selection.toModel(atom.firstChild,1),breaks:f.root.querySelectorAll('br').length};});
 assert.equal(fact.mapping.atom,'false');assert.equal(fact.mapping.interior,undefined);assert.ok(fact.mapping.breaks>=2);for(const row of fact.mapping.offsets){assert.equal(row.model?.node,before.nodes[row.index].id);assert.equal(row.model?.offset,row.offset);}zero(before,await state(page,fact));await clean(page,baseline,fact);
}));
for(const drag of [false,true])test(`SEL-06 native selected-text arbitration drag=${drag}`,()=>probe(`SEL-06-${drag}`,async(page,fact)=>{
 const baseline=await mount(page);await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],1,4);});const before=await state(page,fact);
 const point=await page.evaluate(()=>{const f=(window as any).inputFixture,p=f.selection.toDOM({node:f.ids[0],offset:2,bias:'right'}),r=document.createRange();r.setStart(p.node,p.offset);r.setEnd(p.node,p.offset+1);const b=r.getBoundingClientRect();return {x:b.x+1,y:b.y+b.height/2};});await page.mouse.move(point.x,point.y);await page.mouse.down();
 assert.equal(await page.evaluate(()=>(window as any).inputFixture.selection.pointer.state.textDrag),true);
 if(drag){await page.mouse.move(point.x+20,point.y,{steps:5});assert.equal(await page.evaluate(()=>getSelection()!.toString()),'lph');await page.keyboard.press('Escape');}
 await page.mouse.up();if(!drag)assert.equal(await page.evaluate(()=>getSelection()!.isCollapsed),true);zero(before,await state(page,fact),false);await clean(page,baseline,fact);
}));
for(const terminal of ['pointercancel','blur','dispose'])test(`SEL-07 nested transformed scroll/unmounted endpoint stops on ${terminal}`,()=>probe(`SEL-07-${terminal}`,async(page,fact)=>{
 const baseline=await mount(page,30);await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],1);const renderer=f.selection.renderer,blocks=f.ids.map(id=>renderer.getBlock(id)),stubs=[];renderer.patchBoundary.before();try{blocks.forEach((b,i)=>{b.dataset.pointerIndex=String(i);if(i>1){const stub=document.createElement('div');stub.style.height='28px';stub.dataset.pointerIndex=String(i);b.replaceWith(stub);stubs[i]=stub;}});}finally{renderer.patchBoundary.after();}f.root.style.height='168px';f.root.style.overflow='auto';f.root.parentElement.style.transform='scale(.9)';f.root.parentElement.style.transformOrigin='top left';(window as any).hostReveals=0;f.selection.pointer.viewport={hitTest(x,y){const rect=f.root.getBoundingClientRect(),hit=document.elementFromPoint(Math.max(rect.left+2,Math.min(x,rect.right-2)),Math.max(rect.top+2,Math.min(y,rect.bottom-2)))?.closest('[data-pointer-index]');return hit?{node:f.ids[Number((hit as HTMLElement).dataset.pointerIndex)],offset:2,bias:'right'}:undefined;},reveal(p){const i=f.ids.indexOf(p.node);if(stubs[i]?.isConnected){renderer.patchBoundary.before();try{stubs[i].replaceWith(blocks[i]);(window as any).hostReveals++;}finally{renderer.patchBoundary.after();}}}};f.root.addEventListener('pointerdown',e=>(window as any).selectionPointer=e.pointerId,{once:true});});
 const before=await state(page,fact);const p=await page.evaluate(()=>{const f=(window as any).inputFixture,d=f.selection.toDOM({node:f.ids[0],offset:1,bias:'right'}),r=document.createRange();r.setStart(d.node,d.offset);r.setEnd(d.node,d.offset+1);const b=r.getBoundingClientRect(),root=f.root.getBoundingClientRect();return {x:b.x+1,y:b.y+b.height/2,edge:root.bottom-2};});await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+20,p.edge,{steps:5});await page.waitForFunction(()=>(window as any).hostReveals>0);const during=await state(page,fact);zero(before,during,false);assert.ok(during.selection.focus.node!==before.nodes[0].id);
 if(terminal==='blur')await page.locator('#host-control').focus();else if(terminal==='dispose')await page.evaluate(()=>(window as any).inputFixture.selection.pointer.dispose());else await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:(window as any).selectionPointer})));
 // Complete native mouse arbitration after the prepared terminal delivery.
 await page.mouse.up();
 const stopped=await page.evaluate(()=>({pointer:(window as any).inputFixture.selection.pointer.state,focus:document.activeElement!.id,selection:getSelection()!.toString(),scroll:(window as any).inputFixture.root.scrollTop}));await frames(page);assert.deepEqual(await page.evaluate(()=>({pointer:(window as any).inputFixture.selection.pointer.state,focus:document.activeElement!.id,selection:getSelection()!.toString(),scroll:(window as any).inputFixture.root.scrollTop})),stopped);assert.equal(stopped.pointer.active,false);assert.equal(stopped.pointer.pendingFrame,false);await page.mouse.up();zero(before,await state(page,fact),false);await clean(page,baseline,fact);
}));
test('MBT-06 same-session touch/mouse/pen changes keep native input and control routes available',()=>probe('MBT-06-mixed',async(page,fact)=>{
 const baseline=await mount(page),before=await state(page,fact);fact.hints=await page.evaluate(()=>({coarse:matchMedia('(any-pointer:coarse)').matches,fine:matchMedia('(any-pointer:fine)').matches,touchPoints:navigator.maxTouchPoints}));
 for(const type of ['touch','mouse','pen','touch']){await start(page,type);await page.mouse.up();assert.equal((await pointer(page)).captured,false);assert.equal((await pointer(page)).pendingFrame,false);zero(before,await state(page));}
 await page.locator('#projection').press('Alt+ArrowDown');one(before,await state(page,fact),[1,0,2]);await clean(page,baseline,fact);
}));
test('MBT-04/05 burst hover coalesces without semantic writes and cancellation leaves no recurring frames',()=>probe('MBT-04-bounded',async(page,fact)=>{
 const baseline=await mount(page,30),before=await state(page,fact);await start(page);const b=await page.locator('#projection > [data-node-id]').nth(2).boundingBox();
 await page.evaluate(b=>{const g=document.querySelector('[aria-label="Drag selected block"]')!;for(let i=0;i<500;i++)g.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,isPrimary:true,pointerId:(window as any).trackedPointer,pointerType:'touch',buttons:1,clientX:b.x+30,clientY:b.y+b.height*.7}));},b);await frames(page);fact.work=await pointer(page);assert.equal(fact.work.frames,1);assert.equal(fact.work.hitTests,1);assert.ok(fact.work.geometryReads<=2);zero(before,await state(page));await deliver(page,'pointercancel');await page.mouse.up();await frames(page);assert.equal((await pointer(page)).frames,fact.work.frames);zero(before,await state(page,fact));await clean(page,baseline,fact);
}));
test('XFR-07 owned autoscroll refreshes a real mapped destination and commits a single move',()=>probe('XFR-07-autoscroll-drop',async(page,fact)=>{
 const baseline=await mount(page,30),before=await state(page,fact);await start(page);await hover(page,2,true);await page.waitForFunction(()=>(window as any).inputFixture.pointer.scrollWrites>=2);
 // Move back to a stable visible destination after the owned scroll. The
 // drop still revalidates its engine identity/version against current geometry.
 const target=await page.evaluate(()=>{const f=(window as any).inputFixture,r=f.root.getBoundingClientRect(),blocks=[...f.root.querySelectorAll(':scope > [data-node-id]')];const i=blocks.findIndex((b:Element)=>{const d=b.getBoundingClientRect();return d.top>r.top+30&&d.bottom<r.bottom-30;});const b=blocks[i].getBoundingClientRect();return {index:i,x:b.x+30,y:b.y+b.height*.7};});assert.ok(target.index>0);await page.mouse.move(target.x,target.y);await frames(page);zero(before,await state(page));await page.mouse.up();const order=Array.from({length:30},(_,i)=>i);order.splice(0,1);order.splice(target.index,0,0);one(before,await state(page,fact),order);assert.equal((await pointer(page)).pendingFrame,false);assert.equal((await pointer(page)).captured,false);await clean(page,baseline,fact);
}));
