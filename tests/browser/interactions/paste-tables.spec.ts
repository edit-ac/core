import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from '../browser-harness.ts';
const {probe,facts}=browserHarness('interaction-paste-tables','fixtures/browser-content-modules',{
  markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/paste-tables.spec.ts',sourcePaths:[
    'packages/web/src/modules/content.ts','packages/web/src/modules/tables/clipboard.ts',
    'crates/editac-core/src/commands/table.rs','fixtures/browser-content-modules/session.mjs',
    'packages/web/dist/modules/content.js','packages/web/dist/modules/tables/clipboard.js',
    'packages/core/dist/wasm/editac_wasm_bg.wasm','packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm']});
facts.binding={gate:'INT-1.10',ids:['PST-02','PST-03','PST-04','PST-05'],provenance:'Authored synthetic clipboard events at actual content-module table presenter, current Session/storage and packed WASM; no OS clipboard proof.',profile:{os:process.platform,arch:process.arch}};
async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
async function enter(page){const input=page.getByRole('textbox',{name:'Table row 1 column 1',exact:true});await input.focus();await page.keyboard.press('Alt+Enter');}
async function paste(page,flavors){await page.evaluate(flavors=>{const f=window.inputFixture,data=new DataTransfer();for(const [m,v]of Object.entries(flavors))data.setData(m,v);f.root.querySelector('[data-content-module="table"]').dispatchEvent(window.preparedClipboardEvent('paste',data));},flavors);}
function table(s){return s.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes;}
function unchanged(a,b){for(const k of ['nodes','history','journal'])assert.deepEqual(b[k],a[k],k);}
for(const text of ['**literal**','  one\ttwo  ','שלום é😀'])test(`PST-02 explicit literal cell ignores rich flavors and preserves ${JSON.stringify(text)}`,()=>probe(`PST-02-cell-literal-${text.length}`,async(page,fact)=>{
  fact.caseIds=['PST-02'];await enter(page);await page.getByRole('checkbox',{name:'Paste cells as literal text'}).check();
  const before=await state(page,fact);await paste(page,{'text/html':'<p><b>wrong</b></p>','text/plain':text,'text/tab-separated-values':'a\tb\nc\td'});
  const after=await state(page,fact);const original=table(before),changed=table(after);
  assert.equal(changed[2].rows.length,original[2].rows.length);assert.deepEqual(changed[2].rows[0][0],[[text,[]]]);
  assert.deepEqual(changed[2].rows[0][1],original[2].rows[0][1]);assert.deepEqual(changed[2].rows[1],original[2].rows[1]);
  assert.equal(after.history.undoGroups,1);assert.equal(after.journal.length,1);
  await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');assert.deepEqual((await state(page,fact)).nodes,before.nodes);
},{plainTable:true}));
test('PST-02 multiline literal cell retains breaks within original target',()=>probe('PST-02-cell-multiline',async(page,fact)=>{
  fact.caseIds=['PST-02'];await enter(page);await page.getByRole('checkbox',{name:'Paste cells as literal text'}).check();const before=await state(page,fact);
  await paste(page,{'text/plain':'line one\nline two'});const after=await state(page,fact);
  assert.equal(table(after)[2].rows.length,table(before)[2].rows.length);assert.deepEqual(table(after)[2].rows[0][0],[['line one\nline two',[]]],'Original PST-02 requires an admitted cell-internal break primitive');
},{plainTable:true}));
for(const flavors of [{'text/html':'<table><tr><td onclick="alert(1)">x</td></tr></table>','text/plain':'x'},{'text/plain':'a\tb\nc\td'}])test(`PST-04 unsupported cell rectangle preserves source ${Object.keys(flavors)[0]}`,()=>probe(`PST-04-cell-reject-${Object.keys(flavors)[0].replace('/','-')}`,async(page,fact)=>{
  fact.caseIds=['PST-04'];await enter(page);const before=await state(page,fact);await paste(page,flavors);unchanged(before,await state(page,fact));
},{plainTable:true,protected:[[0,0]]}));
