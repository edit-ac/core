import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from '../browser-harness.ts';
const {probe,facts}=browserHarness('interaction-cell-multiline','fixtures/browser-content-modules',{
  markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/cell-multiline.spec.ts',sourcePaths:[
    'packages/web/src/modules/content.ts','packages/web/src/modules/tables/clipboard.ts','fixtures/browser-content-modules/session.mjs',
    'packages/web/dist/modules/content.js','packages/web/dist/modules/tables/clipboard.js',
    'packages/core/dist/wasm/editac_wasm_bg.wasm','packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm']});
facts.binding={gate:'SFR-1.1',ids:['BRK-08','PST-02'],provenance:'actual mounted table presenter, authored clipboard events, production engine/Session/storage; no OS clipboard claim'};
const text='\nline\t"😀"\n\n';
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
function tuple(s){return s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes;}
async function choose(page,row){const input=page.getByRole('textbox',{name:`Table row ${row} column 1`,exact:true});await input.focus();await input.press('Alt+Enter');}
async function clipboard(page,type,flavors={}){return page.evaluate(({type,flavors})=>{const data=new DataTransfer();for(const [m,v]of Object.entries(flavors))data.setData(m,v);const e=window.preparedClipboardEvent(type,data);window.inputFixture.root.querySelector('[data-content-module="table"]').dispatchEvent(e);return Object.fromEntries([...data.types].map(m=>[m,data.getData(m)]));},{type,flavors});}
for(const mime of ['application/x-edit-ac-table-cells+json','text/plain','text/tab-separated-values','text/html'])test(`PST-02 multiline cell selection roundtrip via ${mime}`,()=>probe(`PST-02-cell-copy-${mime.replaceAll('/','-')}`,async(page,fact)=>{
  await choose(page,1);await page.getByRole('checkbox',{name:'Paste cells as literal text'}).check();await clipboard(page,'paste',{'text/plain':text});
  await page.getByRole('checkbox',{name:'Paste cells as literal text'}).uncheck();const source=await state(page,fact);
  const copied=await clipboard(page,'copy');for(const required of ['application/x-edit-ac-table-cells+json','text/plain','text/tab-separated-values','text/html'])assert.equal(typeof copied[required],'string');
  assert.equal(copied['text/plain'],'"'+text.replaceAll('"','""')+'"');
  assert.deepEqual((await state(page,fact)).nodes,source.nodes);
  await choose(page,2);await clipboard(page,'paste',{[mime]:copied[mime]});const after=await state(page,fact);
  assert.deepEqual(tuple(after)[2].rows[1][0],[[text,[]]]);assert.deepEqual(tuple(after)[2].rows[0],tuple(source)[2].rows[0]);
  assert.equal(after.history.undoGroups,source.history.undoGroups+1);assert.equal(after.journal.length,source.journal.length+1);
  await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');assert.deepEqual((await state(page,fact)).nodes,source.nodes);
  await page.keyboard.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');assert.deepEqual((await state(page,fact)).nodes,after.nodes);
  await page.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await state(page,fact)).nodes,after.nodes);
},{plainTable:true}));
test('PST-02 multiline cell cut retains source on transport refusal and restores exact source on undo',()=>probe('PST-02-cell-cut',async(page,fact)=>{
  await choose(page,1);await page.getByRole('checkbox',{name:'Paste cells as literal text'}).check();await clipboard(page,'paste',{'text/plain':text});const before=await state(page,fact);
  await page.evaluate(()=>{const data=new DataTransfer();data.setData=()=>{throw Error('transport refused');};window.inputFixture.root.querySelector('[data-content-module="table"]').dispatchEvent(window.preparedClipboardEvent('cut',data));});
  const refused=await state(page,fact);for(const key of ['nodes','history','journal'])assert.deepEqual(refused[key],before[key]);
  const copied=await clipboard(page,'cut');assert.equal(typeof copied['application/x-edit-ac-table-cells+json'],'string');const cut=await state(page,fact);assert.deepEqual(tuple(cut)[2].rows[0][0],[['',[]]]);assert.equal(cut.history.undoGroups,before.history.undoGroups+1);
  await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');assert.deepEqual((await state(page,fact)).nodes,before.nodes);
},{plainTable:true}));
