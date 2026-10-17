import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHarness } from '../browser-harness.ts';

const {probe,facts}=browserHarness('interaction-break-tables','fixtures/browser-content-modules',{
  markdown:true,assertSourcesUnchanged:true,testFile:'tests/browser/interactions/break-tables.spec.ts',
  sourcePaths:['packages/web/src/modules/content.ts','fixtures/browser-content-modules/session.mjs'],
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
  assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.journal.length,before.journal.length+1);
  await input.press(process.platform==='darwin'?'Meta+z':'Control+z');const undone=await page.evaluate(()=>window.inputFixture.state());assert.deepEqual(undone.nodes,before.nodes);
  await input.focus();await input.evaluate(el=>el.setSelectionRange(2,2));await input.press(hard?'Shift+Enter':'Enter');await input.press('X');
  assert.equal(await input.inputValue(),'al\nXpha😀');
  const typed=await page.evaluate(()=>window.inputFixture.state());await page.evaluate(()=>window.inputFixture.reopen());const restored=await page.evaluate(()=>window.inputFixture.state());assert.deepEqual(restored.nodes,typed.nodes);fact.snapshots.push(typed,restored);
},{plainTable:true}));
