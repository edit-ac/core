import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const webPackage = JSON.parse(readFileSync('packages/web/package.json','utf8'));
assert.equal(webPackage.exports['./editor'].import,'./dist/editor.js');
import { browserHarness } from '../browser/browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installResourceCounters } from './resources.mjs';

const { probe, facts } = browserHarness('mobile-harness', 'fixtures/browser-mobile-web', {
  autoMount: false, testFile: 'tests/mobile-web/modules.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true },
  serverOptions: { recordRequests: true }, beforeNavigate: async page => page.addInitScript(installResourceCounters),
  sourcePaths: [...browserInputSources, ...['editor','surface','platform/viewport','dom/render','input/text','modules/slash','modules/references','modules/content','extensions/code','modules/reorder','ui/commands'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`]),
    'fixtures/browser-mobile-web/session.mjs','fixtures/browser-mobile-web/index.html','tests/mobile-web/modules.spec.ts','tests/mobile-web/resources.mjs','tests/mobile-web/catalog.mjs','tests/mobile-web/case-index.json','scripts/test-mobile-web.mjs','packages/web/package.json','../architecture/specs/mobile-web.md','../architecture/tests/mobile-web-cases.md'],
});
facts.binding = { gate: 'MWF-1.8', ids: ['MBX-01','MBX-02','MBX-03','MBX-04','MBX-05'],
  provenance: 'prepared touch/native-menu overlap/keyboard geometry through packed production BrowserEditor/recovered Session/Rust-WASM/IndexedDB; actual mobile scrolling/native menu/IME/AT and performance remain original MWB predicates' };
const text = s => s.nodes.filter(n => n.kind === 'block').map(n => n.runs.map(r => r.text).join(''));
const mutations = s => s.patches.filter(p => p.update).length;
function unchanged(a, b) { for (const key of ['nodes','history','patches','journal']) assert.deepEqual(b[key], a[key], key); }
async function frame(page) { await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); }
async function mount(page, options: any = {}, offset = 2) {
  await page.waitForFunction(() => !!(window as any).inputFixture);
  const baseline = await page.evaluate(() => (window as any).mobileResources());
  await page.evaluate(async ({ options, offset }) => {
    const w = window as any, f = w.inputFixture;
    w.mobileGeometry = { visual: { left: 0, top: 0, width: 390, height: 360 }, scale: 1, occlusions: [{left:0,top:260,width:390,height:100}] };
    await f.mount({text:'alpha',baselineModules:true,commandControls:true,viewport:true,...options});
    f.select(f.ids[0],offset); await f.settle();
  }, { options, offset });
  await frame(page); return baseline;
}
async function state(page, fact) { const s = await page.evaluate(() => (window as any).inputFixture.state()); assert.deepEqual(s.errors, []); assert.equal(s.storage, 'localCommitted'); fact.snapshots.push(s); return s; }
async function open(page) { await page.evaluate(() => { const s = (window as any).inputFixture.surface.slash; s.control.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,cancelable:true,pointerType:'touch',pointerId:81})); s.control.click(); }); await frame(page); assert.equal(await page.evaluate(() => (window as any).inputFixture.surface.slash.open), true); }
async function activate(page, id) { await page.evaluate(id => { const b = (window as any).inputFixture.surface.slash.menu.querySelector(`[data-command="${id}"]`); b.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,cancelable:true,pointerType:'touch',pointerId:81})); b.click(); }, id); await frame(page); }
async function finish(page, baseline, fact) {
  await page.evaluate(async () => { const w = window as any; await w.second?.dispose(); await w.inputFixture.destroy(); }); await frame(page);
  const after = await page.evaluate(() => (window as any).mobileResources()); fact.resources = {baseline,after}; assert.deepEqual(after, baseline);
}
async function bounded(page) {
  const b = await page.evaluate(() => {const f=(window as any).inputFixture, m=f.surface.slash.menu, r=m.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,overflow:getComputedStyle(m).overflowY,maxHeight:m.style.maxHeight};});
  assert.ok(b.left>=-1 && b.top>=-1 && b.right<=391 && b.bottom<=261, JSON.stringify(b)); assert.equal(b.overflow,'auto'); return b;
}

test('MBX-01 visible touch invocation requires no slash text and commits existing code semantics once', () => probe('MBX-01-visible', async (page, fact) => {
  const baseline=await mount(page); const before=await state(page,fact); await open(page); unchanged(before,await state(page,fact)); fact.bounds=await bounded(page);
  await activate(page,'code'); const after=await state(page,fact); assert.deepEqual(text(after),['alpha']); assert.deepEqual(after.nodes[0].blockAttributes,['code','js']);
  assert.equal(mutations(after),1); assert.equal(after.history.undoGroups,1); assert.equal(after.journal.length,1); assert.equal(after.focus,true); assert.equal(after.selection.focus.offset,2);
  await page.evaluate(()=>{const f=(window as any).inputFixture;const c=f.surface.captureCommand('undo');try{c?.execute();}finally{c?.dispose();}}); const undone=await state(page,fact); assert.deepEqual(undone.nodes,before.nodes);
  await finish(page,baseline,fact);
}));

test('MBX-01 visible invocation replaces a literal slash query through the same fragment command', () => probe('MBX-01-literal',async(page,fact)=>{
  const baseline=await mount(page,{text:'/insert'},7);await open(page);assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.slash.query),'insert');await activate(page,'insert');const s=await state(page,fact);assert.deepEqual(text(s),['mobile']);assert.equal(s.history.undoGroups,1);assert.equal(mutations(s),1);await finish(page,baseline,fact);
}));

test('MBX-01 keyboard invocation and cancellation keep the literal caret and content',()=>probe('MBX-01-keyboard',async(page,fact)=>{
  const baseline=await mount(page,{commandControls:false});const before=await state(page,fact);await page.keyboard.press('Tab');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.slash.open),true);await page.keyboard.press('Escape');const s=await state(page,fact);unchanged(before,s);assert.equal(s.focus,true);assert.equal(s.selection.focus.offset,2);await finish(page,baseline,fact);
}));

for(const mode of ['resizes-visual','overlays-content'])test(`MBX-01/05 ${mode} panel opens after idle geometry, rotates and dismisses by tap`,()=>probe('MBX-01-'+mode,async(page,fact)=>{
  const baseline=await mount(page,{requestedMode:mode});const before=await state(page,fact);await open(page);await bounded(page);
  await page.evaluate(()=>{const w=window as any;w.mobileGeometry={visual:{left:0,top:0,width:390,height:220},scale:1};window.dispatchEvent(new Event('resize'));});await frame(page);
  const bounds=await page.evaluate(()=>{const m=(window as any).inputFixture.surface.slash.menu,r=m.getBoundingClientRect();return {bottom:r.bottom,maxHeight:m.style.maxHeight};});fact.rotatedBounds=bounds;assert.ok(bounds.bottom<=221);assert.equal(bounds.maxHeight,'220px');
  await page.getByRole('menuitem',{name:'Close commands',exact:true}).click();const after=await state(page,fact);unchanged(before,after);assert.equal(after.focus,true);assert.equal(after.selection.focus.offset,2);await finish(page,baseline,fact);
}));

test('MBX-02 prepared native-menu overlap retains native contextmenu and alternate formatting route',()=>probe('MBX-02-native-menu-fallback',async(page,fact)=>{
  const baseline=await mount(page);await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],4,1);});const before=await state(page,fact);
  const native=await page.evaluate(()=>{const f=(window as any).inputFixture,e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});f.root.dispatchEvent(e);return {prevented:e.defaultPrevented,userSelect:getComputedStyle(f.root).userSelect,touchAction:getComputedStyle(f.root).touchAction};});fact.nativeMenu=native;assert.equal(native.prevented,false);assert.notEqual(native.userSelect,'none');assert.equal(native.touchAction,'auto');
  await page.evaluate(()=>{const w=window as any,f=w.inputFixture;w.mobileGeometry.occlusions=[{left:0,top:80,width:390,height:180}];f.surface.viewport.invalidate();});await frame(page);
  await page.evaluate(()=>{const b=(window as any).inputFixture.surface.commandControls.element.querySelector('[data-command="bold"]');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));b.click();});
  const after=await state(page,fact);assert.deepEqual(text(after),['alpha']);assert.deepEqual(after.nodes[0].runs.map(r=>[r.text,!!r.attributes.bold]),[['a',false],['lph',true],['a',false]]);assert.equal(after.selection.anchor.offset,4);assert.equal(after.selection.focus.offset,1);assert.equal(after.history.undoGroups,1);assert.equal(mutations(after),1);assert.equal(before.journal.length,0);await finish(page,baseline,fact);
}));

for(const cancel of ['host-focus','readonly','composition','remote','pagehide','dispose'])test(`MBX-01/05 pending module action cancels on ${cancel}`,()=>probe('MBX-cancel-'+cancel,async(page,fact)=>{
  const baseline=await mount(page);await open(page);await activate(page,'delayed');const before=await state(page,fact);
  await page.evaluate(async cancel=>{const w=window as any,f=w.inputFixture;
    if(cancel==='host-focus')document.querySelector<HTMLButtonElement>('#host-control')!.focus();
    if(cancel==='readonly')f.surface.setReadOnly(true);
    if(cancel==='composition')f.deliver('compositionstart',{data:''});
    if(cancel==='remote')await f.remote(0,0,'peer ');
    if(cancel==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
    if(cancel==='dispose')await f.destroy();
    w.modulePending.resolve({type:'fragment',blocks:[{attributes:{type:'paragraph'},runs:[{text:'STALE',marks:[]}]}]});
  },cancel);await frame(page);
  assert.equal(await page.evaluate(()=>(window as any).modulePending.signal.aborted),true);
  if(cancel!=='dispose'){const s=await state(page,fact);if(cancel==='remote'){assert.deepEqual(text(s),['peer alpha']);assert.equal(s.journal.length,1);assert.equal(s.patches.filter(p=>p.update&&p.origin.startsWith('editac:local:')).length,0);}else unchanged(before,s);
    if(cancel==='host-focus')assert.equal(await page.locator('#host-control').evaluate(e=>e===document.activeElement),true);}
  await finish(page,baseline,fact);
}));

test('MBX-05 accessible names, disabled state, active focus and tap cancellation are explicit',()=>probe('MBX-05-accessibility-mechanics',async(page,fact)=>{
  const baseline=await mount(page);const before=await state(page,fact);await open(page);
  const names=await page.evaluate(()=>{const s=(window as any).inputFixture.surface.slash;return {label:s.menu.getAttribute('aria-label'),expanded:s.control.getAttribute('aria-expanded'),controls:s.control.getAttribute('aria-controls'),menuId:s.menu.id,focused:s.menu.contains(document.activeElement),disabled:s.menu.querySelector('[data-command="disabled"]').getAttribute('aria-disabled'),named:[...s.menu.querySelectorAll('[role="menuitem"]')].every(b=>!!b.textContent.trim())};});fact.accessibility=names;assert.equal(names.label,'Slash commands');assert.equal(names.expanded,'true');assert.equal(names.controls,names.menuId);assert.equal(names.focused,true);assert.equal(names.named,true);assert.equal(names.disabled,'true');
  await activate(page,'disabled');unchanged(before,await state(page,fact));await page.getByRole('menuitem',{name:'Close commands',exact:true}).click();unchanged(before,await state(page,fact));await finish(page,baseline,fact);
}));

test('MBX-03 code horizontal scrolling and page vertical scrolling retain caret/marks/history',()=>probe('MBX-03-code-scroll',async(page,fact)=>{
  const baseline=await mount(page,{text:'const longName = '+ 'x'.repeat(160),code:true,codeTools:true,baselineModules:false});const before=await state(page,fact);
  const scrolling=await page.evaluate(()=>{const f=(window as any).inputFixture,pre=f.root.querySelector('pre'),host=document.querySelector('#scroll-root');pre.scrollLeft=120;host.scrollTop=100;const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});pre.dispatchEvent(e);return {left:pre.scrollLeft,top:host.scrollTop,overflow:getComputedStyle(pre).overflowX,prevented:e.defaultPrevented};});fact.scrolling=scrolling;assert.ok(scrolling.left>0);assert.ok(scrolling.top>0);assert.equal(scrolling.overflow,'auto');assert.equal(scrolling.prevented,false);unchanged(before,await state(page,fact));await finish(page,baseline,fact);
}));

test('MBX-03 code tap command retains selected range and exactly one semantic undo group',()=>probe('MBX-03-code-command',async(page,fact)=>{
  const baseline=await mount(page,{text:'a\nb',code:true,codeTools:true,baselineModules:false});await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],3,0);});await page.getByRole('button',{name:'Indent code lines',exact:true}).click();const s=await state(page,fact);assert.deepEqual(text(s),['  a\n  b']);assert.equal(mutations(s),1);assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);assert.equal(s.focus,true);await finish(page,baseline,fact);
}));

test('MBX-03 table horizontal scrolling coexists with page scrolling and native cell commands',()=>probe('MBX-03-table-scroll',async(page,fact)=>{
  const baseline=await mount(page,{text:'',table:true,baselineModules:false});const before=await state(page,fact);
  const scrolling=await page.evaluate(()=>{const f=(window as any).inputFixture,t=f.root.querySelector('[data-content-module="table"] [data-table-scroll]'),host=document.querySelector('#scroll-root');t.scrollLeft=150;host.scrollTop=100;return {left:t.scrollLeft,top:host.scrollTop,overflow:getComputedStyle(t).overflowX,touch:getComputedStyle(t).touchAction};});fact.scrolling=scrolling;assert.ok(scrolling.left>0);assert.ok(scrolling.top>0);assert.equal(scrolling.overflow,'auto');assert.equal(scrolling.touch,'auto');unchanged(before,await state(page,fact));
  await page.getByRole('textbox',{name:'Table row 2 column 1',exact:true}).fill('edited😀');const after=await state(page,fact),t=after.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');assert.equal(t.blockAttributes[2].rows[1][0][0][0],'edited😀');assert.equal(mutations(after),1);assert.equal(after.history.undoGroups,1);assert.equal(after.journal.length,1);await finish(page,baseline,fact);
}));

test('MBX-04 baseline block actions work with enhanced module presenters absent',()=>probe('MBX-04-disabled',async(page,fact)=>{
  const baseline=await mount(page,{baselineModules:false});await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],2);});
  await page.evaluate(()=>{const b=(window as any).inputFixture.surface.commandControls.element.querySelector('[data-command="enter"]');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));b.click();});const s=await state(page,fact);assert.deepEqual(text(s),['al','pha']);assert.equal(mutations(s),1);assert.equal(s.history.undoGroups,1);
  const imports=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>new URL(e.name).pathname).filter(p=>/\/(modules\/((?:slash|references|content|reorder)\.js|code\/|images\/|embeds\/|attachments\/)|platform\/(capabilities|keyboard)|web\/extensions\/code|markdown\/)/.test(p)));fact.optionalImports=imports;assert.deepEqual(imports,[]); // Pure command metadata is allowed; optional presenters must remain unloaded.
  assert.equal(await page.locator('[role="menu"]').count(),0);await finish(page,baseline,fact);
}));

test('MBX-04 native editing stays usable with all command presenters disabled',()=>probe('MBX-04-native-input',async(page,fact)=>{
  const baseline=await mount(page,{baselineModules:false,commandControls:false});await page.keyboard.insertText('😀');const s=await state(page,fact);assert.deepEqual(text(s),['al😀pha']);assert.equal(mutations(s),1);assert.equal(s.history.undoGroups,1);assert.equal(await page.locator('[role=menu],[aria-label="Editing commands"]').count(),0);assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.commandControls===undefined),true);await finish(page,baseline,fact);
}));

test('MBX-04 two editor focus cancels first menu without cross-owner viewport teardown',()=>probe('MBX-04-two-editors',async(page,fact)=>{
  const baseline=await mount(page);await open(page);await activate(page,'delayed');await page.evaluate(async()=>{const w=window as any;w.second=await w.inputFixture.sibling();w.second.root.focus();});await frame(page);assert.equal(await page.evaluate(()=>(window as any).modulePending.signal.aborted),true);
  await page.evaluate(async()=>{const w=window as any;await w.inputFixture.destroy();w.modulePending.resolve(undefined);w.mobileGeometry.visual.height=200;window.dispatchEvent(new Event('resize'));});await frame(page);
  const s=await page.evaluate(()=>{const w=window as any;return {ready:w.second.editor.state,viewport:w.second.editor.viewport.state,focus:document.activeElement===w.second.root};});fact.second=s;assert.equal(s.viewport.consumers,1);assert.equal(s.viewport.disposed,false);assert.equal(s.focus,true);await finish(page,baseline,fact);
}));


test('MBX-04 disabled table presenter preserves inert source and ordinary native input',()=>probe('MBX-04-table-disabled',async(page,fact)=>{
  const baseline=await mount(page,{text:'alpha',table:true,presentersDisabled:true,baselineModules:false,commandControls:false});const before=await state(page,fact),table=before.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');assert.ok(table);
  await page.evaluate(()=>{const f=(window as any).inputFixture,n=f.engine.read().visible.find(n=>n.kind==='block'&&n.blockAttributes?.[0]==='paragraph'&&n.runs.some(r=>r.text==='alpha'));f.select(n.id,2);});await page.keyboard.insertText('X');const after=await state(page,fact);assert.deepEqual(after.nodes.find(n=>n.id===table.id),table);assert.ok(text(after).includes('alXpha'));assert.equal(mutations(after),1);assert.equal(after.history.undoGroups,1);
  const imports=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>new URL(e.name).pathname).filter(p=>/\/modules\/(content|images\/|embeds\/|attachments\/)/.test(p)));fact.optionalImports=imports;assert.deepEqual(imports,[]); // Pure command metadata is allowed; optional presenters must remain unloaded.
  assert.equal(await page.locator('[data-content-module]').count(),0);await finish(page,baseline,fact);
}));

test('MBX-01 composition already active cannot open the explicit module menu',()=>probe('MBX-01-composing',async(page,fact)=>{
  const baseline=await mount(page);const before=await state(page,fact);await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionstart',{data:''});f.surface.slash.openExplicit();});assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.slash.open),false);unchanged(before,await state(page,fact));await finish(page,baseline,fact);
}));


async function openReferences(page){await page.evaluate(()=>{const r=(window as any).inputFixture.surface.references;r.control.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));r.control.click();});await page.getByRole('menuitem',{name:'Mobile target',exact:true}).waitFor();await frame(page);}

test('MBX-01/05 reference suggestions share bounded geometry and cancel to the backward range',()=>probe('MBX-reference-cancel',async(page,fact)=>{
  const baseline=await mount(page,{references:true,baselineModules:false});await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],4,1);});const before=await state(page,fact);await openReferences(page);
  const bounds=await page.evaluate(()=>{const r=(window as any).inputFixture.surface.references.menu.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};});fact.referenceBounds=bounds;assert.ok(bounds.left>=0&&bounds.top>=0&&bounds.right<=391&&bounds.bottom<=261);await page.getByRole('button',{name:'Close references',exact:true}).click();const after=await state(page,fact);unchanged(before,after);assert.deepEqual(after.selection,before.selection);assert.equal(after.focus,true);await finish(page,baseline,fact);
}));

test('MBX-01 reference activation uses existing prepared fragment semantics once',()=>probe('MBX-reference-command',async(page,fact)=>{
  const baseline=await mount(page,{references:true,baselineModules:false});await openReferences(page);await page.getByRole('menuitem',{name:'Mobile target',exact:true}).click();const s=await state(page,fact);assert.deepEqual(text(s),['al','Mobile target','pha']);assert.equal(mutations(s),1);assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);const node=s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.reference');assert.equal(node.blockAttributes[2].label,'Mobile target');assert.equal(s.focus,true);await finish(page,baseline,fact);
}));

test('MBX-05 active composition retains ownership over reference invocation',()=>probe('MBX-reference-composing',async(page,fact)=>{
  const baseline=await mount(page,{references:true,baselineModules:false});const before=await state(page,fact);await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionstart',{data:''});f.surface.references.openExplicit();});assert.equal(await page.evaluate(()=>(window as any).inputFixture.surface.references.open),false);unchanged(before,await state(page,fact));await finish(page,baseline,fact);
}));
