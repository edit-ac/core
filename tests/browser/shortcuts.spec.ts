import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserHarness} from './browser-harness.ts';
import {state} from './format-helpers.ts';
const {probe}=browserHarness('shortcuts');
for(const [name,prefix,attribute,container,checked]of [
 ['heading','#',['heading',1],null,null],['list','-',['paragraph'],'unordered',null],['ordered','3.',['paragraph'],'ordered',null],['quote','>',['paragraph'],'quote',null],['checked','- [x]',['paragraph'],'checklist',true]
])test(`${name} space trigger is local, atomic and reversible`,()=>probe(name,async(page,fact)=>{
  await page.keyboard.press('Space');let s=await state(page,fact),block=s.nodes.find(n=>n.kind==='block');assert.deepEqual(block.blockAttributes,attribute);assert.equal(block.runs.map(r=>r.text).join(''),'');if(container)assert.ok(s.nodes.some(n=>n.editor?.containerAttributes?.[0]===container));if(checked!==null)assert.equal(block.editor.checked,checked);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);assert.equal(s.unrelatedIdentity,true);
  await page.keyboard.press('Backspace');s=await state(page,fact);assert.equal(s.text[0],prefix+' ');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);assert.equal(s.history.undoGroups,1);
},prefix));
test('fence Enter preserves code language and caret; code typing remains literal',()=>probe('fence',async(page,fact)=>{
  await page.keyboard.press('Enter');let s=await state(page,fact);assert.deepEqual(s.nodes[0].blockAttributes,['code','js']);assert.equal(s.journal.length,1);assert.equal(s.history.undoGroups,1);await page.keyboard.type('**literal**');s=await state(page,fact);assert.equal(s.text[0],'**literal**');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));
},'```js'));
for(const [prefix,last,mark]of [['**é😀*','*','bold'],['_italic','_','italic'],['~~strike~','~','strike'],['`code','`','code']])test(`completed ${mark} suffix parses one bounded context`,()=>probe(mark,async(page,fact)=>{
  await page.keyboard.type(last);let s=await state(page,fact);assert.ok(s.nodes[0].runs.some(r=>r.attributes[mark]===true));assert.equal(s.history.undoGroups,1);assert.equal(s.journal.length,1);assert.equal(s.unrelatedIdentity,true);
  await page.evaluate(()=>window.inputFixture.engine.history({type:'undo'}));s=await state(page,fact);assert.equal(s.text[0],prefix);await page.evaluate(()=>window.inputFixture.engine.history({type:'redo'}));s=await state(page,fact);assert.ok(s.nodes[0].runs.some(r=>r.attributes[mark]===true));
},prefix));
test('Escape and host disabled rules preserve literal delimiters',()=>probe('disabled',async(page,fact)=>{
  await page.keyboard.press('Escape');await page.keyboard.type('*');let s=await state(page,fact);assert.equal(s.text[0],'**bold**');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));await page.evaluate(()=>window.inputFixture.protocol.shortcuts.enabled=false);await page.keyboard.type(' **more**');s=await state(page,fact);assert.ok(s.text[0].endsWith(' **more**'));assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));
},'**bold*'));
test('ambiguous synthetic input and remote replay cannot trigger rules',()=>probe('provenance',async(page,fact)=>{
  await page.evaluate(()=>window.inputFixture.event('beforeinput',{inputType:'insertText',data:' ',cancelable:true}));let s=await state(page,fact);assert.equal(s.text[0],'# ');assert.deepEqual(s.nodes[0].blockAttributes,['paragraph']);await page.evaluate(()=>window.inputFixture.remote(2,'**remote**'));s=await state(page,fact);assert.equal(s.text[0],'# **remote**');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));
},'#'));
test('escaped, unmatched and oversized contexts stay literal',()=>probe('bounded',async(page,fact)=>{
  await page.keyboard.type('*');let s=await state(page,fact);assert.equal(s.text[0],'\\**literal**');assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));
  await page.evaluate(()=>{const f=window.inputFixture,n=f.engine.read().visible[0],a=f.engine.anchor(n.id,0,'right'),b=f.engine.anchor(n.id,n.runs.map(r=>r.text).join('').length,'left');try{f.engine.commit(f.engine.prepare({kind:'text',origin:'setup',command:{type:'replace',range:{anchor:a,focus:b},text:'x'.repeat(2050)+' **big*'}}));}finally{f.engine.releaseAnchor(a);f.engine.releaseAnchor(b);}f.select(n.id,2057);});await page.keyboard.type('*');s=await state(page,fact);assert.ok(s.nodes[0].runs.every(r=>!r.attributes.bold));
},'\\**literal*'));
