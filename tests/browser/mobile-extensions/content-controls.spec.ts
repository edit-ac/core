import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';
import { browserInputSources } from '../../editing/browser-driver.ts';
import { installExtensionCounters } from './resources.mjs';
import { installResourceCounters } from '../../mobile-web/resources.mjs';

const { probe, facts } = browserHarness('mobile-extensions', 'fixtures/browser-mobile-extensions', {
  autoMount: false, markdown: true, testFile: 'tests/browser/mobile-extensions/content-controls.spec.ts', assertSourcesUnchanged: true,
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
    'tests/browser/mobile-extensions/content-controls.spec.ts','fixtures/code-commands/cases.json','packages/web/src/modules/content.ts','packages/web/dist/modules/content.js','packages/core/src/engine.ts','packages/core/dist/engine.js','packages/markdown/src/index.ts','packages/markdown/dist/index.js','packages/web/src/modules/code/presenter.ts','packages/web/src/modules/code/scheduler.ts', 'tests/browser/mobile-extensions/content-host-matrix.ts', 'tests/browser/mobile-extensions/command-matrix.ts', 'tests/browser/mobile-extensions/command-inventory.mjs',
    'fixtures/rich-content/asset-descriptors.json', 'packages/core/src/extensions/profiles.ts', 'packages/web/src/commands/catalog.ts',
    ...['modules/images/presenter','modules/attachments/presenter','modules/embeds/presenter','modules/content','modules/reorder','modules/search','modules/references','modules/slash','extensions/code'].flatMap(n=>[`packages/web/src/${n}.ts`,`packages/web/dist/${n}.js`]),
    'tests/browser/mobile-extensions/index.mjs', 'tests/browser/mobile-extensions/case-index.json',
    'tests/mobile-web/resources.mjs', 'tests/browser/mobile-extensions/resources.mjs', 'scripts/test-mobile-extensions.mjs', 'packages/web/package.json',
    '../architecture/tests/mobile-extension-cases.md', '../architecture/specs/mobile-web.md',
    ...['editor', 'surface', 'extensions/configuration', 'extensions/contract', 'platform/viewport'].flatMap(n => [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`])],
});
facts.binding = { gate: 'MEX-1.3', ids: ['MWX-C09','MWX-C10','MWX-C11','MWX-C12'],
  platform: 'production desktop browser with prepared mobile viewport/touch/composition; original MWX-1.8 pending',
  targetRule: '44 CSS px minimum width and height for each named action',
  semantics: 'real BrowserEditor/Session/WASM/IndexedDB; hand-authored host and geometry only',
  unfinishedCriteria: ['Original device/OS/IME/AT/performance/budget/release qualification remains pending'] };
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
async function state(page) { return page.evaluate(() => (window as any).inputFixture.state()); }
const text = s => s.nodes.map(n=>n.runs.map(r=>r.text).join('')).join('\n');
async function tap(page,name) { await page.getByRole('button',{name,exact:true}).first().tap();await frame(page); }
async function undo(page) { await page.evaluate(()=>{const f=(window as any).inputFixture;f.root.focus();const c=f.surface.captureCommand('undo');if(!c)throw Error('Undo unavailable');try{c.execute();}finally{c.dispose();}});await frame(page); }
async function select(page,a,b=a) { await page.evaluate(([a,b])=>{const f=(window as any).inputFixture;f.select(f.ids[0],a,b);},[a,b]);await frame(page); }
async function targets(page,selector) { return page.locator(selector).evaluateAll(es=>es.filter((e:HTMLElement)=>!e.hidden).map((e:HTMLElement)=>{const r=e.getBoundingClientRect();return {name:e.textContent||e.getAttribute('aria-label'),width:r.width,height:r.height};})); }
const labels={moveUp:'Move code lines up',moveDown:'Move code lines down',duplicate:'Duplicate code lines',indent:'Indent code lines',outdent:'Outdent code lines',surround:'Surround code selection',comment:'Toggle code comments'};
const {readFile}=await import('node:fs/promises');
const corpus=JSON.parse(await readFile(new URL('../../../fixtures/code-commands/cases.json',import.meta.url),'utf8'));
for(const c of corpus.cases)test(`MWX-C09 touch ${c.id}`,()=>probe(`MWX-C09-${c.id}`,async(page,fact)=>{
 const baseline=await mount(page,{code:true,codeTools:true,text:c.text,language:c.language}),before=await state(page);await select(page,c.a,c.f);
 fact.targets=await targets(page,'[data-code-commands] button');for(const t of fact.targets)assert.ok(t.width>=44&&t.height>=44,JSON.stringify(t));
 await tap(page,labels[c.action]);const after=await state(page);assert.equal(text(after),c.expected);assert.equal(after.history.undoGroups,c.expected===c.text?0:1);
 assert.deepEqual([after.selection.anchor?.offset,after.selection.focus?.offset],c.selection);
 if(c.expected!==c.text){await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);}
 fact.snapshots.push({before,after});await finish(page,baseline,fact);
}));
for(const mode of ['absent','disabled','over-budget','enabled'])test(`MWX-C09 ${mode} highlighting retains literal Unicode selection and input`,()=>probe(`MWX-C09-fallback-${mode}`,async(page,fact)=>{
 const source=mode==='over-budget'?'x'.repeat(102401):'const اسم = "😀 é";\n\tend  ';
 const baseline=await mount(page,{text:source,code:true,codeTools:true,highlight:mode==='absent'?undefined:mode==='disabled'?'disabled':'enabled'}),before=await state(page);
 assert.equal(text(before),source);await select(page,0,4);assert.equal(await page.evaluate(()=>getSelection()?.toString()),source.slice(0,4));
 const counts=await page.evaluate(()=>(window as any).highlightCounters);assert.equal(counts.requests.length,mode==='enabled'?1:0);
 fact.highlight={counts,state:await page.locator('pre').getAttribute('data-highlight-state')};
 await select(page,source.length);await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('beforeinput',{inputType:'insertText',data:'!',cancelable:true});});
 const after=await state(page);assert.equal(text(after),source+'!');assert.equal(after.history.undoGroups,1);await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);
 await finish(page,baseline,fact);const released=await page.evaluate(()=>(window as any).highlightCounters);assert.equal(released.terminated,released.created);
}));
const rows=[['שם 😀','é','한글','العربية'],['left','中','right','last']];
const table=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');
for(const label of ['Insert row before','Insert row after','Remove rows','Insert column before','Insert column after','Remove columns','Header cells','Body cells','Align cells none','Align cells left','Align cells center','Align cells right','Bold cells','Italic cells','Underline cells','Code cells','Heading 2 cells'])test(`MWX-C10 ${label} uses owning semantics and one undo`,()=>probe(`MWX-C10-${label.replaceAll(' ','-')}`,async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableRows:rows}),before=await state(page);
 await tap(page,'Select cell row 2 column 2');await tap(page,label);const after=await state(page),a=table(after).blockAttributes[2];
 // Alignment none is a legitimate unchanged boundary; all accepted changes are one group.
 const changed=JSON.stringify(before.nodes)!==JSON.stringify(after.nodes);assert.equal(after.history.undoGroups,1,'one accepted owning command, including semantic no-op, forms one group');
 if(label.startsWith('Insert row'))assert.equal(a.rows.length,3);if(label==='Remove rows')assert.equal(a.rows.length,1);
 if(label.startsWith('Insert column'))assert.equal(a.alignments.length,5);if(label==='Remove columns')assert.equal(a.alignments.length,3);
 if(label.startsWith('Align cells '))assert.equal(a.alignments[1],label.split(' ').at(-1));
 if(['Header cells','Body cells'].includes(label))assert.equal(a.rows[1][1].header??false,label==='Header cells');
 if(label==='Heading 2 cells')assert.deepEqual(a.rows[1][1].paragraphs[0].style,['heading',2]);
 for(const [name,mark] of [['Bold cells','bold'],['Italic cells','italic'],['Underline cells','underline'],['Code cells','code']])if(label===name)assert.ok(a.rows[1][1][0][1].some(m=>m[0]===mark));
 if(!label.includes('row')&&!label.includes('column')&&!label.startsWith('Align cells')&&label!=='Body cells')assert.ok(changed,label+' must apply');
 await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);
 fact.snapshots.push({before,after});await finish(page,baseline,fact);
}));
test('MWX-C10 modifier-free range and selected-cell formatting preserve Unicode',()=>probe('MWX-C10-range',async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableRows:rows}),before=await state(page);
 await tap(page,'Select cell row 1 column 2');await tap(page,'Extend table selection');await tap(page,'Select cell row 2 column 3');
 assert.equal(await page.locator('[data-cell-selected]').count(),4);await tap(page,'Bold cells');const after=await state(page),d=table(after).blockAttributes[2];
 for(let r=0;r<2;r++)for(let c=0;c<4;c++){assert.equal(d.rows[r][c][0][0],rows[r][c]);assert.equal(d.rows[r][c][0][1].some(m=>m[0]==='bold'),c===1||c===2);}
 assert.equal(after.history.undoGroups,1);await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);fact.snapshots.push({before,after});await finish(page,baseline,fact);
}));
for(const mode of ['readonly','protected'])test(`MWX-C10 ${mode} table rejects writes`,()=>probe(`MWX-C10-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableRows:rows,readOnly:mode==='readonly',protectedCells:mode==='protected'?[[1,1]]:undefined}),before=await state(page);
 await tap(page,'Select cell row 2 column 2');
 if(mode==='readonly')for(const label of ['Bold cells','Insert row before','Align cells left'])assert.equal(await page.getByRole('button',{name:label,exact:true}).isDisabled(),true);
 else for(const label of ['Bold cells','Heading 2 cells','Header cells'])await tap(page,label);
 assert.deepEqual((await snapshot(page)).nodes,before.nodes);assert.equal((await state(page)).history.undoGroups,0);await finish(page,baseline,fact);
}));
test('MWX-C11 grid overflow leaves table controls and native scrolling reachable',()=>probe('MWX-C11-overflow',async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableRows:rows});fact.targets=await targets(page,'[data-content-module="table"] button');for(const t of fact.targets)assert.ok(t.width>=44&&t.height>=44,JSON.stringify(t));
 const measure=()=>page.evaluate(()=>{const f=(window as any).inputFixture,s=f.root.querySelector('[data-table-scroll]'),panel=f.root.querySelector('[data-content-module="table"]'),host=document.querySelector('#scroll-root');return {hostWidth:host.clientWidth,hostScroll:host.scrollWidth,gridWidth:s.clientWidth,gridScroll:s.scrollWidth,panel:panel.getBoundingClientRect().width,rootTouch:getComputedStyle(f.root).touchAction,select:getComputedStyle(f.root).userSelect,gridTouch:getComputedStyle(s).touchAction,overflow:getComputedStyle(s).overflowX,meta:document.querySelector('meta[name=viewport]').getAttribute('content')};});
 fact.geometry=[];for(const width of [390,260]){await page.setViewportSize({width,height:740});await frame(page);const m=await measure();fact.geometry.push(m);assert.ok(m.gridScroll>m.gridWidth);assert.ok(m.hostScroll<=m.hostWidth+1,JSON.stringify(m));assert.equal(m.overflow,'auto');assert.equal(m.rootTouch,'auto');assert.equal(m.gridTouch,'auto');assert.notEqual(m.select,'none');assert.ok(!m.meta.includes('user-scalable=no'));}
 await page.locator('[data-table-scroll]').evaluate(e=>{e.scrollLeft=100;});assert.ok(await page.locator('[data-table-scroll]').evaluate(e=>e.scrollLeft)>0);
 await tap(page,'Select cell row 2 column 2');await tap(page,'Bold cells');assert.equal((await state(page)).history.undoGroups,1);await finish(page,baseline,fact);
}));
test('MWX-C11 long code is locally scrollable with native selection',()=>probe('MWX-C11-code',async(page,fact)=>{
 const source='const unicode = "😀"; '+'x'.repeat(500);const baseline=await mount(page,{code:true,codeTools:true,text:source}),before=await state(page);
 fact.layout=await page.locator('pre').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,overflow:getComputedStyle(e).overflowX,touch:getComputedStyle(e).touchAction}));assert.ok(fact.layout.scroll>fact.layout.width);assert.equal(fact.layout.overflow,'auto');assert.equal(fact.layout.touch,'auto');await select(page,6,13);assert.equal(await page.evaluate(()=>getSelection()?.toString()),'unicode');assert.equal((await state(page)).history.undoGroups,0);assert.deepEqual((await state(page)).nodes,before.nodes);await finish(page,baseline,fact);
}));
test('MWX-C12 one table format and cell input retain unrelated owners and bound presenter updates',()=>probe('MWX-C12-incremental',async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableRows:rows,tableCopies:12,unrelatedCode:true,highlight:'enabled',nodes:Array.from({length:20},(_,i)=>({text:i<12?'':'unrelated '+i}))}),before=await state(page);
 assert.equal(before.nodes.filter(n=>n.blockAttributes?.[0]==='code').length,8);
 const highlightBefore=await page.evaluate(()=>(window as any).highlightCounters.requests.length);assert.equal(highlightBefore,8);
 const owner=table(before).id;await page.evaluate(()=>{(window as any).contentCounters.updates=[];});await tap(page,'Select cell row 2 column 2');await tap(page,'Bold cells');
 const formatted=await state(page);assert.equal(formatted.history.undoGroups,1);assert.deepEqual(formatted.nodes.filter(n=>n.id!==owner),before.nodes.filter(n=>n.id!==owner));
 const input=page.getByRole('textbox',{name:'Table row 2 column 2',exact:true}).first();await input.fill('中😀 é');const edited=await state(page);assert.equal(edited.history.undoGroups,2);assert.equal(table(edited).blockAttributes[2].rows[1][1][0][0],'中😀 é');assert.deepEqual(edited.nodes.filter(n=>n.id!==owner),before.nodes.filter(n=>n.id!==owner));
 fact.counters=await page.evaluate(()=>(window as any).contentCounters);assert.ok(fact.counters.updates.length>0);assert.ok(fact.counters.updates.every(id=>id===owner));assert.equal(fact.counters.created,12);assert.equal(await page.evaluate(()=>(window as any).highlightCounters.requests.length),highlightBefore,'table controls never re-highlight unrelated code');fact.highlightRequests={before:highlightBefore,after:highlightBefore};
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids.at(-1),0);});await undo(page);assert.deepEqual((await state(page)).nodes,formatted.nodes);await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);fact.snapshots.push({before,formatted,edited});await finish(page,baseline,fact);
}));
test('MWX-C09 FND tap replacement and query Enter preserve captured scope',()=>probe('MWX-C09-find',async(page,fact)=>{
 const baseline=await mount(page,{text:'cat [cat] cat',searchAuthorization:'allowed'}),before=await state(page);await select(page,5,8);await tap(page,'Find in selection');
 await page.getByRole('textbox',{name:'Find text',exact:true}).fill('cat');await page.getByRole('textbox',{name:'Replacement text'}).fill('dog');await frame(page);await page.getByRole('textbox',{name:'Find text',exact:true}).press('Enter');assert.deepEqual((await state(page)).nodes,before.nodes);assert.equal((await state(page)).history.undoGroups,0);
 fact.targets=await targets(page,'[data-document-search] button');for(const t of fact.targets)assert.ok(t.width>=44&&t.height>=44,JSON.stringify(t));await tap(page,'Replace all');assert.equal(text(await state(page)),'cat [dog] cat');assert.equal((await state(page)).history.undoGroups,1);await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);await finish(page,baseline,fact);
}));
test('MWX-C09 command search Enter focuses an explicit action without editing',()=>probe('MWX-C09-command-query',async(page,fact)=>{
 const baseline=await mount(page,{text:'alpha',commandControls:true}),before=await state(page);await select(page,0,5);await tap(page,'Search commands');await page.getByRole('searchbox',{name:'Search editing commands'}).fill('Bold');await page.getByRole('searchbox',{name:'Search editing commands'}).press('Enter');assert.deepEqual((await state(page)).nodes,before.nodes);assert.equal((await state(page)).history.undoGroups,0);assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Bold');await tap(page,'Bold');assert.equal((await state(page)).history.undoGroups,1);await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);await finish(page,baseline,fact);
}));
for(const mode of ['readonly','composing'])test(`MWX-C09 ${mode} code cannot mutate through touch`,()=>probe(`MWX-C09-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{code:true,codeTools:true,text:'const اسم = "😀";',readOnly:mode==='readonly'}),before=await state(page);await select(page,0,5);
 if(mode==='readonly')assert.equal(await page.getByRole('button',{name:'Indent code lines',exact:true}).isDisabled(),true);
 else {await page.evaluate(()=>{const f=(window as any).inputFixture;f.deliver('compositionstart',{data:''});f.surface.codeCommands.execute('indent');});assert.deepEqual((await state(page)).nodes,before.nodes);await page.evaluate(()=>(window as any).inputFixture.deliver('compositionend',{data:''}));}
 assert.deepEqual((await state(page)).nodes,before.nodes);assert.equal((await state(page)).history.undoGroups,0);await finish(page,baseline,fact);
}));
test('MWX-C10 table link query Enter is nonmutating',()=>probe('MWX-C10-link-query',async(page,fact)=>{
 const baseline=await mount(page,{table:true}),before=await state(page);await tap(page,'Select cell row 1 column 1');const input=page.getByRole('textbox',{name:'Table cell link',exact:true});await input.fill('https://example.test/');await input.press('Enter');assert.deepEqual((await state(page)).nodes,before.nodes);assert.equal((await state(page)).history.undoGroups,0);await finish(page,baseline,fact);
}));
for(const kind of ['code','search'])test(`MWX-C09 ${kind} control panel tracks a prepared keyboard viewport`,()=>probe(`MWX-C09-viewport-${kind}`,async(page,fact)=>{
 const baseline=await mount(page,{code:kind==='code',codeTools:kind==='code',searchAuthorization:kind==='search'?'allowed':undefined});if(kind==='search')await tap(page,'Find in document');
 fact.geometry=[];for(const visual of [{left:0,top:0,width:390,height:300},{left:20,top:16,width:195,height:250}]){
 await page.evaluate(visual=>{const w=window as any;w.mobileGeometry={visual,scale:visual.width===195?2:1};w.inputFixture.surface.viewport.invalidate();},visual);await frame(page);
 const rect=await page.locator(kind==='code'?'[data-code-commands]':'[data-document-search]').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});fact.geometry.push(rect);assert.ok(rect.left>=visual.left-1&&rect.right<=visual.left+visual.width+1&&rect.top>=visual.top-1&&rect.bottom<=visual.top+visual.height+1,JSON.stringify(rect));}
 assert.equal((await state(page)).history.undoGroups,0);await finish(page,baseline,fact);
}));
test('MWX-C09 canceled code pointer releases its target before another selection',()=>probe('MWX-C09-pointer-cancel',async(page,fact)=>{
 const baseline=await mount(page,{code:true,codeTools:true,text:'a\nb\nc'}),before=await state(page);await select(page,0,1);
 await page.getByRole('button',{name:'Indent code lines',exact:true}).dispatchEvent('pointerdown',{pointerType:'touch',pointerId:17});await page.getByRole('button',{name:'Indent code lines',exact:true}).dispatchEvent('pointercancel',{pointerType:'touch',pointerId:17});assert.deepEqual((await state(page)).nodes,before.nodes);
 await select(page,2,3);await tap(page,'Indent code lines');assert.equal(text(await state(page)),'a\n  b\nc');assert.equal((await state(page)).history.undoGroups,1);await undo(page);assert.deepEqual((await state(page)).nodes,before.nodes);await finish(page,baseline,fact);
}));

// Full raw-source bindings come from the actual optional Markdown codec, never a
// fixture serializer. Unrelated tables and code exercise the production view map.
const rawSource = 'Before  **unchanged** 😀\r\n\r\n| a | bb |\r\n| :- | -: |\r\n| `x\\|y` | é |\r\n\r\nBetween   unchanged\n\n| c | dd |\n| - | - |\n| اسم | é |\n\n' +
  Array.from({length:20},(_,i)=>`Unrelated ${i}  unchanged\n\n| x${i} | y |\n| - | - |\n| z | q |\n\n\`\`\`js\nconst n${i} = "😀";\n\`\`\`\n\n`).join('') + 'After\tunchanged';
async function recoveredSource(page, owner) {
  return page.evaluate(owner=>{
    const f=(window as any).inputFixture,t=(window as any).mobileTableSource;
    const base=f.surface.captureSourceBaseline(t.source,t.owners,{tables:true},t.opening);
    try{return base.sourceWithCurrentTable(owner);}finally{base.dispose();}
  },owner);
}
for(const selected of [0,1])test(`MWX-C12 touch source format ${selected} preserves exact bytes, history and durable recovery`,()=>probe(`MWX-C12-source-${selected}`,async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableSource:rawSource}),before=await state(page);
 const tables=before.nodes.filter(n=>n.blockAttributes?.[0]==='module:editac.table'),owner=tables[selected].id;
 const view=page.locator(`[data-node-id="${owner}"] [data-content-module="table"]`);
 await view.getByRole('button',{name:'Select cell row 2 column 1',exact:true}).tap();
 const native=await view.getByRole('textbox',{name:'Table row 2 column 1',exact:true}).elementHandle();
 const target=await view.getByRole('button',{name:'Format table source',exact:true}).boundingBox();assert.ok(target&&target.width>=44&&target.height>=44);
 await page.evaluate(()=>{(window as any).contentCounters.updates=[];});
 await view.getByRole('button',{name:'Format table source',exact:true}).tap();await frame(page);
 const after=await state(page),formatted=await recoveredSource(page,owner);
 const old=before.nodes.find(n=>n.id===owner),fresh=after.nodes.find(n=>n.id===owner);
 assert.notEqual(fresh.blockAttributes[2].source,old.blockAttributes[2].source);
 assert.equal(formatted,rawSource.replace(old.blockAttributes[2].source,fresh.blockAttributes[2].source),'only selected raw span changes');
 const withoutSource=n=>({...n,blockAttributes:[...n.blockAttributes.slice(0,2),{...n.blockAttributes[2],source:''}]});
 assert.deepEqual(withoutSource(fresh),withoutSource(old));
 assert.deepEqual(after.nodes.filter(n=>n.id!==owner),before.nodes.filter(n=>n.id!==owner));assert.equal(after.history.undoGroups,1);
 assert.equal(await native.evaluate(e=>e.isConnected),true,'source-only update retains native control identity');
 assert.equal(await view.getByRole('button',{name:'Select cell row 2 column 1',exact:true}).getAttribute('aria-pressed'),'true');
 const updates=await page.evaluate(()=>(window as any).contentCounters.updates);assert.ok(updates.length>0);assert.ok(updates.every(id=>id===owner));
 await undo(page);assert.equal(await recoveredSource(page,owner),rawSource);
 await page.evaluate(()=>{(window as any).inputFixture.engine.history({type:'redo'});});await frame(page);assert.equal(await recoveredSource(page,owner),formatted);
 await view.getByRole('button',{name:'Format table source',exact:true}).tap();await frame(page);assert.equal((await state(page)).history.undoGroups,1,'idempotent formatting creates no update');
 const lifetimes=await page.evaluate(()=>{const t=(window as any).mobileTableSource;return {captures:t.captures,disposals:t.disposals};});assert.ok(lifetimes.captures>=2);assert.equal(lifetimes.captures,lifetimes.disposals);
 await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.destroy();await f.recover();});await frame(page);
 assert.equal(await recoveredSource(page,owner),formatted,'IndexedDB reopen retains source and original byte recovery');
 const cell=page.locator(`[data-node-id="${owner}"]`).getByRole('textbox',{name:'Table row 2 column 1',exact:true});
 await page.evaluate(()=>{(window as any).contentCounters.updates=[];});await cell.fill('edited 😀');await frame(page);
 const edited=await state(page);assert.deepEqual(edited.nodes.filter(n=>n.id!==owner),after.nodes.filter(n=>n.id!==owner));
 assert.ok((await page.evaluate(()=>(window as any).contentCounters.updates)).every(id=>id===owner));
 await page.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids.at(-1),0);});
 await undo(page);assert.deepEqual((await state(page)).nodes,after.nodes);
 fact.snapshots.push({owner,before,after,edited,formatted,updates,lifetimes});await finish(page,baseline,fact);
}));
for(const mode of ['absent','readonly','protected','composing','changed','over-limit'])test(`MWX-C12 source ${mode} preserves original data`,()=>probe(`MWX-C12-source-${mode}`,async(page,fact)=>{
 const baseline=await mount(page,{table:true,tableSource:rawSource,sourcePortAbsent:mode==='absent',readOnly:mode==='readonly',protectedCells:mode==='protected'?[[0,0]]:undefined});
 const before=await state(page),owner=before.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table').id;
 const view=page.locator(`[data-node-id="${owner}"]`),button=view.getByRole('button',{name:'Format table source',exact:true});
 if(mode==='absent'||mode==='readonly')assert.equal(await button.isDisabled(),true);
 else {
  if(mode==='composing')await view.getByRole('textbox',{name:'Table row 2 column 1',exact:true}).dispatchEvent('compositionstart');
  if(mode==='changed')await view.getByRole('textbox',{name:'Table row 2 column 1',exact:true}).fill('changed source semantics');
  if(mode==='over-limit')await page.evaluate(()=>{(window as any).mobileTableSource.source='x'.repeat(1048577);});
  const captured=await state(page);await button.tap();await frame(page);assert.deepEqual((await state(page)).nodes,captured.nodes);assert.equal((await state(page)).history.undoGroups,captured.history.undoGroups);
  if(mode!=='composing')assert.match(await view.getByRole('status').textContent(),/original source and data preserved/);
 }
 const current=await state(page);if(mode!=='changed')assert.deepEqual(current.nodes,before.nodes);
 fact.snapshots.push({mode,before,current});await finish(page,baseline,fact);
}));
