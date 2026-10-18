import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';

const {probe}=browserHarness('table-invalidation','fixtures/browser-content-modules',{
  markdown:true,assertSourcesUnchanged:true,sourcePaths:[
    'packages/web/src/modules/content.ts','packages/web/src/modules/tables/clipboard.ts',
    'packages/web/src/dom/render.ts','fixtures/browser-content-modules/session.mjs',
    'fixtures/browser-content-modules/index.html',
  ],
});
const source='| **head** | other |\n| :--- | ---: |\n| alpha😀 | beta |';
const tables=p=>p.locator('[data-content-module="table"]');
const input=(p,r=2,c=1)=>tables(p).first().getByRole('textbox',{name:`Table row ${r} column ${c}`,exact:true});
async function state(p,f){const s=await p.evaluate(()=>window.inputFixture.state());f.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function oneEffect(a,b){assert.equal(b.history.undoGroups,a.history.undoGroups+1);assert.equal(b.journal.length,a.journal.length+1);assert.equal(b.commands.length,a.commands.length+1);}
function unchanged(a,b){assert.deepEqual(b.nodes,a.nodes);assert.deepEqual(b.history,a.history);assert.deepEqual(b.journal,a.journal);}
async function observe(p){await p.evaluate(()=>{
  window.tableObservations=[...document.querySelectorAll('[data-content-module="table"]')].map(table=>{
    const cells=[...table.querySelectorAll('td,th')];
    const previews=cells.map(cell=>cell.querySelector('div'));
    const records=[];
    const observer=new MutationObserver(batch=>records.push(...batch));
    observer.observe(table.querySelector('tbody'),{subtree:true,childList:true,attributes:true,characterData:true});
    return {table,cells,previews,children:previews.map(preview=>preview.firstChild),records,observer};
  });
});}
async function effects(p){return p.evaluate(()=>window.tableObservations.map(o=>({
  sameTable:o.table.isConnected,
  retained:o.children.map((child,i)=>o.previews[i].firstChild===child),
  touched:[...new Set(o.records.map(record=>o.cells.findIndex(cell=>cell===record.target||cell.contains(record.target))))].sort(),
  mutations:o.records.length,
})));}
async function semanticDom(p){return tables(p).evaluateAll(ts=>ts.map(t=>[...t.querySelectorAll('td,th')].map(cell=>({tag:cell.tagName,alignment:cell.style.textAlign,preview:cell.querySelector('div').innerHTML,value:cell.querySelector('textarea').value}))));}

test('One cell edit invalidates one preview; unrelated tables retain DOM, history and reopen agree with cold rendering',()=>probe('cell-history-cold',async(p,f)=>{
  const before=await state(p,f);assert.equal(await tables(p).count(),3);await observe(p);
  await input(p).fill('changed😀');const after=await state(p,f);oneEffect(before,after);
  const changed=await effects(p);f.invalidation=changed;
  assert.deepEqual(changed[0].retained,[true,true,false,true]);assert.deepEqual(changed[0].touched,[2]);
  for(const effect of changed.slice(1)){assert.equal(effect.mutations,0);assert.ok(effect.retained.every(Boolean));assert.equal(effect.sameTable,true);}
  assert.equal(await input(p).inputValue(),'changed😀');
  const expected=await semanticDom(p);
  await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,before.nodes);
  await p.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));assert.deepEqual((await state(p,f)).nodes,after.nodes);
  assert.deepEqual(await semanticDom(p),expected);
  await p.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(p,f)).nodes,after.nodes);assert.deepEqual(await semanticDom(p),expected);
},{tableSource:[source,source,source].join('\n\nseparator\n\n')}));

test('Selection changes never rerender cell content; column metadata retains previews and controls',()=>probe('selection-metadata',async(p,f)=>{
  const before=await state(p,f);await observe(p);
  await tables(p).getByRole('button',{name:'Select cell row 2 column 1',exact:true}).click();
  await tables(p).press('Shift+ArrowRight');unchanged(before,await state(p,f));
  assert.ok((await effects(p))[0].retained.every(Boolean));
  await tables(p).getByRole('button',{name:'Align cells center',exact:true}).click();const after=await state(p,f);oneEffect(before,after);
  assert.ok((await effects(p))[0].retained.every(Boolean));
  assert.deepEqual(await tables(p).locator('td,th').evaluateAll(cs=>cs.map(c=>c.style.textAlign)),['center','center','center','center']);
  const expected=await semanticDom(p);await p.evaluate(()=>window.inputFixture.reopen());await state(p,f);assert.deepEqual(await semanticDom(p),expected);
},{tableSource:source}));

test('Header/shape changes invalidate only their table and preserve content through undo',()=>probe('header-shape',async(p,f)=>{
  const before=await state(p,f);await observe(p);
  await tables(p).first().getByRole('button',{name:'Select cell row 2 column 1',exact:true}).click();
  await tables(p).first().getByRole('button',{name:'Header cells',exact:true}).click();const header=await state(p,f);oneEffect(before,header);
  assert.equal(await tables(p).first().locator('th').count(),3);
  assert.ok((await effects(p))[0].retained.every(Boolean));assert.equal((await effects(p))[1].mutations,0);
  await tables(p).first().getByRole('button',{name:'Insert row after',exact:true}).click();const shaped=await state(p,f);oneEffect(header,shaped);
  assert.equal(await tables(p).first().locator('tr').count(),3);assert.equal((await effects(p))[1].mutations,0);
  await p.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));assert.deepEqual((await state(p,f)).nodes,header.nodes);
},{tableSource:[source,source].join('\n\nseparator\n\n')}));

test('Composition retains native text during another cell update, rejects stale completion and readonly restores committed text',()=>probe('composition-stale-readonly',async(p,f)=>{
  const before=await state(p,f);await input(p).focus();
  await input(p).evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='temporary';});
  await input(p,2,2).fill('neighbor');const neighbor=await state(p,f);oneEffect(before,neighbor);assert.equal(await input(p).inputValue(),'temporary');
  await input(p).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'temporary'})));
  const stale=await state(p,f);unchanged(neighbor,stale);assert.equal(await input(p).inputValue(),'alpha😀');
  await input(p).evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='aborted';});
  await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));assert.equal(await input(p).inputValue(),'alpha😀');
  await input(p).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'aborted'})));
  unchanged(stale,await state(p,f));assert.equal(await input(p).getAttribute('readonly'),'');
},{tableSource:source}));

test('Disposed table controls cannot commit or react to late composition/input',()=>probe('dispose-late',async(p,f)=>{
  const before=await state(p,f);await p.evaluate(()=>{window.detachedTableInput=document.querySelector('[aria-label="Table row 2 column 1"]');window.inputFixture.disposeSurface();const el=window.detachedTableInput;el.value='late';for(const type of ['compositionend','input'])el.dispatchEvent(new InputEvent(type,{bubbles:true}));});
  unchanged(before,await state(p,f));assert.equal(await p.evaluate(()=>window.detachedTableInput.readOnly),true);
},{tableSource:source}));

const richCell=(text,style=['paragraph'])=>({header:false,rowSpan:1,columnSpan:1,paragraphs:[{style,runs:[[text,[]]]}]});
test('Multi-block readonly recovery retains separators; merged cells stay source-preserving fallback',()=>probe('rich-readonly',async(p,f)=>{
  const before=await state(p,f);const cell=input(p,1,1);assert.equal(await cell.inputValue(),'first\nsecond');
  await p.evaluate(()=>window.inputFixture.surface.setReadOnly(true));assert.equal(await cell.inputValue(),'first\nsecond');
  await p.evaluate(()=>window.inputFixture.surface.setReadOnly(false));assert.equal(await cell.getAttribute('readonly'),'');unchanged(before,await state(p,f));
},{tableTuple:['module:editac.table',2,{alignments:['none'],rows:[[{...richCell('first'),paragraphs:[...richCell('first').paragraphs,...richCell('second').paragraphs]}]],source:'original rich source'}]}));

test('Unsupported rowspan descriptor remains recoverable and inert',()=>probe('rowspan-fallback',async(p,f)=>{
  const before=await state(p,f);assert.equal(await tables(p).count(),0);assert.equal(await p.getByRole('textbox',{name:'Unsupported table source'}).inputValue(),'original merged source');
  unchanged(before,await state(p,f));
},{tableTuple:['module:editac.table',2,{alignments:['none'],rows:[[{...richCell('merged'),rowSpan:2}],[null]],source:'original merged source'}]}));


test('Header metadata keeps the active native control, directional selection and unrelated content',()=>probe('header-native-selection',async(p,f)=>{
  const before=await state(p,f);await observe(p);await input(p).focus();
  await input(p).evaluate(el=>{window.activeCell=el;el.setSelectionRange(1,4,'backward');});
  await p.evaluate(()=>{
    const e=window.inputFixture.engine,n=e.read().visible.find(n=>n.blockAttributes?.[0]==='module:editac.table');
    e.history({type:'explicit'});
    const result=e.commit(e.prepare({kind:'editor',origin:'prepared-header-invalidation',commands:[{type:'tableAttributes',owner:n.id,expected:n.blockAttributes,row:1,column:0,rows:1,columns:1,header:true,alignment:null,protected:[]}]}));
    if(result.caret)e.releaseAnchor(result.caret);e.history({type:'boundary'});
  });
  const after=await state(p,f);assert.equal(after.history.undoGroups,before.history.undoGroups+1);
  assert.deepEqual(await input(p).evaluate(el=>({same:el===window.activeCell,active:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd,direction:el.selectionDirection,tag:el.parentElement.tagName})),{same:true,active:true,start:1,end:4,direction:'backward',tag:'TH'});
  assert.ok((await effects(p))[0].retained.every(Boolean));assert.equal((await effects(p))[1].mutations,0);
},{tableSource:[source,source].join('\n\nseparator\n\n')}));

test('Browser layout responds to width and font changes without rebuilding table content; warm and cold layouts agree',()=>probe('layout-invalidation',async(p,f)=>{
  const before=await state(p,f);await observe(p);
  const layout=()=>tables(p).evaluateAll(ts=>ts.map(t=>[...t.querySelectorAll('td,th')].map(c=>({width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height}))));
  const initial=await layout();
  const owner=await tables(p).first().evaluate(t=>t.closest('[data-node-id]').dataset.nodeId);
  await p.addStyleTag({content:`[data-node-id="${owner}"] table { width: 620px; table-layout: fixed; } [data-node-id="${owner}"] td, [data-node-id="${owner}"] th { font-size: 23px; }`});
  const warm=await layout();assert.notDeepEqual(warm[0],initial[0]);
  assert.deepEqual(warm.slice(1),initial.slice(1));
  for(const effect of await effects(p)){assert.equal(effect.mutations,0);assert.ok(effect.retained.every(Boolean));}
  unchanged(before,await state(p,f));
  await p.evaluate(()=>window.inputFixture.reopen());await state(p,f);assert.deepEqual(await layout(),warm);
},{tableSource:[source,source].join('\n\nseparator\n\n')}));
