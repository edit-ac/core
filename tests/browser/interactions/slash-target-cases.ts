import assert from 'node:assert/strict';
import {test} from 'node:test';
export function registerSlashTargetCases(probe) {
 async function state(page,fact){const s=await page.evaluate(()=>window.inputFixture.state());fact.snapshots.push(s);assert.deepEqual(s.errors,[]);return s;}
 test('SLH-06 local invalidation of trigger boundary aborts an anchored response',()=>probe('SLH-06-local-boundary',async(page,fact)=>{
  await page.keyboard.type('/Slow');await page.keyboard.press('Enter');
  await page.evaluate(()=>{const f=window.inputFixture;f.engine.commit(f.engine.prepare({kind:'editor',origin:'fixture-adjacent-edit',commands:[{type:'replaceAt',owner:f.ids[0],from:1,to:2,text:''}]}));});
  const before=await state(page,fact);assert.equal(before.text[0],'a/Slow');assert.equal(before.open,false);assert.deepEqual(before.aborted,[true]);
  await page.evaluate(()=>{const f=window.inputFixture;f.pending[0].resolve(f.fragment('STALE'));});const after=await state(page,fact);
  for(const key of ['text','history','commands','journal','patches'])assert.deepEqual(after[key],before[key],key);
 },'a '));
 for(const action of ['Al','Code'])test(`SLH-07 ${action} replaces only its query beside retained prefix and suffix`,()=>probe(`SLH-07-surroundings-${action}`,async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;f.select(f.ids[0],7);});await page.keyboard.type('/'+action);const before=await state(page,fact);assert.equal(before.open,true);
  await page.keyboard.press('Enter');const after=await state(page,fact);assert.equal(after.text[0],action==='Al'?'before chosen after':'before  after');assert.equal(after.text[1],'independent');assert.equal(after.history.undoGroups,before.history.undoGroups+1);assert.equal(after.journal.length,before.journal.length+1);
  const offset=action==='Al'?13:7;assert.equal(after.selection.anchor.offset,offset);assert.deepEqual(after.selection.anchor,after.selection.focus);assert.equal(after.focus,true);
  await page.keyboard.type('x');assert.equal((await state(page,fact)).text[0],action==='Al'?'before chosenx after':'before x after');
  const undo=process.platform==='darwin'?'Meta+z':'Control+z';await page.keyboard.press(undo);await page.keyboard.press(undo);const restored=await state(page,fact);assert.equal(restored.text[0],before.text[0]);assert.deepEqual(restored.nodes[0].blockAttributes,before.nodes[0].blockAttributes);assert.equal(restored.history.undoGroups,before.history.undoGroups);
 },'before  after'));
 test('SLH-02 intermediate and committed composition slash remains literal',()=>probe('SLH-02-composition-text',async(page,fact)=>{
  await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionstart');f.event('beforeinput',{inputType:'insertCompositionText',data:'/',isComposing:true});const block=f.root.querySelector('[data-node-id]'),node=document.createTreeWalker(block,NodeFilter.SHOW_TEXT).nextNode();node.data='base /';document.getSelection().setBaseAndExtent(node,6,node,6);f.event('compositionupdate',{data:'/'});f.event('input',{inputType:'insertCompositionText',data:'/',isComposing:true});});
  const interim=await state(page,fact);assert.equal(interim.text[0],'base ');assert.equal(interim.dom[0],'base /');assert.equal(interim.open,false);assert.equal(interim.history.undoGroups,0);
  await page.evaluate(()=>{const f=window.inputFixture;f.event('compositionend',{data:'/'});f.event('input',{inputType:'insertCompositionText',data:'/',isComposing:false});});
  const final=await state(page,fact);assert.equal(final.text[0],'base /');assert.equal(final.open,false);assert.equal(final.history.undoGroups,1);assert.equal(final.commands.filter(c=>c.origin.startsWith('slash:')).length,0);
 },'base '));
 test('SLH-02 composing Enter with no start event never accepts an open popup',()=>probe('SLH-02-composing-key',async(page,fact)=>{
  await page.keyboard.type('/Al');const before=await state(page,fact);assert.equal(await page.evaluate(()=>window.inputFixture.event('keydown',{key:'Enter',isComposing:true})),false);const after=await state(page,fact);
  for(const key of ['text','history','commands','journal','patches'])assert.deepEqual(after[key],before[key],key);assert.equal(after.open,true);
  await page.keyboard.press('Enter');assert.equal((await state(page,fact)).text[0],'chosen');
 }));
}
