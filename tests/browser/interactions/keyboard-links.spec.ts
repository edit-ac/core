import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from '../browser-harness.ts';
const {probe,facts}=browserHarness('interaction-keyboard-links','fixtures/browser-input',{assertSourcesUnchanged:true,testFile:'tests/browser/interactions/keyboard-links.spec.ts',sourcePaths:['packages/web/src/input/keyboard.ts','packages/web/src/input/text.ts','packages/web/src/commands/formatting.ts','fixtures/browser-input/session.mjs']});
facts.binding={gate:'INT-1.6',ids:['KEY-07'],provenance:'actual URL dialog activation, current packed WASM/recovered Session/IndexedDB and native subsequent typing; pending link creates no empty content'};
test('KEY-07 collapsed link dialog preserves target and next-typed pending mark without empty content',()=>probe('KEY-07-collapsed-link-typing',async(page,fact)=>{
 await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],2);});const before=await page.evaluate(()=>window.inputFixture.state());
 await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');await page.getByLabel('Link URL').fill('https://pending.test/');await page.getByRole('button',{name:'Apply link',exact:true}).click();
 const pending=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(before,pending);assert.deepEqual(pending.text,before.text);assert.equal(pending.history.undoGroups,0);assert.equal(pending.journal.length,0);
 await page.keyboard.type('S');const s=await page.evaluate(()=>window.inputFixture.state());const nodes=await page.evaluate(()=>window.inputFixture.engine.read().visible);fact.snapshots.push(s);assert.deepEqual(s.errors,[]);assert.equal(s.text[0],'alSpha');assert.equal(nodes[0].runs.find(r=>r.text==='S')?.attributes.link,'https://pending.test/');assert.equal(s.caret.offset,3);assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);
 await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');const undone=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(undone);assert.deepEqual(undone.text,before.text);assert.equal(undone.history.undoGroups,0);
}));
