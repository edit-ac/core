import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { browserHarness } from './browser-harness.ts';
import { browserInputSources } from '../editing/browser-driver.ts';
import { installExtensionCounters } from './mobile-extensions/resources.mjs';
import { installResourceCounters } from '../mobile-web/resources.mjs';

const { probe, facts } = browserHarness('mobile-extension-formatting', 'fixtures/browser-mobile-extensions', {
  autoMount: false, testFile: 'tests/browser/mobile-extension-formatting.spec.ts', assertSourcesUnchanged: true,
  contextOptions: { viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: process.env.EDITAC_MOBILE_EXTENSION_FORMATTING_BROWSER !== 'firefox' },
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
  sourcePaths: [...browserInputSources, 'tests/browser/mobile-extension-formatting.spec.ts',
    'scripts/test-browser.mjs','tests/browser/browser-harness.ts','tests/browser/fixture-server.mjs','tests/browser/editing-packed-cache.mjs','scripts/test-toolchain.mjs','scripts/build-wasm.mjs','scripts/build-extension-runtime.mjs','package-lock.json', 'fixtures/browser-mobile-extensions/session.mjs', 'fixtures/browser-mobile-extensions/index.html',
    'fixtures/rich-presenters/formatting/mixed-extensions.json', 'tests/mobile-web/resources.mjs',
    'tests/browser/mobile-extensions/resources.mjs', '../architecture/specs/rich-content-extensions.md',
    ...['commands/format','commands/editor','history','document','anchors','projection','modules/content','modules/assets','modules/inert_content'].map(n=>`crates/editac-core/src/${n}.rs`),
    'crates/editac-core/tests/content_format.rs','Cargo.lock',
    ...['ui/commands','commands/catalog','commands/formatting','input/keyboard','modules/content','modules/touch-controls',
      'modules/tables/clipboard','modules/images/presenter','modules/attachments/presenter','modules/references/display','modules/math','modules/math-definition','modules/registry','extensions/math','extensions/assets','editor','surface','extensions/configuration','extensions/contract'].flatMap(n =>
      [`packages/web/src/${n}.ts`, `packages/web/dist/${n}.js`])],
});
facts.binding = { gate:'MTF-1.1', original:'MEX-1.9/MWX-1.9',
 semantics:'packed production BrowserEditor/shared Session/WASM/IndexedDB, deterministic content and touch events',
 platform:'desktop browser mobile viewport replay only; device/OS/native menu/IME/AT/performance/release remain open' };
async function frame(page) { await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))); }
async function mount(page, options = {}) {
  await page.waitForFunction(() => !!(window as any).inputFixture);
  await page.evaluate(() => { // Do not let fixture CSS supply production target sizes.
    const style = document.querySelector('style')!; style.textContent = style.textContent!.replace(/button \{[^}]+\}/g, '');
    (window as any).mobileGeometry = { visual: { left:0, top:0, width:390, height:740 }, scale:1 };
  });
  const baseline = await page.evaluate(() => (window as any).mobileResources());
  await page.evaluate(async options => { const f = (window as any).inputFixture; await f.mount({ text: 'alpha bravo charlie', viewport:true, commandControls:true, ...options }); f.select(f.ids[0], 2); await f.settle(); }, options);
  await frame(page); return baseline;
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
async function tap(page, name) { await page.getByRole('button', { name, exact:true }).tap(); await frame(page); }
const corpus = JSON.parse(readFileSync('fixtures/rich-presenters/formatting/mixed-extensions.json', 'utf8'));
const marks = [['Bold','bold'], ['Italic','italic'], ['Underline','underline'], ['Strikethrough','strike'], ['Inline code','code'], ['Edit link','link']];
async function nativeRange(p){return p.evaluate(()=>{const s=getSelection();const name=n=>n?.nodeType===3?'#text':n?.id??n?.nodeName;return{anchor:name(s.anchorNode),focus:name(s.focusNode),anchorOffset:s.anchorOffset,focusOffset:s.focusOffset};});}
async function history(p,type) { await p.evaluate(type => (window as any).inputFixture.engine.history({type}),type); await frame(p); }
function unchanged(a,b) { assert.deepEqual(b.nodes,a.nodes); assert.deepEqual(b.history,a.history); assert.deepEqual(b.journal,a.journal); }
function one(a,b) { assert.equal(b.history.undoGroups,a.history.undoGroups+1); assert.equal(b.journal.length,a.journal.length+1); assert.deepEqual(b.errors,[]); }
function blocksFor(family) {
 if(family==='text')return undefined;
 const returned=corpus.returnedCases.find(c=>c.id===`${family}-bold`);
 if(returned)return structuredClone(returned.envelope.payload).map(b=>({...b,runs:b.runs.map(r=>({...r,marks:[]}))}));
 const id={'image-caption':'image-caption-bold','file-caption':'file-caption-bold',reference:'reference-label',extension:'registered-heading2'}[family];
 return structuredClone(corpus.cases.find(c=>c.id===id).envelope.payload).map(b=>({...b,runs:b.runs.map(r=>({...r,marks:[]}))}));
}
const families=['text','image-caption','file-caption','reference','extension','file','image-asset','math','inert'].map(family=>({family,presented:false}));
 families.push(...['reference','file','image-asset','math','inert'].map(family=>({family,presented:true})));
for(const {family,presented} of families)for(const [label,mark] of marks)
test(`MTF-1.1 ${presented?'presented ':''}${family} captured reverse selection applies ${mark} by touch`,()=>probe(`${presented?'presented-':''}${family}-${mark}`,async(p,fact)=>{
 const baseline=await mount(p,{formattingBlocks:blocksFor(family),...(presented?{formattingPresenters:true,...(family==='reference'?{referenceDisplay:true}:{}),...(family==='math'?{facade:'math'}:{})}:{})});
 const target=await p.evaluate(()=>{const f=(window as any).inputFixture,node=f.engine.read().visible.filter(n=>n.runs.some(r=>r.text)).at(-1),text=node.runs.map(r=>r.text).join('');
  const block=f.root.querySelector(`[data-node-id="${node.id}"]`),atomic=block.contentEditable==='false'?block:block.querySelector('[data-module-type="editac.math"][contenteditable="false"]');
  if(atomic){f.root.focus();const parent=atomic.parentNode,index=Array.prototype.indexOf.call(parent.childNodes,atomic);getSelection().setBaseAndExtent(parent,index+1,parent,index);}
  else f.select(node.id,text.length,0);
  return{id:node.id,text,atomic:!!atomic};});
 const before=await state(p);
 if(before.selection.anchor?.node===target.id){assert.equal(before.selection.anchor.offset,target.text.length);assert.equal(before.selection.focus.offset,0);}
 if(presented)assert.ok(target.atomic,'enabled presenter supplies the atomic selection boundary');
 if(family!=='text'){const seeded=blocksFor(family),expected=seeded.at(-1);assert.equal(target.text,expected.runs.map(r=>r.text).join(''));const node=before.nodes.find(n=>n.id===target.id);if(expected.attributes.type==='content')assert.deepEqual(node.blockAttributes,expected.attributes.tuple);else assert.equal(node.blockAttributes[0],expected.attributes.type);}
 fact.snapshots.push({before,target});
 const nativeBefore=await nativeRange(p);await tap(p,label);
 if(mark==='link'){
  const dialog=p.getByRole('dialog',{name:'Edit link',exact:true});
  await dialog.getByRole('textbox',{name:'Link URL',exact:true}).fill('https://EXAMPLE.test/path');
  const sizes=await dialog.locator('input,button').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return[r.width,r.height];}));
  assert.ok(sizes.every(([w,h])=>w>=44&&h>=44));await dialog.getByRole('button',{name:'Apply link',exact:true}).tap();await frame(p);
 }
 const after=await state(p);one(before,after);const changed=after.nodes.find(n=>n.id===target.id);
 assert.equal(changed.runs.map(r=>r.text).join(''),target.text);
 const original=before.nodes.find(n=>n.id===target.id);assert.deepEqual(changed.blockAttributes,original.blockAttributes);
 const withoutMark=n=>n.runs.map(r=>({text:r.text,attributes:Object.fromEntries(Object.entries(r.attributes).filter(([key])=>key!==mark))}));
 assert.deepEqual(withoutMark(changed),withoutMark(original),'opaque marks, inline attributes and source stay exact');
 assert.equal(changed.runs.filter(r=>r.attributes[mark]).map(r=>r.text).join(''),target.text);
 if(mark==='link')assert.ok(changed.runs.every(r=>r.attributes.link==='https://example.test/path'));
 assert.deepEqual(after.nodes.filter(n=>n.id!==target.id),before.nodes.filter(n=>n.id!==target.id));
 assert.deepEqual(after.selection,before.selection,'directional native selection survives pointerdown/blur/click');
 if(target.atomic)assert.deepEqual(await nativeRange(p),nativeBefore,'whole-node direction retained');
 assert.equal(after.focus,true);
 await tap(p,'Undo');const undone=await state(p);assert.deepEqual(undone.nodes,before.nodes);assert.deepEqual(undone.selection,before.selection);
 await tap(p,'Redo');const redone=await state(p);assert.deepEqual(redone.nodes,after.nodes);assert.deepEqual(redone.selection,after.selection);
 fact.snapshots.push({before,after,target});await finish(p,baseline,fact);
}));
const rows=[['one','two','three','four'],['alpha😀','beta','gamma','delta']];
const table=s=>s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table');
const cellActions=[
 ...[['Bold cells','bold'],['Italic cells','italic'],['Underline cells','underline'],['Strike cells','strike'],['Code cells','code'],['Link cells','link']],
 ...['Paragraph cells',...Array.from({length:6},(_,i)=>`Heading ${i+1} cells`),'Code block cells','Header cells','Body cells',...['none','left','center','right'].map(a=>`Align cells ${a}`)].map(label=>[label,null]),
];
for(const [label,mark]of cellActions)test(`MTF-1.1 ${label} retains captured rectangle and history`,()=>probe(`cells-${label}`,async(p,fact)=>{
 const baseline=await mount(p,{table:true,tableRows:rows}),before=await state(p);
 await tap(p,'Select cell row 2 column 2');await tap(p,'Extend table selection');await tap(p,'Select cell row 1 column 1');
 if(mark==='link')await p.getByRole('textbox',{name:'Table cell link',exact:true}).fill('https://EXAMPLE.test/path');
 await tap(p,label);const after=await state(p);one(before,after);assert.equal(await p.locator('[data-cell-selected]').count(),4);
 const data=table(after).blockAttributes[2];
 for(let r=0;r<2;r++)for(let c=0;c<2;c++){
  const cell=data.rows[r][c],runs=cell.paragraphs?.[0].runs??cell;
  if(mark)assert.ok(runs.every(run=>run[1].some(m=>m[0]===mark&&(mark!=='link'||m[1]==='https://example.test/path'))));
  if(label.startsWith('Heading'))assert.deepEqual(cell.paragraphs[0].style,['heading',Number(label.split(' ')[1])]);
  if(label==='Paragraph cells')assert.deepEqual(cell.paragraphs[0].style,['paragraph']);
  if(label==='Code block cells')assert.deepEqual(cell.paragraphs[0].style,['code','']);
  if(label==='Header cells'||label==='Body cells')assert.equal(cell.header,label==='Header cells');
 }
 if(label.startsWith('Align cells'))assert.deepEqual(data.alignments.slice(0,2),[label.split(' ').at(-1),label.split(' ').at(-1)]);
 const untouched=d=>d.rows.map((row,r)=>row.slice(2).map(cell=>Array.isArray(cell)?{header:r===0,rowSpan:1,columnSpan:1,paragraphs:[{style:['paragraph'],runs:cell}]}:cell));
 assert.deepEqual(untouched(data),untouched(table(before).blockAttributes[2]));
 assert.equal(data.source,table(before).blockAttributes[2].source);
 if(!['Paragraph cells','Code block cells'].includes(label)&&!label.startsWith('Heading'))assert.deepEqual(table(after).runs,table(before).runs);
 else assert.equal(table(after).runs.map(r=>r.text).join(''),rows.map(r=>r.join('\t')).join('\n'),'v2 promotion uses the existing complete literal backing text');
 await history(p,'undo');assert.deepEqual((await state(p)).nodes,before.nodes);await history(p,'redo');assert.deepEqual((await state(p)).nodes,after.nodes);
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
for(const mode of ['readonly','denied','disabled-controls','stale','foreign-editor','no-target','link-cancel','link-noop'])
test(`MTF-1.1 ${mode} command controls preserve document and history`,()=>probe(`guard-${mode}`,async(p,fact)=>{
 const facade=['disabled-controls','denied'].includes(mode);
 const baseline=await mount(p,{...(facade?{facade:'references',formatting:{marks:{bold:{commands:mode!=='denied',shortcuts:false,controls:false}}}}:{}),readOnly:mode==='readonly'});
 await p.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],11,6);});let before=await state(p);
 if(mode==='disabled-controls'||mode==='denied')assert.equal(await p.getByRole('button',{name:'Bold',exact:true}).count(),0);
 else if(mode==='readonly')assert.equal(await p.getByRole('button',{name:'Bold',exact:true}).isDisabled(),true);
 else if(mode.startsWith('link-')){await tap(p,'Edit link');await tap(p,mode==='link-cancel'?'Cancel link':'Apply link');}
 else{
  const button=p.getByRole('button',{name:'Bold',exact:true});
  if(mode!=='no-target')await button.dispatchEvent('pointerdown',{bubbles:true});
  if(mode==='stale'){await p.evaluate(()=>(window as any).inputFixture.remote(0,0,'peer'));before=await state(p);}
  if(mode==='foreign-editor')await p.evaluate(async()=>{(window as any).formatSibling=await (window as any).inputFixture.sibling();(window as any).formatSibling.root.focus();});
  await button.dispatchEvent('click',{bubbles:true});await frame(p);
 }
 const after=await state(p);unchanged(before,after);
 if(mode==='foreign-editor')await p.evaluate(()=>(window as any).formatSibling.dispose());
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
for(const mode of ['readonly','protected','foreign-editor','stale'])test(`MTF-1.1 table ${mode} retires or rejects captured formatting`,()=>probe(`cells-guard-${mode}`,async(p,fact)=>{
 const baseline=await mount(p,{table:true,tableRows:rows,readOnly:mode==='readonly',protectedCells:mode==='protected'?[[0,0]]:undefined});
 await tap(p,'Select cell row 1 column 1');let before=await state(p);
 if(mode==='foreign-editor')await p.evaluate(async()=>{(window as any).formatSibling=await (window as any).inputFixture.sibling();(window as any).formatSibling.root.focus();});
 if(mode==='stale'){await p.evaluate(()=>{const f=(window as any).inputFixture,n=f.engine.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');f.storage.commit({kind:'editor',origin:'prepared-table-change',commands:[{type:'tableFormat',owner:n.id,expected:n.blockAttributes,row:1,column:3,rows:1,columns:1,mark:'italic',action:'apply',href:null,protected:[]}]});});before=await state(p);}
 const button=p.getByRole('button',{name:'Bold cells',exact:true});if(await button.isEnabled())await button.tap();
 const after=await state(p);unchanged(before,after);
 if(mode==='foreign-editor'){assert.equal(await p.locator('[data-cell-selected]').count(),0);await p.evaluate(()=>(window as any).formatSibling.dispose());}
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
test('MTF-1.1 Remove cell link keeps rectangle, opaque data and one history effect',()=>probe('cells-remove-link',async(p,fact)=>{
 const baseline=await mount(p,{table:true,tableRows:rows});await tap(p,'Select cell row 2 column 1');
 await p.getByRole('textbox',{name:'Table cell link',exact:true}).fill('https://example.test/path');await tap(p,'Link cells');
 const before=await state(p);await tap(p,'Remove cell link');const after=await state(p);one(before,after);
 assert.deepEqual(table(after).blockAttributes[2].rows[1][0],[['alpha😀',[]]]);assert.equal(await p.locator('[data-cell-selected]').count(),1);
 await history(p,'undo');assert.deepEqual((await state(p)).nodes,before.nodes);
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
test('MTF-1.1 clearing link URL removes only link from captured text',()=>probe('text-remove-link',async(p,fact)=>{
 const baseline=await mount(p);await p.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],11,6);});
 await tap(p,'Edit link');await p.getByRole('textbox',{name:'Link URL',exact:true}).fill('https://example.test/path');await tap(p,'Apply link');
 const before=await state(p);await tap(p,'Edit link');await p.getByRole('textbox',{name:'Link URL',exact:true}).fill('');await tap(p,'Apply link');
 const after=await state(p);one(before,after);assert.ok(after.nodes.every(n=>n.runs.every(r=>!r.attributes.link)));
 await history(p,'undo');assert.deepEqual((await state(p)).nodes,before.nodes);
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
for(const [label,mark]of marks)test(`MTF-1.1 searchable command menu retains ${mark} target across input focus`,()=>probe(`search-menu-${mark}`,async(p,fact)=>{
 const baseline=await mount(p);await p.evaluate(()=>{const f=(window as any).inputFixture;f.select(f.ids[0],11,6);});const before=await state(p);
 await tap(p,'Search commands');await p.getByRole('searchbox',{name:'Search editing commands',exact:true}).fill(label);await tap(p,label);
 if(mark==='link'){await p.getByRole('textbox',{name:'Link URL',exact:true}).fill('https://example.test/path');await tap(p,'Apply link');}
 const after=await state(p);one(before,after);assert.equal(after.nodes.flatMap(n=>n.runs).filter(r=>r.attributes[mark]).map(r=>r.text).join(''),'bravo');
 assert.deepEqual(after.selection,before.selection);await history(p,'undo');assert.deepEqual((await state(p)).nodes,before.nodes);
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
for(const mode of ['readonly','stale','foreign-editor'])test(`MTF-1.1 presented node ${mode} fences the captured formatting target`,()=>probe(`presented-guard-${mode}`,async(p,fact)=>{
 const baseline=await mount(p,{formattingBlocks:blocksFor('reference'),formattingPresenters:true,referenceDisplay:true});
 await p.evaluate(()=>{const f=(window as any).inputFixture,node=f.root.querySelector('[data-content-module="reference"]')?.closest('[data-node-id]')??[...f.root.querySelectorAll('[data-node-id]')].find(n=>(n as HTMLElement).contentEditable==='false');if(!node)throw Error('Expected reference presenter');f.root.focus();const parent=node.parentNode,index=Array.prototype.indexOf.call(parent.childNodes,node);getSelection().setBaseAndExtent(parent,index+1,parent,index);});
 const button=p.getByRole('button',{name:'Bold',exact:true});await button.dispatchEvent('pointerdown',{bubbles:true});
 if(mode==='readonly')await p.evaluate(()=>(window as any).inputFixture.surface.setReadOnly(true));
 if(mode==='stale')await p.evaluate(()=>(window as any).inputFixture.remote(0,0,'peer'));
 if(mode==='foreign-editor')await p.evaluate(async()=>{const s=await (window as any).inputFixture.sibling();(window as any).formatSibling=s;(window as any).formatSiblingBefore=s.editor.read();s.root.focus();});
 const before=await state(p);await button.dispatchEvent('click',{bubbles:true});await frame(p);const after=await state(p);unchanged(before,after);
 if(mode==='foreign-editor'){const stable=await p.evaluate(()=>JSON.stringify((window as any).formatSibling.editor.read())===JSON.stringify((window as any).formatSiblingBefore));assert.equal(stable,true);await p.evaluate(()=>(window as any).formatSibling.dispose());}
 fact.snapshots.push({before,after});await finish(p,baseline,fact);
}));
