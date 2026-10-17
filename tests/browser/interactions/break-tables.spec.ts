import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';

const {probe,facts}=browserHarness('interaction-break-tables','fixtures/browser-content-modules',{
  markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/break-tables.spec.ts',
  sourcePaths:['packages/web/src/modules/content.ts','fixtures/browser-content-modules/session.mjs','crates/editac-core/src/commands/table.rs','crates/editac-core/src/modules/content.rs','crates/editac-markdown/src/optional.rs','crates/editac-markdown/src/export.rs','packages/core/dist/wasm/editac_wasm_bg.wasm','packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm'],
});
facts.binding={gate:'INT-1.2',ids:['BRK-08'],provenance:'real table presenter/native textarea and prepared engine table command; no OS qualification'};
for(const hard of [false,true])test(`BRK-08: table ${hard?'Shift+Enter':'Enter'} preserves cell and table`,()=>probe(`BRK-08-table-${hard}`,async(page,fact)=>{
  const input=page.getByRole('textbox',{name:'Table row 2 column 1',exact:true});
  const before=await page.evaluate(()=>window.inputFixture.state());
  await input.focus();await input.evaluate(el=>el.setSelectionRange(2,2));await input.press(hard?'Shift+Enter':'Enter');
  const after=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(before,after);
  assert.deepEqual(after.errors,[]);assert.equal(await input.inputValue(),'al\npha😀');
  assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[3,3]);
  const oldTable=before.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table'),newTable=after.nodes.find(n=>n.id===oldTable.id);
  assert.equal(after.nodes.length,before.nodes.length);assert.equal(newTable.blockAttributes[2].rows[1][0].map(r=>r[0]).join(''),'al\npha😀');
  assert.equal(after.markdown.diagnostics.length,0);assert.match(after.markdown.markdown,/al<br \/>pha😀/);assert.equal(newTable.blockAttributes[2].source,oldTable.blockAttributes[2].source);assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.journal.length,before.journal.length+1);
  await input.press(process.platform==='darwin'?'Meta+z':'Control+z');const undone=await page.evaluate(()=>window.inputFixture.state());assert.deepEqual(undone.nodes,before.nodes);
  await input.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');assert.deepEqual((await page.evaluate(()=>window.inputFixture.state())).nodes,after.nodes);
  await input.press(process.platform==='darwin'?'Meta+z':'Control+z');
  await input.focus();await input.evaluate(el=>el.setSelectionRange(2,2));await input.press(hard?'Shift+Enter':'Enter');await input.press('X');
  assert.equal(await input.inputValue(),'al\nXpha😀');
  const typed=await page.evaluate(()=>window.inputFixture.state());await page.evaluate(()=>window.inputFixture.reopen());const restored=await page.evaluate(()=>window.inputFixture.state());assert.deepEqual(restored.nodes,typed.nodes);fact.snapshots.push(typed,restored);
},{plainTable:true}));

for (const style of [['paragraph'],['heading',2],['code','js']]) test(`BRK-08 v2 ${style[0]} cell keeps descriptor, selection and typed recovery`,()=>probe(`BRK-08-v2-${style[0]}`,async(page,fact)=>{
  const input=page.getByRole('textbox',{name:'Table row 1 column 1',exact:true});const before=await page.evaluate(()=>window.inputFixture.state());
  await input.focus();await input.evaluate(el=>el.setSelectionRange(2,2));await input.press('Shift+Enter');
  const after=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(before,after);assert.deepEqual(after.errors,[]);
  assert.equal(await input.inputValue(),'ab\n😀');assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[3,3]);
  const a=before.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table'),b=after.nodes.find(n=>n.id===a.id);
  const expected=structuredClone(a.blockAttributes);expected[2].rows[0][0].paragraphs[0].runs=[['ab\n😀',style[0]==='code'?[]:[['bold']]]];assert.deepEqual(b.blockAttributes,expected);
  assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.journal.length,before.journal.length+1);
  await input.press(process.platform==='darwin'?'Meta+z':'Control+z');assert.deepEqual((await page.evaluate(()=>window.inputFixture.state())).nodes,before.nodes);
  await input.press(process.platform==='darwin'?'Meta+Shift+z':'Control+Shift+z');assert.deepEqual((await page.evaluate(()=>window.inputFixture.state())).nodes,after.nodes);
  const recovery=await page.evaluate(()=>window.inputFixture.typedRoundTrip());assert.deepEqual(recovery.nodes.find(n=>n.blockAttributes?.[0]==='module:editac.table').blockAttributes,b.blockAttributes);
  await input.focus();await input.evaluate(el=>el.setSelectionRange(3,3));await input.press('X');assert.equal(await input.inputValue(),'ab\nX😀');
  const typed=await page.evaluate(()=>window.inputFixture.state());await page.evaluate(()=>window.inputFixture.reopen());assert.deepEqual((await page.evaluate(()=>window.inputFixture.state())).nodes,typed.nodes);
},{tableTuple:['module:editac.table',2,{alignments:['left'],source:'exact source\r\n',rows:[[{paragraphs:[{style,runs:[['ab😀',style[0]==='code'?[]:[['bold']]]]}],rowSpan:1,columnSpan:1,header:true}]]}]}));

test('BRK-08 malformed UTF-16 native cell input stays fail-atomic',()=>probe('BRK-08-cell-invalid-utf16',async(page,fact)=>{
  const input=page.getByRole('textbox',{name:'Table row 2 column 1',exact:true});const before=await page.evaluate(()=>window.inputFixture.state());
  await input.evaluate(el=>{el.value='bad\ud800tail';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));});
  const after=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(before,after);for(const key of ['nodes','history','journal'])assert.deepEqual(after[key],before[key]);assert.equal(await input.inputValue(),'alpha😀');
},{plainTable:true}));
